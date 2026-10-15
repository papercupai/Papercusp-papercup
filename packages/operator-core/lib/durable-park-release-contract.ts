/**
 * durable-park-release-contract.ts — the ONE writer shape for a durable park's typed
 * release contract. Shared by `work_items:release { claimHold }` and the plan supersede
 * cascade (review-system-rework-reduction-2026-09-23 P-030), so both parkers resolve the
 * condition's live event status the same way.
 *
 * Deliberately its own module: it reads reachability through an IMPORT of
 * `readEventConditionReachability`, so a test that mocks `./external-condition-reachability`
 * governs this builder too (an intra-module call would bypass that mock).
 */
import { readEventConditionReachability } from './external-condition-reachability';
import type { DurableParkReleaseContract } from './work-items-durable-park-audit';

/** WI-10007568: completing the task that carries out a pause is not a resume.
 * Keep this legacy contradiction narrow: other terminal dependencies remain valid,
 * and an explicit owner disposition can still repair/clear the malformed contract. */
export function pauseCompletionResumeContradiction(condition: string, trigger: string): string | null {
  if (!/^work-item:done:[^\s]+$/.test(trigger.trim())) return null;
  const normalized = condition.normalize('NFKC').toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!/\b(?:ending|ends?|lifting|lifts?)\s+(?:this|the)\s+system[ -]wide\s+pause\b/.test(normalized)) return null;
  return 'completion of a pause task does not verify an explicit owner resume; repair the release condition and supply resume authority';
}

/** SPEC-BQL-P-004-CLEARER: a park whose trigger is the parked item's OWN terminal event can
 * never release the park. `work-item:done:<id>` fires only once the item is already finished,
 * and the catalogue's live resolver reports it reachable regardless (measured 2026-10-10:
 * four live parks, each stamped 'reachable'). That is a reservation encoded as a park, so it
 * is an unverified contract to repair, not a reachable one. */
export function selfReleaseTriggerContradiction(trigger: string, parkId: string | null | undefined): string | null {
  const id = parkId?.trim();
  if (!id || trigger.trim() !== `work-item:done:${id}`) return null;
  return `trigger ${trigger.trim()} is the parked item's own terminal event; it fires only after the item is finished, so it can never release this park. Declare the condition that permits resumption, or assign the item to its reserving owner instead of parking it`;
}

/** Parse an event fire time as the ledger renders it: ISO (`…Z`) or Postgres timestamptz text
 * (`2026-10-10 13:12:21.494399-04`). A time without an explicit offset is null, never a guess
 * in the host's zone. */
