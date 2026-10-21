import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadHarnessRegistry: vi.fn(),
  addHarnessToWorkspace: vi.fn(),
  moveHarness: vi.fn(),
  removeHarnessFromWorkspace: vi.fn(),
  workspacesForHarness: vi.fn(),
  teardownPotLearningLoop: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('../../../workspace-registry', () => ({
  readRegistry: () => ({
    current: 'ws-test',
    workspaces: [{ id: 'ws-test' }, { id: 'ws-dest' }],
  }),
}));
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry: (...args: unknown[]) => h.loadHarnessRegistry(...args),
}));
vi.mock('../../../harness-membership', () => ({
  addHarnessToWorkspace: (...args: unknown[]) => h.addHarnessToWorkspace(...args),
  moveHarness: (...args: unknown[]) => h.moveHarness(...args),
  removeHarnessFromWorkspace: (...args: unknown[]) => h.removeHarnessFromWorkspace(...args),
  workspacesForHarness: (...args: unknown[]) => h.workspacesForHarness(...args),
}));
vi.mock('../../../pot/provision-learning-loop', () => ({
  teardownPotLearningLoop: (...args: unknown[]) => h.teardownPotLearningLoop(...args),
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import routes from './membership';

const foundMembershipRoute = (routes as Array<{
  path: string;
  method: string;
  handler: (req: Request, ctx: unknown) => Promise<Response>;
}>).find((route) => route.path === '/harness/:slug/membership' && route.method === 'POST');
if (!foundMembershipRoute) throw new Error('no POST route for /harness/:slug/membership');
// A hoisted function declaration does not see the narrowing above, so bind the narrowed value.
const membershipRoute = foundMembershipRoute;

async function postMembership(slug: string, body: unknown) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/membership`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await membershipRoute.handler(req, { params: { slug } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const completeRetirement = (potSlug: string) => ({
  potSlug,
  gymAutoloop: true,
  scoutRoutine: true,
  dreamRoutines: true,
  governorRegistrants: true,
  gitSyncRoutines: true,
});

beforeEach(() => {
  h.loadHarnessRegistry.mockReset().mockResolvedValue({ projects: [{ slug: 'acme', path: '/tmp/acme' }] });
  h.addHarnessToWorkspace.mockReset();
  h.moveHarness.mockReset().mockResolvedValue({
    from: { workspaceId: 'ws-test', slug: 'acme', changed: true },
    to: { workspaceId: 'ws-dest', slug: 'acme', changed: true },
  });
  h.removeHarnessFromWorkspace.mockReset().mockResolvedValue({ workspaceId: 'ws-test', slug: 'acme', changed: true });
  h.workspacesForHarness.mockReset().mockResolvedValue(['ws-test']);
  h.teardownPotLearningLoop.mockReset().mockResolvedValue(completeRetirement('acme'));
  h.sql.mockReset();
});

describe('POST /api/harness/:slug/membership', () => {
  it('retires rows for the exact workspace/install before removing explicit membership', async () => {
    const { status, body } = await postMembership('acme', { op: 'remove', workspace: 'ws-test' });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, result: { workspaceId: 'ws-test', slug: 'acme', changed: true } });
    expect(h.teardownPotLearningLoop).toHaveBeenCalledWith({
      sql: h.sql,
      workspaceId: 'ws-test',
      potSlug: 'acme',
    });
    expect(h.teardownPotLearningLoop.mock.invocationCallOrder[0]).toBeLessThan(
      h.removeHarnessFromWorkspace.mock.invocationCallOrder[0],
    );
  });

  it('keeps membership registered when routine retirement is incomplete', async () => {
    h.teardownPotLearningLoop.mockResolvedValueOnce({ ...completeRetirement('acme'), gitSyncRoutines: false });

    const { status, body } = await postMembership('acme', { op: 'remove', workspace: 'ws-test' });

    expect(status).toBe(503);
    expect(body).toEqual({ error: 'routine retirement incomplete', failed: ['gitSyncRoutines'] });
    expect(h.removeHarnessFromWorkspace).not.toHaveBeenCalled();
  });

  it('does not retire rows for an absent membership', async () => {
    h.loadHarnessRegistry.mockResolvedValueOnce({ projects: [] });
    h.removeHarnessFromWorkspace.mockResolvedValueOnce({ workspaceId: 'ws-test', slug: 'acme', changed: false });

    const { status, body } = await postMembership('acme', { op: 'remove', workspace: 'ws-test' });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, result: { workspaceId: 'ws-test', slug: 'acme', changed: false } });
    expect(h.teardownPotLearningLoop).not.toHaveBeenCalled();
  });

  it('does not retire the source when moving a membership', async () => {
    const { status } = await postMembership('acme', {
      op: 'move',
      fromWorkspace: 'ws-test',
      toWorkspace: 'ws-dest',
    });

    expect(status).toBe(200);
    expect(h.moveHarness).toHaveBeenCalledWith('acme', 'ws-test', 'ws-dest');
    expect(h.teardownPotLearningLoop).not.toHaveBeenCalled();
  });
});
