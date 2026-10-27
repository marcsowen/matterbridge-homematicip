import {createHash} from "node:crypto";
import {
    getHmIPDeviceReachability,
    type HmIPCommand,
    type HmIPDevice,
    type HmIPDeviceCommand,
    type HmIPDeviceCommandBodies,
    type HmIPGroup,
    isHmIPRecord,
} from "homematicip-cloud-client-ts";
import {
    airQualitySensor,
    type CommandHandlerFunction,
    type CommandHandlers,
    colorTemperatureLight,
    contactSensor,
    type DeviceTypeDefinition,
    dimmableLight,
    doorLock,
    electricalSensor,
    extendedColorLight,
    flowSensor,
    genericSwitch,
    humiditySensor,
    lightSensor,
    MatterbridgeEndpoint,
    mountedOnOffControl,
    occupancySensor,
    onOffLight,
    onOffPlugInUnit,
    rainSensor,
    smokeCoAlarm,
    soilSensor,
    temperatureSensor,
    thermostat,
    waterLeakDetector,
    waterValve,
    windowCovering,
} from "matterbridge";
import {
    MatterbridgeColorControlServer,
    MatterbridgePowerSourceServer,
    MatterbridgeThermostatServer,
    MatterbridgeValveConfigurationAndControlServer,
} from "matterbridge/behaviors";
import {Closure} from "matterbridge/devices";
import {BridgedDeviceBasicInformationServer} from "matterbridge/matter/behaviors";
import {ClosureControl, ColorControl, PowerSource, Thermostat} from "matterbridge/matter/clusters";
import {
    type Channel,
    clamp,
    type Entity,
    finite,
    heatingGroup,
    illuminance,
    meterEnergy,
    percent100ths,
} from "./mapping.js";

export interface EntityContext {
    groups?: Readonly<Record<string, HmIPGroup>>;
    vendorId: number;
    lockPins: Record<string, string>;
    command: HmIPCommand;
    deviceCommand: HmIPDeviceCommand;
    error(message: string): void;
}

const simpleColors: Record<string, [number, number]> = {
    BLACK: [0, 0],
    WHITE: [0, 0],
    RED: [0, 1],
    YELLOW: [60, 1],
    GREEN: [120, 1],
    TURQUOISE: [180, 1],
    BLUE: [240, 1],
    PURPLE: [300, 1],
};
function truncateUtf8(value: string, bytes: number): string {
    let result = "";
    for (const character of value) {
        if (Buffer.byteLength(result + character) > bytes) {
            break;
        }
        result += character;
    }
    return result;
}

export function nearestColor(hue: number, saturation: number): string {
    return saturation < 0.1
        ? "WHITE"
        : (["RED", "YELLOW", "GREEN", "TURQUOISE", "BLUE", "PURPLE"][Math.round(hue / 60) % 6] ?? "RED");
}

export class BridgedEntity {
    readonly endpoint: MatterbridgeEndpoint;
    private channel: Channel;
    private device: HmIPDevice;
    private groups: Readonly<Record<string, HmIPGroup>> = {};
    private lastLevel = 1;
    private lastSmokeAlarm = false;
    private lastButtonEvent = "";
    private updating = false;
    private commandQueue: Promise<void> = Promise.resolve();
    private readonly supportsHue: boolean;
    private readonly supportsCt: boolean;
    private readonly metering: boolean;
    private readonly supportsCooling: boolean;

