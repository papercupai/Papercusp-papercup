/** Desktop-only per-device session grant. Uses existing connected-app scopes. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { changeDeviceSessionGrant } from '../../../owner-sessions/device-authority';

const sessionCapability = defineTool({
  method: 'POST',
  path: '/device/desktop/devices/:deviceId/agent-sessions',
  auth: 'loopback',
  input: z.object({ workspaceId: z.string().min(1), enabled: z.boolean() }),
  async handler(_req, ctx) {
    const changed = await changeDeviceSessionGrant(ctx.params.deviceId, ctx.input.workspaceId, ctx.input.enabled);
    if (!changed) return Response.json({ error: 'device_not_found' }, { status: 404 });
    return Response.json({ ok: true, enabled: ctx.input.enabled });
  },
});

export default [sessionCapability];
