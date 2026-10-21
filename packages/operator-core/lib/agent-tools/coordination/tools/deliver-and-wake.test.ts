/**
 * deliver-and-wake.test.ts — Phase 4 of local-hive-orchestration-2026-06-06.
 *
 * Covers P-040 (coord:send / coord:message-agent {wake:true} ENQUEUE the inbox
 * message AND fire the recipient's inbox-wake key), P-042 (single-target: one
 * emit per addressed recipient, on that recipient's OWN key — NEVER a broadcast
 * key, never '*'/'human'), and P-041 (coord:await-inbox arms a standing wake
 * watch on the caller's own inbox-wake key).
 *
 * The await-event engine is mocked at the module seam (we assert WHAT keys are
 * fired, not the live pump — the pump itself is unify-watch's tested substrate).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';
import { COORD_WAKE_TARGET_TIMEOUT_MS } from '../inbox-wake';
import type { WakeReachabilityVerdict } from '../../../events/await/wake-reachability';

// ── Mock the wake pump seam: capture every emit key, do not run the real pump. ──
/**
 * The structured-body gate (owner directive 2026-07-28) requires a sectioned `body` on a
 * directed `expects:'action'` send, plus `forYouBecause` on one section. These fixtures
 * exercise the WAKE path, not body validation, so they spread in the minimum valid body —
 * keeping each case about the thing it names.
 */
const ACTION_BODY = {
  body: [{ text: 'go', forYouBecause: { relation: 'owns' as const, note: 'yours to carry' } }],
};

const emitAwaitedEvent = vi.fn(async ({ key }: { key: string }) => ({
  ok: true as const,
  key,
  woken: 1,
  notified: [] as string[],
  msgId: null,
}));
// coord-dispatch-reliability P-001: the DEFAULT (no-wake) path now NON-FIRINGLY
// probes each recipient's inbox-wake key via listActiveAwaitsForKey + the local
// presence roster to REPORT idle recipients. Stub both so the unit test exercises
// the report without PG. Default: a roster of su-bee-1/2/3 (so they aren't treated
// as federated) and zero active watchers (so a plain send reports them idle).
const listActiveAwaitsForKey = vi.fn(async (_key: string) => [] as unknown[]);
const listPresence = vi.fn(async () => [
  { ownerId: 'su-bee-1' },
  { ownerId: 'su-bee-2' },
  { ownerId: 'su-bee-3' },
]);
// coord:await-inbox composes the registration internals directly — stub them so
// the unit test needs no PG / no real sweeper.
const registerAwait = vi.fn(async (input: { eventKey: string; once?: boolean; minSleepSec?: number | null }) => ({
  id: 77,
  eventKey: input.eventKey,
  once: input.once ?? false,
  minSleepSec: input.minSleepSec ?? null,
  workspaceId: 'ws',
  subscriberId: 'su-self',
  policy: 'wake' as const,
  note: null,
  wakeHandle: null,
  timeoutBehavior: 'wake' as const,
  expiresTs: null,
  createdAt: new Date().toISOString(),
  firedAt: null,
  firedReason: null,
  cancelledAt: null,
}));
// coord:await-inbox is now an annotation over the always-armed watch (D-005):
// it routes through armInboxWake → upsertInboxWakeAwait (NOT registerAwait), so
// the store mock must export the upsert seam that arm path actually calls.
const upsertInboxWakeAwait = vi.fn(
  async (input: { eventKey: string; minSleepSec?: number | null; note?: string | null }) => ({
    id: 77,
    eventKey: input.eventKey,
    once: false,
    minSleepSec: input.minSleepSec ?? null,
    workspaceId: 'ws',
    subscriberId: 'su-self',
    policy: 'wake' as const,
    note: input.note ?? null,
    wakeHandle: null,
    timeoutBehavior: 'expire' as const,
    expiresTs: null,
    createdAt: new Date().toISOString(),
    firedAt: null,
    firedReason: null,
    cancelledAt: null,
  }),
);
const cancelInboxWakeAwaits = vi.fn(async () => 0);
const startAwaitSweeper = vi.fn();
const captureWakeHandleForOwner = vi.fn(async () => ({ handle: null, note: 'no tracked session — inbox-degraded' }));
const reachableVerdict: WakeReachabilityVerdict = {
  reachable: true,
  channel: 'psu-socket' as const,
  durableWhileAlive: true,
  summary: 'live psu-host control socket — wakes inject in place as a fresh turn',
  awaitRepairable: false,
  wouldBeChannel: null,
};
const probeWakeReachability = vi.fn(async (_ownerId: string) => reachableVerdict);
// EI-5957: the wake-MODE gate + staging leg. Captured (not inline) so a test can
// drive the `manual` path — a member in manual wake-mode STAGES the leader's wake
// instead of delivering it. Default `auto` keeps every other test's behavior.
const resolveWakeMode = vi.fn(async (_ownerId: string) => 'auto' as 'auto' | 'manual');
const stagePendingWake = vi.fn(async () => ({ id: 1 }));

