/**
 * Independent-author journey (plan generalized-integrations-google-migration-
 * cupboard-workflows-2026-10-05, P-014, decision D-026).
 *
 * An outside author ships an Outlook-shaped mail and calendar provider plus a
 * trigger pack as ONE package (test/fixtures/outlook-graph-provider). This
 * suite plays everyone except the author, in a clean workspace, through public
 * doors only:
 *
 *   - BUILD: the package is copied out of the tree and type-checked there
 *     against nothing but the published SDK, Microsoft's Graph types and Node's
 *     types; a planted drift copy proves the check can fail (AUTO-BAR-R-11).
 *   - INSTALL: Cupboard's installPluginFromCupboardCore, which refuses a
 *     provider until the owner pins the exact review (consent control).
 *   - RUN: plugin discovery plus registerPluginProviders start the daemon under
 *     the bubblewrap provider sandbox; the network edge is a fake Graph API
 *     reached only through host-mediated fetch (AUTO-BAR-R-12).
 *   - CONNECT: the real OAuth start and callback routes.
 *   - SYNC: the connector runtime lands mail and calendar in the owner Vault
 *     (ITEM-P-014-contract), replays admit nothing twice, and the pack fires
 *     exactly once, only after an explicit arm.
 *
 * Every negative control has a positive control beside it, so a probe that
 * stopped detecting cannot pass vacuously.
 */
import { promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { StartDaemonOptions } from '@papercusp/plugin-loader/daemon';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { seedPackWorkspace } from '../../test/_trigger-pack-fixtures';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
}));
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('../plugin-configs-pg', () => ({ mirrorPluginConfig: async () => undefined }));
vi.mock('../oauth/providers', async (orig) => ({
  ...(await orig<typeof import('../oauth/providers')>()),
  loadAndRegisterProvidersFromDisk: async () => {},
}));

import { loadPlugins } from '@papercusp/plugin-loader';
import { getSessionUserOrDefault } from '../auth';
import { CANONICAL_SOURCE_BY_DATATYPE, resolveCanonicalDocument } from '../capability-verbs/resolve';
import { installPluginFromCupboardCore, InstallPluginError, type InstallPluginCoreDeps } from '../cupboard/install-plugin-core';
import { armTriggerPack, buildTriggerPackReview } from '../cupboard/trigger-pack-lifecycle';
import { materializeTriggerPack } from '../cupboard/trigger-pack-materialize';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import type { RouteContext } from '../endpoint-route/define-route';
import callbackRoute from '../endpoint-route/routes/oauth/callback';
import startRoute from '../endpoint-route/routes/oauth/start';
import { dispatchPendingTriggerRuns } from '../external-triggers/binding-engine';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { setPersonalVaultEnabled } from '../personal-vault/store';
import { grantCapabilities } from '../plugin-grants';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../plugin-host-runtime';
import { runConnectorSync, type ConnectorSourceOutcome } from '../providers/connector-runtime';
import {
  daemonProviderRuntimes,
  startDaemonProvider,
  stopDaemonProvider,
  type ProviderDaemonHandle,
  type StartDaemonProviderOptions,
} from './daemon-provider';
import { providerRegistry } from './provider-registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const PACKAGE_SRC = resolve(HERE, '../../test/fixtures/outlook-graph-provider');
const PLUGIN_NAME = 'outlook-graph-provider';
const PROVIDER_ID = 'outlook-graph';
const OAUTH_PLUGIN = `provider:${PROVIDER_ID}`;
const GITHUB = 'https://github.com/independent-author/outlook-graph-provider';
const HARNESS = 'outlook-author-home';
const REPLY_SLUG = 'outlook-reply-2026-10-06';

let WS = 'outlook-author-journey';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAIL_DELTA = `${GRAPH}/me/mailFolders/inbox/messages/delta`;
const CALENDAR_DELTA = `${GRAPH}/me/calendarView/delta`;
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const EXFIL_HOST = 'graph-exfil.example.net';
const EXFIL_NEXT = `https://${EXFIL_HOST}/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=steal`;
/** Every credential the host holds for this account; none may cross into a daemon frame. */
const SECRET_MARKERS = ['graph-access-', 'graph-refresh-'];

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PACKAGE_SRC, 'fixtures', `${name}.json`), 'utf8'));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

/* ─── the fake Microsoft Graph edge (the only network this suite has) ─── */

