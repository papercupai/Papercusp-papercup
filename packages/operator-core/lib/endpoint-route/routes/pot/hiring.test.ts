import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), origin: vi.fn() }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace' }));
vi.mock('../../../federated-pot-scope', () => ({ resolveFederatedPotScope: async () => 'canonical' }));
vi.mock('../../../hive-policy-store', () => ({ getHivePolicy: async () => ({ policy: { membership: 'open' } }) }));
vi.mock('../../cors', () => ({ requireAllowedOriginOr403: io.origin }));
vi.mock('../../../dao-hr/hiring', async original => ({ ...await original<typeof import('../../../dao-hr/hiring')>(), readHiringView: io.read, runHiringAction: io.write }));
import routes from './hiring';
import { HiringError, hiringActionSchema } from '../../../dao-hr/hiring';
import type { RouteContext } from '@papercusp/agent-mcp';
const ctx: RouteContext = { params: { id: 'local-dao' }, principal: null, input: undefined, log: () => {}, signal: new AbortController().signal };
const req = (body = '{}') => new Request('http://local/api/pot/local-dao/hiring', { method: 'POST', body });
describe('DAO hiring HTTP boundary', () => {
  beforeEach(() => { Object.values(io).forEach(mock => mock.mockReset()); });
  it('keeps both routes loopback and rejects an untrusted write origin before any action', async () => {
    expect(routes.map(r => r.auth)).toEqual(['loopback','loopback']);
    io.origin.mockReturnValue(Response.json({ error: 'origin' }, { status: 403 }));
    expect((await routes[1]!.handler(req(), ctx)).status).toBe(403);
    expect(io.write).not.toHaveBeenCalled();
  });
  it('loads the signed policy but uses the same local DAO/workspace key as the people view', async () => {
    io.read.mockResolvedValue({ roles: [] });
    const response = await routes[0]!.handler(new Request('http://local'), ctx);
    expect(response.status).toBe(200);
    expect(io.read).toHaveBeenCalledWith({ workspaceId: 'workspace', daoSlug: 'local-dao', policy: { membership: 'open' } });
  });
  it('does not accept workspace or actor identity as dispatch context', async () => {
    io.write.mockResolvedValue({ roleId: 'role' });
    const action = { action: 'role', title: 'Engineer', level: 'L3', workspaceId: 'spoofed', actorPersonId: 'PER-spoofed' };
    expect(hiringActionSchema.safeParse(action).success).toBe(false);
    expect((await routes[1]!.handler(req(JSON.stringify(action)), ctx)).status).toBe(200);
    expect(io.write).toHaveBeenCalledWith({ workspaceId: 'workspace', daoSlug: 'local-dao' }, action);
    // The strict core action schema rejects the extra fields; dispatch never uses them.
  });
  it.each([['not_admin',403],['invalid_input',400],['self_approval',409]] as const)('reports %s as a correctable refusal', async (code, status) => {
    io.write.mockRejectedValue(new HiringError(code, 'Refused'));
    expect((await routes[1]!.handler(req(), ctx)).status).toBe(status);
  });
});