    constructor(
        readonly description: Entity,
        device: HmIPDevice,
        private readonly context: EntityContext,
    ) {
        this.channel = description.channel;
        this.device = device;
        this.groups = context.groups ?? {};
        const group = heatingGroup(device, this.groups);
        this.supportsCooling = group?.cooling === true || (isHmIPRecord(group) && group.coolingAllowed === true);
        const features = this.channel.supportedOptionalFeatures as Record<string, unknown> | undefined;
        this.supportsHue = description.kind === "notification" || features?.IOptionalFeatureHueSaturationValue === true;
        this.supportsCt = features?.IOptionalFeatureColorTemperature === true;
        this.metering =
            description.kind === "switch" && this.channel.functionalChannelType === "SWITCH_MEASURING_CHANNEL";
        const types: Record<Entity["kind"], DeviceTypeDefinition> = {
            switch:
                device.type.includes("PLUGABLE") ||
                device.type.includes("CABLE") ||
                device.type === "USB_SWITCH_MEASURING"
                    ? onOffPlugInUnit
                    : device.type === "BRAND_SWITCH_MEASURING"
                      ? onOffLight
                      : mountedOnOffControl,
            dimmer: dimmableLight,
            color: this.supportsHue ? extendedColorLight : this.supportsCt ? colorTemperatureLight : dimmableLight,
            notification: extendedColorLight,
            cover: windowCovering,
            blind: windowCovering,
            shading: windowCovering,
            contact: contactSensor,
            temperature: temperatureSensor,
            humidity: humiditySensor,
            illuminance: lightSensor,
            occupancy: occupancySensor,
            smoke: smokeCoAlarm,
            water: waterLeakDetector,
            rain: rainSensor,
            button: genericSwitch,
            lock: doorLock,
            lockSensor: doorLock,
            thermostat,
            valve: waterValve,
            garage: windowCovering,
            co2: airQualitySensor,
            energy: electricalSensor,
            soil: soilSensor,
            soilTemperature: temperatureSensor,
            flow: flowSensor,
            waterSupply: waterValve,
            waterAlarm: waterLeakDetector,
        };
        const serial = device.id;
        const uniqueId = createHash("sha256").update(description.id).digest("hex").slice(0, 32);
        const name = description.label;
        const kind = description.kind;
        const endpointTypes: [DeviceTypeDefinition, ...DeviceTypeDefinition[]] = [types[kind]];
        if (this.metering) {
            endpointTypes.push(electricalSensor);
        }
        if (kind === "thermostat" && "humidity" in this.channel) {
            endpointTypes.push(humiditySensor);
        }
        this.endpoint =
            kind === "garage"
                ? new Closure(name, serial, {
                      id: description.id,
                      motionLatching: false,
                      speed: false,
                      calibration: false,
                      ventilation: this.channel.ventilationPositionSupported === true,
                      movementDuration: 0,
                      powerSourceType: "None",
                  })
                : new MatterbridgeEndpoint(endpointTypes, {
                      id: description.id,
                  });
        this.endpoint.createDefaultBridgedDeviceBasicInformationClusterServer(
            truncateUtf8(name, 32),
            serial,
            context.vendorId,
            "eQ-3",
            device.modelType.slice(0, 32),
            1,
            device.firmwareVersion.slice(0, 64),
        );
        // Multiple endpoints share the hardware serial, but each has its own stable Matter identity.
        this.endpoint.uniqueId = uniqueId;
        const basicInformation = this.endpoint.getClusterServerOptions(BridgedDeviceBasicInformationServer);
        if (basicInformation) {
            basicInformation.uniqueId = uniqueId;
        }
        // Keep the full name in the frontend; Matter NodeLabel is limited to 32 bytes.
        this.endpoint.deviceName = name;
        const maintenance = Object.values(device.functionalChannels).find((c) => {
            if (!isHmIPRecord(c)) {
                return false;
            }
            const base = c;
            const features = base.supportedOptionalFeatures as Record<string, unknown> | undefined;
            return features?.IOptionalFeatureLowBat === true || (!features && typeof base.lowBat === "boolean");
        });
        if (maintenance) {
            // HmIP reports a low-battery flag, not a percentage or measured voltage.
            // Apple Home treats a null percentage as a failed read and can mark the accessory unreachable.
            // Omit unsupported optional measurements rather than exposing null or invented values.
            this.endpoint.behaviors.require(MatterbridgePowerSourceServer.with(PowerSource.Feature.Battery), {
                status: PowerSource.PowerSourceStatus.Active,
                order: 0,
                description: "Primary battery",
                endpointList: [],
                batChargeLevel: PowerSource.BatChargeLevel.Ok,
                batReplaceability: PowerSource.BatReplaceability.Unspecified,
                batReplacementNeeded: false,
                activeBatFaults: [],
            });
        } else {
            this.endpoint.createDefaultPowerSourceWiredClusterServer();
        }
        switch (kind) {
            case "switch":
                this.endpoint.createDefaultOnOffClusterServer();
                break;
            case "dimmer":
            case "color":
            case "notification":
                this.endpoint.createDefaultOnOffClusterServer().createDefaultLevelControlClusterServer();
                if (this.supportsHue && this.supportsCt) {
                    this.endpoint.createHsColorControlClusterServer(0, 0, 250);
                } else if (this.supportsHue) {
                    this.endpoint.behaviors.require(
                        MatterbridgeColorControlServer.with(ColorControl.Feature.HueSaturation),
                        {
                            colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
                            enhancedColorMode: ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation,
                            colorCapabilities: {
                                hueSaturation: true,
                                xy: false,
                                colorTemperature: false,
                                colorLoop: false,
                                enhancedHue: false,
                            },
                            currentHue: 0,
                            currentSaturation: 0,
                            options: {executeIfOff: false},
                            numberOfPrimaries: null,
                            remainingTime: 0,
                        },
                    );
                } else if (this.supportsCt) {
                    this.endpoint.createCtColorControlClusterServer(
                        250,
                        Math.round(1_000_000 / this.number("maximumColorTemperature", 6500)),
                        Math.round(1_000_000 / this.number("minimalColorTemperature", 2000)),
                    );
                }
                break;
            case "cover":
            case "shading":
                this.endpoint.createDefaultWindowCoveringClusterServer(null, undefined, undefined, 0);
                break;
            case "blind":
                this.endpoint.createDefaultLiftTiltWindowCoveringClusterServer(null, null, undefined, undefined, 0);
                break;
            case "contact":
            case "rain":
            case "water":
            case "waterAlarm":
                this.endpoint.createDefaultBooleanStateClusterServer();
                break;
            case "temperature":
            case "soilTemperature":
                this.endpoint.createDefaultTemperatureMeasurementClusterServer(null);
                break;
            case "soil":
                this.endpoint.createDefaultSoilMeasurementClusterServer(null);
                break;
            case "flow":
                this.endpoint.createDefaultFlowMeasurementClusterServer(null);
                break;
            case "humidity":
                this.endpoint.createDefaultRelativeHumidityMeasurementClusterServer(null);
                break;
            case "illuminance":
                this.endpoint.createDefaultIlluminanceMeasurementClusterServer(null);
                break;
            case "occupancy":
                this.endpoint.createDefaultOccupancySensingClusterServer();
                break;
            case "smoke":
                this.endpoint.createSmokeOnlySmokeCOAlarmClusterServer();
                break;
            case "button":
                this.endpoint.createDefaultMomentarySwitchClusterServer();
                break;
            case "lock":
            case "lockSensor":
                this.endpoint.createDefaultDoorLockClusterServer();
                break;
            case "thermostat":
                if (this.supportsCooling) {
                    // Changeover belongs to the installation, not an individual room. Do not advertise AutoMode.
                    this.endpoint.behaviors.require(
                        MatterbridgeThermostatServer.with(Thermostat.Feature.Heating, Thermostat.Feature.Cooling),
                        {
                            controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
                            localTemperature: 2000,
                            systemMode: Thermostat.SystemMode.Heat,
                            occupiedHeatingSetpoint: 2000,
                            minHeatSetpointLimit: 500,
                            maxHeatSetpointLimit: 3000,
                            absMinHeatSetpointLimit: 500,
                            absMaxHeatSetpointLimit: 3000,
                            thermostatRunningState: {
                                heat: false,
                                cool: false,
                                fan: false,
                                heatStage2: false,
                                coolStage2: false,
                                fanStage2: false,
                                fanStage3: false,
                            },
                            occupiedCoolingSetpoint: 2000,
                            minCoolSetpointLimit: 500,
                            maxCoolSetpointLimit: 3000,
                            absMinCoolSetpointLimit: 500,
                            absMaxCoolSetpointLimit: 3000,
                        },
                    );
                } else {
                    this.endpoint.createDefaultHeatingThermostatClusterServer(20, 20, 5, 30);
                }
                if ("humidity" in this.channel) {
                    this.endpoint.createDefaultRelativeHumidityMeasurementClusterServer(null);
                }
                break;
            case "valve":
                this.endpoint.createDefaultValveConfigurationAndControlClusterServer(0, undefined, 0, false);
                break;
            case "waterSupply":
                this.endpoint.createDefaultValveConfigurationAndControlClusterServer(0, undefined, 0, false);
                this.endpoint.behaviors.require(MatterbridgeValveConfigurationAndControlServer, {
                    currentState: null,
                    currentLevel: null,
                    targetState: null,
                    targetLevel: null,
                    levelStep: 100,
                });
                break;
            case "co2":
                this.endpoint
                    .createDefaultAirQualityClusterServer()
                    .createDefaultCarbonDioxideConcentrationMeasurementClusterServer(null);
                break;
        }
        if (this.metering || kind === "energy") {
            this.endpoint
                .createDefaultPowerTopologyClusterServer()
                .createDefaultElectricalPowerMeasurementClusterServer()
                .createDefaultElectricalEnergyMeasurementClusterServer();
        }
        this.endpoint.addRequiredClusterServers();
        this.installCommands();
    }

