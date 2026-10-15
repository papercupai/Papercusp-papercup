/**
 * external-app-access-to-workspaces-2026-09-29 P-003 — R-5 (a key reaches only the tools,
 * harnesses and workspace its scopes name) and R-6 (shell, files, admin and credential tools
 * are never reachable by an app key), on BOTH transports.
 *
 * Only the database handle is faked: it answers the connected_apps lookups (the auth chain's
 * `verifyAppKey` and the dispatch seat's `loadAppScopeRow`) with one row the test controls.
 * Everything above it is real — the HTTP `/api/agent-tools/*` catch-all, the MCP host
 * (`registerMcpHost` over an in-memory transport), the dispatcher, and the kernel port
 * `operatorKernelEnforcement` that calls `enforceAppKeyScope`.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** When set, what the DISPATCH SEAT's read (`loadAppScopeRow`) sees instead of `row`. */
  seatRow: undefined as Record<string, unknown> | null | undefined,
  seatReads: 0,
  confinementReads: 0,
  confinementPayload: null as unknown,
  confinementFailure: false,
  /** Every fixture tool that actually ran — the negative assertions read this, not response text. */
  runs: [] as string[],
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const sql = Object.assign(
    // Other modules in the transports' graphs also reach this client, some via postgres.js
    // helper calls (`sql(value)`) rather than a tagged template — answer those with no rows.
    async (strings: TemplateStringsArray | unknown, ...values: unknown[]) => {
      // postgres.js identifiers are interpolated into the authoritative policy read.
      if (strings === 'harness_shared.operator_session_confinements') return strings;
      const text = Array.isArray(strings) ? strings.join('?') : '';
      // This async fixture's identifier helper resolves to a promise; unwrap it
      // before matching the table, just as the SQL driver resolves its helper.
      if (/SELECT payload FROM/.test(text) && (await Promise.all(values)).includes('harness_shared.operator_session_confinements')) {
        db.confinementReads += 1;
        if (db.confinementFailure) throw new Error('fixture policy read unavailable');
        return db.confinementPayload === null ? [] : [{ payload: db.confinementPayload }];
      }
      if (!/SELECT[\s\S]*FROM harness_shared\.connected_apps/.test(text)) return [];
      // loadAppScopeRow names its columns literally; verifyAppKey interpolates them.
      if (/SELECT id, workspace_id, scopes, revoked_at/.test(text)) {
        db.seatReads += 1;
        const seat = db.seatRow === undefined ? db.row : db.seatRow;
        return seat ? [seat] : [];
      }
      return db.row ? [db.row] : [];
    },
    {
      unsafe: (fragment: string) => fragment,
      // A kernel denial records to the decision ledger through `sql.begin(tx => tx.unsafe(...))`;
      // answer it in-memory so the fire-and-forget insert does not warn (vitest-fail-on-console).
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
    },
  );
  return {
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql }),
    withWorkspace: async (_ws: string, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
  };
});

