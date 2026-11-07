import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { readNativePushOutcomes } from './native-adoption';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import type { Rubric } from '../rubrics';
import { collectRecordedReuseWindows, evaluateReuseProvider, measureReuseMetrics, measureReuseWindow, readRecordedReuseWindows,
  measureRecordedReuseMetric, REUSE_MEASUREMENT_INSTRUMENT_KEYS, buildReuseSourcePopulation,
  collectReuseSourcePopulation, collectReuseSourcePopulationOffthread, collectRecordedReuseMetrics, applyReuseProviderDecision,
  reuseHoldout, summarizeReuseWindows, type ReuseMeasuredWindow, type ReuseMeasurementActivity,
  type ReuseMeasurementExposure } from './reuse-measurement';
import { composeReuseBrief } from './reuse-brief-providers';
import { createReuseCallColumns, serializeReuseCallColumns } from './reuse-source-population';
import { recordReuseBriefIssued } from './reuse-brief-ledger';

const at = '2026-10-01T00:00:00.000Z', now = '2026-10-01T00:31:00.000Z';
const exposure = (patch: Partial<ReuseMeasurementExposure> = {}): ReuseMeasurementExposure => ({
  id: 'e1', workspaceId: 'default', owner: 'owner', invocation: 'invocation', workItem: 'WI-1', provider: 'clones',
  at, issued: true, clientReceipt: null, selector: { paths: ['a.ts'], symbols: ['targetSymbol'] }, ...patch,
});
const activity = (patch: Partial<ReuseMeasurementActivity> = {}): ReuseMeasurementActivity => ({
  id: 'a1', workspaceId: 'default', owner: 'owner', at: '2026-10-01T00:01:00.000Z', tool: 'Read', status: 'ok', detail: { file: 'a.ts' }, ...patch,
});
const measure = (activities: ReuseMeasurementActivity[] = [], patch: Partial<ReuseMeasurementExposure> = {}, complete = true) =>
  measureReuseWindow({ exposure: exposure(patch), activities, now, activityCensusComplete: complete });

describe('R16 provider-specific recorded outcome windows', () => {
  it('pins independently precomputed provider/work-item hash cohorts across retries', () => {
    expect(reuseHoldout('WI-8', 'clones')).toBe(true);
    expect(reuseHoldout('WI-1', 'clones')).toBe(false);
    expect(reuseHoldout('WI-8', 'coverage')).toBe(false);
    expect(reuseHoldout('WI-12', 'coverage')).toBe(true);
    expect(() => measure([], { workItem: 'WI-8' })).toThrow('held-out');
  });
  it('partitions acted-on, not-acted-on and unknown without counting issuance as delivery', () => {
    const positive = measure([activity()]);
    const negative = measure([activity({ detail: { file: 'unrelated.ts' } })], { id: 'e2' });
    const unknown = measure([], { id: 'e3' }, false);
    expect(summarizeReuseWindows([positive, negative, unknown]).clones).toEqual({ issued: 3, delivered: 0, deliveryUnknown: 3,
      actedOn: { positive: 1, negative: 1, unknown: 1 }, grepAfterPush: { positive: 0, negative: 2, unknown: 1 } });
    expect(measure([], { clientReceipt: { ref: 'client-receipt:1', observedAt: now } }).delivered).toBe(true);
  });
  it.each(['clones', 'cochange', 'provenance', 'sql', 'coverage', 'semantic', 'grep', 'first-touch'])(
    'uses the declared selector for %s grep outcomes', provider => {
      expect(measure([activity({ tool: 'Grep', detail: { pattern: 'targetSymbol' } })], { provider }).grepAfterPush).toBe(true);
      expect(measure([activity({ tool: 'Grep', detail: { pattern: 'otherSymbol' } })], { provider }).grepAfterPush).toBe(false);
    });
  it('bounds the window to twenty invocations before the thirty-minute limit', () => {
    const activities = Array.from({ length: 21 }, (_, i) => activity({ id: String(i).padStart(2, '0'),
      at: new Date(Date.parse(at) + (i + 1) * 1_000).toISOString(), detail: { file: i === 20 ? 'a.ts' : 'other.ts' } }));
    const result = measure(activities);
    expect(result.endedBy).toBe('invocations');
    expect(result.end).toBe('2026-10-01T00:00:20.000Z');
    expect(result.activityIds).toHaveLength(20);
    expect(result.actedOn).toBe(false);
    expect(measure([activity({ at: '2026-10-01T00:30:01.000Z' })]).actedOn).toBe(false);
  });
  it('leaves open, missing, malformed and truncated activity unknown; preserves positives', () => {
    expect(measureReuseWindow({ exposure: exposure(), activities: [], now: at, activityCensusComplete: true }).actedOn).toBeNull();
    expect(measure([activity({ detail: null })]).actedOn).toBeNull();
    expect(measure([activity({ truncated: true })]).actedOn).toBeNull();
    expect(measure([activity({ detail: null }), activity({ id: 'a2' })]).actedOn).toBe(true);
    expect(measure([activity({ tool: 'Grep', detail: { pattern: '(target|other)' } })]).grepAfterPush).toBeNull();
    expect(measure([activity({ tool: 'Bash', detail: { command: "rg 'target.*' ." } })]).grepAfterPush).toBeNull();
  });
  it('anchors absolute paths to the activity harness and isolates unrelated owners', () => {
    const a = activity({ harness: 'fixture', detail: { file_path: '/fixture/a.ts' }, tool: 'mcp__papercusp_su__capability_read' });
    expect(measure([a]).actedOn).toBeNull();
    expect(measureReuseWindow({ exposure: exposure(), activities: [a], now, activityCensusComplete: true,
      repoRoots: new Map([['fixture', '/fixture']]) }).actedOn).toBe(true);
    expect(measure([activity({ owner: 'someone-else' })]).actedOn).toBe(false);
    expect(measure([activity({ workspaceId: 'foreign' })]).actedOn).toBe(false);
  });
  it('deduplicates evidence and refuses conflicting identities', () => {
    const w = measure([activity(), activity()]);
    expect(w.activityIds).toEqual(['a1']);
    expect(summarizeReuseWindows([w, w]).clones.issued).toBe(1);
    expect(() => measure([activity(), activity({ detail: null })])).toThrow('Conflicting');
    expect(() => summarizeReuseWindows([w, { ...w, actedOn: false }])).toThrow('Conflicting');
  });
  it('uses numeric invocation identity to break timestamp ties before applying the cap', () => {
    const rows = Array.from({ length: 21 }, (_, i) => activity({ id: String(i + 1),
      detail: { file: i === 20 ? 'a.ts' : 'other.ts' } }));
    const w = measure(rows.reverse());
    expect(w.activityIds).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(w.actedOn).toBe(false);
  });
});

