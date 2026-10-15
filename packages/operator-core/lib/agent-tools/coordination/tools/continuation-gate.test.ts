import { describe, expect, it } from 'vitest';
import {
  CONTINUATION_CEILING_PCT,
  evaluateContinuationGate,
  continuationGateFromReads,
  countPendingInterrupts,
  isFleetWindDownLoopEndAuthorized,
  isPendingInterrupt,
} from './continuation-gate';
import { CUE_AUTHORITY_FIELD } from '../cue-authority';
import { CONTEXT_GAUGE_CRITICAL_PCT } from './inbox-context-usage';
import { COMPACTION_HINT_PCT } from './inbox-context-usage';
import { FLUSH_GATE_PCT } from './inbox-flush-gate';

describe('evaluateContinuationGate (P-005 continuation gate)', () => {
  it('OPENS when context has headroom and the inbox is empty', () => {
    const v = evaluateContinuationGate({ contextPct: 40, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.contextHeadroom).toBe(true);
    expect(v.guidance).toMatch(/continuation gate OPEN/);
    expect(v.guidance).toMatch(/flush/i); // still tells the agent to checkpoint first
  });

  it('CLOSES at/above the context ceiling', () => {
    const v = evaluateContinuationGate({ contextPct: CONTINUATION_CEILING_PCT, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(false);
    expect(v.contextHeadroom).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/60% continuation ceiling/);
    expect(v.guidance).toMatch(/continuation gate CLOSED/);
  });

  it('stays OPEN just below the ceiling', () => {
    const v = evaluateContinuationGate({ contextPct: CONTINUATION_CEILING_PCT - 1, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(true);
  });

  it('CLOSES on a pending inbox interrupt (singular vs plural wording)', () => {
    const one = evaluateContinuationGate({ contextPct: 30, unreadInbox: 1 });
    expect(one.shouldContinue).toBe(false);
    expect(one.reasons.join(' ')).toMatch(/1 unread inbox message /);
    const many = evaluateContinuationGate({ contextPct: 30, unreadInbox: 3 });
    expect(many.reasons.join(' ')).toMatch(/3 unread inbox messages/);
  });

  it('fails SAFE toward settle when context is unknown (null)', () => {
    const v = evaluateContinuationGate({ contextPct: null, unreadInbox: 0 });
    expect(v.shouldContinue).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/context usage unknown/);
  });

  it('fails SAFE toward settle when the inbox could not be evaluated (null)', () => {
    const v = evaluateContinuationGate({ contextPct: 20, unreadInbox: null });
    expect(v.shouldContinue).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/inbox not evaluated/);
  });

  it('reports BOTH blocking legs when both fail', () => {
    const v = evaluateContinuationGate({ contextPct: 90, unreadInbox: 5 });
    expect(v.shouldContinue).toBe(false);
    expect(v.reasons).toHaveLength(2);
  });

  it('honors a custom ceiling', () => {
    expect(evaluateContinuationGate({ contextPct: 50, unreadInbox: 0, ceilingPct: 40 }).shouldContinue).toBe(false);
    expect(evaluateContinuationGate({ contextPct: 50, unreadInbox: 0, ceilingPct: 70 }).shouldContinue).toBe(true);
  });

  it('the continuation ceiling sits BELOW the flush gate and the compaction hint', () => {
    // You stop STARTING new units (60%) well before the flush gate (75%) and the
    // compaction-urgent zone (85%) — the layering the spec fixes.
    expect(CONTINUATION_CEILING_PCT).toBeLessThan(FLUSH_GATE_PCT);
    expect(FLUSH_GATE_PCT).toBeLessThan(COMPACTION_HINT_PCT);
  });
});

describe('isPendingInterrupt / countPendingInterrupts (WI-4179 — machinery is not an interrupt)', () => {
  it('drops CATEGORIZED system broadcasts (the watchdog severe-event[-resolved] firehose)', () => {
    expect(isPendingInterrupt({ category: 'severe-event-resolved' })).toBe(false);
    expect(isPendingInterrupt({ category: 'severe-event' })).toBe(false);
    expect(isPendingInterrupt({ category: 'service-health' })).toBe(false);
  });

  it('drops auto lifecycle chatter and peers’ intent declares', () => {
    expect(isPendingInterrupt({ auto: true, lifecycle: 'claim' })).toBe(false);
    expect(isPendingInterrupt({ lifecycle: 'intent' })).toBe(false);
  });

  it('KEEPS deliberate messages: directed peer mail, owner-directive relays, uncategorized system nags', () => {
    expect(isPendingInterrupt({})).toBe(true); // a plain peer message
    expect(isPendingInterrupt({ lifecycle: 'claim' })).toBe(true); // deliberate (not auto) lifecycle mail
    expect(isPendingInterrupt({ category: '' })).toBe(true); // an empty category is no classification
  });

  it('the live WI-4179 shape: 16 identical watchdog resolution rows + 1 real peer message ⇒ 1, not 17', () => {
    const watchdogRow = { category: 'severe-event-resolved' };
    const unread = [...Array.from({ length: 16 }, () => watchdogRow), { lifecycle: undefined }];
    expect(countPendingInterrupts(unread)).toBe(1);
    // …and the gate verdict follows the corrected count, not the raw length.
    expect(evaluateContinuationGate({ contextPct: 20, unreadInbox: countPendingInterrupts(unread.slice(0, 16)) }).shouldContinue).toBe(true);
  });
});

describe('continuationGateFromReads (raw presence + inbox reads)', () => {
  it('derives contextPct from tokens/limit then delegates', () => {
    const v = continuationGateFromReads({ contextTokens: 40, compactionLimit: 100, unreadInbox: 0 });
    expect(v.contextPct).toBe(40);
    expect(v.shouldContinue).toBe(true);
  });

  it('null tokens ⇒ unknown context ⇒ settle', () => {
    const v = continuationGateFromReads({ contextTokens: null, compactionLimit: 100, unreadInbox: 0 });
    expect(v.contextPct).toBeNull();
    expect(v.shouldContinue).toBe(false);
  });

  it('a zero/absent limit ⇒ unknown context ⇒ settle (no divide-by-zero)', () => {
    const v = continuationGateFromReads({ contextTokens: 100, compactionLimit: 0, unreadInbox: 0 });
    expect(v.contextPct).toBeNull();
    expect(v.shouldContinue).toBe(false);
  });

  it('passes rewakeGuaranteed through to the verdict', () => {
    expect(continuationGateFromReads({ contextTokens: 40, compactionLimit: 100, unreadInbox: 0, rewakeGuaranteed: true }).rewakeGuaranteed).toBe(true);
    expect(continuationGateFromReads({ contextTokens: 40, compactionLimit: 100, unreadInbox: 0 }).rewakeGuaranteed).toBeNull();
  });
});

describe('re-wake guarantee escalation (kills the "the next wake re-opens the gate" false comfort)', () => {
  it('a CLOSED gate with NO guaranteed re-wake escalates to self-compact / arm-a-wake', () => {
    const v = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0, rewakeGuaranteed: false });
    expect(v.shouldContinue).toBe(false);
    expect(v.rewakeGuaranteed).toBe(false);
    expect(v.guidance).toMatch(/SILENTLY HALT/);
    expect(v.guidance).toMatch(/session:request-compaction/);
    expect(v.guidance).toMatch(/loop:arm|events:await/);
    // and it must NOT hand back the false-comfort "the next wake re-opens the gate"
    expect(v.guidance).not.toMatch(/the next wake re-opens the gate/);
  });

  it('reports an active standing inbox wake without calling it a qualifying await', () => {
    const v = evaluateContinuationGate({
      contextPct: 80,
      unreadInbox: 0,
      rewakeGuaranteed: false,
      activeInboxWakeAwait: true,
    });
    expect(v.shouldContinue).toBe(false);
    expect(v.activeInboxWakeAwait).toBe(true);
    expect(v.guidance).toContain('no qualifying deliberate await');
    expect(v.guidance).toContain('active standing coord:inbox-wake await present');
    expect(v.guidance).not.toContain('no registered await');
  });

  it('diagnoses an armed-but-fire-starved loop instead of claiming no loop exists', () => {
    const v = evaluateContinuationGate({
      contextPct: 80,
      unreadInbox: 0,
      rewakeGuaranteed: false,
      activeLoopRewakeBlockedReason: 'fire-starved',
      activeLoopIntervalSec: 180,
      activeLoopGoal: 'finish WI-1',
      selfCompactionAvailable: false,
    });

    expect(v.activeLoopRewakeBlockedReason).toBe('fire-starved');
    expect(v.guidance).toContain('an armed loop EXISTS');
    expect(v.guidance).toContain('fire-starved');
    expect(v.guidance).toContain('repair the EXISTING loop state');
    expect(v.guidance).not.toContain('no armed loop,');
    expect(v.guidance).not.toContain('ARM A WAKE:');
  });

  it('diagnoses a delivered wake with no loop-origin turn and repairs the existing path', () => {
    const v = evaluateContinuationGate({
      contextPct: 80,
      unreadInbox: 0,
      rewakeGuaranteed: false,
      activeLoopRewakeBlockedReason: 'last-fire-no-loop-turn',
      selfCompactionAvailable: false,
    });

    expect(v.guidance).toContain('lastDeliveryOutcome=\'loop-delivered-wake-no-loop-turn\'');
    expect(v.guidance).toContain('repair the EXISTING loop state');
    expect(v.guidance).toContain('confirm a loop-origin turn before settling');
    expect(v.guidance).not.toContain('ARM A WAKE:');
  });

  it('a CLOSED gate WITH a guarantee keeps the base settle guidance', () => {
    const v = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0, rewakeGuaranteed: true });
    expect(v.shouldContinue).toBe(false);
    expect(v.guidance).toMatch(/the next wake re-opens the gate/);
    expect(v.guidance).not.toMatch(/SILENTLY HALT/);
  });

  it('a guaranteed WARM wake does not masquerade as a fresh-context boundary', () => {
    const v = evaluateContinuationGate({
      contextPct: 91,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: true,
      activeLoopIntervalSec: 300,
      activeLoopGoal: 'drain the lane',
    });
    expect(v.shouldContinue).toBe(false);
    expect(v.nextWakeFresh).toBe(false);
    expect(v.guidance).toMatch(/next wake is WARM/);
    expect(v.guidance).toMatch(/loop:checkpoint/);
    expect(v.guidance).toContain(
      "loop:arm { intervalSec: 300, goal: \"drain the lane\", carry: 'cold' }",
    );
    expect(v.guidance).not.toMatch(/the next wake re-opens the gate/);
  });

  it.each([
    { unreadInbox: 1, selfCompactionAvailable: true },
    { unreadInbox: 1, selfCompactionAvailable: false },
    { unreadInbox: 1, selfCompactionAvailable: null },
    { unreadInbox: null, selfCompactionAvailable: true },
    { unreadInbox: null, selfCompactionAvailable: false },
    { unreadInbox: null, selfCompactionAvailable: null },
  ])('preserves warm carry when only the inbox closes the gate ($unreadInbox, host $selfCompactionAvailable)', (inputs) => {
    const v = evaluateContinuationGate({
      contextPct: 44,
      ...inputs,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      activeLoopIntervalSec: 300,
      activeLoopGoal: 'drain the lane',
    });

    expect(v.shouldContinue).toBe(false);
    expect(v.contextHeadroom).toBe(true);
    expect(v.reasons).toHaveLength(1);
    expect(v.guidance).toContain('coord:inbox');
    expect(v.guidance).not.toContain('over-ceiling');
    expect(v.guidance).not.toContain("carry: 'cold'");
    expect(v.guidance).not.toMatch(/cold wake|retune.*loop|session:request-compaction/);
  });

  it('does not label unknown context as over-ceiling or prescribe a cold retune', () => {
    const v = evaluateContinuationGate({
      contextPct: null,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: true,
    });

    expect(v.shouldContinue).toBe(false);
    expect(v.reasons.join(' ')).toContain('context usage unknown');
    expect(v.guidance).not.toContain('over-ceiling');
    expect(v.guidance).not.toContain("carry: 'cold'");
  });

  it('a hostless warm wake is not retuned to a cold path that may park', () => {
    const v = evaluateContinuationGate({
      contextPct: 75,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: false,
      activeLoopIntervalSec: 300,
      activeLoopGoal: 'drain the lane',
    });
    expect(v.guidance).toMatch(/next wake is WARM/);
    expect(v.guidance).toMatch(/fresh-context delivery is unavailable/i);
    expect(v.guidance).toMatch(/cold wake.*may park/);
    expect(v.guidance).toMatch(/Do not retune this warm loop to cold/);
    expect(v.guidance).toMatch(/managed psu-pty host/);
    expect(v.guidance).not.toContain("carry: 'cold'");
    expect(v.guidance).not.toMatch(/cold wake starts from that durable carry-note/);
  });

  it('unknown host support does not claim a cold retune will create a fresh context', () => {
    const v = evaluateContinuationGate({
      contextPct: 75,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: null,
      activeLoopIntervalSec: 300,
      activeLoopGoal: 'drain the lane',
    });
    expect(v.guidance).toMatch(/fresh-context delivery is unverified/i);
    expect(v.guidance).not.toContain("carry: 'cold'");
    expect(v.guidance).not.toMatch(/cold wake starts from that durable carry-note/);
  });

  it('requires a status read before rendering a cold retune when active-loop values are unavailable', () => {
    const v = evaluateContinuationGate({
      contextPct: 91,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: true,
    });
    expect(v.guidance).toContain('read loop:status');
    expect(v.guidance).toContain('intervalSec: <status.intervalSec>');
    expect(v.guidance).toContain('goal: <status.goal>');
  });

  it('a guaranteed COLD wake keeps the ordinary settle path', () => {
    const v = evaluateContinuationGate({
      contextPct: 91,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: true,
      selfCompactionAvailable: true,
    });
    expect(v.nextWakeFresh).toBe(true);
    expect(v.guidance).toMatch(/the next wake re-opens the gate/);
    expect(v.guidance).not.toMatch(/next wake is WARM/);
  });

  it('an already-cold loop without a usable host restores the reachable warm path', () => {
    const v = evaluateContinuationGate({
      contextPct: 75,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: true,
      selfCompactionAvailable: false,
      activeLoopIntervalSec: 300,
      activeLoopGoal: 'drain the lane',
    });
    expect(v.guidance).toMatch(/configured for COLD carry/);
    expect(v.guidance).toMatch(/fresh-context delivery is unavailable/);
    expect(v.guidance).toMatch(/carry: 'warm'/);
    expect(v.guidance).toMatch(/preserves this context and does not reset it/);
  });

  it('unknown (null/absent) re-wake keeps the base guidance — non-breaking', () => {
    const v = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0 });
    expect(v.rewakeGuaranteed).toBeNull();
    expect(v.guidance).toMatch(/the next wake re-opens the gate/);
    expect(v.guidance).not.toMatch(/SILENTLY HALT/);
  });

  it('an OPEN gate ignores rewakeGuaranteed (the wake only matters at settle)', () => {
    const v = evaluateContinuationGate({ contextPct: 30, unreadInbox: 0, rewakeGuaranteed: false });
    expect(v.shouldContinue).toBe(true);
    expect(v.guidance).toMatch(/continuation gate OPEN/);
    expect(v.guidance).not.toMatch(/SILENTLY HALT/);
  });
});