    private number(key: string, fallback: number): number {
        const value = this.channel[key];
        return finite(value) ? value : fallback;
    }

    private send<K extends keyof HmIPDeviceCommandBodies>(
        operation: K,
        body: HmIPDeviceCommandBodies[K],
    ): Promise<void> {
        return this.context.deviceCommand(
            operation,
            {
                deviceId: this.device.id,
                channelIndex: this.description.index,
            },
            body,
        );
    }

    private addCommand<C extends CommandHandlers>(name: C, handler: CommandHandlerFunction<C>): void {
        this.endpoint.addCommandHandler(name, (data) => {
            // Queue the entire operation, including reads of the previous successful command state.
            const result = this.commandQueue.then(() => handler(data));
            this.commandQueue = result.then(
                () => {},
                () => {},
            );
            return result;
        });
    }

    private async setLevel(value: number): Promise<void> {
        const dimLevel = clamp(value, 0, 1);
        if (this.description.kind === "notification") {
            const optical = this.channel.opticalSignalBehaviour !== undefined;
            await this.send(optical ? "setOpticalSignal" : "setSimpleRGBColorDimLevel", {
                dimLevel,
                simpleRGBColorState:
                    this.channel.simpleRGBColorState === "BLACK" && dimLevel > 0
                        ? "WHITE"
                        : typeof this.channel.simpleRGBColorState === "string"
                          ? this.channel.simpleRGBColorState
                          : "WHITE",
                ...(optical ? {opticalSignalBehaviour: dimLevel > 0 ? "ON" : "OFF"} : {}),
            });
        } else {
            await this.send("setDimLevel", {dimLevel});
        }
        this.channel = {...this.channel, dimLevel};
        if (dimLevel > 0) {
            this.lastLevel = dimLevel;
        }
    }

