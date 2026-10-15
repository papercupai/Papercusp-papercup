import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ allowed: true, target: true, ended: false, send: vi.fn(), audit: vi.fn(), run: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async original => ({ ...(await original<typeof import('@papercusp/agent-mcp')>()), defineTool: (d: unknown) => d }));
vi.mock('../../../owner-sessions/actions', () => ({ sendOwnerSessionMessage: (...args: unknown[]) => f.send(...args) }));
vi.mock('../../../owner-sessions/device-authority', () => ({ requireDeviceAgentSessions: async () => f.allowed ? null : Response.json({ error: 'agent_sessions_not_granted' }, { status: 403 }) }));
vi.mock('./sessions', () => ({ resolveDeviceSessionOwner: async () => f.target
  ? { ok: true, row: { state: f.ended ? 'ended' : 'parked' } }
  : { ok: false, response: Response.json({ error: 'session_not_in_workspace' }, { status: 404 }) } }));
vi.mock('../../../owner-sessions/device-actions', async original => ({
  ...(await original<typeof import('../../../owner-sessions/device-actions')>()),
  auditDeviceAction: (...args: unknown[]) => f.audit(...args), runDeviceAction: (...args: unknown[]) => f.run(...args),
}));
import routes from './session-messages';
import { isPhoneDevicePath } from '../../../device-ingress-paths';
const principal = { kind: 'device', slug: 'phone-a', label: 'Owner', workspaceId: 'workspace-a' };
const call = async (body: unknown) => {
  const response = await routes[0].handler(new Request('http://localhost/api/device/sessions/su-target/messages',
    { method: 'POST', body: JSON.stringify(body) }), { principal, params: { owner: 'su-target' } } as never) as Response;
  return { status: response.status, body: await response.json() };
};
beforeEach(() => {
  f.allowed = true; f.target = true; f.ended = false;
  f.send.mockReset().mockResolvedValue({ ok: true, delivery: { kind: 'queued' }, response: { secret: 'internal' } });
  f.audit.mockReset().mockImplementation(async (_context, reply) => reply);
  f.run.mockReset().mockImplementation(async (_context, _key, _request, run) => run('scoped-write-key'));
});
describe('paired-device sends', () => {
  it('uses the shared REQUIRED-wake sender and exposes only delivery classification', async () => {
    expect(await call({ text: 'Please continue', idempotencyKey: 'write-1', ownerId: 'su-foreign', deviceId: 'other' }))
      .toEqual({ status: 200, body: { ok: true, delivery: { kind: 'queued' } } });
    expect(f.send).toHaveBeenCalledWith({ workspaceId: 'workspace-a', ownerId: 'su-target', text: 'Please continue',
      idempotencyKey: 'scoped-write-key', pairedDevice: { id: 'phone-a', label: 'Owner' } });
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ principal, owner: 'su-target', action: 'send' }),
      'write-1', { text: 'Please continue' }, expect.any(Function));
  });
  it.each([{}, { text: 'hi' }, { text: 'hi', idempotencyKey: '' }])('requires an idempotency key before dispatch (%j)', async body => {
    expect((await call(body)).status).toBe(400);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledTimes(1);
  });
  it.each([null, '', '   ', 42])('refuses an invalid message (%j)', async text => {
    expect((await call({ text, idempotencyKey: 'k' })).status).toBe(400);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('audits a missing grant before any recipient lookup or dispatch', async () => {
    f.allowed = false;
    expect((await call({ text: 'hi', idempotencyKey: 'k' })).status).toBe(403);
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('refuses a foreign workspace target without sending', async () => {
    f.target = false;
    expect((await call({ text: 'hi', idempotencyKey: 'k' })).status).toBe(404);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('refuses an ended session without sending', async () => {
    f.ended = true;
    expect((await call({ text: 'hi', idempotencyKey: 'k' })).status).toBe(409);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('preserves staged delivery instead of promising a wake', async () => {
    f.send.mockResolvedValue({ ok: true, delivery: { kind: 'staged' }, response: {} });
    expect((await call({ text: 'hi', idempotencyKey: 'k' })).body.delivery).toEqual({ kind: 'staged' });
  });
  it('preserves a stored idempotency conflict without sending again', async () => {
    f.run.mockResolvedValue({ status: 409, body: { ok: false, error: 'idempotency_conflict' } });
    expect(await call({ text: 'changed body', idempotencyKey: 'same-key' }))
      .toEqual({ status: 409, body: { ok: false, error: 'idempotency_conflict' } });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledWith(expect.objectContaining({ principal, owner: 'su-target', action: 'send' }),
      'same-key', { text: 'changed body' }, expect.any(Function));
  });
  it('admits exact phone paths through both shared remote ingress doors', () => {
    expect(isPhoneDevicePath('/api/device/sessions/su-target/messages')).toBe(true);
    expect(isPhoneDevicePath('/api/device/sessions/../messages')).toBe(false);
    expect(isPhoneDevicePath('/api/device/sessions/su-target/kill')).toBe(false);
  });
});
