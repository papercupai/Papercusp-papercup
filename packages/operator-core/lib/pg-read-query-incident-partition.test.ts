import { describe, expect, it } from 'vitest';
import {
  buildExecutedPartitionAdvisory,
  executePredicatePartition,
  planPredicatePartition,
  predicatePartitionSql,
  renderPredicatePartition,
  type PredicatePartitionCell,
  type PredicatePartitionData,
} from './pg-read-query';

/**
 * AUTO-BAR-R-005-P-004 — the guard built on the RECORDED incident rather than a
 * synthetic shape: the 5-row `harness_shared.session_briefs` partition from
 * WI-10002017 comment 346985.
 *
 * The bar names its own falsifier: this test must FAIL whenever either the
 * all-NULL bucket or the minority state-only bucket goes missing from the
 * produced partition. Those two are not arbitrary picks — they are the two the
 * caller's scalars cannot see, for two different reasons. The all-NULL bucket is
 * invisible because NULL fails every comparison; the 2-row bucket is invisible
 * because it is small enough to read as noise. A partition that silently drops
 * either one reports a clean-looking census that has lost the finding.
 *
 * Lives in its own file, not inside pg-read-query.test.ts's EXECUTED-probe
 * describe, because that block belongs to P-002's in-flight close (WI-10002034)
 * and its fakeClient/route helpers are block-scoped. The small duplication below
 * is deliberate: it buys a guard that cannot collide with that lane.
 */

/** The recorded classes. Named, so a later reader cannot mistake one for a magic number. */
const INCIDENT = {
  /** jsonb activation path ABSENT -> NULL -> satisfies no branch. The whole point. */
  nullActivation: 13_657,
  applied: 255,
  specDiffersAndStateDiffers: 97,
  /** The minority bucket: spec EQUAL, state differs. Two rows. */
  specEqualStateDiffers: 2,
  failed: 1,
} as const;

const INCIDENT_TOTAL = 14_012;

/**
 * `<>` rather than the `IS DISTINCT FROM` this predicate would naturally use:
 * planPredicatePartition currently reads the FROM inside `IS DISTINCT FROM` as a
 * FROM clause and resolves the relation to the column name (WI-10002041, filed
 * with a distinguishing probe). Swap this back once that lands — the shape under
 * test is unaffected, but leaving the workaround unexplained would read as a
 * preference rather than a known defect.
 */
const INCIDENT_SQL = [
  'SELECT count(*) AS total,',
  "       count(*) FILTER (WHERE control_state->'activation'->>'status' <> 'applied') AS bricked,",
  '       count(*) FILTER (WHERE spec_revision <> applied_spec_revision) AS spec_differs',
  '  FROM harness_shared.session_briefs',
  " WHERE workspace_id = 'papercusp-workspace'",
].join('\n');

/** d1 = activation <> 'applied'; d2 = spec_revision <> applied_spec_revision. */
const INCIDENT_CELLS: PredicatePartitionCell[] = [
  { values: [null, null], rows: INCIDENT.nullActivation },
  { values: ['false', 'false'], rows: INCIDENT.applied },
  { values: ['true', 'true'], rows: INCIDENT.specDiffersAndStateDiffers },
  { values: ['true', 'false'], rows: INCIDENT.specEqualStateDiffers },
  { values: ['true', null], rows: INCIDENT.failed },
];

const ALL_NULL_BUCKET = `NULL | NULL → ${INCIDENT.nullActivation}`;
const STATE_ONLY_BUCKET = `true | false → ${INCIDENT.specEqualStateDiffers}`;

function data(cells: PredicatePartitionCell[] = INCIDENT_CELLS): PredicatePartitionData {
  return { cells, samples: ['brief-7f3a', 'brief-91cc'], totalRows: INCIDENT_TOTAL };
}

function render(cells?: PredicatePartitionCell[]): string {
  return renderPredicatePartition(planPredicatePartition(INCIDENT_SQL)!, data(cells));
}

const without = (marker: keyof typeof INCIDENT): PredicatePartitionCell[] =>
  INCIDENT_CELLS.filter((c) => c.rows !== INCIDENT[marker]);

