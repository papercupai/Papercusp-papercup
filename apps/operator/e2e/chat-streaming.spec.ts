/**
 * Live chat streaming via the fake-LLM injection seam (PAPERCUSP_FAKE_LLM=1).
 *
 * Covers the full route → SSE → consumer pipeline for architect/oracle/agent_chats
 * without a real model. The dev server must be launched with PAPERCUSP_FAKE_LLM=1
 * for these specs to receive scripted deltas instead of timing out on the real LLM.
 *
 * If the env var isn't set the route streams from a real backend and these specs
 * will fail (or stall). They auto-skip when the fake seam isn't active to avoid
 * polluting CI before the feature flag flips.
 */
import { test, expect } from './_egress';
import { seedFakeLlmHarness } from './_fake-llm-fixture';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { publishReport } from '../../../packages/operator-core/lib/report-library';
let harnessSlug = 'main';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

async function fakeLlmActive(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  // We probe by calling architect:chat with a 5s timeout. Real-LLM responses
  // take >5s; fake-LLM responses always terminate within ~200ms.
  try {
    const res = await request.post(`${baseURL}/api/agent-tools/architect/chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'probe', harnessSlug },
      timeout: 6_000,
    });
    if (!res.ok() && process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return false;
    const body = await res.text();
    const active = body.includes('[fake-llm]');
    if (process.env.VERIFY_TAURI_ISOLATED_DB === '1' && !active) throw new Error(`Isolated fake LLM probe failed: ${res.status()} ${body}`);
    return active;
  } catch (error) {
    if (process.env.VERIFY_TAURI_ISOLATED_DB === '1') throw error;
    return false;
  }
}

test.describe('chat streaming via fake-LLM seam', () => {
  test.beforeAll(async () => { harnessSlug = await seedFakeLlmHarness(); });
  test('architect:chat emits scripted deltas + result event', async ({ request }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }
    const res = await request.post(`${baseURL}/api/agent-tools/architect/chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'What is the meaning of testing?', harnessSlug },
      timeout: 10_000,
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/\[fake-llm\]/);
    // Three deltas are scripted; the SSE stream should mention each delta + result
    expect(body).toContain('Generating deterministic output');
    expect(body).toContain('Stream terminates');
  });

  test('oracle:chat receives the same scripted deltas', async ({ request }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }
    const res = await request.post(`${baseURL}/api/agent-tools/oracle/chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { messages: [{ role: 'user', content: 'hello oracle' }] },
      timeout: 10_000,
    });
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('[fake-llm]');
  });

  test('fake-LLM does not require any real model credentials', async ({ request }) => {
    if (!(await fakeLlmActive(request))) {
      test.skip(true, 'PAPERCUSP_FAKE_LLM=1 not set on dev server; skipping');
    }
    // Implicit: the route succeeded, no upstream model auth was needed.
    // This is a contract test for the seam — without the env var, this route
    // would 5xx on missing OMP/Claude bearer.
    const res = await request.post(`${baseURL}/api/agent-tools/architect/chat`, {
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      data: { message: 'no creds needed', harnessSlug },
      timeout: 10_000,
    });
    expect(res.ok()).toBeTruthy();
  });
});

test('P010 current-build conformance journey', async ({ page }, info) => {
  test.setTimeout(180_000);
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_ISOLATED_SEED).toBe('ready');
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
  expect(workspace).toMatch(/^verify-tauri-isolated-/);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['localhost', '127.0.0.1']).toContain(database.hostname);
  expect(database.port).not.toBe('5432');
  expect(database.port).not.toBe('');
  const sql = postgres(database.toString(), { max: 1, onnotice: () => {} });
  const conversationId = randomUUID();
  const turnId = randomUUID();
  try {
    const report = await publishReport(sql, {
      workspaceId: workspace, title: 'P010 current authorized report', visibility: 'owner',
      requestKey: `p010-browser-${turnId}`,
      bodyMd: 'Current browser resource. [Safe link](https://example.com/p010)\n\n'
        + '<script>window.__p010Executed=true</script><img src=x onerror="window.__p010Executed=true">\n\n'
        + '[Unsafe link](javascript:window.__p010Executed=true)',
    });
    const foreign = await publishReport(sql, {
      workspaceId: `${workspace}-foreign`, title: 'P010 foreign secret title',
      bodyMd: 'P010 foreign secret body', visibility: 'owner', requestKey: `p010-foreign-${turnId}`,
    });
    const result = (id: string, reportId: string) => ({
      id, kind: 'report', title: 'Untrusted model title', sources: [{ ref: `report:${reportId}` }],
      actions: [{ id: 'open', kind: 'open', label: 'Open report', ref: `report:${reportId}` }],
    });
    await sql.unsafe(`INSERT INTO harness_shared.operator_conversations
      (id,workspace_id,status,started_at,subject_kind) VALUES ($1,$2,'active',$3,'global')`,
    [conversationId, workspace, Date.now() + 10_000]);
    await sql.unsafe(`INSERT INTO harness_shared.operator_turns
      (id,conversation_id,workspace_id,seq,role,text,source,created_at,chat_state)
      VALUES ($1,$2,$3,0,'assistant','P010 browser result reply','text_typed',$4,$5::jsonb)`,
    [turnId, conversationId, workspace, Date.now(), sql.json({ schemaVersion: 1, results: [
      result('p010-browser-report', report.reportId), result('p010-browser-foreign', foreign.reportId),
    ] })]);

    const fixture = await sql.unsafe(`SELECT id,workspace_id,status,subject_kind,subject_ref,
      current_database() AS database,inet_server_port() AS port FROM harness_shared.operator_conversations
      WHERE id=$1`, [conversationId]);
    const current = await page.request.get(`${baseURL}/api/zero-harness/rest-query`, {
      params: { name: 'operatorConversations.current', args: JSON.stringify({ workspaceId: workspace }) },
      headers: { 'x-papercusp-workspace': workspace },
    });
    const currentBody = await current.json();
    await info.attach('p010-browser-fixture-readback', { body: JSON.stringify({ fixture,
      status: current.status(), current: currentBody }), contentType: 'application/json' });
    expect(fixture).toMatchObject([{ id: conversationId, workspace_id: workspace, status: 'active', subject_ref: null }]);
    expect(current.status()).toBe(200);
    expect(currentBody.rows).toMatchObject([{ id: conversationId, workspaceId: workspace }]);

    // Exercise persisted history and the real scoped resolver, without route stubs.
    await page.goto(`${baseURL}/?chat=true`);
    const sidebar = page.getByRole('complementary', { name: 'Papercup chat' });
    const authorized = page.locator('[data-result-id="p010-browser-report"]');
    await expect(authorized).toContainText('P010 current authorized report');
    await expect(page.locator('[data-result-id="p010-browser-foreign"]')).toContainText(/unavailable|not available/i);
    await expect(sidebar).not.toContainText('P010 foreign secret');
    const safeLink = authorized.locator('a[href="https://example.com/p010"]');
    await expect(safeLink).toHaveAttribute('target', '_blank');
    await expect(safeLink).toHaveAttribute('rel', /noopener/);
    await expect(authorized.locator('script,img,[onerror],a[href^="javascript:"],a[href^="data:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __p010Executed?: boolean }).__p010Executed === true)).toBe(false);
    await info.attach('p010-browser-authorized-results', { body: await page.screenshot(), contentType: 'image/png' });

    await page.reload();
    await expect(authorized).toContainText('P010 current authorized report');
    await authorized.locator('[data-action-id="open"]').click();
    await expect(page).toHaveURL(new RegExp(`/reports\\?sel=${report.reportId}`));
    await expect(page.locator('.reports-reader')).toContainText('Current browser resource.');
    await page.goto(`${baseURL}/?chat=true`);
    await expect(authorized).toContainText('P010 current authorized report');
    await sql.unsafe('DELETE FROM harness_shared.report_library WHERE workspace_id=$1 AND report_id=$2',
      [workspace, report.reportId]);
    await authorized.locator('[data-action-id="open"]').click();
    await expect(sidebar).toContainText(/unavailable/i);
    expect(new URL(page.url()).pathname).toBe('/');
    const rows = await sql.unsafe(`SELECT id FROM harness_shared.operator_turns
      WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY seq`, [workspace, conversationId]);
    expect(rows.map(row => row.id)).toEqual([turnId]);
    await info.attach('p010-browser-result-identity', {
      body: JSON.stringify({ conversationId, turnId, reportId: report.reportId, foreignReportId: foreign.reportId }),
      contentType: 'application/json',
    });
    if (process.env.VERIFY_TAURI_SOURCE_RECEIPT) await info.attach('p010-browser-source', {
      body: await readFile(process.env.VERIFY_TAURI_SOURCE_RECEIPT), contentType: 'application/json',
    });
  } finally { await sql.end({ timeout: 5 }); }
});
