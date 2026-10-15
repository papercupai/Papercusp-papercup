/**
 * bench.test.ts — fleet-reliability-verification-2026-07-10 P-006.
 *
 * projectBenchRows is the PURE reshape (event_awaits rows → the bench
 * roster, bench-tagged rows only) — unit-tested directly (mirrors
 * leader-brief.test.ts's projectMember pattern). The handler is exercised
 * with mocked deps for: stage mode (registers FOR `member`, not the caller;
 * tags the note; reports a bench miss immediately when no wake handle is
 * found) and list mode (resolves the fleet, filters to bench-tagged rows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-leader', ownerLabel: 'l', source: 'static-client', workspaceId: 'ws-x', userId: null }),
  deriveFleetMembership: vi.fn(() => ({ fleetSlug: 'p2p-git' })),
}));
vi.mock('../../agent-fleets-store', () => ({
  // A full vi.mock replaces EVERY runtime export, so the FLEET_TYPES vocabulary has to be
  // carried here: goal-launch-settings builds its fleetType schema from FLEET_TYPES at module
  // scope, so omitting it fails COLLECTION on any newly-connected import path, before a test
  // can run. Pinned by agent-fleets-store.test.ts "full-mock contract".
  FLEET_TYPES: ['single', 'paired'] as const,
  listFleetsLedBy: vi.fn(async () => []),
}));
vi.mock('../coordination/presence-fleet', () => ({
  resolvePresenceFleet: vi.fn(async (_ownerId: string | undefined, launchFallback: { fleetSlug: string | null; fleetRole: string | null }) => launchFallback),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-x',
  resolveConcreteWorkspaceId: (...candidates: Array<string | null | undefined>) => {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() && c.trim() !== '*') return c.trim();
    }
    return 'ws-x';
  },
}));
vi.mock('../../events/await/handle', () => ({
  captureWakeHandleForOwner: vi.fn(async (ownerId: string) =>
    ownerId === 'su-no-session'
      ? { handle: null, note: 'no tracked session for your coord id — the wake degrades to an inbox notification' }
      : { handle: { kind: 'adv-session', advSessionId: 1, agent: 'claude', sessionId: 's', ompThreadId: null, cwd: '/r', pid: 1 }, note: 'resumable' },
  ),
}));
vi.mock('../../events/await/store', () => ({
  registerAwait: vi.fn(async (i: Record<string, unknown>) => ({
    id: 42,
    eventKey: i.eventKey,
    expiresTs: i.timeoutSec == null ? null : '2030-01-01',
    supersededPendingCount: 0,
  })),
  FLEET_BENCH_NOTE_PREFIX: '[fleet:bench] ',
  listParkedAwaitsForSubscribers: vi.fn(async () => []),
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  getClaimSpecRecord: vi.fn(async () => null),
  resolveClaimSpecWorkspace: (workspaceId: string | undefined) => workspaceId,
}));
vi.mock('../../fleet/assignments', () => ({
  listFleetAssignments: vi.fn(async () => [
    { agentId: 'su-worker', fleetSlug: 'p2p-git' },
    { agentId: 'su-no-session', fleetSlug: 'p2p-git' },
  ]),
  groupByAgent: vi.fn((rows: unknown[]) => rows),
}));
// WI-5938: default to a DRAINED lane so every pre-existing stage-mode test keeps
// exercising the bench path it was written for; the refusal tests opt in per-case.
vi.mock('../../fleet/lane-health', () => ({
  readFleetLaneHealth: vi.fn(async () => ({
    claimable: 0,
    matchedByFilter: 0,
    excluded: {},
    spec: {
      ref: 'spec-x (spec rev 3)',
      specId: 'spec-x',
      revision: 3,
      matchedBy: 'fleet-slug',
      harness: 'papercusp',
      assigneeScoped: null,
    },
  })),
}));

import benchTool, { projectBenchRows, benchQueueVerdict } from './bench';
import { registerAwait, listParkedAwaitsForSubscribers } from '../../events/await/store';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import { listFleetAssignments, groupByAgent } from '../../fleet/assignments';
import { deriveFleetMembership } from '../coordination/identity';
import { listFleetsLedBy, type AgentFleetRecord } from '../../agent-fleets-store';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { readFleetLaneHealth } from '../../fleet/lane-health';
import { getClaimSpecRecord } from '../../scheduler/claim-spec-store';
import { withBoundedTimeout } from '../../bounded-timeout';

/** A complete AgentFleetRecord so listFleetsLedBy fixtures typecheck against the real
 *  return type instead of hiding behind `as never` (check-mock-cast-escape). */
