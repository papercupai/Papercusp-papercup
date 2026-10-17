/**
 * claimability-snapshot.test.ts — WI-5947.
 *
 * `work_items:claimable` presents three readings as ONE verdict: the survivor COUNTS
 * (aggregateIssueClaimExclusions), the survivor ROWS (listIssueClaimableRows), and the
 * per-floor excluded SAMPLE (sampleIssueClaimExclusions). They share an inner subquery and
 * a floor predicate, so they are semantically identical — but they used to be three
 * INDEPENDENT round-trips, each its own implicit transaction. Against a table the fleet is
 * actively claiming from, a row counted by the first was gone by the second, producing
 * `claimableCount:1, returned:0` under a limit of 50 — which `scheduler:get_next` then read
 * as a "CLAIM-PATH/READ-PATH DIVERGENCE" and told the agent to file a claim-path bug that
 * did not exist.
 *
 * These pin the fix at the boundary that actually matters: readIssueClaimability issues ONE
 * read-only REPEATABLE READ transaction, sets the isolation BEFORE any data statement, runs
 * every read on that transaction handle, and FAILS rather than degrading to a partial or
 * zeroed reading. (The floor semantics themselves are covered by the DB-backed
 * claim-ssot-agreement / get-next-exclusion-breakdown integration suites; this is the
 * transaction-shape contract, which a quiescent-table integration test cannot observe.)
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/claimability-snapshot.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readIssueClaimability } from './get-next';

/** One entry per statement the code actually EXECUTED (interpolated fragments are never
 *  awaited, so they never appear here — which is exactly the count we want). */
type Log = string[];

