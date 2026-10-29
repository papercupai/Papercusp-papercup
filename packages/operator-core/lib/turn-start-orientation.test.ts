/**
 * turn-start-orientation — the pure composition half (P-004 / D-004 ruling 3).
 *
 * The IO half is a Promise.all of already-tested readers; what is worth pinning
 * here is the behaviour that decides whether an agent is oriented at all, and the
 * behaviour that decides what it COSTS every turn.
 */
import { describe, it, expect, vi } from 'vitest';

const getLoopStatusMock = vi.hoisted(() => vi.fn());
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: getLoopStatusMock }));

import {
  composeOrientationBlock,
  defaultOrientationDeps,
  fingerprintOrientation,
  fingerprintDeliveredOrientation,
  isLoopFireWithheld,
  orientationUnchanged,
  isEmptyOrientation,
  renderOrientationLines,
  resolveOrientationState,
  selectOrientationImprovementTriage,
  buildAnnouncedGateWarning,
  ORIENTATION_BUDGET_CHARS,
  type OrientationState,
  type OrientationModeState,
} from './turn-start-orientation';
import { selectUntriaged } from './harness/improvements/triage-core';
import type { ScoredItem } from './harness/improvements/digest';

const base: OrientationState = {
  planDecisions: undefined,
  lockTransitions: undefined,
  coupledPeers: [],
  held: [],
  historyUpdates: [],
  effortUpdates: [],
  unansweredDirected: 0,
  unansweredStale: 0,
  openAsks: null,
  inboxRecent: [],
  announcedGates: [],
  modes: [],
  authorityVerdict: null,
  loopArmed: false,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};
const withWork: OrientationState = {
  planDecisions: undefined,
  lockTransitions: undefined,
  coupledPeers: [],
  held: [
    {
      id: 'WI-1',
      status: 'wip',
      checkpoint: 'Implemented the reader; next run the focused test.',
      checkpointUpdatedAtMs: 1_000,
      checkpointStale: false,
    },
  ],
  historyUpdates: [],
  effortUpdates: [],
  unansweredDirected: 2,
  unansweredStale: 0,
  openAsks: null,
  inboxRecent: [{ msgId: 'm-1', from: 'su-peer', summary: 'Need your decision on the shared seam.' }],
  announcedGates: [{ event: 'fleet:atlas:phase-open', note: 'Phase 2 may begin.' }],
  modes: [],
  authorityVerdict: null,
  loopArmed: true,
  loopFireWithheld: false,
  improvementTriage: null,
  executableFrontier: null,
  neverDropFacts: [],
  toolSurface: null,
  carryBlindWindow: null,
};

/** The context generation most of these cases hold fixed; P-023's own block varies it. */
const EPOCH = 3;

const quietDeps = {
  held: async () => [],
  historyUpdates: async () => [],
  effortUpdates: async () => [],
  inbox: async () => ({ count: 0, newest: [] }),
  announcedGates: async () => [],
  openAsks: async () => null,
  modes: async () => [],
  authorityVerdict: async () => null,
  loopArmed: async () => false,
  loopFireWithheld: async () => false,
  improvementTriage: async () => null,
  executableFrontier: async () => null,
  obligations: async () => null,
  neverDropFacts: async () => [],
  toolSurface: async () => null,
  carryBlindWindow: async () => null,
  contextEpoch: async () => 0,
};

function obligationBrief(sourceGeneration = 'agenda-1'): NonNullable<OrientationState['obligations']> {
  return {
    schemaVersion: 'agent-obligations-v1',
    evaluatedAt: '2026-09-05T20:00:00.000Z',
    sourceGeneration,
    evaluations: [],
    primary: [],
    projection: {
      text: '- [DUE] Send the owner report — report now',
      entries: [],
      receipt: {
        sink: 'turn-start',
        mode: 'truncate',
        entriesAvailable: 2,
        entriesDelivered: 1,
        entriesOmitted: 1,
        bodyDeliveredChars: 44,
        estimatedTokens: 11,
        bodyTruncated: true,
        refused: false,
        reason: 'entry-cap',
      },
    },
    detailRef: 'coord:orient for the complete obligation agenda',
  };
}

