import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {AnsiLogger} from "matterbridge/logger";
import {Endpoint, Environment, ServerNode} from "matterbridge/matter";
import {AggregatorEndpoint} from "matterbridge/matter/endpoints";
import {HmIPPlatform} from "../dist/module.js";

const drain = async (platform) => {
    await platform.session?.whenIdle();
    await platform.queue;
};
test("platform discovers, reconciles push events, recovers snapshots, and shuts down", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hmip-platform-test-"));
    const environment = new Environment("platform-test", Environment.default);
    environment.vars.set("path.root", directory);
    environment.vars.set("runtime.signals", false);
    environment.vars.set("runtime.exitcode", false);
    environment.vars.set("log.level", "error");
    let server;
    let platform;
    let listener;
    let connectionListener;
    let snapshotCalls = 0;
    let shutdown = false;
    const device = {
        id: "3014F711A000000000000001",
        type: "DIN_RAIL_SWITCH_4",
        label: "Same name",
        modelType: "HmIP-DRSI4",
        firmwareVersion: "1.0",
        functionalChannels: {
            1: {functionalChannelType: "SWITCH_CHANNEL", index: 1, on: false},
            2: {functionalChannelType: "SWITCH_CHANNEL", index: 2, on: true},
        },
    };
    let state = {devices: {[device.id]: device}, groups: {}, home: {}};
    const client = {
        init: async () => {},
        disconnect() {},
        getCurrentState: async () => {
            snapshotCalls++;
            if (state === false) {
                throw new Error("Snapshot unavailable");
            }
            return structuredClone(state);
        },
        connect: (callback, onConnection) => {
            listener = callback;
            connectionListener = onConnection;
            onConnection("connected");
        },
        command: async () => {},
        deviceCommand: async () => {},
        shutdown: () => {
            shutdown = true;
        },
    };
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
        platform = new HmIPPlatform(
            {
                matterbridgeVersion: "3.11.0",
                matterbridgeDirectory: directory,
                aggregatorVendorId: 65521,
                bridgeMode: "bridge",
            },
            new AnsiLogger({logName: "Test"}),
            {name: "matterbridge-homematicip", accessPoint: device.id, authToken: "test-token"},
            client,
        );
        platform.setMatterNode(
            async (_plugin, endpoint) => {
                await aggregator.add(endpoint);
            },
            async (_plugin, endpoint) => {
                await endpoint.delete();
            },
            async () => {},
            async () => {},
        );
        await platform.onStart();
        assert.equal(platform.entities.size, 2);
        assert.equal(platform.getDevices().length, 2, "multi-channel names must not collide");
        const selectDevices = platform.getSelectDevices();
        assert.equal(selectDevices.length, 1);
        assert.ok(
            platform.getDevices().every((endpoint) => endpoint.serialNumber.includes(selectDevices[0].serialNumber)),
        );
        assert.deepEqual(
            platform.getDevices().map((endpoint) => endpoint.deviceName),
            ["Same name – Switch 1", "Same name – Switch 2"],
        );
        const first = platform.entities.get(`${device.id}:1:switch`);
        assert.equal(first.endpoint.getAttribute("OnOff", "onOff"), false);
        device.functionalChannels["1"].on = true;
        listener({events: {change: {pushEventType: "DEVICE_CHANGED", device: structuredClone(device)}}});
        await drain(platform);
        assert.equal(first.endpoint.getAttribute("OnOff", "onOff"), true);
        state = false;
        connectionListener("reconnected");
        await drain(platform);
        assert.equal(first.endpoint.getAttribute("BridgedDeviceBasicInformation", "reachable"), false);
        state = {devices: {[device.id]: device}, groups: {}, home: {}};
        connectionListener("reconnected");
        await drain(platform);
        assert.equal(first.endpoint.getAttribute("BridgedDeviceBasicInformation", "reachable"), true);
        connectionListener("disconnected");
        await drain(platform);
        assert.equal(first.endpoint.getAttribute("BridgedDeviceBasicInformation", "reachable"), false);
        const callsBeforeReconnect = snapshotCalls;
        device.functionalChannels["1"].on = false;
        connectionListener("reconnected");
        await drain(platform);
        assert.equal(snapshotCalls, callsBeforeReconnect + 1);
        assert.equal(first.endpoint.getAttribute("OnOff", "onOff"), false, "missed changes are recovered immediately");
        assert.equal(first.endpoint.getAttribute("BridgedDeviceBasicInformation", "reachable"), true);
        listener({events: {removed: {pushEventType: "DEVICE_REMOVED", device: {id: device.id}}}});
        await drain(platform);
        assert.equal(platform.entities.size, 0);
        await platform.onShutdown();
        assert.equal(shutdown, true);
        const callsBeforeShutdownEvent = snapshotCalls;
        connectionListener("reconnected");
        await drain(platform);
        assert.equal(snapshotCalls, callsBeforeShutdownEvent);
        listener({events: {late: {pushEventType: "DEVICE_ADDED", device}}});
        await drain(platform);
        assert.equal(platform.entities.size, 0);
        platform = undefined;
    } finally {
        await platform?.onShutdown();
        await server?.close();
        await environment.close();
        await rm(directory, {recursive: true, force: true});
    }
});
