/**
 * The provider-sandbox probe against REAL bubblewrap (WI-10006742).
 *
 * The probe used to fail for any plugin dir under /dev/shm, because the profile
 * mounted a fresh /dev on top of the plugin bind. It then reported "bwrap with
 * --unshare-net is unavailable on this host", a host-level claim that sent the
 * diagnosis the wrong way. These cases run the exact profile through bwrap:
 * the regression case, a positive control under the OS tmpdir, a failure that
 * must carry bwrap's own reason, and a non-finishing probe that must not be
 * cached.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DaemonSandboxUnavailableError, probeProviderSandbox, providerSandboxWorks, startDaemonPlugin } from './supervisor';

const BWRAP = '/usr/bin/bwrap';
const runtimeDirs = [dirname(dirname(process.execPath))];
const made: string[] = [];

function scratchUnder(base: string): string {
  const dir = mkdtempSync(join(base, 'provider-sandbox-probe-'));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux' && existsSync(BWRAP))('provider sandbox probe (real bwrap)', () => {
  it('establishes the profile for a plugin dir under the OS tmpdir (precondition, not a skip)', async () => {
    const probe = await probeProviderSandbox({ pluginDir: scratchUnder(tmpdir()), runtimeDirs });
    expect(probe).toEqual({ works: true });
  });

  it.runIf(existsSync('/dev/shm'))('establishes the profile for a plugin dir under /dev/shm, the test TMPDIR fallback', async () => {
    const probe = await probeProviderSandbox({ pluginDir: scratchUnder('/dev/shm'), runtimeDirs });
    expect(probe).toEqual({ works: true });
  });

  it('a failure carries bwrap\'s own reason, not a claim about the host', async () => {
    const missing = join(scratchUnder(tmpdir()), 'not-installed');
    const probe = await probeProviderSandbox({ pluginDir: missing, runtimeDirs });
    expect(probe.works).toBe(false);
    expect(probe.detail).toContain(missing);
    expect(await providerSandboxWorks({ pluginDir: missing, runtimeDirs })).toBe(false);
  });

  it('a probe that did not run to an exit status is not cached', async () => {
    const dir = scratchUnder(tmpdir());
    const fakeBwrap = join(dir, 'fake-bwrap');
    // Present but not executable: EACCES occurs before bwrap ever runs.
    writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const pluginDir = scratchUnder(tmpdir());
    const first = await probeProviderSandbox({ bwrapBinary: fakeBwrap, pluginDir, runtimeDirs });
    expect(first.works).toBe(false);
    expect(first.detail).toMatch(/not cached/);
    chmodSync(fakeBwrap, 0o755);
    expect(await probeProviderSandbox({ bwrapBinary: fakeBwrap, pluginDir, runtimeDirs })).toEqual({ works: true });
  });

  it('a profile that ran and failed IS cached (positive control for the case above)', async () => {
    const dir = scratchUnder(tmpdir());
    const fakeBwrap = join(dir, 'fake-bwrap');
    writeFileSync(fakeBwrap, '#!/bin/sh\necho refused >&2\nexit 1\n', { mode: 0o755 });
    const pluginDir = scratchUnder(tmpdir());
    expect(await probeProviderSandbox({ bwrapBinary: fakeBwrap, pluginDir, runtimeDirs })).toEqual({ works: false, detail: 'refused' });
    writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await probeProviderSandbox({ bwrapBinary: fakeBwrap, pluginDir, runtimeDirs })).toEqual({ works: false, detail: 'refused' });
  });
});

describe.runIf(process.platform === 'linux')('provider sandbox probe responsiveness', () => {
  it('keeps the host responsive while a probe waits and shares concurrent starts', async () => {
    const dir = scratchUnder(tmpdir());
    const fakeBwrap = join(dir, 'fake-bwrap');
    // Only the host timer can release this child. A synchronous probe prevents
    // that timer from firing and times out instead of establishing the profile.
    writeFileSync(fakeBwrap, '#!/bin/sh\necho call >> "$0.calls"\nwhile [ ! -f "$0.ready" ]; do /bin/sleep 0.01; done\n', { mode: 0o755 });
    const input = { bwrapBinary: fakeBwrap, pluginDir: dir, runtimeDirs };
    const release = setTimeout(() => writeFileSync(`${fakeBwrap}.ready`, 'ready'), 0);
    try {
      expect(await Promise.all([probeProviderSandbox(input), probeProviderSandbox(input)]))
        .toEqual([{ works: true }, { works: true }]);
      expect(readFileSync(`${fakeBwrap}.calls`, 'utf8').trim().split('\n')).toEqual(['call']);
    } finally {
      clearTimeout(release);
    }
  });
});

/**
 * WI-6554700010018251: a probe that times out says nothing about the profile,
 * yet startDaemonPlugin used to refuse the provider on it, so one slow bwrap
 * run on a loaded host left the provider unregistered. The fake below stands
 * in for bwrap: its probe run (`... -- /usr/bin/true`) runs `probeBody`; any
 * other run records its argv and waits like a live daemon.
 */