describe('turn-start-orientation — when it speaks', () => {
  it('says NOTHING when there is nothing to say (no held work, no mail, no loop)', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(composeOrientationBlock({ state: base, committed: null, epoch: EPOCH })).toBe('');
  });

  it('speaks in full on the FIRST turn (no committed cursor = baseline)', () => {
    const out = composeOrientationBlock({ state: withWork, committed: null, epoch: EPOCH });
    expect(out).toContain('Orientation');
    expect(out).toContain('WI-1 (wip)');
    expect(out).toContain('2 directed msg(s) awaiting YOUR reply');
  });

  it('says NOTHING on a turn where nothing changed — the whole economy of the fold', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    expect(composeOrientationBlock({ state: withWork, committed, epoch: EPOCH })).toBe('');
  });

  it('re-emits when a held item own-thread history generation advances', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    const changed: OrientationState = {
      ...withWork,
      historyUpdates: [{ workItemId: 'WI-1', harness: 'papercusp', count: 2, newestPostId: 44 }],
    };
    const out = composeOrientationBlock({ state: changed, committed, epoch: EPOCH });
    expect(out).toContain('2 post-claim history update(s)');
    expect(out).toContain('WI-1');
    expect(orientationUnchanged(committed, fingerprintOrientation(changed, EPOCH, committed))).toBe(false);
  });

  it('does not advance unseen post-claim history when the outer budget omits its line', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    const changed: OrientationState = {
      ...withWork,
      toolSurface: { hookCalls: 30, windowMinutes: 5 },
      historyUpdates: [{ workItemId: 'WI-1', harness: 'papercusp', count: 1, newestPostId: 45 }],
    };
    const block = composeOrientationBlock({ state: changed, committed, epoch: EPOCH, budgetChars: 210 });
    expect(block).not.toContain('post-claim history update(s)');
    const delivered = fingerprintDeliveredOrientation(changed, EPOCH, committed, block);
    expect(delivered.historyUpdates).toBe(committed.historyUpdates);
  });

  it('re-emits current plan/goal revision generations without duplicating their full history', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    const changed: OrientationState = {
      ...withWork,
      effortUpdates: [{ level: 'plan', ref: 'one-plan', count: 1, newestPostId: 46 }],
    };
    const out = composeOrientationBlock({ state: changed, committed, epoch: EPOCH });
    expect(out).toContain('1 post-claim plan/goal revision(s) (plan:one-plan)');
    expect(out).not.toContain('full history');
  });

  it('preserves the prior history token when the history reader fails', async () => {
    const state = await resolveOrientationState('su-x', 'ws-x', {
      ...quietDeps,
      historyUpdates: async () => { throw new Error('read failed'); },
    });
    const committed = { ...fingerprintOrientation(base, EPOCH), historyUpdates: 'WI-old:1:9' };
    expect(fingerprintOrientation(state, EPOCH, committed).historyUpdates).toBe('WI-old:1:9');
  });

  it('preserves unseen plan/goal revisions on read failure and final-budget omission', async () => {
    const state = await resolveOrientationState('su-x', 'ws-x', {
      ...quietDeps,
      effortUpdates: async () => { throw new Error('read failed'); },
    });
    const committed = { ...fingerprintOrientation(base, EPOCH), effortUpdates: 'plan:old:1:8' };
    expect(fingerprintOrientation(state, EPOCH, committed).effortUpdates).toBe('plan:old:1:8');

    const changed: OrientationState = {
      ...withWork,
      toolSurface: { hookCalls: 30, windowMinutes: 5 },
      effortUpdates: [{ level: 'goal', ref: 'G-1', count: 1, newestPostId: 47 }],
    };
    const block = composeOrientationBlock({ state: changed, committed, epoch: EPOCH, budgetChars: 210 });
    expect(block).not.toContain('post-claim plan/goal revision(s)');
    expect(fingerprintDeliveredOrientation(changed, EPOCH, committed, block).effortUpdates)
      .toBe('plan:old:1:8');
  });

  it('emits the executable frontier on baseline, then suppresses it during unrelated changes', () => {
    const state: OrientationState = {
      ...withWork,
      executableFrontier: { planSlug: 'one-plan', executableWidth: 7 },
    };
    expect(composeOrientationBlock({ state, committed: null, epoch: EPOCH })).toContain(
      'frontier: 7 executable (one-plan)',
    );

    const committed = fingerprintOrientation(state, EPOCH);
    const unrelated = composeOrientationBlock({
      state: { ...state, unansweredDirected: 3 },
      committed,
      epoch: EPOCH,
    });
    expect(unrelated).toContain('3 directed msg(s)');
    expect(unrelated).not.toContain('frontier:');
  });

  it('emits only real executable-frontier edges, including plan identity changes', () => {
    const previous: OrientationState = {
      ...withWork,
      executableFrontier: { planSlug: 'one-plan', executableWidth: 7 },
    };
    const committed = fingerprintOrientation(previous, EPOCH);
    expect(
      composeOrientationBlock({
        state: { ...previous, executableFrontier: { planSlug: 'one-plan', executableWidth: 1 } },
        committed,
        epoch: EPOCH,
      }),
    ).toContain('frontier: 7 -> 1 executable (one-plan)');
    expect(
      composeOrientationBlock({
        state: { ...previous, executableFrontier: { planSlug: 'next-plan', executableWidth: 2 } },
        committed,
        epoch: EPOCH,
      }),
    ).toContain('frontier: one-plan@7 -> next-plan@2 executable');
  });

  it('preserves the last frontier cursor through an unknown read without repeating it later', () => {
    const previous: OrientationState = {
      ...withWork,
      executableFrontier: { planSlug: 'one-plan', executableWidth: 7 },
    };
    const committed = fingerprintOrientation(previous, EPOCH);
    const unknown: OrientationState = {
      ...previous,
      unansweredDirected: 3,
      executableFrontier: null,
    };
    const out = composeOrientationBlock({ state: unknown, committed, epoch: EPOCH });
    expect(out).not.toContain('frontier:');
    expect(fingerprintOrientation(unknown, EPOCH, committed).frontier).toBe(committed.frontier);
  });

  /**
   * P-012 / D-071. CTRL carries mode IDS only, so an agent could read that it is
   * in AUTO without ever learning WHO put it there or WHY — and "the owner told
   * me to" versus "I set this myself" is precisely the distinction the
   * provenance rules turn on. These pin the rendered attribution, not the
   * registry state.
   */
  function modeRow(over: Partial<OrientationModeState> = {}): OrientationModeState {
    return {
      axisKey: 'autonomy',
      mode: 'auto',
      reason: 'owner said run autonomously',
      setBy: 'su-c03852cb',
      setBySelf: false,
      ownerDirected: false,
      impliedBy: null,
      ...over,
    };
  }

  it('renders each mode attribution shape distinguishably', () => {
    const render = (over: Parameters<typeof modeRow>[0]) =>
      composeOrientationBlock({ state: { ...base, modes: [modeRow(over)] }, committed: null, epoch: EPOCH });

    expect(render({ ownerDirected: true })).toContain(
      'mode auto ON — owner-directed (reason: owner said run autonomously)',
    );
    expect(render({ setBySelf: true, reason: 'self-armed for the drain' })).toContain(
      'mode auto ON — self-set (reason: self-armed for the drain)',
    );
    // The fourth case the item text does not name. A peer-set mode rendered as
    // "self-set" would attribute a flip this agent never made to this agent.
    expect(render({ setBy: 'su-c03852cb', reason: 'leader set the lane posture' })).toContain(
      'mode auto ON — set by su-c03852cb (reason: leader set the lane posture)',
    );
    expect(render({ mode: 'ideate', impliedBy: 'drain', reason: 'implication cascade' })).toContain(
      'mode ideate ON — implied by drain (reason: implication cascade)',
    );
  });

  it('attributes an implied row to its SOURCE even when the row also carries ownerDirected', () => {
    // An implication cascade propagates the triggering directive's flags onto the
    // rows it inserts, so this shape is the COMMON one, not a corner case: testing
    // ownerDirected first would render every implied mode as a decision the owner
    // took directly, and "implied by" could never appear at all.
    const line = composeOrientationBlock({
      state: { ...base, modes: [modeRow({ mode: 'auto', impliedBy: 'drain', ownerDirected: true, setBySelf: true })] },
      committed: null,
      epoch: EPOCH,
    });
    expect(line).toContain('mode auto ON — implied by drain');
    expect(line).not.toContain('owner-directed');
    expect(line).not.toContain('self-set');
  });

  it('states a mode ONCE — including on a later turn that re-renders for an unrelated reason', () => {
    // The falsifying case for a watermark-token-only implementation.
    // composeOrientationBlock is all-or-nothing: when ANY token changes every
    // class re-renders, so a line gated only on its own token reappears verbatim
    // on the next turn an unrelated message arrives. Only the diff against the
    // committed cursor suppresses it.
    const state: OrientationState = { ...base, modes: [modeRow({ ownerDirected: true })] };
    expect(composeOrientationBlock({ state, committed: null, epoch: EPOCH })).toContain('mode auto ON');

    const committed = fingerprintOrientation(state, EPOCH);
    const unrelated = composeOrientationBlock({
      state: { ...state, unansweredDirected: 3 },
      committed,
      epoch: EPOCH,
    });
    expect(unrelated).toContain('3 directed msg(s)');
    expect(unrelated).not.toContain('mode auto ON');
  });

  it('announces only the NEWLY added mode when a second axis is set', () => {
    const before: OrientationState = { ...base, modes: [modeRow({ ownerDirected: true })] };
    const committed = fingerprintOrientation(before, EPOCH);
    const after = composeOrientationBlock({
      state: {
        ...before,
        modes: [modeRow({ ownerDirected: true }), modeRow({ axisKey: 'ideation', mode: 'ideate', setBySelf: true })],
      },
      committed,
      epoch: EPOCH,
    });
    expect(after).toContain('mode ideate ON — self-set');
    expect(after).not.toContain('mode auto ON');
  });

  it('re-announces a mode whose ATTRIBUTION changed, not merely its id', () => {
    // The identity is (axis, mode, setter, ownerDirected, impliedBy) — a mode
    // re-set by someone else is a different fact about the agent's authority,
    // even though `modes: ['auto']` is byte-identical across the two turns.
    const before: OrientationState = { ...base, modes: [modeRow({ setBySelf: true })] };
    const committed = fingerprintOrientation(before, EPOCH);
    expect(
      composeOrientationBlock({
        state: { ...before, modes: [modeRow({ ownerDirected: true })] },
        committed,
        epoch: EPOCH,
      }),
    ).toContain('mode auto ON — owner-directed');
  });

  it('stays silent on an UNREADABLE mode registry and preserves the committed cursor', () => {
    // `null` is "could not read", not "no modes set". Asserting a posture we
    // could not read is worse than saying nothing; and erasing the cursor would
    // make the NEXT successful read re-announce a mode that never changed.
    const previous: OrientationState = { ...base, modes: [modeRow({ ownerDirected: true })] };
    const committed = fingerprintOrientation(previous, EPOCH);
    const unreadable: OrientationState = { ...previous, unansweredDirected: 3, modes: null };
    expect(composeOrientationBlock({ state: unreadable, committed, epoch: EPOCH })).not.toContain('mode auto');
    expect(fingerprintOrientation(unreadable, EPOCH, committed).modes).toBe(committed.modes);
  });

  it('speaks again the moment ANY tracked field changes', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    for (const changed of [
      { ...withWork, unansweredDirected: 3 },
      { ...withWork, openAsks: { count: 1, oldestAgeMs: 1_000, oldestTo: 'su-peer' } },
      { ...withWork, loopArmed: false },
      { ...withWork, loopFireWithheld: true },
      { ...withWork, held: [{ id: 'WI-1', status: 'blocked' }] },
      { ...withWork, held: [{ id: 'WI-2', status: 'wip' }] },
      { ...withWork, announcedGates: [{ event: 'fleet:atlas:another-gate' }] },
      { ...withWork, inboxRecent: [{ msgId: 'm-2', from: 'su-peer', summary: 'New ask' }] },
      // improvementTriage was a tracked field here until P-017 withdrew it from
      // the per-turn block. It is deliberately absent rather than relaxed: the
      // paired 'watermark withdrawal' test below now asserts the OPPOSITE for
      // it — a triage-only delta must NOT re-emit — so the property is still
      // measured, just with the sign the current contract actually has.
      { ...withWork, obligations: obligationBrief() },
    ] as OrientationState[]) {
      expect(composeOrientationBlock({ state: changed, committed, epoch: EPOCH })).not.toBe('');
    }
  });

  it('re-emits the WHOLE block on a change, never a partial diff', () => {
    // Binding-context surface: an agent shown only the changed line would read the
    // elided lines as absent state. orient-list-delta.ts made the same call for
    // orient's claimable/facts folds; this mirrors it deliberately.
    const committed = fingerprintOrientation(withWork, EPOCH);
    const out = composeOrientationBlock({
      state: { ...withWork, unansweredDirected: 3 },
      committed,
      epoch: EPOCH,
    });
    expect(out).toContain('WI-1 (wip)'); // unchanged line still present
    expect(out).toContain('engine loop'); // unchanged line still present
  });

  it('renders the bounded shared agenda with an explicit omission recovery reference', () => {
    const out = composeOrientationBlock({
      state: { ...base, loopArmed: true, obligations: obligationBrief() },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('[DUE] Send the owner report');
    expect(out).toContain('+1 omitted');
    expect(out).toContain('coord:orient');
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
  });

  it('an obligations-only re-emit never asserts "holding: nothing" over a held item (EI-24811284380539882)', () => {
    // The unchanged-fingerprint path narrows the block to the undischarged
    // obligation row. That projection did not re-read held work, so it must stay
    // SILENT about it — rendering the measured-empty "holding: nothing — claim
    // before your first edit" told an agent holding four items its lane was empty.
    const undischarged = {
      ...obligationBrief(),
      primary: [{ kind: 'duty' }] as unknown as NonNullable<OrientationState['obligations']>['primary'],
    };
    const state: OrientationState = { ...withWork, unansweredDirected: 0, inboxRecent: [], obligations: undischarged };
    const committed = fingerprintOrientation(state, EPOCH);
    const out = composeOrientationBlock({ state, committed, epoch: EPOCH });
    expect(out).toContain('[DUE] Send the owner report'); // the obligation row is still re-injected
    expect(out).not.toContain('holding: nothing');
    expect(out).not.toContain('claim before your first edit');
    // Same quiet-value rule for the loop: this projection did not look at it either.
    expect(out).not.toContain('engine loop');
  });

  it('preserves an obligation cursor on read failure but re-emits a measured clear', () => {
    const active: OrientationState = { ...base, obligations: obligationBrief() };
    const committed = fingerprintOrientation(active, EPOCH);
    expect(
      orientationUnchanged(committed, fingerprintOrientation({ ...active, obligations: undefined }, EPOCH, committed)),
    ).toBe(true);
    expect(
      orientationUnchanged(committed, fingerprintOrientation({ ...active, obligations: null }, EPOCH, committed)),
    ).toBe(false);
  });

  it('keeps obligation recovery reachable after the outer envelope is crowded', () => {
    const brief = obligationBrief();
    brief.projection.text = `- [DUE] ${'load-bearing owner-report action '.repeat(5).trim()}`;
    const state: OrientationState = {
      ...withWork,
      loopArmed: false,
      obligations: brief,
      toolSurface: { hookCalls: 22, windowMinutes: 5 },
      openAsks: { count: 4, oldestAgeMs: 90_000, oldestTo: 'su-peer-awaiting-review' },
      neverDropFacts: [
        'guard-rail:current-owner-request-remains-open',
        'dead-end:do-not-repeat-the-withdrawn-plan',
      ],
    };

    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH, budgetChars: 600 });

    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
    expect(out).toContain('directed msg(s) awaiting YOUR reply');
    expect(out).toContain(brief.detailRef);
    expect(out).not.toContain(brief.projection.text);
    const prior = fingerprintOrientation(
      { ...state, obligations: obligationBrief('agenda-before') },
      EPOCH,
    );
    expect(fingerprintDeliveredOrientation(state, EPOCH, prior, out).obligations).toBe('agenda-before');
  });

  it('a held-item STATUS change re-emits, not just an id change', () => {
    const a = fingerprintOrientation({ ...base, held: [{ id: 'WI-1', status: 'wip' }] }, EPOCH);
    const b = fingerprintOrientation({ ...base, held: [{ id: 'WI-1', status: 'blocked' }] }, EPOCH);
    expect(orientationUnchanged(a, b)).toBe(false);
  });

  it('keeps recovery when only the outer envelope omits an obligation', () => {
    const brief = obligationBrief();
    brief.projection.text = `- [DUE] ${'load-bearing owner-report action '.repeat(10).trim()}`;
    brief.projection.receipt.entriesAvailable = 1;
    brief.projection.receipt.entriesDelivered = 1;
    brief.projection.receipt.entriesOmitted = 0;
    brief.projection.receipt.bodyTruncated = false;
    const state: OrientationState = {
      ...withWork,
      loopArmed: false,
      obligations: brief,
      toolSurface: { hookCalls: 22, windowMinutes: 5 },
      openAsks: { count: 4, oldestAgeMs: 90_000, oldestTo: 'su-peer-awaiting-review' },
      neverDropFacts: ['guard-rail:current-owner-request-remains-open'],
    };

    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH, budgetChars: 600 });

    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
    expect(out).toContain('directed msg(s) awaiting YOUR reply');
    expect(out).not.toContain(brief.projection.text);
    expect(out).toContain(brief.detailRef);
    const prior = fingerprintOrientation(
      { ...state, obligations: obligationBrief('agenda-before') },
      EPOCH,
    );
    expect(fingerprintDeliveredOrientation(state, EPOCH, prior, out).obligations).toBe('agenda-before');
  });

  it('a withheld-fire state change re-emits while the loop remains armed', () => {
    const committed = fingerprintOrientation(withWork, EPOCH);
    expect(
      composeOrientationBlock({
        state: { ...withWork, loopFireWithheld: true },
        committed,
        epoch: EPOCH,
      }),
    ).not.toBe('');
  });

  it('held-item ORDER does not count as a change (the fingerprint sorts)', () => {
    const a = fingerprintOrientation(
      {
        ...base,
        held: [
          { id: 'WI-1', status: 'wip' },
          { id: 'WI-2', status: 'wip' },
        ],
      },
      EPOCH,
    );
    const b = fingerprintOrientation(
      {
        ...base,
        held: [
          { id: 'WI-2', status: 'wip' },
          { id: 'WI-1', status: 'wip' },
        ],
      },
      EPOCH,
    );
    expect(orientationUnchanged(a, b)).toBe(true);
  });

  it('treats an unrecognizable committed value as CHANGED (fail-open, never silent)', () => {
    // A delta must never make orientation worse than no delta — same posture as
    // idListUnchanged. Anything unparseable ⇒ deliver in full.
    for (const junk of [null, undefined, 'nope', 42, {}] as unknown[]) {
      expect(orientationUnchanged(junk as never, fingerprintOrientation(withWork, EPOCH))).toBe(false);
    }
  });
});

