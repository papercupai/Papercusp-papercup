import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PICKUP_WINDOW_SEC,
  PICKUP_ESCALATION_SOURCE,
  TURN_PROOF_CONFIRMED,
  TURN_PROOF_STATES,
  UNBINDABLE_BINDING_REASON,
  hostRecoverableCondition,
  initialTurnProof,
  isTurnProof,
  judgeExpiredPickup,
  judgeHostTail,
  pickupHostView,
  pickupWindowSec,
} from './turn-proof';
import { WAKE_TURN_CHANNELS } from './types';

describe('initialTurnProof (P-006/D-004)', () => {
  it('trusts only the executor attestation as proof at booking time', () => {
    expect(initialTurnProof('psu-socket-inject', 'host-attested')).toBe('host-attested');
    expect(initialTurnProof('psu-socket-recycle', 'host-attested')).toBe('host-attested');
  });

  it('books the inbox fallback as awaiting, never as a started turn', () => {
    // The peer-reported defect: degradeToInboxOrDrop returns delivered/inbox, which read back
    // as a clean success although no turn ran.
    expect(initialTurnProof('inbox', undefined)).toBe('awaiting');
  });

  it('books every unattested turn-burning channel as awaiting', () => {
    for (const channel of WAKE_TURN_CHANNELS) {
      expect(initialTurnProof(channel, undefined)).toBe('awaiting');
    }
  });

  it('books content that rides another delivery as superseded, not as a missed pickup', () => {
    expect(initialTurnProof('coalesced', undefined)).toBe('superseded');
    expect(initialTurnProof('suppressed-redundant', undefined)).toBe('superseded');
  });

  it('never yields a state outside the migration 1441 CHECK set', () => {
    for (const channel of [...WAKE_TURN_CHANNELS, 'inbox', 'coalesced', 'suppressed-redundant']) {
      for (const attested of [undefined, 'host-attested'] as const) {
        expect(TURN_PROOF_STATES).toContain(initialTurnProof(channel, attested));
      }
    }
  });
});

describe('turn-proof states', () => {
  it('counts only host-attested and observed as pickup', () => {
    expect([...TURN_PROOF_CONFIRMED].sort()).toEqual(['host-attested', 'observed']);
    expect(TURN_PROOF_CONFIRMED.has('awaiting')).toBe(false);
    expect(TURN_PROOF_CONFIRMED.has('superseded')).toBe(false);
    expect(TURN_PROOF_CONFIRMED.has('not-picked-up')).toBe(false);
  });

  it('recognises exactly the declared states', () => {
    for (const s of TURN_PROOF_STATES) expect(isTurnProof(s)).toBe(true);
    expect(isTurnProof('delivered')).toBe(false);
    expect(isTurnProof(null)).toBe(false);
  });
});

describe('pickupWindowSec', () => {
  it('defaults to the measured 600s window', () => {
    expect(pickupWindowSec({})).toBe(DEFAULT_PICKUP_WINDOW_SEC);
    expect(DEFAULT_PICKUP_WINDOW_SEC).toBe(600);
  });

  it('honours a valid override and clamps it to [30s, 24h]', () => {
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '120' })).toBe(120);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '5' })).toBe(30);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '999999' })).toBe(86_400);
  });

  it('falls back to the default on an unparsable or non-positive value', () => {
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: 'soon' })).toBe(600);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '0' })).toBe(600);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '  ' })).toBe(600);
  });
});

describe('hostRecoverableCondition (D-004 (4) + D-007)', () => {
  const stuck = { repolls: 3, oldestAtMs: 1 };

  it('names auth, quota, an unbound successor and a stuck pending pipeline, in that order', () => {
    expect(hostRecoverableCondition({ authBlocked: true, quotaBlocked: true })).toBe('auth-blocked');
    expect(hostRecoverableCondition({ quotaBlocked: true, unboundSuccessor: true })).toBe('quota-blocked');
    expect(hostRecoverableCondition({ unboundSuccessor: true, stuckPending: stuck })).toBe('unbound-successor');
    expect(hostRecoverableCondition({ stuckPending: stuck })).toBe('pending-turn-stuck');
  });

  it('is null for a healthy host, a bound successor, or no host at all', () => {
    expect(hostRecoverableCondition({ authBlocked: false, quotaBlocked: false })).toBeNull();
    expect(hostRecoverableCondition({ unboundSuccessor: false, stuckPending: null })).toBeNull();
    expect(hostRecoverableCondition(null)).toBeNull();
  });
});

