/**
 * Unit tests for the PURE surface of gate-ownership.ts (P-004 /
 * `gate-ownership-condition-singleton-2026-08-03`).
 *
 * The read path is exercised through an injected `findConditionObjects`, so this
 * suite needs no database — the parts worth pinning are the event-key choice and
 * the fail-soft behavior, both of which are silent-failure-shaped if they rot.
 */
import { describe, it, expect } from 'vitest';
import {
  gateStallConditionKey,
  gateRedStreakConditionKey,
  assessGateOwnership,
  toCellOwnership,
  unownedCell,
  unmeasuredCell,
  ownershipContradicted,
  ownershipNeedsLivenessConfirmation,
  ownershipHeldByLiveHolder,
  shouldStandDownForLivePeer,
  readGateOwnership,
} from './gate-ownership';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { CRITICAL_CLAIM_PROGRESS_LEASE_MS } from '../agent-tools/work_items/release-force-guard';
import { noSubjectThread, silentThread, unmeasuredThread } from './cell-thread';
import type { ConditionObject } from './condition-object';

const OWNERSHIP_NOW_MS = 1_800_000_000_000;
const ownershipAtAge = (ageMs: number): string => new Date(OWNERSHIP_NOW_MS - ageMs).toISOString();

/** An injected presence oracle returning one verdict for one owner. */
function oracle(sessionState: string) {
  return (async (subjects: readonly { ownerId: string }[]) =>
    new Map(subjects.map((s) => [s.ownerId, { ownerId: s.ownerId, sessionState }]))) as never;
}

function mkObj(over: Partial<ConditionObject> = {}): ConditionObject {
  return {
    conditionKey: 'green-stall:papercusp',
    workItem: 'WI-1234',
    title: 'green-checkpoint STALLED',
    claimState: 'claimable',
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    duplicates: [],
    ...over,
  };
}

describe('gateStallConditionKey', () => {
  // REGRESSION GUARD (D-012). `green-stall:` and `main-behind-staging:` both read
  // as "the pipeline is stalled" in English and are declared MUTUAL FALSIFIERS —
  // pointing the gate cell at the wrong one attaches ownership to the other cell's
  // incident, which no type would catch.
  it('is the green-checkpoint stall key, NOT the main-behind-staging key', () => {
    expect(gateStallConditionKey('papercusp')).toBe('green-stall:papercusp');
    expect(gateStallConditionKey('papercusp')).not.toContain('main-behind');
  });

  it('is slug-suffixed, so a non-default harness gets its own key', () => {
    expect(gateStallConditionKey('oddsmith')).toBe('green-stall:oddsmith');
  });
});