describe.runIf(process.platform === 'linux')('provider daemon start after a probe outcome', () => {
  function fakeBwrap(probeBody: string): string {
    const fake = join(scratchUnder(tmpdir()), 'fake-bwrap');
    writeFileSync(fake, [
      '#!/bin/sh',
      'for last; do :; done',
      `if [ "$last" = /usr/bin/true ]; then ${probeBody}; fi`,
      'echo "$@" > "$0.spawned"',
      'exec /bin/sleep 30',
    ].join('\n') + '\n', { mode: 0o755 });
    return fake;
  }

  async function waitForFile(file: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (existsSync(file)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return existsSync(file);
  }

  const base = { pluginName: 'probe-outcome-fixture', cmd: ['/usr/bin/node', 'daemon.cjs'], sandbox: 'provider' as const, runtimeDirs, restart: { policy: 'never' as const } };

  it('spawns through bwrap when the probe times out instead of refusing the provider', async () => {
    const bwrap = fakeBwrap('exec /bin/sleep 5');
    const logs: string[] = [];
    const handle = await startDaemonPlugin({
      ...base, cwd: scratchUnder(tmpdir()), bwrapBinary: bwrap, sandboxProbeTimeoutMs: 100, onLog: (line) => logs.push(line),
    });
    try {
      expect(handle.pid()).toBeTypeOf('number');
      expect(await waitForFile(`${bwrap}.spawned`, 10_000)).toBe(true);
      expect(readFileSync(`${bwrap}.spawned`, 'utf8').trim()).toMatch(/ -- \/usr\/bin\/node daemon\.cjs$/);
      expect(logs.filter((line) => line.includes('provider sandbox probe inconclusive'))).toHaveLength(1);
    } finally {
      await handle.shutdown();
    }
  }, 20_000);

  it('still refuses when the probe ran and the profile failed (positive control)', async () => {
    const bwrap = fakeBwrap('echo "unshare denied" >&2; exit 1');
    await expect(startDaemonPlugin({ ...base, cwd: scratchUnder(tmpdir()), bwrapBinary: bwrap, sandboxProbeTimeoutMs: 15_000 }))
      .rejects.toThrow(DaemonSandboxUnavailableError);
    expect(existsSync(`${bwrap}.spawned`)).toBe(false);
  }, 20_000);

  it('fails a pending call at once when bwrap cannot be spawned at all', async () => {
    const bwrap = fakeBwrap('exit 0');
    chmodSync(bwrap, 0o644); // EACCES: neither the probe nor the spawn can start it
    const started = Date.now();
    const outcome = await startDaemonPlugin({ ...base, cwd: scratchUnder(tmpdir()), bwrapBinary: bwrap })
      .then(async (handle) => {
        try {
          await handle.request('papercup.describe', undefined, 15_000);
          return 'resolved';
        } catch (e) {
          return String(e);
        } finally {
          await handle.shutdown();
        }
      }, (e: unknown) => String(e));
    expect(outcome).toMatch(/spawn error|EACCES/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});
