import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';

// The fixtures are PRINTED by the real writer-side formatters, not hand-copied, so a format
// change in scripts/lib/test-pass-reuse.mjs breaks this test instead of silently blinding the
// gate-side parser.
import {
  estimateReuseSavings,
  formatReuseAlarmLine,
  formatReuseExclusionLines,
  formatTestReuseLine,
  formatTestReuseTotalLine,
  laneOfFromSplit,
  laneScopedCandidates,
  REUSE_EXCLUSION_SAMPLE_PER_TASK,
  selectReusablePasses,
} from '../../../../scripts/lib/test-pass-reuse.mjs';
// @ts-expect-error — pure JS guard script with no .d.mts (not enrolled in tsconfig.declarations.json; same as empty-suite-guard.test.ts)
import { scriptSupportsPassReuse } from '../../../../scripts/lib/empty-suite-guard.mjs';
import {
  formatDriftUnknownLine,
  formatExecutedMapAlarmLines,
  formatExecutedMapResultLines,
  formatTestReuseAuditResultLines,
  formatExecutedMapTotalLine,
  readExecutedMapResults,
  summarizeExecutedMapResults,
} from '../../../../scripts/lib/executed-source-map.mjs';
import {
  buildTestPassReuseHealth,
  TEST_PASS_REUSE_HEALTH_MAX_EXCLUSION_EXAMPLES,
  evaluateTestPassReuseAuditWindow,
  formatDurationMs,
  parseTestPassReuse,
  parseTestPassReuseHealth,
  parseTestPassReuseAuditArchive,
  parsePureProofCaptureResult,
  parsePureProofCaptureArchive,
  readPureProofCaptureResult,
  summarizeExecutedSourceMapRecorder,
  summarizeTestPassReuse,
  TEST_PASS_REUSE_HEALTH_MAX_ALARMS,
  TEST_PASS_REUSE_EXCLUSION_REASONS,
  type TestPassReuseAuditInvocation,
} from './test-pass-reuse-report';

const summary = (over: Record<string, number> = {}) => ({
  candidates: 10,
  reused: 7,
  noProof: 1,
  otherContext: 0,
  otherRunner: 0,
  notCaptured: 0,
  opaque: 0,
  unknownDrift: 1,
  globalInput: 0,
  inputChanged: 1,
  audited: 0,
  ...over,
});

describe('candidate suite identity in the reuse archive', () => {
  const sha = 'a'.repeat(40);
  const suite = { command: 'npm run test:affected', runGroupId: 'run-1', startedAtMs: 10, completedAtMs: 20 };
  const output = () => [formatTestReuseLine('core::test', summary(), ' auditRate=0.05 lane=pure'),
    formatTestReuseTotalLine({ tasks: 1, summaries: [summary()], savedMs: 100, unmeasured: 0 })].join('\n');
  it('retains the actual command and child boundaries through producer, health and immutable archive', () => {
    const health = buildTestPassReuseHealth(output(), sha, 30, suite)!;
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(health)))?.suite).toEqual(suite);
    expect(parseTestPassReuseAuditArchive({ suite: health.suite, audit: {
      ...health.audit, judgedSha: sha, recordedAtMs: health.recordedAtMs },
      auditRuns: health.auditRuns, auditedFiles: health.auditedFiles })?.suite).toEqual(suite);
    expect(buildTestPassReuseHealth(output(), sha, 30)).not.toHaveProperty('suite');
  });
  it.each([{ command: '' }, { runGroupId: '' }, { startedAtMs: -1 },
    { completedAtMs: 9 }, { completedAtMs: 31 }])('keeps malformed invocation evidence unknown: %j', (change) => {
    const health = buildTestPassReuseHealth(output(), sha, 30, { ...suite, ...change })!;
    expect(health.suite).toBeNull();
    expect(parseTestPassReuseHealth({ ...health, suite: { ...suite, ...change } })?.suite).toBeNull();
  });
});