// Mutation-probe seam (copy-out tier): `scripts/mutation-probe.sh --test
// 'PAPERCUSP_SCOPE_POLICY_PROBE={} …'` points the policy at a mutated COPY, so proving these
// guards falsifiable never mutates the shared tree. scope-policy.ts has only a type-only
// import, so the copy runs standalone. Unset (every normal run): the real module.
vi.mock('./scope-policy', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_SCOPE_POLICY_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

// The MCP host's transport setup calls a bare `require(...)` for the SDK schemas.
(globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
process.env.AGENT_MCP_TOOL_MANIFEST = '/nonexistent/scope-enforcement-no-manifest.json';

const { registerProjectedTool, _resetProjectionRegistryForTests } = await import('@papercusp/agent-mcp');
type ProjectedTool = import('@papercusp/agent-mcp').ProjectedTool;
const { default: catchall } = await import('../endpoint-route/routes/agent-tools/catchall');
const { registerMcpHost, mcpHostServerOptions, tryBuildSpawnContext } = await import('../endpoint-route/routes/transport/_mcp-host');
const { resolveAgentIdentity } = await import('../agent-tools/coordination/identity');
const { synthesizeTransportPrincipal } = await import('../endpoint-route/routes/transport/role-principal-caps');
const { readSessionConfinement } = await import('../capability-envelope/session-confinement-store');
const { getBuildInfo, _resetBuildInfoForTest } = await import('../build-info');
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { mintAppKey } = await import('./key');
type RouteContext = import('../endpoint-route/define-route').RouteContext;
type Transport = import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
type MessageExtraInfo = import('@modelcontextprotocol/sdk/types.js').MessageExtraInfo;

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const postRoute = catchall.find((d) => d.method === 'POST');
if (!postRoute) throw new Error('agent-tools catchall has no POST route');

/** A fixture tool that echoes who called it; `group:verb` decides its policy class. */
function echoTool(name: string, over: Partial<ProjectedTool> = {}): ProjectedTool {
  const path = `/api/agent-tools/${name.replace(':', '/')}`;
  return {
    pluginName: 'agent-mcp',
    description: `fixture ${name}`,
    inputSchema: { type: 'object', properties: { harness: { type: 'string' } } },
    capabilities: [],
    public: true,
    expose: { http: { path, methods: ['POST'] }, mcp: { name } },
    fn: async (_input, ctx) => {
      db.runs.push(name);
      return { content: [{ type: 'text', text: JSON.stringify({ ran: name, slug: ctx.principal?.slug ?? null }) }] };
    },
    ...over,
  };
}

const IN_SCOPE = 'fix:app-whoami';
const OUT_OF_SCOPE = 'fix:app-other';
/** A hard-deny GROUP (dev:*) with no dangerous capability string — the curated half of R-6. */
const HARD_DENIED_GROUP = 'dev:fixture-restart';
/** A hard-deny CAPABILITY (capability:*) in an ordinary group — the derived half of R-6. */
const HARD_DENIED_CAPABILITY = 'fix:fixture-shell';

function appRow(tokenHash: string, id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_email: 'owner@example.com',
    workspace_id: 'ws-app',
    kind: 'app',
    label: 'ci bot',
    // The row LISTS the hard-denied tools too: a tampered or pre-existing row must still be
    // refused at call time, not only at issue time.
    scopes: {
      capabilities: ['capability:bash'],
      tools: [IN_SCOPE, HARD_DENIED_GROUP, HARD_DENIED_CAPABILITY],
      harnesses: ['h-allowed'],
    },
    limits: {},
    paired_at: new Date('2026-09-29T00:00:00Z'),
    expires_at: null,
    paused_at: null,
    revoked_at: null,
    last_seen: null,
    last_ip: null,
    token_hash: tokenHash,
    // P-010 (D-025): verifyAppKey reads the workspace's Remote access switch with the key and
    // fails closed without it; this fixture's workspace has remote access on.
    remote_access_enabled: true,
    ...over,
  };
}

let minted: ReturnType<typeof mintAppKey>;

beforeEach(async () => {
  // This in-memory host has a declared fixture build, independent of a live
  // shared checkout's Git HEAD or the two-second build-info discovery budget.
  vi.stubEnv('PAPERCUSP_BUILD_SHA', '1'.repeat(40));
  _resetBuildInfoForTest();
  expect(getBuildInfo().sha).toBe('1'.repeat(40));
  _resetProjectionRegistryForTests();
  registerProjectedTool(echoTool(IN_SCOPE));
  registerProjectedTool(echoTool(OUT_OF_SCOPE));
  registerProjectedTool(echoTool(HARD_DENIED_GROUP));
  registerProjectedTool(echoTool(HARD_DENIED_CAPABILITY, { capabilities: ['capability:bash'] }));
  minted = mintAppKey();
  db.row = appRow(minted.tokenHash, minted.id);
  db.seatRow = undefined;
  db.seatReads = 0;
  db.confinementReads = 0;
  db.confinementPayload = null;
  db.confinementFailure = false;
  db.runs = [];
  // Fail at the fixture precondition if an authoritative policy read silently
  // misses this fake SQL client. Empty/missing policy must be a measured read.
  expect(await readSessionConfinement(`app:${minted.id}`, 'ws-app')).toBeNull();
  expect(db.confinementReads).toBe(1);
  db.confinementReads = 0;
});

afterAll(() => {
  vi.unstubAllEnvs();
  _resetBuildInfoForTest();
});

// ── HTTP ────────────────────────────────────────────────────────────────────────

async function httpCall(name: string, args: Record<string, unknown> = {}): Promise<{ status: number; text: string }> {
  const res = await postRoute!.handler(
    new Request(`http://x.test/api/agent-tools/${name.replace(':', '/')}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${minted.key}` },
      body: JSON.stringify(args),
    }),
    CTX,
  );
  return { status: res.status, text: await res.text() };
}

