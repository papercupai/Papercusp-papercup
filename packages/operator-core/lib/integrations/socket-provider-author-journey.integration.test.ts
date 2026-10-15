/**
 * Outside-author journey for a socket chat provider (plan cupboard-distributable-integrations-2026-10-10,
 * R-6 "Outside authors can do the same", P-011; integration layer).
 *
 * An author outside Papercusp ships a chat integration of the same shape as the first-party `slack`
 * package: socket ingress the host holds, pasted credentials, the `chat-message` datatype, a channel
 * picker and threaded replies (test/fixtures/teamchat-socket-provider). This suite plays everyone
 * except the author, through public paths only:
 *
 *   - BUILD: the package is copied out of the tree and type-checked there against nothing but the
 *     published SDK and Node's types; a drifted copy proves the check can fail.
 *   - PUBLISH: the author pushes to "GitHub" (a local bare repository that git reaches through
 *     `url.<base>.insteadOf`) and publishes with publishInstalledUnitToCupboard, the core behind
 *     `cupboard:publish-plugin`, against a stand-in Cupboard.
 *   - INSTALL: the Cupboard install route, by listing id, exactly as the Cupboard page posts it. It
 *     resolves the listing, git-clones the published repository and refuses a provider until the
 *     owner pins its review. The plugin loader then discovers it and the host starts its daemon in
 *     the provider sandbox.
 *   - CONNECT: the Settings → Integrations credential route with the two pasted tokens.
 *   - RECEIVE: the production socket-ingress manager opens the gateway with the gateway token, acks
 *     each delivery, has the daemon normalize it, and admits a chat-message delivery; the API token is
 *     injected only into the package's own API calls.
 *
 * Only the outside world is a stand-in: GitHub's API and the Cupboard answer from in-process routes,
 * and TeamChat is a local HTTP server plus a local WebSocket server. Every negative control has a
 * positive control beside it.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { ProviderInvokeRequest } from '@papercusp/plugin-sdk';
import type { StartDaemonOptions } from '@papercusp/plugin-loader/daemon';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as Sql,
  ws: 'teamchat-author-journey',
  /** The author's GitHub login, assembled at runtime so no token-shaped literal sits in the tree. */
  ghToken: ['gh', 'journey', 'author'].join('-'),
  snapshot: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
}));
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => h.ws };
});
vi.mock('../plugin-configs-pg', () => ({ mirrorPluginConfig: async () => undefined }));
// The author's own GitHub login and device attestation belong to their machine, not to Papercusp.
vi.mock('../identity/gh-token', async (orig) => ({
  ...(await orig<typeof import('../identity/gh-token')>()),
  getGhAuthToken: async () => ({ kind: 'ok', token: h.ghToken }),
}));
vi.mock('../cupboard/publisher-attestation', () => ({ resolvePublisherAttestation: async () => null }));
// "After plugin install" snapshots the real workspace; record that the install fired it instead.
vi.mock('../backup', async (orig) => ({ ...(await orig<typeof import('../backup')>()), triggerSnapshotEvent: h.snapshot }));
// The host's own discovery would also load every bundled first-party plugin. This suite runs the same
// loader over the global plugins dir the install wrote to, and the registry is ready once it has.
vi.mock('../plugin-host-runtime', async (orig) => ({
  ...(await orig<typeof import('../plugin-host-runtime')>()),
  whenProvidersRegistered: async () => undefined,
}));

