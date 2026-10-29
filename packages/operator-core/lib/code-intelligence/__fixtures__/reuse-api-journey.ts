/** R22: real CLI completion with actual history, tests and per-file coverage. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeClaimReuseContribution } from '../reuse-brief-providers.ts';

/** The staging adapter owns this lifecycle; private callers cannot opt out of
 * their guards merely by choosing a different workspace name. */
export interface ManagedReuseJourney {
  root: string;
  harness: string;
  planSlug: string;
  sessionId: string;
  register(baseline: string): Promise<void>;
  trackClaim(id: string): Promise<void>;
  createSession(create: () => Promise<number | null>): Promise<number>;
  retainProof(proof: Record<string, unknown>): Promise<void>;
  snapshotPath: string;
}

/** Preserve the pre-admitted canonical identity before any follow-up mutation. */
export async function createControlledReusePlan(
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>,
  harness: string, planSlug: string, targetPath: string,
) {
  const planned = await call('plans:new', { harness, slug: planSlug,
    title: 'Controlled CLI R20 fixture',
    content: 'Controlled CLI fixture; no model or live cohort.\n\n## Phase 1 — Fixture\n',
    projection: { pick: ['ok', 'results[].ok', 'results[].slug', 'slug'] } });
  assert.notEqual(planned.ok, false, JSON.stringify(planned));
  assert.equal(planned.slug, planSlug, 'Controlled plan identity changed: ' + JSON.stringify(planned));
  const added = await call('plans:add-item', { harness, slug: planSlug, phase: 'Phase 1 — Fixture',
    text: `Inspect ${targetPath}`, importance: 'normal',
    projection: { pick: ['ok', 'results[].ok', 'results[].itemId'] } });
  assert.equal(added.results?.[0]?.ok, true, JSON.stringify(added));
  const planItem = added.results?.[0]?.itemId;
  assert(planItem, 'Maintained plan-item writer must persist the controlled anchor: ' + JSON.stringify(added));
  return { planItem, added };
}

/** Keep the sparse harness inside the private session's existing pot. */
export function privateReuseHarnessRegistration(workspace: string, harness: string, path: string, expectedCommit: string) {
  assert(workspace.startsWith('test-runtime-'), 'Private reuse workspace required');
  return { slug: harness, path, pot: workspace, registrationOnly: true, expectedCommit,
    projection: { pick: ['ok', 'slug', 'path'] } };
}

/** Inner assertions read the private operator ledger; the outer test retains its own sink. */
export function privateReuseTestEnvironment(env: NodeJS.ProcessEnv, workspace: string, root: string, harness = workspace) {
  assert(workspace.startsWith('test-runtime-'), 'Private reuse workspace required');
  const url = new URL(env.HARNESS_ADMIN_DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && Number(url.port) > 0 && url.port === env.PAPERCUSP_PG_PORT,
  'Inner reporter must use the private product database');
  return { PAPERCUSP_TEST_RUNS_DB_URL: url.toString(), PAPERCUSP_TEST_RUN_WORKSPACE: workspace,
    PAPERCUSP_TEST_RUN_HARNESS: harness, PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(root, 'reports/inner-test-receipt.jsonl'),
    PAPERCUSP_TEST_RUN_SOURCE: 'local' };
}

/** D033: authored inputs shared by the focused producer preflight and native CLI.
 * No response, source identity, provider payload or production policy is edited.
 */
