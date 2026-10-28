/**
 * POST /api/operator/conversations/:id/card-response
 *
 * Resolves a pending ctx.askUser card. Session-auth + 30 RPS per user.
 *
 * Ported from app/api/operator/conversations/[id]/card-response/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1) — session check inline.
 */
import { deliverCommittedCardResponse } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getSessionUserOrLocalDefaultAuthority } from '../../session-or-local';
import { findConverseCard } from '../../../agent-tools/operator/converse-card';
import { cardResponseRateAllow } from '../../../card-response-rate-limit';
import { getConversationById } from '../../../operator-conversations';
import { defineTool } from '@papercusp/agent-mcp';
import { isNativeCardCorrelationId } from '../../../su-session-native-card-identity';
import { routeSuNativeCard } from '../../../su-session-owner-routing';

interface Body {
  correlationId: string;
  action: 'submit' | 'decline' | 'cancel';
  workspaceId: string;
  payload?: unknown;
  reason?: string;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/card-response',
  auth: 'loopback',
  async handler(req, ctx) {
    // WI-5044: session user OR (loopback-only) the seeded default user — the
    // desktop webview has no session cookie; a strict cookie check made every
    // card pick un-postable on the shipping product.
    const responder = await getSessionUserOrLocalDefaultAuthority(req);
    if (!responder) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const { user } = responder;

    const body = (await req.json().catch(() => null)) as Body | null;
    if (
      !body ||
      typeof body.correlationId !== 'string' ||
      body.correlationId.length === 0 ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.length === 0 ||
      (body.action !== 'submit' && body.action !== 'decline' && body.action !== 'cancel')
    ) {
      return Response.json(
        { error: 'correlationId, workspaceId, action required; action ∈ {submit,decline,cancel}' },
        { status: 400 },
      );
    }

    if (!cardResponseRateAllow(user.id)) {
      return Response.json(
        { error: 'rate limit: 30 RPS per user' },
        { status: 429 },
      );
    }

    // Native cards answer a live SU callback, not a persisted conversation
    // card. The agent-chat id and exact incarnation must both match before
    // crossing the existing owner relay. Never fall back to a local waiter.
    if (isNativeCardCorrelationId(body.correlationId)) {
      if (body.workspaceId !== user.workspace_id) return Response.json({ error: 'card not found' }, { status: 404 });
      try {
        const result = await routeSuNativeCard({ workspaceId: user.workspace_id, agentChatId: ctx.params.id as string,
          request: { kind: 'response', correlationId: body.correlationId, action: body.action, payload: body.payload } });
        if (!result || result.kind !== 'response') return Response.json({ error: 'card not found' }, { status: 404 });
        return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: result.status });
      } catch { return Response.json({ error: 'native card owner unavailable; reconnect and request a new card' }, { status: 503 }); }
    }

    const conversation = await getConversationById(ctx.params.id as string, user.workspace_id);
    if (!conversation || body.workspaceId !== conversation.workspaceId) {
      return Response.json({ error: 'conversation not found' }, { status: 404 });
    }

    // A worker need not hold the original deferred or child mount. Locate
    // the exact persisted binding within this authenticated URL scope, then
    // commit under current parent, child AND human authority in storage.
    try {
      const card = await findConverseCard({ sql: getOrgPg().sql,
        workspaceId: conversation.workspaceId, conversationId: conversation.id,
        correlationId: body.correlationId, authorizeAdditional: responder.authorize });
      if (card) {
        const response = body.action === 'submit' ? { action: 'submit' as const, payload: body.payload }
          : { action: body.action };
        const receipt = await card.commitResponse(response, card.info(), 'response');
        deliverCommittedCardResponse({ ...card.info(), response: receipt.response });
        return receipt.accepted ? Response.json({ ok: true })
          : Response.json({ error: 'card already decided' }, { status: 409 });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const status = code === 'unauthorized' ? 403 : code === 'invalid-answer' ? 400
        : ['already-decided', 'cancelled', 'expired'].includes(code) ? 409 : 503;
      return Response.json({ error: status === 503 ? 'card decision needs reconciliation' : code }, { status });
    }
    // A process-local card has no durable binding to this URL conversation or
    // its child run. Workspace equality alone would let another conversation
    // in the same shared workspace answer it, so only the scoped store above
    // may authorize non-native responses.
    return Response.json({ error: 'card not found' }, { status: 404 });
  },
});
