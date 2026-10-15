/**
 * Integration rung for the AgenticMail entrypoint guard
 * (reboot-residue-service-repairs-2026-10-03, spec FAIL-P-001-agenticmail-entrypoint@2:
 * "The AgenticMail health check reports the API as unavailable when its packaged API is absent").
 *
 * The 2026-10-02 reboot left agenticmail.service `failed` for days. Its start script exec'd node
 * on `<npm root -g>/agenticmail/node_modules/@agenticmail/api/dist/index.js`, which a disk
 * reclamation had deleted, and nothing reported it because the reconciler only checked the static
 * SUPERVISED_PROCESSES registry. The tree-side guard for that class is the host-scoped failed-unit
 * census (`censusUnregisteredFailedUnits`, wired `failedUnitCensus: true` in production deps).
 *
 * The unit rung (unit-reconciler-failed-unit-census.test.ts) feeds canned `systemctl` text. This
 * rung uses no stubs for the boundary the residue crossed. It installs a real runtime (not
 * transient) user unit shaped like agenticmail.service: a start script that execs node on the
 * packaged API entry. It starts the unit on the REAL user systemd manager, and lets the census read
 * it through the production `execSystemctlUser` against the real SUPERVISED_PROCESSES registry.
 *
 *   - entry ABSENT  -> node exits on MODULE_NOT_FOUND, the unit goes `failed`, and the census
 *                      reports it and announces it once.
 *   - entry PRESENT -> the unit stays `active` and the census does not report it (control).
 *
 * Fixture units are named `pc-itest-agenticmail-<rand>.service` and are stopped, reset and removed,
 * followed by a daemon-reload, after each case.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SUPERVISION_RECONCILE_SIDECAR_VAR,
  execSystemctlUser,
} from '../harness/routines/supervision-reconcile-action';
import { SUPERVISED_PROCESSES } from '../service-health';
import { _resetFailedUnitCensusForTests, censusUnregisteredFailedUnits } from './unit-reconciler';

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
const UNIT_DIR = RUNTIME_DIR ? join(RUNTIME_DIR, 'systemd', 'user') : '';
const userSystemdReachable =
  !!RUNTIME_DIR && spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0;

/** The packaged API entry path relative to the npm global root, as agenticmail's start script names it. */
const ENTRY_REL = join('agenticmail', 'node_modules', '@agenticmail', 'api', 'dist', 'index.js');

