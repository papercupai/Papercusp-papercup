/**
 * Plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 #D-065 (WI-6554700010019417):
 * a fork pot's gate inherits only NON-TEST legs its upstream gate's own MEASURED result shows
 * red, and fails closed on every gap.
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_UPSTREAM_INSTALL_ENV,
  UPSTREAM_RESULT_MAX_AGE_MS,
  inheritUpstreamGateLegs,
  isInheritableGateEntry,
  partitionUpstreamInherited,
  upstreamGateResultFromGateHealth,
  upstreamInstallFromEnv,
} from './upstream-inherited-legs';

const NOW = 1_792_600_000_000;

/** Shaped like the upstream papercusp row measured 2026-10-21 (repairTickLegs from a hold tick,
 *  failingTestsMeasured left false by a later unmeasured tick). */
function tickHealth(atMs = NOW - 60_000) {
  return {
    failingTestsMeasured: false,
    failingTests: ['@bug-drill/fixture', 'some/carried/stale.test.ts'],
    repairTickLegs: {
      head: 'b6c344e0aac2',
      atMs,
      ok: false,
      failingSignatures: ['lint:tsc', '@papercusp/operator-core :: lint:condition-rail', '@papercusp/web :: test'],
      legs: [
        { id: 'lint:tsc', status: 'fail', durationMs: 1 },
        { id: 'lint:tsc:orchestrator', status: 'pass', durationMs: 1 },
        { id: 'lint:design-primitives', status: 'errored', durationMs: 1 },
        { id: 'lint:migrations', status: 'skipped', durationMs: 1 },
        { id: '@papercusp/operator-core :: lint:condition-rail', status: 'fail', durationMs: 1 },
        { id: '@papercusp/web :: test', status: 'fail', durationMs: 1 },
      ],
    },
  };
}

describe('isInheritableGateEntry', () => {
  it.each([
    ['lint:tsc', true],
    ['lint:tsc:workspaces', true],
    ['@papercusp/operator-core :: lint:condition-rail', true],
    ['@papercusp/operator-core :: typecheck', true],
    ['@papercusp/web :: test', false],
    ['@papercusp/web :: test:integration', false],
    ['@bug-drill/fixture', false],
    ['apps/operator/lib/release/selection-base.test.ts', false],
    ['@x/y :: seed', false],
    ['seed:demo', false],
    ['@papercusp/operator-vite', false],
    ['lint:tsc-missing', false],
  ])('%s → %s', (id, expected) => {
    expect(isInheritableGateEntry(id)).toBe(expected);
  });
});

describe('upstreamGateResultFromGateHealth', () => {
  it('prefers repairTickLegs: fail + errored legs, unioned with failingSignatures', () => {
    const read = upstreamGateResultFromGateHealth(tickHealth(), NOW);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.result.source).toBe('repairTickLegs');
    expect(new Set(read.result.failing)).toEqual(
      new Set([
        'lint:tsc',
        'lint:design-primitives',
        '@papercusp/operator-core :: lint:condition-rail',
        '@papercusp/web :: test',
      ]),
    );
    expect(read.result.failing).not.toContain('lint:tsc:orchestrator');
    expect(read.result.failing).not.toContain('lint:migrations');
  });

  it('never uses a carried failingTests list (failingTestsMeasured:false)', () => {
    const health = { failingTestsMeasured: false, failingTests: ['lint:tsc'], observedAt: NOW - 1000 };
    expect(upstreamGateResultFromGateHealth(health, NOW)).toEqual({ ok: false, reason: 'unmeasured' });
  });

  it('uses failingTests only when failingTestsMeasured is true, aged by observedAt', () => {
    const health = { failingTestsMeasured: true, failingTests: ['lint:tsc', 'a/b.test.ts'], observedAt: NOW - 1000 };
    const read = upstreamGateResultFromGateHealth(health, NOW);
    expect(read).toEqual({
      ok: true,
      result: { source: 'failingTests', failing: ['lint:tsc', 'a/b.test.ts'], observedAtMs: NOW - 1000 },
    });
  });

  it('fails closed on a stale measurement', () => {
    const read = upstreamGateResultFromGateHealth(tickHealth(NOW - UPSTREAM_RESULT_MAX_AGE_MS - 1), NOW);
    expect(read).toEqual({ ok: false, reason: 'stale' });
  });

  it('fails closed when the measurement has no timestamp', () => {
    const health = { failingTestsMeasured: true, failingTests: ['lint:tsc'] };
    expect(upstreamGateResultFromGateHealth(health, NOW)).toEqual({ ok: false, reason: 'unknown-age' });
  });

  it('fails closed with no gate_health at all', () => {
    expect(upstreamGateResultFromGateHealth(null, NOW)).toEqual({ ok: false, reason: 'no-gate-health' });
    expect(upstreamGateResultFromGateHealth([], NOW)).toEqual({ ok: false, reason: 'no-gate-health' });
  });

  it('falls back to failingTests when repairTickLegs is an explicit null (cleared by a real verdict)', () => {
    const health = { repairTickLegs: null, failingTestsMeasured: true, failingTests: ['lint:tsc'], observedAt: NOW - 5 };
    const read = upstreamGateResultFromGateHealth(health, NOW);
    expect(read.ok && read.result.source).toBe('failingTests');
  });
});

