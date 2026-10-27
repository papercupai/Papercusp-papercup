/**
 * card-link — the inbox ⇄ live-card bridge for inbox-cards-unification Phase D
 * (P-035). When a durable escalation that was linked to a live `ctx.askUser`
 * card (P-034 stashed `cardCorrelationId`/`cardWorkspaceId` in the record's
 * meta) is resolved from the INBOX (coord:resolve), this unblocks the waiting
 * agent by resolving the same card in the correlator.
 *
 * Best-effort + safe by construction:
 *   - No-op when the record carries no `cardCorrelationId` (every flag-off
 *     escalation — so the default path is untouched).
 *   - resolveCardResponse returns not-found (never throws) when the card was
 *     already resolved live or its run ended; the escalation is resolved
 *     regardless.
 */

import { deliverCommittedCardResponse, resolveCardResponse, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import type { AdmissionAuthorityContext } from '../../work-item-admission-authority';
import { operatorChatChildAuthority } from '../../operator-chat-store';
import { findConverseCard } from '../operator/converse-card';

/** Version1 links carry scope only; authority comes from the authenticated
 * transport and is rechecked inside each card transaction. */
export async function commitLinkedConverseCard(record: Record<string, unknown>, choice: string,
  ctx: UnifiedToolContext & AdmissionAuthorityContext): Promise<void> {
  if (!Object.hasOwn(record, 'cardProtocolVersion')) return;
  if (record.cardProtocolVersion !== 1 || typeof record.cardCorrelationId !== 'string'
    || typeof record.cardConversationId !== 'string' || typeof record.cardWorkspaceId !== 'string'
    || record.cardWorkspaceId !== ctx.workspaceId) throw new Error('unauthorized');
  const transport = ctx.admissionRecoveryAuthority;
  const credentialSha256 = transport?.kind === 'superuser' && ctx.isSuperuser
    ? transport.credentialSha256 : ctx.principal?.kind === 'pi' ? ctx.chatParent?.credentialSha256 : undefined;
  if (!credentialSha256) throw new Error('unauthorized');
  const authorizeAdditional = operatorChatChildAuthority({ workspaceId: ctx.workspaceId,
    credentialSha256, capability: 'coord:write', toolName: 'coord:resolve' });
  const card = await findConverseCard({ sql: getOrgPg().sql, workspaceId: ctx.workspaceId,
    conversationId: record.cardConversationId, correlationId: record.cardCorrelationId, authorizeAdditional });
  if (!card) throw new Error('card-not-found');
  const receipt = await card.commitResponse({ action: 'submit', payload: { picks: [choice] } }, card.info(), 'response');
  const response = receipt.response;
  const picks = response.action === 'submit' && response.payload && typeof response.payload === 'object'
    ? (response.payload as Record<string, unknown>).picks : undefined;
  if (!receipt.accepted && (!Array.isArray(picks) || picks.length !== 1 || picks[0] !== choice)) {
    throw new Error('already-decided');
  }
  deliverCommittedCardResponse({ ...card.info(), response });
}

/**
 * If `record` is linked to a live card, resolve that card with the chosen
 * option so the blocked agent resumes. `choice` is the picked option id.
 */
export function unblockLinkedCard(
  // A coord escalation record (or any bag) — read the link off it. Typed as a
  // plain record so the index-signature'd EscalationRecord assigns cleanly
  // (avoids TS's weak-type check on an all-optional shape).
  record: Record<string, unknown>,
  choice: string,
): { unblocked: boolean } {
  if (Object.hasOwn(record, 'cardProtocolVersion')) return { unblocked: false };
  const correlationId = record.cardCorrelationId;
  const workspaceId = record.cardWorkspaceId;
  if (typeof correlationId !== 'string') return { unblocked: false };
  try {
    const res = resolveCardResponse({
      correlationId,
      action: 'submit',
      payload: { picks: [choice] },
      ...(typeof workspaceId === 'string' ? { expectedWorkspaceId: workspaceId } : {}),
    });
    return { unblocked: res.ok };
  } catch {
    // The card may already be resolved / its run ended — the escalation is
    // resolved regardless. Never let card-unblock failure surface to coord:resolve.
    return { unblocked: false };
  }
}
