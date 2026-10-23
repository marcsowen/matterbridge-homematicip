import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { HmIPClient } from 'homematicip-cloud-client-ts';

const accessPoint = process.argv[2]?.replace(/[-\s]/g, '').toUpperCase();
const output = process.argv[3];
if (!accessPoint || !/^[A-F0-9]{24}$/.test(accessPoint) || !output) {
  console.error('Usage: node dist/pair.js ACCESS_POINT_ID NEW_OUTPUT_FILE.json');
  process.exitCode = 1;
} else {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const timeout = setTimeout(300_000, undefined, { signal: abort.signal })
    .then(cancel)
    .catch(() => {});
  const client = new HmIPClient(console, {
    accessPoint,
    pin: process.env.HMIP_PIN,
    applicationIdentifier: 'matterbridge-homematicip',
    applicationVersion: '0.0.1',
  });
  try {
    console.info(
      'For HCU: press the controller button before starting. For HAP: press the link button when it flashes.',
    );
    if (!(await client.init(abort.signal))) throw new Error('Controller initialization failed.');
    const id = randomUUID();
    if (!(await client.authConnectionRequest(id, abort.signal))) throw new Error('Pairing request failed.');
    for (;;) {
      const result = await client.authRequestAcknowledged(id, abort.signal);
      if (result.status === 'failed') throw new Error('Pairing acknowledgement failed.');
      if (result.status === 'acknowledged') break;
      await setTimeout(1500, undefined, { signal: abort.signal });
    }
    const token = await client.authRequestToken(id, abort.signal);
    if (!token || !(await client.authConfirmToken(id, token.authToken, abort.signal)))
      throw new Error('Token confirmation failed.');
    await writeFile(output, `${JSON.stringify({ accessPoint, authToken: token.authToken }, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    console.info(
      'Pairing complete. Credentials saved to the requested file; copy them into the Matterbridge plugin configuration.',
    );
  } catch {
    console.error(
      'Pairing failed, timed out, or was cancelled. Check the controller button and ensure the output file does not already exist.',
    );
    process.exitCode = 1;
  } finally {
    abort.abort();
    client.shutdown();
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await timeout;
  }
}
