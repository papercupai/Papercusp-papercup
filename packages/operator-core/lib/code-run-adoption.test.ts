/**
 * code-run-adoption.test — the code:run adoption metric (code-run-token-frugality, owner directive
 * 2026-06-26). Pure aggregation with an injected runQuery, so these are deterministic unit tests.
 *
 * TEETH: the opportunity classification reuses the LIVE nudge thresholds (BATCH_NUDGE_THRESHOLD /
 * FANOUT_DISTINCT_THRESHOLD imported from code-run-batch-nudge) — these tests pin the at-threshold
 * boundary so a drift between metric and nudge flips RED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BATCH_NUDGE_THRESHOLD,
  EXCLUDED_TOOL_NORMS,
  FANOUT_DISTINCT_THRESHOLD,
  PREFERRED_DOOR_NORMS,
  TURN_GAP_MS,
  isPreferredDoor,
  sqlNormList,
} from './code-run-batch-nudge';
import { NUDGE_CONVERSION_SQL } from './code-run-nudge-telemetry';
import {
  isBatchableSpawn,
  spawnRowsFromCalls,
  summarizeSpawnAdoption,
  computeCodeRunAdoption,
  readCodeRunAdoption,
  rollupAdoption,
  gradeToolUtilization,
  ADOPTION_MIN_SAMPLE,
  ADOPTION_CACHE_TTL_MS,
  CODE_RUN_ADOPTION_SQL,
  CODE_RUN_ADOPTION_MAX_SINCE_DAYS,
  CODE_RUN_ADOPTION_STATEMENT_TIMEOUT_MS,
  CODE_RUN_ADOPTION_ROW_CAP,
  CODE_RUN_INSTRUMENTATION_SQL,
  NATIVE_EXEC_ROUTING_SQL,
  clampSinceDays,
  buildCodeRunAdoptionQuery,
  readCodeRunInstrumentation,
  readRecipeOutcomeReport,
  RECIPE_OUTCOME_REPORT_SQL,
  readNativeExecRouting,
  __resetCodeRunAdoptionCacheForTests,
  type CallRow,
  type SpawnAdoptionRow,
} from './code-run-adoption';

it('R13 recipe report keeps raw units and missing source coverage separate from benefit claims', async () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'app', windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z' };
  const report = await readRecipeOutcomeReport(async <T>(query: string, params: unknown[]) => {
    expect(query).toBe(RECIPE_OUTCOME_REPORT_SQL);
    expect(params).toEqual(['ws', 'app', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z']);
    return [{ report: { sourceRows: 0, attempts: 0, returnedContextBytes: null } }] as unknown as T[];
  }, scope);
  expect(report).toMatchObject({ measurement: { attempts: 0, returnedContextBytes: null },
    units: { returnedContextBytes: 'utf8-bytes-per-dispatch-at-settled-result-door' },
    coverage: { state: 'unknown', complete: false, backlog: null },
    benefit: { state: 'unknown', measuredSavings: null },
    lineage: { criterionKey: 'provider-outcomes', instrumentKey: 'code-intel:reuse-provider-outcomes' } });
  await expect(readRecipeOutcomeReport(async () => [], { ...scope, harnessSlug: '' })).rejects.toThrow('Exact scope');
  await expect(readRecipeOutcomeReport(async () => [], { ...scope, windowEnd: '2999-01-01' })).rejects.toThrow('closed');
});

describe('P-008 run instrumentation and native-exec routing reads', () => {
  it('maps every metadata-only run dimension without selecting content', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const runQuery = async <T>(query: string, params: unknown[]): Promise<T[]> => {
      calls.push({ query, params });
      return [
        {
          runs: '3',
          backend_counts: { server: 2, unknown: '1' },
          tool_calls: '9',
          intermediate_bytes: '32485',
          returned_context_bytes: '35336',
          spilled_bytes: '31000',
          duration_ms: '9488',
          failed_runs: '1',
          failure_class_counts: { timeout: '1' },
          recipe_captures: '1',
          recipe_reuses: '2',
          recipe_cache_hits: '1',
          recipe_candidates: '4',
          recipe_revisions: '2',
          aggregate_output_escapes: '1',
        },
      ] as unknown as T[];
    };

    await expect(readCodeRunInstrumentation(runQuery, 999)).resolves.toEqual({
      runs: 3,
      backendCounts: { server: 2, unknown: 1 },
      toolCalls: 9,
      intermediateBytes: 32_485,
      returnedContextBytes: 35_336,
      spilledBytes: 31_000,
      durationMs: 9_488,
      failedRuns: 1,
      failureClassCounts: { timeout: 1 },
      recipeCaptures: 1,
      recipeReuses: 2,
      recipeCacheHits: 1,
      recipeCandidates: 4,
      recipeRevisions: 2,
      aggregateOutputEscapes: 1,
      // WI-40720 gap 3 — spill resolution. The stub row supplies no spill columns, so these
      // read 0, which is the honest answer: NOT MEASURED, never "no spills went unread".
      spills: 0,
      spillReadAttempts: 0,
      spillReadSuccesses: 0,
      backendMismatches: 0,
      preflightFailures: 0,
      capabilityMisses: 0,
      recipeRequests: 0,
      spillFailures: 0,
    });
    expect(calls).toEqual([{ query: CODE_RUN_INSTRUMENTATION_SQL, params: [90] }]);
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain('metadata_json');
    expect(CODE_RUN_INSTRUMENTATION_SQL).not.toMatch(/content|result_text|output_ref/i);
  });

  it('reports the D-017 route share with an honest null for an empty population', async () => {
    const seen: unknown[][] = [];
    const populated = await readNativeExecRouting(async <T>(query: string, params: unknown[]): Promise<T[]> => {
      expect(query).toBe(NATIVE_EXEC_ROUTING_SQL);
      seen.push(params);
      return [{ native_calls: '3', native_sessions: '2', routed_calls: '7', routed_sessions: '5' }] as unknown as T[];
    }, 14);
    expect(populated).toEqual({
      nativeExecCalls: 3,
      nativeExecSessions: 2,
      routedRunCalls: 7,
      routedRunSessions: 5,
      routedFraction: 0.7,
    });
    expect(seen).toEqual([[14]]);
    // search/session-ingest.ts writes Codex custom-tool calls with this exact
    // vocabulary. A generic-looking `tool` predicate silently returns zero.
    expect(NATIVE_EXEC_ROUTING_SQL).toContain("part_kind = 'tool_use'");
    expect(NATIVE_EXEC_ROUTING_SQL).not.toContain("part_kind = 'tool'");

    const empty = await readNativeExecRouting(async <T>(): Promise<T[]> => [] as T[], 7);
    expect(empty.routedFraction).toBeNull();
  });
});

// The herd guard (EI-6889) is module-level state — reset it before every case so the memo/in-flight
// maps never leak a result across tests.
beforeEach(() => __resetCodeRunAdoptionCacheForTests());

const fanTools = ['plans:get', 'work_items:get', 'docs:search', 'coord:inbox'];

// Default spacing between calls in the `calls()` helper: comfortably ABOVE TURN_GAP_MS so each
// call in these fixtures lands in its OWN inference turn — i.e. distinct calls == distinct turns,
// matching every test's original intent (each call IS a separate round-trip) unless a test
// overrides the spacing to prove the turn-aware behavior (see the P-012 describe block below).
const SEPARATE_TURN_GAP = TURN_GAP_MS + 1000;

function calls(
  spawnId: string,
  role: string,
  day: string,
  toolNames: string[],
  opts: { gapMs?: number; startAt?: number } = {},
): CallRow[] {
  const gapMs = opts.gapMs ?? SEPARATE_TURN_GAP;
  const startAt = opts.startAt ?? 0;
  return toolNames.map((toolName, i) => ({ spawnId, role, day, toolName, invokedAt: startAt + i * gapMs }));
}

describe('isBatchableSpawn — reuses the live nudge thresholds (turn-based, P-012)', () => {
  it('same-tool AT the threshold (by TURNS) is an opportunity; one below is not', () => {
    expect(isBatchableSpawn({ maxSameToolTurns: BATCH_NUDGE_THRESHOLD, distinctTools: 1, distinctTurns: 1 })).toBe(
      true,
    );
    expect(isBatchableSpawn({ maxSameToolTurns: BATCH_NUDGE_THRESHOLD - 1, distinctTools: 1, distinctTurns: 1 })).toBe(
      false,
    );
  });

  it('distinct-tools AT the fan-out threshold, ALSO spanning that many turns, is an opportunity', () => {
    expect(
      isBatchableSpawn({
        maxSameToolTurns: 1,
        distinctTools: FANOUT_DISTINCT_THRESHOLD,
        distinctTurns: FANOUT_DISTINCT_THRESHOLD,
      }),
    ).toBe(true);
    expect(
      isBatchableSpawn({
        maxSameToolTurns: 1,
        distinctTools: FANOUT_DISTINCT_THRESHOLD - 1,
        distinctTurns: FANOUT_DISTINCT_THRESHOLD - 1,
      }),
    ).toBe(false);
  });

  it('distinct-tools AT the threshold but confined to ONE turn is NOT an opportunity (P-012)', () => {
    // The tool-diversity bar is hit, but every call landed in the SAME inference turn (already
    // collapsed to one round-trip via parallel dispatch) — nothing left to fold into code:run.
    expect(isBatchableSpawn({ maxSameToolTurns: 1, distinctTools: FANOUT_DISTINCT_THRESHOLD, distinctTurns: 1 })).toBe(
      false,
    );
  });
});

describe('spawnRowsFromCalls — excludes batch tools from the work counts', () => {
  it('does NOT count code:run / recipes:* toward work, but DOES set usedCodeRun', () => {
    const rows = spawnRowsFromCalls([...calls('s1', 'cup', '2026-06-26', ['code:run', 'recipes:search', 'plans:get'])]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workCalls: 1,
      distinctTools: 1,
      maxSameTool: 1,
      maxSameToolTurns: 1,
      distinctTurns: 1,
      usedCodeRun: true,
    });
  });

  it('matches both name forms (code_run / code:run) for the adoption signal', () => {
    const rows = spawnRowsFromCalls(calls('s1', 'cup', '2026-06-26', ['code_run', 'plans:get']));
    expect(rows[0].usedCodeRun).toBe(true);
  });
});

// ── P-012 (agent-operability-clarity-full-audit-2026-07-13): the metric must measure INFERENCE
//    TURNS, not raw downstream RPC count — mirrors the live nudge's fix in code-run-batch-nudge.ts.
describe('spawnRowsFromCalls — turn-aware opportunity classification (P-012)', () => {
  it('a same-tool burst confined to ONE turn (parallel dispatch) scores maxSameToolTurns=1, NOT an opportunity', () => {
    const burst = Array(BATCH_NUDGE_THRESHOLD + 1).fill('work_items:get');
    const rows = spawnRowsFromCalls(calls('par1', 'cup', '2026-06-26', burst, { gapMs: 10 }));
    expect(rows[0].maxSameTool).toBe(BATCH_NUDGE_THRESHOLD + 1); // raw count still reflects the calls
    expect(rows[0].maxSameToolTurns).toBe(1); // but they all landed in ONE turn
    expect(isBatchableSpawn(rows[0])).toBe(false);
  });

  it('the same same-tool burst SPREAD across separate turns scores maxSameToolTurns == call count, IS an opportunity', () => {
    const burst = Array(BATCH_NUDGE_THRESHOLD).fill('work_items:get');
    const rows = spawnRowsFromCalls(calls('seq1', 'cup', '2026-06-26', burst)); // default: separate turns
    expect(rows[0].maxSameToolTurns).toBe(BATCH_NUDGE_THRESHOLD);
    expect(isBatchableSpawn(rows[0])).toBe(true);
  });

  it('a fan-out confined to ONE turn (a legitimate parallel batch) is NOT an opportunity', () => {
    const rows = spawnRowsFromCalls(calls('par2', 'cup', '2026-06-26', fanTools, { gapMs: 10 }));
    expect(rows[0].distinctTools).toBe(fanTools.length); // tool diversity is real
    expect(rows[0].distinctTurns).toBe(1); // but it is all ONE turn
    expect(isBatchableSpawn(rows[0])).toBe(false);
  });

  it('the same distinct-tool spread across separate turns IS an opportunity', () => {
    const rows = spawnRowsFromCalls(calls('seq2', 'cup', '2026-06-26', fanTools)); // default: separate turns
    expect(rows[0].distinctTurns).toBe(fanTools.length);
    expect(isBatchableSpawn(rows[0])).toBe(true);
  });

  it('mixed burst: one turn of 2 parallel calls + a later turn of a 3rd tool == 2 distinct turns, below threshold', () => {
    const mixed: CallRow[] = [
      { spawnId: 'mix1', role: 'cup', day: '2026-06-26', toolName: 'plans:get', invokedAt: 0 },
      { spawnId: 'mix1', role: 'cup', day: '2026-06-26', toolName: 'work_items:get', invokedAt: 10 },
      {
        spawnId: 'mix1',
        role: 'cup',
        day: '2026-06-26',
        toolName: 'docs:search',
        invokedAt: SEPARATE_TURN_GAP,
      },
    ];
    const rows = spawnRowsFromCalls(mixed);
    expect(rows[0].distinctTools).toBe(3); // tool-diversity threshold reached
    expect(rows[0].distinctTurns).toBe(2); // but only 2 real round-trips — below FANOUT_DISTINCT_THRESHOLD
    expect(isBatchableSpawn(rows[0])).toBe(false);
  });
});

describe('computeCodeRunAdoption — end-to-end raw rows → per-(role,day) summary', () => {
  it('computes opportunity + adoption correctly for a mixed population', () => {
    const day = '2026-06-26';
    const raw: CallRow[] = [
      ...calls('A', 'cup', day, fanTools), // fan-out opportunity, NOT adopted
      ...calls('B', 'cup', day, [...fanTools, 'code:run']), // fan-out opportunity, ADOPTED
      ...calls('C', 'cup', day, ['plans:get', 'docs:get']), // 2 calls — NOT an opportunity
    ];
    const [sum] = computeCodeRunAdoption(raw);
    expect(sum).toMatchObject({
      role: 'cup',
      day,
      spawns: 3,
      opportunitySpawns: 2,
      opportunitySpawnsUsingCodeRun: 1,
      codeRunSpawns: 1,
    });
    expect(sum.adoptionRate).toBeCloseTo(0.5, 5);
  });

  it('classifies a same-tool burst as an opportunity', () => {
    const day = '2026-06-26';
    const sameToolBurst = Array(BATCH_NUDGE_THRESHOLD).fill('work_items:get');
    const [sum] = computeCodeRunAdoption(calls('D', 'mug', day, sameToolBurst));
    expect(sum.opportunitySpawns).toBe(1);
    expect(sum.adoptionRate).toBe(0); // had the chance, did not use code:run
  });

  it('a spawn that only ran code:run has no work-opportunity but counts as a code:run spawn', () => {
    const [sum] = computeCodeRunAdoption(calls('E', 'cup', '2026-06-26', Array(5).fill('code:run')));
    expect(sum).toMatchObject({ spawns: 1, opportunitySpawns: 0, codeRunSpawns: 1 });
    expect(sum.adoptionRate).toBeNull(); // no opportunity ⇒ undefined ratio, not 0
  });

  it('buckets independently per role and per day, sorted by role then day', () => {
    const out = computeCodeRunAdoption([
      ...calls('A', 'cup', '2026-06-25', fanTools),
      ...calls('B', 'mug', '2026-06-26', fanTools),
      ...calls('C', 'cup', '2026-06-26', fanTools),
    ]);
    expect(out.map((s) => `${s.role}/${s.day}`)).toEqual(['cup/2026-06-25', 'cup/2026-06-26', 'mug/2026-06-26']);
  });
});

describe('rollupAdoption + gradeToolUtilization — the learning-loop signal', () => {
  const day = '2026-06-26';
  // Build N opportunity spawns, `adopted` of them using code:run, for one role.
  function opportunityCalls(role: string, total: number, adopted: number): CallRow[] {
    const rows: CallRow[] = [];
    for (let i = 0; i < total; i++) {
      const spawnId = `${role}-${i}`;
      // A same-tool burst = a batchable opportunity. Since P-012 the signal is maxSameToolTurns
      // (DISTINCT INFERENCE TURNS), not raw call count, so these calls must be spaced FURTHER
      // APART THAN TURN_GAP_MS or they cluster into one turn and score 1 — which would make this
      // helper silently stop producing opportunities and quietly zero out every adoption rate
      // built on it. The spacing is the semantic content of the fixture, not decoration.
      const base = i * 1_000_000;
      for (let k = 0; k < BATCH_NUDGE_THRESHOLD; k++) {
        rows.push({ spawnId, role, day, toolName: 'work_items:get', invokedAt: base + k * (TURN_GAP_MS + 1) });
      }
      if (i < adopted) {
        rows.push({
          spawnId,
          role,
          day,
          toolName: 'code:run',
          invokedAt: base + BATCH_NUDGE_THRESHOLD * (TURN_GAP_MS + 1),
        });
      }
    }
    return rows;
  }

  it('rolls per-(role,day) summaries into one fleet figure', () => {
    const roll = rollupAdoption(computeCodeRunAdoption(opportunityCalls('cup', 10, 4)));
    expect(roll.opportunitySpawns).toBe(10);
    expect(roll.opportunitySpawnsUsingCodeRun).toBe(4);
    expect(roll.adoptionRate).toBeCloseTo(0.4, 5);
  });

  it('grades a ~2% baseline as broken (the number the loop must move)', () => {
    const roll = rollupAdoption(computeCodeRunAdoption(opportunityCalls('cup', 50, 1)));
    expect(gradeToolUtilization(roll).rating).toBe('broken');
    expect(gradeToolUtilization(roll).evidence).toMatch(/adoption 2%/);
  });

  it('grades a healthy fleet (≥60% folded) as healthy, a mid fleet as degraded', () => {
    expect(gradeToolUtilization(rollupAdoption(computeCodeRunAdoption(opportunityCalls('cup', 20, 14)))).rating).toBe(
      'healthy',
    );
    expect(gradeToolUtilization(rollupAdoption(computeCodeRunAdoption(opportunityCalls('cup', 20, 8)))).rating).toBe(
      'degraded',
    );
  });

  it('too small a sample (< ADOPTION_MIN_SAMPLE opportunities) is honest unknown, not broken', () => {
    const roll = rollupAdoption(computeCodeRunAdoption(opportunityCalls('cup', ADOPTION_MIN_SAMPLE - 1, 0)));
    expect(roll.opportunitySpawns).toBeLessThan(ADOPTION_MIN_SAMPLE);
    expect(gradeToolUtilization(roll).rating).toBe('unknown');
  });

  it('no opportunities at all → null rate → unknown', () => {
    expect(rollupAdoption([]).adoptionRate).toBeNull();
    expect(gradeToolUtilization(rollupAdoption([])).rating).toBe('unknown');
  });
});

describe('summarizeSpawnAdoption — adoptionRate edge', () => {
  it('null adoptionRate when there are zero opportunity spawns', () => {
    const rows: SpawnAdoptionRow[] = [
      // maxSameToolTurns/distinctTurns are 1 to PRESERVE this row's meaning: it must not be a
      // batchable opportunity, which is what makes adoptionRate null. Setting them at or above
      // BATCH_NUDGE_THRESHOLD would make this an opportunity spawn and quietly change the case
      // under test into its opposite.
      { role: 'r', day: 'd', workCalls: 1, distinctTools: 1, maxSameTool: 1, maxSameToolTurns: 1, distinctTurns: 1, usedCodeRun: false },
    ];
    expect(summarizeSpawnAdoption(rows)[0].adoptionRate).toBeNull();
  });
});

describe('readCodeRunAdoption — runs the BOUNDED query (WI-3815) through an injected runner', () => {
  it('runs the bounded, empty-params query and maps DB rows into a summary', async () => {
    const captured: { query: string; params: unknown[] }[] = [];
    const fakeRun = async <T>(query: string, params: unknown[]): Promise<T[]> => {
      captured.push({ query, params });
      return [
        {
          role: 'cup',
          day: '2026-06-26',
          work_calls: 4,
          distinct_tools: 4,
          max_same_tool: 1,
          max_same_tool_turns: 1,
          distinct_turns: 4,
          used_code_run: false,
        },
        {
          role: 'cup',
          day: '2026-06-26',
          work_calls: 5,
          distinct_tools: 4,
          max_same_tool: 1,
          max_same_tool_turns: 1,
          distinct_turns: 4,
          used_code_run: true,
        },
      ] as unknown as T[];
    };
    const out = await readCodeRunAdoption(fakeRun, { sinceDays: 14 });
    // WI-3815: an EMPTY params array — the days value is inlined (clamped, validated) into the
    // query text itself, so the batch runs via postgres.js's simple protocol (multi-statement,
    // one implicit transaction), which is what lets SET LOCAL scope to the scan that follows it.
    expect(captured[0].params).toEqual([]);
    expect(captured[0].query).toContain('harness_shared.tool_invocations');
    expect(captured[0].query).toBe(buildCodeRunAdoptionQuery(14));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ spawns: 2, opportunitySpawns: 2, opportunitySpawnsUsingCodeRun: 1 });
    expect(out[0].adoptionRate).toBeCloseTo(0.5, 5);
  });

  it('defaults to a 7-day window', async () => {
    let seenQuery = '';
    await readCodeRunAdoption(async <T>(q: string, _p: unknown[]): Promise<T[]> => {
      seenQuery = q;
      return [] as unknown as T[];
    });
    expect(seenQuery).toContain("interval '7 days'");
  });

  it('clamps an out-of-range sinceDays instead of passing it straight to PG', async () => {
    let seenQuery = '';
    await readCodeRunAdoption(
      async <T>(q: string, _p: unknown[]): Promise<T[]> => {
        seenQuery = q;
        return [] as unknown as T[];
      },
      { sinceDays: 99999 },
    );
    expect(seenQuery).toContain(`interval '${CODE_RUN_ADOPTION_MAX_SINCE_DAYS} days'`);
  });
});

describe('clampSinceDays (WI-3815)', () => {
  it('passes through an in-range value', () => {
    expect(clampSinceDays(14)).toBe(14);
  });
  it('defaults missing/undefined to 7', () => {
    expect(clampSinceDays(undefined)).toBe(7);
  });
  it('floors a non-positive or non-finite value to 7', () => {
    expect(clampSinceDays(0)).toBe(7);
    expect(clampSinceDays(-5)).toBe(7);
    expect(clampSinceDays(NaN)).toBe(7);
  });
  it('caps an oversized value at CODE_RUN_ADOPTION_MAX_SINCE_DAYS', () => {
    expect(clampSinceDays(99999)).toBe(CODE_RUN_ADOPTION_MAX_SINCE_DAYS);
  });
  it('truncates a fractional value', () => {
    expect(clampSinceDays(7.9)).toBe(7);
  });
});

describe('CODE_RUN_ADOPTION_SQL — kept parameterized for ad-hoc dev:pg_query use (WI-3815)', () => {
  it('is NOT what readCodeRunAdoption runs, but stays a valid standalone $1-parameterized query', () => {
    expect(CODE_RUN_ADOPTION_SQL).toContain('$1');
    expect(CODE_RUN_ADOPTION_SQL).not.toContain('SET LOCAL');
    expect(CODE_RUN_ADOPTION_SQL).not.toContain('LIMIT');
  });
});

describe('buildCodeRunAdoptionQuery (WI-3815)', () => {
  it('embeds a SET LOCAL statement_timeout ahead of the scan, in the same batch', () => {
    const q = buildCodeRunAdoptionQuery(7);
    expect(q.trim().startsWith(`SET LOCAL statement_timeout = '${CODE_RUN_ADOPTION_STATEMENT_TIMEOUT_MS}ms';`)).toBe(
      true,
    );
  });
  it('inlines the CLAMPED window as an interval literal, not a $1 param', () => {
    expect(buildCodeRunAdoptionQuery(200)).toContain(`interval '${CODE_RUN_ADOPTION_MAX_SINCE_DAYS} days'`);
    expect(buildCodeRunAdoptionQuery(3)).toContain("interval '3 days'");
    expect(buildCodeRunAdoptionQuery(3)).not.toContain('$1');
  });
  it('caps the result with a LIMIT', () => {
    expect(buildCodeRunAdoptionQuery(7)).toContain(`LIMIT ${CODE_RUN_ADOPTION_ROW_CAP}`);
  });
});

describe('readCodeRunAdoption — thundering-herd guard (EI-6889)', () => {
  // TEETH: the operator wedge came from N subsystems each launching an independent 7-day scan of
  // harness_shared.tool_invocations. These pin that concurrent + repeated callers collapse onto ONE
  // scan per window, so a fresh full scan can never be triggered per call again.

  const rows = [
    {
      role: 'cup',
      day: '2026-07-02',
      work_calls: 5,
      distinct_tools: 4,
      max_same_tool: 1,
      max_same_tool_turns: 1,
      distinct_turns: 4,
      used_code_run: true,
    },
  ] as const;

  it('SINGLE-FLIGHT: concurrent callers for the same window share ONE scan', async () => {
    let scans = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runQuery = async <T>(): Promise<T[]> => {
      scans += 1;
      await gate; // hold every scan open so all callers overlap in-flight
      return rows as unknown as T[];
    };
    // Fire 18 concurrent callers — the observed herd size on 2026-07-02.
    const all = Promise.all(Array.from({ length: 18 }, () => readCodeRunAdoption(runQuery, { sinceDays: 7 })));
    release();
    const results = await all;
    expect(scans).toBe(1); // 18 callers → exactly ONE PG scan
    // Every caller got the same (correct) rollup.
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0][0]).toMatchObject({ spawns: 1, opportunitySpawns: 1, opportunitySpawnsUsingCodeRun: 1 });
  });

  it('SHORT-TTL memo: a second call within the TTL reuses the result without re-scanning', async () => {
    let scans = 0;
    let t = 1_000_000;
    const now = (): number => t;
    const runQuery = async <T>(): Promise<T[]> => {
      scans += 1;
      return rows as unknown as T[];
    };
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    t += ADOPTION_CACHE_TTL_MS - 1; // still inside the window
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    expect(scans).toBe(1); // second call served from the memo
  });

  it('re-scans once the TTL has elapsed', async () => {
    let scans = 0;
    let t = 1_000_000;
    const now = (): number => t;
    const runQuery = async <T>(): Promise<T[]> => {
      scans += 1;
      return rows as unknown as T[];
    };
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    t += ADOPTION_CACHE_TTL_MS; // past the window (>= TTL)
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    expect(scans).toBe(2);
  });

  it('keys the memo by sinceDays — a different window is a distinct scan', async () => {
    let scans = 0;
    const now = (): number => 1_000_000;
    const runQuery = async <T>(): Promise<T[]> => {
      scans += 1;
      return rows as unknown as T[];
    };
    await readCodeRunAdoption(runQuery, { sinceDays: 7, now });
    await readCodeRunAdoption(runQuery, { sinceDays: 14, now });
    expect(scans).toBe(2); // 7d and 14d never share a cache entry
  });

  it('does NOT memoize a failed scan — the next call retries', async () => {
    let scans = 0;
    const runQuery = async <T>(): Promise<T[]> => {
      scans += 1;
      if (scans === 1) throw new Error('pool exhausted');
      return rows as unknown as T[];
    };
    await expect(readCodeRunAdoption(runQuery, { sinceDays: 7 })).rejects.toThrow('pool exhausted');
    // In-flight slot cleared + failure not cached → the retry actually re-runs and succeeds.
    const out = await readCodeRunAdoption(runQuery, { sinceDays: 7 });
    expect(scans).toBe(2);
    expect(out[0]).toMatchObject({ spawns: 1 });
  });
});

// ── code-run-self-state-adoption-2026-07-03 P-006: poller exclusion ───────────────────

describe('spawnRowsFromCalls — excludes poller tools from the work counts (P-006)', () => {
  it('an activity:recent 2×-per-spawn poller is NOT a batchable opportunity', () => {
    const rows = spawnRowsFromCalls([
      // Spaced across turns ON PURPOSE: this proves the poller is excluded because of WHAT it is,
      // not because the two calls happened to land in one turn. Same-timestamp calls would score
      // 0 turns anyway, so the test would pass without exercising the exclusion at all.
      { spawnId: 'p1', role: 'operator', day: '2026-07-03', toolName: 'activity:recent', invokedAt: 0 },
      { spawnId: 'p1', role: 'operator', day: '2026-07-03', toolName: 'activity:recent', invokedAt: TURN_GAP_MS + 1 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].maxSameTool).toBe(0);
    expect(rows[0].distinctTools).toBe(0);
    expect(isBatchableSpawn(rows[0])).toBe(false);
  });

  it('a real same-tool burst on a non-poller tool still counts', () => {
    const rows = spawnRowsFromCalls([
      // MUST straddle a turn boundary: isBatchableSpawn keys off maxSameToolTurns, so two calls
      // at the same instant are ONE turn and this assertion would flip to false. The gap is what
      // makes this "a real same-tool burst" rather than one parallel fan-out.
      { spawnId: 'r1', role: 'cup', day: '2026-07-03', toolName: 'work_items:get', invokedAt: 0 },
      { spawnId: 'r1', role: 'cup', day: '2026-07-03', toolName: 'work_items:get', invokedAt: TURN_GAP_MS + 1 },
    ]);
    expect(isBatchableSpawn(rows[0])).toBe(true);
  });
});

/** WI-40720 / P-020. The preferred-door set was hand-copied across NINE sites in three files, and
 *  they had already drifted: `orchestrate:run` shipped as a first-class door and appeared in none of
 *  them, so preferred-door usage was missing from adoption, from nudge conversion, and from the
 *  rollout telemetry gates. The old comment said the copies were "kept in lockstep by the
 *  agent-insight doc + the metric test" — documentation is not a mechanism, which is what these
 *  tests replace it with.
 *
 *  The guard is deliberately written against the SET, never against the literal 'orchestraterun':
 *  a test that hardcodes today's members is just a tenth copy, and would pass while the eleventh
 *  site drifts. Add a door to PREFERRED_DOOR_NORMS and every assertion below re-derives. */
