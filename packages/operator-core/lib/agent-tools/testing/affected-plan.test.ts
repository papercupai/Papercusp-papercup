import { describe, expect, it } from 'vitest';

import { parseAffectedProbe } from '../../release/sync-batch-delta-check';
import {
  AFFECTED_PLAN_MAX_ROWS,
  deriveAffectedPlan,
  planNote,
  type AffectedPlanExec,
} from './affected-plan';

/**
 * Captured VERBATIM from a real run on 2026-09-02:
 *   node scripts/affected-tests.mjs \
 *     --changed-paths apps/operator/scripts/psu-launcher.mjs,packages/operator-core/lib/adv-sessions.ts \
 *     --print-affected
 * Trimmed to a representative subset. The non-AFFECTED_* preamble lines are kept on
 * purpose: the parser must ignore them, and they are exactly what a naive
 * `split('\n')`-and-take-everything would swallow.
 */
const REAL_PROBE_OUTPUT = [
  'Full run log: /tmp/pcv/papercusp-affected-tests/1525523-b40e208b.log',
  'AFFECTED_BASE_SOURCE ref=refs/papercusp/test-certified sha=1f43e05ae7a8 (test-certified watermark)',
  'AFFECTED_DERIVATION source=explicit changedPaths=2 workspaces=6 guards=19 tasks=27 runStartHead=0a5de631b680727d4806854648247175da8fea2f',
  'AFFECTED_WS\t@papercusp/web',
  'AFFECTED_WS\t@papercusp/operator-core',
  'AFFECTED_WS_CMD\t@papercusp/web\tnpm run --silent --workspace apps/operator test',
  'AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test:lane-pure',
  'AFFECTED_WS_CMD\t@papercusp/operator-core\tnpm run --silent --workspace packages/operator-core test:lane-stateful',
  'AFFECTED_GUARD\t@papercusp/operator-core\tlint:dependency-integrity',
].join('\n');

function execReturning(stdout: string, opts: { err?: Error & { code?: number }; stderr?: string } = {}) {
  const calls: { file: string; args: readonly string[]; cwd: string }[] = [];
  const exec: AffectedPlanExec = (file, args, options, callback) => {
    calls.push({ file, args, cwd: options.cwd });
    callback(opts.err ?? null, stdout, opts.stderr ?? '');
  };
  return { exec, calls };
}