// WI-6554700010018245: coord:send to `human` fires a detached owner push
// (messages.ts lazily imports ../../session-push). Unmocked, the real push
// fails in a unit run and its catch logs console.warn, which
// vitest-fail-on-console turns into a failure of whichever case sent to `human`.
const notifySessionOwnerMessage = vi.fn(async () => undefined);
vi.mock('../../../session-push', () => ({
  notifySessionOwnerMessage: (...args: unknown[]) => notifySessionOwnerMessage(...(args as [])),
}));

vi.mock('../../../events/await/engine', () => ({
  emitAwaitedEvent: (args: { key: string }) => emitAwaitedEvent(args),
  startAwaitSweeper: () => startAwaitSweeper(),
}));
vi.mock('../../../events/await/store', () => ({
  registerAwait: (input: { eventKey: string }) => registerAwait(input),
  upsertInboxWakeAwait: (input: { eventKey: string }) => upsertInboxWakeAwait(input),
  cancelInboxWakeAwaits: () => cancelInboxWakeAwaits(),
  listActiveAwaitsForKey: (key: string) => listActiveAwaitsForKey(key),
}));
// ⚠ Do NOT reintroduce `importOriginal()` in THIS mock.
//
// OBSERVED (measured, WI-7411): with `...(await importOriginal())` here, inbox-wake.ts
// binds the REAL `listPresence` — the factory still runs (verified), but its override
// never takes effect. Printing the bound function yields the real
// `async function listPresence(opts = {}) { return store.list(opts); }`. Removing
// importOriginal fixes it: 21/21.
//
// ⚠ NOT ESTABLISHED — do NOT generalize this into "importOriginal is unsafe". ~289
// test files in this repo use that idiom successfully, and EI-17276 explicitly
// RECOMMENDS it (new exports pass through automatically). So there is an additional
// condition specific to this module pair that was NOT isolated; a cycle through
// presence.ts's imports (identity / control-anchor / machine-capability-tags) was
// checked and is NOT it. If you touch this, re-measure rather than trusting a rule.
//
// The failure it produced: the real one calls `store.list()` →
// getOrgPg() → assertRealPgAllowed [EI-19311807188719573], which THROWS. That throw
// lands in reportIdleRecipients' fail-soft roster catch (inbox-wake.ts), degrading
// the probe to EMPTY_IDLE_REPORT — so `notWoken` comes back undefined and the P-001
// idle-report test below fails while every negative sibling passes vacuously.
//
// It presents as "the mock silently doesn't work", with NO error surfaced — and
// the reason is worth knowing, because it is NOT that warns are unreliable here.
// setup-fail-on-console.ts sets shouldFailOnWarn:true, so a warn normally FAILS
// the test loudly; only allowlisted texts are silenced, and console-noise-filter.ts
// silences exactly "A UNIT test tried to open a REAL Postgres connection" — grep that
// string, not a line number: this comment used to cite :75 and inbox-wake.ts:431, and
// the latter had already moved to :629. The fail-soft roster catch in
// reportIdleRecipients (inbox-wake.ts, grep "idle-probe roster read failed")
// interpolates ${e.message} into its own warn, so it INHERITS that silence by
// substring match — a fail-soft handler silencing its own wrapper log. (WI-7411)
//
// TO DEBUG THIS PATH, grep the run's stdout for "[silenced-console-census]"
// (EI-19417655142979569). The census counts every suppressed rail message per file
// AND quotes up to 3 DISTINCT wrapper texts, so the very line that named this catch
// is now printed rather than swallowed — the count alone would tell you the rail
// fired but not which of several fail-soft paths degraded. process._rawDebug()
// remains the fallback for a message the allowlist does not bucket: vitest cannot
// intercept it.
vi.mock('../presence', async () => ({
  // Consumed by presence-wakeability.ts via fleet-roster. Re-sourced from the
  // DEFINING package rather than hand-copied, so it cannot drift from the real
  // value (it is 10 * 60 * 1000, not the 90s one might assume).
  PRESENCE_STALE_MS: (await import('@papercusp/coordination/presence')).PRESENCE_STALE_MS,
  listPresence: () => listPresence(),
  /* Consumed by the liveness-oracle cross-check that reportIdleRecipients runs
     (inbox-wake.ts) — NOT by this file directly, which is why a full-replacement
     mock strands the moment that path grows a new import from '../presence'.
     Omitting it made the oracle THROW, and the fail-soft catch's console.warn
     then failed the test via vitest-fail-on-console: four cases red for a
     missing mock export rather than anything they assert (EI-19948371369670710).

     `null` is FAITHFUL, not a fudge: the real probe returns null ("inconclusive")
     for any record without a pid on the local host, and these fixtures are
     synthetic presence rows with no real pid — so null is what the real function
     would answer here. Returning true/false would invent liveness the oracle
     then acts on. */
  probeProcessLiveness: () => null,
  /* DERIVED from the same fixture list rather than a second hand-written one, so
     the single-record getter can never disagree with listPresence() about who
     exists — a divergence the oracle would read as real state. */
  getPresence: async (ownerId: string) =>
    (await listPresence()).find((r) => r.ownerId === ownerId) ?? null,
}));
vi.mock('../../../events/await/handle', () => ({
  captureWakeHandleForOwner: () => captureWakeHandleForOwner(),
}));
vi.mock('../../../events/await/wake-reachability', () => ({
  probeWakeReachability: (ownerId: string) => probeWakeReachability(ownerId),
}));
// coord:message-agent opens a PG-backed conversation before the wake half — stub
// just that one un-caught await so the unit test exercises the wake path without a
// database. The subscribe + ping steps are already best-effort try/catch in the
// tool (their getOrgPg()/PgEntitySubscriptionStore calls throw → caught → no-op).
vi.mock('../conversations', () => ({
  openConversation: vi.fn(async () => ({
    conversation: { id: 'conv-1' },
    thread_id: 'thread-1',
  })),
}));
// The wake-MODE gate + staging leg also reach live PG, and their failure mode is
// NOT a throw: on a dev box with a reachable org PG, a `manual` resolution (e.g.
// a pot:pause global default, or another suite's wake-mode rows) routes the
// wake into stagePendingWake — which WROTE this suite's synthetic owners into
// the PRODUCTION harness_shared.pending_wakes table (caught live by the
// coord-invariant-monitor as EI-275, 21 debris rows). Unit tests must never
// depend on the box's live wake-mode state: pin mode to `auto` and make staging
// a spy.
vi.mock('../wake-mode', () => ({
  resolveWakeMode: (ownerId: string) => resolveWakeMode(ownerId),
}));
vi.mock('../pending-wakes', () => ({
  stagePendingWake: () => stagePendingWake(),
}));

