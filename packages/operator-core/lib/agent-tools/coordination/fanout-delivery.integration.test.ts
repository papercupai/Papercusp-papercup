// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'wake-pacing-test' }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
let store = await import('../../events/await/store');
let pacing = await import('./wake-fanout-pacing');

describe('bulk wakes persist and pace across operator restarts (real PG)', () => {
  let db: OrgTestDb;
  let reconnect: postgres.Sql | undefined;
  beforeAll(async () => { db = await createOrgTestDb({ adminPoolMax: 8 }); h.sql = db.adminSql; }, 120_000);
  afterAll(async () => { await reconnect?.end({ timeout: 5 }); await db?.cleanup(); });
  beforeEach(async () => {
    const sql = h.sql as postgres.Sql;
    await sql`TRUNCATE harness_shared.event_wake_deliveries, harness_shared.event_awaits RESTART IDENTITY CASCADE`;
    await sql`DELETE FROM harness_shared.fleet_governor WHERE scope_key LIKE 'wake-fanout:%'`;
  });

  it('stores 200 scheduled wakes, reconnects/reloads, and eventually delivers every target without releasing an overdue herd', async () => {
    const targets = Array.from({ length: 200 }, (_, i) => `restart-target-${i}`);
    const awaits = await Promise.all(targets.map((subscriberId) => store.registerAwait({ subscriberId, eventKey: 'fleet:resume:pacing' })));
    const fired = await store.fireAwaitsForKey({ eventKey: 'fleet:resume:pacing' });
    let deferred = 0;
    expect(await store.insertDeliveries({ awaits: fired, pacingWorkspaceId: h.ws, source: 'fleet:resume',
      payload: { fleet: 'pacing' }, onDeferred: () => { deferred++; } })).toBe(200);
    expect(deferred).toBeGreaterThanOrEqual(190);
    const original = await db.adminSql<{ subscriber_id: string; next_attempt_at: Date; payload: unknown }[]>`
      SELECT subscriber_id, next_attempt_at, payload FROM harness_shared.event_wake_deliveries ORDER BY next_attempt_at, id
    `;
    expect(original).toHaveLength(200);
    const times = original.map((r) => new Date(r.next_attempt_at).getTime());
    expect(times.at(-1)! - times[0]).toBeGreaterThan(60_000);
    expect(times.filter((t) => t <= times[0] + 60_000)).toHaveLength(15);
    expect(original.every((r) => pacing.readWakeFanoutPacing(r.payload)?.workspaceId === h.ws)).toBe(true);

    // Destroy the producer's DB connection and reload modules: no in-memory state carries.
    await db.adminSql.end({ timeout: 5 });
    reconnect = postgres(db.adminDsn, { max: 8, prepare: false, onnotice: () => {} });
    h.sql = reconnect;
    vi.resetModules();
    store = await import('../../events/await/store');
    pacing = await import('./wake-fanout-pacing');
    const [{ n }] = await reconnect`SELECT count(*)::int AS n FROM harness_shared.event_wake_deliveries`;
    expect(n).toBe(200);
    const afterRestart = await pacing.reserveWakeFanout(1, h.ws);
    expect(afterRestart[0].notBeforeMs).toBeGreaterThan(times.at(-1)!);

    // Model an outage longer than the schedule. Even when every row is due, the
    // execution bucket admits five, then only one for each six seconds of refill.
    await reconnect`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now() - interval '1 hour'`;
    const claimed = await store.claimDueDeliveries({ limit: 250 });
    expect(claimed).toHaveLength(200);
    const delivered = new Set<string>();
    let deferredAfterRestart = 0;
    for (const d of claimed) {
      const delay = await pacing.admitWakeFanout(pacing.readWakeFanoutPacing(d.payload)!);
      if (delay > 0) { await store.markDeliveryDeferred(d.id, delay); deferredAfterRestart++; }
      else { await store.markDeliveryDelivered(d.id, 'inbox'); delivered.add(d.subscriberId); }
    }
    expect(delivered.size).toBe(5);
    expect(deferredAfterRestart).toBe(195);

    // Advance the persisted clock anchor in the isolated fixture, not a production
    // timeout. Each step refills exactly one token; the real due/settle SQL drains.
    for (let i = 0; i < 195; i++) {
      await reconnect`UPDATE harness_shared.fleet_governor SET updated_at = now() - interval '6.01 seconds'
        WHERE workspace_id = ${h.ws} AND scope_key = ${pacing.WAKE_FANOUT_EXECUTION_SCOPE}`;
      await reconnect`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now() WHERE status = 'pending'`;
      const due = await store.claimDueDeliveries({ limit: 1 });
      expect(due).toHaveLength(1);
      expect(await pacing.admitWakeFanout(pacing.readWakeFanoutPacing(due[0].payload)!)).toBe(0);
      await store.markDeliveryDelivered(due[0].id, 'inbox');
      delivered.add(due[0].subscriberId);
    }
    expect([...delivered].sort()).toEqual(targets.sort());
    const [{ pending }] = await reconnect`SELECT count(*)::int AS pending FROM harness_shared.event_wake_deliveries
      WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND status <> 'delivered'`;
    expect(pending).toBe(0);
    expect(awaits).toHaveLength(200);
  }, 60_000);

  it('concurrent producers share a workspace bucket while other workspaces keep their burst', async () => {
    const [a, b, other] = await Promise.all([
      pacing.reserveWakeFanout(100, 'ws-same'), pacing.reserveWakeFanout(100, 'ws-same'), pacing.reserveWakeFanout(6, 'ws-other'),
    ]);
    const times = [...a, ...b].map((p) => p.notBeforeMs).sort((x, y) => x - y);
    expect(times.filter((t) => t <= times[0] + 1000)).toHaveLength(5);
    expect(times.at(-1)! - times[0]).toBeGreaterThan(60_000);
    expect(other.slice(0, 5).every((p) => p.notBeforeMs === other[0].notBeforeMs)).toBe(true);
  });

  it('small, urgent and loop deliveries stay due while a bulk reservation is outstanding', async () => {
    await pacing.reserveWakeFanout(200, h.ws);
    for (const [source, urgent] of [['owner-directed', true], ['loop:rt-loop', false], ['directed', false]] as const) {
      const a = await store.registerAwait({ subscriberId: source, eventKey: `wake:${source}` });
      await store.insertDeliveries({ awaits: [a], urgent, source });
    }
    const due = await store.claimDueDeliveries({ limit: 10 });
    expect(due.map((d) => d.subscriberId).sort()).toEqual(['directed', 'loop:rt-loop', 'owner-directed']);
    expect(due.every((d) => pacing.readWakeFanoutPacing(d.payload) === null)).toBe(true);
  });

  it('an urgent message and loop wake outrank an overdue bulk queue even in a one-row pump batch', async () => {
    const sql = h.sql as postgres.Sql;
    const bulk = await Promise.all(Array.from({ length: 30 }, (_, i) => store.registerAwait({ subscriberId: `overdue-${i}`, eventKey: `overdue:${i}` })));
    await store.insertDeliveries({ awaits: bulk, pacingWorkspaceId: h.ws });
    await sql`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now() - interval '1 hour'`;
    const urgent = await store.registerAwait({ subscriberId: 'urgent', eventKey: 'urgent-message' });
    const loop = await store.registerAwait({ subscriberId: 'loop', eventKey: 'loop-self-wake' });
    await store.insertDeliveries({ awaits: [urgent], urgent: true });
    await store.insertDeliveries({ awaits: [loop], source: 'loop:rt-pacing' });
    expect((await store.claimDueDeliveries({ limit: 1 }))[0].subscriberId).toBe('urgent');
    expect((await store.claimDueDeliveries({ limit: 1 }))[0].subscriberId).toBe('loop');
  });
});
