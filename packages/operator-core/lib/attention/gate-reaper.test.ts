/**
 * Guards the session-independent gate close path (WI-10002067).
 *
 * The rule this suite exists to protect is the NEGATIVE one: an asker that is
 * merely invisible must NOT be reaped. Every liveness surface TTL-reaps, so on
 * the measured population all 198 askers holding an open gate had no presence
 * row and 149 had no adv_sessions row either — an "invisible ⇒ gone" predicate
 * would close a live session's gate as soon as its presence row aged out.
 *
 * A test asserting something does NOT happen passes against a do-nothing
 * mutant, so `naiveAbsenceMeansGone` below is kept permanently as a control:
 * it is the wrong implementation, and the suite asserts the real function
 * disagrees with it exactly where the rail lives. Without that, the safety
 * assertions could all be vacuous and look identical to real coverage.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNKNOWN_GONE_AFTER_MS,
  decideGateReap,
  type AskerLiveness,
  type GateReapDecision,
  type GateReapInput,
} from './gate-reaper';

const NOW = new Date('2026-09-20T16:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function input(over: Partial<GateReapInput> = {}): GateReapInput {
  return {
    now: NOW,
    openedAt: new Date(NOW.getTime() - 30 * DAY),
    closedAt: null,
    decideBy: null,
    defaultIfUnanswered: null,
    askerLiveness: 'unknown',
    ...over,
  };
}

/** THE WRONG IMPLEMENTATION — kept as a control, never exported. */
function naiveAbsenceMeansGone(i: GateReapInput): GateReapDecision {
  if (i.closedAt !== null) return { close: false, why: 'already-closed' };
  if (i.askerLiveness === 'live') return { close: false, why: 'asker-live' };
  return { close: true, reason: 'asker_gone', disposition: null };
}

describe('decideGateReap — never reopens a terminal gate', () => {
  it('refuses an already-closed gate even when every close rule would otherwise fire', () => {
    const d = decideGateReap(
      input({
        closedAt: new Date(NOW.getTime() - DAY),
        decideBy: new Date(NOW.getTime() - DAY),
        askerLiveness: 'ended',
      }),
    );
    expect(d).toEqual({ close: false, why: 'already-closed' });
  });
});

describe('decideGateReap — decide_by / default_applied', () => {
  it('applies the declared default once the deadline has passed', () => {
    const d = decideGateReap(
      input({ decideBy: new Date(NOW.getTime() - 1), defaultIfUnanswered: { choice: 'deny' } }),
    );
    expect(d).toEqual({ close: true, reason: 'default_applied', disposition: { choice: 'deny' } });
  });

  it('treats a null default as "expire it, with no default to apply" rather than skipping', () => {
    const d = decideGateReap(input({ decideBy: new Date(NOW.getTime() - 1), defaultIfUnanswered: null }));
    expect(d).toEqual({ close: true, reason: 'default_applied', disposition: null });
  });

  it('closes exactly AT the deadline (>=, not >)', () => {
    const d = decideGateReap(input({ decideBy: NOW, askerLiveness: 'live' }));
    expect(d).toMatchObject({ close: true, reason: 'default_applied' });
  });

  it('honours a passed deadline even for a LIVE asker — the deadline is the asker own contract', () => {
    const d = decideGateReap(input({ decideBy: new Date(NOW.getTime() - DAY), askerLiveness: 'live' }));
    expect(d).toMatchObject({ close: true, reason: 'default_applied' });
  });

  it('prefers default_applied over asker_gone when both would fire', () => {
    const d = decideGateReap(input({ decideBy: new Date(NOW.getTime() - DAY), askerLiveness: 'ended' }));
    expect(d).toMatchObject({ close: true, reason: 'default_applied' });
  });

  it('does not let an UNREACHED deadline keep a dead asker gate open', () => {
    // The asker died before its own deadline: still unreachable, still reaped.
    const d = decideGateReap(input({ decideBy: new Date(NOW.getTime() + DAY), askerLiveness: 'ended' }));
    expect(d).toMatchObject({ close: true, reason: 'asker_gone' });
  });

  it('leaves a NULL decide_by untouched by the deadline rule', () => {
    const d = decideGateReap(input({ decideBy: null, askerLiveness: 'live' }));
    expect(d).toEqual({ close: false, why: 'asker-live' });
  });
});

describe('decideGateReap — asker liveness', () => {
  it('reaps an affirmatively ended asker', () => {
    const d = decideGateReap(input({ askerLiveness: 'ended', openedAt: new Date(NOW.getTime() - 60_000) }));
    expect(d).toEqual({ close: true, reason: 'asker_gone', disposition: null });
  });

  it('NEVER reaps a live asker, however old the gate', () => {
    const d = decideGateReap(input({ askerLiveness: 'live', openedAt: new Date(NOW.getTime() - 400 * DAY) }));
    expect(d).toEqual({ close: false, why: 'asker-live' });
  });
});