import { loadPlugins } from '@papercusp/plugin-loader';
import { getSessionUserOrDefault } from '../auth';
import { publishInstalledUnitToCupboard } from '../cupboard/publish-plugin-core';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import type { RouteContext } from '../endpoint-route/define-route';
import installRoute from '../endpoint-route/routes/cupboard-install-plugin';
import credentialRoutes from '../endpoint-route/routes/user/provider-credentials';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../external-triggers/source-store';
import { GLOBAL_PLUGINS_DIR } from '../plugin-catalog';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../plugin-host-runtime';
import { admitConnectorRecord, type ConnectorRecordAdmission } from '../providers/connector-runtime';
import { ProviderSocketIngressManager } from '../providers/provider-socket-ingress';
import {
  daemonProviderRuntimes,
  startDaemonProvider,
  stopDaemonProvider,
  type ProviderDaemonHandle,
  type StartDaemonProviderOptions,
} from './daemon-provider';
import { listProviderOptions } from './provider-options';
import { providerRegistry } from './provider-registry';
import { createSourceHostFetch } from './source-host-fetch';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const PACKAGE_SRC = resolve(HERE, '../../test/fixtures/teamchat-socket-provider');
const PLUGIN_NAME = 'teamchat-socket-provider';
const PROVIDER_ID = 'teamchat';
const GITHUB_OWNER = 'acme-chat';
const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${PLUGIN_NAME}`;
const GITHUB_REPO_ID = 70011;
const CUPBOARD = 'https://cupboard.journey.example';
const CHAT_HOST = 'api.teamchat.example';
const WS = h.ws;

/** Token-shaped fakes, assembled at runtime so no credential-shaped literal sits in the tree. */
const fakeToken = (prefix: string, tail: string) => [prefix, 'J0URNEY', '0123456789abcdef', tail].join('-');
const GATEWAY_TOKEN = fakeToken('tcg', 'gateway');
const API_TOKEN = fakeToken('tca', 'api');

const realFetch = globalThis.fetch.bind(globalThis);

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

let org: OrgTestDb;
let sql: Sql;
let scratch: string;
let authorDir: string;
let bareRepo: string;
let ownerId: string;
let sourceId: string;
let review: unknown;
let listingId: string;
const savedEnv: Record<string, string | undefined> = {};

/* ─── the outside world: GitHub's API, the Cupboard, TeamChat ─── */

const githubCalls: string[] = [];
const cupboardPosts: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
const listings = new Map<string, Record<string, unknown>>();
/** Any request the stand-ins do not answer: the journey must need none. */
const strays: string[] = [];

function githubApi(url: URL): Response {
  githubCalls.push(url.pathname);
  const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/);
  if (!match || match[1] !== GITHUB_OWNER || match[2] !== PLUGIN_NAME) return new Response('Not Found', { status: 404 });
  if (!match[3]) return Response.json({ id: GITHUB_REPO_ID, html_url: GITHUB_URL, full_name: `${GITHUB_OWNER}/${PLUGIN_NAME}` });
  try {
    // The contents API at the default branch, raw: whatever the author pushed.
    return new Response(execFileSync('git', ['--git-dir', bareRepo, 'show', `HEAD:${decodeURIComponent(match[3])}`]));
  } catch {
    return new Response('Not Found', { status: 404 });
  }
}

function cupboardApi(url: URL, method: string, headers: Headers, body: unknown): Response {
  if (method === 'POST' && url.pathname === '/listings') {
    const parsed = JSON.parse(String(body)) as Record<string, unknown>;
    cupboardPosts.push({ authorization: headers.get('authorization'), body: parsed });
    if (headers.get('authorization') !== `Bearer ${h.ghToken}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const id = `lst_${listings.size + 1}`;
    const row = { id, ...parsed };
    listings.set(id, row);
    return Response.json({ ok: true, listing: row }, { status: 201 });
  }
  const one = url.pathname.match(/^\/listings\/([^/]+)$/);
  if (method === 'GET' && one) {
    const row = listings.get(decodeURIComponent(one[1]!));
    return row ? Response.json({ listing: row }) : Response.json({ error: 'not_found' }, { status: 404 });
  }
  strays.push(`${method} ${url.href}`);
  return new Response('no route', { status: 404 });
}

let chatServer: Server;
let chatPort: number;
let gateway: WebSocketServer;
let gatewayPort: number;
const chatCalls: Array<{ method: string; path: string; authorization: string | null; body: string }> = [];
const gatewaySockets: ServerSocket[] = [];
const acks: string[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  });
}

async function router(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.host === 'api.github.com') return githubApi(url);
  if (url.origin === CUPBOARD) return cupboardApi(url, method, headers, init?.body);
  if (url.host === CHAT_HOST) {
    const target = `http://127.0.0.1:${chatPort}${url.pathname}${url.search}`;
    return input instanceof Request ? realFetch(new Request(target, input)) : realFetch(target, init);
  }
  strays.push(`${method} ${url.href}`);
  return new Response('no route', { status: 599 });
}

/** A TeamChat gateway delivery of a new message. */
function messageDelivery(deliveryId: string, message: Record<string, unknown>) {
  return { delivery_id: deliveryId, kind: 'event', event: { type: 'message.created', workspace: 'W-ACME', message } };
}

/* ─── the host side ─── */

