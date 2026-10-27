import assert from "node:assert/strict";
import {test} from "node:test";
import {deviceKinds} from "../dist/catalog.js";
import {parseConfig} from "../dist/config.js";
import {
    describeDevice,
    heatingGroup,
    illuminance,
    meterEnergy,
    percent100ths,
    thermostatActivity,
} from "../dist/mapping.js";

const make = (type, channel) => ({
    id: "device",
    type,
    label: "Device",
    functionalChannels: {1: {index: 1, ...channel}},
});
const channels = {
    switch: "SWITCH_CHANNEL",
    energySensor: "ENERGY_SENSORS_INTERFACE_CHANNEL",
    soilSensor: "SOIL_MOISTURE_SENSOR_INTERFACE_CHANNEL",
    waterSupplyStop: "WATER_SUPPLY_STOP_CHANNEL",
    switchMeasuring: "SWITCH_MEASURING_CHANNEL",
    dimmer: "DIMMER_CHANNEL",
    blind: "BLIND_CHANNEL",
    shutter: "SHUTTER_CHANNEL",
    shading: "SHADING_CHANNEL",
    button: "SINGLE_KEY_CHANNEL",
    contactSensor: "SHUTTER_CONTACT_CHANNEL",
    rotaryHandleSensor: "ROTARY_HANDLE_CHANNEL",
    climateSensor: "CLIMATE_SENSOR_CHANNEL",
    smokeDetector: "SMOKE_DETECTOR_CHANNEL",
    doorLockDrive: "DOOR_LOCK_CHANNEL",
    doorLockSensor: "DOOR_LOCK_SENSOR_CHANNEL",
    garageDoor: "DOOR_CHANNEL",
    waterSensor: "WATER_SENSOR_CHANNEL",
    wateringActuator: "WATERING_ACTUATOR_CHANNEL",
    lightSensor: "LIGHT_SENSOR_CHANNEL",
    motionDetector: "MOTION_DETECTION_CHANNEL",
    presenceDetector: "PRESENCE_DETECTION_CHANNEL",
    rainSensor: "RAIN_DETECTION_CHANNEL",
    universalLight: "UNIVERSAL_LIGHT_CHANNEL",
    switchNotificationLight: "NOTIFICATION_LIGHT_CHANNEL",
    multiModeInput: "MULTI_MODE_INPUT_CHANNEL",
    weatherSensor: "WEATHER_SENSOR_CHANNEL",
    weatherSensorPlus: "WEATHER_SENSOR_PLUS_CHANNEL",
    weatherSensorPro: "WEATHER_SENSOR_PRO_CHANNEL",
    thermostat: "HEATING_THERMOSTAT_CHANNEL",
};
for (const [type, kind] of deviceKinds) {
    if (kind === "garageDoorController") {
        continue;
    }
    test(`catalog coverage: ${type}`, () => {
        const channel = {functionalChannelType: channels[kind]};
        if (kind === "climateSensor" || kind.startsWith("weather")) {
            Object.assign(channel, {actualTemperature: 20, humidity: 40});
        }
        if (kind === "energySensor") {
            channel.connectedEnergySensorType = "ES_IEC";
        }
        if (kind === "lightSensor") {
            channel.currentIllumination = 100;
        }
        if (kind === "motionDetector") {
            channel.motionDetected = false;
        }
        if (kind === "presenceDetector") {
            channel.presenceDetected = false;
        }
        if (kind === "multiModeInput") {
            channel.multiModeInputMode = "KEY_BEHAVIOR";
        }
        if (kind === "universalLight") {
            channel.dimLevel = 0.5;
        }
        assert.ok(describeDevice(make(type, channel)).length > 0);
    });
}
test("unknown and external devices are not guessed from fields", () => {
    for (const type of ["UNKNOWN", "PLUGIN_EXTERNAL", "ACCESS_POINT"]) {
        assert.deepEqual(describeDevice(make(type, {on: true, functionalChannelType: "SWITCH_CHANNEL"})), []);
    }
});
test("impulse-only garage controller is explicitly excluded", () => {
    assert.deepEqual(
        describeDevice(make("WALL_MOUNTED_GARAGE_DOOR_CONTROLLER", {functionalChannelType: "IMPULSE_OUTPUT_CHANNEL"})),
        [],
    );
});
test("input mode selects a contact or a button", () => {
    assert.equal(
        describeDevice(
            make("WIRED_INPUT_16", {
                functionalChannelType: "MULTI_MODE_INPUT_CHANNEL",
                multiModeInputMode: "KEY_BEHAVIOR",
                windowState: null,
            }),
        )[0].kind,
        "button",
    );
    assert.equal(
        describeDevice(
            make("WIRED_INPUT_16", {
                functionalChannelType: "MULTI_MODE_INPUT_CHANNEL",
                multiModeInputMode: "CONTACT",
                windowState: "CLOSED",
            }),
        )[0].kind,
        "contact",
    );
});
test("measurement conversions clamp and preserve direction", () => {
    assert.equal(illuminance(0), 0);
    assert.equal(illuminance(1), 1);
    assert.equal(illuminance(100), 20001);
    assert.equal(percent100ths(0), 0);
    assert.equal(percent100ths(1), 10000);
});
test("configuration validates credentials and normalizes controller ID", () => {
    const c = parseConfig({accessPoint: "3014-f711-a000-0000-0000-0001", authToken: " token "});
    assert.equal(c.accessPoint, "3014F711A000000000000001");
    assert.equal(c.authToken, "token");
    assert.throws(() => parseConfig({accessPoint: "invalid", authToken: "token"}));
});
test("thermostat resolves heating groups across channels", () => {
    const d = make("HEATING_THERMOSTAT", {groups: ["room"]});
    const room = {
        id: "room",
        type: "HEATING",
        cooling: false,
        setPointTemperature: 21,
        actualTemperature: 20,
        humidity: 50,
        minTemperature: 5,
        maxTemperature: 30,
        controlMode: "AUTOMATIC",
        valvePosition: 0.2,
    };
    assert.equal(heatingGroup(d, {room}), room);
    assert.equal(heatingGroup(d, {}), undefined);
});

