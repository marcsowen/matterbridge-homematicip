import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceKinds } from '../dist/catalog.js';
import { parseConfig } from '../dist/config.js';
import { describeDevice, heatingGroup, illuminance, meterEnergy, percent100ths } from '../dist/mapping.js';

const make = (type, channel) => ({
  id: 'device',
  type,
  label: 'Device',
  functionalChannels: { 1: { index: 1, ...channel } },
});
const channels = {
  switch: 'SWITCH_CHANNEL',
  energySensor: 'ENERGY_SENSORS_INTERFACE_CHANNEL',
  soilSensor: 'SOIL_MOISTURE_SENSOR_INTERFACE_CHANNEL',
  waterSupplyStop: 'WATER_SUPPLY_STOP_CHANNEL',
  switchMeasuring: 'SWITCH_MEASURING_CHANNEL',
  dimmer: 'DIMMER_CHANNEL',
  blind: 'BLIND_CHANNEL',
  shutter: 'SHUTTER_CHANNEL',
  shading: 'SHADING_CHANNEL',
  button: 'SINGLE_KEY_CHANNEL',
  contactSensor: 'SHUTTER_CONTACT_CHANNEL',
  rotaryHandleSensor: 'ROTARY_HANDLE_CHANNEL',
  climateSensor: 'CLIMATE_SENSOR_CHANNEL',
  smokeDetector: 'SMOKE_DETECTOR_CHANNEL',
  doorLockDrive: 'DOOR_LOCK_CHANNEL',
  doorLockSensor: 'DOOR_LOCK_SENSOR_CHANNEL',
  garageDoor: 'DOOR_CHANNEL',
  waterSensor: 'WATER_SENSOR_CHANNEL',
  wateringActuator: 'WATERING_ACTUATOR_CHANNEL',
  lightSensor: 'LIGHT_SENSOR_CHANNEL',
  motionDetector: 'MOTION_DETECTION_CHANNEL',
  presenceDetector: 'PRESENCE_DETECTION_CHANNEL',
  rainSensor: 'RAIN_DETECTION_CHANNEL',
  universalLight: 'UNIVERSAL_LIGHT_CHANNEL',
  switchNotificationLight: 'NOTIFICATION_LIGHT_CHANNEL',
  multiModeInput: 'MULTI_MODE_INPUT_CHANNEL',
  weatherSensor: 'WEATHER_SENSOR_CHANNEL',
  weatherSensorPlus: 'WEATHER_SENSOR_PLUS_CHANNEL',
  weatherSensorPro: 'WEATHER_SENSOR_PRO_CHANNEL',
  thermostat: 'HEATING_THERMOSTAT_CHANNEL',
};
for (const [type, kind] of deviceKinds) {
  if (kind === 'garageDoorController') continue;
  test(`catalog coverage: ${type}`, () => {
    const channel = { functionalChannelType: channels[kind] };
    if (kind === 'climateSensor' || kind.startsWith('weather'))
      Object.assign(channel, { actualTemperature: 20, humidity: 40 });
    if (kind === 'energySensor') channel.connectedEnergySensorType = 'ES_IEC';
    if (kind === 'lightSensor') channel.currentIllumination = 100;
    if (kind === 'motionDetector') channel.motionDetected = false;
    if (kind === 'presenceDetector') channel.presenceDetected = false;
    if (kind === 'multiModeInput') channel.multiModeInputMode = 'KEY_BEHAVIOR';
    if (kind === 'universalLight') channel.dimLevel = 0.5;
    assert.ok(describeDevice(make(type, channel)).length > 0);
  });
}
test('unknown and external devices are not guessed from fields', () => {
  for (const type of ['UNKNOWN', 'PLUGIN_EXTERNAL', 'ACCESS_POINT'])
    assert.deepEqual(describeDevice(make(type, { on: true, functionalChannelType: 'SWITCH_CHANNEL' })), []);
});
test('impulse-only garage controller is explicitly excluded', () => {
  assert.deepEqual(
    describeDevice(make('WALL_MOUNTED_GARAGE_DOOR_CONTROLLER', { functionalChannelType: 'IMPULSE_OUTPUT_CHANNEL' })),
    [],
  );
});
test('input mode selects a contact or a button', () => {
  assert.equal(
    describeDevice(
      make('WIRED_INPUT_16', {
        functionalChannelType: 'MULTI_MODE_INPUT_CHANNEL',
        multiModeInputMode: 'KEY_BEHAVIOR',
        windowState: null,
      }),
    )[0].kind,
    'button',
  );
  assert.equal(
    describeDevice(
      make('WIRED_INPUT_16', {
        functionalChannelType: 'MULTI_MODE_INPUT_CHANNEL',
        multiModeInputMode: 'CONTACT',
        windowState: 'CLOSED',
      }),
    )[0].kind,
    'contact',
  );
});
test('measurement conversions clamp and preserve direction', () => {
  assert.equal(illuminance(0), 0);
  assert.equal(illuminance(1), 1);
  assert.equal(illuminance(100), 20001);
  assert.equal(percent100ths(0), 0);
  assert.equal(percent100ths(1), 10000);
});
test('configuration validates credentials and normalizes controller ID', () => {
  const c = parseConfig({ accessPoint: '3014-f711-a000-0000-0000-0001', authToken: ' token ' });
  assert.equal(c.accessPoint, '3014F711A000000000000001');
  assert.equal(c.authToken, 'token');
  assert.throws(() => parseConfig({ accessPoint: 'invalid', authToken: 'token' }));
});
test('thermostat resolves heating groups across channels', () => {
  const d = make('HEATING_THERMOSTAT', { groups: ['room'] });
  const room = {
    id: 'room',
    type: 'HEATING',
    cooling: false,
    setPointTemperature: 21,
    actualTemperature: 20,
    humidity: 50,
    minTemperature: 5,
    maxTemperature: 30,
    controlMode: 'AUTOMATIC',
    valvePosition: 0.2,
  };
  assert.equal(heatingGroup(d, { room }), room);
  assert.equal(heatingGroup(d, {}), undefined);
});

