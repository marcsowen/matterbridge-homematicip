import { type HmIPDevice, type HmIPGroup, isHmIPHeatingGroup, isHmIPRecord } from 'homematicip-cloud-client-ts';
import { deviceKinds } from './catalog.js';

export type Kind =
  | 'switch'
  | 'dimmer'
  | 'color'
  | 'notification'
  | 'cover'
  | 'blind'
  | 'shading'
  | 'contact'
  | 'temperature'
  | 'humidity'
  | 'illuminance'
  | 'occupancy'
  | 'smoke'
  | 'water'
  | 'rain'
  | 'button'
  | 'lock'
  | 'lockSensor'
  | 'thermostat'
  | 'valve'
  | 'garage'
  | 'co2'
  | 'energy'
  | 'soil'
  | 'soilTemperature'
  | 'flow'
  | 'waterSupply'
  | 'waterAlarm';
export type Channel = Record<string, unknown>;
export interface Entity {
  id: string;
  deviceId: string;
  index: number;
  kind: Kind;
  label: string;
  channel: Channel;
}
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export const percent100ths = (value: number): number => Math.round(clamp(value, 0, 1) * 10_000);
export const illuminance = (lux: number): number =>
  lux <= 0 ? 0 : clamp(Math.round(10_000 * Math.log10(lux) + 1), 1, 65_534);

export function describeDevice(device: HmIPDevice): Entity[] {
  if (!deviceKinds.has(device.type)) return [];
  const entities: Entity[] = [];
  for (const [key, raw] of Object.entries(device.functionalChannels)) {
    if (!isHmIPRecord(raw)) continue;
    const c = raw;
    const index = finite(c.index) ? c.index : Number(key);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    const add = (kind: Kind) => {
      const id = `${device.id}:${index}:${kind}`;
      if (!entities.some((entity) => entity.id === id))
        entities.push({
          id,
          deviceId: device.id,
          index,
          kind,
          label: typeof c.label === 'string' && c.label.trim() ? c.label : device.label,
          channel: c,
        });
    };
    switch (c.functionalChannelType) {
      case 'SWITCH_CHANNEL':
      case 'SWITCH_MEASURING_CHANNEL':
      case 'MULTI_MODE_INPUT_SWITCH_CHANNEL':
        add('switch');
        break;
      case 'DIMMER_CHANNEL':
      case 'MULTI_MODE_INPUT_DIMMER_CHANNEL':
        add('dimmer');
        break;
      case 'UNIVERSAL_LIGHT_CHANNEL':
        if (finite(c.dimLevel) || typeof c.on === 'boolean') add('color');
        break;
      case 'NOTIFICATION_LIGHT_CHANNEL':
        add('notification');
        break;
      case 'SHUTTER_CHANNEL':
        add('cover');
        break;
      case 'BLIND_CHANNEL':
      case 'MULTI_MODE_INPUT_BLIND_CHANNEL':
        add(c.blindModeActive === false ? 'cover' : 'blind');
        break;
      case 'SHADING_CHANNEL':
        add('shading');
        break;
      case 'SHUTTER_CONTACT_CHANNEL':
      case 'SHUTTER_CONTACT_INTERFACE_CHANNEL':
      case 'ROTARY_HANDLE_CHANNEL':
      case 'ROTARY_HANDLE_SENSOR_CHANNEL':
        add('contact');
        break;
      case 'MULTI_MODE_INPUT_CHANNEL':
        if (c.channelRole === 'DOOR_BELL_INPUT' || c.multiModeInputMode === 'KEY_BEHAVIOR') add('button');
        else if (c.windowState !== undefined) add('contact');
        break;
      case 'SINGLE_KEY_CHANNEL':
        add('button');
        break;
      case 'SMOKE_DETECTOR_CHANNEL':
        add('smoke');
        break;
      case 'WATER_SENSOR_CHANNEL':
        add('water');
        break;
      case 'RAIN_DETECTION_CHANNEL':
        add('rain');
        break;
      case 'DOOR_LOCK_CHANNEL':
        add('lock');
        break;
      case 'DOOR_LOCK_SENSOR_CHANNEL':
        add('lockSensor');
        break;
      case 'WATERING_ACTUATOR_CHANNEL':
        add('valve');
        break;
      case 'ENERGY_SENSORS_INTERFACE_CHANNEL':
        if (c.connectedEnergySensorType === 'ES_IEC' || c.connectedEnergySensorType === 'ES_LED') add('energy');
        break;
      case 'SOIL_MOISTURE_SENSOR_INTERFACE_CHANNEL':
        add('soil');
        if ('soilTemperature' in c) add('soilTemperature');
        break;
      case 'WATER_SUPPLY_STOP_CHANNEL':
        add('waterSupply');
        if ('waterAlarmActive' in c) add('waterAlarm');
        break;
      case 'DOOR_CHANNEL':
        add('garage');
        if (typeof c.on === 'boolean') add('switch');
        break;
      case 'HEATING_THERMOSTAT_CHANNEL':
      case 'WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL':
      case 'WALL_MOUNTED_THERMOSTAT_WITH_CARBON_CHANNEL':
      case 'WALL_MOUNTED_THERMOSTAT_WITHOUT_DISPLAY_CHANNEL':
        add('thermostat');
        break;
    }
    // Measurement capabilities can coexist with actuators (e.g. outdoor motion switches).
    if ('windowState' in c && !entities.some((e) => e.index === index && (e.kind === 'contact' || e.kind === 'button')))
      add('contact');
    if ('actualTemperature' in c) add('temperature');
    if ('humidity' in c) add('humidity');
    if ('illumination' in c || 'currentIllumination' in c || 'averageIllumination' in c) add('illuminance');
    if ('motionDetected' in c || 'presenceDetected' in c) add('occupancy');
    if ('raining' in c) add('rain');
    if ('carbonDioxideConcentration' in c) add('co2');
    if (c.functionalChannelType === 'WATERING_ACTUATOR_CHANNEL' && 'waterFlow' in c) add('flow');
  }
  return entities;
}

