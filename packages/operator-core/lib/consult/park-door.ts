/**
 * consult-backed-parking-2026-10-12 P-005 — the product-decision park door.
 *
 * `work_items:set_blocker` routes an accepted product-decision blocker here.
 * In the same call the door:
 *   1. refuses unless a default action AND a deadline are stated (R-3), with
 *      the deadline bounded 15..1440 minutes from now (D-002);
 *   2. opens a decision-review consult whose `routing.cascade` carries the
 *      park identity (D-013 DecisionReviewCascadeMeta), so the P-006 resolver
 *      can read it from any trigger (R-13);
 *   3. registers the parking agent's wake on the verdict event (R-13);
 *   4. sends the owner a low-importance FYI (R-13).
 * An owner-authority topic is recorded on the cascade (R-14); the resolver,
 * not this door, guarantees such a park never resolves to proceed.
 *
 * Effects are injected (ParkDoorDeps) so the decision logic is unit-testable;
 * `makeProdParkDoorDeps` binds the real consult opener, await store and coord
 * send. Every import there is dynamic for the same reason as park-prod.ts.
 */
import {
  DECISION_REVIEW_CASCADE_FLAVOR,
  isOwnerAuthorityTopic,
  type DecisionReviewCascadeMeta,
  type OwnerAuthorityTopic,
} from './decision-review';
import { parkBlockerRef } from './park-adapters';
import { parkVerdictEventKey } from './park-resolver';

/** D-002: a park's deadline is bounded 15 to 1440 minutes from now. */
export const PARK_DEADLINE_MIN_MINUTES = 15;
export const PARK_DEADLINE_MAX_MINUTES = 1440;
/** The verdict wake outlives the deadline by this margin so a late resolver sweep still lands. */
export const PARK_WAKE_GRACE_SEC = 3600;

export interface ParkDoorRequest {
  workItemId: string;
  setterId: string;
  /** Stable per-request identity from the transport, reused when a park call is retried. */
  requestKey?: string | null;
  /** The decision being parked — the blocker summary. */
  question: string;
  /** What the parker will do if nobody objects (defaultIfUnanswered). */
  defaultIfUnanswered?: string | null;
  /** The deadline (decideBy), an ISO instant. */
  decideBy?: string | null;
  ownerAuthorityTopic?: string | null;
  /** The caller's own ref, kept as blocker evidence (the stored ref becomes consult:<id>). */
  callerRef?: string | null;
}

export type ParkDoorValidation =
  | { ok: true; defaultAction: string; deadlineAt: string; ownerAuthorityTopic: OwnerAuthorityTopic | null }
  | { ok: false; code: 'park_default_required' | 'park_deadline_required' | 'park_deadline_out_of_bounds' | 'park_owner_authority_topic_invalid'; error: string };

/** R-3 + D-002: the refusal half of the door. Pure; `nowMs` is injected. */
export function validateParkRequest(req: ParkDoorRequest, nowMs: number): ParkDoorValidation {
  const defaultAction = req.defaultIfUnanswered?.trim() ?? '';
  if (!defaultAction) {
    return {
      ok: false,
      code: 'park_default_required',
      error:
        'a product-decision park needs `defaultIfUnanswered`: the action you will take if no reviewer objects by the deadline. Blocker was not written.',
    };
  }
  const decideBy = req.decideBy?.trim() ?? '';
  if (!decideBy) {
    return {
      ok: false,
      code: 'park_deadline_required',
      error:
        `a product-decision park needs \`decideBy\`: an ISO deadline ${PARK_DEADLINE_MIN_MINUTES}–${PARK_DEADLINE_MAX_MINUTES} minutes from now ` +
        '(default choice: 60 minutes). Silence at the deadline resolves to your default. Blocker was not written.',
    };
  }
  const deadlineMs = Date.parse(decideBy);
  const minutes = (deadlineMs - nowMs) / 60_000;
  if (!Number.isFinite(deadlineMs) || minutes < PARK_DEADLINE_MIN_MINUTES || minutes > PARK_DEADLINE_MAX_MINUTES) {
    return {
      ok: false,
      code: 'park_deadline_out_of_bounds',
      error:
        `decideBy '${decideBy}' must be a parseable ISO instant ${PARK_DEADLINE_MIN_MINUTES}–${PARK_DEADLINE_MAX_MINUTES} minutes from now ` +
        `(got ${Number.isFinite(minutes) ? `${Math.round(minutes)} minutes` : 'an unparseable value'}). Blocker was not written.`,
    };
  }
  const rawTopic = req.ownerAuthorityTopic ?? null;
  if (rawTopic !== null && !isOwnerAuthorityTopic(rawTopic)) {
    return {
      ok: false,
      code: 'park_owner_authority_topic_invalid',
      error: `ownerAuthorityTopic '${rawTopic}' is not one of spend, destructive, publish, credentials, security. Blocker was not written.`,
    };
  }
  return {
    ok: true,
    defaultAction,
    deadlineAt: new Date(deadlineMs).toISOString(),
    ownerAuthorityTopic: rawTopic,
  };
}