/**
 * P-023 / D-008 — the epoch-boundary behaviour.
 *
 * These are the cases the pre-P-023 fold got WRONG, and they are worth stating as
 * behaviour rather than as implementation: the cursor is keyed by OWNER, but what
 * it dedups against is the agent's CONTEXT. A carry-respawn and a cold loop wake
 * both keep the owner id and discard the context — and they are exactly the
 * boundaries where orientation state is most likely to be byte-identical to the
 * predecessor's last turn, because nothing changed except that the process
 * restarted. So the old suppression was anti-correlated with need.
 */
describe('turn-start-orientation — the context boundary (P-023 / D-008)', () => {
  it('SPEAKS across a context boundary even when nothing else changed at all', () => {
    // The load-bearing case. Identical held items, identical mail, identical loop —
    // only the context generation moved. Pre-P-023 this returned '' and a fresh
    // successor was told nothing.
    const committed = fingerprintOrientation(withWork, 7);
    const out = composeOrientationBlock({ state: withWork, committed, epoch: 8 });
    expect(out).not.toBe('');
    expect(out).toContain('WI-1 (wip)');
  });

  it('still says nothing WITHIN one context generation — the economy is preserved', () => {
    // The complement of the case above: this change must not turn a per-turn fold
    // into a per-turn cost. Same epoch, same state ⇒ still silent.
    const committed = fingerprintOrientation(withWork, 8);
    expect(composeOrientationBlock({ state: withWork, committed, epoch: 8 })).toBe('');
  });

  it('treats a PRE-P-023 committed cursor (no epoch key) as changed, not as equal', () => {
    // Migration posture: rows written before the epoch key existed must re-emit
    // once rather than suppress forever against a generation they never recorded.
    const legacy = { held: 'WI-1:wip', unanswered: 2, loop: 1 };
    expect(orientationUnchanged(legacy, fingerprintOrientation(withWork, 0))).toBe(false);
  });

  it('a generation that never moves reproduces the OLD dedup exactly (0 = unknown)', () => {
    // `currentSessionEpoch` answers 0 on a missing relation or a failed read, and
    // that degradation must be the pre-P-023 behaviour — not a block on every turn.
    const committed = fingerprintOrientation(withWork, 0);
    expect(composeOrientationBlock({ state: withWork, committed, epoch: 0 })).toBe('');
  });

  it('carries the epoch on the fingerprint so a stage() cannot commit a silent one', () => {
    expect(fingerprintOrientation(withWork, 8).epoch).toBe(8);
    expect(orientationUnchanged(fingerprintOrientation(withWork, 7), fingerprintOrientation(withWork, 8))).toBe(false);
  });

  it('CONTROL: the pre-P-023 comparator cannot tell a boundary crossing apart', () => {
    // Falsifiability control, kept permanently rather than proved by mutating the
    // tree (the repo's tier for a module subject: a deliberately-wrong
    // implementation lives beside the real one). Without it the assertions above
    // could pass for the wrong reason — e.g. if the two states differed in some
    // field other than the epoch, "re-emits" would be true but vacuous.
    //
    // Here every content field is identical BY CONSTRUCTION (same `withWork`), so
    // the old three-field comparator returns "unchanged" and would suppress the
    // block. That is the exact defect: a fresh successor, told nothing.
    const a = fingerprintOrientation(withWork, 7);
    const b = fingerprintOrientation(withWork, 8);
    const preP023Comparator = a.held === b.held && a.unanswered === b.unanswered && a.loop === b.loop;
    expect(preP023Comparator).toBe(true); // old logic: "nothing changed" → silence
    expect(orientationUnchanged(a, b)).toBe(false); // new logic: context moved → speak
  });
});

