/** P024 request fixture. Real operator, database and installed daemons; synthetic vendor transport only. */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, stopPrivateOperatorHost, waitForPrivateOperator } from './private-http-workspace-preflight';
// @ts-ignore -- native ESM fixture keeps the already-built host outside tsx.
import { KEY, CANONICAL, PUBLICATION, spawnBlogPostHttpHost } from './blog-post-http-host.mjs';

const root = resolve(import.meta.dirname, '../../..');
const evidenceDir = process.env.BLOG_POST_EVIDENCE_DIR!;
let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;

async function stopHost() {
  if (!host) return;
  await stopPrivateOperatorHost(host);
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'private operator survived cleanup');
}

function toolData(body: any): any {
  let value = body.result;
  if (value?.data) return value.data;
  if (value?.content) {
    const text = value.content.find((part: any) => part.type === 'text')?.text;
    if (text) value = JSON.parse(text);
  }
  return value?.data ?? value;
}

/** Use the same raw driver and statement in the HTTP fixture and its cheap PG guard. */
export async function configureBlogPostPublication(sql: postgres.Sql, params: {
  workspace: string; sourceId: string; userId: string;
}) {
  const rows = await sql`UPDATE harness_shared.data_sources SET config = config || ${sql.json({ publicationId: PUBLICATION })}::jsonb
    WHERE workspace_id = ${params.workspace} AND id = ${params.sourceId}::uuid AND owner_user_id = ${params.userId}::uuid
    RETURNING config`;
  assert.equal(rows.length, 1, 'owned publication source required');
  assert.equal(rows[0].config.publicationId, PUBLICATION, 'publication configuration was not stored');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  assert.equal(new URL(base).hostname, '127.0.0.1');
  assert.ok(![3070, 3170, 3271].includes(Number(new URL(base).port)));
  assert.ok(e.PAPERCUSP_HOME && evidenceDir);
  assert.ok(dirname(e.HOME!).includes('papercusp-test-runtime-'));
  appendFileSync(join(evidenceDir, 'vendor-requests.jsonl'), '');
  const installedFiles: Record<string, string> = {};
  for (const id of ['devto', 'hashnode']) {
    const source = join(root, 'libs/papercusp/plugins', id);
    const target = join(e.PAPERCUSP_HOME!, 'global-plugins', id);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
    for (const file of ['papercusp.json', 'index.cjs', 'daemon.cjs']) {
      const bytes = readFileSync(join(target, file));
      assert.deepEqual(bytes, readFileSync(join(source, file)));
      installedFiles[`${id}/${file}`] = createHash('sha256').update(bytes).digest('hex');
    }
  }
  console.log('BLOG_POST_PHASE packages-prepared');
  const { path: bundle } = await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
  const bundleBytes = readFileSync(bundle);
  for (const module of ['agent-tools/blog/post.ts', 'capability-verbs/blog.ts', 'provider-credentials.ts', 'host-fetch.ts'])
    assert.ok(bundleBytes.includes(Buffer.from(module)), `${module} absent from executed bundle`);
  const hostEnv = { ...privateBundleRuntimeEnv(e), PAPERCUSP_FLAG_PAPERCUSP_SOCIAL_AUTO_PUBLISH: '0' };
  host = spawnBlogPostHttpHost(bundle, { cwd: root, env: hostEnv }) as ChildProcess;
  host.stdout!.on('data', chunk => process.stdout.write(chunk));
  host.stderr!.on('data', chunk => process.stderr.write(chunk));
  hostIdentity = readProcessIdentity(host.pid!);
  assert.ok(hostIdentity);
  const headers = { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, hostIdentity, environment: hostEnv });
  const requests: Array<{ path: string; status: number }> = [];
  async function call(method: string, path: string, body?: unknown) {
    const response = await fetch(base + path, { method, headers, signal: AbortSignal.timeout(75_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.ok(!text.includes(KEY), 'HTTP response leaked the stored credential');
    requests.push({ path, status: response.status });
    return { status: response.status, body: JSON.parse(text) };
  }
  const overview = async () => {
    const r = await call('GET', '/api/user/integrations/tickets');
    assert.equal(r.status, 200); return r.body;
  };
  const before = await overview();
  for (const id of ['devto', 'hashnode']) {
    assert.ok(before.providers.some((p: any) => p.id === id), `${id} package not discovered`);
    const saved = await call('PUT', `/api/user/integrations/providers/${id}/credentials`, { values: { api_key: KEY } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const readback = await call('GET', `/api/user/integrations/providers/${id}/credentials`);
    assert.equal(readback.status, 200);
    assert.ok(readback.body.credentials.every((c: any) => c.configured));
  }
  const after = await overview();
  const sources = Object.fromEntries(['devto', 'hashnode'].map(id => {
    const rows = after.sources.filter((s: any) => s.provider === id);
    assert.equal(rows.length, 1); return [id, rows[0].id as string];
  }));
  const adminUrl = e.HARNESS_ADMIN_DATABASE_URL!;
  assert.equal(new URL(adminUrl).port, e.PAPERCUSP_PG_PORT);
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const vendorRows = () => existsSync(join(evidenceDir, 'vendor-requests.jsonl'))
    ? readFileSync(join(evidenceDir, 'vendor-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  try {
    const [user] = await sql`SELECT id::text FROM harness_shared.users WHERE username = 'default'`;
    assert.ok(user?.id);
    // Disposable identity/config preparation; credentials were saved only via Settings routes.
    await configureBlogPostPublication(sql, { workspace, sourceId: sources.hashnode, userId: user.id });
    const [grant] = await sql`INSERT INTO harness_shared.personal_grants
      (workspace_id, user_id, principal_type, principal_id, scopes, granted_by)
      VALUES (${workspace}, ${user.id}::uuid, 'agent-role', 'operator', ${['personal:devto', 'personal:hashnode']}, 'private-request-fixture') RETURNING id`;
    const invoke = (id: string, extra: Record<string, unknown> = {}) => call('POST', '/api/agent-mcp/run-tool', {
      name: 'blog:post', confirmed: true, args: { providerId: id, sourceId: sources[id], title: 'Request proof',
        markdown: '# Synthetic content', canonicalUrl: CANONICAL, addressee: { from: 'owner-instruction' }, ...extra } });
    console.log('BLOG_POST_PHASE request-ready');
    for (const id of ['devto', 'hashnode']) {
      const draft = await invoke(id);
      assert.equal(draft.status, 200, JSON.stringify(draft.body));
      const data = toolData(draft.body);
      assert.equal(data.status, 'drafted', JSON.stringify(draft.body));
      assert.equal(data.result.published, false); assert.equal(data.result.canonicalUrl, CANONICAL);
      const withheld = await invoke(id, { published: true });
      assert.equal(withheld.status, 200, JSON.stringify(withheld.body));
      assert.equal(toolData(withheld.body).status, 'withheld');
      assert.equal(toolData(withheld.body).withheld.reason, 'publish-flag-off');
      for (const extra of [{ sourceId: randomUUID() }, { canonicalUrl: 'https://elsewhere.invalid/post' }]) {
        const refused = await invoke(id, extra);
        assert.ok(refused.status >= 400 || refused.body.result?.isError, 'invalid outbound request accepted');
      }
    }
    const sent = vendorRows();
    assert.deepEqual(sent.map((r: any) => r.provider).sort(), ['devto', 'hashnode']);
    await sql`UPDATE harness_shared.personal_grants SET revoked_at = now() WHERE id = ${grant.id}::uuid`;
    const denied = await invoke('devto');
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.deepEqual(toolData(denied.body), { allowed: false, refusal: 'no_live_grant' });
    assert.deepEqual(vendorRows(), sent, 'a refused or withheld request reached the vendor transport');
    const rows = await sql`SELECT id::text, kind, status FROM harness_shared.data_sources
      WHERE workspace_id = ${workspace} AND owner_user_id = ${user.id}::uuid AND kind IN ('devto', 'hashnode') ORDER BY kind`;
    assert.deepEqual(rows.map(row => row.id).sort(), Object.values(sources).sort());
    await stopHost();
    console.log('BLOG_POST_RECEIPT ' + JSON.stringify({ workspace, hostStopped: true, health,
      bundleSha256: createHash('sha256').update(bundleBytes).digest('hex'), installedFiles, requests,
      sources: rows, vendorTransport: 'synthetic', vendorRequests: sent, drafts: 2, withheld: 2, refused: 5 }));
  } finally { await sql.end({ timeout: 5 }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(evidenceDir, 'retained evidence directory required');
    await main();
  } catch (error) {
    console.error('BLOG_POST_FAILURE ' + (error instanceof Error ? error.stack : String(error)));
    process.exitCode = 1;
  } finally { await stopHost(); }
}
