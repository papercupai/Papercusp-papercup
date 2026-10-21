/**
 * wait-ref-admission.ts — event-wait-settlement-2026-10-20 P-006 (Design 6; D-001 item 2;
 * R-11, R-20): admit a NEW event/gate wait only when a fire can prove it was met.
 *
 * Every releasing path (emit-time settlement, announced settlement, the blocker re-check
 * sweep, durable-park settlement) releases on ONE predicate, `fireCertifiesCondition`. A
 * wait whose ref fails it can never be released by any of them, so writing it strands the
 * item. This is the write-time half: the same reader the releasing paths use classifies the
 * ref, and the writer refuses what no fire can prove, with the options that would work.
 *
 * Accepted: a catalogued completion key with its subject, an announced gate, a live
 * predicate watch (`predicate:<id>`) — anything `readEventConditionReachability` with
 * `requireSpecificCondition` reports reachable and not yet fired.
 * Refused:
 *  - unprovable — broad (`coord:inbox-wake:<owner>`, `git-sync:committed`), change
 *    notification (`work-item:status:<id>`), uncatalogued or free text;
 *  - already satisfied — a proving key whose latch (or current announcement) already
 *    records a fire: the wait would strand at once, because a fire before the wait is
 *    never credited to it (durable-park-release-contract.ts `firedTriggerCannotCertify`);
 *  - unreachable — the key's producer announcement was cancelled or expired;
 *  - unmeasured — the resolver failed. Fail-closed: a ledger outage must not let an
 *    unvalidated wait through; the caller retries.
 *
 * Deliberately imports `readEventConditionReachability` (not an intra-module call), so a
 * test that mocks `./external-condition-reachability` governs this admission too.
 */
import {
  readEventConditionReachability,
  type ExternalConditionReachability,
  type UncertifiedConditionReason,
} from './external-condition-reachability';

export type WaitRefRefusalCode =
  | 'wait_ref_unprovable'
  | 'wait_ref_already_satisfied'
  | 'wait_ref_unreachable'
  | 'wait_ref_unmeasured';

export type WaitRefAdmission =
  | { ok: true; reachability: ExternalConditionReachability }
  | {
      ok: false;
      code: WaitRefRefusalCode;
      reachability: ExternalConditionReachability;
      /** One self-contained sentence set: what is wrong with the ref and what to name instead. */
      detail: string;
    };

/** The four ways to express a wait that some fire (or a person) can resolve — S2's guidance. */
export const WAIT_REF_OPTIONS =
  'Name instead: (1) a key whose fire proves this exact condition — a catalogued completion family with ' +
  'its subject id, e.g. work-item:done:<id> or release:deployed:<sha> (events:catalog lists them); ' +
  "(2) an announced gate — the condition's owner declares it with events:emit { event, announce:true } " +
  'and you use the key it returns; (3) a predicate watch — watch:create / state:subscribe mints a ' +
  'predicate:<id> key that fires when the measured value crosses; or (4) when no event can prove it, a ' +
  'runtime or human blocker with recheckAt, so the re-check sweep escalates it to you on that date.';

const UNPROVABLE_REASON: Record<UncertifiedConditionReason, string> = {
  uncatalogued: 'is not a catalogued event key and no producer has announced it, so nothing will ever fire it',
  broad:
    'is a broad wake: it fires for reasons unrelated to this condition (any message, any commit, any fleet ' +
    'change), so a fire can never prove the condition was met',
  'change-notification':
    'is a change notification: a fire says its subject changed, not that it reached the state you are ' +
    'waiting for',
};

/**
 * Classify one event/gate ref for a NEW wait. `surface` only words the refusal: a blocker
 * `ref` and a durable-park `trigger` are the same thing to the releasing paths.
 */
export async function admitWaitRef(
  ref: string,
  opts: { surface: 'blocker' | 'park'; read?: typeof readEventConditionReachability } = { surface: 'blocker' },
): Promise<WaitRefAdmission> {
  const read = opts.read ?? readEventConditionReachability;
  const reachability = await read(ref, { requireSpecificCondition: true });
  const noun = opts.surface === 'park' ? 'park trigger' : 'wait ref';
  if (reachability.uncertifiedReason) {
    return {
      ok: false,
      code: 'wait_ref_unprovable',
      reachability,
      detail: `${noun} '${ref}' ${UNPROVABLE_REASON[reachability.uncertifiedReason]}. ${WAIT_REF_OPTIONS}`,
    };
  }
  if (reachability.basis === 'fired') {
    return {
      ok: false,
      code: 'wait_ref_already_satisfied',
      reachability,
      detail:
        `${noun} '${ref}' already fired (${reachability.firedAt ?? reachability.evidence}): the condition it ` +
        'proves already holds, and a fire that predates the wait is never credited to it, so the wait would ' +
        'strand at once. If you are not actually blocked, proceed without it; if something is still ' +
        `outstanding, that key does not express it. ${WAIT_REF_OPTIONS}`,
    };
  }
  if (reachability.verdict === 'reachable') return { ok: true, reachability };
  if (reachability.verdict === 'impossible') {
    return {
      ok: false,
      code: 'wait_ref_unreachable',
      reachability,
      detail:
        `${noun} '${ref}' can no longer fire: ${reachability.evidence}. Ask the condition's owner to ` +
        `re-announce it, or name a key that is still live. ${WAIT_REF_OPTIONS}`,
    };
  }
  return {
    ok: false,
    code: 'wait_ref_unmeasured',
    reachability,
    detail:
      `${noun} '${ref}' could not be validated (${reachability.evidence}); nothing was written. Retry — a ` +
      'new wait is only admitted once the event ledger shows a fire can prove it.',
  };
}