describe('toCellOwnership', () => {
  it('renames conditionKey to eventKey and carries the lease through', () => {
    const own = toCellOwnership(mkObj({
      claimState: 'held',
      takenBy: 'su-abc',
      takenAt: 'T1',
      lastProgressAt: 'P1',
      expiresAt: 'T2',
    }));
    expect(own).toEqual({
      assessment: 'held-needs-confirmation',
      eventKey: 'green-stall:papercusp',
      workItem: 'WI-1234',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-abc',
      takenAt: 'T1',
      lastProgressAt: 'P1',
      expiresAt: 'T2',
      holderSessionState: null,
      duplicates: [],
      // P-006. The PURE projection does not read a thread — it defaults to an
      // explicit "not read on this projection" rather than a fabricated empty
      // one, so a caller that forgets to pass a thread cannot silently publish
      // "nobody has commented".
      thread: noSubjectThread('thread not read on this projection'),
    });
  });

  it('projects an expired shared progress lease as stalled for a positively-live holder', () => {
    const own = toCellOwnership(
      mkObj({
        claimState: 'held',
        takenBy: 'su-abc',
        takenAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        expiresAt: new Date(OWNERSHIP_NOW_MS - 1).toISOString(),
      }),
      'recorded',
      noSubjectThread('test thread'),
      OWNERSHIP_NOW_MS,
    );
    expect(own.assessment).toBe('held-stalled');
  });

  it('respects the effective lease extended by the holder’s pending gate-run wait', () => {
    const own = toCellOwnership(
      mkObj({
        claimState: 'held',
        takenBy: 'su-abc',
        takenAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        // condition-object has already bounded this expiry to the matching pending wait.
        expiresAt: new Date(OWNERSHIP_NOW_MS + 60 * 60_000).toISOString(),
      }),
      'live',
      noSubjectThread('test thread'),
      OWNERSHIP_NOW_MS,
    );
    expect(own.assessment).toBe('held-live');
    expect(shouldStandDownForLivePeer(own, 'su-caller')).toBe(true);
  });

  it('projects a reclaimed gate item as held before its first new progress checkpoint', () => {
    const own = toCellOwnership(
      mkObj({
        claimState: 'held',
        takenBy: 'su-abc',
        takenAt: ownershipAtAge(3 * 60_000),
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
      }),
      'live',
      noSubjectThread('test thread'),
      OWNERSHIP_NOW_MS,
    );
    expect(own.assessment).toBe('held-live');
  });

  // The distinction that earns the enum: both states have a non-null takenBy, so a
  // caller null-testing takenBy reports a dead agent's abandoned lease as live
  // ownership — which suppresses the next agent from picking the work up.
  it('distinguishes held from lease-expired even though BOTH have a takenBy', () => {
    const held = toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-abc' }));
    const expired = toCellOwnership(mkObj({ claimState: 'lease-expired', takenBy: 'su-abc' }));
    expect(held.takenBy).toBe(expired.takenBy);
    expect(held.claimState).not.toBe(expired.claimState);
  });

  it('surfaces duplicates rather than hiding them behind the canonical row', () => {
    expect(toCellOwnership(mkObj({ duplicates: ['WI-2', 'WI-3'] })).duplicates).toEqual(['WI-2', 'WI-3']);
  });
});