/** The park identity written on the consult's routing.cascade (D-013). */
export function parkCascadeMeta(
  req: Pick<ParkDoorRequest, 'workItemId' | 'setterId'>,
  valid: Extract<ParkDoorValidation, { ok: true }>,
): DecisionReviewCascadeMeta {
  return {
    flavor: DECISION_REVIEW_CASCADE_FLAVOR,
    workItemId: req.workItemId,
    setterId: req.setterId,
    defaultAction: valid.defaultAction,
    deadlineAt: valid.deadlineAt,
    ownerAuthorityTopic: valid.ownerAuthorityTopic,
  };
}

export interface ParkDoorDeps {
  now(): number;
  openConsult(input: {
    question: string;
    originTaskRef: string;
    cascade: DecisionReviewCascadeMeta;
    requestKey?: string;
    onAccepted?: (consultId: string) => Promise<void> | void;
  }): Promise<{ consultId: string }>;
  registerVerdictWake(input: { subscriberId: string; eventKey: string; timeoutSec: number; note: string }): Promise<void>;
  notifyOwner(input: { summary: string; body: string; workItemId: string }): Promise<void>;
}

export interface ParkOpened {
  consultId: string;
  blockerRef: string;
  verdictEvent: string;
  deadlineAt: string;
  defaultAction: string;
  ownerAuthorityTopic: OwnerAuthorityTopic | null;
  wakeRegistered: boolean;
  ownerNotified: boolean;
  /** Evidence line recording the caller's own ref, which the consult ref replaced. */
  evidence: string;
}

export type ParkDoorResult = { ok: true; park: ParkOpened } | Extract<ParkDoorValidation, { ok: false }> | { ok: false; code: 'park_consult_failed'; error: string };

/**
 * Open the decision-review consult for an accepted park. The consult is the park's
 * durable identity: it is opened FIRST, and its failure refuses the blocker. The wake
 * and the owner notice are best-effort after it — a failure there is reported on the
 * result, never silently dropped, and never un-parks the item.
 */