export function heatingGroup(device: HmIPDevice, groups: Readonly<Record<string, HmIPGroup>>) {
  for (const raw of Object.values(device.functionalChannels)) {
    if (!isHmIPRecord(raw) || !Array.isArray(raw.groups)) continue;
    for (const id of raw.groups) {
      const group = typeof id === 'string' ? groups[id] : undefined;
      if (group && isHmIPHeatingGroup(group)) return group;
    }
  }
  return undefined;
}

// ESI counters are kWh. Classify by tariff meaning, not counter slot order.
// An unavailable component makes the total unknown rather than silently understating it.
export function meterEnergy(channel: Channel, direction: 'import' | 'export'): number | null {
  if (channel.connectedEnergySensorType === 'ES_LED') {
    return direction === 'import' && finite(channel.energyCounterOne) && channel.energyCounterOne >= 0
      ? channel.energyCounterOne
      : null;
  }
  const counters = ['One', 'Two', 'Three'].map((slot) => ({
    type: channel[`energyCounter${slot}Type`],
    value: channel[`energyCounter${slot}`],
  }));
  const singleType =
    direction === 'import' ? 'ENERGY_COUNTER_USAGE_SINGLE_TARIFF' : 'ENERGY_COUNTER_INPUT_SINGLE_TARIFF';
  const single = counters.filter((counter) => counter.type === singleType);
  const selected = single.length
    ? single
    : direction === 'import'
      ? counters.filter(
          (counter) =>
            counter.type === 'ENERGY_COUNTER_USAGE_HIGH_TARIFF' || counter.type === 'ENERGY_COUNTER_USAGE_LOW_TARIFF',
        )
      : [];
  if (!selected.length || new Set(selected.map((counter) => counter.type)).size !== selected.length) return null;
  let total = 0;
  for (const { value } of selected) {
    if (!finite(value) || value < 0) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}
