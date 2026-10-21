import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { buildTaskBrief, getClaimTimeTaskBrief, getIntentTimeTaskBrief, getCompletionTimeBrief, taskIncidentBrief, TASK_BRIEF_BUDGET_MS, TASK_BRIEF_MAX_CHARS, type TaskBriefDeps } from './task-brief';
import { nativeChangeReport, type ChangeReportRequest } from './packer-facade';
import { firstPartyCallers } from './first-party-callers';
import type { CodeIntelAnswer } from './contracts';

const dirs: string[] = [];
describe('P039 completion pre-review briefs', () => {
  const ref = (paths = ['target.ts']) => ({ workspaceId: 'w', harness: 'h', paths });
  const setup = () => {
    const root = fixture();
    writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    writeFileSync(join(root, 'target.test.ts'), 'import { target } from "./target"; target();');
    const report: typeof nativeChangeReport = (args, subject) => nativeChangeReport(args, subject, {
      exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => 'fixture-artifact',
      graph: async () => firstPartyCallers({ ts, root, name: subject.symbol, filePath: subject.file,
        op: 'impact', direction: 'downstream', paths: ['.'], includeInterfaces: true }),
    });
    return { root, report, rootResolver: async () => root };
  };
  it('uses actual compiler test reach and flags missing bound execution without trusting prose', async () => {
    const { report, rootResolver } = setup();
    const brief = await getCompletionTimeBrief(ref(), { root: rootResolver, report, runs: async () => [] });
    expect(brief.status).toBe('measured'); expect(brief.phase).toBe('pre-review');
    expect(brief.changes).toEqual([expect.objectContaining({ file: 'target.ts', symbol: 'target' })]);
    expect(brief.testsWithoutRunEvidence).toContain('target.test.ts');
    expect(brief.executionCoverage).toBe('unmeasured');
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    const recorded = await getCompletionTimeBrief(ref(), { root: rootResolver, report,
      runs: async () => [{ path: 'target.test.ts', status: 'pass', runGroupId: 'bound-run' }] });
    expect(recorded.tests).toContainEqual({ path: 'target.test.ts', execution: 'recorded', status: 'pass', runGroupId: 'bound-run' });
    expect(recorded.testsWithoutRunEvidence).toEqual([]);
    expect(recorded.executionCoverage).toBe('unmeasured');
  });
  it('keeps unavailable ledger evidence unknown and excludes skipped tests from recorded execution', async () => {
    const { report, rootResolver } = setup();
    const unknown = await getCompletionTimeBrief(ref(), { root: rootResolver, report, runs: async () => null });
    expect(unknown.testsWithoutRunEvidence).toBeNull(); expect(unknown.tests[0]?.execution).toBe('unknown');
    const skipped = await getCompletionTimeBrief(ref(), { root: rootResolver, report,
      runs: async () => [{ path: 'target.test.ts', status: 'skip', runGroupId: 'bound-run' }] });
    expect(skipped.testsWithoutRunEvidence).toContain('target.test.ts');
  });
  it('invalidates consequences when the source changes during the ledger read', async () => {
    const { root, report, rootResolver } = setup();
    const result = await getCompletionTimeBrief(ref(), { root: rootResolver, report, runs: async () => {
      writeFileSync(join(root, 'target.ts'), 'export function target() { return 2; }'); return [];
    } });
    expect(result).toMatchObject({ status: 'unknown', changes: [], tests: [], testsWithoutRunEvidence: null });
  });
  it('gives the default compiler report the remaining brief deadline, not a fixed 2000 ms sub-budget', async () => {
    const { rootResolver } = setup();
    // Honour the budget the way the off-thread worker does: a fresh worker under host load
    // measured 1048-2598 ms, so a 2000 ms budget expires before the answer arrives.
    const graph = vi.fn(async (request: ChangeReportRequest, graphRoot: string, budgetMs: number) => budgetMs < 2_100
      ? { ...firstPartyCallers({ ts, root: graphRoot, name: request.symbol, filePath: request.file, op: 'impact',
        direction: 'downstream', paths: ['.'], includeInterfaces: true }),
        error: `the callers worker exceeded its ${budgetMs} ms deadline and was killed`, evidence: undefined }
      : firstPartyCallers({ ts, root: graphRoot, name: request.symbol, filePath: request.file, op: 'impact',
        direction: 'downstream', paths: ['.'], includeInterfaces: true }));
    const brief = await getCompletionTimeBrief(ref(), { root: rootResolver, graph, runs: async () => [],
      effects: { exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => 'fixture-artifact' } });
    expect(graph.mock.calls[0]![2]).toBeGreaterThan(2_000);
    expect(graph.mock.calls[0]![2]).toBeLessThan(TASK_BRIEF_BUDGET_MS);
    expect(brief).toMatchObject({ status: 'measured', changes: [expect.objectContaining({ file: 'target.ts', symbol: 'target' })] });
  });
  it('names why compiler evidence was unmeasured instead of returning a causeless unknown', async () => {
    const { root, rootResolver } = setup();
    const expired = 'the callers worker exceeded its 2000 ms deadline and was killed';
    const report: typeof nativeChangeReport = (args, subject) => nativeChangeReport(args, subject, {
      exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => 'fixture-artifact',
      graph: async () => ({ ...firstPartyCallers({ ts, root, name: subject.symbol, filePath: subject.file,
        op: 'impact', direction: 'downstream', paths: ['.'], includeInterfaces: true }), error: expired, evidence: undefined }),
    });
    const brief = await getCompletionTimeBrief(ref(), { root: rootResolver, report, runs: async () => [] });
    expect(brief).toMatchObject({ status: 'unknown', changes: [] });
    expect(brief.scope.processed).toEqual(['target.ts']);
    expect(brief.limitations).toContainEqual(expect.stringContaining(`Compiler evidence was unmeasured for target.ts#target: ${expired}`));
  });
  it('never analyzes an escaping source or an unbounded path population', async () => {
    const { root, report, rootResolver } = setup(); const outside = fixture();
    writeFileSync(join(outside, 'private.ts'), 'export function privateSource() {}');
    symlinkSync(join(outside, 'private.ts'), join(root, 'escape.ts'));
    const spy = vi.fn(report);
    const result = await getCompletionTimeBrief(ref(['escape.ts', '../private.ts']), { root: rootResolver, report: spy });
    expect(result.status).toBe('unknown'); expect(spy).not.toHaveBeenCalled();
    const bounded = await getCompletionTimeBrief(ref(Array.from({ length: 40 }, (_, i) => `${'x'.repeat(210)}${i}.ts`)),
      { root: async () => null, report: spy });
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
});
describe('P018 scoped incident hypotheses', () => {
  it('keeps observed failures and static candidates distinct from proven causation', () => {
    const failures = [{ testRunId: 42, path: 'target.test.ts', status: 'fail' as const, commit: 'a'.repeat(40), logSha256: 'b'.repeat(64) }];
    const input = { workItemId: 'WI-task', harness: 'h', paths: ['target.test.ts', 'consumer.ts'], failures,
      consumers: ['consumer.ts:2', 'outside.ts:3'], recentChanges: ['c'.repeat(40), 'untrusted'] };
    const original = structuredClone(input), brief = taskIncidentBrief(input);
    expect(brief).toMatchObject({ status: 'measured', cause: 'unknown', runtimeExecution: 'unmeasured', workRecord: 'WI-task',
      failures, candidates: [{ path: 'target.test.ts', basis: 'failed-test', causation: 'unverified' },
        { path: 'consumer.ts', basis: 'static-relationship', causation: 'unverified' }], recentChanges: ['c'.repeat(40)] });
    expect(brief.recover).toEqual({ tool: 'testing:runs', args: { testRunIds: [42], harness: 'h' } }); expect(input).toEqual(original);
    expect(JSON.stringify(brief)).not.toContain('outside.ts');
  });
  it('does not turn a missing ledger read or an out-of-scope error into a cause', () => {
    const scope = { workItemId: 'WI-task', harness: 'h', paths: ['target.ts'], consumers: ['target.ts:1'], recentChanges: [] };
    expect(taskIncidentBrief({ ...scope, failures: null })).toMatchObject({ status: 'unknown', cause: 'unknown', candidates: [] });
    expect(taskIncidentBrief({ ...scope, failures: null }).recover).toEqual({ tool: 'work_items:get', args: { id: 'WI-task', harness: 'h' } });
    expect(taskIncidentBrief({ ...scope, failures: [{ testRunId: 7, path: '../outside.test.ts', status: 'error', commit: null, logSha256: null }] }))
      .toMatchObject({ status: 'measured', cause: 'unknown', failures: [], candidates: [] });
  });
  it('keeps the exact registered test scope and a stalled optional ledger read bounded', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    writeFileSync(join(root, 'target.test.ts'), 'import { target } from "./target"; target();');
    const deps = depsFor(root); deps.failures = vi.fn(() => new Promise<never>(() => {}));
    const brief = await buildTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
      payload: { rootPath: '/untrusted', paths: ['target.ts', 'target.test.ts'] } } }, deps);
    expect(deps.failures).toHaveBeenCalledWith({ workspaceId: 'w', harness: 'h', root, paths: ['target.test.ts'] });
    expect(brief.status).toBe('current'); expect(brief.incident).toMatchObject({ status: 'unknown', cause: 'unknown' });
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
  it('rejects a source edit during the incident read before publishing a current brief', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root); deps.failures = async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
      writeFileSync(join(root, 'target.ts'), 'export function target() { return 2; }');
      return [];
    };
    const brief = await buildTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
      payload: { paths: ['target.ts'] } } }, deps);
    expect(brief).toMatchObject({ status: 'unknown', sourceFingerprint: null, files: [] });
    expect(brief.incident).toBeUndefined();
  });
});
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'task-brief-')); dirs.push(dir); return dir; };
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const answer = (paths: string[]): CodeIntelAnswer => ({ backend: 'repomix', intent: 'pack', query: 'fixture',
  sites: paths.map(path => ({ path, line1: null, kind: 'file', detail: null })),
  truncation: { truncated: false, totalAvailable: null, continuation: null },
  freshness: { health: 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null }, latencyMs: 0, error: null });
