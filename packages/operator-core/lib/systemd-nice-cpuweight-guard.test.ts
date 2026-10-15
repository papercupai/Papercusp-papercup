/**
 * systemd-nice-cpuweight-guard.test.ts — WI-10002636.
 *
 * Under cgroup v2, `Nice=` only ranks processes WITHIN a unit's own cgroup.
 * Against sibling units in the same slice, the CPU share is decided by
 * `CPUWeight=` (default 100). A unit that sets `Nice=10` to mean "background
 * job, yield to everything" therefore still competes at full weight unless it
 * also lowers `CPUWeight`. Measured 2026-09-23 06:33Z: kopia-snapshots.service
 * (Nice=10, no CPUWeight) burned 12.77 cores while the P-203 fold VM, at
 * weight 20, sat at 30% vCPU run-queue delay. Setting CPUWeight=10 dropped the
 * VM's delay to 3%.
 *
 * The guard: every repo-shipped `.service` that asks for background priority
 * (`Nice>=10` in `[Service]`) must also declare a `CPUWeight` below 100.
 * The units that predate this guard are listed in BASELINE, which may only
 * SHRINK: a baseline entry that no longer violates fails the test, so fixing
 * a unit forces its removal from the list. Review of that backlog is its own
 * work-item; each unit needs judgment (a pg_dump starved at weight 1 on a
 * contended box holds its snapshot longer and delays PG's xmin horizon).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SYSTEMD_DIR = fileURLToPath(new URL('../../../apps/operator/scripts/systemd/', import.meta.url));

/** Background-priority threshold: Nice at or above this means "yield to siblings". */
const BACKGROUND_NICE = 10;

/**
 * Pre-existing units that set Nice>=10 without a CPUWeight. SHRINK-ONLY:
 * remove an entry when its unit gains a CPUWeight; never add one.
 */
const BASELINE: ReadonlySet<string> = new Set([
  'llm-test-nightly.service',
  'papercup-backup-health.service',
  'papercup-docker-reclaim.service',
  'papercup-fedplane-disk-health.service',
  'papercup-isolated-dht-liveness.service',
  'papercup-live-federation-gate.service',
  'papercup-perf-signals-capture.service',
  'papercup-testvm-reaper.service',
  'papercup-tmp-scratch-reclaim.service',
  'papercup-vitest-orphan-reaper.service',
  'papercup-webkit-reaper.service',
  'papercusp-db-backup.service',
]);

interface ServicePriority {
  nice: number | null;
  cpuWeight: number | null;
}

/** Reads Nice= and CPUWeight= from the [Service] section only; comments ignored. */
export function readServicePriority(unitText: string): ServicePriority {
  let section = '';
  const out: ServicePriority = { nice: null, cpuWeight: null };
  for (const raw of unitText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'Nice') out.nice = Number.parseInt(value ?? '', 10);
    if (key === 'CPUWeight') out.cpuWeight = Number.parseInt(value ?? '', 10);
  }
  return out;
}

/** True when the unit asks for background priority but leaves its cgroup CPU share at default or higher. */
export function niceWithoutCpuWeight(unitText: string): boolean {
  const { nice, cpuWeight } = readServicePriority(unitText);
  if (nice === null || Number.isNaN(nice) || nice < BACKGROUND_NICE) return false;
  return cpuWeight === null || Number.isNaN(cpuWeight) || cpuWeight >= 100;
}

function loadUnits(): Array<{ name: string; text: string }> {
  return readdirSync(SYSTEMD_DIR)
    .filter((f) => f.endsWith('.service'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(SYSTEMD_DIR, name), 'utf8') }));
}

describe('niceWithoutCpuWeight predicate (WI-10002636)', () => {
  it('FLAGS the pre-fix kopia shape: Nice=10 in [Service], no CPUWeight', () => {
    const unit = ['[Unit]', 'Description=x', '', '[Service]', 'Type=oneshot', 'Nice=10', 'IOSchedulingClass=best-effort'].join('\n');
    expect(niceWithoutCpuWeight(unit)).toBe(true);
  });

  it('FLAGS Nice=19 with an explicit default CPUWeight=100', () => {
    expect(niceWithoutCpuWeight(['[Service]', 'Nice=19', 'CPUWeight=100'].join('\n'))).toBe(true);
  });

  it('does NOT flag Nice=10 with CPUWeight=10', () => {
    expect(niceWithoutCpuWeight(['[Service]', 'Nice=10', 'CPUWeight=10'].join('\n'))).toBe(false);
  });

  it('does NOT flag a mild Nice below the background threshold', () => {
    expect(niceWithoutCpuWeight(['[Service]', 'Nice=5'].join('\n'))).toBe(false);
  });

  it('does NOT read a CPUWeight that appears only in a comment', () => {
    expect(niceWithoutCpuWeight(['[Service]', 'Nice=10', '# CPUWeight=10 would go here'].join('\n'))).toBe(true);
  });

  it('ignores keys outside [Service]', () => {
    expect(niceWithoutCpuWeight(['[Unit]', 'Nice=10', '', '[Service]', 'Type=simple'].join('\n'))).toBe(false);
  });
});

describe('repo systemd units: background Nice needs a CPUWeight (WI-10002636)', () => {
  const units = loadUnits();

  it('finds the unit directory (positive control: kopia-snapshots.service is present)', () => {
    expect(units.map((u) => u.name)).toContain('kopia-snapshots.service');
  });

  it('no unit outside the shrink-only baseline sets Nice>=10 without CPUWeight<100', () => {
    const offenders = units.filter((u) => !BASELINE.has(u.name) && niceWithoutCpuWeight(u.text)).map((u) => u.name);
    expect(offenders).toEqual([]);
  });

  it('every baseline entry still exists and still violates (fixed units must leave the baseline)', () => {
    const byName = new Map(units.map((u) => [u.name, u.text]));
    const stale = [...BASELINE].filter((name) => {
      const text = byName.get(name);
      return text === undefined || !niceWithoutCpuWeight(text);
    });
    expect(stale).toEqual([]);
  });

  it.each(['kopia-snapshots.service', 'kopia-home-snapshot.service'])('%s runs at CPUWeight <= 10', (name) => {
    const unit = units.find((u) => u.name === name);
    expect(unit).toBeDefined();
    const { cpuWeight } = readServicePriority(unit?.text ?? '');
    expect(cpuWeight).not.toBeNull();
    expect(cpuWeight).toBeLessThanOrEqual(10);
  });
});