describe('parseAffectedProbe — the AFFECTED_WS_CMD / AFFECTED_DERIVATION extension', () => {
  it('does not fold AFFECTED_WS_CMD lines into the workspace set', () => {
    const probe = parseAffectedProbe(REAL_PROBE_OUTPUT);
    // The whole point of the ordering guard in the parser. If AFFECTED_WS were matched
    // first with a loose pattern, the three _CMD lines would land here too and every
    // caller counting "affected workspaces" would silently over-report by the number of
    // TASKS — the corruption green-checkpoint.ts warns about where it parses AFFECTED_WS
    // into its own Set.
    expect(probe.workspaces).toEqual(['@papercusp/web', '@papercusp/operator-core']);
  });

  it('CONTROL: the mis-ordered parser really does corrupt the workspace set', () => {
    // Falsifiability control, kept permanently rather than run as a one-off mutation:
    // the repo's guidance for a MODULE subject is to hold a deliberately-wrong
    // implementation beside the real one, never to mutate the shared tree (git-sync
    // sweeps every few minutes and would commit the mutant).
    //
    // This is the wrong order — AFFECTED_WS matched with a loose `(.+)` BEFORE
    // AFFECTED_WS_CMD. If it produced the same answer as the real parser, the ordering
    // guard above would be vacuous and would pass no matter how the parser regressed.
    const misOrdered = (stdout: string): string[] => {
      const workspaces: string[] = [];
      for (const line of stdout.split('\n')) {
        const ws = /^AFFECTED_WS.*\t(.+)$/.exec(line);
        if (ws?.[1]) workspaces.push(ws[1].trim());
      }
      return workspaces;
    };
    const corrupted = misOrdered(REAL_PROBE_OUTPUT);
    const correct = parseAffectedProbe(REAL_PROBE_OUTPUT).workspaces;

    // The control must actually diverge — and in the specific direction that matters:
    // it swallows task COMMANDS as if they were workspace names.
    expect(corrupted).not.toEqual(correct);
    expect(corrupted.length).toBeGreaterThan(correct.length);
    expect(corrupted).toContain('npm run --silent --workspace apps/operator test');
    expect(correct).not.toContain('npm run --silent --workspace apps/operator test');

    // CALIBRATION: the control and the real parser must still agree on a probe with no
    // _CMD lines at all. Without this, a control that was simply broken in some other
    // way would also "diverge" and the assertions above would prove nothing.
    const noCmdLines = ['AFFECTED_WS\t@papercusp/web', 'AFFECTED_GUARD\t@papercusp/web\tlint:x'].join('\n');
    expect(misOrdered(noCmdLines)).toEqual(parseAffectedProbe(noCmdLines).workspaces);
  });

  it('keeps each task command whole, with its workspace', () => {
    const probe = parseAffectedProbe(REAL_PROBE_OUTPUT);
    expect(probe.taskCommands).toEqual([
      { workspace: '@papercusp/web', command: 'npm run --silent --workspace apps/operator test' },
      {
        workspace: '@papercusp/operator-core',
        command: 'npm run --silent --workspace packages/operator-core test:lane-pure',
      },
      {
        workspace: '@papercusp/operator-core',
        command: 'npm run --silent --workspace packages/operator-core test:lane-stateful',
      },
    ]);
  });

  it('records that tasks outnumber workspaces — the understatement this exists to surface', () => {
    const probe = parseAffectedProbe(REAL_PROBE_OUTPUT);
    expect(probe.taskCommands.length).toBeGreaterThan(probe.workspaces.length);
    // operator-core alone contributes more than one task.
    const operatorCoreTasks = probe.taskCommands.filter((t) => t.workspace === '@papercusp/operator-core');
    expect(operatorCoreTasks.length).toBe(2);
  });

  it('parses the derivation source and its numeric counts', () => {
    const probe = parseAffectedProbe(REAL_PROBE_OUTPUT);
    expect(probe.derivation?.source).toBe('explicit');
    expect(probe.derivation?.counts).toEqual({ changedPaths: 2, workspaces: 6, guards: 19, tasks: 27 });
  });

  it('does NOT coerce runStartHead into the counts map', () => {
    // Number('0a5de631…') is NaN. A NaN sitting in a counts map reads as a measurement
    // that FAILED rather than a field that was never a count — the exact misreading the
    // numeric guard prevents.
    const probe = parseAffectedProbe(REAL_PROBE_OUTPUT);
    expect(probe.derivation?.counts).not.toHaveProperty('runStartHead');
    expect(Object.values(probe.derivation?.counts ?? {}).some(Number.isNaN)).toBe(false);
  });

  it('still returns the narrow RadiusProbe fields the release lane consumes', () => {
    // The extension is additive; sync-batch-delta-check's callers must be untouched.
    const probe = parseAffectedProbe(REAL_PROBE_OUTPUT);
    expect(probe.guards).toEqual(['@papercusp/operator-core:lint:dependency-integrity']);
  });

  it('treats a selection of nothing as a real answer, not a parse failure', () => {
    const probe = parseAffectedProbe('AFFECTED_DERIVATION source=explicit changedPaths=1 workspaces=0 tasks=0\n');
    expect(probe.workspaces).toEqual([]);
    expect(probe.taskCommands).toEqual([]);
    expect(probe.derivation?.counts.workspaces).toBe(0);
  });
});

