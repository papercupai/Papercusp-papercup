/**
 * Hold census against a fully migrated Postgres (plan
 * unified-bug-pipeline-and-honest-queue-2026-10-05 P-001 / D-026 points 5-6).
 *
 * Seeds rows held in every domain, plus rows the census must NOT count (terminal, observation
 * lane, another workspace), and drives the real paged query and payload projection. One harness
 * holds only registered holds and must report zero holds with no clearer; the other carries two
 * unregistered holds and must name them. A page size of 2 forces the keyset paging through
 * several pages, so a dropped or repeated page shows up as a wrong total.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { holdCensus, renderHoldCensus, type HoldCensusOptions } from './hold-census';

let db: OrgTestDb;
let sql: NonNullable<HoldCensusOptions['sql']>;

const WS = 'ws-hold-census';
const MAPPED = 'hc-mapped';
const UNMAPPED = 'hc-unmapped';
// A complete answerable ask (D-029): every field hasActiveStrictHumanAsk requires, on one blocker.
const ask = {
  status: 'active',
  kind: 'human',
  capability: 'product-decision',
  ref: 'hc-decision',
  summary: 'Ship the change or hold it?',
  createdBy: 'su-test',
  createdAt: '2026-10-06T00:00:00.000Z',
  nextVerb: 'work_items:set_blocker { op: "clear" }',
  defaultIfUnanswered: 'ship it',
};

async function seed(
  harness: string,
  id: string,
  status: string,
  payload: Record<string, unknown>,
  workspace = WS,
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload, origin, title)
    VALUES (${harness}, ${id}, 'bug', ${status}, ${workspace}, 0, 0,
            ${sql.json(payload as Parameters<typeof sql.json>[0])}, 'local', ${id})`;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql as unknown as typeof sql;

  // Every domain, all registered: the census must find holds and no hold without a clearer.
  const bulk = { summary: 'x'.repeat(4000), toolFailureProbation: { class: 'caller' } };
  await seed(MAPPED, 'EI-readiness', 'open', { ...bulk, implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' } });
  await seed(MAPPED, 'EI-review', 'open', { agentReview: { status: 'pending' } });
  await seed(MAPPED, 'EI-blocker', 'blocked', { externalBlockers: [{ status: 'active', kind: 'external', capability: 'credential' }] });
  await seed(MAPPED, 'EI-lease', 'wip', { _claimHold: true, held_open_by: 'su-1' });
  await seed(MAPPED, 'EI-ask', 'needs-human', { externalBlockers: [ask] });
  await seed(MAPPED, 'EI-ready', 'open', { implementationReadiness: { status: 'ready', reason: 'anything' } });
  // Out of the population even though their holds are unregistered.
  await seed(MAPPED, 'EI-done', 'done', { implementationReadiness: { status: 'unknown', reason: 'unregistered-terminal' } });
  await seed(MAPPED, 'EI-obs', 'open', { lane: 'observation', implementationReadiness: { status: 'unknown', reason: 'unregistered-observation' } });
  await seed(MAPPED, 'EI-other-ws', 'open', { implementationReadiness: { status: 'unknown', reason: 'unregistered-elsewhere' } }, 'ws-someone-else');

  // Two holds nobody clears, beside one that is registered.
  await seed(UNMAPPED, 'EI-free-text', 'open', { implementationReadiness: { status: 'not-ready', reason: 'legacy-free-text' } });
  await seed(UNMAPPED, 'EI-bare-human', 'needs-human', {});
  await seed(UNMAPPED, 'EI-park', 'open', { _claimHold: true });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('hold census (P-001 / D-026)', () => {
  it('a harness whose holds are all registered reports holds, and zero with no clearer', async () => {
    const census = await holdCensus(WS, { harness: MAPPED, sql, pageSize: 2 });
    expect(census.scanned).toBe(6);
    expect(census.held).toBe(5);
    expect(census.byKey).toEqual({
      'readiness:awaiting-agent-review': 1,
      'review:pending': 1,
      'blocker:credential': 1,
      'park:lease': 1,
      'blocker:product-decision': 1,
      'needs-human:strict-human-ask': 1,
    });
    expect(census.byDomain).toEqual({ readiness: 1, review: 1, blocker: 2, park: 1, 'needs-human': 1 });
    expect(census.byClearerKind.none ?? 0).toBe(0);
    expect(census.unmappedCount).toBe(0);
    expect(census.unmapped).toEqual([]);
  });

  it('names every hold with no clearer; the sample is capped but the counts stay totals', async () => {
    const census = await holdCensus(WS, { harness: UNMAPPED, sql, pageSize: 2, sampleLimit: 1 });
    expect(census.scanned).toBe(3);
    expect(census.held).toBe(3);
    expect(census.unmappedCount).toBe(2);
    expect(census.byClearerKind.none).toBe(2);
    expect(census.unmappedByKey).toEqual({
      'readiness:legacy-free-text': 1,
      'needs-human:needs-human-without-answerable-ask': 1,
    });
    expect(census.unmapped).toHaveLength(1);
    expect(census.unmappedSampleTruncated).toBe(true);
    expect(census.unmapped[0]).toMatchObject({ harness: UNMAPPED });
    expect(renderHoldCensus(census)).toContain('no-clearer=2');
  });

  it('workspace-wide, every page is read exactly once whatever the page size', async () => {
    const paged = await holdCensus(WS, { sql, pageSize: 1, sampleLimit: 10 });
    const whole = await holdCensus(WS, { sql });
    expect(paged.scanned).toBe(9);
    expect(paged.unmappedCount).toBe(2);
    expect(paged.unmapped.map((row) => row.id).sort()).toEqual(['EI-bare-human', 'EI-free-text']);
    expect({ ...paged, unmapped: [] }).toEqual({ ...whole, unmapped: [] });
  });
});