describe('decideGateReap — the unknown-asker safety rail', () => {
  it('does NOT reap an unknown asker inside the grace window', () => {
    const d = decideGateReap(input({ askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - 2 * DAY) }));
    expect(d).toEqual({ close: false, why: 'asker-unknown-within-grace' });
  });

  it('reaps an unknown asker once the gate clears the age floor', () => {
    const d = decideGateReap(
      input({ askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - DEFAULT_UNKNOWN_GONE_AFTER_MS - 1) }),
    );
    expect(d).toEqual({ close: true, reason: 'asker_gone', disposition: null });
  });

  it('closes exactly AT the age floor (>=, not >)', () => {
    const d = decideGateReap(
      input({ askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - DEFAULT_UNKNOWN_GONE_AFTER_MS) }),
    );
    expect(d).toMatchObject({ close: true, reason: 'asker_gone' });
  });

  it('honours a caller-supplied floor on both sides of the boundary', () => {
    const floor = 3 * DAY;
    const within = decideGateReap(
      input({ askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - 2 * DAY), unknownGoneAfterMs: floor }),
    );
    const past = decideGateReap(
      input({ askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - 4 * DAY), unknownGoneAfterMs: floor }),
    );
    expect(within).toEqual({ close: false, why: 'asker-unknown-within-grace' });
    expect(past).toMatchObject({ close: true, reason: 'asker_gone' });
  });
});

describe('decideGateReap — suppressed_ask outlives its declaring session (WI-10005039)', () => {
  // A suppressed ask is the "DO NOT ask the owner a 4th time" population: the agent registered it
  // PRECISELY so the owner would see it after the agent is gone. Closing it as asker_gone would
  // delete the very ask the kind exists to keep.
  it('does NOT reap a suppressed_ask whose asker has ended, however old', () => {
    const d = decideGateReap(input({ kind: 'suppressed_ask', askerLiveness: 'ended', openedAt: new Date(NOW.getTime() - 400 * DAY) }));
    expect(d).toEqual({ close: false, why: 'suppressed-awaiting-owner' });
  });

  it('does NOT reap a suppressed_ask whose asker is unknown past the age floor', () => {
    const d = decideGateReap(
      input({ kind: 'suppressed_ask', askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - DEFAULT_UNKNOWN_GONE_AFTER_MS - 1) }),
    );
    expect(d).toEqual({ close: false, why: 'suppressed-awaiting-owner' });
  });

  it('still applies the declared default once its own deadline passes', () => {
    const d = decideGateReap(
      input({
        kind: 'suppressed_ask',
        askerLiveness: 'ended',
        decideBy: new Date(NOW.getTime() - 1),
        defaultIfUnanswered: { choice: 'proceed-with-recommended' },
      }),
    );
    expect(d).toEqual({ close: true, reason: 'default_applied', disposition: { choice: 'proceed-with-recommended' } });
  });

  it('holds a suppressed_ask open BEFORE its deadline even with an ended asker', () => {
    const d = decideGateReap(
      input({ kind: 'suppressed_ask', askerLiveness: 'ended', decideBy: new Date(NOW.getTime() + DAY) }),
    );
    expect(d).toEqual({ close: false, why: 'suppressed-awaiting-owner' });
  });

  it('never reopens a closed suppressed_ask', () => {
    const d = decideGateReap(input({ kind: 'suppressed_ask', closedAt: new Date(NOW.getTime() - DAY) }));
    expect(d).toEqual({ close: false, why: 'already-closed' });
  });

  it('CONTROL: a plain session-bound ask with the same ended asker IS still reaped', () => {
    // If this ever stops closing, the suppressed_ask assertions above would pass vacuously
    // (e.g. a do-nothing reaper) — so pin both sides.
    for (const kind of [undefined, 'ask'] as const) {
      const d = decideGateReap(input({ ...(kind ? { kind } : {}), askerLiveness: 'ended', openedAt: new Date(NOW.getTime() - 60_000) }));
      expect(d).toEqual({ close: true, reason: 'asker_gone', disposition: null });
    }
  });
});

describe('control: the rail is real, not vacuous', () => {
  const withinGrace = input({ askerLiveness: 'unknown', openedAt: new Date(NOW.getTime() - 2 * DAY) });

  it('the naive "invisible means gone" implementation WOULD close the protected gate', () => {
    // Calibration: if this ever stops closing, the control has drifted and the
    // disagreement assertion below would pass for the wrong reason.
    expect(naiveAbsenceMeansGone(withinGrace)).toMatchObject({ close: true, reason: 'asker_gone' });
  });

  it('the real implementation disagrees with it exactly there', () => {
    expect(decideGateReap(withinGrace).close).toBe(false);
    expect(naiveAbsenceMeansGone(withinGrace).close).toBe(true);
  });

  it('but the two AGREE wherever no rail is involved', () => {
    for (const askerLiveness of ['live', 'ended'] as AskerLiveness[]) {
      const i = input({ askerLiveness, openedAt: new Date(NOW.getTime() - 30 * DAY) });
      expect(decideGateReap(i).close).toBe(naiveAbsenceMeansGone(i).close);
    }
  });
});
