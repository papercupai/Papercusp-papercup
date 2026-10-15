import { beforeEach, describe, expect, it, vi } from 'vitest';

const pgMock = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  withWorkspace: async (_workspaceId: string, callback: (tx: unknown) => unknown) => {
    const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
      pgMock.queries.push({ text: strings.join(' ? '), values });
      return Promise.resolve([]);
    };
    return callback(tx);
  },
}));
vi.mock('./auth', () => ({ PRINCIPAL_INVALIDATE_CHANNEL: 'agent_mcp_principal_invalidate' }));

import { startPiSession } from './provisioning';

beforeEach(() => {
  pgMock.queries.length = 0;
});

describe('startPiSession', () => {
  it('persists exact tool names and a durable expiry with the bearer hash', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const result = await startPiSession({
      workspaceId: 'ws-customer',
      sessionId: 'converse-test',
      capabilities: ['chat:write'],
      allowedTools: ['chat:ask_choice'],
      expiresAt,
    });

    expect(result.sessionId).toBe('converse-test');
    expect(result.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pgMock.queries[0]?.text).toContain('allowed_tools, expires_at');
    expect(pgMock.queries[0]?.values).toContain('ws-customer');
    expect(pgMock.queries[0]?.values).toContain('converse-test');
    expect(pgMock.queries[0]?.values).toContain(JSON.stringify(['chat:write']));
    expect(pgMock.queries[0]?.values).toContain(JSON.stringify(['chat:ask_choice']));
    expect(pgMock.queries[0]?.values).toContain(expiresAt);
  });

  it('rejects an already-expired session before writing anything', async () => {
    await expect(startPiSession({
      workspaceId: 'ws-customer',
      sessionId: 'expired',
      capabilities: [],
      allowedTools: [],
      expiresAt: new Date(Date.now() - 1),
    })).rejects.toThrow('pi_session_expiry_must_be_in_the_future');
    expect(pgMock.queries).toHaveLength(0);
  });
});
