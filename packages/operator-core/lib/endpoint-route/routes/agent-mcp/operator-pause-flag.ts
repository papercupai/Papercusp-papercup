/**
 * GET    /api/agent-mcp/operator-pause-flag — read paused state.
 * POST   — set paused=true.
 * DELETE — set paused=false.
 * Ported from app/api/agent-mcp/operator-pause-flag/route.ts. `auth: 'public'`.
 */
import { getSessionUser } from '../../../auth';
import { assertBackgroundActivityAuthority, featureBackgroundActivityChangeSchema, setFeatureBackgroundActivityPolicy,
  setWorkspaceBackgroundActivityPolicy, stopFeatureBackgroundActivity, isPaused } from '../../../device-operator-actions';
import { defineTool } from '@papercusp/agent-mcp';
import { z } from 'zod';

function policyFailure(error: unknown): Response {
  const code = (error as { code?: string })?.code;
  const status = code === 'startup_policy_forbidden' ? 403 : code === 'startup_policy_conflict' ? 409
    : code === 'startup_policy_invalid' ? 400 : 503;
  return Response.json({ ok: false, error: status === 503 ? 'startup_policy_unavailable' : code }, { status });
}

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-pause-flag',
  auth: 'public',
  async handler() {
    return Response.json({ paused: await isPaused() });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/operator-pause-flag',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    }
    try {
      assertBackgroundActivityAuthority(user);
      // notify-classification: {"id":"packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-pause-flag.ts#<module>/handler:84264ab6800c19ef4af0:1","classification":"durable","reason":"Pause state and its history commit together in changePauseState before operatorPauseFlag invalidation; the committed policy alone does not prove subscribers received that consequence.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove the shared operator-state/sync invalidation path for the committed pause revision, without adding a workflow per route wrapper","deliveryState":"unverified"}
      await setWorkspaceBackgroundActivityPolicy({ action: 'pause', until: null }, undefined, user);
    } catch (error) { return policyFailure(error); }
    return Response.json({ ok: true, paused: true });
  },
});

const del = defineTool({
  method: 'DELETE',
  path: '/agent-mcp/operator-pause-flag',
  auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    }
    try {
      assertBackgroundActivityAuthority(user);
      // notify-classification: {"id":"packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-pause-flag.ts#<module>/handler:d9e04cc4c59562021d61:1","classification":"durable","reason":"Resume commits policy and history before notifying operatorPauseFlag subscribers; awaiting the policy helper does not prove its detached invalidation survives process exit.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove the shared operator-state/sync invalidation consequence for the committed resume revision","deliveryState":"unverified"}
      await setWorkspaceBackgroundActivityPolicy({ action: 'resume' }, undefined, user);
    } catch (error) { return policyFailure(error); }
    return Response.json({ ok: true, paused: false });
  },
});

const featureChange = z.object({
  featureId: z.string().regex(/^activity-[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  change: featureBackgroundActivityChangeSchema,
}).strict();
const policyChange = z.union([featureChange, z.object({
  scope: z.literal('workspace'),
  revision: featureChange.shape.revision,
  change: featureBackgroundActivityChangeSchema,
}).strict(), z.object({ featureId: featureChange.shape.featureId, action: z.literal('stop'),
  runtimePid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict()]);

const patch = defineTool({
  method: 'PATCH', path: '/agent-mcp/operator-pause-flag', auth: 'loopback',
  async handler(req) {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    try { assertBackgroundActivityAuthority(user); } catch (error) { return policyFailure(error); }
    const parsed = policyChange.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ ok: false, error: 'startup_policy_invalid' }, { status: 400 });
    try {
      if ('action' in parsed.data) {
        // notify-classification: {"id":"packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-pause-flag.ts#<module>/handler:51167af9cf86422aa676:1","classification":"durable","reason":"The shared stop helper audits intent before the local/owner-routed stop and detaches the later completion audit. A pending/draining response is not proof of the terminal audit or restart recovery.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must retain the shared stop invocation's terminal completion/history consequence across producer exit, preserving authenticated runtime routing and one audit per logical stop","deliveryState":"unverified"}
        const result = await stopFeatureBackgroundActivity(parsed.data.featureId, user,
          { headers: req.headers, runtimePid: parsed.data.runtimePid });
        return Response.json({ ok: result.status !== 'unavailable', ...result },
          { status: result.status === 'unavailable' ? 503 : 200 });
      }
      const { change, revision } = parsed.data;
      const policy = 'featureId' in parsed.data
        // notify-classification: {"id":"packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-pause-flag.ts#<module>/handler:0c8223ddef9ec113d720:1","classification":"durable","reason":"Feature policy and its companion history share the PG transaction, then changePauseState detaches operatorPauseFlag invalidation. The stored revision is not subscriber-delivery proof.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove the shared policy invalidation consequence for this feature/revision across restart","deliveryState":"unverified"}
        ? await setFeatureBackgroundActivityPolicy(parsed.data.featureId, change, revision, user)
        // notify-classification: {"id":"packages/operator-core/lib/endpoint-route/routes/agent-mcp/operator-pause-flag.ts#<module>/handler:a7ed93252862f93a46db:1","classification":"durable","reason":"Workspace policy and audit history commit before the shared operator-state/sync invalidations; this route awaits persistence but does not establish terminal delivery of those invalidations.","durablePath":"UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009 must prove the shared policy invalidation consequence for the committed workspace revision across restart","deliveryState":"unverified"}
        : await setWorkspaceBackgroundActivityPolicy(change, revision, user);
      return Response.json({ ok: true, policy });
    } catch (error) { return policyFailure(error); }
  },
});

export default [get, post, del, patch];