export function sparseReuseFixtureFiles(repo: string): Record<string, string> {
  const body = 'let t=0;for(const x of v){if(x>0)t+=x;else t-=x;}' + 't++;'.repeat(20);
  return {
    'a.ts': "import{sql}from'./b';\nexport function f(v:number[]){" + body + 'sql`UPDATE t SET x=1`;return t;}\n',
    'b.ts': 'export function sql(p:TemplateStringsArray){return p.join(\'\');}\n'
      + 'export function g(v:number[]){' + body + 'sql`UPDATE t SET x=1`;return t;}\nexport const revision=0;\n',
    'c.ts': "import{sql}from'./b';import{f}from'./a';\nexport function q(){f([1]);return sql`SELECT x FROM t`;}\n",
    'a.test.ts': `import{test,expect}from${JSON.stringify(join(repo, 'node_modules/vitest/dist/index.js'))};\n`
      + "import{f}from'./a';test('f',()=>expect(f([2])).toBe(22));\n",
    'package.json': JSON.stringify({ name: 'controlled-r20', private: true, type: 'module',
      scripts: { 'test:file': 'vitest run --config vitest.config.ts' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['*.ts'] }),
    '.gitignore': 'node_modules\nreports\n.papercusp\n',
    'vitest.config.ts': `import { defineConfig } from ${JSON.stringify(join(repo, 'node_modules/vitest/dist/config.js'))};\n`
      + `import { executedSourceOriginalsPlugin } from ${JSON.stringify(join(repo, 'libs/test-config/src/vitest-config.ts'))};\n`
      + `import AdminTestRunsReporter from ${JSON.stringify(join(repo, 'libs/test-config/src/admin-test-runs-reporter.ts'))};\n`
      + 'export default defineConfig({plugins:[executedSourceOriginalsPlugin()],test:{include:["a.test.ts"],maxWorkers:1,'
      + 'reporters:["default",new AdminTestRunsReporter()],coverage:{enabled:true,provider:"custom",'
      + `customProviderModule:${JSON.stringify(join(repo, 'libs/test-config/src/test-coverage-provider.ts'))},`
      + 'include:["*.ts"],reporter:["json"],reportsDirectory:"./reports"}}});\n',
  };
}

export async function runNativeReuseJourney({ call, workspace, root: privateRoot, owner, repo, handlerHash, claimOnly = false, managed }: {
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>;
  workspace: string; root: string; owner: string; repo: string; handlerHash: string; claimOnly?: boolean;
  managed?: ManagedReuseJourney;
}) {
  assert(managed ? claimOnly && managed.root === privateRoot : workspace.startsWith('test-runtime-'),
    'Private runtime or adapter-owned claim lifecycle required');
  const root = managed?.root ?? (claimOnly ? await mkdtemp(join(tmpdir(), 'r-')) : privateRoot);
  const harness = managed?.harness ?? (claimOnly ? 'r' : workspace);
  const targetPath = claimOnly ? 'a.ts' : 'src/target.ts';
  const siblingPath = claimOnly ? 'b.ts' : 'src/sibling.ts';
  const partnerPath = claimOnly ? 'b.ts' : 'src/partner.ts';
  const readerPath = claimOnly ? 'c.ts' : 'src/reader.ts';
  const testPath = claimOnly ? 'a.test.ts' : 'src/target.test.ts';
  try {
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { pgHookTurnStore } = await import('../../agent-identities/sync-hook-rules.ts');
  // This is the real private fixture's turn. Use its maintained writer; never
  // insert issued rows or pretend that a production user received this replay.
  await pgHookTurnStore().begin(owner, workspace);
  await mkdir(join(root, 'src'), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const body = 'let total = 0; for (const value of values) { if (value > 0) total += value; else total -= value; } '
    + 'total += values.length; '.repeat(20) + 'return total;';
  const aggregate = (name: string) => `export function ${name}(values: number[]) {\n  ${body.replaceAll('; ', ';\n  ')}\n}\n`;
  const target = "import { sql } from './partner';\n" + aggregate('aggregatePositive')
    + 'export function updateValue() { return sql`UPDATE public.p010_replay SET value = 1 WHERE id = 1`; }\n';
  const ordinaryFiles: Record<string, string> = {
    'src/target.ts': target,
    'src/sibling.ts': aggregate('aggregateSibling'),
    'src/partner.ts': "export function sql(parts: TemplateStringsArray) { return parts.join(''); }\nexport const revision = 0;\n",
    // A real static consumer brings the SQL reader into compiler-captured
    // supporting scope. The test never imports or executes this consumer.
    'src/reader.ts': "import { sql } from './partner';\nimport { aggregatePositive } from './target';\n"
      + "export function readValue() { aggregatePositive([1]); return sql`SELECT value FROM public.p010_replay WHERE id = 1`; }\n",
    'src/target.test.ts': `import { test, expect } from ${JSON.stringify(join(repo, 'node_modules/vitest/dist/index.js'))};\n`
      + "import { aggregatePositive, updateValue } from './target';\n"
      + "test('native reuse positive branch and writer', () => { expect(aggregatePositive([2])).toBe(22); expect(updateValue()).toContain('UPDATE'); });\n",
    'package.json': JSON.stringify({ name: 'private-native-reuse', private: true, type: 'module',
      scripts: { 'test:file': 'vitest run --config vitest.config.ts' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' }, include: ['src/**/*.ts'] }),
    '.gitignore': 'node_modules\nreports\n.papercusp\n',
    'vitest.config.ts': `import { defineConfig } from ${JSON.stringify(join(repo, 'node_modules/vitest/dist/config.js'))};\n`
      + `import { executedSourceOriginalsPlugin } from ${JSON.stringify(join(repo, 'libs/test-config/src/vitest-config.ts'))};\n`
      + `import AdminTestRunsReporter from ${JSON.stringify(join(repo, 'libs/test-config/src/admin-test-runs-reporter.ts'))};\n`
      + 'export default defineConfig({plugins:[executedSourceOriginalsPlugin()],test:{include:["src/target.test.ts"],maxWorkers:1,'
      + 'reporters:["default",new AdminTestRunsReporter()],coverage:{enabled:true,provider:"custom",'
      + `customProviderModule:${JSON.stringify(join(repo, 'libs/test-config/src/test-coverage-provider.ts'))},`
      + 'include:["src/*.ts"],reporter:["json"],reportsDirectory:"./reports"}}});\n',
  };
  const files = claimOnly ? sparseReuseFixtureFiles(repo) : ordinaryFiles;
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  git('init', '-q'); git('config', 'user.name', 'native reuse fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'private fixture baseline');
  for (let revision = 1; revision <= 3; revision++) {
    await writeFile(join(root, targetPath), files[targetPath]! + (claimOnly ? `// r${revision}\n` : `// coordinated revision ${revision}\n`));
    await writeFile(join(root, partnerPath), files[partnerPath]!.replace(/revision\s*=\s*0/, `revision=${revision}`));
    git('add', targetPath, partnerPath);
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', `private coordinated revision ${revision}`);
  }
  const baseline = git('rev-parse', 'HEAD');
  if (claimOnly) {
    if (managed) await managed.register(baseline);
    else {
      const registered = await call('harness:create', privateReuseHarnessRegistration(workspace, harness, root, baseline));
      assert.equal(registered.ok, true, JSON.stringify(registered));
    }
    const { loadHarnessRegistry } = await import('../../harness-registry.ts');
    assert.equal((await loadHarnessRegistry(workspace)).projects.find(p => p.slug === harness)?.path, root);
  }
  // Publish an actual parser-produced clone inventory, with this repository's
  // real historical identity, to the same fixture snapshot seam as other replays.
  const { buildCloneIndex } = await import('../clone-index.ts');
  const { prepareCloneAdvisories } = await import('../clone-advisory.ts');
  const cloneFiles = prepareCloneAdvisories(buildCloneIndex([
    { path: targetPath, source: await readFile(join(root, targetPath), 'utf8') },
    { path: siblingPath, source: await readFile(join(root, siblingPath), 'utf8') },
  ]));
  const snapshotPath = managed?.snapshotPath ?? join(homedir(), '.papercusp/graph-snapshot', harness, 'dependency-snapshot.json');
  await mkdir(join(snapshotPath, '..'), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify({ schema: 'graph-dependency-snapshot-v1', generatedAt: new Date().toISOString(),
    index: { backend: 'first-party-imports', lastCommit: baseline }, edges: [],
    clones: { schema: 'clone-advisory-v1', files: cloneFiles } }), managed ? { flag: 'wx' } : undefined);
  // D026: a real persisted planning timestamp and one explicitly controlled CLI
  // session qualify provenance. This does not represent a model-session census.
  // D029: sparse authored context only; never shorten the returned task brief.
  const planSlug = managed?.planSlug ?? `${claimOnly ? 'r' : 'p010'}-${new Date().toISOString().slice(0, 10)}`;
  let planItem: string | undefined;
  if (claimOnly) {
    const createdPlan = await createControlledReusePlan(call, harness, planSlug, targetPath);
    planItem = createdPlan.planItem;
    const added = createdPlan.added;
    // Read the same indexed boundary that work_items:create validates, before
    // spending the rest of the native journey on an unusable anchor.
    const { getPlanItemRow } = await import('../../agent-tools/plans/source.ts');
    const persisted = await getPlanItemRow(planSlug, { workspaceId: workspace, harnessSlug: harness });
    assert(persisted?.items.some(item => item.id === planItem),
      'Controlled plan anchor must survive persisted index readback: ' + JSON.stringify({
        workspace, planSlug, planItem, added, persisted,
      }));
  }
  const expectedProviders = ['clones', 'cochange', 'provenance', 'sql', 'coverage'];
  const cohortCandidates: { id: string; cohorts: Record<string, string> }[] = [];
  let id: string | undefined;
  // Explicit controlled-treatment selection: retain actual persisted identities,
  // never override the production selector or mislabel held-out advice as failure.
  for (let attempt = 0; attempt < (claimOnly ? 16 : 1); attempt++) {
    if (claimOnly && attempt > 0) {
      const added = await call('plans:add-item', { harness, slug: planSlug, phase: 'Phase 1 — Fixture',
        text: `Inspect ${targetPath} candidate ${attempt + 1}`, importance: 'normal',
        projection: { pick: ['results[].ok', 'results[].itemId'] } });
      planItem = added.results?.[0]?.itemId;
      assert.equal(added.results?.[0]?.ok, true, JSON.stringify(added));
      const { getPlanItemRow } = await import('../../agent-tools/plans/source.ts');
      const persisted = await getPlanItemRow(planSlug, { workspaceId: workspace, harnessSlug: harness });
      assert(planItem && persisted?.items.some(item => item.id === planItem), 'Candidate anchor must persist');
    }
    const created = await call('work_items:create', { harness, kind: 'change',
      title: claimOnly ? `Controlled R20 candidate ${attempt + 1}` : 'Private native P010 completion consequences',
      ...(managed ? { state: 'open' } : { assign_to: 'self', state: 'wip' }),
      changeKinds: ['logic'], changeKindReason: 'Private source fixture validated through an actual complete test population.',
      ...(claimOnly ? { force: true, plan_item: { slug: planSlug, item: planItem! } } : {}),
      payload: { paths: [targetPath] }, projection: { pick: ['results[].id', 'results[].item.id'] } });
    const candidate = created.results?.[0]?.id ?? created.results?.[0]?.item?.id;
    assert(candidate, JSON.stringify(created));
    // On staging, creation is deliberately unclaimed. Journal the exact id
    // before the later fallible claim can create an owned lease.
    if (managed) await managed.trackClaim(candidate);
    if (!claimOnly) { id = candidate; break; }
    const { reuseHoldout } = await import('../reuse-measurement.ts');
    const cohorts = Object.fromEntries(expectedProviders.map(provider =>
      [provider, reuseHoldout(candidate, provider) ? 'holdout' : 'treatment']));
    cohortCandidates.push({ id: candidate, cohorts });
    console.log('NATIVE_REUSE_COHORT_CANDIDATE=' + JSON.stringify({ id: candidate, cohorts }));
    if (Object.values(cohorts).every(cohort => cohort === 'treatment')) { id = candidate; break; }
    const dropped = await call('work_items:complete', { id: candidate, harness, state: 'dropped', assumptions: 'none',
      completion: { summary: 'Discarded controlled treatment candidate because its actual provider cohort contains a holdout.',
        testsRun: 'Maintained reuseHoldout for five required providers', testResult: JSON.stringify(cohorts),
        verifiedHow: 'Hash of actual persisted work-item identity before explicit claim', filesChanged: [] },
      projection: { pick: ['results[].ok', 'results[].error'] } });
    assert.equal(dropped.results?.[0]?.ok, true, JSON.stringify(dropped));
  }
  assert(id, 'No five-provider treatment fixture within bounded candidate budget: ' + JSON.stringify(cohortCandidates));
  // The real claim primes the cooperative snapshot loader before tests run.
  // Keep the complete response as fixture evidence without certifying R20's
  // separate provenance/planning cohort from this completion-only scenario.
  const claimed = await call('work_items:claim', { ...(managed
    ? { id, assignee: 'self', harness, changeKinds: ['logic'] } : { row: `${id},self,${harness}` }),
    projection: { pick: ['results[].ok', 'results[].taskBrief'] } });
  assert.equal(claimed.results?.[0]?.ok, true, JSON.stringify(claimed));
  console.log('NATIVE_INCIDENT_API_STAGE=reuse-fixture-owned');
  const before = await readFile(join(root, targetPath), 'utf8');
  // P-008: the provenance provider reports PRIOR work on the file's functions
  // (change-history.ts readPriorWork). A captured edit counts only when its
  // enclosing symbols overlap them, so the controlled CLI edit lands inside f.
  const fnOpen = 'export function f(v:number[]){';
  if (claimOnly) assert(before.includes(fnOpen), 'Sparse a.ts must declare f: ' + before);
  const edited = claimOnly ? before.replace(fnOpen, fnOpen + '// CLI\n')
    : '// touched clone sibling in this private task\n' + before + aggregate('plantedCopy');
  let controlledSession: { id: number; session: string; editedAt: string } | undefined;
  if (claimOnly) {
    const { recordAdvSession } = await import('../../adv-sessions.ts');
    const session = managed?.sessionId ?? `controlled-cli-${randomUUID()}`;
    const createSession = () => recordAdvSession({ workspaceId: workspace, planSlug, mode: 'console',
      label: 'Controlled P010 CLI fixture; no model invoked', cwd: root, coordOwnerId: owner, sessionId: session });
    const sessionRow = managed ? await managed.createSession(createSession) : await createSession();
    assert(sessionRow, 'Maintained controlled CLI session writer must persist its actual start');
    // The CLI shell performs the real write. Its subsequent Write report names
    // that exact operation/session; no direct session-less Edit is fabricated.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const script = 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])';
    const written = await call('capability:bash', { cwd: root, work_item_id: id,
      command: [process.execPath, '-e', script, join(root, targetPath), edited].map(quote).join(' '),
      timeout: 10_000 });
    assert.equal(written.exit_code, 0, JSON.stringify(written));
    assert.equal(await readFile(join(root, targetPath), 'utf8'), edited);
    const editedAt = new Date().toISOString();
    await call('activity:report', { owner, session_id: session, adv_session_id: sessionRow,
      harness_slug: harness, kind: 'tool', tool_name: 'Write', phase: 'post', status: 'ok', cwd: root,
      tool_use_id: `controlled-write-${randomUUID()}`, summary: 'Actual controlled CLI fixture write; no model invocation',
      tool_input: { file_path: join(root, targetPath), content: edited } });
    controlledSession = { id: sessionRow, session, editedAt };
    // The provenance reader reads only harness_shared.edit_attribution_ledger
    // (50ca13d720). A shell write produces no ledger row, so record the Write
    // through the production writer, the one locks:release runs for a
    // hook-mediated CLI Write. Await symbol capture so the labels are durable.
    // The provider excludes the claimed item (its own edits are current work),
    // so the controlled Write is attributed to a separate, visible prior item.
    const priorCreated = await call('work_items:create', { harness, kind: 'change',
      title: 'Controlled prior a.ts edit (P010 provenance witness)',
      ...(managed ? { state: 'open' } : { assign_to: 'self', state: 'wip' }),
      changeKinds: ['logic'], changeKindReason: 'Private source fixture: prior work the claimed item reads.',
      payload: { paths: [targetPath] }, projection: { pick: ['results[].id', 'results[].item.id'] } });
    const prior: string | undefined = priorCreated.results?.[0]?.id ?? priorCreated.results?.[0]?.item?.id;
    assert(prior && prior !== id, JSON.stringify(priorCreated));
    if (managed) await managed.trackClaim(prior);
    const { recordEditAttribution } = await import('../../edit-attribution.ts');
    await recordEditAttribution({ repoRoot: root, files: [targetPath], agentId: owner, sessionId: session,
      workspaceId: workspace, goalRef: prior, intent: 'Controlled P010 CLI fixture write',
      dispatchCallId: randomUUID() }, { strict: true, awaitSymbols: true });
    // Prove the producer's ledger join before the expensive nested test, through
    // the exact reader and arguments the provenance provider uses.
    const { readSymbolProvenance, readPriorWork, fileSymbolNames } = await import('../change-history.ts');
    const provenance = await readSymbolProvenance({ workspaceId: workspace, harness, root, path: targetPath,
      since: editedAt });
    const priorWork = await readPriorWork({ workspaceId: workspace, root, path: targetPath,
      names: fileSymbolNames(targetPath, edited), excludeWorkItem: id });
    console.log('NATIVE_REUSE_PROVENANCE_PRECONDITION=' + JSON.stringify({ workspace, harness,
      workItem: id, prior, controlledSession, provenance, priorWork }));
    assert(provenance.fileEdits.some(edit => edit.workItem === prior && edit.owner === owner && edit.session === session
      && (edit.symbols ?? []).includes('f')),
    'Actual controlled Write must be recorded with its enclosing symbol: ' + JSON.stringify(provenance));
    assert(priorWork.status === 'measured' && priorWork.items.some(item => item.workItem === prior && item.symbols.includes('f')),
      'Actual controlled Write must qualify as prior work for the claimed item: ' + JSON.stringify(priorWork));
  } else {
    await call('capability:edit', { file_path: join(root, targetPath), old_string: before, new_string: edited });
  }
  // with-test-pg preserves the parent's durable evidence destination on purpose.
  // This nested run instead feeds the private operator's completion reader.
  if (!managed) {
  Object.assign(process.env, privateReuseTestEnvironment(process.env, workspace, root, harness));
  delete process.env.PAPERCUSP_TEST_RUN_COMMIT;
  delete process.env.PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN;
  delete process.env.PC_TEST_FILE_COVERAGE_SCOPE;
  const { resolveTestRunsPgUrl, resolveTestRunWorkspaceId } = await import('@papercusp/test-config/admin-test-runs-reporter');
  assert.equal(resolveTestRunsPgUrl(), process.env.HARNESS_ADMIN_DATABASE_URL);
  assert.equal(resolveTestRunWorkspaceId(), workspace);
  }
  const run = await call('testing:run', { harness, work_item_id: id, files: [testPath],
    timeoutMs: 30_000 });
  console.log('NATIVE_REUSE_TEST_RUN=' + JSON.stringify(run));
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.passed, 1, JSON.stringify(run));
  assert.equal(run.failed, 0, JSON.stringify(run));
  assert.equal(run.skipped, 0, JSON.stringify(run));
  assert.equal(run.testRunIds?.length, 1, JSON.stringify(run));
  assert.equal(typeof run.runId, 'string', JSON.stringify(run));
  // Preserve the real telemetry clock and ledger receipt outside PG teardown.
  // invoked_at is the dispatch-settle time, not when testing:run began.
  const bindingRows = await getOrgPg().sql<{ invoked_at: Date; duration_ms: number | null }[]>`
    SELECT invoked_at, duration_ms FROM harness_shared.tool_invocations
    WHERE workspace_id = ${workspace} AND coord_owner_id = ${owner}
      AND tool_name = 'testing:run' AND args_json->>'work_item_id' = ${id}
    ORDER BY invoked_at DESC LIMIT 1`;
  const testRows = await getOrgPg().sql<{ file_path: string; finished_at: Date; run_group_id: string }[]>`
    SELECT file_path, finished_at, run_group_id FROM harness_shared.test_runs
    WHERE run_group_id = ${run.runId} AND file_path = ${testPath}`;
  console.log('NATIVE_REUSE_BINDING_DIAGNOSTIC=' + JSON.stringify({ workspace, workItem: id,
    runGroupId: run.runId, testRunIds: run.testRunIds, invocations: bindingRows, tests: testRows }));
  assert.equal(bindingRows.length, 1, 'Actual attributed testing:run must be durably recorded before completion');
  assert.equal(testRows.length, 1, 'Actual test-file receipt must be retained for the same run group');
  // Refuse a completion replay whose telemetry cannot support a negative
  // execution claim. This reads the real run's coverage, without seeding it.
  const { readNativeCoverageScope, queryTestCoverage } = await import('../test-coverage-map.ts');
  const sourceFiles = await Promise.all([targetPath, readerPath, partnerPath, testPath]
    .map(async path => ({ path, sha256: hash(await readFile(join(root, path), 'utf8')) })));
  const coverage = await readNativeCoverageScope({ surface: 'completion', workspaceId: workspace,
    owner, invocation: 'native-fixture-precondition', workItem: id, paths: [targetPath],
    sourceVersion: hash(JSON.stringify(sourceFiles.map(source => [source.path, source.sha256]))), commit: baseline,
    repository: { workspaceId: workspace, rootPath: root, harness }, sourceFiles },
  new AbortController().signal, { runGroupId: run.runId, testFiles: [testPath] });
  if (!coverage) {
    // Keep the actual writer scope/run in the primary error: private teardown
    // and bounded child tails must not erase why the completion preflight failed.
    const stored = await getOrgPg().sql`SELECT workspace_id, harness_slug, root_path, run_group_id,
      test_file, jsonb_array_length(snapshot->'sources') AS source_count
      FROM harness_shared.test_coverage_maps WHERE root_path = ${root} LIMIT 5`;
    assert.fail('Actual attributed run must have source-bound per-file coverage: ' + JSON.stringify({
      expected: { workspace, harness, root, runGroup: run.runId }, stored,
      run: { ok: run.ok, passed: run.passed, failed: run.failed, skipped: run.skipped, testRunIds: run.testRunIds },
    }));
  }
  if (claimOnly) {
    const { getClaimTimeTaskBrief } = await import('../task-brief.ts');
    const itemRead = await call('work_items:get', { id, harness, payloadTier: 'full',
      projection: { pick: ['results[].workItem'] } });
    const item = itemRead.results?.[0]?.workItem;
    assert(item && item.sourcePlanSlug === planSlug, JSON.stringify(itemRead));
    // Match the complete production claim reader, including engineering evidence
    // and compaction. Omitting reuse identity keeps only the mandatory baseline.
    // The claim's recipient is `owner`: gateTaskBriefRecover keeps each recover ref
    // (decisions/incident/engineering/top-level) only when that recipient's listed
    // toolset can call it, so the baseline must be read for the same recipient.
    const baselineRead = await getClaimTimeTaskBrief({ workItem: item, workspaceId: workspace, harness, owner });
    assert(baselineRead, 'Controlled anchored claim must produce its mandatory baseline');
    const base = baselineRead.taskBrief;
    assert.equal(base.status, 'current', JSON.stringify(base));
    const response = await call('work_items:claim', { row: `${id},self,${harness}`, payloadTier: 'full',
      projection: { pick: ['results[].ok', 'results[].taskBrief'] } });
    const brief = response.results?.[0]?.taskBrief;
    // Preserve the actual dispatcher observations before a strict assertion
    // fails and private-PG teardown removes the only copy. A missing provider
    // can be disabled, unknown or over budget; the response alone cannot say.
    const claimInvocations = await getOrgPg().sql`SELECT id, invoked_at,
      metadata_json->'reuseBriefProviders' AS providers
      FROM harness_shared.tool_invocations
      WHERE workspace_id = ${workspace} AND coord_owner_id = ${owner}
        AND tool_name = 'work_items:claim' AND args_json->>'row' = ${`${id},self,${harness}`}
      ORDER BY invoked_at DESC LIMIT 1`;
    console.log('NATIVE_REUSE_CLAIM_DIAGNOSTIC=' + JSON.stringify({ workspace, workItem: id,
      base, response, claimInvocations, expectedProviders,
      baseChars: [...JSON.stringify(base)].length,
      responseBriefChars: brief ? [...JSON.stringify(brief)].length : null }));
    assert(brief && brief.status === 'current', JSON.stringify(response));
    assert.deepEqual({ ...brief, graph: { ...brief.graph,
      relationships: brief.graph.relationships.slice(0, base.graph.relationships.length) } }, base);
    const contributions = brief.graph.relationships.flatMap((line: string) => {
      const row = decodeClaimReuseContribution(brief, line); return row ? [row] : [];
    });
    const { REUSE_PROVIDER_POLICY, briefCodePoints } = await import('../reuse-brief-providers.ts');
    const expected = expectedProviders;
    assert.deepEqual(contributions.map((row: { provider: string }) => row.provider), expected, JSON.stringify(response));
    for (const row of contributions) {
      const policy = REUSE_PROVIDER_POLICY[row.provider as keyof typeof REUSE_PROVIDER_POLICY];
      assert(briefCodePoints(row.text) <= policy.cap && row.sourceVersion === brief.sourceFingerprint && row.indexVersion);
    }
    assert(briefCodePoints(JSON.stringify(brief)) <= 3_000, JSON.stringify(brief));
    const issued = await getOrgPg().sql<{ subject: string; chars: number }[]>`SELECT subject, chars
      FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner}
        AND subject::jsonb->>'workItem' = ${id} AND subject::jsonb->>'surface' = 'claim'`;
    const finalInvocation = issued.map(row => JSON.parse(row.subject)).find(row => row.provider === 'provenance')?.invocation;
    const finalIssued = issued.filter(row => JSON.parse(row.subject).invocation === finalInvocation);
    assert(finalInvocation, JSON.stringify(issued));
    assert.deepEqual(finalIssued.map(row => JSON.parse(row.subject).provider).sort(), [...expected].sort());
    assert(finalIssued.every(row => JSON.parse(row.subject).sourceVersion === brief.sourceFingerprint
      && JSON.parse(row.subject).indexVersion && row.chars > 0));
    const proof = { workspace, harness, root, fixtureWorkItem: id,
      planSlug, baseline, handlerHash, sourceFingerprint: brief.sourceFingerprint, controlledSession, cohortCandidates,
      transport: 'real-cli-http', expectedProviders: expected, response, base, issued: finalIssued,
      testRunIds: run.testRunIds, runGroupId: run.runId,
      scope: managed ? 'controlled staging CLI fixture; no model invocation, live user census or final shipment'
        : 'controlled private current-source CLI fixture; no model invocation, live user census or final shipment' };
    if (managed) await managed.retainProof(proof);
    console.log('NATIVE_REUSE_CLAIM_API_PROOF=' + JSON.stringify(proof));
    return;
  }
  const current = await readFile(join(root, 'src/target.ts'), 'utf8');
  const copyStart = current.slice(0, current.indexOf('export function plantedCopy')).split('\n').length;
  const uncovered = queryTestCoverage({ root, question: { path: 'src/target.ts',
    changedLines: Array.from({ length: current.split('\n').length - copyStart }, (_, i) => copyStart + i) },
    snapshots: coverage.snapshots, currentHashes: coverage.currentHashes, currentPopulation: coverage.population });
  assert(uncovered.uncoveredChangedLines.length > 0, JSON.stringify({ uncovered, snapshots: coverage.snapshots }));
  const { readPostgresLineage } = await import('../postgres-lineage-query.ts');
  const lineage = await readPostgresLineage(root, sourceFiles.map(source => source.path));
  assert(lineage.sites.some(site => site.path === 'src/reader.ts' && site.access === 'read'
    && site.table === 'public.p010_replay'), JSON.stringify(lineage));
  const closed = await call('work_items:complete', { id, harness: workspace, state: 'done', assumptions: 'none',
    completion: { summary: 'Changed the private aggregate and planted a copy; verified the positive branch and writer.',
      testsRun: 'testing:run src/target.test.ts with complete per-file V8 coverage', testResult: '1 passed, 0 failed',
      verifiedHow: 'Actual native CLI test and completion on private current source.', filesChanged: ['src/target.ts'] },
    projection: { pick: ['ok', 'results[].ok', 'results[].error', 'results[].completionBrief', 'results[].workItem.state'] } });
  const receipt = closed.results?.[0];
  assert.equal(receipt?.ok, true, JSON.stringify(closed));
  const text = JSON.stringify(receipt.completionBrief);
  const completionSignals = { sibling: /Untouched sibling.*sibling/.test(text), newCopy: /New copy.*plantedCopy/.test(text),
    cochange: /Untouched src\/partner/.test(text), sql: /SQL reader left unchecked[^\"]*reader\.ts/.test(text),
    coverage: /no recorded test executed changed lines/.test(text) };
  console.log('NATIVE_REUSE_COMPLETION_DIAGNOSTIC=' + JSON.stringify({ completionSignals,
    tests: receipt.completionBrief.tests, limitations: receipt.completionBrief.limitations }));
  assert(Object.values(completionSignals).every(Boolean), JSON.stringify({ completionSignals,
    tests: receipt.completionBrief.tests, limitations: receipt.completionBrief.limitations }));
  const issued = await getOrgPg().sql<{ subject: string; chars: number }[]>`SELECT subject, chars
    FROM harness_shared.code_intel_pushes WHERE workspace_id = ${workspace} AND owner_id = ${owner}
      AND subject::jsonb->>'workItem' = ${id} AND subject::jsonb->>'surface' = 'completion'`;
  assert(issued.length >= 3, JSON.stringify(issued));
  assert(issued.every(row => JSON.parse(row.subject).invocation && JSON.parse(row.subject).sourceVersion
    && JSON.parse(row.subject).indexVersion && row.chars > 0));
  const { REUSE_PROVIDER_POLICY, briefCodePoints } = await import('../reuse-brief-providers.ts');
  for (const row of issued) {
    const provider = JSON.parse(row.subject).provider as keyof typeof REUSE_PROVIDER_POLICY;
    assert(row.chars <= REUSE_PROVIDER_POLICY[provider].cap, JSON.stringify(row));
  }
  assert(briefCodePoints(JSON.stringify(receipt.completionBrief)) <= 3_000);
  const settled = await call('work_items:get', { id, harness: workspace, projection: { pick: ['results[].workItem.state'] } });
  assert.equal(settled.results?.[0]?.workItem.state, 'done');
  console.log('NATIVE_REUSE_API_PROOF=' + JSON.stringify({ workspace, fixtureWorkItem: id, baseline, handlerHash,
    sourceFingerprint: hash(await readFile(join(root, 'src/target.ts'), 'utf8')), transport: 'real-cli-http',
    completionSignals, issued, claimed, completion: receipt.completionBrief, terminal: true,
    scope: 'private current-source compiled operator and actual CLI actions; no production receipt or final shipment' }));
  } finally {
    if (claimOnly && !managed) await rm(root, { recursive: true, force: true });
  }
}
