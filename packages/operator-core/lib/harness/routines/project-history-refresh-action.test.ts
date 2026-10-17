/**
 * Guards for `system:project-history-refresh` (EI-20475585438015488, cause 3).
 *
 * The subject of these tests is the POLICY, not the subprocess: config resolution,
 * argv construction, the two path preconditions, and the failure-streak fold are all
 * pure, so the behaviour that actually decides whether a hive's History artifact stays
 * fresh is testable without a multi-minute generation.
 *
 * Two of these guards exist because of measured failures, not hypotheticals — see the
 * PATH TRAP note in the action's header. They are marked below.
 */
import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  resolveProjectHistoryConfig,
  buildProjectHistoryArgs,
  resolveCliBin,
  resolvePtool,
  decideProjectHistoryHealthUpdate,
  PROJECT_HISTORY_HEALTH_DEFAULT,
  PROJECT_HISTORY_FAILURE_ALERT_THRESHOLD,
  runProjectHistoryRefreshAction,
  type ProjectHistoryHealthOutcome,
  type ProjectHistoryConfig,
} from './project-history-refresh-action';

const SIDESTAGE_CFG = {
  repo_root: '/home/u/.papercusp/hives/sidestage',
  output: 'apps/api/src/build-history/build-history.snapshot.ts',
  project_id: 'sidestage',
  project_name: 'SideStage',
  export_name: 'BUILD_HISTORY_SNAPSHOT',
  plan_prefix: '',
};

function ok(cfg: Record<string, unknown>): ProjectHistoryConfig {
  const r = resolveProjectHistoryConfig(cfg, 'sidestage', 'papercusp-workspace');
  if (!r.ok) throw new Error(`expected ok, got refusal: ${r.reason}`);
  return r.config;
}

describe('resolveProjectHistoryConfig', () => {
  it('resolves the SideStage row into an absolute artifact path', () => {
    const c = ok(SIDESTAGE_CFG);
    expect(c.output).toBe('/home/u/.papercusp/hives/sidestage/apps/api/src/build-history/build-history.snapshot.ts');
    expect(c.harness).toBe('sidestage');
    expect(c.workspace).toBe('papercusp-workspace');
    expect(c.format).toBe('typescript');
    expect(c.exportName).toBe('BUILD_HISTORY_SNAPSHOT');
  });

  it('REFUSES a row with no repo_root rather than guessing one', () => {
    const r = resolveProjectHistoryConfig({ output: 'a.ts' }, 'sidestage', 'ws');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/repo_root is required/);
  });

  it('REFUSES a relative repo_root — a wrong-tree write would be committed by git-sync', () => {
    const r = resolveProjectHistoryConfig({ ...SIDESTAGE_CFG, repo_root: 'hives/sidestage' }, 'sidestage', 'ws');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must be absolute/);
  });

  it('REFUSES a row with no output rather than defaulting a multi-MB write path', () => {
    const r = resolveProjectHistoryConfig({ repo_root: '/abs' }, 'sidestage', 'ws');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/output is required/);
  });

  it('REFUSES an unknown format instead of silently writing JSON into a .ts file', () => {
    const r = resolveProjectHistoryConfig({ ...SIDESTAGE_CFG, format: 'yaml' }, 'sidestage', 'ws');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must be "json" or "typescript"/);
  });

  it('infers format from the output extension when unset', () => {
    expect(ok({ repo_root: '/abs', output: 'x.ts' }).format).toBe('typescript');
    expect(ok({ repo_root: '/abs', output: 'x.json' }).format).toBe('json');
  });

  it('honours an absolute output path unchanged', () => {
    expect(ok({ repo_root: '/abs', output: '/elsewhere/h.ts' }).output).toBe('/elsewhere/h.ts');
  });

  /**
   * The CLI's own default prefix is `<harness>-`, which would silently filter the
   * archive down to prefix-matching plans. An archive that looks complete while
   * omitting most of it is the exact class of bug this whole work-item was filed for.
   */
  it('defaults plan_prefix to EMPTY, never to <harness>-', () => {
    expect(ok({ repo_root: '/abs', output: 'x.ts' }).planPrefix).toBe('');
  });

  it('defaults project id/name to the harness slug when unset', () => {
    const c = ok({ repo_root: '/abs', output: 'x.ts' });
    expect(c.projectId).toBe('sidestage');
    expect(c.projectName).toBe('sidestage');
  });
});