describe('gate ownership assessment truth table', () => {
  it.each<[string, Parameters<typeof assessGateOwnership>[0], ReturnType<typeof assessGateOwnership>]>([
    ['unread claim', { claimState: null, holderSessionState: null, duplicates: [] }, null],
    [
      'duplicates outrank canonical row',
      {
        claimState: 'held',
        holderSessionState: 'live',
        duplicates: ['WI-2'],
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'duplicate-owners',
    ],
    ['no object', { claimState: 'no-object', holderSessionState: null, duplicates: [] }, 'unowned'],
    ['claimable', { claimState: 'claimable', holderSessionState: null, duplicates: [] }, 'claimable'],
    ['hold-blocked', { claimState: 'hold-blocked', holderSessionState: null, duplicates: [] }, 'hold-blocked'],
    ['expired', { claimState: 'lease-expired', holderSessionState: 'ended', duplicates: [] }, 'lease-expired'],
    ['live', { claimState: 'held', holderSessionState: 'live', duplicates: [] }, 'held-live'],
    [
      'live with expired item progress',
      {
        claimState: 'held',
        holderSessionState: 'live',
        duplicates: [],
        takenAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'held-stalled',
    ],
    ['parked', { claimState: 'held', holderSessionState: 'parked', duplicates: [] }, 'held-live'],
    ['recorded', { claimState: 'held', holderSessionState: 'recorded', duplicates: [] }, 'held-live'],
    [
      'parked with expired item progress',
      {
        claimState: 'held',
        holderSessionState: 'parked',
        duplicates: [],
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'held-stalled',
    ],
    [
      'recorded with expired item progress',
      {
        claimState: 'held',
        holderSessionState: 'recorded',
        duplicates: [],
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'held-stalled',
    ],
    ['draining', { claimState: 'held', holderSessionState: 'draining', duplicates: [] }, 'held-needs-confirmation'],
    ['suspect', { claimState: 'held', holderSessionState: 'suspect', duplicates: [] }, 'held-needs-confirmation'],
    [
      'draining despite expired item progress',
      {
        claimState: 'held',
        holderSessionState: 'draining',
        duplicates: [],
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'held-needs-confirmation',
    ],
    [
      'suspect despite expired item progress',
      {
        claimState: 'held',
        holderSessionState: 'suspect',
        duplicates: [],
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'held-needs-confirmation',
    ],
    ['oracle unread', { claimState: 'held', holderSessionState: null, duplicates: [] }, 'held-needs-confirmation'],
    [
      'ended despite expired item progress',
      {
        claimState: 'held',
        holderSessionState: 'ended',
        duplicates: [],
        lastProgressAt: ownershipAtAge(CRITICAL_CLAIM_PROGRESS_LEASE_MS + 1),
        nowMs: OWNERSHIP_NOW_MS,
      },
      'held-by-ended-session',
    ],
  ])('%s → %s', (_label, input, expected) => {
    expect(assessGateOwnership(input)).toBe(expected);
  });
});

describe('unownedCell vs unmeasuredCell', () => {
  it('unowned is a MEASURED no-object with no unknown attached', () => {
    expect(unownedCell('green-stall:x')).toEqual({
      assessment: 'unowned',
      eventKey: 'green-stall:x',
      workItem: null,
      claimState: 'no-object',
      unknown: null,
      takenBy: null,
      takenAt: null,
      lastProgressAt: null,
      expiresAt: null,
      holderSessionState: null,
      duplicates: [],
      // P-006: nothing owns the condition ⇒ there is no thread to have.
      thread: noSubjectThread('no work-item owns this condition, so there is no thread to read'),
    });
  });

  // REGRESSION GUARD. P-004 shipped these as the SAME value, so an unreachable
  // store rendered as the reassuring "nobody owns this red — go file one".
  it('unmeasured is NOT no-object — a failed read never reads as an empty one', () => {
    const u = unmeasuredCell('green-stall:x', 'pg down');
    expect(u.claimState).toBeNull();
    expect(u.claimState).not.toBe('no-object');
    expect(u.unknown).toEqual({ code: 'resolver-failed', detail: 'pg down' });
  });
});

describe('ownershipContradicted (the P-005 falsifier verdict)', () => {
  it('fires when a HELD lease is contradicted by a dead holder', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), 'ended') };
    expect(ownershipContradicted(own)).toBe(true);
  });

  it('does NOT fire for a parked holder — parked is alive and will wake', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), 'parked') };
    expect(ownershipContradicted(own)).toBe(false);
  });

  /**
   * REGRESSION GUARD (P-007). `ownershipContradicted` shipped in P-005 counting
   * `recorded` as a dead holder. It is the opposite: the oracle classifies
   * `recorded` BEFORE the heartbeat/pid path expressly so it is never
   * force-ended — it means authoritatively ALIVE per the session log, merely not
   * inbox-wake-dispatchable, and it covers every console/autonomous agent plus
   * any session in its launch→first-await window.
   *
   * The bug direction is what makes it worth pinning: the falsifier exists to stop
   * a dead holder reading as live ownership, and it did the reverse — reported a
   * LIVE holder as an abandoned claim, which invites taking work off an agent
   * actively doing it. The P-005 suite tested only `ended` and `parked`, so
   * nothing caught it. This enumerates ALL SIX states so a future addition to
   * `SessionState` cannot slip through the same gap.
   */
  it('does NOT fire for a `recorded` holder — recorded means ALIVE, not dead', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), 'recorded') };
    expect(ownershipContradicted(own)).toBe(false);
  });

  it('classifies every SessionState exactly once, with `ended` the only contradiction', () => {
    const verdicts = (['live', 'parked', 'draining', 'suspect', 'ended', 'recorded'] as const).map(
      (s) => [s, ownershipContradicted({ ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), s) })] as const,
    );
    expect(Object.fromEntries(verdicts)).toEqual({
      live: false,
      parked: false,
      draining: false, // ambiguous — confirm, do not conclude
      suspect: false, // ambiguous — confirm, do not conclude
      recorded: false, // ALIVE (session-log authority)
      ended: true, // the ONLY confirmed dead-holder verdict
    });
  });

  it('routes the two AMBIGUOUS states to a confirmation verdict instead of a conclusion', () => {
    const at = (s: SessionState) =>
      ownershipNeedsLivenessConfirmation({ ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), s) });
    expect(at('draining')).toBe(true);
    expect(at('suspect')).toBe(true);
    expect(at('live')).toBe(false);
    expect(at('recorded')).toBe(false);
    expect(at('ended')).toBe(false);
    // No verdict to judge ⇒ null, never a boolean guess.
    expect(ownershipNeedsLivenessConfirmation(unownedCell('green-stall:x'))).toBeNull();
    expect(
      ownershipNeedsLivenessConfirmation({ ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), null) }),
    ).toBeNull();
  });

  it('does NOT fire when the oracle could not answer (null is no contradiction)', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), null) };
    expect(ownershipContradicted(own)).toBe(false);
  });

  it('does not fire for a lease that already expired — that is not a contradiction', () => {
    const own = { ...toCellOwnership(mkObj({ claimState: 'lease-expired', takenBy: 'su-x' }), 'ended') };
    expect(ownershipContradicted(own)).toBe(false);
  });
});

