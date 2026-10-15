/**
 * datatype-oddsmith-domain.integration.test — Phase 2 "prove on oddsmith" (P-005/P-006), the
 * in-tree proxy against real Postgres. Declares oddsmith's ACTUAL datatype set and proves both
 * tiers flow through the framework with zero bespoke plumbing:
 *   - REASONING datatypes (generic-kind): bet / wager / forecast / calibration-record — their
 *     work_item_kind is create-able and their payloads are schema-validated.
 *   - MONEY-TRUTH datatypes (projection, D-008): position / fill / cash / order — an external
 *     engine (`engine:oddsmith`) is the single writer, so they are NOT create-able via
 *     work_items:create (read-only — the projection-tier enforcement).
 *
 * The remaining Phase-2 piece (running the live oddsmith hive loop) needs the 2-machine/live
 * rig; this proves the framework SIDE of "prove on oddsmith" deterministically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertDatatype, getDatatype, getGenericKindDatatype, listDatatypes, datatypesSummary } from './datatype-registry-store';
import { validateDatatypePayload } from './datatype-payload-validation';
import { frontierPlacementKindClause, HIVE_PLACEMENT_TAG } from './datatype-frontier-placement';

const { createOrgTestDb } = await import('../test/_org-test-db');
const WS = 'oddsmith-ops';

const REASONING = {
  bet: { type: 'object', properties: { market: { type: 'string', minLength: 1 }, p_model: { type: 'number', minimum: 0, maximum: 1 }, edge: { type: 'number' } }, required: ['market', 'p_model'], additionalProperties: false },
  wager: { type: 'object', properties: { bet_id: { type: 'string' }, stake: { type: 'number', minimum: 0 } }, required: ['bet_id', 'stake'] },
  forecast: { type: 'object', properties: { question: { type: 'string' }, p: { type: 'number', minimum: 0, maximum: 1 } }, required: ['question', 'p'] },
  'calibration-record': { type: 'object', properties: { forecast_id: { type: 'string' }, outcome: { type: 'boolean' } }, required: ['forecast_id', 'outcome'] },
} as const;
const MONEY_TRUTH = ['position', 'fill', 'cash', 'order'] as const;

const SI = {
  improvements: [{ id: 'tighten', description: 'sharpen the estimate' }],
  scorecard: [{ metric: 'calibration', description: 'brier vs realized' }],
  gym: { signals: ['realized vs forecast'], rubric: 'a win improves calibration without new risk' },
};

describe('oddsmith domain datatypes (real PG) — Phase 2 framework proof', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    // createOrgTestDb applies the FULL migration set (incl. 421/425 and the D-007
    // pot-rename 506/523) — replaying 421/425 verbatim here is redundant AND re-runs
    // their old hive_slug index against the post-523 schema, 42703-ing "column
    // hive_slug does not exist". See datatype-registry.integration.test.ts.
    db = await createOrgTestDb();
    // Reasoning datatypes — generic-kind records (D-007). 'bet' still carries the retired
    // hive-placement tag, which since P-009 / D-022 must decide nothing.
    for (const [id, schema] of Object.entries(REASONING)) {
      await upsertDatatype(db.adminSql, {
        id, workspaceId: WS, title: id, description: `oddsmith ${id} reasoning datatype`,
        tier: 'generic-kind', nature: 'record', // D-007: bet/wager/forecast/calibration-record are records
        workItemKind: id, payloadSchema: schema, selfImprovement: SI,
        tags: id === 'bet' ? ['oddsmith', HIVE_PLACEMENT_TAG] : ['oddsmith'],
      });
    }
    // Money-truth datatypes — projection, engine-owned.
    for (const id of MONEY_TRUTH) {
      await upsertDatatype(db.adminSql, {
        id, workspaceId: WS, title: id, description: `oddsmith ${id} money-truth projection`,
        tier: 'projection', nature: id === 'fill' ? 'event' : 'record', // D-013 §4: a fill happened; the rest are state
        authoritativeWriter: 'engine:oddsmith', workItemKind: id,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('REASONING (generic-kind): each kind is create-able and payload-validated', async () => {
    const bet = await getGenericKindDatatype(db.adminSql, WS, 'bet');
    expect(bet).not.toBeNull();
    expect(bet!.tier).toBe('generic-kind');
    // valid payload passes; a schema violation is rejected (the validation a datatype provides).
    expect(validateDatatypePayload(bet!.payloadSchema, { market: 'BTC>100k EOY', p_model: 0.6 }).ok).toBe(true);
    expect(validateDatatypePayload(bet!.payloadSchema, { market: 'BTC>100k EOY' }).ok).toBe(false); // missing p_model
    expect(validateDatatypePayload(bet!.payloadSchema, { market: 'x', p_model: 2 }).ok).toBe(false); // p>1
    // all four reasoning kinds resolve through the create gate.
    for (const id of Object.keys(REASONING)) {
      expect(await getGenericKindDatatype(db.adminSql, WS, id)).not.toBeNull();
    }
  });

  it('MONEY-TRUTH (projection): engine-owned, NOT create-able via work_items (read-only enforced)', async () => {
    for (const id of MONEY_TRUTH) {
      const row = await getDatatype(db.adminSql, WS, id);
      expect(row!.tier).toBe('projection');
      expect(row!.authoritativeWriter).toBe('engine:oddsmith');
      // a projection kind is NOT a generic-kind ⇒ work_items:create's gate rejects it: Papercusp
      // cannot author a money-truth instance; the engine is the single writer (D-008).
      expect(await getGenericKindDatatype(db.adminSql, WS, id)).toBeNull();
    }
  });

  it('the whole oddsmith set is registered; no oddsmith kind is frontier-placeable (records are not work)', async () => {
    const all = (await listDatatypes(db.adminSql, WS)).map((d) => d.id).sort();
    expect(all).toEqual([...MONEY_TRUTH, ...Object.keys(REASONING)].sort());

    // Stamp each candidate the way migration 1322's mint trigger does (registry row wins;
    // no row = work/agent), then run the frontier clause over rows shaped like
    // harness_features_consolidated.
    const placeable = (
      await db.adminSql<{ item_kind: string }[]>`
        SELECT t.item_kind
          FROM unnest(${['bet', 'wager', 'position', 'feature']}::text[]) AS t(item_kind),
               LATERAL harness_shared.work_item_kind_nature(${WS}, t.item_kind) AS k,
               LATERAL (SELECT '{}'::jsonb AS payload) AS c
         WHERE ${frontierPlacementKindClause(db.adminSql)} ORDER BY t.item_kind`
    ).map((r) => r.item_kind);
    // P-009 / D-022: placement follows nature/audience. Only the built-in 'feature' (no
    // registry row = work/agent) is placed. 'bet' is a record even though it still carries
    // the retired hive-placement tag; 'wager' is a record; 'position' is a projection record.
    expect(placeable).toEqual(['feature']);
  });

  it('P-011 observability: datatypesSummary breaks the workspace down by tier + review-status', async () => {
    const s = await datatypesSummary(db.adminSql, WS);
    expect(s.total).toBe(8);
    expect(s.byTier['generic-kind']).toBe(4); // bet/wager/forecast/calibration-record
    expect(s.byTier['projection']).toBe(4); // position/fill/cash/order
    expect(s.byReviewStatus['none']).toBe(8); // none published yet
    expect(s.published).toBe(0);
  });
});
