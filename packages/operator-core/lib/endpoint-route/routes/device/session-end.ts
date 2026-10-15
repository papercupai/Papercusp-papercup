import { randomUUID } from 'node:crypto';
import { classifyAgentPane, defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { resolveDeviceSessionOwner } from './sessions';
import { requireDeviceAgentSessions } from '../../../owner-sessions/device-authority';
import { readSessionRosterSnapshot } from '../../../owner-sessions/roster';
import { adminToolResultJson, endOwnerSession } from '../../../owner-sessions/actions';
import { auditDeviceAction, deviceActionRefusal, runDeviceAction } from '../../../owner-sessions/device-actions';
import { resolveSessionStates } from '../../../agent-tools/coordination/liveness-oracle';
import { getKnownRoles } from '../../../known-roles';
import { getRole } from '../../../role-registry';
import { BACKEND_FEATURE_CAPABILITIES } from '../../../backend-feature-capabilities';

const end = defineTool({
  method: 'POST', path: '/device/sessions/:owner/end', auth: DEVICE_AUTH, cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const context = { principal, owner: ctx.params.owner, action: 'end' as const };
    const respond = (reply: { status: number; body: Record<string, unknown> }) => Response.json(reply.body, { status: reply.status });
    const denied = await requireDeviceAgentSessions(principal);
    if (denied) return respond(await auditDeviceAction(context, { status: denied.status, body: await denied.json() }));
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return respond(await auditDeviceAction(context, deviceActionRefusal('invalid_json', 400))); }
    const suppliedKey = body && body.idempotencyKey;
    if (suppliedKey !== undefined && (typeof suppliedKey !== 'string' || !suppliedKey.trim() || suppliedKey.length > 200)) {
      return respond(await auditDeviceAction(context, deviceActionRefusal('invalid_idempotency_key', 400)));
    }
    return respond(await runDeviceAction(context, typeof suppliedKey === 'string' ? suppliedKey.trim() : randomUUID(), {}, async () => {
      const target = await resolveDeviceSessionOwner(principal.workspaceId, context.owner);
      if (!target.ok) return { status: target.response.status, body: await target.response.json() };
      if (target.row.state === 'ended') return { status: 200, body: { ok: true, state: 'ended', alreadyEnded: true } };
      const roster = await readSessionRosterSnapshot({ workspaceId: principal.workspaceId });
      const raw = [...roster.active, ...roster.starting, ...roster.pending].find(row => row.ownerId === context.owner);
      // A prefix or a truthy handle is not an agent identity. Use the same
      // role/plugin and native-backend catalogs as launch/roster shaping, and
      // fail closed when either part is missing or unknown.
      const role = typeof raw?.role === 'string' ? raw.role : '';
      const knownRole = role !== '' && (getKnownRoles().includes(role)
        || classifyAgentPane({ role }).kind === 'su'
        || getRole(role, raw?.harnessSlug ?? '') !== null);
      const backend = raw?.nativeSession?.backend;
      const nativeAgent = typeof backend === 'string' && Object.hasOwn(BACKEND_FEATURE_CAPABILITIES, backend);
      if (!raw || !knownRole || !nativeAgent
        || /routine|git[-_]?sync|checkpoint|human|system|bg-host/i.test(`${role} ${raw.ownerId}`)) {
        return deviceActionRefusal('protected_session');
      }
      const revoked = await requireDeviceAgentSessions(principal);
      if (revoked) return { status: revoked.status, body: await revoked.json() };
      const result = await endOwnerSession({ workspaceId: principal.workspaceId, ownerId: context.owner,
        reason: `Owner ended session from paired device ${principal.slug}` });
      const parsed = adminToolResultJson(result) as { ok?: boolean; results?: Array<{ ok?: boolean }> } | undefined;
      if (result.status !== 200 || (result.body as { isError?: boolean })?.isError
        || !parsed || parsed.ok === false || parsed.results?.some(row => row.ok === false)) {
        return deviceActionRefusal('session_end_failed', 502);
      }
      const verdicts = await resolveSessionStates([{ ownerId: context.owner }], { hydratePerId: true });
      return { status: 200, body: { ok: true, state: verdicts.get(context.owner)?.sessionState ?? null } };
    }));
  },
});
export default [end];
