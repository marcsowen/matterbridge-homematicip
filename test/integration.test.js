import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {Endpoint, Environment, ServerNode} from "matterbridge/matter";
import {AggregatorEndpoint} from "matterbridge/matter/endpoints";
import {BridgedEntity} from "../dist/entity.js";

test("initialized Matter endpoints accept cloud state with correct units and semantics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hmip-matter-test-"));
    const environment = new Environment("hmip-test", Environment.default);
    environment.vars.set("path.root", directory);
    environment.vars.set("runtime.signals", false);
    environment.vars.set("runtime.exitcode", false);
    environment.vars.set("log.level", "error");
    let server;
    try {
        server = await ServerNode.create({
            id: "test",
            environment,
            network: {port: 0},
            basicInformation: {
                vendorId: 65521,
                productId: 32768,
                vendorName: "Test",
                productName: "Test",
                serialNumber: "Test",
            },
        });
        const aggregator = new Endpoint(AggregatorEndpoint, {id: "aggregator"});
        await server.add(aggregator);
        const cases = [
            [
                "switch",
                {
                    functionalChannelType: "SWITCH_MEASURING_CHANNEL",
                    on: true,
                    currentPowerConsumption: 42,
                    energyCounter: 1.5,
                },
                "OnOff",
                "onOff",
                true,
                "BRAND_SWITCH_MEASURING",
            ],

            [
                "thermostat",
                {actualTemperature: 21.25, setPointTemperature: 22, humidity: 45.5},
                "Thermostat",
                "localTemperature",
                2125,
            ],
            ["co2", {carbonDioxideConcentration: null}, "CarbonDioxideConcentrationMeasurement", "measuredValue", null],
            [
                "energy",
                {
                    connectedEnergySensorType: "ES_IEC",
                    energyCounterOneType: "ENERGY_COUNTER_USAGE_HIGH_TARIFF",
                    energyCounterOne: null,
                },
                "ElectricalEnergyMeasurement",
                "cumulativeEnergyImported",
                null,
            ],
            [
                "waterSupply",
                {waterSupplyState: "FULL_OPENED", processing: false},
                "ValveConfigurationAndControl",
                "currentLevel",
                100,
            ],
            [
                "waterSupply",
                {waterSupplyState: "REDUCED_WATERFLOW", processing: false},
                "ValveConfigurationAndControl",
                "currentLevel",
                null,
            ],

            ["soil", {soilMoisture: 56}, "SoilMeasurement", "soilMoistureMeasuredValue", 56],
            ["soil", {soilMoisture: null}, "SoilMeasurement", "soilMoistureMeasuredValue", null],
            ["soil", {soilMoisture: 101}, "SoilMeasurement", "soilMoistureMeasuredValue", null],
            ["soilTemperature", {soilTemperature: -2.5}, "TemperatureMeasurement", "measuredValue", -250],
            ["flow", {waterFlow: 10}, "FlowMeasurement", "measuredValue", 6],
            ["flow", {waterFlow: null}, "FlowMeasurement", "measuredValue", null],
            ["flow", {waterFlow: -1}, "FlowMeasurement", "measuredValue", null],
            ["waterSupply", {waterSupplyState: "FULL_OPENED"}, "ValveConfigurationAndControl", "currentState", 1],
            ["waterSupply", {waterSupplyState: "REDUCED_WATERFLOW"}, "ValveConfigurationAndControl", "currentState", 1],
            ["waterSupply", {waterSupplyState: "NO_WATERFLOW"}, "ValveConfigurationAndControl", "currentState", 0],
            ["waterSupply", {waterSupplyState: "UNKNOWN"}, "ValveConfigurationAndControl", "currentState", null],
            [
                "waterSupply",
                {waterSupplyState: "FULL_OPENED", processing: true},
                "ValveConfigurationAndControl",
                "currentState",
                2,
            ],
            ["waterAlarm", {waterAlarmActive: true}, "BooleanState", "stateValue", true],
            [
                "energy",
                {connectedEnergySensorType: "ES_LED", energyCounterOne: 1.5},
                "ElectricalEnergyMeasurement",
                "cumulativeEnergyImported",
                {energy: 1500000},
            ],
            [
                "energy",
                {
                    connectedEnergySensorType: "ES_IEC",
                    energyCounterOne: 2,
                    energyCounterOneType: "ENERGY_COUNTER_INPUT_SINGLE_TARIFF",
                },
                "ElectricalEnergyMeasurement",
                "cumulativeEnergyExported",
                {energy: 2000000},
            ],
            ["energy", {currentPowerConsumption: -42.5}, "ElectricalPowerMeasurement", "activePower", -42500],

            ["temperature", {actualTemperature: 21.25}, "TemperatureMeasurement", "measuredValue", 2125],
            ["humidity", {humidity: 45.5}, "RelativeHumidityMeasurement", "measuredValue", 4550],
            ["illuminance", {illumination: 100}, "IlluminanceMeasurement", "measuredValue", 20001],
            ["contact", {windowState: "CLOSED"}, "BooleanState", "stateValue", true],
            ["water", {waterlevelDetected: true}, "BooleanState", "stateValue", true],
            ["rain", {raining: false}, "BooleanState", "stateValue", false],
            ["occupancy", {presenceDetected: true}, "OccupancySensing", "occupancy", {occupied: true}],
            ["smoke", {smokeDetectorAlarmType: "PRIMARY_ALARM"}, "SmokeCoAlarm", "smokeState", 2],
            ["switch", {on: true}, "OnOff", "onOff", true],
            ["color", {dimLevel: 0.5}, "LevelControl", "currentLevel", 127],
            ["dimmer", {dimLevel: 0.5}, "LevelControl", "currentLevel", 127],
            [
                "cover",
                {shutterLevel: 0.75, processing: false},
                "WindowCovering",
                "currentPositionLiftPercent100ths",
                7500,
            ],
            [
                "blind",
                {shutterLevel: 0.25, slatsLevel: 0.5, processing: false},
                "WindowCovering",
                "currentPositionTiltPercent100ths",
                5000,
            ],
            ["lock", {lockState: "LOCKED"}, "DoorLock", "lockState", 1],
            ["valve", {wateringActive: true}, "ValveConfigurationAndControl", "currentState", 1],
            [
                "thermostat",
                {valveActualTemperature: 21, setPointTemperature: 22},
                "Thermostat",
                "occupiedHeatingSetpoint",
                2200,
            ],
            [
                "garage",
                {doorState: "OPEN", processing: false},
                "ClosureControl",
                "overallCurrentState",
                {position: 1, secureState: false},
            ],
            ["notification", {dimLevel: 0.5, simpleRGBColorState: "GREEN"}, "ColorControl", "currentHue", 85],
            ["co2", {carbonDioxideConcentration: 650}, "CarbonDioxideConcentrationMeasurement", "measuredValue", 650],
            [
                "switch",
                {
                    functionalChannelType: "SWITCH_MEASURING_CHANNEL",
                    on: true,
                    energyCounter: 1.5,
                    currentPowerConsumption: 42,
                },
                "ElectricalEnergyMeasurement",
                "cumulativeEnergyImported",
                {energy: 1500000},
            ],
        ];
        for (const [index, [kind, channel, cluster, attribute, expected, deviceType]] of cases.entries()) {
            const device = {
                id: `device${index}`,
                type: deviceType ?? "PLUGABLE_SWITCH",
                label: "Test",
                modelType: "HmIP-Test",
                firmwareVersion: "1.0",
                functionalChannels: {
                    0: {functionalChannelType: "DEVICE_BASE", lowBat: false, unreach: false},
                    1: channel,
                },
            };
            const entity = new BridgedEntity(
                {id: `${device.id}:1:${kind}`, deviceId: device.id, kind, index: 1, label: "Test", channel},
                device,
                {
                    vendorId: 65521,
                    lockPins: {},
                    command: async () => {},
                    deviceCommand: async () => {},
                    error: assert.fail,
                },
            );
            await aggregator.add(entity.endpoint);
            assert.equal(entity.endpoint.getAttribute("BridgedDeviceBasicInformation", "serialNumber"), device.id);
            assert.equal(
                entity.endpoint.getAttribute("BridgedDeviceBasicInformation", "uniqueId"),
                entity.endpoint.uniqueId,
            );
            await entity.update(device, channel, {});
            const batteryAttributes = entity.endpoint.getAttribute("PowerSource", "attributeList").map(Number);
            assert.ok(!batteryAttributes.includes(0x0c), "unknown battery percentage is not advertised");
            assert.ok(!batteryAttributes.includes(0x0b), "unmeasured battery voltage is not advertised");
            assert.equal(entity.endpoint.getAttribute("PowerSource", "batChargeLevel"), 0);
            const lowBatteryDevice = {
                ...device,
                functionalChannels: {
                    ...device.functionalChannels,
                    0: {...device.functionalChannels[0], lowBat: true},
                },
            };
            await entity.update(lowBatteryDevice, channel, {});
            assert.equal(entity.endpoint.getAttribute("PowerSource", "batChargeLevel"), 2);
            assert.equal(entity.endpoint.getAttribute("BridgedDeviceBasicInformation", "reachable"), true);
            await entity.update(device, channel, {});
            assert.equal(entity.endpoint.getAttribute("PowerSource", "batChargeLevel"), 0);
            assert.deepEqual(
                JSON.parse(JSON.stringify(entity.endpoint.getAttribute(cluster, attribute))),
                expected,
                kind,
            );
            if (deviceType === "BRAND_SWITCH_MEASURING") {
                const types = entity.endpoint
                    .getAttribute("Descriptor", "deviceTypeList")
                    .map((type) => Number(type.deviceType));
                assert.ok(types.includes(0x0100), "BSM is an OnOffLight");
                assert.ok(!types.includes(0x010f), "BSM is not a mounted control");
                assert.equal(entity.endpoint.getAttribute("ElectricalPowerMeasurement", "activePower"), 42000);
                assert.equal(
                    Number(
                        entity.endpoint.getAttribute("ElectricalEnergyMeasurement", "cumulativeEnergyImported").energy,
                    ),
                    1500000,
                );
                await entity.update(device, {...channel, on: false}, {});
                assert.equal(entity.endpoint.getAttribute("OnOff", "onOff"), false);
            }
            if (kind === "thermostat" && "humidity" in channel) {
                assert.equal(entity.endpoint.getAttribute("Thermostat", "occupiedHeatingSetpoint"), 2200);
                assert.equal(entity.endpoint.getAttribute("RelativeHumidityMeasurement", "measuredValue"), 4550);
                const types = entity.endpoint
                    .getAttribute("Descriptor", "deviceTypeList")
                    .map((type) => Number(type.deviceType));
                assert.equal(
                    types[0],
                    0x0301,
                    "thermostat remains the first device type after endpoint initialization",
                );
                assert.ok(types.includes(0x0307), "humidity sensor device type");
                assert.equal(entity.endpoint.hasClusterServer("TemperatureMeasurement"), false);
                await entity.update(device, {...channel, humidity: null}, {});
                assert.equal(entity.endpoint.getAttribute("RelativeHumidityMeasurement", "measuredValue"), null);
                await entity.update(device, {...channel, humidity: 50}, {});
                assert.equal(entity.endpoint.getAttribute("RelativeHumidityMeasurement", "measuredValue"), 5000);
                const coolingChannel = {...channel, groups: ["climate"]};
                const coolingDevice = {...device, id: "cooling-device", functionalChannels: {1: coolingChannel}};
                const group = {
                    id: "climate",
                    type: "HEATING",
                    cooling: false,
                    coolingAllowed: true,
                    actualTemperature: 26,
                    setPointTemperature: 22,
                    humidity: 50,
                    minTemperature: 5,
                    maxTemperature: 30,
                    controlMode: "AUTOMATIC",
                    valvePosition: null,
                };
                const calls = [];
                const climate = new BridgedEntity(
                    {
                        id: "cooling-device:1:thermostat",
                        deviceId: coolingDevice.id,
                        kind,
                        index: 1,
                        label: "Cooling",
                        channel: coolingChannel,
                    },
                    coolingDevice,
                    {
                        vendorId: 65521,
                        lockPins: {},
                        groups: {climate: group},
                        coolingEnabled: true,
                        command: async (operation, body) => calls.push({operation, body}),
                        deviceCommand: async () => {},
                        error: assert.fail,
                    },
                );
                const heatingOnly = new BridgedEntity(
                    {
                        id: "heating-only",
                        deviceId: coolingDevice.id,
                        kind,
                        index: 1,
                        label: "Heating only",
                        channel: coolingChannel,
                    },
                    coolingDevice,
                    {
                        vendorId: 65521,
                        lockPins: {},
                        groups: {climate: group},
                        coolingEnabled: false,
                        command: async () => {},
                        deviceCommand: async () => {},
                        error: assert.fail,
                    },
                );
                await aggregator.add(heatingOnly.endpoint);
                assert.equal(
                    heatingOnly.endpoint.getAttribute("Thermostat", "featureMap").cooling,
                    false,
                    "room coolingAllowed alone does not establish installation cooling capability",
                );
                await aggregator.add(climate.endpoint);
                const read = (attribute) => climate.endpoint.getAttribute("Thermostat", attribute);
                assert.equal(read("featureMap").cooling, true);
                assert.equal(read("featureMap").autoMode, false);
                for (const cooling of [false, true, false]) {
                    group.cooling = cooling;
                    await climate.update(coolingDevice, coolingChannel, {climate: group});
                    assert.equal(read("systemMode"), cooling ? 3 : 4);
                    assert.equal(read(cooling ? "occupiedCoolingSetpoint" : "occupiedHeatingSetpoint"), 2200);
                    assert.equal(read("thermostatRunningState").cool, cooling);
                    assert.equal(read("thermostatRunningState").heat, false);
                }
                group.cooling = true;
                group.actualTemperature = 20;
                await climate.update(coolingDevice, coolingChannel, {climate: group});
                assert.equal(read("thermostatRunningState").cool, false);
                group.valvePosition = 0.5;
                await climate.update(coolingDevice, coolingChannel, {climate: group});
                assert.equal(read("thermostatRunningState").cool, true);
                await assert.rejects(() => climate.setMode(4), /Unsupported thermostat mode/);
                assert.equal(calls.length, 0, "mode mismatch must not issue any cloud commands");
                await climate.setTemperature(23);
                assert.deepEqual(calls.pop(), {
                    operation: "setHeatingSetPointTemperature",
                    body: {groupId: "climate", setPointTemperature: 23},
                });
                await climate.setMode(0);
                assert.equal(calls.at(-1).body.setPointTemperature, 30, "Off in cooling uses the upper limit");
            }
            if (["dimmer", "color", "notification"].includes(kind)) {
                for (const [dimLevel, level, on] of [
                    [0, 1, false],
                    [0.0001, 1, true],
                    [1, 254, true],
                    [0, 1, false],
                ]) {
                    await entity.update(device, {...channel, dimLevel}, {});
                    assert.equal(
                        entity.endpoint.getAttribute("LevelControl", "currentLevel"),
                        level,
                        `${kind}: ${dimLevel}`,
                    );
                    assert.equal(entity.endpoint.getAttribute("OnOff", "onOff"), on, `${kind}: ${dimLevel}`);
                }
            }
        }
    } finally {
        await server?.close();
        await environment.close();
        await rm(directory, {recursive: true, force: true});
    }
});
