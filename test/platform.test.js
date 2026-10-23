import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AnsiLogger } from 'matterbridge/logger';
import { Endpoint, Environment, ServerNode } from 'matterbridge/matter';
import { AggregatorEndpoint } from 'matterbridge/matter/endpoints';
import { HmIPPlatform } from '../dist/module.js';

const drain = async (platform) => {
  await platform.queue;
};
test('platform discovers, reconciles push events, recovers snapshots, and shuts down', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmip-platform-test-'));
  const environment = new Environment('platform-test', Environment.default);
  environment.vars.set('path.root', directory);
  environment.vars.set('runtime.signals', false);
  environment.vars.set('runtime.exitcode', false);
  environment.vars.set('log.level', 'error');
  let server;
  let platform;
  let listener;
  let connectionListener;
  let snapshotCalls = 0;
  let shutdown = false;
  const device = {
    id: '3014F711A000000000000001',
    type: 'DIN_RAIL_SWITCH_4',
    label: 'Same name',
    modelType: 'HmIP-DRSI4',
    firmwareVersion: '1.0',
    functionalChannels: {
      1: { functionalChannelType: 'SWITCH_CHANNEL', index: 1, on: false },
      2: { functionalChannelType: 'SWITCH_CHANNEL', index: 2, on: true },
    },
  };
  let state = { devices: { [device.id]: device }, groups: {}, home: {} };
  const client = {
    init: async () => true,
    getCurrentState: async () => {
      snapshotCalls++;
      return structuredClone(state);
    },
    connect: (callback, onConnection) => {
      listener = callback;
      connectionListener = onConnection;
      onConnection('connected');
    },
    command: async () => {},
    shutdown: () => {
      shutdown = true;
    },
  };
  try {
    server = await ServerNode.create({
      id: 'test',
      environment,
      network: { port: 0 },
      basicInformation: {
        vendorId: 65521,
        productId: 32768,
        vendorName: 'Test',
        productName: 'Test',
        serialNumber: 'Test',
      },
    });
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await server.add(aggregator);
    platform = new HmIPPlatform(
      {
        matterbridgeVersion: '3.11.0',
        matterbridgeDirectory: directory,
        aggregatorVendorId: 65521,
        bridgeMode: 'bridge',
      },
      new AnsiLogger({ logName: 'Test' }),
      { name: 'matterbridge-homematicip', accessPoint: device.id, authToken: 'test-token' },
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
    assert.equal(platform.getDevices().length, 2, 'multi-channel names must not collide');
    const first = platform.entities.get(`${device.id}:1:switch`);
    assert.equal(first.endpoint.getAttribute('OnOff', 'onOff'), false);
    device.functionalChannels['1'].on = true;
    listener({ events: { change: { pushEventType: 'DEVICE_CHANGED', device: structuredClone(device) } } });
    await drain(platform);
    assert.equal(first.endpoint.getAttribute('OnOff', 'onOff'), true);
    state = false;
    await platform.enqueue(() => platform.refresh());
    assert.equal(first.endpoint.getAttribute('BridgedDeviceBasicInformation', 'reachable'), false);
    state = { devices: { [device.id]: device }, groups: {}, home: {} };
    await platform.enqueue(() => platform.refresh());
    assert.equal(first.endpoint.getAttribute('BridgedDeviceBasicInformation', 'reachable'), true);
    connectionListener('disconnected');
    await drain(platform);
    assert.equal(first.endpoint.getAttribute('BridgedDeviceBasicInformation', 'reachable'), false);
    await platform.enqueue(() => platform.refresh());
    assert.equal(
      first.endpoint.getAttribute('BridgedDeviceBasicInformation', 'reachable'),
      false,
      'REST success cannot conceal a known websocket outage',
    );
    const callsBeforeReconnect = snapshotCalls;
    device.functionalChannels['1'].on = false;
    connectionListener('reconnected');
    await drain(platform);
    assert.equal(snapshotCalls, callsBeforeReconnect + 1);
    assert.equal(first.endpoint.getAttribute('OnOff', 'onOff'), false, 'missed changes are recovered immediately');
    assert.equal(first.endpoint.getAttribute('BridgedDeviceBasicInformation', 'reachable'), true);
    listener({ events: { removed: { pushEventType: 'DEVICE_REMOVED', device: { id: device.id } } } });
    await drain(platform);
    assert.equal(platform.entities.size, 0);
    await platform.onShutdown();
    assert.equal(shutdown, true);
    const callsBeforeShutdownEvent = snapshotCalls;
    connectionListener('reconnected');
    await drain(platform);
    assert.equal(snapshotCalls, callsBeforeShutdownEvent);
    listener({ events: { late: { pushEventType: 'DEVICE_ADDED', device } } });
    await drain(platform);
    assert.equal(platform.entities.size, 0);
    platform = undefined;
  } finally {
    await platform?.onShutdown();
    await server?.close();
    await environment.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('refresh retries failures but does not poll after recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let initOk = false;
  let state = false;
  let initCalls = 0;
  let snapshotCalls = 0;
  const platform = Object.assign(Object.create(HmIPPlatform.prototype), {
    stopped: false,
    connected: false,
    abort: new AbortController(),
    queue: Promise.resolve(),
    entities: new Map(),
    devices: new Map(),
    log: { warn() {}, error() {} },
    client: {
      async init() {
        initCalls++;
        return initOk;
      },
      connect() {},
      async getCurrentState() {
        snapshotCalls++;
        return state;
      },
    },
  });
  await platform.enqueue(() => platform.refresh());
  assert.equal(initCalls, 1);
  initOk = true;
  t.mock.timers.tick(30_000);
  await drain(platform);
  assert.equal(initCalls, 2);
  assert.equal(snapshotCalls, 1);
  state = { devices: {}, groups: {} };
  t.mock.timers.tick(30_000);
  await drain(platform);
  assert.equal(snapshotCalls, 2);
  t.mock.timers.tick(600_000);
  await drain(platform);
  assert.equal(snapshotCalls, 2, 'healthy connections must not poll');

  platform.client.getCurrentState = async () => {
    snapshotCalls++;
    throw new Error('temporary failure');
  };
  await platform.enqueue(() => platform.refresh());
  t.mock.timers.tick(30_000);
  await drain(platform);
  assert.equal(snapshotCalls, 4, 'thrown errors also retry');
  platform.stopped = true;
  t.mock.timers.tick(30_000);
  await drain(platform);
  assert.equal(snapshotCalls, 4, 'pending retries do not run after shutdown');
});
