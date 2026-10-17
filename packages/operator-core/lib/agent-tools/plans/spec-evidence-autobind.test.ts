import { describe, expect, it } from 'vitest';
import {
  AUTOBIND_ACTOR_ID,
  clauseKey,
  decideAutobind,
  requirementTestFiles,
  runKey,
  runSpecEvidenceAutobind,
  type AutobindDeps,
  type AutobindLedgerRun,
  type AutobindLiveBinding,
  type AutobindTarget,
} from './spec-evidence-autobind';

const TEST = 'packages/operator-core/lib/agent-tools/plans/example.test.ts';
const SOURCE = 'packages/operator-core/lib/agent-tools/plans/example.ts';

const target: AutobindTarget = {
  workspaceId: 'ws',
  harnessSlug: 'papercusp',
  planSlug: 'plan-a',
  specId: 'AUTO-BAR-R-2-P-002',
  specRevision: 2,
  workItemId: 'WI-1',
  barKey: 'R-2',
  testFile: TEST,
};

const run = (id: number, status: AutobindLedgerRun['status'], finishedAt = `2026-10-15T17:${String(id % 60).padStart(2, '0')}:00.000Z`) =>
  ({ id, filePath: TEST, status, finishedAt, commitSha: 'a'.repeat(40), worktreeDirty: false }) satisfies AutobindLedgerRun;

const binding = (id: number, testRunId: number | null, observedAt = '2026-10-15T17:00:00.000Z', evidenceRef = TEST) =>
  ({ id, evidenceRef, testRunId, observedAt }) satisfies AutobindLiveBinding;

/** A ledger + store fixture behind the injected seams; records every write. */
function fixture(opts: {
  runs?: AutobindLedgerRun[];
  live?: AutobindLiveBinding[];
  targets?: AutobindTarget[];
  dirty?: string[];
  refuse?: { error: string; message: string };
}) {
  const writes: Array<{ op: 'bind'; runId: number } | { op: 'retract'; bindingId: number; reason: string }> = [];
  const targets = opts.targets ?? [target];
  const deps: AutobindDeps = {
    loadTargets: async () => targets,
    async loadLatestRuns() {
      const latest = new Map<string, AutobindLedgerRun>();
      for (const r of [...(opts.runs ?? [])].sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.id - b.id)) {
        latest.set(runKey('papercusp', r.filePath), r);
      }
      return latest;
    },
    loadLiveBindings: async () => new Map(targets.map((t) => [clauseKey(t), opts.live ?? []])),
    measuredPaths: async () => (opts.refuse ? { ok: false, ...opts.refuse } : { ok: true, root: '/repo', paths: [SOURCE, TEST] }),
    uncommittedPaths: async (_root, paths) => paths.filter((p) => opts.dirty?.includes(p)),
    async bind(_t, r) {
      writes.push({ op: 'bind', runId: r.id });
      return { ok: true };
    },
    async retract(_t, bindingId, reason) {
      writes.push({ op: 'retract', bindingId, reason });
    },
  };
  return { deps, writes };
}

describe('decideAutobind', () => {
  it('binds the latest passing run of an unbound file', () => {
    expect(decideAutobind(target, run(10, 'pass'), [])).toEqual({ kind: 'bind', target, run: run(10, 'pass') });
  });
  it('is a no-op when that run is already bound', () => {
    expect(decideAutobind(target, run(10, 'pass'), [binding(1, 10)])).toMatchObject({ kind: 'noop', reason: 'already-bound' });
  });
  it('rebinds when a newer pass lands over an older bound run', () => {
    expect(decideAutobind(target, run(11, 'pass'), [binding(1, 10)])).toMatchObject({ kind: 'bind', run: { id: 11 } });
  });
  it('does not backfill an older pass over newer bound proof', () => {
    expect(decideAutobind(target, run(10, 'pass'), [binding(1, 11)]))
      .toMatchObject({ kind: 'noop', reason: 'newer-proof-bound' });
  });
  it('retracts proof older than a later failing run, including a hand-bound row without a run id', () => {
    const failed = run(12, 'fail', '2026-10-15T18:00:00.000Z');
    const decision = decideAutobind(target, failed, [binding(1, 10), binding(2, null, '2026-10-15T17:30:00.000Z')]);
    expect(decision).toEqual({ kind: 'retract', target, run: failed, bindingIds: [1, 2] });
  });
  it('treats an error run like a failure', () => {
    expect(decideAutobind(target, run(12, 'error'), [binding(1, 10)])).toMatchObject({ kind: 'retract', bindingIds: [1] });
  });
  it('does not retract a binding newer than the failure', () => {
    expect(decideAutobind(target, run(12, 'fail'), [binding(1, 13)])).toMatchObject({ kind: 'noop', reason: 'nothing-to-retract' });
  });
  it('is a no-op with no terminal run on the ledger', () => {
    expect(decideAutobind(target, null, [])).toMatchObject({ kind: 'noop', reason: 'no-terminal-run' });
  });
  it.each([
    { worktreeDirty: true }, { worktreeDirty: null }, { commitSha: null }, { commitSha: 'not-a-commit' },
  ])('refuses a passing run without clean commit provenance: %j', (provenance) => {
    expect(decideAutobind(target, { ...run(10, 'pass'), ...provenance }, []))
      .toMatchObject({ kind: 'noop', reason: 'run-not-committed' });
  });
  it('still invalidates older proof after a dirty failing run', () => {
    expect(decideAutobind(target, { ...run(12, 'fail'), worktreeDirty: true }, [binding(1, 10)]))
      .toMatchObject({ kind: 'retract', bindingIds: [1] });
  });
});

