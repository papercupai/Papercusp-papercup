import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolveFederatedPotScope } from '../../../federated-pot-scope';
import { getHivePolicy } from '../../../hive-policy-store';
import { HiringError, readHiringView, runHiringAction } from '../../../dao-hr/hiring';
import { requireAllowedOriginOr403 } from '../../cors';

function failure(error: unknown) {
  if (!(error instanceof HiringError)) throw error;
  return Response.json({ ok: false, error: error.code, message: error.message }, { status: error.code === 'not_admin' ? 403 : error.code === 'invalid_input' ? 400 : 409 });
}
const get = defineTool({
  method: 'GET', path: '/pot/:id/hiring', auth: 'loopback',
  async handler(_req, ctx) {
    const workspaceId = activeWorkspaceId(), daoSlug = ctx.params.id as string;
    try {
      const signed = await getHivePolicy(workspaceId, await resolveFederatedPotScope(workspaceId, daoSlug));
      return Response.json({ ok: true, hiring: await readHiringView({ workspaceId, daoSlug, policy: signed?.policy ?? null }) });
    } catch (error) { return failure(error); }
  },
});
const post = defineTool({
  method: 'POST', path: '/pot/:id/hiring', auth: 'loopback',
  async handler(req, ctx) {
    const refusal = requireAllowedOriginOr403(req); if (refusal) return refusal;
    try {
      return Response.json({ ok: true, result: await runHiringAction({ workspaceId: activeWorkspaceId(), daoSlug: ctx.params.id as string }, await req.json().catch(() => null)) });
    } catch (error) { return failure(error); }
  },
});
export default [get, post];