describe('turn-start-orientation — what it says', () => {
  it('leads with unanswered directed mail — it outranks the agent’s own work', () => {
    const [first] = renderOrientationLines(withWork);
    expect(first).toContain('awaiting YOUR reply');
  });

  it('warns explicitly when NO wake source is armed', () => {
    const out = composeOrientationBlock({
      state: { ...withWork, loopArmed: false },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('not armed');
    expect(out).toContain('if authorized');
    expect(out).toContain('finish or use permitted wake');
    expect(out).not.toContain('halt silently');
  });

  it('labels an armed loop fire withheld for interaction instead of making it look unarmed', () => {
    const out = composeOrientationBlock({
      state: { ...withWork, loopFireWithheld: true },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('engine loop: ARMED — fire pending, withheld for interactive turn.');
    expect(out).not.toContain('engine loop: not armed');
  });

  it('recognizes only a current, active withheld fire', () => {
    const fired = '2026-08-24T04:00:00.000Z';
    expect(isLoopFireWithheld({ active: true, lastFiredAt: fired, lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      true,
    );
    expect(isLoopFireWithheld({ active: true, lastFiredAt: fired, lastWithheldAt: fired })).toBe(true);
    expect(isLoopFireWithheld({ active: true, lastFiredAt: fired, lastWithheldAt: '2026-08-24T03:59:59.000Z' })).toBe(
      false,
    );
    expect(isLoopFireWithheld({ active: false, lastFiredAt: fired, lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      false,
    );
    expect(isLoopFireWithheld({ active: true, lastFiredAt: null, lastWithheldAt: '2026-08-24T04:00:01.000Z' })).toBe(
      false,
    );
    expect(
      isLoopFireWithheld({ active: true, lastFiredAt: 'not-a-time', lastWithheldAt: '2026-08-24T04:00:01.000Z' }),
    ).toBe(false);
  });

  it('reads the withheld-fire signal from the shared loop-status discriminator', async () => {
    getLoopStatusMock.mockResolvedValue({
      active: true,
      lastFiredAt: '2026-08-24T04:00:00.000Z',
      lastWithheldAt: '2026-08-24T04:00:01.000Z',
    });
    expect(await defaultOrientationDeps().loopFireWithheld('su-1')).toBe(true);

    getLoopStatusMock.mockResolvedValue({
      active: true,
      lastFiredAt: '2026-08-24T04:00:02.000Z',
      lastWithheldAt: '2026-08-24T04:00:01.000Z',
    });
    expect(await defaultOrientationDeps().loopFireWithheld('su-1')).toBe(false);
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-1');
  });

  it('derives armed and withheld loop fields from one owner-status snapshot', async () => {
    getLoopStatusMock.mockClear();
    getLoopStatusMock.mockResolvedValue({
      active: true,
      lastFiredAt: '2026-08-24T04:00:00.000Z',
      lastWithheldAt: '2026-08-24T04:00:01.000Z',
    });
    const deps = defaultOrientationDeps();
    const [armed, withheld] = await Promise.all([
      deps.loopArmed('su-1'),
      deps.loopFireWithheld('su-1'),
    ]);

    expect(armed).toBe(true);
    expect(withheld).toBe(true);
    expect(getLoopStatusMock).toHaveBeenCalledTimes(1);
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-1');

    getLoopStatusMock.mockClear();
    getLoopStatusMock.mockResolvedValue({ active: false });
    expect(await defaultOrientationDeps().loopArmed('su-1')).toBe(false);
    expect(getLoopStatusMock).toHaveBeenCalledTimes(1);
    expect(getLoopStatusMock).toHaveBeenCalledWith('su-1');
  });

  it('tells an agent holding nothing to claim before editing', () => {
    const out = composeOrientationBlock({
      state: { ...base, unansweredDirected: 1 },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('holding: nothing');
  });

  it('does not report holding nothing when the held-item read fails', async () => {
    const state = await resolveOrientationState('su-1', 'ws-1', {
      ...quietDeps,
      held: async () => { throw new Error('held-item read failed'); },
    });
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH });
    expect(out).toContain('held work-items: unavailable');
    expect(out).not.toContain('holding: nothing');
    expect(fingerprintOrientation(state, EPOCH).held).toBe('!unavailable');
    expect(fingerprintOrientation({ ...state, held: withWork.held, heldReadFailed: false }, EPOCH).held)
      .toBe(fingerprintOrientation(withWork, EPOCH).held);
  });

  it('folds held checkpoints, staleness, announced gates, and actionable inbox headlines', () => {
    const state: OrientationState = {
      ...withWork,
      held: [
        { ...withWork.held[0]!, checkpointStale: true },
        { id: 'WI-2', status: 'wip', checkpoint: null },
      ],
    };
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH });
    expect(out).toContain('stale checkpoint: WI-1');
    expect(out).toContain('no checkpoint: WI-2');
    expect(out).toContain('announced gates: fleet:atlas:phase-open');
    expect(out).toContain('checkpoint WI-1: Implemented the reader');
    expect(out).toContain('inbox su-peer: Need your decision');
  });

  describe('announced-gate metadata warnings', () => {
    it('warns before await selection when a global gate resembles a plan-item key', () => {
      expect(
        buildAnnouncedGateWarning({
          event: 'p006-complete',
          logical_gate: 'P-006',
          scope: 'global',
          announcedBy: 'su-ended',
        }),
      ).toContain('AMBIGUOUS GLOBAL');
    });

    it('warns when the declarer is stale and has no live successor', () => {
      expect(
        buildAnnouncedGateWarning({
          event: 'fleet:backend:release-ready',
          scope: 'fleet:backend',
          announcedBy: 'su-ended',
          stale_owner: true,
        }),
      ).toContain('STALE announced gate');
    });

    it('does not label a scoped plan-item-like gate as globally ambiguous', () => {
      expect(
        buildAnnouncedGateWarning({
          event: 'fleet:backend:p006-complete',
          scope: 'fleet:backend',
        }),
      ).toBeUndefined();
    });

    it('re-emits when announced-gate metadata changes, including a warning', () => {
      const plain = fingerprintOrientation(
        { ...base, announcedGates: [{ event: 'p006-complete', note: null }] },
        EPOCH,
      );
      const warned = fingerprintOrientation(
        {
          ...base,
          announcedGates: [
            {
              event: 'p006-complete',
              note: null,
              logical_gate: 'P-006',
              live_awaiters: 0,
              stale_owner: true,
              warning: 'STALE announced gate p006-complete',
            },
          ],
        },
        EPOCH,
      );
      expect(orientationUnchanged(plain, warned)).toBe(false);
      expect(
        renderOrientationLines({
          ...base,
          announcedGates: [
            { event: 'p006-complete', note: null, warning: 'AMBIGUOUS GLOBAL announced gate p006-complete' },
          ],
        }),
      ).toContain('- ⚠ AMBIGUOUS GLOBAL announced gate p006-complete');
    });
  });

  // P-017 (plan turn-start-memory-two-class-2026-09-21): the improvement-triage
  // line is WITHDRAWN from the per-turn block. It rendered every single turn and
  // produced no observed action, which is what teaches a reader to skip the whole
  // block. `selectOrientationImprovementTriage` and the provider are untouched —
  // the full coord:orient payload still serves this on demand.
  it('does not render an improvement-triage line in the per-turn block (P-017 withdrawal)', () => {
    const out = composeOrientationBlock({
      state: {
        ...base,
        improvementTriage: {
          pending: 6,
          considered: 6,
          lowerBound: false,
          top: { id: 'EI-6', title: 'Repeated coord send truncation', lane: 'human' },
        },
      },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).not.toContain('improvement triage');
    expect(out).not.toContain('EI-6');
  });

  it('does not let an improvement-triage change alone re-emit the block (P-017 watermark withdrawal)', () => {
    // The paired half of the withdrawal: if `triage` stayed in the watermark, a
    // triage-only delta would mark the block changed and re-emit it with nothing
    // visibly different — a re-emit whose cause the reader cannot see.
    // Built on `withWork` (not `base`) deliberately: a triage-only state is now
    // EMPTY, so an empty baseline would satisfy the '' assertion for the wrong
    // reason and measure nothing.
    const triageState = (pending: number): OrientationState => ({
      ...withWork,
      improvementTriage: {
        pending,
        considered: 100,
        lowerBound: true,
        top: { id: `EI-${pending}`, title: 'Bound the population', lane: 'human' },
      },
    });
    const committed = fingerprintOrientation(triageState(80), EPOCH);
    expect(orientationUnchanged(committed, fingerprintOrientation(triageState(81), EPOCH, committed))).toBe(
      true,
    );
    expect(composeOrientationBlock({ state: triageState(81), committed, epoch: EPOCH })).toBe('');
    // Calibration: the same comparison MUST still detect a change the reader can
    // see, or the assertion above would pass on a fingerprint that ignores
    // everything.
    const realChange = { ...triageState(81), unansweredDirected: withWork.unansweredDirected + 1 };
    expect(orientationUnchanged(committed, fingerprintOrientation(realChange, EPOCH, committed))).toBe(false);
  });

  it('preserves the one human-queue ranker order while filtering untriaged rows', () => {
    const item = (id: string, score: number): ScoredItem => ({
      id,
      kind: 'change',
      title: id,
      scope: 'operator-core',
      tier: 'human',
      score,
      ageDays: 1,
      tierReason: 'test',
    });
    const rankedFirst = item('EI-ranked-first', 1);
    const legacyScoreFirst = item('EI-legacy-score-first', 100);
    const humanQueue = [rankedFirst, legacyScoreFirst];

    expect(
      selectOrientationImprovementTriage({ humanQueue, autoEligible: [] }, selectUntriaged, {
        considered: 2,
        lowerBound: false,
      }),
    ).toEqual({
      pending: 2,
      considered: 2,
      lowerBound: false,
      top: { id: 'EI-ranked-first', title: 'EI-ranked-first', lane: 'human' },
    });
    expect(humanQueue.map((candidate) => candidate.id)).toEqual(['EI-ranked-first', 'EI-legacy-score-first']);
  });

  it('keeps no-wake and checkpoint warnings ahead of lower-priority fold content', () => {
    const lines = renderOrientationLines({
      ...withWork,
      loopArmed: false,
      held: [{ ...withWork.held[0]!, checkpointStale: true }],
    });
    const directed = lines.findIndex((line) => line.includes('awaiting YOUR reply'));
    const noWake = lines.findIndex((line) => line.includes('engine loop: not armed'));
    const stale = lines.findIndex((line) => line.includes('stale checkpoint'));
    const gates = lines.findIndex((line) => line.includes('announced gates'));
    expect(lines[noWake]).toContain('if authorized');
    expect(lines[noWake]).toContain('finish or use permitted wake');
    expect(lines[noWake]).not.toContain('or you halt silently');
    expect(directed).toBeLessThan(noWake);
    expect(noWake).toBeLessThan(stale);
    expect(stale).toBeLessThan(gates);
  });

  it('resolves every new fold leg through injectable shared-reader seams', async () => {
    const state = await resolveOrientationState('su-1', 'ws-1', {
      held: async () => [{ id: 'WI-9', checkpoint: 'continue here', checkpointStale: true }],
      historyUpdates: async () => [{ workItemId: 'WI-9', count: 1, newestPostId: 12 }],
      effortUpdates: async () => [{ level: 'plan', ref: 'p-9', count: 1, newestPostId: 13 }],
      inbox: async () => ({
        count: 1,
        newest: [{ msgId: 'm-9', from: 'su-2', summary: 'Please answer.' }],
      }),
      announcedGates: async () => [{ event: 'fleet:f:ready' }],
      modes: async () => [
        {
          axisKey: 'autonomy',
          mode: 'auto',
          reason: 'owner said run autonomously',
          setBy: 'su-owner',
          setBySelf: false,
          ownerDirected: true,
          impliedBy: null,
        },
      ],
      loopArmed: async () => true,
      loopFireWithheld: async () => true,
      improvementTriage: async () => ({
        pending: 2,
        considered: 2,
        lowerBound: false,
        top: { id: 'EI-9', title: 'Act on this filing', lane: 'human' },
      }),
      executableFrontier: async () => ({ planSlug: 'one-plan', executableWidth: 2 }),
      obligations: async () => obligationBrief(),
      neverDropFacts: async () => ['guard-rail:some-settled-thing'],
      // P-010's leg. Injected rather than left to the default reader on purpose:
      // this test's whole subject is that every fold leg resolves through an
      // INJECTABLE seam, and an un-injected leg would silently reach the real
      // loop/DB readers from a unit test.
      openChecks: async () => [
        {
          id: 'claim:a carried claim nobody has re-probed',
          claim: 'a carried claim nobody has re-probed',
          recheck: 'run the stored probe',
          pointer: 'loop:status',
          kind: 'check' as const,
        },
      ],
      // P-015's leg, injected for the same reason as openChecks above. `deps`
      // is Partial and resolveOrientationState fills the gaps from
      // defaultOrientationDeps(), so an UN-injected lockTransitions reaches the
      // real lock tables from a unit test — on this box that read SUCCEEDS and
      // returns whatever the live fleet happens to hold, which is how this
      // assertion first failed. The `observed` token below is deliberately
      // unproducible by the default reader, so the assertion proves the value
      // came through the seam rather than merely that some value arrived.
      lockTransitions: async () => ({ held: [], blocked: [], observed: ['h:seam:proof'] }),
      // P-016's leg, injected for the same reason as lockTransitions above: an
      // UN-injected coupledPeers reaches the real coupling + presence tables.
      // The owner id is unproducible by the default reader (no such session),
      // so a match proves the value came through the seam.
      coupledPeers: async () => [{ ownerId: 'su-seam-proof', ownerLabel: null, intent: 'seam proof' }],
    });
    expect(state).toEqual({
      held: [{ id: 'WI-9', checkpoint: 'continue here', checkpointStale: true }],
      historyUpdates: [{ workItemId: 'WI-9', count: 1, newestPostId: 12 }],
      effortUpdates: [{ level: 'plan', ref: 'p-9', count: 1, newestPostId: 13 }],
      unansweredDirected: 1,
      unansweredStale: 0,
      openAsks: null,
      inboxRecent: [{ msgId: 'm-9', from: 'su-2', summary: 'Please answer.' }],
      announcedGates: [{ event: 'fleet:f:ready' }],
      modes: [
        {
          axisKey: 'autonomy',
          mode: 'auto',
          reason: 'owner said run autonomously',
          setBy: 'su-owner',
          setBySelf: false,
          ownerDirected: true,
          impliedBy: null,
        },
      ],
      authorityVerdict: null,
      lockTransitions: { held: [], blocked: [], observed: ['h:seam:proof'] },
      coupledPeers: [{ ownerId: 'su-seam-proof', ownerLabel: null, intent: 'seam proof' }],
      loopArmed: true,
      loopFireWithheld: true,
      improvementTriage: {
        pending: 2,
        considered: 2,
        lowerBound: false,
        top: { id: 'EI-9', title: 'Act on this filing', lane: 'human' },
      },
      executableFrontier: { planSlug: 'one-plan', executableWidth: 2 },
      obligations: obligationBrief(),
      neverDropFacts: ['guard-rail:some-settled-thing'],
      toolSurface: null,
      carryBlindWindow: null,
      openChecks: [
        {
          id: 'claim:a carried claim nobody has re-probed',
          claim: 'a carried claim nobody has re-probed',
          recheck: 'run the stored probe',
          pointer: 'loop:status',
          kind: 'check',
        },
      ],
    });
  });

  it('reports the activity gap without asserting registration, and re-emits as hooks increase', () => {
    const first: OrientationState = {
      ...base,
      unansweredDirected: 1,
      toolSurface: { hookCalls: 20, windowMinutes: 3 },
    };
    const firstBlock = composeOrientationBlock({ state: first, committed: null, epoch: EPOCH });
    expect(firstBlock).toContain('No agent-origin MCP calls recorded in 3m');
    expect(firstBlock).toContain('20 harness beats');
    expect(firstBlock).toContain('Tool-list registration is unknown');
    expect(firstBlock).not.toContain('RESTART THE SESSION');

    const committed = fingerprintOrientation(first, EPOCH);
    const second: OrientationState = {
      ...first,
      toolSurface: { hookCalls: 21, windowMinutes: 3 },
    };
    const secondBlock = composeOrientationBlock({ state: second, committed, epoch: EPOCH });
    expect(orientationUnchanged(committed, fingerprintOrientation(second, EPOCH))).toBe(false);
    expect(secondBlock).toContain('No agent-origin MCP calls recorded in 3m');
    expect(secondBlock).toContain('21 harness beats');
    expect(secondBlock).not.toContain('Tool list loaded EMPTY');
    expect(secondBlock.indexOf('No agent-origin MCP calls recorded')).toBeLessThan(
      secondBlock.indexOf('directed msg(s) awaiting YOUR reply'),
    );
  });

  it('degrades a failed improvement read to silence instead of a false zero', async () => {
    const state = await resolveOrientationState('su-1', 'ws-1', {
      held: async () => [],
      inbox: async () => ({ count: 0, newest: [] }),
      announcedGates: async () => [],
      loopArmed: async () => false,
      loopFireWithheld: async () => false,
      improvementTriage: async () => {
        throw new Error('ranker unavailable');
      },
      executableFrontier: async () => {
        throw new Error('frontier unavailable');
      },
      obligations: async () => {
        throw new Error('obligation reader unavailable');
      },
    });
    expect(state.improvementTriage).toBeNull();
    expect(state.executableFrontier).toBeNull();
    expect(state.obligations).toBeUndefined();
    expect(composeOrientationBlock({ state, committed: null, epoch: EPOCH })).toBe('');
  });
});

describe('turn-start-orientation — what it costs', () => {
  // EI-20085805220385722 — the stale half must stay VISIBLE without inheriting
  // the "answer first" priority. Both halves of that are asserted: an agent
  // whose only asks come from dead senders must not be told to drop its work,
  // and must not have the obligation silently disappear either.
  it('reports ended-sender asks WITHOUT the answer-first priority', () => {
    const out = composeOrientationBlock({
      state: { ...base, unansweredDirected: 0, unansweredStale: 2 },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('2 more from ENDED senders');
    expect(out).not.toContain('awaiting YOUR reply');
  });

  it('re-emits when a sender DIES and its ask moves from live to stale', () => {
    // The total is unchanged, so a fingerprint folding the two together would
    // suppress precisely the transition the reader needs to see.
    const live: OrientationState = { ...base, unansweredDirected: 1, unansweredStale: 0 };
    const died: OrientationState = { ...base, unansweredDirected: 0, unansweredStale: 1 };
    expect(orientationUnchanged(fingerprintOrientation(live, EPOCH), fingerprintOrientation(died, EPOCH))).toBe(false);
  });

  it('never exceeds its budget, even with an absurd number of held items', () => {
    const state: OrientationState = {
      ...base,
      held: Array.from({ length: 200 }, (_, i) => ({ id: `WI-${i}`, status: 'wip' })),
      unansweredDirected: 4,
      loopArmed: false,
    };
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH });
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
  });

  it('uses the expanded default budget for crowded turn-start state', () => {
    const state: OrientationState = {
      ...base,
      held: Array.from({ length: 12 }, (_, i) => ({
        id: `WI-${i}`,
        status: 'wip',
        checkpoint: 'A long checkpoint '.repeat(8),
        checkpointUpdatedAtMs: 1_000,
        checkpointStale: false,
      })),
      historyUpdates: [
        { workItemId: 'WI-0', harness: 'papercusp', count: 2, newestPostId: 1 },
        { workItemId: 'WI-1', harness: 'papercusp', count: 2, newestPostId: 2 },
      ],
      unansweredDirected: 4,
      loopArmed: false,
    };

    const narrow = composeOrientationBlock({ state, committed: null, epoch: EPOCH, budgetChars: 600 });
    const expanded = composeOrientationBlock({ state, committed: null, epoch: EPOCH });

    expect(ORIENTATION_BUDGET_CHARS).toBe(1_000);
    expect(expanded.length).toBeGreaterThan(narrow.length);
    expect(expanded.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
    expect(expanded).toContain('checkpoint WI-0');
  });

  it('drops the LOWEST-priority line under pressure, keeping unanswered mail', () => {
    const state: OrientationState = {
      ...base,
      held: [{ id: `WI-${'x'.repeat(120)}`, status: 'wip' }],
      unansweredDirected: 4,
      loopArmed: false,
    };
    const out = composeOrientationBlock({ state, committed: null, epoch: EPOCH, budgetChars: 160 });
    expect(out).toContain('awaiting YOUR reply');
    expect(out).not.toContain('engine loop');
  });

  it('emits NOTHING rather than a bare header when the budget fits no real line', () => {
    const out = composeOrientationBlock({
      state: withWork,
      committed: null,
      epoch: EPOCH,
      budgetChars: 10,
    });
    expect(out).toBe('');
  });
});

/**
 * EI-21309540201944554. coord:orient folds the never-drop tier on EVERY tick
 * (EI-18725816532600240, after a cold wake was told to implement an approach a
 * `dead-end:` fact had already falsified). This block fires even more often and
 * did not inherit that rule, so a settled do-not-repeat was invisible to the
 * agent it was written for unless it spent a coord:orient round-trip.
 */
describe('never-drop facts fold', () => {
  const KEYS = [
    'guard-rail:verifying-owner-speech-in-transcripts',
    'wall:host-bundle-unbuildable-at-staging-head',
    'dead-end:readinbox-push-filters-into-sql',
  ];
  const factLine = (state: OrientationState): string | undefined =>
    renderOrientationLines(state).find((l) => l.includes('never-drop facts'));

  it('surfaces the keys, and says how many it did not show', () => {
    const line = factLine({ ...base, neverDropFacts: KEYS });
    expect(line).toBeDefined();
    // Asserted on the legible HEAD, not the whole key: this one is 48 chars and
    // is deliberately clipped to FACT_KEY_CHARS to protect the budget.
    expect(line).toContain('guard-rail:verifying-owner-speech');
    expect(line).toContain('+1 more');
  });

  it('truncates a long key WITHOUT eating the type prefix', () => {
    // The prefix says how much authority the fact carries; a key clipped to a
    // bare "guard-r…" would cost the reader the only glanceable part.
    const line = factLine({ ...base, neverDropFacts: [`guard-rail:${'x'.repeat(120)}`] });
    expect(line).toContain('guard-rail:');
    expect(line).toContain('…');
  });

  it('ranks the do-not-repeat ABOVE the what-to-work-on lines', () => {
    // The what-to-work-on line here used to be improvement-triage; that class is
    // withdrawn from the per-turn block (P-017), so the ordering property is now
    // carried by the executable frontier, which renders in the same position.
    const lines = renderOrientationLines({
      ...base,
      neverDropFacts: KEYS,
      executableFrontier: { planSlug: 'turn-start-memory-two-class-2026-09-21', executableWidth: 3 },
    });
    const factIdx = lines.findIndex((l) => l.includes('never-drop facts'));
    const workIdx = lines.findIndex((l) => l.includes('frontier:'));
    expect(factIdx).toBeGreaterThanOrEqual(0);
    // Both indices must be REAL, or `-1 > n` would silently make this vacuous.
    expect(workIdx).toBeGreaterThanOrEqual(0);
    // Ordering IS the feature: a guard rail is worth almost nothing once the
    // agent has already picked an approach off the line below it.
    expect(workIdx).toBeGreaterThan(factIdx);
  });

  it('is not an empty orientation when a never-drop fact is the only signal', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(isEmptyOrientation({ ...base, neverDropFacts: KEYS })).toBe(false);
  });

  it('re-emits when a NEW guard rail lands — the turn it first applies is the one that matters', () => {
    const before = fingerprintOrientation({ ...base, neverDropFacts: [KEYS[0]] }, EPOCH);
    const after = fingerprintOrientation({ ...base, neverDropFacts: KEYS }, EPOCH);
    expect(orientationUnchanged(before, after)).toBe(false);
  });

  it('does NOT re-emit merely because the fold returned the same keys in another order', () => {
    const a = fingerprintOrientation({ ...base, neverDropFacts: [KEYS[0], KEYS[1]] }, EPOCH);
    const b = fingerprintOrientation({ ...base, neverDropFacts: [KEYS[1], KEYS[0]] }, EPOCH);
    expect(orientationUnchanged(a, b)).toBe(true);
  });

  it('stays inside the default budget even with many long keys', () => {
    // composeOrientationBlock BREAKS on the first line that does not fit, so an
    // unbounded fact line would silently truncate every line below it.
    const many = Array.from({ length: 25 }, (_, i) => `guard-rail:${'long-slug-'.repeat(4)}${i}`);
    const out = composeOrientationBlock({
      state: { ...base, neverDropFacts: many },
      committed: null,
      epoch: EPOCH,
    });
    expect(out.length).toBeLessThanOrEqual(ORIENTATION_BUDGET_CHARS);
    expect(out).toContain('never-drop facts');
  });

  it('still renders the higher-priority warning lines alongside it', () => {
    const out = composeOrientationBlock({
      state: { ...base, neverDropFacts: KEYS, unansweredDirected: 2 },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('directed msg(s) awaiting YOUR reply');
    expect(out).toContain('never-drop facts');
  });
});

/**
 * WI-2142142 — the SENDER-side mirror of the unanswered-directed line: asks
 * THIS agent made that a peer has not yet answered ("what am I still owed?",
 * as opposed to `unansweredDirected`'s "what do I still owe?").
 */
describe('open asks (WI-2142142 — "what am I still owed?")', () => {
  const openAsks = { count: 3, oldestAgeMs: 3_600_000, oldestTo: 'su-peer' };

  it('renders a line when there is at least one open ask', () => {
    const out = composeOrientationBlock({
      state: { ...base, openAsks },
      committed: null,
      epoch: EPOCH,
    });
    expect(out).toContain('3 open ask(s) sent');
    expect(out).toContain('awaiting su-peer');
  });

  it('is absent, and does not break isEmptyOrientation, when openAsks is null', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(composeOrientationBlock({ state: base, committed: null, epoch: EPOCH })).toBe('');
  });

  it('renders below the unanswered-directed line — an ask you are owed never outranks one you owe', () => {
    const lines = renderOrientationLines({ ...withWork, openAsks });
    const directed = lines.findIndex((l) => l.includes('awaiting YOUR reply'));
    const owed = lines.findIndex((l) => l.includes('open ask(s) sent'));
    expect(directed).toBeGreaterThanOrEqual(0);
    expect(owed).toBeGreaterThan(directed);
  });

  it('says NOTHING on a turn where the open-ask count is unchanged — mirrors unansweredDirected', () => {
    const state = { ...withWork, openAsks };
    const committed = fingerprintOrientation(state, EPOCH);
    expect(composeOrientationBlock({ state, committed, epoch: EPOCH })).toBe('');
  });

  it('the fingerprint is COUNT-ONLY: age moving alone must not re-emit, but the count moving must', () => {
    const state = { ...withWork, openAsks };
    const committed = fingerprintOrientation(state, EPOCH);
    // Same age-token exclusion rule as `unanswered` beside it: a fingerprint keyed
    // on oldestAgeMs would re-emit every turn purely because time passed.
    expect(
      composeOrientationBlock({
        state: { ...state, openAsks: { ...openAsks, oldestAgeMs: openAsks.oldestAgeMs + 60_000 } },
        committed,
        epoch: EPOCH,
      }),
    ).toBe('');
    expect(
      composeOrientationBlock({
        state: { ...state, openAsks: { ...openAsks, count: openAsks.count + 1 } },
        committed,
        epoch: EPOCH,
      }),
    ).not.toBe('');
  });
});

/**
 * EI-21442716425230784 — the carry blind window's line.
 *
 * A successor inherits a carry document built BEFORE the cut it describes: the
 * psu host waits on a busy-gate, and everything the predecessor does in that
 * window is absent from the doc. The doc warns that such a window exists but
 * carries no signal about THIS one, so the successor cannot tell an empty window
 * from one holding the most owner-salient act of the session (the reported case:
 * an OAuth consent URL the owner was explicitly asked to act on).
 */
describe('carry blind window line', () => {
  const window = {
    snapshotAtMs: Date.parse('2026-08-25T16:13:55.000Z'),
    cutAtMs: Date.parse('2026-08-25T16:17:52.000Z'),
    windowMs: 237_000,
    callsAfter: 26,
    lastCallAtMs: Date.parse('2026-08-25T16:17:33.000Z'),
    lastToolName: 'capability:bash',
  };

  it('renders above the directed-message line — it is the only line that DECAYS', () => {
    // Every other line describes state the agent can re-read all session. This one
    // describes turns living solely in a dead predecessor's transcript, so losing
    // it to budget truncation loses it permanently.
    const lines = renderOrientationLines({ ...withWork, carryBlindWindow: window });
    const blind = lines.findIndex((l) => l.includes('carry blind window'));
    const directed = lines.findIndex((l) => l.includes('directed msg(s)'));
    expect(blind).toBeGreaterThanOrEqual(0);
    expect(directed).toBeGreaterThanOrEqual(0);
    expect(blind).toBeLessThan(directed);
  });

  it('a measured window makes an otherwise-identical orientation re-emit', () => {
    // The shape this must survive: a successor's first turn holds exactly what its
    // predecessor held, so every other token is unchanged. A fingerprint blind to
    // the window would suppress the one warning that cannot be re-derived.
    const without = fingerprintOrientation(base, 7);
    const with_ = fingerprintOrientation({ ...base, carryBlindWindow: window }, 7);
    expect(orientationUnchanged(without, with_)).toBe(false);
  });

  it('does not re-emit while the same window stands — it is a one-shot', () => {
    const first = fingerprintOrientation({ ...base, carryBlindWindow: window }, 7);
    const second = fingerprintOrientation({ ...base, carryBlindWindow: { ...window } }, 7);
    expect(orientationUnchanged(first, second)).toBe(true);
  });

  it('a window alone is enough to spend the block on', () => {
    expect(isEmptyOrientation(base)).toBe(true);
    expect(isEmptyOrientation({ ...base, carryBlindWindow: window })).toBe(false);
  });

  it('degrades to silence when the reader fails, never to a manufactured window', async () => {
    getLoopStatusMock.mockResolvedValue({ active: false });
    const state = await resolveOrientationState('su-x', 'ws-1', {
      held: async () => [],
      inbox: async () => ({ count: 0, newest: [] }),
      announcedGates: async () => [],
      loopArmed: async () => false,
      loopFireWithheld: async () => false,
      improvementTriage: async () => null,
      executableFrontier: async () => null,
      obligations: async () => null,
      neverDropFacts: async () => [],
      toolSurface: async () => null,
      carryBlindWindow: async () => {
        throw new Error('host event log unreadable');
      },
      contextEpoch: async () => 1,
    });
    expect(state.carryBlindWindow).toBeNull();
  });
});
