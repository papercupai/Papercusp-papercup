import { describe, expect, it } from 'vitest';
import { parsePureProofCaptureResult, readPureProofCaptureResult } from '../release/test-pass-reuse-report';

import {
  PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT,
  PURE_PROOF_CAPTURE_SLICE_DEFAULT,
  buildCaptureEnv,
  buildCaptureVitestArgs,
  decideNextSlice,
  orderCaptureCandidates,
  pureProofCaptureBudgetMs,
  pureProofCaptureEnabled,
  pureProofCaptureSliceSize,
  repoRelativeLaneFiles,
  runPureLaneProofCapture,
  splitTimedOutSlice,
} from '../../../../scripts/lib/pure-lane-proof-capture.mjs';

/**
 * gate-test-reuse-yield-2026-10-01 P-006 part 1 (Decision D-005 §1): the post-verdict phase that
 * re-runs pure-lane files ISOLATED so the recorder writes the proofs the pure lane (isolate:false)
 * never records. The rails under test: never capture over a failure at the sha, never re-capture a
 * file already proven at it, order the useful files first, stop before the budget or the next gate
 * fire, and skip (never throw) whenever the checkout or database cannot support a proof.
 */

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW = Date.parse('2026-10-01T12:00:00Z');
const HOUR = 3600_000;
const RUNNER = 'p1 v25.9.0 linux x64';
const WS = 'packages/operator-core';
const rr = (f: string) => `${WS}/${f}`;

const proof = (sha: string, ageMs: number, runnerIdentity: string | null = RUNNER) => ({
  recordedSha: sha,
  recordedAtMs: NOW - ageMs,
  runnerIdentity,
});

describe('env switches', () => {
  it('is ON by default and off only for an explicit off value', () => {
    expect(pureProofCaptureEnabled({})).toBe(true);
    expect(pureProofCaptureEnabled({ PC_PURE_PROOF_CAPTURE: '1' })).toBe(true);
    for (const off of ['0', 'false', 'OFF', ' no ']) {
      expect(pureProofCaptureEnabled({ PC_PURE_PROOF_CAPTURE: off })).toBe(false);
    }
  });

  it('reads budget and slice size, falling back on anything that is not a positive integer', () => {
    expect(pureProofCaptureBudgetMs({})).toBe(PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT);
    expect(pureProofCaptureBudgetMs({ PC_PURE_PROOF_CAPTURE_BUDGET_MS: '60000' })).toBe(60000);
    expect(pureProofCaptureBudgetMs({ PC_PURE_PROOF_CAPTURE_BUDGET_MS: '-5' })).toBe(PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT);
    expect(pureProofCaptureSliceSize({})).toBe(PURE_PROOF_CAPTURE_SLICE_DEFAULT);
    expect(pureProofCaptureSliceSize({ PC_PURE_PROOF_CAPTURE_SLICE: '2' })).toBe(2);
    expect(pureProofCaptureSliceSize({ PC_PURE_PROOF_CAPTURE_SLICE: 'x' })).toBe(PURE_PROOF_CAPTURE_SLICE_DEFAULT);
  });
});

