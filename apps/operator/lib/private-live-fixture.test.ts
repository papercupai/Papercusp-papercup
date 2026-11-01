import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { cleanupPrivateLockOwners, freshPtyProtocols, observePtySocket, privateLiveTarget, registerPrivateLockOwners } from '../test/private-live-fixture';

const env = {
  PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', VERIFY_TAURI_DEV_URL: 'http://127.0.0.1:45001',
  VERIFY_TAURI_PORT: '45001', PAPERCUSP_WORKSPACE_ID: 'verify-tauri-isolated-99',
  PAPERCUSP_WORKSPACE: 'verify-tauri-isolated-99', PAPERCUSP_HOME: '/tmp/private-home',
  PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_PG_PORT: '45002',
  HARNESS_ADMIN_DATABASE_URL: 'postgres://fixture:private@127.0.0.1:45002/fixture',
};
const owners = [
  { coordOwnerId: 'A', sessionId: 'ff1de569-d5d7-4ea4-a2a9-ab1d46cb0a51' },
  { coordOwnerId: 'B', sessionId: 'e6bbbce3-dc48-4d41-aad5-4b6258f36221' },
];

describe('private live fixture boundaries (no runtime boots)', () => {
  it('accepts a consistent explicit private handoff', () => {
    expect(privateLiveTarget(env)).toMatchObject({ base: env.VERIFY_TAURI_DEV_URL, workspace: env.PAPERCUSP_WORKSPACE });
  });
  it.each([
    { PAPERCUSP_VERIFY_TAURI_ISOLATED: '0' }, { VERIFY_TAURI_DEV_URL: 'http://127.0.0.1:3170' },
    { VERIFY_TAURI_DEV_URL: 'http://example.com:45001' }, { VERIFY_TAURI_PORT: '45003' },
    { PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' }, { PAPERCUSP_HOME: '' },
    { PAPERCUSP_SKIP_PG_DISCOVERY: '0' }, { PAPERCUSP_PG_PORT: '45003' },
    { HARNESS_ADMIN_DATABASE_URL: 'postgres://localhost:5432/shared' },
  ])('fails closed for inconsistent or ambient targets: %j', (override) => {
    expect(() => privateLiveTarget({ ...env, ...override })).toThrow();
  });
  it('requests a new ticket from the HTTP endpoint for every attach', async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ protocol: 'papercusp-pty.v1', ticket: 'papercusp-pty-ticket.v1.first' }))
      .mockResolvedValueOnce(Response.json({ protocol: 'papercusp-pty.v1', ticket: 'papercusp-pty-ticket.v1.second' }));
    const headers = { Origin: env.VERIFY_TAURI_DEV_URL, 'x-papercusp-workspace': env.PAPERCUSP_WORKSPACE };
    const url = env.VERIFY_TAURI_DEV_URL + '/api/harness/private/pty/id/ticket';
    expect(await freshPtyProtocols(url, headers, request)).not.toEqual(await freshPtyProtocols(url, headers, request));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, url, { method: 'POST', headers });
  });
  it('refuses a failed mint rather than opening without credentials', async () => {
    await expect(freshPtyProtocols('http://fixture/ticket', {}, vi.fn().mockResolvedValue(new Response('', { status: 401 })))).rejects.toThrow();
  });
  it('captures immediate binary replay and ignores text control frames', async () => {
    const socket = new EventEmitter();
    const observed = observePtySocket(socket as WebSocket);
    socket.emit('open');
    socket.emit('message', Buffer.from('replay'), true);
    socket.emit('message', Buffer.from('control'), false);
    expect(await observed.opened).toEqual({ opened: true });
    expect(observed.output()).toBe('replay');
  });
  it.each([401, 403])('observes pre-upgrade HTTP %s without an open', async (statusCode) => {
    const socket = new EventEmitter();
    const observed = observePtySocket(socket as WebSocket);
    const resume = vi.fn();
    socket.emit('unexpected-response', {}, { statusCode, resume });
    expect(await observed.opened).toEqual({ opened: false, statusCode });
    expect(resume).toHaveBeenCalledOnce();
  });

  it('registers each exact private owner through the maintained API and reads workspace back', async () => {
    const ids: number[] = [];
    const api = { recordAdvSession: vi.fn().mockResolvedValueOnce(21).mockResolvedValueOnce(22),
      workspaceForCoordOwner: vi.fn().mockResolvedValue(env.PAPERCUSP_WORKSPACE),
      classifyOwnerNativeSession: vi.fn().mockResolvedValueOnce({ binding: 'bound', advSessionId: 21 })
        .mockResolvedValueOnce({ binding: 'bound', advSessionId: 22 }) };
    await registerPrivateLockOwners(env.PAPERCUSP_WORKSPACE, owners, ids, api);
    expect(ids).toEqual([21, 22]);
    expect(api.recordAdvSession).toHaveBeenNthCalledWith(2, { workspaceId: env.PAPERCUSP_WORKSPACE, mode: 'console', ...owners[1] });
    expect(api.workspaceForCoordOwner.mock.calls).toEqual([['A'], ['B']]);
    expect(api.classifyOwnerNativeSession).toHaveBeenNthCalledWith(2, {
      ownerId: 'B', sessionId: owners[1].sessionId, workspaceId: env.PAPERCUSP_WORKSPACE, advSessionId: 22,
    });
  });
  it('refuses failed registration and retains partial setup IDs on wrong-workspace readback', async () => {
    const ids: number[] = [];
    const api = { recordAdvSession: vi.fn().mockResolvedValue(21), workspaceForCoordOwner: vi.fn().mockResolvedValue('foreign'),
      classifyOwnerNativeSession: vi.fn() };
    await expect(registerPrivateLockOwners(env.PAPERCUSP_WORKSPACE, owners, ids, api)).rejects.toThrow('readback differs');
    expect(ids).toEqual([21]);
    expect(api.recordAdvSession).toHaveBeenCalledOnce();
    api.recordAdvSession.mockResolvedValue(null);
    await expect(registerPrivateLockOwners(env.PAPERCUSP_WORKSPACE, [owners[1]], ids, api)).rejects.toThrow('registration failed');
    expect(ids).toEqual([21]);
  });
  it.each(['foreign', 'unbound'])('refuses %s native binding and retains its exact cleanup row', async (binding) => {
    const ids: number[] = [];
    const api = { recordAdvSession: vi.fn().mockResolvedValue(21),
      workspaceForCoordOwner: vi.fn().mockResolvedValue(env.PAPERCUSP_WORKSPACE),
      classifyOwnerNativeSession: vi.fn().mockResolvedValue({ binding, advSessionId: 21 }) };
    await expect(registerPrivateLockOwners(env.PAPERCUSP_WORKSPACE, owners, ids, api)).rejects.toThrow('native session readback differs');
    expect(ids).toEqual([21]);
  });
  it('cancels both owners before any release and verifies zero locks/waiters', async () => {
    const calls: string[] = [];
    const queued = new Set(['A', 'B']);
    const call = vi.fn(async (owner: string, tool: string) => {
      calls.push(owner + ':' + tool);
      if (tool === 'locks:queue') return { active_locks: [], waiting: queued.has(owner) ? [{ ticket_id: owner + '-ticket' }] : [] };
      if (tool === 'locks:cancel_wait') queued.delete(owner);
      return { ok: true };
    });
    await cleanupPrivateLockOwners(['A', 'B'], call);
    expect(calls).toEqual(['A:locks:queue', 'A:locks:cancel_wait', 'B:locks:queue', 'B:locks:cancel_wait',
      'A:locks:release', 'A:locks:queue', 'B:locks:release', 'B:locks:queue']);
    expect(call).toHaveBeenCalledWith('B', 'locks:cancel_wait', { ticket_id: 'B-ticket' });
  });
  it('reports cleanup residue while still attempting the other owner', async () => {
    const call = vi.fn(async (owner: string, tool: string) => tool === 'locks:queue'
      ? { active_locks: owner === 'A' ? ['held'] : [], waiting: [] } : { ok: true });
    await expect(cleanupPrivateLockOwners(['A', 'B'], call)).rejects.toThrow('private lock cleanup failed');
    expect(call).toHaveBeenCalledWith('B', 'locks:release', { all_mine: true });
  });
});
