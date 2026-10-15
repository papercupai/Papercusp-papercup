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

describe.skipIf(!nativeAvailable)('isolated GNOME renderer integration', () => {
  it('measures visible windows, changed PTY geometry and genuinely different retained history', async () => {
    const { stdout } = await run('/usr/bin/python3', [fixture, '--lines=60000', '--limit=10000',
      '--prepare-profile-module', preparationModule], {
      timeout: 45_000, maxBuffer: 128 * 1024,
    });
    const rows = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.unlimited)).toEqual([false, true]);
    expect(rows[1].history_bytes).toBeGreaterThan(rows[0].history_bytes * 3);
    expect(rows[0].profile_uuid).not.toBe(rows[0].default_profile_uuid);
    for (const row of rows) {
      expect(row.default_still_unlimited).toBe(true);
      expect(row.font_preserved).toBe(true);
      // A hidden GtkWindow answers pings but never changes the visible VTE grid.
      // Refuse to treat such samples as renderer latency evidence again.
      const columns = row.columns_after_resize.map((title: string) => {
        expect(title).toMatch(/^REFLOW_COLS_\d+_\d+$/);
        return Number(title.split('_').at(-1));
      });
      expect(columns[0]).toBeLessThan(columns[1]);
      expect(columns[2]).toBeLessThan(columns[3]);
      expect(columns[2]).toBeGreaterThan(columns[0]);
      expect(row.baseline_ping_ms).toHaveLength(5);
      expect(row.sibling_ping_after_resize_ms).toHaveLength(4);
      expect(row.sibling_ping_after_resize_ms.every((ms: number) => Number.isFinite(ms) && ms >= 0)).toBe(true);
      if (!row.unlimited) expect(Math.max(...row.sibling_ping_after_resize_ms)).toBeLessThan(250);
    }
    console.info('CUSTOMER_TERMINAL_STRESS_JSON=' + JSON.stringify({
      kind: 'gnome-history-reflow', lines: 60000, displayHistoryLimit: 10000,
      siblingReplyBoundMs: 250, rows,
    }));
  }, 50_000);

  it('keeps a new standard GNOME window in a separate renderer from preserved old history', async () => {
    const { stdout } = await run('/usr/bin/python3', [fixture, '--lines=20000', '--limit=10000',
      '--prepare-profile-module', preparationModule, '--isolate-sibling'], {
      timeout: 45_000, maxBuffer: 128 * 1024,
    });
    const rows = stdout.trim().split('\n').map((line) => JSON.parse(line));
    for (const row of rows) {
      if (row.independent_sibling) expect(row.sibling_server_pid).not.toBe(row.server_pid);
      else expect(row.sibling_server_pid).toBe(row.server_pid);
      expect(row.default_still_unlimited).toBe(true);
    }
    console.info('CUSTOMER_TERMINAL_STRESS_JSON=' + JSON.stringify({
      kind: 'gnome-renderer-isolation', lines: 20000, displayHistoryLimit: 10000, rows,
    }));
  }, 50_000);
});