type MailRound3 = 'empty' | 'replay-round-2' | 'new-mail';
const net = {
  calls: [] as Array<{ url: string; method: string; authorization: string | null }>,
  tokenSeq: 0,
  mailRound3: 'empty' as MailRound3,
  replayRound4: false,
  /** Positive control for the frame scan: echo the bearer into the response body. */
  leak: false,
  /** Negative control for egress: the first mail page links to an undeclared host. */
  exfilNextLink: false,
};

function emptyDeltaPage(base: string, token: string, extra: Record<string, unknown> = {}) {
  return { '@odata.deltaLink': `${base}?$deltatoken=${token}`, value: [], ...extra };
}

function graphResponse(url: URL): Record<string, unknown> | null {
  const href = `${url.origin}${url.pathname}`;
  const delta = url.searchParams.get('$deltatoken');
  const skip = url.searchParams.get('$skiptoken');
  if (href === MAIL_DELTA) {
    // Whatever round the cursor is in, the next mail page links to an undeclared host.
    if (net.exfilNextLink) return { '@odata.nextLink': EXFIL_NEXT, value: [] };
    if (skip === 'mail-page-2') return fixture('mail-delta-2');
    if (delta === 'mail-round-2') return fixture('mail-delta-3');
    if (delta === 'mail-round-3') {
      if (net.mailRound3 === 'replay-round-2') return fixture('mail-delta-3');
      if (net.mailRound3 === 'new-mail') return fixture('mail-delta-4');
      return emptyDeltaPage(MAIL_DELTA, 'mail-round-3');
    }
    if (delta === 'mail-round-4') return net.replayRound4 ? fixture('mail-delta-4') : emptyDeltaPage(MAIL_DELTA, 'mail-round-4');
    if (!delta && !skip) return fixture('mail-delta-1');
  }
  if (href === CALENDAR_DELTA) {
    if (delta === 'calendar-round-2') return emptyDeltaPage(CALENDAR_DELTA, 'calendar-round-2');
    if (!delta) return fixture('calendar-delta-1');
  }
  return null;
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const authorization = headers.get('authorization');
  net.calls.push({ url: url.href, method, authorization });
  if (url.href === TOKEN_URL && method === 'POST') {
    net.tokenSeq += 1;
    return Response.json({
      access_token: `graph-access-${net.tokenSeq}`,
      refresh_token: `graph-refresh-${net.tokenSeq}`,
      expires_in: 3600,
      scope: 'offline_access Mail.Read Calendars.Read User.Read',
      token_type: 'Bearer',
    });
  }
  if (url.host === 'graph.microsoft.com') {
    if (!authorization?.startsWith('Bearer graph-access-')) return new Response('unauthorized', { status: 401 });
    if (url.pathname === '/v1.0/me') return Response.json({ id: 'outlook-user-1', userPrincipalName: 'owner@contoso.example' });
    const body = graphResponse(url);
    // The leak control echoes the bearer into whatever page Graph serves, whatever the cursor round.
    if (body) return Response.json(net.leak ? { ...body, '@odata.debug': authorization } : body);
  }
  return new Response(`fake graph: no route for ${method} ${url.href}`, { status: 599 });
}

/* ─── a tap on the daemon boundary: every frame either way, and the sandbox it ran in ─── */

const frames: Array<{ direction: 'host->daemon' | 'daemon->host'; method: string; body: string }> = [];
const started: Array<{ options: StartDaemonOptions; handle: ProviderDaemonHandle }> = [];

function record(direction: 'host->daemon' | 'daemon->host', method: string, value: unknown) {
  frames.push({ direction, method, body: JSON.stringify(value ?? null) });
}

function tapStart(overrides: Partial<StartDaemonProviderOptions> = {}) {
  return (opts: StartDaemonProviderOptions) =>
    startDaemonProvider({
      ...opts,
      ...overrides,
      startDaemon: async (so: StartDaemonOptions) => {
        const handlers = Object.fromEntries(
          Object.entries(so.requestHandlers ?? {}).map(([method, handler]) => [
            method,
            async (params: unknown) => {
              record('daemon->host', method, params);
              const reply = await handler(params);
              record('host->daemon', `${method}:reply`, reply);
              return reply;
            },
          ]),
        );
        const { startDaemonPlugin } = await import('@papercusp/plugin-loader/daemon');
        const inner = await startDaemonPlugin({ ...so, requestHandlers: handlers });
        const handle: ProviderDaemonHandle = {
          async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
            record('host->daemon', method, params);
            const result = await inner.request<T>(method, params, timeoutMs);
            record('daemon->host', `${method}:result`, result);
            return result;
          },
          shutdown: () => inner.shutdown(),
          pid: () => inner.pid(),
        };
        started.push({ options: { ...so, requestHandlers: handlers }, handle });
        return handle;
      },
    });
}

