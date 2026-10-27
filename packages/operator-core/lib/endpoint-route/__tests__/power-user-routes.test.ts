/**
 * Integration tests for the three ported power-user routes:
 *
 *   POST /api/agent-tokens/power-user           — issue access+refresh
 *   POST /api/agent-tokens/power-user/refresh   — exchange refresh→access
 *   GET  /api/agent-bundle                       — fetch persona+tools.md+...
 *
 * These ports were done by the R5 endpoint-route migration (320220c1 +
 * 58de9cb0). The tests drive the actual `defineTool` handlers through
 * a Hono app — same code path as the production catch-all. PG and FS
 * are mocked; HMAC token logic runs for real.
 *
 * If R5 broke a behavior on the way through, the asserts here catch it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { listManaged, resetScheduledRegistry } from '@papercusp/scheduled-registry';
import { setEntityEnum } from '@papercusp/tooldef';
// Populate the projected-tool REGISTRY so the tools/list profile-gate test
// below sees the real catalog. (Sibling tool tests import this too; relying on
// registerAllRoutes → catchall to transitively load it is fragile.)
import '../../agent-tools/index';

/* ─── PG mocks — token signing key + sessions table ──────────────────── */

const FIXED_KEY_B64 = randomBytes(32).toString('base64');
const FIXED_ROTATED_AT = new Date('2026-05-20T00:00:00.000Z');

const SESSIONS = new Map<string, { workspaceId: string; userId: string }>();

vi.mock('../../power-user-sessions', () => ({
  createPowerUserSession: vi.fn(async (opts: { workspaceId: string; userId: string }) => {
    const id = `pus-${randomBytes(8).toString('hex')}`;
    SESSIONS.set(id, { workspaceId: opts.workspaceId, userId: opts.userId });
    return { authSessionId: id, workspaceId: opts.workspaceId, userId: opts.userId };
  }),
  getActivePowerUserSession: vi.fn(async (id: string) => {
    const row = SESSIONS.get(id);
    if (!row) return null;
    return { authSessionId: id, workspaceId: row.workspaceId, userId: row.userId };
  }),
  revokePowerUserSession: vi.fn(async (id: string) => {
    SESSIONS.delete(id);
  }),
}));

vi.mock(import('@papercusp/db-org'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOrgPg: () =>
      ({
        db: {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [{ valueB64: FIXED_KEY_B64, rotatedAt: FIXED_ROTATED_AT }],
              }),
            }),
          }),
          insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
        },
        sql: Object.assign((..._args: unknown[]) => Promise.resolve([]), {
          // Route code may issue `sql.unsafe(...)` / `sql.begin(...)` — no-op them.
          unsafe: () => Promise.resolve([]),
          begin: async (cb: (tx: unknown) => Promise<unknown>) => cb({ unsafe: () => Promise.resolve([]) }),
        }) as unknown as {
          <T>(strings: TemplateStringsArray, ...vals: unknown[]): Promise<T>;
        },
      }) as never,
  };
});

/* ─── Auth + workspace mocks ─────────────────────────────────────────── */

vi.mock(import('../../auth'), async (importOriginal) => {
  const actual = await importOriginal();
  const stubUser = {
    id: 'user-test',
    username: 'tester',
    display_name: 'Tester',
    has_password: true,
    workspace_id: 'workspace-active',
    capabilities: ['*'],
  };
  return {
    ...actual,
    getSessionUserOrDefault: vi.fn(async () => stubUser),
    getSessionUser: vi.fn(async () => stubUser),
  };
});

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'workspace-active'),
  workspaceById: vi.fn((id: string) =>
    id === 'workspace-active' || id === 'workspace-alt'
      ? { id, name: `Workspace ${id}` }
      : undefined,
  ),
  DEFAULT_WORKSPACE_ID: 'workspace-active',
  // Pulled in transitively via lib/backup (the @papercusp/backup seam reads
  // workspacesRoot); omitting it crashes the suite at import time.
  workspacesRoot: vi.fn(() => '/tmp/papercusp-test-ws'),
}));