import coordSend from './send';
import messageAgent from './message-agent';
import awaitInbox from './await-inbox';
import { COORD_INBOX_WAKE_PREFIX, inboxWakeKey, ownerFromInboxWakeKey } from '../inbox-wake';

const ctx = { uiClientId: 'su-self', isSuperuser: true, workspaceId: 'ws' } as never;
const parse = <T>(tool: { args: { parse: (x: unknown) => unknown } }, x: unknown): T =>
  tool.args.parse(x) as T;
const out = (res: unknown) => {
  const r = res as { data?: any; content?: Array<{ text: string }> };
  // Bulk tools return { data: envelope }; non-bulk / guard paths return raw { content }.
  return r.data ?? JSON.parse(r.content![0].text);
};
// coord:send is now bulk (bulk-endpoint-standardization-2026-06-21 P-004): the
// SINGLE form returns the house envelope { ok, results:[…], counts }; the one
// message's per-message fields (wake / notWoken / endTurn / msg_id) live in
// results[0]. (coord:message-agent + coord:await-inbox are NOT bulk — they stay
// flat, asserted via `out`.)
const send1 = (res: unknown) => out(res).results[0];

describe('inboxWakeKey helper', () => {
  it('round-trips an ownerId through the inbox-wake key', () => {
    const k = inboxWakeKey('su-bee-1');
    expect(k).toBe(`${COORD_INBOX_WAKE_PREFIX}su-bee-1`);
    expect(ownerFromInboxWakeKey(k)).toBe('su-bee-1');
    expect(ownerFromInboxWakeKey('lock:grant:x')).toBeNull();
  });
});

