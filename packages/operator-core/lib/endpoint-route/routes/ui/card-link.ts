/** Authentication targets stay in the live correlator, never session history. */
import { defineTool, readPrivateCardLink } from '@papercusp/agent-mcp';
import { getSessionUserOrLocalDefaultAuthority } from '../../session-or-local';
import { isNativeCardCorrelationId } from '../../../su-session-native-card-identity';
import { routeSuNativeCard } from '../../../su-session-owner-routing';

export default defineTool({
  method: 'GET', path: '/ui/cards/:id/link', auth: 'loopback',
  async handler(req, ctx) {
    const responder = await getSessionUserOrLocalDefaultAuthority(req);
    if (!responder) return new Response(null, { status: 401 });
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    const id = ctx.params.id as string;
    let target: string | null;
    try {
      const result = isNativeCardCorrelationId(id) ? await routeSuNativeCard({ workspaceId: responder.user.workspace_id,
        request: { kind: 'link', correlationId: id } }) : null;
      target = isNativeCardCorrelationId(id) ? result?.kind === 'link' ? result.target : null
        : readPrivateCardLink(id, responder.user.workspace_id);
    } catch { return new Response(null, { status: 503, headers }); }
    if (!target) return new Response(null, { status: 404, headers });
    return new Response(null, { status: 303, headers: { ...headers, Location: target } });
  },
});