const started: Array<{ options: StartDaemonOptions; handle: ProviderDaemonHandle }> = [];
const invocations: ProviderInvokeRequest[] = [];
const admissions: ConnectorRecordAdmission[] = [];
const logs: string[] = [];
let ingress: ProviderSocketIngressManager | null = null;

/**
 * The production daemon start, with the started process recorded (so the sandbox can be read from the
 * kernel) and every `provider.invoke` the host sends across the daemon boundary recorded as sent.
 */
function tapStart(opts: StartDaemonProviderOptions) {
  return startDaemonProvider({
    ...opts,
    startDaemon: async (so: StartDaemonOptions) => {
      const { startDaemonPlugin } = await import('@papercusp/plugin-loader/daemon');
      const inner = await startDaemonPlugin(so);
      const handle: ProviderDaemonHandle = {
        async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
          if (method === 'provider.invoke') invocations.push((params as { request: ProviderInvokeRequest }).request);
          return inner.request<T>(method, params, timeoutMs);
        },
        shutdown: () => inner.shutdown(),
        pid: () => inner.pid(),
      };
      started.push({ options: so, handle });
      return handle;
    },
  });
}

async function discover() {
  const projectDir = join(scratch, 'empty-project');
  await fs.mkdir(projectDir, { recursive: true });
  return loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir: GLOBAL_PLUGINS_DIR() });
}

async function postInstall(body: Record<string, unknown>) {
  const response = await installRoute.handler(
    new Request('http://127.0.0.1/api/cupboard/install-plugin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    CTX,
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function putCredentials(providerId: string, values: Record<string, string>) {
  const save = credentialRoutes[1]!;
  const response = await save.handler(
    new Request(`http://127.0.0.1/api/user/integrations/providers/${providerId}/credentials`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
    { ...CTX, params: { providerId } },
  );
  return { status: response.status, text: await response.text() };
}

async function sourcesOfKind(kind: string) {
  return sql<Array<{ id: string; status: string; ownerUserId: string | null }>>`
    SELECT id::text AS id, status, owner_user_id AS "ownerUserId"
      FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${kind} AND status <> 'disabled'`;
}

async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ─── out-of-tree build ─── */

type TsModule = typeof import('typescript');
const ts = createRequire(import.meta.url)(join(REPO, 'node_modules', 'typescript')) as TsModule;

/** The package plus a node_modules holding ONLY what an outside author would install. */
async function outOfTreeCopy(dest: string) {
  await fs.cp(PACKAGE_SRC, dest, { recursive: true });
  const links: Array<[string, string]> = [
    ['@papercusp/plugin-sdk', join(REPO, 'packages', 'plugin-sdk')],
    ['@types/node', join(REPO, 'node_modules', '@types', 'node')],
    ['undici-types', join(REPO, 'node_modules', 'undici-types')],
  ];
  for (const [name, target] of links) {
    const at = join(dest, 'node_modules', name);
    await fs.mkdir(dirname(at), { recursive: true });
    await fs.symlink(target, at, 'dir');
  }
}

function typecheck(dir: string): { files: string[]; diagnostics: string[] } {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(dir, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, ' '));
    },
  });
  if (!parsed) throw new Error('journey_tsconfig_unreadable');
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  return {
    files: parsed.fileNames.map((f) => relative(dir, f)).sort(),
    diagnostics: ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file ? relative(dir, d.file.fileName) : '(global)';
      return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    }),
  };
}