/**
 * P-007's rail (`release:checkpoint-run` stands down for a live peer) branches on
 * THIS predicate, so its failure direction is the one to pin: a false `true` wedges
 * the fleet's only manual verdict lever, which is far worse than a false `false`
 * (one redundant suite — the status quo before the rail existed).
 *
 * Enumerated over all six states for the same reason as the contradiction map
 * above: the P-005 bug survived because a suite tested the cases its author had in
 * mind rather than the whole domain.
 */
describe('ownershipHeldByLiveHolder (the P-007 coordination verdict)', () => {
  const at = (s: SessionState | null) =>
    ownershipHeldByLiveHolder({ ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), s) });

  it('classifies every SessionState exactly once — the three ALIVE states, and only those', () => {
    const verdicts = (['live', 'parked', 'draining', 'suspect', 'ended', 'recorded'] as const).map(
      (s) => [s, at(s)] as const,
    );
    expect(Object.fromEntries(verdicts)).toEqual({
      live: true,
      parked: true, // alive, merely idle between turns
      recorded: true, // ALIVE per the session log — excluding it would re-run the P-005 bug here
      draining: false, // ambiguous — never enough to block a peer's gate run
      suspect: false, // ambiguous
      ended: false, // a dead holder must never wedge the gate
    });
  });

  it('is false when the oracle could not answer — stands down only on POSITIVE evidence', () => {
    expect(at(null)).toBe(false);
  });

  it('is false when nothing holds the condition, and for a merely-expired lease', () => {
    expect(ownershipHeldByLiveHolder(unownedCell('green-stall:papercusp'))).toBe(false);
    expect(
      ownershipHeldByLiveHolder({
        ...toCellOwnership(mkObj({ claimState: 'lease-expired', takenBy: 'su-x' }), 'live'),
      }),
    ).toBe(false);
  });

  it('is false on an UNMEASURED cell — an unreadable store must not refuse the run', () => {
    expect(ownershipHeldByLiveHolder(unmeasuredCell('green-stall:papercusp', 'store down'))).toBe(false);
  });

  it('is disjoint from the other two verdicts — no state is both live and dead/ambiguous', () => {
    for (const s of ['live', 'parked', 'draining', 'suspect', 'ended', 'recorded'] as const) {
      const own = { ...toCellOwnership(mkObj({ claimState: 'held', takenBy: 'su-x' }), s) };
      const live = ownershipHeldByLiveHolder(own);
      const dead = ownershipContradicted(own);
      const ambiguous = ownershipNeedsLivenessConfirmation(own) === true;
      expect([live, dead, ambiguous].filter(Boolean).length, `${s} must land in exactly one bucket`).toBe(1);
    }
  });
});

