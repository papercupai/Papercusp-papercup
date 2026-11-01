/** D087 prospective launcher. Default is request-free preparation; execution needs
 * exact live selection, independent vetting, an activation audit and a clean source.
 * A started marker is never removed, even after a crash or an invalid block.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { writeStdoutSync } from '../../../../scripts/lib/write-stdout-sync.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliEntry } from '../util/cli-entry';
import { zstdDecompressSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));
const defaultExperiment = 'session-tool-delivery-clean-runtime-candidate-20261023';
const fixtures = {
  [defaultExperiment]: 'packages/operator-core/lib/llm-testing/fixtures/tool-delivery-clean-runtime-candidate-20261023.json',
  'session-tool-delivery-clean-source-v2-20261023': 'packages/operator-core/lib/llm-testing/fixtures/tool-delivery-clean-source-v2-20261023.json',
  'session-tool-delivery-clean-source-v3-20261024': 'packages/operator-core/lib/llm-testing/fixtures/tool-delivery-clean-source-v3-20261024.json',
};
const planSlug = 'deterministic-tool-definition-delivery-2026-09-21';

/** Compare the definitions sent over JSON, including meaningful schema/guidance drift. */
export function assertCleanCohortCatalogDefinitions(actual, expected) {
  // Optional schema properties can be enumerable with value undefined. They are
  // absent from both the provider request and the persisted registration JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected,
    'Model-facing catalog request differs from preregistration.');
}

/** Freeze the captured graph, while admitting only explicit measurement changes. */
export function assertCleanCohortCapturedInputs({ captured, actual, amendment, fixture, portableSha256, readHash }) {
  // Earlier immutable captures predate the graph witness and remain historical.
  if (!captured) return;
  for (const key of ['installSha256', 'executableSha256', 'nodeVersion'])
    assert.equal(actual[key], captured[key], `Captured runtime input changed: ${key}`);
  assert.ok(Object.keys(captured.moduleHashes).length, 'Captured module census is empty.');
  const measurement = { ...amendment.addedFiles, ...Object.fromEntries(
    Object.entries(amendment.sourceReplacements).map(([path, pin]) => [path, pin.sha256])) };
  for (const [path, frozenHash] of Object.entries(captured.moduleHashes))
    assert.equal(readHash(path), measurement[path] ?? frozenHash, `Captured module changed: ${path}`);
  for (const [path, actualHash] of Object.entries(actual.moduleHashes)) {
    // The complete installed generation, including unloaded packages, is bound above.
    if (path.split('/').includes('node_modules')) continue;
    const expected = path === fixture ? portableSha256 : measurement[path] ?? captured.moduleHashes[path];
    assert.equal(actualHash, expected, `Unregistered loaded source: ${path}`);
  }
}

/** Only registered prospective identities are selectable; no arbitrary fixture path. */
export function parseCleanCohortArgs(argv) {
  assert.ok(argv.length >= 2 && argv.length <= 6 && argv.length % 2 === 0,
    'Pass retained-checkout private-directory [--registration experiment-id] [--execute exact-readiness.json].');
  let experimentId = defaultExperiment, readinessPath;
  const seen = new Set();
  for (let i = 2; i < argv.length; i += 2) {
    const option = argv[i], value = argv[i + 1];
    assert.ok(['--registration', '--execute'].includes(option) && !seen.has(option) && value,
      'Unknown, duplicate or incomplete cohort option.');
    seen.add(option);
    if (option === '--registration') experimentId = value;
    else readinessPath = value;
  }
  assert.ok(Object.hasOwn(fixtures, experimentId), 'Unregistered prospective cohort.');
  return { experimentId, fixture: fixtures[experimentId], readinessPath };
}