function depsFor(root: string): TaskBriefDeps {
  return { root: vi.fn(async () => root), effects: { exec: vi.fn(async () => ({ stdout: '' })),
    now: () => new Date(), writeArtifact: vi.fn(async () => '') },
    graph: vi.fn(async () => ({ ...answer([]), error: 'not configured' })),
    pack: vi.fn(async (_op, args) => {
      const { readFileSync } = await import('node:fs');
      const path = join(root, 'pack.xml');
      writeFileSync(path, args.include.map((p: string) => `<file path="${p}">${readFileSync(join(root, p), 'utf8')}</file>`).join('\n'));
      return { answer: answer([...args.include]), artifact: { path, preview: '', provenance: { commit: 'fixture-pin' } as never } };
    }),
  };
}
describe('P012 bounded scoped task briefs', () => {
  it('captures explicit no-claim intent scope without inventing a work-item identity', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "INTENT_SOURCE"; }');
    const deps = depsFor(root); deps.hasClaim = vi.fn(async () => false); deps.failures = vi.fn(async () => []);
    const ref = { owner: 'su-intent', workspaceId: 'w', harness: 'h', intent: 'Inspect target', paths: ['target.ts'] };
    const first = (await getIntentTimeTaskBrief(ref, deps))!.taskBrief;
    expect(first.status).toBe('current'); expect(first.files[0]?.path).toBe('target.ts');
    expect(JSON.stringify(first.excerpts)).toContain('INTENT_SOURCE'); expect(first.incident).toBeUndefined();
    expect(deps.failures).not.toHaveBeenCalled(); expect(first.recover.tool).toBe('code:pack');
    const next = (await getIntentTimeTaskBrief({ ...ref, intent: 'Change target' }, deps))!.taskBrief;
    expect(next.intent?.fingerprint).not.toBe(first.intent?.fingerprint);
    expect(next.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
  it('suppresses no-claim briefs for held or unreadable ownership and refuses unsafe transient paths', async () => {
    const deps = depsFor(fixture()); deps.hasClaim = vi.fn(async () => true);
    const ref = { owner: 'su-intent', workspaceId: 'w', harness: 'h', intent: 'Inspect target', paths: ['target.ts'] };
    expect(await getIntentTimeTaskBrief(ref, deps)).toBeNull();
    deps.hasClaim = async () => { throw new Error('unavailable'); };
    expect(await getIntentTimeTaskBrief(ref, deps)).toBeNull(); expect(deps.root).not.toHaveBeenCalled();
    deps.hasClaim = async () => false;
    const result = await getIntentTimeTaskBrief({ ...ref, paths: ['../private.ts', '.env', '**/*'] }, deps);
    expect(result?.taskBrief.status).toBe('unknown'); expect(deps.pack).not.toHaveBeenCalled();
    expect(result?.taskBrief.recover.tool).toBe('coord:declare-intent');
  });
  it('does not infer a root or search when stored task scope is missing', async () => {
    const deps = depsFor(fixture());
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h' }, workspaceId: 'w' }, deps);
    expect(brief.status).toBe('unknown'); expect(deps.root).not.toHaveBeenCalled(); expect(deps.pack).not.toHaveBeenCalled();
  });
  it('rejects traversal, whole-repository globs, hidden paths and escaping symlinks before packing', async () => {
    const root = fixture(), outside = fixture(); writeFileSync(join(outside, 'private.ts'), 'PRIVATE');
    symlinkSync(join(outside, 'private.ts'), join(root, 'escaped.ts'));
    const deps = depsFor(root);
    const brief = await buildTaskBrief({ workspaceId: 'allowed', workItem: { id: 'WI-task', harness: 'h',
      payload: { rootPath: outside, paths: ['../private.ts', '.', '**/*', '.env', 'escaped.ts'] } } }, deps);
    expect(deps.root).toHaveBeenCalledWith('allowed', 'h'); expect(deps.pack).not.toHaveBeenCalled();
    expect(JSON.stringify(brief)).not.toContain('PRIVATE'); expect(brief.status).toBe('unknown');
  });
  it('remeasures the same scoped source after an edit and does not retain the old excerpt', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "old"; }');
    writeFileSync(join(root, 'unrelated.ts'), 'UNRELATED_PRIVATE');
    const ref = { workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } };
    const deps = depsFor(root), first = await buildTaskBrief(ref, deps);
    writeFileSync(join(root, 'target.ts'), 'export function target() { return "new"; }');
    const next = await buildTaskBrief(ref, deps);
    expect(first.status).toBe('current'); expect(next.status).toBe('current');
    expect(first.sourceFingerprint).not.toBe(next.sourceFingerprint);
    expect(JSON.stringify(next.excerpts)).toContain('new'); expect(JSON.stringify(next.excerpts)).not.toContain('old');
    expect(JSON.stringify(next)).not.toContain('UNRELATED_PRIVATE');
    expect(JSON.stringify(next).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
  it('discards excerpts when source changes during safe packing', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root), pack = deps.pack;
    deps.pack = async (...args) => { const result = await pack(...args); writeFileSync(join(root, 'target.ts'), 'changed'); return result; };
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } }, deps);
    expect(brief).toMatchObject({ status: 'unknown', files: [], excerpts: [], sourceFingerprint: null });
  });
  it('preserves verified source when optional compiler enrichment misses the remaining brief budget', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "CURRENT_SOURCE"; }');
    const deps = depsFor(root), pack = deps.pack;
    // Advance the wall clock after packing to reproduce the measured nearly-full
    // source budget without sleeping or changing the source oracle.
    const clock = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(clock);
    deps.pack = async (...args) => { const packed = await pack(...args); now.mockReturnValue(clock + 5_500); return packed; };
    deps.graph = vi.fn(() => new Promise<CodeIntelAnswer>(() => {}));
    try {
      const result = await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
        payload: { paths: ['target.ts'] } } }, deps);
      expect(result?.taskBrief.status).toBe('current');
      expect(result?.taskBrief.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result?.taskBrief.files).toEqual([expect.objectContaining({ path: 'target.ts' })]);
      expect(JSON.stringify(result?.taskBrief.excerpts)).toContain('CURRENT_SOURCE');
      expect(result?.taskBrief.graph.status).toBe('unknown');
      expect(result?.taskBrief.graph.reason).toMatch(/budget|unavailable/);
      expect(vi.mocked(deps.graph).mock.calls[0]![4]).toBeLessThan(TASK_BRIEF_BUDGET_MS);
    } finally { now.mockRestore(); }
  }, 10_000);
  it('names the capture phase in flight when the claim-time deadline fallback wins', async () => {
    // A hung safe pack must surface as an honest unknown that says WHERE the
    // budget went; a bare "exceeded its deadline" was undiagnosable (WI-10007889 P018).
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root);
    let packStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { packStarted = resolve; });
    deps.pack = vi.fn(() => { packStarted(); return new Promise<never>(() => {}); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = getClaimTimeTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
        payload: { paths: ['target.ts'] } } }, deps);
      await started;
      await vi.advanceTimersByTimeAsync(TASK_BRIEF_BUDGET_MS);
      const result = await pending;
      expect(result?.taskBrief.status).toBe('unknown');
      expect(result?.taskBrief.files).toEqual([]);
      // The phase in flight AND how the window was spent (WI-6554700010018774):
      // every phase entered is listed in order with its elapsed time.
      expect(result?.taskBrief.exclusions).toHaveLength(1);
      expect(result?.taskBrief.exclusions[0]).toMatch(
        /^Task brief exceeded its bounded read deadline during safe-pack \(elapsed \d+ms; setup \d+ms, repository-root \d+ms, scope-read \d+ms, safe-pack \d+ms\)\.$/);
    } finally { vi.useRealTimers(); }
  }, 10_000);
  it('shares the capture window with compilation and rejects evidence from a file omitted by the safe packer', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "CURRENT_SOURCE"; }');
    const deps = depsFor(root), pack = deps.pack;
    let finishCompiler: ((answer: CodeIntelAnswer) => void) | undefined;
    deps.graph = vi.fn(() => new Promise<CodeIntelAnswer>(resolve => { finishCompiler = resolve; }));
    deps.pack = async (...args) => {
      // A sequential capture cannot obtain this compiler response during the
      // packing window; a response rejected by the safe packer must stay private.
      expect(finishCompiler).toBeTypeOf('function');
      finishCompiler!({ ...answer([]), error: null });
      const packed = await pack(...args);
      return { ...packed, answer: { ...packed.answer, sites: [] } };
    };
    const brief = await buildTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
      payload: { paths: ['target.ts'] } } }, deps);
    expect(brief.status).toBe('current');
    expect(brief.files).toEqual([]); expect(brief.excerpts).toEqual([]);
    expect(brief.graph.status).toBe('unknown');
    expect(vi.mocked(deps.graph).mock.calls[0]![4]).toBeGreaterThan(2_000);
    expect(vi.mocked(deps.graph).mock.calls[0]![4]).toBeLessThan(TASK_BRIEF_BUDGET_MS);
  });
  it('keeps scoped source current after compiler failure but still rejects a concurrent source edit', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "CURRENT_SOURCE"; }');
    const deps = depsFor(root);
    const ref = { workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } };
    deps.graph = async () => { throw new Error('compiler unavailable'); };
    const current = await buildTaskBrief(ref, deps);
    expect(current.status).toBe('current'); expect(JSON.stringify(current.excerpts)).toContain('CURRENT_SOURCE');
    expect(current.graph.status).toBe('unknown');
    deps.graph = async () => { writeFileSync(join(root, 'target.ts'), 'export function target() { return "CHANGED"; }');
      throw new Error('compiler unavailable'); };
    expect(await buildTaskBrief(ref, deps)).toMatchObject({ status: 'unknown', files: [], excerpts: [], sourceFingerprint: null });
  });
  it('clamps the packer subprocess budget and exposes refusal as unknown with recovery', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export const x = 1;'); const deps = depsFor(root);
    deps.pack = async (_op, _args, effects) => {
      await effects!.exec('packer', [], { timeoutMs: 180_000 });
      return { answer: { ...answer([]), error: 'packer deadline' }, artifact: null };
    };
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h', payload: { paths: ['target.ts'] } } }, deps);
    expect(vi.mocked(deps.effects.exec).mock.calls[0]![2]!.timeoutMs).toBeLessThanOrEqual(6_000);
    expect(brief.status).toBe('unknown'); expect(brief.recover.tool).toBe('code:pack'); expect(brief.excerpts).toEqual([]);
  });
  it('recovers the registered repository rather than a payload root and cites canonical cross-plan authority', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root);
    deps.decisions = vi.fn(async () => ({ planSlug: 'task-plan', totalDecisions: 2,
      totalLocalDecisions: 1, totalAffectedDecisions: 1, affectedDecisions: 1, authorityReadFailed: false,
      decisions: [{ id: 'D-003', title: 'local', snippet: 'body' },
        { id: 'D-004', title: 'inbound', snippet: 'body', sourcePlanSlug: 'governing-plan' }] }));
    const brief = await buildTaskBrief({ workspaceId: 'task-workspace', workItem: { id: 'WI-task', harness: 'h',
      sourcePlanSlug: 'task-plan', payload: { rootPath: '/untrusted', paths: ['target.ts'] } } }, deps);
    expect(brief.repository).toEqual({ workspaceId: 'task-workspace', rootPath: root });
    expect(brief.recover).toEqual({ tool: 'code:pack', args: { op: 'pack', include: ['target.ts'], rootPath: root } });
    expect(brief.decisions).toEqual({ status: 'measured', refs: [{ plan: 'task-plan', id: 'D-003' },
      { plan: 'governing-plan', id: 'D-004' }], recover: { tool: 'plans:get', args: { slug: 'task-plan', harness: 'h', heading: 'Decisions' } } });
    expect(JSON.stringify(brief)).not.toContain('/untrusted');
  });
  it('keeps a failed governing-authority read explicitly unknown while preserving current scoped source', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root); deps.decisions = vi.fn(async () => { throw new Error('authority unavailable'); });
    const brief = await buildTaskBrief({ workItem: { id: 'WI-task', harness: 'h', sourcePlanSlug: 'task-plan',
      payload: { paths: ['target.ts'] } } }, deps);
    expect(brief.status).toBe('current'); expect(brief.decisions?.status).toBe('unknown');
    expect(brief.decisions?.refs).toEqual([]); expect(brief.decisions?.recover.args.slug).toBe('task-plan');
  });
  it('preserves scoped recovery and at least one source card when deep task paths and decisions fill the inline budget', async () => {
    const root = fixture(), prefix = 'packages/operator-core/lib/code-intelligence';
    mkdirSync(join(root, prefix), { recursive: true });
    const paths = ['task-brief.ts', 'task-brief.test.ts', 'task-brief.integration.test.ts',
      'native-ecosystem.integration.test.ts', 'native-ecosystem.e2e.test.ts'].map(name => `${prefix}/${name}`);
    for (const path of paths) writeFileSync(join(root, path), 'export function target() { return "SCOPED_SOURCE"; }');
    const plan = 'native-code-intelligence-ecosystem-and-dream-2026-10-09';
    const deps = depsFor(root);
    deps.decisions = async () => ({ planSlug: plan, totalDecisions: 8, totalLocalDecisions: 8,
      totalAffectedDecisions: 0, affectedDecisions: 0, authorityReadFailed: false,
      decisions: Array.from({ length: 8 }, (_, i) => ({ id: `D-00${i + 1}`, title: 'authority', snippet: 'body' })) });
    const brief = await buildTaskBrief({ workspaceId: 'papercusp-workspace', workItem: { id: 'WI-native-task', harness: 'papercusp',
      sourcePlanSlug: plan, payload: { paths } } }, deps);
    expect(brief.status).toBe('current');
    expect(brief.files.length).toBeGreaterThan(0);
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { rootPath: root, include: paths.slice().sort() } });
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    expect(brief.exclusions.join(' ')).toMatch(/omitted/);
  });
});
