/**
 * Owner → agent-session message delivery: the request shape and the outcome
 * classifier, shared by the desktop conversation composer
 * (apps/operator/app/_components/chat/use-owner-session-chat.ts) and the device
 * session send route (mobile-agent-sessions-2026-10-12 P-001 / P-004).
 *
 * PURE and dependency-free on purpose: the desktop imports it into client code,
 * and the server imports it into a route. Both must report the SAME outcome for
 * the same coord:send response, which is only guaranteed if there is one copy.
 */

/**
 * What actually happened to a sent message — goals-tab-improvement P-002 (the
 * wake-mode correctness bug).
 *
 * The old banner said "Sent — the agent is woken if it's live" unconditionally,
 * which is not a claim this code was ever in a position to make. Two routine
 * states make it false:
 *   - the agent is in `coord:wake-mode` MANUAL, where wakes are STAGED for the
 *     owner to release rather than delivered. The message is real and queued,
 *     but the agent is not working on it and will not until released;
 *   - no live session picked the wake up at all (`recipient_absent`).
 * Both reported as unqualified success, which is the worst kind of wrong: the
 * human walks away believing they have asked for something.
 *
 * Rather than pre-reading wake-mode and guessing, we report what the send
 * RESPONSE says — the authority on what the platform did with it. That also
 * catches the absent case for free, which a wake-mode pre-check would not.
 */
export type SendDelivery =
  /** Legacy response shape: old servers called the queue count `woken`. */
  | { kind: 'woken'; count: number }
  | { kind: 'staged' }
  | { kind: 'absent' }
  | { kind: 'queued' };

/** Read the delivery outcome out of a coord:send response. PURE → unit-tested. */
export function deliveryFromSendResponse(body: unknown): SendDelivery {
  const first = (body as { results?: Array<Record<string, unknown>> } | null)?.results?.[0];
  if (!first) return { kind: 'queued' };
  const wake = first.wake as { queued?: number; woken?: number; staged?: number | boolean } | undefined;
  if (wake) {
    // Current coord:send responses distinguish durable queueing from execution.
    // A queued wake is not a pickup receipt, so keep the UI on the honest warning
    // banner. The woken fallback is retained only for older server responses.
    if (typeof wake.queued === 'number') return { kind: 'queued' };
    if (typeof wake.woken === 'number' && wake.woken > 0) return { kind: 'woken', count: wake.woken };
    // A staged wake is the manual-mode case: accepted, held for release.
    if (wake.staged) return { kind: 'staged' };
  }
  if (first.recipient_absent === true) return { kind: 'absent' };
  if (first.staged === true) return { kind: 'staged' };
  // Delivered to the inbox with no wake attempted/reported — it will be read at
  // the agent's next turn. Honest middle ground, not a claim of attention.
  return { kind: 'queued' };
}

/** The coord:send arguments for one owner message to an agent session. */
export interface OwnerMessageSendArgs {
  to: [string];
  summary: string;
  body: string;
  wake: 'required';
}

/**
 * Build the coord:send arguments for an owner message. The desktop posts these
 * to `/api/admin/coord/send`; the device route dispatches coord:send with them
 * in-process. One builder keeps the wake requirement and the summary rule from
 * drifting between the two.
 */
export function ownerMessageSendArgs(ownerId: string, body: string): OwnerMessageSendArgs {
  return {
    to: [ownerId],
    summary: body.length > 80 ? `${body.slice(0, 77)}…` : body,
    body,
    wake: 'required',
  };
}