test("new sensor discovery follows actual cloud field names and channel modes", () => {
    const kinds = (type, channel) => describeDevice(make(type, channel)).map((e) => e.kind);
    assert.deepEqual(kinds("CARBON_DIOXIDE_SENSOR", {carbonDioxideConcentration: null}), ["co2"]);
    assert.deepEqual(
        kinds("SOIL_MOISTURE_SENSOR_INTERFACE", {
            functionalChannelType: "SOIL_MOISTURE_SENSOR_INTERFACE_CHANNEL",
            soilMoisture: null,
            soilTemperature: null,
        }),
        ["soil", "soilTemperature"],
    );
    assert.deepEqual(
        kinds("WATERING_ACTUATOR", {
            functionalChannelType: "WATERING_ACTUATOR_CHANNEL",
            waterFlow: null,
        }),
        ["valve", "flow"],
    );
    assert.deepEqual(
        kinds("WATER_SUPPLY_STOP", {
            functionalChannelType: "WATER_SUPPLY_STOP_CHANNEL",
            waterAlarmActive: false,
            waterPressure: null,
        }),
        ["waterSupply", "waterAlarm"],
    );
    for (const connectedEnergySensorType of ["ES_GAS", "UNKNOWN", null]) {
        assert.deepEqual(
            kinds("ENERGY_SENSORS_INTERFACE", {
                functionalChannelType: "ENERGY_SENSORS_INTERFACE_CHANNEL",
                connectedEnergySensorType,
            }),
            [],
        );
    }
});

test("electricity counters respect tariff direction, null values, and LED mode", () => {
    const c = {
        connectedEnergySensorType: "ES_IEC",
        energyCounterOneType: "ENERGY_COUNTER_USAGE_LOW_TARIFF",
        energyCounterOne: 3.25,
        energyCounterTwoType: "ENERGY_COUNTER_INPUT_SINGLE_TARIFF",
        energyCounterTwo: 7,
        energyCounterThreeType: "ENERGY_COUNTER_USAGE_HIGH_TARIFF",
        energyCounterThree: 10.5,
    };
    assert.equal(meterEnergy(c, "import"), 13.75);
    assert.equal(meterEnergy(c, "export"), 7);
    for (const value of [null, undefined, -1, NaN, Infinity]) {
        assert.equal(meterEnergy({...c, energyCounterThree: value}, "import"), null);
    }
    assert.equal(meterEnergy({...c, energyCounterThreeType: c.energyCounterOneType}, "import"), null);
    assert.equal(meterEnergy({...c, energyCounterThreeType: "ENERGY_COUNTER_USAGE_SINGLE_TARIFF"}, "import"), 10.5);
    assert.equal(meterEnergy({connectedEnergySensorType: "ES_LED", energyCounterOne: 0}, "import"), 0);
    assert.equal(meterEnergy({connectedEnergySensorType: "ES_LED", energyCounterOne: 12}, "export"), null);
    assert.equal(meterEnergy({}, "import"), null);
});

