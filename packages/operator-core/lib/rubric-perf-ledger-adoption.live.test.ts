/**
 * LIVE census for test-rubric-unification-2026-10-12 AUTO-BAR-R-10 (P-010, evidence plane
 * `live`, integration layer; ruling goal-agent-behavior-feedback-2026-09-06#D-023 rule 1:
 * a live census binds only in ledger form, as a committed *.live.test.ts):
 * "In the ledger-filled papercusp-app-performance scorecard, every criterion that baseline
 * EI-25797437572523561 measured by SQL or an instrument is rated from a ledger result."
 *
 * Population (fixed before counting): the ratings of the baseline scorecard
 * EI-25797437572523561 (rubric papercusp-app-performance rev 1) whose rating is a
 * measurement — anything except `unknown` / `not-assessed`. Every rev-1 criterion names an
 * `[instrument …]` binding (pg:…, host:…, static:…, desktop:…), so a rated baseline entry is
 * exactly a criterion the baseline measured by SQL or an instrument. N is reported, never
 * hard-coded; an empty population FAILS rather than passing vacuously.
 *
 * Subject: the newest non-retracted papercusp-app-performance scorecard created after the
 * baseline whose observation says it was ledger-filled (`observation.ledgerFilled === true`,
 * written by scorecards:emit { fromLedger: true }, AUTO-BAR-R-7).
 *
 * Property, per census criterion (each violation is named):
 *   rated        the subject card rates the criterion
 *   fromLedger   the rating says `ratedFrom: 'ledger'` and cites `ledgerResult.testRunId`
 *   real         that test_runs row exists, is a rubric check row (framework 'rubric-check')
 *                for this rubric + criterion, and was recorded after the baseline card
 *   latest       no newer check row for the same criterion existed when the card was filed
 *   compared     the baseline entry and the ledger value + unit are both present, so the
 *                comparison table printed below is complete for every census criterion
 * The in-file controls prove the checker rejects each failure, so a green run is not vacuous.
 *
 * GUARDED: this asserts over LIVE state, so it must never decide the green-checkpoint gate.
 * The live suite runs only when the operator database answers AND the run is not inside a
 * gate fire (PAPERCUSP_GATE_FIRE_ID unset, cwd not a *-checkpoint tree) AND it was either
 * dispatched by the operator test runner (PAPERCUSP_TEST_RUN_GROUP — set by testing:run and
 * by scorecards:emit when it executes a criterion's tests check) or explicitly enabled:
 *
 *   PAPERCUSP_PERF_LEDGER_CENSUS_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *     npm run test:file -- packages/operator-core/lib/rubric-perf-ledger-adoption.live.test.ts
 *
 * The bar binds this file with testName set to the LIVE case, so a skipped live case is
 * refused at grading (check_test_case_unresolved), never counted as a pass.
 */
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { allowRealPgForLiveSuite } from './testing/live-suite-real-pg';

// The oracle is SOURCE (./rubric-perf-ledger-adoption.ts) so a mutation of it is caught by the
// always-run controls below; it used to live in this file, where no source mutant could reach it.
import {
  type AdoptionInput,
  type BaselineEntry,
  type CheckRow,
  type LedgerRating,
  PERF_BASELINE_CARD,
  PERF_RUBRIC_REF,
  checkLedgerAdoption,
} from './rubric-perf-ledger-adoption';

const WORKSPACE = 'papercusp-workspace';

// ---------------------------------------------------------------------------
// Controls (always run): the oracle rejects each failure and accepts the good case.
// ---------------------------------------------------------------------------

const BASE: AdoptionInput['baseline'] = {
  createdAt: '2026-10-12T17:59:13.638Z',
  ratings: {
    a: { rating: 'misses', evidence: 'p95 25 s' },
    b: { rating: 'near', evidence: '2.3 MB/s' },
    z: { rating: 'unknown', evidence: 'not run' },
  },
};
const ROWS: CheckRow[] = [
  { testRunId: '10', rubricRef: PERF_RUBRIC_REF, criterionKey: 'a', recordedAt: '2026-10-14T00:00:00Z', value: 9000, unit: 'ms' },
  { testRunId: '11', rubricRef: PERF_RUBRIC_REF, criterionKey: 'b', recordedAt: '2026-10-14T00:00:00Z', value: 1.9, unit: 'MB/s' },
];
const GOOD_SUBJECT: NonNullable<AdoptionInput['subject']> = {
  id: 'EI-2',
  createdAt: '2026-10-14T01:00:00Z',
  ratings: {
    a: { rating: 'misses', ratedFrom: 'ledger', ledgerResult: { testRunId: 10 } },
    b: { rating: 'meets', ratedFrom: 'ledger', ledgerResult: { testRunId: '11' } },
  },
};