describe('named pure capture result reader (WI-10005218 / R-3)', () => {
  const record = () => ({ state: 'done', reason: null, sha: 'a'.repeat(40),
    slices: 1, files: 2, rows: 2, retired: 0, failed: 0, isolatedFail: 0, remaining: 0, stoppedBy: 'complete',
    evidence: { version: 1, runGroupId: 'run-1:pure-proof-capture', startedAtMs: 100, completedAtMs: 200,
      clean: true, proofs: ['a', 'b'].map((file, i) => ({ file: `packages/operator-core/lib/${file}.test.ts`,
        testRunId: String(i + 1), recordedAtMs: 150, runnerIdentity: 'runner-1',
        runContext: 'green-checkpoint', runGroupId: 'run-1:pure-proof-capture', source: 'local' })) } });
  const line = (r = record()) => `PURE_PROOF_CAPTURE_RESULT ${JSON.stringify(r)}`;
  const archive = () => ({ version: 1, runId: 'run-1', gateFireId: 'fire-1', pid: 123,
    processStartedAtMs: 1, judgedSha: 'a'.repeat(40), resolvedAtMs: 70,
    terminalEmissionCompletedAtMs: 90, verdictRecordedAtMs: 80,
    promotion: { candidate: 'a'.repeat(12), recordedAtMs: 60, reason: 'not-green', promoted: false },
    capture: record(), archivedAtMs: 210 });

  it('retains the immutable process receipt and named proofs without borrowing missing clocks', () => {
    const r = archive();
    expect(parsePureProofCaptureArchive(JSON.parse(JSON.stringify(r)))).toEqual(r);
    const unknown = { ...r, verdictRecordedAtMs: null, promotion: null, capture: null };
    expect(parsePureProofCaptureArchive(unknown)).toEqual(unknown);
  });

  it('preserves an explicit moved-HEAD skip without qualifying proofs at the foreign SHA', () => {
    const r = archive();
    const skipped = { ...record(), state: 'skipped', reason: 'notRun(HEAD-moved)', sha: 'b'.repeat(40),
      slices: 0, files: 0, rows: 0, evidence: { ...record().evidence, clean: true, proofs: null } };
    const parsed = parsePureProofCaptureArchive({ ...r, capture: skipped })!;
    expect(parsed.judgedSha).toBe(r.judgedSha);
    expect(parsed.capture?.state).toBe('skipped');
    expect(parsed.capture?.evidence.proofs).toBeNull();
  });

  it.each([
    ['unmeasured process', (r: any) => { delete r.processStartedAtMs; }],
    ['recycled pid without start', (r: any) => { r.processStartedAtMs = null; }],
    ['unsafe run path', (r: any) => { r.runId = '../run'; }],
    ['missing verdict status', (r: any) => { delete r.verdictRecordedAtMs; }],
    ['before final resolution', (r: any) => { r.capture.evidence.startedAtMs = 65; }],
    ['before terminal emission', (r: any) => { r.capture.evidence.startedAtMs = 85; }],
    ['verdict after capture', (r: any) => { r.verdictRecordedAtMs = 110; }],
    ['capture after archive', (r: any) => { r.archivedAtMs = 199; }],
    ['foreign process group', (r: any) => { r.runId = 'other'; }],
    ['foreign judged SHA', (r: any) => { r.judgedSha = 'b'.repeat(40); }],
    ['foreign promotion', (r: any) => { r.promotion.candidate = 'b'.repeat(12); }],
    ['pending promotion', (r: any) => { r.promotion.reason = 'decision-pending'; }],
    ['discarded recursive pass', (r: any) => { r.promotion.reason = 'superseded-by-refire'; }],
    ['promotion after resolution', (r: any) => { r.promotion.recordedAtMs = 71; }],
    ['missing named capture population', (r: any) => { delete r.capture.evidence; }],
  ])('rejects inconsistent archive evidence: %s', (_name, mutate) => {
    const r = archive();
    mutate(r);
    expect(parsePureProofCaptureArchive(r)).toBeNull();
  });

  it('preserves the complete named population through the existing process log and JSON archive', () => {
    const r = record();
    const parsed = readPureProofCaptureResult(`unrelated log\n[green-checkpoint:123] ${line(r)}\r\n`)!;
    expect(parsed).toEqual(r);
    expect(parsePureProofCaptureResult(JSON.parse(JSON.stringify(parsed)))).toEqual(r);
    r.evidence.proofs[0]!.file = 'mutated';
    expect(parsed.evidence.proofs![0]!.file).toBe('packages/operator-core/lib/a.test.ts');
  });

  it.each([
    ['aggregate-only', (r: any) => { delete r.evidence; }],
    ['missing counter', (r: any) => { delete r.rows; }],
    ['negative counter', (r: any) => { r.remaining = -1; }],
    ['fractional counter', (r: any) => { r.slices = 0.5; }],
    ['short SHA', (r: any) => { r.sha = 'abcdef0'; }],
    ['missing population', (r: any) => { delete r.evidence.proofs; }],
    ['count-only population', (r: any) => { r.evidence.proofs = 2; }],
    ['missing row', (r: any) => { r.evidence.proofs.pop(); }],
    ['duplicate file', (r: any) => { r.evidence.proofs[1].file = r.evidence.proofs[0].file; }],
    ['aliased test row', (r: any) => { r.evidence.proofs[1].testRunId = r.evidence.proofs[0].testRunId; }],
    ['traversal path', (r: any) => { r.evidence.proofs[0].file = 'packages/operator-core/../foreign.test.ts'; }],
    ['foreign workspace', (r: any) => { r.evidence.proofs[0].file = 'packages/web/a.test.ts'; }],
    ['foreign group', (r: any) => { r.evidence.proofs[0].runGroupId = 'other'; }],
    ['CI source', (r: any) => { r.evidence.proofs[0].source = 'ci'; }],
    ['foreign context', (r: any) => { r.evidence.proofs[0].runContext = 'local'; }],
    ['mixed runner', (r: any) => { r.evidence.proofs[0].runnerIdentity = 'other'; }],
    ['dirty tree', (r: any) => { r.evidence.clean = false; }],
    ['unknown tree', (r: any) => { r.evidence.clean = null; }],
    ['old row', (r: any) => { r.evidence.proofs[0].recordedAtMs = 99; }],
    ['future row', (r: any) => { r.evidence.proofs[0].recordedAtMs = 201; }],
    ['reversed boundary', (r: any) => { r.evidence.completedAtMs = 90; }],
    ['missing test identity', (r: any) => { r.evidence.proofs[0].testRunId = ''; }],
  ])('rejects %s instead of qualifying evidence', (_name, mutate) => {
    const r = record();
    mutate(r);
    expect(readPureProofCaptureResult(line(r))).toBeNull();
  });

  it('retains explicitly unknown or empty populations without inventing named proofs', () => {
    const r = record();
    expect(parsePureProofCaptureResult({ ...r, evidence: { ...r.evidence, proofs: null } })?.evidence.proofs).toBeNull();
    const skipped = { ...r, state: 'skipped', reason: 'dirty-checkout(1)',
      slices: 0, files: 0, rows: 0, stoppedBy: null, evidence: { ...r.evidence, clean: null, proofs: null } };
    expect(parsePureProofCaptureResult(skipped)).toEqual(skipped);
    const empty = { ...r, slices: 0, files: 0, rows: 0, evidence: { ...r.evidence, proofs: [] } };
    expect(parsePureProofCaptureResult(empty)?.evidence.proofs).toEqual([]);
  });

  it.each(['', 'PURE_PROOF_CAPTURE state=done rows=2', 'PURE_PROOF_CAPTURE_RESULT',
    'PURE_PROOF_CAPTURE_RESULT {"state":"done"', `${line()}\n${line()}`,
    `${line()}\nPURE_PROOF_CAPTURE_RESULT {broken`])('rejects absent, torn or duplicate log records: %s', (output) => {
    expect(readPureProofCaptureResult(output)).toBeNull();
  });
});

describe('parseTestPassReuse', () => {
  it('reads one applied invocation: per-task lines, the total, and later alarms', () => {
    const a = summary();
    const b = summary({ candidates: 4, reused: 4, noProof: 0, unknownDrift: 0, inputChanged: 0 });
    const output = [
      'AFFECTED_DERIVATION source=explicit changedPaths=1',
      formatTestReuseLine('@papercusp/operator-core', a, ' rows=900 narrowed=true minSavedTestMs=61000'),
      formatTestReuseLine('@papercusp/web', b, ' rows=40 narrowed=false minSavedTestMs=5000'),
      formatTestReuseTotalLine({ tasks: 2, summaries: [a, b], savedMs: 66000, unmeasured: 2 }),
      ' RUN  v4.1.8 /repo/packages/operator-core',
      formatReuseAlarmLine('@papercusp/operator-core', { file: 'lib/x.test.ts', reason: 'audit' }),
    ].join('\n');

    const runs = parseTestPassReuse(output);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.applied).toBe(true);
    expect(run!.workspaces.map((w) => w.ws)).toEqual(['@papercusp/operator-core', '@papercusp/web']);
    expect(run!.workspaces[0]!.counts).toMatchObject({ candidates: 10, reused: 7, unknownDrift: 1, rows: 900 });
    expect(run!.workspaces[0]!.narrowed).toBe(true);
    expect(run!.workspaces[1]!.narrowed).toBe(false);
    expect(run!.workspaces[0]!.minSavedTestMs).toBe(61000);
    expect(run!.total).toEqual({
      tasks: 2,
      candidates: 14,
      reused: 11,
      audited: 0,
      minSavedTestMs: 66000,
      unmeasured: 2,
    });
    expect(run!.alarms).toEqual([
      { ws: '@papercusp/operator-core', file: 'lib/x.test.ts', proof: 'audit' },
    ]);
  });

  it('keeps an unknown saving as null, never as zero', () => {
    const a = summary();
    const runs = parseTestPassReuse(
      formatTestReuseTotalLine({ tasks: 1, summaries: [a], savedMs: null, unmeasured: 0 }),
    );
    expect(runs[0]!.total!.minSavedTestMs).toBeNull();
    expect(summarizeTestPassReuse(runs).minSavedTestMs).toBeNull();
    expect(summarizeTestPassReuse(runs).headline).toContain('test time saved unknown');
  });

  it('reads a whole-run off line and a per-task off line with a reason that has punctuation', () => {
    const output = [
      '[green-checkpoint] TEST_PASS_REUSE applied=false reason=dirty-checkout',
      'TEST_PASS_REUSE ws=@papercusp/web applied=false reason=proofs-unavailable(connect ECONNREFUSED 127.0.0.1:5432)',
      formatTestReuseTotalLine({ tasks: 1, summaries: [], savedMs: 0, unmeasured: 0 }),
    ].join('\n');
    const runs = parseTestPassReuse(output);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ applied: false, offReason: 'dirty-checkout', workspaces: [] });
    expect(runs[1]!.workspaces[0]).toMatchObject({
      ws: '@papercusp/web',
      applied: false,
      reason: 'proofs-unavailable(connect ECONNREFUSED 127.0.0.1:5432)',
    });
  });

  it('splits two concatenated invocations (selective phase, then full phase)', () => {
    const a = summary();
    const b = summary({ candidates: 800, reused: 790 });
    const output = [
      formatTestReuseLine('@papercusp/operator-core', a, ' minSavedTestMs=1000'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [a], savedMs: 1000, unmeasured: 0 }),
      formatTestReuseLine('@papercusp/operator-core', b, ' minSavedTestMs=900000'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [b], savedMs: 900000, unmeasured: 3 }),
    ].join('\n');
    const runs = parseTestPassReuse(output);
    expect(runs.map((r) => r.total?.reused)).toEqual([7, 790]);
    const s = summarizeTestPassReuse(runs);
    expect(s).toMatchObject({ invocations: 2, candidates: 810, reused: 797, minSavedTestMs: 901000, unmeasured: 3 });
    expect(s.headline).toBe(
      'per-file reuse: 797 of 810 candidate file(s) reused, at least 15m 01s test time saved (3 file(s) unmeasured), no alarms',
    );
  });

  it('ignores lookalike text and reports a round with no reuse lines as not reported', () => {
    const output = 'TEST_PASS_REUSE_TOTALLY not a line\nsome TEST_PASS_REUSE ws=x mid-line mention';
    const runs = parseTestPassReuse(output);
    expect(runs).toEqual([]);
    expect(summarizeTestPassReuse(runs).headline).toBe('per-file reuse: not reported by this round');
  });
});