describe('preferred-door norms are DERIVED from one source, not restated per call site', () => {
  it('every SQL predicate that filters on doors carries the whole set', () => {
    // If a future predicate is hardcoded instead of interpolated, it will be missing whichever
    // door was added most recently — which is exactly how orchestrate:run went missing.
    for (const norm of PREFERRED_DOOR_NORMS) {
      expect(CODE_RUN_INSTRUMENTATION_SQL, `instrumentation SQL omits ${norm}`).toContain(`'${norm}'`);
      expect(NATIVE_EXEC_ROUTING_SQL, `native-exec routing SQL omits ${norm}`).toContain(`'${norm}'`);
      expect(NUDGE_CONVERSION_SQL, `nudge-conversion SQL omits ${norm}`).toContain(`'${norm}'`);
      expect(buildCodeRunAdoptionQuery(7), `adoption SQL omits ${norm}`).toContain(`'${norm}'`);
    }
  });

  it('orchestrate:run specifically is measured — the door whose absence motivated this', () => {
    // Not a restatement of the set: this pins the REGRESSION. Dropping orchestrate:run back out
    // of PREFERRED_DOOR_NORMS is the concrete mistake to catch, and the loop above would happily
    // pass on a shrunken set.
    expect(PREFERRED_DOOR_NORMS.has('orchestraterun')).toBe(true);
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("'orchestraterun'");
  });

  it('a preferred door is never also a nudge target', () => {
    // You do not tell an orchestrate:run call to "use code:run". This holds by construction —
    // EXCLUDED_TOOL_NORMS is built FROM PREFERRED_DOOR_NORMS — and this pins that construction.
    for (const norm of PREFERRED_DOOR_NORMS) {
      expect(EXCLUDED_TOOL_NORMS.has(norm), `${norm} is a door but is nudgeable`).toBe(true);
    }
  });

  it('the adoption work-count predicate excludes the doors AND the pollers, which are different concepts', () => {
    const sql = buildCodeRunAdoptionQuery(7);
    for (const norm of EXCLUDED_TOOL_NORMS) expect(sql).toContain(`'${norm}'`);
    // The poller exclusion (P-006) is composed separately and must not be folded into the door set.
    expect(sql).toContain("'activityrecent'");
    expect(EXCLUDED_TOOL_NORMS.has('activityrecent')).toBe(false);
  });

  it('isPreferredDoor accepts every door in BOTH the verb and MCP spellings', () => {
    // The runtime twin of the SQL guard above. A call site asking `toolName === 'code:run'`
    // silently excludes the other doors AND the `code_run` spelling of its own door.
    for (const norm of PREFERRED_DOOR_NORMS) {
      expect(isPreferredDoor(norm), `${norm} bare`).toBe(true);
    }
    expect(isPreferredDoor('code:run')).toBe(true);
    expect(isPreferredDoor('code_run')).toBe(true);
    expect(isPreferredDoor('recipes:run')).toBe(true);
    expect(isPreferredDoor('orchestrate:run')).toBe(true);
    expect(isPreferredDoor('orchestrate_run')).toBe(true);
  });

  it('isPreferredDoor rejects near-misses rather than matching loosely', () => {
    // Normalization strips punctuation, so the risk is over-matching, not under-matching.
    expect(isPreferredDoor('work_items:get')).toBe(false);
    expect(isPreferredDoor('recipes:search')).toBe(false);
    expect(isPreferredDoor('orchestrate:trace')).toBe(false);
    expect(isPreferredDoor('')).toBe(false);
  });

  it('sqlNormList emits a stable, quoted, injection-safe list', () => {
    expect(sqlNormList(new Set(['bbb', 'aaa']))).toBe("'aaa','bbb'");
    // Sorted, so a set reordering cannot produce a spurious SQL diff.
    expect(sqlNormList(PREFERRED_DOOR_NORMS)).toBe(sqlNormList(new Set([...PREFERRED_DOOR_NORMS].reverse())));
    // Single quotes are escaped rather than terminating the literal.
    expect(sqlNormList(new Set(["o'brien"]))).toBe("'o''brien'");
  });
});