export function parseEventInstantMs(text: string | null | undefined): number | null {
  const trimmed = String(text ?? '').trim();
  // Legacy evidence rendered a postgres.js Date via Date.toString(): "Sun Oct 11 2026 07:22:44
  // GMT-0400 (Eastern Daylight Time)". It carries an explicit offset, so it is orderable.
  if (/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}\b/.test(trimmed)) {
    const ms = Date.parse(trimmed.replace(/\s*\(.*\)$/, ''));
    return Number.isFinite(ms) ? ms : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(trimmed);
  if (!m) return null;
  const frac = m[3] ? m[3].slice(0, 4) : '';
  let tz = m[4];
  if (tz !== 'Z') {
    const digits = tz.slice(1).replace(':', '');
    tz = `${tz[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`;
  }
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}${tz}`);
  return Number.isFinite(ms) ? ms : null;
}

/** EI-25664119449929994: a FIRED trigger certifies a release condition only when the fire
 * postdates the park and is not the parked item's own lifecycle event. Measured 2026-10-11:
 * all 9 live parks labelled satisfied-still-parked carried a latch that fired BEFORE the
 * park was written (the writer read the key's lifetime latch at park time), and 5 of them
 * were `work-item:status:<own id>`, which fires on any transition of the item, the parker's
 * own included. Returns why the fire cannot certify, or null when it can. `parkedAtMs` null
 * skips the ordering check (no park time on record). */
export function firedTriggerCannotCertify(input: {
  trigger: string;
  parkId?: string | null;
  firedAt: string | null | undefined;
  parkedAtMs: number | null;
}): string | null {
  const trigger = input.trigger.trim();
  const id = input.parkId?.trim();
  // Only the GENERIC status key is self-fulfilling: it fires on every transition of the item,
  // the parker's own included. A specific transition (work-item:unblocked:<own id>) still names
  // exactly one condition and keeps its stamp; the own terminal event is handled upstream.
  if (id && trigger === `work-item:status:${id}`) {
    return `trigger "${trigger}" is the parked item's own status event; it fires on any transition of the item (the park's own included), so it can wake a re-evaluation but cannot establish the release condition. Name a subject-bound trigger for the condition itself`;
  }
  if (input.parkedAtMs == null) return null;
  const firedMs = parseEventInstantMs(input.firedAt);
  if (firedMs == null) {
    return `trigger "${trigger}" fired at an unreadable time (${input.firedAt ?? 'none'}), so it cannot be shown to postdate the park; verify the condition directly`;
  }
  if (firedMs <= input.parkedAtMs) {
    return `trigger "${trigger}" last fired at ${input.firedAt}, before this park (${new Date(input.parkedAtMs).toISOString()}); a fire that predates the park cannot establish a condition declared at park time. If the condition already holds, clear the park; otherwise name a trigger that fires once it is met`;
  }
  return null;
}

/** Every contract shape that can never verify its own release, in precedence order. */
export function releaseContractContradiction(
  condition: string,
  trigger: string,
  parkId?: string | null,
): string | null {
  return pauseCompletionResumeContradiction(condition, trigger) ?? selfReleaseTriggerContradiction(trigger, parkId);
}

/** Reject incomplete durable parks at the shared write boundary, including internal producers. */
export function assertDurableParkReleaseContract(value: unknown): void {
  const contract = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const missing = ['condition', 'owner', 'trigger', 'evidence'].filter(
    (key) => typeof contract[key] !== 'string' || !(contract[key] as string).trim(),
  );
  if (!['reachable', 'blocked', 'unreachable', 'satisfied'].includes(String(contract.reachability))) {
    missing.push('reachability');
  }
  if (missing.length) {
    throw new Error(`durable park requires a complete release contract: ${missing.join(', ')}`);
  }
}

/** Resolve, rather than trust, the release condition. Only a specific condition's latch
 * that fired AFTER the park is satisfied; broad wakes, the parked item's own lifecycle
 * events, pre-park fires and unmeasured keys remain unverified. `parkedAt` defaults to now
 * (a new park); a re-evaluation of an existing park passes its `claim_hold_at`. */
export async function buildDurableParkReleaseContract(
  input: { condition: string; trigger: string; owner?: string; parkId?: string | null; parkedAt?: string | null },
  defaultOwner: string,
): Promise<DurableParkReleaseContract> {
  const contradiction = releaseContractContradiction(input.condition, input.trigger, input.parkId);
  if (contradiction) {
    return {
      condition: input.condition.trim(), owner: input.owner?.trim() || defaultOwner,
      trigger: input.trigger.trim(), reachability: 'blocked', evidence: contradiction,
    };
  }
  const reachability = await readEventConditionReachability(input.trigger, { requireSpecificCondition: true });
  const parsedParkedAt = input.parkedAt ? parseEventInstantMs(input.parkedAt) ?? Date.parse(input.parkedAt) : NaN;
  const uncertified = reachability.basis === 'fired'
    ? firedTriggerCannotCertify({
        trigger: input.trigger,
        parkId: input.parkId,
        firedAt: reachability.firedAt,
        parkedAtMs: Number.isFinite(parsedParkedAt) ? parsedParkedAt : Date.now(),
      })
    : null;
  if (uncertified) {
    return {
      condition: input.condition.trim(), owner: input.owner?.trim() || defaultOwner,
      trigger: input.trigger.trim(), reachability: 'blocked', evidence: uncertified,
    };
  }
  return {
    condition: input.condition.trim(),
    owner: input.owner?.trim() || defaultOwner,
    trigger: input.trigger.trim(),
    reachability:
      reachability.basis === 'fired'
        ? 'satisfied'
        : reachability.verdict === 'reachable'
          ? 'reachable'
          : reachability.verdict === 'impossible'
            ? 'unreachable'
            : 'blocked',
    evidence: reachability.evidence,
  };
}
