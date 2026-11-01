import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { buildTaskBrief, claimedScopePaths, enrichTaskBriefWithReuse, gateTaskBriefRecover, getClaimTimeTaskBrief, getIntentTimeTaskBrief, getCompletionTimeBrief, snapshotCallersAnswer, taskIncidentBrief, TASK_BRIEF_BUDGET_MS, TASK_BRIEF_MAX_CHARS, type TaskBriefDeps } from './task-brief';
import { nativeChangeReport, type ChangeReportRequest } from './packer-facade';
import { firstPartyCallers } from './first-party-callers';
import type { CodeIntelAnswer } from './contracts';
import { coChangeFromCommits, formatPriorWorkLine, type PriorWorkQuery, type PriorWorkReport } from './change-history';
import { readEngineeringEvidence, type EngineeringEvidenceDeps } from './engineering-evidence';
import { coverageHash, type TestCoverageSnapshot } from '@papercusp/test-config/test-coverage-map';
import { decodeClaimReuseContribution } from './reuse-brief-providers';
import { toolsetFromNames } from './push-toolset';
import { firstPartyCallersOffthread } from './first-party-callers-offthread';
import type { queryPushSnapshot } from './push-snapshot';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { TASK_BRIEF_CAPTURE_CHANNEL, type TaskBriefCaptureTiming } from './task-brief';

// Pass-through spy: every test keeps the real worker; WI-6554700010042518 asserts it never starts.
vi.mock('./first-party-callers-offthread', async original => {
  const actual = await original<typeof import('./first-party-callers-offthread')>();
  return { ...actual, firstPartyCallersOffthread: vi.fn(actual.firstPartyCallersOffthread) };
});

/** A recipient session listed every tool a brief can name for recovery. */
const RECOVERY_TOOLS = ['code:pack', 'work_items:get', 'coord:declare-intent', 'plans:get', 'testing:runs', 'graph:query'];

