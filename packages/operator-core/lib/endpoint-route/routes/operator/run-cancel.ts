/**
 * POST /api/operator/conversations/:id/run-cancel
 *
 * Cancels every pending ctx.askUser card under a given runId.
 * Session-auth + 30 RPS (shared with /card-response).
 *
 * Ported from app/api/operator/conversations/[id]/run-cancel/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1) — session check inline.
 */
import {
  cancelPendingCardsForRunAsync,
  deliverCommittedCardResponse,
  snapshotWorkspace,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getSessionUserOrLocalDefaultAuthority } from '../../session-or-local';
import { findConverseRunCards } from '../../../agent-tools/operator/converse-card';
import { cardResponseRateAllow } from '../../../card-response-rate-limit';
import { getConversationById } from '../../../operator-conversations';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  runId: string;
  workspaceId: string;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/run-cancel',
  auth: 'loopback',
  async handler(req, ctx) {
    const responder = await getSessionUserOrLocalDefaultAuthority(req);
    if (!responder) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const { user } = responder;

    const body = (await req.json().catch(() => null)) as Body | null;
    if (
      !body ||
      typeof body.runId !== 'string' ||
      body.runId.length === 0 ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.length === 0
    ) {
      return Response.json({ error: 'runId, workspaceId required' }, { status: 400 });
    }

    if (!cardResponseRateAllow(user.id)) {
      return Response.json({ error: 'rate limit: 30 RPS per user' }, { status: 429 });
    }

    const conversation = await getConversationById(ctx.params.id as string, user.workspace_id);
    if (!conversation || body.workspaceId !== conversation.workspaceId) {
      return Response.json({ error: 'conversation not found' }, { status: 404 });
    }
    try {
      const cards = await findConverseRunCards({ sql: getOrgPg().sql,
        workspaceId: conversation.workspaceId, conversationId: conversation.id,
        runId: body.runId, authorizeAdditional: responder.authorize });
      if (cards) {
        let conflicted = false;
        for (const card of cards) {
          const receipt = await card.commitResponse({ action: 'cancel' }, card.info(), 'run-end');
          deliverCommittedCardResponse({ ...card.info(), response: receipt.response });
          if (receipt.response.action !== 'cancel') conflicted = true;
        }
        return conflicted ? Response.json({ error: 'card already decided' }, { status: 409 })
          : Response.json({ ok: true, cancelledRunId: body.runId });
      }
    } catch (error) {
      const unauthorized = error instanceof Error && error.message === 'unauthorized';
      return Response.json({ error: unauthorized ? 'unauthorized' : 'card cancellation needs reconciliation' },
        { status: unauthorized ? 403 : 503 });
    }
    const runs = snapshotWorkspace(conversation.workspaceId);
    const ownsRun = runs.some((vs) => vs.runId === body.runId);
    if (!ownsRun) {
      return Response.json({ error: 'run not found in workspace' }, { status: 404 });
    }

    const cancelled = await cancelPendingCardsForRunAsync(body.runId, conversation.workspaceId, true);
    if (!cancelled.ok) return Response.json({ error: cancelled.error }, { status: cancelled.status });

    return Response.json({ ok: true, cancelledRunId: body.runId });
  },
});
