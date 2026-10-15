import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  check: vi.fn(),
  restriction: vi.fn(),
  sourceHold: vi.fn(),
}));

vi.mock('../../../personal-vault/binding-enforcement', () => ({
  checkRestrictedEgress: io.check,
  readSessionRestriction: io.restriction,
}));
vi.mock('../../../personal-vault/git-sync-hold', () => ({ readRestrictedSourceHoldState: io.sourceHold }));

import egressRoutes from './restricted-egress-check';

type Route = { handler(req: Request): Promise<Response> };
const route = egressRoutes[0] as unknown as Route;

function request(status: boolean): Request {
  return new Request('http://127.0.0.1/api/agent-mcp/restricted-egress-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'su-test', tool: 'Bash', texts: ['ls'], status }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  io.check.mockResolvedValue({ verdict: 'allow', code: 'allowed', reason: '', targets: [], restricted: false });
  io.restriction.mockResolvedValue(false);
  io.sourceHold.mockResolvedValue('clear');
});

describe('restricted-egress status route', () => {
  it.each(['unknown', 'clear', 'held'] as const)('returns the %s integration-tree source state to the hook', async (state) => {
    io.sourceHold.mockResolvedValue(state);
    const response = await route.handler(request(true));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, restricted: false, sourceHold: state });
    expect(io.sourceHold).toHaveBeenCalledOnce();
  });

  it('does not run either status census when the caller did not request status', async () => {
    const response = await route.handler(request(false));
    await expect(response.json()).resolves.not.toHaveProperty('sourceHold');
    expect(io.sourceHold).not.toHaveBeenCalled();
    expect(io.restriction).not.toHaveBeenCalled();
  });
});
