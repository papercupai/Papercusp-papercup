/** Exercise the real mount/auth stack and HS256 verifier on every session door. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Hono } from 'hono';
const f = vi.hoisted(() => ({ grant: false, revoked: false, roster: vi.fn(), history: vi.fn(), audit: vi.fn(), send: vi.fn(), end: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async original => ({ ...(await original<typeof import('@papercusp/agent-mcp')>()), defineTool: (d: unknown) => d }));
vi.mock('../../../auth/principal/from-cookie', () => ({ principalFromCookie: async () => null }));
vi.mock('../../../auth/principal/from-superuser-token', () => ({ principalFromSuperuserToken: () => null }));
vi.mock('../../../auth/principal/from-bearer-token', () => ({ principalFromBearerToken: async () => null }));
vi.mock('../../../auth/principal/from-loopback', () => ({ principalFromLoopback: () => null }));
vi.mock('../../../connected-apps/principal', () => ({ resolveAppKeyPrincipal: async () => null }));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ambient-workspace' }));
vi.mock('../../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../../coverage-census/attribution/sink', () => ({ recordHttpTraffic: vi.fn() }));
vi.mock('../../../remote-auth-policy', async original => ({ ...(await original<typeof import('../../../remote-auth-policy')>()), isDirectRemoteRequest: () => false }));
vi.mock('../../../device-store', () => ({
  isRevoked: async () => f.revoked,
  deviceAgentSessionsAllowed: async () => f.grant,
  setDeviceAgentSessionsEnabled: async () => false,
}));
vi.mock('../../../owner-sessions/roster', () => ({ readSessionRosterSnapshot: (...args: unknown[]) => f.roster(...args) }));
vi.mock('../../../owner-sessions/transcript', () => ({ readOwnerHistoryPage: (...args: unknown[]) => f.history(...args) }));
vi.mock('../../../owner-sessions/timeline', () => ({
  projectDeviceTimelineEntry: (entry: unknown) => entry,
  readOwnerSessionTimeline: async () => new Response('data: []\n\n', { headers: { 'content-type': 'text/event-stream' } }),
}));
vi.mock('../../../owner-sessions/actions', () => ({ sendOwnerSessionMessage: (...args: unknown[]) => f.send(...args),
  endOwnerSession: (...args: unknown[]) => f.end(...args), adminToolResultJson: () => ({ ok: true }) }));
vi.mock('../../../owner-sessions/device-actions', async original => ({
  ...(await original<typeof import('../../../owner-sessions/device-actions')>()),
  auditDeviceAction: (...args: unknown[]) => f.audit(...args),
  runDeviceAction: async (_context: unknown, _key: string, _request: unknown, run: (key: string) => unknown) => run('device-write-key'),
}));
vi.mock('../../../agent-tools/coordination/liveness-oracle', () => ({ resolveSessionStates: async () => new Map([['su-target', { sessionState: 'ended' }]]) }));
vi.mock('../../../device-feeds', () => ({ recentToasts: vi.fn(), recentAuditEntries: vi.fn(), currentlyRunning: vi.fn() }));
vi.mock('../../../device-harnesses', () => ({ listHarnessesFor: vi.fn(), harnessStatusFor: vi.fn() }));
vi.mock('../../../operator-standing-candidates', () => ({ readCandidates: vi.fn(), refreshCandidates: vi.fn() }));

import { registerRoute, type RouteDefinition } from '../../define-route';
import { signDeviceToken, __resetDeviceJwtForTest } from '../../../device-jwt';
import listRoutes from './sessions';
import transcriptRoutes from './session-transcript';
import messageRoutes from './session-messages';
import endRoutes from './session-end';
import syncRoutes from './sync';
const SECRET = 'sessions-auth-test-fixture-secret-only-000000';
const WS = 'paired-workspace';
const DOORS = [
  ['GET', '/device/sessions'],
  ['GET', '/device/sessions/su-target/transcript'],
  ['GET', '/device/sessions/su-target/transcript?stream=1'],
  ['POST', '/device/sessions/su-target/messages'],
  ['POST', '/device/sessions/su-target/end'],
  ['GET', '/device/rest-query?name=deviceSessions.list&args=%7B%7D'],
] as const;

it('auth matrix covers exactly the registered session routes, stream mode and deviceSessions queries (R-4)', () => {
  // Read the actual registration barrel, not a second maintained module list.
  // Parse source without importing the other endpoint families or booting them.
  const registryUrl = new URL('../index.ts', import.meta.url);
  const parse = (url: URL) => ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const registry = parse(registryUrl);
  const registered = new Set<string>();
  const visitRegistration = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'flatten') {
      let input = node.arguments[0];
      while (input && ts.isAsExpression(input)) input = input.expression;
      if (input && ts.isIdentifier(input)) registered.add(input.text);
    }
    ts.forEachChild(node, visitRegistration);
  };
  visitRegistration(registry);
  const inventory = new Set<string>();
  let sessionRoutes = 0;
  const propertyText = (object: ts.ObjectLiteralExpression, key: string) => {
    const property = object.properties.find(node => ts.isPropertyAssignment(node)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === key);
    return property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
      ? property.initializer.text : null;
  };
  for (const statement of registry.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.startsWith('./device/')) continue;
    const name = statement.importClause?.name?.text;
    if (!name || !registered.has(name)) continue;
    const source = parse(new URL(`${statement.moduleSpecifier.text}.ts`, registryUrl));
    const visitRoute = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineTool'
        && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const path = propertyText(node.arguments[0], 'path');
        const method = propertyText(node.arguments[0], 'method');
        if (path?.match(/^\/device\/sessions(?:\/|$)/)) {
          expect(method, `session route ${path} must declare its auth-matrix method`).not.toBeNull();
          const concrete = path.replace(':owner', 'su-target');
          inventory.add(`${method} ${concrete}`);
          sessionRoutes++;
          if (method === 'GET' && path.endsWith('/transcript')) inventory.add(`GET ${concrete}?stream=1`);
        }
      }
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression)
        && node.expression.text.startsWith('deviceSessions.')) {
        inventory.add(`GET /device/rest-query?name=${node.expression.text}&args=%7B%7D`);
      }
      ts.forEachChild(node, visitRoute);
    };
    visitRoute(source);
  }
  expect(sessionRoutes).toBeGreaterThan(0);
  expect(inventory.has('GET /device/rest-query?name=deviceSessions.list&args=%7B%7D')).toBe(true);
  const matrix = DOORS.map(([method, path]) => `${method} ${path}`);
  expect(new Set(matrix).size, 'duplicate doors do not replace missing inventory entries').toBe(matrix.length);
  expect(matrix.slice().sort()).toEqual([...inventory].sort());
});

let app: Hono;
let token: string;
beforeEach(() => {
  vi.stubEnv('MOBILE_JWT_SECRET', SECRET); __resetDeviceJwtForTest();
  f.grant = false; f.revoked = false;
  f.roster.mockReset().mockResolvedValue({ active: [{ ownerId: 'su-target', workspaceId: WS, role: 'su',
    label: 'AUTH MATRIX', sessionState: 'parked', nativeSession: { backend: 'codex' } }], starting: [], pending: [], ended: [] });
  f.history.mockReset().mockResolvedValue({ ok: true, entries: [], cursor: null, hasMore: false });
  f.audit.mockReset().mockImplementation(async (_context, reply) => reply);
  f.send.mockReset().mockResolvedValue({ ok: true, delivery: { kind: 'queued' } });
  f.end.mockReset().mockResolvedValue({ status: 200 });
  token = signDeviceToken({ sub: 'phone-a', workspace_id: WS, device_kind: 'mobile' });
  app = new Hono();
  for (const def of [...listRoutes, ...transcriptRoutes, ...messageRoutes, ...endRoutes, ...syncRoutes]) {
    registerRoute(app, def as RouteDefinition<undefined>);
  }
});
afterEach(() => { vi.unstubAllEnvs(); __resetDeviceJwtForTest(); });
const request = (method: string, path: string, bearer?: string) => app.request(path, {
  method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
  ...(method === 'POST' ? { body: JSON.stringify({ text: 'Continue', idempotencyKey: 'k' }) } : {}),
});
function expiredToken(): string {
  const [header, payload] = token.split('.');
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), exp: 1 };
  const expired = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${header}.${expired}`).digest('base64url');
  return `${header}.${expired}.${signature}`;
}
describe.each(DOORS)('session auth matrix: %s %s', (method, path) => {
  it.each(['missing', 'invalid', 'expired', 'revoked-device'])('refuses %s JWT before reading data or performing an action', async kind => {
    f.grant = true; f.revoked = kind === 'revoked-device';
    const bearer = kind === 'missing' ? undefined : kind === 'invalid' ? `${token.slice(0, -5)}wrong` : kind === 'expired' ? expiredToken() : token;
    const response = await request(method, path, bearer);
    expect([401, 403]).toContain(response.status);
    expect(f.roster).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });
  it('pairing alone grants no sessions access; the desktop grant enables it', async () => {
    expect((await request(method, path, token)).status).toBe(403);
    expect(f.roster).not.toHaveBeenCalled();
    f.grant = true;
    expect((await request(method, path, token)).status).toBe(200);
    expect(f.roster).toHaveBeenCalledWith({ workspaceId: WS });
  });
  it('revoking the capability refuses the next request with the same valid JWT', async () => {
    f.grant = true;
    expect((await request(method, path, token)).status).toBe(200);
    f.grant = false;
    expect((await request(method, path, token)).status).toBe(403);
  });
});

describe.each(DOORS.filter(([, path]) => path.includes('/su-target/')))(
  'workspace authority matrix: %s %s', (method, path) => {
    it('refuses a foreign-workspace owner with a valid capable device JWT before history or actions', async () => {
      f.grant = true;
      // Prove this door works for the authenticated device's own workspace.
      expect((await request(method, path, token)).status).toBe(200);
      f.history.mockClear(); f.send.mockClear(); f.end.mockClear();
      f.roster.mockClear().mockResolvedValue({ active: [{ ownerId: 'su-target', workspaceId: 'foreign-workspace',
        role: 'su', label: 'Foreign agent', sessionState: 'parked', nativeSession: { backend: 'codex' } }],
      starting: [], pending: [], ended: [] });
      expect((await request(method, path, token)).status).toBe(404);
      expect(f.roster).toHaveBeenCalledWith({ workspaceId: WS });
      expect(f.history).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled();
    });
  },
);
