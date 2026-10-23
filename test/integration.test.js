import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Endpoint, Environment, ServerNode } from 'matterbridge/matter';
import { AggregatorEndpoint } from 'matterbridge/matter/endpoints';
import { BridgedEntity } from '../dist/entity.js';

test('initialized Matter endpoints accept cloud state with correct units and semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmip-matter-test-'));
  const environment = new Environment('hmip-test', Environment.default);
  environment.vars.set('path.root', directory);
  environment.vars.set('runtime.signals', false);
  environment.vars.set('runtime.exitcode', false);
  environment.vars.set('log.level', 'error');
  let server;
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
    const cases = [
      ['co2', { carbonDioxideConcentration: null }, 'CarbonDioxideConcentrationMeasurement', 'measuredValue', null],
      [
        'energy',
        {
          connectedEnergySensorType: 'ES_IEC',
          energyCounterOneType: 'ENERGY_COUNTER_USAGE_HIGH_TARIFF',
          energyCounterOne: null,
        },
        'ElectricalEnergyMeasurement',
        'cumulativeEnergyImported',
        null,
      ],
      [
        'waterSupply',
        { waterSupplyState: 'FULL_OPENED', processing: false },
        'ValveConfigurationAndControl',
        'currentLevel',
        100,
      ],
      [
        'waterSupply',
        { waterSupplyState: 'REDUCED_WATERFLOW', processing: false },
        'ValveConfigurationAndControl',
        'currentLevel',
        null,
      ],

      ['soil', { soilMoisture: 56 }, 'SoilMeasurement', 'soilMoistureMeasuredValue', 56],
      ['soil', { soilMoisture: null }, 'SoilMeasurement', 'soilMoistureMeasuredValue', null],
      ['soil', { soilMoisture: 101 }, 'SoilMeasurement', 'soilMoistureMeasuredValue', null],
      ['soilTemperature', { soilTemperature: -2.5 }, 'TemperatureMeasurement', 'measuredValue', -250],
      ['flow', { waterFlow: 10 }, 'FlowMeasurement', 'measuredValue', 6],
      ['flow', { waterFlow: null }, 'FlowMeasurement', 'measuredValue', null],
      ['flow', { waterFlow: -1 }, 'FlowMeasurement', 'measuredValue', null],
      ['waterSupply', { waterSupplyState: 'FULL_OPENED' }, 'ValveConfigurationAndControl', 'currentState', 1],
      ['waterSupply', { waterSupplyState: 'REDUCED_WATERFLOW' }, 'ValveConfigurationAndControl', 'currentState', 1],
      ['waterSupply', { waterSupplyState: 'NO_WATERFLOW' }, 'ValveConfigurationAndControl', 'currentState', 0],
      ['waterSupply', { waterSupplyState: 'UNKNOWN' }, 'ValveConfigurationAndControl', 'currentState', null],
      [
        'waterSupply',
        { waterSupplyState: 'FULL_OPENED', processing: true },
        'ValveConfigurationAndControl',
        'currentState',
        2,
      ],
      ['waterAlarm', { waterAlarmActive: true }, 'BooleanState', 'stateValue', true],
      [
        'energy',
        { connectedEnergySensorType: 'ES_LED', energyCounterOne: 1.5 },
        'ElectricalEnergyMeasurement',
        'cumulativeEnergyImported',
        { energy: 1500000 },
      ],
      [
        'energy',
        {
          connectedEnergySensorType: 'ES_IEC',
          energyCounterOne: 2,
          energyCounterOneType: 'ENERGY_COUNTER_INPUT_SINGLE_TARIFF',
        },
        'ElectricalEnergyMeasurement',
        'cumulativeEnergyExported',
        { energy: 2000000 },
      ],
      ['energy', { currentPowerConsumption: -42.5 }, 'ElectricalPowerMeasurement', 'activePower', -42500],

      ['temperature', { actualTemperature: 21.25 }, 'TemperatureMeasurement', 'measuredValue', 2125],
      ['humidity', { humidity: 45.5 }, 'RelativeHumidityMeasurement', 'measuredValue', 4550],
      ['illuminance', { illumination: 100 }, 'IlluminanceMeasurement', 'measuredValue', 20001],
      ['contact', { windowState: 'CLOSED' }, 'BooleanState', 'stateValue', true],
      ['water', { waterlevelDetected: true }, 'BooleanState', 'stateValue', true],
      ['rain', { raining: false }, 'BooleanState', 'stateValue', false],
      ['occupancy', { presenceDetected: true }, 'OccupancySensing', 'occupancy', { occupied: true }],
      ['smoke', { smokeDetectorAlarmType: 'PRIMARY_ALARM' }, 'SmokeCoAlarm', 'smokeState', 2],
      ['switch', { on: true }, 'OnOff', 'onOff', true],
      ['dimmer', { dimLevel: 0.5 }, 'LevelControl', 'currentLevel', 127],
      ['cover', { shutterLevel: 0.75, processing: false }, 'WindowCovering', 'currentPositionLiftPercent100ths', 7500],
      [
        'blind',
        { shutterLevel: 0.25, slatsLevel: 0.5, processing: false },
        'WindowCovering',
        'currentPositionTiltPercent100ths',
        5000,
      ],
      ['lock', { lockState: 'LOCKED' }, 'DoorLock', 'lockState', 1],
      ['valve', { wateringActive: true }, 'ValveConfigurationAndControl', 'currentState', 1],
      [
        'thermostat',
        { valveActualTemperature: 21, setPointTemperature: 22 },
        'Thermostat',
        'occupiedHeatingSetpoint',
        2200,
      ],
      [
        'garage',
        { doorState: 'OPEN', processing: false },
        'ClosureControl',
        'overallCurrentState',
        { position: 1, secureState: false },
      ],
      ['notification', { dimLevel: 0.5, simpleRGBColorState: 'GREEN' }, 'ColorControl', 'currentHue', 85],
      ['co2', { carbonDioxideConcentration: 650 }, 'CarbonDioxideConcentrationMeasurement', 'measuredValue', 650],
      [
        'switch',
        {
          functionalChannelType: 'SWITCH_MEASURING_CHANNEL',
          on: true,
          energyCounter: 1.5,
          currentPowerConsumption: 42,
        },
        'ElectricalEnergyMeasurement',
        'cumulativeEnergyImported',
        { energy: 1500000 },
      ],
    ];
    for (const [index, [kind, channel, cluster, attribute, expected]] of cases.entries()) {
      const device = {
        id: `device${index}`,
        type: 'PLUGABLE_SWITCH',
        label: 'Test',
        modelType: 'HmIP-Test',
        firmwareVersion: '1.0',
        functionalChannels: { 0: { functionalChannelType: 'DEVICE_BASE', lowBat: false, unreach: false }, 1: channel },
      };
      const entity = new BridgedEntity(
        { id: `${device.id}:1:${kind}`, deviceId: device.id, kind, index: 1, label: 'Test', channel },
        device,
        { vendorId: 65521, lockPins: {}, command: async () => {}, error: assert.fail },
      );
      await aggregator.add(entity.endpoint);
      await entity.update(device, channel, {});
      assert.deepEqual(JSON.parse(JSON.stringify(entity.endpoint.getAttribute(cluster, attribute))), expected, kind);
    }
  } finally {
    await server?.close();
    await environment.close();
    await rm(directory, { recursive: true, force: true });
  }
});
