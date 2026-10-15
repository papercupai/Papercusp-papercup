import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ change: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async original => ({ ...(await original<typeof import('@papercusp/agent-mcp')>()), defineTool: (definition: unknown) => definition }));
vi.mock('../../../owner-sessions/device-authority', () => ({ changeDeviceSessionGrant: fixture.change }));
import routes from './session-capability';
type Route = { auth: string; input: { safeParse: (value: unknown) => { success: boolean } }; handler: (req: Request, ctx: unknown) => Promise<Response> };
const route = routes[0] as unknown as Route;
beforeEach(() => { fixture.change.mockReset(); fixture.change.mockResolvedValue(true); });
describe('per-device Agent sessions grant', () => {
  it('is a loopback-only route with a required workspace and boolean decision', () => {
    expect(route.auth).toBe('loopback');
    expect(route.input.safeParse({ workspaceId: 'ws', enabled: true }).success).toBe(true);
    expect(route.input.safeParse({ enabled: true }).success).toBe(false);
    expect(route.input.safeParse({ workspaceId: 'ws', enabled: 'true' }).success).toBe(false);
  });
  it.each([true, false])('changes exactly the named device in its workspace to %s', async enabled => {
    const response = await route.handler(new Request('http://localhost'), { params: { deviceId: 'phone' }, input: { workspaceId: 'ws', enabled } });
    expect(fixture.change).toHaveBeenCalledWith('phone', 'ws', enabled);
    expect(await response.json()).toEqual({ ok: true, enabled });
  });
  it('refuses a missing or foreign device', async () => {
    fixture.change.mockResolvedValue(false);
    expect((await route.handler(new Request('http://localhost'), { params: { deviceId: 'foreign' }, input: { workspaceId: 'ws', enabled: true } })).status).toBe(404);
  });
});