describe('HTTP /api/agent-tools — app key scope (R-5, R-6)', () => {
  it('R-5: a tool in the key allowlist runs as app:<id>', async () => {
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { content: Array<{ text: string }> };
    expect(JSON.parse(body.content[0].text)).toEqual({ ran: IN_SCOPE, slug: `app:${minted.id}` });
    // Positive control for every `db.runs` negative below: the recorder sees a real run.
    expect(db.runs).toEqual([IN_SCOPE]);
  });

  it('R-5: a tool NOT in the allowlist is refused and never runs', async () => {
    const res = await httpCall(OUT_OF_SCOPE, { harness: 'h-allowed' });
    expect(res.status).not.toBe(200);
    expect(res.text).toContain('app_scope:tool_not_in_scope');
    expect(db.runs).not.toContain(OUT_OF_SCOPE);
  });

  it('R-5: a harness outside the key allowlist is refused', async () => {
    const res = await httpCall(IN_SCOPE, { harness: 'h-other' });
    expect(res.status).not.toBe(200);
    expect(res.text).toContain('app_scope:harness_not_in_scope');
  });

  it('R-5: a harness-accepting tool must name an allowed harness when the key is harness-limited', async () => {
    const res = await httpCall(IN_SCOPE, {});
    expect(res.text).toContain('app_scope:harness_required_by_scope');
  });

  it('R-5: an argument naming another workspace is refused', async () => {
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed', workspace: 'ws-other' });
    expect(res.text).toContain('app_scope:workspace_mismatch');
  });

  it('R-6: a hard-denied tool group is refused even though the row lists it', async () => {
    const res = await httpCall(HARD_DENIED_GROUP, { harness: 'h-allowed' });
    expect(res.text).toContain('app_scope:hard_denied');
    expect(db.runs).not.toContain(HARD_DENIED_GROUP);
  });

  it('R-6: a tool needing a capability:* grant is refused even though the key holds it', async () => {
    const res = await httpCall(HARD_DENIED_CAPABILITY, { harness: 'h-allowed' });
    expect(res.text).toContain('app_scope:hard_denied');
    expect(db.runs).not.toContain(HARD_DENIED_CAPABILITY);
  });

  it('the dispatch seat re-reads the row: a key paused after authentication is stopped', async () => {
    db.seatRow = { ...db.row!, paused_at: new Date() };
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed' });
    expect(db.seatReads).toBeGreaterThan(0);
    expect(res.text).toContain('app_scope:key_paused');
    expect(db.runs).not.toContain(IN_SCOPE);
  });

  it('a key deleted between authentication and dispatch is refused (fail closed)', async () => {
    db.seatRow = null;
    const res = await httpCall(IN_SCOPE, { harness: 'h-allowed' });
    expect(res.text).toContain('app_scope:key_unknown');
  });
});

// ── MCP ─────────────────────────────────────────────────────────────────────────