describe('summarizeTestPassReuse', () => {
  it('names alarms and per-task off reasons in the headline', () => {
    const a = summary();
    const output = [
      formatTestReuseLine('@papercusp/operator-core', a, ' minSavedTestMs=30000'),
      'TEST_PASS_REUSE ws=@papercusp/web applied=false reason=proofs-unavailable(timeout)',
      formatTestReuseTotalLine({ tasks: 1, summaries: [a], savedMs: 30000, unmeasured: 0 }),
      formatReuseAlarmLine('@papercusp/operator-core', { file: 'lib/y.test.ts', reason: 'notCaptured' }),
    ].join('\n');
    const s = summarizeTestPassReuse(parseTestPassReuse(output));
    expect(s.alarms).toHaveLength(1);
    expect(s.offReasons).toEqual(['proofs-unavailable(timeout)']);
    expect(s.headline).toBe(
      'per-file reuse: 7 of 10 candidate file(s) reused, at least 30s test time saved, 1 ALARM(s); ' +
        'off for some tasks: proofs-unavailable(timeout)',
    );
  });

  it('reports a fully-off round by its reasons', () => {
    const s = summarizeTestPassReuse(
      parseTestPassReuse('TEST_PASS_REUSE applied=false reason=disabled-by-env'),
    );
    expect(s.headline).toBe('per-file reuse off: disabled-by-env');
  });
});

describe('parseTestPassReuseHealth', () => {
  const persisted = () => ({
    judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4',
    recordedAtMs: 1_790_530_000_000,
    ...summarizeTestPassReuse(
      parseTestPassReuse(
        [
          formatTestReuseLine('@papercusp/operator-core', summary(), ' minSavedTestMs=30000'),
          formatTestReuseTotalLine({ tasks: 1, summaries: [summary()], savedMs: 30000, unmeasured: 0 }),
          formatReuseAlarmLine('@papercusp/operator-core', { file: 'lib/y.test.ts', reason: 'audit' }),
        ].join('\n'),
      ),
    ),
  });

  it('round-trips a persisted summary through JSON', () => {
    const blob = JSON.parse(JSON.stringify(persisted()));
    expect(parseTestPassReuseHealth(blob)).toEqual(persisted());
  });

  it('keeps a null saving', () => {
    expect(parseTestPassReuseHealth({ ...persisted(), minSavedTestMs: null })?.minSavedTestMs).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a bad sha', { ...persisted(), judgedSha: 'main' }],
    ['a negative count', { ...persisted(), reused: -1 }],
    ['a string saving', { ...persisted(), minSavedTestMs: '30000' }],
    ['a malformed alarm', { ...persisted(), alarms: [{ ws: 'x' }] }],
    ['an empty headline', { ...persisted(), headline: '' }],
  ])('reads %s as not measured', (_label, value) => {
    expect(parseTestPassReuseHealth(value)).toBeNull();
  });
});

describe('buildTestPassReuseHealth (P-013 runner half)', () => {
  const sha = 'c58655490ce1a3be734de61df08aa7f8159122d4';
  const suiteOutput = (alarmCount = 1) =>
    [
      formatTestReuseLine('@papercusp/operator-core', summary(), ' minSavedTestMs=30000'),
      formatTestReuseTotalLine({ tasks: 1, summaries: [summary()], savedMs: 30000, unmeasured: 0 }),
      ...Array.from({ length: alarmCount }, (_, i) =>
        formatReuseAlarmLine('@papercusp/operator-core', { file: `lib/a${i}.test.ts`, reason: 'audit' }),
      ),
    ].join('\n');

  it('builds the record the recorder stores, and it survives the JSON verdict channel', () => {
    const built = buildTestPassReuseHealth(suiteOutput(), sha, 1_790_530_000_000);
    expect(built).toMatchObject({ judgedSha: sha, recordedAtMs: 1_790_530_000_000, reused: 7, candidates: 10 });
    expect(built?.headline).toContain('7 of 10 candidate file(s) reused');
    // The version-skew fallback reads it back out of JSON; the read-side check must accept it.
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('caps stored alarms but keeps the full count in the headline', () => {
    const n = TEST_PASS_REUSE_HEALTH_MAX_ALARMS + 5;
    const built = buildTestPassReuseHealth(suiteOutput(n), sha, 1);
    expect(built?.alarms).toHaveLength(TEST_PASS_REUSE_HEALTH_MAX_ALARMS);
    expect(built?.headline).toContain(`${n} ALARM(s)`);
  });

  it.each([
    ['a round with no reuse lines', 'plain vitest output only', sha],
    ['a null sha', null, null],
    ['a branch name instead of a sha', null, 'main'],
  ])('returns null (not reported, never zero) for %s', (_label, output, judged) => {
    expect(buildTestPassReuseHealth(output ?? suiteOutput(), judged, 1)).toBeNull();
  });
});

describe('formatDurationMs', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDurationMs(4_400)).toBe('4s');
    expect(formatDurationMs(61_000)).toBe('1m 01s');
    expect(formatDurationMs(3_720_000)).toBe('1h 02m');
  });
});

