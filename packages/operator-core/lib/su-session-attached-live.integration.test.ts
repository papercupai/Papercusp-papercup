/** Inventory integration uses an isolated real PTY with a controlled Node child.
 * The separately opt-in live-engine group creates and archives a named test
 * conversation. Provider tokens are spent only with that explicit flag;
 * its backend is Claude, model defaults to pinned `sonnet` (PUI D-012), and
 * account defaults to `auto` so the gateway can choose from its provider pool.
 */
// Establish the maintained PTY discovery isolation before either side of that
// production seam is imported. These fake children must never look like fleet sessions.
import { hermeticEnv } from '../../../apps/operator/vitest-shims/psu-pty-temp-dir';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdaptorServer } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA, type SuSessionEvent } from '@papercusp/chat-protocol';
import { parseSseStream, type ParsedSseEvent } from '@papercusp/sse';
import { confirmedProviderRateLimit } from './su-session-attached-live-rate-limit';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { modelArgsFor } from '../../../apps/operator/scripts/psu-launcher.mjs';
import { eventLogPathForOwner, hostThroughPty, metaPathFor, socketPathFor } from '../../../apps/operator/scripts/psu-pty-host.mjs';
import { findLiveHost, injectIntoHostWithConfirmation } from './events/await/psu-pty-discovery';
import { redactSensitiveText } from './sensitive-text';
import { buildClaudeMcpEntry } from './desktop-install/claude-integration';
import { SuNativeCards } from './su-session-native-cards';
import type { SuSessionEventInput } from './su-session-host';
import { approvalCardText } from './su-session-approval-display';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import { SU_EXEC_COMBINATIONS, SU_EXEC_SCENARIOS, SU_EXEC_REQUEST_SCENARIOS, SU_EXEC_PTY_CONTROLS, suExecScenariosFor, suExecQualificationPopulation,
  suExecQualificationDefects } from './__fixtures__/su-execution-parity';
import { clockwisePngColors, imageSha256, quadrantPng, retainImageInput, type ImageColor } from './__fixtures__/su-image-qualification';

/**
 * Exercise the actual host -> discovery -> socket -> PTY child boundary that
 * the inventory classifies. A controlled Node child avoids provider calls;
 * this is transport/inventory integration, not native-provider qualification.
 */