// EI-20209826138488049 / EI-20212450572990141: the escalation above used to
// prescribe session:request-compaction FIRST — to sessions that structurally
// cannot run it. A headless/autonomous member has no psu-pty host, so the call
// refuses (no_live_pty_host) and the session spends its LAST turn discovering
// that. The remedy is selected from the SAME predicate request-compaction
// itself evaluates (selfCompactionAvailability), never a proxy for "is this
// session headless".
describe('remedy selection by self-compaction availability', () => {
  const closedNoRewake = { contextPct: 80, unreadInbox: 0, rewakeGuaranteed: false as const };
  const armIndex = (g: string) => g.search(/loop:arm/);
  const compactIndex = (g: string) => g.search(/session:request-compaction/);

  it('UNAVAILABLE ⇒ never prescribes the call that would refuse', () => {
    const v = evaluateContinuationGate({ ...closedNoRewake, selfCompactionAvailable: false });
    expect(v.selfCompactionAvailable).toBe(false);
    expect(v.guidance).toMatch(/SILENTLY HALT/);
    expect(v.guidance).toMatch(/loop:arm/);
    // The whole point: the tool that CANNOT succeed here is named only to be
    // RULED OUT — never offered as a remedy the session should reach for.
    expect(v.guidance).toMatch(/NOT available to this session/);
    expect(v.guidance).toMatch(/do not spend your last turn on it/);
    expect(v.guidance).not.toMatch(/or SELF-COMPACT/);
  });

  it('AVAILABLE ⇒ offers both, and still leads with arming', () => {
    const v = evaluateContinuationGate({ ...closedNoRewake, selfCompactionAvailable: true });
    expect(v.selfCompactionAvailable).toBe(true);
    expect(v.guidance).toMatch(/session:request-compaction/);
    expect(v.guidance).toMatch(/loop:arm/);
    expect(armIndex(v.guidance)).toBeLessThan(compactIndex(v.guidance));
  });

  it('UNKNOWN ⇒ non-breaking: both remedies, arming first, with the refusal named', () => {
    const v = evaluateContinuationGate(closedNoRewake);
    expect(v.selfCompactionAvailable).toBeNull();
    expect(v.guidance).toMatch(/session:request-compaction/);
    expect(armIndex(v.guidance)).toBeLessThan(compactIndex(v.guidance));
    // unknown must WARN about the refusal rather than pretend the call is safe
    expect(v.guidance).toMatch(/no_live_pty_host/);
  });

  it('arming leads in EVERY branch — the diagnosed condition is the missing re-wake, and only loop:arm removes it', () => {
    for (const selfCompactionAvailable of [true, false, null]) {
      const g = evaluateContinuationGate({ ...closedNoRewake, selfCompactionAvailable }).guidance;
      expect(armIndex(g)).toBeGreaterThanOrEqual(0);
      if (compactIndex(g) >= 0) expect(armIndex(g)).toBeLessThan(compactIndex(g));
    }
  });

  it('availability only steers a CLOSED gate with no re-wake — never an open one', () => {
    const open = evaluateContinuationGate({ contextPct: 30, unreadInbox: 0, rewakeGuaranteed: false, selfCompactionAvailable: false });
    expect(open.shouldContinue).toBe(true);
    expect(open.guidance).toMatch(/continuation gate OPEN/);
    const guaranteed = evaluateContinuationGate({ contextPct: 80, unreadInbox: 0, rewakeGuaranteed: true, selfCompactionAvailable: false });
    expect(guaranteed.guidance).toMatch(/the next wake re-opens the gate/);
    // the verdict still REPORTS the reading it was given, in both cases
    expect(open.selfCompactionAvailable).toBe(false);
    expect(guaranteed.selfCompactionAvailable).toBe(false);
  });

  it('continuationGateFromReads passes selfCompactionAvailable through to the verdict', () => {
    const base = { contextTokens: 80, compactionLimit: 100, unreadInbox: 0, rewakeGuaranteed: false as const };
    expect(continuationGateFromReads({ ...base, selfCompactionAvailable: false }).selfCompactionAvailable).toBe(false);
    expect(continuationGateFromReads({ ...base, selfCompactionAvailable: true }).selfCompactionAvailable).toBe(true);
    expect(continuationGateFromReads(base).selfCompactionAvailable).toBeNull();
    // and the pass-through actually reaches the guidance, not just the field
    expect(continuationGateFromReads({ ...base, selfCompactionAvailable: false }).guidance).toMatch(/NOT available to this session/);
  });

  it('continuationGateFromReads preserves the standing inbox-wake signal', () => {
    const v = continuationGateFromReads({
      contextTokens: 80,
      compactionLimit: 100,
      unreadInbox: 0,
      rewakeGuaranteed: false,
      activeInboxWakeAwait: true,
    });
    expect(v.activeInboxWakeAwait).toBe(true);
    expect(v.guidance).toContain('active standing coord:inbox-wake await present');
  });
});