function rules(input: AdoptionInput): string[] {
  return checkLedgerAdoption(input).violations.map((v) => `${v.criterionKey}:${v.rule}`);
}

describe('R-10 ledger-adoption oracle controls (always run)', () => {
  it('accepts a fully ledger-filled card and builds the comparison for every census key', () => {
    const out = checkLedgerAdoption({ baseline: BASE, subject: GOOD_SUBJECT, checkRows: ROWS });
    expect(out.population).toEqual(['a', 'b']);
    expect(out.violations).toEqual([]);
    expect(out.comparison.map((c) => c.criterionKey)).toEqual(['a', 'b']);
  });

  it('fails an empty population instead of passing vacuously', () => {
    expect(rules({ baseline: { ...BASE, ratings: { z: BASE.ratings.z! } }, subject: GOOD_SUBJECT, checkRows: ROWS })).toEqual([
      '*:population',
    ]);
  });

  it('fails when no ledger-filled card exists', () => {
    expect(rules({ baseline: BASE, subject: null, checkRows: ROWS })).toEqual(['*:subject']);
  });

  it('fails a census criterion the card does not rate', () => {
    const subject = { ...GOOD_SUBJECT, ratings: { a: GOOD_SUBJECT.ratings.a! } };
    expect(rules({ baseline: BASE, subject, checkRows: ROWS })).toEqual(['b:rated']);
  });

  it('fails a hand-rated census criterion', () => {
    const subject = { ...GOOD_SUBJECT, ratings: { ...GOOD_SUBJECT.ratings, b: { rating: 'meets' } } };
    expect(rules({ baseline: BASE, subject, checkRows: ROWS })).toEqual(['b:fromLedger']);
  });

  it('fails a rating that cites a row that is not this criterion check row', () => {
    const subject = {
      ...GOOD_SUBJECT,
      ratings: { ...GOOD_SUBJECT.ratings, b: { rating: 'meets', ratedFrom: 'ledger', ledgerResult: { testRunId: 10 } } },
    };
    expect(rules({ baseline: BASE, subject, checkRows: ROWS })).toEqual(['b:real']);
  });

  it('fails a ledger result recorded before the baseline', () => {
    const rows = ROWS.map((r) => (r.criterionKey === 'a' ? { ...r, recordedAt: '2026-10-01T00:00:00Z' } : r));
    expect(rules({ baseline: BASE, subject: GOOD_SUBJECT, checkRows: rows })).toEqual(['a:real']);
  });

  it('fails a rating that is not the latest ledger result at filing time', () => {
    const rows = [...ROWS, { ...ROWS[0]!, testRunId: '12', recordedAt: '2026-10-14T00:30:00Z' }];
    expect(rules({ baseline: BASE, subject: GOOD_SUBJECT, checkRows: rows })).toEqual(['a:latest']);
  });

  it('ignores a check row recorded after the card was filed', () => {
    const rows = [...ROWS, { ...ROWS[0]!, testRunId: '13', recordedAt: '2026-10-15T00:00:00Z' }];
    expect(rules({ baseline: BASE, subject: GOOD_SUBJECT, checkRows: rows })).toEqual([]);
  });

  it('fails a comparison with no ledger unit', () => {
    const rows = ROWS.map((r) => (r.criterionKey === 'b' ? { ...r, unit: null } : r));
    expect(rules({ baseline: BASE, subject: GOOD_SUBJECT, checkRows: rows })).toEqual(['b:compared']);
  });
});

// ---------------------------------------------------------------------------
// LIVE census.
// ---------------------------------------------------------------------------

function liveRequested(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): boolean {
  if (env.PAPERCUSP_GATE_FIRE_ID?.trim()) return false;
  if (/-checkpoint(?:[\\/]|$)/.test(cwd)) return false;
  return env.PAPERCUSP_PERF_LEDGER_CENSUS_LIVE === '1' || Boolean(env.PAPERCUSP_TEST_RUN_GROUP?.trim());
}

