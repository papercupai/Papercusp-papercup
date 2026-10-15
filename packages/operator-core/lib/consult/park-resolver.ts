/**
 * Park resolver (consult-backed-parking-2026-10-12 P-006).
 *
 * A product-decision park (work_items:set_blocker, P-005) is a peer review with a
 * DEFAULT action and a DEADLINE. This module is the PURE decision core: given a
 * snapshot of one park (its default, deadline, decision-review replies, the parked
 * agent's adopt/rebut responses and any owner answer) and `now`, it returns the
 * park outcome to record and the side effects to perform. It performs no I/O;
 * `runParkTriggers` (below) applies the actions through injected dependencies so
 * set_blocker, consult:reply and the consult expiry sweep can all drive it.
 *
 * Rules (plan Decisions D-002, D-003, D-004; bars R-5, R-6, R-14, R-16..R-19):
 * - Silence proceeds: at the deadline a park with no standing objection resolves to
 *   `proceed`, clears its blocker and is recorded as PEER REVIEW, never as owner
 *   approval (R-5, D-004).
 * - A standing objection (an `object` reply not withdrawn by its author and not
 *   answered by the parked agent) wakes the parked agent with `consider-alternative`
 *   (R-16). Adopting resolves the park to `adopted` (peer review). Rebutting advances
 *   the review cascade holding both positions (R-16); it does not drop the objection.
 * - An objection still standing when reviewers are exhausted (or at the deadline), or
 *   ANY owner-authority park at its deadline / reviewer exhaustion, becomes ONE owner
 *   question presenting both options (R-17). An owner-authority park never resolves
 *   to proceed (R-14).
 * - An owner answer at any time resolves to `owner-decided` with the owner's text;
 *   nothing a peer says afterwards overrides it (R-18).
 * - Only an outcome wakes the parked agent: a reply that changes no outcome emits
 *   nothing (R-19). Every outcome emits the verdict event with the verdict, the
 *   default, the alternative (when there is one) and the consult reference (R-6).
 */

export type DecisionReviewStance = 'support' | 'object' | 'no-view';
export type ObjectionBasis = 'alternative' | 'hazard' | 'owner-authority';

/** One decision-review reply (consult:reply, P-004). */
export interface ParkReply {
  /** Stable id of the reply (thread post / message id). */
  id: string;
  responderOwnerId: string;
  /** ISO timestamp. */
  at: string;
  stance: DecisionReviewStance;
  reason?: string | null;
  alternative?: string | null;
  basis?: ObjectionBasis | null;
}

/** The parked agent's answer to a standing objection. */
export interface ParkerResponse {
  kind: 'adopt' | 'rebut';
  at: string;
  text: string;
  /** The objection reply this responds to; omitted = the latest standing objection. */
  objectionId?: string | null;
}

export interface OwnerAnswer {
  at: string;
  text: string;
}

export type ParkVerdict = 'proceed' | 'consider-alternative' | 'owner-deciding' | 'owner-decided' | 'adopted';

/** Verdicts after which the park is settled and its blocker cleared. */
export const TERMINAL_PARK_VERDICTS: ReadonlySet<ParkVerdict> = new Set(['proceed', 'adopted', 'owner-decided']);

export interface ParkOutcomeRecord {
  verdict: ParkVerdict;
  at: string;
  /** Objection the outcome is about (consider-alternative / owner-deciding / adopted). */
  objectionId?: string | null;
}

export interface ParkState {
  consultId: string;
  workItemId: string;
  blockerRef: string;
  parkerOwnerId: string;
  question: string;
  defaultAction: string;
  /** ISO deadline. */
  deadlineAt: string;
  ownerAuthority: boolean;
  ownerAuthorityTopic?: string | null;
  replies: readonly ParkReply[];
  parkerResponses: readonly ParkerResponse[];
  ownerAnswer?: OwnerAnswer | null;
  /** The review cascade has no further reviewer to ask. */
  reviewersExhausted: boolean;
  /** Outcomes already recorded, oldest first. */
  outcomes: readonly ParkOutcomeRecord[];
  /** An owner question was already opened for this park (asked exactly once). */
  ownerQuestionOpened: boolean;
}

export interface ParkVerdictPayload {
  verdict: ParkVerdict;
  consultId: string;
  workItemId: string;
  blockerRef: string;
  defaultAction: string;
  alternative: string | null;
  objectionReason: string | null;
  ownerText: string | null;
  /** Peer outcomes are peer review; only an owner answer is the owner's decision (D-004). */
  recordedAs: 'peer-review' | 'owner';
}

export type ParkAction =
  | { kind: 'record-outcome'; outcome: ParkOutcomeRecord }
  | { kind: 'clear-blocker'; recordedAs: 'peer-review' | 'owner'; note: string }
  | { kind: 'emit-verdict'; payload: ParkVerdictPayload }
  | {
      kind: 'advance-cascade';
      positions: { default: string; rebuttal: string; objection: string; alternative: string | null };
    }
  | { kind: 'ask-owner'; question: string; options: [string, string] };

