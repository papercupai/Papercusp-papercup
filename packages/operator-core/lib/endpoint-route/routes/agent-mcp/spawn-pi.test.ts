/**
 * WI-10003619 — POST /api/agent-mcp/spawn-pi must never hand out the operator's
 * superuser token.
 *
 * The route used to read `~/.papercusp/superuser-token` and embed it in the
 * returned MCP server config (`--header Authorization:Bearer <token>`). On a
 * hosted workspace VM the customer account could reach this loopback route and
 * received the '*'-capability token. The fix returns only the pi session's own
 * scoped bearer. This test plants a REAL token file under a temp HOME, so a
 * regression that reads it again (by any path) is caught by the byte check.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';
import { turnProvenanceDir } from '../../../turn-provenance/turn-provenance';

const startPiSessionMock = vi.fn(async (o: { sessionId: string; allowedTools: string[] }) => ({
  sessionId: o.sessionId,
  bearer: 'pi-scoped-bearer-0123456789abcdef',
}));

vi.mock('@papercusp/agent-mcp/provisioning', () => ({
  startPiSession: (o: { sessionId: string; allowedTools: string[] }) => startPiSessionMock(o),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (definition: unknown) => definition,
  getCatalog: () => [
    { name: 'tasks:list', capability: 'tasks:read' },
    { name: 'coord:send', capability: 'coord:write' },
  ],
}));
// This handler-only test does not need the production tool registry. Loading it
// imports the entire operator catalog and can start unrelated database-backed work.
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../papercusp-root', () => ({ papercuspRoot: () => '/srv/papercusp-home' }));
vi.mock('../../../operator-api-base', () => ({ operatorApiBase: () => 'http://127.0.0.1:3070' }));

const SUPERUSER_TOKEN = 'SUPERUSER-TOKEN-must-never-leave-the-operator-7f3a9c';
const CTX: RouteContext = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };

let home: string;
const savedHome = process.env.HOME;

async function callPost(body: unknown): Promise<Response> {
  const mod = await import('./spawn-pi');
  const route = mod.default as unknown as { handler: (r: Request, c: RouteContext) => Promise<Response> };
  return route.handler(
    new Request('http://127.0.0.1:3070/api/agent-mcp/spawn-pi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), 'spawn-pi-home-'));
  mkdirSync(join(home, '.papercusp'), { recursive: true });
  writeFileSync(join(home, '.papercusp', 'superuser-token'), `${SUPERUSER_TOKEN}\n`);
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('POST /api/agent-mcp/spawn-pi (WI-10003619)', () => {
  it('never includes the superuser token anywhere in the response, even when the token file exists', async () => {
    const res = await callPost({ sessionId: 'abc', capabilities: ['coord:read'] });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SUPERUSER_TOKEN);
    expect(text).not.toContain('superuser=1');
    expect(text).not.toMatch(/Authorization:\s*Bearer/i);
  });

  it('wires the MCP server to the pi session’s own scoped bearer', async () => {
    const res = await callPost({ sessionId: 'abc', capabilities: ['coord:read'] });
    const json = (await res.json()) as {
      sessionId: string;
      bearer: string;
      mcpServer: { command: string; args: string[]; env: Record<string, string> };
    };
    expect(json.sessionId).toBe('abc');
    expect(json.bearer).toBe('pi-scoped-bearer-0123456789abcdef');
    expect(json.mcpServer.env.AGENT_MCP_BEARER).toBe(json.bearer);
    expect(json.mcpServer.env.OPERATOR_BASE_URL).toBe('http://127.0.0.1:3070');
    expect(json.mcpServer.env.PAPERCUSP_TURN_PROVENANCE_DIR).toBe(turnProvenanceDir());
    expect(startPiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-test',
        sessionId: 'abc',
        capabilities: ['coord:read'],
        allowedTools: [],
      }),
    );
  });

  it('persists exact names, not only coarse capability tags', async () => {
    await callPost({ sessionId: 'scoped', capabilities: ['tasks:read'] });
    expect(startPiSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'scoped',
        capabilities: ['tasks:read'],
        allowedTools: ['tasks:list'],
      }),
    );
  });
});