/* ─── workspace plumbing ─── */

let org: OrgTestDb;
let sql: Sql;
let scratch: string;
let globalPluginsDir: string;
let ownerId: string;
let sourceId: string;
const registrationErrors: ProviderRegistrationFailure[] = [];

function installDeps(): InstallPluginCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(PACKAGE_SRC, dest, { recursive: true });
    },
    globalPluginsDir: () => globalPluginsDir,
    tmpDir: () => join(scratch, 'tmp'),
    grant: (input) => grantCapabilities(input, { sql }),
    invalidateHost: async () => undefined,
    materializeTriggerPack: (args) => materializeTriggerPack(sql, WS, args, { registry: providerRegistry() }),
  };
}

async function install(review?: unknown) {
  return installPluginFromCupboardCore(
    {
      githubUrl: GITHUB,
      harness: HARNESS,
      ...(review ? { acceptCapabilities: true, expectedReview: review as never } : {}),
      triggerPackConfig: { inputs: { tone: 'warm' } },
    },
    installDeps(),
  );
}

async function discover() {
  const projectDir = join(scratch, 'empty-project');
  await fs.mkdir(projectDir, { recursive: true });
  return loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir });
}

async function copyDatatype(id: string) {
  const base = await getDatatype(sql, 'papercusp-workspace', id);
  if (!base) throw new Error(`journey_datatype_missing:${id}`);
  await upsertDatatype(sql, {
    id: base.id,
    workspaceId: WS,
    potSlug: base.potSlug,
    title: base.title,
    description: base.description,
    tier: base.tier,
    nature: base.nature,
    audience: base.audience,
    workItemKind: base.workItemKind,
    payloadSchema: base.payloadSchema,
    authoritativeWriter: base.authoritativeWriter,
    selfImprovement: base.selfImprovement,
    published: base.published,
    tags: base.tags,
    createdBy: 'independent-author-journey',
  });
}

async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

async function sync(): Promise<ConnectorSourceOutcome> {
  const result = await runConnectorSync(
    sql,
    // pollIntervalSeconds 0: back-to-back passes are each due, as successive Graph deltas would be.
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId], pollIntervalSeconds: 0 },
    { ingest, servicesFor: async () => undefined, leaseOwner: 'independent-author-journey' },
  );
  const outcome = result.sources.find((row) => row.sourceId === sourceId);
  if (!outcome) throw new Error(`journey_sync_skipped_source: ${JSON.stringify(result)}`);
  return outcome;
}

async function vaultDoc(datatype: 'email-message' | 'calendar-event', externalId: string) {
  return resolveCanonicalDocument(sql, {
    workspaceId: WS,
    userId: ownerId,
    source: CANONICAL_SOURCE_BY_DATATYPE[datatype],
    externalId,
    sourceId,
  });
}

async function triggerRunCount(): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  return row.n;
}

