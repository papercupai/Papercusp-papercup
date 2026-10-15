/** Test-only preload: the maintained fixture owns this child's private IPC channel.
 * Production token lifetimes and the machine clock are never changed.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { fixtureIdentity } from './native-device-fixture';

export const DEVICE_EXPIRY_OFFSET_MS = 366 * 24 * 60 * 60 * 1000;

export function installFixtureClock() {
  fixtureIdentity(process.env);
  assert(process.send && process.connected, 'Fixture clock requires an owned private IPC channel');
  const originalNow = Date.now;
  let offset = 0;
  Date.now = () => originalNow() + offset;
  process.on('message', message => {
    if (!message || typeof message !== 'object' || !('type' in message) ||
      message.type !== 'native-fixture-expire-device') return;
    offset = DEVICE_EXPIRY_OFFSET_MS;
    process.send!({ type: 'native-fixture-clock-advanced', offsetMs: offset });
  });
}

export async function advanceFixtureDeviceClock(child: ChildProcess, env = process.env) {
  fixtureIdentity(env);
  assert(typeof child.send === 'function' && child.connected && child.exitCode === null && child.signalCode === null,
    'Expiry requires the owned live IPC operator');
  return new Promise<number>((done, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); child.off('message', received); child.off('exit', exited);
      if (error) reject(error); else done(DEVICE_EXPIRY_OFFSET_MS);
    };
    const received = (value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value &&
        value.type === 'native-fixture-clock-advanced' && 'offsetMs' in value &&
        value.offsetMs === DEVICE_EXPIRY_OFFSET_MS) finish();
    };
    const exited = () => finish(new Error('Owned operator exited before clock acknowledgement'));
    const timer = setTimeout(() => finish(new Error('Owned operator did not acknowledge expiry clock')), 5000);
    child.on('message', received); child.once('exit', exited);
    child.send!({ type: 'native-fixture-expire-device' }, error => { if (error) finish(error); });
  });
}

// Importing helpers in the suite has no effect; only the explicit child preload installs it.
if (process.execArgv.includes(fileURLToPath(import.meta.url))) installFixtureClock();