describe('R16 frozen measurement units and efficacy', () => {
  it('derives exact added clone lines and a complete syntax-bound call census, including hidden locals and unresolved calls', () => {
    const body = Array.from({ length: 25 }, (_, n) => `  total += input + ${n};`).join('\n');
    const a = `export function sum(input:number) {\n  let total=0;\n${body}\n  return total;\n}\n`, b = a.replace('sum', 'copy');
    const sources = [{ path: 'a.ts', source: a }, { path: 'b.ts', source: b },
      { path: 'use.ts', source: 'import {sum} from "./a"; function local() {} local(); sum(2); missing();' }];
    const addedLines = { 'b.ts': b.trimEnd().split('\n').map((_, i) => i + 1) };
    const first = buildReuseSourcePopulation({ sources, addedLines, complete: true });
    expect(first.addedNonGeneratedLines).toBe(29);
    expect(first.duplicateAddedLines).toBe(29);
    expect(first.lineCensusComplete).toBe(true);
    expect(first.calls.map(c => [c.from, c.to, c.resolved])).toEqual([
      ['use.ts', 'use.ts', true], ['use.ts', 'a.ts', true], ['use.ts', null, false],
    ]);
    expect(first.callCensusComplete).toBe(true);
    expect(buildReuseSourcePopulation({ sources, addedLines, complete: true })).toEqual(first);
    expect(buildReuseSourcePopulation({ sources, addedLines: { ...addedLines, 'README.md': [1] }, complete: true }).lineCensusComplete).toBe(false);
    expect(buildReuseSourcePopulation({ sources, addedLines, complete: false }).callCensusComplete).toBe(false);
    // Git added-line identities count LF, even when TypeScript treats a bare
    // carriage return before the function as another source line.
    expect(buildReuseSourcePopulation({ sources: [sources[0]!, { path: 'b.ts', source: `const prefix=0;\r${b}` }],
      addedLines, complete: true }).duplicateAddedLines).toBe(29);
    // A lazy immutable reader must preserve the same independently enumerated
    // line and call population as the in-memory fixture, including repeats.
    const sourceMap = new Map(sources.map(s => [s.path, s.source]));
    expect(buildReuseSourcePopulation({ sourcePaths: [...sourceMap.keys()],
      readSource: path => sourceMap.get(path)!, addedLines, complete: true })).toEqual(first);
  });
  it('captures a complete immutable population larger than 128 MiB without truncating files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reuse-large-source-population-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    const commit = (date: string) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'controlled population'],
      { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    try {
      git('init', '-q');
      await writeFile(join(root, 'base.ts'), 'export const base = 1;\n');
      git('add', 'base.ts'); commit('2026-09-29T00:00:00Z');
      const source = `/*${'é'.repeat(512 * 1024)}*/\nexport function target() {} target();\n`;
      const paths = Array.from({ length: 129 }, (_, n) => `source-${n}.ts`);
      for (const path of paths) await writeFile(join(root, path), source);
      git('add', '.'); commit('2026-10-01T00:00:00Z');
      const result = await collectReuseSourcePopulation(root, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z');
      expect(Buffer.byteLength(source) * paths.length).toBeGreaterThan(128 * 1024 * 1024);
      expect(result).toMatchObject({ addedNonGeneratedLines: 258, duplicateAddedLines: 0,
        lineCensusComplete: true, callCensusComplete: true });
      expect(result.method.sourcePopulation).toEqual(['base.ts', ...paths].sort());
      expect(result.calls).toHaveLength(129);
      expect(new Set(result.calls.map(call => call.from))).toEqual(new Set(paths));
      expect(result.calls.every(call => call.resolved && call.to === call.from)).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);
  it('captures a historical committed source window despite later working-tree changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reuse-source-population-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Controlled measurement fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Controlled measurement fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    try {
      git('init', '-q'); await writeFile(join(root, 'a.ts'), 'export function target() {}\n');
      // Git uses committer date for rev-list windows: fix both clocks explicitly.
      const datedCommit = (message: string, date: string) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message],
        { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
      git('add', 'a.ts'); datedCommit('pinned baseline', '2026-09-29T00:00:00Z');
      await writeFile(join(root, 'a.ts'), 'export const added = 1;\nexport function target() {}\n');
      await writeFile(join(root, 'b.ts'), 'import { target } from "./a"; target();\n'); git('add', 'b.ts');
      const literalPaths = ['odd [x].ts', 'quote".ts', 'line\nbreak.ts', ':colon.ts'];
      for (const path of literalPaths) await writeFile(join(root, path), 'export const café = 1;\n');
      git('add', '.');
      datedCommit('window change', '2026-10-01T00:00:00Z');
      const phases: string[] = [];
      const pinned = await collectReuseSourcePopulation(root, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z', tmpdir(), phase => phases.push(phase));
      expect(phases).toEqual(['source-tree', 'source-capture', 'source-diff', 'source-clones', 'source-calls']);
      // The shared history policy excludes newline paths; batching must retain
      // every eligible literal identity without interpreting pathspec syntax.
      expect(pinned).toMatchObject({ addedNonGeneratedLines: 5, callCensusComplete: true });
      expect(pinned.method.sourcePopulation).toEqual(['a.ts', 'b.ts', ...literalPaths.filter(path => !path.includes('\n'))].sort());
      expect(pinned.method.addedLinePopulation).toEqual(expect.arrayContaining([
        { path: 'a.ts', lines: [1] }, { path: 'b.ts', lines: [1] },
        ...literalPaths.filter(path => !path.includes('\n')).map(path => ({ path, lines: [1] })),
      ]));
      expect(pinned.calls).toEqual([expect.objectContaining({ from: 'b.ts', to: 'a.ts', resolved: true })]);
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      try {
        expect(await collectReuseSourcePopulationOffthread(root, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z')).toEqual(pinned);
        expect(ticks).toBeGreaterThan(0);
      } finally { clearInterval(timer); }
      await writeFile(join(root, 'b.ts'), 'not historical source');
      expect(await collectReuseSourcePopulation(root, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z')).toEqual(pinned);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('removes source captures after a worker times out before answering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reuse-worker-cleanup-fixture-'));
    const marker = join(root, 'capture-path'), workerPath = join(root, 'worker.mjs');
    try {
      await writeFile(workerPath, `import {writeFileSync} from 'node:fs';
        process.once('message', job => {
          writeFileSync(${JSON.stringify(marker)}, job.captureRoot);
          writeFileSync(job.captureRoot + '/immutable-blob', 'captured source');
          setInterval(() => {}, 1000);
        });`);
      await expect(collectReuseSourcePopulationOffthread(root, at, now, { workerPath, budgetMs: 5000 }))
        .rejects.toThrow('deadline');
      const capture = await readFile(marker, 'utf8');
      expect(capture).toContain('reuse-source-worker-');
      expect(existsSync(capture)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);
  it('measures exact units and keeps unresolved populations separate', () => {
    expect(measureReuseMetrics({ addedNonGeneratedLines: 200, duplicateAddedLines: 10, lineCensusComplete: true,
      callCensusComplete: true, workItems: [
        { id: 'a', eligible: true, firstWriteAt: now, successfulSearchAt: at, complete: true },
        { id: 'b', eligible: true, firstWriteAt: at, successfulSearchAt: now, complete: true },
        { id: 'c', eligible: true, firstWriteAt: null, successfulSearchAt: null, complete: false },
      ], calls: [{ id: '1', resolved: true, from: 'a', to: 'b' }, { id: '2', resolved: true, from: 'a', to: 'a' },
        { id: '3', resolved: false, from: 'a', to: null }] })).toMatchObject({
      redundancy: { value: 50, numerator: 10, denominator: 200 }, searchBeforeWrite: { value: 0.5, unknown: 1 },
      crossFileCalls: { value: 0.5, denominator: 2, unknown: 1 },
    });
    expect(measureReuseMetrics({ addedNonGeneratedLines: 0, duplicateAddedLines: 0, lineCensusComplete: true,
      callCensusComplete: true, workItems: [], calls: [] }).redundancy.value).toBeNull();
  });
  const population = (treatment: boolean, holdout: boolean): ReuseMeasuredWindow[] => {
    const windows: ReuseMeasuredWindow[] = [];
    for (let i = 0, t = 0, h = 0; t < 100 || h < 100; i++) {
      const workItem = `WI-${i}`, held = reuseHoldout(workItem, 'clones');
      if (held ? h >= 100 : t >= 100) continue;
      const w = measure([], { id: `e${i}`, workItem, issued: !held });
      w.actedOn = w.grepAfterPush = held ? holdout : treatment;
      windows.push(w); if (held) h++; else t++;
    }
    return windows;
  };
  const evaluate = (windows: ReuseMeasuredWindow[], patch = {}) => evaluateReuseProvider({ provider: 'clones',
    workspaceId: 'default', experimentStartedAt: at, now: '2026-10-16T00:00:00.000Z', windows, ...patch });
  it('disables only a mature ineffective population and retains a mature beneficial population', () => {
    const disabled = evaluate(population(false, true));
    expect(disabled).toMatchObject({ mature: true, confidence: 'measured', action: 'disable', reversible: true });
    expect(disabled.arms.treatment.actedOn.interval!.upper).toBeLessThan(disabled.arms.holdout.actedOn.interval!.lower);
    expect(evaluate(population(true, false))).toMatchObject({ mature: true, action: 'keep' });
    const mixed = population(false, true).map(w => ({ ...w, grepAfterPush: !w.holdout }));
    expect(evaluate(mixed).action).toBe('keep');
  });
  it('refuses disabling on immature, unknown, stale or foreign populations', () => {
    const windows = population(false, true);
    expect(evaluate(windows, { now: '2026-10-02T00:00:00.000Z' })).toMatchObject({ mature: false, action: 'keep', confidence: 'unknown' });
    expect(evaluate(windows.map(w => ({ ...w, actedOn: null })))).toMatchObject({ mature: false, action: 'keep' });
    expect(evaluate(windows, { now: '2026-11-01T00:00:00.000Z' }).mature).toBe(false);
    expect(evaluate(windows, { workspaceId: 'foreign' }).mature).toBe(false);
    expect(evaluate([...windows, ...windows]).arms.treatment.actedOn.observed).toBe(100);
    expect(() => evaluate(windows.map(w => ({ ...w, holdout: !w.holdout })))).toThrow('cohort');
  });
});

describe('R16 repeatable existing-ledger reads', () => {
  let fx: PlanPgFixture;
  beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 180_000);
  afterAll(async () => { await fx?.dispose(); });
  it('R13 canonical active-rubric checks bind scorecard ledger identities', async () => {
    const { proposeRubric, getRubric } = await import('../rubrics');
    const { rescoreRubric } = await import('../harness/routines/rubric-rescore-action');
    const { runInstrumentChecks, readLatestRubricCheckResults } = await import('../check-results-ledger');
    const { emitScorecard, scorecardEmitArgs, _closeScorecardEmitMutexForTests } = await import('../agent-tools/scorecards/emit');
    const { runWithWorkspace } = await import('../workspace-als');
    const snapshots = JSON.parse(await readFile(new URL('../../test/fixtures/unified-learning-active-rubrics.json', import.meta.url), 'utf8'));
    const source = snapshots.rubrics.find((r: Rubric) => r.rubricId === 'code-intel-reuse-measurement') as Rubric;
    expect(source).toMatchObject({ status: 'active', revision: 8,
      criteriaHash: '8fa50bf367007267c5b2f863d69460438b1d698d38c365d718d2ca9a2b6679b2' });
    await runWithWorkspace(source.workspaceId, async () => {
    // Install the exact live definition into the isolated store. The check and
    // scorecard paths read it back themselves; no getRubric/resolver is mocked.
    await proposeRubric({ rubricId: source.rubricId, kind: 'standard', characteristic: source.characteristic,
      title: source.title, description: source.description, criteria: source.criteria,
      methodRef: source.methodRef ?? undefined, ratingScale: source.ratingScale, status: 'active',
      by: source.createdBy ?? 'su-r13-rubric-author' });
    const active = await getRubric(source.rubricId);
    expect(active).toMatchObject({ status: 'active', criteriaHash: source.criteriaHash });
    expect(active!.criteria.map(c => c.key)).toEqual(source.criteria.map(c => c.key));
    const harness = 'r13-canonical-reuse', stamp = new Date(Date.now() - 60_000).toISOString();
    const choices = [ ['authored', 'success'], ['automatic-match', 'success'],
      ['saved-replay', 'success'], ['saved-replay', 'error'], ['saved-replay', 'refused'] ];
    for (const [index, [selection, outcome]] of choices.entries()) {
      const callId = `r13-canonical-${index}`;
      await fx.admin`INSERT INTO harness_shared.tool_invocations
        (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,transport,metadata_json)
        VALUES (${source.workspaceId},${harness},'agent-mcp','recipes:run','operator','r13-canonical','r13',${stamp}::timestamptz,'ok','mcp',
          ${fx.admin.json({ otel: { callId }, returnedContextBytes: 20, spillPending: false, resultDoorReason: 'within-budget' })})`;
      await fx.admin`INSERT INTO harness_shared.code_recipe_runs
        (recipe_id,workspace_id,agent_owner,agent_role,success,reused,execution_trace,ts)
        VALUES ('r13-canonical',${source.workspaceId},'r13-agent','operator',${outcome === 'success'},true,
          ${fx.admin.json({ usage: { version: 1, choice: 'agent', selection, outcome, mode: 'commit', settled: true },
            runEvidence: { version: 1, invocationId: callId, attempt: 0, executed: outcome !== 'refused',
              sourceBytes: 10, intermediateBytes: 5, elapsedBeforeRecordMs: 1 } })},${stamp}::timestamptz)`;
    }
    const scored = await rescoreRubric({ rubricRef: source.rubricId, workspaceId: source.workspaceId, harnessSlug: harness }, {
      runInstruments: value => runInstrumentChecks(value), emit: async () => ({}) as never,
    });
    expect(scored).toMatchObject({ executed: 4 });
    expect(scored.testRunIds).toHaveLength(4);
    const latest = await readLatestRubricCheckResults({ rubricRef: source.rubricId, workspaceId: source.workspaceId });
    const row = [...latest.values()].find(r => r.check.criterionKey === 'provider-outcomes')!;
    expect(scored.testRunIds).toContain(row.testRunId);
    expect(row).toMatchObject({ status: 'error', check: { rubricRef: source.rubricId, kind: 'instrument', value: null } });
    const report = JSON.parse(row.detail!).recipeOutcomes;
    expect(report).toMatchObject({ lineage: { rubricRef: source.rubricId, criterionKey: 'provider-outcomes',
      instrumentKey: REUSE_MEASUREMENT_INSTRUMENT_KEYS.providerOutcomes },
      measurement: { authored: 1, automaticMatches: 1, deliberateSelections: 3, replaySuccesses: 1,
        replayErrors: 1, replayRefusals: 1, replayDenominator: 3, sourceBytes: 50, intermediateBytes: 25,
        elapsedBeforeRecordMs: 5, returnedContextBytes: 100 },
      coverage: { state: 'unknown', complete: false }, benefit: { state: 'unknown', measuredSavings: null },
      units: { sourceBytes: 'utf8-bytes-per-receipt', returnedContextBytes: 'utf8-bytes-per-dispatch-at-settled-result-door' } });
    const procedure = JSON.parse(row.check.provenance!.procedure.snapshot);
    expect(procedure).toMatchObject({ instrumentKey: REUSE_MEASUREMENT_INSTRUMENT_KEYS.providerOutcomes,
      window: { workspaceId: source.workspaceId, harnessSlug: harness } });
    try {
      const card = await emitScorecard(scorecardEmitArgs.parse({ rubricRef: source.rubricId, fromLedger: true }),
        { createdBy: 'su-r13-independent-grader', ctxHarness: harness, workspaceId: source.workspaceId },
        { dispatchTool: async () => { throw new Error('ledger emission must not re-execute a check'); } });
      expect(card.ok).toBe(true);
      if (!('issueId' in card) || typeof card.issueId !== 'string') throw new Error(JSON.stringify(card));
      const [stored] = await fx.admin`SELECT payload FROM harness_shared.work_items WHERE feature_id=${card.issueId}`;
      expect(stored!.payload.observation.ratings['provider-outcomes']).toMatchObject({ rating: 'unknown', ratedFrom: 'ledger',
        evidenceRef: `test_runs:${row.testRunId}`, ledgerResult: { testRunId: row.testRunId, value: null } });
      expect((await readLatestRubricCheckResults({ rubricRef: source.rubricId, workspaceId: source.workspaceId })).size).toBe(4);
    } finally { await _closeScorecardEmitMutexForTests(); }
    });
  }, 120_000);
  it('recomputes persisted call columns and rejects damaged raw sites without using a saved score', async () => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'packed-producer', windowStart: at, windowEnd: now };
    const columns = createReuseCallColumns();
    columns.sink({ path: 'a.ts', line: 1, column: 1 }, 'a.ts', 0);
    columns.sink({ path: 'a.ts', line: 2, column: 1 }, 'b.ts', 1);
    columns.sink({ path: 'b.ts', line: 1, column: 1 }, null, 2);
    const record = { schema: 'reuse-metrics-v1', harness: scope.harnessSlug, windowStart: at, windowEnd: now,
      sourceRefs: ['git:packed-base', 'git:packed-end'], callColumns: serializeReuseCallColumns(columns.finish()),
      population: { calls: [], workItems: [], addedNonGeneratedLines: null, duplicateAddedLines: null,
        lineCensusComplete: false, callCensusComplete: true } };
    const write = async () => {
      const raw = JSON.stringify(record);
      const subject = JSON.stringify({ schema: 'reuse-metrics-ref-v1', harness: scope.harnessSlug,
        windowStart: at, windowEnd: now, sha256: createHash('sha256').update(raw).digest('hex') });
      await fx.admin`INSERT INTO harness_shared.code_intel_reuse_measurements (workspace_id, owner_id, turn_id, kind, subject, payload)
        VALUES (${fx.workspaceId}, 'packed-source', ${now}, 'reuse-metrics', ${subject}, ${raw})`;
    };
    await write();
    const result = await measureRecordedReuseMetric(fx.admin, scope, 'crossFileCalls');
    expect(result).toMatchObject({ verdict: 'pass', value: 50 });
    expect(JSON.parse(result.detail).measurement).toMatchObject({ numerator: 1, denominator: 2, unknown: 1 });
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).verdict).toBe('unknown');
    record.population.callCensusComplete = false;
    await write();
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'crossFileCalls')).verdict).toBe('unknown');
    record.callColumns.blocks[0] = 'broken';
    await write();
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'crossFileCalls')).verdict).toBe('unknown');
  });
  it('records hash-pinned raw metric populations, then the registered reader recomputes and rejects corrupted evidence', async () => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'raw-producer', windowStart: at, windowEnd: now };
    const load = async () => ({ ...buildReuseSourcePopulation({ sources: [{ path: 'a.ts', source: 'export function a() {} a();' }],
      addedLines: { 'a.ts': [1] }, complete: true }), sourceRefs: ['git:controlled-base', 'git:controlled-end'], base: 'controlled-base', commit: 'controlled-end' });
    await collectRecordedReuseMetrics(fx.admin, scope, load);
    expect(await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).toMatchObject({ verdict: 'pass', value: 0 });
    expect(await measureRecordedReuseMetric(fx.admin, scope, 'crossFileCalls')).toMatchObject({ verdict: 'pass', value: 0 });
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'searchBeforeWrite')).verdict).toBe('unknown');
    await fx.admin`UPDATE harness_shared.code_intel_reuse_measurements SET payload = payload || 'corrupted'
      WHERE workspace_id = ${fx.workspaceId} AND kind = 'reuse-metrics' AND subject::jsonb->>'harness' = 'raw-producer'`;
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).verdict).toBe('unknown');
  });
  it('counts a recorded search-before-write positive only through a unique exact assignment', async () => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'assignment-producer', windowStart: at, windowEnd: now };
    const load = async () => ({ ...buildReuseSourcePopulation({ sources: [{ path: 'a.ts', source: 'export const a=1;' }],
      addedLines: { 'a.ts': [1] }, complete: true }), sourceRefs: ['git:assignment-baseline', 'git:assignment-end'], base: 'assignment-baseline', commit: 'assignment-end' });
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,status,title,summary,taken_by,taken_at,created_ts,updated_ts)
      VALUES (${fx.workspaceId},'assignment-producer','WI-measurement-assignment','feature','open','fixture','fixture','assignment-owner',${at},1,1)`;
    for (const [tool, minute] of [['Grep',1],['Edit',2]] as const) await fx.admin`
      INSERT INTO harness_shared.agent_activity(workspace_id,owner_id,harness_slug,kind,phase,tool_name,status,detail,created_at)
      VALUES (${fx.workspaceId},'assignment-owner','assignment-producer','tool','post',${tool},'ok','{}'::jsonb,
        ${`2026-10-01T00:0${minute}:00.000Z`}::timestamptz)`;
    expect((await collectRecordedReuseMetrics(fx.admin,scope,load)).population.workItems[0]!.complete).toBe(false);
    const census = [{ref:'fixture:complete-assignment-activity',owner:'assignment-owner',start:at,end:now}];
    expect((await collectRecordedReuseMetrics(fx.admin,scope,load,census)).population.workItems).toMatchObject([
      { id:'WI-measurement-assignment',complete:true,firstWriteAt:'2026-10-01T00:02:00.000Z',successfulSearchAt:'2026-10-01T00:01:00.000Z' }]);
    expect(await measureRecordedReuseMetric(fx.admin,scope,'searchBeforeWrite')).toMatchObject({verdict:'pass',value:100});
    await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,status,title,summary,taken_by,taken_at,created_ts,updated_ts)
      VALUES (${fx.workspaceId},'assignment-producer','WI-measurement-overlap','feature','open','fixture','fixture','assignment-owner',${at},1,1)`;
    expect((await collectRecordedReuseMetrics(fx.admin,scope,load,census)).population.workItems.every(w=>!w.complete)).toBe(true);
    expect((await measureRecordedReuseMetric(fx.admin,scope,'searchBeforeWrite')).verdict).toBe('unknown');
  });
  it('retains call and assignment measurements when immutable Git additions include binary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reuse-binary-population-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    const commit = (date: string) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'binary population fixture'],
      { env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'binary-producer', windowStart: at, windowEnd: now };
    try {
      git('init', '-q');
      await writeFile(join(root, 'a.ts'), 'export function target() {}\n');
      git('add', '.'); commit('2026-09-29T00:00:00Z');
      const base = git('rev-parse', 'HEAD').trim();
      await writeFile(join(root, 'b.ts'), 'import { target } from "./a"; target();\n');
      await writeFile(join(root, 'asset.bin'), Buffer.from([0, 255, 1, 254]));
      git('add', '.'); commit('2026-10-01T00:10:00Z');
      const end = git('rev-parse', 'HEAD').trim();
      // Neither later working bytes nor an unknown line denominator may erase
      // independently observable cross-file calls and search-before-write.
      await writeFile(join(root, 'b.ts'), 'uncommitted();\n');
      await fx.admin`INSERT INTO harness_shared.work_items
        (workspace_id,harness_slug,feature_id,item_kind,status,title,summary,taken_by,taken_at,created_ts,updated_ts)
        VALUES (${fx.workspaceId},'binary-producer','WI-binary-assignment','feature','open','fixture','fixture','binary-owner',${at},1,1)`;
      for (const [tool, minute] of [['Grep',1],['Edit',2]] as const) await fx.admin`
        INSERT INTO harness_shared.agent_activity(workspace_id,owner_id,harness_slug,kind,phase,tool_name,status,detail,created_at)
        VALUES (${fx.workspaceId},'binary-owner','binary-producer','tool','post',${tool},'ok','{}'::jsonb,
          ${`2026-10-01T00:0${minute}:00.000Z`}::timestamptz)`;
      const phases: string[] = [];
      const load = () => collectReuseSourcePopulation(root, at, now, tmpdir(), phase => phases.push(phase));
      const collected = await collectRecordedReuseMetrics(fx.admin, scope, load,
        [{ ref: 'fixture:complete-binary-activity', owner: 'binary-owner', start: at, end: now }]);
      expect(collected.population).toMatchObject({ addedNonGeneratedLines: null, duplicateAddedLines: null,
        lineCensusComplete: false, callCensusComplete: true, method: {
          binaryChangedPaths: ['asset.bin'], sourcePopulation: ['a.ts', 'b.ts'], addedLinePopulation: [{ path: 'b.ts', lines: [1] }],
          cloneVersion: null, cloneCensus: { status: 'unknown', reason: 'binary-additions', computed: false },
        } });
      expect(phases).toEqual(['source-tree', 'source-capture', 'source-diff', 'source-calls']);
      const oracle = buildReuseSourcePopulation({ complete: true, addedLines: { 'b.ts': [1] }, sources: [
        { path: 'a.ts', source: 'export function target() {}\n' },
        { path: 'b.ts', source: 'import { target } from "./a"; target();\n' },
      ] });
      expect(collected.population.calls).toEqual(oracle.calls);
      expect(collected.population.callCensusComplete).toBe(oracle.callCensusComplete);
      expect(collected.population.calls).toEqual([expect.objectContaining({ from: 'b.ts', to: 'a.ts', resolved: true })]);
      expect(collected.sourceRefs).toEqual(expect.arrayContaining([`git:${base}`, `git:${end}`]));
      expect(collected.population.workItems).toMatchObject([{ id: 'WI-binary-assignment', complete: true,
        firstWriteAt: '2026-10-01T00:02:00.000Z', successfulSearchAt: '2026-10-01T00:01:00.000Z' }]);
      expect(await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).toMatchObject({ verdict: 'unknown' });
      expect(await measureRecordedReuseMetric(fx.admin, scope, 'crossFileCalls')).toMatchObject({ verdict: 'pass', value: 100 });
      expect(await measureRecordedReuseMetric(fx.admin, scope, 'searchBeforeWrite')).toMatchObject({ verdict: 'pass', value: 100 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('persists mature disable evidence before using the flag writer, while immature evidence never writes', async () => {
    const windows: ReuseMeasuredWindow[] = [];
    for (let i=0,t=0,h=0;t<100||h<100;i++) {
      const workItem = `WI-${i}`, held = reuseHoldout(workItem, 'clones');
      if (held ? h>=100 : t>=100) continue;
      const w = measure([], { id: `action-${i}`, workspaceId: fx.workspaceId, workItem, issued: !held });
      w.actedOn = w.grepAfterPush = held; windows.push(w); if (held) h++; else t++;
    }
    const input = { provider: 'clones', workspaceId: fx.workspaceId, experimentStartedAt: at,
      now: '2026-10-16T00:00:00.000Z', windows };
    const changes: boolean[] = [];
    const write = async (_provider: string, enabled: boolean) => {
      const rows = await fx.admin`SELECT payload FROM harness_shared.code_intel_reuse_measurements
        WHERE workspace_id = ${fx.workspaceId} AND kind = 'reuse-provider-action'`;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toMatchObject({ decision: { action: 'disable' }, reversal: { enabled: true } });
      changes.push(enabled); return { ok: true };
    };
    expect(await applyReuseProviderDecision(fx.admin, { ...input, now: '2026-10-02T00:00:00.000Z' }, write)).toMatchObject({ applied: false });
    expect(changes).toEqual([]);
    expect(await applyReuseProviderDecision(fx.admin, input, write)).toMatchObject({ applied: true, reversal: { enabled: true } });
    expect(changes).toEqual([false]);
  });
  it('repeats the same scoped result without changing issued rows or coercing unknowns', async () => {
    const window = measure([activity()], { workspaceId: fx.workspaceId });
    const subject = JSON.stringify({ schema: 'reuse-measurement-v1', sourceRefs: ['fixture:known-activity-population'],
      observation: { exposure: exposure({ workspaceId: fx.workspaceId }), activities: [activity()], now, activityCensusComplete: true } });
    await fx.admin`INSERT INTO harness_shared.code_intel_reuse_measurements
      (workspace_id, owner_id, turn_id, kind, subject, recorded_at)
      VALUES (${fx.workspaceId}, 'owner', 'fixture-turn', 'reuse-measurement', ${subject}, ${at})`;
    await fx.admin`INSERT INTO harness_shared.code_intel_pushes
      (workspace_id, owner_id, turn_id, leg, subject, chars, pushed_at)
      VALUES (${fx.workspaceId}, 'owner', 'fixture-turn', 'reuse-clones', 'issued-only', 100, ${at})`;
    const input = { workspaceId: fx.workspaceId, start: at, end: now };
    const first = await readRecordedReuseWindows(fx.admin, input), second = await readRecordedReuseWindows(fx.admin, input);
    expect(first).toEqual([window]); expect(second).toEqual(first);
    expect(summarizeReuseWindows(first)).toEqual(summarizeReuseWindows(second));
    expect(await readRecordedReuseWindows(fx.admin, { ...input, workspaceId: 'foreign' })).toEqual([]);
    const rows = await fx.admin`SELECT chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = 'owner' ORDER BY id`;
    expect(rows.map(r => r.chars)).toEqual([100]);
    const issued = await readNativePushOutcomes({ workspaceId: fx.workspaceId, windowStart: at, windowEnd: now }, fx.admin);
    expect(issued.map(r => r.leg)).toEqual(['reuse-clones']);
    // Changing the RAW event changes the recomputed outcome; replaying a stored
    // verdict would keep the old positive and fail this assertion.
    const altered = JSON.parse(subject);
    altered.observation.activities[0].detail.file = 'unrelated.ts';
    await fx.admin`UPDATE harness_shared.code_intel_reuse_measurements SET subject = ${JSON.stringify(altered)}
      WHERE workspace_id = ${fx.workspaceId} AND kind = 'reuse-measurement'`;
    expect((await readRecordedReuseWindows(fx.admin, input))[0]!.actedOn).toBe(false);
  });
  it('registered instruments recompute exact-window raw populations with explicit ledger units', async () => {
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'fixture', windowStart: at, windowEnd: now };
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).verdict).toBe('unknown');
    const record = { schema: 'reuse-metrics-v1', harness: 'fixture', windowStart: at, windowEnd: now,
      sourceRefs: ['fixture:line-changes', 'fixture:tool-invocations', 'fixture:resolved-calls'], population: {
        addedNonGeneratedLines: 200, duplicateAddedLines: 10, lineCensusComplete: true, callCensusComplete: true,
        workItems: [{ id: 'a', eligible: true, firstWriteAt: now, successfulSearchAt: at, complete: true }],
        calls: [{ id: 'a', resolved: true, from: 'a.ts', to: 'b.ts' }],
      } };
    await fx.admin`INSERT INTO harness_shared.code_intel_reuse_measurements
      (workspace_id, owner_id, turn_id, kind, subject)
      VALUES (${fx.workspaceId}, 'metric-fixture', 'turn', 'reuse-metrics', ${JSON.stringify(record)})`;
    for (const metric of ['redundancy', 'searchBeforeWrite', 'crossFileCalls'] as const) {
      const instrument = getRegisteredInstrument(REUSE_MEASUREMENT_INSTRUMENT_KEYS[metric]);
      expect(instrument?.evaluator).toBe('platform');
      if (instrument?.evaluator !== 'platform') throw new Error('Missing registered metric');
      const result = await instrument.rescore!.resolve(scope);
      expect(result).toMatchObject({ verdict: 'pass', value: metric === 'redundancy' ? 50 : 100 });
      expect(instrument.rescore!.unit).toBe(metric === 'redundancy' ? 'count' : '%');
    }
    const rubric = { ref: 'reuse-measurement-fixture', workspaceId: fx.workspaceId,
      subjectPlan: 'reuse-metrics-fixture', subjectHarnessSlug: 'fixture',
      criteria: Object.values(REUSE_MEASUREMENT_INSTRUMENT_KEYS)
        .map(key => ({ key, check: { kind: 'instrument', instrumentKey: key } })) } as unknown as Rubric;
    const subject = { kind: 'plan', ref: 'reuse-metrics-fixture', windowStart: at, windowEnd: now } as const;
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now: () => Date.parse(now) });
    expect(snapshots?.[REUSE_MEASUREMENT_INSTRUMENT_KEYS.redundancy]).toMatchObject({
      verdict: 'pass', provenance: 'platform-computed', value: { quantity: 50, unit: 'count' } });
    expect(snapshots?.[REUSE_MEASUREMENT_INSTRUMENT_KEYS.searchBeforeWrite]).toMatchObject({
      verdict: 'pass', value: { quantity: 100, unit: '%' } });
    const unscoped = await resolveScorecardInstrumentSnapshots({ rubric: { ...rubric, subjectHarnessSlug: undefined }, subject },
      { now: () => Date.parse(now) });
    expect(unscoped?.[REUSE_MEASUREMENT_INSTRUMENT_KEYS.redundancy]?.verdict).toBe('unknown');
    expect((await measureRecordedReuseMetric(fx.admin, { ...scope, harnessSlug: 'other' }, 'redundancy')).verdict).toBe('unknown');
    expect((await measureRecordedReuseMetric(fx.admin, { ...scope, windowEnd: '2026-10-02T00:00:00.000Z' }, 'redundancy')).verdict).toBe('unknown');
    record.population.duplicateAddedLines = 20;
    await fx.admin`UPDATE harness_shared.code_intel_reuse_measurements SET subject = ${JSON.stringify(record)}
      WHERE workspace_id = ${fx.workspaceId} AND kind = 'reuse-metrics' AND owner_id = 'metric-fixture'`;
    expect((await measureRecordedReuseMetric(fx.admin, scope, 'redundancy')).value).toBe(100);
  });
  it('collects actual composition, push and activity rows for both arms; recollection updates raw evidence without duplicate outcomes', async () => {
    const owner = 'live-collector-fixture', start = '2026-10-03T00:00:00.000Z', end = '2026-10-03T00:31:00.000Z';
    const context = { surface: 'claim' as const, workspaceId: fx.workspaceId, owner,
      invocation: 'controlled-collector-dispatch', workItem: 'WI-12', paths: ['clones.ts', 'coverage.ts'],
      sourceVersion: 'controlled-source-v1', repository: { workspaceId: fx.workspaceId, rootPath: '/fixture', harness: 'collector-fixture' } };
    const composed = await composeReuseBrief({ base: { mandatory: 'retained', advice: [] as string[] }, context,
      deadline: Date.now() + 6000, enabled: async () => true,
      append: (base, contribution) => ({ ...base, advice: [...base.advice, contribution.text] }),
      providers: (['clones', 'coverage'] as const).map(id => ({ id, read: async () => ({ status: 'measured' as const,
        sourceVersion: context.sourceVersion, indexVersion: 'controlled-index', lines: [`${id}.ts:1 candidate`], citedPaths: [`${id}.ts`] }) })) });
    expect(composed.observations.map(row => row.status)).toEqual(['issued', 'held-out']);
    await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${fx.workspaceId}, ${owner}, 'collector-turn')`;
    expect(await recordReuseBriefIssued({ context, observations: composed.observations,
      recover: { tool: 'work_items:get', args: { id: 'WI-12' } } }, new AbortController().signal)).toBe(true);
    await fx.admin`UPDATE harness_shared.code_intel_pushes SET pushed_at = ${start}::timestamptz
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}`;
    const insertActivity = async (tool: string, detail: object, suffix: string, activityOwner = owner) => fx.admin`
      INSERT INTO harness_shared.agent_activity (workspace_id, owner_id, harness_slug, kind, phase, tool_name, status, detail, created_at)
      VALUES (${fx.workspaceId}, ${activityOwner}, 'collector-fixture', 'tool', 'post', ${tool}, 'ok',
        ${JSON.stringify(detail)}::jsonb, ${`2026-10-03T00:0${suffix}:00.000Z`}::timestamptz)`;
    await insertActivity('Read', { file_path: '/fixture/clones.ts' }, '1');
    await insertActivity('Grep', { pattern: 'coverage.ts' }, '2');
    await insertActivity('Read', { file: 'coverage.ts' }, '3', 'foreign-owner');
    const scope = { workspaceId: fx.workspaceId, harnessSlug: 'collector-fixture', start, end, now: end,
      repoRoots: new Map([['collector-fixture', '/fixture']]) };
    const first = await collectRecordedReuseWindows(fx.admin, scope);
    expect(first.rejected).toEqual([]);
    expect(first.recorded).toHaveLength(2);
    expect(first.windows.find(w => w.exposure.provider === 'clones')).toMatchObject({ issued: true, holdout: false,
      delivered: null, actedOn: true, grepAfterPush: null, complete: false });
    expect(first.windows.find(w => w.exposure.provider === 'coverage')).toMatchObject({ issued: false, holdout: true,
      delivered: null, actedOn: null, grepAfterPush: true, complete: false });
    expect((await collectRecordedReuseWindows(fx.admin, scope)).recorded).toEqual([]);
    expect(await readRecordedReuseWindows(fx.admin, scope)).toEqual(expect.arrayContaining(first.windows));
    expect((await collectRecordedReuseWindows(fx.admin, { ...scope, harnessSlug: 'foreign' })).windows).toEqual([]);
    const largeDetail = Array.from({ length: 160 }, (_, i) => createHash('sha256').update(`activity-${i}`).digest('hex')).join('');
    await insertActivity('Read', { file: 'coverage.ts', retainedDiagnostic: largeDetail }, '4');
    await collectRecordedReuseWindows(fx.admin, scope);
    const latest = await readRecordedReuseWindows(fx.admin, scope);
    expect(latest).toHaveLength(2);
    expect(latest.find(w => w.exposure.provider === 'coverage')!.actedOn).toBe(true);
    const raw = await fx.admin`SELECT subject, payload FROM harness_shared.code_intel_reuse_measurements
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} AND kind = 'reuse-measurement' ORDER BY id DESC LIMIT 1`;
    expect(raw[0]!.subject.length).toBeLessThan(256);
    expect(JSON.parse(raw[0]!.payload).sourceRefs).toContainEqual(expect.stringMatching(/^agent-activity:\d+$/));
    // SPEC-P-006-C: the collector writes no measurement row into the delivered-push log.
    const pushed = await fx.admin`SELECT leg FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} ORDER BY id`;
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.map(r => r.leg).filter(leg => ['reuse-measurement', 'reuse-metrics', 'reuse-provider-action'].includes(leg))).toEqual([]);
    const instrument = getRegisteredInstrument(REUSE_MEASUREMENT_INSTRUMENT_KEYS.providerOutcomes);
    if (instrument?.evaluator !== 'platform') throw new Error('Missing provider outcome instrument');
    const live = await instrument.rescore!.resolve({ workspaceId: fx.workspaceId, harnessSlug: 'collector-fixture',
      windowStart: start, windowEnd: end });
    expect(live.verdict).toBe('unknown'); // Four providers have no exposure census.
    const detail = JSON.parse(live.detail!);
    expect(detail.recipeOutcomes).toMatchObject({
      scope: { workspaceId: fx.workspaceId, harnessSlug: 'collector-fixture', windowStart: start, windowEnd: end },
      measurement: { attempts: 0 }, coverage: { state: 'unknown', complete: false },
      lineage: { criterionKey: 'provider-outcomes', instrumentKey: REUSE_MEASUREMENT_INSTRUMENT_KEYS.providerOutcomes },
    });
    expect(detail.byProvider.coverage).toMatchObject({ issued: 0, deliveryUnknown: 1,
      actedOn: { positive: 1, negative: 0, unknown: 0 }, grepAfterPush: { positive: 1 } });
    expect(detail.notObserved.sort()).toEqual(['cochange', 'provenance', 'semantic', 'sql']);
    expect(detail.recommendations.every((r: { action: string; mature: boolean }) => r.action === 'keep' && !r.mature)).toBe(true);
    await fx.admin`UPDATE harness_shared.code_intel_reuse_measurements SET payload = payload || ' '
      WHERE workspace_id = ${fx.workspaceId} AND id = (SELECT max(id) FROM harness_shared.code_intel_reuse_measurements
        WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} AND kind = 'reuse-measurement')`;
    await expect(readRecordedReuseWindows(fx.admin, scope)).rejects.toThrow('payload digest mismatch');
  });
});
