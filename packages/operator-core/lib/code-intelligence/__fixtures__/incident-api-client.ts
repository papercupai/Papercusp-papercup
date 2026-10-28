/** Real CLI request journey in with-test-pg's private operator and database; typechecked with operator-core. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleRepoRoot } from '../../module-repo-root.ts';
import { createAdaptorServer } from '@hono/node-server';
import { nativeCliPlan, nativeCliResult } from '../native-cli.fixture.ts';
import { createTextCollector } from '../../child-output.js';

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
const repo = moduleRepoRoot(import.meta.url);
async function call(name: string, args: Record<string, unknown>) {
  const startedAt = performance.now();
  console.log(`NATIVE_INCIDENT_API_STAGE=cli-start:${name}`);
  const plan = nativeCliPlan(endpoint.toString(), name, args, { ...process.env,
    PAPERCUSP_SID: 'native-incident-private-owner', PAPERCUSP_WORKSPACE: workspace, PAPERCUSP_HARNESS_SLUG: workspace });
  // The host runs in this process: an asynchronous CLI leaves its HTTP loop live.
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [join(repo, 'apps/operator/scripts/ptool.mjs'),
      name, `--url=${plan.cliUrl}`, '--json', '-'], { cwd: repo, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = createTextCollector(child.stdout);
    const stderr = createTextCollector(child.stderr, {
      maxChars: 16_000,
      onDecodedText: (text) => {
        // Connection/list/request phase clocks must reach the outer fixture before
        // a deadline kills the client. No request arguments are logged here.
        writeSync(2, text);
      },
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), plan.timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => {
      clearTimeout(timer);
      done({ status, stdout: stdout.text(), stderr: stderr.text() });
    });
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
  if (argv[4] === 'reuse' || argv[4] === 'reuse-claim') {
    const { runNativeReuseJourney } = await import('./reuse-api-journey.ts');
    await runNativeReuseJourney({ call, workspace, root, owner: identity.ownerId, repo, handlerHash,
      claimOnly: argv[4] === 'reuse-claim' });
  } else if (argv[4] === 'first-touch' || argv[4] === 'grep') {
    await runNativeSnapshotJourney({ call, workspace, root, owner: identity.ownerId, repo, endpoint, leg: argv[4] });
  } else if (argv[4] === 'task-brief') {
    await runNativeTaskBriefJourney({ call, workspace, root, owner: identity.ownerId });
  } else {
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
  let failure = await run(2);
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
  // P-038: exercise the installed native dispatcher and its real operator/PG
  // delivery, with fixture measurements rather than invented production history.
  const beforeTarget = readFileSync(join(root, 'a-target.ts'), 'utf8');
  const { recordEditAttributionStrict } = await import('../../edit-attribution.ts');
  await recordEditAttributionStrict({ repoRoot: root, files: ['a-target.ts'],
    agentId: 'native-incident-private-owner', workspaceId: workspace, goalRef: id,
    intent: 'Private fixture changes incidentTarget', dispatchCallId: randomUUID() });
  await writeFile(join(root, 'a-target.ts'), 'export function incidentTarget() { return 3; }\n');
  const afterTarget = readFileSync(join(root, 'a-target.ts'), 'utf8');
  assert.notEqual(afterTarget, beforeTarget);
  const { collectInterfaceEdits } = await import(pathToFileURL(join(repo, 'apps/operator/scripts/hooks/inject/core.mjs')).href);
  const { consequenceFor } = await import(pathToFileURL(join(repo, 'apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs')).href);
  const required = await import(pathToFileURL(join(repo, 'scripts/check-required-field-strands.mjs')).href);
  const behavioural = await import(pathToFileURL(join(repo, 'scripts/check-behavioural-strands.mjs')).href);
  const observationScope = { owner: 'native-incident-private-owner', workspace, harness: workspace,
    client: 'codex', cwd: root };
  // The private harness has no source-history repository. Supply its controlled
  // before image at the filesystem/history seam; use the maintained AST diff,
  // hook collector and persistent ledger to derive every symbol observation.
  await collectInterfaceEdits({ ...observationScope, toolCalls: [{ editedPaths: ['a-target.ts'] }] },
    (path: string) => consequenceFor(path, { includeSourceChanges: true,
      exists: (candidate: string) => candidate === join(root, 'scripts/check-required-field-strands.mjs'),
      loadRequired: async () => required,
      loadBehavioural: async () => ({ ...behavioural, submodulePaths: () => [],
        repoForPath: (relPath: string) => ({ cwd: root, relPath }) }),
      resolveBase: () => 'a'.repeat(40), showAt: () => beforeTarget,
    }));
  failure = await run(2);
  const attributed = await call('work_items:get', { id, harness: workspace,
    projection: { pick: ['results[].workItem.id', 'results[].workItem.state'] } });
  const workItem = attributed.results?.[0]?.workItem;
  assert.equal(workItem?.id, id); assert.equal(typeof workItem.state, 'string');
  const sha = (path: string) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  const snapshotPath = join(homedir(), '.papercusp/graph-snapshot/papercusp/dependency-snapshot.json');
  await mkdir(resolve(snapshotPath, '..'), { recursive: true });
  const snapshot = JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt: new Date().toISOString(),
    // This is the explicit fixture snapshot identity, never a production commit.
    index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
    edges: [{ imported: 'a-target.ts', importer: testPath, importerSha256: sha(testPath) }],
    symbols: { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound', symbols: [{
      id: 'private-incident-target', name: 'incidentTarget', path: 'a-target.ts', line: 1, column: 17,
      sha256: sha('a-target.ts'), signature: 'incidentTarget()', aliases: [], callers: [],
    }] } });
  await writeFile(snapshotPath, snapshot);
  const replay: typeof observationScope & { toolCalls: unknown[];
    incidentAttribution?: import('../push-channel.ts').IncidentAttribution } = { ...observationScope,
    toolCalls: [{ tool: 'mcp__papercusp_su__testing_run', toolInput: { harness: workspace, files: [testPath] },
      toolResponse: { byFile: { [testPath]: { status: 'fail', failed: 1, runId: failure.id } } } }] };
  // A fresh collection loads the earlier observation from the delivery ledger;
  // the failing-test request itself supplies no changed symbols or work items.
  await collectInterfaceEdits(replay);
  assert(replay.incidentAttribution, 'Shared collector must recover the earlier source observation');
  assert.equal(replay.incidentAttribution?.status, 'measured');
  assert.deepEqual(replay.incidentAttribution.recentEdits?.[0]?.symbols, [{ name: 'incidentTarget', line: 1 }]);
  assert.equal(replay.incidentAttribution.recentEdits?.[0]?.sha256, sha('a-target.ts'));
  const dispatcher = await installedNativeDispatcher({ repo, root, endpoint, workspace, owner: observationScope.owner });
  const nativeEvent = { hook_event_name: 'PostToolUse', cwd: root,
    tool_name: 'mcp__papercusp_su__testing_run', tool_input: { harness: workspace, files: [testPath] },
    tool_response: { byFile: { [testPath]: { status: 'fail', failed: 1, runId: failure.id } } } };
  const postIncident = () => dispatcher.post(nativeEvent);
  // The maintained cold loader returns immediately; converge only on its
  // bounded fixture load, retaining the first delivered response for evidence.
  let delivered = await postIncident();
  for (let attempt = 0; attempt < 10 && !delivered.text.includes('Code intelligence (incident)'); attempt++) {
    await new Promise(done => setTimeout(done, 25));
    delivered = await postIncident();
  }
  assert.match(delivered.text, /Code intelligence \(incident\)/);
  assert.match(delivered.text, /Recently changed symbols.*incidentTarget:a-target\.ts:1/);
  assert(delivered.text.includes(id), delivered.text);
  assert.match(delivered.text, /file-edit-ledger/);
  assert(delivered.text.includes(String(failure.id)), delivered.text);
  assert.match(delivered.text, /cause, runtime execution and dynamic dispatch are unknown/);
  const rows = await getOrgPg().sql<{ id: string; subject: string; chars: number; cited_paths: string[] }[]>`
    SELECT id, subject, chars, cited_paths FROM harness_shared.code_intel_pushes
    WHERE workspace_id = ${workspace} AND owner_id = 'native-incident-private-owner' AND leg = 'incident'`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.subject, `failed-tests:${testPath}`);
  // push-channel.ts records a fact's own block length (no join separator) since a40935b119.
  assert.equal(rows[0]!.chars, delivered.text.length);
  const duplicate = await postIncident();
  assert(!duplicate.text.includes('Code intelligence (incident)'), duplicate.text);
  const [count] = await getOrgPg().sql<{ count: number }[]>`SELECT count(*)::int AS count
    FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace}
      AND owner_id = 'native-incident-private-owner' AND leg = 'incident'`;
  assert.equal(count!.count, 1);
  const pushProof = { delivered: delivered.text, duplicateSuppressed: true, ledger: rows[0],
    attribution: replay.incidentAttribution, testRunId: failure.id, handlerHash,
    deliveryBoundary: 'installed Codex dispatcher/native PostToolUse event to stdout context envelope',
    installed: { ...dispatcher.installation, processes: dispatcher.processes(),
      nodeOptions: '', envelope: delivered.envelope, duplicateEnvelope: duplicate.envelope },
    snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
    sourceBeforeSha256: createHash('sha256').update(beforeTarget).digest('hex'), sourceAfterSha256: sha('a-target.ts'),
    observationProducer: 'maintained collector and delivery ledger with controlled before image',
    scope: 'private current-source installed dispatcher replay; automatic symbol collection and edit/open-WI lookup; synthetic snapshot commit and controlled source-history seam; no live Codex model session' };
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
  await writeFile(join(root, 'a-target.ts'), beforeTarget);
  await run(1);
  const repaired = await call('work_items:get', { id, harness: workspace, resume: true,
    projection: { pick: ['results[].resume.taskBrief'] } });
  assert.equal(repaired.results[0].resume.taskBrief.status, 'current');
  assert.deepEqual(repaired.results[0].resume.taskBrief.incident.failures, []);
  assert.deepEqual(repaired.results[0].resume.taskBrief.incident.candidates, []);
  console.log('NATIVE_INCIDENT_API_PROOF=' + JSON.stringify({ workspace, transport: 'real-cli-http',
    failure: 'actual-node-assertion', staticCandidate: true, cause: 'unknown', runtimeExecution: 'unmeasured',
    resume: 'current', repaired: true, push: pushProof }));
  }
} finally {
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await getOrgPg().sql.end({ timeout: 2 });
}
process.exit(0);
}

/** Both delivery legs execute the same installed bytes in fresh plain-Node processes. */
async function installedNativeDispatcher({ repo, root, endpoint, workspace, owner }: {
  repo: string; root: string; endpoint: URL; workspace: string; owner: string;
}) {
  const { installInjectionHooks } = await import('../../desktop-install/papercusp-files.ts');
  const { readInstallStamp } = await import('../../desktop-install/install-provenance.ts');
  const sourceDir = join(repo, 'apps/operator/scripts/hooks/inject');
  const installedDir = join(homedir(), '.papercusp/hooks/inject');
  const installed = await installInjectionHooks(homedir(), sourceDir);
  const hookPaths = ['index.mjs', 'core.mjs', 'ports.mjs', 'delivery-ledger.mjs', 'adapters/codex.mjs'];
  const hashes = Object.fromEntries(hookPaths.map(path => {
    assert(installed.includes(join('inject', path)), `Hook not installed: ${path}`);
    const bytes = readFileSync(join(installedDir, path));
    assert.deepEqual(bytes, readFileSync(join(sourceDir, path)), `Installed hook differs: ${path}`);
    return [path, createHash('sha256').update(bytes).digest('hex')];
  }));
  const stamp = await readInstallStamp(installedDir);
  assert.equal(stamp?.sourceDir, sourceDir);
  let processes = 0;
  return { installation: { hashes, stamp }, processes: () => processes,
    post: async (nativeEvent: Record<string, unknown>) => {
      // core.mjs hookOutcomeTracer: names the branch that produced an empty answer.
      const outcomeFile = join(tmpdir(), `papercusp-hook-outcome-${process.pid}-${randomUUID()}.jsonl`);
      const hookOutcome = () => {
        try { return readFileSync(outcomeFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown); } catch { return null; }
      };
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
        const child = spawn(process.execPath, [join(installedDir, 'index.mjs'),
          '--client=codex', '--event=post-tool-use'], { cwd: root, env: { ...process.env,
          NODE_OPTIONS: '', PAPERCUSP_SID: owner,
          PAPERCUSP_HOME: join(homedir(), '.papercusp'), PAPERCUSP_WORKSPACE: workspace,
          PAPERCUSP_HARNESS_SLUG: workspace, PAPERCUSP_OPERATOR_URL: endpoint.origin,
          PAPERCUSP_MCP_PROXY_PORT: endpoint.port, PAPERCUSP_MID_TURN_CONTEXT: 'on',
          PAPERCUSP_HOOK_OUTCOME_FILE: outcomeFile,
        }, stdio: ['pipe', 'pipe', 'pipe'] });
        processes++;
        const stdout = createTextCollector(child.stdout), stderr = createTextCollector(child.stderr);
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', status => { clearTimeout(timer); done({ status, stdout: stdout.text(), stderr: stderr.text() }); });
        child.stdin.end(JSON.stringify(nativeEvent));
      });
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.equal(result.stderr, '', result.stderr);
      if (!result.stdout.trim()) return { text: '', envelope: null, hookOutcome: hookOutcome() };
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.hookSpecificOutput?.hookEventName, 'PostToolUse');
      assert.equal(typeof envelope.hookSpecificOutput?.additionalContext, 'string');
      assert.equal(envelope.hookSpecificOutput.permissionDecision, undefined);
      return { text: envelope.hookSpecificOutput.additionalContext as string, envelope };
    } };
}

