// @vitest-environment node
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/gnome-reflow-probe.py', import.meta.url));
const preparationModule = new URL('../../../packages/operator-core/lib/gnome-terminal-profile.mjs', import.meta.url).href;
const run = promisify(execFile);
const nativeAvailable = process.platform === 'linux'
  && existsSync('/usr/libexec/gnome-terminal-server')
  && spawnSync('/usr/bin/python3', ['-c', 'from gi.repository import Gio'], { timeout: 2_000 }).status === 0
  && ['xvfb-run', 'dbus-run-session', 'xdotool', 'openbox', 'xprop'].every((command) =>
    spawnSync('which', [command], { timeout: 2_000 }).status === 0);

describe.skipIf(!nativeAvailable)('isolated GNOME renderer reproduction', () => {
  it('rejects invalid workload sizes before creating a GUI or settings backend', async () => {
    await expect(run('/usr/bin/python3', [fixture, '--lines=999'], { timeout: 5_000 }))
      .rejects.toMatchObject({ code: 2 });
  });

});
