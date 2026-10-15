/**
 * Guards for dev:pg_query advisory fire telemetry (plan
 * `dry-run-for-claims-preview-a-predicate-partition-null-traps-2026-09-20`, P-003).
 *
 * Two properties carry this module, and both are the kind that fail SILENTLY
 * toward a confident wrong number rather than toward an error:
 *
 *   1. A fire is counted at DELIVERY, not at computation. pg_query composes
 *      every sql-shape advisory up front, but the unbounded-json-search path
 *      returns early carrying only its own. Counting the computed set there
 *      would inflate the exact number the plan's "<5 queries/week" falsifier
 *      reads — turning a too-narrow trigger into a healthy-looking one.
 *
 *   2. "the migration has not applied" must never render as a measured zero.
 *      Migration 720's header names this trap directly: a counter nobody writes
 *      reads exactly like a clean bill of health.
 */
import { describe, it, expect } from 'vitest';
import {
  firesForDelivery,
  countAdvisoryFires,
  recordAdvisoryFires,
  labelDeliveredAdvisories,
  SQL_SHAPE_ADVISORY_LABELS,
  DELIVERED_ADVISORY_LABELS,
  ERROR_PATH_ADVISORY_LABELS,
  type LabelledAdvisory,
} from './fires';

/** A tagged-template stand-in for the postgres client. */
function fakeSql(behaviour: { rows?: unknown[]; throws?: unknown }) {
  const fn = async () => {
    if (behaviour.throws !== undefined) throw behaviour.throws;
    return behaviour.rows ?? [];
  };
  return fn as unknown as NonNullable<Parameters<typeof countAdvisoryFires>[0]['client']>;
}

const SLOTS: LabelledAdvisory[] = [
  ['json-text-search', null],
  ['epoch-unit', '⚠ epoch seconds divided by 1000.'],
  ['non-summing-partition', '⚠ a non-zero scalar may be missing rows.'],
  ['unused-cte', null],
];

describe('firesForDelivery', () => {
  it('records only the advisories that actually produced text', () => {
    const fires = firesForDelivery(SLOTS, 'success');
    expect(fires.map((f) => f.advisoryLabel)).toEqual(['epoch-unit', 'non-summing-partition']);
  });

  it('stamps deliveredWith so dilution stays distinguishable from a solo delivery', () => {
    const many = firesForDelivery(SLOTS, 'success');
    expect(many.every((f) => f.deliveredWith === 2)).toBe(true);

    const solo = firesForDelivery([['epoch-unit', 'x']], 'success');
    expect(solo[0].deliveredWith).toBe(1);
  });

  it('does NOT count an advisory that was computed but not delivered', () => {
    // The refusal path: every advisory was built, but only json-text-search was
    // put in front of the caller. Counting the other three here is the inflation
    // this rule exists to prevent.
    const refused = firesForDelivery(
      [['json-text-search', '⚠ unbounded json search.']],
      'refused',
    );
    expect(refused).toHaveLength(1);
    expect(refused[0].outcome).toBe('refused');

    // CONTROL: the same slot set counted at COMPUTATION time would report 3.
    // If firesForDelivery ever starts agreeing with this number, the delivery
    // rule has been lost.
    const computed = SLOTS.filter(([, t]) => t !== null).length + 1;
    expect(refused.length).not.toBe(computed);
  });

  it('treats whitespace-only advisory text as not fired', () => {
    expect(firesForDelivery([['epoch-unit', '   ']], 'success')).toEqual([]);
  });

  it('returns nothing when no advisory fired', () => {
    expect(firesForDelivery([['a', null], ['b', null]], 'success')).toEqual([]);
  });
});

