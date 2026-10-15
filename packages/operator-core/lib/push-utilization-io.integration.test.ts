/**
 * push-utilization-io.integration.test.ts — the P-011 utilization ledger LIVE
 * LEG against a real Postgres (table faithful to migration 610, mirroring
 * push-delivery-store.integration.test.ts).
 *
 * What the PG-free unit suite can't prove and this does:
 *   • recordPulled / recordActed stamp by (owner, handle_ref) on DELIVERED rows
 *     only — queued/dropped rows and other owners never take a stamp — and are
 *     first-observation-wins idempotent;
 *   • the END-TO-END P-011 read: real disposition rows (delivered / dropped /
 *     queued, stamped and aged in PG) → runUtilizationReport → the per-matcher
 *     dashboard rollup with the observation-grace policy applied to real
 *     `timestamptz::text` values — the live-leg "wired" evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { enqueuePush, recordDelivered, recordDropped, recordPulled, recordActed } =
  await import('./push-delivery-store');
const { runUtilizationReport } = await import('./push-utilization-io');

let rootSql: postgres.Sql;

const OWNER = 'su-recv';

function enqueue(over: Partial<Parameters<typeof enqueuePush>[0]> = {}) {
  return enqueuePush({
    targetOwnerId: OWNER,
    matcherKind: 'collision',
    severity: 'critical',
    handleKind: 'session',
    handleRef: 'su-peer',
    handleQuery: ['foo', 'bar'],
    teaser: 'peer su-peer converging — shared: foo, bar',
    score: 0.8,
    sourceSessionId: 'su-peer',
    ...over,
  });
}

/** Enqueue + flip to delivered in one step; returns the row id. */
async function delivered(over: Partial<Parameters<typeof enqueuePush>[0]> = {}) {
  const id = await enqueue(over);
  await recordDelivered([id]);
  return id;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pushutil_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 610.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.push_delivery (
      id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      target_owner_id   text NOT NULL,
      target_session_id text,
      workspace_id      text NOT NULL DEFAULT 'default',
      matcher_kind      text NOT NULL,
      severity          text NOT NULL,
      handle_kind       text NOT NULL,
      handle_ref        text NOT NULL,
      handle_query      jsonb NOT NULL DEFAULT '[]'::jsonb,
      teaser            text NOT NULL DEFAULT '',
      score             double precision NOT NULL DEFAULT 0,
      source_session_id text,
      status            text NOT NULL DEFAULT 'queued',
      drop_reason       text,
      enqueued_at       timestamptz NOT NULL DEFAULT now(),
      delivered_at      timestamptz,
      pulled_at         timestamptz,
      acted_at          timestamptz
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.push_delivery`;
});

describe('recordPulled / recordActed (PG) — the P-011 outcome stamps', () => {
  it('stamps by (owner, ref) on delivered rows only; first observation wins', async () => {
    const target = await delivered({ handleRef: 'su-a' });
    await enqueue({ handleRef: 'su-a' }); // same ref, still queued — must not stamp
    await delivered({ handleRef: 'su-a', targetOwnerId: 'su-other' }); // other owner — must not stamp

    expect(await recordPulled(OWNER, 'su-a')).toBe(1);
    expect(await recordPulled(OWNER, 'su-a')).toBe(0); // already stamped — idempotent

    const rows = await rootSql<{ id: number; pulled_at: string | null }[]>`
      SELECT id, pulled_at FROM harness_shared.push_delivery ORDER BY id`;
    const stamped = rows.filter((r) => r.pulled_at != null).map((r) => Number(r.id));
    expect(stamped).toEqual([target]);
  });

  it('recordActed is independent of pulled (teaser-alone engagement) and skips dropped rows', async () => {
    const live = await delivered({ handleRef: 'su-a' });
    const droppedId = await enqueue({ handleRef: 'su-b' });
    await recordDropped([{ id: droppedId, reason: 'below-floor' }]);

    expect(await recordActed(OWNER, 'su-a')).toBe(1);
    expect(await recordActed(OWNER, 'su-b')).toBe(0); // dropped — never reached the receiver

    const row = (await rootSql<{ pulled_at: string | null; acted_at: string | null }[]>`
      SELECT pulled_at, acted_at FROM harness_shared.push_delivery WHERE id = ${live}`)[0]!;
    expect(row.acted_at).not.toBeNull();
    expect(row.pulled_at).toBeNull(); // acted never implies pulled
  });
});

describe('runUtilizationReport end-to-end (PG) — the P-011 wired evidence', () => {
  it('rolls real disposition rows into the per-matcher dashboard with the grace policy', async () => {
    // collision: pulled + ignored(stale) + pending(fresh) + one drop.
    await delivered({ handleRef: 'su-a' });
    await recordPulled(OWNER, 'su-a');
    const stale = await delivered({ handleRef: 'su-b' });
    await rootSql`UPDATE harness_shared.push_delivery SET delivered_at = now() - interval '2 hours' WHERE id = ${stale}`;
    await delivered({ handleRef: 'su-c' }); // fresh, unstamped → pending
    const droppedId = await enqueue({ handleRef: 'su-d' });
    await recordDropped([{ id: droppedId, reason: 'budget-exhausted' }]);
    // dead-end: acted (teaser alone), aged past the grace so it counts as observed.
    const acted = await delivered({ matcherKind: 'dead-end', handleKind: 'fact', handleRef: 'fact/x', severity: 'warning' });
    await rootSql`UPDATE harness_shared.push_delivery SET delivered_at = now() - interval '2 hours' WHERE id = ${acted}`;
    await recordActed(OWNER, 'fact/x');
    // still queued — skipped from the ledger, counted.
    await enqueue({ handleRef: 'su-e' });

    const result = await runUtilizationReport({ targetOwnerId: OWNER });

    expect(result.counts).toEqual({ rows: 6, ledgerEntries: 5, queued: 1, pendingObservation: 1 });

    const collision = result.report.matchers.find((m) => m.matcherKind === 'collision')!;
    expect(collision.delivered).toBe(3);
    expect(collision.observed).toBe(2); // su-c pending, excluded
    expect(collision.pulled).toBe(1);
    expect(collision.engaged).toBe(1);
    expect(collision.ignored).toBe(1); // su-b: delivered-but-never-pulled — the D-005 signal
    expect(collision.droppedByReason['budget-exhausted']).toBe(1);
    expect(collision.deliveryRate).toBe(3 / 4);

    const deadEnd = result.report.matchers.find((m) => m.matcherKind === 'dead-end')!;
    expect(deadEnd.observed).toBe(1);
    expect(deadEnd.acted).toBe(1);
    expect(deadEnd.pulled).toBe(0);
    expect(deadEnd.engagementRate).toBe(1);

    // Advisory-only, all the way through — and thin data never recommends eviction.
    expect(result.report.advisoryOnly).toBe(true);
    expect(result.report.recommendations.every((r) => r.advisoryOnly)).toBe(true);
    expect(result.report.recommendations.every((r) => r.suggestedAction === 'gather-more-data')).toBe(true);
  });

  it('the owner cut excludes other receivers; the enqueue window excludes old rows', async () => {
    await delivered({ handleRef: 'su-a' });
    await delivered({ handleRef: 'su-x', targetOwnerId: 'su-other' });
    const old = await delivered({ handleRef: 'su-old' });
    await rootSql`UPDATE harness_shared.push_delivery SET enqueued_at = now() - interval '10 days' WHERE id = ${old}`;

    const result = await runUtilizationReport({
      targetOwnerId: OWNER,
      since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    });
    expect(result.counts.rows).toBe(1);
    expect(result.report.matchers.find((m) => m.matcherKind === 'collision')!.delivered).toBe(1);
  });
});