describe('buildProjectHistoryArgs', () => {
  it('emits the generate subcommand with every option the generator needs', () => {
    const args = buildProjectHistoryArgs(ok(SIDESTAGE_CFG));
    expect(args.slice(0, 2)).toEqual(['project-history', 'generate']);
    for (const flag of ['--workspace', '--harness', '--project-id', '--project-name', '--repo', '--output', '--format', '--export-name']) {
      expect(args).toContain(flag);
    }
  });

  /**
   * `--prefix=` must be ONE token. Passed as two (`--prefix`, ''), an argv spawn with
   * no shell would hand the option parser the NEXT flag as its value, silently
   * filtering the archive by a garbage prefix.
   */
  it('passes an empty prefix as a single --prefix= token, never as two argv entries', () => {
    const args = buildProjectHistoryArgs(ok(SIDESTAGE_CFG));
    expect(args).toContain('--prefix=');
    expect(args).not.toContain('--prefix');
  });

  it('carries a non-empty prefix in the same = form', () => {
    const args = buildProjectHistoryArgs(ok({ ...SIDESTAGE_CFG, plan_prefix: 'sidestage-' }));
    expect(args).toContain('--prefix=sidestage-');
  });
});

describe('resolveCliBin', () => {
  it('honours an explicit PAPERCUSP_CLI pin', () => {
    expect(resolveCliBin({ PAPERCUSP_CLI: '/opt/papercusp/bin/papercusp' })).toBe('/opt/papercusp/bin/papercusp');
  });

  /**
   * MEASURED, not hypothetical: the installed dispatcher at ~/.papercusp/bin/papercusp
   * is regenerated every boot and was observed to have the `project-history` route at
   * 18:2x and to be missing it (exit 2) at 19:0x the same evening. The operator
   * service's PATH does not contain that directory at all. A bare-name fallback would
   * therefore fail only sometimes, which is worse than failing always.
   */
  it('NEVER falls back to a bare PATH name — it returns an absolute in-tree path', () => {
    const resolved = resolveCliBin({ PAPERCUSP_INTEGRATION_ROOT: '/repo' });
    expect(resolved).toBe(path.join('/repo', 'libs', 'papercusp', 'packages', 'cli', 'bin', 'papercusp'));
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).not.toBe('papercusp');
  });
});

describe('resolvePtool', () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);

  it('finds ptool by scanning PATH', () => {
    expect(resolvePtool({ PATH: '/a:/b' }, exists(['/b/ptool']))).toBe('/b/ptool');
  });

  it('prefers the first PATH hit', () => {
    expect(resolvePtool({ PATH: '/a:/b' }, exists(['/a/ptool', '/b/ptool']))).toBe('/a/ptool');
  });

  it('honours an explicit PAPERCUSP_PTOOL override', () => {
    expect(resolvePtool({ PAPERCUSP_PTOOL: '/custom/ptool', PATH: '/a' }, exists(['/custom/ptool']))).toBe('/custom/ptool');
  });

  it('returns null for an override that is not executable, rather than falling back to PATH', () => {
    expect(resolvePtool({ PAPERCUSP_PTOOL: '/gone/ptool', PATH: '/a' }, exists(['/a/ptool']))).toBeNull();
  });

  /**
   * The generator shells out to a bare `ptool` for every plan/work-item read with no
   * env override of its own. A null here is what lets the action refuse BEFORE
   * spawning — the failure it prevents is a truncated-but-valid artifact overwriting
   * a good one, which no later check would catch.
   */
  it('returns null when ptool is nowhere on PATH', () => {
    expect(resolvePtool({ PATH: '/a:/b' }, exists([]))).toBeNull();
    expect(resolvePtool({ PATH: '' }, exists(['/a/ptool']))).toBeNull();
  });
});

