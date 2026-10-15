/**
 * read.integration.test.ts — the Queen decision-ledger READ surface
 * (decision_ledger mig 260/265 + autonomy_tripwires mig 266/269), against a real PG.
 * getOrgPg() is mocked to a per-test DB.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - readDecisionLedger is newest-first, workspace-scoped, with the filter passthroughs
 *    (layer/category/posture/disposition/sinceMs) narrowing in SQL;
 *  - the B-16 undo seam: the tripwireId correlated subselect surfaces a tripwire ONLY
 *    when status='armed' AND it correlates on BOTH decision_id::text and workspace_id
 *    (TEETHED here: the `AND t.status = 'armed'` gate);
 *  - summarizeDecisionLedger rolls the rows up by layer/posture/category/disposition
 *    and reports the newest ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const hb = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: hb.sql }) };
});

const { readDecisionLedger, summarizeDecisionLedger } = await import('./read');

const WS = 'ws-dl';
let rootSql: postgres.Sql;

// Insert a decision_ledger row, returning its generated id.
async function insDecision(over: Record<string, unknown> = {}): Promise<number> {
  const r = {
    workspace_id: WS, harness_slug: 'web', layer: 'action', ts: '2026-01-01T00:00:00Z',
    action: 'do', category: 'cat-a', posture: 'auto', outcome: 'ok', disposition: null,
    links: null, metadata: null, ...over,
  } as Record<string, unknown>;
  const rows = await rootSql<{ id: string }[]>`
    INSERT INTO harness_shared.decision_ledger
      (workspace_id, harness_slug, layer, ts, action, category, posture, outcome, disposition, links, metadata)
    VALUES (${r.workspace_id as string}, ${r.harness_slug as string}, ${r.layer as string}, ${r.ts as string},
            ${r.action as string}, ${r.category as string | null}, ${r.posture as string}, ${r.outcome as string},
            ${r.disposition as string | null},
            ${r.links == null ? null : rootSql.json(r.links as object)},
            ${r.metadata == null ? null : rootSql.json(r.metadata as object)})
    RETURNING id`;
  return Number(rows[0]!.id);
}

async function insTripwire(decisionId: number, status: string, ws = WS): Promise<string> {
  const id = `tw-${randomBytes(3).toString('hex')}`;
  await rootSql`
    INSERT INTO harness_shared.autonomy_tripwires (id, workspace_id, category, revert_handle, status, decision_id)
    VALUES (${id}, ${ws}, 'cat', '{}'::jsonb, ${status}, ${String(decisionId)})`;
  return id;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `dl_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to mig 260 (+ 265's disposition/revisit_at): the columns the reader touches.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.decision_ledger (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL, harness_slug text, layer text NOT NULL DEFAULT 'action',
      ts timestamptz NOT NULL DEFAULT now(), action text NOT NULL, capability text, tier text, category text,
      risk_tier text, reversibility text, authority text, posture text NOT NULL, outcome text NOT NULL, outcome_code text,
      disposition text, revisit_at timestamptz, revert_handle text, why text, links jsonb,
      actor_role text, actor_spawn_id text, actor_principal text, transport text, duration_ms integer, metadata jsonb,
      CONSTRAINT decision_ledger_layer_check CHECK (layer IN ('action','disposition')),
      CONSTRAINT decision_ledger_posture_check CHECK (posture IN ('auto','proposed','gated','rejected')),
      CONSTRAINT decision_ledger_outcome_check CHECK (outcome IN ('ok','error'))
    )`);
  // FAITHFUL to mig 266 (+ 269's decision_id): the columns the subselect correlates on.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.autonomy_tripwires (
      id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default', category text NOT NULL,
      revert_handle jsonb NOT NULL, status text NOT NULL DEFAULT 'armed'
        CHECK (status IN ('armed','cleared','tripped','reverted')),
      armed_at timestamptz NOT NULL DEFAULT now(), decision_id text
    )`);
  hb.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.decision_ledger, harness_shared.autonomy_tripwires RESTART IDENTITY`;
});

describe('decision-ledger read surface (PG)', () => {
  it('readDecisionLedger is newest-first, workspace-scoped, with mapped fields', async () => {
    await insDecision({ ts: '2026-01-01T00:00:00Z', action: 'old', links: { a: 1 }, metadata: { m: 2 } });
    await insDecision({ ts: '2026-03-01T00:00:00Z', action: 'new' });
    await insDecision({ workspace_id: 'other-ws', action: 'foreign' }); // invisible to WS

    const rows = await readDecisionLedger(WS);
    expect(rows.map((r) => r.action)).toEqual(['new', 'old']); // ts DESC, other-ws excluded
    const old = rows.find((r) => r.action === 'old')!;
    expect(typeof old.id).toBe('number'); // id coerced
    expect(old.ts).toBe('2026-01-01T00:00:00.000Z'); // ISO
    expect(old.links).toEqual({ a: 1 }); // jsonb → object
    expect(old.metadata).toEqual({ m: 2 });
  });

  it('tripwireId surfaces ONLY an ARMED tripwire correlated on decision_id AND workspace', async () => {
    const dArmed = await insDecision({ action: 'armed-one' });
    const twId = await insTripwire(dArmed, 'armed');
    const dReverted = await insDecision({ action: 'reverted-one' });
    await insTripwire(dReverted, 'reverted'); // not armed → must NOT surface
    const dCrossWs = await insDecision({ action: 'cross-ws' });
    await insTripwire(dCrossWs, 'armed', 'other-ws'); // armed but wrong workspace → must NOT surface

    const byAction = Object.fromEntries((await readDecisionLedger(WS)).map((r) => [r.action, r.tripwireId]));
    expect(byAction['armed-one']).toBe(twId); // armed + same ws → surfaced
    expect(byAction['reverted-one']).toBeNull(); // reverted → gated out
    expect(byAction['cross-ws']).toBeNull(); // ws-correlation excludes it
  });

  it('filters narrow in SQL (layer / posture / category / disposition / sinceMs)', async () => {
    await insDecision({ action: 'a1', layer: 'action', posture: 'auto', category: 'x', ts: '2026-01-01T00:00:00Z' });
    await insDecision({ action: 'd1', layer: 'disposition', posture: 'proposed', category: 'y', disposition: 'defer', ts: '2026-05-01T00:00:00Z' });

    expect((await readDecisionLedger(WS, { layer: 'disposition' })).map((r) => r.action)).toEqual(['d1']);
    expect((await readDecisionLedger(WS, { posture: 'auto' })).map((r) => r.action)).toEqual(['a1']);
    expect((await readDecisionLedger(WS, { category: 'y' })).map((r) => r.action)).toEqual(['d1']);
    expect((await readDecisionLedger(WS, { disposition: 'defer' })).map((r) => r.action)).toEqual(['d1']);
    expect((await readDecisionLedger(WS, { sinceMs: Date.parse('2026-03-01T00:00:00Z') })).map((r) => r.action)).toEqual(['d1']); // older a1 excluded
  });

  it('summarizeDecisionLedger rolls up by layer/posture/category/disposition + newest ts', async () => {
    await insDecision({ layer: 'action', posture: 'auto', category: 'x', ts: '2026-01-01T00:00:00Z' });
    await insDecision({ layer: 'disposition', posture: 'proposed', category: 'x', disposition: 'act', ts: '2026-02-01T00:00:00Z' });
    await insDecision({ layer: 'disposition', posture: 'proposed', category: 'y', disposition: 'defer', ts: '2026-04-01T00:00:00Z' });

    const s = await summarizeDecisionLedger(WS);
    expect(s.total).toBe(3);
    expect(s.byLayer).toEqual({ action: 1, disposition: 2 });
    expect(s.byPosture).toEqual({ auto: 1, proposed: 2 });
    expect(s.byCategory).toEqual({ x: 2, y: 1 });
    expect(s.byDisposition).toEqual({ act: 1, defer: 1 }); // null dispositions skipped
    expect(s.latestTs).toBe('2026-04-01T00:00:00.000Z'); // newest
  });
});
