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
import { probeProviderSandbox, providerSandboxWorks } from './supervisor';

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