/**
 * P-007's actual decision. Pinned separately from the liveness predicate because
 * its failure mode is different in kind: `ownershipHeldByLiveHolder` being wrong
 * misreports a fact, whereas this being wrong REFUSES THE FLEET'S ONLY MANUAL
 * VERDICT LEVER. Every clause must fail open.
 */
describe('shouldStandDownForLivePeer (the P-007 rail decision)', () => {
  const held = (over: { state?: SessionState | null; takenBy?: string | null } = {}) => ({
    ...toCellOwnership(
      mkObj({ claimState: 'held', takenBy: over.takenBy === undefined ? 'su-peer' : over.takenBy }),
      over.state === undefined ? 'live' : over.state,
    ),
  });

  it('stands down for a LIVE peer who is not the caller — the case the rail exists for', () => {
    expect(shouldStandDownForLivePeer(held(), 'su-me')).toBe(true);
  });

  it('NEVER stands down against the caller OWN claim — that would lock an agent out of its own gate', () => {
    expect(shouldStandDownForLivePeer(held({ takenBy: 'su-me' }), 'su-me')).toBe(false);
  });

  it('proceeds when the CALLER cannot be identified — an unknown caller may be the holder', () => {
    // resolveAgentIdentity throws on a power-user ctx missing uiClientId; the rail maps that to
    // null. Refusing here would block a re-fire of the caller's own claim on an identity glitch.
    expect(shouldStandDownForLivePeer(held(), null)).toBe(false);
  });

  it('proceeds for a DEAD holder — a dead peer must never wedge the gate', () => {
    expect(shouldStandDownForLivePeer(held({ state: 'ended' }), 'su-me')).toBe(false);
  });

  it('proceeds on the two AMBIGUOUS verdicts — coordination never blocks on a maybe', () => {
    expect(shouldStandDownForLivePeer(held({ state: 'draining' }), 'su-me')).toBe(false);
    expect(shouldStandDownForLivePeer(held({ state: 'suspect' }), 'su-me')).toBe(false);
  });

  it('proceeds when the oracle could not answer, and when the store was unreadable', () => {
    expect(shouldStandDownForLivePeer(held({ state: null }), 'su-me')).toBe(false);
    expect(shouldStandDownForLivePeer(unmeasuredCell('green-stall:papercusp', 'store down'), 'su-me')).toBe(false);
  });

  it('proceeds when nothing owns the condition, and when the lease merely expired', () => {
    expect(shouldStandDownForLivePeer(unownedCell('green-stall:papercusp'), 'su-me')).toBe(false);
    expect(
      shouldStandDownForLivePeer(
        { ...toCellOwnership(mkObj({ claimState: 'lease-expired', takenBy: 'su-peer' }), 'live') },
        'su-me',
      ),
    ).toBe(false);
  });

  it('stands down for the three ALIVE states only, holding caller and holder fixed', () => {
    const verdicts = (['live', 'parked', 'draining', 'suspect', 'ended', 'recorded'] as const).map(
      (s) => [s, shouldStandDownForLivePeer(held({ state: s }), 'su-me')] as const,
    );
    expect(Object.fromEntries(verdicts)).toEqual({
      live: true,
      parked: true,
      recorded: true,
      draining: false,
      suspect: false,
      ended: false,
    });
  });
});