describe('judgeHostTail (D-007: one tail judge for P-006 and P-007)', () => {
  const MIN = 60_000;
  const WINDOW = 10 * MIN;
  const START = 1_000 * MIN;
  const NOW = START + 60 * MIN;
  const at = (min: number) => new Date(START + min * MIN).toISOString();
  const judge = (events: Parameters<typeof judgeHostTail>[0], extra: Partial<Parameters<typeof judgeHostTail>[1]> = {}) =>
    judgeHostTail(events, { hostStartedAtMs: START, nowMs: NOW, pickupWindowMs: WINDOW, ...extra });
  const unbindable = (min: number) => ({
    kind: 'respawn-binding-unconfirmed',
    reason: UNBINDABLE_BINDING_REASON,
    ts: at(min),
  });
  const pending = (min: number) => ({ kind: 'duplicate-delivery-id', state: 'pending', ts: at(min) });

  it('reads an unconfirmed binding as unbound ONLY for the unbindable reason', () => {
    expect(judge([unbindable(1)]).unboundSuccessor).toBe(true);
    // A binding WAIT that ended (superseded, re-anchor) is not a child without an identity:
    // measured, hosts carrying these reasons ran 95-245 tool calls an hour.
    for (const reason of ['superseded', 'successor-reanchor-unconfirmed', undefined]) {
      expect(judge([{ kind: 'respawn-binding-unconfirmed', reason, ts: at(1) }]).unboundSuccessor).toBe(false);
    }
  });

  it('reads a host refusal of an unbindable child as unbound', () => {
    expect(judge([{ kind: 'successor-unbindable-refused', ts: at(2) }]).unboundSuccessor).toBe(true);
  });

  it('lets a later confirmed binding or a delivered turn clear an unbound verdict (newest wins)', () => {
    expect(judge([unbindable(1), { kind: 'respawn-binding-confirmed', ts: at(2) }]).unboundSuccessor).toBe(false);
    expect(judge([unbindable(1), { kind: 'respawn-carry-delivered', ts: at(2) }]).unboundSuccessor).toBe(false);
    // The host refuses every turn to an unbindable child (P-005(c)), so a delivered turn proves
    // the child was bindable after all.
    expect(judge([unbindable(1), { kind: 'turn-delivered', ts: at(2) }]).unboundSuccessor).toBe(false);
    expect(judge([{ kind: 'turn-delivered', ts: at(1) }, unbindable(2)]).unboundSuccessor).toBe(true);
  });

  it('ignores events from a predecessor host process (the tail file is per owner)', () => {
    const predecessor = { kind: 'respawn-binding-unconfirmed', reason: UNBINDABLE_BINDING_REASON, ts: at(-5) };
    expect(judge([predecessor]).unboundSuccessor).toBe(false);
    // With no known start every timed event counts.
    expect(judge([predecessor], { hostStartedAtMs: null }).unboundSuccessor).toBe(true);
  });

  it('ignores events without a usable timestamp', () => {
    expect(judge([{ kind: 'successor-unbindable-refused' }]).unboundSuccessor).toBe(false);
    expect(judge([{ kind: 'successor-unbindable-refused', ts: 'not a date' }]).unboundSuccessor).toBe(false);
  });

  it('reports a stuck pending pipeline after >=2 re-polls past the window with no turn since', () => {
    expect(judge([pending(5), pending(20), pending(40)]).stuckPending).toEqual({
      repolls: 3,
      oldestAtMs: START + 5 * MIN,
    });
  });

  it('does not report one pending sighting: a busy host pends a mid-turn wake routinely', () => {
    expect(judge([pending(5)]).stuckPending).toBeNull();
  });

  it('does not report pending re-polls still inside the pickup window', () => {
    expect(judge([pending(55), pending(58)]).stuckPending).toBeNull();
  });

  it('resets pending state on a delivered turn', () => {
    expect(judge([pending(5), pending(10), { kind: 'turn-delivered', ts: at(12) }]).stuckPending).toBeNull();
    // Re-polls after the turn start a new count from the newer oldest.
    expect(judge([pending(5), { kind: 'turn-delivered', ts: at(12) }, pending(20), pending(30)]).stuckPending).toEqual({
      repolls: 2,
      oldestAtMs: START + 20 * MIN,
    });
  });

  it('only counts duplicate-delivery-id events whose state is pending', () => {
    const delivered = (min: number) => ({ kind: 'duplicate-delivery-id', state: 'delivered', ts: at(min) });
    expect(judge([delivered(5), delivered(10), delivered(20)]).stuckPending).toBeNull();
  });

  it('counts pending loop-origin lifecycle deliveries but excludes unrelated carry-respawns and controls', () => {
    const pendingMode = (min: number, mode: string) => ({ ...pending(min), mode });
    // The measured false alarm (P-012, su-ef6886ef): two pending carry-respawn deliveries closed by
    // respawn-carry-dropped; the host's first wake turn was delivered on poll 1.
    const carryTail = [
      pendingMode(5, 'carry-respawn'),
      pendingMode(6, 'carry-respawn'),
      { kind: 'busy-gate-expired', mode: 'carry-respawn', ts: at(8) },
      { kind: 'respawn-carry-dropped', reason: 'superseded', rearmed: true, ts: at(8) },
    ];
    expect(judge(carryTail).stuckPending).toBeNull();
    for (const mode of ['reset', 'recycle', 'mcp-reconnect', 'shutdown']) {
      expect(judge([pendingMode(5, mode), pendingMode(20, mode), pendingMode(40, mode)]).stuckPending).toBeNull();
    }
    // A cold loop fire may travel through a lifecycle mode, but its routineId ties the pending
    // host receipt to the turn that must follow it. Count those retries for every cold transport.
    for (const mode of ['carry-respawn', 'reset', 'recycle']) {
      const loopPending = [5, 20, 40].map((min) => ({
        ...pendingMode(min, mode), routineId: 'rt-loop-cold', fireNumber: 15,
      }));
      expect(judge(loopPending).stuckPending).toEqual({ repolls: 3, oldestAtMs: START + 5 * MIN });
    }
    // Explicit turn deliveries still report; so does a tail predating the mode stamp (no mode).
    expect(judge([pendingMode(5, 'turn'), pendingMode(20, 'turn')]).stuckPending).toEqual({
      repolls: 2,
      oldestAtMs: START + 5 * MIN,
    });
    expect(judge([pending(5), pending(20)]).stuckPending).not.toBeNull();
    // A mixed tail counts only its turn re-polls (and their oldest).
    expect(judge([pendingMode(3, 'carry-respawn'), pendingMode(5, 'turn'), pendingMode(20, 'turn')]).stuckPending).toEqual({
      repolls: 2,
      oldestAtMs: START + 5 * MIN,
    });
  });

  it('does not report a visibly busy host: running with progress, or writing output, inside the window', () => {
    const tail = [pending(5), pending(20), pending(40)];
    expect(judge(tail, { execution: { phase: 'running', lastProgressAt: NOW - MIN } }).stuckPending).toBeNull();
    // A bridged (interactive) host publishes no execution observation; its terminal output is the signal.
    expect(judge(tail, { lastOutputAtMs: NOW - MIN }).stuckPending).toBeNull();
    // Stale progress or stale output does not exempt it.
    expect(judge(tail, { execution: { phase: 'running', lastProgressAt: NOW - 42 * MIN } }).stuckPending).not.toBeNull();
    expect(judge(tail, { lastOutputAtMs: NOW - 42 * MIN }).stuckPending).not.toBeNull();
    // Progress without a running phase is not busy.
    expect(judge(tail, { execution: { phase: 'settled', lastProgressAt: NOW - MIN } }).stuckPending).not.toBeNull();
  });
});

