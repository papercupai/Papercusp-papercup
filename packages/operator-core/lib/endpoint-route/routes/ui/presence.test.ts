import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sql, workspace } = vi.hoisted(() => ({
  sql: vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => []),
  workspace: { id: 'request-workspace' },
}));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => workspace.id }));
vi.mock('../../../superuser-token', () => ({ isLoopbackRequest: () => true }));

import route from './presence';

async function post(body: Record<string, unknown>) {
  return (route as unknown as { handler: (req: Request) => Promise<Response> }).handler(new Request('http://localhost/api/ui/presence', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'requesting-tab', url: 'http://localhost/?chat=true', ...body }),
  }));
}

beforeEach(() => {
  sql.mockClear();
  workspace.id = 'request-workspace';
});

describe('UI presence request workspace', () => {
  it.each([{}, { workspace_id: null }])('binds ordinary browser presence to its request workspace (%j)', async body => {
    expect((await post(body)).status).toBe(200);
    expect(sql.mock.calls[0]![2]).toBe('request-workspace');
  });

  it('keeps a matching explicit workspace', async () => {
    expect((await post({ workspace_id: 'request-workspace' })).status).toBe(200);
    expect(sql.mock.calls[0]![2]).toBe('request-workspace');
  });

  it('refuses a foreign workspace before writing presence', async () => {
    const response = await post({ workspace_id: 'foreign-workspace' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'workspace_mismatch' });
    expect(sql).not.toHaveBeenCalled();
  });
});