const ledFleet = (fleetSlug: string): AgentFleetRecord => ({
  workspaceId: 'ws-x',
  fleetSlug,
  title: null,
  description: null,
  owner: null,
  leaderOwnerId: 'su-leader',
  leaderMissingSinceMs: null,
  colorScheme: null,
  controlState: 'active',
  fleetType: 'single',
  controlReason: null,
  controlBy: null,
  controlAt: null,
  controlResumeGate: null,
  controlExpiresAt: null,
  controlNoResumePath: false,
  lastLaunchTransaction: null,
  createdAt: 0,
  updatedAt: 0,
});

const lane = (claimable: number, matchedByFilter = claimable) => ({
  claimable,
  matchedByFilter,
  excluded: {},
  issueFamily: { claimable, matchedByFilter, excluded: {} },
  featureFamily: null,
  familyReachability: { issue: true, feature: false },
  effective: {
    claimable,
    matchedByFilter,
    excluded: {},
    basis: 'issue-family' as const,
  },
  spec: {
    ref: 'spec-x (spec rev 3)',
    specId: 'spec-x',
    revision: 3,
    matchedBy: 'fleet-slug',
    harness: 'papercusp',
    assigneeScoped: null,
  },
});

const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof benchTool.handler>[1];
const call = async (args: Record<string, unknown>) => {
  const res = (await benchTool.handler(args as never, ctx)) as { data: Record<string, unknown> };
  return res.data;
};

beforeEach(() => vi.clearAllMocks());

describe('projectBenchRows (pure)', () => {
  const NOW = '2026-07-10T12:00:00.000Z';

  it('keeps only bench-tagged rows and restores the staged assignment from the note', () => {
    const rows = [
      { subscriberId: 'su-a', eventKey: 'k1', note: '[fleet:bench] flip TEST hive bridged', expiresTs: null, createdAt: NOW },
      { subscriberId: 'su-b', eventKey: 'k2', note: 'unrelated events:await note', expiresTs: null, createdAt: NOW },
      { subscriberId: 'su-c', eventKey: 'k3', note: null, expiresTs: null, createdAt: NOW },
    ];
    const out = projectBenchRows(rows);
    expect(out).toEqual([
      { member: 'su-a', event: 'k1', stagedAssignment: 'flip TEST hive bridged', benchedAt: NOW, expiresTs: null },
    ]);
  });

  it('a bench-tagged row with an empty staged assignment maps to null, never an empty string', () => {
    const rows = [{ subscriberId: 'su-a', eventKey: 'k1', note: '[fleet:bench] ', expiresTs: null, createdAt: NOW }];
    expect(projectBenchRows(rows)[0].stagedAssignment).toBeNull();
  });

  it('empty input → empty output', () => {
    expect(projectBenchRows([])).toEqual([]);
  });
});

describe('resolveBenchFleetTarget — durable leadership and presence fallback', () => {
  it('uses the sole durable led fleet before the latest presence label', async () => {
    vi.mocked(listFleetsLedBy).mockResolvedValueOnce([ledFleet('actually-led')]);
    vi.mocked(resolvePresenceFleet).mockResolvedValueOnce({
      fleetSlug: 'latest-joined',
      fleetRole: 'member',
    });

    const out = await call({ list: true });

    expect(out).toMatchObject({ ok: true, fleet: 'actually-led' });
    expect(listFleetsLedBy).toHaveBeenCalledWith('ws-x', 'su-leader');
    expect(resolvePresenceFleet).toHaveBeenCalledWith('su-leader', { fleetSlug: 'p2p-git' });
  });

  it('refuses an omitted target when the caller leads multiple fleets', async () => {
    vi.mocked(listFleetsLedBy).mockResolvedValueOnce([ledFleet('fleet-a'), ledFleet('fleet-b')]);
    vi.mocked(resolvePresenceFleet).mockResolvedValueOnce({
      fleetSlug: 'fleet-b',
      fleetRole: 'leader',
    });

    const out = await call({ list: true });

    expect(out).toMatchObject({
      ok: false,
      error: 'ambiguous_fleet',
      fleets: ['fleet-a', 'fleet-b'],
    });
    expect(listFleetAssignments).not.toHaveBeenCalled();
  });

  it('falls back to current presence when the caller leads no fleet', async () => {
    vi.mocked(listFleetsLedBy).mockResolvedValueOnce([]);
    vi.mocked(resolvePresenceFleet).mockResolvedValueOnce({
      fleetSlug: 'presence-fleet',
      fleetRole: 'member',
    });
    vi.mocked(groupByAgent).mockReturnValueOnce([]);

    const out = await call({ list: true });

    expect(out).toMatchObject({ ok: true, fleet: 'presence-fleet', benched_count: 0 });
    expect(listFleetAssignments).toHaveBeenCalledWith({
      workspaceId: 'ws-x',
      fleet: 'presence-fleet',
      activeOnly: true,
    });
  });

  it('keeps an explicit fleet independent of ambient leadership and presence reads', async () => {
    const out = await call({ list: true, fleet: 'explicit-fleet' });

    expect(out).toMatchObject({ ok: true, fleet: 'explicit-fleet' });
    expect(listFleetsLedBy).not.toHaveBeenCalled();
    expect(resolvePresenceFleet).not.toHaveBeenCalled();
  });
});

