/** Executed only by the canonical MCP e2e suite in the maintained private profile. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertManagedToolSuccess, finishManagedApiTeardown } from './managed-api-result.ts';
import { privateBundleRuntimeEnv, resolvePreparedPrivateApiBundle, stopPrivateOperatorHost,
  waitForPrivateOperator } from '../../../../test/private-http-workspace-preflight.ts';
import { readProcessIdentity } from '../../../process-identity.ts';

const stage = (name: string) => console.log('MANAGED_API_STAGE=' + name);
// This command needs no database/host boot. The canonical test uses it to
// measure the OS prerequisite with the same private session-bus boundary.
if (process.argv.includes('--scope-preflight')) {
  const { probeScopeSupport } = await import('../../../task-manager/managed-spawn.ts');
  console.log('MANAGED_SCOPE_PROOF=' + JSON.stringify(await probeScopeSupport()));
  process.exit(0);
}
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
assert(workspace?.startsWith('test-runtime-'), 'Disposable runtime identity required');
assert.equal(process.env.PAPERCUSP_POT_HOME_SLUG, workspace);
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert(process.env.PAPERCUSP_EMBED_SIDECAR_URL, 'Maintained operator-api preflight required');
const { superuserTokenPath } = await import('../../../superuser-token.ts');
const { getOrgPg } = await import('@papercusp/db-org');
const token = randomBytes(32).toString('hex');
await writeFile(superuserTokenPath(), token, { mode: 0o600, flag: 'wx' });
const evidenceDir = process.env.STAGING_FIRST_HTTP_EVIDENCE_DIR!;
assert(evidenceDir, 'Retained execution evidence directory required');
const bundle = resolvePreparedPrivateApiBundle(process.argv.slice(2), evidenceDir);
assert(bundle, 'Pinned prepared operator bundle required before host allocation');
const base = process.env.PAPERCUSP_OPERATOR_URL!;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const hostEnv = privateBundleRuntimeEnv(process.env);
const host = spawn(process.execPath, [bundle], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
host.stdout.on('data', data => process.stdout.write(data));
host.stderr.on('data', data => process.stderr.write(data));
const hostIdentity = readProcessIdentity(host.pid!);
try { await waitForPrivateOperator({ host, base, evidenceDir, environment: hostEnv, hostIdentity }); }
catch (error) { await stopPrivateOperatorHost(host); throw error; }
stage('host-ready');
const clients: Client[] = [];
const owner = 'managed-private-parity-owner';
const verifiedOwners = new Map<string, string>();
async function client(owner: string) {
  stage('client-connect:' + owner);
  const url = new URL(base + '/api/mcp');
  for (const [key, value] of Object.entries({ superuser: '1', workspace, harness: workspace,
    client: owner, format: 'json', structured: '1' })) url.searchParams.set(key, value);
  const current = new Client({ name: 'managed-parity-private-client', version: '1' });
  clients.push(current);
  await current.connect(new StreamableHTTPClientTransport(url, { requestInit: {
    headers: { Authorization: `Bearer ${token}` },
  } }));
  await current.listTools(); // Establish the current catalog contract on each fresh transport.
  const identity = (await invoke(current, 'coord:whoami', {})).body;
  assert.equal(identity.workspaceId, workspace);
  assert(identity.ownerId, 'Resolved owner required for ledger cleanup');
  const previous = verifiedOwners.get(owner);
  if (previous) assert.equal(identity.ownerId, previous, 'Fresh transports must retain owner identity');
  verifiedOwners.set(owner, identity.ownerId);
  return current;
}
async function invoke(current: Client, name: string, args: Record<string, unknown>, expectSuccess = true) {
  stage('invoke:' + name);
  // tools:invoke deliberately raises NestedToolRefusalError and the host renders
  // that exception as prefixed text. Direct negative calls preserve the typed
  // refusal contract that this acceptance case must inspect.
  let result: any = await current.callTool(expectSuccess
    ? { name: 'tools:invoke', arguments: { name, args } }
    : { name, arguments: args }, undefined,
    { timeout: 45_000 });
  let text = result.content?.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'))?.text;
  let body = text ? JSON.parse(text) : null;
  if (body?.schemaVersion === 'papercusp.output-envelope/v1') {
    const reference = body.content.find((part: any) => part.uri?.startsWith('papercusp://scratch/'));
    assert(reference, 'Result envelope must carry an owned recovery reference');
    stage('hydrate:' + name);
    const chunks: Buffer[] = []; let cursor: Record<string, unknown> | null = { uri: reference.uri, byte_offset: 0, byte_limit: 2048 };
    let offset = 0;
    for (let pages = 0; cursor && pages < 64; pages++) {
      // The direct read door propagates its recovery-page accounting mode.
      // A tools:invoke wrapper is a different outer tool and spends the cohort.
      const read: any = await current.callTool({ name: 'capability:read', arguments: cursor });
      const page = JSON.parse(read.content.find((part: any) => part.type === 'text').text);
      assert.equal(page.ok, true, JSON.stringify(page)); assert.equal(page.encoding, 'base64');
      const bytes = Buffer.from(page.data, 'base64');
      assert.equal(bytes.toString('base64'), page.data); assert.equal(bytes.length, page.byte_length);
      assert.equal(page.byte_offset, offset); chunks.push(bytes); offset += bytes.length;
      cursor = page.next_cursor?.args ?? null;
      if (!cursor) { assert.equal(page.eof, true); assert.equal(offset, page.total_bytes); }
    }
    assert.equal(cursor, null, 'Reference paging must reach EOF within its bound');
    const bytes = Buffer.concat(chunks);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
    result = JSON.parse(bytes.toString('utf8'));
    text = result.content.find((part: any) => part.type === 'text' && part.text.trim().startsWith('{'))?.text;
    body = text ? JSON.parse(text) : null;
  }
  if (expectSuccess) assertManagedToolSuccess(name, result, body);
  stage('settled:' + name);
  return { result, body };
}
const pageServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><head><title>HTTP managed browser</title></head><body><script>sessionStorage.n=String(Number(sessionStorage.n||0)+1);document.body.textContent="page:"+sessionStorage.n;</script></body></html>');
});
await new Promise<void>(resolve => pageServer.listen(0, '127.0.0.1', resolve));
const pageAddress = pageServer.address(); assert(pageAddress && typeof pageAddress !== 'string');
const pageUrl = `http://127.0.0.1:${pageAddress.port}/`;
let kernelId: string | undefined; let browserId: string | undefined; let ptyId: string | undefined;
let current: Client | undefined; let proof: Record<string, unknown> | undefined;
const fileRoot = join(process.env.HOME!, 'managed-files');
try {
  current = await client(owner);
  // A private valid repository exercises the real per-path lock store, rather
  // than the intentional uncoordinated path for ordinary temporary files.
  await mkdir(join(fileRoot, '.git'), { recursive: true });
  await writeFile(join(fileRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const a = join(fileRoot, 'a.txt'); const b = join(fileRoot, 'b.txt');
  await writeFile(a, 'one\n'); await writeFile(b, 'two\n');
  const raster = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64');
  const imagePath = join(fileRoot, 'image.png'); await writeFile(imagePath, raster);
  const imageRead = await invoke(current, 'capability:read', { file_path: imagePath });
  assert(imageRead.result.content.some((part: any) => part.type === 'image' &&
    part.mimeType === 'image/png' && Buffer.from(part.data, 'base64').equals(raster)), 'Original raster must cross production MCP');
  const edits = [
    { file_path: a, old_string: 'one', new_string: 'ONE' },
    { file_path: b, old_string: 'two', new_string: 'TWO' },
  ];
  const filePeer = await client('managed-private-file-peer');
  const hold = (await invoke(filePeer, 'locks:acquire', { paths: ['a.txt'], intent: 'MC-P026-PATCH peer conflict', wait: { max_sec: 0 } })).body;
  assert.equal(hold.ok, true, JSON.stringify(hold)); assert(hold.lock_id);
  try {
    const blocked = await invoke(current, 'capability:patch', { edits }, false);
    assert.equal(blocked.body?.reason, 'file_locked', JSON.stringify(blocked));
    assert.equal(await readFile(a, 'utf8'), 'one\n'); assert.equal(await readFile(b, 'utf8'), 'two\n');
  } finally {
    await invoke(filePeer, 'locks:release', { lock_id: hold.lock_id });
  }
  const rejected = await invoke(current, 'capability:patch', { edits: [edits[0], { ...edits[1], old_string: 'absent' }] }, false);
  assert.equal(rejected.body?.reason, 'hunk_not_found', JSON.stringify(rejected));
  assert.equal(await readFile(a, 'utf8'), 'one\n'); assert.equal(await readFile(b, 'utf8'), 'two\n');
  const patched = (await invoke(current, 'capability:patch', { edits })).body;
  assert.equal(patched.filesWritten, 2, JSON.stringify(patched));
  assert.equal(await readFile(a, 'utf8'), 'ONE\n'); assert.equal(await readFile(b, 'utf8'), 'TWO\n');
  const { probeScopeSupport } = await import('../../../task-manager/managed-spawn.ts');
  const scope = await probeScopeSupport();
  stage('scope-preflight:' + JSON.stringify(scope));
  assert.equal(scope.ok, false, 'Private operator-api profile must not inherit the desktop session bus');
  const refusedPty = await invoke(current, 'capability:pty_open', {
    command: 'cat', cwd: process.env.HOME, cols: 80, rows: 24,
  }, false);
  console.log('MANAGED_PTY_REFUSAL=' + JSON.stringify(refusedPty));
  assert.equal(refusedPty.result.isError, true, JSON.stringify(refusedPty.result));
  assert.equal(refusedPty.body?.reason, 'pty_confinement_unavailable', JSON.stringify(refusedPty.result));
  assert.equal(refusedPty.body?.unconfined_reason, 'no-scope-support', JSON.stringify(refusedPty.result));
  const opened = (await invoke(current, 'code:run', { kernel: { op: 'open' } })).body;
  assert.equal(opened.ok, true, JSON.stringify(opened)); kernelId = opened.kernel.id;
  const firstCell = (await invoke(current, 'code:run', { kernel: { op: 'run', id: kernelId }, script: 'globalThis.count = 2; return ++count;' })).body;
  assert.equal(firstCell.ok, true, JSON.stringify(firstCell));
  assert.equal(firstCell.summary, 3, JSON.stringify(firstCell));
  const browser = (await invoke(current, 'capability:fetch', { url: pageUrl, browser: { op: 'open', screenshot: true } }));
  assert.equal(browser.body.ok, true, JSON.stringify(browser.body)); browserId = browser.body.browser.id;
  assert.equal(browser.body.observation.text, 'page:1');
  assert(browser.result.content.some((part: any) => part.type === 'image' && part.mimeType === 'image/png'));
  // A separate MCP session must retain handles by authenticated owner/workspace/harness.
  current = await client(owner);
  const retained = (await invoke(current, 'code:run', { kernel: { op: 'run', id: kernelId }, script: 'return ++count;' })).body;
  console.log('MANAGED_KERNEL_CONTINUITY=' + JSON.stringify(retained));
  assert.equal(retained.ok, true, JSON.stringify(retained));
  assert.equal(retained.summary, 4, JSON.stringify(retained));
  assert.equal(retained.kernel.state, 'live', JSON.stringify(retained));
  const observed = (await invoke(current, 'capability:fetch', { browser: { op: 'observe', id: browserId } })).body;
  assert.equal(observed.ok, true, JSON.stringify(observed)); assert.equal(observed.observation.text, 'page:1');
  const navigated = (await invoke(current, 'capability:fetch', { url: pageUrl, browser: { op: 'navigate', id: browserId } })).body;
  assert.equal(navigated.ok, true, JSON.stringify(navigated)); assert.equal(navigated.observation.text, 'page:2');
  const foreign = await client('managed-private-parity-foreign');
  for (const [name, args] of [
    ['code:run', { kernel: { op: 'status', id: kernelId } }],
    ['capability:fetch', { browser: { op: 'close', id: browserId } }],
  ] as const) {
    const { body } = await invoke(foreign, name, args, false);
    assert.equal(body?.ok, false, `Foreign handle accepted by ${name}`);
  }
  // Deliberately discard the browser handle: teardown must recover it from the
  // real private ledger, as it must when an opened handle's reply is lost.
  browserId = undefined;
  assert.equal((await invoke(current, 'code:run', { kernel: { op: 'close', id: kernelId } })).body.kernel.state, 'closed'); kernelId = undefined;
  proof = { transport: 'http', workspace,
    kernel: 'retained-across-clients', browser: 'retained-across-clients', pty: 'refused-without-private-session-bus',
    image: 'original-raster', patch: 'canonical-peer-lock-and-all-hunks',
    foreignHandles: 'refused' };
} catch (error) {
  console.error('MANAGED_API_FAILURE=' + (error instanceof Error ? error.stack : String(error)));
  throw error;
} finally {
  if (current) {
    if (browserId) await invoke(current, 'capability:fetch', { browser: { op: 'close', id: browserId } }).catch(() => {});
    if (kernelId) await invoke(current, 'code:run', { kernel: { op: 'close', id: kernelId } }).catch(() => {});
    if (ptyId) await invoke(current, 'capability:pty_kill', { task_id: ptyId }).catch(() => {});
  }
  // A lost reply can hide a successfully opened handle. Drain the exact private
  // owner's ledger rows before PostgreSQL goes away, rather than losing receipts.
  const { getTask } = await import('../../../task-manager/store.ts');
  const { readProcessIdentity } = await import('../../../process-identity.ts');
  const { taskTerminalEventKey } = await import('../../../task-manager/task-terminal-events.ts');
  const rows = await getOrgPg().sql`SELECT task_id FROM harness_shared.task_ledger
    WHERE workspace_id = ${workspace} AND class IN ('browser', 'pty')`;
  const cleanupErrors: unknown[] = [];
  for (const entry of rows) {
    try {
      const row = await getTask(entry.task_id); assert(row);
      assert.equal(row.workspaceId, workspace);
      assert.equal(row.launchedBy, verifiedOwners.get(owner), 'Never clean a foreign owner row');
      assert(current, 'Opened handles require an authenticated cleanup client');
      if (row.class === 'browser') {
        assert.equal(typeof row.detail?.browserSessionId, 'string');
        const closed = await invoke(current, 'capability:fetch', { browser: { op: 'close', id: row.detail!.browserSessionId } });
        assert(['closed', 'lost'].includes(closed.body.browser.state));
        assert.equal(existsSync(row.cwd!), false, 'Browser root must be gone before PG shutdown');
        const [fire] = await getOrgPg().sql`SELECT fire_count FROM harness_shared.event_key_fires
          WHERE event_key = ${taskTerminalEventKey(row.taskId)}`;
        assert.equal(Number(fire?.fire_count), 1, 'Terminal recording must finish before PG shutdown');
      } else if (row.pid && readProcessIdentity(row.pid) === row.processIdentity) {
        await invoke(current, 'capability:pty_kill', { task_id: row.taskId });
      }
      if (row.pid) assert.notEqual(readProcessIdentity(row.pid), row.processIdentity, 'Owned process still live');
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await finishManagedApiTeardown({ hasProof: !!proof, rowCount: rows.length, cleanupErrors, close: [
    async () => { await rm(fileRoot, { recursive: true, force: true }); },
    ...clients.map(entry => async () => { await entry.close(); }),
    async () => { await stopPrivateOperatorHost(host);
      assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'Private host survived cleanup'); },
    async () => { await new Promise<void>(resolve => pageServer.close(() => resolve())); },
    async () => { await getOrgPg().sql.end({ timeout: 2 }); },
  ] });
  console.log('MANAGED_API_CLEANUP=' + JSON.stringify({ workspace, rows: rows.length,
    ownedIdentity: verifiedOwners.get(owner), processes: 'gone', browserRoots: 'gone', terminalRecorded: true }));
}
if (proof) console.log('MANAGED_API_PROOF=' + JSON.stringify(proof));
process.exit(0);
