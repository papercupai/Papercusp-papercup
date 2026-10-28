import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliLinkStatus } from './account-link-cli';

const link = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('./account-link-cli', () => ({
  getCliLinkStatus: link.status,
  startCliLink: vi.fn(),
  completeCliLink: vi.fn(),
}));
vi.mock('../endpoint-route/cors', () => ({ requireAllowedOriginOr403: () => null }));

import { accountsLinkStatusTool } from '../agent-tools/accounts/link';
import statusRoute from '../endpoint-route/routes/admin/deploy-accounts-link-status';

afterEach(() => vi.clearAllMocks());

describe('CLI link status delivery after owner routing', () => {
  const outcomes: CliLinkStatus[] = [
    { status: 'pending' },
    { status: 'completed', account: null },
    { status: 'failed', error: 'link owner unavailable (owner_gone)' },
    { status: 'unknown' },
  ];

  it.each(outcomes)('MCP awaits and returns $status instead of spreading a Promise', async (status) => {
    link.status.mockResolvedValueOnce(status);
    const result = await accountsLinkStatusTool.handler({ linkId: 'held-link' } as never, {} as never);
    expect(result).toEqual({ data: { ok: true, ...status } });
    expect(link.status).toHaveBeenCalledWith('held-link');
  });

  it.each(outcomes)('HTTP awaits and returns $status instead of an empty response', async (status) => {
    link.status.mockResolvedValueOnce(status);
    const request = new Request('http://127.0.0.1/api/admin/deploy-accounts/link-status', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: 'held-link' }),
    });
    const response = await statusRoute.handler(request as never, {} as never) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...status });
    expect(link.status).toHaveBeenCalledWith('held-link');
  });
});