describe('partitionUpstreamInherited', () => {
  it('inherits only non-test legs upstream also shows red; tests and fork-only reds stay blocking', () => {
    const fork = [
      'lint:tsc',
      'lint:tsc:orchestrator',
      '@papercusp/operator-core :: lint:condition-rail',
      '@papercusp/web :: test',
      'apps/operator/lib/release/selection-base.test.ts',
    ];
    const upstream = {
      failing: ['lint:tsc', '@papercusp/operator-core :: lint:condition-rail', '@papercusp/web :: test'],
    };
    expect(partitionUpstreamInherited(fork, upstream)).toEqual({
      inherited: ['lint:tsc', '@papercusp/operator-core :: lint:condition-rail'],
      blocking: ['lint:tsc:orchestrator', '@papercusp/web :: test', 'apps/operator/lib/release/selection-base.test.ts'],
    });
  });
});

describe('inheritUpstreamGateLegs', () => {
  const base = { upstreamInstall: 'papercusp', workspaceId: 'ws', nowMs: NOW };

  it('applies a measured upstream result and logs the audit line', async () => {
    const reads: unknown[] = [];
    const out = await inheritUpstreamGateLegs({
      ...base,
      failingTests: ['lint:tsc', 'lint:tsc:orchestrator'],
      read: async (target) => {
        reads.push(target);
        return tickHealth();
      },
    });
    expect(reads).toEqual([{ workspaceId: 'ws', installSlug: 'papercusp' }]);
    expect(out.status).toBe('applied');
    expect(out.inherited).toEqual(['lint:tsc']);
    expect(out.blocking).toEqual(['lint:tsc:orchestrator']);
    expect(out.logLine).toBe(
      `UPSTREAM_INHERITED blocking=1 inherited=1 upstream=papercusp source=repairTickLegs observedAt=${NOW - 60_000}`,
    );
  });

  it('keeps every entry blocking when the read throws', async () => {
    const out = await inheritUpstreamGateLegs({
      ...base,
      failingTests: ['lint:tsc'],
      read: async () => {
        throw new Error('connection refused');
      },
    });
    expect(out).toMatchObject({ status: 'skipped', blocking: ['lint:tsc'], inherited: [] });
    expect(out.logLine).toContain('skipped=read-failed:connection refused');
  });

  it('keeps every entry blocking when upstream is unmeasured', async () => {
    const out = await inheritUpstreamGateLegs({
      ...base,
      failingTests: ['lint:tsc'],
      read: async () => ({ failingTestsMeasured: false, failingTests: ['lint:tsc'] }),
    });
    expect(out).toMatchObject({ status: 'skipped', reason: 'unmeasured', blocking: ['lint:tsc'], inherited: [] });
  });
});

describe('upstreamInstallFromEnv', () => {
  it('reads a well-formed slug and rejects junk', () => {
    expect(upstreamInstallFromEnv({ [GATE_UPSTREAM_INSTALL_ENV]: ' papercusp ' })).toBe('papercusp');
    expect(upstreamInstallFromEnv({})).toBeNull();
    expect(upstreamInstallFromEnv({ [GATE_UPSTREAM_INSTALL_ENV]: "x'; drop" })).toBeNull();
    expect(upstreamInstallFromEnv({ [GATE_UPSTREAM_INSTALL_ENV]: 'Papercusp' })).toBeNull();
  });
});