describe('reuse outcome measurements over archived invocations (WI-10005218 / R-2)', () => {
  const ws = '@papercusp/operator-core::test:unit:pure';
  const counts = summary({ candidates: 100, reused: 98, audited: 2 });
  const output = (extra = 'auditRate=0.05 lane=pure') => [
    formatTestReuseLine(ws, counts, ` ${extra}`),
    formatTestReuseTotalLine({ tasks: 1, summaries: [counts], savedMs: 100, unmeasured: 0 }),
  ].join('\n');
  const invocation = (): TestPassReuseAuditInvocation => ({
    runId: 'archived-run-1',
    judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4',
    runnerIdentity: 'proof-v2 node25 linux x64',
    startedAtMs: 110,
    completedAtMs: 120,
    output: output(),
    auditedFiles: ['packages/operator-core/lib/audit-36.test.ts', 'packages/operator-core/lib/audit-42.test.ts'].map((file) => ({
      invocation: 0, ws, file, verdict: 'pass', evidenceRef: `test-run:${file}`,
      judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4', runnerIdentity: 'proof-v2 node25 linux x64',
      runContext: 'green-checkpoint', runGroupId: null, dirty: false,
    })),
  });
  const window = (over: Partial<Parameters<typeof evaluateTestPassReuseAuditWindow>[0]> = {}) =>
    evaluateTestPassReuseAuditWindow({
      windowStartMs: 100, windowEndMs: 200, expectedRunIds: ['archived-run-1'],
      invocations: [invocation()], ...over,
    });

  const reporterResults = (verdict: 'pass' | 'fail' | 'unknown' = 'pass') => readExecutedMapResults('/unused', {
    readFile: () => JSON.stringify({ workspaceName: '@papercusp/operator-core', outcome: 'written', rows: 2, retired: 0, skipped: 0,
      dirty: false, sha: invocation().judgedSha, error: null,
      fileResults: { version: 1, runnerIdentity: invocation().runnerIdentity, runContext: 'green-checkpoint',
        runGroupId: 'initial-group', files: invocation().auditedFiles!.map((f) => ({ testFile: f.file, verdict })) } }),
  });
  const namedLines = (verdict: 'pass' | 'fail' | 'unknown' = 'pass') => formatTestReuseAuditResultLines(ws, reporterResults(verdict),
    { watch: new Map(invocation().auditedFiles!.map((f) => [f.file, 'audit'])) });

  it('archives named initial results end to end through the real reporter reader/formatter', () => {
    const health = buildTestPassReuseHealth([output(), ...namedLines()].join('\n'), invocation().judgedSha, 120)!;
    const archived = parseTestPassReuseHealth(JSON.parse(JSON.stringify(health)))!;
    expect(archived.auditedFiles).toHaveLength(2);
    expect(archived.auditedFiles?.[0]).toMatchObject({ invocation: 0, ws, verdict: 'pass',
      runnerIdentity: invocation().runnerIdentity, runContext: 'green-checkpoint', dirty: false });
    expect(archived.auditedFiles?.[0]?.evidenceRef).toMatch(/^suite-output:line:/);
    expect(window({ invocations: [{ ...invocation(), auditedFiles: archived.auditedFiles! }] }).verdict).toBe('pass');
    const compact = { audit: { ...archived.audit, judgedSha: archived.judgedSha, recordedAtMs: archived.recordedAtMs },
      auditRuns: archived.auditRuns, auditedFiles: archived.auditedFiles };
    expect(parseTestPassReuseAuditArchive(JSON.parse(JSON.stringify(compact))))
      .toMatchObject({ judgedSha: invocation().judgedSha, recordedAtMs: 120,
        auditRuns: archived.auditRuns, auditedFiles: archived.auditedFiles });
    expect(parseTestPassReuseAuditArchive({ ...compact, auditRuns: null })).toBeNull();
    expect(parseTestPassReuseAuditArchive({ ...compact, audit: { ...compact.audit, audited: 99 } })).toBeNull();
  });

  it('retains original selector runtime through the existing archive even with zero audit draws', () => {
    const runtime = { version: 1 as const, judgedSha: invocation().judgedSha,
      runnerIdentity: invocation().runnerIdentity, runContext: 'green-checkpoint',
      runGroupId: 'initial-group', dirty: false };
    const zero = summary({ candidates: 1, reused: 1, audited: 0 });
    const printed = [formatTestReuseLine(ws, zero, ' auditRate=0.05 lane=pure', runtime),
      formatTestReuseTotalLine({ tasks: 1, summaries: [zero], savedMs: 1, unmeasured: 0 })].join('\n');
    const health = buildTestPassReuseHealth(printed, runtime.judgedSha, 120)!;
    const archived = parseTestPassReuseAuditArchive(JSON.parse(JSON.stringify({
      audit: { ...health.audit, judgedSha: health.judgedSha, recordedAtMs: health.recordedAtMs },
      auditRuns: health.auditRuns, auditedFiles: health.auditedFiles,
    })))!;
    expect(archived.auditRuns[0]!.workspaces[0]!.runtime).toEqual(runtime);
    expect(archived.auditedFiles).toEqual([]);
  });

  // The real affected-tests arming path (orchestration + selector) with only external IO replaced.
  // `overrides` swaps seams; returns the stdout lines and the journal-only writes it made.
  const loadRealArm = (overrides: Record<string, unknown> = {}) => {
    const source = readFileSync(new URL('../../../../scripts/affected-tests.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('async function armTestPassReuse(');
    const end = source.indexOf('\n// AFFECTED_RETRY_FAILED=1', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const lines: string[] = [];
    const journal: string[] = [];
    // Exercise the real orchestration and selector, with only external IO replaced.
    const sandbox = {
      ROOT: '/repo', RUN_LOG_ROOT: '/logs', LANE_SCRIPTS: [], join, relative,
      process: { env: { GREEN_CHECKPOINT: '1', PAPERCUSP_TEST_RUN_SOURCE: 'ci', PAPERCUSP_TEST_RUN_GROUP: 'initial-group' } },
      outSync: (line: string) => lines.push(line),
      // Journal-only appends to the retained run log (outSync also journals; not modelled here).
      logLine: (text: string) => journal.push(text), RUN_LOG_PATH: '/logs/affected-tests-run.log',
      // The real eligibility selector; the gate-decision PG write is an IO seam.
      scriptSupportsPassReuse, recordGateReuseDecision: async () => undefined,
      testReuseEnabled: () => true,
      execFileSync: (command: string, args: string[]) => command === 'node' ? 'v25 linux x64'
        : args[0] === 'rev-parse' ? invocation().judgedSha : '',
      reuseRunnerIdentity: () => invocation().runnerIdentity,
      defaultRunnerIdentity: () => invocation().runnerIdentity,
      nativeProcessTraceEnv: (env: NodeJS.ProcessEnv) => env,
      executedMapRecordingEnabled: () => false,
      qualificationPhysicalExecution: null,
      connectExecutedMapPg: async () => ({ end: async () => undefined }),
      gitChangedBetween: () => () => [], gitInertGlobalChange: () => () => false,
      gitSchemaDriftJudge: () => null, testConfigMainProcessFiles: () => new Set(),
      testReuseAuditRate: () => 0.05,
      loadReuseProofs: async () => ({ proofs: new Map(), rows: 0 }),
      setTimeout: () => ({ unref: () => undefined }),
      reuseCandidates: () => ['lib/uncaptured.test.ts'], laneOfTaskScript: () => null,
      selectReusablePasses, formatTestReuseLine, formatTestReuseTotalLine, formatDriftUnknownLine,
      formatReuseExclusionLines,
      estimateReuseSavings, laneOfFromSplit, laneScopedCandidates,
      // Checkout, PG and filesystem seams: the judged-tree read, the destructive checkpoint
      // restore, proof/duration queries and the skip-list write.
      judgedTreeProofFormat: () => null,
      restoreCandidateCheckpointForReuse: () => ({ ok: false, reason: 'test-stub' }),
      loadReuseProofFiles: async () => ({ files: [], rows: 0 }),
      loadPassDurations: async () => new Map(), writeReuseSkipList: () => '/logs/reuse-skip.json',
      ...overrides,
    };
    // Derived completeness: every import the extracted function names must be in the sandbox, so
    // a new dependency fails here BY NAME instead of as a mid-run ReferenceError.
    const body = source.slice(start, end).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const imported = [...source.matchAll(/^import\s*\{([^}]*)\}\s*from/gm)]
      .flatMap((m) => m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean));
    expect(imported.filter((n) => new RegExp(`\\b${n}\\b`).test(body) && !(n in sandbox))).toEqual([]);
    const arm = runInNewContext(`${source.slice(start, end)}\narmTestPassReuse`, sandbox) as (tasks: unknown[]) => Promise<void>;
    return { arm, lines, journal };
  };

  it('the actual affected-tests arming path emits selector runtime without sampled files', async () => {
    const { arm, lines } = loadRealArm();
    await arm([{ ws: { name: '@papercusp/operator-core', dir: '', scripts: { test: 'vitest --passWithNoTests' } },
      script: 'test' }]);
    const parsed = parseTestPassReuse(lines.join('\n'));
    expect(parsed[0]!.total?.audited).toBe(0);
    expect(parsed[0]!.workspaces[0]!.runtime).toEqual({ version: 1, judgedSha: invocation().judgedSha,
      runnerIdentity: invocation().runnerIdentity, runContext: 'green-checkpoint',
      runGroupId: 'initial-group', dirty: false });
  });

  it('R-3 / AUTO-FAIL-UNKNOWN-DRIFT journal clause: the actual arming path journals every exclusion record and prints only a bounded sample that names the journal', async () => {
    const files = Array.from({ length: REUSE_EXCLUSION_SAMPLE_PER_TASK + 2 }, (_, i) => `lib/excluded-${i}.test.ts`);
    const { arm, lines, journal } = loadRealArm({ reuseCandidates: () => files });
    await arm([{ ws: { name: '@papercusp/operator-core', dir: '', scripts: { test: 'vitest --passWithNoTests' } },
      script: 'test' }]);
    const records = journal.join('').split('\n').filter((l) => l.startsWith('TEST_PASS_REUSE_EXCLUSION '))
      .map((l) => JSON.parse(l.slice('TEST_PASS_REUSE_EXCLUSION '.length)));
    expect(records.map((r) => r.file)).toEqual(files);
    for (const r of records) {
      expect(r).toEqual({ version: 1, ws: '@papercusp/operator-core::test', file: r.file, reason: 'noProof',
        recordedSha: null, judgedSha: invocation().judgedSha, evidence: { missing: 'proof' }, runGroupId: 'initial-group' });
    }
    // stdout carries the bounded sample only, never a full record line.
    expect(lines.some((l) => l.startsWith('TEST_PASS_REUSE_EXCLUSION '))).toBe(false);
    const health = buildTestPassReuseHealth(lines.join('\n'), invocation().judgedSha, 120)!;
    expect(health.exclusions).toMatchObject({ total: files.length, omitted: 2, malformed: 0,
      journals: ['/logs/affected-tests-run.log'], runGroupIds: ['initial-group'] });
    expect(health.exclusions!.examples.map((e) => e.file)).toEqual(files.slice(0, REUSE_EXCLUSION_SAMPLE_PER_TASK));
  });

  it('D-004 B2 / AUTO-FAIL-UNKNOWN-DRIFT journal clauses: a proof whose drift is unknown is journaled as unknownDrift with both SHAs, and stdout carries only the sample', async () => {
    const file = 'lib/drift-unknown.test.ts';
    const recordedSha = 'a1b2c3d4e5f6';
    const p = { recordedSha, recordedAtMs: Date.now() - 60_000, executedModules: [file, 'lib/a.ts'], readPaths: [],
      inputsCaptured: true, opaqueReasons: [], runContext: 'green-checkpoint', runnerIdentity: invocation().runnerIdentity };
    const { arm, lines, journal } = loadRealArm({
      reuseCandidates: () => [file],
      loadReuseProofs: async () => ({ proofs: new Map([[file, p]]), rows: 1 }),
      gitChangedBetween: () => () => null,
    });
    await arm([{ ws: { name: '@papercusp/operator-core', dir: '', scripts: { test: 'vitest --passWithNoTests' } },
      script: 'test' }]);
    const records = journal.join('').split('\n').filter((l) => l.startsWith('TEST_PASS_REUSE_EXCLUSION '))
      .map((l) => JSON.parse(l.slice('TEST_PASS_REUSE_EXCLUSION '.length)));
    expect(records).toEqual([{ version: 1, ws: '@papercusp/operator-core::test', file, reason: 'unknownDrift',
      recordedSha, judgedSha: invocation().judgedSha, runGroupId: 'initial-group' }]);
    expect(lines.some((l) => l.startsWith('TEST_PASS_REUSE_EXCLUSION '))).toBe(false);
    const health = buildTestPassReuseHealth(lines.join('\n'), invocation().judgedSha, 120)!;
    expect(health.exclusions).toMatchObject({ total: 1, omitted: 0, malformed: 0 });
    expect(health.exclusions!.examples).toEqual([{ ws: '@papercusp/operator-core::test', file, reason: 'unknownDrift',
      recordedSha, judgedSha: invocation().judgedSha, evidence: null }]);
  });

  it.each(['%', 'not-json', encodeURIComponent(JSON.stringify({ version: 2 }))])(
    'keeps malformed selector runtime explicit instead of dropping it (%s)', (encoded) => {
      const parsed = parseTestPassReuse(output(`auditRate=0.05 lane=pure runtime=${encoded}`));
      expect(parsed[0]!.workspaces[0]!.runtime).toBeNull();
      const health = buildTestPassReuseHealth(output(`auditRate=0.05 lane=pure runtime=${encoded}`),
        invocation().judgedSha, 120)!;
      expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(health)))?.auditRuns?.[0]?.workspaces[0]?.runtime).toBeNull();
    });

  it('retains an inline-retry miss even without a console FAIL row or soundness alarm', () => {
    const health = buildTestPassReuseHealth([output(), ...namedLines('fail')].join('\n'), invocation().judgedSha, 120)!;
    expect(health.audit?.alarmCount).toBe(2);
    expect(health.alarms).toHaveLength(2);
    expect(window({ invocations: [{ ...invocation(), auditedFiles: health.auditedFiles! }] }).verdict).toBe('fail');
  });

  it('keeps unknown named results rather than certifying them from the final task pass', () => {
    const health = buildTestPassReuseHealth([output(), ...namedLines('unknown'), 'Tests 2 passed'].join('\n'), invocation().judgedSha, 120)!;
    expect(health.auditedFiles?.map((f) => f.verdict)).toEqual(['unknown', 'unknown']);
    expect(window({ invocations: [{ ...invocation(), auditedFiles: health.auditedFiles! }] }).verdict).toBe('unknown');
  });

  it.each([
    ['missing', []], ['partial', namedLines().slice(0, 1)],
    ['duplicate', [namedLines()[0]!, namedLines()[0]!]],
    ['malformed', [namedLines()[0]!, 'TEST_PASS_REUSE_AUDIT_RESULT {oops}']],
    ['unsupported version', namedLines().map((line) => line.replace('"version":1', '"version":2'))],
  ])('marks %s named coverage as unmeasured', (_label, lines) => {
    const health = buildTestPassReuseHealth([output(), ...lines].join('\n'), invocation().judgedSha, 120)!;
    expect(health.auditedFiles).toBeNull();
  });

  it('names separate invocations when the same file is audited twice', () => {
    const health = buildTestPassReuseHealth([output(), ...namedLines(), output(), ...namedLines()].join('\n'), invocation().judgedSha, 120)!;
    expect(health.auditedFiles?.map((f) => f.invocation)).toEqual([0, 0, 1, 1]);
  });

  it.each([
    { judgedSha: 'b'.repeat(40) }, { runnerIdentity: 'foreign runner' }, { runContext: 'clean-local' },
    { dirty: true }, { dirty: null }, { judgedSha: null }, { runnerIdentity: null },
  ])('refuses a source/runtime mismatch as proof of a passed audit: %j', (over) => {
    const r = invocation();
    r.auditedFiles = r.auditedFiles!.map((file) => ({ ...file, ...over }));
    expect(window({ invocations: [r] }).verdict).toBe('unknown');
  });

  it('retains the real configured rate, audited count and explicit pure lane', () => {
    expect(summarizeTestPassReuse(parseTestPassReuse(output())).audit).toEqual({
      auditRate: 0.05, audited: 2, eligible: 100, pureReused: 98, alarmCount: 0,
    });
    // An observed 2/100 sample is valid under the configured 5% deterministic draw.
    expect(window()).toMatchObject({ verdict: 'pass', audited: 2, alarms: 0 });
  });

  it('keeps a missing lane unmeasured rather than claiming zero subsequent pure reuse', () => {
    expect(summarizeTestPassReuse(parseTestPassReuse(output('auditRate=0.05'))).audit)
      .toMatchObject({ audited: 2, pureReused: null });
  });

  it.each([
    ['old counter', (s: string) => s.replaceAll(' audited=2', '')],
    ['missing rate', (s: string) => s.replace('auditRate=0.05', '')],
    ['malformed rate', (s: string) => s.replace('auditRate=0.05', 'auditRate=NaN')],
    ['malformed workspace counter', (s: string) => s.replace('audited=2', 'audited=oops')],
    ['inconsistent total', (s: string) => s.replace('tasks=1', 'tasks=2')],
    ['inconsistent candidates', (s: string) => s.replace('candidates=100', 'candidates=1')],
    ['unavailable task', (s: string) => `TEST_PASS_REUSE ws=other applied=false reason=unavailable\n${s}`],
  ])('does not qualify %s as a zero-miss measurement', (_name, change) => {
    const log = change(output());
    expect(summarizeTestPassReuse(parseTestPassReuse(log)).audit).toBeNull();
    expect(window({ invocations: [{ ...invocation(), output: log }] }).verdict).toBe('unknown');
  });

  it('preserves a missing total audited counter as null at the parser boundary', () => {
    expect(parseTestPassReuse(output().replaceAll(' audited=2', ''))[0]?.total?.audited).toBeNull();
  });

  it.each([
    { expectedRunIds: [], invocations: [] },
    { expectedRunIds: ['archived-run-1', 'missing'] },
    { expectedRunIds: ['archived-run-1', 'archived-run-1'] },
    { invocations: [invocation(), invocation()] },
    { invocations: [{ ...invocation(), runId: 'substituted' }] },
    { invocations: [{ ...invocation(), judgedSha: 'main' }] },
    { invocations: [{ ...invocation(), runnerIdentity: '' }] },
    { invocations: [{ ...invocation(), completedAtMs: 201 }] },
    { invocations: [{ ...invocation(), completedAtMs: 109 }] },
    { invocations: [{ ...invocation(), auditedFiles: null }] },
    { invocations: [{ ...invocation(), auditedFiles: [] }] },
    { invocations: [{ ...invocation(), auditedFiles: [invocation().auditedFiles![0]!] }] },
    { invocations: [{ ...invocation(), auditedFiles: Array(2).fill(invocation().auditedFiles![0]!) }] },
    { invocations: [{ ...invocation(), auditedFiles: invocation().auditedFiles!.map((f) => ({ ...f, evidenceRef: '' })) }] },
    { invocations: [{ ...invocation(), auditedFiles: invocation().auditedFiles!.map((f) => ({ ...f, verdict: 'unknown' as const })) }] },
    { invocations: [{ ...invocation(), auditedFiles: invocation().auditedFiles!.map((f) => ({ ...f, ws: 'foreign' })) }] },
    { invocations: [{ ...invocation(), auditedFiles: invocation().auditedFiles!.map((f) => ({ ...f, invocation: 1 })) }] },
  ])('keeps empty, partial, substituted or unqualified coverage UNKNOWN (%j)', (over) => {
    expect(window(over).verdict).toBe('unknown');
  });

  it('requires an observed nonzero audit even if reusable files were present', () => {
    const noAudit = output().replaceAll('audited=2', 'audited=0').replaceAll('reused=98', 'reused=100');
    expect(window({ invocations: [{ ...invocation(), output: noAudit, auditedFiles: [] }] }).verdict).toBe('unknown');
  });

  it('fails a real first-attempt miss even if retry results or window coverage would look clean', () => {
    const r = invocation();
    r.output += `\n${formatReuseAlarmLine(ws, { file: r.auditedFiles![0]!.file, reason: 'audit' })}`;
    r.auditedFiles![0]!.verdict = 'fail';
    expect(window({ invocations: [r] })).toMatchObject({ verdict: 'fail', alarms: 1 });
    r.auditedFiles = null;
    expect(window({ invocations: [r] })).toMatchObject({ verdict: 'fail', alarms: 1 });
  });

  it.each(['0.01', '1e-7'])('fails a fully observed window with a changed audit policy (%s)', (auditRate) => {
    expect(window({ invocations: [{ ...invocation(), output: output(`auditRate=${auditRate} lane=pure`) }] }).verdict).toBe('fail');
  });

  it('does not attribute an unqualified foreign failure to the observed audits', () => {
    const r = invocation();
    r.auditedFiles![0] = { ...r.auditedFiles![0]!, ws: 'foreign', verdict: 'fail' };
    expect(window({ invocations: [r] })).toMatchObject({ verdict: 'unknown', alarms: 0 });
  });

  it('rejects a passing file outside the actual selector draw', () => {
    const r = invocation();
    r.auditedFiles![0]!.file = 'packages/operator-core/lib/not-a-sample.test.ts';
    expect(window({ invocations: [r] }).verdict).toBe('unknown');
  });

  it('distinguishes the same audited file in selective and full invocations', () => {
    const r = invocation();
    r.output += `\n${output()}`;
    r.auditedFiles!.push(...r.auditedFiles!.map((f) => ({ ...f, invocation: 1 })));
    expect(window({ invocations: [r] })).toMatchObject({ verdict: 'pass', audited: 4 });
  });

  it('retains full alarm counts across health storage caps and degrades old health honestly', () => {
    const alarms = Array.from({ length: TEST_PASS_REUSE_HEALTH_MAX_ALARMS + 3 }, (_, i) =>
      formatReuseAlarmLine(ws, { file: `lib/${i}.test.ts`, reason: 'audit' }));
    const health = buildTestPassReuseHealth([output(), ...alarms].join('\n'), invocation().judgedSha, 120)!;
    expect(health.alarms).toHaveLength(TEST_PASS_REUSE_HEALTH_MAX_ALARMS);
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(health)))?.audit?.alarmCount).toBe(alarms.length);
    const { audit: _audit, ...old } = health;
    expect(parseTestPassReuseHealth(old)?.audit).toBeUndefined();
    expect(parseTestPassReuseHealth({ ...health, audit: { ...health.audit, audited: -1 } })?.audit).toBeNull();
  });
});