describe('benchQueueVerdict — effective family-aware counts (EI-211885)', () => {
  it('refuses a bench when issue aliases are zero but the feature lane is nonempty', () => {
    expect(
      benchQueueVerdict({
        ...lane(0, 0),
        effective: { claimable: 4, matchedByFilter: null },
      }),
    ).toMatchObject({ refuse: true, claimable: 4, reason: 'queue-nonempty' });
  });

  it('reports unknown rather than drained when the effective pre-floor count is unavailable', () => {
    expect(
      benchQueueVerdict({
        ...lane(0, 0),
        effective: { claimable: 0, matchedByFilter: null },
      }),
    ).toMatchObject({ refuse: false, claimable: 0, matchedByFilter: null, reason: 'unknown' });
  });
});

describe('fleet:bench — stage mode', () => {
  it('registers the await FOR `member`, not the caller, tagging the note with the staged assignment', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: 'p2p-git:phase3-open', stagedAssignment: 'flip TEST hive bridged' });
    expect(captureWakeHandleForOwner).toHaveBeenCalledWith('su-worker');
    const arg = vi.mocked(registerAwait).mock.calls[0][0];
    expect(arg).toMatchObject({
      subscriberId: 'su-worker',
      eventKey: 'p2p-git:phase3-open',
      policy: 'wake',
      note: '[fleet:bench] flip TEST hive bridged',
      timeoutBehavior: 'wake',
    });
    expect(out).toMatchObject({
      ok: true,
      bench_id: '42',
      member: 'su-worker',
      event: 'p2p-git:phase3-open',
      stagedAssignment: 'flip TEST hive bridged',
      expires_ts: null,
      registered: true,
      benched_by: 'su-leader',
    });
    expect(typeof out.bench_id).toBe('string');
  });

  it('keeps the default bench alive until the wake event instead of expiring after 30 minutes', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: 'blocked:cleared', stagedAssignment: 'resume the staged leg' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      timeoutBehavior: 'wake',
      timeoutSec: null,
    });
    expect(out).toMatchObject({ ok: true, expires_ts: null });
  });

  it('preserves an explicit bench deadline for callers that want a timeout backstop', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: 'blocked:cleared', stagedAssignment: 'resume the staged leg', timeout_sec: 600 });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      timeoutBehavior: 'wake',
      timeoutSec: 600,
    });
    expect(out).toMatchObject({ ok: true, expires_ts: '2030-01-01' });
  });

  it('cross-key retargeting atomically retires every prior fleet bench for the member', async () => {
    vi.mocked(registerAwait).mockResolvedValueOnce({
      id: 42,
      eventKey: 'blocked:cleared',
      expiresTs: null,
      supersededPendingCount: 2,
    } as never);

    const out = await call({ member: 'su-worker', wakeEvent: 'blocked:cleared', stagedAssignment: 'resume the staged leg' });

    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      subscriberId: 'su-worker',
      eventKey: 'blocked:cleared',
      supersedePending: {
        allEventKeys: true,
        includeNotePrefix: '[fleet:bench] ',
      },
    });
    expect(out).toMatchObject({ ok: true, superseded_benches: 2 });
  });

  it('narrows a bare work-item:claimable bench to the staged member\'s claim spec and harness', async () => {
    vi.mocked(getClaimSpecRecord).mockResolvedValueOnce({
      source: 'fleet',
      spec: {
        specId: 'nonp2p-lane',
        revision: 47,
        view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change'] } },
        states: ['open'],
        limits: {},
      },
      revision: 47,
      updatedBy: 'leader',
      updatedAt: '2026-08-23T19:00:00.000Z',
      harnessSlug: 'papercusp',
      fleetSlug: 'nonp2p-bug-drain-luna-max-20260820',
    } as never);

    const out = await call({ member: 'su-worker', wakeEvent: 'work-item:claimable', stagedAssignment: 'resume the staged leg' });
    expect(vi.mocked(getClaimSpecRecord)).toHaveBeenCalledWith({ cupId: 'su-worker', workspaceId: 'ws-x' });
    expect(vi.mocked(registerAwait).mock.calls[0][0]).toMatchObject({
      subscriberId: 'su-worker',
      eventKey: 'work-item:claimable',
      payloadFilter: {
        all: [
          { kind: { in: ['bug', 'change'] } },
          { harness: { equals: 'papercusp' } },
        ],
      },
    });
    expect(out).toMatchObject({
      ok: true,
      auto_scoped_payload_filter: true,
      payload_filter_source: { source: 'fleet', specId: 'nonp2p-lane', revision: 47 },
    });
  });

  it('reports a bench miss immediately when no wake handle is found for the member', async () => {
    const out = await call({ member: 'su-no-session', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: true, registered: false });
    expect(out.advice as string).toContain('BENCH MISS');
  });

  it('refuses an unknown member before allocating or registering any bench state', async () => {
    const out = await call({ member: 'su-unknown', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({
      ok: false,
      error: 'member_not_found',
      member: 'su-unknown',
      fleet: 'p2p-git',
    });
    expect(out.hint as string).toContain("No member matching 'su-unknown'");
    expect(listFleetAssignments).toHaveBeenCalledWith({ workspaceId: 'ws-x', fleet: 'p2p-git', activeOnly: true });
    expect(readFleetLaneHealth).not.toHaveBeenCalled();
    expect(captureWakeHandleForOwner).not.toHaveBeenCalled();
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('missing member/wakeEvent (and not list mode) errors instead of silently no-oping', async () => {
    const out = await call({ stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: false, error: 'missing_args' });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('a pattern wakeEvent is flagged pattern:true and expanded before registering', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: '@fleet:red-team', stagedAssignment: 'x' });
    expect(vi.mocked(registerAwait).mock.calls[0][0].eventKey).toBe('fleet:*:red-team');
    expect(out).toMatchObject({ pattern: true });
  });
});

describe('benchQueueVerdict (pure) — park/pull is derived state, not prose [WI-5938]', () => {
  it('claimable > 0 ⇒ REFUSE: the lane is live, so park is the wrong verb', () => {
    expect(benchQueueVerdict(lane(4))).toMatchObject({
      refuse: true,
      claimable: 4,
      reason: 'queue-nonempty',
      specRef: 'spec-x (spec rev 3)',
    });
  });

  it('a genuinely drained lane (0 claimable, 0 matching) still benches', () => {
    expect(benchQueueVerdict(lane(0, 0))).toMatchObject({ refuse: false, reason: 'drained' });
  });

  it('GATED is not drained but IS benchable: 0 claimable with rows still matching the filter', () => {
    // EI-18689489507862177 — the backlog exists, every row is behind a claim floor. That
    // is a BLOCKED lane, which is exactly what benching is for.
    expect(benchQueueVerdict(lane(0, 113))).toMatchObject({ refuse: false, reason: 'gated' });
  });

  it('an UNREADABLE count fails OPEN as unknown — never refuses, and never reports "drained"', () => {
    // A read error must not wedge every bench on the fleet, and must not be laundered
    // into a verified-empty queue. Both halves matter.
    const v = benchQueueVerdict(null);
    expect(v).toMatchObject({ refuse: false, reason: 'unknown', claimable: null });
    expect(v.reason).not.toBe('drained');
  });
});

describe('fleet:bench — stage mode refuses a live lane [WI-5938 acceptance]', () => {
  it('ACCEPTANCE: a member with claimable > 0 gets the typed refusal, and NOTHING is staged', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(lane(7));
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({
      ok: false,
      error: 'bench_refused_queue_nonempty',
      member: 'su-worker',
      claimable: 7,
      spec_ref: 'spec-x (spec rev 3)',
    });
    // The refusal must happen BEFORE staging — a refused bench that still registered an
    // await would park the member anyway while reporting that it had not.
    expect(registerAwait).not.toHaveBeenCalled();
    expect(captureWakeHandleForOwner).not.toHaveBeenCalled();
  });

  it('ACCEPTANCE: a genuinely drained lane still benches normally', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(lane(0, 0));
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: true, bench_id: '42', lane: { verdict: 'drained', claimable: 0 } });
    expect(registerAwait).toHaveBeenCalled();
  });

  it('scopes the claimable floors to the MEMBER being benched, not the calling leader', async () => {
    // Their own held claims must not count against them as an exclusion, or a member
    // holding work reads as a gated lane rather than a live one.
    await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(vi.mocked(readFleetLaneHealth).mock.calls[0][0]).toMatchObject({
      fleet: 'p2p-git',
      assignee: 'su-worker',
    });
  });

  it('{ force: true } benches past a live lane but reports the override rather than hiding it', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(lane(7));
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x', force: true });
    expect(out).toMatchObject({ ok: true, forced: true, lane: { verdict: 'queue-nonempty', claimable: 7 } });
    expect(out.force_note as string).toContain('7 claimable');
    expect(registerAwait).toHaveBeenCalled();
  });

  it('an unreadable lane count does NOT wedge the bench (fails open, and says so)', async () => {
    vi.mocked(readFleetLaneHealth).mockResolvedValueOnce(null);
    const out = await call({ member: 'su-worker', wakeEvent: 'k', stagedAssignment: 'x' });
    expect(out).toMatchObject({ ok: true, lane: { verdict: 'unknown', claimable: null } });
  });
});