test('new sensor discovery follows actual cloud field names and channel modes', () => {
  const kinds = (type, channel) => describeDevice(make(type, channel)).map((e) => e.kind);
  assert.deepEqual(kinds('CARBON_DIOXIDE_SENSOR', { carbonDioxideConcentration: null }), ['co2']);
  assert.deepEqual(
    kinds('SOIL_MOISTURE_SENSOR_INTERFACE', {
      functionalChannelType: 'SOIL_MOISTURE_SENSOR_INTERFACE_CHANNEL',
      soilMoisture: null,
      soilTemperature: null,
    }),
    ['soil', 'soilTemperature'],
  );
  assert.deepEqual(
    kinds('WATERING_ACTUATOR', {
      functionalChannelType: 'WATERING_ACTUATOR_CHANNEL',
      waterFlow: null,
    }),
    ['valve', 'flow'],
  );
  assert.deepEqual(
    kinds('WATER_SUPPLY_STOP', {
      functionalChannelType: 'WATER_SUPPLY_STOP_CHANNEL',
      waterAlarmActive: false,
      waterPressure: null,
    }),
    ['waterSupply', 'waterAlarm'],
  );
  for (const connectedEnergySensorType of ['ES_GAS', 'UNKNOWN', null]) {
    assert.deepEqual(
      kinds('ENERGY_SENSORS_INTERFACE', {
        functionalChannelType: 'ENERGY_SENSORS_INTERFACE_CHANNEL',
        connectedEnergySensorType,
      }),
      [],
    );
  }
});

test('electricity counters respect tariff direction, null values, and LED mode', () => {
  const c = {
    connectedEnergySensorType: 'ES_IEC',
    energyCounterOneType: 'ENERGY_COUNTER_USAGE_LOW_TARIFF',
    energyCounterOne: 3.25,
    energyCounterTwoType: 'ENERGY_COUNTER_INPUT_SINGLE_TARIFF',
    energyCounterTwo: 7,
    energyCounterThreeType: 'ENERGY_COUNTER_USAGE_HIGH_TARIFF',
    energyCounterThree: 10.5,
  };
  assert.equal(meterEnergy(c, 'import'), 13.75);
  assert.equal(meterEnergy(c, 'export'), 7);
  for (const value of [null, undefined, -1, NaN, Infinity]) {
    assert.equal(meterEnergy({ ...c, energyCounterThree: value }, 'import'), null);
  }
  assert.equal(meterEnergy({ ...c, energyCounterThreeType: c.energyCounterOneType }, 'import'), null);
  assert.equal(meterEnergy({ ...c, energyCounterThreeType: 'ENERGY_COUNTER_USAGE_SINGLE_TARIFF' }, 'import'), 10.5);
  assert.equal(meterEnergy({ connectedEnergySensorType: 'ES_LED', energyCounterOne: 0 }, 'import'), 0);
  assert.equal(meterEnergy({ connectedEnergySensorType: 'ES_LED', energyCounterOne: 12 }, 'export'), null);
  assert.equal(meterEnergy({}, 'import'), null);
});
