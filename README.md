# matterbridge-homematicip

## Bring Homematic IP devices into your Matter smart home

This [Matterbridge](https://github.com/Luligu/matterbridge) plugin makes supported Homematic IP devices available
to Matter-compatible smart home systems, including Apple Home, Google Home, Amazon Alexa, and Samsung SmartThings.
Control your lights, adjust the heating, operate blinds, and use sensors and buttons in scenes and automations
through your preferred smart home app.

The plugin discovers devices connected to your Homematic IP Access Point or Home Control Unit and keeps their state
up to date. Your devices remain connected to Homematic IP, and you can continue using the Homematic IP app.

> **Early release:** You may encounter bugs or rough edges. Please [report issues](https://github.com/marcsowen/matterbridge-homematicip/issues) to help improve the plugin.

## Matter or HomeKit—which should I choose?

Both options can bring your Homematic IP devices into Apple Home:

| | This plugin: Matterbridge + Matter | [homebridge-homematicip](https://github.com/marcsowen/homebridge-homematicip): Homebridge + HomeKit |
| --- | --- | --- |
| Best suited to | Using Matter-compatible apps, including homes with several smart home ecosystems | An Apple Home / HomeKit setup |
| Connection to your smart home | Matter | HomeKit |
| Current Homematic IP feature coverage | The supported Matter features listed below | Broader coverage today, including security-system integration and history features in compatible HomeKit apps |
| Project maturity | Early release | The established HomeKit plugin |

[Matter](https://csa-iot.org/all-solutions/matter/) is the industry's shared standard for connecting smart home
products across ecosystems. It is an important direction for the future of the smart home, and support for device
types and features continues to grow. Adoption in individual apps can take longer: a feature supported by Matter
is not necessarily available in every app yet.

If you mainly use Apple Home and want the more complete Homematic IP integration today, consider
[homebridge-homematicip](https://github.com/marcsowen/homebridge-homematicip). Choose this plugin if you want to
explore Matter or use your Homematic IP devices across Matter-compatible ecosystems. You do not need Homebridge
to use this plugin.

## Requirements

- A Homematic IP Access Point or a Home Control Unit (HmIP-HCU1) with cloud access enabled.
- Homematic IP devices already set up in the Homematic IP app.
- A working [Matterbridge installation](https://github.com/Luligu/matterbridge#readme), version 3.11.0 or newer
  within version 3, running on Node.js 24 LTS.
- A Matter-compatible smart home app and any Matter controller or hub that app requires.
- An internet connection: this plugin communicates with your devices through the Homematic IP cloud, even though
  the connection between Matterbridge and your Matter controller is local.

CCU and RaspberryMatic installations using a local API are not supported.

## Installation

First, install Matterbridge using its [installation instructions](https://github.com/Luligu/matterbridge#readme)
and check that you can open its web interface.

Install `matterbridge-homematicip` through the plugin installation controls in the Matterbridge web interface.
Then open its settings and configure your controller as described below.

Alternatively, install the package from a terminal on the machine running Matterbridge:

```sh
npm install -g matterbridge-homematicip --omit=dev
matterbridge --add matterbridge-homematicip
```

Use the same Node.js environment and user account as your Matterbridge installation. For Docker, use the Matterbridge
web interface to manage plugins inside the container.

The plugin needs an authentication token before it can discover devices. Once configured, restart it and follow
[Adding devices to your smart home app](#adding-devices-to-your-smart-home-app).

## Configuration

### Using an existing authentication token

Enter these two values in the plugin settings:

- **Access Point / HCU ID** (`accessPoint`): the controller's SGTIN printed on its label, for example
  `3014-xxxx-xxxx-xxxx-xxxx-xxxx`. Spaces and hyphens are accepted.
- **Cloud authentication token** (`authToken`): your existing Homematic IP cloud token. A token already used by
  homebridge-homematicip can also be used here, or you can create a separate token for this plugin.

Save the settings and restart the plugin. If you configure it as JSON, the basic configuration is:

```json
{
  "name": "matterbridge-homematicip",
  "type": "DynamicPlatform",
  "accessPoint": "YOUR_CONTROLLER_ID",
  "authToken": "YOUR_TOKEN"
}
```

### Creating an authentication token

If you do not have a token, use the pairing helper included with the plugin. For a global npm installation on
Linux or macOS, run this in the same environment used to install the plugin:

```sh
node "$(npm root -g)/matterbridge-homematicip/dist/pair.js" YOUR_CONTROLLER_ID /path/to/hmip-credentials.json
```

For other installation layouts, open a terminal in the installed `matterbridge-homematicip` directory and run
`node dist/pair.js YOUR_CONTROLLER_ID /path/to/hmip-credentials.json`. For Docker, run the helper inside the container
and save the file in a persistent directory you can access.

Replace the controller ID and choose a new output file outside the plugin directory. Its parent directory must exist.

1. **For an HCU:** press the button on top of the controller before running the command.
2. **For an Access Point:** run the command, then press its link button when it flashes.
3. Wait for the confirmation that pairing is complete.
4. Open the generated file and copy `accessPoint` and `authToken` into the plugin settings.
5. Save the settings and restart the plugin.

If a controller PIN is configured, supply it through the `HMIP_PIN` environment variable before running the command.
Pairing waits for up to five minutes and can be cancelled with Ctrl+C. The credentials are saved to a private file
rather than printed in the terminal; keep that file secure. The command will not overwrite an existing file.

### Additional settings

Most users can leave these at their defaults.

| Setting | Purpose | Default |
| --- | --- | --- |
| `pin` | Controller PIN, if required; separate from a door lock's authorization PIN | Not set |
| `excludedDevices` | List of Homematic IP device IDs that should not appear in Matter | `[]` |
| `lockPins` | Door lock authorization PINs, keyed by device ID, for example `{"DEVICE_ID": "1234"}` | `{}` |

Matterbridge's device allow/block lists are also respected. Restart the plugin after changing its settings.

## Adding devices to your smart home app

Once your Homematic IP devices appear in Matterbridge:

1. Open the **Add device** or **Add accessory** flow in your smart home app.
2. Scan the Matter QR code shown by Matterbridge. Depending on Matterbridge's bridge mode, this is the code for
   the whole bridge or for this plugin.
3. Follow the app's prompts to finish setup, assign rooms, and name your devices.

See the [Matterbridge documentation](https://github.com/Luligu/matterbridge#readme) for bridge modes and pairing help.
You pair the bridge, rather than pairing each Homematic IP device separately.

Multi-channel devices and devices with several sensors may appear as multiple accessories. Names use your Homematic IP labels, with readable channel or function
suffixes where needed; you can rename them in your smart home app. Changing a configurable input between button
and contact modes can replace the corresponding accessory, so check any automations that use it afterward.

## Supported devices and features

The following device families are implemented. Available controls depend on the device, its configuration, and your
smart home app's support for the corresponding Matter features.

| Homematic IP device family | What you can use in your smart home app |
| --- | --- |
| Switches, plugs, and multi-channel relay actuators | Switch individual outputs on and off |
| Measuring switches and plugs | Switching, power consumption, and accumulated energy; HmIP-BSM devices appear as on/off lights |
| HmIP-ESI electricity meter interfaces (IEC or LED sensors) | Power and imported energy; exported energy where reported by an IEC meter |
| Dimmers and RGBW lights | Brightness, plus color and color temperature where supported |
| Notification light switches | Switching, brightness, and the device's available colors |
| Shutters, blinds, and shading modules | Open, close, stop, position, and slat tilt where available |
| Window/door contacts and rotary handles | Open/closed status; tilted windows are reported as open |
| Configurable inputs | Contact status or button events, depending on input mode |
| Buttons, remotes, and doorbell inputs | Short- and long-press events for automations |
| Motion and presence detectors | Occupancy and brightness readings where available |
| Climate and weather sensors | Temperature, humidity, brightness, and rain detection where available |
| Radiator and wall thermostats | Heating setpoint, current temperature, and humidity where available, combined on one thermostat endpoint |
| Smoke detectors | Smoke alarms and reported low-battery status |
| Water and rain detectors | Water/moisture or rain detection |
| Door lock drives | Lock and unlock |
| Door lock sensors | Lock status only |
| Soil moisture interfaces (ELV-SH-SMSI) | Soil moisture and soil temperature where available |
| Watering actuators | Open/close the valve, optional timed watering, and water flow where available |
| Water stop and supply units (HmIP-WSS / HmIP-WSS-GB) | Open/close the water supply and reported water alarm status |
| Hörmann and Tormatic garage door modules | Door control with position feedback, plus the door light where available |
| CO₂ sensors, including glass wall thermostats and wired climate sensors | CO₂ readings, plus temperature and humidity where supplied by the cloud |

### Things to know

- **Heating:** Off sets the heating group to its minimum temperature in manual mode for frost protection; it does
  not fully disable heating. The app may show Heat again afterward. Manage automatic schedules, cooling, and boost
  in the Homematic IP app.
- **Lights:** Brightness levels and steps are supported. Continuous dimming commands are not supported, and fades
  follow the actuator's configuration. Set notification blink patterns in the Homematic IP app.
- **Locks:** Unlocking a lock drive does not open its latch. A lock sensor only reports state and cannot operate the lock.
- **Smoke detectors:** Only smoke detection is exposed, not CO detection. Test the physical detector locally;
  remote self-tests are not supported.
- **Garage doors:** The HmIP-WGC impulse-only controller is not supported because it does not provide reliable
  position feedback.
- **Electricity meters:** HmIP-ESI supports IEC and LED electricity sensors. Recognized consumption tariffs are combined
  into imported energy; feed-in is reported separately as exported energy. Missing counter readings remain unknown.
  Gas sensors, tariff prices, and resetting meter counters are not exposed.
- **Water devices:** Flow readings from watering actuators use Matter's resolution of 0.1 m³/h (about 1.67 L/min),
  so small changes may not be visible. HmIP-WSS supports full opening and closing; reduced flow is reported as open,
  without a percentage. Timed opening, flow/pressure measurements, and device-specific safety settings for HmIP-WSS
  are not exposed. Manage these settings in the Homematic IP app.
- **Other features:** Security-system arming, HomeKit/Eve history, wind and rainfall totals, sunshine duration, and
  absolute humidity are not exposed by this plugin. External/plugin devices and unknown device types are skipped.
- **App support:** Garage door, valve, rain, soil, flow, and energy features may not be available in every Matter app yet.

## Connection interruptions

The plugin fetches the complete device state at startup, then receives live updates over WebSocket without periodic
polling. When the cloud connection is lost, devices are marked unreachable. It reconnects automatically and refreshes their state,
including devices added or removed while offline. Failed initialization or state refreshes are retried automatically.
Button presses missed during an interruption cannot be recovered.

Normal restarts keep your Matter registrations. If devices remain unreachable, check internet access, the controller ID
and token, and the Matterbridge log. If a feature is missing in your smart home app, check both the supported features
above and the app's Matter support.

## Development

The plugin uses [homematicip-cloud-client-ts](https://github.com/marcsowen/homematicip-cloud-client-ts) for cloud
communication, pairing, state validation, and connection lifecycle events. It is installed automatically;
users do not need to install or configure it separately.

Development uses Node.js 24, TypeScript, and Biome:

```sh
git clone https://github.com/marcsowen/matterbridge-homematicip.git
cd matterbridge-homematicip
npm ci
npm run build       # compile TypeScript
npm run lint        # check formatting and code quality
npm test            # build and run tests
npm run check       # lint and tests
npm pack --dry-run  # inspect package contents
```

To test a built checkout with Matterbridge, run `matterbridge --add "$PWD"` from its directory. Keep the directory
in place while registered. For Docker, mount the checkout into the container and register its path inside the container.

`src/catalog.ts` lists recognized device types. `src/mapping.ts` discovers channels and measurements.
`src/entity.ts` creates Matter devices and translates commands and state. `src/module.ts` manages discovery,
reconciliation, event ordering, and shutdown. `src/pair.ts` provides the pairing helper.

Tests cover device mappings, configuration, conversions, command failures, initialized Matter endpoints, and
connection recovery with simulated cloud responses. They do not access a real cloud account or replace physical-device
and smart home app testing. CI runs on Node.js 24.

## License

[Apache-2.0](LICENSE).