describe('the recorded incident partition (WI-10002017 — AUTO-BAR-R-005-P-004)', () => {
  it('the fixture is the recorded census: five classes that exhaust the relation', () => {
    // Pins the fixture to the record. If someone edits a class count without
    // editing the total, this fails rather than quietly testing a different
    // incident than the one the bar names.
    const summed = Object.values(INCIDENT).reduce((a, b) => a + b, 0);
    expect(summed).toBe(INCIDENT_TOTAL);
    expect(INCIDENT_CELLS.reduce((a, c) => a + c.rows, 0)).toBe(INCIDENT_TOTAL);
  });

  it('a BARE COUNT cannot distinguish the 13,657-row NULL class', () => {
    // The caller's own scalars, computed exactly as Postgres would: a FILTER
    // counts a row only when its predicate is TRUE, and NULL is not TRUE.
    const isTrue = (v: string | null) => v === 'true';
    const bricked = INCIDENT_CELLS.filter((c) => isTrue(c.values[0])).reduce((a, c) => a + c.rows, 0);
    const specDiffers = INCIDENT_CELLS.filter((c) => isTrue(c.values[1])).reduce(
      (a, c) => a + c.rows,
      0,
    );

    expect(bricked).toBe(100);
    expect(specDiffers).toBe(INCIDENT.specDiffersAndStateDiffers);

    // THE DEFECT, stated as arithmetic: the caller sees bricked=100 against a
    // total of 14,012 and reads 13,912 rows as healthy. In fact 13,657 of them
    // were never evaluated at all — they satisfied no branch. The scalars cannot
    // separate "evaluated and fine" from "never evaluated", because the wrong
    // answer is shaped exactly like the right one.
    const accountedForByBuckets = bricked + INCIDENT.applied;
    expect(accountedForByBuckets).toBe(355);
    expect(accountedForByBuckets).not.toBe(INCIDENT_TOTAL);
    // The remainder is EXACTLY the all-NULL class, to the row: every other
    // class lands in one of the two buckets (`failed` is already inside
    // `bricked`, since 'failed' <> 'applied' is TRUE). So the shortfall is not
    // an approximation or a mix of causes — it is one silent population.
    expect(INCIDENT_TOTAL - accountedForByBuckets).toBe(INCIDENT.nullActivation);
  });

  it('the ADVISORY surfaces that same NULL class, as its own labelled cell', () => {
    const advisory = render();
    expect(advisory).toContain(ALL_NULL_BUCKET);
    // Per-dimension NULL rows: d2 carries the failed row's NULL as well, so the
    // two counts differ on purpose — a single conflated NULL total would hide
    // which dimension actually fell through.
    expect(advisory).toContain(
      `PER-DIMENSION NULL ROWS: d1=${INCIDENT.nullActivation}, d2=${
        INCIDENT.nullActivation + INCIDENT.failed
      }`,
    );
    // The cells reconcile to the unfiltered total, which is what makes the
    // partition exhaustive where the caller's buckets were not.
    expect(advisory).toContain(`PARTITION TOTAL: ${INCIDENT_TOTAL} of ${INCIDENT_TOTAL}`);
  });

  it('the advisory surfaces the 2-row minority state-only bucket', () => {
    expect(render()).toContain(STATE_ONLY_BUCKET);
  });

  // ---- Falsifiability. These are the bar's own failure conditions, run as
  // negative controls so the two assertions above cannot rot into decoration.
  // Mutating the shared checkout to prove the same thing is forbidden here and
  // unnecessary: the subject is a pure function, so a wrong input IS the mutant.

  it('GUARD: drops its verdict when the all-NULL bucket vanishes from the partition', () => {
    const degraded = render(without('nullActivation'));
    expect(degraded).not.toContain(ALL_NULL_BUCKET);
    expect(degraded).toContain('PER-DIMENSION NULL ROWS: d1=0');
    // And the loss is arithmetically visible: the cells no longer reach the
    // unfiltered total, which is the check the advisory tells the reader to run.
    expect(degraded).toContain(`PARTITION TOTAL: ${INCIDENT_TOTAL - INCIDENT.nullActivation} of ${INCIDENT_TOTAL}`);
  });

  it('GUARD: drops its verdict when the minority state-only bucket vanishes', () => {
    const degraded = render(without('specEqualStateDiffers'));
    expect(degraded).not.toContain(STATE_ONLY_BUCKET);
    // A 2-row loss moves the total by 2. Small enough to shrug at, which is
    // exactly why it needs a guard rather than an eyeball.
    expect(degraded).toContain(
      `PARTITION TOTAL: ${INCIDENT_TOTAL - INCIDENT.specEqualStateDiffers} of ${INCIDENT_TOTAL}`,
    );
  });

  it('renders the incident end-to-end through the executed probe', async () => {
    // Same fakeClient shape the EXECUTED-probe suite uses: boundedPgReadTxn calls
    // sql.begin(cb) and issues SET statements inside the transaction before the
    // callback runs, so a double that models only a tag function fails with
    // "sql.begin is not a function".
    const tx = Object.assign((..._a: unknown[]) => Promise.resolve([] as Record<string, unknown>[]), {
      unsafe: (text: string) => {
        if (/^\s*SET\b/i.test(text)) return Promise.resolve([]);
        if (/AS row_count/i.test(text)) {
          return Promise.resolve([
            { d1: null, d2: null, row_count: INCIDENT.nullActivation },
            { d1: false, d2: false, row_count: INCIDENT.applied },
            { d1: true, d2: true, row_count: INCIDENT.specDiffersAndStateDiffers },
            { d1: true, d2: false, row_count: INCIDENT.specEqualStateDiffers },
            { d1: true, d2: null, row_count: INCIDENT.failed },
          ]);
        }
        if (/AS total/i.test(text)) return Promise.resolve([{ total: INCIDENT_TOTAL }]);
        return Promise.resolve([{ sample: 'brief-7f3a' }]);
      },
    });
    const client = Object.assign((..._a: unknown[]) => Promise.resolve([]), {
      begin: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    }) as unknown as NonNullable<Parameters<typeof executePredicatePartition>[1]>['client'];

    const advisory = (await buildExecutedPartitionAdvisory(INCIDENT_SQL, { client }))!;
    // Booleans arrive from the driver and are stringified by the probe, so the
    // rendered cells must match the hand-built fixture above exactly.
    expect(advisory).toContain(ALL_NULL_BUCKET);
    expect(advisory).toContain(STATE_ONLY_BUCKET);
    expect(advisory).toContain(`PARTITION TOTAL: ${INCIDENT_TOTAL} of ${INCIDENT_TOTAL}`);
  });

  it('partitions the incident against session_briefs, not a column from its own predicate', () => {
    // Regression cover for the workaround at INCIDENT_SQL: if the relation ever
    // resolves to a predicate's right-hand column again, the emitted homework SQL
    // selects from something the caller never named and the probe cannot run.
    const plan = planPredicatePartition(INCIDENT_SQL)!;
    expect(plan.relation).toBe('harness_shared.session_briefs');
    expect(plan.dimensions).toHaveLength(2);
  });

  it("keeps the complete CTE population WHERE when FILTER buckets define the partition", () => {
    const sql = [
      'WITH scoped_briefs AS (',
      '  SELECT workspace_id, created_at, control_state',
      '    FROM harness_shared.session_briefs',
      "   WHERE workspace_id = 'papercusp-workspace'",
      "     AND created_at >= '2026-09-29T19:45:00Z'::timestamptz",
      "     AND created_at < '2026-09-29T19:50:00Z'::timestamptz",
      "     AND (source = 'native' OR source = 'hook')",
      ')',
      'SELECT count(*) AS total,',
      "       count(*) FILTER (WHERE control_state->'activation'->>'status' <> 'applied') AS pending,",
      "       count(*) FILTER (WHERE control_state->'activation'->>'status' = 'applied') AS applied",
      '  FROM scoped_briefs',
    ].join('\n');
    const plan = planPredicatePartition(sql)!;
    const partitionSql = predicatePartitionSql(plan);

    expect(plan.relation).toBe('harness_shared.session_briefs');
    expect(partitionSql).toContain("WHERE workspace_id = 'papercusp-workspace'");
    expect(partitionSql).toContain("created_at >= '2026-09-29T19:45:00Z'::timestamptz");
    expect(partitionSql).toContain("created_at < '2026-09-29T19:50:00Z'::timestamptz");
    expect(partitionSql).toContain("(source = 'native' OR source = 'hook')");
  });
});