async function withMcpClient<T>(run: (client: InstanceType<typeof Client>) => Promise<T>): Promise<T> {
  const extra = {
    requestInfo: {
      url: 'http://127.0.0.1:3070/api/mcp',
      headers: { host: '127.0.0.1:3070', authorization: `Bearer ${minted.key}` },
    },
  } as unknown as MessageExtraInfo;
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  let requestInfo: MessageExtraInfo | undefined;
  const transport: Transport = {
    async start() {
      serverWire.onmessage = (message) => transport.onmessage?.(message, requestInfo);
      serverWire.onclose = () => transport.onclose?.();
      serverWire.onerror = (error) => transport.onerror?.(error);
      await serverWire.start();
    },
    send: (message) => serverWire.send(message),
    close: () => serverWire.close(),
  };
  const server = new McpServer({ name: 'app-scope', version: '1' }, mcpHostServerOptions());
  registerMcpHost(server);
  const client = new Client({ name: 'app-scope-client', version: '1' });
  try {
    await server.connect(transport);
    await client.connect(clientWire);
    requestInfo = extra;
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

// `unknown`, not `{ content?: unknown }`: callTool() returns a union whose compat
// member has no `content`, and an all-optional parameter type trips TS's weak-type check.
const mcpText = (r: unknown): string => {
  const content = (r as { content?: unknown } | null | undefined)?.content;
  return (Array.isArray(content) ? (content as Array<{ text?: unknown }>) : [])
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .join('');
};

describe('MCP /api/mcp — app key scope (R-5, R-6)', () => {
  it('authenticated app identity needs the principal projection independently of policy composition', async () => {
    const spawn = await tryBuildSpawnContext({ requestInfo: {
      url: 'http://127.0.0.1:3070/api/mcp',
      headers: { host: '127.0.0.1:3070', authorization: `Bearer ${minted.key}` },
    } });
    expect(spawn.kind).toBe('ok');
    if (spawn.kind !== 'ok') throw new Error('fixture app did not authenticate');
    expect(() => resolveAgentIdentity(spawn.ctx)).toThrow(/cannot.*attributed/);
    expect(resolveAgentIdentity({ ...spawn.ctx, principal: synthesizeTransportPrincipal(spawn.ctx) }).ownerId)
      .toBe(`app:${minted.id}`);
  });

  it('reads and enforces the authenticated app owner confinement on listing', async () => {
    db.confinementPayload = { sessions: { [`app:${minted.id}`]: {
      confinement: { denyTools: [IN_SCOPE], reason: 'fixture ceiling', imposedBy: 'fixture' },
      declaredAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    } } };
    const names = await withMcpClient(async (client) => (await client.listTools()).tools.map((t) => t.name));
    expect(db.confinementReads).toBeGreaterThan(0);
    expect(names).not.toContain(IN_SCOPE);
  });

  it('an unreadable confinement never exposes the app catalog', async () => {
    db.confinementFailure = true;
    await expect(withMcpClient((client) => client.listTools())).rejects.toThrow(/session_confinement_unavailable/);
    expect(db.confinementReads).toBeGreaterThan(0);
  });

  it('the authenticated app frozen context refuses ambient resource reads', async () => {
    db.confinementPayload = { sessions: { [`app:${minted.id}`]: {
      confinement: { denyTools: [], denyAmbientContext: true, reason: 'fixture frozen context', imposedBy: 'fixture' },
      declaredAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
    } } };
    await withMcpClient(async (client) => {
      expect(await client.listResources()).toEqual({ resources: [] });
      expect(db.confinementReads).toBeGreaterThan(0);
      await expect(client.readResource({ uri: 'papercusp://fixture/private' })).rejects.toThrow(/frozen assignment context/);
    });
  });

  it('R-5 + R-6: tools/list shows exactly the in-scope tool — no out-of-scope or hard-denied tool', async () => {
    const names = await withMcpClient(async (client) => (await client.listTools()).tools.map((t) => t.name));
    expect(names).toContain(IN_SCOPE);
    expect(names).not.toContain(OUT_OF_SCOPE);
    expect(names).not.toContain(HARD_DENIED_GROUP);
    expect(names).not.toContain(HARD_DENIED_CAPABILITY);
  });

  it('R-5: an in-scope call runs as app:<id>', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: IN_SCOPE, arguments: { harness: 'h-allowed' } }));
    expect(res.isError ?? false).toBe(false);
    expect(mcpText(res)).toContain(`app:${minted.id}`);
    expect(db.runs).toEqual([IN_SCOPE]);
  });

  it('R-5: a direct call to an unlisted tool is refused', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: OUT_OF_SCOPE, arguments: { harness: 'h-allowed' } }));
    expect(res.isError).toBe(true);
    expect(mcpText(res)).toContain('app_scope:tool_not_in_scope');
  });

  it('R-5: a disallowed harness is refused', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: IN_SCOPE, arguments: { harness: 'h-other' } }));
    expect(res.isError).toBe(true);
    expect(mcpText(res)).toContain('app_scope:harness_not_in_scope');
  });

  it('R-6: a direct call to a hard-denied tool is refused', async () => {
    for (const name of [HARD_DENIED_GROUP, HARD_DENIED_CAPABILITY]) {
      const res = await withMcpClient((client) => client.callTool({ name, arguments: { harness: 'h-allowed' } }));
      expect(res.isError, name).toBe(true);
      expect(mcpText(res), name).toContain('app_scope:hard_denied');
      expect(db.runs, name).not.toContain(name);
    }
  });
});