describe('coord:send', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    emitAwaitedEvent.mockClear();
    // Reset the no-wake idle-probe seams to their defaults each test (a prior
    // test's mockResolvedValue/mockRejectedValueOnce must not leak): roster of
    // su-bee-1/2/3, zero active watchers.
    listActiveAwaitsForKey.mockReset();
    listActiveAwaitsForKey.mockResolvedValue([]);
    listPresence.mockReset();
    listPresence.mockResolvedValue([
      { ownerId: 'su-bee-1' },
      { ownerId: 'su-bee-2' },
      { ownerId: 'su-bee-3' },
    ]);
    // EI-5957: default every recipient to `auto` (fire) unless a test opts into
    // `manual` (stage); reset the staging spy between tests.
    resolveWakeMode.mockReset();
    resolveWakeMode.mockResolvedValue('auto');
    stagePendingWake.mockClear();
  });
  afterEach(() => resetCoordLog());

  it('default (wake omitted) ENQUEUES the message and fires NO wake (P-040 cheap inject)', async () => {
    const res = await coordSend.handler(parse(coordSend, { to: ['su-bee-1'], summary: 'fyi', expects: 'none' }), ctx);
    const lines = await log.readLines('messages');
    expect(lines).toHaveLength(1); // enqueued to the inbox
    expect(lines[0].to).toEqual(['su-bee-1']);
    expect(emitAwaitedEvent).not.toHaveBeenCalled(); // no wake fired
    expect(send1(res).wake).toBeUndefined();
  });

  it('default path REPORTS an idle recipient (no watcher) as notWoken, without firing a wake (P-001)', async () => {
    // su-bee-1 is in the roster (not federated) with zero active watchers → idle.
    listActiveAwaitsForKey.mockResolvedValue([]);
    const res = await coordSend.handler(parse(coordSend, { to: ['su-bee-1'], summary: 'fyi', expects: 'none' }), ctx);
    // delivery still happened, and STILL no wake was fired (report-only).
    expect(await log.readLines('messages')).toHaveLength(1);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(out(res).ok).toBe(true); // the envelope ran
    const body = send1(res);
    expect(body.ok).toBe(true);
    expect(body.wake).toBeUndefined();
    expect(body.notWoken.idleRecipients).toEqual(['su-bee-1']);
    expect(typeof body.notWoken.note).toBe('string');
  });

  it('default path does NOT report a recipient with a live watcher (P-001)', async () => {
    listActiveAwaitsForKey.mockResolvedValue([{ id: 1 }]); // one active watcher
    const res = await coordSend.handler(parse(coordSend, { to: ['su-bee-1'], summary: 'fyi', expects: 'none' }), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(send1(res).notWoken).toBeUndefined();
  });

  it('default path NEVER reports a federated recipient (not in the local roster) as idle (P-001 invariant c)', async () => {
    // su-remote isn't in the roster → unknown/advisory, never falsely flagged idle.
    const res = await coordSend.handler(parse(coordSend, { to: ['su-remote'], summary: 'fyi', expects: 'none' }), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(send1(res).notWoken).toBeUndefined();
  });

  it('default path DEGRADES (no notWoken, send still ok) on a roster read hiccup (P-001 invariant c)', async () => {
    // The degrade path logs one advisory warn — expected; spy it (the repo fails
    // tests on un-asserted console.warn).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listPresence.mockReset();
    listPresence.mockRejectedValue(new Error('roster down'));
    const res = await coordSend.handler(parse(coordSend, { to: ['su-bee-1'], summary: 'fyi', expects: 'none' }), ctx);
    expect(out(res).ok).toBe(true); // the send succeeding is sacred
    const body = send1(res);
    expect(body.notWoken).toBeUndefined();
    expect(await log.readLines('messages')).toHaveLength(1);
    warn.mockRestore();
  });

  it("wake:'required' path does NOT emit a notWoken idle report (the wake path owns liveness via recipient_absent)", async () => {
    listActiveAwaitsForKey.mockResolvedValue([]);
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: 'required' }),
      ctx,
    );
    expect(send1(res).notWoken).toBeUndefined();
    // the no-wake probe must not run on the wake path
    expect(listActiveAwaitsForKey).not.toHaveBeenCalled();
  });

  it('wake:true ENQUEUES the message AND fires exactly the recipient keys (P-040)', async () => {
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1', 'su-bee-2'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: true }),
      ctx,
    );
    // enqueue half (durable inbox) still happened
    const lines = await log.readLines('messages');
    expect(lines).toHaveLength(1);
    expect(lines[0].to).toEqual(['su-bee-1', 'su-bee-2']);
    // wake half: ONE emit per recipient, each on that recipient's OWN key.
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-1'), inboxWakeKey('su-bee-2')]);
    expect(send1(res).wake).toMatchObject({
      targets: ['su-bee-1', 'su-bee-2'],
      queued: 2,
      // Legacy `woken` mirrors the event-engine queue count; it is not an
      // execution receipt. `pickupConfirmed` carries that distinction.
      woken: 2,
      pickupConfirmed: false,
    });
  });

  it('NEVER fires a broadcast key — "*" and "human" are not wakeable (P-042)', async () => {
    await coordSend.handler(
      parse(coordSend, { to: ['*', 'human', 'su-bee-3'], summary: 'mixed', expects: 'none', wake: true }),
      ctx,
    );
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    // only the concrete agent is queued for a wake; '*'/'human' are skipped
    expect(keys).toEqual([inboxWakeKey('su-bee-3')]);
    expect(keys).not.toContain('*');
    expect(keys.some((k) => k.includes('*'))).toBe(false);
  });

  it('a send to ONLY "*" fires no wake at all (P-042 — no thunder-herd)', async () => {
    const res = await coordSend.handler(
      parse(coordSend, { to: ['*'], summary: 'broadcast', expects: 'none', wake: true }),
      ctx,
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(send1(res).wake).toMatchObject({ targets: [], queued: 0, woken: 0, pickupConfirmed: false });
    // No live targets ⇒ NOT a wake-into-the-void: the warning is gated on
    // targets.length > 0 (a broadcast that wakes no one is by design, not a gap).
    expect(send1(res).wake.warning).toBeUndefined();
    // the broadcast message is still in the inbox (delivery is unaffected)
    expect(await log.readLines('messages')).toHaveLength(1);
  });

  it("wake:'required' to a live target that wakes NO ONE returns recipient_absent — the loud miss (directed-wake-honesty P-002)", async () => {
    // The addressee is a concrete agent (a real target), but nothing is
    // listening on its inbox-wake key — emitAwaitedEvent resolves woken:0. The
    // old behavior was a silent woken:0 warning; D-002 makes a REQUIRED wake that
    // lands nowhere a loud recipient_absent the caller can react to.
    emitAwaitedEvent.mockResolvedValueOnce({
      ok: true as const,
      key: inboxWakeKey('su-bee-1'),
      woken: 0,
      notified: [] as string[],
      msgId: null,
    });
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: 'required' }),
      ctx,
    );
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-1')]);
    const { wake } = send1(res);
    expect(wake.mode).toBe('required');
    expect(wake.targets).toEqual(['su-bee-1']);
    expect(wake.queued).toBe(0);
    expect(wake.woken).toBe(0);
    expect(wake.recipient_absent).toBe(true);
    expect(typeof wake.note).toBe('string');
    // P-004: durability is unchanged — recipient_absent alters only the signal,
    // never delivery; the message is still in the durable inbox.
    expect(await log.readLines('messages')).toHaveLength(1);
  });

  it('EI-202273: a stalled direct wake returns delivery UNKNOWN before the transport timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      emitAwaitedEvent.mockImplementationOnce(() => new Promise(() => {}));
      const pending = coordSend.handler(
        parse(coordSend, { to: ['su-bee-1'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: 'required' }),
        ctx,
      );
      await vi.advanceTimersByTimeAsync(COORD_WAKE_TARGET_TIMEOUT_MS + 1);
      const res = await pending;
      const { wake } = send1(res);
      expect(wake).toMatchObject({
        mode: 'required',
        targets: ['su-bee-1'],
        queued: 0,
        woken: 0,
        wakeOutcome: 'unknown',
        timedOutTargets: ['su-bee-1'],
      });
      expect(wake.recipient_absent).toBeUndefined();
      expect(wake.note).toMatch(/delivery is UNKNOWN/i);
      // The timeout only degrades the wake signal; the inbox message remains durable.
      expect(await log.readLines('messages')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });

  it("legacy wake:true coerces to 'required' — a clean miss is still recipient_absent (P-003 transition)", async () => {
    emitAwaitedEvent.mockResolvedValueOnce({
      ok: true as const,
      key: inboxWakeKey('su-bee-1'),
      woken: 0,
      notified: [] as string[],
      msgId: null,
    });
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: true }),
      ctx,
    );
    const { wake } = send1(res);
    expect(wake.mode).toBe('required');
    expect(wake.recipient_absent).toBe(true);
  });

  it("wake:'optimistic' that wakes NO ONE is SILENT — best-effort over a durable backstop (P-002)", async () => {
    emitAwaitedEvent.mockResolvedValueOnce({
      ok: true as const,
      key: inboxWakeKey('su-bee-1'),
      woken: 0,
      notified: [] as string[],
      msgId: null,
    });
    const res = await coordSend.handler(
      // Backstop declared → optimistic miss is SILENT (no recipient_absent).
      // Without a backstop the code now reports the miss loudly (recipient_absent:true).
      parse(coordSend, { to: ['su-bee-1'], summary: 'fyi', expects: 'none', wake: 'optimistic', backstop: 'test delivery sweep re-dispatches' }),
      ctx,
    );
    const { wake } = send1(res);
    expect(wake.mode).toBe('optimistic');
    expect(wake.woken).toBe(0);
    expect(wake.recipient_absent).toBeUndefined(); // a miss over a declared backstop is not loud
    expect(await log.readLines('messages')).toHaveLength(1);
  });

  it("wake:'required' that QUEUES a delivery returns NO recipient_absent (queued>0 control)", async () => {
    // default mock returns woken:1 per emit (the event-engine queue count) → two targets ⇒ queued:2.
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1', 'su-bee-2'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: 'required' }),
      ctx,
    );
    const { wake } = send1(res);
    expect(wake).toMatchObject({
      mode: 'required',
      targets: ['su-bee-1', 'su-bee-2'],
      queued: 2,
      woken: 2,
      pickupConfirmed: false,
      wakeOutcome: 'queued',
    });
    expect(wake.recipient_absent).toBeUndefined();
  });

  it('EI-5957: wake to a MANUAL-mode target STAGES with a LOUD note (not a quiet staged:1)', async () => {
    // su-bee-1 is in manual wake-mode (the hive pause/edit gate) → the leader's
    // wake STAGES instead of firing. The bug: this returned a quiet `staged:1`
    // that read like success, so a fleet leader assumed delivery while the member
    // never got the directive. The fix surfaces it LOUDLY.
    resolveWakeMode.mockResolvedValue('manual');
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1'], summary: 'stand down', expects: 'action', ...ACTION_BODY, wake: 'required' }),
      ctx,
    );
    // it STAGED, not fired: no wake emitted, the pending-wake was recorded
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    const { wake } = send1(res);
    expect(wake.queued).toBe(0);
    expect(wake.woken).toBe(0);
    expect(wake.staged).toBe(1);
    expect(wake.stagedTargets).toEqual(['su-bee-1']); // names WHO didn't get it
    // the LOUD signal — a note (not a bare staged:1) explaining STAGED + the remedy
    expect(typeof wake.note).toBe('string');
    expect(wake.note).toMatch(/STAGED/);
    expect(wake.note).toMatch(/manual wake-mode/i);
    expect(wake.note).toMatch(/wake-queue|wake-mode/);
    // staged is a DISTINCT outcome from a "missed" wake — recipient_absent stays unset
    expect(wake.recipient_absent).toBeUndefined();
    // delivery (durable inbox) is unchanged — only the signal is louder
    expect(await log.readLines('messages')).toHaveLength(1);
  });

  it('EI-5957: a MIXED batch (one auto, one manual) fires the auto wake AND stages+warns the manual one', async () => {
    // su-bee-1 auto (fires), su-bee-2 manual (stages). The auto path is untouched;
    // the staged one is named + warned even though a peer was woken.
    resolveWakeMode.mockImplementation(async (ownerId: string) =>
      ownerId === 'su-bee-2' ? 'manual' : 'auto',
    );
    const res = await coordSend.handler(
      parse(coordSend, { to: ['su-bee-1', 'su-bee-2'], summary: 'go', expects: 'action', ...ACTION_BODY, wake: 'required' }),
      ctx,
    );
    // only the auto target's key fired
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-bee-1')]);
    expect(stagePendingWake).toHaveBeenCalledTimes(1);
    const { wake } = send1(res);
    expect(wake.queued).toBe(1); // the auto peer's durable wake delivery was queued
    expect(wake.woken).toBe(1); // legacy alias for queued; no execution receipt exists yet
    expect(wake.staged).toBe(1);
    expect(wake.stagedTargets).toEqual(['su-bee-2']);
    expect(wake.note).toMatch(/STAGED/);
    expect(wake.recipient_absent).toBeUndefined(); // queued>0 ⇒ not a missed wake
  });

  it("broadcast-only with wake:'required' is EXEMPT from recipient_absent (P-005 — '*' was never wakeable)", async () => {
    const res = await coordSend.handler(
      parse(coordSend, { to: ['*'], summary: 'b', expects: 'none', wake: 'required' }),
      ctx,
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
    const { wake } = send1(res);
    expect(wake.targets).toEqual([]);
    expect(wake.recipient_absent).toBeUndefined();
  });
});

