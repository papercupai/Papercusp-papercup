/**
 * assignments.test.ts — the pure by-agent grouping + smell selectors over
 * fleet_assignment rows (state-not-chat-fleet-state-2026-06-05, P-002).
 *
 * The load-bearing invariant under test is CLAIM-PRIMARY (D-002): a claim whose
 * holder has no presence row must still produce an agent group (orphan), not be
 * silently dropped the way a presence-primary join would.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// EI-18763117665515043: resolveTerminalPlanItemResidue dynamic-imports both of
// these — mocked here so the unit tests never touch PG (the same pattern
// agent-tools/work_items/get.plan-item-blocked.test.ts uses for the identical
// planItemLaneBlockReason wiring on the self-select-observe path).
const getWorkItem = vi.fn();
vi.mock('../work-items', () => ({ getWorkItem: (...a: unknown[]) => getWorkItem(...a) }));
const planItemLaneBlockReason = vi.fn();
vi.mock('../scheduler/plan-item-lane-guard', () => ({
  planItemLaneBlockReason: (...a: unknown[]) => planItemLaneBlockReason(...a),
}));

import {
  ACTIVE_TOOL_CALL_WINDOW_MS,
  deriveClaimHealth,
  deriveActivity,
  isBroadClaimableParkMaskingStalledClaim,
  downgradeEndedHolders,
  groupByAgent,
  HOUSEKEEPING_TOOL_NAMES,
  isReclaimCandidate,
  isResidueCandidate,
  orphanedClaims,
  reclaimableClaims,
  reconcileOrphanedWithVerdicts,
  resolveTerminalPlanItemResidue,
  stalledClaims,
  summarizeOrphan,
  shouldRecoverClaimFromHealth,
  upgradeRecordedLiveHolders,
  type FleetAssignmentRow,
  type HolderActivity,
  type PlanItemLaneBlock,
} from './assignments';
import { classifyItemActivity, isReclaimable, type ItemActivity } from '../item-activity';
import { STALE_CLAIM_GRACE_MS } from '../work-items-stale-claims';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';

const base: FleetAssignmentRow = {
  source: 'presence',
  workspaceId: '*',
  agentId: 'su-a',
  agentLabel: 'su · a',
  agentName: null,
  harnessSlug: null,
  planSlug: null,
  itemId: null,
  workItemId: null,
  itemKind: null,
  detail: '',
  status: null,
  claimAcquiredTs: null,
  claimExpiresTs: null,
  claimActive: null,
  livenessMode: null,
  lastActivityTs: null,
  holderPresent: true,
  holderAlive: true,
  holderHeartbeatAt: '2026-06-05T12:00:00.000Z',
  holderIntent: null,
  holderPlanSlug: null,
  orphaned: false,
  stalled: null,
  lastProgressAt: null,
  declaredPlanMatches: null,
  assigneeRank: null,
  rankWriter: null,
};

const presence = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  ...over,
});

const planClaim = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  source: 'plan_item_claim',
  planSlug: 'plan-x',
  itemId: 'P-001',
  harnessSlug: 'all',
  claimActive: true,
  ...over,
});

describe('groupByAgent — claim-primary (D-002)', () => {
  it('a claim with NO presence row still yields an agent group (the orphan survives)', () => {
    const groups = groupByAgent([
      planClaim({
        agentId: 'su-dead',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('su-dead');
    expect(groups[0].present).toBe(false);
    expect(groups[0].alive).toBe(false);
    expect(groups[0].orphaned).toBe(true);
    expect(groups[0].claims).toHaveLength(1);
  });

  it('merges a presence row and its claims into one group', () => {
    const groups = groupByAgent([
      presence({ detail: 'building x', planSlug: 'plan-x' }),
      planClaim({ agentId: 'su-a', detail: 'P-001 work' }),
      planClaim({
        agentId: 'su-a',
        source: 'work_item_claim',
        itemId: null,
        workItemId: 'WI-7',
        itemKind: 'task',
        planSlug: null,
      }),
    ]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.present).toBe(true);
    expect(g.intent).toBe('building x');
    expect(g.declaredPlanSlug).toBe('plan-x');
    expect(g.claims).toHaveLength(2);
    expect(g.claims.map((c) => c.type).sort()).toEqual(['plan-item', 'work-item']);
  });

  it('name-keyed assignment rows merge into the owner group that claims that name', () => {
    const groups = groupByAgent([
      planClaim({ agentId: 'su-a', agentName: 'builder-1' }),
      {
        ...base,
        source: 'plan_item_assignment',
        agentId: 'builder-1',
        agentName: 'builder-1',
        planSlug: 'plan-x',
        itemId: 'P-002',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        claimActive: true,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('su-a');
    expect(groups[0].name).toBe('builder-1');
    expect(groups[0].claims).toHaveLength(2);
  });

  it('an assignment whose name no claim links stays a standalone name-keyed group', () => {
    const groups = groupByAgent([
      {
        ...base,
        source: 'plan_item_assignment',
        agentId: 'builder-9',
        agentName: 'builder-9',
        planSlug: 'plan-y',
        itemId: 'P-003',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        claimActive: true,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].agentId).toBe('builder-9');
    expect(groups[0].present).toBe(false);
  });

  it('flags declaredUnclaimed when the declared plan is backed by no claim (the D-002 smell)', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-smell', planSlug: 'plan-z' }),
      presence({ agentId: 'su-ok', planSlug: 'plan-x' }),
      planClaim({ agentId: 'su-ok' }),
    ]);
    const smell = groups.find((g) => g.agentId === 'su-smell');
    const ok = groups.find((g) => g.agentId === 'su-ok');
    expect(smell?.declaredUnclaimed).toBe(true);
    expect(ok?.declaredUnclaimed).toBe(false);
  });

  it('sorts live agents first, then orphan-holders', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-stale', holderAlive: false, holderHeartbeatAt: '2026-06-05T01:00:00.000Z' }),
      planClaim({
        agentId: 'su-orphan',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
      presence({ agentId: 'su-live' }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(['su-live', 'su-orphan', 'su-stale']);
  });
});

// The work-item-claim row factory carrying a per-assignee rank (local-hive P-021).
const workClaim = (over: Partial<FleetAssignmentRow>): FleetAssignmentRow => ({
  ...base,
  source: 'work_item_claim',
  agentId: 'su-bee',
  itemId: null,
  workItemId: 'WI-?',
  itemKind: 'feature',
  detail: 'a work-item',
  status: 'todo',
  claimActive: true,
  ...over,
});

describe('groupByAgent — the per-bee ordered work-list (local-hive P-021)', () => {
  it('derives doing (head-of-line) + queued (rank order) + load from work-item claims', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-bee', detail: 'working' }),
      workClaim({ workItemId: 'WI-3', detail: 'third', assigneeRank: 2, rankWriter: 'cup' }),
      workClaim({ workItemId: 'WI-1', detail: 'first', assigneeRank: 0, rankWriter: 'mug' }),
      workClaim({ workItemId: 'WI-2', detail: 'second', assigneeRank: 1, rankWriter: 'cup' }),
    ]);
    const g = groups.find((x) => x.agentId === 'su-bee')!;
    expect(g.load).toBe(3);
    expect(g.queued.map((q) => q.id)).toEqual(['WI-1', 'WI-2', 'WI-3']); // rank ASC
    expect(g.doing?.id).toBe('WI-1'); // head-of-line = lowest rank
    expect(g.doing?.rankWriter).toBe('mug'); // the Queen-overlaid head
  });

  it('sorts unranked work-items to the tail (NULLs last), stable by id', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-bee' }),
      workClaim({ workItemId: 'WI-b', assigneeRank: null }),
      workClaim({ workItemId: 'WI-a', assigneeRank: null }),
      workClaim({ workItemId: 'WI-ranked', assigneeRank: 0 }),
    ]);
    const g = groups.find((x) => x.agentId === 'su-bee')!;
    expect(g.queued.map((q) => q.id)).toEqual(['WI-ranked', 'WI-a', 'WI-b']);
    expect(g.doing?.id).toBe('WI-ranked');
  });

  it('an agent with no work-items has doing=null, queued=[], load=0', () => {
    const groups = groupByAgent([
      presence({ agentId: 'su-idle' }),
      planClaim({ agentId: 'su-idle' }), // a plan-item lease is NOT a work-item
    ]);
    const g = groups.find((x) => x.agentId === 'su-idle')!;
    expect(g.doing).toBeNull();
    expect(g.queued).toEqual([]);
    expect(g.load).toBe(0);
  });
});

describe('orphanedClaims', () => {
  it('keeps active orphaned claims, drops lapsed and held ones', () => {
    const rows = [
      planClaim({ agentId: 'su-1', orphaned: true, claimActive: true }),
      planClaim({ agentId: 'su-2', orphaned: true, claimActive: false }), // lapsed
      planClaim({ agentId: 'su-3', orphaned: false, claimActive: true }), // healthy
    ];
    expect(orphanedClaims(rows).map((r) => r.agentId)).toEqual(['su-1']);
  });
});

// ── WI-5975: absence rendered as absence; liveness outranks progress-recency ────
//
// The incident: a leader read a held item as an ORPHAN from lastProgressAt:null
// plus ~2.5h of no visible activity, moved to reassign it, and was refused — the
// holder was ALIVE and completed the item minutes later. Two conditions rendered
// identically (never-checkpointed vs measured-stale), and a live holder's claim
// landed in the same reclaimable bucket as a dead holder's.
describe('summarizeOrphan — WI-5975', () => {
  const heldByLive = workClaim({
    agentId: 'su-holder',
    workItemId: 'WI-5923',
    holderAlive: true,
    stalled: true,
    lastProgressAt: null,
    claimAcquiredTs: '2026-07-26T04:00:00.000Z',
  });

  it('renders a never-checkpointed claim distinctly from a measured-stale one', () => {
    expect(summarizeOrphan(heldByLive).progress).toBe('never-checkpointed');
    expect(summarizeOrphan(heldByLive).last_progress_at).toBeNull();

    const stale = workClaim({
      agentId: 'su-holder',
      workItemId: 'WI-1',
      holderAlive: true,
      stalled: true,
      lastProgressAt: '2026-07-26T01:00:00.000Z',
    });
    expect(summarizeOrphan(stale).progress).toBe('stale-since');
    expect(summarizeOrphan(stale).last_progress_at).toBe('2026-07-26T01:00:00.000Z');
  });

  it('never emits a bare null for the progress signal', () => {
    // The whole defect: a null that reads like a measurement. Whatever the
    // inputs, `progress` is always an explicit, self-describing discriminator.
    for (const lastProgressAt of [null, '2026-07-26T01:00:00.000Z']) {
      for (const holderAlive of [true, false]) {
        const s = summarizeOrphan(workClaim({ agentId: 'su-x', holderAlive, lastProgressAt }));
        expect(s.progress).toMatch(/^(never-checkpointed|stale-since)$/);
      }
    }
  });

  // THE regression canary for the incident, stated as the acceptance criterion:
  // a live holder can never be rendered as an orphan.
  it('a LIVE holder is never an orphan, however old the progress signal is', () => {
    const s = summarizeOrphan(heldByLive, { sessionState: 'live', lastToolCallAt: '2026-07-26T06:29:58.000Z' });
    expect(s.verdict).toBe('held-by-live-agent');
    expect(s.action).toBe('ask');
    expect(isReclaimCandidate(s)).toBe(false);
    expect(s.holder_last_tool_call_at).toBe('2026-07-26T06:29:58.000Z');
  });

  it('P-005 exposes progress-derived claim health separately from liveness/activity', () => {
    const now = Date.parse('2026-07-26T06:30:00.000Z');
    const quietLive = summarizeOrphan(
      {
        ...heldByLive,
        holderAlive: true,
        lastProgressAt: null,
      },
      { sessionState: 'live' },
      now,
    );
    expect(quietLive.verdict).toBe('held-by-live-agent');
    expect(quietLive.claim_health.status).toBe('suspect');
    expect(quietLive.claim_health.evidence.map((e) => e.writer)).toContain('coord_presence');

    const productive = summarizeOrphan(
      { ...heldByLive, stalled: false },
      {
        sessionState: 'parked',
        productiveToolCallAt: '2026-07-26T06:29:30.000Z',
        checkpointKind: 'mechanical',
      },
      now,
    );
    expect(productive.verdict).toBe('held-by-live-agent');
    expect(productive.claim_health.status).toBe('healthy');
    expect(productive.claim_health.reasons.join(' ')).toContain('non-housekeeping tool progress');
  });

  it('P-005 mechanical-only checkpoints and heartbeat-only liveness do not keep a claim healthy', () => {
    const now = Date.parse('2026-07-26T06:30:00.000Z');
    const mechanicalOnly = deriveClaimHealth(
      {
        ...heldByLive,
        holderAlive: true,
        lastProgressAt: '2026-07-26T06:29:30.000Z',
      },
      { sessionState: 'live', checkpointKind: 'mechanical' },
      now,
    );
    expect(mechanicalOnly.status).toBe('suspect');
    expect(mechanicalOnly.reasons.join(' ')).toContain('mechanical-only checkpoint');
  });

  it('P-005 names waiting/recoverable/contested health with writer evidence', () => {
    const now = Date.parse('2026-07-26T06:30:00.000Z');
    const waiting = deriveClaimHealth(
      heldByLive,
      { sessionState: 'parked', parkedOn: ['fleet:x:critical-path-open'] },
      now,
    );
    expect(waiting.status).toBe('waiting');
    expect(waiting.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ writer: 'events_await', signal: 'exact_dependency_waits' }),
      ]),
    );

    const recoverable = deriveClaimHealth(
      heldByLive,
      { sessionState: 'suspect', wakeable: true },
      now,
    );
    expect(recoverable.status).toBe('recoverable');
    expect(recoverable.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ writer: 'coord_presence', signal: 'wakeable', value: true })]),
    );

    const contested = deriveClaimHealth(
      {
        ...heldByLive,
        orphaned: true,
      },
      { sessionState: 'live', contextGeneration: 3 },
      now,
    );
    expect(contested.status).toBe('contested');
    expect(contested.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ writer: 'memory_session_epochs', signal: 'context_generation', value: 3 }),
      ]),
    );
  });

  it('a lane-drained work-item:claimable watch does not mask a stalled held claim', () => {
    const now = Date.parse('2026-07-26T06:30:00.000Z');
    const health = deriveClaimHealth(
      heldByLive,
      {
        sessionState: 'parked',
        parkedOn: ['work-item:claimable'],
        monitorState: 'parked-awaiting-capability',
      },
      now,
    );

    expect(health.status).toBe('suspect');
    expect(health.reasons).toContain('heartbeat/liveness exists but no fresh authored or productive progress');
    expect(shouldRecoverClaimFromHealth(health)).toBe(true);
    expect(health.evidence).toContainEqual(
      expect.objectContaining({ writer: 'events_await', signal: 'active_event_waits', value: ['work-item:claimable'] }),
    );
    expect(health.evidence).not.toContainEqual(
      expect.objectContaining({ writer: 'events_await', signal: 'exact_dependency_waits' }),
    );
  });

  it('the handler suppression guard only matches a stalled claim with a broad parked watch', () => {
    expect(
      isBroadClaimableParkMaskingStalledClaim('parked-awaiting-capability', ['work-item:claimable'], true),
    ).toBe(true);
    expect(
      isBroadClaimableParkMaskingStalledClaim('parked-awaiting-capability', ['work-item:claimable'], false),
    ).toBe(false);
    expect(
      isBroadClaimableParkMaskingStalledClaim('parked-awaiting-capability', ['fleet:bar:gate'], true),
    ).toBe(false);
    expect(isBroadClaimableParkMaskingStalledClaim('waiting', ['work-item:claimable'], true)).toBe(false);
  });

  it('the oracle OUTRANKS the row heartbeat in both directions', () => {
    // Warm-dead: heartbeat still fresh, oracle says ended ⇒ genuinely reclaimable.
    const warmDead = summarizeOrphan({ ...heldByLive, holderAlive: true }, { sessionState: 'ended' });
    expect(warmDead.verdict).toBe('orphan');
    expect(warmDead.action).toBe('reclaim');

    // Cold-but-live: heartbeat lapsed, oracle says live ⇒ ASK, never reclaim.
    const coldLive = summarizeOrphan({ ...heldByLive, holderAlive: false }, { sessionState: 'live' });
    expect(coldLive.verdict).toBe('held-by-live-agent');
    expect(coldLive.action).toBe('ask');
  });

  // EI-18738329288671636: `orphan`/`reclaim` requires the oracle to say the
  // holder is CONFIRMED GONE — the oracle's OWN docstrings (presence-wakeability.ts)
  // say `ended`/`suspect`/`draining` are the dead states and `parked`/`recorded`
  // are alive (just not the running-right-now `live`). Live-verified: a `parked`
  // holder with `holder_present:true` and a fresh heartbeat was reported
  // `orphan`/`reclaim` before this fix — this is the regression canary for that.
  it.each<[Exclude<SessionState, 'live'>]>([['draining'], ['suspect'], ['ended']])(
    'sessionState %s is CONFIRMED gone ⇒ orphan/reclaim',
    (sessionState) => {
      expect(summarizeOrphan(heldByLive, { sessionState }).verdict).toBe('orphan');
    },
  );

  it.each<[Exclude<SessionState, 'live'>]>([['parked'], ['recorded']])(
    'sessionState %s is documented ALIVE (just not running-right-now) ⇒ held-by-live-agent, never orphan',
    (sessionState) => {
      const s = summarizeOrphan(heldByLive, { sessionState });
      expect(s.verdict).toBe('held-by-live-agent');
      expect(s.action).toBe('ask');
      expect(isReclaimCandidate(s)).toBe(false);
    },
  );

  it('falls back to the row heartbeat when no oracle verdict is available', () => {
    // Degrade to the OLD behaviour rather than manufacture a confident verdict
    // from missing input — the same failure mode this bug is about.
    expect(summarizeOrphan(heldByLive, null).verdict).toBe('held-by-live-agent');
    expect(summarizeOrphan(heldByLive, { sessionState: null }).verdict).toBe('held-by-live-agent');
    expect(summarizeOrphan({ ...heldByLive, holderAlive: false }).verdict).toBe('orphan');
  });

  it('omits holder_last_tool_call_at entirely when unknown (absence stays absent)', () => {
    expect('holder_last_tool_call_at' in summarizeOrphan(heldByLive)).toBe(false);
    expect('holder_last_tool_call_at' in summarizeOrphan(heldByLive, { sessionState: 'live' })).toBe(false);
    expect(summarizeOrphan(heldByLive, { sessionState: 'live', lastToolCallAt: null }).holder_last_tool_call_at).toBeNull();
  });

  it('keeps the pre-existing wire fields intact', () => {
    const s = summarizeOrphan(heldByLive);
    expect(s).toMatchObject({ source: 'work_item_claim', agent: 'su-holder', id: 'WI-5923' });
  });

  // ── EI-18716042694888410: recent REAL work outranks session posture ──────────
  //
  // The incident: fleet:assignments reported summary.reclaimable_claims:4, every
  // row verdict:orphan/action:reclaim/progress:never-checkpointed. All four
  // holders were `parked` AND actively working — 803-2981 tool calls that day,
  // two of them 22-23 calls in the last five MINUTES. The Mug persona says to
  // act on summary.reclaimable_claims, so the documented procedure was to
  // force-release work out from under four live workers.
  //
  // `lastToolCallAt` was fetched (lastToolCallAtByOwner, with its own partial
  // index) and documented as the signal separating working-but-not-checkpointing
  // from wedged — then attached to the payload and never read by the verdict.
  describe('recent tool activity outranks a non-live sessionState', () => {
    const NOW = Date.parse('2026-07-26T14:00:00.000Z');
    const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

    it('a fresh claim with no heartbeat is held during the scheduler grace window', () => {
      const fresh = workClaim({
        holderAlive: false,
        claimAcquiredTs: agoMs(2 * 60_000),
        lastProgressAt: null,
      });
      const s = summarizeOrphan(fresh, null, NOW);
      expect(s.verdict).toBe('held-by-live-agent');
      expect(s.action).toBe('ask');
      expect(isReclaimCandidate(s)).toBe(false);
    });

    it('anchors fresh-claim grace on the newest claim or progress timestamp', () => {
      const freshReclaim = workClaim({
        holderAlive: false,
        claimAcquiredTs: agoMs(2 * 60_000),
        // A prior holder's progress must not make this re-claim look stale.
        lastProgressAt: agoMs(4 * 60 * 60_000),
      });
      const s = summarizeOrphan(freshReclaim, { sessionState: 'draining' }, NOW);
      expect(s.verdict).toBe('held-by-live-agent');
      expect(s.action).toBe('ask');

      const aged = { ...freshReclaim, claimAcquiredTs: agoMs(STALE_CLAIM_GRACE_MS + 1) };
      const agedSummary = summarizeOrphan(aged, { sessionState: 'draining' }, NOW);
      expect(agedSummary.verdict).toBe('orphan');
      expect(agedSummary.action).toBe('reclaim');
    });

    it('a PARKED holder invoking tools right now is never reclaimable', () => {
      const s = summarizeOrphan(
        heldByLive,
        { sessionState: 'parked', lastToolCallAt: agoMs(2 * 60_000) },
        NOW,
      );
      expect(s.verdict).toBe('held-by-live-agent');
      expect(s.action).toBe('ask');
      expect(isReclaimCandidate(s)).toBe(false);
    });

    it.each<[Exclude<SessionState, 'live'>]>([
      ['parked'],
      ['draining'],
      ['suspect'],
      ['recorded'],
    ])('%s + a fresh tool call ⇒ ask, not reclaim', (sessionState) => {
      const s = summarizeOrphan(heldByLive, { sessionState, lastToolCallAt: agoMs(30_000) }, NOW);
      expect(isReclaimCandidate(s)).toBe(false);
    });

    // EI-18738329288671636: these four exercise the isRecentlyActive WINDOW logic
    // layered under the sessionState fallback — they need a sessionState the
    // oracle documents as CONFIRMED gone (`draining`), not `parked` (documented
    // alive, and now correctly NEVER orphan regardless of tool-call recency —
    // see the dedicated `sessionState %s is documented ALIVE` cases above).

    it('a genuinely wedged holder still crosses the window into reclaim', () => {
      // The inverse, so the window is actually exercised rather than the guard
      // degenerating into "never reclaim anything".
      const s = summarizeOrphan(
        heldByLive,
        { sessionState: 'draining', lastToolCallAt: agoMs(6 * 60 * 60_000) },
        NOW,
      );
      expect(s.verdict).toBe('orphan');
      expect(s.action).toBe('reclaim');
      expect(isReclaimCandidate(s)).toBe(true);
    });

    it('brackets the window boundary', () => {
      const inside = summarizeOrphan(
        heldByLive,
        { sessionState: 'draining', lastToolCallAt: agoMs(ACTIVE_TOOL_CALL_WINDOW_MS - 1_000) },
        NOW,
      );
      const outside = summarizeOrphan(
        heldByLive,
        { sessionState: 'draining', lastToolCallAt: agoMs(ACTIVE_TOOL_CALL_WINDOW_MS + 1_000) },
        NOW,
      );
      expect(isReclaimCandidate(inside)).toBe(false);
      expect(isReclaimCandidate(outside)).toBe(true);
    });

    it('ignores an unparseable or absent timestamp rather than presuming activity', () => {
      // Absence must not read as liveness — the same failure mode as the null
      // progress signal above.
      for (const lastToolCallAt of [null, undefined, 'not-a-date']) {
        const s = summarizeOrphan(heldByLive, { sessionState: 'draining', lastToolCallAt }, NOW);
        expect(s.verdict).toBe('orphan');
      }
    });

    it('does not let a far-future timestamp manufacture liveness', () => {
      const s = summarizeOrphan(
        heldByLive,
        { sessionState: 'draining', lastToolCallAt: agoMs(-24 * 60 * 60_000) },
        NOW,
      );
      expect(s.verdict).toBe('orphan');
    });

    it('a PARKED holder is never orphan even far outside the tool-call window — parked is documented alive, not a wedged-holder proxy', () => {
      const s = summarizeOrphan(
        heldByLive,
        { sessionState: 'parked', lastToolCallAt: agoMs(6 * 60 * 60_000) },
        NOW,
      );
      expect(s.verdict).toBe('held-by-live-agent');
      expect(isReclaimCandidate(s)).toBe(false);
    });

    // EI-18779583390738111: a claim row read holder_present:true/verdict:held-by-live-agent
    // while the SAME payload's agents[] row for the SAME holder read alive:false/
    // sessionState:'ended'/verdict:dead — because the old fusion let ANY recent tool
    // call override EVERY confirmed-gone sessionState, `ended` included. `ended` fires
    // only on the SessionEnd/Stop lifecycle event, which already unconditionally
    // released every claim that session held (session-death-claim-release-2026-07-11) —
    // a confirmed, PERMANENT termination that a tool call made before death cannot
    // walk back. Unlike `suspect`/`draining` (still overridable — see above), `ended`
    // must NEVER be reported held-by-live-agent, however fresh the last tool call.
    it('sessionState "ended" is NEVER overridden by a fresh tool call — unlike suspect/draining', () => {
      const s = summarizeOrphan(heldByLive, { sessionState: 'ended', lastToolCallAt: agoMs(30_000) }, NOW);
      expect(s.verdict).toBe('orphan');
      expect(s.action).toBe('reclaim');
      expect(isReclaimCandidate(s)).toBe(true);
    });

    // The cross-row invariant the bug's own recurrence guard asks for, checkable
    // without a live fleet: for `ended` specifically — the state agents[]-row alive
    // derivation treats identically to suspect/draining for `alive:false`, but which
    // (unlike suspect/draining) represents a CONFIRMED, non-heuristic termination —
    // summarizeOrphan must never report held-by-live-agent/ask, at ANY tool-call
    // recency, so a claim row can never contradict the same payload's agents[] row.
    it.each([agoMs(1_000), agoMs(5 * 60_000), agoMs(6 * 60 * 60_000), null, undefined])(
      'sessionState "ended" never contradicts agents[]-row alive:false, regardless of lastToolCallAt=%s',
      (lastToolCallAt) => {
        const s = summarizeOrphan(heldByLive, { sessionState: 'ended', lastToolCallAt }, NOW);
        expect(s.verdict).toBe('orphan');
        expect(s.action).toBe('reclaim');
      },
    );
  });

  // Pins the structurally-declared HolderActivity union to the real oracle type,
  // so the data-layer copy cannot drift from presence-wakeability's SessionState.
  it('HolderActivity.sessionState accepts exactly the oracle SessionState union', () => {
    const states: SessionState[] = ['live', 'parked', 'draining', 'suspect', 'ended', 'recorded'];
    const asHolder: HolderActivity[] = states.map((sessionState) => ({ sessionState }));
    const backToOracle: (SessionState | null | undefined)[] = asHolder.map((h) => h.sessionState);
    expect(backToOracle).toEqual(states);
  });

  // EI-18763117665515043: `fleet:assignments` reported verdict:'orphan'/
  // action:'reclaim' for a claim whose LINKED plan item was already `done` — the
  // reclaim verdict never cross-checked the plan-item lane the way
  // `work_items:get`'s own `planItemBlocked` already does. `residue` (when
  // passed) must OVERRIDE the liveness-derived verdict entirely, in BOTH
  // directions (a dead holder AND a demonstrably live one).
  describe('residue overrides the liveness verdict entirely (EI-18763117665515043)', () => {
    // The INPUT is a full PlanItemLaneBlock — `reason` is required on it
    // (scheduler/plan-item-lane-guard.ts), and is worded here exactly as the real
    // terminal/residue producer emits it (same file, the `is already <status> — its
    // work-item is stale residue…` branch). The explicit type annotation is the point:
    // it binds this fixture to the interface, so the NEXT required field added there
    // reds this one line instead of silently drifting.
    const residue: PlanItemLaneBlock = {
      planSlug: 'p',
      itemId: 'P-007',
      effectiveStatus: 'done',
      reason:
        'plan-item p#P-007 is already done — its work-item is stale residue of completed/abandoned work, not open work',
      // WI-7316 added this required field; the tripwire above worked exactly as intended.
      // null is the honest value for THIS fixture: a cleanly-terminal item with no
      // unresolved blocked-by edge carries no contradiction for the resolver to report.
      staleBlockedHint: null,
    };

    // The OUTPUT is deliberately NARROWER than the input: summarizeOrphan projects the
    // lane block down to the three identifying fields and drops `reason` to keep the
    // per-row payload small (assignments.ts — the `residue:` construction, and the
    // structural output type on the SummarizedOrphan interface). Assert against that
    // projection explicitly rather than against the input fixture: comparing to the
    // input only ever passed because the fixture was missing `reason`, i.e. the two
    // shapes coincided by accident. Pinning it here means a future change that starts
    // or stops forwarding a field fails loudly instead of silently altering the payload.
    const residueProjection = { planSlug: 'p', itemId: 'P-007', effectiveStatus: 'done' };

    it('a DEAD holder whose claim is residue reports residue/close, not orphan/reclaim', () => {
      const deadResidue = summarizeOrphan(heldByLive, { sessionState: 'ended' }, undefined, residue);
      expect(deadResidue.verdict).toBe('residue');
      expect(deadResidue.action).toBe('close');
      expect(deadResidue.residue).toEqual(residueProjection);
      expect(isReclaimCandidate(deadResidue)).toBe(false);
      expect(isResidueCandidate(deadResidue)).toBe(true);
    });

    it('a LIVE holder whose claim is residue ALSO reports residue/close, not held-by-live-agent/ask', () => {
      const liveResidue = summarizeOrphan(
        heldByLive,
        { sessionState: 'live', lastToolCallAt: '2026-07-27T19:00:00.000Z' },
        undefined,
        residue,
      );
      expect(liveResidue.verdict).toBe('residue');
      expect(liveResidue.action).toBe('close');
      expect(isResidueCandidate(liveResidue)).toBe(true);
    });

    it('no residue ⇒ unchanged liveness-derived verdict (the pre-existing behaviour)', () => {
      const s = summarizeOrphan(heldByLive, { sessionState: 'ended' }, undefined, null);
      expect(s.verdict).toBe('orphan');
      expect(isResidueCandidate(s)).toBe(false);
    });

    it('isResidueCandidate/isReclaimCandidate are mutually exclusive', () => {
      const dead = summarizeOrphan(heldByLive, { sessionState: 'ended' }, undefined, residue);
      expect(isReclaimCandidate(dead)).toBe(false);
      expect(isResidueCandidate(dead)).toBe(true);
    });
  });
});

describe('resolveTerminalPlanItemResidue — EI-18763117665515043', () => {
  beforeEach(() => {
    getWorkItem.mockReset();
    planItemLaneBlockReason.mockReset();
  });

  const claimRow = (over: Partial<FleetAssignmentRow> = {}): FleetAssignmentRow => ({
    ...base,
    source: 'work_item_claim',
    workItemId: 'WI-6211',
    harnessSlug: 'papercusp',
    ...over,
  });

  it('resolves a terminal (done) linked plan item into the map', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-6211', harness: 'papercusp', family: 'issue', payload: {} });
    planItemLaneBlockReason.mockResolvedValue({
      reason: 'plan-item p#P-007 is already done — its work-item is stale residue of completed/abandoned work, not open work',
      planSlug: 'p',
      itemId: 'P-007',
      effectiveStatus: 'done',
    });
    const map = await resolveTerminalPlanItemResidue([claimRow()]);
    expect(getWorkItem).toHaveBeenCalledWith('WI-6211', 'papercusp');
    expect(map.get('WI-6211')).toMatchObject({ planSlug: 'p', itemId: 'P-007', effectiveStatus: 'done' });
  });

  it('resolves a dropped linked plan item too', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-6211', harness: 'papercusp', family: 'issue', payload: {} });
    planItemLaneBlockReason.mockResolvedValue({
      reason: 'plan-item p#P-007 is already dropped',
      planSlug: 'p',
      itemId: 'P-007',
      effectiveStatus: 'dropped',
    });
    const map = await resolveTerminalPlanItemResidue([claimRow()]);
    expect(map.get('WI-6211')?.effectiveStatus).toBe('dropped');
  });

  it('never treats blocked/needs-human as residue (only done/dropped)', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-6211', harness: 'papercusp', family: 'issue', payload: {} });
    planItemLaneBlockReason.mockResolvedValue({
      reason: 'plan-item p#P-007 is effectively blocked',
      planSlug: 'p',
      itemId: 'P-007',
      effectiveStatus: 'blocked',
    });
    const map = await resolveTerminalPlanItemResidue([claimRow()]);
    expect(map.has('WI-6211')).toBe(false);
  });

  it('a clear lane (no block reason) yields no residue entry', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-6211', harness: 'papercusp', family: 'issue', payload: {} });
    planItemLaneBlockReason.mockResolvedValue(null);
    const map = await resolveTerminalPlanItemResidue([claimRow()]);
    expect(map.size).toBe(0);
  });

  it('ignores presence rows and rows with no workItemId', async () => {
    const map = await resolveTerminalPlanItemResidue([base, claimRow({ workItemId: null })]);
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('dedupes several claim rows naming the SAME work-item into ONE lookup', async () => {
    getWorkItem.mockResolvedValue({ id: 'WI-6211', harness: 'papercusp', family: 'issue', payload: {} });
    planItemLaneBlockReason.mockResolvedValue({
      reason: 'r',
      planSlug: 'p',
      itemId: 'P-007',
      effectiveStatus: 'done',
    });
    await resolveTerminalPlanItemResidue([
      claimRow({ agentId: 'su-a' }),
      claimRow({ agentId: 'su-b' }),
    ]);
    expect(getWorkItem).toHaveBeenCalledTimes(1);
  });

  it('best-effort: a lookup failure for one id omits it, never throws', async () => {
    getWorkItem.mockRejectedValue(new Error('pg down'));
    const map = await resolveTerminalPlanItemResidue([claimRow()]);
    expect(map.size).toBe(0);
  });

  it('an empty/no-claim input never dynamic-imports anything', async () => {
    const map = await resolveTerminalPlanItemResidue([base]);
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });
});

// ── agent-activity-liveness-truth P-005: the single derived truth ───────────────
// (reuses the `workClaim` row builder defined above for the P-021 work-list tests)

describe('deriveActivity — the view-row projection of the truth (P-005, D-002)', () => {
  it('free when unclaimed', () => {
    expect(
      deriveActivity({ agentId: null, orphaned: false, stalled: null, lastProgressAt: null, holderAlive: false }),
    ).toBe('free');
  });
  it('dead when the holder is gone (orphaned), regardless of progress', () => {
    expect(
      deriveActivity({
        agentId: 'bee-1',
        orphaned: true,
        stalled: false,
        lastProgressAt: '2026-06-22T00:00:00Z',
        holderAlive: false,
      }),
    ).toBe('dead');
  });
  it('stalled when alive but not progressing (the second half of the incident)', () => {
    expect(
      deriveActivity({ agentId: 'bee-1', orphaned: false, stalled: true, lastProgressAt: null, holderAlive: true }),
    ).toBe('stalled');
  });
  it('progressing ONLY when alive AND has real progress — the one "actively worked" state', () => {
    expect(
      deriveActivity({
        agentId: 'bee-1',
        orphaned: false,
        stalled: false,
        lastProgressAt: '2026-06-22T00:00:00Z',
        holderAlive: true,
      }),
    ).toBe('progressing');
  });
  it('alive (grace) when freshly claimed by a live holder with no progress yet', () => {
    expect(
      deriveActivity({ agentId: 'bee-1', orphaned: false, stalled: false, lastProgressAt: null, holderAlive: true }),
    ).toBe('alive');
  });
  it('reserved when claimed but holder liveness is not affirmatively alive', () => {
    expect(
      deriveActivity({ agentId: 'bee-1', orphaned: false, stalled: false, lastProgressAt: null, holderAlive: false }),
    ).toBe('reserved');
  });

  // The load-bearing cross-check: the SQL view's stalled/orphaned booleans, once
  // projected by deriveActivity, must AGREE with the pure canonical classifier on
  // the same inputs — so the SQL reconciler and the TS readers can never drift.
  it('agrees with classifyItemActivity on representative claim states', () => {
    const NOW = 1_800_000_000_000;
    const fresh = NOW - 60_000; // within window
    const old = NOW - 30 * 60_000; // past the 10-min window
    type Case = { holderAlive: boolean; lastProgressAt: number | null; takenAt: number };
    const cases: Case[] = [
      { holderAlive: true, lastProgressAt: fresh, takenAt: old }, // progressing
      { holderAlive: true, lastProgressAt: null, takenAt: fresh }, // alive (grace)
      { holderAlive: true, lastProgressAt: old, takenAt: old }, // stalled
      { holderAlive: false, lastProgressAt: fresh, takenAt: fresh }, // dead (view) / reserved? → see note
    ];
    for (const c of cases) {
      const classifier = classifyItemActivity(
        { takenBy: 'bee-1', takenAt: c.takenAt, lastProgressAt: c.lastProgressAt, holderAlive: c.holderAlive },
        { now: NOW },
      );
      // Project the view booleans the way migration 358 computes them for a
      // work_item_claim leg (holder_alive=false ⇒ orphaned; alive+stale ⇒ stalled).
      const stalled = c.holderAlive && NOW - (c.lastProgressAt ?? c.takenAt) > 600_000;
      const orphaned = !c.holderAlive;
      const projected = deriveActivity({
        agentId: 'bee-1',
        orphaned,
        stalled,
        lastProgressAt: c.lastProgressAt == null ? null : new Date(c.lastProgressAt).toISOString(),
        holderAlive: c.holderAlive,
      });
      // Both sides agree on the single most important property: is it reclaimable
      // (dead/stalled) vs actively worked? The view collapses unknown-holder to
      // dead while the classifier may say reserved within grace, so we assert the
      // safety-critical equivalence (reclaimable ⇔ reclaimable), not label identity.
      expect(isReclaimable(projected)).toBe(
        isReclaimable(classifier as ItemActivity) || (orphaned && classifier === 'reserved'),
      );
    }
  });
});

describe('stalledClaims / reclaimableClaims (P-002/P-005)', () => {
  it('stalledClaims keeps active stalled rows only', () => {
    const rows = [
      workClaim({ agentId: 'bee-1', stalled: true }),
      workClaim({ agentId: 'bee-2', stalled: false }),
      workClaim({ agentId: 'bee-3', stalled: true, claimActive: false }), // lapsed
    ];
    expect(stalledClaims(rows).map((r) => r.agentId)).toEqual(['bee-1']);
  });
  it('reclaimableClaims is the union of dead (orphaned) and stalled', () => {
    const rows = [
      workClaim({ agentId: 'dead', orphaned: true, stalled: false }),
      workClaim({ agentId: 'stuck', orphaned: false, stalled: true }),
      workClaim({ agentId: 'healthy', orphaned: false, stalled: false }),
    ];
    expect(
      reclaimableClaims(rows)
        .map((r) => r.agentId)
        .sort(),
    ).toEqual(['dead', 'stuck']);
  });
});

describe('groupByAgent — surfaces stalled like orphaned (P-005)', () => {
  it('a live holder sitting on a non-progressing work-item reads as stalled, not covered', () => {
    const groups = groupByAgent([
      workClaim({ agentId: 'bee-stuck', stalled: true, holderPresent: true, holderAlive: true }),
    ]);
    const g = groups.find((x) => x.agentId === 'bee-stuck')!;
    expect(g.stalled).toBe(true);
    expect(g.orphaned).toBe(false);
    expect(g.doing?.activity).toBe('stalled'); // the head-of-line is NOT progressing
  });
});

// WI-1408 (fleet-registration-persists): a member launched with `--fleet <slug>`
// must show up GROUPED under that fleet here — the read side of the fix. The
// presence row's fleet_slug/fleet_role columns are a projection of the durable
// membership fact (fleet_membership_events, WI-1345) that bootstrap-su/-role/
// operator-spawn stamp at boot (appendFleetMembershipIfAbsent, WI-1893 — see
// bootstrap-su-fleet-stamp.test.ts for that write-side wiring). This pins
// that a `listFleetAssignments` row carrying fleetSlug/fleetRole survives
// `groupByAgent` into the roster's per-agent fleet label — never silently
// dropped or left null the way the reported bug produced.
describe('groupByAgent — named-fleet membership label (WI-1408 / P-005)', () => {
  it("a --fleet-launched member's presence row groups it under the fleet (non-null fleetSlug/fleetRole)", () => {
    const groups = groupByAgent([presence({ agentId: 'su-member-1', fleetSlug: 'atlas-fleet', fleetRole: 'member' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fleetSlug).toBe('atlas-fleet');
    expect(groups[0].fleetRole).toBe('member');
  });

  it('a work-item claim joined to a fleeted holder still surfaces the fleet label via the holder-join fallback', () => {
    const groups = groupByAgent([
      workClaim({
        agentId: 'su-member-2',
        workItemId: 'WI-9',
        holderPresent: true,
        holderAlive: true,
        fleetSlug: 'atlas-fleet',
        fleetRole: 'member',
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].fleetSlug).toBe('atlas-fleet');
    expect(groups[0].fleetRole).toBe('member');
  });

  it('an agent with no fleet membership groups with a null fleetSlug (unchanged, non-regressive default)', () => {
    const groups = groupByAgent([presence({ agentId: 'su-unfleeted' })]);
    expect(groups[0].fleetSlug).toBeNull();
    expect(groups[0].fleetRole).toBeNull();
  });
});

describe('downgradeEndedHolders — heartbeat-vs-authoritative liveness drift (EI-6374)', () => {
  it('an ENDED holder whose warm heartbeat reads `alive`/`progressing` is downgraded to `dead`', () => {
    // The exact bug: fleet_assignment showed the bee alive (warm heartbeat) while
    // coord:send {wake:required} reported the session `ended` and not wakeable.
    const rows = [
      presence({ agentId: 'su-ended', holderAlive: true }),
      workClaim({
        agentId: 'su-ended',
        workItemId: 'WI-1438',
        holderPresent: true,
        holderAlive: true,
        lastProgressAt: '2026-07-02T12:00:00.000Z', // → 'progressing' before the fix
        orphaned: false,
      }),
    ];
    // Pre-fix: the claim reads as actively worked.
    expect(deriveActivity(rows[1])).toBe('progressing');

    const fixed = downgradeEndedHolders(rows, new Set(['su-ended']));
    const claim = fixed.find((r) => r.source === 'work_item_claim')!;
    const pres = fixed.find((r) => r.source === 'presence')!;
    // The claim is now a dead/orphaned (reclaimable) leg — no longer false coverage.
    expect(claim.holderAlive).toBe(false);
    expect(claim.orphaned).toBe(true);
    expect(deriveActivity(claim)).toBe('dead');
    expect(isReclaimable(deriveActivity(claim))).toBe(true);
    // The presence backbone row also drops liveness (but is never marked orphaned —
    // it holds no claim), so the agent no longer counts as alive.
    expect(pres.holderAlive).toBe(false);
    expect(pres.orphaned).toBe(false);
    expect(groupByAgent(fixed)[0].alive).toBe(false);
  });

  it('leaves a LIVE holder (not in the ended set) untouched', () => {
    const rows = [
      workClaim({
        agentId: 'su-live',
        workItemId: 'WI-2',
        holderAlive: true,
        lastProgressAt: '2026-07-02T12:00:00.000Z',
      }),
    ];
    const out = downgradeEndedHolders(rows, new Set(['su-ended']));
    expect(out[0]).toBe(rows[0]); // identity preserved — pure no-op for non-ended holders
    expect(deriveActivity(out[0])).toBe('progressing');
  });

  it('is a no-op when the ended set is empty (returns the same array)', () => {
    const rows = [workClaim({ agentId: 'su-x', workItemId: 'WI-3', holderAlive: true })];
    expect(downgradeEndedHolders(rows, new Set())).toBe(rows);
  });

  it('does not revive an already-dead/stale holder or touch an inactive claim', () => {
    // holderAlive=false already ⇒ the gate skips it (we only DOWNGRADE a live-reading
    // holder); a lapsed claim (claimActive=false) is never freshly orphaned.
    const dead = workClaim({
      agentId: 'su-ended',
      workItemId: 'WI-4',
      holderAlive: false,
      orphaned: false,
      claimActive: false,
    });
    const out = downgradeEndedHolders([dead], new Set(['su-ended']));
    expect(out[0]).toBe(dead); // untouched — holderAlive was already false
    expect(out[0].orphaned).toBe(false);
  });
});

describe('upgradeRecordedLiveHolders — recorded-live bootstrap liveness drift (EI-8106)', () => {
  it('a recorded-live holder whose presence/wakeability has not registered is not orphaned', () => {
    const rows = [
      workClaim({
        agentId: 's-bootstrap',
        workItemId: 'WI-8106',
        holderPresent: false,
        holderAlive: false,
        holderHeartbeatAt: null,
        orphaned: true,
      }),
    ];

    expect(deriveActivity(rows[0])).toBe('dead');
    expect(orphanedClaims(rows)).toHaveLength(1);

    const fixed = upgradeRecordedLiveHolders(rows, new Set(['s-bootstrap']));
    expect(fixed[0]).not.toBe(rows[0]);
    expect(fixed[0].holderPresent).toBe(true);
    expect(fixed[0].holderAlive).toBe(true);
    expect(fixed[0].orphaned).toBe(false);
    expect(deriveActivity(fixed[0])).toBe('alive');
    expect(orphanedClaims(fixed)).toHaveLength(0);
    expect(groupByAgent(fixed)[0].alive).toBe(true);
  });

  it('is a no-op when the recorded-live set is empty', () => {
    const rows = [workClaim({ agentId: 's-bootstrap', workItemId: 'WI-8107', orphaned: true })];
    expect(upgradeRecordedLiveHolders(rows, new Set())).toBe(rows);
  });
});

describe('reconcileOrphanedWithVerdicts — the EI-18698865231464142 blind spot', () => {
  it('a non-session (role-string) holder confirmed dead by an out-of-band oracle, invisible to BOTH orphaned and stalled, is reconciled into orphaned', () => {
    // The exact bug: 'improvement-runner' carries no adv_sessions row, so
    // downgradeEndedHolders (keyed by endedRecordedOwnerIds) never fires for it —
    // the row stays orphaned:false/stalled:null even though a richer oracle
    // (fleet:assignments' own sessionState, via reconcileWakeability) independently
    // confirms the holder is `ended`.
    const rows = [
      workClaim({
        agentId: 'improvement-runner',
        workItemId: 'EI-18694945517907886',
        holderAlive: true,
        orphaned: false,
        stalled: null,
      }),
    ];
    // Pre-fix: invisible to both reclaim lists.
    expect(orphanedClaims(rows)).toHaveLength(0);
    expect(stalledClaims(rows)).toHaveLength(0);

    const fixed = reconcileOrphanedWithVerdicts(rows, new Set(['improvement-runner']));
    expect(fixed[0]).not.toBe(rows[0]);
    expect(fixed[0].orphaned).toBe(true);
    expect(fixed[0].holderAlive).toBe(false);
    expect(orphanedClaims(fixed)).toHaveLength(1);
    expect(deriveActivity(fixed[0])).toBe('dead');
  });

  it('never overrides an already-stalled row (the progress-based leg keeps precedence)', () => {
    const rows = [
      workClaim({ agentId: 'su-quiet', workItemId: 'WI-1', holderAlive: true, orphaned: false, stalled: true }),
    ];
    const fixed = reconcileOrphanedWithVerdicts(rows, new Set(['su-quiet']));
    expect(fixed[0]).toBe(rows[0]); // untouched — already accounted for by stalledClaims
    expect(fixed[0].orphaned).toBe(false);
  });

  it('never touches an already-orphaned row, a lapsed claim, a presence row, or a holder outside the set', () => {
    const rows = [
      workClaim({ agentId: 'su-a', workItemId: 'WI-2', orphaned: true }), // already orphaned
      workClaim({ agentId: 'su-b', workItemId: 'WI-3', claimActive: false }), // lapsed
      presence({ agentId: 'su-c' }), // presence, not a claim
      workClaim({ agentId: 'su-d', workItemId: 'WI-4' }), // not in the dead set
    ];
    const fixed = reconcileOrphanedWithVerdicts(rows, new Set(['su-a', 'su-b', 'su-c']));
    expect(fixed).toEqual(rows); // no row content changed
  });

  it('is a no-op (identity-preserving) when the dead-owner set is empty', () => {
    const rows = [workClaim({ agentId: 'su-x', workItemId: 'WI-5' })];
    expect(reconcileOrphanedWithVerdicts(rows, new Set())).toBe(rows);
  });

  // The RECURRENCE GUARD (per the incident's own "every incident is a detector
  // failure" callout): assert the INVARIANT, not the mechanism — any active claim
  // whose holder is in the caller's confirmed-dead set MUST appear in orphanedClaims
  // (or already be in stalledClaims), covering a non-session/role-string holder id
  // explicitly, so this can never again pass through neither reclaim list.
  it('INVARIANT: every active claim held by a confirmed-dead owner appears in orphaned or stalled', () => {
    const deadOwners = new Set(['improvement-runner', 'su-ended-session']);
    const rows = [
      workClaim({ agentId: 'improvement-runner', workItemId: 'WI-role-string', orphaned: false, stalled: null }),
      workClaim({ agentId: 'su-ended-session', workItemId: 'WI-session', orphaned: true, stalled: null }),
      workClaim({ agentId: 'su-live', workItemId: 'WI-live', orphaned: false, stalled: null }),
    ];
    const fixed = reconcileOrphanedWithVerdicts(rows, deadOwners);
    for (const r of fixed) {
      if (!r.agentId || !deadOwners.has(r.agentId)) continue;
      const reclaimable = orphanedClaims(fixed).includes(r) || stalledClaims(fixed).includes(r);
      expect(reclaimable).toBe(true);
    }
    // The live holder's claim is untouched and correctly NOT reclaimable.
    expect(orphanedClaims(fixed).some((r) => r.agentId === 'su-live')).toBe(false);
  });
});


describe('shouldRecoverClaimFromHealth (P-006)', () => {
  it('allows automated recovery only for suspect claim-health verdicts', () => {
    expect(shouldRecoverClaimFromHealth({ status: 'suspect' })).toBe(true);
    for (const status of ['healthy', 'waiting', 'recoverable', 'contested'] as const) {
      expect(shouldRecoverClaimFromHealth({ status })).toBe(false);
    }
  });
});

describe('HOUSEKEEPING_TOOL_NAMES (EI-19307414464301772)', () => {
  it('carries both colon and underscore spellings of every per-turn housekeeping call', () => {
    expect([...HOUSEKEEPING_TOOL_NAMES].sort()).toEqual(
      [
        'coord:glance',
        'coord_glance',
        'activity:report',
        'activity_report',
        'journal:record-turn',
        'journal_record-turn',
        'flags:get',
        'flags_get',
        'sessions:ingest-gate-event',
        'sessions_ingest-gate-event',
      ].sort(),
    );
  });
});
