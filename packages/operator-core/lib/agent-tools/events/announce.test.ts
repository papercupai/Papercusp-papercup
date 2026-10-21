/**
 * announce.test.ts — ANNOUNCED gate events (EI-9270,
 * fleet-member-native-guidance-2026-07-10 P-010).
 *
 * Covers the three seams the feature adds:
 *  1. the pure key/scope helpers (announce-key.ts) — auto-prefixing + visibility;
 *  2. events:emit { announce:true } — declares (registerAnnouncement) and does NOT
 *     fire (emitAwaitedEvent never called); scope defaults from presence;
 *  3. events:await — the registration-time LATCH: a fired announcement returns
 *     already_fired (no await registered); an unfired one annotates the response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertMockCoversImports } from '../../testing/mock-import-coverage';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-leader', ownerLabel: 'l', source: 'static-client', workspaceId: 'ws-x', userId: null }),
  deriveAgentRole: () => 'su',
}));
vi.mock('../../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(),
  startAwaitSweeper: vi.fn(),
}));
vi.mock('../coordination/messages', () => ({
  sendMessage: vi.fn(async () => ({ msg_id: 'fed-1', to: [], ts: 't' })),
}));
vi.mock('../coordination/federation-scope', () => ({
  resolveWorkspaceHiveScope: vi.fn(async () => ({ kind: 'none' })),
}));
vi.mock('../coordination/presence', () => ({
  getPresence: vi.fn(async () => ({ fleetSlug: 'p2p-git', currentPlanSlug: 'plan-x' })),
  // presence-wakeability.ts (pulled in transitively via fleet/assignments.ts,
  // which await.ts's import chain reaches) reads this constant at module
  // load time — an incomplete manual mock throws "No PRESENCE_STALE_MS
  // export" the instant that chain is evaluated (EI-17276). Real value:
  // libs/generic/pubsub-substrate/src/presence/types.ts.
  PRESENCE_STALE_MS: 10 * 60 * 1000,
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async () => ({ handle: null, note: 'no-handle' })),
}));
// EI-17140: events:await's orphan-key guard (a non-pattern, non-announced-gate
// registration) reads the INSTALLED tier via a real plugin-host warm-up +
// on-disk manifest scan when this module isn't mocked — genuinely slow I/O
// that `withBoundedTimeout` (1500ms) legitimately degrades under fleet load,
// logging a console.warn that trips vitest-fail-on-console (flaky, load-
// sensitive). Mirrors await.test.ts's hermetic mock of the same module so
// this suite never performs real I/O for a seam it isn't testing.
vi.mock('../../events/await/installed-events', () => ({
  readInstalledUnitEvents: vi.fn(async () => []),
}));
// WI-6554700010018245: events:emit validates the payload against saved event
// types (validateSavedEventPayload) before firing, and that reads
// harness_shared.event_key_registry through the real org-admin pool by
// default. Without this mock every emit case that reaches it opens a live
// Postgres connection, which the unit-test DB guard (EI-19311807188719573)
// refuses. Same hermetic double as emit.test.ts.
vi.mock('../../events/saved-event-type', () => ({
  saveEventType: vi.fn(async () => ({ eventKey: 'saved' })),
  validateSavedEventPayload: vi.fn(async () => undefined),
}));
vi.mock('../../events/await/store', () => ({
  FLEET_BENCH_NOTE_PREFIX: '[fleet:bench] ',
  registerAnnouncement: vi.fn(async (input: { eventKey: string; expectedCondition?: unknown; logicalGateKey?: string | null }) => ({
    id: 1,
    eventKey: input.eventKey,
    expiresTs: null,
    firedAt: null,
    firedReason: null,
    note: null,
    subscriberId: 'su-leader',
    causalGeneration: 4,
    expectedCondition: input.expectedCondition ?? null,
    logicalGateKey: input.logicalGateKey ?? null,
  })),
  countActiveAwaitsByPrefixes: vi.fn(async (prefixes: string[]) => new Map(prefixes.map((p) => [p, 3]))),
  registerAwait: vi.fn(async (input: { eventKey: string }) => ({
    id: 9,
    eventKey: input.eventKey,
    expiresTs: 'later',
    timeoutBehavior: 'wake',
  })),
  findAnnouncementsForKey: vi.fn(async () => []),
  findNearMissKeys: vi.fn(async () => []),
  // EI-18676056143796303: the orphan-key guard's fire-latch cross-check — mocked as a
  // genuine "no evidence" answer (fires:0) so `unknownEventKey` behaves exactly as it did
  // before this cross-check existed (this suite asserts nothing about it either way).
  probeKeyFireEvidence: vi.fn(async (eventKey: string) => ({
    prefix: eventKey,
    exact: false,
    distinctKeys: 0,
    fires: 0,
    lastFiredAt: null,
  })),
  // EI-19332682533219755: a PATTERN registration discloses which concrete keys its
  // glob really covers. Defaults to "no observed keys" ⇒ no advisory, so every
  // pre-existing pattern test below is unaffected (mirrors await.test.ts).
  probePatternMatchScope: vi.fn(async () => ({ prefix: '', matchedKeys: [], truncated: false })),
  // await.ts imports this on the announced-gate cancel path. It was absent from this
  // factory too — latent, because no test here had walked that branch yet. The
  // coverage guard at the bottom of this file is what surfaced it.
  cancelAwaitsForSubscribersOnKeys: vi.fn(async () => 0),
  cancelAwait: vi.fn(async () => true),
  // Same class again: fd4bbd8766 (2026-08-27T09:06Z) added this import to await.ts
  // beside the monitor dedup gate mocked below. That commit updated await.test.ts
  // (both mocks) but not this file. Mirrors await.test.ts:56 — "no live exact await",
  // so the dedup gate never suppresses and every assertion here is unaffected.
  hasLiveExactAwaitForSubscriberKey: vi.fn(async () => false),
}));
// fd4bbd8766 also put a REAL-PG read on awaitTool.handler's registration path
// (hasActiveMonitorForOwnerPredicate -> boundedPgReadTxn -> getOrgPg). Left unmocked it
// trips the unit-test live-Postgres guard [EI-19311807188719573] for every test here
// that registers an await against a live announcement. Spread-the-original mirrors
// await.test.ts:58-61 so the pure helpers (normalizeMonitorPredicateKey,
// monitorPredicateDedupRefusal) keep their real implementations.
vi.mock('../../harness/routines/monitor-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/routines/monitor-policy')>()),
  hasActiveMonitorForOwnerPredicate: vi.fn(async () => false),
}));

import emit from './emit';
import awaitTool from './await';
import { getPresence } from '../coordination/presence';
import { buildAnnouncedKey, defaultAnnounceScope, announcementVisibleTo, normalizeEventKey } from '../../events/await/announce-key';
import { emitAwaitedEvent } from '../../events/await/engine';
import { registerAnnouncement, registerAwait, findAnnouncementsForKey, findNearMissKeys } from '../../events/await/store';
// Namespace view of the SAME mocked module — the coverage guard at the bottom of
// this file checks its key set against production's import list.
import * as storeMock from '../../events/await/store';

const emitHandler = (emit as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler;
const awaitHandler = (awaitTool as unknown as { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler;
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('announce-key (pure)', () => {
  it('prefixes a scoped gate and is idempotent', () => {
    expect(buildAnnouncedKey('phase3-open', { kind: 'fleet', ref: 'p2p-git' })).toBe('fleet:p2p-git:phase3-open');
    expect(buildAnnouncedKey('fleet:p2p-git:phase3-open', { kind: 'fleet', ref: 'p2p-git' })).toBe('fleet:p2p-git:phase3-open');
  });
  it('passes a global gate through unprefixed', () => {
    expect(buildAnnouncedKey('release-window-open', { kind: 'global', ref: null })).toBe('release-window-open');
  });
  it('throws on a scoped gate with no ref', () => {
    expect(() => buildAnnouncedKey('g', { kind: 'fleet', ref: null })).toThrow(/requires a ref/);
  });
  it('defaults scope to the narrowest context: fleet → plan → global', () => {
    expect(defaultAnnounceScope({ fleetSlug: 'f1', planSlug: 'p1' })).toEqual({ kind: 'fleet', ref: 'f1' });
    expect(defaultAnnounceScope({ fleetSlug: null, planSlug: 'p1' })).toEqual({ kind: 'plan', ref: 'p1' });
    expect(defaultAnnounceScope({})).toEqual({ kind: 'global', ref: null });
  });
  it('visibility: global to everyone; scoped only to the matching context', () => {
    expect(announcementVisibleTo({ scopeKind: 'global', scopeRef: null }, {})).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'fleet', scopeRef: 'f1' }, { fleetSlug: 'f1' })).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'fleet', scopeRef: 'f1' }, { fleetSlug: 'f2' })).toBe(false);
    expect(announcementVisibleTo({ scopeKind: 'plan', scopeRef: 'p1' }, { planSlug: 'p1' })).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'harness', scopeRef: 'h1' }, { harnessSlug: 'h1' })).toBe(true);
    expect(announcementVisibleTo({ scopeKind: 'harness', scopeRef: 'h1' }, {})).toBe(false);
  });
});

describe('events:emit { announce: true }', () => {
  it('declares (registerAnnouncement) with the fleet-prefixed key and does NOT fire', async () => {
    const out = parse(await emitHandler({ event: 'phase3-open', announce: true, summary: 'opens on verified green' }, {}));
    expect(out.announced).toBe(true);
    expect(out.event).toBe('fleet:p2p-git:phase3-open'); // presence fleet default + auto-prefix
    expect(out.scope).toEqual({ kind: 'fleet', ref: 'p2p-git' });
    expect(out.live_awaiters).toBe(3);
    expect(out.generation).toBe(4);
    expect(registerAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'fleet:p2p-git:phase3-open',
        scopeKind: 'fleet',
        scopeRef: 'p2p-git',
        note: 'opens on verified green',
        boundTo: { kind: 'fleet-leadership', ref: 'p2p-git' },
      }),
    );
    expect(emitAwaitedEvent).not.toHaveBeenCalled();
  });
  it('requires an explicit ref when presence lacks the selected fleet', async () => {
    vi.mocked(getPresence).mockResolvedValueOnce({ currentPlanSlug: null } as Awaited<ReturnType<typeof getPresence>>);
    await expect(emitHandler({
      event: 'unscoped-fleet-gate',
      announce: true,
      announceScope: 'fleet',
    }, {})).rejects.toThrow(/needs a slug.*presence carries no fleet/);

    const explicit = parse(await emitHandler({
      event: 'explicit-fleet-gate',
      announce: true,
      announceScope: 'fleet',
      announceScopeRef: 'named-fleet',
    }, {}));
    expect(explicit.scope).toEqual({ kind: 'fleet', ref: 'named-fleet' });
  });
  it('documents when announceScopeRef can default from presence', () => {
    const description = emit.args.shape.announceScopeRef.description ?? '';
    expect(description).toContain('matching fleet or plan slug');
    expect(description).toContain('when available');
    expect(description).toContain('harness scope always requires an explicit slug');
  });
  it('honors an explicit global scope (no prefix)', async () => {
    const out = parse(await emitHandler({ event: 'migration-freeze-lifted', announce: true, announceScope: 'global' }, {}));
    expect(out.event).toBe('migration-freeze-lifted');
    expect(out.scope).toEqual({ kind: 'global', ref: null });
  });
  it('persists one expected SHA on the causal declaration generation', async () => {
    const out = parse(await emitHandler({
      event: 'deployed',
      announce: true,
      announceScope: 'global',
      expected_sha: 'ABCDEF1',
    }, {}));
    expect(registerAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      expectedCondition: { kind: 'sha', sha: 'abcdef1' },
    }));
    expect(out).toMatchObject({ generation: 4, expected: { kind: 'sha', sha: 'abcdef1' } });
  });
  it('persists and returns a logical gate identity', async () => {
    const out = parse(await emitHandler({
      event: 'deployed',
      announce: true,
      announceScope: 'global',
      logical_gate: 'release-route',
    }, {}));
    expect(registerAnnouncement).toHaveBeenCalledWith(expect.objectContaining({
      logicalGateKey: 'release-route',
    }));
    expect(out.logical_gate).toBe('release-route');
  });
  it('rejects a logical gate identity on a fire rather than a declaration', async () => {
    await expect(emitHandler({ event: 'deployed', logical_gate: 'release-route' }, {})).rejects.toThrow(/logical_gate.*announce:true/);
  });
  it('rejects two expected-condition forms on one declaration', async () => {
    await expect(emitHandler({
      event: 'deployed',
      announce: true,
      expected_sha: 'abcdef1',
      expected_predicate: { sha: { eq: 'abcdef1' } },
    }, {})).rejects.toThrow(/only one expected condition/);
  });
  it('rejects announce + to (a declaration wakes no one)', async () => {
    await expect(emitHandler({ event: 'g', announce: true, to: ['su-x'] }, {})).rejects.toThrow(/`to` is not allowed/);
  });
});

describe('events:await — the announced-gate latch', () => {
  it('returns already_fired for a latched gate and registers NO await', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: '2026-07-10T00:00:00Z', firedReason: 'event', note: 'gate opened', subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.already_fired).toBe(true);
    expect(out.fired_at).toBe('2026-07-10T00:00:00Z');
    expect(registerAwait).not.toHaveBeenCalled();
  });
  it('a LAPSED declaration (fired_reason=expired) is NOT a latch — the await registers', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: '2026-07-09T00:00:00Z', firedReason: 'expired', note: null, subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.already_fired).toBeUndefined();
    expect(out.await_id).toBe(9);
    expect(registerAwait).toHaveBeenCalled();
  });
  it('annotates the registration when the gate is declared but unfired', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: null, firedReason: null, note: 'opens on verified green', subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.await_id).toBe(9);
    expect(out.announced_gate).toEqual({
      note: 'opens on verified green',
      announcedBy: 'su-leader',
      generation: null,
      expected: null,
    });
  });
  it('skips the latch read for pattern awaits', async () => {
    const out = parse(await awaitHandler({ event: 'work-item:done:*' }, {}));
    expect(findAnnouncementsForKey).not.toHaveBeenCalled();
    expect(out.pattern).toBe(true);
  });
});

describe('normalizeEventKey (pure) — event-key-nearmiss-guard P-003', () => {
  it('equates separator/case drift', () => {
    const n = normalizeEventKey;
    expect(n('phase-3-ready')).toBe(n('phase3-ready'));
    expect(n('Phase3_Ready')).toBe(n('phase3-ready'));
    expect(n('phase.3.ready')).toBe(n('phase3-ready'));
    expect(n('fleet:p2p-git:phase3-open')).toBe(n('fleet:p2pgit:phase-3-open'));
  });
  it('does not equate genuinely different keys', () => {
    expect(normalizeEventKey('phase4-ready')).not.toBe(normalizeEventKey('phase3-ready'));
  });
});

describe('events:emit — near-miss advisory (P-004)', () => {
  const emitResult = (waiters: number) => ({ key: 'k', woken: 0, notified: [], waiters, msgId: 'm1' });

  it('surfaces near_misses when the emit reached no one', async () => {
    (emitAwaitedEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(emitResult(0));
    (findNearMissKeys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { eventKey: 'fleet:p2p-git:phase3-ready', kind: 'await', holders: 1 },
    ]);
    const out = parse(await emitHandler({ event: 'phase-3-ready' }, {}));
    expect(out.near_misses).toEqual([{ key: 'fleet:p2p-git:phase3-ready', kind: 'await', holders: 1 }]);
    expect(out.advice).toMatch(/near-identical/);
    expect(findNearMissKeys).toHaveBeenCalledWith('phase-3-ready');
  });
  it('does NOT scan when waiters > 0', async () => {
    (emitAwaitedEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(emitResult(2));
    const out = parse(await emitHandler({ event: 'phase-3-ready' }, {}));
    expect(out.near_misses).toBeUndefined();
    expect(findNearMissKeys).not.toHaveBeenCalled();
  });
  it('does NOT scan when a `to` audience was named', async () => {
    (emitAwaitedEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(emitResult(0));
    const out = parse(await emitHandler({ event: 'phase-3-ready', to: ['su-x'] }, {}));
    expect(out.near_misses).toBeUndefined();
    expect(findNearMissKeys).not.toHaveBeenCalled();
  });
  it('does NOT scan on the announce path', async () => {
    await emitHandler({ event: 'g', announce: true }, {});
    expect(findNearMissKeys).not.toHaveBeenCalled();
  });
  it('fail-soft: a scan error changes nothing', async () => {
    (emitAwaitedEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(emitResult(0));
    (findNearMissKeys as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pg down'));
    const out = parse(await emitHandler({ event: 'phase-3-ready' }, {}));
    expect(out.ok).toBe(true);
    expect(out.near_misses).toBeUndefined();
  });
});

describe('events:await — near-miss advisory (P-005)', () => {
  it('annotates the registration when only a near-identical key is active', async () => {
    (findNearMissKeys as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { eventKey: 'fleet:p2p-git:phase3-open', kind: 'announce', holders: 1 },
    ]);
    const out = parse(await awaitHandler({ event: 'phase3open' }, {}));
    expect(out.await_id).toBe(9); // registration still proceeds — advisory only
    expect(out.near_miss).toEqual([{ key: 'fleet:p2p-git:phase3-open', kind: 'announce', holders: 1 }]);
    expect(out.near_miss_advice).toMatch(/events:cancel/);
    expect(findNearMissKeys).toHaveBeenCalledWith('phase3open', { excludeOwner: 'su-leader' });
  });
  it('does NOT scan when an exact announcement matches', async () => {
    (findAnnouncementsForKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { firedAt: null, firedReason: null, note: 'n', subscriberId: 'su-leader' },
    ]);
    const out = parse(await awaitHandler({ event: 'fleet:p2p-git:phase3-open' }, {}));
    expect(out.announced_gate).toBeTruthy();
    expect(findNearMissKeys).not.toHaveBeenCalled();
  });
  it('skips the scan for pattern awaits', async () => {
    await awaitHandler({ event: 'work-item:done:*' }, {});
    expect(findNearMissKeys).not.toHaveBeenCalled();
  });
});

// ─── mock-coverage recurrence guard (EI-19360393379790366) ────────────────────
// This suite drives the REAL await.ts / emit.ts handlers against a hand-written
// PARTIAL mock of events/await/store (partial on purpose — the real module pulls
// db-org, so a full importOriginal spread would cost this suite its hermeticity).
// The cost of that choice is that every time production adds a store import, the
// factory silently goes stale and the suite reds with "No <x> export is defined on
// the mock" — and only if some test happens to walk the new branch. That has now
// happened three times (EI-17276 PRESENCE_STALE_MS, EI-18676056143796303
// probeKeyFireEvidence, EI-19332682533219755 probePatternMatchScope), each caught
// downstream rather than here; cancelAwaitsForSubscribersOnKeys was missing too and
// had NOT yet been hit by any test.
//
// This asserts the factory covers the import list STATICALLY, so the next addition
// fails right here, naming the missing export, instead of as an opaque mock error
// in whichever unrelated test first walks that code path.
//
// The mechanism is shared (testing/mock-import-coverage.ts) because this suite is not
// the only one making the promise: await.test.ts and compose-toolsurface.test.ts drive
// the same handler through their own partial factories.
describe('events/await/store mock coverage', () => {
  it('mocks every store export the handlers under test import', () => {
    assertMockCoversImports(storeMock, {
      importerUrl: import.meta.url,
      sources: ['./await.ts', './emit.ts'],
      moduleSpecifier: 'events/await/store',
      expectNames: ['probePatternMatchScope'],
    });
  });
});