function systemctl(...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function activeState(unit: string): string {
  return systemctl('show', '-p', 'ActiveState', '--value', unit).stdout.trim();
}

async function waitForState(unit: string, want: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = activeState(unit);
  while (state !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    state = activeState(unit);
  }
  return state;
}

const cleanups: Array<() => void> = [];

/**
 * Install an agenticmail-shaped runtime unit whose start script execs node on the packaged API
 * entry under a fresh npm global root. `withEntry` decides whether the packaged API exists.
 */
function installAgenticmailShapedUnit(withEntry: boolean): { unit: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), 'pc-itest-npm-root-'));
  const entry = join(root, 'lib', 'node_modules', ENTRY_REL);
  mkdirSync(dirname(entry), { recursive: true });
  if (withEntry) {
    // A minimal long-running API stand-in: it stays up, as the real server does.
    writeFileSync(entry, 'setInterval(() => {}, 1 << 30);\n');
  }
  const startScript = join(root, 'start-server.sh');
  writeFileSync(startScript, `#!/bin/sh\nexec "${process.execPath}" "${entry}"\n`);
  chmodSync(startScript, 0o755);

  const unit = `pc-itest-agenticmail-${randomBytes(4).toString('hex')}.service`;
  const unitPath = join(UNIT_DIR, unit);
  mkdirSync(UNIT_DIR, { recursive: true });
  writeFileSync(
    unitPath,
    [
      '[Unit]',
      'Description=papercusp integration fixture (FAIL-P-001): agenticmail-shaped API entry',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${startScript}`,
      'Restart=no',
      '',
    ].join('\n'),
  );
  cleanups.push(() => {
    systemctl('stop', unit);
    systemctl('reset-failed', unit);
    rmSync(unitPath, { force: true });
    systemctl('daemon-reload');
    rmSync(root, { recursive: true, force: true });
  });
  expect(systemctl('daemon-reload').status).toBe(0);
  return { unit, entry };
}

describe.skipIf(!userSystemdReachable)('failed-unit census on the real user systemd manager (FAIL-P-001)', () => {
  const priorSidecarVar = process.env[SUPERVISION_RECONCILE_SIDECAR_VAR];

  beforeAll(() => {
    // Force the production exec to spawn systemctl locally, so the test does not depend on a
    // spawner sidecar being up. The systemctl call, its arguments and its parsing are unchanged.
    process.env[SUPERVISION_RECONCILE_SIDECAR_VAR] = '0';
    return () => {
      if (priorSidecarVar === undefined) delete process.env[SUPERVISION_RECONCILE_SIDECAR_VAR];
      else process.env[SUPERVISION_RECONCILE_SIDECAR_VAR] = priorSidecarVar;
    };
  });

  beforeEach(() => _resetFailedUnitCensusForTests());

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('reports the unit as failed when the packaged API entry is absent', async () => {
    const { unit } = installAgenticmailShapedUnit(false);
    systemctl('start', unit);
    expect(await waitForState(unit, 'failed')).toBe('failed');
    // The unit is a runtime unit file, not a run-scoped transient unit: the census's selection
    // depends on exactly this property, so pin it from systemd itself.
    expect(systemctl('show', '-p', 'Transient', '--value', unit).stdout.trim()).toBe('no');

    const notes: string[] = [];
    const reported = await censusUnregisteredFailedUnits(
      { execUser: execSystemctlUser, notify: async ({ summary }) => void notes.push(summary) },
      SUPERVISED_PROCESSES,
      () => {},
    );

    expect(reported).toContain(unit);
    expect(notes.join('\n')).toContain(unit);
  }, 30_000);

  it('does not report the unit while the packaged API entry is present (control)', async () => {
    const { unit } = installAgenticmailShapedUnit(true);
    systemctl('start', unit);
    expect(await waitForState(unit, 'active')).toBe('active');
    // Give a bad entry the chance to crash before the census reads, so "active" is not a race.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(activeState(unit)).toBe('active');

    const notes: string[] = [];
    const reported = await censusUnregisteredFailedUnits(
      { execUser: execSystemctlUser, notify: async ({ summary }) => void notes.push(summary) },
      SUPERVISED_PROCESSES,
      () => {},
    );

    expect(reported).not.toContain(unit);
    expect(notes.join('\n')).not.toContain(unit);
  }, 30_000);

  it('announces a still-failed unit once per failure episode', async () => {
    const { unit } = installAgenticmailShapedUnit(false);
    systemctl('start', unit);
    expect(await waitForState(unit, 'failed')).toBe('failed');

    const notes: string[] = [];
    const deps = { execUser: execSystemctlUser, notify: async ({ summary }: { summary: string }) => void notes.push(summary) };
    const first = await censusUnregisteredFailedUnits(deps, SUPERVISED_PROCESSES, () => {});
    const second = await censusUnregisteredFailedUnits(deps, SUPERVISED_PROCESSES, () => {});

    // Both ticks still REPORT the unit; only the first ANNOUNCES it.
    expect(first).toContain(unit);
    expect(second).toContain(unit);
    expect(notes.filter((n) => n.includes(unit))).toHaveLength(1);
  }, 30_000);
});

describe('environment precondition (FAIL-P-001 must not pass by skipping)', () => {
  it('has a reachable user systemd manager on hosts that run this rung', () => {
    // On a host without a user manager the rung above skips; this case records that explicitly
    // rather than letting a skipped suite read as a pass.
    if (!userSystemdReachable) {
      expect.soft(userSystemdReachable, 'user systemd unreachable: FAIL-P-001 rung skipped').toBe(true);
      return;
    }
    expect(UNIT_DIR).toMatch(/systemd\/user$/);
  });
});
