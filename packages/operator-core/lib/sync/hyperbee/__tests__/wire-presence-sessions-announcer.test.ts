/**
 * WI-10002534 — the P-005 SESSION-grain announcer must be ONE per (workspace,
 * gossip topic) per process, never one per harness handle or per re-wire.
 *
 * Measured on the P-203 rig (parent WI-10002529): the tower wired 39 harness
 * handles onto ONE gossip topic, and each armed its own sessions announcer over
 * the SAME workspace-wide roster (`listPresence({ workspaceId })`). Every change
 * therefore went out as ~39 duplicate full-set frames, and the receiver — keyed on
 * (workspace, owner, machine) with harness_slug outside the key — rewrote every
 * row once per frame. The same code also leaked one announcer per re-wire of a
 * single handle (the only clear was the handle's close hook).
 *
 * Hermetic: identity, roster, fleet enrichment and the gossip transport are
 * mocked, and every timer goes through the injected setIntervalFn seam, so the
 * test counts exactly the announcers that are live.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastSessions = vi.fn(async () => true);
type TopicRegistration = {
  topicHex: string;
  workspaceId: string;
  potHomeSlug: string;
  writer?: {
    getOwnSessions: () => Promise<Array<{ owner_id: string; harness_slug: string; last_active_ms: number }>>;
  };
};
const registerPresenceGossipTopic = vi.fn(async (_input: TopicRegistration) => true);

vi.mock('../presence-gossip-wiring', () => ({
  registerPresenceGossipTopic: (...a: unknown[]) => registerPresenceGossipTopic(...(a as [TopicRegistration])),
  broadcastPresencePut: async () => true,
  broadcastPresenceDel: async () => true,
  broadcastSessions: (...a: unknown[]) => broadcastSessions(...(a as [])),
}));

vi.mock('../local-announce-identity', () => ({
  resolveLocalAnnounceIdentity: async () => ({
    keychainId: '42:machine',
    devicePubkeyBase64: 'pk',
    githubUserId: 42,
    githubLogin: 'owner',
    attestationGistId: '',
  }),
  resolveLocalAnnounceIdentityFromHiveMembers: async () => null,
}));

vi.mock('../../../federated-pot-scope', () => ({
  listHiveMembersForLocalPot: async () => [],
}));

let roster: Array<{ ownerId: string; intent: string | null; potSlug?: string | null }> = [];
const listPresence = vi.fn(async (_args: { workspaceId: string }) => roster);
vi.mock('../../../agent-tools/coordination/presence', () => ({
  listPresence: (...a: unknown[]) => listPresence(...(a as [{ workspaceId: string }])),
}));

const fetchPresenceFleet = vi.fn(async (_ownerIds: string[]) => new Map());
vi.mock('../../../agent-tools/coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...a: unknown[]) => fetchPresenceFleet(...(a as [string[]])),
}));

import {
  wirePresenceAnnounceForHarness,
  __resetSessionAnnouncersForTests,
  type PresenceWireHandle,
} from '../wire-presence';

const SESSION_TICK_MS = 10_000;
const PRESENCE_TICK_MS = 5_000;

/** A timer seam that records every armed interval so the test can count the live ones. */
function timers() {
  let next = 1;
  const live = new Map<number, { cb: () => void; ms: number }>();
  return {
    setIntervalFn: (cb: () => void, ms: number) => {
      const id = next++;
      live.set(id, { cb, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: (h: ReturnType<typeof setInterval>) => {
      live.delete(h as unknown as number);
    },
    liveSessionAnnouncers: () => [...live.values()].filter((t) => t.ms === SESSION_TICK_MS),
  };
}

function handle(harnessSlug: string, topicHex: string, workspaceId = 'ws') {
  const closeHooks: Array<() => void | Promise<void>> = [];
  const h: PresenceWireHandle = {
    workspaceId,
    harnessSlug,
    ownLog: { keyHex: `log-${harnessSlug}` },
    append: async () => {},
    swarm: { topicHex },
    registerCloseHook: (hook) => {
      closeHooks.push(hook);
      return () => {};
    },
  };
  return {
    h,
    close: async () => {
      for (const hook of closeHooks) await hook();
    },
  };
}

function wire(h: PresenceWireHandle, t: ReturnType<typeof timers>, potSlug = 'pot') {
  return wirePresenceAnnounceForHarness(h, {
    presenceGossip: true,
    intervalMs: PRESENCE_TICK_MS,
    resolvePotSlug: async () => potSlug,
    resolveRunsRoutines: async () => null,
    resolveActiveRoutines: async () => null,
    setIntervalFn: t.setIntervalFn,
    clearIntervalFn: t.clearIntervalFn,
    now: () => clock,
    onError: (err) => tickErrors.push(err),
  });
}

/** The announcers' injected clock (ms); tests advance it to age the roster memo. */
let clock = 1_000_000;

/** A tick swallows its own errors into onError — surface them so a failing tick is loud. */
const tickErrors: unknown[] = [];

/** Fire every live sessions announcer once — one real 10s tick — and let it settle. */
async function tickAll(t: ReturnType<typeof timers>) {
  // One announcer at a time: each tick awaits dynamic imports, so wait for its
  // broadcast before firing the next.
  for (const a of t.liveSessionAnnouncers()) {
    const before = broadcastSessions.mock.calls.length;
    a.cb();
    await vi.waitFor(() => {
      expect(tickErrors.map(String)).toEqual([]);
      expect(broadcastSessions.mock.calls.length).toBe(before + 1);
    });
  }
}

beforeEach(() => {
  broadcastSessions.mockClear();
  registerPresenceGossipTopic.mockClear();
  listPresence.mockClear();
  fetchPresenceFleet.mockClear();
  clock = 1_000_000;
  tickErrors.length = 0;
  roster = [
    { ownerId: 'su-a', intent: 'x', potSlug: 'pot' },
    { ownerId: 'su-b', intent: 'y', potSlug: 'pot' },
  ];
  // Guarded so the same file measures the pre-fix code too (the distinguishing run).
  if (typeof __resetSessionAnnouncersForTests === 'function') __resetSessionAnnouncersForTests();
});

describe('sessions announcer is one per (workspace, topic) — WI-10002534', () => {
  it('re-wiring the SAME handle N times leaves exactly one live announcer', async () => {
    const t = timers();
    const { h } = handle('repo-a', 'topic-1');
    for (let i = 0; i < 5; i++) await wire(h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
  });

  it('N harness handles on ONE topic share one announcer → one frame per tick', async () => {
    const t = timers();
    for (const slug of ['papercusp', 'papercusp/libs/a', 'papercusp/libs/b']) {
      await wire(handle(slug, 'topic-1').h, t);
    }
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
    const [topic, sessions] = broadcastSessions.mock.calls[0] as unknown as [string, unknown[]];
    expect(topic).toBe('topic-1');
    expect(sessions).toHaveLength(2);
  });

  it('harnesses on DIFFERENT topics each keep their own announcer', async () => {
    const t = timers();
    await wire(handle('repo-a', 'topic-1').h, t);
    await wire(handle('repo-b', 'topic-2').h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(2);
    await tickAll(t);
    const topics = broadcastSessions.mock.calls.map((c) => (c as unknown as [string])[0]).sort();
    expect(topics).toEqual(['topic-1', 'topic-2']);
  });

  it('each topic announces only sessions homed in its pot', async () => {
    const t = timers();
    roster = [
      { ownerId: 'su-pot-a', intent: 'a', potSlug: 'pot-a' },
      { ownerId: 'su-pot-b', intent: 'b', potSlug: 'pot-b' },
    ];
    await wire(handle('repo-a', 'topic-a').h, t, 'pot-a');
    await wire(handle('repo-b', 'topic-b').h, t, 'pot-b');

    await tickAll(t);

    const byTopic = new Map(
      broadcastSessions.mock.calls.map((call) => {
        const [topic, sessions] = call as unknown as [string, Array<{ owner_id: string }>];
        return [topic, sessions.map((session) => session.owner_id)] as const;
      }),
    );
    expect([...byTopic.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['topic-a', ['su-pot-a']],
      ['topic-b', ['su-pot-b']],
    ]);
  });

  it('pair-time snapshots use the same pot filter as periodic announcements', async () => {
    const t = timers();
    roster = [
      { ownerId: 'su-pot-a', intent: 'a', potSlug: 'pot-a' },
      { ownerId: 'su-pot-b', intent: 'b', potSlug: 'pot-b' },
    ];
    await wire(handle('repo-a', 'topic-a').h, t, 'pot-a');

    const registration = registerPresenceGossipTopic.mock.calls[0]?.[0];
    expect(registration?.potHomeSlug).toBe('pot-a');
    const sessions = await registration?.writer?.getOwnSessions();
    expect(sessions?.map((session) => session.owner_id)).toEqual(['su-pot-a']);
    expect(sessions?.[0]).toMatchObject({
      harness_slug: 'repo-a',
      last_active_ms: clock,
    });
  });

  it('closing one of two sharing handles keeps announcing; closing the last stops it', async () => {
    const t = timers();
    const a = handle('repo-a', 'topic-1');
    const b = handle('repo-b', 'topic-1');
    await wire(a.h, t);
    await wire(b.h, t);
    await a.close();
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
    await b.close();
    expect(t.liveSessionAnnouncers()).toHaveLength(0);
  });

  it('a harness re-wired after its handle closed announces again (no stale refcount)', async () => {
    const t = timers();
    const a = handle('repo-a', 'topic-1');
    await wire(a.h, t);
    await a.close();
    expect(t.liveSessionAnnouncers()).toHaveLength(0);
    const a2 = handle('repo-a', 'topic-1');
    await wire(a2.h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(1);
  });
});

/**
 * WI-10005271 — announcers on DIFFERENT topics of the SAME workspace must share
 * one roster read per tick. Measured on bg-host 2026-10-02: ~47 topics for one
 * workspace, each announcer calling listPresence itself every 10 s
 * (98 calls / 20 s, 96 of them from tickSessions).
 */
describe('one roster read per workspace per tick — WI-10005271', () => {
  const TOPICS = ['topic-1', 'topic-2', 'topic-3', 'topic-4', 'topic-5', 'topic-6'];

  it('N topics in one workspace: one tick each reads the roster ONCE and broadcasts N frames', async () => {
    const t = timers();
    for (const [i, topic] of TOPICS.entries()) await wire(handle(`repo-${i}`, topic).h, t);
    expect(t.liveSessionAnnouncers()).toHaveLength(TOPICS.length);
    await tickAll(t);
    expect(listPresence).toHaveBeenCalledTimes(1);
    expect(fetchPresenceFleet).toHaveBeenCalledTimes(1);
    expect(broadcastSessions).toHaveBeenCalledTimes(TOPICS.length);
    // Each topic still stamps its OWN label on the shared roster.
    const byTopic = new Map(
      broadcastSessions.mock.calls.map((c) => {
        const [topic, sessions] = c as unknown as [string, Array<{ owner_id: string; harness_slug: string }>];
        return [topic, sessions] as const;
      }),
    );
    expect([...byTopic.keys()].sort()).toEqual([...TOPICS].sort());
    for (const [i, topic] of TOPICS.entries()) {
      const sessions = byTopic.get(topic)!;
      expect(sessions.map((s) => s.owner_id)).toEqual(['su-a', 'su-b']);
      expect(sessions.every((s) => s.harness_slug === `repo-${i}`)).toBe(true);
    }
  });

  it('a later tick past the memo window re-reads the roster and announces the change', async () => {
    const t = timers();
    for (const [i, topic] of TOPICS.entries()) await wire(handle(`repo-${i}`, topic).h, t);
    await tickAll(t);
    expect(listPresence).toHaveBeenCalledTimes(1);
    roster = [...roster, { ownerId: 'su-c', intent: 'z', potSlug: 'pot' }];
    clock += SESSION_TICK_MS;
    await tickAll(t);
    expect(listPresence).toHaveBeenCalledTimes(2);
    const latest = broadcastSessions.mock.calls.slice(-TOPICS.length) as unknown as Array<
      [string, Array<{ owner_id: string }>]
    >;
    for (const [, sessions] of latest) expect(sessions.map((s) => s.owner_id)).toEqual(['su-a', 'su-b', 'su-c']);
  });

  it('a failed roster read is not cached: the next tick retries at the same instant', async () => {
    const t = timers();
    await wire(handle('repo-a', 'topic-1').h, t);
    const [announcer] = t.liveSessionAnnouncers();
    listPresence.mockRejectedValueOnce(new Error('pg down'));
    announcer!.cb();
    await vi.waitFor(() => expect(tickErrors.map(String)).toEqual(['Error: pg down']));
    expect(broadcastSessions).not.toHaveBeenCalled();
    tickErrors.length = 0;
    await tickAll(t);
    expect(listPresence).toHaveBeenCalledTimes(2);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);
  });

  it('a roster is retried on the next tick when the session frame was not sent', async () => {
    const t = timers();
    await wire(handle('repo-a', 'topic-1').h, t);
    broadcastSessions.mockResolvedValueOnce(false);

    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(1);

    clock += SESSION_TICK_MS;
    await tickAll(t);
    expect(broadcastSessions).toHaveBeenCalledTimes(2);
  });

  it('different workspaces never share a roster snapshot', async () => {
    const t = timers();
    await wire(handle('repo-a', 'topic-1', 'ws-1').h, t);
    await wire(handle('repo-b', 'topic-2', 'ws-2').h, t);
    await tickAll(t);
    expect(listPresence.mock.calls.map((c) => c[0].workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
  });
});