describe('orderCaptureCandidates', () => {
  const base = {
    sha: SHA,
    runnerIdentity: RUNNER,
    failedAtSha: new Set<string>(),
    passedInSuite: new Set<string>(),
  };

  it('excludes files that failed at the sha and files already proven at it', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['f.test.ts', 'p.test.ts', 'n.test.ts'],
      failedAtSha: new Set(['f.test.ts']),
      proofs: new Map([['p.test.ts', proof(SHA, HOUR)]]),
    });
    expect(r.order).toEqual(['n.test.ts']);
    expect(r.excluded).toEqual({ failed: 1, proven: 1 });
  });

  it('a failure at the sha wins even over a fresh proof at the same sha (never capture over a failure)', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['x.test.ts'],
      failedAtSha: new Set(['x.test.ts']),
      proofs: new Map([['x.test.ts', proof(SHA, HOUR)]]),
    });
    expect(r.order).toEqual([]);
    expect(r.excluded).toEqual({ failed: 1, proven: 0 });
  });

  it('orders ran-and-passed first, then unproven, then refresh oldest-first; by path within a tier', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['z-ran.test.ts', 'a-ran.test.ts', 'm-none.test.ts', 'b-none.test.ts', 'r-new.test.ts', 'r-old.test.ts'],
      passedInSuite: new Set(['z-ran.test.ts', 'a-ran.test.ts']),
      proofs: new Map([
        ['z-ran.test.ts', proof(OLD, 2 * HOUR)],
        ['r-new.test.ts', proof(OLD, 2 * HOUR)],
        ['r-old.test.ts', proof(OLD, 20 * HOUR)],
      ]),
    });
    expect(r.order).toEqual([
      'a-ran.test.ts',
      'z-ran.test.ts',
      'b-none.test.ts',
      'm-none.test.ts',
      'r-old.test.ts',
      'r-new.test.ts',
    ]);
    expect(r.tiers).toEqual({ ranPassed: 2, unproven: 2, refresh: 2 });
  });

  it('treats a proof from another runner identity as no proof', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['other-node.test.ts', 'other-node-at-sha.test.ts'],
      proofs: new Map([
        ['other-node.test.ts', proof(OLD, HOUR, 'p1 v24.0.0 linux x64')],
        ['other-node-at-sha.test.ts', proof(SHA, HOUR, 'p1 v24.0.0 linux x64')],
      ]),
    });
    expect(r.tiers).toEqual({ ranPassed: 0, unproven: 2, refresh: 0 });
    expect(r.excluded.proven).toBe(0);
  });

  it('owner #2143: a proof never expires, so an old one is proven at its sha and refreshed elsewhere', () => {
    const r = orderCaptureCandidates({
      ...base,
      laneFiles: ['old-at-sha.test.ts', 'old.test.ts', 'nan.test.ts', 'recent.test.ts'],
      proofs: new Map([
        ['old-at-sha.test.ts', proof(SHA, 90 * 24 * HOUR)],
        ['old.test.ts', proof(OLD, 30 * 24 * HOUR)],
        ['nan.test.ts', { recordedSha: OLD, recordedAtMs: Number.NaN, runnerIdentity: RUNNER }],
        ['recent.test.ts', proof(OLD, HOUR)],
      ]),
    });
    expect(r.excluded).toEqual({ failed: 0, proven: 1 });
    // An unreadable timestamp sorts as the oldest, so it is refreshed first.
    expect(r.order).toEqual(['nan.test.ts', 'old.test.ts', 'recent.test.ts']);
    expect(r.tiers).toEqual({ ranPassed: 0, unproven: 0, refresh: 3 });
  });

  it('de-duplicates the lane list', () => {
    const r = orderCaptureCandidates({ ...base, laneFiles: ['a.test.ts', 'a.test.ts'], proofs: new Map() });
    expect(r.order).toEqual(['a.test.ts']);
  });
});

describe('decideNextSlice', () => {
  const at = { startedAtMs: NOW, budgetMs: 15 * 60_000, estimateMs: 60_000 };

  it('goes when the slice fits the budget and ends before the next-fire margin', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: NOW + 10 * 60_000 })).toEqual({ go: true, reason: null });
  });

  it('stops on the budget', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW + 14.5 * 60_000, nextFireAtMs: null })).toEqual({ go: false, reason: 'budget' });
  });

  it('stops when the slice would end inside the 2-minute margin of the next fire, or the fire is overdue', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: NOW + 2.5 * 60_000 })).toEqual({ go: false, reason: 'next-fire' });
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: NOW - 1 })).toEqual({ go: false, reason: 'next-fire' });
  });

  it('an unknown next fire leaves only the budget', () => {
    expect(decideNextSlice({ ...at, nowMs: NOW, nextFireAtMs: null })).toEqual({ go: true, reason: null });
  });
});

