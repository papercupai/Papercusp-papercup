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
}).strict(), z.object({ featureId: featureChange.shape.featureId, action: z.literal('stop') }).strict()]);

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
        const result = await stopFeatureBackgroundActivity(parsed.data.featureId, user);
        return Response.json({ ok: result.status !== 'unavailable', ...result },
          { status: result.status === 'unavailable' ? 503 : 200 });
      }
      const { change, revision } = parsed.data;
      const policy = 'featureId' in parsed.data
        ? await setFeatureBackgroundActivityPolicy(parsed.data.featureId, change, revision, user)
        : await setWorkspaceBackgroundActivityPolicy(change, revision, user);
      return Response.json({ ok: true, policy });
    } catch (error) { return policyFailure(error); }
  },
});

export default [get, post, del, patch];
