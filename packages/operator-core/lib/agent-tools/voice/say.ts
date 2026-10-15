import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { pushSentinelSay } from '../../sentinel-output-buffer';
import { getOrgPg } from '@papercusp/db-org';
import uiDispatch from '../ui/dispatch';
import { providedContentSchema, readProvidedContent } from '../documents/content';
import { ContentIntakeError } from '../../content-intake';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

/**
 * voice:say — the Sentinel's voice-OUT (sentinel-as-claude-tui-2026-06-22,
 * Phase D). The voice-first Sentinel (a psu/Claude-Code session) calls this to
 * speak a line ALOUD to the local app user: the text lands in the shared
 * `sentinel_says` FIFO, then either the server-side full-agent pump speaks it
 * onto the voice bus or the local webview drains it via
 * `GET /api/operator/papercup-output`.
 *
 * LOCAL APP USER ONLY (owner constraint): this is the local TTS channel, NOT the
 * P2P voice-channel system (voice:join/etc.). Capability `operator:read` matches
 * the sentinel role's `voice:* → operator:read` mapping (role-principal-caps).
 */
export default defineTool({
  name: 'voice:say',
  profile: 'engineer',
  description:
    "Speak a short line aloud, or explicitly read original authorized content in the requesting app tab without microphone capture. Read/control modes return a scoped playback receipt; local-only is the default. LOCAL app user only.",
  capability: 'operator:read',
  // WI-10004577: speaks ALOUD (writes the shared sentinel_says FIFO) while sharing the `operator:read`
  // capability with genuine readers, so it declares its own write effect — it must not infer 'read'
  // (that would run it during a code:run dryRun preview AND exempt it from the late-completion abort).
  effect: 'write',
  guidance: {
    when: `For a short reply pass text. When the user explicitly asks to read content aloud, pass operation:'read' and content from an authorized reader (text, selection, HTML or PDF). Read is lossless, not summarize. Check source coverage and the returned receipt; started does not mean audibly completed. operation:'control' targets that reading's id for pause/resume/stop/status.`,
    notWhen: `Don't speak internal tool steps. Long original content uses operation:read. For a requested summary, use your native summary when the complete source fits your context, or documents:read operation:summarize for bounded/repeated processing; then read the explicit summary. For multi-peer P2P voice use voice:join.`,
    seeAlso: [
      'voice:join (multi-peer P2P voice)',
      'voice:transcript (read what was heard / spoken)',
    ],
  },
  requirePrincipal: false,
  // The voice-first Sentinel is the primary caller; operator may speak too.
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle', 'operator'],
  rolesQuota: { sentinel: { perRun: 2000 }, papercup: { perRun: 2000 }, operator: { perRun: 400 } }, // papercup: pot-rename dual-accept twin of sentinel (P1 MIGRATE)
  args: z.union([
    z.object({ text: z.string().min(1).describe('Short spoken reply.') }),
    z.object({ operation: z.literal('read'), content: providedContentSchema, allowCloud: z.boolean().optional(), format: z.enum(['text', 'markdown']).optional() }),
    z.object({ operation: z.literal('control'), readingId: z.string().min(1), action: z.enum(['pause', 'resume', 'stop', 'status']) }),
  ]),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    if ('operation' in args) {
      const clientId = ctx.uiClientId;
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId;
      if (!clientId || !workspaceId || workspaceId === '*') {
        return { data: { ok: false, error: 'requesting_destination_required', message: 'Start narration from the app tab that should play it. No microphone is needed.' } };
      }
      // A caller cannot select another user's tab. Verify the requesting tab's
      // workspace even when the generic UI guard's rollout flag is off.
      const { sql } = getOrgPg();
      const clients = await sql<{ workspace_id: string }[]>`
        SELECT workspace_id FROM harness_shared.ui_clients WHERE client_id = ${clientId} LIMIT 1
      `;
      if (clients[0]?.workspace_id !== workspaceId) {
        return { data: { ok: false, error: 'destination_unavailable', message: 'The requesting app tab is absent or outside this workspace.' } };
      }
      if (args.operation === 'control') {
        return uiDispatch.handler({ client_id: clientId, intent: 'voice_read_control', args: { readingId: args.readingId, action: args.action }, timeout_ms: 5000 }, ctx);
      }
      try {
        const source = await readProvidedContent(args.content, ctx);
        const receipt = await uiDispatch.handler({ client_id: clientId, intent: 'voice_read', args: {
          text: source.text, allowCloud: args.allowCloud === true, format: args.format ?? 'text',
          sourceRefs: source.sourceRefs, digest: source.digest, coverage: source.coverage,
        }, timeout_ms: 5000 }, ctx);
        return { ...receipt, structuredContent: { source: { sourceRefs: source.sourceRefs, digest: source.digest, coverage: source.coverage }, destination: clientId } };
      } catch (error) {
        if (!(error instanceof ContentIntakeError)) throw error;
        return { data: { ok: false, error: error.code, message: error.message } };
      }
    }
    await pushSentinelSay(args.text);
    // Voice ≡ text (WI-4838): the spoken line is persisted HERE, at push
    // time — the single seam every drain path shares (server says-pump when a
    // full-agent session is live, webview local-mode poll otherwise). Persist
    // at drain would tie chat presence to whichever consumer won the FIFO;
    // push-time also means the text reaches chat even if synthesis fails.
    try {
      const { getOrCreateActiveConversation, appendTurn } = await import(
        '../../operator-conversations'
      );
      const conv = await getOrCreateActiveConversation();
      await appendTurn({
        conversationId: conv.id,
        role: 'assistant',
        text: args.text,
        source: 'voice_tts',
        elConvId: null,
      });
      const { notifySyncInvalidate } = await import('../../sync-sse');
      void notifySyncInvalidate('operatorTurns.page', { conversationId: conv.id })
        .catch(() => { /* best-effort */ });
    } catch (err) {
      console.warn('[voice:say] chat persist failed:', (err as Error)?.message ?? err);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  },
});