describe('isFleetWindDownLoopEndAuthorized (EI-21012758172744411)', () => {
  const fleet = 'drain-fleet';
  const cue = (over: Record<string, unknown> = {}) => ({
    [CUE_AUTHORITY_FIELD]: {
      authority: 'fleet-leader',
      authorityRef: fleet,
      scope: 'fleet-members',
      scopeRef: fleet,
    },
    summary: `Fleet ${fleet} WIND-DOWN — release claims, then loop:end`,
    ...over,
  });
  const authorized = {
    activeClaimPresent: false,
    currentFleet: fleet,
    currentFleetRole: 'member',
    fleetControlState: 'winding-down',
    claimSpecLaneDrained: true,
    cues: [cue()],
  } as const;

  it('POSITIVE: accepts the complete claimless + current-fleet + typed-control + typed-cue tuple', () => {
    expect(isFleetWindDownLoopEndAuthorized(authorized)).toBe(true);
  });

  it('NEGATIVE: a held claim blocks even a valid typed wind-down cue', () => {
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, activeClaimPresent: true })).toBe(false);
  });

  it('NEGATIVE: active control state does not authorize loop:end', () => {
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, fleetControlState: 'active' })).toBe(false);
  });

  it('NEGATIVE: a leader or an unproven lane cannot use the member escape', () => {
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, currentFleetRole: 'leader' })).toBe(false);
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, claimSpecLaneDrained: false })).toBe(false);
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, claimSpecLaneDrained: null })).toBe(false);
  });

  it('NEGATIVE: free text, wrong authority, wrong scope, and wrong fleet are all fail-closed', () => {
    const cases = [
      { cues: [{ summary: 'WIND-DOWN now; loop:end' }] },
      { cues: [cue({ [CUE_AUTHORITY_FIELD]: { authority: 'hive-queen', authorityRef: fleet, scope: 'hive-wide' } })] },
      { cues: [cue({ [CUE_AUTHORITY_FIELD]: { authority: 'fleet-leader', authorityRef: fleet, scope: 'hive-wide' } })] },
      { cues: [cue({ [CUE_AUTHORITY_FIELD]: { authority: 'fleet-leader', authorityRef: 'other-fleet', scope: 'fleet-members', scopeRef: 'other-fleet' } })] },
      { cues: [cue({ summary: 'Fleet drain-fleet WIND-DOWN — release claims' })] },
    ];
    for (const over of cases) {
      expect(isFleetWindDownLoopEndAuthorized({ ...authorized, ...over })).toBe(false);
    }
  });

  it('NEGATIVE: missing membership, control, or cue reads remain denied instead of becoming an implicit allow', () => {
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, currentFleet: null })).toBe(false);
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, fleetControlState: null })).toBe(false);
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, cues: [] })).toBe(false);
    expect(isFleetWindDownLoopEndAuthorized({ ...authorized, cues: null })).toBe(false);
  });

  // ── WI-2034563: the exception must not authorize STRANDING ────────────────
  describe('park resume path (WI-2034563)', () => {
    it('NEGATIVE: a park that publishes a way back withdraws the wake-less authorization', () => {
      // This is the incident in one assertion. The tuple is otherwise perfect — a
      // claimless member, a genuine typed leader cue, a real winding-down fleet — and
      // it is exactly the tuple that let ~23 of 45 members end their only wake source
      // and sit unreachable for hours. When the park expects them back, they must hold
      // the declared gate instead; a member that DOES hold one never reaches this
      // predicate, because the parked-await read upstream already clears the guard.
      expect(isFleetWindDownLoopEndAuthorized({ ...authorized, parkOffersResumePath: true })).toBe(false);
    });

    it('POSITIVE: a terminal/legacy park (no way back) keeps the historical authorization', () => {
      // Load-bearing for rollout: every pre-mig-1065 wind-down resolves to false here,
      // so no fleet parked today is wedged by the rule above.
      expect(isFleetWindDownLoopEndAuthorized({ ...authorized, parkOffersResumePath: false })).toBe(true);
      expect(isFleetWindDownLoopEndAuthorized({ ...authorized, parkOffersResumePath: null })).toBe(true);
      expect(isFleetWindDownLoopEndAuthorized({ ...authorized, parkOffersResumePath: undefined })).toBe(true);
      // Omitting the field entirely is the same reading, which is what keeps every
      // caller that predates this input correct rather than accidentally denied.
      expect(isFleetWindDownLoopEndAuthorized(authorized)).toBe(true);
    });
  });
});