// WI-10003603: a recorder that failed every write (WI-10003597) left reuse at zero for ~8h because
// its outcome only reached discarded task stderr. The runner now prints it; these fixtures are
// produced by the RUNNER's own reader + formatters from the reporter's result-file lines, so the
// whole chain (reporter line → runner read → printed line → gate parse) is exercised end to end.
describe('pass-proof recorder outcome (WI-10003603)', () => {
  type Line = { outcome: string; rows: number; retired?: number; skipped?: number; dirty?: boolean; error?: string | null };
  const resultFile = (lines: Line[]) =>
    lines
      .map((l) =>
        JSON.stringify({
          workspaceName: 'w',
          retired: 0,
          skipped: 0,
          dirty: false,
          sha: 'c0ffee000000',
          error: null,
          ...l,
        }),
      )
      .join('\n');
  /** One affected-tests invocation's recorder output, as the runner prints it. */
  // `expects` stamps the runner's arming-time report expectation (WI-10003792) onto a task's read.
  const printed = (tasks: Record<string, Line[] | null>, expects: Record<string, boolean> = {}) => {
    const reads = Object.entries(tasks).map(([task, lines]) => ({
      task,
      read: {
        ...readExecutedMapResults('/unused', {
          readFile: () => {
            if (lines === null) throw new Error('ENOENT');
            return resultFile(lines);
          },
        }),
        expectsReport: expects[task] ?? null,
      },
    }));
    return [
      ...reads.flatMap(({ task, read }) => [
        ...formatExecutedMapResultLines(task, read),
        ...formatExecutedMapAlarmLines(task, read),
      ]),
      formatExecutedMapTotalLine(summarizeExecutedMapResults(reads.map((r) => r.read))),
    ].join('\n');
  };

  it('is NOT REPORTED (null) when the round printed no recorder total — never "recorded nothing"', () => {
    expect(summarizeExecutedSourceMapRecorder('TEST_PASS_REUSE applied=false reason=off')).toBeNull();
  });

  it('reads a healthy round as recorded, with rows summed over invocations', () => {
    const out = [
      printed({ 'a::test': [{ outcome: 'written', rows: 40 }], 'b::test:lane-pure': [{ outcome: 'nothing-to-record', rows: 0 }] }),
      printed({ 'c::test': [{ outcome: 'written', rows: 2, retired: 1 }] }),
    ].join('\n');
    const r = summarizeExecutedSourceMapRecorder(out)!;
    expect(r).toMatchObject({ invocations: 2, tasks: 3, written: 2, rows: 42, retired: 1, nothingToRecord: 1 });
    expect(r.verdict).toBe('recorded');
    expect(r.alarm).toBe(false);
  });

  it('ALARMS on a failing writer and carries its error — the WI-10003597 round', () => {
    const out = printed({
      '@papercusp/operator-core::test': [{ outcome: 'failed', rows: 900, error: 'cannot cast type boolean to\nboolean[]' }],
      'x::test': [{ outcome: 'timed-out', rows: 3 }],
    });
    const r = summarizeExecutedSourceMapRecorder(out)!;
    expect(r).toMatchObject({ verdict: 'write-failing', alarm: true, failed: 1, timedOut: 1, written: 0 });
    expect(r.alarms[0]).toEqual({
      task: '@papercusp/operator-core::test',
      outcome: 'failed',
      error: 'cannot cast type boolean to boolean[]',
    });
    const health = buildTestPassReuseHealth(out, 'abcdef1234567', 1)!;
    expect(health.headline).toContain('PASS-PROOF RECORDER FAILING: 1 write(s) failed, 1 timed out');
    expect(health.headline).toContain('cannot cast type boolean to boolean[]');
  });

  it('ALARMS when the clean round persisted nothing, or no task reported at all', () => {
    const dirty = summarizeExecutedSourceMapRecorder(printed({ 'a::test': [{ outcome: 'not-persisted', rows: 5, dirty: true }] }))!;
    expect(dirty).toMatchObject({ verdict: 'not-persisted', alarm: true });
    const silent = summarizeExecutedSourceMapRecorder(printed({ 'a::test': null, 'b::test': null }))!;
    expect(silent).toMatchObject({ verdict: 'unreported', alarm: true, noReport: 2 });
    const quiet = summarizeExecutedSourceMapRecorder(printed({ 'a::test:lane-pure': [{ outcome: 'nothing-to-record', rows: 0 }] }))!;
    expect(quiet).toMatchObject({ verdict: 'nothing-to-record', alarm: false });
  });

  // WI-10003792: an enrolled task that went silent used to hide inside noReport, indistinguishable
  // from an astro check that never could report.
  it('ALARMS task-silent when an enrolled task reported nothing, even though others recorded', () => {
    const out = printed(
      {
        'core::test': [{ outcome: 'written', rows: 12 }],
        'lib::test': null,
        'docs::test': null,
      },
      { 'core::test': true, 'lib::test': true, 'docs::test': false },
    );
    const r = summarizeExecutedSourceMapRecorder(out)!;
    expect(r).toMatchObject({
      verdict: 'task-silent',
      alarm: true,
      noReport: 2,
      noReportExpected: 1,
      noReportUnexpected: 1,
      written: 1,
    });
    expect(r.alarms).toEqual([expect.objectContaining({ task: 'lib::test', outcome: 'no-report-unexpected' })]);
    const health = buildTestPassReuseHealth(out, 'abcdef1234567', 1)!;
    expect(health.headline).toContain('PASS-PROOF RECORDER partly silent: 1 enrolled task(s) reported no outcome (lib::test)');
  });

  it('does NOT alarm when every silent task was known unable to report', () => {
    const onlyExpected = summarizeExecutedSourceMapRecorder(
      printed({ 'core::test': [{ outcome: 'written', rows: 3 }], 'docs::test': null }, { 'core::test': true, 'docs::test': false }),
    )!;
    expect(onlyExpected).toMatchObject({ verdict: 'recorded', alarm: false, noReportExpected: 1, noReportUnexpected: 0 });
    // All armed tasks silent, all of them unable to report: nothing recordable, not a broken recorder.
    const allExpected = summarizeExecutedSourceMapRecorder(printed({ 'docs::test': null, 'cli::test': null }, { 'docs::test': false, 'cli::test': false }))!;
    expect(allExpected).toMatchObject({ verdict: 'nothing-to-record', alarm: false });
    // …but one unknown-expectation task among them keeps the old `unreported` reading.
    const mixed = summarizeExecutedSourceMapRecorder(printed({ 'docs::test': null, 'x::test': null }, { 'docs::test': false }))!;
    expect(mixed).toMatchObject({ verdict: 'unreported', alarm: true });
  });

  it('still reads a TOTAL line written before the split, with both split counts at 0', () => {
    const legacy =
      'EXECUTED_SOURCE_MAP_TOTAL tasks=2 written=1 rows=5 retired=0 notPersisted=0 nothingToRecord=0 failed=0 timedOut=0 noReport=1 malformed=0';
    expect(summarizeExecutedSourceMapRecorder(legacy)).toMatchObject({
      verdict: 'recorded',
      noReport: 1,
      noReportExpected: 0,
      noReportUnexpected: 0,
    });
  });

  it('builds a health record from recorder lines alone, and round-trips it through the parser', () => {
    const out = printed({ 'a::test': [{ outcome: 'failed', rows: 1, error: 'db down' }] });
    const built = buildTestPassReuseHealth(out, 'abcdef1234567', 7)!;
    expect(built.recorder?.verdict).toBe('write-failing');
    expect(built.headline).toMatch(/^per-file reuse: not reported by this round; PASS-PROOF RECORDER FAILING/);
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(built)))).toEqual(built);
  });

  it('keeps the reuse record when a persisted recorder is malformed, reading only the recorder as unreported', () => {
    const built = buildTestPassReuseHealth(printed({ 'a::test': [{ outcome: 'written', rows: 1 }] }), 'abcdef1234567', 7)!;
    const parsed = parseTestPassReuseHealth({ ...built, recorder: { verdict: 'recorded' } });
    expect(parsed).not.toBeNull();
    expect(parsed!.recorder).toBeNull();
    expect(parseTestPassReuseHealth({ ...built, recorder: undefined })!.recorder).toBeNull();
  });
});