describe('readGateOwnership', () => {
  it('resolves BOTH condition keys in one batched call and projects the stall object when only it is found', async () => {
    const seen: string[][] = [];
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async (keys: readonly string[]) => {
        seen.push([...keys]);
        return new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-x' })]]);
      }) as never,
    });
    expect(seen).toEqual([['green-stall:papercusp', 'gate-red-streak:papercusp']]);
    expect(own.claimState).toBe('held');
    expect(own.eventKey).toBe('green-stall:papercusp');
  });

  // REGRESSION GUARD (WI-37451). Measured live 2026-08-09: the gate was firing
  // healthily and answering red (`gate-red-streak:papercusp` open, an ownable
  // work-item existed) while `green-stall:` had never opened at all. The old
  // resolver looked up ONLY the stall key, so this cell — and checkpoint-run's
  // stand-down check, which reads the same function — reported "no-object" for
  // an incident that was in fact owned and claimable.
  it('resolves red-streak-only ownership — a red gate is ownable even when it never stalled', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([
          [
            'gate-red-streak:papercusp',
            mkObj({ conditionKey: 'gate-red-streak:papercusp', workItem: 'WI-37450', claimState: 'claimable' }),
          ],
        ])) as never,
    });
    expect(own.eventKey).toBe('gate-red-streak:papercusp');
    expect(own.workItem).toBe('WI-37450');
    expect(own.claimState).toBe('claimable');
  });

  // D-002(b): the two conditions can be open SIMULTANEOUSLY by design (a red
  // streak outliving the 12h no-green backstop opens both). This cell stays
  // single-valued, so it must pick one — red-streak, the more specific and
  // currently-firing incident (see pickGateConditionKey's doc comment).
  it('prefers gate-red-streak when BOTH conditions are open at once', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([
          ['green-stall:papercusp', mkObj({ conditionKey: 'green-stall:papercusp', workItem: 'WI-1' })],
          ['gate-red-streak:papercusp', mkObj({ conditionKey: 'gate-red-streak:papercusp', workItem: 'WI-2' })],
        ])) as never,
    });
    expect(own.eventKey).toBe('gate-red-streak:papercusp');
    expect(own.workItem).toBe('WI-2');
  });

  // REGRESSION GUARD. Measured live 2026-09-20: `green-stall:papercusp` was open and
  // linked to WI-10001932 while `state:read { cell:'gate.greenCheckpoint.ownership' }`
  // answered `unowned` — whose safeAction is "File the owning work-item and claim it
  // before starting", i.e. it recruits a SECOND fixer onto an already-owned incident.
  //
  // ⚠ WHY THE THREE TESTS ABOVE DID NOT CATCH IT — read this before simplifying the
  // fixture. Each of them injects a map that OMITS the key it means to be absent. The
  // REAL `findConditionObjects` never does that: it `out.set(k, ...)` for EVERY
  // requested key in all three of its branches, so a key with no linked rows still
  // arrives as a `no-object` object with `workItem: null`. `objs.has(redStreakKey)`
  // was therefore ALWAYS true in production and the stall branch was dead code —
  // a defect invisible to every mock that is more forgiving than the real collaborator.
  //
  // So this fixture deliberately supplies BOTH keys, with the absent condition in its
  // true production shape. That is the whole point of the test; a version that drops
  // the red-streak entry silently stops guarding anything and rejoins the trio above.
  it('projects the OPEN stall owner when the red-streak key resolves to a no-object entry (production map shape)', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([
          [
            'green-stall:papercusp',
            mkObj({
              conditionKey: 'green-stall:papercusp',
              workItem: 'WI-10001932',
              claimState: 'held',
              takenBy: 'su-ce04d24c',
            }),
          ],
          // present-but-empty, exactly as the real finder returns an unopened condition
          [
            'gate-red-streak:papercusp',
            mkObj({ conditionKey: 'gate-red-streak:papercusp', workItem: null, claimState: 'no-object' }),
          ],
        ])) as never,
      resolveSessionStates: oracle('live'),
    });
    expect(own.eventKey).toBe('green-stall:papercusp');
    expect(own.workItem).toBe('WI-10001932');
    expect(own.claimState).toBe('held');
    // the assessment peers branch on: a held incident must NOT read as unowned, because
    // `unowned` is what tells the next agent to file a duplicate.
    expect(own.assessment).not.toBe('unowned');

    // FALSIFIABILITY CONTROL, kept permanently rather than proven by mutating the shared
    // tree (a mutation probe here would race git-sync's sweep). This is the exact
    // predicate the resolver used before the fix. Against the SAME production-shaped
    // fixture it selects the red-streak key — so the assertions above are discriminating,
    // not vacuous, and a revert to map-membership is guaranteed to fail this test rather
    // than pass it quietly.
    const legacyPick = (stall: string, red: string, objs: ReadonlyMap<string, ConditionObject>) =>
      objs.has(red) ? red : stall;
    const productionShaped = new Map<string, ConditionObject>([
      ['green-stall:papercusp', mkObj({ conditionKey: 'green-stall:papercusp', workItem: 'WI-10001932' })],
      [
        'gate-red-streak:papercusp',
        mkObj({ conditionKey: 'gate-red-streak:papercusp', workItem: null, claimState: 'no-object' }),
      ],
    ]);
    expect(legacyPick('green-stall:papercusp', 'gate-red-streak:papercusp', productionShaped)).toBe(
      'gate-red-streak:papercusp',
    );
    expect(own.eventKey).not.toBe(
      legacyPick('green-stall:papercusp', 'gate-red-streak:papercusp', productionShaped),
    );
  });

  it('returns no-object, keyed by the stall key, when NEITHER key resolves to anything', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () => new Map()) as never,
    });
    expect(own.claimState).toBe('no-object');
    expect(own.workItem).toBeNull();
    expect(own.eventKey).toBe('green-stall:papercusp');
  });

  it('resolves the operator-home condition for a workspace-wide harness sentinel', async () => {
    const seen: { keys?: string[]; harnessSlug?: string } = {};
    const own = await readGateOwnership({
      harness: '*',
      findConditionObjects: (async (keys: string[], scope: { harnessSlug: string }) => {
        seen.keys = keys;
        seen.harnessSlug = scope.harnessSlug;
        return new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-live' })]]);
      }) as never,
      resolveSessionStates: oracle('live'),
    });

    expect(seen).toEqual({
      keys: ['green-stall:papercusp', 'gate-red-streak:papercusp'],
      harnessSlug: 'papercusp',
    });
    expect(own.eventKey).toBe('green-stall:papercusp');
    expect(own.assessment).toBe('held-live');
  });

  // A cell must ALWAYS render, but it must render UNMEASURED — never "no owner".
  it('degrades to UNMEASURED when the store is unreachable, never throws', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () => {
        throw new Error('pg down');
      }) as never,
    });
    expect(own.claimState).toBeNull();
    expect(own.unknown?.code).toBe('resolver-failed');
    expect(own.eventKey).toBe('green-stall:papercusp');
  });

  it('resolves the holder liveness through the presence oracle when a holder exists', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-dead' })]])) as never,
      resolveSessionStates: oracle('ended'),
    });
    expect(own.holderSessionState).toBe('ended');
    expect(ownershipContradicted(own)).toBe(true);
  });

  it('passes active gate ownership into the oracle so a stale holder is suspect, not ended', async () => {
    const seen: Array<{ ownerId: string; claimsHeld?: boolean }> = [];
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-stale' })]])) as never,
      resolveSessionStates: (async (subjects: readonly { ownerId: string; claimsHeld?: boolean }[]) => {
        seen.push(...subjects);
        return new Map(
          subjects.map((subject) => [
            subject.ownerId,
            {
              ownerId: subject.ownerId,
              sessionState: subject.claimsHeld ? 'suspect' : 'ended',
            },
          ]),
        );
      }) as never,
    });

    expect(seen).toEqual([{ ownerId: 'su-stale', claimsHeld: true }]);
    expect(own.holderSessionState).toBe('suspect');
    expect(ownershipContradicted(own)).toBe(false);
    expect(ownershipNeedsLivenessConfirmation(own)).toBe(true);
  });

  // RECURRENCE GUARD (EI-22177969873560474): this cell's `holderSessionState`
  // is documented as "measured by the presence oracle" — the SAME oracle
  // coord:presence's roster read uses. presence-snapshot.ts enables the
  // psu-host positive-authority rescue leg (`{ positive: true }`) for every
  // roster row; this call must pass the equivalent `psuHostPositiveAuthority`
  // option, or a holder with a confirmed-live psu host but a base-derived
  // 'suspect'/'ended' verdict reads 'suspect' HERE while coord:presence
  // rescues the SAME owner to 'parked' — the exact two-surfaces-disagree bug.
  it('requests the psu-host positive-authority rescue leg, matching coord:presence', async () => {
    const seenOpts: Array<{ psuHostPositiveAuthority?: boolean; hydratePerId?: boolean }> = [];
    await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-parked' })]])) as never,
      resolveSessionStates: (async (
        subjects: readonly { ownerId: string }[],
        opts: { psuHostPositiveAuthority?: boolean; hydratePerId?: boolean },
      ) => {
        seenOpts.push(opts);
        return new Map(subjects.map((s) => [s.ownerId, { ownerId: s.ownerId, sessionState: 'parked' }]));
      }) as never,
    });
    expect(seenOpts).toEqual([{ hydratePerId: true, psuHostPositiveAuthority: true }]);
  });

  it('does NOT call the oracle when there is no holder to measure', async () => {
    let calls = 0;
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'claimable', takenBy: null })]])) as never,
      resolveSessionStates: (async () => {
        calls += 1;
        return new Map();
      }) as never,
    });
    expect(calls).toBe(0);
    expect(own.holderSessionState).toBeNull();
  });

  // A failed falsifier leg must not invent liveness in EITHER direction: null
  // means "no contradiction established", never "the holder is alive".
  it('leaves holderSessionState null when the oracle throws, keeping the claim readable', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-x' })]])) as never,
      resolveSessionStates: (async () => {
        throw new Error('oracle down');
      }) as never,
    });
    expect(own.claimState).toBe('held');
    expect(own.holderSessionState).toBeNull();
    expect(ownershipContradicted(own)).toBe(false);
  });
});

