/** Real CLI request journey in with-test-pg's private operator and database; typechecked with operator-core. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { nativeCliPlan, nativeCliResult } from '../native-cli.fixture.ts';

// The plain-Node bootstrap supplies this callback from outside tsx's namespace.
// The maintained handler is already compiled; routing it through tsx again
// parses and rewrites the host artifact's dynamic imports and can exhaust the
// private fixture deadline.
export async function runNativeIncidentApi(argv: readonly string[],
  importHandler: (url: string) => Promise<{ handler: Parameters<typeof createAdaptorServer>[0]['fetch'] }>) {
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
assert(workspace?.startsWith('test-runtime-'), 'Private runtime required');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
// Executable assets are shared inputs; HOME, workspace, credentials and data
// remain private. Pin their canonical installations before the host imports.
const vendor = join(homedir(), '.papercusp/vendor');
await mkdir(vendor, { recursive: true });
for (const [name, selected] of [['repomix', argv[0]], ['lsp', argv[1]]] as const) {
  assert(selected, `Missing maintained ${name} installation`);
  await symlink(await realpath(selected), join(vendor, name), 'dir');
}
const version = spawnSync(join(vendor, 'repomix/node_modules/.bin/repomix'), ['--version'], { encoding: 'utf8', timeout: 10_000 });
assert.equal(version.status, 0, version.stderr); assert.match(version.stdout, /\b1\.18\.0\b/);
console.log('NATIVE_INCIDENT_API_STAGE=pinned-assets-ready');
console.log('NATIVE_INCIDENT_API_STAGE=import-start:first-party-callers-offthread');
const { firstPartyCallersOffthread } = await import('../first-party-callers-offthread.ts');
console.log('NATIVE_INCIDENT_API_STAGE=import-ready:first-party-callers-offthread');
console.log('NATIVE_INCIDENT_API_STAGE=import-start:lsp-adapter');
const { LSP_VENDOR_DIR } = await import('../lsp-adapter.ts');
console.log('NATIVE_INCIDENT_API_STAGE=import-ready:lsp-adapter');
const handlerPath = argv[2], handlerHash = argv[3];
assert(handlerPath && handlerHash, 'Maintained private ESM handler artifact required');
assert.equal(createHash('sha256').update(readFileSync(handlerPath)).digest('hex'), handlerHash,
  'Prepared handler artifact changed before the private runtime loaded it');
console.log('NATIVE_INCIDENT_API_STAGE=import-start:handler-artifact');
const { handler } = await importHandler(pathToFileURL(handlerPath).href);
console.log('NATIVE_INCIDENT_API_STAGE=handler-loaded');
console.log('NATIVE_INCIDENT_API_STAGE=import-start:fixture-stores');
const { superuserTokenPath } = await import('../../superuser-token.ts');
const { loadHarnessRegistry } = await import('../../harness-registry.ts');
const { persistHarnessTestRunsWithIds } = await import('../../testing-run-store.ts');
const { getOrgPg } = await import('@papercusp/db-org');
const { setAutoPumpEnabledForTests } = await import('../../events/await/engine.ts');
console.log('NATIVE_INCIDENT_API_STAGE=import-ready:fixture-stores');
setAutoPumpEnabledForTests(false);
await writeFile(superuserTokenPath(), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const server = createAdaptorServer({ fetch: handler });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert(address && typeof address !== 'string');
const endpoint = new URL(`http://127.0.0.1:${address.port}/api/mcp`);
for (const [key, value] of Object.entries({ workspace, harness: workspace, client: 'native-incident-private-owner' })) {
  endpoint.searchParams.set(key, value);
}
const repo = resolve(import.meta.dirname, '../../../../..');
async function call(name: string, args: Record<string, unknown>) {
  const startedAt = performance.now();
  console.log(`NATIVE_INCIDENT_API_STAGE=cli-start:${name}`);
  const plan = nativeCliPlan(endpoint.toString(), name, args, { ...process.env,
    PAPERCUSP_SID: 'native-incident-private-owner', PAPERCUSP_WORKSPACE: workspace, PAPERCUSP_HARNESS_SLUG: workspace });
  // The host runs in this process: an asynchronous CLI leaves its HTTP loop live.
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [join(repo, 'apps/operator/scripts/ptool.mjs'),
      name, `--url=${plan.cliUrl}`, '--json', '-'], { cwd: repo, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => {
      const text = String(data);
      stderr = (stderr + text).slice(-16_000);
      // Connection/list/request phase clocks must reach the outer fixture before
      // a deadline kills the client. No request arguments are logged here.
      writeSync(2, text);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), plan.timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); done({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(args));
  });
  writeSync(2, `NATIVE_CLI_PROGRESS=${JSON.stringify({ name, state: 'settled',
    elapsedMs: Math.round(performance.now() - startedAt), status: result.status })}\n`);
  const decoded = nativeCliResult(result) as Record<string, any>;
  console.log(`NATIVE_INCIDENT_API_STAGE=cli-finished:${name}`);
  return decoded;
}
try {
  const identity = await call('coord:whoami', {}); assert.equal(identity.workspaceId, workspace);
  const root = (await loadHarnessRegistry(workspace)).projects.find(p => p.slug === workspace)?.path;
  assert(root, 'Maintained private home harness must resolve');
  await writeFile(join(root, 'a-target.ts'), 'export function incidentTarget() { return 1; }\n');
  await writeFile(join(root, 'b-consumer.ts'), 'import { incidentTarget } from "./a-target.ts";\nexport function consumer() { return incidentTarget(); }\n');
  const testPath = 'target.test.ts';
  const assertion = (expected: number) => 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { incidentTarget } from "./a-target.ts";\ntest("native incident assertion", () => assert.equal(incidentTarget(), ' + expected + '));\n';
  const run = async (expected: number) => {
    await writeFile(join(root, testPath), assertion(expected));
    const startedAt = new Date();
    const result = spawnSync(process.execPath, ['--test', testPath], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.error, undefined); assert.equal(result.status, expected === 1 ? 0 : 1);
    const output = result.stdout + result.stderr;
    assert.match(output, /native incident assertion/);
    const failed = result.status !== 0;
    const receipt = await persistHarnessTestRunsWithIds({ workspaceId: workspace, harnessSlug: workspace,
      root, source: 'local', runGroupId: randomUUID(), worktreeDirty: true, rows: [{ filePath: testPath,
        framework: 'node', status: failed ? 'fail' : 'pass', startedAt, finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(), outputTail: output,
        execution: { passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, collectionFailed: false,
          failedCaseTitles: failed ? ['native incident assertion'] : [], passedCaseTitles: failed ? [] : ['native incident assertion'] } }] });
    assert.equal(receipt.written, 1); assert.equal(receipt.ids.length, 1);
    return { id: receipt.ids[0], hash: createHash('sha256').update(output).digest('hex') };
  };
  const failure = await run(2);
  const compiler = await firstPartyCallersOffthread({ root, name: 'incidentTarget', filePath: 'a-target.ts',
    paths: ['a-target.ts', 'b-consumer.ts', testPath], op: 'callers', limit: 8, vendorDir: LSP_VENDOR_DIR }, { budgetMs: 6_000 });
  assert.equal(compiler.error, null, JSON.stringify(compiler));
  assert(compiler.sites.some(row => row.path === 'b-consumer.ts'), JSON.stringify(compiler));
  console.log('NATIVE_INCIDENT_API_STAGE=compiler-relationship-ready');
  const created = await call('work_items:create', { kind: 'feature', title: 'Private native incident request fixture',
    harness: workspace, assign_to: 'self', state: 'wip', payload: { paths: ['a-target.ts', 'b-consumer.ts', testPath] },
    projection: { pick: ['results[].id', 'results[].ok', 'results[].item.id'] } });
  const id = created.results?.[0]?.id ?? created.results?.[0]?.item?.id;
  assert(id, JSON.stringify(created));
  const claimed = await call('work_items:claim', { row: `${id},self,${workspace}`,
    projection: { pick: ['results[].taskBrief'] } });
  const brief = claimed.results?.[0]?.taskBrief;
  assert.equal(brief?.status, 'current', JSON.stringify(claimed));
  assert.equal(brief.incident.status, 'measured');
  assert.equal(brief.incident.cause, 'unknown'); assert.equal(brief.incident.runtimeExecution, 'unmeasured');
  assert.deepEqual(brief.incident.failures.map((row: any) => [row.testRunId, row.path, row.logSha256]),
    [[failure.id, testPath, failure.hash]]);
  assert(brief.incident.candidates.some((row: any) => row.path === 'b-consumer.ts' &&
    row.basis === 'static-relationship' && row.causation === 'unverified'), JSON.stringify(brief));
  const resumed = await call('work_items:get', { id, harness: workspace, resume: true,
    projection: { pick: ['results[].resume.taskBrief'] } });
  assert.deepEqual(resumed.results[0].resume.taskBrief.incident.failures, brief.incident.failures);
  assert.equal(resumed.results[0].resume.taskBrief.sourceFingerprint, brief.sourceFingerprint);
  await run(1);
  const repaired = await call('work_items:get', { id, harness: workspace, resume: true,
    projection: { pick: ['results[].resume.taskBrief'] } });
  assert.equal(repaired.results[0].resume.taskBrief.status, 'current');
  assert.deepEqual(repaired.results[0].resume.taskBrief.incident.failures, []);
  assert.deepEqual(repaired.results[0].resume.taskBrief.incident.candidates, []);
  console.log('NATIVE_INCIDENT_API_PROOF=' + JSON.stringify({ workspace, transport: 'real-cli-http',
    failure: 'actual-node-assertion', staticCandidate: true, cause: 'unknown', runtimeExecution: 'unmeasured',
    resume: 'current', repaired: true }));
} finally {
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await getOrgPg().sql.end({ timeout: 2 });
}
process.exit(0);
}