/** Pure gate, also exercised with hostile readiness records by the maintained tests. */
export function assertCleanCohortAuthority(registration, portableSha256, expected, live) {
  assert.equal(expected?.experimentId, registration.experiment.id, 'No exact prospective execution approval.');
  assert.equal(expected.portableSha256, portableSha256, 'Approved registration bytes differ.');
  assert.equal(expected.buildSha, live.buildSha, 'Expanded measurement reader is not loaded.');
  assert.equal(live.readerSourceSha256, registration.measurementAmendment.sourceReplacements[
    'packages/operator-core/lib/tool-delivery-acceptance.ts'].sha256, 'Expanded reader bytes differ.');
  assert.deepEqual(live.plan, expected.plan, 'Plan changed after approval.');
  assert.ok(Number.isSafeInteger(expected.plan.version) && /^[a-f0-9]{64}$/.test(expected.plan.contentHash));
  assert.deepEqual(live.audit, { seq: expected.auditSeq, version: expected.plan.version,
    contentHash: expected.plan.contentHash }, 'Activation audit does not cover current plan.');
  assert.equal(live.rubric.revision, expected.rubric.revision);
  assert.equal(live.rubric.criteriaHash, expected.rubric.criteriaHash);
  assert.equal(live.rubric.criteriaCount, 10, 'The full acceptance population must remain selected.');
  assert.deepEqual(live.rubric.selections, { 'R-6': registration.experiment.id, 'R-9': registration.experiment.id });
  assert.equal(live.vetting.satisfied, true);
  assert.equal(live.vetting.reason, 'current');
  assert.equal(live.vetting.attestedRevision, expected.rubric.revision);
  assert.equal(live.vetting.attestedCriteriaHash, expected.rubric.criteriaHash);
  assert.deepEqual(live.vetting.critique.critics, [expected.critic]);
  assert.ok(typeof live.implementer === 'string' && typeof expected.critic === 'string' && expected.critic !== live.implementer);
  assert.equal(live.r10.length, 2);
  assert.deepEqual(live.r10.map(row => row.specId).sort(), ['AUTO-BAR-R-10-P-013', 'AUTO-BAR-R-10-P-015']);
  for (const row of live.r10) {
    assert.equal(row.verdict, 'pass'); assert.deepEqual(row.wouldBlock, []);
    assert.equal(row.mechanicalProof.verdict, 'pass'); assert.deepEqual(row.mechanicalProof.gaps, []);
  }
}

/** wx makes concurrent launch or a crashed predecessor terminal for this identity. */
export function claimCleanCohort(directory, marker) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(directory, 'started.json'), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
}