describe('fleet wind-down authorization reaches the critical no-PTY gate only', () => {
  it('POSITIVE: the authorized tuple selects loop:end at the critical threshold', () => {
    const v = evaluateContinuationGate({
      contextPct: CONTEXT_GAUGE_CRITICAL_PCT,
      unreadInbox: 0,
      selfCompactionAvailable: false,
      fleetWindDownLoopEndAuthorized: true,
    });
    expect(v.shouldContinue).toBe(false);
    expect(v.fleetWindDownLoopEndAuthorized).toBe(true);
    expect(v.guidance).toMatch(/AUTHORIZED FLEET WIND-DOWN/);
    expect(v.guidance).toContain('loop:end');
    expect(v.guidance).toContain('do not call session:end or respawn');
  });

  it('NEGATIVE: authorization cannot bypass the critical no-PTY preconditions', () => {
    const warm = evaluateContinuationGate({
      contextPct: CONTEXT_GAUGE_CRITICAL_PCT,
      unreadInbox: 0,
      selfCompactionAvailable: true,
      fleetWindDownLoopEndAuthorized: true,
    });
    const belowCritical = evaluateContinuationGate({
      contextPct: CONTEXT_GAUGE_CRITICAL_PCT - 1,
      unreadInbox: 0,
      selfCompactionAvailable: false,
      fleetWindDownLoopEndAuthorized: true,
    });
    expect(warm.guidance).not.toMatch(/AUTHORIZED FLEET WIND-DOWN/);
    expect(belowCritical.guidance).not.toMatch(/AUTHORIZED FLEET WIND-DOWN/);
  });
});
