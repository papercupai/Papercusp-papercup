import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mock = vi.hoisted(() => ({
  connect: vi.fn(), clientClose: vi.fn(), transportClose: vi.fn(), transport: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class { connect = mock.connect; close = mock.clientClose; },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async original => ({
  ...await original<typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js')>(),
  StreamableHTTPClientTransport: class {
    close = mock.transportClose;
    constructor(...args: unknown[]) { mock.transport(...args); }
  },
}));
import { AgentMcpConnectionError, connectAgentMcp } from './agent-mcp-client';

beforeEach(() => {
  vi.clearAllMocks();
  mock.connect.mockResolvedValue(undefined);
  mock.clientClose.mockResolvedValue(undefined);
  mock.transportClose.mockResolvedValue(undefined);
});

describe('owned MCP initialization failure evidence', () => {
  it.each([
    [new McpError(ErrorCode.RequestTimeout, 'secret timeout'), { category: 'request-timeout' }],
    [new McpError(ErrorCode.ConnectionClosed, 'secret close'), { category: 'connection-closed' }],
    [new StreamableHTTPError(503, 'secret upstream'), { category: 'http-status', httpStatus: 503 }],
    [Object.assign(new Error('secret URL'), { cause: { code: 'ECONNREFUSED' } }), { category: 'network', systemCode: 'ECONNREFUSED' }],
    [Object.assign(new Error('secret'), { code: 'secret-untrusted-code' }), { category: 'unknown' }],
    [new StreamableHTTPError(999, 'secret'), { category: 'unknown' }],
    ['secret primitive', { category: 'unknown' }],
  ])('keeps only classified evidence for %o', (raw, diagnostic) => {
    const error = new AgentMcpConnectionError('http', raw);
    expect(error.message).toBe('http_connection_failed');
    expect(error.diagnostic).toEqual(diagnostic);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(String(error)).not.toContain('secret');
  });
  it('bounds recursive causes and does not serialize them', () => {
    const raw: { cause?: unknown } = {}; raw.cause = raw;
    expect(new AgentMcpConnectionError('uds', raw)).toMatchObject({ message: 'uds_connection_failed', diagnostic: { category: 'unknown' } });
  });
  it('closes both resources once without a retry or fallback, even when cleanup rejects', async () => {
    const raw = new McpError(ErrorCode.RequestTimeout, 'secret URL and bearer');
    mock.connect.mockRejectedValueOnce(raw);
    mock.clientClose.mockRejectedValueOnce(new Error('secret cleanup'));
    mock.transportClose.mockRejectedValueOnce(new Error('secret cleanup'));
    await expect(connectAgentMcp({ url: 'http://127.0.0.1:1/api/mcp?sig=secret',
      headers: { Authorization: 'Bearer secret' }, mode: 'http', timeoutMs: 123 }))
      .rejects.toMatchObject({ message: 'http_connection_failed', diagnostic: { category: 'request-timeout' } });
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.clientClose).toHaveBeenCalledOnce();
    expect(mock.transportClose).toHaveBeenCalledOnce();
    expect(mock.transport).toHaveBeenCalledOnce();
    expect(mock.connect.mock.calls[0][1]).toEqual({ timeout: 123 });
  });
  it('leaves successful connections open and uses the original URL and headers', async () => {
    const url = 'http://127.0.0.1:1/api/mcp?sig=unchanged';
    const headers = { Authorization: 'Bearer unchanged' };
    const result = await connectAgentMcp({ url, headers, mode: 'http' });
    expect(result.transportKind).toBe('http');
    expect(mock.transport.mock.calls[0][0].href).toBe(url);
    expect(mock.transport.mock.calls[0][1]).toEqual({ requestInit: { headers } });
    expect(mock.clientClose).not.toHaveBeenCalled();
    expect(mock.transportClose).not.toHaveBeenCalled();
  });
});