describe('runSpecEvidenceAutobind over fixture ledger rows', () => {
  it('produces a binding from a qualifying pass without any agent call', async () => {
    const { deps, writes } = fixture({ runs: [run(9, 'fail'), run(10, 'pass')] });
    const result = await runSpecEvidenceAutobind('ws', deps);
    expect(writes).toEqual([{ op: 'bind', runId: 10 }]);
    expect(result.outcomes).toEqual([{ kind: 'bound', target, runId: 10 }]);
  });

  it('never binds from a run that predates the code', async () => {
    const { deps, writes } = fixture({
      runs: [run(10, 'pass')],
      refuse: { error: 'test_run_source_modified_after_run', message: 'example.ts was modified after the run started' },
    });
    const result = await runSpecEvidenceAutobind('ws', deps);
    expect(writes).toEqual([]);
    expect(result.outcomes).toMatchObject([{ kind: 'refused', error: 'test_run_source_modified_after_run', runId: 10 }]);
  });

  it('defers while a measured path is uncommitted, then binds once it is committed', async () => {
    const first = fixture({ runs: [run(10, 'pass')], dirty: [SOURCE] });
    const deferred = await runSpecEvidenceAutobind('ws', first.deps);
    expect(first.writes).toEqual([]);
    expect(deferred.outcomes).toMatchObject([{ kind: 'deferred', reason: 'code-not-committed', paths: [SOURCE] }]);

    const second = fixture({ runs: [run(10, 'pass')] });
    await runSpecEvidenceAutobind('ws', second.deps);
    expect(second.writes).toEqual([{ op: 'bind', runId: 10 }]);
  });

  it('does not leave proof current after a later failing run', async () => {
    const { deps, writes } = fixture({ runs: [run(10, 'pass'), run(11, 'fail')], live: [binding(7, 10)] });
    const result = await runSpecEvidenceAutobind('ws', deps);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ op: 'retract', bindingId: 7 });
    expect((writes[0] as { reason: string }).reason).toContain('test-run 11');
    expect((writes[0] as { reason: string }).reason).toContain(AUTOBIND_ACTOR_ID);
    expect(result.outcomes).toMatchObject([{ kind: 'retracted', runId: 11, bindingIds: [7] }]);
  });

  it('is idempotent: a second tick over the same ledger writes nothing', async () => {
    const { deps, writes } = fixture({ runs: [run(10, 'pass')], live: [binding(7, 10)] });
    const result = await runSpecEvidenceAutobind('ws', deps);
    expect(writes).toEqual([]);
    expect(result.decisions).toEqual({ noop: 1, bind: 0, retract: 0 });
  });

  it.each([10, 11])('rechecks live proof before appending a stale sweep snapshot (run %i)', async (newRunId) => {
    const { deps, writes } = fixture({ runs: [run(10, 'pass')] });
    let reads = 0;
    deps.loadLiveBindings = async () => new Map([[clauseKey(target), ++reads === 1 ? [] : [binding(7, newRunId)]]]);
    const result = await runSpecEvidenceAutobind('ws', deps);
    expect(reads).toBe(2);
    expect(writes).toEqual([]);
    expect(result.outcomes).toEqual([]);
    expect(result.decisions).toEqual({ noop: 1, bind: 0, retract: 0 });
  });

  it('ignores a live binding for a different test file of the same clause', async () => {
    const { deps, writes } = fixture({ runs: [run(10, 'pass')], live: [binding(7, 10, '2026-10-15T17:00:00.000Z', 'other.test.ts')] });
    await runSpecEvidenceAutobind('ws', deps);
    expect(writes).toEqual([{ op: 'bind', runId: 10 }]);
  });

  it('bounds the writes per tick and says so on the result', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...target, specId: `AUTO-BAR-R-${i}-P-00${i}` }));
    const { deps, writes } = fixture({ runs: [run(10, 'pass')], targets: many });
    const result = await runSpecEvidenceAutobind('ws', deps, 2);
    expect(writes).toHaveLength(2);
    expect(result.truncatedByLimit).toBe(true);
    expect(result.decisions.bind).toBe(3);
  });
});

describe('requirementTestFiles', () => {
  const block = (key: string, check: unknown) =>
    `**${key} — Title.**\n\n\`\`\`requirement\n${JSON.stringify({
      intent: { request: 'Do the thing.', sourceRefs: ['owner-directive:1'] },
      acceptance: { condition: 'It happens.', falsifier: 'It does not.', evidencePlane: 'tree', requiredScope: ['P-001'], requiredTestLayers: ['unit'] },
      verification: { method: 'Run it.', check },
    })}\n\`\`\`\n`;

  it('reads named test files from the live requirement blocks and skips non-test checks', () => {
    const content = [
      '# Plan',
      '',
      '## Requirements',
      '',
      block('R-1', { kind: 'tests', files: [TEST, `./${TEST}`] }),
      block('R-2', { kind: 'instrument', instrumentKey: 'none' }),
      '',
      '## Design',
      '',
      'x',
    ].join('\n');
    const files = requirementTestFiles(content);
    expect(files.get('R-1')).toEqual([TEST]);
    expect(files.has('R-2')).toBe(false);
  });

  it('returns nothing for a plan without requirements', () => {
    expect(requirementTestFiles('# Plan\n\nno requirements here').size).toBe(0);
  });
});
