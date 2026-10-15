/**
 * WI-10002031 — runner tests for the installed-hook-drift sweep.
 *
 * The load-bearing test in this file is "a REFUSAL escalates as NOT MEASURED and
 * never as clean". That is the whole reason the runner exists in the shape it
 * does: `detectInstalledHookDrift` is fail-closed and returns `drifted: []` under
 * a refusal, so the obvious runner (`if (drifted.length) alarm()`) goes silent on
 * a failed measurement — which is the precise bug that left the predecessor guard
 * inert for ~6 weeks. If someone "simplifies" the refusal branch away, these
 * tests are what fails.
 *
 * Every dep is injected. Nothing here reads the real ~/.papercusp/hooks/cc: that
 * directory is LEGITIMATELY divergent between a canonical fix landing and the
 * operator restart that re-installs it, so an ambient-reading test would go red
 * for reasons that are not bugs (and would pass in CI while failing for every
 * psu-launched agent — the failure closed as WI-10002057).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  resolveCanonicalCcHookDir,
  resolveInstalledCcHookDir,
  runInstalledHookDriftSweepOnce,
  type InstalledHookDriftSweepDeps,
} from './installed-hook-drift-watchdog';
import type { HookDriftReport } from '../desktop-install/installed-hook-drift';
import { CC_HOOK_FILES } from '../desktop-install/papercusp-files';

function report(over: Partial<HookDriftReport> = {}): HookDriftReport {
  return {
    canonicalDir: '/canon/apps/operator/scripts/hooks/cc',
    installedDir: '/home/agent/.papercusp/hooks/cc',
    checked: ['ask-gate-mirror.sh', 'guard-operator-desktop.mjs'],
    drifted: [],
    clean: true,
    ...over,
  };
}

/** Records which escalation path fired, so a test can assert routing, not just counts. */
function harness(over: Partial<InstalledHookDriftSweepDeps> = {}) {
  const calls = { drift: 0, notMeasured: 0, detect: 0, notMeasuredReasons: [] as string[] };
  const deps: Partial<InstalledHookDriftSweepDeps> = {
    host: () => 'fixture-host',
    rail: { broadcast: async () => true, resolve: async () => true },
    resolveCanonical: () => ({ ok: true, dir: '/canon/apps/operator/scripts/hooks/cc', source: 'integration-root' }),
    resolveInstalled: () => '/home/agent/.papercusp/hooks/cc',
    detect: () => {
      calls.detect += 1;
      return report();
    },
    escalateDrift: async () => {
      calls.drift += 1;
    },
    escalateNotMeasured: async (info) => {
      calls.notMeasured += 1;
      calls.notMeasuredReasons.push(info.reason);
    },
    ...over,
  };
  return { calls, deps };
}