describe('deriveAffectedPlan', () => {
  it('passes the changed paths as ONE comma-joined argument', async () => {
    // affected-tests.mjs accepts flags only and ABORTS on positional paths
    // (EI-22026635212798684), so `--changed-paths a b c` does not narrow the run — it
    // fails it. This assertion is the reason the exec seam is injectable at all.
    const { exec, calls } = execReturning(REAL_PROBE_OUTPUT);
    await deriveAffectedPlan({ changedPaths: ['a/one.ts', 'b/two.ts'], root: '/repo', execFileImpl: exec });
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const flagIndex = args.indexOf('--changed-paths');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe('a/one.ts,b/two.ts');
    expect(args).toContain('--print-affected');
    // ...and nothing positional slipped in beside it.
    expect(args.filter((a) => a === 'a/one.ts' || a === 'b/two.ts')).toEqual([]);
  });

  it('returns mode:"plan" and carries no pass/fail counts', async () => {
    const { exec } = execReturning(REAL_PROBE_OUTPUT);
    const plan = await deriveAffectedPlan({ changedPaths: ['a/one.ts'], root: '/repo', execFileImpl: exec });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe('plan');
    expect(plan).not.toHaveProperty('passed');
    expect(plan).not.toHaveProperty('failed');
    expect(plan.note).toContain('NOTHING RAN');
  });

  it('reports counts from the parsed rows', async () => {
    const { exec } = execReturning(REAL_PROBE_OUTPUT);
    const plan = await deriveAffectedPlan({ changedPaths: ['a/one.ts'], root: '/repo', execFileImpl: exec });
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.counts).toEqual({ workspaces: 2, tasks: 3, guards: 1 });
    expect(plan.truncated).toEqual({ taskCommands: 0, guards: 0 });
  });

  it('keeps counts COMPLETE when the returned rows are capped', async () => {
    const many = [
      'AFFECTED_DERIVATION source=explicit changedPaths=1',
      ...Array.from(
        { length: AFFECTED_PLAN_MAX_ROWS + 7 },
        (_, i) => `AFFECTED_WS_CMD\t@ws/${i}\tnpm run --silent --workspace w${i} test`,
      ),
    ].join('\n');
    const { exec } = execReturning(many);
    const plan = await deriveAffectedPlan({ changedPaths: ['a/one.ts'], root: '/repo', execFileImpl: exec });
    if (!plan.ok) throw new Error('expected a plan');
    // A truncated LIST must never read as a smaller radius.
    expect(plan.taskCommands).toHaveLength(AFFECTED_PLAN_MAX_ROWS);
    expect(plan.counts.tasks).toBe(AFFECTED_PLAN_MAX_ROWS + 7);
    expect(plan.truncated.taskCommands).toBe(7);
  });

  it('reports a failed probe as a probe fault, never as an empty affected set', async () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 127 });
    const { exec } = execReturning('', { err, stderr: 'no such file' });
    const plan = await deriveAffectedPlan({ changedPaths: ['a/one.ts'], root: '/repo', execFileImpl: exec });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe('probe_failed');
    expect(plan.exitCode).toBe(127);
    // The dangerous misreading is "the probe returned nothing, so nothing is affected".
    expect(plan.detail).toContain('NOT evidence that the affected set is empty');
  });

  it('WI-6554700010029567: a clean exit with NO derivation banner is undetermined, never an empty plan', async () => {
    // Observed live 2026-10-26: exit 0, no AFFECTED_DERIVATION line, and the tool answered
    // `workspaces: []` + "a real and common answer, NOT a failed probe" for six code paths
    // that select 9 workspaces / 48 tasks. A caller reading that skips verification.
    const { exec } = execReturning('Full run log: /tmp/pcv/papercusp-affected-tests/x.log\n', {
      stderr: 'AFFECTED_TESTS_ABORT reason=exit-without-verdict code=0',
    });
    const plan = await deriveAffectedPlan({ changedPaths: ['a/one.ts'], root: '/repo', execFileImpl: exec });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toBe('probe_failed');
    expect(plan.exitCode).toBe(0);
    expect(plan.detail).toContain('no AFFECTED_DERIVATION banner');
    expect(plan.detail).toContain('UNDETERMINED');
    expect(plan.stderrTail).toContain('exit-without-verdict');
  });

  it('CONTROL: a banner-carrying EMPTY selection is still a real plan, not a probe failure', async () => {
    const { exec } = execReturning('AFFECTED_DERIVATION source=explicit changedPaths=1 workspaces=0 guards=0 tasks=0\n');
    const plan = await deriveAffectedPlan({ changedPaths: ['docs/x.md'], root: '/repo', execFileImpl: exec });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.counts).toEqual({ workspaces: 0, tasks: 0, guards: 0 });
    expect(plan.note).toContain('real and common answer');
  });
});

describe('planNote', () => {
  it('leads with NOTHING RAN in both the populated and the empty case', () => {
    expect(planNote(6, 27)).toMatch(/^NOTHING RAN/);
    expect(planNote(0, 0)).toMatch(/^NOTHING RAN/);
  });

  it('says an empty selection is a real answer rather than a failure', () => {
    expect(planNote(0, 0)).toContain('real and common answer');
  });

  it('warns against rebuilding a command from a workspace name', () => {
    // Root CLAUDE.md: `npm run --workspace <name> test` exits 1 having measured ZERO
    // tests for a standalone submodule, which is indistinguishable from a failing suite.
    expect(planNote(6, 27)).toContain('VERBATIM');
    expect(planNote(6, 27)).toContain('--prefix');
  });

  it('shows changed paths as one comma-delimited argument', () => {
    const note = planNote(6, 27);
    expect(note).toContain('--changed-paths=path/to/first.ts,path/to/second.ts');
    expect(note).toContain('one comma-delimited argument');
  });
});