describe('coord:message-agent', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
    emitAwaitedEvent.mockClear();
  });
  afterEach(() => resetCoordLog());

  it('wake:true wakes exactly the single named owner (P-040/P-042)', async () => {
    // openConversation/subscribe touch PG; they best-effort try/catch, so the
    // tool still returns and the wake half (our assertion target) runs.
    const res = await messageAgent.handler(
      parse(messageAgent, { to: 'su-owner', body: 'pick this up', wake: true }),
      ctx,
    );
    const keys = emitAwaitedEvent.mock.calls.map((c) => c[0].key);
    expect(keys).toEqual([inboxWakeKey('su-owner')]);
    // message-agent is multi-recipient (P-003 unification): `to` is always the
    // resolved addressee ARRAY — a single `to:'su-owner'` comes back as ['su-owner'].
    expect(out(res).to).toEqual(['su-owner']);
  }, 15_000);

  it('without wake, fires no wake key', async () => {
    await messageAgent.handler(parse(messageAgent, { to: 'su-owner', body: 'fyi' }), ctx);
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  }, 15_000);
});

describe('coord:await-inbox (D-005 idle annotation and live reachability evidence)', () => {
  beforeEach(() => {
    upsertInboxWakeAwait.mockClear();
    startAwaitSweeper.mockClear();
    probeWakeReachability.mockReset();
    probeWakeReachability.mockResolvedValue(reachableVerdict);
  });

  it('refreshes the STANDING wake watch on the caller\'s OWN inbox-wake key (via the always-arm upsert)', async () => {
    const res = await awaitInbox.handler(parse(awaitInbox, { note: 'drained' }), ctx);
    expect(startAwaitSweeper).toHaveBeenCalled();
    // D-005: routes through armInboxWake → upsertInboxWakeAwait (the idempotent
    // standing-row upsert), NOT the old registerAwait insert.
    expect(upsertInboxWakeAwait).toHaveBeenCalledTimes(1);
    const input = upsertInboxWakeAwait.mock.calls[0][0];
    expect(input.eventKey).toBe(inboxWakeKey('su-self')); // own key — the rendezvous
    expect(input.minSleepSec).toBeGreaterThan(0); // floored against burst sends
    const body = out(res);
    expect(body.ok).toBe(true);
    expect(body.inbox_wake_key).toBe(inboxWakeKey('su-self'));
    expect(body.watch).toMatchObject({ wake: true, once: false }); // standing — survives idle→woken→idle
    expect(probeWakeReachability).toHaveBeenCalledTimes(2);
    expect(body.reachability).toMatchObject({
      before: { reachable: true, channel: 'psu-socket' },
      after: { reachable: true, channel: 'psu-socket' },
    });
    expect(body.advice).toContain('already wake-reachable');
  });

  it('reports when the refresh repairs a missing standing await', async () => {
    probeWakeReachability
      .mockResolvedValueOnce({
        reachable: false,
        channel: 'none' as const,
        durableWhileAlive: false,
        summary: 'no standing coord:inbox-wake await',
        awaitRepairable: true,
        wouldBeChannel: 'psu-socket' as const,
      })
      .mockResolvedValueOnce(reachableVerdict);

    const body = out(await awaitInbox.handler(parse(awaitInbox, { note: 'drained' }), ctx));

    expect(body.reachability).toMatchObject({
      before: { reachable: false, channel: 'none', awaitRepairable: true },
      after: { reachable: true, channel: 'psu-socket' },
    });
    expect(body.advice).toContain('You were unarmed before this call');
    expect(body.advice).toContain('now wake-reachable via psu-socket');
  });

  it('honours an explicit min_sleep_sec floor', async () => {
    await awaitInbox.handler(parse(awaitInbox, { min_sleep_sec: 5 }), ctx);
    expect(upsertInboxWakeAwait.mock.calls[0][0].minSleepSec).toBe(5);
  });
});