describe('resolveCanonicalCcHookDir', () => {
  it('prefers PAPERCUSP_INTEGRATION_ROOT — the seam the operator services set', () => {
    const r = resolveCanonicalCcHookDir({
      PAPERCUSP_INTEGRATION_ROOT: '/integration',
      PAPERCUSP_RELEASE_ROOT: '/release',
    } as NodeJS.ProcessEnv);
    expect(r).toEqual({
      ok: true,
      dir: '/integration/apps/operator/scripts/hooks/cc',
      source: 'integration-root',
    });
  });

  it('falls back to PAPERCUSP_RELEASE_ROOT', () => {
    const r = resolveCanonicalCcHookDir({ PAPERCUSP_RELEASE_ROOT: '/release' } as NodeJS.ProcessEnv);
    expect(r).toEqual({
      ok: true,
      dir: '/release/apps/operator/scripts/hooks/cc',
      source: 'release-root',
    });
  });

  it('REFUSES rather than guessing from the calling process tree when neither is set', () => {
    // Guessing here would compare the install against whatever tree the operator
    // happens to run from — the confusion that produces the drift in the first
    // place — and would manufacture drift that does not exist.
    const r = resolveCanonicalCcHookDir({} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toMatch(/PAPERCUSP_INTEGRATION_ROOT/);
  });

  it('treats a whitespace-only root as unset', () => {
    const r = resolveCanonicalCcHookDir({ PAPERCUSP_INTEGRATION_ROOT: '   ' } as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });
});

describe('installed-hook original condition lifecycle', () => {
  function lifecycle() {
    const open = new Set<string>(), resolved: string[] = [];
    const state = { report: report({ clean: false, drifted: [{ name: 'guard.mjs', status: 'divergent',
      canonicalSha256: 'new', installedSha256: 'old' }] }) };
    const { deps } = harness({ detect: () => state.report, rail: {
      broadcast: async event => { open.add(event.conditionKey!); expect(event.oneShot).toBe(true); return true; },
      resolve: async event => { if (!open.delete(event.conditionKey)) return false; resolved.push(event.conditionKey); return true; },
    } });
    return { open, resolved, state, deps };
  }

  it('preserves drift through a refused measurement, then resolves both episodes from complete matching bytes', async () => {
    const f = lifecycle();
    await runInstalledHookDriftSweepOnce(f.deps); expect(f.open.size).toBe(1);
    f.state.report = report({ clean: false, checked: [], refused: 'installed-dir-unreadable' });
    await runInstalledHookDriftSweepOnce({ ...f.deps }); expect(f.open.size).toBe(2);
    f.state.report = report(); await runInstalledHookDriftSweepOnce({ ...f.deps });
    expect(f.open.size).toBe(0); expect(f.resolved).toHaveLength(2);
  });

  it('a complete drifting measurement resolves blindness while drift remains open', async () => {
    const f = lifecycle(); const drift = f.state.report;
    f.state.report = report({ clean: false, checked: [], refused: 'canonical-dir-unreadable' });
    await runInstalledHookDriftSweepOnce(f.deps); expect(f.open.size).toBe(1);
    f.state.report = drift; await runInstalledHookDriftSweepOnce(f.deps);
    expect(f.open.size).toBe(1); expect([...f.open][0]).toContain(':drift:');
    expect(f.resolved[0]).toContain(':blind');
  });

  it('unreadable bytes and an empty comparison preserve alarms', async () => {
    const f = lifecycle();
    f.state.report.drifted[0].status = 'unreadable';
    await runInstalledHookDriftSweepOnce(f.deps); expect(f.open.size).toBe(2);
    f.state.report = report({ checked: [] }); await runInstalledHookDriftSweepOnce(f.deps);
    expect(f.open.size).toBe(2); expect(f.resolved).toEqual([]);
  });

  it('another host or installed directory cannot resolve an existing drift episode', async () => {
    const f = lifecycle(); await runInstalledHookDriftSweepOnce(f.deps);
    f.state.report = report();
    await runInstalledHookDriftSweepOnce({ ...f.deps, host: () => 'other-host' });
    await runInstalledHookDriftSweepOnce({ ...f.deps, resolveInstalled: () => '/other/install' });
    expect(f.open.size).toBe(1); expect(f.resolved).toEqual([]);
  });

  it.each(['resolveCanonical', 'resolveInstalled', 'detect'] as const)('a thrown %s is measured blindness', async field => {
    const f = lifecycle();
    f.deps[field] = () => { throw new Error('unavailable'); };
    expect((await runInstalledHookDriftSweepOnce(f.deps)).verdict).toBe('not-measured');
    expect([...f.open]).toEqual(['alarm:installed-hook-drift:fixture-host:blind']);
  });

  it('both delivery legs remain independent', async () => {
    const f = lifecycle(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      f.deps.escalateDrift = async () => { throw new Error('legacy down'); };
      await runInstalledHookDriftSweepOnce(f.deps); expect(f.open.size).toBe(1);
      f.deps.rail!.broadcast = async () => { throw new Error('broadcast down'); };
      const legacy = vi.fn(async () => {}); f.deps.escalateDrift = legacy;
      await runInstalledHookDriftSweepOnce(f.deps); expect(legacy).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
});

describe('resolveInstalledCcHookDir', () => {
  it('points at the copy that actually executes on every agent turn', () => {
    expect(resolveInstalledCcHookDir('/home/agent')).toBe('/home/agent/.papercusp/hooks/cc');
  });
});

describe('runInstalledHookDriftSweepOnce', () => {
  it('scopes detection to the managed CC hook manifest', async () => {
    let managedNames: readonly string[] | undefined;
    const { deps } = harness({
      detect: (opts) => {
        managedNames = opts.managedNames;
        return report();
      },
    });

    await runInstalledHookDriftSweepOnce(deps);

    expect(managedNames).toEqual(CC_HOOK_FILES);
  });

  it('stays quiet only when a real comparison ran and found nothing', async () => {
    const { calls, deps } = harness();
    const out = await runInstalledHookDriftSweepOnce(deps);
    expect(out).toEqual({ verdict: 'clean', checked: 2, escalated: 0 });
    expect(calls.drift).toBe(0);
    expect(calls.notMeasured).toBe(0);
  });

  it('escalates drift when installed bytes diverge from canonical', async () => {
    const { calls, deps } = harness({
      detect: () =>
        report({
          clean: false,
          drifted: [
            {
              name: 'ask-gate-mirror.sh',
              status: 'divergent',
              canonicalSha256: 'aaa',
              installedSha256: 'bbb',
            },
          ],
        }),
    });
    const out = await runInstalledHookDriftSweepOnce(deps);
    expect(out).toEqual({ verdict: 'drifted', checked: 2, drifted: 1, escalated: 1 });
    expect(calls.drift).toBe(1);
    expect(calls.notMeasured).toBe(0);
  });

  it('REGRESSION: a refusal escalates as NOT MEASURED, never as clean', async () => {
    // The refusal contract carries drifted: [] — so a runner that keyed on
    // `drifted.length > 0` would report success here. That silent-success is the
    // 6-week-inert bug this whole item exists to kill.
    const { calls, deps } = harness({
      detect: () =>
        report({ clean: false, checked: [], drifted: [], refused: 'installed-dir-unreadable' }),
    });
    const out = await runInstalledHookDriftSweepOnce(deps);
    expect(out).toEqual({
      verdict: 'not-measured',
      reason: 'installed-dir-unreadable',
      escalated: 1,
    });
    expect(calls.notMeasured).toBe(1);
    expect(calls.drift).toBe(0);
  });

  it('REGRESSION: an unreadable CANONICAL dir is also a failed measurement', async () => {
    const { calls, deps } = harness({
      detect: () =>
        report({ clean: false, checked: [], drifted: [], refused: 'canonical-dir-unreadable' }),
    });
    const out = await runInstalledHookDriftSweepOnce(deps);
    expect(out.verdict).toBe('not-measured');
    expect(calls.notMeasured).toBe(1);
    expect(calls.drift).toBe(0);
  });

  it('does not even attempt detection when the canonical baseline is unresolvable', async () => {
    const { calls, deps } = harness({
      resolveCanonical: () => ({ ok: false, reason: 'no integration root' }),
    });
    const out = await runInstalledHookDriftSweepOnce(deps);
    expect(out).toEqual({ verdict: 'not-measured', reason: 'no integration root', escalated: 1 });
    expect(calls.detect).toBe(0);
    expect(calls.notMeasured).toBe(1);
    expect(calls.notMeasuredReasons).toEqual(['no integration root']);
  });

  it('reports a missing-from-install hook as drift — an unarmed rail, not an absence', async () => {
    const { calls, deps } = harness({
      detect: () =>
        report({
          clean: false,
          drifted: [
            {
              name: 'new-guard.sh',
              status: 'missing-from-install',
              canonicalSha256: 'aaa',
              installedSha256: null,
            },
          ],
        }),
    });
    const out = await runInstalledHookDriftSweepOnce(deps);
    expect(out.verdict).toBe('drifted');
    expect(calls.drift).toBe(1);
  });
});
