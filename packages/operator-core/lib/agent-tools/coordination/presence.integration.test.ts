/**
 * presence.integration.test.ts — the presence GC mutator against REAL Postgres
 * (the shared baseline-schema DB via inject('baselineSchemaDsn')).
 *
 * BRIEF-test-coverage-fu-coordination-federation-area target #3: only the
 * `deriveLiveness` boundary was tested; `sweepStalePresence` (the DELETE-by-age
 * mutator that keeps the roster from accumulating hundreds of long-ended rows)
 * was unguarded. This drives the `presence.ts` operator adapter export end-to-end
 * — through the module's OWN getOrgPg() handle — so the host-seam wiring + the
 * underlying PgPresenceStore.sweepStale query are exercised together.
 *
 * ⚠ presence-reconcile is su-584a8's federation surface; this touches NEITHER the
 * source nor the reconcile path — it only adds coverage for the existing GC
 * mutator. Seeds explicit heartbeat_at timestamps (admin/bypass) so the age
 * boundary is deterministic; TRUNCATEs coord_presence per test for isolation
 * (no other baseline-DSN suite uses it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { PgPresenceStore } from '@papercusp/coordination/presence';
import { disposeBaselineCoordFixture, setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { sweepStalePresence, listPresence } from './presence';
import { fetchWakeability, LIVE_TURN_WINDOW_MS, WAKE_PICKUP_GRACE_MS } from './presence-wakeability';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';

let fx: BaselineCoordFixture | undefined;
let admin: postgres.Sql;

/** Seed a presence row with an explicit heartbeat age (seconds in the past). */
async function seed(ownerId: string, ageSeconds: number, workspaceId = 'default'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, ${workspaceId}, 'static-client',
            now() - ${`${ageSeconds} seconds`}::interval)
  `;
}

async function ownerIds(): Promise<string[]> {
  const rows = await admin<{ owner_id: string }[]>`
    SELECT owner_id FROM harness_shared.coord_presence ORDER BY owner_id`;
  return rows.map((r) => r.owner_id);
}

async function cleanWakeabilityRows(sql: postgres.Sql): Promise<void> {
  const prefix = 'wkt-%';
  await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE ${prefix}`;
  await sql`DELETE FROM harness_shared.event_wake_deliveries WHERE subscriber_id LIKE ${prefix}`;
  await sql`DELETE FROM harness_shared.event_wake_attempts WHERE subscriber_id LIKE ${prefix}`;
  await sql`DELETE FROM harness_shared.tool_invocations WHERE coord_owner_id LIKE ${prefix}`;
  await sql`DELETE FROM harness_shared.agent_activity WHERE owner_id LIKE ${prefix}`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(() => disposeBaselineCoordFixture(fx, async (sql) => {
  try {
    await sql`TRUNCATE harness_shared.coord_presence`;
  } finally {
    await cleanWakeabilityRows(sql);
  }
}));
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`;
});

describe('sweepStalePresence (real PG)', () => {
  it('deletes only rows older than maxAgeMs and returns the count; fresh rows survive', async () => {
    await seed('stale-1hr', 3600);
    await seed('stale-30m', 1800);
    await seed('fresh-now', 0);
    await seed('fresh-2m', 120);

    // 10-minute threshold: the two >10m rows go, the two recent ones stay.
    const removed = await sweepStalePresence(10 * 60 * 1000);

    expect(removed).toBe(2);
    expect(await ownerIds()).toEqual(['fresh-2m', 'fresh-now']);
  });

  it('returns 0 and deletes nothing when every row is fresh', async () => {
    await seed('a', 1);
    await seed('b', 5);
    const removed = await sweepStalePresence(60 * 60 * 1000); // 1h threshold
    expect(removed).toBe(0);
    expect(await ownerIds()).toEqual(['a', 'b']);
  });

  it('returns 0 on an empty roster', async () => {
    expect(await sweepStalePresence(1000)).toBe(0);
  });

  it('sweeps across workspaces (the GC is not workspace-scoped)', async () => {
    await seed('ws-default-stale', 3600, 'default');
    await seed('ws-other-stale', 3600, 'harness:papercup');
    await seed('ws-other-fresh', 0, 'harness:papercup');

    const removed = await sweepStalePresence(10 * 60 * 1000);

    expect(removed).toBe(2);
    expect(await ownerIds()).toEqual(['ws-other-fresh']);
  });

  it('clamps a sub-second maxAgeMs to a 1s floor (still removes a clearly-old row)', async () => {
    // WI-10007115: separate seed/delete statements let a "just-now" row
    // cross the 1s boundary before GC runs. Postgres now() is stable inside
    // this transaction; use the store's existing SQL seam for this boundary
    // case. The other cases exercise the operator adapter's own connection.
    await admin.begin(async (sql) => {
      await sql`
        INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
        VALUES ('ancient', 'ancient', 'default', 'static-client', now() - interval '2 seconds'),
               ('half-second-old', 'half-second-old', 'default', 'static-client', now() - interval '0.5 seconds')
      `;
      const store = new PgPresenceStore({
        getSql: () => sql as unknown as postgres.Sql,
        ensureSchema: async () => {},
      });
      expect(await store.sweepStale(0)).toBe(1);
      const rows = await sql<{ owner_id: string }[]>`
        SELECT owner_id FROM harness_shared.coord_presence ORDER BY owner_id`;
      expect(rows.map((row) => row.owner_id)).toEqual(['half-second-old']);

      // Counterfactual: without the 1s clamp the same surviving row is old
      // enough for a zero-second cutoff, using exactly the same DB clock.
      const withoutFloor = await sql<{ owner_id: string }[]>`
        DELETE FROM harness_shared.coord_presence WHERE heartbeat_at < now() RETURNING owner_id`;
      expect(withoutFloor.map((row) => row.owner_id)).toEqual(['half-second-old']);
    });
  });

  it('the surviving rows are visible through the listPresence read path', async () => {
    await seed('gone', 3600);
    await seed('kept', 0);
    await sweepStalePresence(10 * 60 * 1000);
    const live = await listPresence();
    expect(live.map((r) => r.ownerId)).toContain('kept');
    expect(live.map((r) => r.ownerId)).not.toContain('gone');
  });
});

/**
 * fetchWakeability (the P-001 IO seam, fleet-dispatch-wake-clarity-2026-06-22)
 * against REAL Postgres. The `deriveSessionState` boundary is pure-unit-tested in
 * presence-wakeability.test.ts; here we pin the four batch SQL queries — the
 * column names + filter predicates that, if they ever drift, would SILENTLY
 * degrade the wakeable/sessionState fields to absent (the inert-feature failure
 * mode this plan exists to prevent). Reads through the module's own getOrgPg()
 * handle; seeds the shared event_awaits + agent_activity tables under a unique
 * owner prefix (cleaned per-test) so it never TRUNCATEs out a concurrent suite.
 */
describe('fetchWakeability (real PG)', () => {
  // Unique prefix → our seeds never collide with another baseline-DSN suite's
  // rows on these SHARED tables, and we DELETE only our own (no TRUNCATE).
  const P = 'wkt-';
  const own = (id: string) => `${P}${id}`;

  beforeEach(() => cleanWakeabilityRows(admin));

  /** Seed one standing inbox-wake await (the `wakeable` signal). Defaults to a
   *  LIVE await (unfired, uncancelled, unexpired, correctly-keyed). */
  async function seedAwait(
    id: string,
    opts: { firedAt?: Date | null; cancelledAt?: Date | null; expiresTs?: Date | null; key?: string } = {},
  ): Promise<void> {
    const owner = own(id);
    await admin`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
      VALUES (${owner}, ${opts.key ?? `${COORD_INBOX_WAKE_PREFIX}${owner}`},
              ${opts.firedAt ?? null}, ${opts.cancelledAt ?? null}, ${opts.expiresTs ?? null})`;
  }

  /** Seed a settled wake delivery at a chosen age. The delivery is attached to
   * the target's standing await so the query exercises the production key and
   * terminal-status/channel filters, not just the pure timestamp helper. */
  async function seedDelivery(
    id: string,
    opts: { status: 'pending' | 'delivered' | 'dropped' | 'dead'; channel?: string | null; agoSec?: number },
  ): Promise<Date> {
    const owner = own(id);
    const eventKey = `${COORD_INBOX_WAKE_PREFIX}${owner}`;
    const awaitRows = await admin<{ id: number }[]>`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key)
      VALUES (${owner}, ${eventKey})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    const awaitId =
      awaitRows[0]?.id ??
      (
        await admin<{ id: number }[]>`
          SELECT id
            FROM harness_shared.event_awaits
           WHERE subscriber_id = ${owner} AND event_key = ${eventKey}
           ORDER BY id
           LIMIT 1`
      )[0]?.id;
    if (awaitId == null) throw new Error(`missing event_awaits row for ${eventKey}`);
    const at = new Date(Date.now() - (opts.agoSec ?? 0) * 1000);
    await admin`
      INSERT INTO harness_shared.event_wake_deliveries
        (await_id, subscriber_id, event_key, status, channel, created_at, delivered_at)
      VALUES (${awaitId}, ${owner}, ${eventKey}, ${opts.status},
              ${opts.channel ?? null}, ${at},
              ${opts.status === 'delivered' ? at : null})`;
    return at;
  }

  /** Seed a completed coord:send wake:'required' attempt at a chosen age. */
  async function seedAttempt(
    id: string,
    opts: { outcome: 'queued' | 'missed'; agoSec?: number },
  ): Promise<void> {
    const owner = own(id);
    const eventKey = `${COORD_INBOX_WAKE_PREFIX}${owner}`;
    const at = new Date(Date.now() - (opts.agoSec ?? 0) * 1000);
    await admin`
      INSERT INTO harness_shared.event_wake_attempts
        (workspace_id, subscriber_id, event_key, outcome, attempted_at)
      VALUES ('default', ${owner}, ${eventKey}, ${opts.outcome}, ${at})`;
  }

  /** Seed one agent_activity row at a chosen age (the `liveTurn` signal). */
  async function seedActivity(
    id: string,
    opts: { kind: string; summary?: string; agoSec?: number },
  ): Promise<void> {
    await admin`
      INSERT INTO harness_shared.agent_activity (owner_id, kind, summary, created_at)
      VALUES (${own(id)}, ${opts.kind}, ${opts.summary ?? null},
              ${new Date(Date.now() - (opts.agoSec ?? 0) * 1000)})`;
  }

  /** Seed an owner-attributed tool call without advancing agent_activity. */
  async function seedToolInvocation(id: string): Promise<Date> {
    const owner = own(id);
    const rows = await admin<{ invoked_at: Date | string }[]>`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
         window_key, status, coord_owner_id)
      VALUES ('default', 'papercusp', 'test', 'coord:inbox', 'operator', ${owner},
              'test-window', 'ok', ${owner})
      RETURNING invoked_at`;
    const invokedAt = rows[0]?.invoked_at;
    if (invokedAt == null) throw new Error(`missing tool_invocations row for ${owner}`);
    return invokedAt instanceof Date ? invokedAt : new Date(invokedAt);
  }

  it('a live inbox-wake await + a running turn → { wakeable, liveTurn } (the dispatch-now signal)', async () => {
    await seedAwait('live');
    await seedActivity('live', { kind: 'tool', summary: '▶ npm test', agoSec: 3 });
    const m = await fetchWakeability([own('live')]);
    // lastActivityMs (EI-21356812816484561) is emitted whenever the owner has
    // activity in the window. Asserted as a matcher rather than relaxing this
    // to toMatchObject, so the exact-shape guard still catches field growth.
    expect(m.get(own('live'))).toEqual({
      wakeable: true,
      liveTurn: true,
      lastActivityMs: expect.any(Number),
    });
  });

  it('WI-10002562: a Codex tool call after a delivered wake prevents a false wake miss without a newer agent_activity row', async () => {
    await seedAwait('codex-active');
    // Keep the prior agent_activity outside the live-turn window. The only
    // post-wake activity below is the owner-attributed tool_invocations row.
    await seedActivity('codex-active', {
      kind: 'tool',
      summary: 'pre-wake activity',
      agoSec: Math.ceil(LIVE_TURN_WINDOW_MS / 1000) + 60,
    });
    const wakeAt = await seedDelivery('codex-active', {
      status: 'delivered',
      channel: 'pty-inject',
      agoSec: 2,
    });
    const toolCallAt = await seedToolInvocation('codex-active');
    expect(toolCallAt.getTime()).toBeGreaterThan(wakeAt.getTime());

    const signals = (await fetchWakeability([own('codex-active')])).get(own('codex-active'));
    expect(signals).toMatchObject({
      wakeable: true,
      liveTurn: true,
      lastActivityMs: expect.any(Number),
    });
    expect(signals?.lastActivityMs).toBeGreaterThan(wakeAt.getTime());
    expect(signals?.wakeAttemptMiss).toBeUndefined();
  });

  it('a cancelled / fired / expired await is NOT wakeable (it would be the `ended` row)', async () => {
    await seedAwait('cancelled', { cancelledAt: new Date() });
    await seedAwait('fired', { firedAt: new Date() });
    await seedAwait('expired', { expiresTs: new Date(Date.now() - 60_000) });
    const ids = [own('cancelled'), own('fired'), own('expired')];
    const m = await fetchWakeability(ids);
    for (const id of ids) expect(m.get(id)?.wakeable).toBe(false);
  });

  it('a future-expiry await still counts as wakeable', async () => {
    await seedAwait('future', { expiresTs: new Date(Date.now() + 60_000) });
    const m = await fetchWakeability([own('future')]);
    expect(m.get(own('future'))?.wakeable).toBe(true);
  });

  it('an await on a DIFFERENT event_key does not count as inbox-wakeable', async () => {
    // A live await keyed on something other than coord:inbox-wake:<id> must NOT
    // make the agent look dispatchable — the event_key predicate is load-bearing.
    await seedAwait('otherkey', { key: 'lock:grant:abc' });
    const m = await fetchWakeability([own('otherkey')]);
    expect(m.get(own('otherkey'))?.wakeable).toBe(false);
  });

  it('only a trailing session-end marker → liveTurn=false (just-ended-but-still-warm; the heartbeat-lag fix)', async () => {
    await seedAwait('justended');
    await seedActivity('justended', { kind: 'lifecycle', summary: '■ session ended', agoSec: 5 });
    const m = await fetchWakeability([own('justended')]);
    expect(m.get(own('justended'))).toEqual({
      wakeable: true,
      liveTurn: false,
      lastActivityMs: expect.any(Number),
    });
  });

  it('activity AFTER the end-marker → liveTurn=true (a new turn resumed)', async () => {
    await seedAwait('resumed');
    await seedActivity('resumed', { kind: 'lifecycle', summary: '■ session ended', agoSec: 30 });
    await seedActivity('resumed', { kind: 'tool', summary: '✎ x.ts', agoSec: 2 });
    const m = await fetchWakeability([own('resumed')]);
    expect(m.get(own('resumed'))).toEqual({
      wakeable: true,
      liveTurn: true,
      lastActivityMs: expect.any(Number),
    });
  });

  // EI-12979: the end-marker match must be EXACT, never an unanchored substring.
  // Before the fix this used `summary ILIKE '%end%'`, so a lifecycle summary that
  // merely CONTAINS "end" (e.g. "recommend a fix") would be mistaken for the
  // `■ session ended` marker — turning a live, mid-turn agent's ONLY recent
  // activity into a false end-marker and reporting liveTurn=false (parked) for a
  // session that is demonstrably still running.
  it('EI-12979: a lifecycle summary merely CONTAINING "end" is not the end marker — liveTurn stays true', async () => {
    await seedAwait('substringtrap');
    await seedActivity('substringtrap', { kind: 'lifecycle', summary: 'recommend a fix', agoSec: 5 });
    const m = await fetchWakeability([own('substringtrap')]);
    expect(m.get(own('substringtrap'))).toEqual({
      wakeable: true,
      liveTurn: true,
      lastActivityMs: expect.any(Number),
    });
  });

  it('an owner with no rows is present in the map as { wakeable:false, liveTurn:false }', async () => {
    const m = await fetchWakeability([own('ghost')]);
    expect(m.get(own('ghost'))).toEqual({ wakeable: false, liveTurn: false });
  });

  it('EI-22642013373311117: keeps activity beyond the 24h wake-miss window for stale-session detection', async () => {
    // The activity-dead ceiling is six hours, but the wake-miss evidence window
    // is 24h. Before the fix, a multi-day-silent heartbeat-fresh owner lost its
    // lastActivityMs row here and was incorrectly classified as a fresh parked
    // candidate instead of an activity-dead session.
    await seedAwait('stale-activity');
    await seedActivity('stale-activity', {
      kind: 'tool',
      summary: 'last turn before the stale-activity horizon',
      agoSec: 48 * 60 * 60,
    });

    const m = await fetchWakeability([own('stale-activity')]);
    expect(m.get(own('stale-activity'))).toMatchObject({
      wakeable: true,
      liveTurn: false,
      lastActivityMs: expect.any(Number),
    });
  });

  it('EI-21216592915615709: terminal turn wake with only pre-wake activity is a miss, while pickup and non-turn rows are not', async () => {
    // The incident shape: a recent activity row predates a terminal wake
    // delivery, so heartbeat/activity freshness alone still says "live" even
    // though no post-wake turn started.
    // WI-10004329: a delivered wake only confirms a miss once it has outlived the
    // pickup grace, so the miss fixture sits past it (still inside liveTurn).
    const matured = Math.round(WAKE_PICKUP_GRACE_MS / 1000) + 60;
    expect(LIVE_TURN_WINDOW_MS).toBeGreaterThan((matured + 5) * 1000);
    await seedAwait('miss');
    await seedActivity('miss', { kind: 'tool', summary: 'pre-wake work', agoSec: matured + 3 });
    await seedDelivery('miss', { status: 'delivered', channel: 'pty-inject', agoSec: matured });

    // A later activity watermark proves pickup, even though the delivery is
    // still recent and turn-burning.
    await seedActivity('picked', { kind: 'tool', summary: 'post-wake work', agoSec: 2 });
    await seedDelivery('picked', { status: 'delivered', channel: 'pty-inject', agoSec: 5 });

    // Pending and inbox/coalesced settlements are deliberately not evidence of
    // a turn attempt: queueing or settling without a turn is not pickup failure.
    await seedActivity('pending', { kind: 'tool', summary: 'pre-wake work', agoSec: 5 });
    await seedDelivery('pending', { status: 'pending', channel: 'pty-inject', agoSec: 2 });
    await seedActivity('inbox', { kind: 'tool', summary: 'pre-wake work', agoSec: 5 });
    await seedDelivery('inbox', { status: 'delivered', channel: 'inbox', agoSec: 2 });

    const m = await fetchWakeability([own('miss'), own('picked'), own('pending'), own('inbox')]);
    expect(m.get(own('miss'))).toMatchObject({ wakeable: true, liveTurn: true, wakeAttemptMiss: true });
    expect(m.get(own('picked'))?.wakeAttemptMiss).toBeUndefined();
    expect(m.get(own('pending'))?.wakeAttemptMiss).toBeUndefined();
    expect(m.get(own('inbox'))?.wakeAttemptMiss).toBeUndefined();
  });

  it('EI-21458515135707634: merges the newest required-send attempt with legacy delivery evidence', async () => {
    // Required-send misses have no event_wake_deliveries row, so the new ledger
    // must feed the same pickup-miss oracle as the legacy terminal delivery path.
    await seedActivity('required-only', { kind: 'tool', summary: 'pre-wake work', agoSec: 5 });
    await seedAttempt('required-only', { outcome: 'missed', agoSec: 2 });

    // The required attempt is newer than the legacy delivery, so it controls the
    // merged watermark and correctly reports a miss despite the older delivery.
    // A 'queued' attempt is pickup-pending until it outlives the grace
    // (WI-10004329), so this fixture sits past it.
    const matured = Math.round(WAKE_PICKUP_GRACE_MS / 1000) + 60;
    await seedActivity('required-newest', { kind: 'tool', summary: 'pre-wake work', agoSec: matured + 20 });
    await seedDelivery('required-newest', { status: 'delivered', channel: 'pty-inject', agoSec: matured + 10 });
    await seedAttempt('required-newest', { outcome: 'queued', agoSec: matured });

    // A newer legacy delivery supersedes an older required attempt and proves
    // that this recipient has activity after the latest wake evidence.
    await seedActivity('legacy-newest', { kind: 'tool', summary: 'post-wake work', agoSec: 1 });
    await seedAttempt('legacy-newest', { outcome: 'missed', agoSec: 10 });
    await seedDelivery('legacy-newest', { status: 'delivered', channel: 'pty-inject', agoSec: 2 });

    const m = await fetchWakeability([own('required-only'), own('required-newest'), own('legacy-newest')]);
    expect(m.get(own('required-only'))?.wakeAttemptMiss).toBe(true);
    expect(m.get(own('required-newest'))?.wakeAttemptMiss).toBe(true);
    expect(m.get(own('legacy-newest'))?.wakeAttemptMiss).toBeUndefined();
  });

  it('WI-10004329: a just-handed-off wake is pickup-pending, not a miss; a definitive failure still is', async () => {
    // The incident shape (goal 60d3a8, 2026-09-30): the holder's loop fire was
    // injected at 18:28:04.731Z, its first tool call landed at 18:28:08.547Z,
    // and a liveness read inside that 3.8 s gap called the healthy holder
    // `ended`, so the respawner replaced it.
    await seedAwait('fresh-delivered');
    await seedActivity('fresh-delivered', { kind: 'tool', summary: 'pre-wake work', agoSec: 240 });
    await seedDelivery('fresh-delivered', { status: 'delivered', channel: 'pty-inject', agoSec: 2 });

    await seedActivity('fresh-queued', { kind: 'tool', summary: 'pre-wake work', agoSec: 240 });
    await seedAttempt('fresh-queued', { outcome: 'queued', agoSec: 2 });

    // No grace for a definitive failure: nobody was re-invoked.
    await seedActivity('fresh-dropped', { kind: 'tool', summary: 'pre-wake work', agoSec: 240 });
    await seedDelivery('fresh-dropped', { status: 'dropped', agoSec: 2 });

    // Re-waking must not reset the grace: an older, matured, unanswered wake
    // still confirms the miss even though a newer wake is pending.
    const matured = Math.round(WAKE_PICKUP_GRACE_MS / 1000) + 60;
    await seedActivity('rewoken', { kind: 'tool', summary: 'pre-wake work', agoSec: matured + 30 });
    await seedAttempt('rewoken', { outcome: 'queued', agoSec: matured });
    await seedAttempt('rewoken', { outcome: 'queued', agoSec: 2 });

    const ids = ['fresh-delivered', 'fresh-queued', 'fresh-dropped', 'rewoken'];
    const m = await fetchWakeability(ids.map(own));
    expect(m.get(own('fresh-delivered'))?.wakeAttemptMiss).toBeUndefined();
    expect(m.get(own('fresh-delivered'))).toMatchObject({ wakeable: true });
    expect(m.get(own('fresh-queued'))?.wakeAttemptMiss).toBeUndefined();
    expect(m.get(own('fresh-dropped'))?.wakeAttemptMiss).toBe(true);
    expect(m.get(own('rewoken'))?.wakeAttemptMiss).toBe(true);
  });

  it('returns an empty map for an empty ownerIds list (no query fired)', async () => {
    const m = await fetchWakeability([]);
    expect(m.size).toBe(0);
  });
});