describe('argv and env', () => {
  it('names every file and refuses a zero-file pass', () => {
    expect(buildCaptureVitestArgs(['lib/a.test.ts', 'lib/b.test.ts'])).toEqual([
      'run',
      '--no-passWithNoTests',
      'lib/a.test.ts',
      'lib/b.test.ts',
    ]);
    expect(() => buildCaptureVitestArgs([])).toThrow(/empty slice/);
  });

  it('runs the isolated default config with recording armed and rows marked local, without mutating the input', () => {
    const input = {
      GREEN_CHECKPOINT: '1',
      PC_TEST_LANE: 'pure',
      PC_TEST_REUSE_SKIP_LIST: '/tmp/skip.json',
      PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
      PC_EXECUTED_SOURCE_MAP_OUT: '/tmp/out.json',
      PAPERCUSP_TEST_RUN_SOURCE: 'ci',
      PAPERCUSP_TEST_RUN_GROUP: 'suite-run',
      VITEST_MAX_WORKERS: '6',
    };
    const env = buildCaptureEnv(input, { resultFile: '/tmp/r.jsonl', runGroupId: 'run-1:pure-proof-capture', sha: SHA });
    expect(env.PC_TEST_LANE).toBeUndefined();
    expect(env.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
    expect(env.PC_EXECUTED_SOURCE_MAP_NO_PERSIST).toBeUndefined();
    expect(env.PC_EXECUTED_SOURCE_MAP_OUT).toBeUndefined();
    expect(env.PC_EXECUTED_SOURCE_MAP_WORKSPACE).toBe('@papercusp/operator-core');
    expect(env.PC_EXECUTED_SOURCE_MAP_RESULT).toBe('/tmp/r.jsonl');
    expect(env.PAPERCUSP_TEST_RUN_SOURCE).toBe('local');
    expect(env.PAPERCUSP_TEST_RUN_GROUP).toBe('run-1:pure-proof-capture');
    expect(env.PAPERCUSP_TEST_RUN_COMMIT).toBe(SHA);
    expect(env.GREEN_CHECKPOINT).toBe('1');
    expect(env.VITEST_MAX_WORKERS).toBe('6');
    expect(input.PC_TEST_LANE).toBe('pure');
    expect(input.PAPERCUSP_TEST_RUN_SOURCE).toBe('ci');
  });

  it('maps workspace-relative and absolute include entries to repo-relative paths', () => {
    expect(repoRelativeLaneFiles('/r', '/r/packages/operator-core', ['lib/a.test.ts', '/r/packages/operator-core/lib/b.test.ts'])).toEqual([
      'packages/operator-core/lib/a.test.ts',
      'packages/operator-core/lib/b.test.ts',
    ]);
  });
});

type Slice = { args: string[]; env: Record<string, string | undefined>; cwd: string; timeoutMs: number };

function harness(over: Record<string, unknown> = {}) {
  const clock = { now: NOW };
  const slices: Slice[] = [];
  const logs: string[] = [];
  const removed: string[] = [];
  const lane = ['lib/a.test.ts', 'lib/b.test.ts', 'lib/c.test.ts', 'lib/d.test.ts', 'lib/e.test.ts'];
  const deps = {
    git: (_root: string, args: string[]) => (args[0] === 'rev-parse' ? `${SHA}\n` : args[0] === 'status' ? '' : null),
    laneInclude: () => lane,
    runnerIdentity: () => RUNNER,
    connect: async () => ({ end: async () => {} }),
    loadShaOutcomes: async () => ({
      failed: new Set([rr('lib/e.test.ts')]),
      passedInSuite: new Set([rr('lib/c.test.ts'), rr('lib/d.test.ts')]),
      ranInSuite: 5,
    }),
    loadProofs: async () => ({ proofs: new Map([[rr('lib/a.test.ts'), proof(SHA, HOUR)]]), rows: 1 }),
    loadSliceFailures: async ({ files }: { files: string[] }) => files.filter((f) => f === rr('lib/d.test.ts')),
    readResults: () => ({
      status: 'ok',
      results: [{ outcome: 'persisted', rows: 2, retired: 1, skipped: 0, dirty: false, sha: SHA }],
      malformed: 0,
    }),
    runSlice: async (s: Slice) => {
      slices.push(s);
      clock.now += 30_000;
      return { code: 0, signal: null, timedOut: false, spawnError: null };
    },
    readNextFireAtMs: async (): Promise<number | null> => null,
    now: () => clock.now,
    makeTempDir: () => '/tmp/capture-test',
    removeTempDir: (dir: string) => removed.push(dir),
    log: (line: string) => logs.push(line),
    ...over,
  };
  const env = { GREEN_CHECKPOINT: '1', PC_PURE_PROOF_CAPTURE_SLICE: '2' } as Record<string, string | undefined>;
  return { deps, env, slices, logs, removed, clock };
}

const run = (h: ReturnType<typeof harness>, env = h.env) =>
  runPureLaneProofCapture({ root: '/r', env, runGroupId: 'run-1:pure-proof-capture', deps: h.deps as never });

describe('runPureLaneProofCapture', () => {
  function namedHarness(mutate?: (rows: Array<Record<string, unknown>>) => void) {
    const h = harness({ loadSliceFailures: async () => [] });
    h.deps.readResults = () => ({ status: 'reported', malformed: 0,
      results: [{ outcome: 'written', rows: h.slices.at(-1)!.args.length - 2,
        retired: 0, skipped: 0, dirty: false, sha: SHA }] });
    Object.assign(h.deps, { loadCapturedProofRows: async ({ files }: { files: string[] }) => {
      const rows = files.map((file, i) => ({ file, testRunId: String(100 * h.slices.length + i), recordedAtMs: h.clock.now,
        runnerIdentity: RUNNER, runContext: 'green-checkpoint', runGroupId: 'run-1:pure-proof-capture', source: 'local' }));
      mutate?.(rows);
      return rows;
    } });
    return h;
  }

  it('reads proofs only for the lane files it judges (WI-6554700010019200)', async () => {
    const scopes: unknown[] = [];
    const h = harness({
      loadProofs: async ({ files }: { files?: string[] }) => {
        scopes.push(files);
        return { proofs: new Map([[rr('lib/a.test.ts'), proof(SHA, HOUR)]]), rows: 1 };
      },
    });
    await run(h);
    expect(scopes).toHaveLength(1);
    expect([...(scopes[0] as string[])].sort()).toEqual(
      ['lib/a.test.ts', 'lib/b.test.ts', 'lib/c.test.ts', 'lib/d.test.ts', 'lib/e.test.ts'].map(rr),
    );
  });

  it('retains the exact named local proof population before removing its temporary result files', async () => {
    const h = namedHarness();
    const r = await run(h);
    expect(r.evidence).toMatchObject({ version: 1, runGroupId: 'run-1:pure-proof-capture',
      clean: true, startedAtMs: NOW, completedAtMs: NOW + 60_000 });
    expect(r.evidence.proofs?.map((p) => p.file)).toEqual([rr('lib/c.test.ts'), rr('lib/d.test.ts'), rr('lib/b.test.ts')]);
    const records = h.logs.filter((line) => line.startsWith('PURE_PROOF_CAPTURE_RESULT '));
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0].slice('PURE_PROOF_CAPTURE_RESULT '.length))).toMatchObject({
      sha: SHA, rows: 3, evidence: r.evidence,
    });
    const parsed = readPureProofCaptureResult(h.logs.join('\n'))!;
    expect(parsed).toMatchObject({ sha: SHA, rows: 3, evidence: r.evidence });
    expect(parsePureProofCaptureResult(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(h.removed).toEqual(['/tmp/capture-test']);
  });

  it.each([
    ['missing row', (r: Array<Record<string, unknown>>) => { r.pop(); }],
    ['duplicate row', (r: Array<Record<string, unknown>>) => { r[1] = r[0]; }],
    ['foreign file', (r: Array<Record<string, unknown>>) => { r[0].file = rr('foreign.test.ts'); }],
    ['foreign group', (r: Array<Record<string, unknown>>) => { r[0].runGroupId = 'other'; }],
    ['CI source', (r: Array<Record<string, unknown>>) => { r[0].source = 'ci'; }],
    ['foreign context', (r: Array<Record<string, unknown>>) => { r[0].runContext = 'local'; }],
    ['foreign runner', (r: Array<Record<string, unknown>>) => { r[0].runnerIdentity = 'other'; }],
    ['old row', (r: Array<Record<string, unknown>>) => { r[0].recordedAtMs = NOW - 1; }],
    ['future row', (r: Array<Record<string, unknown>>) => { r[0].recordedAtMs = NOW + 90_000; }],
    ['missing test row', (r: Array<Record<string, unknown>>) => { r[0].testRunId = ''; }],
  ])('retains %s as unknown rather than a named capture', async (_name, mutate) => {
    expect((await run(namedHarness(mutate))).evidence.proofs).toBeNull();
  });

  it('does not turn a failed proof query or historical aggregate-only report into zero proofs', async () => {
    const h = namedHarness();
    Object.assign(h.deps, { loadCapturedProofRows: async () => { throw new Error('query failed'); } });
    expect((await run(h)).evidence.proofs).toBeNull();
    expect((await run(harness())).evidence.proofs).toBeNull();
  });

  it('does not qualify named rows from a timed-out slice', async () => {
    const h = namedHarness();
    h.deps.runSlice = async (s: Slice) => {
      h.slices.push(s);
      h.clock.now += 30_000;
      return { code: 0, signal: null, timedOut: true, spawnError: null };
    };
    expect((await run(h)).evidence.proofs).toBeNull();
  });

  it('emits one explicit skip with unknown proof evidence on a dirty tree', async () => {
    const h = harness({ git: (_root: string, args: string[]) => args[0] === 'rev-parse' ? SHA : ' M source.ts' });
    const result = await run(h);
    expect(result.evidence).toMatchObject({ clean: null, proofs: null });
    expect(readPureProofCaptureResult(h.logs.join('\n'))).toMatchObject({ state: 'skipped',
      reason: 'dirty-checkout(1)', evidence: { clean: null, proofs: null } });
    expect(h.logs.filter((line) => line.startsWith('PURE_PROOF_CAPTURE_RESULT '))).toHaveLength(1);
    expect(h.slices).toHaveLength(0);
  });

  it('captures the ordered candidates in slices, isolated, and reports what was recorded', async () => {
    const h = harness();
    const r = await run(h);
    // a: proven at the sha; e: failed at the sha. c, d ran-and-passed (tier i), then b (unproven).
    expect(h.slices.map((s) => s.args)).toEqual([
      ['run', '--no-passWithNoTests', 'lib/c.test.ts', 'lib/d.test.ts'],
      ['run', '--no-passWithNoTests', 'lib/b.test.ts'],
    ]);
    expect(h.slices[0].cwd).toBe('/r/packages/operator-core');
    expect(h.slices[0].env.PAPERCUSP_TEST_RUN_SOURCE).toBe('local');
    expect(h.slices[0].env.PC_TEST_LANE).toBeUndefined();
    expect(h.slices[0].env.PC_EXECUTED_SOURCE_MAP_RESULT).toBe('/tmp/capture-test/executed-map-result-1.jsonl');
    expect(r).toMatchObject({
      state: 'done',
      sha: SHA,
      slices: 2,
      files: 3,
      rows: 4,
      retired: 2,
      failed: 1,
      isolatedFail: 1,
      remaining: 0,
      stoppedBy: 'complete',
    });
    expect(h.logs).toContain(`PURE_PROOF_CAPTURE_ISOLATED_FAIL file=${rr('lib/d.test.ts')} sha=${SHA.slice(0, 12)}`);
    expect(h.logs.some((l) => l.startsWith('PURE_PROOF_CAPTURE state=planned') && l.includes('excludedFailed=1 excludedProven=1'))).toBe(true);
    expect(h.logs.some((l) => l.startsWith('PURE_PROOF_CAPTURE_EXECUTED_SOURCE_MAP_RESULT task=pure-proof-capture#1'))).toBe(true);
    expect(h.removed).toEqual(['/tmp/capture-test']);
  });

  it('skips without touching git when switched off', async () => {
    let gitCalls = 0;
    const h = harness({ git: () => ((gitCalls += 1), null) });
    const r = await run(h, { ...h.env, PC_PURE_PROOF_CAPTURE: '0' });
    expect(r).toMatchObject({ state: 'skipped', reason: 'disabled-by-env' });
    expect(gitCalls).toBe(0);
  });

  it('skips outside the gate run context and when recording is off', async () => {
    const h = harness();
    expect((await run(h, { PC_PURE_PROOF_CAPTURE_SLICE: '2' })).reason).toBe('not-gate-context');
    expect((await run(h, { ...h.env, AFFECTED_RECORD_EXECUTED_SOURCES: '0' })).reason).toBe('recording-disabled');
    expect(h.slices).toHaveLength(0);
  });

  it('skips a dirty or sha-less checkout', async () => {
    const dirty = harness({ git: (_r: string, a: string[]) => (a[0] === 'rev-parse' ? SHA : ' M lib/x.ts\n') });
    expect((await run(dirty)).reason).toBe('dirty-checkout(1)');
    const noSha = harness({ git: () => null });
    expect((await run(noSha)).reason).toBe('no-judged-sha');
    expect(dirty.slices.length + noSha.slices.length).toBe(0);
  });

  it('skips when the suite never ran the pure lane at this sha', async () => {
    const h = harness({ loadShaOutcomes: async () => ({ failed: new Set(), passedInSuite: new Set(), ranInSuite: 0 }) });
    expect(await run(h)).toMatchObject({ state: 'skipped', reason: 'pure-lane-not-run-at-sha' });
    expect(h.slices).toHaveLength(0);
  });

  // WI-10004717: a repair-queue run judged b8eb76cc, then moved the checkout to a newly admitted
  // head before capture ran. HEAD had no rows, and the old reason claimed the lane never ran.
  describe('when HEAD has no suite rows', () => {
    const notRunAtHead = async () => ({ failed: new Set<string>(), passedInSuite: new Set<string>(), ranInSuite: 0 });
    const runSince = (h: ReturnType<typeof harness>, sinceMs: number | null) =>
      runPureLaneProofCapture({
        root: '/r',
        env: h.env,
        runGroupId: 'run-1:pure-proof-capture',
        sinceMs,
        deps: h.deps as never,
      });

    it('names the judged sha when this run recorded the lane at a different sha', async () => {
      const judged = 'b'.repeat(40);
      const seen: Array<{ sinceMs: number; files: string[] }> = [];
      const h = harness({
        loadShaOutcomes: notRunAtHead,
        loadLatestLaneSha: async (o: { sinceMs: number; files: string[] }) => {
          seen.push(o);
          return judged;
        },
      });
      const r = await runSince(h, NOW - 3_600_000);
      expect(r).toMatchObject({
        state: 'skipped',
        reason: `tree-moved-off-judged-sha(judged=${judged.slice(0, 12)},head=${SHA.slice(0, 12)})`,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].sinceMs).toBe(NOW - 3_600_000);
      expect(seen[0].files.length).toBeGreaterThan(0);
      expect(h.slices).toHaveLength(0); // never mints a proof off-HEAD
    });

    it('keeps the plain reason when the latest recorded sha IS HEAD, none exists, or the lookup fails', async () => {
      for (const latest of [async () => SHA, async () => null, async () => { throw new Error('boom'); }]) {
        const h = harness({ loadShaOutcomes: notRunAtHead, loadLatestLaneSha: latest });
        expect(await runSince(h, NOW - 1000)).toMatchObject({ state: 'skipped', reason: 'pure-lane-not-run-at-sha' });
        expect(h.slices).toHaveLength(0);
      }
    });

    it('does not query for a judged sha when the run start is unknown', async () => {
      let calls = 0;
      const h = harness({
        loadShaOutcomes: notRunAtHead,
        loadLatestLaneSha: async () => {
          calls += 1;
          return 'c'.repeat(40);
        },
      });
      expect(await runSince(h, null)).toMatchObject({ reason: 'pure-lane-not-run-at-sha' });
      expect(calls).toBe(0);
    });
  });

  it('skips when the database is unavailable, and never throws', async () => {
    const h = harness({
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const r = await run(h);
    expect(r.state).toBe('skipped');
    expect(r.reason).toMatch(/^pg-unavailable\(connect_ECONNREFUSED\)$/);
  });

  it('stops before a slice that would exceed the budget', async () => {
    const h = harness();
    // Slice estimate is 2 files × 250ms = 0.5s; a 30s slice then raises it to 15s/file → 30s.
    const r = await run(h, { ...h.env, PC_PURE_PROOF_CAPTURE_BUDGET_MS: '40000' });
    expect(r).toMatchObject({ slices: 1, files: 2, remaining: 1, stoppedBy: 'budget' });
  });

  it('stops before running into the next scheduled gate fire', async () => {
    const h = harness();
    h.deps.readNextFireAtMs = async () => h.clock.now + 60_000;
    expect(await run(h)).toMatchObject({ slices: 0, remaining: 3, stoppedBy: 'next-fire' });
  });

  it('stops if the checkout moved off the judged sha between slices', async () => {
    let revParses = 0;
    const h = harness({
      git: (_r: string, a: string[]) => {
        if (a[0] === 'status') return '';
        revParses += 1;
        return revParses <= 2 ? SHA : OLD;
      },
    });
    expect(await run(h)).toMatchObject({ slices: 1, stoppedBy: `head-moved(${OLD.slice(0, 12)})` });
  });

  // WI-6554700010030061: one hung file used to end capture (stoppedBy=slice-timeout) and discard
  // the whole slice; on the frozen lineage that was 249 passing files and 4001 never attempted.
  it('splits a timed-out slice, isolates the hung file and keeps capturing the lane', async () => {
    const h = harness();
    h.deps.runSlice = async (s: Slice) => {
      h.slices.push(s);
      h.clock.now += 30_000;
      return { code: 1, signal: null, timedOut: s.args.includes('lib/c.test.ts'), spawnError: null };
    };
    const r = await run(h);
    // candidates c, d, b in slices of 2: [c,d] times out -> [c], [d]; [c] times out alone.
    expect(h.slices.map((s) => s.args.slice(2))).toEqual([
      ['lib/c.test.ts', 'lib/d.test.ts'], ['lib/c.test.ts'], ['lib/d.test.ts'], ['lib/b.test.ts'],
    ]);
    expect(r).toMatchObject({ slices: 4, remaining: 0, timedOutSlices: 2, hung: [rr('lib/c.test.ts')], stoppedBy: 'complete' });
    expect(h.logs).toContain(`PURE_PROOF_CAPTURE_SLICE_TIMEOUT n=1 files=${rr('lib/c.test.ts')},${rr('lib/d.test.ts')}`);
    expect(h.logs).toContain(`PURE_PROOF_CAPTURE_HUNG file=${rr('lib/c.test.ts')} sha=${SHA.slice(0, 12)}`);
  });

  it('isolates a file that hangs on every attempt without looping', async () => {
    const h = harness({ runSlice: async () => ({ code: 1, signal: null, timedOut: true, spawnError: null }) });
    const r = await run(h);
    expect(r).toMatchObject({ slices: 4, remaining: 0, timedOutSlices: 4, stoppedBy: 'complete' });
    expect(r.hung).toEqual([rr('lib/c.test.ts'), rr('lib/d.test.ts'), rr('lib/b.test.ts')]);
  });

  it('keeps the other slices\' proofs when a timed-out slice minted nothing', async () => {
    const h = namedHarness();
    const reported = h.deps.readResults;
    h.deps.runSlice = async (s: Slice) => {
      h.slices.push(s);
      h.clock.now += 30_000;
      return { code: 1, signal: null, timedOut: s.args.includes('lib/c.test.ts'), spawnError: null };
    };
    h.deps.readResults = () => (h.slices.at(-1)!.args.includes('lib/c.test.ts')
      ? { status: 'no-report', results: [], malformed: 0 } : reported());
    const named = (h.deps as unknown as { loadCapturedProofRows: (a: { files: string[] }) => Promise<unknown[]> })
      .loadCapturedProofRows;
    Object.assign(h.deps, { loadCapturedProofRows: async (a: { files: string[] }) =>
      (a.files.includes(rr('lib/c.test.ts')) ? [] : named(a)) });
    const r = await run(h);
    expect(r.hung).toEqual([rr('lib/c.test.ts')]);
    expect(r.evidence.proofs?.map((p) => p.file)).toEqual([rr('lib/d.test.ts'), rr('lib/b.test.ts')]);
  });

  it('splits a slice into contiguous sub-slices and leaves a singleton unsplit', () => {
    expect(splitTimedOutSlice(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    expect(splitTimedOutSlice(Array.from({ length: 250 }, (_, i) => String(i))).map((s) => s.length))
      .toEqual([32, 32, 32, 32, 32, 32, 32, 26]);
    expect(splitTimedOutSlice(['only'])).toEqual([]);
  });

  it('reports nothing to capture when every candidate is already proven or failed', async () => {
    const h = harness({ laneInclude: () => ['lib/a.test.ts', 'lib/e.test.ts'] });
    expect(await run(h)).toMatchObject({ state: 'done', slices: 0, stoppedBy: 'nothing-to-capture' });
    expect(h.slices).toHaveLength(0);
  });
});
