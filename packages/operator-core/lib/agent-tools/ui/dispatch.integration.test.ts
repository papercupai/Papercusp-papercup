/**
 * dispatch.integration.test.ts — the ui:dispatch MCP tool handler, against a real
 * Postgres. It's a request/response over harness_shared.ui_intents: INSERT a
 * pending intent, poll until a browser tab flips its status, else time out.
 *
 * Regression for EI-6861 ("Tool ui:dispatch returns a structural error —
 * null-value-in-column-workspace-id"): migration 453 added a NOT NULL
 * workspace_id to harness_shared.ui_intents, and the tool must stamp it via
 * activeWorkspaceId() on every insert. This test recreates the table WITH that
 * NOT NULL constraint, so if a refactor ever drops workspace_id from the insert
 * again the INSERT throws and this test fails — the exact class that reached the
 * shared DB during the migration's deploy-ordering window (old 4-column code
 * inserting NULL). A fake-sql unit test cannot prove the constraint is satisfied.
 *
 * Also proves: `args` is stored as a real jsonb OBJECT (::text::jsonb) with
 * requested_by from the principal; the poll returns the response once status
 * leaves 'pending'; with no responder it times out (row → status=timeout).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { createCache } from '@papercusp/cache';
import { activeWorkspaceId } from '../../workspace-registry';
import type { SummaryDeps } from '../../content-summary';
import type { RunAgentChatOptions } from '../../agent-chat-stream';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, summaryDeps: undefined as unknown as SummaryDeps }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// uiCrossWorkspaceBlock is flag-gated (papercusp-ui-workspace-guard, default OFF).
// Keep it OFF so the handler exercises the insert path directly (no ui_clients dep).
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));
// Keep real intake, summary policy/cache processing and projected dispatch. Only
// the model/budget dependencies are controlled; this is not a provider test.
vi.mock('../../content-summary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../content-summary')>();
  return { ...actual, summarizeContent: (source: Parameters<typeof actual.summarizeContent>[0], options: Parameters<typeof actual.summarizeContent>[1], signal: AbortSignal | undefined) => actual.summarizeContent(source, options, signal, h.summaryDeps) };
});

const dispatchTool = (await import('./dispatch')).default;
await import('../voice/say');
await import('../documents/read');
const narrationTool = lookupByMcpName('voice:say');
const documentTool = lookupByMcpName('documents:read');
if (!narrationTool) throw new Error('voice:say must be registered');
if (!documentTool) throw new Error('documents:read must be registered');
function narrationContext(overrides: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  const workspaceId = activeWorkspaceId();
  return {
    log: () => {}, progress: () => {}, emit: () => {},
    signal: new AbortController().signal, role: 'operator', runId: 'narration-pg-fixture',
    workspaceId, uiClientId: 'requesting-tab', isSuperuser: true,
    principal: { slug: 'narration-agent', workspaceId, capabilities: new Set(['operator:read']) },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    ...overrides,
  };
}
const narrate = (args: unknown, ctx = narrationContext()) =>
  dispatchProjectedTool(narrationTool, 'voice:say', args, ctx, {});
const documentContext = () => narrationContext({ principal: { slug: 'narration-agent', workspaceId: activeWorkspaceId(), capabilities: new Set(['operator:read', 'search:read']) } });
const readDocument = (args: unknown, ctx = documentContext()) =>
  dispatchProjectedTool(documentTool, 'documents:read', args, ctx, {});
const call = (args: Record<string, unknown>, ctx: Record<string, unknown> = { principal: { slug: 'tester' } }) =>
  dispatchTool.handler(args as never, ctx as never) as Promise<{ isError?: boolean; content: { text: string }[] }>;

let rootSql: postgres.Sql;
let summaryRequests: RunAgentChatOptions[];

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `ui_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // Mirrors harness_shared.ui_intents including migration 453's NOT NULL
  // workspace_id — the constraint EI-6861 tripped on.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.ui_intents (
      id BIGSERIAL PRIMARY KEY,
      client_id text NOT NULL, intent text NOT NULL,
      args jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending', result jsonb, error_message text,
      requested_by text, workspace_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    )`);
  await rootSql.unsafe(`CREATE TABLE harness_shared.ui_clients (client_id text PRIMARY KEY, workspace_id text NOT NULL)`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.ui_intents RESTART IDENTITY`;
  await rootSql`TRUNCATE harness_shared.ui_clients`;
  summaryRequests = [];
  const cache = createCache();
  h.summaryDeps = {
    async *run() { throw new Error('Unexpected cloud model call'); },
    async *runLocal(options) {
      summaryRequests.push(options);
      yield { type: 'result', finalText: 'The report lists 12 and 34.', costUsd: 0, tokensIn: 12, tokensOut: 8, stopReason: 'end_turn' };
    },
    isLocalModel: async model => model === 'fixture-local',
    checkBudget: async () => ({ exceeded: false }),
    recordSpend: async () => {},
    reuse: (workspace, key, factory) => cache.getOrSet(workspace, key, factory),
  };
});

describe('explicit summary composition through projected tools and the real UI intent store', () => {
  it('keeps original read, summary-only and explicitly narrated cached summary separate', async () => {
    await rootSql`INSERT INTO harness_shared.ui_clients VALUES ('requesting-tab', ${activeWorkspaceId()})`;
    const content = { kind: 'text', text: 'Original report: 12 and 34. EXACT FINAL TAIL', ref: 'provided:report', partial: true };
    const original = await readDocument({ content });
    expect(original.result?.structuredContent).toMatchObject({ ok: true, text: content.text });
    expect(summaryRequests).toHaveLength(0);
    const [originalReceipt] = await Promise.all([narrate({ operation: 'read', content }), respond('done', { readingId: 'original', status: 'starting' })]);
    expect(originalReceipt.ok).toBe(true);
    expect(summaryRequests).toHaveLength(0);
    const request = { operation: 'summarize', content, summary: { model: 'fixture-local', length: 'short', focus: 'numbers' } };
    const summarized = await readDocument(request);
    const summary = summarized.result?.structuredContent;
    expect(summary).toMatchObject({ ok: true, summary: 'The report lists 12 and 34.', cached: false, sourceRefs: ['provided:report'], coverage: { complete: false } });
    if (!summary || typeof summary !== 'object' || !('summary' in summary) || typeof summary.summary !== 'string') throw new Error('The projected document summary must return its text.');
    const summaryText = summary.summary;
    expect(await rootSql`SELECT id FROM harness_shared.ui_intents`).toHaveLength(1);
    expect(summaryRequests).toHaveLength(1);
    expect(JSON.parse(summaryRequests[0]!.promptText)).toMatchObject({ quotedSource: content.text, focus: 'numbers' });
    expect((await readDocument(request)).result?.structuredContent).toMatchObject({ cached: true, summary: summaryText });
    expect(summaryRequests).toHaveLength(1);
    const [summaryReceipt] = await Promise.all([
      narrate({ operation: 'read', content: { kind: 'text', text: summaryText, partial: true, ref: 'provided:explicit-summary' } }),
      respond('done', { readingId: 'explicit-summary', status: 'starting' }),
    ]);
    expect(summaryReceipt.result?.structuredContent).toMatchObject({ destination: 'requesting-tab' });
    const rows = await rootSql`SELECT client_id, args FROM harness_shared.ui_intents ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.args.text)).toEqual([content.text, summaryText]);
    expect(rows.every(row => row.client_id === 'requesting-tab' && row.args.allowCloud === false)).toBe(true);
    expect(summaryRequests).toHaveLength(1);
  });

  it('requires a concrete workspace and cloud consent before producing any summary or output intent', async () => {
    const request = { operation: 'summarize', content: { kind: 'text', text: 'Private source' }, summary: { model: 'cloud-fixture' } };
    expect((await readDocument(request)).result?.structuredContent).toMatchObject({ ok: false, error: 'cloud-consent-required' });
    const unscoped = documentContext();
    unscoped.workspaceId = '*';
    unscoped.principal = { ...unscoped.principal!, workspaceId: '*' };
    expect((await readDocument(request, unscoped)).result?.structuredContent).toMatchObject({ ok: false, error: 'unauthorized' });
    expect(summaryRequests).toHaveLength(0);
    expect(await rootSql`SELECT id FROM harness_shared.ui_intents`).toHaveLength(0);
  });
});

describe('voice:say projected narration through the real UI intent store', () => {
  it('delivers authorized source and returns the requesting tab receipt without a second tab intent', async () => {
    await rootSql`INSERT INTO harness_shared.ui_clients VALUES ('requesting-tab', ${activeWorkspaceId()}), ('another-tab', ${activeWorkspaceId()})`;
    const [response] = await Promise.all([
      narrate({ operation: 'read', content: { kind: 'html', html: '<p>FIRST 12</p><p>FINAL 34</p>', ref: 'provided:article', partial: true } }),
      respond('done', { readingId: 'read-1', status: 'starting' }),
    ]);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.result?.structuredContent).toMatchObject({ destination: 'requesting-tab', source: { sourceRefs: ['provided:article'], coverage: { complete: false } } });
    const receipt = response.result?.content?.find(item => item.type === 'text' && item.text.trimStart().startsWith('{'));
    if (receipt?.type !== 'text') throw new Error('The projected narration must return its JSON receipt.');
    expect(JSON.parse(receipt.text)).toMatchObject({ status: 'done', result: { readingId: 'read-1', status: 'starting' } });
    const rows = await rootSql`SELECT client_id, intent, args, requested_by, workspace_id FROM harness_shared.ui_intents`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client_id: 'requesting-tab', intent: 'voice_read', requested_by: 'narration-agent', workspace_id: activeWorkspaceId(), args: { text: 'FIRST 12\n\nFINAL 34', allowCloud: false, coverage: { complete: false, warnings: ['source-partial'] } } });
  });

  it('denies absent and foreign tabs and capability failures before storing an intent', async () => {
    const args = { operation: 'read', content: { kind: 'text', text: 'Private source' } };
    for (const clientWorkspace of [null, 'foreign-workspace']) {
      await rootSql`TRUNCATE harness_shared.ui_clients`;
      if (clientWorkspace) await rootSql`INSERT INTO harness_shared.ui_clients VALUES ('requesting-tab', ${clientWorkspace})`;
      const denied = await narrate(args);
      expect(denied.result?.structuredContent).toMatchObject({ ok: false, error: 'destination_unavailable' });
    }
    const ctx = narrationContext({ principal: { slug: 'unapproved', workspaceId: activeWorkspaceId(), capabilities: new Set() } });
    expect((await narrate(args, ctx)).error?.code).toBe('missing_capability');
    expect(await rootSql`SELECT id FROM harness_shared.ui_intents`).toHaveLength(0);
  });

  it('routes an explicit reading control to the requesting tab and returns its stored status', async () => {
    await rootSql`INSERT INTO harness_shared.ui_clients VALUES ('requesting-tab', ${activeWorkspaceId()})`;
    const [response] = await Promise.all([
      narrate({ operation: 'control', readingId: 'read-1', action: 'pause' }),
      respond('done', { readingId: 'read-1', status: 'paused' }),
    ]);
    expect(response.ok).toBe(true);
    const rows = await rootSql`SELECT client_id, intent, args, status FROM harness_shared.ui_intents`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client_id: 'requesting-tab', intent: 'voice_read_control', args: { readingId: 'read-1', action: 'pause' }, status: 'done' });
  });
});

// Concurrent "browser tab": flip the first pending intent to a terminal status.
async function respond(status: string, result: unknown) {
  for (let i = 0; i < 300; i++) {
    const r = await rootSql`UPDATE harness_shared.ui_intents SET status=${status}, result=${rootSql.json(result as never)}, completed_at=now() WHERE status='pending' RETURNING id`;
    if (r.length) return;
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe('ui:dispatch handler (PG)', () => {
  it('stamps a non-null workspace_id and stores the intent (jsonb args + requested_by), returning the response when a tab answers', async () => {
    const [res] = await Promise.all([
      call({ client_id: 'c1', intent: 'set_url', args: { params: { tab: 'plans' } }, timeout_ms: 3000 }),
      respond('done', { navigated: true }),
    ]);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: 'done', result: { navigated: true } });
    expect(res.isError).toBeFalsy();
    const row = (await rootSql<{ typ: string; tab: string; requested_by: string; workspace_id: string | null }[]>`
      SELECT jsonb_typeof(args) AS typ, args->'params'->>'tab' AS tab, requested_by, workspace_id FROM harness_shared.ui_intents`)[0]!;
    // Regression (EI-6861): the insert MUST supply a non-null workspace_id. With
    // the NOT NULL column, an insert that omitted it would already have thrown above.
    expect(row.workspace_id).toBeTruthy();
    expect(typeof row.workspace_id).toBe('string');
    expect(row.typ).toBe('object'); // args is a real jsonb object (::text::jsonb), not a string scalar
    expect(row.tab).toBe('plans');
    expect(row.requested_by).toBe('tester'); // principal.slug
  });

  it('times out when no tab answers: row → status=timeout, isError returned', async () => {
    const res = await call({ client_id: 'nobody', intent: 'set_url', args: {}, timeout_ms: 250 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).status).toBe('timeout');
    const row = (await rootSql<{ status: string; workspace_id: string | null }[]>`
      SELECT status, workspace_id FROM harness_shared.ui_intents`)[0]!;
    expect(row.status).toBe('timeout'); // the timeout UPDATE fired
    expect(row.workspace_id).toBeTruthy(); // still stamped even on the timeout path
  });
});