async function observeInventoryPtyBoundary() {
  const ownerId = 'su-exec-inventory-' + randomUUID();
  const probe = randomUUID();
  const root = mkdtempSync(join(tmpdir(), 'su-exec-inventory-'));
  const inputLog = join(root, 'child-input');
  const signalSource = new EventEmitter();
  let captured = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const io = {
    stdout: { columns: 80, rows: 24, write: (data: Buffer | string) => { captured += data.toString(); }, on() {}, off() {} },
    stdin,
  };
  const done = hostThroughPty({
    command: process.execPath,
    args: ['-e', [
      "const fs=require('node:fs');",
      "process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');",
      "process.stdout.write('SU_EXEC_PTY_READY\\n');",
      "let received='';process.stdin.on('data',data=>{fs.appendFileSync(process.env.SU_EXEC_INPUT_LOG,data);received+=data;if(received.includes(process.env.SU_EXEC_PROBE)){",
      "process.stdout.write('SU_EXEC_CHILD_RECEIPT:'+process.env.SU_EXEC_PROBE+'\\n');process.exit(0);}});",
      "setTimeout(()=>process.exit(19),12000);",
    ].join('')],
    cwd: root, env: hermeticEnv({ PAPERCUSP_SID: ownerId, SU_EXEC_PROBE: probe, SU_EXEC_INPUT_LOG: inputLog }),
    ownerId, io, bridgeTty: false, signalSource,
    onExit: () => undefined, emitCompacted: () => null,
  });
  const socket = socketPathFor(ownerId);
  const metadata = metaPathFor(ownerId);
  try {
    await vi.waitFor(() => expect(captured).toContain('SU_EXEC_PTY_READY'), { timeout: 5000 });
    // The host is in this Vitest worker; use the maintained exact-worker PID
    // verifier, rather than asking the native launcher classifier to recognize Vitest.
    const discovered = findLiveHost(ownerId, undefined, { verifyIdentity: pid => pid === process.pid });
    expect(discovered).toMatchObject({ ownerId, pid: process.pid, sock: socket });
    expect(existsSync(metadata)).toBe(true);
    const admission = await injectIntoHostWithConfirmation(socket, { mode: 'compact', data: '', ownerId });
    expect(admission).toMatchObject({ ok: true, confirmation: 'acked', reason: 'accepted' });
    // Admission acknowledges queue custody. Only the later production event
    // proves semantic refusal; the child-input log below proves no JSON leaked.
    const refusal = await vi.waitFor(() => {
      const events = readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const dropped = events.find(event => event.kind === 'retired-mode-dropped');
      expect(dropped).toMatchObject({ kind: 'retired-mode-dropped', mode: 'compact' });
      return dropped;
    }, { timeout: 5000 });
    const delivery = await injectIntoHostWithConfirmation(socket, { mode: 'raw', data: probe, ownerId });
    expect(delivery.ok).toBe(true);
    await vi.waitFor(() => expect(captured).toContain('SU_EXEC_CHILD_RECEIPT:' + probe), { timeout: 5000 });
    expect(await done, captured).toBe(0);
    expect(readFileSync(inputLog, 'utf8')).toBe(probe);
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(metadata)).toBe(false);
    return { refusal, rawDelivered: captured.includes('SU_EXEC_CHILD_RECEIPT:' + probe),
      discoveryRemoved: !existsSync(socket) && !existsSync(metadata) };
  } finally {
    signalSource.emit('SIGTERM');
    await done.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('SU execution live qualification inventory (P-001)', () => {
  it('SU-EXEC R-1 acceptance contract', async () => {
    const observed = await observeInventoryPtyBoundary();
    expect(observed.rawDelivered).toBe(true);
    expect(SU_EXEC_PTY_CONTROLS.find(control => control.mode === 'raw')?.classification).toBe('native-presentation');
    expect(SU_EXEC_PTY_CONTROLS.find(control => control.mode === 'compact')?.classification).toBe('retired');
    // Keep the native-provider drill population unknown: a real PTY transport
    // receipt from a controlled child cannot qualify either provider backend.
    const population = suExecQualificationPopulation();
    for (const combination of SU_EXEC_COMBINATIONS) {
      const rows = population.filter(row => row.provider === combination.provider && row.execution === combination.execution);
      expect(rows.map(row => row.scenario)).toEqual(suExecScenariosFor(combination).map(scenario => scenario.id));
      expect(rows.every(row => row.state === 'unknown')).toBe(true);
      expect(rows.filter(row => row.scenario.startsWith('pty-control:')).map(row => row.scenario).sort())
        .toEqual(SU_EXEC_PTY_CONTROLS.map(control => `pty-control:${control.mode}`).sort());
      for (const request of SU_EXEC_REQUEST_SCENARIOS.filter(request => request.provider === combination.provider)) {
        expect(rows.some(row => row.scenario === request.id)).toBe(true);
      }
    }
    for (const id of ['assets', 'request-families', 'fork', 'wake-receipts', 'cold-carry', 'same-provider-handoff', 'provider-transfer']) {
      expect(SU_EXEC_SCENARIOS.find(scenario => scenario.id === id)?.falsifier).toBeTruthy();
    }
    expect(suExecQualificationDefects(population).length).toBeGreaterThan(0);
  }, 20_000);

  it('SU-EXEC R-18 inventory preflight', async () => {
    const observed = await observeInventoryPtyBoundary();
    expect(observed.discoveryRemoved).toBe(true);
    for (const row of suExecQualificationPopulation()) {
      expect(row.ownerItem).toMatch(/^P-\d{3}$/);
      expect(row.host).toBe('linux/x64/current-build');
      expect(row.evidenceRefs).toEqual([]);
      expect(row.negativeControlRefs).toEqual([]);
    }
    // No missing mandatory live proof may become a healthy/parity verdict.
    const missing = suExecQualificationPopulation().filter(row => row.execution === 'pty');
    expect(suExecQualificationDefects(missing)).toContainEqual(expect.stringContaining('missing'));
  }, 20_000);
});

type StartedTool = Extract<SuSessionEventInput, { type: 'tool'; phase: 'started' }>;
type OpenedCard = Extract<SuSessionEventInput, { type: 'card'; phase: 'opened' }>;

/** This fixture may answer only the read-only identity call requested by its
 * owner turn. Keep native permissions and reject unrelated cards immediately. */
function assertIdentityApproval(event: OpenedCard, call: StartedTool | undefined, turnId: string): void {
  expect(event.turnId).toBe(turnId);
  expect(call?.turnId, 'approval must have a matching started tool in this turn').toBe(turnId);
  if (!call) throw new Error('Identity approval has no matching tool');
  const input = call.input ?? {};
  expect(input).toBeTypeOf('object');
  expect(Array.isArray(input)).toBe(false);
  expect(input).not.toBeNull();
  const wrapped = ['tools:invoke', 'mcp__papercusp-su__tools_invoke'].includes(call.name);
  if (wrapped) {
    expect(input).toEqual({ name: 'coord:whoami', args: {} });
  } else {
    expect(['coord:whoami', 'mcp__papercusp-su__coord_whoami']).toContain(call.name);
    expect(input).toEqual({});
  }
  const view = approvalCardText(call.name, input);
  expect(event.card.approval?.title, 'card must describe this exact identity call').toBe(view.title);
  expect(event.card.details).toBe(view.details);
  expect(event.card.presentation).toMatchObject({ kind: 'radio', options: expect.arrayContaining([{ id: 'yes', label: 'Yes' }]) });
}

describe('bounded attached identity approval', () => {
  it.each([
    ['mcp__papercusp-su__coord_whoami', {}],
    ['mcp__papercusp-su__tools_invoke', { name: 'coord:whoami', args: {} }],
  ])('answers the actual native permission for %s without broadening it', async (name, input) => {
    const events: SuSessionEventInput[] = [];
    const cards = new SuNativeCards('identity-fixture', `identity-${randomUUID()}`, event => events.push(event));
    const pending = cards.handleClaude(name as string, input as Record<string, unknown>, 'identity-turn', {
      signal: new AbortController().signal, toolUseID: 'identity-call', requestId: 'identity-request',
    });
    try {
      const opened = events.find((event): event is OpenedCard => event.type === 'card' && event.phase === 'opened');
      if (!opened) throw new Error('Native permission did not open a card');
      assertIdentityApproval(opened, { type: 'tool', phase: 'started', turnId: 'identity-turn',
        callId: 'identity-call', name: name as string, input }, 'identity-turn');
      expect(resolveCardResponse({ correlationId: opened.card.correlationId, action: 'submit',
        payload: { picks: ['yes'] }, expectedWorkspaceId: 'identity-fixture' })).toEqual({ ok: true });
      await expect(pending).resolves.toMatchObject({ behavior: 'allow', updatedInput: input });
      expect(events).toContainEqual(expect.objectContaining({ type: 'card', phase: 'closed', resolution: 'submitted' }));
    } finally { cards.cancel(); }
  });

  it.each([
    ['Bash', { command: 'touch unauthorized.txt' }, 'identity-turn'],
    ['mcp__papercusp-su__tools_invoke', { name: 'work_items:create', args: {} }, 'identity-turn'],
    ['mcp__papercusp-su__coord_whoami', { owner: 'someone-else' }, 'identity-turn'],
    ['mcp__papercusp-su__coord_whoami', {}, 'another-turn'],
  ])('refuses an unrelated %s request in %s', async (name, input, turnId) => {
    const events: SuSessionEventInput[] = [];
    const cards = new SuNativeCards('identity-fixture', `identity-${randomUUID()}`, event => events.push(event));
    const pending = cards.handleClaude(name as string, input as Record<string, unknown>, turnId as string, {
      signal: new AbortController().signal, toolUseID: 'unrelated-call', requestId: 'unrelated-request',
    });
    try {
      const opened = events.find((event): event is OpenedCard => event.type === 'card' && event.phase === 'opened');
      if (!opened) throw new Error('Native permission did not open a card');
      expect(() => assertIdentityApproval(opened, { type: 'tool', phase: 'started', turnId: turnId as string,
        callId: 'unrelated-call', name: name as string, input }, 'identity-turn')).toThrow();
    } finally { cards.cancel(); await pending; }
  });
});

const claudeFixture = vi.hoisted(() => ({ sourceHome: undefined as string | undefined }));
// Preserve real bootstrap/config materialization while supplying this operator's
// private MCP credential, rather than the global operator's fixed bearer.
vi.mock('./interactive-claude-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./interactive-claude-config')>();
  return { ...actual, writeInteractiveClaudeConfig: (opts: Parameters<typeof actual.writeInteractiveClaudeConfig>[0]) => {
    if (!claudeFixture.sourceHome) throw new Error('Private Claude source config is not prepared');
    return actual.writeInteractiveClaudeConfig({ ...opts, home: claudeFixture.sourceHome });
  } };
});