/** Render the SQL text carried by the fake postgres.js fragments, including nested fragments. */
function renderSqlFragment(fragment: unknown): string {
  if (fragment === undefined || fragment === null) return '';
  if (!fragment || typeof fragment !== 'object') return '?';
  const value = fragment as { strings?: unknown[]; args?: unknown[] };
  if (!Array.isArray(value.strings)) return '?';
  const args = value.args ?? [];
  return value.strings.map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`).join('');
}

/**
 * A postgres-js-shaped fake: callable as a tagged template, with `.unsafe`/`.json`. Both a
 * query and an `unsafe(...)` return a thenable FRAGMENT — awaiting it records the statement
 * and yields no rows; interpolating it into another template records nothing. Every read
 * therefore degrades to its documented empty-result defaults, leaving the transaction shape
 * as the only thing under test.
 */
function makeHandle(log: Log, opts: { failAtQuery?: number } = {}) {
  let queries = 0;
  const handle = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = { strings: Array.from(strings), args: values };
    // Strip SQL comments before flattening so comment-only column names cannot
    // satisfy projection assertions or hide the rest of the statement.
    const text = renderSqlFragment(fragment).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      ...fragment,
      then(resolve: (rows: unknown[]) => void, reject: (err: unknown) => void) {
        queries += 1;
        log.push(`QUERY:${text}`);
        if (opts.failAtQuery === queries) {
          reject(new Error('snapshot read failed'));
          return;
        }
        resolve([]);
      },
    };
  }) as unknown as Record<string, unknown> & ((s: TemplateStringsArray) => unknown);
  handle.unsafe = (text: string) => ({
    strings: [text],
    args: [],
    then(resolve: (rows: unknown[]) => void) {
      log.push(`EXEC:${text}`);
      resolve([]);
    },
  });
  handle.json = (v: unknown) => ({ __json: v });
  return handle;
}

/** A pool handle whose `begin` hands the callback a SEPARATE transaction handle, so we can
 *  tell a statement issued on the transaction from one issued on a fresh pool checkout. */
function makePool(opts: { failAtQuery?: number } = {}) {
  const poolLog: Log = [];
  const txLog: Log = [];
  let beginCalls = 0;
  const pool = makeHandle(poolLog) as unknown as Record<string, unknown>;
  pool.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    beginCalls += 1;
    return fn(makeHandle(txLog, opts));
  };
  return {
    client: pool as never,
    poolLog,
    txLog,
    get beginCalls() {
      return beginCalls;
    },
    /** Only the statements that were real queries (not the SET preamble). */
    get queries() {
      return txLog.filter((l) => l.startsWith('QUERY:'));
    },
  };
}

const OPTS = { harness: 'papercup', assignee: 'probe' };

describe('readIssueClaimability — one snapshot for every claimability read (WI-5947)', () => {
  it('reports bounded timings for each SQL read stage, including the stage that fails', async () => {
    const pg = makePool({ failAtQuery: 1 });
    const timings: Array<[string, number]> = [];

    await expect(readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      onStageTiming: (stage, elapsedMs) => timings.push([stage, elapsedMs]),
    })).rejects.toThrow('snapshot read failed');

    expect(timings).toEqual([
      ['transaction-isolation', expect.any(Number)],
      ['statement-timeout', expect.any(Number)],
      ['candidate-materialization', expect.any(Number)],
    ]);
    expect(timings.every(([, elapsedMs]) => elapsedMs >= 0 && Number.isFinite(elapsedMs))).toBe(true);
  });

  it('reports each reached query stage on a successful snapshot read', async () => {
    const pg = makePool();
    const stages: string[] = [];

    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      sampleLimit: 5,
      onStageTiming: (stage) => stages.push(stage),
    });

    expect(stages).toEqual([
      'transaction-isolation',
      'statement-timeout',
      'candidate-materialization',
      'lane-scope-population',
      'claim-exclusion-breakdown',
      'claimable-rows',
      'excluded-sample',
      'admitted-composition',
    ]);
  });

  it('issues exactly ONE transaction, and runs the counts + rows + sample inside it', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      sampleLimit: 5,
    });

    expect(pg.beginCalls).toBe(1);
    // EI-18802055183255275: the candidate set (spec filter + all claim floors) is
    // materialized ONCE (the CREATE TEMP TABLE), then counts, rows, the two-part sample
    // (floor ids + queue-control detail), and the WI-6673 admitted-composition read each
    // scan that materialized snapshot instead of recomputing it from scratch...
    //
    // WI-525554 adds ONE deliberate exception, which is why this is 7 and not 6: the
    // lane-scope population read (statement 2, right after the materialization) re-derives
    // from issueClaimCandidateSubquery instead of scanning the temp table, because it must
    // measure the FULL pre-pushdown population that the lane filter would otherwise destroy.
    // That does NOT weaken the invariant this test exists for: it runs on the SAME
    // transaction client, so it sees the same MVCC snapshot as every other statement here.
    // The load-bearing assertions are beginCalls and poolLog below, not this count.
    expect(pg.queries).toHaveLength(7);
    // ...and NOTHING was issued on a fresh pool checkout outside the snapshot. This is the
    // regression: independent checkouts is what let the readings disagree.
    expect(pg.poolLog).toEqual([]);
    // The reading is whole — every part present, from the one snapshot.
    expect(out.breakdown).toBeDefined();
    expect(out.rows).toEqual([]);
    expect(out.sample).toBeDefined();
    expect(out.admitted).toBeDefined();
  });

  it('pushes a single-spec filter into snapshot materialization and marks prefiltered rows matched', async () => {
    const pg = makePool();
    await readIssueClaimability(
      { field: 'kind', op: '=', value: 'bug' },
      { ...OPTS, client: pg.client },
      { limit: 20 },
    );

    const materialization = pg.queries[0] ?? '';
    const cteStart = materialization.indexOf('WITH filtered_claim_candidates AS MATERIALIZED');
    const cteEnd = materialization.indexOf(') SELECT', cteStart);
    const where = materialization.slice(cteStart, cteEnd);
    expect(materialization).toMatch(/\(TRUE\)\s+AS spec_match/);
    expect(where).toContain('COALESCE(item_kind, kind)');
    expect(where).toContain('= ?');
  });

  it('pushes the observation-lane floor into snapshot materialization before evaluating claim floors', async () => {
    const pg = makePool();
    await readIssueClaimability(
      { field: 'kind', op: '=', value: 'bug' },
      { ...OPTS, client: pg.client },
      { limit: 20 },
    );

    const materialization = pg.queries[0] ?? '';
    expect(materialization).toMatch(/WITH filtered_claim_candidates AS MATERIALIZED \(/);
    expect(materialization).toMatch(/FROM filtered_claim_candidates wi/);
    // The filter belongs to the CTE's base-table WHERE; the outer query only
    // decorates the already-filtered rows with the expensive claim floors.
    const cteEnd = materialization.indexOf(') SELECT');
    const fromFiltered = materialization.indexOf('FROM filtered_claim_candidates wi');
    expect(cteEnd).toBeGreaterThan(-1);
    expect(materialization.slice(0, cteEnd)).toMatch(/wi\.lane IS DISTINCT FROM 'observation'/);
    expect(materialization.indexOf('COALESCE(item_kind, kind)')).toBeLessThan(cteEnd);
    expect(fromFiltered).toBeGreaterThan(cteEnd);
  });

  it('keeps the raw columns floors need in the source CTE, not the 80-column work-item row', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });

    const materialization = pg.queries[0] ?? '';
    const cteEnd = materialization.indexOf(') SELECT');
    const projection = materialization.slice(0, materialization.indexOf('(TRUE) AS spec_match'));
    expect(cteEnd).toBeGreaterThan(-1);
    expect(projection).not.toContain('wi.*');
    expect(projection).toContain('wi.feature_id');
    expect(projection).toContain('wi.payload');
    // This CTE is only the filtered source for evaluating floors. Intake floor #16
    // consumes summary, and other floors consume payload, so both remain available here.
    // The separate persisted temp-table projection is guarded below.
    expect(projection).toContain('wi.summary');
    expect(projection).not.toContain('wi._search');
    expect(projection).not.toContain('wi.embedding');
  });

  it('persists a bounded payload projection and omits raw summary while preserving floor counts', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 });

    const materialization = pg.queries[0] ?? '';
    const cteEnd = materialization.indexOf(') SELECT');
    const fromFiltered = materialization.indexOf('FROM filtered_claim_candidates wi', cteEnd);
    const specMatch = materialization.indexOf('(TRUE) AS spec_match', cteEnd);
    expect(cteEnd).toBeGreaterThan(-1);
    expect(specMatch).toBeGreaterThan(cteEnd);
    expect(fromFiltered).toBeGreaterThan(specMatch);
    const snapshotColumns = materialization.slice(cteEnd + 2, specMatch);

    // The CTE still exposes raw floor inputs, but the local temp table receives only the
    // fields used by counts, rank, samples, and row listing. In particular it cannot copy
    // the wide summary or arbitrary evidence/body keys from payload into every row.
    expect(snapshotColumns).not.toContain('wi.summary');
    expect(snapshotColumns).not.toMatch(/(?:^|,)\s*wi\.payload\s*(?:,|$)/);
    expect(snapshotColumns).toContain('jsonb_strip_nulls(jsonb_build_object(');
    for (const key of [
      'paths', 'tags', 'severity', '_ei', 'clusterPriority', 'plan_item', 'planItem',
      'source_plan_slug', 'source_plan_item_ids', 'held_open_by', 'held_open_at',
      'held_open_reason', 'claim_hold_by', 'claim_hold_at', 'claim_hold_reason',
      'claim_hold_release', 'agentReview', 'submittedBy', 'ledgerIdeaId', 'revisionKind',
    ]) {
      expect(snapshotColumns, `persisted payload must retain ${key}`).toContain(`'${key}'`);
    }

    // Floor booleans remain in the same snapshot; compaction cannot turn a measured bucket
    // into a structural zero.
    expect(materialization).toContain('AS ok_claim_hold');
    expect(materialization).toContain('AS ok_live_gate_ops');
    expect(materialization).toContain('AS ok_stop_line');
  });

  // Derivation under test, extracted so the control case below can feed it a
  // deliberately-broken query and prove it actually reports a missing column.
  // Split at the CTE boundary, collect every `wi.<col>` the OUTER query reads,
  // and subtract what the CTE projects.
  function missingProjectedColumns(materialization: string): string[] {
    const cteEnd = materialization.indexOf(') SELECT');
    if (cteEnd < 0) return [];
    const cols = (segment: string) =>
      new Set([...segment.matchAll(/\bwi\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()));
    const projected = cols(materialization.slice(0, cteEnd));
    return [...cols(materialization.slice(cteEnd))].filter((c) => !projected.has(c)).sort();
  }

  // FALSIFIABILITY CONTROL. The assertion above passes today, which on its own
  // is indistinguishable from a check that can never fail — the exact way the
  // enumerated list it replaced stayed green while `wi.lane` was missing. These
  // two synthetic queries are permanent controls: one omits a projected column
  // and MUST be reported, one is complete and MUST come back clean. Without the
  // second, "reports something" would also be satisfied by a broken derivation
  // that flags everything.
  const SYNTHETIC_OUTER = `) SELECT (wi.lane IS DISTINCT FROM 'observation') AS ok_observation,
             wi.feature_id AS id FROM filtered_claim_candidates wi`;
  it('EI-21578114931113813: the derivation reports a column the CTE fails to project (control)', () => {
    const broken = `WITH filtered_claim_candidates AS MATERIALIZED (
        SELECT wi.feature_id, wi.payload FROM harness_shared.work_items wi WHERE TRUE
      ${SYNTHETIC_OUTER}`;
    // `lane` is read by the outer floor but never projected — this is the shape
    // that produced `column wi.lane does not exist` (42703) against live PG.
    expect(missingProjectedColumns(broken)).toEqual(['lane']);

    const complete = `WITH filtered_claim_candidates AS MATERIALIZED (
        SELECT wi.feature_id, wi.payload, wi.lane FROM harness_shared.work_items wi WHERE TRUE
      ${SYNTHETIC_OUTER}`;
    // Calibration: the same derivation must go quiet once the column is present,
    // so the result above is a real detection and not a constant.
    expect(missingProjectedColumns(complete)).toEqual([]);
  });

  // EI-21578114931113813. This guard used to be a HAND-ENUMERATED list of
  // `expect(projection).toContain('wi.<col>')` lines — and every entry on it was
  // added REACTIVELY, after the missing column had already taken
  // `work_items:claimable` down in production with `column wi.<col> does not
  // exist` (42703). `wi.lane` was merely the most recent: the base table has the
  // column, so nothing fails until PostgreSQL resolves the name against the
  // narrow CTE at runtime. Vitest cannot catch it either, because the projection
  // and the outer floors are assembled from different modules and only meet in
  // the generated SQL string.
  //
  // A hand-maintained list of "columns the outer query reads" is a second copy
  // of a truth the SQL already owns (CLAUDE.md, derived-truth ladder rung 1), so
  // it drifts by construction: the NEXT exclusion helper that starts reading a
  // new column strands exactly the same way, and the list only learns about it
  // after the next outage. Derive the requirement from the query instead — then
  // a new column is covered the moment it is referenced, with nobody having to
  // remember this file exists.
  it('EI-21578114931113813: every wi.<column> the outer floors read is present in the CTE projection (derived, not enumerated)', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });

    const materialization = pg.queries[0] ?? '';
    const cteEnd = materialization.indexOf(') SELECT');
    expect(cteEnd).toBeGreaterThan(-1);
    const cteProjection = materialization.slice(0, cteEnd);
    const outerQuery = materialization.slice(cteEnd);

    // Soundness precondition: `wi` must mean the materialized CTE throughout the
    // outer query. If some inner subquery ever re-aliases a real table to `wi`,
    // its column references are NOT the CTE's and the derivation below would
    // report them as false positives — fail loudly here instead of silently
    // widening the projection to satisfy a shadowed alias.
    expect(outerQuery).not.toMatch(/\bharness_shared\.\w+\s+(?:AS\s+)?wi\b/i);

    const referenced = [...outerQuery.matchAll(/\bwi\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0); // positive control: we really parsed SQL

    const missing = missingProjectedColumns(materialization);

    expect(
      missing,
      `The outer claimability floors read ${missing.length} column(s) the narrow CTE does not ` +
        `project: ${missing.join(', ')}. PostgreSQL resolves these against ` +
        `filtered_claim_candidates, not harness_shared.work_items, so work_items:claimable ` +
        `will fail at runtime with 'column wi.<name> does not exist' even though the base ` +
        `table has them. Add each to the claimability-snapshot projection in ` +
        `scheduler/get-next.ts.`,
    ).toEqual([]);
  });

  it('WI-6673: the admitted COMPOSITION is read in the same snapshot as the count it describes — never a separate checkout', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });
    // Composition that came from a DIFFERENT snapshot than the count would let a caller
    // quote a total and a make-up that never coexisted — the same class of defect WI-5947
    // fixed for counts-vs-rows.
    expect(pg.beginCalls).toBe(1);
    expect(pg.poolLog).toEqual([]);
    expect(out.admitted).toBeDefined();
  });

  it('WI-6673: composition is UNCONDITIONAL — present even under breakdownOnly, because the failure is quoting a count without asking what is in it', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      breakdownOnly: true,
    });
    expect(out.admitted).toBeDefined();
    expect(out.admitted.degenerate).toBe(false); // empty fake reads ⇒ empty pool
    expect(out.admitted.lowSeverityShare).toBeNull();
  });

  it('sets REPEATABLE READ + READ ONLY before any data statement (PG rejects it after, which would silently leave the reads on READ COMMITTED)', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 });

    // EI-18802055183255275: no longer ", READ ONLY" — Postgres unconditionally refuses
    // `CREATE TABLE AS` (even for a TEMP table) inside a read-only transaction, and this
    // function now materializes one. See the matching comment at the call site.
    expect(pg.txLog[0]).toBe('EXEC:SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(pg.txLog[1]).toMatch(/^EXEC:SET LOCAL statement_timeout = \d+$/);
    // Nothing may execute ahead of the isolation preamble — including the CREATE TEMP
    // TABLE materialization, which is itself the first QUERY (data statement).
    const firstQueryAt = pg.txLog.findIndex((l) => l.startsWith('QUERY:'));
    expect(firstQueryAt).toBeGreaterThan(1);
  });

  it('bounds the snapshot with a caller-tunable statement_timeout (the admin pool deliberately carries none)', async () => {
    const pg = makePool();
    await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      statementTimeoutMs: 2500,
    });
    expect(pg.txLog[1]).toBe('EXEC:SET LOCAL statement_timeout = 2500');
  });

  it('breakdownOnly reads the counts alone — still in a transaction, still one snapshot', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, {
      limit: 20,
      breakdownOnly: true,
    });
    expect(pg.beginCalls).toBe(1);
    // the materialization + the WI-525554 lane-scope population read + counts + the
    // unconditional admitted-composition read; the row list is skipped.
    expect(pg.queries).toHaveLength(4);
    expect(out.rows).toEqual([]);
    expect(out.sample).toBeUndefined();
  });

  it('omitting sampleLimit reads counts + rows (+ composition) only, and omits `sample` entirely (absent, not an empty sample)', async () => {
    const pg = makePool();
    const out = await readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20 });
    // materialization + the WI-525554 lane-scope population read + counts + rows + composition.
    expect(pg.queries).toHaveLength(5);
    expect(out.sample).toBeUndefined();
    expect('sample' in out).toBe(false);
  });

  it('a failed read THROWS — it never degrades to a partial or zeroed reading (a synthesised 0 is indistinguishable from a genuinely drained lane)', async () => {
    // query 1 = the CREATE TEMP TABLE materialization, query 2 = the WI-525554 lane-scope
    // population read, query 3 = the counts (all three succeed); query 4 = the row list —
    // the one that now fails.
    //
    // The ordinal MUST track that insertion. Left at 3 this test still passed, but it was
    // failing the COUNTS rather than the row list — a different statement than the name
    // claims, which is a silently weakened test rather than a loud one.
    const pg = makePool({ failAtQuery: 4 }); // the row list fails, after materialize+lane-scope+counts succeeded
    await expect(
      readIssueClaimability(undefined, { ...OPTS, client: pg.client }, { limit: 20, sampleLimit: 5 }),
    ).rejects.toThrow(/snapshot read failed/);
  });
});