describe('fleet:bench — list mode', () => {
  it('keeps a registered presence-only bench visible when a harness is supplied', async () => {
    // Presence rows are harness-agnostic. The production repro passed
    // harness:'papercusp' and silently filtered the member before the parked
    // await could be projected.
    // The stage call now resolves membership before registering; keep both that
    // roster read and the later list-mode read scoped to the same member.
    vi.mocked(groupByAgent)
      .mockReturnValueOnce([{ agentId: 'su-worker', fleetSlug: 'p2p-git' } as never])
      .mockReturnValueOnce([{ agentId: 'su-worker', fleetSlug: 'p2p-git' } as never]);
    vi.mocked(listParkedAwaitsForSubscribers).mockResolvedValueOnce([
      {
        subscriberId: 'su-worker',
        eventKey: 'work-item:done:WI-40532',
        note: '[fleet:bench] remain benched until the duplicate claim clears',
        expiresTs: null,
        createdAt: '2026-07-10T12:00:00.000Z',
        timeoutBehavior: 'wake',
      },
    ]);

    const staged = await call({
      member: 'su-worker',
      wakeEvent: 'work-item:done:WI-40532',
      stagedAssignment: 'remain benched until the duplicate claim clears',
      harness: 'papercusp',
      fleet: 'p2p-git',
    });
    expect(staged).toMatchObject({ ok: true, registered: true });

    const out = await call({ list: true, fleet: 'p2p-git', harness: 'papercusp' });
    expect(listFleetAssignments).toHaveBeenCalledWith({ workspaceId: 'ws-x', fleet: 'p2p-git', activeOnly: true });
    expect(listParkedAwaitsForSubscribers).toHaveBeenCalledWith(['su-worker']);
    expect(out).toMatchObject({
      ok: true,
      fleet: 'p2p-git',
      benched_count: 1,
      benched: [{ member: 'su-worker', event: 'work-item:done:WI-40532' }],
    });
  });

  it('resolves the caller\'s own fleet when none is passed, and filters to bench-tagged rows', async () => {
    vi.mocked(listFleetAssignments).mockResolvedValueOnce([]);
    vi.mocked(groupByAgent).mockReturnValueOnce([
      { agentId: 'su-worker', fleetSlug: 'p2p-git' } as never,
      { agentId: 'su-other', fleetSlug: 'other-fleet' } as never,
    ]);
    vi.mocked(listParkedAwaitsForSubscribers).mockResolvedValueOnce([
      { subscriberId: 'su-worker', eventKey: 'p2p-git:phase3-open', note: '[fleet:bench] flip TEST hive bridged', expiresTs: null, createdAt: '2026-07-10T12:00:00.000Z', timeoutBehavior: 'wake' },
    ]);
    const out = await call({ list: true });
    expect(listParkedAwaitsForSubscribers).toHaveBeenCalledWith(['su-worker']);
    expect(out).toMatchObject({
      ok: true,
      fleet: 'p2p-git',
      benched_count: 1,
      benched: [{ member: 'su-worker', event: 'p2p-git:phase3-open', stagedAssignment: 'flip TEST hive bridged' }],
    });
  });

  it('a plain (non-bench) parked await never leaks into the bench roster', async () => {
    vi.mocked(groupByAgent).mockReturnValueOnce([{ agentId: 'su-worker', fleetSlug: 'p2p-git' } as never]);
    vi.mocked(listParkedAwaitsForSubscribers).mockResolvedValueOnce([
      { subscriberId: 'su-worker', eventKey: 'lock:grant:t1', note: null, expiresTs: null, createdAt: '2026-07-10T12:00:00.000Z', timeoutBehavior: 'wake' },
    ]);
    const out = await call({ list: true });
    expect(out).toMatchObject({ ok: true, benched_count: 0, benched: [] });
  });

  it('an explicit { fleet } overrides the caller\'s own launch-env fleet', async () => {
    // ...Once, NOT a permanent mockReturnValue: vi.clearAllMocks() clears calls but
    // NOT return values, so a permanent one here silently pins an EMPTY roster for
    // every test added after this point in the file (which then read as
    // `member_not_found` for a member that is plainly in the fixture).
    vi.mocked(groupByAgent).mockReturnValueOnce([]);
    const out = await call({ list: true, fleet: 'other-fleet' });
    expect(out).toMatchObject({ fleet: 'other-fleet' });
  });

  it('errors clearly when no fleet is resolvable and none was passed', async () => {
    vi.mocked(deriveFleetMembership).mockReturnValueOnce({ fleetSlug: null, fleetRole: null });
    vi.mocked(listFleetsLedBy).mockResolvedValueOnce([]);
    vi.mocked(resolvePresenceFleet).mockResolvedValueOnce({ fleetSlug: null, fleetRole: null });
    const out = await call({ list: true });
    expect(out).toMatchObject({ ok: false, error: 'no_fleet' });
    expect(listFleetAssignments).not.toHaveBeenCalled();
  });
});