async function sourceCursor(): Promise<string> {
  const [row] = await sql<Array<{ cursor: unknown }>>`
    SELECT cursor FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
  return JSON.stringify(row.cursor ?? null);
}

/** The daemon's own cursor: an opaque JSON string the runtime stores under `cursor.provider`. */
async function providerCursor(): Promise<{ mail?: { next: string | null }; calendar?: unknown } | null> {
  const raw = (JSON.parse(await sourceCursor()) as { provider?: unknown } | null)?.provider;
  return typeof raw === 'string' ? (JSON.parse(raw) as { mail?: { next: string | null }; calendar?: unknown }) : null;
}

function secretsInFrames(slice = frames): string[] {
  return slice.filter((f) => SECRET_MARKERS.some((marker) => f.body.includes(marker))).map((f) => `${f.direction} ${f.method}`);
}

/* ─── out-of-tree build ─── */

type TsModule = typeof import('typescript');
const ts = createRequire(import.meta.url)(join(REPO, 'node_modules', 'typescript')) as TsModule;

/** A node_modules holding ONLY what an outside author would install. */
async function outOfTreeCopy(dest: string) {
  await fs.cp(PACKAGE_SRC, dest, { recursive: true });
  const links: Array<[string, string]> = [
    ['@papercusp/plugin-sdk', join(REPO, 'packages', 'plugin-sdk')],
    ['@microsoft/microsoft-graph-types', join(REPO, 'node_modules', '@microsoft', 'microsoft-graph-types')],
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
      const where = d.file ? `${relative(dir, d.file.fileName)}` : '(global)';
      return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    }),
  };
}

/** Same detector shape as P-001's: any specifier that is not the SDK, the Graph types or a node builtin. */
const ALLOWED_IMPORTS = /^(?:@papercusp\/plugin-sdk|@microsoft\/microsoft-graph-types|node:[a-z_/]+)$/;
function foreignImports(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/\bimport\s*(?:type\s+)?(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  return specifiers.filter((s) => !s.startsWith('./') && !ALLOWED_IMPORTS.test(s));
}

/* ─── lifecycle ─── */

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  scratch = await fs.mkdtemp(join(tmpdir(), 'independent-author-journey-'));
  globalPluginsDir = join(scratch, 'global-plugins');
  await fs.mkdir(join(scratch, 'tmp'), { recursive: true });
  const home = join(scratch, 'papercusp-home');
  await fs.mkdir(home, { recursive: true });
  process.env.PAPERCUSP_HOME = home;
  await fs.writeFile(
    join(home, 'oauth-apps.json'),
    JSON.stringify({
      microsoft: {
        clientId: 'outlook-client-id',
        clientSecret: 'secret-1',
        redirectUri: 'https://papercusp.example/api/oauth/callback',
      },
    }),
  );
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  await seedPackWorkspace(sql, WS, HARNESS);
  await copyDatatype('email-message');
  await copyDatatype('calendar-event');
  ownerId = (await getSessionUserOrDefault(new Headers())).id;
  await setPersonalVaultEnabled(sql, WS, ownerId, true, 'owner');
}, 300_000);

afterAll(async () => {
  await stopDaemonProvider(PLUGIN_NAME);
  providerRegistry().unregisterPlugin(PLUGIN_NAME);
  vi.unstubAllGlobals();
  delete process.env.PAPERCUSP_HOME;
  await org?.cleanup();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
}, 120_000);

describe('independent-author journey (P-014)', () => {
  it('is a clean second workspace, not papercusp-workspace', () => {
    expect(WS).not.toBe('papercusp-workspace');
  });

  describe('built outside the source tree (AUTO-BAR-R-11, ITEM-P-014-contract)', () => {
    it('imports only the published SDK, the Graph types and node builtins (detector proven both ways)', async () => {
      expect(foreignImports("import { x } from '@papercusp/operator-core/lib/db';")).toEqual(['@papercusp/operator-core/lib/db']);
      expect(foreignImports("const r = require('../../../lib/integrations/provider-registry');")).toEqual([
        '../../../lib/integrations/provider-registry',
      ]);
      expect(foreignImports("/** @typedef {import('@papercusp/plugin-sdk').HostFetch} H */\nimport fs from 'node:fs';")).toEqual([]);
      for (const file of ['daemon.mjs', 'fixture-types.ts']) {
        const source = readFileSync(join(PACKAGE_SRC, file), 'utf8');
        expect({ file, foreign: foreignImports(source) }).toEqual({ file, foreign: [] });
      }
    });

    it('type-checks in a fresh directory against Microsoft Graph types; a drifted copy fails', async () => {
      const clean = join(scratch, 'oat', 'clean');
      await outOfTreeCopy(clean);
      const ok = typecheck(clean);
      expect(ok.files).toEqual(expect.arrayContaining(['daemon.mjs', 'fixture-types.ts']));
      expect(ok.diagnostics).toEqual([]);

      const drift = join(scratch, 'oat', 'drift');
      await outOfTreeCopy(drift);
      const mail = join(drift, 'fixtures', 'mail-delta-2.json');
      await fs.writeFile(mail, (await fs.readFile(mail, 'utf8')).replace('"conversationId"', '"conversationID"'));
      const daemon = join(drift, 'daemon.mjs');
      await fs.writeFile(daemon, `import '@papercusp/operator-core';\n${await fs.readFile(daemon, 'utf8')}`);
      const bad = typecheck(drift);
      expect(bad.diagnostics.some((d) => d.startsWith('fixture-types.ts'))).toBe(true);
      expect(bad.diagnostics.some((d) => d.startsWith('daemon.mjs') && d.includes('@papercusp/operator-core'))).toBe(true);
    }, 120_000);

    it('fixtures carry Graph delta tokens, conversation ids, categories and a recurring series', () => {
      const first = fixture('mail-delta-1') as { '@odata.nextLink'?: string; value: Array<Record<string, unknown>> };
      expect(first['@odata.nextLink']).toContain('$skiptoken=');
      expect(fixture('mail-delta-2')['@odata.deltaLink']).toContain('$deltatoken=');
      expect(first.value.every((m) => typeof m.conversationId === 'string')).toBe(true);
      expect(first.value.some((m) => Array.isArray(m.categories) && (m.categories as unknown[]).length > 0)).toBe(true);
      const removed = (fixture('mail-delta-3').value as Array<Record<string, unknown>>).filter((m) => '@removed' in m);
      expect(removed).toHaveLength(1);
      const events = fixture('calendar-delta-1').value as Array<Record<string, unknown>>;
      const master = events.find((e) => e.type === 'seriesMaster');
      expect(master?.recurrence).toBeTruthy();
      expect(events.filter((e) => e.seriesMasterId === master?.id).map((e) => e.type).sort()).toEqual(['exception', 'occurrence']);
    });
  });

  describe('install, connect, sync, arm (ITEM-P-014-contract, AUTO-BAR-R-11)', () => {
    let review: unknown;

    it('consent control: without a pinned review the install refuses and writes nothing', async () => {
      const refused = await install().catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(InstallPluginError);
      expect(refused).toMatchObject({ status: 409, code: 'provider_install_consent_required' });
      review = (refused as InstallPluginError).data?.review;
      expect(review).toBeTruthy();
      expect(JSON.stringify(review)).toContain('graph.microsoft.com');

      await expect(fs.readdir(globalPluginsDir).catch(() => [])).resolves.toEqual([]);
      const grants = await sql`SELECT 1 FROM harness_shared.plugin_capability_grants WHERE plugin_name = ${PLUGIN_NAME}`;
      expect(grants).toHaveLength(0);
      const packs = await sql`SELECT 1 FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}`;
      expect(packs).toHaveLength(0);
      expect((await discover()).loaded.map((lp) => lp.plugin.name)).not.toContain(PLUGIN_NAME);
      expect(providerRegistry().list().map((p) => p.descriptor.id)).not.toContain(PROVIDER_ID);
    });

    it('installs with the pinned review; discovery starts the daemon in the provider sandbox', async () => {
      const installed = await install(review);
      expect(installed).toMatchObject({ ok: true, name: PLUGIN_NAME, version: '1.0.0' });

      const { loaded, errors } = await discover();
      expect(errors).toEqual([]);
      const registered = await registerPluginProviders(loaded, (e) => registrationErrors.push(e), providerRegistry(), tapStart());
      expect(registrationErrors).toEqual([]);
      expect(registered).toEqual([PROVIDER_ID]);
      expect(started).toHaveLength(1);
      expect(started[0].options.sandbox).toBe('provider');

      // The running process, read from the kernel rather than from our own options.
      const pid = started[0].handle.pid();
      expect(pid).toBeGreaterThan(0);
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      expect(basename(argv[0])).toBe('bwrap');
      expect(argv).toContain('--unshare-net');
      expect(argv.join(' ')).toContain(join(globalPluginsDir, PLUGIN_NAME));
      expect(argv.join(' ')).not.toContain(join(scratch, 'papercusp-home'));
    });

    it('connects through the real OAuth start and callback routes', async () => {
      const start = await startRoute.handler(
        new Request(
          `https://papercusp.example/api/oauth/start?provider=${OAUTH_PLUGIN}&plugin=${OAUTH_PLUGIN}&harness=${HARNESS}&field=outlook`,
        ),
        CTX,
      );
      const authorize = start.headers.get('location') ?? ((await start.json()) as { authorizationUrl?: string }).authorizationUrl;
      expect(authorize).toContain('login.microsoftonline.com');
      const state = new URL(authorize!).searchParams.get('state');
      expect(state).toBeTruthy();

      const callback = await callbackRoute.handler(
        new Request(`https://papercusp.example/api/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state!)}`),
        CTX,
      );
      const location = callback.headers.get('location');
      expect(location, await callback.clone().text()).toBeTruthy();
      expect(new URL(location!, 'https://papercusp.example').searchParams.get('oauth_error')).toBeNull();

      const sources = await sql<Array<{ id: string; status: string; providerAccountId: string | null }>>`
        SELECT id::text AS id, status, provider_account_id AS "providerAccountId"
          FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${PROVIDER_ID}`;
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatchObject({ status: 'connected', providerAccountId: 'outlook-user-1' });
      sourceId = sources[0].id;
    });

    it('re-install after connect binds the pack to the source by datatype, disarmed', async () => {
      const again = await install(review);
      expect(again.triggerPack).toMatchObject({ armed: false });
      const bindings = await sql<Array<{ armed: boolean; sourceId: string | null; eventPattern: string }>>`
        SELECT armed, source_id::text AS "sourceId", event_pattern AS "eventPattern"
          FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND detached_at IS NULL`;
      const inbound = bindings.filter((b) => b.eventPattern.endsWith(':message.received'));
      expect(inbound).toHaveLength(1);
      expect(inbound[0]).toMatchObject({ armed: false, sourceId });
    });

    it('syncs mail and calendar into the owner Vault with Graph semantics kept', async () => {
      const outcome = await sync();
      expect(outcome).toMatchObject({ outcome: expect.not.stringMatching(/fail|error/), rejected: 0 });
      expect(outcome.admitted).toBe(6); // msg-1, msg-2, msg-3, series master, occurrence, exception

      const msg1 = await vaultDoc('email-message', 'AAMkAGI2-msg-1');
      expect(JSON.stringify(msg1)).toContain('AAQkAGI2-conv-quarterly');
      const tagged = fixture('mail-delta-1').value as Array<{ id: string; categories: string[] }>;
      const withCategory = tagged.find((m) => m.categories.length > 0)!;
      const doc = await vaultDoc('email-message', withCategory.id);
      for (const category of withCategory.categories) expect(JSON.stringify(doc)).toContain(category);

      const master = await vaultDoc('calendar-event', 'AAMkAGI2-evt-series');
      expect(JSON.stringify(master)).toContain('weekly');
      const occurrence = await vaultDoc('calendar-event', 'AAMkAGI2-evt-occ-1');
      expect(JSON.stringify(occurrence)).toContain('AAMkAGI2-evt-series');

      expect(await triggerRunCount()).toBe(0);
    });

    it('replay control: redelivery and a re-served delta page admit and launch nothing twice', async () => {
      const second = await sync(); // round-2: msg-2 redelivered with a new category, msg-3 removed
      net.mailRound3 = 'replay-round-2'; // Graph re-serves the same change set
      let third: ConnectorSourceOutcome;
      try {
        third = await sync();
      } finally {
        net.mailRound3 = 'empty';
      }
      expect(second.deduped).toBeGreaterThanOrEqual(1);
      expect(third.admitted).toBe(0);
      expect(third.deduped).toBeGreaterThanOrEqual(2);
      expect(await triggerRunCount()).toBe(0);
    });

    it('fires exactly once after an explicit arm, and never again on replay', async () => {
      const [pack] = await sql<Array<{ id: string }>>`
        SELECT id::text AS id FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}`;
      const packReview = await buildTriggerPackReview(sql, WS, pack.id);
      expect(packReview).toBeTruthy();
      await expect(
        armTriggerPack(sql, WS, { installationId: pack.id, fingerprint: packReview!.fingerprint, reviewedBy: 'owner' }),
      ).resolves.toMatchObject({ ok: true });

      net.mailRound3 = 'new-mail';
      const arrived = await sync();
      net.mailRound3 = 'empty';
      expect(arrived.admitted).toBe(1);
      expect(await triggerRunCount()).toBe(1);
      await dispatchPendingTriggerRuns(sql, { announceRunWork: async () => undefined });
      const runs = await sql`SELECT 1 FROM harness_shared.plan_runs WHERE plan_slug = ${REPLY_SLUG}`;
      expect(runs).toHaveLength(1);

      net.replayRound4 = true;
      const replay = await sync();
      net.replayRound4 = false;
      expect(replay.admitted).toBe(0);
      expect(await triggerRunCount()).toBe(1);
      await dispatchPendingTriggerRuns(sql, { announceRunWork: async () => undefined });
      expect(await sql`SELECT 1 FROM harness_shared.plan_runs WHERE plan_slug = ${REPLY_SLUG}`).toHaveLength(1);
    });
  });

  describe('isolation of the installed provider (AUTO-BAR-R-12)', () => {
    it('no frame in either direction ever carried a token; the scan catches a leaky Graph', async () => {
      expect(frames.filter((f) => f.method === 'host.fetch').length).toBeGreaterThan(0);
      expect(secretsInFrames()).toEqual([]);
      // Graph itself saw the bearer: the host injected it outside the sandbox.
      expect(net.calls.some((c) => c.url.startsWith(GRAPH) && c.authorization?.startsWith('Bearer graph-access-'))).toBe(true);

      const before = frames.length;
      net.leak = true;
      try {
        await sync();
      } finally {
        net.leak = false;
      }
      expect(secretsInFrames(frames.slice(before)).length).toBeGreaterThan(0);
    });

    it('cannot act for an account it was not called for', async () => {
      const handler = started[0].options.requestHandlers?.['host.fetch'];
      expect(handler).toBeTypeOf('function');
      // During a live call, replay that call's token against a different source.
      let crossAccount: unknown;
      vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
        const live = [...frames].reverse().find((f) => f.direction === 'daemon->host' && f.method === 'host.fetch');
        const { callToken } = JSON.parse(live!.body) as { callToken: string };
        crossAccount = await Promise.resolve(
          handler!({ callToken, source: '00000000-0000-0000-0000-00000000beef', request: { url: `${GRAPH}/me` } }),
        ).catch((e: unknown) => e);
        return fakeFetch(input as RequestInfo, init);
      });
      await sync();
      expect(crossAccount).toBeInstanceOf(Error);
      expect(JSON.stringify(crossAccount) + String(crossAccount)).toMatch(/source|bound|account/i);
    });

    it('cannot reach an undeclared host; the cursor stops at the refused request', async () => {
      // Positive control: the fake edge records any host it is asked for.
      await fakeFetch(`https://${EXFIL_HOST}/probe`);
      expect(net.calls.some((c) => c.url.startsWith(`https://${EXFIL_HOST}/probe`))).toBe(true);
      net.calls.length = 0;

      const before = await providerCursor();
      expect(before?.mail?.next ?? null).toBeNull(); // a settled delta position, nothing pending
      net.exfilNextLink = true;
      let outcome: ConnectorSourceOutcome;
      try {
        outcome = await sync();
      } finally {
        net.exfilNextLink = false;
      }
      expect(outcome.outcome).toMatch(/fail|error/);
      const [row] = await sql<Array<{ lastError: string | null }>>`
        SELECT last_error AS "lastError" FROM harness_shared.data_sources WHERE id = ${sourceId}::uuid`;
      expect(row.lastError ?? '').toMatch(/egress|undeclared|not declared|host/i);
      expect(net.calls.some((c) => c.url.includes(EXFIL_HOST))).toBe(false);
      // The page that carried the link was admitted, so its cursor commits. The pass stops AT the
      // refused request: the next pass retries that exact URL (and is refused again) rather than
      // skipping past it, and the calendar stream is untouched.
      const after = await providerCursor();
      expect(after?.mail?.next).toBe(EXFIL_NEXT);
      expect(after?.calendar).toEqual(before?.calendar);
    });

    it('refuses a call without host-mediated fetch before the daemon is contacted', async () => {
      const runtime = daemonProviderRuntimes().get(PLUGIN_NAME);
      expect(runtime).toBeTruthy();
      const syncFrames = () => frames.filter((f) => f.method === 'provider.syncPage').length;
      const before = syncFrames();
      await expect(
        runtime!.adapter.syncPage!({ source: sourceId, cursor: null, mode: 'incremental', config: {} } as never, undefined as never),
      ).rejects.toThrow(/host-mediated fetch/i);
      expect(syncFrames()).toBe(before);
    });

    it('does not run at all without bubblewrap (positive control: the same package registered above)', async () => {
      const { loaded } = await discover();
      const failures: ProviderRegistrationFailure[] = [];
      const registered = await registerPluginProviders(
        loaded,
        (e) => failures.push(e),
        providerRegistry(),
        tapStart({ bwrapBinary: '/usr/bin/false' }),
      );
      expect(registered).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures[0])).toMatch(/sandbox/i);
      expect(providerRegistry().list().map((p) => p.descriptor.id)).not.toContain(PROVIDER_ID);
      expect(daemonProviderRuntimes().get(PLUGIN_NAME)).toBeUndefined();
    });
  });
});