async function runNativeSnapshotJourney({ call, workspace, root, owner, repo, endpoint, leg }: {
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  workspace: string; root: string; owner: string; repo: string; endpoint: URL;
  leg: 'first-touch' | 'grep';
}) {
  const { getOrgPg } = await import('@papercusp/db-org');
  const target = 'a-target.ts', consumer = 'b-consumer.ts', testPath = 'target.test.ts';
  await writeFile(join(root, target), 'export function firstTouchTarget() { return 1; }\n');
  await writeFile(join(root, consumer), 'import { firstTouchTarget as localTarget } from "./a-target.ts";\nexport function consumer() { return localTarget(); }\n');
  await writeFile(join(root, testPath), 'import { consumer } from "./b-consumer.ts";\nexport const observed = consumer();\n');
  const sha = (path: string) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
  const snapshotPath = join(homedir(), '.papercusp/graph-snapshot/papercusp/dependency-snapshot.json');
  await mkdir(resolve(snapshotPath, '..'), { recursive: true });
  const snapshot = JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt: new Date().toISOString(),
    index: { backend: 'first-party-imports', lastCommit: 'a'.repeat(40) },
    edges: [{ imported: target, importer: consumer, importerSha256: sha(consumer) },
      { imported: consumer, importer: testPath, importerSha256: sha(testPath) }],
    symbols: { schema: 'code-intel-symbol-snapshot-v1', knowledge: 'syntax-bound', symbols: [{
      id: 'private-first-touch-target', name: 'firstTouchTarget', path: target, line: 1, column: 17,
      sha256: sha(target), signature: 'firstTouchTarget()', aliases: [],
      sources: [target, consumer].map(path => ({ path, sha256: sha(path) })),
      callers: [{ path: consumer, line: 2, column: 37, sha256: sha(consumer),
        spelling: 'localTarget', workspace: '@fixture/consumer' }],
    }] } });
  await writeFile(snapshotPath, snapshot);
  const dispatcher = await installedNativeDispatcher({ repo, root, endpoint, workspace, owner });
  const shellRead = (name: string) => {
    const result = spawnSync('rg', [name, target], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const shellEvent = (name: string, result: ReturnType<typeof shellRead>) => ({
    hook_event_name: 'PostToolUse', cwd: root, tool_name: 'exec_command',
    tool_input: { cmd: `rg ${name} ${target}`, workdir: root },
    tool_response: { exit_code: result.status, output: result.stdout + result.stderr },
  });
  let shell: ReturnType<typeof shellRead> | undefined;
  let nativeEvent: Record<string, unknown>;
  if (leg === 'first-touch') {
    // Explicit byte pages preserve the reader's machine-readable response;
    // ordinary line reads intentionally render numbered text in the CLI.
    const toolInput = { file_path: join(root, target), byte_offset: 0, byte_limit: 4096 };
    const read = await call('capability:read', toolInput);
    assert.equal(read.encoding, 'base64', JSON.stringify(read));
    assert.equal(read.eof, true, JSON.stringify(read));
    assert.deepEqual(Buffer.from(read.data, 'base64'), readFileSync(join(root, target)));
    nativeEvent = { hook_event_name: 'PostToolUse', cwd: root,
      tool_name: 'mcp__papercusp_su__capability_read', tool_input: toolInput, tool_response: read };
  } else {
    shell = shellRead('firstTouchTarget');
    assert.equal(shell.status, 0, JSON.stringify(shell));
    assert.match(shell.stdout, /export function firstTouchTarget/);
    nativeEvent = shellEvent('firstTouchTarget', shell);
  }
  const heading = `Code intelligence (${leg})`;
  let delivered = await dispatcher.post(nativeEvent);
  for (let attempt = 0; attempt < 10 && !delivered.text.includes(heading); attempt++) {
    await new Promise(done => setTimeout(done, 25));
    delivered = await dispatcher.post(nativeEvent);
  }
  assert(delivered.text.includes(heading), `Installed dispatcher did not deliver ${heading}: ${JSON.stringify(delivered)}`);
  assert(delivered.text.includes('@fixture/consumer'), delivered.text);
  assert(delivered.text.includes(consumer), delivered.text);
  if (leg === 'first-touch') {
    assert.match(delivered.text, /firstTouchTarget:1 >=1 static calls/);
    // P-006: the covering test is inline; a `Next: testing:run …` line appears only for a
    // session whose tools/list included testing:run (this fixture's owner never listed tools).
    assert.match(delivered.text, new RegExp(`Tests with static import reach[^:]*: ${testPath.replace(/\./g, '\\.')}\\.`), delivered.text);
    assert.match(delivered.text, /dynamic dispatch.*runtime execution are unknown/);
  } else {
    assert(delivered.text.includes(`firstTouchTarget: definition ${target}:1`), delivered.text);
    assert.match(delivered.text, /@fixture\/consumer: 1/);
    assert.match(delivered.text, /Aliases a literal grep can miss: localTarget/);
    assert.match(delivered.text, /Comments\/strings are excluded/);
    assert.match(delivered.text, /runtime execution remain unknown/);
  }
  const rows = await getOrgPg().sql<{ id: string; subject: string; chars: number; cited_paths: string[] }[]>`
    SELECT id, subject, chars, cited_paths FROM harness_shared.code_intel_pushes
    WHERE workspace_id = ${workspace} AND owner_id = ${owner} AND leg = ${leg}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.subject, leg === 'first-touch' ? target : 'firstTouchTarget');
  // push-channel.ts records a fact's own block length (no join separator) since a40935b119.
  assert.equal(rows[0]!.chars, delivered.text.length);
  const duplicate = await dispatcher.post(nativeEvent);
  assert(!duplicate.text.includes(heading), duplicate.text);
  let unresolvedSuppressed: boolean | undefined;
  if (leg === 'grep') {
    const unknown = shellRead('unresolvedFixtureSymbol');
    assert.equal(unknown.status, 1);
    const unresolved = await dispatcher.post(shellEvent('unresolvedFixtureSymbol', unknown));
    assert(!unresolved.text.includes(heading), unresolved.text);
    unresolvedSuppressed = true;
  }
  const [count] = await getOrgPg().sql<{ count: number }[]>`SELECT count(*)::int AS count
    FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace}
      AND owner_id = ${owner} AND leg = ${leg}`;
  assert.equal(count!.count, 1);
  console.log((leg === 'first-touch' ? 'NATIVE_FIRST_TOUCH_API_PROOF=' : 'NATIVE_GREP_API_PROOF=')
    + JSON.stringify({ workspace, transport: 'real-cli-http',
    readPath: target, shell, unresolvedSuppressed, delivered: delivered.text, duplicateSuppressed: true, ledger: rows[0],
    deliveryBoundary: 'installed Codex dispatcher/native PostToolUse event to stdout context envelope',
    installed: { ...dispatcher.installation, processes: dispatcher.processes(), nodeOptions: '',
      envelope: delivered.envelope, duplicateEnvelope: duplicate.envelope },
    snapshotSha256: createHash('sha256').update(snapshot).digest('hex'), sourceSha256: sha(target),
    scope: `private current-source installed dispatcher replay after real ${leg === 'first-touch' ? 'capability:read' : 'rg'}; synthetic snapshot commit; no live Codex model session or final shipment` }));
}

/** Reuse the same private handler/CLI/PG boundary without replaying the incident leg. */
async function runNativeTaskBriefJourney({ call, workspace, root, owner }: {
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  workspace: string; root: string; owner: string;
}) {
  const { getOrgPg } = await import('@papercusp/db-org');
  const paths = ['a-target.ts', 'b-consumer.ts', 'target.test.ts'];
  await writeFile(join(root, paths[0]!), 'export function briefTarget() { return 1; }\n');
  await writeFile(join(root, paths[1]!), 'import { briefTarget } from "./a-target.ts";\nexport function consumer() { return briefTarget(); }\n');
  await writeFile(join(root, paths[2]!), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { briefTarget } from "./a-target.ts";\ntest("native completion assertion", () => assert.equal(briefTarget(), 2));\n');
  const claims = () => getOrgPg().sql<{ count: number }[]>`SELECT count(*)::int AS count
    FROM harness_shared.work_items WHERE workspace_id = ${workspace} AND taken_by = ${owner}`;
  assert.equal((await claims())[0]!.count, 0, 'No-claim intent requires measured absence of ownership');
  const intent = 'Inspect the bounded target and its consumer before implementing the completion fixture';
  const declared = await call('coord:declare-intent', { intent, harness: workspace, current_files: paths,
    projection: { pick: ['ok', 'taskBrief'] } });
  assert.equal(declared.ok, true, JSON.stringify(declared));
  const brief = declared.taskBrief;
  assert.equal(brief?.status, 'current', JSON.stringify(declared));
  assert.deepEqual(brief.scope.paths, paths);
  assert.equal(brief.intent.text, intent);
  assert.equal(brief.incident, undefined, 'Transient intent must not invent a work-item incident');
  assert(brief.files.some((file: any) => file.path === paths[0]));
  const oriented = await call('coord:orient', { intent, harness: workspace, currentFiles: paths,
    claimableLimit: 0, inboxLimit: 0, memoryLimit: 0, includeFleet: false,
    projection: { pick: ['intentDeclared', 'taskBrief'] } });
  assert.equal(oriented.intentDeclared, true, JSON.stringify(oriented));
  assert.equal(oriented.taskBrief?.status, 'current', JSON.stringify(oriented));
  assert.equal(oriented.taskBrief.sourceFingerprint, brief.sourceFingerprint);
  assert.equal(oriented.taskBrief.intent.fingerprint, brief.intent.fingerprint);
  assert.equal((await claims())[0]!.count, 0, 'Intent/orient must not create a work-item claim');

  // The change-kind gate refuses a close with no declared kind. Declare it when
  // the item is created, as a real agent would, so the close below only has to
  // carry the logic kind's proof (its passing native test command and result).
  const created = await call('work_items:create', { kind: 'change', title: 'Private native completion source fixture',
    harness: workspace, assign_to: 'self', state: 'wip', payload: { paths },
    changeKinds: ['logic'], changeKindReason: 'The fixture edits one private source function and proves it with its native test.',
    projection: { pick: ['results[].id', 'results[].ok', 'results[].item.id'] } });
  const id = created.results?.[0]?.id ?? created.results?.[0]?.item?.id;
  assert.equal(typeof id, 'string', JSON.stringify(created));
  assert.equal((await claims())[0]!.count, 1);
  const held = await call('coord:declare-intent', { intent, harness: workspace, current_files: paths,
    projection: { pick: ['ok', 'taskBrief'] } });
  assert.equal(held.ok, true); assert.equal(held.taskBrief, undefined, JSON.stringify(held));
  await writeFile(join(root, paths[0]!), 'export function briefTarget() { return 2; }\n');
  const test = spawnSync(process.execPath, ['--test', paths[2]!], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.equal(test.error, undefined); assert.equal(test.status, 0, test.stdout + test.stderr);
  assert.match(test.stdout, /native completion assertion/);
  // A real native run is evidence for this fixture, but it is deliberately not a
  // server-bound testing:run invocation. The receipt must expose that distinction.
  const closed = await call('work_items:complete', { id, harness: workspace, state: 'done', assumptions: 'none',
    completion: { summary: 'Updated the private target and verified its actual native assertion.',
      testsRun: 'node --test target.test.ts', testResult: '1 passed, 0 failed',
      verifiedHow: 'Native node:test process exited 0 in the private harness.', filesChanged: [paths[0]] },
    projection: { pick: ['ok', 'results[].ok', 'results[].error', 'results[].stateWarning',
      'results[].completionBrief', 'results[].workItem.state', 'results[].finish.complete'] } });
  const receipt = closed.results?.[0];
  assert.equal(receipt?.ok, true, JSON.stringify(closed));
  const completion = receipt.completionBrief;
  assert.equal(completion?.status, 'measured', JSON.stringify(closed));
  assert.equal(completion.phase, 'pre-review');
  assert.equal(completion.executionCoverage, 'unmeasured');
  assert(completion.changes.some((change: any) => change.file === paths[0] && change.symbol === 'briefTarget'));
  assert.deepEqual(completion.testsWithoutRunEvidence, ['target.test.ts']);
  const settled = await call('work_items:get', { id, harness: workspace,
    projection: { pick: ['results[].workItem.state'] } });
  assert.equal(settled.results?.[0]?.workItem.state, 'done', JSON.stringify(settled));
  console.log('NATIVE_TASK_BRIEF_API_PROOF=' + JSON.stringify({ workspace, transport: 'real-cli-http',
    noClaimBeforeIntent: true, declare: brief, orient: oriented.taskBrief, heldClaimSuppressed: true,
    completion, terminal: true, testOutputSha256: createHash('sha256').update(test.stdout + test.stderr).digest('hex'),
    scope: 'private current-source CLI requests; compiler and safe packer; no model session or final shipment' }));
}