/**
 * EI-21334781727749359 — the stage path's read legs must be BUDGETED.
 *
 * The regression these lock down is not "wrong answer" but "no answer in time":
 * sixteen concurrent per-member renewals each ran ~35s server-side, past the MCP
 * client deadline, and every caller was told the mutation MAY have executed. A
 * tool whose worst case is an unbounded wait with unknown write state cannot be
 * called safely, so each leg is pinned to its budget AND to its failure DIRECTION
 * — the two legs deliberately fail opposite ways, and swapping them would either
 * wedge every bench on a slow read or re-open the membership hole.
 *
 * Fake timers are used so the guard asserts the DEADLINE fires, not that a real
 * multi-second wall-clock sleep elapsed.
 */
describe('fleet:bench — bounded read legs [EI-21334781727749359]', () => {
  const hangForever = () => new Promise<never>(() => {});
  /** Mirrors BENCH_LANE_READ_BUDGET_MS; the calibration only needs A deadline to
   *  observe, so this deliberately does not import the constant — a test that
   *  reads its expectation from the code under test cannot contradict it. */
  const BENCH_LANE_BUDGET_UNDER_TEST = 6_000;
  let warned: string[];

  beforeEach(() => {
    // withBoundedTimeout announces a degradation on console.warn, and
    // vitest-fail-on-console turns that into a failure. Capture it instead of
    // silencing it: the warning is the only direct evidence that the DEADLINE
    // fired, as opposed to the read having failed some other way.
    warned = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
  });

  afterEach(() => {
    vi.mocked(console.warn).mockRestore?.();
  });

  const callWithDeadline = async (args: Record<string, unknown>) => {
    vi.useFakeTimers();
    try {
      const pending = call(args);
      // Past BOTH budgets (roster 5s, lane 6s). If a bound is ever removed, the
      // underlying mock never settles, so this promise never resolves and the test
      // fails on a timeout rather than passing vacuously.
      await vi.advanceTimersByTimeAsync(30_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  it('LANE read fails OPEN: a lane read that never returns still benches, and says the guard was skipped', async () => {
    vi.mocked(readFleetLaneHealth).mockImplementationOnce(hangForever);

    const out = await callWithDeadline({ member: 'su-worker', wakeEvent: 'gate:x', stagedAssignment: 'take P-004' });

    // The bench MUST still be registered — refusing here would let one slow read
    // wedge every bench on the fleet, the outage design note (1) forbids.
    expect(out).toMatchObject({ ok: true, member: 'su-worker' });
    expect(registerAwait).toHaveBeenCalledTimes(1);
    // ...and it must NOT be dressed up as a verified-empty queue.
    expect(out.lane).toMatchObject({ verdict: 'unknown', unavailable_reason: 'timeout' });
    expect((out.lane as Record<string, unknown>).claimable).toBeNull();
    // Prove the BOUND is what ended the wait. Without this the test would also pass
    // if readFleetLaneHealth had merely returned null on its own, which is a
    // different code path and would leave the real regression uncovered.
    expect(warned.join('\n')).toContain('fleet-bench:laneHealth exceeded 6000ms');
  });

  it('ROSTER read fails CLOSED: a hung roster refuses fast and stages NOTHING', async () => {
    vi.mocked(listFleetAssignments).mockImplementationOnce(hangForever);

    const out = await callWithDeadline({ member: 'su-worker', wakeEvent: 'gate:x' });

    expect(out).toMatchObject({ ok: false, error: 'roster_read_timeout', member: 'su-worker' });
    // The whole point of failing closed here: no write happened, so the caller
    // never has to hand-verify whether one did.
    expect(registerAwait).not.toHaveBeenCalled();
    // An unreadable roster must never be reported as "that member is absent".
    expect(out.error).not.toBe('member_not_found');
    expect(warned.join('\n')).toContain('fleet-bench:roster exceeded 5000ms');
  });

  it('an unreadable roster does not degrade into benching an unknown member', async () => {
    vi.mocked(listFleetAssignments).mockImplementationOnce(hangForever);
    const out = await callWithDeadline({ member: 'su-never-existed', wakeEvent: 'gate:x' });
    expect(out).toMatchObject({ ok: false, error: 'roster_read_timeout' });
    expect(registerAwait).not.toHaveBeenCalled();
  });

  it('list mode refuses on an unreadable roster instead of reporting an empty bench roster', async () => {
    vi.mocked(listFleetAssignments).mockImplementationOnce(hangForever);
    const out = await callWithDeadline({ list: true, fleet: 'p2p-git' });
    expect(out).toMatchObject({ ok: false, error: 'roster_read_timeout' });
    // A zero count here would read as "nobody is benched", a different claim entirely.
    expect(out.benched_count).toBeUndefined();
  });

  /**
   * FALSIFIABILITY CONTROLS — permanent, in-test, never a mutation of production
   * code (a probe that mutates this shared tree can be committed by the git-sync
   * sweep even when nothing goes wrong).
   *
   * The cases above assert that the handler SETTLES while a read hangs. That is
   * only meaningful if an UNBOUNDED await of the same hang would NOT settle — so
   * the negative control demonstrates exactly that, and the calibration proves the
   * instrument (fake timers + this deadline) can observe a bound firing at all. If
   * a future edit drops a budget, `await pending` above stops resolving and those
   * tests go red rather than passing vacuously; if instead the harness itself
   * breaks, the calibration goes red and tells you the tests below prove nothing.
   */
  it('CONTROL: an UNBOUNDED await of the same hang never settles (so the assertions above discriminate)', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      // The pre-fix shape: await the expensive read with no budget at all.
      void (async () => {
        await hangForever();
        settled = true;
      })();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CALIBRATION: a BOUNDED await of that same hang does settle, degraded, at its deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = withBoundedTimeout<null>(hangForever, {
        fallback: null,
        timeoutMs: BENCH_LANE_BUDGET_UNDER_TEST,
        label: 'calibration',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result).toMatchObject({ value: null, degraded: true, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('the healthy path is unchanged: a fast lane read reports its real verdict and no timeout marker', async () => {
    const out = await call({ member: 'su-worker', wakeEvent: 'gate:x' });
    expect(out).toMatchObject({ ok: true });
    expect((out.lane as Record<string, unknown>).unavailable_reason).toBeUndefined();
    expect((out.lane as Record<string, unknown>).verdict).toBe('drained');
  });
});
