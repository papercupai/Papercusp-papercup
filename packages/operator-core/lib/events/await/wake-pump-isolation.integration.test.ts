// @vitest-environment node
/**
 * wake-pump-isolation.integration.test.ts — C6 (idempotency / coalescing) + the
 * cross-agent adversarial pump path against REAL Postgres
 * (coordination-test-suite-2026-06-08 P-006).
 *
 * The EI-152 regression lives in wake-executor-matrix.test.ts; the store-level
 * one-shot / coalesce / retry / backoff state machine is covered in
 * await-store.integration.test.ts and the pump's pacing/governor logic in
 * engine.test.ts. THIS file adds the missing adversarial cells:
 *   - `armInboxWake` re-arm idempotency at the ARM (wrapper) level, not just the
 *     store upsert — re-arming on every tick yields ONE standing row.
 *   - **cross-agent emit isolation through the real `emitAwaitedEvent`**: an emit
 *     to A's inbox-wake key fires + delivers ONLY to A; B is never touched. (EI-153
 *     class, at the engine entry point an agent actually calls.)
 *   - **end-to-end pump delivers A's wake via A's live socket, never B's** (real
 *     store + real pump + the keystone testbed's real socket).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { MultiSessionTestbed } from '../../../test/_multi-session-testbed';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-pump-iso' }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => h.ws,
  backgroundWorkspaceIds: () => [h.ws],
}));

const store = await import('./store');
const engine = await import('./engine');
const { armInboxWake, cancelInboxWake } = await import('./inbox-wake-arm');
const { inboxWakeKey } = await import('../../agent-tools/coordination/inbox-wake');
const { consultExpiryEmitReplyEvent } = await import('../../consult/consult-expiry-adapters');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

describe('wake pump — C6 idempotency + cross-agent isolation (real PG)', () => {
  let db: OrgTestDb;
  let tb: MultiSessionTestbed;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // The pump narrates each delivery via console.warn (engine.ts `log`) — expected
  // operational noise, so silence it (fail-on-console default). Installed per-test
  // because the integration config auto-restores spies between tests.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Every test in this suite drives the pump ITSELF (deterministic explicit
    // `pumpWakeDeliveries` calls, the third test with the testbed's isolated
    // psu-pty host discovery). The internal fire-and-forget auto-pump kick that
    // `emitAwaitedEvent` schedules via `setImmediate` must NOT run alongside: it
    // fires with PRODUCTION host discovery (never the testbed's isolated dir),
    // is unawaited, and can straggle across the test boundary — e.g. test 2's
    // emit kicks a background pump that doesn't get to run until test 3 is
    // already mid-flight, where it claims test 3's freshly-inserted delivery for
    // A under `pumpsInFlight`'s single-flight guard before test 3's own explicit,
    // testbed-scoped `pumpWakeDeliveries` call does — leaving the delivery
    // claimed-but-undelivered (mirrors the fix already applied in
    // wake-on-message.integration.test.ts for the identical race).
    engine.setAutoPumpEnabledForTests(false);
  });

  afterEach(async () => {
    engine.setAutoPumpEnabledForTests(true);
    if (tb) await tb.destroy();
    vi.unstubAllEnvs();
  });

  const uid = () => `su-${Math.random().toString(36).slice(2, 10)}`;

  it('armInboxWake re-arm is idempotent: every tick refreshes ONE standing row', async () => {
    const owner = uid();
    const first = await armInboxWake({ ownerId: owner, note: 'tick 1', workspaceId: h.ws });
    const second = await armInboxWake({ ownerId: owner, note: 'tick 2', workspaceId: h.ws });
    const third = await armInboxWake({ ownerId: owner, note: 'tick 3', workspaceId: h.ws });

    // Same standing row, refreshed in place — never duplicated.
    expect(second.awaitId).toBe(first.awaitId);
    expect(third.awaitId).toBe(first.awaitId);
    expect(first.eventKey).toBe(inboxWakeKey(owner));
    const active = (await store.listActiveAwaits(owner)).filter((a) => a.eventKey === inboxWakeKey(owner));
    expect(active).toHaveLength(1);
    expect(active[0].note).toBe('tick 3');

    // Cancel removes it; a later arm starts fresh.
    expect(await cancelInboxWake(owner, h.ws)).toBe(1);
    expect((await store.listActiveAwaits(owner)).filter((a) => a.eventKey === inboxWakeKey(owner))).toHaveLength(0);
    const rearmed = await armInboxWake({ ownerId: owner, workspaceId: h.ws });
    expect(rearmed.awaitId).not.toBe(first.awaitId);
  });

  it('cross-agent: an emit to A\'s inbox-wake key fires + delivers ONLY to A, never B', async () => {
    const a = uid();
    const b = uid();
    await armInboxWake({ ownerId: a, workspaceId: h.ws });
    await armInboxWake({ ownerId: b, workspaceId: h.ws });

    // The real engine entry point an agent calls.
    const res = await engine.emitAwaitedEvent({ key: inboxWakeKey(a), summary: 'for A only', workspaceId: h.ws });
    // Drain the pump deterministically (emit kicks it via setImmediate).
    await engine.pumpWakeDeliveries(h.ws);

    // Exactly A was woken; B's standing watch is untouched.
    expect(res.woken).toBe(1);
    const aDeliveries = await store.listRecentDeliveries(a);
    const bDeliveries = await store.listRecentDeliveries(b);
    expect(aDeliveries.length).toBe(1);
    expect(bDeliveries.length).toBe(0); // A's emit can NEVER produce a B delivery
    // B's standing await is still armed (never consumed by A's emit).
    expect((await store.listActiveAwaits(b)).filter((x) => x.eventKey === inboxWakeKey(b))).toHaveLength(1);
  });

  it('end-to-end: the pump delivers A\'s wake via A\'s LIVE socket, and B\'s socket receives nothing', async () => {
    tb = MultiSessionTestbed.create();
    const a = uid();
    const b = uid();
    const hostA = await tb.spawnSocketHost(a);
    const hostB = await tb.spawnSocketHost(b);

    // A standing wake delivery for A (handle-less inbox-wake — the EI-152 shape).
    await armInboxWake({ ownerId: a, workspaceId: h.ws });
    const fired = await store.fireAwaitsForKey({ eventKey: inboxWakeKey(a) });
    expect(fired.map((x) => x.subscriberId)).toEqual([a]);
    await store.insertDeliveries({ awaits: fired });

    // Drive the REAL pump with the executor's psu-host discovery pointed at the
    // testbed's isolated dir (real findLiveHost + real injectIntoHost).
    // Wrapped async: the executor's seam is async (`typeof findLiveHostAsync`), and this
    // form type-checks whether the testbed's discovery dep is sync or async.
    const findPsuHost = tb.findPsuHostDep();
    await engine.pumpWakeDeliveries(h.ws, { findPsuHost: async (ownerId: string) => findPsuHost(ownerId) });

    // A's delivery landed on A's socket; B's socket got nothing.
    const recent = await store.listRecentDeliveries(a);
    expect(recent[0]).toMatchObject({ status: 'delivered', channel: 'psu-socket-inject' });
    expect(hostA.received).toHaveLength(1);
    expect(hostA.received[0]).toMatchObject({ v: 1, mode: 'turn' });
    expect(hostB.received).toHaveLength(0);
  });

  it('WI-6554700010045160: request-only emission stays queued until the background owner delivers that exact wake', async () => {
    tb = MultiSessionTestbed.create();
    const owner = uid();
    const host = await tb.spawnSocketHost(owner);
    await armInboxWake({ ownerId: owner, workspaceId: h.ws });
    const findPsuHost = tb.findPsuHostDep();
    const pump = () => engine.pumpWakeDeliveries(h.ws, {
      findPsuHost: async (ownerId: string) => findPsuHost(ownerId),
    });

    vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '0');
    const emitted = await engine.emitAwaitedEvent({ key: inboxWakeKey(owner), workspaceId: h.ws });
    expect(emitted.woken).toBe(1);
    const queued = await store.listRecentDeliveries(owner);
    expect(queued).toHaveLength(1);
    expect((await pump()).claimed).toBe(0);
    expect(await store.listRecentDeliveries(owner)).toEqual(queued);
    expect(host.received).toHaveLength(0);

    vi.stubEnv('PAPERCUSP_BACKGROUND_WORKERS', '1');
    expect((await pump()).delivered).toBe(1);
    expect(await store.listRecentDeliveries(owner)).toEqual([
      expect.objectContaining({ id: queued[0].id, status: 'delivered', channel: 'psu-socket-inject' }),
    ]);
    expect(host.received).toHaveLength(1);
    await pump();
    expect(host.received).toHaveLength(1);
  });

  it('a system consult reply wakes the requester without consuming source or answerer watches (D-006)', async () => {
    tb = MultiSessionTestbed.create();
    const source = tb.session('consult source');
    const answerer = tb.session('isolated answerer');
    const requester = tb.session('consult requester');
    const sourceHost = await tb.spawnSocketHost(source.ownerId);
    const answererHost = await tb.spawnSocketHost(answerer.ownerId);
    const requesterHost = await tb.spawnSocketHost(requester.ownerId);
    await armInboxWake({ ownerId: source.ownerId, workspaceId: h.ws });
    await armInboxWake({ ownerId: answerer.ownerId, workspaceId: h.ws });
    const sourceBefore = await store.listActiveAwaits(source.ownerId);
    const answererBefore = await store.listActiveAwaits(answerer.ownerId);
    const key = `consult:reply:conv-${requester.ownerId}`;
    await store.registerAwait({ subscriberId: requester.ownerId, eventKey: key });
    const findPsuHost = tb.findPsuHostDep();
    const pump = () => engine.pumpWakeDeliveries(h.ws, {
      findPsuHost: async (ownerId: string) => findPsuHost(ownerId),
    });

    // Cross the maintained SYSTEM adapter and real event store/pump/socket
    // seams. The transcript source in the payload is not a wake recipient.
    await consultExpiryEmitReplyEvent(engine.emitAwaitedEvent)({
      key, workspaceId: h.ws, to: [requester.ownerId], summary: 'answer window expired',
      payload: { sourceOwnerId: source.ownerId, answeringOwnerId: answerer.ownerId, reason: 'expired' },
    });
    await pump();
    expect(await store.listRecentDeliveries(requester.ownerId)).toEqual([
      expect.objectContaining({ eventKey: key, source: 'consult-expiry-sweep',
        status: 'delivered', channel: 'psu-socket-inject' }),
    ]);
    expect(requesterHost.received).toHaveLength(1);
    expect(sourceHost.received).toHaveLength(0);
    expect(answererHost.received).toHaveLength(0);
    expect(await store.listRecentDeliveries(source.ownerId)).toEqual([]);
    expect(await store.listRecentDeliveries(answerer.ownerId)).toEqual([]);
    expect(await store.listActiveAwaits(source.ownerId)).toEqual(sourceBefore);
    expect(await store.listActiveAwaits(answerer.ownerId)).toEqual(answererBefore);

    // These negatives must not pass merely because either independent host
    // is unusable. Their own exact wakes still land after the consult event.
    for (const [ownerId, host] of [
      [source.ownerId, sourceHost], [answerer.ownerId, answererHost],
    ] as const) {
      const emitted = await engine.emitAwaitedEvent({ key: inboxWakeKey(ownerId), workspaceId: h.ws });
      expect(emitted.woken).toBe(1);
      await pump();
      expect(host.received).toHaveLength(1);
      expect((await store.listRecentDeliveries(ownerId))[0]).toMatchObject({
        status: 'delivered', channel: 'psu-socket-inject',
      });
    }
    expect(requesterHost.received).toHaveLength(1);
  });
});