    private async setOn(on: boolean): Promise<void> {
        if (["dimmer", "notification"].includes(this.description.kind)) {
            return this.setLevel(on ? this.lastLevel : 0);
        }
        await this.send("setSwitchState", {on});
        this.channel = {...this.channel, on};
    }

    private async setColor(hue: number, saturationLevel: number): Promise<void> {
        const dimLevel = this.number("dimLevel", this.lastLevel);
        if (this.description.kind === "notification") {
            const color = nearestColor(hue, saturationLevel);
            const optical = this.channel.opticalSignalBehaviour !== undefined;
            await this.send(optical ? "setOpticalSignal" : "setSimpleRGBColorDimLevel", {
                dimLevel,
                simpleRGBColorState: color,
                ...(optical ? {opticalSignalBehaviour: dimLevel > 0 ? "ON" : "OFF"} : {}),
            });
            this.channel = {...this.channel, simpleRGBColorState: color};
        } else {
            await this.send("setHueSaturationDimLevel", {hue, saturationLevel, dimLevel});
        }
        this.channel = {...this.channel, hue, saturationLevel};
    }

    private installCommands(): void {
        const e = this.endpoint;
        const kind = this.description.kind;
        if (["switch", "dimmer", "color", "notification"].includes(kind)) {
            this.addCommand("on", () => this.setOn(true));
            this.addCommand("off", () => this.setOn(false));
            this.addCommand("toggle", () =>
                this.setOn(!(typeof this.channel.on === "boolean" ? this.channel.on : this.number("dimLevel", 0) > 0)),
            );
        }
        if (["dimmer", "color", "notification"].includes(kind)) {
            this.addCommand("moveToLevel", ({request}) => this.setLevel(request.level / 254));
            this.addCommand("moveToLevelWithOnOff", async ({request}) => {
                await this.setLevel(request.level / 254);
                if (kind === "color") {
                    await this.setOn(request.level > 0);
                }
            });
            this.addCommand("LevelControl.step", ({request}) =>
                this.setLevel(
                    this.number("dimLevel", 0) + ((request.stepMode === 0 ? 1 : -1) * request.stepSize) / 254,
                ),
            );
            this.addCommand("LevelControl.stepWithOnOff", ({request}) =>
                this.setLevel(
                    this.number("dimLevel", 0) + ((request.stepMode === 0 ? 1 : -1) * request.stepSize) / 254,
                ),
            );
            this.addCommand("LevelControl.move", () => {
                throw new Error("Continuous dimming is not supported by the cloud adapter; use an absolute level.");
            });
            this.addCommand("LevelControl.moveWithOnOff", () => {
                throw new Error("Continuous dimming is not supported by the cloud adapter; use an absolute level.");
            });
        }
        if (this.supportsHue) {
            this.addCommand("moveToHue", ({request}) =>
                this.setColor((request.hue * 360) / 254, this.number("saturationLevel", 1)),
            );
            this.addCommand("moveToSaturation", ({request}) =>
                this.setColor(this.number("hue", 0), request.saturation / 254),
            );
            this.addCommand("moveToHueAndSaturation", ({request}) =>
                this.setColor((request.hue * 360) / 254, request.saturation / 254),
            );
        }
        if (this.supportsCt) {
            this.addCommand("moveToColorTemperature", ({request}) =>
                this.send("setColorTemperatureDimLevel", {
                    colorTemperature: Math.round(
                        clamp(
                            1_000_000 / request.colorTemperatureMireds,
                            this.number("minimalColorTemperature", 2000),
                            this.number("maximumColorTemperature", 6500),
                        ),
                    ),
                    dimLevel: this.number("dimLevel", this.lastLevel),
                }),
            );
        }
        if (["cover", "blind", "shading"].includes(kind)) {
            const lift = (value: number) =>
                this.send(
                    kind === "shading" ? "setPrimaryShadingLevel" : "setShutterLevel",
                    kind === "shading" ? {primaryShadingLevel: value} : {shutterLevel: value},
                );
            this.addCommand("upOrOpen", () => lift(0));
            this.addCommand("downOrClose", () => lift(1));
            this.addCommand("stopMotion", () => this.send("stop", {}));
            this.addCommand("goToLiftPercentage", ({request}) =>
                lift(clamp(request.liftPercent100thsValue / 10_000, 0, 1)),
            );
            if (kind === "blind") {
                this.addCommand("goToTiltPercentage", ({request}) =>
                    this.send("setSlatsLevel", {
                        slatsLevel: clamp(request.tiltPercent100thsValue / 10_000, 0, 1),
                        shutterLevel: this.number("shutterLevel", 0),
                    }),
                );
            }
        }
        if (kind === "lock" || kind === "lockSensor") {
            const lock = (targetLockState: string) => {
                if (kind === "lockSensor") {
                    throw new Error("This Homematic IP lock sensor cannot actuate the lock.");
                }
                return this.send("setLockState", {
                    targetLockState,
                    authorizationPin: this.context.lockPins[this.device.id] ?? "",
                });
            };
            this.addCommand("lockDoor", () => lock("LOCKED"));
            this.addCommand("unlockDoor", () => lock("UNLOCKED"));
        }
        if (kind === "valve") {
            this.addCommand("open", ({request}) => {
                if (request.openDuration != null) {
                    return this.send("setWateringSwitchStateWithTime", {
                        wateringActive: true,
                        wateringTime: request.openDuration,
                    });
                }
                return this.send("setWateringSwitchState", {wateringActive: true});
            });
            this.addCommand("close", () => this.send("setWateringSwitchState", {wateringActive: false}));
        }
        if (kind === "waterSupply") {
            this.addCommand("open", ({request}) => {
                if (request.openDuration != null) {
                    throw new Error("Timed opening is not supported by the water supply valve.");
                }
                if (request.targetLevel !== undefined && request.targetLevel !== 100) {
                    throw new Error("Only fully opening the water supply valve is supported.");
                }
                return this.send("setWaterSupplyState", {waterSupplyState: "FULL_OPENED"});
            });
            this.addCommand("close", () => this.send("setWaterSupplyState", {waterSupplyState: "NO_WATERFLOW"}));
        }
        if (kind === "garage") {
            this.addCommand("ClosureControl.moveTo", ({request}) => {
                const command =
                    request.position === ClosureControl.TargetPosition.MoveToFullyClosed
                        ? "CLOSE"
                        : request.position === ClosureControl.TargetPosition.MoveToFullyOpen
                          ? "OPEN"
                          : request.position === ClosureControl.TargetPosition.MoveToVentilationPosition &&
                              this.channel.ventilationPositionSupported
                            ? "PARTIAL_OPEN"
                            : undefined;
                if (!command) {
                    throw new Error("Unsupported garage door position.");
                }
                return this.send("sendDoorCommand", {doorCommand: command});
            });
            this.addCommand("ClosureControl.stop", () => this.send("sendDoorCommand", {doorCommand: "STOP"}));
        }
        if (kind === "smoke") {
            this.addCommand("SmokeCoAlarm.selfTestRequest", () => {
                throw new Error(
                    "Remote physical smoke detector self-test is not available through this cloud adapter.",
                );
            });
        }
        if (kind === "thermostat") {
            for (const attribute of this.supportsCooling
                ? ["occupiedHeatingSetpoint", "occupiedCoolingSetpoint"]
                : ["occupiedHeatingSetpoint"]) {
                e.subscribeAttribute("Thermostat", attribute, (value: unknown, _old: unknown, context) => {
                    if (this.updating || !context.fabric || !finite(value)) {
                        return;
                    }
                    const cooling = heatingGroup(this.device, this.groups)?.cooling === true;
                    if ((attribute === "occupiedCoolingSetpoint") !== cooling) {
                        return;
                    }
                    void this.setTemperature(value / 100).catch(() =>
                        this.context.error("Homematic IP rejected the thermostat setpoint."),
                    );
                });
            }
            e.subscribeAttribute("Thermostat", "systemMode", (value: unknown, _old: unknown, context) => {
                if (this.updating || !context.fabric) {
                    return;
                }
                void this.setMode(value).catch(() => this.context.error("Homematic IP rejected the thermostat mode."));
            });
            this.addCommand("setpointRaiseLower", ({request}) =>
                this.setTemperature(
                    (heatingGroup(this.device, this.groups)?.setPointTemperature ??
                        this.number("setPointTemperature", 20)) +
                        request.amount / 10,
                ),
            );
        }
    }