describe('pickupHostView', () => {
  it('builds the judge view from the discovery record, anchored to the host start', () => {
    const now = 10_000_000;
    const view = pickupHostView(
      { startedAt: now - 5_000, authBlocked: false, quotaBlocked: true, execution: { phase: 'settled' } },
      [
        { kind: 'successor-unbindable-refused', ts: now - 60_000 },
        { kind: 'successor-unbindable-refused', ts: now - 1_000 },
      ],
      now,
      600_000,
    );
    expect(view).toEqual({
      execution: { phase: 'settled' },
      authBlocked: false,
      quotaBlocked: true,
      unboundSuccessor: true,
      stuckPending: null,
    });
  });

  it('sees no unbound successor when every event predates the current host', () => {
    const now = 10_000_000;
    const view = pickupHostView({ startedAt: now - 5_000 }, [{ kind: 'successor-unbindable-refused', ts: now - 60_000 }], now, 600_000);
    expect(view.unboundSuccessor).toBe(false);
    expect(view.execution).toBeNull();
  });
});

describe('judgeExpiredPickup (P-006 slice 2)', () => {
  const DELIVERED = 1_000_000;
  const psu = { deliveredAtMs: DELIVERED, channel: 'psu-socket-inject', source: null };

  it('counts a host turn start AFTER delivery as observed', () => {
    const v = judgeExpiredPickup(psu, { execution: { phase: 'running', turnStartedAt: DELIVERED + 5_000 } });
    expect(v).toEqual({ proof: 'observed', turnStartedAtMs: DELIVERED + 5_000, via: 'host-turn-start' });
  });

  it('never counts a turn that started BEFORE (or at) delivery', () => {
    for (const t of [DELIVERED - 1, DELIVERED]) {
      const v = judgeExpiredPickup(psu, { execution: { phase: 'running', turnStartedAt: t } });
      expect(v.proof).toBe('not-picked-up');
    }
  });

  it('never counts a failed turn or a turn on a blocked host as a pickup', () => {
    // A codex child whose login cannot refresh starts a turn that fails at once.
    const failed = judgeExpiredPickup(psu, { execution: { phase: 'failed', turnStartedAt: DELIVERED + 1 } });
    expect(failed.proof).toBe('not-picked-up');
    const blocked = judgeExpiredPickup(psu, {
      authBlocked: true,
      execution: { phase: 'settled', turnStartedAt: DELIVERED + 1 },
    });
    expect(blocked).toMatchObject({ proof: 'not-picked-up', escalate: true, recoverable: 'auth-blocked' });
  });

  it('escalates a turn-starting channel once when the host reports a recoverable condition', () => {
    expect(judgeExpiredPickup(psu, { quotaBlocked: true })).toMatchObject({ escalate: true, recoverable: 'quota-blocked' });
    expect(judgeExpiredPickup(psu, { unboundSuccessor: true })).toMatchObject({
      escalate: true,
      recoverable: 'unbound-successor',
    });
  });

  it('reports a pending-turn-stuck host without escalating: a re-queue would pend behind the stalled turn (D-007)', () => {
    const v = judgeExpiredPickup(psu, { stuckPending: { repolls: 4, oldestAtMs: DELIVERED } });
    expect(v).toMatchObject({ proof: 'not-picked-up', escalate: false, recoverable: 'pending-turn-stuck' });
    expect((v as { reason: string }).reason).toMatch(/P-012/);
  });

  it('never counts a host turn start as a pickup while the host pipeline is stuck', () => {
    const v = judgeExpiredPickup(psu, {
      stuckPending: { repolls: 2, oldestAtMs: DELIVERED },
      execution: { phase: 'running', turnStartedAt: DELIVERED + 5_000 },
    });
    expect(v.proof).toBe('not-picked-up');
  });

  it('never escalates a re-queue again (bounded to ONE)', () => {
    const v = judgeExpiredPickup({ ...psu, source: PICKUP_ESCALATION_SOURCE }, { authBlocked: true });
    expect(v).toMatchObject({ proof: 'not-picked-up', escalate: false });
  });

  it('reports inbox and other non-turn channels without escalating (D-002)', () => {
    for (const channel of ['inbox', 'coalesced', null]) {
      const v = judgeExpiredPickup({ ...psu, channel }, { authBlocked: true });
      expect(v).toMatchObject({ proof: 'not-picked-up', escalate: false });
    }
  });

  it('every turn-burning channel is escalatable, so a new turn channel cannot be silently excluded', () => {
    for (const channel of WAKE_TURN_CHANNELS) {
      expect(judgeExpiredPickup({ ...psu, channel }, { authBlocked: true }).proof).toBe('not-picked-up');
      expect(judgeExpiredPickup({ ...psu, channel }, { authBlocked: true })).toMatchObject({ escalate: true });
    }
  });

  it('does not escalate without a live host or without a recoverable condition', () => {
    expect(judgeExpiredPickup(psu, null)).toMatchObject({ escalate: false, recoverable: null });
    expect(judgeExpiredPickup(psu, { execution: { phase: 'settled', turnStartedAt: DELIVERED - 10 } })).toMatchObject({
      escalate: false,
      recoverable: null,
    });
  });
});
