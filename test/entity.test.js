import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgedEntity } from '../dist/entity.js';
import { describeDevice } from '../dist/mapping.js';

export function device(
  type = 'PLUGABLE_SWITCH',
  channel = { functionalChannelType: 'SWITCH_CHANNEL', on: false, index: 1 },
) {
  return {
    id: '3014F711A000000000000001',
    label: 'Test device',
    type,
    modelType: 'HmIP-Test',
    firmwareVersion: '1.0.0',
    functionalChannels: { 0: { functionalChannelType: 'DEVICE_BASE', unreach: false, lowBat: false }, 1: channel },
    permanentlyReachable: true,
    lastStatusUpdate: 0,
    homeId: 'home',
  };
}
function make(kind, channel = {}, type = 'PLUGABLE_SWITCH') {
  const d = device(type, channel);
  const calls = [];
  const e = new BridgedEntity({ id: `${d.id}:1:${kind}`, deviceId: d.id, index: 1, kind, label: d.label, channel }, d, {
    vendorId: 65521,
    lockPins: {},
    command: async (path, body) => {
      calls.push({ path, body });
    },
    error: assert.fail,
  });
  return { e, d, calls };
}
const invoke = (e, command, request = {}) =>
  e.endpoint.commandHandler.executeHandler(command, { request, endpoint: e.endpoint });

for (const kind of [
  'switch',
  'dimmer',
  'color',
  'notification',
  'cover',
  'blind',
  'shading',
  'contact',
  'temperature',
  'humidity',
  'illuminance',
  'occupancy',
  'smoke',
  'water',
  'rain',
  'button',
  'lock',
  'lockSensor',
  'thermostat',
  'valve',
  'garage',
  'co2',
  'energy',
  'soil',
  'soilTemperature',
  'flow',
  'waterSupply',
  'waterAlarm',
]) {
  test(`constructs real Matterbridge endpoint: ${kind}`, async () => {
    const { e } = make(kind);
    assert.ok(e.endpoint.hasClusterServer('BridgedDeviceBasicInformation'));
    await e.endpoint.close();
  });
}

test('switch commands preserve device and channel IDs', async () => {
  const { e, d, calls } = make('switch');
  await invoke(e, 'on');
  await invoke(e, 'toggle');
  assert.deepEqual(
    calls.map((c) => c.body.on),
    [true, false],
  );
  assert.equal(calls[0].body.deviceId, d.id);
  assert.equal(calls[0].body.channelIndex, 1);
  await e.endpoint.close();
});
test('dimmer converts Matter levels and restores last nonzero brightness', async () => {
  const { e, calls } = make('dimmer');
  await invoke(e, 'moveToLevelWithOnOff', { level: 127 });
  await invoke(e, 'off');
  await invoke(e, 'on');
  assert.deepEqual(
    calls.map((c) => c.body.dimLevel),
    [0.5, 0, 0.5],
  );
  await e.endpoint.close();
});
test('covering commands use closed percentages without HomeKit inversion', async () => {
  const { e, calls } = make('blind', { shutterLevel: 0.25 });
  await invoke(e, 'upOrOpen');
  await invoke(e, 'downOrClose');
  await invoke(e, 'goToLiftPercentage', { liftPercent100thsValue: 2500 });
  await invoke(e, 'goToTiltPercentage', { tiltPercent100thsValue: 7000 });
  await invoke(e, 'stopMotion');
  assert.deepEqual(
    calls.slice(0, 3).map((c) => c.body.shutterLevel),
    [0, 1, 0.25],
  );
  assert.equal(calls[3].body.slatsLevel, 0.7);
  assert.equal(calls[4].path, 'device/control/stop');
  await e.endpoint.close();
});
test('read-only lock sensor rejects actuation', async () => {
  const { e, calls } = make('lockSensor');
  await assert.rejects(invoke(e, 'unlockDoor'), /cannot actuate/);
  assert.equal(calls.length, 0);
  await e.endpoint.close();
});
test('watering duration reaches the timed API', async () => {
  const { e, calls } = make('valve');
  await invoke(e, 'open', { openDuration: 60 });
  await invoke(e, 'close');
  assert.equal(calls[0].body.wateringTime, 60);
  assert.equal(calls[1].body.wateringActive, false);
  await e.endpoint.close();
});
test('multi-channel descriptors have stable unique identities', () => {
  const d = device('DIN_RAIL_SWITCH_4');
  d.functionalChannels['2'] = { ...d.functionalChannels['1'], index: 2 };
  const before = describeDevice(d);
  d.label = 'Renamed';
  assert.deepEqual(
    describeDevice(d).map((e) => e.id),
    before.map((e) => e.id),
  );
  assert.equal(new Set(before.map((e) => e.id)).size, 2);
});

