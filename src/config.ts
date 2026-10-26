import type {PlatformConfig} from "matterbridge";

export interface Configuration {
    accessPoint: string;
    authToken: string;
    pin?: string;
    excludedDevices: Set<string>;
    lockPins: Record<string, string>;
}

export function parseConfig(config: PlatformConfig): Configuration {
    const accessPoint =
        typeof config.accessPoint === "string" ? config.accessPoint.replace(/[-\s]/g, "").toUpperCase() : "";
    const authToken = typeof config.authToken === "string" ? config.authToken.trim() : "";
    if (!/^[A-F0-9]{24}$/.test(accessPoint)) {
        throw new Error(
            "Configure accessPoint with the 24 hexadecimal characters printed on your Homematic IP controller.",
        );
    }
    if (!authToken) {
        throw new Error("Configure authToken with a paired Homematic IP cloud token. See README for pairing.");
    }
    const pin = config.pin;
    if (pin !== undefined && (typeof pin !== "string" || !/^\d*$/.test(pin))) {
        throw new Error("Controller PIN must be a string containing digits.");
    }
    const excluded = config.excludedDevices ?? [];
    if (!Array.isArray(excluded) || !excluded.every((id) => typeof id === "string")) {
        throw new Error("excludedDevices must be an array of device IDs.");
    }
    const lockPins: Record<string, string> = {};
    const pins = config.lockPins ?? {};
    if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
        throw new Error("lockPins must map device IDs to PIN strings.");
    }
    for (const [id, pin] of Object.entries(pins)) {
        if (typeof pin !== "string" || !/^\d*$/.test(pin)) {
            throw new Error("Lock PINs must be strings containing digits.");
        }
        lockPins[id] = pin;
    }
    return {accessPoint, authToken, pin, excludedDevices: new Set(excluded), lockPins};
}
