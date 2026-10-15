/**
 * Settings forms: choices for a field that declares `x-options` (plan cupboard-distributable-
 * integrations-2026-10-10 P-004, D-005; SPEC-R-2-P-004).
 *
 * Thin HTTP over packages/operator-core/lib/integrations/provider-options.ts, which asks the
 * signed-in owner's connected sources whose provider declares the capability.
 *
 *   POST /user/integrations/options   { capability, args?, sourceId? } → { capability, groups[] }
 *
 * POST because `args` is an object and the read invokes the provider; it changes nothing, so it
 * invalidates no query.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import { requireAllowedOriginOr403 } from '../../cors';
import { listProviderOptions } from '../../../integrations/provider-options';
import { TicketIntegrationError } from '../../../integrations/ticket-integrations';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

const options = defineTool({
  method: 'POST',
  path: '/user/integrations/options',
  auth: 'loopback',
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    const body = await req.json().catch(() => null);
    if (!isPlainObject(body) || typeof body.capability !== 'string' || (body.sourceId !== undefined && typeof body.sourceId !== 'string')) {
      return Response.json(
        { ok: false, error: 'bad_request', detail: 'body must be { capability: string, args?: object, sourceId?: string }' },
        { status: 400 },
      );
    }
    try {
      const user = await getSessionUserOrDefault(req.headers);
      const result = await listProviderOptions(getOrgPg().sql, {
        workspaceId: activeWorkspaceId(),
        ownerUserId: user.id,
        capability: body.capability,
        ...(body.args !== undefined ? { args: body.args as Record<string, unknown> } : {}),
        ...(typeof body.sourceId === 'string' ? { sourceId: body.sourceId } : {}),
      });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof TicketIntegrationError) {
        return Response.json({ ok: false, error: error.code, detail: error.message }, { status: error.status });
      }
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: 'provider_options_failed', detail }, { status: 500 });
    }
  },
});

export default [options];