    private async setTemperature(temperature: number): Promise<void> {
        const group = heatingGroup(this.device, this.groups);
        if (!group) {
            throw new Error("Thermostat has no heating group.");
        }
        if (temperature < (group.minTemperature ?? 5) || temperature > (group.maxTemperature ?? 30)) {
            throw new Error("Setpoint outside the heating group limits.");
        }
        await this.context.command("setHeatingSetPointTemperature", {
            groupId: group.id,
            setPointTemperature: Math.round(temperature * 2) / 2,
        });
    }

    private async setMode(mode: unknown): Promise<void> {
        const group = heatingGroup(this.device, this.groups);
        if (!group) {
            throw new Error("Thermostat has no heating group.");
        }
        if (mode !== 0 && mode !== (group.cooling === true ? 3 : 4)) {
            throw new Error("Unsupported thermostat mode.");
        }
        await this.context.command("setHeatingControlMode", {
            groupId: group.id,
            controlMode: "MANUAL",
        });
        if (mode === 0) {
            await this.setTemperature(
                group.cooling === true ? (group.maxTemperature ?? 30) : (group.minTemperature ?? 5),
            );
        }
    }

    async buttonEvent(event: string): Promise<void> {
        if (this.description.kind !== "button") {
            return;
        }
        // Long presses are followed by a short/release event on some devices; do not emit a second click.
        if (event === "KEY_PRESS_LONG_STOP") {
            await this.endpoint.triggerSwitchEvent("Long");
        } else if (
            event === "DOOR_BELL_SENSOR_EVENT" ||
            (event === "KEY_PRESS_SHORT" && this.lastButtonEvent !== "KEY_PRESS_LONG_START")
        ) {
            await this.endpoint.triggerSwitchEvent("Single");
        }
        this.lastButtonEvent = event;
    }

