import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { resolveDeviceSessionOwner } from './sessions';
import { requireDeviceAgentSessions } from '../../../owner-sessions/device-authority';
import { sendOwnerSessionMessage } from '../../../owner-sessions/actions';
import { auditDeviceAction, deviceActionRefusal, runDeviceAction } from '../../../owner-sessions/device-actions';
import { redactSensitiveText } from '../../../sensitive-text';

const messages = defineTool({
  method: 'POST', path: '/device/sessions/:owner/messages', auth: DEVICE_AUTH, cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const context = { principal, owner: ctx.params.owner, action: 'send' as const };
    const respond = (reply: { status: number; body: Record<string, unknown> }) => Response.json(reply.body, { status: reply.status });
    const denied = await requireDeviceAgentSessions(principal);
    if (denied) return respond(await auditDeviceAction(context, { status: denied.status, body: await denied.json() }));
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return respond(await auditDeviceAction(context, deviceActionRefusal('invalid_json', 400))); }
    const key = body && body.idempotencyKey;
    const text = body && body.text;
    if (typeof key !== 'string' || !key.trim() || key.length > 200) {
      return respond(await auditDeviceAction(context, deviceActionRefusal('idempotency_key_required', 400)));
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000) {
      return respond(await auditDeviceAction(context, deviceActionRefusal('invalid_message', 400)));
    }
    return respond(await runDeviceAction(context, key.trim(), { text }, async writeKey => {
      const target = await resolveDeviceSessionOwner(principal.workspaceId, context.owner);
      if (!target.ok) return { status: target.response.status, body: await target.response.json() };
      if (target.row.state === 'ended') return deviceActionRefusal('session_ended', 409);
      // Recheck after asynchronous roster/receipt reads, before the shared action.
      const revoked = await requireDeviceAgentSessions(principal);
      if (revoked) return { status: revoked.status, body: await revoked.json() };
      const sent = await sendOwnerSessionMessage({ workspaceId: principal.workspaceId, ownerId: context.owner,
        text, idempotencyKey: writeKey, pairedDevice: { id: principal.slug,
          label: redactSensitiveText(principal.label ?? 'Owner') } });
      // The raw coord result may contain internal fields; the phone gets only delivery.
      return sent.ok ? { status: 200, body: { ok: true, delivery: sent.delivery } }
        : deviceActionRefusal('session_send_failed', sent.status);
    }));
  },
});
export default [messages];