export interface ParkDecision {
  verdict: ParkVerdict | null;
  actions: ParkAction[];
}

/** Event key the parking agent awaits (registered at park time by set_blocker). */
export function parkVerdictEventKey(consultId: string): string {
  return `consult:park-verdict:${consultId}`;
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

function latestOutcome(state: ParkState): ParkOutcomeRecord | null {
  return state.outcomes.length ? state.outcomes[state.outcomes.length - 1]! : null;
}

/**
 * Objections that still stand: an `object` reply whose author has not since replied
 * with a non-objecting stance, and which the parked agent has not adopted. A rebuttal
 * answers the objection but does NOT withdraw it — the disagreement goes on through
 * the cascade (R-16) and, if it survives, to the owner (R-17).
 */
export function standingObjections(state: ParkState): ParkReply[] {
  const replies = [...state.replies].sort((a, b) => ms(a.at) - ms(b.at));
  const latestByResponder = new Map<string, ParkReply>();
  for (const r of replies) latestByResponder.set(r.responderOwnerId, r);
  return [...latestByResponder.values()]
    .filter((r) => r.stance === 'object')
    .sort((a, b) => ms(a.at) - ms(b.at));
}

/** The parker's latest response that addresses `objection` (explicitly, or as the latest after it). */
function responseTo(state: ParkState, objection: ParkReply): ParkerResponse | null {
  let found: ParkerResponse | null = null;
  for (const r of state.parkerResponses) {
    const addresses = r.objectionId ? r.objectionId === objection.id : ms(r.at) >= ms(objection.at);
    if (addresses && (!found || ms(r.at) >= ms(found.at))) found = r;
  }
  return found;
}

function payload(
  state: ParkState,
  verdict: ParkVerdict,
  objection: ParkReply | null,
  ownerText: string | null = null,
): ParkVerdictPayload {
  return {
    verdict,
    consultId: state.consultId,
    workItemId: state.workItemId,
    blockerRef: state.blockerRef,
    defaultAction: state.defaultAction,
    alternative: objection?.alternative ?? null,
    objectionReason: objection?.reason ?? null,
    ownerText,
    recordedAs: verdict === 'owner-decided' ? 'owner' : 'peer-review',
  };
}

function outcomeActions(
  state: ParkState,
  verdict: ParkVerdict,
  at: string,
  objection: ParkReply | null,
  ownerText: string | null = null,
): ParkAction[] {
  const actions: ParkAction[] = [
    { kind: 'record-outcome', outcome: { verdict, at, objectionId: objection?.id ?? null } },
  ];
  if (TERMINAL_PARK_VERDICTS.has(verdict)) {
    const recordedAs = verdict === 'owner-decided' ? 'owner' : 'peer-review';
    const note =
      verdict === 'proceed'
        ? `Peer review: no standing objection at the deadline; proceeding with the default: ${state.defaultAction}`
        : verdict === 'adopted'
          ? `Peer review: adopted the reviewer's alternative: ${objection?.alternative ?? ''}`
          : `Owner decided: ${ownerText ?? ''}`;
    actions.push({ kind: 'clear-blocker', recordedAs, note });
  }
  actions.push({ kind: 'emit-verdict', payload: payload(state, verdict, objection, ownerText) });
  return actions;
}

/** Decide what (if anything) happens to `state` at `now`. Pure and idempotent. */
export function resolvePark(state: ParkState, now: string): ParkDecision {
  const last = latestOutcome(state);

  // R-18: the owner's answer settles the park at any time and is never overridden.
  if (last?.verdict === 'owner-decided') return { verdict: null, actions: [] };
  if (state.ownerAnswer && state.ownerAnswer.text.trim()) {
    return {
      verdict: 'owner-decided',
      actions: outcomeActions(state, 'owner-decided', now, null, state.ownerAnswer.text),
    };
  }
  // Peer-settled parks stay settled; only an owner answer (above) reopens them.
  if (last && TERMINAL_PARK_VERDICTS.has(last.verdict)) return { verdict: null, actions: [] };

  const pastDeadline = ms(now) >= ms(state.deadlineAt);
  const standing = standingObjections(state);

  // Adoption of a standing objection settles the park as peer review (D-004).
  for (const o of standing) {
    const resp = responseTo(state, o);
    if (resp?.kind === 'adopt') {
      return { verdict: 'adopted', actions: outcomeActions(state, 'adopted', now, o) };
    }
  }

  const unanswered = standing.filter((o) => !responseTo(state, o));
  const rebutted = standing.filter((o) => responseTo(state, o)?.kind === 'rebut');
  const actions: ParkAction[] = [];

  // R-16: a rebuttal advances the cascade holding both positions — once per rebuttal.
  for (const o of rebutted) {
    const resp = responseTo(state, o)!;
    const advanced = state.outcomes.some(
      (r) => r.verdict === 'consider-alternative' && r.objectionId === o.id && ms(r.at) >= ms(resp.at),
    );
    if (!advanced) {
      actions.push({
        kind: 'advance-cascade',
        positions: { default: state.defaultAction, rebuttal: resp.text, objection: o.reason ?? '', alternative: o.alternative ?? null },
      });
      // Marker so the same rebuttal does not advance the cascade twice. It is a
      // record only — the parked agent itself rebutted, so it is not woken (R-19).
      actions.push({ kind: 'record-outcome', outcome: { verdict: 'consider-alternative', at: now, objectionId: o.id } });
    }
  }

  // R-17: exhausted reviewers with a standing objection, or any owner-authority park
  // at its deadline / exhaustion, becomes ONE owner question presenting both options.
  const escalate = (standing.length > 0 || state.ownerAuthority) && (state.reviewersExhausted || pastDeadline);
  if (escalate) {
    if (last?.verdict === 'owner-deciding' || state.ownerQuestionOpened) return { verdict: null, actions };
    const objection = standing[standing.length - 1] ?? null;
    const alternative =
      objection?.alternative?.trim() ||
      (objection ? `Do not take the default (${objection.reason ?? 'objection'})` : 'Do not take the default action');
    const topic = state.ownerAuthority ? ` [owner-authority: ${state.ownerAuthorityTopic ?? 'unspecified'}]` : '';
    actions.push({
      kind: 'ask-owner',
      question: `${state.question}${topic}`,
      options: [state.defaultAction, alternative],
    });
    actions.push(...outcomeActions(state, 'owner-deciding', now, objection));
    return { verdict: 'owner-deciding', actions };
  }

  // R-16: a new unanswered objection wakes the parked agent to adopt or rebut.
  const fresh = unanswered.find(
    (o) => !state.outcomes.some((r) => r.verdict === 'consider-alternative' && r.objectionId === o.id),
  );
  if (fresh) {
    actions.push(...outcomeActions(state, 'consider-alternative', now, fresh));
    return { verdict: 'consider-alternative', actions };
  }

  // R-5: silence (no standing objection) proceeds at the deadline. R-14: never for owner-authority.
  if (pastDeadline && standing.length === 0 && !state.ownerAuthority) {
    actions.push(...outcomeActions(state, 'proceed', now, null));
    return { verdict: 'proceed', actions };
  }

  // R-19: nothing changed an outcome — no wake.
  return { verdict: null, actions };
}

/** Side-effect seams the trigger layer needs; production wiring lives with the callers. */
export interface ParkTriggerDeps {
  loadPark(consultId: string): Promise<ParkState | null>;
  recordOutcome(state: ParkState, outcome: ParkOutcomeRecord): Promise<void>;
  clearBlocker(state: ParkState, input: { recordedAs: 'peer-review' | 'owner'; note: string }): Promise<void>;
  emitVerdict(eventKey: string, payload: ParkVerdictPayload): Promise<void>;
  advanceCascade(
    state: ParkState,
    positions: Extract<ParkAction, { kind: 'advance-cascade' }>['positions'],
  ): Promise<void>;
  askOwner(state: ParkState, input: { question: string; options: [string, string] }): Promise<void>;
}

export interface ParkTriggerResult {
  consultId: string;
  verdict: ParkVerdict | null;
  applied: ParkAction['kind'][];
}

/**
 * Load one park, resolve it at `now` and apply the resulting actions in order.
 * Called after set_blocker opens a park, after every decision-review reply, after a
 * parker adopt/rebut, after an owner answer, and by the consult expiry sweep for
 * parks past their deadline. Returns null when `consultId` is not a park.
 */
export async function runParkTriggers(
  deps: ParkTriggerDeps,
  consultId: string,
  now: string = new Date().toISOString(),
): Promise<ParkTriggerResult | null> {
  const state = await deps.loadPark(consultId);
  if (!state) return null;
  const decision = resolvePark(state, now);
  const applied: ParkAction['kind'][] = [];
  for (const action of decision.actions) {
    switch (action.kind) {
      case 'record-outcome':
        await deps.recordOutcome(state, action.outcome);
        break;
      case 'clear-blocker':
        await deps.clearBlocker(state, { recordedAs: action.recordedAs, note: action.note });
        break;
      case 'emit-verdict':
        await deps.emitVerdict(parkVerdictEventKey(state.consultId), action.payload);
        break;
      case 'advance-cascade':
        await deps.advanceCascade(state, action.positions);
        break;
      case 'ask-owner':
        await deps.askOwner(state, { question: action.question, options: action.options });
        break;
    }
    applied.push(action.kind);
  }
  return { consultId, verdict: decision.verdict, applied };
}