/**
 * P-006. The thread is ADVISORY (D-006), and the tests that matter are about
 * CONTAINMENT: an advisory leg must never be able to damage the measured verdict
 * beside it, and must never render its own failure as reassurance.
 */
describe('the folded thread block', () => {
  it('does not let an unreadable thread degrade a successfully measured ownership', async () => {
    const own = await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'held', takenBy: 'su-x' })]])) as never,
      resolveSessionStates: oracle('ended'),
      readCellThread: (async () => unmeasuredThread('thread store down')) as never,
    });
    // The ownership verdict — and its falsifier — survive intact.
    expect(own.claimState).toBe('held');
    expect(own.holderSessionState).toBe('ended');
    expect(ownershipContradicted(own)).toBe(true);
    // ...and the advisory block reports its own failure honestly.
    expect(own.thread.unknown?.code).toBe('resolver-failed');
    expect(own.thread.total).toBeNull();
  });

  it('renders not-applicable — never an empty thread — when nothing owns the condition', async () => {
    const own = unownedCell('green-stall:papercusp');
    expect(own.thread.unknown?.code).toBe('not-applicable');
    expect(own.thread.total).toBeNull();
  });

  it('marks the thread unmeasured when ownership itself could not be read', async () => {
    // Ownership unreadable ⇒ the thread was never even attempted. Reporting
    // "nothing was said" here would restate the failure as reassurance.
    const own = unmeasuredCell('green-stall:papercusp', 'store unreachable');
    expect(own.claimState).toBeNull();
    expect(own.thread.unknown?.code).toBe('resolver-failed');
  });

  it('passes the resolved harness through to the thread read', async () => {
    let sawHarness: string | undefined;
    await readGateOwnership({
      harness: 'papercusp',
      findConditionObjects: (async () =>
        new Map([['green-stall:papercusp', mkObj({ claimState: 'claimable', takenBy: null })]])) as never,
      readCellThread: (async (_id: string | null, o: { harness?: string }) => {
        sawHarness = o.harness;
        return silentThread();
      }) as never,
    });
    expect(sawHarness).toBe('papercusp');
  });
});