const ALLOWED_IMPORTS = /^(?:@papercusp\/plugin-sdk|node:[a-z_/]+)$/;
/** Any specifier that is not the SDK or a node builtin. */
function foreignImports(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/\bimport\s*(?:type\s+)?(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]!);
  return specifiers.filter((s) => !s.startsWith('./') && !ALLOWED_IMPORTS.test(s));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Acme Chat', '-c', 'user.email=dev@acme-chat.example', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/* ─── lifecycle ─── */

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  scratch = await fs.mkdtemp(join(tmpdir(), 'socket-provider-author-journey-'));
  authorDir = join(scratch, 'author', PLUGIN_NAME);
  bareRepo = join(scratch, 'github', GITHUB_OWNER, PLUGIN_NAME);
  const home = join(scratch, 'papercusp-home');
  await fs.mkdir(home, { recursive: true });

  const env: Record<string, string> = {
    PAPERCUSP_HOME: home,
    PAPERCUSP_CUPBOARD_URL: CUPBOARD,
    // git reaches "GitHub" at the local bare repositories, for the installer's clone as for anyone's.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${join(scratch, 'github')}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  };
  for (const [key, value] of Object.entries(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  vi.stubGlobal('fetch', vi.fn(router));

  chatServer = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? '').split('?')[0]!;
    const authorization = req.headers.authorization ?? null;
    chatCalls.push({ method: req.method ?? '', path, authorization, body });
    res.setHeader('content-type', 'application/json');
    if (path === '/v1/gateway.open') {
      const ok = authorization === `Bearer ${GATEWAY_TOKEN}`;
      res.statusCode = ok ? 200 : 401;
      res.end(JSON.stringify(ok ? { ok: true, gateway: { url: `ws://127.0.0.1:${gatewayPort}/gw?n=${chatCalls.length}` } } : { ok: false }));
      return;
    }
    if (authorization !== `Bearer ${API_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    if (path === '/v1/rooms' && req.method === 'GET') {
      res.end(JSON.stringify({ rooms: [{ id: 'R-BUGS', name: 'bugs', topic: 'Bug reports' }, { id: 'R-GENERAL', name: 'general' }] }));
      return;
    }
    if (path === '/v1/rooms/R-BUGS/messages' && req.method === 'POST') {
      res.end(JSON.stringify({ message: { id: 'M-REPLY-1' } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((r) => chatServer.listen(0, '127.0.0.1', r));
  chatPort = (chatServer.address() as AddressInfo).port;

  gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => gateway.once('listening', () => r()));
  gatewayPort = (gateway.address() as AddressInfo).port;
  gateway.on('connection', (socket) => {
    gatewaySockets.push(socket);
    socket.on('message', (data) => acks.push(data.toString()));
    socket.send(JSON.stringify({ kind: 'hello', delivery_id: `hello-${gatewaySockets.length}` }));
  });

  const base = await getDatatype(sql, 'papercusp-workspace', 'chat-message');
  if (!base) throw new Error('journey_datatype_missing:chat-message');
  await upsertDatatype(sql, { ...base, workspaceId: WS, createdBy: 'socket-provider-author-journey' });
  ownerId = (await getSessionUserOrDefault(new Headers())).id;
}, 300_000);

afterAll(async () => {
  ingress?.stop();
  await stopDaemonProvider(PLUGIN_NAME);
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
  for (const socket of gateway?.clients ?? []) socket.terminate();
  await new Promise<void>((r) => (gateway ? gateway.close(() => r()) : r()));
  await new Promise<void>((r) => (chatServer ? chatServer.close(() => r()) : r()));
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await org?.cleanup();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
}, 120_000);

describe('outside author: a socket chat provider from build to first message (R-6)', () => {
  it('is a clean workspace that has never heard of the provider', async () => {
    expect(WS).not.toBe('papercusp-workspace');
    expect(providerRegistry().get(PROVIDER_ID)).toBeUndefined();
    // Positive control for the Integrations card route below: an installed provider answers 200.
    expect((await putCredentials(PROVIDER_ID, { gateway_token: GATEWAY_TOKEN })).status).toBe(404);
  });

  describe('built outside the source tree', () => {
    it('imports only the published SDK and node builtins (detector proven both ways)', () => {
      expect(foreignImports("import { x } from '@papercusp/operator-core/lib/db';")).toEqual(['@papercusp/operator-core/lib/db']);
      expect(foreignImports("const r = require('../../lib/integrations/provider-registry');")).toEqual([
        '../../lib/integrations/provider-registry',
      ]);
      expect(foreignImports("/** @typedef {import('@papercusp/plugin-sdk').HostFetch} H */\nimport fs from 'node:fs';")).toEqual([]);
      const source = readFileSync(join(PACKAGE_SRC, 'daemon.mjs'), 'utf8');
      expect(foreignImports(source)).toEqual([]);
    });

    it('type-checks in a fresh directory against the SDK alone; a drifted copy fails', async () => {
      const clean = join(scratch, 'oat', 'clean');
      await outOfTreeCopy(clean);
      const ok = typecheck(clean);
      expect(ok.files).toEqual(['daemon.mjs']);
      expect(ok.diagnostics).toEqual([]);

      const drift = join(scratch, 'oat', 'drift');
      await outOfTreeCopy(drift);
      const daemon = join(drift, 'daemon.mjs');
      const source = await fs.readFile(daemon, 'utf8');
      expect(source).toContain("datatype: 'chat-message',");
      // A record that breaks the SDK's ProviderRecord, and an import from inside Papercusp.
      const drifted = source.replace("datatype: 'chat-message',", 'datatype: 42,');
      await fs.writeFile(daemon, `import { providerRegistry } from '@papercusp/operator-core';\nvoid providerRegistry;\n${drifted}`);
      const bad = typecheck(drift);
      expect(bad.diagnostics.some((d) => d.startsWith('daemon.mjs') && d.includes('@papercusp/operator-core')), bad.diagnostics.join('\n')).toBe(true);
      expect(bad.diagnostics.some((d) => d.startsWith('daemon.mjs') && /number/.test(d) && /string/.test(d)), bad.diagnostics.join('\n')).toBe(true);
    }, 120_000);
  });

  describe('published to the Cupboard', () => {
    it('pushes to its GitHub repository and publishes a plugin listing', async () => {
      await outOfTreeCopy(authorDir);
      await fs.writeFile(join(authorDir, '.gitignore'), 'node_modules/\n');
      git(authorDir, 'init', '-q');
      git(authorDir, 'add', '-A');
      git(authorDir, 'commit', '-q', '-m', 'TeamChat provider 1.0.0');
      await fs.mkdir(dirname(bareRepo), { recursive: true });
      git(scratch, 'init', '-q', '--bare', bareRepo);
      git(authorDir, 'push', '-q', bareRepo, 'HEAD:refs/heads/main');
      expect(git(authorDir, 'ls-files').split('\n')).not.toContain('node_modules/@papercusp/plugin-sdk');

      // Negative control first: a repository GitHub does not know is refused before anything is listed.
      const unknown = await publishInstalledUnitToCupboard({ slug: PLUGIN_NAME, github_url: `https://github.com/${GITHUB_OWNER}/no-such-repo` });
      expect(unknown).toMatchObject({ ok: false, status: 422 });
      expect(cupboardPosts).toHaveLength(0);

      const published = await publishInstalledUnitToCupboard({ slug: PLUGIN_NAME, github_url: GITHUB_URL });
      expect(published).toMatchObject({ ok: true, listing_kind: 'plugin' });
      expect(cupboardPosts).toHaveLength(1);
      expect(cupboardPosts[0]!.authorization).toBe(`Bearer ${h.ghToken}`);
      expect(cupboardPosts[0]!.body).toMatchObject({
        listing_kind: 'plugin',
        listing_ref: PLUGIN_NAME,
        github_url: GITHUB_URL,
        github_owner: GITHUB_OWNER,
        github_name: PLUGIN_NAME,
        github_repository_id: GITHUB_REPO_ID,
      });
      // The publish gate read the manifest the author pushed, through GitHub's contents API.
      expect(githubCalls.some((p) => p.endsWith('/papercusp.json'))).toBe(true);
      listingId = String((published as { listing: { listing: { id: string } } }).listing.listing.id);
      expect(listings.get(listingId)).toBeTruthy();
    });
  });

  describe('installed from the Cupboard by listing id', () => {
    it('refuses until the owner pins the provider review, and writes nothing before that', async () => {
      const missing = await postInstall({ listingId: 'lst_does_not_exist' });
      expect(missing).toMatchObject({ status: 404, json: { error: 'listing_not_found_or_unreachable' } });

      const refused = await postInstall({ listingId });
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({ code: 'provider_install_consent_required' });
      review = (refused.json.data as { review?: unknown } | undefined)?.review;
      expect(review).toBeTruthy();
      expect(JSON.stringify(review)).toContain(CHAT_HOST);
      await expect(fs.readdir(GLOBAL_PLUGINS_DIR()).catch(() => [])).resolves.not.toContain(PLUGIN_NAME);
      expect(h.snapshot).not.toHaveBeenCalled();
    });

    it('installs with the pinned review; the loader finds it and the daemon runs in the provider sandbox', async () => {
      const installed = await postInstall({ listingId, acceptCapabilities: true, expectedReview: review });
      expect(installed.status, JSON.stringify(installed.json)).toBe(200);
      expect(installed.json).toMatchObject({ ok: true, name: PLUGIN_NAME, version: '1.0.0' });
      const dir = join(GLOBAL_PLUGINS_DIR(), PLUGIN_NAME);
      expect(JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8'))).toMatchObject({ name: PLUGIN_NAME });
      // What landed came from the published repository, not from the author's working copy.
      await expect(fs.stat(join(dir, 'node_modules'))).rejects.toThrow();
      expect(h.snapshot).toHaveBeenCalledWith(WS, 'plugin_install', expect.objectContaining({ githubUrl: GITHUB_URL }));

      const { loaded, errors } = await discover();
      expect(errors).toEqual([]);
      const failures: ProviderRegistrationFailure[] = [];
      const registered = await registerPluginProviders(loaded, (e) => failures.push(e), providerRegistry(), tapStart);
      expect(failures).toEqual([]);
      expect(registered).toEqual([PROVIDER_ID]);
      expect(started).toHaveLength(1);
      expect(started[0]!.options.sandbox).toBe('provider');
      const pid = started[0]!.handle.pid();
      expect(pid).toBeGreaterThan(0);
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      expect(basename(argv[0]!)).toBe('bwrap');
      expect(argv).toContain('--unshare-net');
      // The installed package is the only part of the Papercusp home (where pasted tokens are stored) it can see.
      const home = join(scratch, 'papercusp-home');
      const fromHome = argv.filter((arg) => arg.startsWith(home));
      expect(fromHome.length).toBeGreaterThan(0);
      expect(fromHome.filter((arg) => !arg.startsWith(dir))).toEqual([]);
      expect(daemonProviderRuntimes().get(PLUGIN_NAME)).toBeTruthy();
      expect(providerRegistry().get(PROVIDER_ID)?.descriptor.ingress?.socket?.credential).toBe('gateway_token');
    }, 120_000);
  });

  describe('connected on Settings → Integrations', () => {
    it('refuses a token that does not match the declared pattern, and connects nothing', async () => {
      const bad = await putCredentials(PROVIDER_ID, { gateway_token: 'not-a-gateway-token' });
      expect(bad.status).toBe(422);
      expect(JSON.parse(bad.text)).toMatchObject({ field: 'gateway_token' });
      expect(bad.text).not.toContain('not-a-gateway-token');
      expect(await sourcesOfKind(PROVIDER_ID)).toEqual([]);
    });

    it('connects the owner source once both pasted tokens are saved; no response echoes them', async () => {
      const saved = await putCredentials(PROVIDER_ID, { gateway_token: GATEWAY_TOKEN, api_token: API_TOKEN });
      expect(saved.status, saved.text).toBe(200);
      expect(saved.text).not.toContain(GATEWAY_TOKEN);
      expect(saved.text).not.toContain(API_TOKEN);
      const sources = await sourcesOfKind(PROVIDER_ID);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ status: 'connected', ownerUserId: ownerId });
      sourceId = sources[0]!.id;
    });
  });

  describe('receiving messages over the gateway the host holds', () => {
    it('opens the gateway with the gateway token, acks every delivery and admits each message once', async () => {
      ingress = new ProviderSocketIngressManager({
        admit: async (db, input) => {
          const outcome = await admitConnectorRecord(db, input, {
            ingest: (inner, args) =>
              ingestExternalTriggerEvent(inner, args, {
                emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
              }),
            sinksFor: async () => [],
          });
          admissions.push(outcome);
          return outcome;
        },
        log: (message) => logs.push(message),
      });
      await ingress.reconcile();

      const opens = () => chatCalls.filter((c) => c.path === '/v1/gateway.open');
      expect(opens()).toHaveLength(1);
      expect(opens()[0]!.authorization).toBe(`Bearer ${GATEWAY_TOKEN}`);
      const socket = await waitFor('the gateway connection', () => gatewaySockets[0]);

      const report = { id: 'M-100', room: 'R-BUGS', author: { id: 'U-REPORTER' }, body: 'Export returns a 500 <@U-BOT>', mentions: ['U-BOT'], created_at: '2026-10-11T12:00:00.000Z' };
      socket.send(JSON.stringify(messageDelivery('d-1', report)));
      // The app's own reply is not an inbound message.
      socket.send(JSON.stringify(messageDelivery('d-2', { id: 'M-101', room: 'R-BUGS', author: { id: 'U-BOT', bot: true }, body: 'Filed.', thread: 'M-100' })));
      await waitFor('the message to be admitted', () => admissions.length === 1);
      // TeamChat redelivers a message it thinks was not acked: same message, new delivery id.
      socket.send(JSON.stringify(messageDelivery('d-3', report)));
      await waitFor('the redelivery to be processed', () => admissions.length === 2);

      expect(acks).toEqual(expect.arrayContaining(['d-1', 'd-2', 'd-3'].map((id) => JSON.stringify({ delivery_id: id }))));
      expect(admissions).toEqual(['admitted', 'deduped']);
      const rows = await sql<Array<{ datatype_id: string; payload: Record<string, unknown> }>>`
        SELECT DISTINCT ON (dedupe_key) datatype_id, payload FROM harness_shared.trigger_deliveries
         WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid ORDER BY dedupe_key, received_at`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.datatype_id).toBe('chat-message');
      expect(rows[0]!.payload).toMatchObject({
        channelId: 'R-BUGS',
        threadId: 'M-100',
        sender: 'U-REPORTER',
        text: 'Export returns a 500 <@U-BOT>',
        mentions: ['U-BOT'],
        extensions: { teamchat: { deliveryId: 'd-1', workspace: 'W-ACME' } },
      });

      // The package's reconnect notice makes the host open a fresh gateway instead of waiting for the close.
      socket.send(JSON.stringify({ kind: 'rotate', delivery_id: 'd-4' }));
      await waitFor('a fresh gateway connection', () => gatewaySockets.length >= 2 && opens().length >= 2);
      expect(opens().every((c) => c.authorization === `Bearer ${GATEWAY_TOKEN}`)).toBe(true);

      // The sandboxed daemon normalized every delivery for this source and never saw a token.
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every((call) => call.capability === 'ingress.normalize' && call.source === sourceId)).toBe(true);
      const seen = JSON.stringify(invocations) + logs.join('\n');
      expect(seen).not.toContain(GATEWAY_TOKEN);
      expect(seen).not.toContain(API_TOKEN);
    }, 60_000);
  });

  describe('acting in TeamChat', () => {
    it('lists rooms for a picker and replies in the thread with only the API token, injected by the host', async () => {
      const before = invocations.length;
      const callsBefore = chatCalls.length;
      const hostFetchFor = (db: Sql, input: { workspaceId: string; providerId: string; sourceId: string; harness: string }) =>
        createSourceHostFetch(db, { ...input, sourceIds: [input.sourceId], registry: providerRegistry(), fetchImpl: globalThis.fetch });

      const options = await listProviderOptions(sql, { workspaceId: WS, ownerUserId: ownerId, capability: 'chat.channels' }, { registry: providerRegistry(), hostFetchFor });
      expect(options.groups).toHaveLength(1);
      expect(options.groups[0]).toMatchObject({
        sourceId,
        provider: PROVIDER_ID,
        error: null,
        options: [
          { value: 'R-BUGS', label: '#bugs', description: 'Bug reports' },
          { value: 'R-GENERAL', label: '#general' },
        ],
      });

      const reply = await providerRegistry().get(PROVIDER_ID)!.adapter.invoke(
        { source: sourceId, capability: 'chat.reply', args: { channelId: 'R-BUGS', threadId: 'M-100', text: 'Filed as a ticket.' } },
        { fetch: hostFetchFor(sql, { workspaceId: WS, providerId: PROVIDER_ID, sourceId, harness: DEFAULT_SOURCE_TOKEN_HARNESS }) },
      );
      expect(reply).toEqual({ channelId: 'R-BUGS', threadId: 'M-100', messageId: 'M-REPLY-1' });

      const api = chatCalls.slice(callsBefore).map(({ method, path, authorization }) => ({ method, path, authorization }));
      expect(api).toEqual([
        { method: 'GET', path: '/v1/rooms', authorization: `Bearer ${API_TOKEN}` },
        { method: 'POST', path: '/v1/rooms/R-BUGS/messages', authorization: `Bearer ${API_TOKEN}` },
      ]);
      expect(JSON.parse(chatCalls[chatCalls.length - 1]!.body)).toEqual({ thread: 'M-100', body: 'Filed as a ticket.' });
      const seen = JSON.stringify(invocations.slice(before));
      expect(seen).not.toContain(API_TOKEN);
      expect(seen).not.toContain(GATEWAY_TOKEN);
    });

    it('needed nothing from the network beyond GitHub, the Cupboard and TeamChat', () => {
      expect(strays).toEqual([]);
    });
  });
});