const dirs: string[] = [];
describe('P039 completion pre-review briefs', () => {
  const ref = (paths = ['target.ts']) => ({ workspaceId: 'w', harness: 'h', paths });
  const setup = () => {
    const root = fixture();
    writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    writeFileSync(join(root, 'target.test.ts'), 'import { target } from "./target"; target();');
    // Prepare real compiler evidence before the brief starts its six-second capture.
    // Reuse it across advice/toolset/coverage calls; nativeChangeReport still checks
    // its source hashes, so an edit cannot turn this fixture into stale evidence.
    const compiler = firstPartyCallers({ ts, root, name: 'target', filePath: 'target.ts',
      op: 'impact', direction: 'downstream', paths: ['.'], includeInterfaces: true });
    const report: typeof nativeChangeReport = (args, subject) => nativeChangeReport(args, subject, {
      exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => 'fixture-artifact',
      graph: async () => compiler,
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
  it('appends untouched co-change into the existing completion advisory with P009 limits and issued identity', async () => {
    const { report, rootResolver } = setup();
    const now = new Date().toISOString();
    const history = coChangeFromCommits({ end: now, paths: ['target.ts'], commit: 'a'.repeat(40), complete: true,
      commits: [1, 2, 3].map(n => ({ sha: String(n), parents: ['parent'], at: new Date(Date.now() - n * 86400000).toISOString(),
        files: [{ status: 'M', path: 'target.ts' }, { status: 'M', path: 'partner.ts' }] })) });
    const issued = vi.fn(async () => true), observe = vi.fn();
    const base = await getCompletionTimeBrief(ref(), { root: rootResolver, report, runs: async () => [] });
    const enriched = await getCompletionTimeBrief({ ...ref(), workItem: 'WI-completion',
      reuse: { owner: 'su-fixture', invocation: 'real-completion', observe } },
    { root: rootResolver, report, runs: async () => [], cochange: async () => history, reuse: { recordIssued: issued } });
    expect(enriched.changes).toEqual(base.changes); expect(enriched.tests).toEqual(base.tests);
    expect(enriched.limitations).toContain('Untouched partner.ts (3/3;90d)');
    expect(Object.keys(enriched)).toEqual(Object.keys(base));
    expect(issued).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]?.[0]).toMatchObject({ ledger: 'recorded',
      context: { surface: 'completion', invocation: 'real-completion', workItem: 'WI-completion' },
      observations: expect.arrayContaining([expect.objectContaining({ provider: 'cochange', status: 'issued' }),
        expect.objectContaining({ provider: 'sql' })]) });
    expect(JSON.stringify(enriched).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
  it('SPEC-P-006-B: names the diff recovery call only to a recipient listed code:pack, and ledgers what it received', async () => {
    const { report, rootResolver } = setup();
    const history = coChangeFromCommits({ end: new Date().toISOString(), paths: ['target.ts'], commit: 'a'.repeat(40), complete: true,
      commits: [1, 2, 3].map(n => ({ sha: String(n), parents: ['parent'], at: new Date(Date.now() - n * 86400000).toISOString(),
        files: [{ status: 'M', path: 'target.ts' }, { status: 'M', path: 'partner.ts' }] })) });
    const run = async (listed: string[] | null) => {
      const issued = vi.fn(async (_input: { recover?: unknown }) => true), observe = vi.fn();
      const brief = await getCompletionTimeBrief({ ...ref(), workItem: 'WI-completion',
        reuse: { owner: 'su-fixture', invocation: 'p006-completion', observe } },
      { root: rootResolver, report, runs: async () => [], cochange: async () => history, reuse: { recordIssued: issued },
        toolset: async () => listed ? toolsetFromNames(listed) : { status: 'unknown', reason: 'no-listing' } });
      return { brief, issued: issued.mock.calls[0]?.[0], observed: observe.mock.calls[0]?.[0] };
    };
    const listed = await run(['code:pack']);
    expect(listed.brief.status).toBe('measured');
    expect(listed.brief.recover).toMatchObject({ tool: 'code:pack', args: { op: 'diff', include: ['target.ts'] } });
    expect(listed.issued?.recover).toEqual(listed.brief.recover); expect(listed.observed?.recover).toEqual(listed.brief.recover);
    for (const withheld of [await run(null), await run([]), await run(['testing:run'])]) {
      expect(withheld.brief.status).toBe('measured');
      expect(withheld.brief.changes).toEqual(listed.brief.changes);
      expect(withheld.brief.limitations).toContain('Untouched partner.ts (3/3;90d)');
      expect(withheld.brief).not.toHaveProperty('recover');
      expect(JSON.stringify(withheld.brief)).not.toContain('code:pack');
      expect(withheld.issued).toBeDefined(); expect(withheld.issued?.recover).toBeUndefined();
      expect(withheld.observed?.recover).toBeUndefined();
    }
  });
  it('invalidates consequences when the source changes during the ledger read', async () => {
    const { root, report, rootResolver } = setup();
    const result = await getCompletionTimeBrief(ref(), { root: rootResolver, report, runs: async () => {
      writeFileSync(join(root, 'target.ts'), 'export function target() { return 2; }'); return [];
    } });
    expect(result).toMatchObject({ status: 'unknown', changes: [], tests: [], testsWithoutRunEvidence: null });
  });
  it.each(['complete', 'truncated', 'incomplete'] as const)('binds completion coverage questions to %s measured diff and compiler test reach', async mode => {
    const { report, rootResolver } = setup();
    const observe = vi.fn();
    const measured: typeof nativeChangeReport = async (...args) => {
      const result = await report(...args);
      return { ...result, report: { ...result.report, changed: [{ path: 'target.ts', line1: 1,
        patch: `diff --git a/target.ts b/target.ts\n--- a/target.ts\n+++ b/target.ts\n@@ -1,2 +1,3 @@\n unchanged\n-old\n+new\n${mode === 'incomplete' ? '' : '+added\n'}` }],
      limitations: mode === 'truncated' ? [...result.report.limitations, 'Diff excerpt truncated for target.ts.'] : result.report.limitations } };
    };
    await getCompletionTimeBrief({ ...ref(), reuse: { owner: 'su-fixture', invocation: 'completion-coverage', observe } },
      { root: rootResolver, report: measured, cochange: async () => coChangeFromCommits({ end: new Date().toISOString(),
        paths: ['target.ts'], commit: null, complete: false, commits: [] }),
      reuse: { providers: [], recordIssued: async () => true } });
    const context = observe.mock.calls[0]![0].context;
    expect(context.changedLines).toEqual(mode === 'complete' ? { 'target.ts': [2, 3] } : undefined);
    expect(context.staticTests).toContain('target.test.ts');
    // Neither a static path nor a diff becomes checked or executed source.
    expect(context.checkedPaths).toBeUndefined();
  });
  it('keeps an independent SQL provider when the co-change source is unavailable', async () => {
    const { report, rootResolver } = setup();
    const observed = vi.fn();
    const result = await getCompletionTimeBrief({ ...ref(), reuse: { owner: 'su-fixture', invocation: 'completion-sql', observe: observed } },
      { root: rootResolver, report, cochange: async () => { throw new Error('history unavailable'); }, reuse: {
        recordIssued: async () => true, providers: [{ id: 'sql', read: async context => ({ status: 'measured',
          sourceVersion: context.sourceVersion, indexVersion: 'sql-v1', lines: ['Unchecked reader db/read.ts'] }) }],
      } });
    expect(result.limitations).toContain('Unchecked reader db/read.ts');
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ ledger: 'recorded', observations: [{ provider: 'sql', status: 'issued' }] });
  });
  it.each(['covered', 'uncovered', 'partial', 'stale', 'ambiguous', 'missing'] as const)(
    'derives checked source from one %s close-bound coverage receipt and shares it with coverage advice', async mode => {
      const { root, report, rootResolver } = setup(), observed = vi.fn();
      const coverage = vi.fn(async (context: import('./reuse-brief-providers').ReuseProviderContext) => {
        if (mode === 'missing') return null;
        const testHash = coverageHash(readFileSync(join(root, 'target.test.ts')));
        const hashes = new Map(context.sourceFiles!.map(file => [file.path, file.sha256]));
        hashes.set('target.test.ts', testHash);
        const snapshot: TestCoverageSnapshot = { schemaVersion: 1, root, scopeRoot: root,
          testFile: 'target.test.ts', testSha256: testHash, observedAt: new Date().toISOString(),
          populationComplete: mode !== 'partial', population: [{ path: 'target.test.ts', sha256: testHash }],
          sources: [{ path: 'target.ts', sha256: mode === 'stale' ? '0'.repeat(64) : hashes.get('target.ts')!,
            executable: [1], covered: mode === 'uncovered' ? [] : [1] }] };
        return { snapshots: mode === 'ambiguous' ? [snapshot, { ...snapshot, scopeRoot: join(root, 'other') }] : [snapshot],
          currentHashes: hashes, population: ['target.test.ts'] };
      });
      const result = await getCompletionTimeBrief({ ...ref(), reuse: { owner: 'su-fixture', invocation: 'bound-coverage', observe: observed } },
        { root: rootResolver, report, coverage, cochange: async () => coChangeFromCommits({ end: new Date().toISOString(),
          paths: ['target.ts'], commit: null, complete: false, commits: [] }), reuse: { recordIssued: async () => true } });
      expect(coverage).toHaveBeenCalledOnce();
      expect(observed.mock.calls[0]![0].context.checkedPaths).toEqual(
        mode === 'covered' || mode === 'partial' ? ['target.ts'] : mode === 'uncovered' ? [] : undefined);
      expect(result.limitations.join(' ')).toContain(mode === 'stale' || mode === 'ambiguous' || mode === 'missing'
        ? 'execution unknown' : mode === 'uncovered' ? 'no test executes' : 'executed by target.test.ts');
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
  it('spends only the caller deadline, so an outer bound never discards the named reason (WI-6554700010030397)', async () => {
    const { rootResolver } = setup();
    const graph = vi.fn(async (request: ChangeReportRequest, graphRoot: string, budgetMs: number) => ({
      ...firstPartyCallers({ ts, root: graphRoot, name: request.symbol, filePath: request.file, op: 'impact',
        direction: 'downstream', paths: ['.'], includeInterfaces: true }),
      error: `the callers worker exceeded its ${budgetMs} ms deadline and was killed`, evidence: undefined }));
    const deadlineMs = Date.now() + 1_500;
    const brief = await getCompletionTimeBrief({ ...ref(), deadlineMs }, { root: rootResolver, graph, runs: async () => [],
      effects: { exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => 'fixture-artifact' } });
    expect(graph.mock.calls[0]![2]).toBeLessThanOrEqual(1_250);
    expect(brief).toMatchObject({ status: 'unknown', changes: [] });
    expect(brief.limitations).toContainEqual(expect.stringContaining('Compiler evidence was unmeasured for target.ts#target'));
  });
  describe('operator-home callers come from the warm push snapshot (WI-6554700010042518)', () => {
    const home = () => ({ ...ref(), harness: operatorHomeHarnessSlug() });
    const effects = { exec: async () => ({ stdout: '', stderr: '' }), writeArtifact: async () => 'fixture-artifact' };
    // A real, source-hashed compiler answer, re-labelled as the snapshot's syntax-bound callers.
    const snapshotOf = (root: string, declaredIn = 'target.ts'): CodeIntelAnswer => {
      const compiler = firstPartyCallers({ ts, root, name: 'target', filePath: 'target.ts', op: 'callers', paths: ['.'] });
      const evidence = compiler.evidence!;
      return { ...compiler, backend: 'first-party-snapshot', evidence: { ...evidence,
        relationships: evidence.relationships.map(edge => ({ ...edge, target: { contentHash: 'declaration',
          versionedSymbolId: null, site: { path: declaredIn, line1: 1, kind: null, name: 'target', detail: null } } })) } };
    };
    it('measures the section from the snapshot inside the deadline and never starts the cold worker', async () => {
      const { root, rootResolver } = setup();
      vi.mocked(firstPartyCallersOffthread).mockClear();
      const answer = snapshotOf(root);
      const snapshot = vi.fn<typeof queryPushSnapshot>(async () => answer);
      const started = Date.now();
      const brief = await getCompletionTimeBrief(home(), { root: rootResolver, snapshot, runs: async () => [], effects });
      expect(Date.now() - started).toBeLessThan(TASK_BRIEF_BUDGET_MS);
      // Per-file proof: the changed declaration file cannot match a snapshot taken before the edit.
      expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ op: 'callers', name: 'target',
        callerProof: 'per-file', declaredIn: 'target.ts' }));
      expect(brief).toMatchObject({ status: 'measured', changes: [expect.objectContaining({ file: 'target.ts', symbol: 'target' })] });
      expect(firstPartyCallersOffthread).not.toHaveBeenCalled();
    });
    it('reports a cold snapshot as index-not-ready instead of forking the worker', async () => {
      const { rootResolver } = setup();
      vi.mocked(firstPartyCallersOffthread).mockClear();
      const brief = await getCompletionTimeBrief(home(), { root: rootResolver, snapshot: async () => null,
        snapshotMissReason: () => 'loading', runs: async () => [], effects });
      expect(brief).toMatchObject({ status: 'unknown', changes: [] });
      expect(brief.limitations).toContainEqual(expect.stringContaining(
        'Compiler evidence was unmeasured for target.ts#target: index-not-ready: the caller snapshot is loading'));
      expect(firstPartyCallersOffthread).not.toHaveBeenCalled();
    });
    it('refuses a same-name declaration in another file and names the miss', async () => {
      const { root, rootResolver } = setup();
      const brief = await getCompletionTimeBrief(home(), { root: rootResolver, snapshot: async () => snapshotOf(root, 'other.ts'),
        runs: async () => [], effects });
      expect(brief).toMatchObject({ status: 'unknown', changes: [] });
      expect(brief.limitations).toContainEqual(expect.stringContaining(
        "snapshot-miss: the snapshot's target is declared in other.ts, not target.ts"));
    });
    it('asks the snapshot before spending a report, so uncalled exports cannot use up the deadline (WI-6554700010042685)', async () => {
      const { root, rootResolver } = setup();
      // Measured live on push-snapshot.ts: each report re-ran git provenance and the diff (~1 s), and
      // its leading constants and types had no snapshot answer, so the deadline expired with processed [].
      writeFileSync(join(root, 'target.ts'), 'export const LIMIT = 1;\nexport type Shape = { a: number };\n'
        + 'export interface Box { b: number }\nexport function target() { return LIMIT; }');
      const reports: string[] = [];
      const exec = async (_bin: string, argv: readonly string[]) => {
        if (argv[0] === 'diff' && argv.includes('--unified=3')) reports.push(argv.join(' '));
        return { stdout: '', stderr: '' };
      };
      // Built once: the brief asks the snapshot twice per answered symbol, and a per-call compiler
      // answer pushed this test past the brief budget under host load (mutation-probe overlay, 6104 ms).
      const answer = snapshotOf(root);
      const snapshot = vi.fn<typeof queryPushSnapshot>(async query => query.name === 'target' ? answer : null);
      const brief = await getCompletionTimeBrief(home(), { root: rootResolver, snapshot, snapshotMissReason: () => null,
        runs: async () => [], effects: { ...effects, exec } });
      expect(brief).toMatchObject({ status: 'measured', scope: { processed: ['target.ts'] },
        changes: [expect.objectContaining({ file: 'target.ts', symbol: 'target' })] });
      // One report, for the one symbol the snapshot answered; the three misses cost only snapshot reads.
      expect(reports).toHaveLength(1);
      expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ name: 'LIMIT' }));
    });
    it('labels both limitation copies as direct callers, and never reads a miss as zero callers', async () => {
      const { root } = setup();
      const answer = await snapshotCallersAnswer({ symbol: 'target', file: join(root, 'target.ts'), phase: 'pre-review' }, root,
        async () => snapshotOf(root));
      expect(answer.error).toBeNull();
      expect(answer.sites.length).toBeGreaterThan(0);
      expect(answer.coverage?.limitations).toContainEqual(expect.stringContaining('Direct callers from the first-party snapshot'));
      expect(answer.evidence?.graphScope.limitations).toContainEqual(expect.stringContaining('Direct callers from the first-party snapshot'));
      const miss = await snapshotCallersAnswer({ symbol: 'target', file: 'target.ts' }, root, async () => null, () => null);
      expect(miss).toMatchObject({ sites: [],
        error: expect.stringContaining('snapshot-miss: no caller of target declared in target.ts could be verified against current disk') });
      expect(miss.evidence).toBeUndefined();
    });
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
  it('scopes an item without payload.paths from existing repository paths its text names (WI-6554700010030367)', async () => {
    const root = fixture(); mkdirSync(join(root, 'packages/x'), { recursive: true });
    writeFileSync(join(root, 'packages/x/target.ts'), 'export function target() { return "TEXT_SCOPE"; }');
    const deps = depsFor(root); deps.failures = vi.fn(async () => []);
    const workItem = { id: 'WI-plan', harness: 'h', title: 'P-004 wire the reader',
      summary: 'Edit packages/x/target.ts and add packages/x/new-file.ts.', payload: {} };
    const brief = await buildTaskBrief({ workspaceId: 'w', workItem }, deps);
    expect(brief.status).toBe('current'); expect(brief.scope.paths).toEqual(['packages/x/target.ts']);
    expect(brief.exclusions.join(' ')).toContain('inferred from repository paths');
    expect(await getClaimTimeTaskBrief({ workspaceId: 'w', workItem }, deps)).not.toBeNull();
    const packCallsBefore = vi.mocked(deps.pack).mock.calls.length;
    expect(packCallsBefore).toBeGreaterThan(0);
    const absent = await buildTaskBrief({ workspaceId: 'w', workItem: { ...workItem, summary: 'Create packages/x/new-file.ts.' } }, deps);
    expect(absent).toMatchObject({ status: 'unknown', files: [] });
    expect(vi.mocked(deps.pack).mock.calls.length).toBe(packCallsBefore);
    expect(absent.exclusions.join(' ')).toContain('names no existing repository path');
  });
  it('withholds a partial declared scope instead of publishing the same surviving files for different items', async () => {
    const root = fixture();
    const sharedPaths = [
      'apps/operator/scripts/resume-spawn-live.ts',
      'packages/operator-core/lib/events/await/resume-spawn-live.integration.test.ts',
    ];
    mkdirSync(join(root, 'apps/operator/scripts'), { recursive: true });
    mkdirSync(join(root, 'packages/operator-core/lib/events/await'), { recursive: true });
    writeFileSync(join(root, sharedPaths[0]!), 'export function resumeSpawnLive() { return true; }');
    writeFileSync(join(root, sharedPaths[1]!), 'import { resumeSpawnLive } from "../../../scripts/resume-spawn-live"; resumeSpawnLive();');
    const deps = depsFor(root);
    const items = [
      { id: 'WI-lint', missing: 'lib/agent-identities/identity-surface-lint.test.ts' },
      { id: 'WI-census', missing: 'lib/agent-identities/identity-surface-census.test.ts' },
    ];
    for (const item of items) {
      const result = await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: {
        id: item.id, harness: 'h', payload: { paths: [item.missing, ...sharedPaths] },
      } }, deps);
      expect(result?.taskBrief).toMatchObject({ status: 'unknown', scope: { harness: 'h', paths: [] },
        sourceFingerprint: null, files: [], excerpts: [] });
      expect(result?.taskBrief.exclusions.join(' ')).toContain('declared task scope is incomplete');
    }
    expect(deps.pack).not.toHaveBeenCalled();
  });
});
const fixture =() => { const dir = mkdtempSync(join(tmpdir(), 'task-brief-')); dirs.push(dir); return dir; };
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
    toolset: vi.fn(async () => toolsetFromNames(RECOVERY_TOOLS)),
  };
}
describe('native engineering evidence task context', () => {
  function engineeringFixture(patch: Partial<EngineeringEvidenceDeps> = {}) {
    const deps: EngineeringEvidenceDeps = {
      authorize: async scope => scope.workspaceId === 'w' && scope.harness === 'h',
      symbol: async () => [{ path: 'target.ts', name: 'target', line1: 1, versionedSymbolId: 'target-v1',
        fileFingerprint: 'a'.repeat(64), declarationFingerprint: null }],
      sourceCurrent: async () => true,
      items: async scope => [{ ...scope, plan: 'ee-feature', item: 'P-001', anchorState: 'current' }],
      specs: async () => [{ plan: 'ee-feature', item: 'P-001', id: 'EE-1', revision: 1, currentRevision: 1,
        fingerprint: 'b'.repeat(64), behavior: 'Return the feature', lifecycle: 'active' }],
      spec: async () => null,
      decisions: async () => [{ plan: 'ee-feature', id: 'D-001', title: 'Rationale', body: 'Explicit item rule',
        itemRefs: ['P-001'], affects: [] },
      { plan: 'broader-plan', id: 'D-002', title: 'Broader context', body: 'Affects the plan without declaring this item.',
        itemRefs: [], affects: ['ee-feature'] }],
      proofs: async () => [{ id: 51, plan: 'ee-feature', spec: 'EE-1', revision: 1, workItem: 'WI-ee',
        evidenceRef: 'test-run:72101', kind: 'test', state: 'current', withdrawn: false,
        fingerprints: {}, runId: 72101, reasons: [] }],
      run: async () => ({ id: 72101, file: 'target.test.ts', status: 'pass', commit: 'c'.repeat(40) }),
      cases: async () => [{ runId: 72101, key: 'ee.intent-exact', occurrence: 1, status: 'pass' }],
      ...patch,
    };
    const reader: typeof readEngineeringEvidence = (query, scope) => readEngineeringEvidence(query, scope, deps);
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const subject = { id: 'WI-ee', harness: 'h', sourcePlanSlug: 'ee-feature', sourcePlanItemIds: ['P-001'],
      payload: { paths: ['target.ts'] } };
    return { root, subject, deps: { ...depsFor(root), engineering: reader, claimedPaths: async () => [] } };
  }
  it('ee.brief-four-axes: carries exact canonical references or an explicit execution gap through claim, intent and completion', async () => {
    const { root, subject, deps } = engineeringFixture();
    const claim = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject, owner: 'su-ee' }, deps))!.taskBrief;
    expect(claim.engineering?.intent[0]?.ref).toMatchObject({ tool: 'plans:get-specs', args: { revision: 1, specIds: ['EE-1'] } });
    expect(claim.engineering?.rationale[0]?.ref).toMatchObject({ tool: 'plans:get', args: { decisionId: 'D-001' } });
    expect(claim.engineering?.rationale).toHaveLength(1);
    expect(claim.engineering?.gaps).toContain('broader-plan-context-available');
    expect(claim.engineering?.validation[0]?.ref.tool).toBe('plans:get-spec-evidence');
    expect(claim.engineering?.execution).toEqual([]); expect(claim.engineering?.gaps.length).toBeGreaterThan(0);
    const intent = (await getIntentTimeTaskBrief({ owner: 'su-ee', workspaceId: 'w', harness: 'h',
      intent: 'Inspect target', paths: ['target.ts'] }, deps))!.taskBrief;
    expect(intent.engineering?.recover?.args).toMatchObject({ file_path: 'target.ts', name: 'target', harnesses: ['h'] });
    const completion = await getCompletionTimeBrief({ workspaceId: 'w', harness: 'h', paths: [], subject, owner: 'su-ee' },
      { root: async () => root, engineering: deps.engineering, toolset: deps.toolset });
    expect(claim.engineering?.recover?.tool).toBe('graph:query');
    expect(completion.engineering?.recover).toEqual(claim.engineering?.recover);
  });

  it('preserves the complete engineering baseline and delivers every hint recorded as issued', async () => {
    const { root, subject, deps } = engineeringFixture();
    writeFileSync(join(root, 'target.ts'), '// ' + 'source context '.repeat(80)
      + '\nexport function target() { return 1; }');
    for (const maxChars of [6000, TASK_BRIEF_MAX_CHARS, 2400]) {
      const ref = { workspaceId: 'w', workItem: subject, maxChars, owner: 'su-fixture' };
      const base = (await getClaimTimeTaskBrief(ref, deps))!.taskBrief;
      const observe = vi.fn();
      const enriched = (await getClaimTimeTaskBrief({ ...ref,
        reuse: { owner: 'su-fixture', invocation: 'engineering-budget', observe } }, {
        ...deps, reuse: { recordIssued: async () => true, providers: [
          { id: 'clones', read: async context => ({ status: 'measured', sourceVersion: context.sourceVersion,
            indexVersion: 'clones-v1', lines: ['target.ts ' + 'similar source '.repeat(22)] }) },
          { id: 'sql', read: async context => ({ status: 'measured', sourceVersion: context.sourceVersion,
            indexVersion: 'sql-v1', lines: ['target.ts ' + 'reader '.repeat(20)] }) },
        ] },
      }))!.taskBrief;
      const hints = enriched.graph.relationships.flatMap(line => {
        const row = decodeClaimReuseContribution(enriched, line); return row ? [row] : [];
      });
      expect({ ...enriched, graph: { ...enriched.graph,
        relationships: enriched.graph.relationships.slice(0, base.graph.relationships.length) } })
        .toEqual(base);
      const issued = observe.mock.calls[0][0].observations.filter((row: { status: string }) => row.status === 'issued');
      if (maxChars === 6000) expect(issued.length).toBeGreaterThan(0);
      expect(hints.map(row => row.provider)).toEqual(issued.map((row: { provider: string }) => row.provider));
      expect(JSON.stringify(enriched).length).toBeLessThanOrEqual(maxChars);
    }
  });
  it.each([3000, 2900])('classifies claim overflow as budget and preserves a later fitting provider at %i characters', async maxChars => {
    const { subject, deps } = engineeringFixture();
    const base = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject }, deps))!.taskBrief;
    base.exclusions.push('');
    base.exclusions[base.exclusions.length - 1] = 'x'.repeat(maxChars - 150 - JSON.stringify(base).length);
    const observe = vi.fn();
    const result = await enrichTaskBriefWithReuse(base, { workspaceId: 'w', workItem: subject, maxChars,
      reuse: { owner: 'su-fixture', invocation: 'claim-overflow', observe } }, {
      ...deps, reuse: { recordIssued: async () => true, providers: [
        { id: 'sql', read: async context => ({ status: 'measured', sourceVersion: context.sourceVersion,
          indexVersion: 'sql-v1', lines: ['SQL reader ' + 'r'.repeat(190)] }) },
        { id: 'coverage', read: async context => ({ status: 'measured', sourceVersion: context.sourceVersion,
          indexVersion: 'coverage-v1', lines: ['Covered target.ts'] }) },
      ] },
    }, Date.now() + 6000);
    expect(observe.mock.calls[0][0].observations).toEqual([
      expect.objectContaining({ provider: 'sql', status: 'budget', reason: 'truncated' }),
      expect.objectContaining({ provider: 'coverage', status: 'issued' }),
    ]);
    expect(result.graph.relationships.map(line => decodeClaimReuseContribution(result, line)?.provider)).toEqual(['coverage']);
    expect({ ...result, graph: { ...result.graph, relationships: base.graph.relationships } }).toEqual(base);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(maxChars);
  });
  it('SPEC-P-008-B: the claim brief lists the prior work the first-touch note shows for the same function', async () => {
    const { subject, deps } = engineeringFixture();
    // The brief derives the touched names from the file at claim time (target.ts declares target()).
    const report: PriorWorkReport = { status: 'measured', path: 'target.ts', names: ['target'], total: 1,
      items: [{ workItem: 'WI-prior', title: 'Fix target overflow', state: 'done', kind: 'bug',
        lastEditAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), closedAt: null, symbols: ['target'] }],
      fileLevel: [], fileLevelTotal: 0, truncated: false, error: null };
    const priorWork = vi.fn(async (query: PriorWorkQuery): Promise<PriorWorkReport> =>
      ({ ...report, path: query.path, names: query.names }));
    const observe = vi.fn();
    const brief = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject,
      reuse: { owner: 'su-fixture', invocation: 'claim-prior-work', observe } },
    { ...deps, reuse: { recordIssued: async () => true, priorWork } }))!.taskBrief;
    expect(priorWork).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w', path: 'target.ts',
      names: ['target'], excludeWorkItem: 'WI-ee' }));
    const contributions = brief.graph.relationships.flatMap(line => {
      const row = decodeClaimReuseContribution(brief, line); return row ? [row] : [];
    });
    const provenance = contributions.find(row => row.provider === 'provenance');
    // The exact line the first-touch push renders for this report (shared formatter, same harness).
    expect(provenance?.text).toContain(formatPriorWorkLine(report, { harness: 'h' })!);
    expect(observe.mock.calls[0][0].observations).toContainEqual(
      expect.objectContaining({ provider: 'provenance', status: 'issued', cohort: 'treatment' }));
  });
  it('ee.brief-budget: fits the complete caller brief in 2400 characters and retains scoped recovery for omitted data', async () => {
    const { subject, deps } = engineeringFixture();
    const brief = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject, maxChars: 2400, owner: 'su-ee' }, deps))!.taskBrief;
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(2400);
    expect(brief.engineering?.recover).toEqual({ tool: 'graph:query', args: { op: 'evidence', harnesses: ['h'], plan: 'ee-feature', item: 'P-001' } });
  });
  it('ee.brief-stale: preserves stale validation and refuses a foreign scope', async () => {
    const { subject, deps } = engineeringFixture({ proofs: async () => [{ id: 51, plan: 'ee-feature', spec: 'EE-1',
      revision: 1, workItem: 'WI-ee', evidenceRef: 'test-run:72101', kind: 'test', state: 'stale', withdrawn: false,
      fingerprints: {}, runId: 72101, reasons: ['changed-source'] }] });
    const brief = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject }, deps))!.taskBrief;
    expect(brief.engineering?.validation[0]?.state).toBe('stale');
    const foreign = (await getClaimTimeTaskBrief({ workspaceId: 'foreign', workItem: subject }, deps))!.taskBrief;
    expect(foreign.engineering?.intent).toEqual([]); expect(foreign.engineering?.gaps).toContain('engineering-evidence-unavailable');
  });
  it('ee.brief-no-trace: a missing trace or unavailable evidence cannot block ordinary task context', async () => {
    const { subject, deps } = engineeringFixture();
    const withoutPaths = { ...subject, payload: {} };
    const claim = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: withoutPaths }, deps))!.taskBrief;
    expect(claim.engineering?.intent.length).toBeGreaterThan(0); expect(claim.engineering?.execution).toEqual([]);
    deps.engineering = async () => { throw new Error('optional trace service absent'); };
    const fallback = (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject }, deps))!.taskBrief;
    expect(fallback.status).toBe('current'); expect(fallback.engineering?.gaps).toContain('engineering-evidence-unavailable');
  });
});
describe('P-006 SPEC-P-006-B: a brief names a recovery tool only when the recipient was listed it', () => {
  const claimFixture = (listing: TaskBriefDeps['toolset']) => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps: TaskBriefDeps = { ...depsFor(root), toolset: listing, failures: async () => [], decisions: async () => null };
    return { deps, subject: { id: 'WI-p006', harness: 'h', sourcePlanSlug: 'p006-plan', payload: { paths: ['target.ts'] } } };
  };
  const claim = async (listing: TaskBriefDeps['toolset'], extra: Partial<Parameters<typeof getClaimTimeTaskBrief>[0]> = {},
    patch: Partial<TaskBriefDeps> = {}) => {
    const { deps, subject } = claimFixture(listing);
    return (await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: subject, owner: 'su-p006', ...extra }, { ...deps, ...patch }))!.taskBrief;
  };
  it('names every recovery call to a session listed its tools', async () => {
    const brief = await claim(async () => toolsetFromNames(RECOVERY_TOOLS));
    expect(brief.status).toBe('current');
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { op: 'pack', include: ['target.ts'] } });
    expect(brief.decisions?.recover).toEqual({ tool: 'plans:get', args: { slug: 'p006-plan', harness: 'h', heading: 'Decisions' } });
  });
  it('withholds every recovery call from an unknown, empty or unread listing and keeps the inline evidence', async () => {
    const listed = await claim(async () => toolsetFromNames(RECOVERY_TOOLS));
    const listings: TaskBriefDeps['toolset'][] = [
      async () => ({ status: 'unknown', reason: 'no-listing' }),
      async () => toolsetFromNames([]),
      async () => { throw new Error('listing read failed'); },
      () => new Promise(() => {}),
    ];
    for (const listing of listings) {
      const brief = await claim(listing);
      expect(brief.status).toBe('current');
      expect(brief.files).toEqual(listed.files); expect(brief.excerpts).toEqual(listed.excerpts);
      expect(brief).not.toHaveProperty('recover'); expect(brief.decisions).not.toHaveProperty('recover');
      expect(JSON.stringify(brief)).not.toMatch(/code:pack|plans:get|work_items:get|testing:runs|graph:query/);
    }
    // No recipient identity is an unknown listing, never "all tools"; the reader is not asked.
    const reader = vi.fn(async () => toolsetFromNames(RECOVERY_TOOLS));
    expect(await claim(reader, { owner: undefined })).not.toHaveProperty('recover');
    expect(reader).not.toHaveBeenCalled();
  });
  it('keeps only the calls whose tool is in a partial listing', async () => {
    const brief = await claim(async () => toolsetFromNames(['plans:get', 'testing:run']));
    expect(brief).not.toHaveProperty('recover');
    expect(brief.decisions?.recover?.tool).toBe('plans:get');
    expect(gateTaskBriefRecover({ recover: { tool: 'code:pack' }, incident: { recover: { tool: 'testing:runs' } },
      engineering: { recover: { tool: 'graph:query' } }, decisions: { recover: { tool: 'plans:get' } } },
    toolsetFromNames(['testing:runs', 'graph:query'])))
      .toEqual({ incident: { recover: { tool: 'testing:runs' } }, engineering: { recover: { tool: 'graph:query' } }, decisions: {} });
  });
  it('records the call the recipient received: a withheld call reaches the reuse ledger and outcome as absent', async () => {
    const run = async (listing: TaskBriefDeps['toolset']) => {
      const issued = vi.fn(async (_input: { recover?: unknown }) => true), observe = vi.fn();
      const brief = await claim(listing, { reuse: { owner: 'su-p006', invocation: 'p006-claim', observe } }, {
        reuse: { recordIssued: issued, providers: [{ id: 'sql', read: async context => ({ status: 'measured',
          sourceVersion: context.sourceVersion, indexVersion: 'sql-v1', lines: ['target.ts reads table t'] }) }] } });
      return { brief, issued: issued.mock.calls[0]?.[0], observed: observe.mock.calls[0]?.[0] };
    };
    const listed = await run(async () => toolsetFromNames(RECOVERY_TOOLS));
    expect(listed.issued?.recover).toEqual(listed.brief.recover); expect(listed.observed?.recover).toEqual(listed.brief.recover);
    const withheld = await run(async () => toolsetFromNames(['work_items:get']));
    expect(withheld.issued).toBeDefined(); expect(withheld.issued?.recover).toBeUndefined();
    expect(withheld.observed).toMatchObject({ ledger: 'recorded' }); expect(withheld.observed?.recover).toBeUndefined();
  });
});
describe('P012 bounded scoped task briefs', () => {
  it('captures explicit no-claim intent scope without inventing a work-item identity', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "INTENT_SOURCE"; }');
    const deps = depsFor(root); deps.claimedPaths = vi.fn(async () => []); deps.failures = vi.fn(async () => []);
    const ref = { owner: 'su-intent', workspaceId: 'w', harness: 'h', intent: 'Inspect target', paths: ['target.ts'] };
    const first = (await getIntentTimeTaskBrief(ref, deps))!.taskBrief;
    expect(first.status).toBe('current'); expect(first.files[0]?.path).toBe('target.ts');
    expect(JSON.stringify(first.excerpts)).toContain('INTENT_SOURCE'); expect(first.incident).toBeUndefined();
    expect(deps.failures).not.toHaveBeenCalled(); expect(first.recover?.tool).toBe('code:pack');
    const next = (await getIntentTimeTaskBrief({ ...ref, intent: 'Change target' }, deps))!.taskBrief;
    expect(next.intent?.fingerprint).not.toBe(first.intent?.fingerprint);
    expect(next.sourceFingerprint).toBe(first.sourceFingerprint);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
  });
  it('briefs only the declared paths outside every held claim, with claim scope derived like buildTaskBrief (WI-6554700010030367)', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return "OUTSIDE_CLAIM"; }');
    writeFileSync(join(root, 'held.ts'), 'export function held() { return 1; }');
    const deps = depsFor(root); deps.claimedPaths = vi.fn(async () => ['held.ts']); deps.failures = vi.fn(async () => []);
    const ref = { owner: 'su-intent', workspaceId: 'w', harness: 'h', intent: 'Inspect target', paths: ['held.ts', 'target.ts'] };
    const brief = (await getIntentTimeTaskBrief(ref, deps))!.taskBrief;
    expect(brief.status).toBe('current'); expect(brief.files.map(file => file.path)).toEqual(['target.ts']);
    expect(JSON.stringify(brief.excerpts)).toContain('OUTSIDE_CLAIM');
    expect(claimedScopePaths([{ payload: { paths: ['./a.ts'] }, title: 'Edit packages/x/ignored.ts' },
      { payload: {}, title: 'P-004 wire the reader', summary: 'Edit packages/x/target.ts now' }])).toEqual(['a.ts', 'packages/x/target.ts']);
  });
  it('suppresses intent briefs for claim-covered paths or unreadable ownership and refuses unsafe transient paths', async () => {
    const deps = depsFor(fixture()); deps.claimedPaths = vi.fn(async () => ['target.ts']);
    const ref = { owner: 'su-intent', workspaceId: 'w', harness: 'h', intent: 'Inspect target', paths: ['target.ts'] };
    expect(await getIntentTimeTaskBrief(ref, deps)).toBeNull();
    expect(await getIntentTimeTaskBrief({ ...ref, paths: ['./target.ts'] }, deps)).toBeNull();
    deps.claimedPaths = async () => { throw new Error('unavailable'); };
    expect(await getIntentTimeTaskBrief(ref, deps)).toBeNull(); expect(deps.root).not.toHaveBeenCalled();
    deps.claimedPaths = async () => [];
    const result = await getIntentTimeTaskBrief({ ...ref, paths: ['../private.ts', '.env', '**/*'] }, deps);
    expect(result?.taskBrief.status).toBe('unknown'); expect(deps.pack).not.toHaveBeenCalled();
    expect(result?.taskBrief.recover?.tool).toBe('coord:declare-intent');
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
  it('publishes the successful capture clock so native deadlines can be compared with passing calls', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root), pack = deps.pack;
    const timings: TaskBriefCaptureTiming[] = [];
    const diagnostics = channel(TASK_BRIEF_CAPTURE_CHANNEL);
    const observe = (message: unknown) => { timings.push(message as TaskBriefCaptureTiming); };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    deps.pack = async (...args) => {
      args[2]?.onPhase?.('identity');
      clock.mockReturnValue(10_007);
      args[2]?.onPhase?.('execution');
      clock.mockReturnValue(10_018);
      return pack(...args);
    };
    diagnostics.subscribe(observe);
    try {
      const result = await getClaimTimeTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
        payload: { paths: ['target.ts'] } } }, deps);
      expect(result?.taskBrief.status).toBe('current');
      expect(timings).toHaveLength(1);
      expect(timings[0]).toMatchObject({ workItem: 'WI-task', status: 'current', elapsedMs: 18 });
      expect(timings[0]?.phases).toEqual(expect.arrayContaining([
        { phase: 'safe-pack:identity', elapsedMs: 7 }, { phase: 'safe-pack:execution', elapsedMs: 11 },
      ]));
      expect(JSON.stringify(result)).not.toContain('elapsedMs');
    } finally { diagnostics.unsubscribe(observe); clock.mockRestore(); }
  });
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
      expect(result?.taskBrief.scope.paths).toEqual([]);
      expect(deps.pack).toHaveBeenCalledWith('pack', expect.objectContaining({ include: ['target.ts'] }), expect.anything());
      // The phase in flight AND how the window was spent (WI-6554700010018774):
      // every phase entered is listed in order with its elapsed time.
      expect(result?.taskBrief.exclusions).toHaveLength(2);
      expect(result?.taskBrief.exclusions[0]).toMatch(
        /^Task brief exceeded its bounded read deadline during safe-pack \(elapsed \d+ms; setup \d+ms, repository-root \d+ms, scope-read \d+ms, safe-pack \d+ms\)\.$/);
      expect(result?.taskBrief.exclusions[1]).toBe(
        'Scope paths are unknown because the bounded capture did not complete; an empty path list does not prove an empty input scope.',
      );
    } finally { vi.useRealTimers(); }
  }, 10_000);
  it.each(['flag-read', 'execution', 'artifact-write', 'preview'] as const)(
    'preserves the safe packer %s phase when the unchanged claim deadline wins', async stage => {
      const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
      const deps = depsFor(root);
      let packStarted: () => void = () => {};
      const started = new Promise<void>(resolve => { packStarted = resolve; });
      deps.pack = vi.fn((_op, _args, effects) => {
        effects?.onPhase?.(stage);
        packStarted();
        return new Promise<never>(() => {});
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const pending = getClaimTimeTaskBrief({ workspaceId: 'w', workItem: { id: 'WI-task', harness: 'h',
          payload: { paths: ['target.ts'] } } }, deps);
        await started;
        await vi.advanceTimersByTimeAsync(TASK_BRIEF_BUDGET_MS);
        const brief = (await pending)?.taskBrief;
        expect(brief?.status).toBe('unknown');
        expect(brief?.sourceFingerprint).toBeNull();
        expect(brief?.files).toEqual([]);
        expect(brief?.exclusions[0]).toContain(`during safe-pack:${stage} (`);
        expect(brief?.exclusions[0]).toMatch(/safe-pack:[a-z-]+ \d+ms/);
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
    expect(brief.status).toBe('unknown'); expect(brief.recover?.tool).toBe('code:pack'); expect(brief.excerpts).toEqual([]);
  });
  it('recovers the registered repository rather than a payload root and cites canonical cross-plan authority', async () => {
    const root = fixture(); writeFileSync(join(root, 'target.ts'), 'export function target() { return 1; }');
    const deps = depsFor(root);
    deps.decisions = vi.fn(async () => ({ planSlug: 'task-plan', totalDecisions: 2,
      totalLocalDecisions: 1, totalAffectedDecisions: 1, affectedDecisions: 1, authorityReadFailed: false,
      decisions: [{ id: 'D-003', title: 'local', snippet: 'body', provenance: { kind: 'unrecorded' as const } },
        { id: 'D-004', title: 'inbound', snippet: 'body', sourcePlanSlug: 'governing-plan',
          provenance: { kind: 'unrecorded' as const } }] }));
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
    expect(brief.decisions?.refs).toEqual([]); expect(brief.decisions?.recover?.args.slug).toBe('task-plan');
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
      decisions: Array.from({ length: 8 }, (_, i) => ({ id: `D-00${i + 1}`, title: 'authority', snippet: 'body',
        provenance: { kind: 'unrecorded' as const } })) });
    const brief = await buildTaskBrief({ workspaceId: 'papercusp-workspace', workItem: { id: 'WI-native-task', harness: 'papercusp',
      sourcePlanSlug: plan, payload: { paths } } }, deps);
    expect(brief.status).toBe('current');
    expect(brief.files.length).toBeGreaterThan(0);
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { rootPath: root, include: paths.slice().sort() } });
    expect(JSON.stringify(brief).length).toBeLessThanOrEqual(TASK_BRIEF_MAX_CHARS);
    expect(brief.exclusions.join(' ')).toMatch(/omitted/);
  });
});