/* ─── FS mocks for /agent-bundle ──────────────────────────────────────── */

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: ((p: string) => {
      if (typeof p !== 'string') return actual.existsSync(p);
      if (p.endsWith('.persona.md') || p.endsWith('.tools.md')) return true;
      if (p.endsWith('/prompts') || p.endsWith('/scripts')) return true;
      return actual.existsSync(p);
    }) as never,
    readFileSync: ((p: string, ...rest: unknown[]) => {
      if (typeof p === 'string') {
        if (p.endsWith('papercusp-su-power.tools.md')) return '# papercusp-su tools.md FIXTURE\n';
        if (p.endsWith('papercusp-su.persona.md')) return '# persona FIXTURE\n';
        if (p.endsWith('.persona.md')) return '# role persona stub\n';
        if (p.endsWith('.tools.md')) return '# role tools stub\n';
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never,
  };
});

/* ─── Telemetry mock ─────────────────────────────────────────────────── */

vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

/* ─── Serving-generation mock ────────────────────────────────────────────── */
// MCP tools/list refuses with serving_generation_unknown when the serving generation cannot be
// read, and under the mocked db-org above it reads no applied migrations
// (required-migrations-unapplied), so every tools/list here returned zero tools. Pin a known
// generation, as mcp-native-owner-dispatch.test.ts and scope-enforcement.test.ts do.
vi.mock('../../serving-generation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../serving-generation')>(),
  readServingGeneration: async () => ({
    state: 'known', revision: 'serving-generation-v1:power-user-fixture',
    buildSha: 'power-user-fixture', appliedMigrationDigest: 'power-user-fixture', toolRegistryRevision: 'power-user-fixture',
  }),
}));

/* ─── Now bring the app online ───────────────────────────────────────── */

import { Hono } from 'hono';
import { registerAllRoutes } from '../register';
import {
  mintAccessToken,
  mintRefreshToken,
  verifyAccessToken,
  _resetPowerUserTokenKeyCache,
} from '../../power-user-token';
import { startAwaitSweeper } from '../../events/await/engine';

let app: Hono;

beforeEach(() => {
  SESSIONS.clear();
  _resetPowerUserTokenKeyCache();
  app = new Hono().basePath('/api');
  registerAllRoutes(app);
});
afterEach(() => {
  vi.clearAllMocks();
});

/* ─── Helpers ────────────────────────────────────────────────────────── */

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

it('does not arm the await sweeper against the factory-mocked workspace registry', () => {
  // This mock intentionally omits backgroundWorkspaceIds (the latent trigger reported by
  // EI-21209553211440005). The production timer must not survive into this test's module graph.
  const g = globalThis as typeof globalThis & { __papercuspAwaitSweeperStarted?: boolean };
  delete g.__papercuspAwaitSweeperStarted;
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  try {
    startAwaitSweeper();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(listManaged().some((entry) => entry.name === 'await-event-sweeper')).toBe(false);
  } finally {
    setIntervalSpy.mockRestore();
    resetScheduledRegistry();
    delete g.__papercuspAwaitSweeperStarted;
  }
});

/* ─── 1. POST /api/agent-tokens/power-user ───────────────────────────── */

describe('POST /api/agent-tokens/power-user (issue)', () => {
  it('returns access + refresh + workspace + user + auth_session_id', async () => {
    const res = await postJson('/api/agent-tokens/power-user', {});
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(typeof j.access_token).toBe('string');
    expect(typeof j.refresh_token).toBe('string');
    expect(j.workspace_id).toBe('workspace-active');
    expect(j.user_id).toBe('user-test');
    expect(j.auth_session_id).toMatch(/^pus-/);
    expect(Date.parse(j.access_expires_at as string)).toBeGreaterThan(Date.now());
    expect(Date.parse(j.refresh_expires_at as string)).toBeGreaterThan(
      Date.parse(j.access_expires_at as string),
    );
  });

  it('honors body.workspace when present', async () => {
    const res = await postJson('/api/agent-tokens/power-user', { workspace: 'workspace-alt' });
    const j = (await res.json()) as { workspace_id: string };
    expect(j.workspace_id).toBe('workspace-alt');
  });

  it('falls back to activeWorkspaceId when body.workspace is missing/blank', async () => {
    const res = await postJson('/api/agent-tokens/power-user', { workspace: '   ' });
    const j = (await res.json()) as { workspace_id: string };
    expect(j.workspace_id).toBe('workspace-active');
  });

  it('issued access token has the right shape and claims', async () => {
    const r = await postJson('/api/agent-tokens/power-user', {});
    const { access_token, auth_session_id, workspace_id, user_id } = (await r.json()) as {
      access_token: string;
      auth_session_id: string;
      workspace_id: string;
      user_id: string;
    };
    const claims = await verifyAccessToken(access_token);
    expect(claims).not.toBeNull();
    expect(claims!.workspaceId).toBe(workspace_id);
    expect(claims!.userId).toBe(user_id);
    expect(claims!.authSessionId).toBe(auth_session_id);
  });
});