function canonicalAuthority(expected) {
  assert.ok(Number.isSafeInteger(expected.auditSeq) && expected.auditSeq > 0);
  // The API reader runs on staging. This is a read-only authority check, not a
  // replacement recorder and not a request to the final-release host.
  const script = `
    const [p,r,a,t,d,w] = await Promise.all([
      tools.plans.get({slug:'${planSlug}',harness:'papercusp',heading:'Now'}),
      tools.rubrics.get({rubricRef:'acceptance-${planSlug}',detail:'full'}),
      tools.dev.pg_query({sql:"SELECT audit_seq,audited_plan_revision_seq,audited_plan_content_hash FROM harness_shared.plan_audits WHERE workspace_id='papercusp-workspace' AND plan_slug='${planSlug}' AND audit_kind='activation' AND audit_seq=${expected.auditSeq}"}),
      tools.plans.evaluate_spec_test_adequacy({slug:'${planSlug}',harness:'papercusp',specIds:['AUTO-BAR-R-10-P-013','AUTO-BAR-R-10-P-015'],includeDraft:true,detail:'summary'}),
      tools.dev.pipeline_position({path:'packages/operator-core/lib/tool-delivery-acceptance.ts',testClass:'operator-api'}),
      tools.coord.whoami({})]);
    if(!p.ok||!r.ok||a.truncated||!t.ok||!w.ownerId) throw Error('Authority read incomplete');
    const plan=p.results[0], row=r.results[0], audit=a.rows[0];
    if(!plan.ok||!row.ok||a.rows.length!==1) throw Error('Authority record absent');
    const serving=d.servingRuntimes.filter(x=>x.runtime==='staging-operator');
    if(serving.length!==1||!serving[0].containsChange||d.currentBuildTestRoute.readiness!=='ready') throw Error('Reader rollout incomplete');
    return {plan:{version:plan.version,contentHash:plan.contentHash},
      audit:{seq:audit.audit_seq,version:audit.audited_plan_revision_seq,contentHash:audit.audited_plan_content_hash},
      rubric:{revision:row.rubric.revision,criteriaHash:row.rubric.criteriaHash,criteriaCount:row.rubric.criteria.length,
        selections:Object.fromEntries(row.rubric.criteria.filter(c=>['R-6','R-9'].includes(c.barKey)).map(c=>[c.barKey,c.check?.experimentId]))},
      vetting:{satisfied:row.vetting.satisfied,reason:row.vetting.reason,attestedRevision:row.vetting.attestedRevision,
        attestedCriteriaHash:row.vetting.attestedCriteriaHash,critique:{critics:row.vetting.critique?.critics}},
      r10:t.rows.map(x=>({specId:x.specId,verdict:x.verdict,wouldBlock:x.wouldBlock,
        mechanicalProof:{verdict:x.mechanicalProof.verdict,gaps:x.mechanicalProof.gaps}})),
      buildSha:serving[0].buildSha,implementer:w.ownerId};`;
  const result = JSON.parse(execFileSync('ptool', ['code:run', '--url=http://127.0.0.1:3170',
    '--workspace=papercusp-workspace', '--harness=papercusp', '--script', script], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PAPERCUSP_MCP_PROXY: '0', PAPERCUSP_CONTEXT_TIER: 'full' }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(result.ok, true); assert.equal(result.partial, false);
  assert.ok(!result.summaryNotice?.truncated, 'Authority read was truncated.');
  return result.summary;
}

export async function main(argv = process.argv.slice(2)) {
  const { experimentId, fixture, readinessPath } = parseCleanCohortArgs(argv);
  const root = realpathSync(argv[0]), privateRoot = realpathSync(argv[1]);
  const controllerRoot = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
  assert.equal(realpathSync(process.cwd()), root);
  const within = path => { const rel = relative(root, realpathSync(path));
    return rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
  assert.equal(process.env.NODE_PATH ?? '', ''); assert.equal(process.env.NODE_OPTIONS ?? '', '');
  for (const key of ['PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', 'VERIFY_TAURI_SOURCE_RECEIPT']) assert.equal(process.env[key] ?? '', '');
  const loader = resolve(root, 'node_modules/tsx/dist/loader.mjs');
  assert.deepEqual(process.execArgv, ['--import', loader], 'Use only the exact local TS loader.');
  assert.ok(within(loader));
  const gitAt = (base, args, directory) => execFileSync('git', args, { cwd: directory ? resolve(base, directory) : base,
    timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const git = (args, directory) => gitAt(controllerRoot, args, directory);
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  const sourceHead = gitAt(root, ['rev-parse', 'HEAD']).toString().trim();
  const bytes = readFileSync(resolve(controllerRoot, fixture)), registration = JSON.parse(bytes);
  const separateController = registration.executionPolicy.measurementController === 'separate-root';
  assert.ok(separateController ? controllerRoot !== root : controllerRoot === root,
    'Separate source/controller execution must be explicitly preregistered.');
  assert.equal(sha(git(['show', `${head}:${fixture}`])), sha(bytes), 'Uncommitted registration.');
  assert.equal(registration.experiment.id, experimentId);
  assert.equal(registration.executionPolicy.requireCleanRuntime, true);
  assert.equal(registration.executionPolicy.launcherPath, relative(controllerRoot, fileURLToPath(import.meta.url)).split(sep).join('/'));
  const directory = resolve(privateRoot, registration.custodyPaths.receiptDirectory);
  const privateRelative = relative(root, privateRoot);
  assert.ok(isAbsolute(privateRelative) || privateRelative === '..' || privateRelative.startsWith(`..${sep}`),
    'Receipts must be outside the retained source.');
  const controllerPrivateRelative = relative(controllerRoot, privateRoot);
  assert.ok(isAbsolute(controllerPrivateRelative) || controllerPrivateRelative === '..' || controllerPrivateRelative.startsWith(`..${sep}`),
    'Receipts must be outside the measurement controller.');
  assert.equal(relative(privateRoot, directory), registration.custodyPaths.receiptDirectory);
  assert.ok(!existsSync(resolve(directory, 'started.json')), 'Started cohort: reconcile, never replay.');
  const raw = readFileSync(resolve(privateRoot, registration.custodyPaths.privateCaptureFile));
  assert.equal(sha(raw), registration.capture.privateCapture.originalSha256);
  const frozen = JSON.parse(raw);
  if (separateController) {
    assert.equal(sourceHead, frozen.sourcePins.head, 'Captured source checkout commit changed.');
    assert.equal(sourceHead, frozen.capture.cleanBoundary.commit, 'Captured boundary commit changed.');
  }
  const guard = await import(pathToFileURL(resolve(controllerRoot, 'packages/operator-core/lib/tool-delivery-clean-runtime.ts')));
  const imports = guard.installToolDeliveryModuleGuard(root, separateController ? controllerRoot : undefined);
  const controllerUrls = separateController ? imports.controllerUrls : imports.urls;
  controllerUrls.add(import.meta.url); imports.urls.add(pathToFileURL(loader).href);
  // The guard and its dependency verifier loaded before the resolve hook existed.
  for (const path of ['packages/operator-core/lib/tool-delivery-clean-runtime.ts',
    'packages/operator-core/lib/dependency-generation-proof.ts']) controllerUrls.add(pathToFileURL(resolve(controllerRoot, path)).href);
  try {
    const load = path => import(pathToFileURL(resolve(root, path)));
    const acceptance = await import(pathToFileURL(resolve(controllerRoot, 'packages/operator-core/lib/tool-delivery-acceptance.ts')));
    const pins = acceptance.toolDeliveryCommittedSubmodules(registration);
    const readSource = (path, ref) => ref ? acceptance.readToolDeliveryCommittedSource(path, ref, pins, git) : readFileSync(resolve(controllerRoot, path));
    const custody = acceptance.verifyToolDeliverySourceCustody({ registration, privateCapture: raw, buildSha: head, readSource });
    assert.equal(custody.verified, true, custody.reason);
    const { runScenario } = await load('libs/testing-shell/src/llm/runner.ts');
    const { operatorRunnerDeps } = await load('packages/operator-core/lib/llm-testing/deps.ts');
    const { getScenario } = await load('packages/operator-core/lib/llm-testing/scenarios/index.ts');
    const ledger = await load('packages/operator-core/lib/llm-testing/test-run-ledger.ts');
    await load('packages/operator-core/lib/runtime-vintage.ts');
    const { getLongLivedAdminPool } = await load('packages/operator-core/lib/long-lived-admin-pool.ts');
    const { buildShippingSeedCatalog } = await load('packages/operator-core/lib/llm-testing/targets/su-compact-catalog.ts');
    const { catalogToResponsesTools } = await load('packages/operator-core/lib/llm-testing/targets/codex-responses-tool-loop.ts');
    // The original capture warmed this committed source component. The actual
    // controller entrypoint is independently recorded in controller.moduleHashes.
    if (separateController) await load(registration.executionPolicy.launcherPath);
    const sql = getLongLivedAdminPool('llm-testing-storage', { max: 2, prepare: false });
    for (const arm of ['compact', 'full']) {
      const built = await buildShippingSeedCatalog(arm);
      assertCleanCohortCatalogDefinitions(catalogToResponsesTools(built.catalog),
        registration.experiment.manifestContract[`${arm}Definitions`]);
      assert.deepEqual([...built.catalog.canonicalBySanitized.entries()], registration.experiment.manifestContract.canonicalBySanitized);
    }
    const expectedBlocks = frozen.configuration.armOrder.flatMap(b => b.arms.map(arm => ({ scenario: b.scenario,
      arm, variantId: frozen.variants[arm].id })));
    assert.equal(expectedBlocks.length, 10); assert.equal(frozen.configuration.replicationsPerArm, 3);
    assert.equal(frozen.configuration.neverRetryMeasuredReplication, true);
    for (const b of expectedBlocks) assert.equal(getScenario(b.scenario).transport, 'in-process');
    const capture = async () => {
      const source = await guard.captureToolDeliveryCleanBoundary({ sourceRoot: root, registration, moduleUrls: [...imports.urls] });
      if (!separateController) return source;
      const controller = await guard.captureToolDeliveryCleanBoundary({ sourceRoot: controllerRoot, registration,
        moduleUrls: [...controllerUrls] });
      const { pid, processStartTicks, sut, monotonicNs, controller: nested, ...pin } = controller;
      return { ...source, controller: { ...pin, entrypoint: registration.executionPolicy.launcherPath } };
    };
    const initial = await capture();
    assertCleanCohortCapturedInputs({ captured: frozen.capture?.cleanBoundary, actual: initial,
      amendment: separateController ? { addedFiles: {}, sourceReplacements: {} } : registration.measurementAmendment,
      fixture, portableSha256: sha(bytes),
      readHash: path => sha(readFileSync(guard.toolDeliveryModuleFile(root, pathToFileURL(resolve(root, path)).href))) });
    const { pid, processStartTicks, sut, monotonicNs, ...pin } = initial;
    const check = boundary => {
      if (separateController) {
        assert.equal(boundary.commit, frozen.sourcePins.head);
        assert.equal(boundary.controller?.entrypoint, registration.executionPolicy.launcherPath);
      }
      assert.equal(guard.validateToolDeliveryCleanBoundary(boundary, pin), undefined);
      assert.equal(guard.validateToolDeliveryCleanCensus(boundary, registration), undefined); };
    check(initial);
    const prior = await sql`SELECT id FROM harness_shared.llm_test_runs WHERE telemetry_json->>'variantId' = ANY(${Object.values(registration.experiment.arms)}) LIMIT 1`;
    assert.equal(prior.length, 0, 'Candidate rows already exist: never replay.');
    if (!readinessPath) return { status: 'PREPARATION_ONLY_NO_EXECUTION_AUTHORITY', realModelCalls: 0,
      head, sourceHead, portableSha256: sha(bytes), pinSha256: digest(pin) };
    const expected = JSON.parse(readFileSync(realpathSync(readinessPath), 'utf8'));
    const live = canonicalAuthority(expected);
    const readerCustody = acceptance.verifyToolDeliverySourceCustody({ registration, privateCapture: raw,
      buildSha: live.buildSha, readSource });
    assert.equal(readerCustody.verified, true, `Expanded reader rollout: ${readerCustody.reason}`);
    live.readerSourceSha256 = sha(readSource('packages/operator-core/lib/tool-delivery-acceptance.ts', live.buildSha));
    assertCleanCohortAuthority(registration, sha(bytes), expected, live);
    const runtime = await ledger.prepareLlmScenarioRuntimeReader(resolve(root, registration.sourcePins.scenarioPaths[expectedBlocks[0].scenario]), 'in-process');
    // Warm runtime-vintage imports before the final module census. The graph must
    // already be complete; a new dependency after this point invalidates the cohort.
    assert.equal(digest((await capture()).moduleHashes), digest(initial.moduleHashes), 'Runtime preparation added unpinned modules.');
    check(await capture());
    claimCleanCohort(directory, { at: new Date().toISOString(), experimentId: registration.experiment.id,
      privateSha256: sha(raw), portableSha256: sha(bytes), buildSha: head, sourceBuildSha: sourceHead,
      pinSha256: digest(pin), readiness: expected });
    const blocks = [], receipt = [], deps = operatorRunnerDeps({ persist: true });
    for (const [blockIndex, slot] of expectedBlocks.entries()) {
      const path = resolve(root, registration.sourcePins.scenarioPaths[slot.scenario]);
      const beforeLedger = await ledger.beginLlmScenarioLedger(path, runtime);
      assert.equal(beforeLedger.worktree?.porcelain, '');
      assert.equal(beforeLedger.runtime.status, 'captured', 'Original recorder runtime witness missing.');
      const before = await capture(); check(before);
      const report = await runScenario(getScenario(slot.scenario), {
        ...Object.fromEntries(['sutModel', 'judgeModel', 'simModel'].map(key => [key, frozen.configuration[key]])),
        forceRepeat: 3, scenarioFilePath: path, variant: frozen.variants[slot.arm],
      }, deps);
      writeFileSync(resolve(directory, `${slot.scenario}-${slot.arm}.json`), JSON.stringify(report), { flag: 'wx', mode: 0o600 });
      const after = await capture(); check(after);
      const ids = report.runs.map(run => run.summary.runId);
      assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3);
      const rows = await sql`SELECT id,transcript_raw_zstd FROM harness_shared.llm_test_runs WHERE id = ANY(${ids})`;
      assert.equal(rows.length, 3, 'Persistence incomplete: reconcile report, never rerun.');
      const manifests = ids.map(runId => ({ runId, manifests: JSON.parse(zstdDecompressSync(rows.find(r => r.id === runId).transcript_raw_zstd,
        { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')).filter(event => event.name === 'tool_definition_manifest') }));
      assert.ok(manifests.every(row => row.manifests.length > 0));
      const block = { ...slot, runIds: ids, before, after, requestManifestSha256: digest(manifests) };
      const testRunId = await ledger.recordLlmScenarioTestRun(report, path, beforeLedger, { experimentId: registration.experiment.id, blockIndex, block });
      assert.ok(Number.isSafeInteger(testRunId) && testRunId > 0, 'Original recorder insert failed: never synthesize or retry.');
      blocks.push(block); receipt.push({ ...slot, ids, statuses: report.runs.map(run => run.status), testRunId });
      writeFileSync(resolve(directory, 'clean-runtime-receipts.json'), JSON.stringify({ pin, blocks }), { mode: 0o600 });
      writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
      console.log('CLEAN_COHORT_BLOCK_COMPLETE', JSON.stringify({ blockIndex, ...slot, ids, testRunId }));
    }
    check(await capture());
    return { status: 'EXECUTION_COMPLETE_NOT_ACCEPTANCE', blocks: blocks.length, attempts: receipt.flatMap(row => row.ids).length };
  } finally { imports.deregister(); }
}

if (isCliEntry(import.meta.url)) {
  // Synchronous write: process.exit() would truncate a buffered console.log to a pipe.
  main().then(result => { writeStdoutSync(`${JSON.stringify(result)}\n`); process.exit(0); },
    error => { console.error(error.message); process.exit(1); });
}