    async reachable(value: boolean): Promise<void> {
        await this.endpoint.setAttribute("BridgedDeviceBasicInformation", "reachable", value);
    }

    async update(device: HmIPDevice, channel: Channel, groups: Readonly<Record<string, HmIPGroup>>): Promise<void> {
        this.device = device;
        this.channel = channel;
        this.groups = groups;
        this.updating = true;
        const e = this.endpoint;
        const c = channel;
        const set = async (cluster: string, attribute: string, value: unknown) => {
            if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
                return;
            }
            await e.setAttribute(cluster, attribute, value as boolean | number | string | object | null);
        };
        const measurement = (key: string, cluster: string, transform: (value: number) => number) =>
            set(cluster, "measuredValue", c[key] === null ? null : finite(c[key]) ? transform(c[key]) : undefined);
        try {
            const maintenance = Object.values(device.functionalChannels).find(
                (raw) => "unreach" in raw || "lowBat" in raw,
            ) as Channel | undefined;
            await this.reachable(getHmIPDeviceReachability(device) !== false);
            if (typeof maintenance?.lowBat === "boolean" && e.hasAttributeServer("PowerSource", "batChargeLevel")) {
                await set("PowerSource", "batChargeLevel", maintenance.lowBat ? 2 : 0);
            }
            switch (this.description.kind) {
                case "switch":
                    await set("OnOff", "onOff", c.on);
                    break;
                case "dimmer":
                case "color":
                case "notification": {
                    if (finite(c.dimLevel) && c.dimLevel > 0) {
                        this.lastLevel = c.dimLevel;
                    }
                    await set(
                        "OnOff",
                        "onOff",
                        typeof c.on === "boolean" ? c.on : finite(c.dimLevel) ? c.dimLevel > 0 : undefined,
                    );
                    // Lighting levels are 1–254; off is represented by OnOff, not level zero.
                    await set(
                        "LevelControl",
                        "currentLevel",
                        finite(c.dimLevel) ? clamp(Math.round(c.dimLevel * 254), 1, 254) : undefined,
                    );
                    const simple =
                        typeof c.simpleRGBColorState === "string" ? simpleColors[c.simpleRGBColorState] : undefined;
                    if (this.supportsHue) {
                        const hue = simple?.[0] ?? c.hue;
                        const saturation = simple?.[1] ?? c.saturationLevel;
                        await set(
                            "ColorControl",
                            "currentHue",
                            finite(hue) ? Math.round((clamp(hue, 0, 360) * 254) / 360) : undefined,
                        );
                        await set(
                            "ColorControl",
                            "currentSaturation",
                            finite(saturation) ? Math.round(clamp(saturation, 0, 1) * 254) : undefined,
                        );
                    }
                    if (this.supportsCt) {
                        await set(
                            "ColorControl",
                            "colorTemperatureMireds",
                            finite(c.colorTemperature) && c.colorTemperature > 0
                                ? Math.round(1_000_000 / c.colorTemperature)
                                : undefined,
                        );
                    }
                    break;
                }
                case "cover":
                case "blind":
                case "shading": {
                    const level = this.description.kind === "shading" ? c.primaryShadingLevel : c.shutterLevel;
                    await set(
                        "WindowCovering",
                        "currentPositionLiftPercent100ths",
                        finite(level) ? percent100ths(level) : null,
                    );
                    if (c.processing === false) {
                        await set(
                            "WindowCovering",
                            "targetPositionLiftPercent100ths",
                            finite(level) ? percent100ths(level) : null,
                        );
                    }
                    if (this.description.kind === "blind") {
                        await set(
                            "WindowCovering",
                            "currentPositionTiltPercent100ths",
                            finite(c.slatsLevel) ? percent100ths(c.slatsLevel) : null,
                        );
                        if (c.processing === false) {
                            await set(
                                "WindowCovering",
                                "targetPositionTiltPercent100ths",
                                finite(c.slatsLevel) ? percent100ths(c.slatsLevel) : null,
                            );
                        }
                    }
                    break;
                }
                case "contact":
                    if (["OPEN", "CLOSED", "TILTED"].includes(String(c.windowState))) {
                        await set("BooleanState", "stateValue", c.windowState === "CLOSED");
                    }
                    break;
                case "temperature":
                    await measurement("actualTemperature", "TemperatureMeasurement", (value) =>
                        Math.round(clamp(value, -273.15, 327.67) * 100),
                    );
                    break;
                case "humidity":
                    await measurement("humidity", "RelativeHumidityMeasurement", (value) =>
                        Math.round(clamp(value, 0, 100) * 100),
                    );
                    break;
                case "illuminance": {
                    const lux = c.currentIllumination ?? c.illumination ?? c.averageIllumination;
                    await set("IlluminanceMeasurement", "measuredValue", finite(lux) ? illuminance(lux) : null);
                    break;
                }
                case "occupancy": {
                    const occupied = c.motionDetected ?? c.presenceDetected;
                    if (typeof occupied === "boolean") {
                        await set("OccupancySensing", "occupancy", {occupied});
                    }
                    break;
                }
                case "smoke": {
                    if (typeof c.smokeDetectorAlarmType !== "string") {
                        break;
                    }
                    const alarm =
                        c.smokeDetectorAlarmType === "PRIMARY_ALARM" || c.smokeDetectorAlarmType === "SECONDARY_ALARM";
                    await set("SmokeCoAlarm", "smokeState", alarm ? 2 : 0);
                    await set("SmokeCoAlarm", "expressedState", alarm ? 1 : maintenance?.lowBat ? 3 : 0);
                    await set("SmokeCoAlarm", "batteryAlert", maintenance?.lowBat ? 2 : 0);
                    if (alarm !== this.lastSmokeAlarm) {
                        await e.triggerEvent(
                            "SmokeCoAlarm",
                            alarm ? "smokeAlarm" : "allClear",
                            alarm ? {alarmSeverityLevel: 2} : {},
                        );
                        this.lastSmokeAlarm = alarm;
                    }
                    break;
                }
                case "water":
                    if (typeof c.waterlevelDetected === "boolean" || typeof c.moistureDetected === "boolean") {
                        await set(
                            "BooleanState",
                            "stateValue",
                            c.waterlevelDetected === true || c.moistureDetected === true,
                        );
                    }
                    break;
                case "waterAlarm":
                    if (typeof c.waterAlarmActive === "boolean") {
                        await set("BooleanState", "stateValue", c.waterAlarmActive);
                    }
                    break;
                case "soil":
                    await set(
                        "SoilMeasurement",
                        "soilMoistureMeasuredValue",
                        finite(c.soilMoisture) && c.soilMoisture >= 0 && c.soilMoisture <= 100 ? c.soilMoisture : null,
                    );
                    break;
                case "soilTemperature":
                    await measurement("soilTemperature", "TemperatureMeasurement", (value) =>
                        Math.round(clamp(value, -273.15, 327.67) * 100),
                    );
                    break;
                case "flow":
                    // Cloud: litres/minute. Matter: 10 * cubic metres/hour (coarse 0.1 m³/h resolution).
                    await set(
                        "FlowMeasurement",
                        "measuredValue",
                        finite(c.waterFlow) && c.waterFlow >= 0 && c.waterFlow * 0.6 <= 65534
                            ? Math.round(c.waterFlow * 0.6)
                            : null,
                    );
                    break;
                case "waterSupply":
                    await set(
                        "ValveConfigurationAndControl",
                        "currentState",
                        c.processing === true
                            ? 2
                            : c.waterSupplyState === "NO_WATERFLOW"
                              ? 0
                              : ["FULL_OPENED", "REDUCED_WATERFLOW"].includes(String(c.waterSupplyState))
                                ? 1
                                : null,
                    );
                    await set(
                        "ValveConfigurationAndControl",
                        "currentLevel",
                        c.processing === true
                            ? null
                            : c.waterSupplyState === "NO_WATERFLOW"
                              ? 0
                              : c.waterSupplyState === "FULL_OPENED"
                                ? 100
                                : null,
                    );
                    if (c.processing === false) {
                        await set("ValveConfigurationAndControl", "targetState", null);
                        await set("ValveConfigurationAndControl", "targetLevel", null);
                    }
                    break;
                case "rain":
                    if (typeof c.raining === "boolean") {
                        await set("BooleanState", "stateValue", c.raining);
                    }
                    break;
                case "lock":
                case "lockSensor":
                    await set(
                        "DoorLock",
                        "lockState",
                        c.lockState === "LOCKED" ? 1 : ["UNLOCKED", "OPEN"].includes(String(c.lockState)) ? 2 : null,
                    );
                    break;
                case "valve":
                    if (typeof c.wateringActive === "boolean") {
                        await set("ValveConfigurationAndControl", "currentState", c.wateringActive ? 1 : 0);
                    }
                    break;
                case "thermostat": {
                    const group = heatingGroup(device, groups);
                    const actual = group?.actualTemperature ?? c.actualTemperature ?? c.valveActualTemperature;
                    const target = group?.setPointTemperature ?? c.setPointTemperature;
                    const cooling = this.supportsCooling && group?.cooling === true;
                    if (e.hasClusterServer("RelativeHumidityMeasurement")) {
                        const humidity = c.humidity;
                        await set(
                            "RelativeHumidityMeasurement",
                            "measuredValue",
                            finite(humidity) ? Math.round(clamp(humidity, 0, 100) * 100) : null,
                        );
                    }
                    await set("Thermostat", "localTemperature", finite(actual) ? Math.round(actual * 100) : null);
                    await set(
                        "Thermostat",
                        cooling ? "occupiedCoolingSetpoint" : "occupiedHeatingSetpoint",
                        finite(target) ? Math.round(target * 100) : undefined,
                    );
                    const valve = group?.valvePosition ?? c.valvePosition;
                    const active = finite(valve)
                        ? valve > 0
                        : finite(actual) && finite(target)
                          ? cooling
                              ? actual > target
                              : actual < target
                          : false;
                    await set("Thermostat", "thermostatRunningState", {
                        heat: !cooling && active,
                        cool: cooling && active,
                        fan: false,
                        heatStage2: false,
                        coolStage2: false,
                        fanStage2: false,
                        fanStage3: false,
                    });
                    if (group) {
                        await set("Thermostat", "minHeatSetpointLimit", Math.round((group.minTemperature ?? 5) * 100));
                        await set("Thermostat", "maxHeatSetpointLimit", Math.round((group.maxTemperature ?? 30) * 100));
                        if (this.supportsCooling) {
                            await set(
                                "Thermostat",
                                "minCoolSetpointLimit",
                                Math.round((group.minTemperature ?? 5) * 100),
                            );
                            await set(
                                "Thermostat",
                                "maxCoolSetpointLimit",
                                Math.round((group.maxTemperature ?? 30) * 100),
                            );
                        }
                        await set("Thermostat", "systemMode", cooling ? 3 : 4);
                    }
                    break;
                }
                case "garage": {
                    const position =
                        c.doorState === "CLOSED"
                            ? ClosureControl.CurrentPosition.FullyClosed
                            : c.doorState === "OPEN"
                              ? ClosureControl.CurrentPosition.FullyOpened
                              : c.doorState === "VENTILATION_POSITION"
                                ? ClosureControl.CurrentPosition.OpenedForVentilation
                                : null;
                    await set("ClosureControl", "overallCurrentState", {
                        position,
                        secureState: position === ClosureControl.CurrentPosition.FullyClosed,
                    });
                    await set(
                        "ClosureControl",
                        "mainState",
                        c.processing ? ClosureControl.MainState.Moving : ClosureControl.MainState.Stopped,
                    );
                    break;
                }
                case "co2":
                    await measurement("carbonDioxideConcentration", "CarbonDioxideConcentrationMeasurement", (value) =>
                        Math.max(0, value),
                    );
                    break;
            }
            if (this.metering || this.description.kind === "energy") {
                await set(
                    "ElectricalPowerMeasurement",
                    "activePower",
                    finite(c.currentPowerConsumption) ? Math.round(c.currentPowerConsumption * 1000) : null,
                );
                const imported = this.description.kind === "energy" ? meterEnergy(c, "import") : c.energyCounter;
                await set(
                    "ElectricalEnergyMeasurement",
                    "cumulativeEnergyImported",
                    finite(imported) ? {energy: Math.round(imported * 1_000_000)} : null,
                );
                if (this.description.kind === "energy") {
                    const exported = meterEnergy(c, "export");
                    await set(
                        "ElectricalEnergyMeasurement",
                        "cumulativeEnergyExported",
                        exported === null ? null : {energy: Math.round(exported * 1_000_000)},
                    );
                }
            }
        } finally {
            this.updating = false;
        }
    }
}