/* ─── 2. POST /api/agent-tokens/power-user/refresh ───────────────────── */

describe('POST /api/agent-tokens/power-user/refresh', () => {
  it('exchanges a valid refresh token for a fresh access token', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      refresh_token: string;
      workspace_id: string;
      user_id: string;
      auth_session_id: string;
    };
    const res = await postJson('/api/agent-tokens/power-user/refresh', {}, bearer(issue.refresh_token));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { access_token: string; access_expires_at: string };
    const claims = await verifyAccessToken(j.access_token);
    expect(claims).not.toBeNull();
    expect(claims!.authSessionId).toBe(issue.auth_session_id);
    expect(claims!.workspaceId).toBe(issue.workspace_id);
    expect(claims!.userId).toBe(issue.user_id);
  });

  it('401 when no Authorization header', async () => {
    const res = await postJson('/api/agent-tokens/power-user/refresh', {});
    expect(res.status).toBe(401);
  });

  it('401 when Authorization is garbage', async () => {
    const res = await postJson(
      '/api/agent-tokens/power-user/refresh',
      {},
      bearer('a.bogus.token'),
    );
    expect(res.status).toBe(401);
  });

  it('401 on type confusion — access token presented as refresh', async () => {
    const { token } = await mintAccessToken({
      workspaceId: 'workspace-active',
      userId: 'user-test',
      authSessionId: 'pus-typetest',
    });
    SESSIONS.set('pus-typetest', { workspaceId: 'workspace-active', userId: 'user-test' });
    const res = await postJson('/api/agent-tokens/power-user/refresh', {}, bearer(token));
    expect(res.status).toBe(401);
  });

  it('401 when the session has been revoked', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      refresh_token: string;
      auth_session_id: string;
    };
    SESSIONS.delete(issue.auth_session_id);
    const res = await postJson(
      '/api/agent-tokens/power-user/refresh',
      {},
      bearer(issue.refresh_token),
    );
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/revoked|unknown/i);
  });

  it('401 on an expired refresh token', async () => {
    SESSIONS.set('pus-expiretest', { workspaceId: 'workspace-active', userId: 'user-test' });
    const { token } = await mintRefreshToken({ authSessionId: 'pus-expiretest', ttlSec: -10 });
    const res = await postJson('/api/agent-tokens/power-user/refresh', {}, bearer(token));
    expect(res.status).toBe(401);
  });
});

/* ─── 3. GET /api/agent-bundle ────────────────────────────────────────── */

describe('GET /api/agent-bundle', () => {
  async function freshAccessToken(workspaceId = 'workspace-active'): Promise<string> {
    const res = await postJson('/api/agent-tokens/power-user', { workspace: workspaceId });
    const j = (await res.json()) as { access_token: string };
    return j.access_token;
  }

  it('returns the bundle with persona, toolsmd, mcp_url, workspace, user', async () => {
    const tok = await freshAccessToken();
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(tok), host: 'localhost:3070' },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      persona: string;
      toolsmd: string;
      skills: Array<{ name: string; source: string }>;
      hooks: Array<{ name: string; source: string }>;
      mcp_url: string;
      workspace: { id: string; name: string };
      user: { id: string };
      expires_at: string;
    };
    expect(j.toolsmd).toContain('FIXTURE');
    expect(j.persona).toContain('FIXTURE');
    expect(j.workspace.id).toBe('workspace-active');
    expect(j.user.id).toBe('user-test');
    expect(Array.isArray(j.skills)).toBe(true);
    expect(Array.isArray(j.hooks)).toBe(true);
    expect(j.mcp_url).toMatch(/\/api\/mcp\?power_user=1&profile=power$/);
    expect(Date.parse(j.expires_at)).toBeGreaterThan(Date.now());
  });

  it('mcp_url is derived from the request origin, never hardcoded', async () => {
    const tok = await freshAccessToken();
    const res = await app.request('http://operator.local:9999/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(tok) },
    });
    const j = (await res.json()) as { mcp_url: string };
    expect(j.mcp_url).toBe('http://operator.local:9999/api/mcp?power_user=1&profile=power');
  });

  it('401 with no Authorization header', async () => {
    const res = await app.request('/api/agent-bundle', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('401 with a refresh token instead of an access token (type confusion)', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      refresh_token: string;
    };
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(issue.refresh_token) },
    });
    expect(res.status).toBe(401);
  });

  it('401 with a token whose session has been revoked', async () => {
    const issue = (await (await postJson('/api/agent-tokens/power-user', {})).json()) as {
      access_token: string;
      auth_session_id: string;
    };
    SESSIONS.delete(issue.auth_session_id);
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(issue.access_token) },
    });
    expect(res.status).toBe(401);
  });

  it('401 with an expired access token', async () => {
    SESSIONS.set('pus-exp', { workspaceId: 'workspace-active', userId: 'user-test' });
    const { token } = await mintAccessToken({
      workspaceId: 'workspace-active',
      userId: 'user-test',
      authSessionId: 'pus-exp',
      ttlSec: -10,
    });
    const res = await app.request('/api/agent-bundle', {
      method: 'GET',
      headers: { ...bearer(token) },
    });
    expect(res.status).toBe(401);
  });
});