describe.skipIf(process.env.PAPERCUSP_REAL_ATTACHED_ENGINE !== '1')('live attached SU engine', () => {
  let db: OrgTestDb | undefined;
  let pg: DedicatedNativePg | undefined;
  let fixture: BaselineCoordFixture | undefined;
  let server: ReturnType<typeof createAdaptorServer> | undefined;
  let home: string | undefined;
  let previousEnv: Record<string, string | undefined> = {};
  let startup = { stage: 'not-started', startedAt: Date.now(), finished: false };
  async function setupStep<T>(stage: string, action: () => Promise<T>): Promise<T> {
    startup = { stage, startedAt: Date.now(), finished: false };
    console.info('SU_EXEC_NATIVE_SETUP', JSON.stringify({ stage, state: 'started' }));
    try {
      const value = await action();
      startup.finished = true;
      console.info('SU_EXEC_NATIVE_SETUP', JSON.stringify({ stage, state: 'completed', elapsedMs: Date.now() - startup.startedAt }));
      return value;
    } catch (error) {
      console.error('SU_EXEC_NATIVE_SETUP', JSON.stringify({ stage, state: 'failed', elapsedMs: Date.now() - startup.startedAt,
        message: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }

  beforeAll(async () => {
    const account = process.env.PAPERCUSP_ATTACHED_TEST_ACCOUNT?.trim() || 'auto';
    const catalogPath = process.env.PUI_NATIVE_ACCOUNT_CATALOG;
    const accounts = account === 'auto' ? (() => {
      if (!catalogPath) throw new Error('Attached auto-route acceptance requires PUI_NATIVE_ACCOUNT_CATALOG');
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as { accounts?: unknown };
      if (!Array.isArray(catalog.accounts) || !catalog.accounts.length) throw new Error('Attached account catalog is empty');
      return catalog.accounts.map((entry: { id?: string; provider?: string }) => {
        if (!entry.id || !/^[A-Za-z0-9._-]+$/.test(entry.id) || !['claude', 'codex'].includes(entry.provider ?? '')) {
          throw new Error('Attached account catalog needs valid id/provider metadata');
        }
        return { id: entry.id, provider: entry.provider, credentialRef: '', addedAt: 0, boundTo: [] };
      });
    })() : [];
    home = mkdtempSync(join(tmpdir(), 'pui-attached-live-'));
    previousEnv.PAPERCUSP_TEST_PG_ADMIN_URL = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    pg = await setupStep('private-pg', () => startDedicatedNativePg({ baseDir: home!,
      settings: { max_connections: '120', fsync: 'off', synchronous_commit: 'off' } }));
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
    db = await setupStep('org-db', () => createOrgTestDb());
    expect(new URL(db.adminDsn).port, 'the org fixture must use this test-owned PG process')
      .toBe(new URL(pg.getConnectionUri()).port);
    if (account === 'auto') await db.adminSql`
      INSERT INTO harness_shared.operator_account_pool (workspace_id, payload, updated_at)
      VALUES ('papercusp-workspace', ${JSON.stringify({ accounts })}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`;
    const privateHome = join(home, '.papercusp');
    mkdirSync(privateHome, { recursive: true });
    writeFileSync(join(privateHome, 'superuser-token'), randomBytes(32).toString('base64url'), { mode: 0o600 });
    const env = {
      PAPERCUSP_HOME: privateHome, DATABASE_URL: db.adminDsn,
      PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace',
      PAPERCUSP_WORKSPACES_ROOT: join(home, 'workspaces'),
      PAPERCUSP_LAUNCH_CONTEXT_DIR: join(home, 'launch-context'),
      PAPERCUSP_SU_CODEX_HOMES_DIR: join(home, 'native-codex'),
      PAPERCUSP_SU_OMP_HOMES_DIR: join(home, 'native-omp'),
      PAPERCUSP_SESSION_CLAUDE_DIR: join(home, 'native-claude'),
      PAPERCUSP_SESSION_MCP_DIR: join(home, 'native-mcp'),
      PAPERCUSP_BACKGROUND_WORKERS: '0', PAPERCUSP_DBOS_ENABLE: '0',
      PAPERCUSP_MEMORY_EMBEDDER: 'disabled', PAPERCUSP_SERVE_UI: '0',
    };
    Object.assign(previousEnv, Object.fromEntries([...Object.keys(env), 'HARNESS_DATABASE_URL',
      'HARNESS_ADMIN_DATABASE_URL', 'PAPERCUSP_HONO_PORT', 'PAPERCUSP_OPERATOR_URL',
      'PAPERCUSP_MCP_PROXY_BASE', 'OPERATOR_DEV_PORT'].map(key => [key, process.env[key]])));
    Object.assign(process.env, env);
    delete process.env.OPERATOR_DEV_PORT;
    fixture = await setupStep('coord-fixture', () => setupBaselineCoordFixture({ dsn: db!.adminDsn }));
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp';
    await setupStep('seed-harness', async () => {
      const { insertHiveIfAbsent } = await import('./hive-store');
      await insertHiveIfAbsent({ workspaceId: 'papercusp-workspace', homeSlug: harness,
        pubkeyBase64: randomBytes(32).toString('base64'), keychainId: `attached-fixture-${randomUUID()}` }, db!.adminSql);
      const { setHiveSetting } = await import('./hive-settings-store');
      await setHiveSetting({ workspaceId: 'papercusp-workspace', potHomeSlug: harness,
        settingKey: 'promptOverride.su', value: readFileSync(resolve(import.meta.dirname,
          '../../../apps/operator/prompts/pot-instances/papercup-pot.su.md'), 'utf8') }, db!.adminSql);
      const { saveHarnessRegistry } = await import('./harness-registry');
      await saveHarnessRegistry({ projects: [{ slug: harness, path: resolve(import.meta.dirname, '../../..'),
        harness_kind: 'hive', self_repo: true }] }, 'papercusp-workspace');
    });
    const { scaffoldHarnessSchema } = await import('./scaffold-harness-schema');
    await setupStep('scaffold-harness-schema', () => scaffoldHarnessSchema(harness));
    // Mount the production MCP definitions and auth/workspace stack without
    // importing every unrelated HTTP route. Warm the real operator catalogue
    // before initialize: its cold import otherwise consumes the client's MCP
    // handshake deadline (r199), whereas the full host app warmed it incidentally.
    const app = await setupStep('mount-private-mcp', async () => {
      const [{ Hono }, { registerRoute }, { default: transportRoutes }, { default: cardResponseRoute },
        { createWorkspaceContextMiddleware }, { createLocalMachineOperatorTransport }] = await Promise.all([
        import('hono'), import('./endpoint-route/define-route'), import('./endpoint-route/routes/transport'),
        import('./endpoint-route/routes/operator/card-response'),
        import('./workspace-context-middleware'), import('./workspace-host/local-machine-operator-transport'),
      ]);
      const app = new Hono().basePath('/api');
      app.use('*', createWorkspaceContextMiddleware(createLocalMachineOperatorTransport()));
      for (const route of transportRoutes) registerRoute(app, route);
      registerRoute(app, cardResponseRoute);
      return app;
    });
    await setupStep('warm-private-mcp-catalogue', async () => {
      const { ensureOperatorToolsLoaded } = await import('./endpoint-route/routes/transport/_mcp-host');
      await ensureOperatorToolsLoaded();
    });
    server = createAdaptorServer({ fetch: app.fetch });
    await setupStep('listen-private-operator', () => new Promise<void>((done, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', done);
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Private attached test operator has no port');
    expect([3070, 3170, 3271, 3278]).not.toContain(address.port);
    const origin = `http://127.0.0.1:${address.port}`;
    Object.assign(process.env, { PAPERCUSP_HONO_PORT: String(address.port),
      PAPERCUSP_OPERATOR_URL: origin, PAPERCUSP_MCP_PROXY_BASE: origin });
    claudeFixture.sourceHome = join(home, 'claude-source');
    mkdirSync(join(claudeFixture.sourceHome, '.claude'), { recursive: true });
    const { readSuperuserToken } = await import('./superuser-token');
    const token = readSuperuserToken();
    if (!token) throw new Error('Private attached operator has no MCP bearer');
    const entry = buildClaudeMcpEntry(origin, token, 'attached-fixture', '');
    writeFileSync(join(claudeFixture.sourceHome, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, mcpServers: { 'papercusp-su': entry },
    }), { mode: 0o600 });
    const { ensureProjectTrust } = await import('./interactive-claude-config');
    await setupStep('ensure-project-trust', () => ensureProjectTrust(claudeFixture.sourceHome!, resolve(import.meta.dirname, '../../..')));
    expect(entry.headers.Authorization === `Bearer ${token}`, 'MCP config must use the private operator bearer').toBe(true);
    const client = new Client({ name: 'attached-fixture-preflight', version: '1.0.0' });
    const mcpUrl = new URL('/api/mcp', origin);
    mcpUrl.search = new URLSearchParams({ superuser: '1', workspace: 'papercusp-workspace',
      tools: 'coord:whoami,tools:invoke' }).toString();
    try {
      await setupStep('card-response-preflight', async () => {
        const response = await fetch(`${origin}/api/operator/conversations/${randomUUID()}/card-response`, {
          method: 'POST', headers: { ...entry.headers, 'content-type': 'application/json' }, body: '{}',
        });
        const body = await response.text();
        expect(response.status, body).toBe(400);
        expect(response.headers.get('content-type'), body).toContain('application/json');
        expect(JSON.parse(body)).toMatchObject({ error: expect.stringContaining('correlationId, workspaceId, action required') });
      });
      await setupStep('mcp-connect', () => client.connect(new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: entry.headers },
      })));
      const listed = await setupStep('mcp-list-tools', () => client.listTools({}, { timeout: 30_000 }));
      expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['coord:whoami', 'tools:invoke']));
    } finally {
      await client.close();
    }
  }, 180_000);

  afterAll(async () => {
    if (!startup.finished) console.error('SU_EXEC_NATIVE_SETUP', JSON.stringify({ stage: startup.stage,
      state: 'interrupted', elapsedMs: Date.now() - startup.startedAt }));
    try {
      if (server) await new Promise<void>((done, reject) => {
        server!.close(error => error ? reject(error) : done());
        if ('closeAllConnections' in server! && typeof server!.closeAllConnections === 'function') server!.closeAllConnections();
      });
    } finally {
      try { await fixture?.dispose(); } finally {
        try { await db?.cleanup(); } finally {
          try { await pg?.stop(); } finally {
            for (const [key, value] of Object.entries(previousEnv)) {
              if (value === undefined) delete process.env[key]; else process.env[key] = value;
            }
            if (home) rmSync(home, { recursive: true, force: true });
            claudeFixture.sourceHome = undefined;
          }
        }
      }
    }
  }, 60_000);

  it.each(['claude', 'codex'] as const)('P006 actual-image-dependent native result and durable reconnect (%s)', async backend => {
    const [{ createChat, archiveChat, getChat }, { default: launchRoutes }, { suSessionRoutes },
      { getRegisteredSuSessionHost }, { readSuperuserToken }, { activeWorkspaceId }] = await Promise.all([
      import('./agent-chats-data'), import('./endpoint-route/routes/adv/launch-su'),
      import('./endpoint-route/routes/agent-chats/su-session'), import('./su-session-host'),
      import('./superuser-token'), import('./workspace-registry'),
    ]);
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp', workspaceId = activeWorkspaceId();
    const created = await createChat({ slug: harness, role: 'operator', title: `P006 image ${backend} ${randomUUID()}` });
    if (!created.ok) throw new Error(created.error);
    const chatId = created.data.id, key = { workspaceId, harnessSlug: harness, agentChatId: chatId };
    const headers = { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${readSuperuserToken()}` };
    const context = { params: { slug: harness, chatId } } as never;
    let host: ReturnType<typeof getRegisteredSuSessionHost>;
    try {
      let model: string | undefined = backend === 'claude' ? 'sonnet' : undefined;
      const launch = await launchRoutes.find(route => route.method === 'POST')!.handler(new Request('http://localhost/api/adv/sessions/launch-su', {
        method: 'POST', headers, body: JSON.stringify({ agent: backend, attached_engine: true, execution_kind: 'programmatic',
          agent_chat_id: chatId, harness_slug: harness, model, account: 'auto', carry: 'warm' }),
      }), context);
      const launched = await launch.json() as { status: string; transport?: string; error?: string };
      expect(launch.status, JSON.stringify(launched)).toBe(200);
      host = getRegisteredSuSessionHost(key);
      if (!host) throw new Error('Image acceptance did not attach a native host');
      await vi.waitFor(() => {
        expect(host!.snapshot().terminal, JSON.stringify(host!.recent.slice(-6))).toBe(false);
        expect(host!.snapshot()).toMatchObject({ executorAttached: true, streamReady: true });
      }, { timeout: 120_000, interval: 100 });
      expect(host.descriptor().capabilities.input?.parts).toContain('image');
      if (backend === 'codex') {
        await vi.waitFor(() => expect(host!.descriptor().models?.length).toBeGreaterThan(0), { timeout: 30_000 });
        const models = host.descriptor().models!;
        model = (models.find(row => row.isDefault) ?? models[0]).id;
      }
      // Randomize the arrangement only in the bitmap; neither the prompt nor
      // a filename contains the answer. This requires actual visual inference.
      const palette: ImageColor[] = ['red', 'blue', 'green', 'yellow'];
      for (let i = palette.length - 1; i > 0; i--) { const j = randomInt(i + 1); [palette[i], palette[j]] = [palette[j], palette[i]]; }
      const png = quadrantPng(palette), image = png.toString('base64');
      expect(clockwisePngColors(png), 'independent PNG calibration before native delivery').toEqual(palette);
      const command = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION, type: 'owner_turn',
        commandId: `image-${randomUUID()}`, turnId: `image-turn-${randomUUID()}`, issuedAt: new Date().toISOString(),
        target: host.descriptor().identity, model,
        content: 'Read the attached image. Reply only with the four quadrant colors clockwise starting at top left, comma separated. Do not use tools or change anything.',
        input: [{ type: 'image', mediaType: 'image/png', data: image }],
      };
      const evidenceRoot = process.env.PAPERCUSP_SU_IMAGE_EVIDENCE_DIR ?? join(tmpdir(), 'papercusp-su-image-evidence');
      mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
      const evidence = mkdtempSync(join(evidenceRoot, `${backend}-`));
      retainImageInput(evidence, command, png);
      console.info('SU_EXEC_P006_NATIVE_IMAGE_EVIDENCE', JSON.stringify({ backend, evidence, imageSha256: imageSha256(png) }));
      const route = suSessionRoutes.find(route => route.method === 'POST')!;
      const post = () => route.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      const accepted = await post(); expect(accepted.status, JSON.stringify(await accepted.json())).toBe(202);
      const saved = await getChat({ slug: harness, chatId });
      expect(saved.ok && saved.data.transcript.some(turn => JSON.stringify(turn).includes(image))).toBe(true);
      const stream = host.subscribe()[Symbol.asyncIterator]();
      const observed = new Map(host.recent.map(row => [row.event.sequence, row.event]));
      const deadline = Date.now() + 120_000;
      let answer = '';
      try {
        while (true) {
          const events = [...observed.values()];
          const errors = events.flatMap(event => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
          if (errors.length) throw new Error(errors.join('\n'));
          answer = events.flatMap(event => event.type === 'transcript' && event.role === 'assistant'
            && event.channel === 'text' && event.phase === 'completed' && event.turnId === command.turnId
            ? [event.content ?? ''] : []).join(' ').toLowerCase();
          if (host.descriptor().lifecycle === 'waiting-for-owner' && answer) break;
          let timer: ReturnType<typeof setTimeout>;
          try {
            const next = await Promise.race([stream.next(), new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(`Native image result missing: ${JSON.stringify({ backend,
                model, answer, lifecycle: host!.descriptor().lifecycle, eventTypes: events.slice(-8).map(event => event.type) })}`)),
              Math.max(1, deadline - Date.now()));
            })]);
            if (next.done) throw new Error('Native image stream ended without a final result');
            observed.set(next.value.event.sequence, next.value.event);
          } finally { clearTimeout(timer!); }
        }
      } finally { await stream.return?.(); }
      const result = { backend, model, answer, expectedColors: palette, imageSha256: imageSha256(png),
        descriptor: host.descriptor(), nativeInput: 'not-inspected' };
      writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      if (backend === 'claude') {
        const { findSessionTranscript } = await import('./claude-sessions');
        const { readClaudeTranscriptSnapshotLines } = await import('./su-session-claude-adapter');
        const descriptor = host.descriptor(), extension = descriptor.backendExtension;
        const path = await findSessionTranscript(descriptor.identity.nativeSessionId, { owner: descriptor.identity.ownerId,
          roots: extension.backend === 'claude' && extension.configDir ? [join(extension.configDir, 'projects')] : [] });
        if (path) for await (const line of readClaudeTranscriptSnapshotLines(path)) {
          const row = JSON.parse(line);
          if (row.type !== 'user' || !Array.isArray(row.message?.content)
            || !row.message.content.some((part: { type?: string; text?: string }) => part.type === 'text' && part.text === command.content)) continue;
          writeFileSync(join(evidence, 'native-user-message.json'), JSON.stringify(row.message, null, 2) + '\n', { mode: 0o600 });
          const nativeImages = row.message.content.filter((part: { type?: string }) => part.type === 'image');
          result.nativeInput = 'retained';
          writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
          expect(nativeImages).toHaveLength(1);
          const nativePng = Buffer.from(nativeImages[0].source.data, 'base64');
          expect(imageSha256(nativePng), 'native Claude transcript image must match submitted PNG').toBe(imageSha256(png));
          expect(clockwisePngColors(nativePng)).toEqual(palette);
          break;
        }
        expect(result.nativeInput, `Native input missing; retained evidence: ${evidence}`).toBe('retained');
      }
      console.info('SU_EXEC_P006_NATIVE_IMAGE_OBSERVED', JSON.stringify({ backend, model, answer,
        expectedColors: palette, lifecycle: host.descriptor().lifecycle, evidence }));
      expect(answer.match(/\b(?:red|blue|green|yellow)\b/g), `${answer}; retained evidence: ${evidence}`).toEqual(palette);
      // A reconnect/retry reads the existing durable receipt. It never drops
      // the image or sends this already delivered command a second time.
      const reconnected = await post(); expect(await reconnected.json()).toMatchObject({ ok: true, replayed: true });
      console.info('SU_EXEC_P006_NATIVE_IMAGE', JSON.stringify({ backend, model, ownerId: host.descriptor().identity.ownerId,
        nativeSessionId: host.descriptor().identity.nativeSessionId, expectedColors: palette, answer,
        persistedImage: true, reconnectReplayed: true }));
    } finally {
      host ??= getRegisteredSuSessionHost(key);
      if (host && !host.snapshot().terminal) await host.startCommand({ schema: SU_SESSION_SCHEMA,
        protocolVersion: SU_SESSION_PROTOCOL_VERSION, type: 'end', commandId: `end-${randomUUID()}`,
        issuedAt: new Date().toISOString(), target: host.descriptor().identity }).terminal;
      host?.dispose('P006 native image acceptance finished');
      expect((await archiveChat({ slug: harness, chatId })).ok).toBe(true);
    }
  }, 240_000);

  it.each(['claude', 'codex'] as const)('SU-EXEC R-8 acceptance contract: native %s programmatic supervision', async backend => {
    const [{ createChat, archiveChat }, { default: launchRoutes }, { suSessionRoutes },
      { getRegisteredSuSessionHost }, { readSuperuserToken }, { activeWorkspaceId },
      { readDurableSuSession }, { listTasks, getTask }] = await Promise.all([
      import('./agent-chats-data'), import('./endpoint-route/routes/adv/launch-su'),
      import('./endpoint-route/routes/agent-chats/su-session'), import('./su-session-host'),
      import('./superuser-token'), import('./workspace-registry'), import('./su-session-persistence'),
      import('./task-manager/store'),
    ]);
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp';
    const workspaceId = activeWorkspaceId();
    const created = await createChat({ slug: harness, role: 'operator', title: `R8 native ${backend} ${randomUUID()}` });
    if (!created.ok) throw new Error(created.error);
    const chatId = created.data.id;
    const key = { workspaceId, harnessSlug: harness, agentChatId: chatId };
    const headers = { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${readSuperuserToken()}` };
    const context = { params: { slug: harness, chatId } } as never;
    const model = backend === 'claude' ? 'sonnet' : 'gpt-5.5';
    let host: ReturnType<typeof getRegisteredSuSessionHost>;
    let taskId: string | undefined;
    let subscription: AsyncGenerator<ParsedSseEvent, void, unknown> | undefined;
    let client: AbortController | undefined;
    let lastSequence = 0;
    const observed: SuSessionEvent[] = [];
    try {
      const response = await launchRoutes.find(route => route.method === 'POST')!.handler(new Request(
        'http://localhost/api/adv/sessions/launch-su', { method: 'POST', headers,
          body: JSON.stringify({ agent: backend, attached_engine: true, execution_kind: 'programmatic',
            agent_chat_id: chatId, harness_slug: harness, model,
            account: process.env.PAPERCUSP_ATTACHED_TEST_ACCOUNT?.trim() || 'auto', carry: 'warm' }) }), context);
      const launched = await response.json();
      expect(response.status, JSON.stringify(launched)).toBe(200);
      host = getRegisteredSuSessionHost(key);
      if (!host) throw new Error('R8 launch did not register a native host');
      await vi.waitFor(() => {
        const errors = host!.recent.flatMap(({ event }) => event.type === 'error' ? [event.message] : []);
        expect(host!.snapshot(), JSON.stringify(errors)).toMatchObject({ executorAttached: true, streamReady: true, terminal: false });
      }, { timeout: 120_000, interval: 100 });
      const descriptor = host.descriptor();
      const identity = descriptor.identity;
      const generation = descriptor.runtimeGeneration;
      expect(descriptor.executionKind).toBe('programmatic');
      expect(Number.isSafeInteger(generation)).toBe(true);
      expect(generation).toBeGreaterThanOrEqual(0);
      expect(identity.nativeSessionId).toBeTruthy();
      const tasks = await listTasks({ workspaceId, sessionId: identity.nativeSessionId!, coordOwnerId: identity.ownerId,
        classes: ['agent-session'] });
      expect(tasks, 'one enrolled native process per logical session').toHaveLength(1);
      taskId = tasks[0].taskId;
      expect(tasks[0].detail).toMatchObject({ coordOwnerId: identity.ownerId, transport: 'structured' });
      expect(tasks[0].pid).toBeGreaterThan(0);
      const saved = await readDurableSuSession({ workspaceId, agentChatId: chatId });
      expect(saved).toMatchObject({ advSessionId: identity.advSessionId, nativeSessionId: identity.nativeSessionId,
        runtimeGeneration: generation, descriptor: { executionKind: 'programmatic' } });
      const route = suSessionRoutes.find(item => item.method === 'POST')!;
      const eventsRoute = suSessionRoutes.find(item => item.path.endsWith('/events'))!;
      const connectClient = async () => {
        client = new AbortController();
        const response = await eventsRoute.handler(new Request('http://localhost/events', {
          headers: { ...headers, 'last-event-id': String(lastSequence) }, signal: client.signal,
        }), context);
        expect(response.status).toBe(200);
        expect(response.body, 'the real SSE route must track the client lease').not.toBeNull();
        subscription = parseSseStream(response.body);
      };
      const nonce = `R8-${randomUUID()}`;
      const command = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
        type: 'owner_turn', commandId: `r8-${randomUUID()}`, turnId: `turn-${randomUUID()}`,
        issuedAt: new Date().toISOString(), target: identity, expectedRuntimeGeneration: generation,
        content: `This is a bounded read-only transport acceptance test. Call Papercusp coord:whoami exactly once (tools:invoke if deferred), then reply with ${nonce}. Do nothing else.` };
      await connectClient();
      const post = () => route.handler(new Request('http://localhost/commands', { method: 'POST', headers,
        body: JSON.stringify(command) }), context);
      expect((await post()).status).toBe(202);
      let toolIdentity = false;
      let reply = false;
      const deadline = Date.now() + 120_000;
      while (!toolIdentity || !reply || host.descriptor().lifecycle !== 'waiting-for-owner') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let next: IteratorResult<ParsedSseEvent, void>;
        try {
          next = await Promise.race([subscription!.next(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`R8 native supervision timed out: ${JSON.stringify({
              backend, toolIdentity, reply, lifecycle: host!.descriptor().lifecycle,
              recentTypes: observed.slice(-8).map(event => event.type),
            })}`)), Math.max(1, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
        if (next.done) throw new Error('R8 native stream ended before the scoped tool and reply completed');
        if (next.value.event !== 'session_event') continue;
        const event = JSON.parse(next.value.data) as SuSessionEvent;
        expect(event.sequence).toBeGreaterThan(lastSequence);
        lastSequence = event.sequence;
        observed.push(event);
        if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
        if (event.type === 'card' && event.phase === 'opened') {
          const call = observed.slice().reverse().find((entry): entry is StartedTool & SuSessionEvent =>
            entry.type === 'tool' && entry.phase === 'started' && entry.turnId === event.turnId);
          assertIdentityApproval(event, call, command.turnId);
          const answered = await fetch(`${process.env.PAPERCUSP_OPERATOR_URL}/api/operator/conversations/${encodeURIComponent(chatId)}/card-response`, {
            method: 'POST', headers, body: JSON.stringify({ correlationId: event.card.correlationId,
              workspaceId, action: 'submit', payload: { picks: ['yes'] } }),
          });
          expect(answered.status, await answered.text()).toBe(200);
        }
        if (event.type === 'tool' && event.phase === 'completed' && !event.isError && event.turnId === command.turnId) {
          const output = JSON.stringify(event.output);
          toolIdentity ||= output.includes(identity.ownerId) && output.includes(workspaceId);
        }
        if (event.type === 'transcript' && 'content' in event && event.role === 'assistant'
          && event.turnId === command.turnId && event.content?.includes(nonce)) reply = true;
      }
      // Reconnecting a consumer must keep the native process, generation and
      // durable command identity. A retry returns the receipt, never inference.
      client!.abort();
      await subscription!.return();
      subscription = undefined;
      await connectClient();
      expect(getRegisteredSuSessionHost(key)).toBe(host);
      expect(host.descriptor().runtimeGeneration).toBe(generation);
      expect(await (await post()).json()).toMatchObject({ ok: true, replayed: true });
      expect(await listTasks({ workspaceId, sessionId: identity.nativeSessionId!, coordOwnerId: identity.ownerId,
        classes: ['agent-session'] })).toHaveLength(1);
      const mismatched = await host.acceptCommand({ ...command, commandId: `mismatch-${randomUUID()}`, expectedRuntimeGeneration: generation + 1 });
      expect(await mismatched.terminal).toMatchObject({ status: 'refused', refusal: { code: 'runtime_generation_mismatch' } });
      const interrupt = host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
        type: 'interrupt', commandId: `interrupt-${randomUUID()}`, issuedAt: new Date().toISOString(), target: identity });
      expect(await interrupt.terminal).toMatchObject({ status: 'completed' });
      const end = host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
        type: 'end', commandId: `end-${randomUUID()}`, issuedAt: new Date().toISOString(), target: identity });
      expect(await end.terminal).toMatchObject({ status: 'completed' });
      await vi.waitFor(async () => expect((await getTask(taskId!))?.endedAt).toBeTruthy(), { timeout: 10_000 });
      expect(host.snapshot()).toMatchObject({ terminal: true, streamReady: false });
      const afterEnd = host.startCommand({ ...command, commandId: `ended-${randomUUID()}` });
      expect(await afterEnd.terminal).toMatchObject({ status: 'refused' });
      console.info('SU_EXEC_R8_NATIVE_RECEIPT', JSON.stringify({ backend, executionKind: 'programmatic',
        ownerId: identity.ownerId, nativeSessionId: identity.nativeSessionId, runtimeGeneration: generation, taskId,
        toolStream: true, durableReplay: true, generationMismatchRefused: true, ended: true,
        // This case deliberately does not claim the separate PTY, active-tool
        // interruption, background-child or operator-loss qualification duties.
        remaining: ['native-pty', 'active-tool-interrupt', 'background-child', 'operator-loss'] }));
    } finally {
      host ??= getRegisteredSuSessionHost(key);
      if (host && !host.snapshot().terminal) await host.startCommand({ schema: SU_SESSION_SCHEMA,
        protocolVersion: SU_SESSION_PROTOCOL_VERSION, type: 'end', commandId: `cleanup-${randomUUID()}`,
        issuedAt: new Date().toISOString(), target: host.descriptor().identity }).terminal;
      host?.dispose('R8 native supervision acceptance finished');
      client?.abort();
      await subscription?.return();
      if (taskId) await vi.waitFor(async () => expect((await getTask(taskId!))?.endedAt).toBeTruthy(), { timeout: 10_000 });
      expect((await archiveChat({ slug: harness, chatId })).ok).toBe(true);
    }
  }, 300_000);

  it('creates through launch-su, commits an owner turn, proves scoped SU tools, and ends the child', async (ctx) => {
    const [{ createChat, archiveChat, getChat }, { default: launchRoutes }, { suSessionRoutes }, { getRegisteredSuSessionHost }, { readSuperuserToken }, { activeWorkspaceId }, { readDurableSuSession }] = await Promise.all([
      import('./agent-chats-data'), import('./endpoint-route/routes/adv/launch-su'),
      import('./endpoint-route/routes/agent-chats/su-session'), import('./su-session-host'),
      import('./superuser-token'), import('./workspace-registry'), import('./su-session-persistence'),
    ]);
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp';
    const backend = 'claude' as const;
    const model = process.env.PAPERCUSP_ATTACHED_TEST_MODEL?.trim() || 'sonnet';
    const account = process.env.PAPERCUSP_ATTACHED_TEST_ACCOUNT?.trim() || 'auto';
    const workspaceId = activeWorkspaceId();
    const created = await createChat({ slug: harness, role: 'operator', title: `PUI attached acceptance ${randomUUID()}` });
    expect(created.ok, !created.ok ? created.error : '').toBe(true);
    if (!created.ok) return;
    const chatId = created.data.id;
    const key = { workspaceId, harnessSlug: harness, agentChatId: chatId };
    const headers = { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${readSuperuserToken()}` };
    const context = { params: { slug: harness, chatId } } as never;
    let host: ReturnType<typeof getRegisteredSuSessionHost>;
    let engineTaskId: string | undefined;
    let iterator: AsyncIterator<{ id: number; event: SuSessionEvent }> | undefined;
    try {
      const response = await launchRoutes.find((route) => route.method === 'POST')!.handler(new Request(
        'http://localhost/api/adv/sessions/launch-su', {
          method: 'POST', headers,
          body: JSON.stringify({ agent: backend, attached_engine: true, agent_chat_id: chatId,
            harness_slug: harness, model, account, carry: 'warm' }),
        }), context);
      const launched = await response.json() as { status: string; transport?: string; advSessionId: number; ownerId?: string };
      expect(response.status, JSON.stringify(launched)).toBe(200);
      expect(launched).toMatchObject({ status: 'ok', transport: 'structured' });
      const advSessionId = launched.advSessionId;
      const durable = await readDurableSuSession({ workspaceId, agentChatId: chatId });
      expect(durable).toMatchObject({ advSessionId, agentChatId: chatId, backend, harnessSlug: harness });
      host = getRegisteredSuSessionHost(key);
      if (!host) throw new Error('No live host after attached launch');
      const readyDeadline = Date.now() + 120_000;
      while (Date.now() < readyDeadline) {
        const snapshot = host.snapshot();
        if (snapshot.terminal) {
          const events = host.recent.map((entry) => entry.event);
          const rateLimit = confirmedProviderRateLimit(events);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during engine startup (${rateLimit.signals[0]})`);
          }
          const failures = events.flatMap((event) => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
          throw new Error(`Attached ${backend} engine ended before ready: lifecycle=${host.descriptor().lifecycle}; errors=${JSON.stringify(failures)}; snapshot=${JSON.stringify(snapshot)}`);
        }
        if (snapshot.executorAttached && snapshot.streamReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const readySnapshot = host.snapshot();
      if (!readySnapshot.executorAttached || !readySnapshot.streamReady || readySnapshot.terminal) {
        const events = host.recent.map((entry) => entry.event);
        const rateLimit = confirmedProviderRateLimit(events);
        if (rateLimit.confirmed) {
          ctx.skip(`NOT MEASURED: provider account limit during engine startup (${rateLimit.signals[0]})`);
        }
        const failures = events.flatMap((event) => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
        throw new Error(`Attached ${backend} engine did not become ready in 120s: lifecycle=${host.descriptor().lifecycle}; errors=${JSON.stringify(failures)}; snapshot=${JSON.stringify(readySnapshot)}`);
      }
      const identity = host.descriptor().identity;
      expect(identity).toMatchObject({ workspaceId, harnessSlug: harness, ownerId: launched.ownerId });
      expect(identity.nativeSessionId).toBeTruthy();
      const actualModel = host.descriptor().model;
      expect(actualModel, 'the native engine must identify the model that will answer').toBeTruthy();
      expect(host.descriptor().accountRoute).toBe(account);
      const { listTasks } = await import('./task-manager/store');
      const tasks = await listTasks({ workspaceId, sessionId: identity.nativeSessionId!, coordOwnerId: identity.ownerId, classes: ['agent-session'] });
      expect(tasks).toHaveLength(1);
      engineTaskId = tasks[0].taskId;
      expect(tasks[0].argv.length).toBeGreaterThan(0);
      const modelFlag = tasks[0].argv.indexOf('--model');
      expect(modelFlag, 'the real native launch must carry the explicit model pin').toBeGreaterThanOrEqual(0);
      const requestedArgs = modelArgsFor('claude', model);
      const nativeModel = tasks[0].argv[modelFlag + 1];
      // Claude's configured context window can add [1m] to the pinned family.
      // Preserve the exact native value in the receipt; compare the family here.
      expect(nativeModel.replace(/\[1m\]$/, ''))
        .toBe(requestedArgs[requestedArgs.indexOf('--model') + 1].replace(/\[1m\]$/, ''));
      expect(tasks[0].detail).toMatchObject({ coordOwnerId: identity.ownerId, transport: 'structured' });
      iterator = host.subscribe()[Symbol.asyncIterator]();
      const nonce = `PUI-ATTACHED-${randomUUID()}`;
      const content = `This is a bounded, read-only PUI transport acceptance test. Call the Papercusp coord:whoami tool exactly once (use tools:invoke if deferred), then reply with ${nonce} and the returned ownerId and workspaceId. Do not change files, send messages, register work, or start other work.`;
      const command = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
        type: 'owner_turn', commandId: `command-${randomUUID()}`, turnId: `turn-${randomUUID()}`,
        issuedAt: new Date().toISOString(), target: identity, content };
      const commandRoute = suSessionRoutes.find((route) => route.method === 'POST')!;
      const accepted = await commandRoute.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      expect(accepted.status, JSON.stringify(await accepted.json())).toBe(202);
      const saved = await getChat({ slug: harness, chatId });
      expect(saved.ok && saved.data.transcript.some((turn) => turn.content === content)).toBe(true);
      const observedEvents: SuSessionEvent[] = [];
      let toolIdentity = false;
      let reply = false;
      const deadline = Date.now() + 120_000;
      while ((!toolIdentity || !reply) && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout>;
        let next: IteratorResult<{ id: number; event: SuSessionEvent }>;
        try {
          next = await Promise.race([iterator.next(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for the scoped SU tool and reply')), Math.max(1, deadline - Date.now()));
          })]).finally(() => clearTimeout(timer));
        } catch (error) {
          const buffered = host.recent.map((entry) => entry.event);
          const rateLimit = confirmedProviderRateLimit([...observedEvents, ...buffered]);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
          }
          const recentTypes = buffered.slice(-8).map((event) => event.type).join(',') || 'none';
          const text = buffered.flatMap(event => event.type === 'transcript' && 'content' in event
            && event.role === 'assistant' ? [event.content ?? ''] : []).join('').slice(-2400);
          const errors = buffered.flatMap(event => event.type === 'error'
            ? [{ code: event.code, message: event.message }] : []).slice(-4);
          const secrets = Object.entries(process.env).filter(([key]) =>
            /token|secret|password|credential|authorization|api.?key/i.test(key)).map(([, value]) => value);
          const calls = buffered.filter(event => event.type === 'tool' && event.phase === 'started').slice(-4);
          const cards = buffered.filter(event => event.type === 'card').slice(-4);
          const diagnostic = redactSensitiveText(JSON.stringify({ assistantText: text, errors, calls, cards }), secrets);
          throw new Error(`${String(error)}; lifecycle=${host.descriptor().lifecycle}; bufferedEvents=${buffered.length}; recentTypes=${recentTypes}; nativeDiagnostic=${diagnostic}`);
        }
        if (next.done) throw new Error('SU stream ended before acceptance');
        const event = next.value.event;
        observedEvents.push(event);
        if (event.type === 'card' && event.phase === 'opened') {
          const call = observedEvents.slice().reverse().find((entry): entry is Extract<SuSessionEvent, { type: 'tool'; phase: 'started' }> =>
            entry.type === 'tool' && entry.phase === 'started' && entry.turnId === event.turnId);
          assertIdentityApproval(event, call, command.turnId);
          const answered = await fetch(`${process.env.PAPERCUSP_OPERATOR_URL}/api/operator/conversations/${encodeURIComponent(chatId)}/card-response`, {
            method: 'POST', headers, body: JSON.stringify({ correlationId: event.card.correlationId,
              workspaceId, action: 'submit', payload: { picks: ['yes'] } }),
          });
          expect(answered.status, await answered.text()).toBe(200);
        }
        if (event.type === 'error') {
          const rateLimit = confirmedProviderRateLimit(observedEvents);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
          }
          throw new Error(`${event.code}: ${event.message}`);
        }
        if (event.type === 'tool' && event.phase === 'completed' && !event.isError) {
          const output = JSON.stringify(event.output);
          toolIdentity ||= output.includes(identity.ownerId) && output.includes(workspaceId);
        }
        if (event.type === 'transcript' && 'content' in event && event.role === 'assistant' && event.content?.includes(nonce)) {
          expect(event.turnId).toBe(command.turnId);
          reply = true;
        }
      }
      const rateLimit = confirmedProviderRateLimit(observedEvents);
      if (rateLimit.confirmed) {
        ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
      }
      expect({ toolIdentity, reply }).toEqual({ toolIdentity: true, reply: true });
      const replay = await commandRoute.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
      console.log(JSON.stringify({ acceptance: 'attached-su-identity', workspaceId, harness, chatId, ownerId: identity.ownerId, nativeSessionId: identity.nativeSessionId, requestedModel: model, nativeModel, actualModel, accountRoute: account, toolIdentity, reply }));
    } finally {
      host ??= getRegisteredSuSessionHost(key);
      if (host && !host.snapshot().terminal) {
        const terminal = await host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
          type: 'end', commandId: `end-${randomUUID()}`, issuedAt: new Date().toISOString(), target: host.descriptor().identity }).terminal;
        expect(terminal.status).toBe('completed');
      }
      host?.dispose('live acceptance finished');
      await iterator?.return?.();
      if (engineTaskId) {
        const { getTask } = await import('./task-manager/store');
        await vi.waitFor(async () => expect((await getTask(engineTaskId!))?.endedAt).toBeTruthy(), { timeout: 5_000 });
      }
      expect((await archiveChat({ slug: harness, chatId })).ok).toBe(true);
    }
  }, 240_000);
});