/** WI-40720 gap 3 — spill RESOLUTION correlation.
 *
 *  Stamping a spill records only that bytes left the response. Whether the agent ever went and
 *  READ them is a different fact, and the more important one: an unread spill is context the
 *  model silently never saw, which is precisely what the result door exists to avoid. */
describe('CODE_RUN_INSTRUMENTATION_SQL — spill resolution is measured, and measured honestly', () => {
  it('matches BOTH capability:read call shapes', () => {
    // A spill can be addressed by its filesystem path or by its papercusp:// URI. Matching
    // only one shape silently under-counts reads that really happened — which would show up
    // as "agents ignore spills", a conclusion about behaviour drawn from a join bug.
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("args_json->>'file_path'");
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("args_json->>'uri'");
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("'capabilityread'");
  });

  it('keeps ATTEMPT and SUCCESS separate, per the P-020 ruling', () => {
    // A matched row is an attempt whatever its status; only status='ok' is a success.
    // Collapsing them makes "spill never opened" indistinguishable from "spill opened and
    // failed to resolve" — different failures with different fixes.
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain('spill_read_attempts');
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain('spill_read_successes');
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("bool_or(ti.status = 'ok')");
  });

  it('reads both spill addresses from metadata_json, never the output_ref column', () => {
    // The rollup is contractually metadata-only (the guard above asserts the SQL never names
    // output_ref/content/result_text). The URI is therefore duplicated into metadata_json by
    // the handler rather than read from the column — this pins that choice so a future edit
    // does not "simplify" it back into a guard breach.
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("metadata_json->>'spillUri'");
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("metadata_json->>'spillPath'");
    expect(CODE_RUN_INSTRUMENTATION_SQL).not.toMatch(/output_ref/i);
  });

  it('counts every P-020 hard rollback trigger, none of which is derivable from the histograms', () => {
    // Each of these was absent while LOOKING covered by an adjacent aggregate:
    //  - backendCounts cannot show a MISMATCH: every row reports the backend it RAN on, so a
    //    request for a different one is invisible there.
    //  - failureClassCounts does not separate a preflight REFUSAL from an execution failure.
    //  - recipeReuses counts reuse with no requested denominator to divide by.
    //  - spill PERSISTENCE failure (bytes truncated then lost entirely) had no count at all.
    // A trigger that cannot be counted is a trigger that never fires.
    for (const col of [
      'backend_mismatches',
      'preflight_failures',
      'capability_misses',
      'recipe_requests',
      'spill_failures',
    ]) {
      expect(CODE_RUN_INSTRUMENTATION_SQL, `missing ${col}`).toContain(col);
    }
    // Read from the stamped metadata keys, not re-derived from a histogram.
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("metadata_json->>'backendMismatch'");
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain("metadata_json->>'spillFailed'");
  });

  it('reports raw counts, not a precomputed ratio', () => {
    // With zero spills a ratio is 0% or a divide-by-zero, and both read as a verdict about
    // spill health that no evidence supports. Counts let the evaluator say "not measured".
    expect(CODE_RUN_INSTRUMENTATION_SQL).toContain('AS spills');
    expect(CODE_RUN_INSTRUMENTATION_SQL).not.toMatch(/spill_read_rate|spill_resolution_pct/i);
  });
});