// ── A key as the Connect-an-app wizard issues it (WI-10004317) ──────────────────
// The wizard grants EXACT TOOLS and no capabilities, and real tools declare a capability
// (`work_items:list` declares `work_items:read`). The fixtures above declare none, which is how
// an empty tools/list for every real key went unseen until a live run (P-014 B1 run 2).

const DECLARES_CAPABILITY = 'fix:app-read';
const DECLARED_CAPABILITY = 'fix:read';

describe('a wizard-issued key (exact tools, no capabilities) reaches a tool that declares a capability', () => {
  beforeEach(() => {
    registerProjectedTool(echoTool(DECLARES_CAPABILITY, { capabilities: [DECLARED_CAPABILITY] }));
    db.row = appRow(minted.tokenHash, minted.id, { scopes: { capabilities: [], tools: [DECLARES_CAPABILITY] } });
  });

  it('MCP tools/list shows the granted tool and nothing else', async () => {
    const names = await withMcpClient(async (client) => (await client.listTools()).tools.map((t) => t.name));
    expect(names).toEqual([DECLARES_CAPABILITY]);
  });

  it('MCP tools/call runs the granted tool as app:<id>', async () => {
    const res = await withMcpClient((client) => client.callTool({ name: DECLARES_CAPABILITY, arguments: {} }));
    expect(mcpText(res)).toContain(`app:${minted.id}`);
    expect(res.isError ?? false).toBe(false);
    expect(db.runs).toEqual([DECLARES_CAPABILITY]);
  });

  it('HTTP runs the granted tool as app:<id>', async () => {
    const res = await httpCall(DECLARES_CAPABILITY, {});
    expect(res.text).toContain(`app:${minted.id}`);
    expect(res.status).toBe(200);
    expect(db.runs).toEqual([DECLARES_CAPABILITY]);
  });

  it('an ungranted tool declaring the same capability stays hidden and refused', async () => {
    const other = 'fix:app-read-other';
    registerProjectedTool(echoTool(other, { capabilities: [DECLARED_CAPABILITY] }));
    const names = await withMcpClient(async (client) => (await client.listTools()).tools.map((t) => t.name));
    expect(names).not.toContain(other);
    const res = await withMcpClient((client) => client.callTool({ name: other, arguments: {} }));
    expect(res.isError).toBe(true);
    expect(db.runs).not.toContain(other);
  });
});