test("wall thermostat retains one stable endpoint for temperature, setpoint and humidity", () => {
    const channel = {
        functionalChannelType: "WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL",
        actualTemperature: 21,
        humidity: null,
        setPointTemperature: 22,
    };
    const entities = describeDevice(make("WALL_MOUNTED_THERMOSTAT_PRO", channel));
    assert.deepEqual(
        entities.map(({id, kind}) => ({id, kind})),
        [{id: "device:1:thermostat", kind: "thermostat"}],
    );
    assert.deepEqual(
        describeDevice(make("TEMPERATURE_HUMIDITY_SENSOR_OUTDOOR", {actualTemperature: 21, humidity: 45})).map(
            (e) => e.kind,
        ),
        ["temperature", "humidity"],
    );
});

test("room activity aggregates associated valve channels without temperature inference", () => {
    const room = {
        id: "room",
        type: "HEATING",
        cooling: false,
        setPointTemperature: 24,
        actualTemperature: 20,
        humidity: null,
        minTemperature: 5,
        maxTemperature: 30,
        controlMode: "AUTOMATIC",
        valvePosition: null,
    };
    const channel = {functionalChannelType: "WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL", groups: ["room"]};
    const wall = {...make("WALL_MOUNTED_THERMOSTAT", channel), id: "wall"};
    const actuator = {...make("ANY_MODEL", {}), id: "actuator", functionalChannels: {}};
    const activity = () => thermostatActivity(wall, channel, {room}, {actuator});
    assert.equal(activity(), undefined);
    for (const type of [
        "HEATING_THERMOSTAT_CHANNEL",
        "FLOOR_TERMINAL_BLOCK_CHANNEL",
        "FLOOR_TERMINAL_BLOCK_MECHANIC_CHANNEL",
    ]) {
        actuator.functionalChannels = {
            1: {functionalChannelType: type, groups: ["room"], valvePosition: 0},
            2: {functionalChannelType: type, groups: ["room"], valvePosition: 0.35},
            3: {functionalChannelType: type, groups: ["other"], valvePosition: 1},
        };
        assert.equal(activity(), true, type);
        actuator.functionalChannels[2].valvePosition = 0;
        assert.equal(activity(), false, type);
        actuator.functionalChannels[2].valvePosition = null;
        assert.equal(activity(), undefined, type);
        actuator.functionalChannels[1].valvePosition = 1;
        assert.equal(activity(), true, type);
        actuator.functionalChannels[0] = {functionalChannelType: "DEVICE_BASE", unreach: true};
        assert.equal(activity(), undefined, type);
    }
    actuator.functionalChannels = {
        1: {
            functionalChannelType: "FLOOR_TERMINAL_BLOCK_LOCAL_PUMP_CHANNEL",
            channelRole: "FLOOR_HEATING_COOLING_CONTROLLER",
            groups: ["room"],
            valvePosition: 0,
        },
    };
    assert.equal(activity(), false, "configurable first output used as a valve is included");
    actuator.functionalChannels[1].valvePosition = 1;
    assert.equal(activity(), true);
    actuator.functionalChannels[1].channelRole = "LOCAL_PUMP";
    assert.equal(activity(), undefined, "a pump output is not room valve activity");
    delete actuator.functionalChannels[1].channelRole;
    assert.equal(activity(), undefined, "an unknown output role is not assumed to be a valve");
    actuator.functionalChannels = {};
    wall.functionalChannels[2] = {functionalChannelType: "INTERNAL_SWITCH_CHANNEL", valvePosition: 1};
    assert.equal(activity(), true);
    wall.functionalChannels[2].valvePosition = 0;
    assert.equal(activity(), false);
    room.valvePosition = 0.2;
    assert.equal(activity(), true, "a supplied room value takes precedence");
    const radiatorChannel = {functionalChannelType: "HEATING_THERMOSTAT_CHANNEL", groups: ["room"], valvePosition: 0};
    const radiator = make("HEATING_THERMOSTAT", radiatorChannel);
    assert.equal(
        thermostatActivity(radiator, radiatorChannel, {room}, {wall}),
        false,
        "closed radiator does not inherit room activity",
    );
    radiatorChannel.valvePosition = null;
    assert.equal(thermostatActivity(radiator, radiatorChannel, {room}, {wall}), undefined);
    radiatorChannel.valvePosition = 0.4;
    assert.equal(
        thermostatActivity(radiator, radiatorChannel, {}, {}),
        true,
        "radiator activity works without a wall thermostat or group measurement",
    );
});