describe('countAdvisoryFires status discrimination', () => {
  const window = { workspaceId: 'w', since: new Date(0), until: new Date(1) };

  it('reports measured counts with a real total', async () => {
    const r = await countAdvisoryFires({
      ...window,
      client: fakeSql({ rows: [
        { advisory_label: 'non-summing-partition', n: '7' },
        { advisory_label: 'epoch-unit', n: 2 },
      ] }),
    });
    expect(r.status).toBe('measured');
    if (r.status !== 'measured') throw new Error('unreachable');
    expect(r.byLabel['non-summing-partition']).toBe(7);
    expect(r.total).toBe(9);
  });

  it('a MEASURED empty window is a real zero, and says so', async () => {
    const r = await countAdvisoryFires({ ...window, client: fakeSql({ rows: [] }) });
    expect(r.status).toBe('measured');
    if (r.status !== 'measured') throw new Error('unreachable');
    expect(r.total).toBe(0);
  });

  it('an ABSENT table is NOT a zero — the trap migration 720 documents', async () => {
    const r = await countAdvisoryFires({
      ...window,
      client: fakeSql({ throws: Object.assign(new Error('relation does not exist'), { code: '42P01' }) }),
    });
    expect(r.status).toBe('not-instrumented');
    // The whole point: there is no number to read here at all. A caller that
    // coerced this to 0 would report "the advisory never fired" about a
    // database that was never instrumented.
    expect(r).not.toHaveProperty('total');
  });

  it('any other failure is unavailable, not zero and not not-instrumented', async () => {
    const r = await countAdvisoryFires({
      ...window,
      client: fakeSql({ throws: Object.assign(new Error('connection closed'), { code: '08006' }) }),
    });
    expect(r.status).toBe('unavailable');
    expect(r).not.toHaveProperty('total');
  });
});

describe('advisory label lists', () => {
  // These counts are PINS, not trivia. The labels are a hand-maintained second
  // copy of an anonymous array literal in pg_query.ts, so the failure mode is
  // an inserted advisory shifting every later label by one — which produces a
  // complete, plausible, entirely misattributed report. A failure here means
  // "go add the label", not "update the number".
  it('pins the sql-shape advisory count', () => {
    expect(SQL_SHAPE_ADVISORY_LABELS).toHaveLength(18);
  });

  it('composes the success list as sql-shape plus the four result-derived ones', () => {
    expect(DELIVERED_ADVISORY_LABELS).toHaveLength(22);
    expect(DELIVERED_ADVISORY_LABELS[18]).toBe('tenant-scope');
  });

  it('gives the ERROR path its own tail — routing, never tenant-scope', () => {
    // The specific misattribution this list exists to prevent: the error path
    // appends only toolRoutingAdvisory, so reusing the success labels would
    // record every routing advisory on a failed query as a tenant-scope fire.
    expect(ERROR_PATH_ADVISORY_LABELS).toHaveLength(19);
    expect(ERROR_PATH_ADVISORY_LABELS[18]).toBe('tool-routing');
    expect(ERROR_PATH_ADVISORY_LABELS[18]).not.toBe(DELIVERED_ADVISORY_LABELS[18]);
  });

  it('refuses to guess when values outrun labels', () => {
    const labelled = labelDeliveredAdvisories(['a', 'b', 'c'], ['first']);
    expect(labelled[0][0]).toBe('first');
    // Explicitly unlabelled rather than borrowing a neighbour's name: a
    // mislabelled fire is a wrong number that looks right.
    expect(labelled[1][0]).toBe('unlabelled:1');
    expect(labelled[2][0]).toBe('unlabelled:2');
    expect(labelled).toHaveLength(3);
  });
});

describe('recordAdvisoryFires', () => {
  it('writes nothing and reports 0 when nothing fired', async () => {
    expect(await recordAdvisoryFires({ workspaceId: 'w', fires: [], client: fakeSql({}) })).toBe(0);
  });

  it('records NOTHING when the workspace is unknown, rather than inventing one', async () => {
    // ctx.workspaceId is string|undefined. Coercing to '' would satisfy the
    // NOT NULL column while pooling unattributable fires into a phantom tenant
    // that every per-workspace window would then report on.
    let wrote = false;
    const spy = (async () => {
      wrote = true;
      return [];
    }) as unknown as NonNullable<Parameters<typeof recordAdvisoryFires>[0]['client']>;
    const n = await recordAdvisoryFires({
      workspaceId: undefined,
      fires: firesForDelivery(SLOTS, 'success'),
      client: spy,
    });
    expect(n).toBe(0);
    expect(wrote).toBe(false);
  });

  it('never throws on a failing write — it sits behind a live query result', async () => {
    const n = await recordAdvisoryFires({
      workspaceId: 'w',
      fires: firesForDelivery(SLOTS, 'success'),
      client: fakeSql({ throws: new Error('db down') }),
    });
    expect(n).toBe(0);
  });
});