/* ─── 4. POST /api/mcp?power_user=1 (tools/list profile gate) ─────────── */

describe('POST /api/mcp?power_user=1 (tools/list profile gate)', () => {
  // tools/list applies every entity-enum loader while building advertised schemas.
  // This suite is unit-tier: bind empty loaders so profile filtering exercises the
  // real route without inheriting the production DB-backed pot/harness loaders.
  beforeEach(() => {
    setEntityEnum('pot', async () => []);
    setEntityEnum('harness', async () => []);
  });

  async function freshAccessToken(): Promise<string> {
    const res = await postJson('/api/agent-tokens/power-user', {});
    const j = (await res.json()) as { access_token: string };
    return j.access_token;
  }

  // Sends tools/list over the MCP Streamable-HTTP transport and returns
  // the list of tool names from the JSON-RPC response.  The response body
  // is an SSE stream; we drain it and extract the first `data:` line that
  // carries a tools/list result.
  async function mcpToolsListNames(accessToken: string): Promise<string[]> {
    const res = await app.request('http://localhost:3070/api/mcp?power_user=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
        // power_user=1 requires a loopback request (isLoopbackRequest). Hono's
        // in-process app.request() doesn't synthesize a Host header the way a
        // real HTTP client does, so set it explicitly — otherwise
        // tryBuildSpawnContext fails 'power_user_non_loopback' and tools/list
        // returns an empty list.
        host: '127.0.0.1:3070',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    if (!res.body) return [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const msg = JSON.parse(line.slice('data:'.length).trim()) as {
          result?: { tools?: Array<{ name: string }> };
        };
        if (msg?.result?.tools) return msg.result.tools.map((t) => t.name);
      } catch { /* skip non-JSON lines (e.g. keep-alive pings) */ }
    }
    return [];
  }

  it('engineer-tagged (Group A) tools absent; untagged (Group B/C) tools present', async () => {
    const tok = await freshAccessToken();
    const names = await mcpToolsListNames(tok);

    // The power profile must return at least some tools.
    expect(names.length).toBeGreaterThan(0);

    // Group A — profile: 'engineer' — must NOT appear.
    expect(names).not.toContain('intel:artifacts');  // tagged profile: 'engineer' (P-013)
    expect(names).not.toContain('intel:spawn_tree'); // tagged profile: 'engineer' (P-013)
    expect(names).not.toContain('harness:get');      // tagged profile: 'engineer'
    expect(names).not.toContain('work_items:list');  // tagged profile: 'engineer'
    expect(names).not.toContain('audit:list');       // tagged profile: 'engineer'

    // Group B/C — no profile tag — must appear.
    expect(names).toContain('tasks:list');   // untagged
    expect(names).toContain('goals:list');   // untagged
  });

  it('invalid power-user token → tools/list returns empty list (failed spawn ctx)', async () => {
    const names = await mcpToolsListNames('a.bogus.token');
    expect(names).toHaveLength(0);
  });
});