describe('R-10 live guard controls (always run)', () => {
  it('never runs inside a gate fire or a checkpoint tree', () => {
    expect(liveRequested({ PAPERCUSP_GATE_FIRE_ID: 'f1', PAPERCUSP_PERF_LEDGER_CENSUS_LIVE: '1' }, '/x/papercusp')).toBe(false);
    expect(liveRequested({ PAPERCUSP_TEST_RUN_GROUP: 'g' }, '/x/papercusp-checkpoint/packages')).toBe(false);
  });
  it('runs when dispatched by the operator runner or explicitly enabled', () => {
    expect(liveRequested({ PAPERCUSP_TEST_RUN_GROUP: 'g' }, '/x/papercusp')).toBe(true);
    expect(liveRequested({ PAPERCUSP_PERF_LEDGER_CENSUS_LIVE: '1' }, '/x/papercusp')).toBe(true);
    expect(liveRequested({}, '/x/papercusp')).toBe(false);
  });
});

async function openLive(): Promise<Client | null> {
  if (!liveRequested()) return null;
  const client = new Client({ connectionString: getHarnessAdminUrl(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return client;
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }
}

const LIVE = await openLive();
allowRealPgForLiveSuite(Boolean(LIVE));

describe.skipIf(!LIVE)('LIVE: R-10 papercusp-app-performance ledger adoption census (AUTO-BAR-R-10)', () => {
  afterAll(async () => {
    await LIVE?.end();
  });

  it('every baseline-measured criterion is rated from its latest post-baseline ledger check result', async () => {
    const db = LIVE!;
    const baseRes = await db.query<{ created_at: Date; ratings: Record<string, BaselineEntry> | null }>(
      `SELECT to_timestamp(created_ts / 1000.0) AS created_at, payload->'observation'->'ratings' AS ratings
         FROM harness_shared.work_items
        WHERE workspace_id = $1 AND feature_id = $2`,
      [WORKSPACE, PERF_BASELINE_CARD],
    );
    const baseRow = baseRes.rows[0];
    expect(baseRow, `baseline card ${PERF_BASELINE_CARD} must exist`).toBeTruthy();
    const baseline = { createdAt: new Date(baseRow!.created_at).toISOString(), ratings: baseRow!.ratings ?? {} };

    const subjRes = await db.query<{ id: string; created_at: Date; ratings: Record<string, LedgerRating> | null }>(
      `SELECT feature_id AS id, to_timestamp(created_ts / 1000.0) AS created_at,
              payload->'observation'->'ratings' AS ratings
         FROM harness_shared.work_items
        WHERE workspace_id = $1
          AND payload->'observation'->>'rubricRef' = $2
          AND (payload->'observation'->>'ledgerFilled')::boolean IS TRUE
          AND COALESCE(payload->'observation'->>'retracted', 'false') <> 'true'
          AND created_ts > $3
        ORDER BY created_ts DESC
        LIMIT 1`,
      [WORKSPACE, PERF_RUBRIC_REF, Date.parse(baseline.createdAt)],
    );
    const s = subjRes.rows[0];
    const subject = s ? { id: s.id, createdAt: new Date(s.created_at).toISOString(), ratings: s.ratings ?? {} } : null;

    const rowRes = await db.query<{ id: string; created_at: Date; criterion_key: string; value: unknown; unit: string | null }>(
      `SELECT id::text AS id, created_at,
              execution_details->'check'->>'criterionKey' AS criterion_key,
              execution_details->'check'->'value' AS value,
              execution_details->'check'->>'unit' AS unit
         FROM harness_shared.test_runs
        WHERE framework = 'rubric-check'
          AND execution_details->'check'->>'rubricRef' = $1`,
      [PERF_RUBRIC_REF],
    );
    const checkRows: CheckRow[] = rowRes.rows.map((r) => ({
      testRunId: r.id,
      rubricRef: PERF_RUBRIC_REF,
      criterionKey: r.criterion_key,
      recordedAt: new Date(r.created_at).toISOString(),
      value: r.value,
      unit: r.unit,
    }));

    const out = checkLedgerAdoption({ baseline, subject, checkRows });
    // The recorded baseline comparison: one line per census criterion (ledger evidence).
    console.log(
      `R-10 census N=${out.population.length} baseline=${PERF_BASELINE_CARD}@${baseline.createdAt} subject=${subject?.id ?? 'none'} checkRows=${checkRows.length}`,
    );
    for (const c of out.comparison) {
      console.log(
        `R-10 compare ${c.criterionKey}: baseline ${c.baselineRating} (${c.baselineEvidence}) -> ledger ${c.ledgerRating} ${JSON.stringify(c.ledgerValue)} ${c.ledgerUnit}`,
      );
    }
    expect(out.violations, out.violations.map((v) => `${v.criterionKey} ${v.rule}: ${v.detail}`).join('\n')).toEqual([]);
    expect(out.comparison.length).toBe(out.population.length);
  });
});
