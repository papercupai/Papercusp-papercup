/**
 * await-store.integration.test.ts — the await-event store against real
 * Postgres (await-event-primitive-2026-06-05 P-001/P-006, migration 163).
 *
 * Validates the migrated `event_awaits` + `event_wake_deliveries` tables and
 * the store's one-shot/claim/settle SQL — including the atomic one-shot
 * guarantee under concurrent emits (D-002) and the delivery state machine
 * (D-004). Follows the org-fixture mock pattern (test/_org-test-db.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-await-test' }));

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const store = await import('./store');
const { HOST_ACCEPTED_CANCELLED_DELIVERY_MARKER } = await import('./cancel-reasons');
const { lastLoopFireParked } = await import('../../agent-tools/loop/next-wake');
const { reconcileInterestEventAwaits } = await import('../../interest-auto-arm');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

describe('event_awaits + event_wake_deliveries (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /**
   * EI-21295379735880011 — loop-fire Guard 4 withholds an agent's routine wake while
   * this read reports it PARKED. A park must mean "the agent CHOSE to sleep on an
   * event"; a PLATFORM-ARMED binding means the system registered an interest on the
   * agent's behalf while it keeps working. Reading the second as the first silences a
   * fleet leader's own supervision loop from the moment it takes the fleet (~5 rows per
   * fleet), and throttles any work-item holder.
   *
   * The deliberate-park row is a POSITIVE CONTROL: without it a query that returned
   * nothing at all would satisfy both exclusion assertions and look like a pass.
   */
  it('listParkedAwaitsForSubscribers excludes PLATFORM-ARMED bindings (work-item-claim, fleet-leadership) and keeps a deliberate park (EI-21295379735880011)', async () => {
    const sub = 'su-parked-exclusions';

    await store.registerAwait({ subscriberId: sub, eventKey: 'gate:green' });
    await store.registerAwait({
      subscriberId: sub,
      eventKey: 'claim:released:WI-9001',
      note: 'claim-holder auto-arm for WI-9001',
      boundTo: { kind: 'work-item-claim', ref: 'WI-9001' },
    });
    await store.registerAwait({
      subscriberId: sub,
      eventKey: 'fleet:member-dead:demo-fleet',
      note: 'fleet-leader auto-arm (fleet:member-dead:demo-fleet)',
      boundTo: { kind: 'fleet-leadership', ref: 'demo-fleet' },
    });

    const keys = (await store.listParkedAwaitsForSubscribers([sub])).map((r) => r.eventKey);

    // Positive control — the read works and this subscriber's rows are visible.
    expect(keys).toContain('gate:green');
    // Neither auto-arm is a park: the agent chose neither.
    expect(keys).not.toContain('claim:released:WI-9001');
    expect(keys).not.toContain('fleet:member-dead:demo-fleet');
  });

  it('registers an await with the wake handle + computed deadline', async () => {
    const row = await store.registerAwait({
      subscriberId: 'su-1',
      eventKey: 'demo:done',
      note: 'waiting on the demo',
      wakeHandle: {
        kind: 'adv-session',
        advSessionId: 5,
        agent: 'claude',
        sessionId: 'sid',
        ompThreadId: null,
        cwd: '/r',
        pid: 1,
      },
      timeoutBehavior: 'wake',
      timeoutSec: 3600,
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.policy).toBe('wake');
    expect(row.wakeHandle).toMatchObject({ kind: 'adv-session', advSessionId: 5 });
    expect(row.expiresTs).not.toBeNull();
    expect(new Date(row.expiresTs!).getTime()).toBeGreaterThan(Date.now() + 3000_000);
  });

  it('returns an uncapped live-await total alongside the bounded sample', async () => {
    const subscriberId = 'su-wake-count-over-cap';
    for (let i = 1; i <= 6; i += 1) {
      await store.registerAwait({ subscriberId, eventKey: `counted:${i}` });
    }

    const result = await store.listWakeAwaitsForSubscriber(subscriberId);

    expect(result.totalCount).toBe(6);
    expect(result.sample).toHaveLength(5);
    expect(result.sample.every((row) => row.eventKey.startsWith('counted:'))).toBe(true);
  });

  it('fires one-shot: the first fire returns the await, the second returns nothing', async () => {
    await store.registerAwait({ subscriberId: 'su-2', eventKey: 'once:k' });
    const first = await store.fireAwaitsForKey({ eventKey: 'once:k' });
    expect(first.map((a) => a.subscriberId)).toEqual(['su-2']);
    expect(first[0].firedReason).toBe('event');
    const second = await store.fireAwaitsForKey({ eventKey: 'once:k' });
    expect(second).toEqual([]);
  });

  it('CONCURRENT fires of one key fire each await exactly once (atomic one-shot)', async () => {
    await store.registerAwait({ subscriberId: 'su-3', eventKey: 'race:k' });
    await store.registerAwait({ subscriberId: 'su-4', eventKey: 'race:k' });
    const [a, b, c] = await Promise.all([
      store.fireAwaitsForKey({ eventKey: 'race:k' }),
      store.fireAwaitsForKey({ eventKey: 'race:k' }),
      store.fireAwaitsForKey({ eventKey: 'race:k' }),
    ]);
    const total = a.length + b.length + c.length;
    expect(total).toBe(2);
  });

  it('keeps one newest exact one-shot across sequential and concurrent registration surfaces', async () => {
    const subscriberId = 'su-exact-registration-dedup';
    const eventKey = 'exact:registration:dedup';
    const first = await store.registerAwait({ subscriberId, eventKey, note: 'direct events:await' });
    const second = await store.registerAwait({
      subscriberId,
      eventKey,
      note: 'lifecycle auto-arm',
      boundTo: { kind: 'work-item-claim', ref: 'EI-exact-registration-dedup' },
    });

    expect((await store.listActiveAwaits(subscriberId)).map((row) => row.id)).toEqual([second.id]);

    const concurrent = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.registerAwait({
          subscriberId,
          eventKey,
          note: `concurrent surface ${index}`,
          ...(index % 2 === 0
            ? {}
            : { boundTo: { kind: 'fleet-leadership', ref: 'exact-registration-dedup' } }),
        }),
      ),
    );
    const active = (await store.listActiveAwaits(subscriberId)).filter((row) => row.eventKey === eventKey);
    expect(active).toHaveLength(1);
    expect(concurrent.map((row) => row.id)).toContain(active[0].id);

    const history = await db.adminSql<{ id: number; cancelled_at: string | null }[]>`
      SELECT id, cancelled_at
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ${subscriberId} AND event_key = ${eventKey}
       ORDER BY id
    `;
    expect(history).toHaveLength(14);
    expect(history.filter((row) => row.cancelled_at == null)).toHaveLength(1);
    expect(history.find((row) => row.id === first.id)?.cancelled_at).not.toBeNull();
    expect(history.find((row) => row.id === second.id)?.cancelled_at).not.toBeNull();
  });

  it.each([
    ['unfiltered', null],
    ['filtered', { result: { equals: 'ready' } }],
  ])('auto-arm preserves the original bounded %s wait identity, deadline and predicate', async (name, payloadFilter) => {
    const subscriberId = `su-preserve-explicit-${name}`;
    const eventKey = `work-item:done:source-${name}`;
    const manual = await store.registerAwait({
      subscriberId, eventKey, timeoutSec: 3600, timeoutBehavior: 'expire', payloadFilter,
      note: 'explicit source wait', wakeHandle: { kind: 'plan-run', runId: 9 },
    });
    const out = await reconcileInterestEventAwaits(
      { ownerId: subscriberId, eventKeys: [eventKey], boundTo: { kind: 'work-item-blocked', ref: `WI-${name}` }, note: 'blocked-item-holder auto-arm' },
      { captureHandle: async () => ({ handle: { kind: 'plan-run', runId: 10 }, note: 'reachable' }), listActive: store.listActiveAwaits, register: store.registerAwait, cancel: store.cancelAwait },
    );
    expect(out.await_ids).toEqual([manual.id]);
    expect(await store.listActiveAwaits(subscriberId)).toEqual([manual]);
  });

  it.each([
    ['unfiltered', null],
    ['filtered', { result: { equals: 'ready' } }],
  ])('preserves a bounded %s wait registered after the reconciliation snapshot', async (name, payloadFilter) => {
    const subscriberId = `su-preserve-late-${name}`;
    const eventKey = `work-item:done:late-${name}`;
    let manual: Awaited<ReturnType<typeof store.registerAwait>>;
    const out = await reconcileInterestEventAwaits(
      { ownerId: subscriberId, eventKeys: [eventKey], boundTo: { kind: 'work-item-blocked', ref: `WI-late-${name}` }, note: 'blocked-item-holder auto-arm' },
      {
        captureHandle: async () => ({ handle: { kind: 'plan-run', runId: 10 }, note: 'reachable' }),
        listActive: async (ownerId) => {
          const snapshot = await store.listActiveAwaits(ownerId);
          manual = await store.registerAwait({ subscriberId, eventKey, timeoutSec: 3600, payloadFilter, note: 'late explicit wait' });
          return snapshot;
        },
        register: store.registerAwait, cancel: store.cancelAwait,
      },
    );
    expect(out.await_ids).toEqual([manual!.id]);
    expect(await store.listActiveAwaits(subscriberId)).toEqual([manual!]);
  });

  it('concurrent preservation registrations reuse the original deadline without inserting replacements', async () => {
    const subscriberId = 'su-preserve-concurrent';
    const eventKey = 'work-item:done:concurrent-source';
    const manual = await store.registerAwait({ subscriberId, eventKey, timeoutSec: 3600, note: 'explicit source wait' });
    const registered = await Promise.all(Array.from({ length: 6 }, () => store.registerAwait({
      subscriberId, eventKey, boundTo: { kind: 'work-item-blocked', ref: 'WI-concurrent' },
      ...{ preserveExplicitWait: true },
    })));
    expect(registered.every((row) => row.id === manual.id && row.expiresTs === manual.expiresTs)).toBe(true);
    expect(await store.listActiveAwaits(subscriberId)).toEqual([manual]);
    const history = await db.adminSql<{ id: number }[]>`
      SELECT id FROM harness_shared.event_awaits WHERE subscriber_id = ${subscriberId} AND event_key = ${eventKey}
    `;
    expect(history.map((row) => Number(row.id))).toEqual([manual.id]);
  });

  it('keeps filtered predicates and fleet benches distinct from ordinary exact dedup', async () => {
    const subscriberId = 'su-exact-special-surfaces';
    const eventKey = 'exact:special:surfaces';
    const filtered = await store.registerAwait({
      subscriberId,
      eventKey,
      payloadFilter: { candidate: { equals: 'one' } },
    });
    const filteredSibling = await store.registerAwait({
      subscriberId,
      eventKey,
      payloadFilter: { candidate: { equals: 'two' } },
    });
    const bench = await store.registerAwait({
      subscriberId,
      eventKey,
      note: '[fleet:bench] staged assignment',
    });
    const ordinary = await store.registerAwait({ subscriberId, eventKey });

    expect((await store.listActiveAwaits(subscriberId)).map((row) => row.id).sort()).toEqual(
      [filtered.id, filteredSibling.id, bench.id, ordinary.id].sort(),
    );
  });

  it('cancel is subscriber-scoped: yours cancels, a peer’s does not', async () => {
    const mine = await store.registerAwait({ subscriberId: 'su-5', eventKey: 'cancel:k' });
    expect(await store.cancelAwait({ awaitId: mine.id, subscriberId: 'su-other' })).toBe(false);
    expect(await store.cancelAwait({ awaitId: mine.id, subscriberId: 'su-5' })).toBe(true);
    // Cancelled awaits do not fire.
    expect(await store.fireAwaitsForKey({ eventKey: 'cancel:k' })).toEqual([]);
  });

  it('deliveries: insert → claim flips to delivering and joins the handle + note', async () => {
    const a = await store.registerAwait({
      subscriberId: 'su-6',
      eventKey: 'deliver:k',
      note: 'the join carries me',
      wakeHandle: { kind: 'plan-run', runId: 99 },
    });
    const fired = await store.fireAwaitsForKey({ eventKey: 'deliver:k' });
    expect(fired).toHaveLength(1);
    await store.insertDeliveries({ awaits: fired, payload: { n: 1 }, summary: 'done!' });

    const work = await store.claimDueDeliveries({ limit: 5 });
    const mine = work.filter((w) => w.awaitId === a.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe('delivering');
    expect(mine[0].wakeHandle).toMatchObject({ kind: 'plan-run', runId: 99 });
    expect(mine[0].note).toBe('the join carries me');
    expect(mine[0].payload).toEqual({ n: 1 });
    expect(mine[0].summary).toBe('done!');

    // Claimed rows are not re-claimable while delivering.
    const again = await store.claimDueDeliveries({ limit: 5 });
    expect(again.filter((w) => w.awaitId === a.id)).toHaveLength(0);

    // Settle: delivered with channel attribution (the D-007 meter dimension).
    await store.markDeliveryDelivered(mine[0].id, 'plan-run-resume');
    const recent = await store.listRecentDeliveries('su-6');
    expect(recent[0]).toMatchObject({ status: 'delivered', channel: 'plan-run-resume' });
  });

  it('lists recent deliveries for one await with its composed verdict payload', async () => {
    const subscriberId = 'su-focused-await-history';
    const target = await store.registerAwait({ subscriberId, eventKey: 'composed-root:408' });
    const other = await store.registerAwait({ subscriberId, eventKey: 'composed-root:409' });
    const payload = {
      composed: true,
      satisfied: true,
      reason: 'event',
      fired: [{ event: 'green-checkpoint:inconclusive:papercusp', payload: { reason: 'skipped-locked' } }],
    };
    await store.insertDeliveries({ awaits: [target], payload, summary: 'composed verdict' });
    await store.insertDeliveries({ awaits: [other], payload: { unrelated: true }, summary: 'other delivery' });

    const recent = await store.listRecentDeliveries(subscriberId, 10, target.id);

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ awaitId: target.id, payload, summary: 'composed verdict' });
  });

  it('lists recent deliveries only from the coordination workspace', async () => {
    const subscriberId = 'su-workspace-scoped-delivery-history';
    const awaited = await store.registerAwait({ subscriberId, eventKey: 'workspace-scope:local' });
    await store.insertDeliveries({ awaits: [awaited], summary: 'local delivery' });

    const foreign = await db.adminSql`
      INSERT INTO harness_shared.event_wake_deliveries (
        workspace_id, await_id, subscriber_id, event_key, summary, status
      )
      VALUES ('ws-other', ${awaited.id}, ${subscriberId}, 'workspace-scope:foreign', 'foreign delivery', 'parked')
      RETURNING id
    `;

    const recent = await store.listRecentDeliveries(subscriberId, 10, awaited.id);

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ awaitId: awaited.id, summary: 'local delivery' });
    expect(recent.map((delivery) => delivery.id)).not.toContain(Number(foreign[0].id));
  });

  it('a newer loop fire drops older pending/parked wakes from the same loop instance', async () => {
    const awaited = await store.registerAwait({
      subscriberId: 'su-loop-supersession',
      eventKey: 'coord:inbox-wake:su-loop-supersession',
      once: false,
    });

    await store.insertDeliveries({ awaits: [awaited], summary: 'fire 1', source: 'loop:rt-loop-supersession' });
    await store.insertDeliveries({ awaits: [awaited], summary: 'fire 2', source: 'loop:rt-loop-supersession' });
    await store.insertDeliveries({ awaits: [awaited], summary: 'fire 3', source: 'loop:rt-loop-supersession' });

    const recent = await store.listRecentDeliveries('su-loop-supersession', 10);
    expect(recent.find((d) => d.summary === 'fire 3')).toMatchObject({ status: 'pending' });
    expect(recent.find((d) => d.summary === 'fire 2')).toMatchObject({
      status: 'dropped',
      lastError: expect.stringContaining('superseded by newer loop wake'),
    });
    expect(recent.find((d) => d.summary === 'fire 1')).toMatchObject({ status: 'dropped' });

    // Do not leave a live row behind for the shared-fixture tests below.
    await store.markDeliveryDropped(recent.find((d) => d.summary === 'fire 3')!.id, 'test cleanup');
  });

  it('a fresh delivery gets its first attempt before an old repeatedly-failed row', async () => {
    const oldAwait = await store.registerAwait({ subscriberId: 'su-fair-old', eventKey: 'fair:old' });
    await store.insertDeliveries({ awaits: [oldAwait], summary: 'old retry' });
    const old = (await store.claimDueDeliveries({ limit: 10 })).find((d) => d.subscriberId === 'su-fair-old')!;
    await store.markDeliveryFailed({ id: old.id, error: 'still unreachable', attempts: old.attempts, maxAttempts: 8, backoffMs: 0 });

    const freshAwait = await store.registerAwait({ subscriberId: 'su-fair-fresh', eventKey: 'fair:fresh' });
    await store.insertDeliveries({ awaits: [freshAwait], summary: 'fresh first attempt' });

    const [claimed] = await store.claimDueDeliveries({ limit: 1 });
    expect(claimed.subscriberId).toBe('su-fair-fresh');
    expect(claimed.attempts).toBe(1);

    await store.markDeliveryDropped(claimed.id, 'test cleanup');
    await store.markDeliveryDropped(old.id, 'test cleanup');
  });

  it('reserves one slot for an aged parked retry without letting retries monopolize the batch', async () => {
    const prefix = 'su-fair-aged';
    const oldAwait = await store.registerAwait({ subscriberId: `${prefix}-old`, eventKey: 'fair:aged:old' });
    await store.insertDeliveries({ awaits: [oldAwait], summary: 'aged parked retry' });
    const old = (await store.claimDueDeliveries({ limit: 10 })).find((d) => d.subscriberId === `${prefix}-old`)!;
    await store.markDeliveryParked(old.id, 'subscriber is currently uninjectable', 0);
    // Make the retry old enough to enter the bounded starvation reserve. The
    // current query's attempts tier would leave it behind every fresh row.
    await db.adminSql`
      UPDATE harness_shared.event_wake_deliveries
         SET created_at = now() - interval '2 minutes',
             next_attempt_at = now()
       WHERE id = ${old.id}
    `;

    for (let i = 0; i < 5; i += 1) {
      const freshAwait = await store.registerAwait({
        subscriberId: `${prefix}-fresh-${i}`,
        eventKey: `fair:aged:fresh:${i}`,
      });
      await store.insertDeliveries({ awaits: [freshAwait], summary: `fresh ${i}` });
    }

    const claimed = await store.claimDueDeliveries({ limit: 5 });
    const ours = claimed.filter((d) => d.subscriberId.startsWith(`${prefix}-`));
    expect(ours).toHaveLength(5);
    expect(ours.find((d) => d.subscriberId === `${prefix}-old`)).toMatchObject({
      attempts: 2,
      status: 'delivering',
    });
    expect(ours.filter((d) => d.subscriberId.startsWith(`${prefix}-fresh-`))).toHaveLength(4);

    for (const delivery of ours) await store.markDeliveryDropped(delivery.id, 'test cleanup');
    await db.adminSql`
      DELETE FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id LIKE ${`${prefix}-%`}
    `;
  });

  it('rotates the aged-retry reserve after a parked delivery is rechecked', async () => {
    const prefix = 'su-fair-rotation';
    const oldSubscriber = `${prefix}-old`;
    const nextSubscriber = `${prefix}-next`;
    const oldAwait = await store.registerAwait({ subscriberId: oldSubscriber, eventKey: 'fair:rotation:old' });
    const nextAwait = await store.registerAwait({ subscriberId: nextSubscriber, eventKey: 'fair:rotation:next' });
    await store.insertDeliveries({ awaits: [oldAwait], summary: 'first aged retry' });
    await store.insertDeliveries({ awaits: [nextAwait], summary: 'next aged retry' });

    const old = (await store.listRecentDeliveries(oldSubscriber, 1))[0];
    const next = (await store.listRecentDeliveries(nextSubscriber, 1))[0];
    expect(old).toBeDefined();
    expect(next).toBeDefined();

    // Both retries are already due and old enough for the starvation reserve.
    // The older delivery wins once, then its recheck time advances past the other
    // retry. It must not reclaim the reserved slot solely because created_at is old.
    await db.adminSql`
      UPDATE harness_shared.event_wake_deliveries
         SET attempts = 1,
             status = 'parked',
             last_error = 'subscriber is currently uninjectable',
             created_at = CASE
               WHEN id = ${old.id} THEN now() - interval '10 minutes'
               ELSE now() - interval '9 minutes'
             END,
             next_attempt_at = now() - interval '5 minutes'
       WHERE id = ANY(${[old.id, next.id]})
    `;

    const [first] = await store.claimDueDeliveries({ limit: 1 });
    expect(first.id).toBe(old.id);
    await store.markDeliveryParked(first.id, 'still uninjectable', 0);

    const [second] = await store.claimDueDeliveries({ limit: 1 });
    expect(second.id).toBe(next.id);

    await store.markDeliveryDropped(first.id, 'test cleanup');
    await store.markDeliveryDropped(second.id, 'test cleanup');
    await db.adminSql`
      DELETE FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id LIKE ${`${prefix}-%`}
    `;
  });

  it('reserves a bounded slot for a loop retry ahead of a larger non-loop retry backlog', async () => {
    const prefix = 'su-fair-loop-reserve';
    const loopSubscriber = `${prefix}-loop`;
    const loopAwait = await store.registerAwait({
      subscriberId: loopSubscriber,
      eventKey: 'fair:loop-reserve',
    });
    await store.insertDeliveries({
      awaits: [loopAwait],
      source: 'loop:rt_test_loop',
      summary: 'loop self-wake',
    });

    const nonLoopAwaits = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.registerAwait({
          subscriberId: `${prefix}-work-${index}`,
          eventKey: `fair:loop-reserve:work:${index}`,
        }),
      ),
    );
    await store.insertDeliveries({ awaits: nonLoopAwaits, source: 'work-items', summary: 'work retry' });

    const seeded = await db.adminSql<{ id: number; subscriber_id: string }[]>`
      SELECT id, subscriber_id
        FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id LIKE ${`${prefix}-%`}
    `;
    const loopId = seeded.find((row) => row.subscriber_id === loopSubscriber)?.id;
    expect(loopId).toBeDefined();
    // Narrow for the SQL template below: postgres.js has no overload for an `undefined` parameter.
    if (loopId === undefined) throw new Error('the loop delivery was not seeded');
    expect(seeded).toHaveLength(31);

    // The work-item retries are older by created_at, so the old single global
    // reserve would fill a 25-row batch before reaching the loop wake. The loop
    // lane gets its own one-row reserve; ordinary retries retain their reserve.
    await db.adminSql`
      UPDATE harness_shared.event_wake_deliveries
         SET attempts = 1,
             status = 'parked',
             last_error = 'subscriber is currently uninjectable',
             created_at = CASE
               WHEN id = ${loopId} THEN now() - interval '9 minutes'
               ELSE now() - interval '10 minutes'
             END,
             next_attempt_at = CASE
               WHEN id = ${loopId} THEN now() - interval '1 day'
               ELSE now() - interval '5 minutes'
             END
       WHERE id = ANY(${seeded.map((row) => row.id)})
    `;

    const claimed = await store.claimDueDeliveries({ limit: 25 });
    expect(claimed.map((delivery) => delivery.id)).toContain(loopId);
    expect(claimed).toHaveLength(25);

    for (const delivery of claimed) await store.markDeliveryDropped(delivery.id, 'test cleanup');
    await db.adminSql`
      DELETE FROM harness_shared.event_wake_deliveries
       WHERE subscriber_id LIKE ${`${prefix}-%`}
    `;
  });

  it('keeps the host-accepted fact when SessionEnd drops a parked cold reset (WI-6554700010030084)', async () => {
    const key = `${store.INBOX_WAKE_KEY_PREFIX}su-cold-reset-wake`;
    await store.upsertInboxWakeAwait({ subscriberId: 'su-cold-reset-wake', eventKey: key, note: 'standing wake' });
    const first = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: first, summary: 'cold-reset-accepted' });
    const [claimed] = await store.claimDueDeliveries({ limit: 5 });
    await store.markDeliveryParked(
      claimed.id,
      'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
      60_000,
    );
    const second = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: second, summary: 'pending-not-accepted' });

    expect(await store.cancelInboxWakeAwaits('su-cold-reset-wake')).toBe(1);

    const recent = await store.listRecentDeliveries('su-cold-reset-wake', 10);
    const accepted = recent.find((delivery) => delivery.summary === 'cold-reset-accepted');
    const pending = recent.find((delivery) => delivery.summary === 'pending-not-accepted');
    expect(accepted).toMatchObject({ status: 'dropped' });
    expect(pending).toMatchObject({ status: 'dropped' });
    expect(accepted?.lastError).toContain(HOST_ACCEPTED_CANCELLED_DELIVERY_MARKER);
    expect(pending?.lastError).not.toContain(HOST_ACCEPTED_CANCELLED_DELIVERY_MARKER);
    expect(lastLoopFireParked({ lastWakeStatus: 'dropped', lastWakeError: accepted?.lastError })).toBe(false);
    expect(lastLoopFireParked({ lastWakeStatus: 'dropped', lastWakeError: pending?.lastError })).toBe(true);
  });

  it('drops queued and claimed deliveries for any cancelled await before wake execution', async () => {
    const key = `${store.INBOX_WAKE_KEY_PREFIX}su-cancelled-wake`;
    await store.upsertInboxWakeAwait({ subscriberId: 'su-cancelled-wake', eventKey: key, note: 'standing wake' });

    const first = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: first, summary: 'claimed-before-cancel' });
    const [claimed] = await store.claimDueDeliveries({ limit: 5 });
    expect(claimed.status).toBe('delivering');

    // A second delivery remains pending when cancellation begins. The cancel
    // path drops it immediately; the pump guard owns only the already-claimed
    // race above.
    const second = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: second, summary: 'pending-before-cancel' });
    expect(await store.cancelInboxWakeAwaits('su-cancelled-wake')).toBe(1);

    expect(await store.settleCancelledAwaitDeliveries([claimed])).toEqual([claimed.id]);

    const recent = await store.listRecentDeliveries('su-cancelled-wake', 10);
    expect(recent.find((delivery) => delivery.summary === 'claimed-before-cancel')).toMatchObject({
      status: 'dropped',
      channel: null,
    });
    expect(recent.find((delivery) => delivery.summary === 'pending-before-cancel')).toMatchObject({
      status: 'dropped',
    });

    expect(await store.settleCancelledAwaitDeliveries([claimed])).toEqual([]);
  });

  it('failure path: backoff-retry then dead at max attempts', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-7', eventKey: 'fail:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'fail:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    expect(w.subscriberId).toBe('su-7');

    expect(
      await store.markDeliveryFailed({ id: w.id, error: 'e1', attempts: 1, maxAttempts: 8, backoffMs: 1 }),
    ).toBe('retrying');
    expect(
      await store.markDeliveryFailed({ id: w.id, error: 'e2', attempts: 8, maxAttempts: 8, backoffMs: 1 }),
    ).toBe('dead');
    const recent = await store.listRecentDeliveries('su-7');
    expect(recent[0]).toMatchObject({ status: 'dead', lastError: 'e2' });
  });

  it('reopens an optimistically delivered resume after its detached turn dies', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-resume-death', eventKey: 'resume:dies' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'resume:dies' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = (await store.claimDueDeliveries({ limit: 5 })).filter(
      (row) => row.subscriberId === 'su-resume-death',
    );
    await store.markDeliveryDelivered(w.id, 'resume-headless');

    expect(
      await store.reopenDeliveredAfterResumeDeath({
        id: w.id,
        error: 'resume-turn-death:rate_limited',
        maxAttempts: 8,
        backoffMs: 1,
      }),
    ).toBe('retrying');
    const recent = await store.listRecentDeliveries('su-resume-death');
    expect(recent[0]).toMatchObject({
      status: 'pending',
      channel: null,
      deliveredAt: null,
      lastError: 'resume-turn-death:rate_limited',
    });

    // A stale duplicate exit callback cannot revise the row a second time.
    expect(
      await store.reopenDeliveredAfterResumeDeath({
        id: w.id,
        error: 'duplicate',
        maxAttempts: 8,
        backoffMs: 1,
      }),
    ).toBe('ignored');
  });

  it('parked rows wait out their recheck window; dropped rows are terminal + visible', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-8', eventKey: 'park:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'park:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    await store.markDeliveryParked(w.id, 'alive, no pty', 60_000);
    // Not due yet → not re-claimed.
    expect((await store.claimDueDeliveries({ limit: 5 })).filter((x) => x.id === w.id)).toHaveLength(0);
    await store.markDeliveryDropped(w.id, 'dead waiter');
    const recent = await store.listRecentDeliveries('su-8');
    expect(recent[0]).toMatchObject({ status: 'dropped', lastError: 'dead waiter' });
  });

  it('ack settles MY parked wake as inbox-delivered; a peer cannot ack it', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-ack', eventKey: 'ack:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'ack:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    await store.markDeliveryParked(w.id, 'alive, no pty', 60_000);
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-imposter' })).toEqual({
      acked: false,
      alreadySettled: false,
    });
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack' })).toEqual({
      acked: true,
      alreadySettled: false,
    });
    const recent = await store.listRecentDeliveries('su-ack');
    expect(recent[0]).toMatchObject({ status: 'delivered', channel: 'inbox' });
    // Idempotence: a second ack is a no-op (already settled).
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack' })).toEqual({
      acked: false,
      alreadySettled: true,
      status: 'delivered',
    });
  });

  it('retries an ACK miss when the owned delivery is parked again', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-ack-reparked', eventKey: 'ack:reparked' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'ack:reparked' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = (await store.claimDueDeliveries({ limit: 25 })).filter((d) => d.subscriberId === 'su-ack-reparked');
    expect(w).toBeDefined();
    await store.markDeliveryParked(w.id, 'test race: pump returned the row to parked', 60_000);

    // Inject the race's observable sequence: the first conditional ACK write
    // misses, then the owned-row read still sees this delivery parked.
    const originalSql = h.sql as import('postgres').Sql;
    let forcedMiss = false;
    let firstAckUpdate = true;
    h.sql = new Proxy(originalSql, {
      apply(target, thisArg, args) {
        const queryText = (args[0] as TemplateStringsArray).join(' ');
        if (firstAckUpdate && queryText.includes('UPDATE harness_shared.event_wake_deliveries')) {
          firstAckUpdate = false;
          forcedMiss = true;
          return [];
        }
        return Reflect.apply(target, thisArg, args);
      },
    });

    try {
      expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack-reparked' })).toEqual({
        acked: true,
        alreadySettled: false,
      });
      expect(forcedMiss).toBe(true);
    } finally {
      h.sql = originalSql;
    }

    expect((await store.listRecentDeliveries('su-ack-reparked'))[0]).toMatchObject({
      id: w.id,
      status: 'delivered',
      channel: 'inbox',
    });
  });

  it('does not ack a wake already being delivered by the pump', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-ack-delivering', eventKey: 'ack:delivering' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'ack:delivering' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });

    expect(w.status).toBe('delivering');
    expect(await store.ackDelivery({ deliveryId: w.id, subscriberId: 'su-ack-delivering' })).toEqual({
      acked: false,
      alreadySettled: false,
      status: 'delivering',
    });
    expect((await store.listRecentDeliveries('su-ack-delivering'))[0]).toMatchObject({
      id: w.id,
      status: 'delivering',
    });
  });

  it('settleCaughtUpInboxWakeDeliveries (EI-9389): settles MY pre-cutoff pending/parked standing-inbox-wake deliveries as coalesced; a post-cutoff row and a peer\'s row are left alone', async () => {
    const key = `${store.INBOX_WAKE_KEY_PREFIX}su-settle`;
    // The always-armed standing (once:false) inbox-wake watch — mirrors the real thing.
    await store.registerAwait({ subscriberId: 'su-settle', eventKey: key, once: false });

    // Delivery #1 (parked): claim it IMMEDIATELY (nothing else queued yet, so
    // claimDueDeliveries can't accidentally sweep a sibling row too) then park it —
    // both pre-cutoff settle paths (pending AND parked) must be covered.
    const fired1 = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: fired1, summary: 'seen-parked' });
    const [toPark] = await store.claimDueDeliveries({ limit: 1 });
    await store.markDeliveryParked(toPark.id, 'alive, no pty', 60_000);

    // Delivery #2 (pending): traffic the agent has ALREADY read in a bulk coord:inbox,
    // left untouched (never claimed) — this is the common case.
    const fired1b = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: fired1b, summary: 'seen-pending' });

    // A loop uses the same standing key but reading the inbox does not execute
    // its iteration. Both pending and host-parked loop work must survive cleanup.
    for (const summary of ['loop-pending', 'loop-parked']) {
      const loopAwaits = await store.fireAwaitsForKey({ eventKey: key });
      // Distinct source routines avoid the legitimate older-loop supersession.
      const routineId = 'fixture-' + summary;
      await store.insertDeliveries({ awaits: loopAwaits, summary, source: 'loop:' + routineId, payload: { routineId } });
    }
    const loopRows = await store.listRecentDeliveries('su-settle', 10);
    expect(loopRows.find(d => d.summary === 'loop-pending')?.status).toBe('pending');
    expect(loopRows.find(d => d.summary === 'loop-parked')?.status).toBe('pending');
    await store.markDeliveryParked(loopRows.find(d => d.summary === 'loop-parked')!.id, 'host accepted', 60_000);

    // WI-6554700010009881: a work-item dispatch rides the same standing key, but the
    // assignment it carries is not a coord message — a bulk inbox read never shows it.
    // Pending and host-parked dispatch wakes must both survive the settle.
    for (const summary of ['dispatch-pending', 'dispatch-parked']) {
      const dispatchAwaits = await store.fireAwaitsForKey({ eventKey: key });
      await store.insertDeliveries({
        awaits: dispatchAwaits,
        summary,
        source: 'system:plan-run-direct-dispatch',
        payload: { kind: 'actionable-work-item-dispatch', workItemIds: ['WI-' + summary] },
      });
    }
    const dispatchRows = await store.listRecentDeliveries('su-settle', 10);
    await store.markDeliveryParked(dispatchRows.find(d => d.summary === 'dispatch-parked')!.id, 'host accepted', 60_000);

    // A peer's own standing wake, fired at the same moment — must NEVER be touched by
    // MY settle call (subscriber_id-scoped, like ackDelivery).
    const peerKey = `${store.INBOX_WAKE_KEY_PREFIX}su-settle-peer`;
    await store.registerAwait({ subscriberId: 'su-settle-peer', eventKey: peerKey, once: false });
    const firedPeer = await store.fireAwaitsForKey({ eventKey: peerKey });
    await store.insertDeliveries({ awaits: firedPeer, summary: 'peer-untouched' });

    // The cutoff: everything above was queued before this instant.
    const cutoffTs = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20)); // ensure strictly-later created_at below

    // Delivery #2: fired AFTER the cutoff (arrived mid-read) — must survive untouched.
    const fired2 = await store.fireAwaitsForKey({ eventKey: key });
    await store.insertDeliveries({ awaits: fired2, summary: 'post-cutoff' });

    const settledCount = await store.settleCaughtUpInboxWakeDeliveries({ subscriberId: 'su-settle', cutoffTs });
    expect(settledCount).toBe(2); // the pending + the parked pre-cutoff rows

    const mine = await store.listRecentDeliveries('su-settle', 10);
    expect(mine.find((d) => d.summary === 'seen-pending')).toMatchObject({ status: 'delivered', channel: 'coalesced' });
    expect(mine.find((d) => d.summary === 'seen-parked')).toMatchObject({ status: 'delivered', channel: 'coalesced' });
    expect(mine.find((d) => d.summary === 'post-cutoff')).toMatchObject({ status: 'pending' });
    expect(mine.find((d) => d.summary === 'loop-pending')).toMatchObject({ status: 'pending' });
    expect(mine.find((d) => d.summary === 'loop-parked')).toMatchObject({ status: 'parked' });
    expect(mine.find((d) => d.summary === 'dispatch-pending')).toMatchObject({ status: 'pending' });
    expect(mine.find((d) => d.summary === 'dispatch-parked')).toMatchObject({ status: 'parked' });

    const peer =await store.listRecentDeliveries('su-settle-peer', 10);
    expect(peer.find((d) => d.summary === 'peer-untouched')).toMatchObject({ status: 'pending' });

    // Idempotence: re-settling the same (now-empty) window finds nothing left to do.
    expect(await store.settleCaughtUpInboxWakeDeliveries({ subscriberId: 'su-settle', cutoffTs })).toBe(0);
  });

  it('deferred rows give back their attempt and re-queue', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-9', eventKey: 'defer:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'defer:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    expect(w.attempts).toBe(1);
    await store.markDeliveryDeferred(w.id, 0);
    const [again] = (await store.claimDueDeliveries({ limit: 5 })).filter((x) => x.id === w.id);
    expect(again).toBeDefined();
    expect(again.attempts).toBe(1); // deferral did not burn the attempt
  });

  it('stuck-delivering recovery re-queues crashed-host claims', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-10', eventKey: 'stuck:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'stuck:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = await store.claimDueDeliveries({ limit: 5 });
    // Simulate a crash long ago: claimed (delivering) with an old next_attempt_at.
    const sql = h.sql as import('postgres').Sql;
    await sql`UPDATE harness_shared.event_wake_deliveries SET next_attempt_at = now() - interval '1 hour' WHERE id = ${w.id}`;
    expect(await store.recoverStuckDeliveries({ olderThanMs: 5 * 60_000 })).toBeGreaterThanOrEqual(1);
    // A verdict-less recovered row is visible as recovered, not as an ordinary
    // untouched retry (WI-10008205).
    const [recovered] = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM harness_shared.event_wake_deliveries WHERE id = ${w.id}
    `;
    expect(recovered).toEqual({ status: 'pending', last_error: store.RECOVERED_STUCK_DELIVERING_ERROR });
    const reclaimed = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.id === w.id);
    expect(reclaimed).toHaveLength(1);
    await store.markDeliveryDelivered(w.id, 'inbox');
  });

  it('stuck-delivering recovery keeps an existing last_error (psu-host acceptance marker)', async () => {
    const fired = await store
      .registerAwait({ subscriberId: 'su-10-accepted', eventKey: 'stuck:accepted:k' })
      .then(() => store.fireAwaitsForKey({ eventKey: 'stuck:accepted:k' }));
    await store.insertDeliveries({ awaits: fired });
    const [w] = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-10-accepted');
    const sql = h.sql as import('postgres').Sql;
    // The pump reads this prefix to avoid a duplicate wake; recovery must not hide it.
    await sql`
      UPDATE harness_shared.event_wake_deliveries
         SET next_attempt_at = now() - interval '1 hour', last_error = 'psu-host accepted: pending commit'
       WHERE id = ${w.id}
    `;
    expect(await store.recoverStuckDeliveries({ olderThanMs: 5 * 60_000 })).toBeGreaterThanOrEqual(1);
    const [row] = await sql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM harness_shared.event_wake_deliveries WHERE id = ${w.id}
    `;
    expect(row).toEqual({ status: 'pending', last_error: 'psu-host accepted: pending commit' });
    await store.markDeliveryDropped(w.id, 'test cleanup');
  });

  it('a recovered stuck delivery outranks older parked retries, for a bounded number of attempts', async () => {
    const prefix = 'su-recovered-rank';
    const sql = h.sql as import('postgres').Sql;
    const subs = { p1: `${prefix}-parked-1`, p2: `${prefix}-parked-2`, r: `${prefix}-recovered` };
    for (const [key, subscriberId] of Object.entries(subs)) {
      const a = await store.registerAwait({ subscriberId, eventKey: `recovered:rank:${key}` });
      await store.insertDeliveries({ awaits: [a], summary: key });
    }
    const ours = (await store.claimDueDeliveries({ limit: 25 })).filter((d) => d.subscriberId.startsWith(`${prefix}-`));
    expect(ours).toHaveLength(3);
    const id = (subscriberId: string) => ours.find((d) => d.subscriberId === subscriberId)!.id;
    await store.markDeliveryParked(id(subs.p1), 'subscriber is currently uninjectable', 0);
    await store.markDeliveryParked(id(subs.p2), 'subscriber is currently uninjectable', 0);
    // Both parked retries are due EARLIER than the recovered row, so ordering by
    // due time alone (the pre-fix behaviour) would claim them both first.
    await sql`UPDATE harness_shared.event_wake_deliveries SET created_at = now() - interval '2 hours', next_attempt_at = now() - interval '60 minutes' WHERE id = ${id(subs.p1)}`;
    await sql`UPDATE harness_shared.event_wake_deliveries SET created_at = now() - interval '2 hours', next_attempt_at = now() - interval '50 minutes' WHERE id = ${id(subs.p2)}`;
    // The recovered row: claimed (delivering), its host died, and no verdict was written.
    await sql`UPDATE harness_shared.event_wake_deliveries SET created_at = now() - interval '2 hours', next_attempt_at = now() - interval '10 minutes' WHERE id = ${id(subs.r)}`;
    expect(await store.recoverStuckDeliveries({ olderThanMs: 5 * 60_000 })).toBeGreaterThanOrEqual(1);

    // Hold every other test's due row out of the window so only ours compete.
    const foreign = await sql<{ id: number }[]>`
      UPDATE harness_shared.event_wake_deliveries
         SET next_attempt_at = next_attempt_at + interval '1 day'
       WHERE status IN ('pending', 'parked') AND next_attempt_at <= now()
         AND subscriber_id NOT LIKE ${`${prefix}-%`}
      RETURNING id
    `;
    try {
      // limit 2: slot 1 is the oldest-aged-retry reserve (parked-1); slot 2 must be
      // the recovered row, not the older-due parked-2.
      const claimed = await store.claimDueDeliveries({ limit: 2 });
      expect(claimed.map((d) => d.subscriberId).sort()).toEqual([subs.p1, subs.r].sort());

      // Bound: past RECOVERED_PRIORITY_MAX_ATTEMPTS the recovered row is an ordinary
      // aged retry again, so the older-due parked rows win both slots.
      await sql`UPDATE harness_shared.event_wake_deliveries SET status = 'parked' WHERE id IN (${id(subs.p1)}, ${id(subs.p2)})`;
      await sql`
        UPDATE harness_shared.event_wake_deliveries
           SET status = 'pending', attempts = 3, last_error = ${store.RECOVERED_STUCK_DELIVERING_ERROR}
         WHERE id = ${id(subs.r)}
      `;
      const bounded = await store.claimDueDeliveries({ limit: 2 });
      expect(bounded.map((d) => d.subscriberId).sort()).toEqual([subs.p1, subs.p2].sort());
    } finally {
      if (foreign.length > 0) {
        await sql`
          UPDATE harness_shared.event_wake_deliveries
             SET next_attempt_at = next_attempt_at - interval '1 day'
           WHERE id IN ${sql(foreign.map((f) => f.id))}
        `;
      }
      await sql`DELETE FROM harness_shared.event_wake_deliveries WHERE subscriber_id LIKE ${`${prefix}-%`}`;
    }
  });

  it('timeouts: wake-behavior awaits fire as TIMEOUT; expire-behavior awaits lapse silently', async () => {
    await store.registerAwait({
      subscriberId: 'su-11',
      eventKey: 'never:k',
      timeoutBehavior: 'wake',
      timeoutSec: 0,
    });
    await store.registerAwait({
      subscriberId: 'su-12',
      eventKey: 'never:k2',
      timeoutBehavior: 'expire',
      timeoutSec: 0,
    });
    await new Promise((r) => setTimeout(r, 50));
    const timedOut = await store.fireTimedOutAwaits();
    expect(timedOut.some((a) => a.subscriberId === 'su-11')).toBe(true);
    expect(timedOut.every((a) => a.firedReason === 'timeout')).toBe(true);
    expect(await store.expireLapsedAwaits()).toBeGreaterThanOrEqual(1);
    // Both settled — nothing active remains for either key.
    expect(await store.listActiveAwaits('su-11')).toEqual([]);
    expect(await store.listActiveAwaits('su-12')).toEqual([]);
  });

  it('gives an in-window event fire precedence over a one-shot timeout (real PG)', async () => {
    const eventKey = 'timeout-race:event-wins';
    const awaited = await store.registerAwait({
      subscriberId: 'su-timeout-race-event',
      eventKey,
      timeoutBehavior: 'wake',
      timeoutSec: 0,
      once: true,
    });
    const sql = h.sql as import('postgres').Sql;

    // Use the real latch writer, then place the await deadline just after the
    // recorded fire so the row is already due while the fire remains in its
    // [created_at, expires_ts] window.
    await store.recordKeyFire({ eventKey, firedBy: 'integration-test' });
    const [fire] = await sql<{ last_fired_at: string }[]>`
      SELECT last_fired_at
        FROM harness_shared.event_key_fires
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND event_key = ${eventKey}
    `;
    expect(fire).toBeDefined();
    await sql`
      UPDATE harness_shared.event_awaits
         SET created_at = ${fire.last_fired_at}::timestamptz - interval '1 second',
             expires_ts = ${fire.last_fired_at}::timestamptz + interval '1 millisecond'
       WHERE id = ${awaited.id}
    `;
    await new Promise((r) => setTimeout(r, 20));

    const timedOut = await store.fireTimedOutAwaits();

    expect(timedOut.some((a) => a.id === awaited.id)).toBe(false);
    const [state] = await sql<{ fired_at: string | null; fired_reason: string | null }[]>`
      SELECT fired_at, fired_reason
        FROM harness_shared.event_awaits
       WHERE id = ${awaited.id}
    `;
    expect(state).toEqual({ fired_at: null, fired_reason: null });
  });

  it('does not create a second wake when a task-terminal event arrives after timeout', async () => {
    const taskId = 'late-timeout-task-terminal';
    const eventKey = `task:terminal:${taskId}`;
    const awaited = await store.registerAwait({
      subscriberId: 'su-task-terminal-timeout-race',
      eventKey,
      timeoutBehavior: 'wake',
      timeoutSec: 60,
      once: true,
    });
    const sql = h.sql as import('postgres').Sql;

    // Force the deadline to pass, then let the normal timeout path consume the
    // one-shot await before the managed task reaches its terminal ledger state.
    await sql`
      UPDATE harness_shared.event_awaits
         SET expires_ts = now() - interval '1 second'
       WHERE id = ${awaited.id}
    `;
    const timedOut = await store.fireTimedOutAwaits();
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ id: awaited.id, firedReason: 'timeout' });
    expect(await store.insertDeliveries({
      awaits: timedOut,
      payload: { timeout: true },
      summary: 'timeout wake',
    })).toBe(1);

    // The terminal bridge still records the monotonic fire, but the consumed
    // await cannot be claimed a second time by a late event.
    await store.recordKeyFire({
      eventKey,
      firedBy: 'task-manager',
      payload: { taskId, state: 'exited' },
    });
    expect(await store.fireAwaitsForKey({ eventKey, payload: { taskId, state: 'exited' } })).toEqual([]);
    expect(await store.getKeyFireLatch(eventKey)).toMatchObject({ fireCount: 1, lastFiredBy: 'task-manager' });

    const deliveries = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM harness_shared.event_wake_deliveries
       WHERE await_id = ${awaited.id}
    `;
    expect(Number(deliveries[0]?.count)).toBe(1);
  });

  it('does not timeout standing watches in the wake-timeout sweep', async () => {
    const awaited = await store.registerAwait({
      subscriberId: 'su-standing-timeout',
      eventKey: 'timeout-race:standing',
      timeoutBehavior: 'wake',
      timeoutSec: 0,
      once: false,
    });
    await new Promise((r) => setTimeout(r, 20));

    const timedOut = await store.fireTimedOutAwaits();

    expect(timedOut.some((a) => a.id === awaited.id)).toBe(false);
    expect((await store.listActiveAwaits('su-standing-timeout')).map((a) => a.id)).toEqual([awaited.id]);
  });

  it('the wake meter aggregates per subscriber/status/channel', async () => {
    const meter = await store.wakeMeter({ sinceHours: 24 });
    expect(meter.length).toBeGreaterThan(0);
    const delivered = meter.find((m) => m.subscriberId === 'su-6' && m.status === 'delivered');
    expect(delivered).toMatchObject({ channel: 'plan-run-resume', count: 1 });
    // P-006 / D-005: the meter splits by turn proof; a fresh turn-capable delivery is awaiting.
    expect(delivered).toHaveProperty('turnProof', 'awaiting');
    // ...and the per-delivery read (events:status's seam) carries the same proof + deadline.
    const [row] = await store.listRecentDeliveries('su-6', 1);
    expect(row).toMatchObject({ status: 'delivered', turnProof: 'awaiting', turnStartedAt: null });
    expect(row!.pickupDeadlineAt).not.toBeNull();
  });

  it('is single-workspace by construction: no caller can scope a row to a different namespace (WI-3575, formerly the live WI-40 regression)', async () => {
    // Originally this test proved that a `workspaceId: '*'` registration and a
    // `workspaceId: 'some-active-workspace'` emit still landed in the same coord
    // namespace (an unscoped SU shell vs. a system source emitting under the
    // active workspace). WI-3575 found the store never actually branched on the
    // input at all — every exported function silently pinned DEFAULT_COORD_WORKSPACE
    // regardless, so the two-different-workspaceIds scenario the test wrote wasn't
    // exercising isolation, it just proved the ignoring was self-consistent. The
    // dead parameter was removed everywhere (rather than "honored", which would
    // resurrect the exact cross-workspace-mismatch bug this design fixed) — so the
    // scenario is now a type error, not a runtime normalization. Assert the
    // invariant that survives: registerAwait/fireAwaitsForKey take no workspaceId
    // input at all and always land under the one coord workspace.
    await store.registerAwait({ subscriberId: 'su-13', eventKey: 'ws:k' });
    const fired = await store.fireAwaitsForKey({ eventKey: 'ws:k' });
    expect(fired).toHaveLength(1);
    expect(fired[0].subscriberId).toBe('su-13');
    expect(fired[0].workspaceId).toBe(DEFAULT_COORD_WORKSPACE);
  });

  // ── unify-watch-primitive: cardinality + floor + coalesce (P-005/P-007) ──

  it('fair grant-to-next: a targeted key fires ONLY its one waiter, never a broadcast (P-008/D-005)', async () => {
    // The lock-grant-bridge pattern: a freed lock grants ONE next waiter and emits that
    // waiter's targeted `lock:grant:<ticket>` key. Two waiters on two distinct tickets must
    // not thunder-herd — firing ticket A wakes only A's watch, leaving B's armed.
    await store.registerAwait({ subscriberId: 'su-waiterA', eventKey: 'lock:grant:ticketA' });
    await store.registerAwait({ subscriberId: 'su-waiterB', eventKey: 'lock:grant:ticketB' });
    const firedA = await store.fireAwaitsForKey({ eventKey: 'lock:grant:ticketA' });
    expect(firedA.map((a) => a.subscriberId)).toEqual(['su-waiterA']);
    // B is untouched — still active, not woken.
    expect((await store.listActiveAwaits('su-waiterB')).map((a) => a.eventKey)).toEqual(['lock:grant:ticketB']);
  });

  it('standing watches (once:false) fire on EVERY emit; a one-shot peer fires once (cardinality, D-001)', async () => {
    await store.registerAwait({ subscriberId: 'su-standing', eventKey: 'card:k', once: false, minSleepSec: 30 });
    await store.registerAwait({ subscriberId: 'su-oneshot', eventKey: 'card:k', once: true });
    const first = await store.fireAwaitsForKey({ eventKey: 'card:k' });
    expect(first.map((a) => a.subscriberId).sort()).toEqual(['su-oneshot', 'su-standing']);
    // Subsequent emits: the standing watch keeps firing; the one-shot is consumed.
    const second = await store.fireAwaitsForKey({ eventKey: 'card:k' });
    expect(second.map((a) => a.subscriberId)).toEqual(['su-standing']);
    const third = await store.fireAwaitsForKey({ eventKey: 'card:k' });
    expect(third.map((a) => a.subscriberId)).toEqual(['su-standing']);
    expect(third[0].once).toBe(false);
    expect(third[0].minSleepSec).toBe(30);
  });

  it('floor inputs round-trip; the watch-level urgency OR’s onto its deliveries (P-005)', async () => {
    const a = await store.registerAwait({
      subscriberId: 'su-floor',
      eventKey: 'floor:k',
      once: false,
      minSleepSec: 45,
      urgency: true,
    });
    expect(a.minSleepSec).toBe(45);
    expect(a.urgency).toBe(true);
    const fired = await store.fireAwaitsForKey({ eventKey: 'floor:k' });
    // emit-time urgent=false, but the watch is always-urgent → delivery urgent=true.
    await store.insertDeliveries({ awaits: fired, urgent: false });
    const [w] = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-floor');
    expect(w.urgent).toBe(true);
    expect(w.minSleepSec).toBe(45);
  });

  it('coalesced siblings settle as a no-turn delivery; last_woken counts only turn-burning channels (P-005)', async () => {
    await store.registerAwait({ subscriberId: 'su-coal', eventKey: 'coal:k', once: false });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'coal:k' }) });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'coal:k' }) });
    const work = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-coal');
    expect(work.length).toBe(2);
    const [headline, sibling] = work;
    await store.markDeliveryDelivered(headline.id, 'resume', 2);
    await store.markDeliveriesCoalesced([sibling.id], headline.id);
    const recent = await store.listRecentDeliveries('su-coal');
    expect(recent.find((d) => d.id === sibling.id)).toMatchObject({ status: 'delivered', channel: 'coalesced' });
    expect(recent.find((d) => d.id === headline.id)).toMatchObject({ coalescedCount: 2 });
    // The headline 'resume' is a real wake; it sets last_woken.
    expect((await store.lastWokenAtForSubscribers(['su-coal'])).get('su-coal')).toBeGreaterThan(0);

    // A subscriber whose ONLY delivery is coalesced has NO last wake (no turn spent).
    await store.registerAwait({ subscriberId: 'su-coalonly', eventKey: 'coalonly:k' });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'coalonly:k' }) });
    const [only] = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-coalonly');
    await store.markDeliveriesCoalesced([only.id], 999);
    expect((await store.lastWokenAtForSubscribers(['su-coalonly'])).has('su-coalonly')).toBe(false);
  });

  // ── turn-lifecycle-control: always-arm inbox-wake (D-002/D-003, P-002) ──

  it('upsertInboxWakeAwait is idempotent: re-arming refreshes ONE standing row, never duplicates', async () => {
    const key = 'coord:inbox-wake:su-arm-1';
    const first = await store.upsertInboxWakeAwait({
      subscriberId: 'su-arm-1',
      eventKey: key,
      note: 'first',
      wakeHandle: { kind: 'adv-session', advSessionId: 7, agent: 'claude', sessionId: 'sid-1', ompThreadId: null, cwd: '/r', pid: 10 },
      minSleepSec: 60,
    });
    const second = await store.upsertInboxWakeAwait({
      subscriberId: 'su-arm-1',
      eventKey: key,
      note: 'second',
      wakeHandle: null, // re-arm without a fresh handle
      minSleepSec: 30,
    });
    // Same row, refreshed in place.
    expect(second.id).toBe(first.id);
    expect(second.note).toBe('second');
    expect(second.minSleepSec).toBe(30);
    // A null handle on re-arm KEEPS the previously-captured handle (COALESCE).
    expect(second.wakeHandle).toMatchObject({ kind: 'adv-session', advSessionId: 7 });
    // Exactly one active standing inbox-wake await for this agent.
    expect((await store.listActiveAwaits('su-arm-1')).filter((a) => a.eventKey === key)).toHaveLength(1);
  });

  it('cancelInboxWakeAwaits cancels the standing watch; a later arm starts a fresh row', async () => {
    const key = 'coord:inbox-wake:su-arm-2';
    const armed = await store.upsertInboxWakeAwait({ subscriberId: 'su-arm-2', eventKey: key, note: 'armed' });
    expect(await store.cancelInboxWakeAwaits('su-arm-2')).toBe(1);
    expect((await store.listActiveAwaits('su-arm-2')).filter((a) => a.eventKey === key)).toHaveLength(0);
    // Re-arming after cancel creates a NEW active row (the unique index frees on cancel).
    const rearmed = await store.upsertInboxWakeAwait({ subscriberId: 'su-arm-2', eventKey: key, note: 're' });
    expect(rearmed.id).not.toBe(armed.id);
    expect((await store.listActiveAwaits('su-arm-2')).filter((a) => a.eventKey === key)).toHaveLength(1);
    // A second cancel once nothing is active returns 0.
    expect(await store.cancelInboxWakeAwaits('su-arm-2')).toBe(1); // cancels the re-armed row
    expect(await store.cancelInboxWakeAwaits('su-arm-2')).toBe(0);
  });

  it('the unique index is scoped to inbox-wake keys: OTHER standing watches still allow duplicates', async () => {
    // A non-inbox-wake standing watch is NOT constrained by the partial index,
    // so two identical registrations coexist (unchanged behavior for pot/watch).
    await store.registerAwait({ subscriberId: 'su-arm-3', eventKey: 'pot:wake:x', once: false });
    await store.registerAwait({ subscriberId: 'su-arm-3', eventKey: 'pot:wake:x', once: false });
    expect((await store.listActiveAwaits('su-arm-3')).filter((a) => a.eventKey === 'pot:wake:x')).toHaveLength(2);
  });

  it('always-arm round-trip: an armed inbox-wake watch FIRES on a wake emit and stays armed (P-002/D-002)', async () => {
    // The end-to-end always-arm claim, against real PG with the migration-183
    // index: upsertInboxWakeAwait makes an agent wakeable, a wake emit to its
    // inbox-wake key fires the standing watch and yields a claimable delivery
    // carrying the captured handle, and (once:false) the watch survives the wake
    // so the agent stays armed across idle→woken→idle — the whole point of D-002.
    const key = 'coord:inbox-wake:su-rt';
    const armed = await store.upsertInboxWakeAwait({
      subscriberId: 'su-rt',
      eventKey: key,
      note: 'idle — armed at SessionStart',
      wakeHandle: {
        kind: 'adv-session',
        advSessionId: 11,
        agent: 'claude',
        sessionId: 'sid-rt',
        ompThreadId: null,
        cwd: '/r',
        pid: 20,
      },
      minSleepSec: 0,
    });

    // A wake emit to the agent's key fires its armed standing watch (woken ≥ 1).
    const fired = await store.fireAwaitsForKey({ eventKey: key });
    expect(fired.map((a) => a.subscriberId)).toEqual(['su-rt']);
    expect(fired[0].id).toBe(armed.id);

    // …and produces a real, claimable delivery carrying the captured wake handle.
    await store.insertDeliveries({ awaits: fired });
    const work = (await store.claimDueDeliveries({ limit: 10 })).filter((x) => x.subscriberId === 'su-rt');
    expect(work).toHaveLength(1);
    expect(work[0].wakeHandle).toMatchObject({ kind: 'adv-session', advSessionId: 11 });

    // once:false → still armed after the wake (idle→woken→idle stays wakeable).
    const again = await store.fireAwaitsForKey({ eventKey: key });
    expect(again.map((a) => a.subscriberId)).toEqual(['su-rt']);
    expect((await store.listActiveAwaits('su-rt')).filter((a) => a.eventKey === key)).toHaveLength(1);
  });

  it('unguarded-halt rescue skips one-shot inbox waits but keeps the standing keepalive and ordinary wakes intact', async () => {
    const key = 'coord:inbox-wake:su-rescue-filter';
    const oneShot = await store.registerAwait({
      subscriberId: 'su-rescue-one-shot',
      eventKey: key,
      once: true,
    });
    await store.upsertInboxWakeAwait({
      subscriberId: 'su-rescue-standing',
      eventKey: key,
    });

    // The synthetic rescue is not a directed message: it must leave the
    // message-only one-shot armed, while the standing keepalive remains the
    // path that can actually wake the halted session.
    const rescued = await store.fireAwaitsForKey({
      eventKey: key,
      source: 'unguarded-halt-rescue',
    });
    expect(rescued.map((row) => row.subscriberId).sort()).toEqual(['su-rescue-standing']);
    expect((await store.listActiveAwaits('su-rescue-one-shot')).map((row) => row.id)).toEqual([oneShot.id]);

    // A real directed wake on the same key still consumes the one-shot row.
    const directed = await store.fireAwaitsForKey({
      eventKey: key,
      source: 'coord:send',
    });
    expect(directed.map((row) => row.subscriberId).sort()).toEqual([
      'su-rescue-one-shot',
      'su-rescue-standing',
    ]);
    expect(await store.listActiveAwaits('su-rescue-one-shot')).toEqual([]);
  });

  it('rescue source does not suppress one-shot awaits on ordinary event keys', async () => {
    const awaited = await store.registerAwait({
      subscriberId: 'su-rescue-ordinary-key',
      eventKey: 'ordinary:rescue-key',
      once: true,
    });

    const fired = await store.fireAwaitsForKey({
      eventKey: awaited.eventKey,
      source: 'unguarded-halt-rescue',
    });

    expect(fired.map((row) => row.id)).toEqual([awaited.id]);
    expect(await store.listActiveAwaits('su-rescue-ordinary-key')).toEqual([]);
  });

  // ── P-006 slice 2 (WI-10008157, D-004): the pickup sweep's SQL half ──────────────────────

  /** Register → fire → queue → claim → deliver one wake; returns the delivery id. */
  async function deliveredWake(subscriberId: string, eventKey: string, channel: Parameters<typeof store.markDeliveryDelivered>[1]) {
    const a = await store.registerAwait({ subscriberId, eventKey });
    const fired = await store.fireAwaitsForKey({ eventKey });
    await store.insertDeliveries({ awaits: fired, payload: { k: eventKey }, summary: `wake for ${eventKey}` });
    const mine = (await store.claimDueDeliveries({ limit: 100 })).filter((w) => w.awaitId === a.id);
    expect(mine).toHaveLength(1);
    await store.markDeliveryDelivered(mine[0].id, channel);
    return mine[0].id;
  }

  async function proofRow(id: number) {
    const rows = await db.adminSql<Array<Record<string, unknown>>>`
      SELECT turn_proof, turn_started_at, pickup_deadline_at, pickup_escalated_at, source, status
        FROM harness_shared.event_wake_deliveries WHERE id = ${id}`;
    return rows[0];
  }

  async function toolCall(owner: string, tool: string, origin: string, offsetSec: number, args: object = {}) {
    await db.adminSql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
         coord_owner_id, call_origin, args_json, invoked_at)
      VALUES (${h.ws}, 'papercusp', 'test', ${tool}, 'su', 'spawn-x', 'w', 'ok',
              ${owner}, ${origin}, ${JSON.stringify(args)}::text::jsonb,
              now() + make_interval(secs => ${offsetSec}))`;
  }

  it('observeAwaitingTurnProofs: only a turn-only call AFTER delivery proves a turn (P-006 slice 2)', async () => {
    const sub = 'su-turn-proof-observe';
    const id = await deliveredWake(sub, 'turn-proof:observe', 'psu-socket-inject');
    expect(await proofRow(id)).toMatchObject({ turn_proof: 'awaiting', status: 'delivered' });

    // None of these is a turn: before delivery, the compaction retry stream, lifecycle and
    // status-line hooks. Each was measured firing for sessions that ran no turn.
    await toolCall(sub, 'work_items:get', 'agent', -60);
    await toolCall(sub, 'session:request-compaction', 'agent', 5);
    await toolCall(sub, 'activity:report', 'hook', 5, { kind: 'lifecycle', summary: '▶ session started' });
    await toolCall(sub, 'coord:glance', 'hook', 5, { display_only: true });
    await toolCall(sub, 'coord:emit', 'system', 5);
    await store.observeAwaitingTurnProofs();
    expect((await proofRow(id)).turn_proof).toBe('awaiting');

    // A tool-use hook IS a turn (it fires for native tools, which write no agent row).
    const hookSub = 'su-turn-proof-hook';
    const hookId = await deliveredWake(hookSub, 'turn-proof:hook', 'resume-headless');
    await toolCall(hookSub, 'activity:report', 'hook', 3, { phase: 'post' });

    // An agent call after delivery IS a turn, stamped with the FIRST qualifying call.
    await toolCall(sub, 'work_items:get', 'agent', 20);
    await toolCall(sub, 'coord:inbox', 'agent', 40);
    const n = await store.observeAwaitingTurnProofs();
    expect(n).toBeGreaterThanOrEqual(2);

    const observed = await proofRow(id);
    expect(observed.turn_proof).toBe('observed');
    const delivered = await db.adminSql<Array<{ gap: number }>>`
      SELECT extract(epoch FROM (turn_started_at - delivered_at))::float AS gap
        FROM harness_shared.event_wake_deliveries WHERE id = ${id}`;
    expect(delivered[0].gap).toBeGreaterThan(15);
    expect(delivered[0].gap).toBeLessThan(25);
    expect((await proofRow(hookId)).turn_proof).toBe('observed');
  });

  it('listExpiredPickups + settleExpiredPickup: not-picked-up re-queues ONCE for host recovery', async () => {
    const sub = 'su-turn-proof-expire';
    const id = await deliveredWake(sub, 'turn-proof:expire', 'psu-socket-inject');
    const fresh = await deliveredWake(sub, 'turn-proof:fresh', 'psu-socket-inject');
    await db.adminSql`
      UPDATE harness_shared.event_wake_deliveries
         SET delivered_at = now() - interval '20 minutes', pickup_deadline_at = now() - interval '10 minutes'
       WHERE id = ${id}`;

    const expired = (await store.listExpiredPickups()).filter((r) => r.subscriberId === sub);
    // The still-open window is not expired; the closed one is, with its routing fields.
    expect(expired.map((r) => r.id)).toEqual([id]);
    expect(expired[0]).toMatchObject({ eventKey: 'turn-proof:expire', channel: 'psu-socket-inject', source: null });
    expect(expired[0].pickupDeadlineAtMs).toBeLessThan(Date.now());
    expect((await proofRow(fresh)).turn_proof).toBe('awaiting');

    const first = await store.settleExpiredPickup({ id, proof: 'not-picked-up', escalate: true });
    expect(first.settled).toBe(true);
    expect(first.requeuedDeliveryId).not.toBeNull();
    const original = await proofRow(id);
    expect(original.turn_proof).toBe('not-picked-up');
    expect(original.pickup_escalated_at).not.toBeNull();

    const requeued = await db.adminSql<Array<Record<string, unknown>>>`
      SELECT o.await_id = r.await_id AS same_await, o.event_key = r.event_key AS same_key,
             o.subscriber_id = r.subscriber_id AS same_sub, o.payload = r.payload AS same_payload,
             r.status, r.source, r.turn_proof
        FROM harness_shared.event_wake_deliveries o, harness_shared.event_wake_deliveries r
       WHERE o.id = ${id} AND r.id = ${first.requeuedDeliveryId}`;
    expect(requeued[0]).toEqual({
      same_await: true,
      same_key: true,
      same_sub: true,
      same_payload: true,
      status: 'pending',
      source: 'pickup-escalation',
      turn_proof: null,
    });

    // Settling is one-shot: the row is no longer awaiting, so no second settle and no second re-queue.
    expect(await store.settleExpiredPickup({ id, proof: 'not-picked-up', escalate: true })).toEqual({
      settled: false,
      requeuedDeliveryId: null,
    });

    // The re-queue itself never escalates again, even if its host is still blocked.
    const mine = (await store.claimDueDeliveries({ limit: 100 })).filter((w) => w.id === first.requeuedDeliveryId);
    expect(mine).toHaveLength(1);
    await store.markDeliveryDelivered(mine[0].id, 'psu-socket-inject');
    await db.adminSql`
      UPDATE harness_shared.event_wake_deliveries SET pickup_deadline_at = now() - interval '1 minute'
       WHERE id = ${mine[0].id}`;
    const second = await store.settleExpiredPickup({ id: mine[0].id, proof: 'not-picked-up', escalate: true });
    expect(second).toEqual({ settled: true, requeuedDeliveryId: null });
    expect(await proofRow(mine[0].id)).toMatchObject({ turn_proof: 'not-picked-up', pickup_escalated_at: null });
  });

  it('settleExpiredPickup observed stamps the host-reported turn start and never re-queues', async () => {
    const id = await deliveredWake('su-turn-proof-host', 'turn-proof:host', 'psu-socket-inject');
    const startedMs = Date.now() - 5_000;
    const res = await store.settleExpiredPickup({ id, proof: 'observed', turnStartedAtMs: startedMs, escalate: true });
    expect(res).toEqual({ settled: true, requeuedDeliveryId: null });
    const row = await proofRow(id);
    expect(row.turn_proof).toBe('observed');
    expect(new Date(row.turn_started_at as string).getTime()).toBe(startedMs);
    expect(row.pickup_escalated_at).toBeNull();
  });
});