export async function openDecisionReviewPark(req: ParkDoorRequest, deps: ParkDoorDeps): Promise<ParkDoorResult> {
  const nowMs = deps.now();
  const valid = validateParkRequest(req, nowMs);
  if (!valid.ok) return valid;
  const cascade = parkCascadeMeta(req, valid);
  const timeoutSec = Math.max(60, Math.ceil((Date.parse(valid.deadlineAt) - nowMs) / 1000) + PARK_WAKE_GRACE_SEC);
  let wakeRegistered = false;
  let wakeRegistrationAttempted = false;
  const registerVerdictWake = async (consultId: string) => {
    wakeRegistrationAttempted = true;
    try {
      await deps.registerVerdictWake({
        subscriberId: req.setterId,
        eventKey: parkVerdictEventKey(consultId),
        timeoutSec,
        note: `park verdict for ${req.workItemId} (consult ${consultId})`,
      });
      wakeRegistered = true;
    } catch {
      wakeRegistered = false;
    }
  };
  let consultId: string;
  try {
    ({ consultId } = await deps.openConsult({
      question: req.question,
      originTaskRef: req.workItemId,
      cascade,
      ...(req.requestKey ? { requestKey: req.requestKey } : {}),
      onAccepted: registerVerdictWake,
    }));
  } catch (err) {
    return {
      ok: false,
      code: 'park_consult_failed',
      error: `decision-review consult could not be opened: ${err instanceof Error ? err.message : String(err)}. Blocker was not written.`,
    };
  }
  const verdictEvent = parkVerdictEventKey(consultId);
  // The production accepted-request helper calls this before it starts the
  // async reviewer continuation. Lightweight/test bindings may omit it; keep
  // the original best-effort fallback for those callers.
  if (!wakeRegistrationAttempted) await registerVerdictWake(consultId);
  let ownerNotified = false;
  try {
    const authority = valid.ownerAuthorityTopic ? ` Owner-authority topic: ${valid.ownerAuthorityTopic} — this park waits for you.` : '';
    await deps.notifyOwner({
      workItemId: req.workItemId,
      summary: `FYI (low importance): ${req.workItemId} parked for peer review until ${valid.deadlineAt}`,
      body:
        `Decision: ${req.question}\nDefault if no reviewer objects: ${valid.defaultAction}\n` +
        `Review consult: ${consultId}.${authority} No action needed unless you want to weigh in.`,
    });
    ownerNotified = true;
  } catch {
    ownerNotified = false;
  }
  return {
    ok: true,
    park: {
      consultId,
      blockerRef: parkBlockerRef(consultId),
      verdictEvent,
      deadlineAt: valid.deadlineAt,
      defaultAction: valid.defaultAction,
      ownerAuthorityTopic: valid.ownerAuthorityTopic,
      wakeRegistered,
      ownerNotified,
      evidence: req.callerRef ? `park opened decision-review consult ${consultId}; caller ref: ${req.callerRef}` : `park opened decision-review consult ${consultId}`,
    },
  };
}

/** Is this an active park re-assertion (ref already names the park's consult)? */
export function isParkReassertion(ref: string | undefined, activeRefs: readonly string[]): boolean {
  // Any ref already active as a product-decision blocker is a re-assertion: an active park
  // (consult:<id>) or a legacy owner ask written before parks existed. Neither opens a new park.
  return Boolean(ref && activeRefs.includes(ref));
}

/** Production bindings. */
export function makeProdParkDoorDeps(identity: import('../agent-tools/coordination/identity').AgentIdentity): ParkDoorDeps {
  return {
    now: () => Date.now(),
    async openConsult(input) {
      const { acceptFeedbackRequestProd } = await import('./get-feedback-prod');
      if (!identity.workspaceId) throw new Error('park needs a workspace-scoped caller to open its decision-review consult');
      const res = await acceptFeedbackRequestProd(
        {
          workspaceId: identity.workspaceId,
          requesterId: identity.ownerId,
          question: input.question,
          originTaskRef: input.originTaskRef,
          cascade: input.cascade,
          ...(input.requestKey ? { requestKey: input.requestKey } : {}),
        },
        identity,
        {
          ...(input.onAccepted
            ? { onAccepted: (accepted) => input.onAccepted!(accepted.conversation_id) }
            : {}),
        },
      );
      if ('error' in res) throw new Error(`decision-review consult refused: ${res.error}`);
      const consultId = typeof res.conversation_id === 'string' ? res.conversation_id : null;
      if (!consultId) throw new Error(`decision-review consult opened no conversation (verdict ${String(res.verdict)})`);
      return { consultId };
    },
    async registerVerdictWake(input) {
      const { registerAwait } = await import('../events/await/store');
      await registerAwait({
        subscriberId: input.subscriberId,
        eventKey: input.eventKey,
        note: input.note,
        timeoutSec: input.timeoutSec,
        once: true,
      });
    },
    async notifyOwner(input) {
      const { sendMessage } = await import('../agent-tools/coordination/messages');
      await sendMessage(identity, {
        to: ['human'],
        summary: input.summary,
        body: input.body,
      } as Parameters<typeof sendMessage>[1]);
    },
  };
}
