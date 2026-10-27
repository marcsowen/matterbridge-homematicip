import {
    getHmIPDeviceReachability,
    HmIPClient,
    type HmIPCommand,
    type HmIPDevice,
    type HmIPDeviceCommand,
    type HmIPGroup,
    HmIPSession,
    type HmIPSessionTransport,
    type HmIPState,
    type HmIPStateChange,
    isHmIPRecord,
} from "homematicip-cloud-client-ts";
import {MatterbridgeDynamicPlatform, type PlatformConfig, type PlatformMatterbridge} from "matterbridge";
import type {AnsiLogger} from "matterbridge/logger";
import {type Configuration, parseConfig} from "./config.js";
import {BridgedEntity} from "./entity.js";
import {describeDevice} from "./mapping.js";

export interface CloudClient extends HmIPSessionTransport {
    command: HmIPCommand;
    deviceCommand: HmIPDeviceCommand;
    shutdown(): void;
}

export default function initializePlugin(
    matterbridge: PlatformMatterbridge,
    log: AnsiLogger,
    config: PlatformConfig,
): HmIPPlatform {
    return new HmIPPlatform(matterbridge, log, config);
}

export class HmIPPlatform extends MatterbridgeDynamicPlatform {
    readonly entities = new Map<string, BridgedEntity>();
    private readonly devices = new Map<string, HmIPDevice>();
    private groups: Record<string, HmIPGroup> = {};
    private coolingEnabled = false;
    private readonly settings: Configuration;
    private readonly client: CloudClient;
    private session?: HmIPSession;
    private queue: Promise<void> = Promise.resolve();
    private transportConnected = false;
    private stopped = false;
    private readonly unsupported = new Set<string>();

    constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig, client?: CloudClient) {
        const settings = parseConfig(config);
        super(matterbridge, log, config);
        if (!this.verifyMatterbridgeVersion("3.11.0")) {
            throw new Error("Matterbridge 3.11.0 or newer is required.");
        }
        this.settings = settings;
        this.client =
            client ??
            new HmIPClient(log, {
                accessPoint: this.settings.accessPoint,
                authToken: this.settings.authToken,
                pin: this.settings.pin,
                applicationIdentifier: "matterbridge-homematicip",
                applicationVersion: "0.0.1",
            });
    }

    override async onStart(): Promise<void> {
        await this.ready;
        await this.clearSelect();
        this.session = new HmIPSession(this.client, {
            snapshot: (state) => this.enqueue(() => this.applySnapshot(state)),
            change: (change, state) => this.enqueue(() => this.applyChanges(change, state)),
            status: (status) => {
                this.transportConnected = status === "ready";
                return this.enqueue(async () => {
                    for (const device of this.devices.values()) {
                        await this.upsertDevice(device);
                    }
                });
            },
            error: (error) => this.log.warn(`Homematic IP synchronization: ${error.message}`),
        });
        await this.session.start();
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        const next = this.queue.then(async () => {
            if (!this.stopped) {
                await task();
            }
        });
        this.queue = next.catch(() => {
            // The client logs redacted diagnostics. Never dump cloud payloads, tokens, or lock PINs here.
            this.log.error("Homematic IP adapter update failed.");
        });
        return next;
    }

    private async applySnapshot(state: HmIPState): Promise<void> {
        this.groups = state.groups;
        this.coolingEnabled = Object.values(state.home?.functionalHomes ?? {}).some(
            (solution) => isHmIPRecord(solution) && solution.coolingEnabled === true,
        );
        for (const id of this.devices.keys()) {
            if (!state.devices[id]) {
                await this.removeDevice(id);
            }
        }
        for (const device of Object.values(state.devices)) {
            await this.upsertDevice(device);
        }
    }

    private async upsertDevice(device: HmIPDevice): Promise<void> {
        if (this.stopped) {
            return;
        }
        const previous = this.devices.get(device.id);
        const isUnreachable = getHmIPDeviceReachability(device) === false;
        if (previous ? (getHmIPDeviceReachability(previous) === false) !== isUnreachable : isUnreachable) {
            this.log.info(
                `Homematic IP device "${device.label}" (${device.type}) is ${isUnreachable ? "unreachable" : "reachable again"} according to the cloud.`,
            );
        }
        this.devices.set(device.id, device);
        this.setSelectDevice(device.id, device.label);
        const descriptions =
            this.settings.excludedDevices.has(device.id) || !this.validateDevice([device.id, device.label])
                ? []
                : describeDevice(device);
        const active = new Set(descriptions.map((entity) => entity.id));
        for (const [id, entity] of this.entities) {
            if (entity.description.deviceId === device.id && !active.has(id)) {
                await this.unregisterDevice(entity.endpoint);
                this.entities.delete(id);
            }
        }
        if (
            !descriptions.length &&
            !this.unsupported.has(device.type) &&
            !this.settings.excludedDevices.has(device.id)
        ) {
            this.unsupported.add(device.type);
            this.log.info(`No supported Matter channels for Homematic IP type ${device.type}.`);
        }
        for (const description of descriptions) {
            try {
                let entity = this.entities.get(description.id);
                if (!entity) {
                    let label = description.label;
                    let number = 2;
                    while (this.hasDeviceName(label)) {
                        label = `${description.label} (${number++})`;
                    }
                    entity = new BridgedEntity({...description, label}, device, {
                        groups: this.groups,
                        coolingEnabled: this.coolingEnabled,
                        vendorId: this.matterbridge.aggregatorVendorId,
                        lockPins: this.settings.lockPins,
                        deviceCommand: (operation, address, body) => {
                            if (this.stopped) {
                                return Promise.reject(new Error("Plugin is shutting down."));
                            }
                            return this.client.deviceCommand(operation, address, body);
                        },
                        command: (operation, body) => {
                            if (this.stopped) {
                                return Promise.reject(new Error("Plugin is shutting down."));
                            }
                            return this.client.command(operation, body);
                        },
                        error: (message) => this.log.error(message),
                    });
                    await this.registerDevice(entity.endpoint);
                    this.entities.set(description.id, entity);
                }
                await entity.update(device, description.channel, this.groups);
                if (this.transportConnected === false) {
                    await entity.reachable(false);
                }
            } catch {
                this.log.error(
                    `Could not synchronize ${device.type} channel ${description.index} (${description.kind}).`,
                );
                throw new Error("Matter endpoint synchronization failed.");
            }
        }
    }

    private async removeDevice(id: string): Promise<void> {
        for (const [key, entity] of this.entities) {
            if (entity.description.deviceId !== id) {
                continue;
            }
            await this.unregisterDevice(entity.endpoint);
            this.entities.delete(key);
        }
        this.devices.delete(id);
        await this.clearDeviceSelect(id);
    }

    private async applyChanges(change: HmIPStateChange, state: HmIPState): Promise<void> {
        this.groups = state.groups;
        this.coolingEnabled = Object.values(state.home?.functionalHomes ?? {}).some(
            (solution) => isHmIPRecord(solution) && solution.coolingEnabled === true,
        );
        let groupsChanged = false;
        for (const event of Object.values(change.events)) {
            switch (event.pushEventType) {
                case "DEVICE_ADDED":
                case "DEVICE_CHANGED":
                    await this.upsertDevice(event.device);
                    break;
                case "DEVICE_REMOVED":
                    await this.removeDevice(event.device.id);
                    break;
                case "GROUP_ADDED":
                case "GROUP_CHANGED":
                    groupsChanged = true;
                    break;
                case "GROUP_REMOVED":
                    groupsChanged = true;
                    break;
                case "DEVICE_CHANNEL_EVENT":
                    for (const entity of this.entities.values()) {
                        if (
                            entity.description.deviceId === event.deviceId &&
                            entity.description.index === event.channelIndex
                        ) {
                            await entity.buttonEvent(event.channelEventType);
                        }
                    }
                    break;
            }
        }
        if (groupsChanged) {
            for (const device of this.devices.values()) {
                await this.upsertDevice(device);
            }
        }
    }

    override async onConfigure(): Promise<void> {
        await super.onConfigure();
        await this.enqueue(async () => {
            for (const device of this.devices.values()) {
                await this.upsertDevice(device);
            }
        });
    }

    override async onShutdown(reason?: string): Promise<void> {
        this.stopped = true;
        await this.session?.stop();
        this.client.shutdown();
        await this.queue;
        this.entities.clear();
        this.devices.clear();
        await super.onShutdown(reason);
    }
}