describe('runProjectHistoryRefreshAction health bookkeeping', () => {
  const validConfig = { repo_root: '/repo', output: 'history.ts', timeout_ms: 1000 };
  const ctx = (triggerConfig: Record<string, unknown>) => ({
    installSlug: 'sidestage',
    workspaceId: 'ws',
    triggerConfig,
    payloadTemplate: null,
  });

  const preconditionCases: Array<[
    string,
    Record<string, unknown>,
    (file: string) => boolean,
    () => string,
    () => string | null,
    string,
  ]> = [
    ['misconfigured row', { output: 'history.ts' }, () => false, () => '/cli', () => '/ptool', 'repo_root is required'],
    ['missing repository', validConfig, () => false, () => '/cli', () => '/ptool', 'repo_root does not exist'],
    ['missing pinned CLI', validConfig, (file: string) => file === '/repo', () => '/cli', () => '/ptool', 'Papercusp CLI not found'],
    ['missing ptool', validConfig, () => true, () => '/cli', () => null, '`ptool` does not resolve'],
  ];

  it.each(preconditionCases)(
    'records a failed health outcome before returning for a %s precondition',
    async (_label, triggerConfig, exists, resolveCliBin, resolvePtool, expectedReason) => {
      const outcomes: ProjectHistoryHealthOutcome[] = [];
      const generate = vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await runProjectHistoryRefreshAction(ctx(triggerConfig), {
          env: { PATH: '/empty' },
          exists,
          resolveCliBin,
          resolvePtool,
          runGenerate: generate,
          recordHealth: async (_ctx, outcome) => { outcomes.push(outcome); },
        });

        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({ success: false, reason: expect.stringContaining(expectedReason) });
        expect(generate).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    },
  );

  it('records the generator result through the same health seam', async () => {
    const outcomes: ProjectHistoryHealthOutcome[] = [];
    await runProjectHistoryRefreshAction(ctx(validConfig), {
      env: { PATH: '/empty' },
      exists: () => true,
      resolveCliBin: () => '/cli',
      resolvePtool: () => '/ptool',
      runGenerate: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }),
      recordHealth: async (_ctx, outcome) => { outcomes.push(outcome); },
      now: () => 1_000,
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ success: true, code: 0, output: '/repo/history.ts' });
  });
});

describe('decideProjectHistoryHealthUpdate', () => {
  const T = PROJECT_HISTORY_FAILURE_ALERT_THRESHOLD;
  const at = Date.parse('2026-08-17T22:00:00.000Z');

  it('does not alert on the first failure — a lone failure is usually transient', () => {
    const u = decideProjectHistoryHealthUpdate(PROJECT_HISTORY_HEALTH_DEFAULT, false, T, at);
    expect(u.next.consecutiveFailures).toBe(1);
    expect(u.shouldAlert).toBe(false);
  });

  it('alerts once the streak reaches the threshold', () => {
    const one = decideProjectHistoryHealthUpdate(PROJECT_HISTORY_HEALTH_DEFAULT, false, T, at).next;
    const two = decideProjectHistoryHealthUpdate(one, false, T, at);
    expect(two.next.consecutiveFailures).toBe(T);
    expect(two.shouldAlert).toBe(true);
    expect(two.next.alerted).toBe(true);
  });

  it('LATCHES the alert so a long outage raises one notification, not one per tick', () => {
    let h = PROJECT_HISTORY_HEALTH_DEFAULT;
    let alerts = 0;
    for (let i = 0; i < 10; i += 1) {
      const u = decideProjectHistoryHealthUpdate(h, false, T, at);
      if (u.shouldAlert) alerts += 1;
      h = u.next;
    }
    expect(alerts).toBe(1);
    expect(h.consecutiveFailures).toBe(10);
  });

  it('clears the streak and the latch on success, so a later outage can alert again', () => {
    let h = decideProjectHistoryHealthUpdate(PROJECT_HISTORY_HEALTH_DEFAULT, false, T, at).next;
    h = decideProjectHistoryHealthUpdate(h, false, T, at).next;
    expect(h.alerted).toBe(true);

    const recovered = decideProjectHistoryHealthUpdate(h, true, T, at);
    expect(recovered.shouldResolve).toBe(true);
    expect(recovered.next.consecutiveFailures).toBe(0);
    expect(recovered.next.alerted).toBe(false);
    expect(recovered.next.lastOkAt).toBe(new Date(at).toISOString());

    let again = decideProjectHistoryHealthUpdate(recovered.next, false, T, at).next;
    const second = decideProjectHistoryHealthUpdate(again, false, T, at);
    expect(second.shouldAlert).toBe(true);
  });

  it('does not report a resolve when nothing was broken', () => {
    expect(decideProjectHistoryHealthUpdate(PROJECT_HISTORY_HEALTH_DEFAULT, true, T, at).shouldResolve).toBe(false);
  });
});