describe('reuse exclusion evidence in the report (WI-6554700010026699)', () => {
  const sha = 'c58655490ce1a3be734de61df08aa7f8159122d4';
  const ws = '@papercusp/operator-core::test';
  const record = (i: number, over: Record<string, unknown> = {}) => ({
    file: `packages/operator-core/lib/x-${i}.test.ts`, reason: 'unknownDrift', recordedSha: 'a1b2c3d4e5', judgedSha: sha, ...over });
  const where = { runGroupId: 'rg-1', journal: '/logs/affected-tests-run.log' };
  const round = (...samples: string[]) => [formatTestReuseLine(ws, summary(), ''), ...samples,
    formatTestReuseTotalLine({ tasks: 1, summaries: [summary()], savedMs: 0, unmeasured: 0 })].join('\n');
  const rawSample = (total: number, examples: unknown[]) =>
    `TEST_PASS_REUSE_EXCLUSIONS ${JSON.stringify({ version: 1, ws, total, examples, ...where })}`;

  it('R-4 bounds stored examples, keeps the exact omitted count, and links the full journal and run group', () => {
    const samples = Array.from({ length: 5 }, (_, t) => formatReuseExclusionLines(`${ws}-${t}`,
      Array.from({ length: 6 }, (_, i) => record(t * 10 + i, i === 0 ? { reason: 'audited' } : {})), where).sample);
    const out = round(...samples);
    const unbounded = summarizeTestPassReuse(parseTestPassReuse(out)).exclusions!;
    expect(unbounded.total).toBe(30);
    expect(unbounded.omitted).toBe(30 - unbounded.examples.length);
    const health = buildTestPassReuseHealth(out, sha, 120)!;
    expect(health.exclusions!.total).toBe(30);
    expect(health.exclusions!.examples).toHaveLength(TEST_PASS_REUSE_HEALTH_MAX_EXCLUSION_EXAMPLES);
    expect(health.exclusions!.omitted).toBe(30 - TEST_PASS_REUSE_HEALTH_MAX_EXCLUSION_EXAMPLES);
    expect(health.exclusions!.journals).toEqual(['/logs/affected-tests-run.log']);
    expect(health.exclusions!.runGroupIds).toEqual(['rg-1']);
    expect(health.exclusions!.examples[0]).toEqual({ ws: `${ws}-0`, file: 'packages/operator-core/lib/x-0.test.ts',
      reason: 'audited', recordedSha: 'a1b2c3d4e5', judgedSha: sha, evidence: null });
  });

  it('R-4/R-5 (B4) keeps three states apart: no sample line is not measured, a zero total is 0 excluded and 0 omitted, a sample is populated', () => {
    const legacy = buildTestPassReuseHealth(round(), sha, 120)!;
    expect('exclusions' in legacy).toBe(false);
    expect(parseTestPassReuseHealth(JSON.parse(JSON.stringify(legacy)))!.exclusions).toBeUndefined();
    const zero = buildTestPassReuseHealth(round(formatReuseExclusionLines(ws, [], where).sample), sha, 120)!;
    expect(zero.exclusions).toEqual({ total: 0, examples: [], omitted: 0, malformed: 0,
      journals: ['/logs/affected-tests-run.log'], runGroupIds: ['rg-1'] });
    const one = buildTestPassReuseHealth(round(formatReuseExclusionLines(ws, [record(1)], where).sample), sha, 120)!;
    expect(one.exclusions).toMatchObject({ total: 1, omitted: 0 });
    expect(one.exclusions!.examples).toHaveLength(1);
  });

  it('R-4 validates each example: an unsafe path, an unknown reason or a bad sha is dropped and counted, never stored', () => {
    const out = round(rawSample(4, [record(1), record(2, { file: '/abs/x.test.ts' }), record(3, { reason: 'nope' }),
      record(4, { judgedSha: 'not-a-sha' })]), 'TEST_PASS_REUSE_EXCLUSIONS {not json');
    const health = buildTestPassReuseHealth(out, sha, 120)!;
    expect(health.exclusions!.examples.map((e) => e.file)).toEqual(['packages/operator-core/lib/x-1.test.ts']);
    expect(health.exclusions!.total).toBe(4);
    expect(health.exclusions!.omitted).toBe(3);
    expect(health.exclusions!.malformed).toBe(4);
    // A sample claiming fewer records than it carries is inconsistent, so it is rejected whole; with
    // no other sample line the round's total was never measured, so it is null, never 0 (D-004 B4).
    expect(buildTestPassReuseHealth(round(rawSample(0, [record(1)])), sha, 120)!.exclusions)
      .toEqual({ total: null, examples: [], omitted: null, journals: [], runGroupIds: [], malformed: 1 });
  });

  it('D-004 B4: a round whose only sample lines are unparseable is not measured, a fourth state distinct from absent, zero and populated', () => {
    for (const out of [round('TEST_PASS_REUSE_EXCLUSIONS {not json'), round(rawSample(1, [record(1), record(2)]))]) {
      const health = buildTestPassReuseHealth(out, sha, 120)!;
      expect(health.exclusions).toEqual({ total: null, examples: [], omitted: null, journals: [], runGroupIds: [],
        malformed: 1 });
      // The production read path keeps it not measured; it never becomes a 0 total.
      const reread = parseTestPassReuseHealth(JSON.parse(JSON.stringify(health)))!.exclusions!;
      expect(reread).toEqual(health.exclusions);
      expect(reread.total).not.toBe(0);
    }
    // One parsed sample beside an unparseable one is measured, with the drop counted.
    const mixed = buildTestPassReuseHealth(round(rawSample(2, [record(1)]), 'TEST_PASS_REUSE_EXCLUSIONS {oops'), sha, 120)!;
    expect(mixed.exclusions).toMatchObject({ total: 2, omitted: 1, malformed: 1 });
    // A persisted not-measured record that claims examples, or nothing dropped, is inconsistent.
    const bad = (exclusions: unknown) => parseTestPassReuseHealth({
      ...JSON.parse(JSON.stringify(buildTestPassReuseHealth(round(), sha, 120)!)), exclusions })!.exclusions;
    expect(bad({ total: null, omitted: null, examples: [], journals: [], runGroupIds: [], malformed: 0 })).toBeNull();
    expect(bad({ total: null, omitted: 0, examples: [], journals: [], runGroupIds: [], malformed: 1 })).toBeNull();
    expect(bad({ total: null, omitted: null, journals: [], runGroupIds: [], malformed: 1,
      examples: [{ ws, ...record(1), evidence: null }] })).toBeNull();
  });

  it('D-004 (adopted advisory): the report validates exactly the reasons the selector can write', () => {
    const selector = readFileSync(new URL('../../../../scripts/lib/test-pass-reuse.mjs', import.meta.url), 'utf8');
    const written = new Set([...selector.matchAll(/\bexclude\(file, "([A-Za-z]+)"/g)].map((m) => m[1]!));
    expect(written.size).toBeGreaterThan(0);
    expect([...written].sort()).toEqual([...TEST_PASS_REUSE_EXCLUSION_REASONS].sort());
  });

  it('R-2 keeps branch evidence, clipped to a bounded size', () => {
    const long = record(1, { reason: 'opaque', evidence: { opaqueReasons: ['x'.repeat(1000)] } });
    const health = buildTestPassReuseHealth(round(formatReuseExclusionLines(ws, [long], where).sample), sha, 120)!;
    const evidence = health.exclusions!.examples[0]!.evidence!;
    expect(evidence.startsWith('{"opaqueReasons":["xxx')).toBe(true);
    expect(evidence.length).toBe(300);
  });

  it('R-4 survives the JSON verdict channel and reads a tampered omitted count as not measured', () => {
    const health = buildTestPassReuseHealth(round(formatReuseExclusionLines(ws, [record(1), record(2)], where).sample), sha, 120)!;
    const persisted = JSON.parse(JSON.stringify(health));
    expect(parseTestPassReuseHealth(persisted)!.exclusions).toEqual(health.exclusions);
    expect(parseTestPassReuseHealth({ ...persisted, exclusions: { ...persisted.exclusions, omitted: 1 } })!.exclusions).toBeNull();
    expect(parseTestPassReuseHealth({ ...persisted, exclusions: { ...persisted.exclusions,
      examples: [{ ...persisted.exclusions.examples[0], file: '../escape.ts' }, persisted.exclusions.examples[1]] } })!.exclusions).toBeNull();
  });
});