test('concurrent brightness/off/on commands use the last successful brightness', async () => {
  const { e, calls } = make('dimmer');
  await Promise.all([invoke(e, 'moveToLevelWithOnOff', { level: 127 }), invoke(e, 'off'), invoke(e, 'on')]);
  assert.deepEqual(
    calls.map((call) => call.body.dimLevel),
    [0.5, 0, 0.5],
  );
  await e.endpoint.close();
});

test('failed cloud commands reject Matter requests and do not poison later commands', async () => {
  const { e, calls } = make('switch');
  let fail = true;
  e.context.command = async (path, body) => {
    if (fail) throw new Error('cloud unavailable');
    calls.push({ path, body });
  };
  await assert.rejects(invoke(e, 'on'), /cloud unavailable/);
  fail = false;
  await invoke(e, 'on');
  assert.equal(calls.length, 1);
  await e.endpoint.close();
});

test('doorbell and long-press release produce switch events without a spurious short press', async () => {
  const { e } = make('button');
  const events = [];
  e.endpoint.triggerSwitchEvent = async (event) => {
    events.push(event);
    return true;
  };
  await e.buttonEvent('KEY_PRESS_LONG_START');
  await e.buttonEvent('KEY_PRESS_SHORT');
  await e.buttonEvent('KEY_PRESS_LONG_STOP');
  await e.buttonEvent('DOOR_BELL_SENSOR_EVENT');
  assert.deepEqual(events, ['Long', 'Single']);
  await e.endpoint.close();
});

test('universal light brightness-with-on/off commands actuate the switch too', async () => {
  const { e, calls } = make('color', { on: false, dimLevel: 0 });
  await invoke(e, 'moveToLevelWithOnOff', { level: 127 });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['device/control/setDimLevel', 'device/control/setSwitchState'],
  );
  assert.equal(calls[1].body.on, true);
  await e.endpoint.close();
});

test('smoke detectors expose no fictitious CO capability or simulated physical self-test', async () => {
  const { e } = make('smoke');
  assert.equal(e.endpoint.hasAttributeServer('SmokeCoAlarm', 'coState'), false);
  await assert.rejects(invoke(e, 'SmokeCoAlarm.selfTestRequest'), /physical smoke detector self-test/);
  await e.endpoint.close();
});

test('water supply valve sends explicit open/close commands and rejects timed opening', async () => {
  const { e, calls } = make('waterSupply', { functionalChannelType: 'WATER_SUPPLY_STOP_CHANNEL' }, 'WATER_SUPPLY_STOP');
  try {
    await invoke(e, 'open');
    await invoke(e, 'close');
    await assert.rejects(invoke(e, 'open', { openDuration: 60 }), /Timed opening/);
    await assert.rejects(invoke(e, 'open', { targetLevel: 50 }), /fully opening/);
    assert.deepEqual(
      calls.map(({ path, body }) => [path, body.waterSupplyState, body.channelIndex]),
      [
        ['device/control/setWaterSupplyState', 'FULL_OPENED', 1],
        ['device/control/setWaterSupplyState', 'NO_WATERFLOW', 1],
      ],
    );
  } finally {
    await e.endpoint.close();
  }
});
