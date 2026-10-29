/** Required native P010 BAR: real CLI → current operator → compiler report. */
import { fork, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nativeCliCall, nativeCliTestTimeout, nativeFixtureProcess, scopedNativeFixtureArgs } from './native-cli.fixture';
import './scoped-contracts.e2e.test';
import { privateReuseTestEnvironment } from './__fixtures__/reuse-api-journey';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

/** Resolve HEAD inside the owning repository, including test-config's submodule. */
function requireCommittedNativeSource(root: string, path: string, expectedHash: string) {
  const owner = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(join(root, path)), encoding: 'utf8', timeout: 10_000,
  });
  expect(owner.status, `Native source repository unavailable: ${path}`).toBe(0);
  const repository = owner.stdout.trim();
  const blob = spawnSync('git', ['show', `HEAD:${relative(repository, join(root, path))}`], {
    cwd: repository, encoding: 'buffer', timeout: 10_000,
  });
  expect(blob.status, `Native source must be committed before replay: ${path}`).toBe(0);
  expect(createHash('sha256').update(blob.stdout).digest('hex'),
    `Native source differs from its repository HEAD: ${path}; let git-sync commit it before replay`)
    .toBe(expectedHash);
}

describe('private native reuse evidence routing', () => {
  it('checks the owning repository HEAD and refuses an edited nested fixture before native startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-committed-source-'));
    const nested = join(root, 'nested');
    mkdirSync(nested);
    try {
      const source = 'export const fixture = 1;\n';
      writeFileSync(join(nested, 'fixture.ts'), source);
      for (const args of [['init', '-q'], ['add', 'fixture.ts'],
        ['-c', 'user.name=Native fixture', '-c', 'user.email=fixture@example.invalid',
          '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline']]) {
        expect(spawnSync('git', args, { cwd: nested, encoding: 'utf8' }).status).toBe(0);
      }
      const hash = (text: string) => createHash('sha256').update(text).digest('hex');
      expect(() => requireCommittedNativeSource(root, 'nested/fixture.ts', hash(source))).not.toThrow();
      writeFileSync(join(nested, 'fixture.ts'), source + '// edited\n');
      expect(() => requireCommittedNativeSource(root, 'nested/fixture.ts', hash(source + '// edited\n')))
        .toThrow('Native source differs from its repository HEAD');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('binds the inner reporter to its private reader while preserving the parent evidence environment', () => {
    const parent = { HARNESS_ADMIN_DATABASE_URL: 'postgresql://fixture:private@127.0.0.1:42577/papercusp',
      PAPERCUSP_PG_PORT: '42577', PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://parent@localhost:5432/ledger',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'parent-workspace', PAPERCUSP_TEST_RUN_HARNESS: 'papercusp' };
    const selected = privateReuseTestEnvironment(parent, 'test-runtime-routing', '/private/root');
    expect(selected.PAPERCUSP_TEST_RUNS_DB_URL).toBe(parent.HARNESS_ADMIN_DATABASE_URL);
    expect(selected.PAPERCUSP_TEST_RUN_WORKSPACE).toBe('test-runtime-routing');
    expect(selected.PAPERCUSP_TEST_RUN_HARNESS).toBe('test-runtime-routing');
    expect(selected.PAPERCUSP_TEST_RUN_RECEIPT_FILE).toBe('/private/root/reports/inner-test-receipt.jsonl');
    expect(parent.PAPERCUSP_TEST_RUN_WORKSPACE).toBe('parent-workspace');
    expect(parent.PAPERCUSP_TEST_RUNS_DB_URL).toBe('postgresql://parent@localhost:5432/ledger');
    expect(() => privateReuseTestEnvironment({ ...parent, PAPERCUSP_PG_PORT: '42578' },
      'test-runtime-routing', '/private/root')).toThrow('private product database');
    expect(() => privateReuseTestEnvironment(parent, 'papercusp', '/private/root')).toThrow('Private reuse workspace');
  });
});

const baseUrl = process.env.OPERATOR_BASE_URL;
const taskBriefItem = process.env.NATIVE_TASK_BRIEF_ITEM;
const planningPlan = process.env.NATIVE_PLANNING_PLAN;

type NativeFixtureTiming = {
  timeoutMs?: number;
  elapsedMs?: number;
  remainingMs?: number;
  phaseCount?: number;
  phases?: Array<{ elapsedMs: number; line: string }>;
};

/** Keep a child failure actionable without embedding every phase in Vitest's saved error tail. */
function nativeFixtureFailureDiagnostic(
  label: string,
  result: Awaited<ReturnType<typeof nativeFixtureProcess>>,
): string {
  const timingLine = result.output.split('\n').find(line => line.startsWith('NATIVE_FIXTURE_TIMING='));
  let timing: NativeFixtureTiming | null = null;
  try {
    if (timingLine) timing = JSON.parse(timingLine.slice('NATIVE_FIXTURE_TIMING='.length)) as NativeFixtureTiming;
  } catch { /* Preserve the bounded child tail even if timing evidence is malformed. */ }
  const tailMarker = result.output.lastIndexOf('\ntail:\n');
  const childOutput = tailMarker < 0 ? result.output : result.output.slice(tailMarker + '\ntail:\n'.length);
  const timingSummary = timing && {
    timeoutMs: timing.timeoutMs,
    elapsedMs: timing.elapsedMs,
    remainingMs: timing.remainingMs,
    phaseCount: timing.phaseCount,
    finalPhases: timing.phases?.slice(-4).map(phase => ({
      elapsedMs: phase.elapsedMs,
      line: phase.line.slice(0, 240),
    })),
  };
  return `${label} child exit=${JSON.stringify({ code: result.code, signal: result.signal, timing: timingSummary })}\n` +
    `primary child failure:\n${result.failureOutput}\n` +
    `child output tail:\n${childOutput.slice(-4_000)}`;
}

/** bundle-host.sh stall window and ceiling; a fresh host bundle measured ~83s unloaded. */
const hostBundleStallMs = 120_000;
const hostBundleMaxMs = 360_000;
/** Reuse journeys run through the isolated proof with PHASE deadlines: private PG
 * boot and its ~1,400 migrations get their own progress-aware bootstrap budget,
 * so they never consume the fixture's 180s execute allowance (WI-6554700010042656:
 * a single 180s clock spent ~110s on migrations and killed the worker mid-import). */
const nativeIsolatedWorker = isolatedWorkerOptions(180_000);
const privateJourneyTimeoutMs = hostBundleMaxMs + Math.max(180_000, nativeIsolatedWorker.testTimeoutMs) + 20_000;

/**
 * One host-handler bundle per file (EI-27225287785052203): each of six journeys used to pay a
 * fresh bundle under a fixed 120s deadline. A bundle is reused only while every hashed journey
 * source is unchanged since it was built; a failed build is not reused.
 */
let hostHandler: { key: string; build: Promise<{ handlerPath: string; handlerHash: string }> } | undefined;
const hostHandlerRoots: string[] = [];
afterAll(() => { for (const dir of hostHandlerRoots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function privateHostHandler(root: string, sourceKey: string) {
  if (hostHandler?.key === sourceKey) return hostHandler.build;
  const artifactRoot = mkdtempSync(join(tmpdir(), 'native-incident-handler-'));
  hostHandlerRoots.push(artifactRoot);
  const handlerPath = join(artifactRoot, 'handler.mjs');
  const build = (async () => {
    // Keep the producer's own step journal and evidence; kill its entire process group on expiry.
    const result = await nativeFixtureProcess('bash',
      [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/host-handler.ts', handlerPath], {
        cwd: root, env: process.env, timeoutMs: hostBundleStallMs, maxMs: hostBundleMaxMs,
        stepJournal: `${handlerPath}.build-steps.jsonl`,
      });
    expect(result.code, nativeFixtureFailureDiagnostic('Host bundle', result)).toBe(0);
    return { handlerPath, handlerHash: createHash('sha256').update(readFileSync(handlerPath)).digest('hex') };
  })();
  const entry = { key: sourceKey, build };
  hostHandler = entry;
  build.catch(() => { if (hostHandler === entry) hostHandler = undefined; });
  return build;
}

async function privateNativeJourney(mode: 'incident' | 'task-brief' | 'first-touch' | 'grep' | 'reuse' | 'reuse-claim',
  recordRuntime?: (runId: string) => void) {
    const root = resolve(import.meta.dirname, '../../../..');
    const sourcePaths = ['packages/operator-core/lib/code-intelligence/__fixtures__/reuse-api-journey.ts',
      'packages/operator-core/lib/code-intelligence/clone-brief-provider.ts',
      'packages/operator-core/lib/code-intelligence/change-history.ts',
      'packages/operator-core/lib/code-intelligence/reuse-brief-providers.ts',
      'packages/operator-core/lib/code-intelligence/reuse-authoring.ts',
      'packages/operator-core/lib/code-intelligence/push-channel.ts',
      'packages/operator-core/lib/code-intelligence/push-snapshot.ts',
      'packages/operator-core/lib/code-intelligence/__fixtures__/incident-api-client.ts',
      'packages/operator-core/lib/edit-attribution.ts',
      'apps/operator/scripts/hooks/inject/core.mjs',
      'apps/operator/scripts/hooks/inject/index.mjs',
      'apps/operator/scripts/hooks/inject/ports.mjs',
      'apps/operator/scripts/hooks/inject/adapters/codex.mjs',
      'apps/operator/scripts/hooks/inject/delivery-ledger.mjs',
      'packages/operator-core/lib/desktop-install/papercusp-files.ts',
      'packages/operator-core/lib/desktop-install/install-provenance.ts',
      'apps/operator/scripts/hooks/cc/posttooluse-required-field-strand-nudge.mjs',
      'scripts/check-required-field-strands.mjs',
      'scripts/check-behavioural-strands.mjs',
      'packages/operator-core/lib/endpoint-route/routes/agent-mcp/mid-turn-context.ts',
      'packages/operator-core/lib/code-intelligence/task-brief.ts',
      'packages/operator-core/lib/code-intelligence/packer-facade.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/declare-intent.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/orient.ts',
      'packages/operator-core/lib/agent-tools/work_items/complete.ts'];
    // Mode-only sources are checked per journey but do not select the shared host bundle.
    const handlerSourceCount = sourcePaths.length;
    if (mode.startsWith('reuse')) sourcePaths.push('libs/test-config/src/test-coverage-provider.ts',
      'libs/test-config/src/admin-test-runs-reporter.ts',
      'libs/test-config/src/test-coverage-map.ts', 'libs/test-config/src/vitest-config.ts');
    const sourceHashes = () => Object.fromEntries(sourcePaths.map(path =>
      [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
    const beforeHashes = sourceHashes();
    // Native Node children execute committed source under the inherited guard.
    // Refuse before bundling/allocating PG if their fixture would be substituted.
    const committedPaths = ['packages/operator-core/lib/code-intelligence/__fixtures__/incident-api-client.ts',
      ...(mode.startsWith('reuse') ? ['packages/operator-core/lib/code-intelligence/__fixtures__/reuse-api-journey.ts',
        'packages/operator-core/lib/code-intelligence/change-history.ts',
        'libs/test-config/src/test-coverage-provider.ts', 'libs/test-config/src/admin-test-runs-reporter.ts',
        'libs/test-config/src/test-coverage-map.ts', 'libs/test-config/src/vitest-config.ts'] : [])];
    for (const path of committedPaths) requireCommittedNativeSource(root, path, beforeHashes[path]!);
    // Prepare the maintained ESM handler artifact before allocating private PG.
    // A direct tsx import of apps/operator's CommonJS entry is intentionally
    // refused by the committed-source guard.
    const { handlerPath, handlerHash } = await privateHostHandler(root, createHash('sha256')
      .update(JSON.stringify(sourcePaths.slice(0, handlerSourceCount).map(path => [path, beforeHashes[path]])))
      .digest('hex'));
    // The fixture must execute exactly the bundle that was hashed when it was built.
    expect(createHash('sha256').update(readFileSync(handlerPath)).digest('hex')).toBe(handlerHash);
    let pendingStage = '';
    let result: Awaited<ReturnType<typeof nativeFixtureProcess>>;
    const workerArgs = ['--isolated-runtime=operator-api', '--', process.execPath,
        ...scopedNativeFixtureArgs(new URL('./__fixtures__/incident-api-client.ts', import.meta.url).href,
          'runNativeIncidentApi', [join(homedir(), '.papercusp/vendor/repomix'),
            join(homedir(), '.papercusp/vendor/lsp'), handlerPath, handlerHash, mode])];
    if (mode.startsWith('reuse')) {
      expect(recordRuntime, 'Reuse acceptance requires a retained original runtime receipt').toBeTypeOf('function');
      const runId = await recordIsolatedIntegrationProof({ root,
        filePath: 'packages/operator-core/lib/code-intelligence/native-ecosystem.e2e.test.ts',
        sourcePaths: [...sourcePaths, 'scripts/with-test-pg.mjs',
          'packages/operator-core/lib/code-intelligence/native-cli.fixture.ts',
          'packages/operator-core/test/isolated-integration-proof.ts'],
        execute: async (observe, evidenceDir) => {
          const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: '/dev/shm', PC_ISOLATED_RUNTIME_PROOF: '1' };
          delete env.PC_HEAVY_PREEMPT_READY_FILE;
          delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
          const child = fork(join(root, 'scripts/with-test-pg.mjs'), workerArgs,
            { cwd: root, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
          observe(child);
          const captured = await captureIsolatedWorker(child, evidenceDir, nativeIsolatedWorker);
          result = { code: captured.code, signal: captured.signal, output: captured.output,
            failureOutput: isolatedWorkerFailureDetail(captured.output, captured) };
          expect(captured, result.failureOutput).toMatchObject({ code: 0, signal: null,
            timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        },
      });
      recordRuntime!(runId);
    } else {
      result = await nativeFixtureProcess(process.execPath, [join(root, 'scripts/with-test-pg.mjs'), ...workerArgs], {
        cwd: root, env: { ...process.env, TMPDIR: '/dev/shm' }, timeoutMs: 180_000,
        onOutput: (text, timing) => {
          const lines = (pendingStage + text).split('\n');
          pendingStage = lines.pop()!.slice(-2_000);
          for (const line of lines) {
            if (/^NATIVE_REUSE_(?:BINDING|COMPLETION)_DIAGNOSTIC=/.test(line)) writeSync(2, line + '\n');
            if (line.startsWith('NATIVE_INCIDENT_API_STAGE=')) writeSync(2, `NATIVE_INCIDENT_API_PROGRESS=${JSON.stringify({
              stage: line.slice('NATIVE_INCIDENT_API_STAGE='.length), ...timing })}\n`);
          }
        },
      });
    }
    expect(result!.code, nativeFixtureFailureDiagnostic('Private fixture', result!)).toBe(0);
    const prefix = mode === 'reuse-claim' ? 'NATIVE_REUSE_CLAIM_API_PROOF='
      : mode === 'reuse' ? 'NATIVE_REUSE_API_PROOF='
      : mode === 'incident' ? 'NATIVE_INCIDENT_API_PROOF='
      : mode === 'first-touch' ? 'NATIVE_FIRST_TOUCH_API_PROOF='
      : mode === 'grep' ? 'NATIVE_GREP_API_PROOF=' : 'NATIVE_TASK_BRIEF_API_PROOF=';
    const line = result!.output.split('\n').find(row => row.startsWith(prefix));
    expect(line, result!.output).toBeDefined();
    const proof = JSON.parse(line!.slice(prefix.length));
    const afterHashes = sourceHashes();
    expect(afterHashes).toEqual(beforeHashes);
    writeSync(2, `${mode === 'incident' ? 'NATIVE_P038_RUNTIME_PROOF'
      : mode === 'first-touch' ? 'NATIVE_P036_RUNTIME_PROOF'
      : mode === 'grep' ? 'NATIVE_P035_RUNTIME_PROOF' : 'NATIVE_P039_RUNTIME_PROOF'}=${JSON.stringify({ ...proof, beforeHashes, afterHashes })}\n`);
    return proof;
}

describe('native P010 private operator completion reuse delivery', () => {
  it('delivers sibling, new copy, co-change, SQL reader and changed-line coverage through actual CLI completion', async (context) => {
    const proof = await privateNativeJourney('reuse', runId => {
      Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    });
    expect(proof).toMatchObject({ transport: 'real-cli-http', terminal: true,
      completionSignals: { sibling: true, newCopy: true, cochange: true, sql: true, coverage: true },
      scope: expect.stringContaining('private current-source') });
    expect(proof.handlerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.issued.length).toBeGreaterThanOrEqual(3);
  }, privateJourneyTimeoutMs);
});

describe('native P010 controlled CLI claim reuse delivery', () => {
  it('preserves the anchored base and issues five capped providers with actual controlled edit provenance', async (context) => {
    const proof = await privateNativeJourney('reuse-claim', runId => {
      Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    });
    expect(proof).toMatchObject({ transport: 'real-cli-http',
      expectedProviders: ['clones', 'cochange', 'provenance', 'sql', 'coverage'],
      scope: expect.stringContaining('controlled private current-source CLI fixture') });
    expect(proof.controlledSession.id).toBeGreaterThan(0);
    expect(proof.issued).toHaveLength(5);
  }, privateJourneyTimeoutMs);
});

describe('native P035 private operator installed grep answer', () => {
  it('lets real rg finish, supplies the resolved alias caller and stays quiet for an unresolved symbol', async () => {
    const proof = await privateNativeJourney('grep');
    expect(proof).toMatchObject({ transport: 'real-cli-http', duplicateSuppressed: true,
      unresolvedSuppressed: true, shell: { status: 0, stdout: expect.stringContaining('firstTouchTarget') },
      ledger: { subject: 'firstTouchTarget' },
      installed: { nodeOptions: '', envelope: { hookSpecificOutput: {
        hookEventName: 'PostToolUse', additionalContext: expect.stringContaining('Code intelligence (grep)') } } },
      scope: expect.stringContaining('no live Codex model session'),
    });
  }, privateJourneyTimeoutMs);
});

describe('native P036 private operator installed first-touch Read', () => {
  it('delivers the snapshot brief through fresh installed hook processes and suppresses a second Read', async () => {
    const proof = await privateNativeJourney('first-touch');
    expect(proof).toMatchObject({ transport: 'real-cli-http', readPath: 'a-target.ts',
      duplicateSuppressed: true, ledger: { subject: 'a-target.ts' },
      deliveryBoundary: 'installed Codex dispatcher/native PostToolUse event to stdout context envelope',
      installed: { nodeOptions: '', processes: expect.any(Number),
        envelope: { hookSpecificOutput: { hookEventName: 'PostToolUse',
          additionalContext: expect.stringContaining('Code intelligence (first-touch)') } } },
      scope: expect.stringContaining('no live Codex model session'),
    });
  }, privateJourneyTimeoutMs);
});

describe('native P018 private operator CLI incident claim and resume', () => {
  it('carries an actual failed assertion and compiler candidate, then clears the incident after a passing rerun', async () => {
    const proof = await privateNativeJourney('incident');
    expect(proof).toMatchObject({
      transport: 'real-cli-http', failure: 'actual-node-assertion', staticCandidate: true,
      cause: 'unknown', runtimeExecution: 'unmeasured', resume: 'current', repaired: true,
      push: { duplicateSuppressed: true, attribution: { status: 'measured',
        recentEdits: [expect.objectContaining({ path: 'a-target.ts', symbols: [{ name: 'incidentTarget', line: 1 }] })] },
        handlerHash: expect.stringMatching(/^[a-f0-9]{64}$/), observationProducer: 'maintained collector and delivery ledger with controlled before image',
        deliveryBoundary: 'installed Codex dispatcher/native PostToolUse event to stdout context envelope',
        installed: { nodeOptions: '', processes: expect.any(Number),
          envelope: { hookSpecificOutput: { hookEventName: 'PostToolUse',
            additionalContext: expect.stringContaining('Code intelligence (incident)') } } },
        scope: expect.stringContaining('private current-source installed dispatcher replay') },
    });
  // The build and private journey have separate producer deadlines. The test
  // deadline must allow both plus the maintained process-group exit fence.
  }, privateJourneyTimeoutMs);
});

describe('native P039 private operator intent and completion briefs', () => {
  it('delivers no-claim declare/orient scope and a pre-review receipt without inventing test execution', async () => {
    const proof = await privateNativeJourney('task-brief');
    expect(proof).toMatchObject({ transport: 'real-cli-http', noClaimBeforeIntent: true,
      declare: { status: 'current', scope: { paths: ['a-target.ts', 'b-consumer.ts', 'target.test.ts'] } },
      orient: { status: 'current' }, heldClaimSuppressed: true,
      completion: { phase: 'pre-review', status: 'measured', executionCoverage: 'unmeasured',
        changes: [expect.objectContaining({ file: 'a-target.ts', symbol: 'briefTarget' })],
        tests: [expect.objectContaining({ path: 'target.test.ts', execution: 'not-recorded-in-bound-run' })],
        testsWithoutRunEvidence: ['target.test.ts'] }, terminal: true,
    });
  }, privateJourneyTimeoutMs);
});

describe.runIf(Boolean(baseUrl && planningPlan))('native P013 real CLI graph planning advice', () => {
  it('orders scoped producer/consumer references and reports overlap without changing live assignments or file claims', () => {
    const identity = call('coord:whoami', {});
    const producer = 'packages/operator-core/lib/agent-tools/plans/plan-dag-parallelism.ts';
    const consumer = 'packages/operator-core/lib/agent-tools/plans/lint.ts';
    const shared = 'packages/operator-core/lib/agent-tools/plans/native-planning-advice.integration.test.ts';
    const itemIds = (process.env.NATIVE_PLANNING_ITEMS ?? 'P-019,P-025').split(',');
    const itemArgs = { slug: planningPlan, harness: 'papercusp', itemIds,
      projection: { pick: ['items[].item.id', 'items[].item.storedStatus', 'items[].item.blockedBy',
        'items[].coverage.workers', 'items[].coverage.holder.ownerId'] } };
    const before = call('plans:items', itemArgs);
    expect(before.items).toHaveLength(2);
    // A completed reference legitimately has no current holder. Keep at least
    // one caller-owned lane, and preserve the measured ownership of both labels.
    expect(before.items.some((row: { coverage?: { workers?: string[] } }) =>
      row.coverage?.workers?.includes(identity.ownerId)), `Planning fixture needs a current caller-held item: ${JSON.stringify(before)}`).toBe(true);
    const activeItems = before.items.filter((row: { item: { storedStatus: string } }) =>
      !['done', 'dropped'].includes(row.item.storedStatus));
    const expectedWorkers = new Map<string, string[]>(activeItems.map((row: {
      item: { id: string }; coverage?: { workers?: string[] };
    }) => [row.item.id, row.coverage?.workers ?? []]));
    const claimArgs = { paths: [producer, consumer, shared],
      projection: { pick: ['active_locks[].lock_id', 'active_locks[].path', 'active_locks[].owner',
        'active_locks[].intent', 'active_locks[].coordination_domain'] } };
    const claims = call('locks:queue', claimArgs);
    for (const path of [consumer, 'packages/operator-core/lib/code-intelligence/first-party-callers.ts',
      'packages/operator-core/lib/code-intelligence/first-party-traversal.ts']) {
      const route = projectedRoute({ path, testClass: 'operator-api',
        projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
      expect(route.currentBuildTestRoute.readiness).toBe('ready');
      expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
        row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    }
    // These held IDs are reference task labels for the caller-supplied code scope.
    // The advisory must not rewrite their authoritative paths or dependencies.
    const advice = (reverse: boolean) => call('plans:lint', { slug: planningPlan, harness: 'papercusp',
      codeScope: { symbol: 'nativePlanGraphAdvice', file: producer, paths: [producer, consumer], taskPaths: [
        { itemId: itemIds[0], paths: [reverse ? consumer : producer, shared] },
        { itemId: itemIds[1], paths: [reverse ? producer : consumer, shared] },
      ] }, projection: { pick: ['results[].ok', 'results[].report.codeAdvice.status',
        'results[].report.codeAdvice.ordering', 'results[].report.codeAdvice.proposedOrder',
        'results[].report.codeAdvice.overlaps', 'results[].report.codeAdvice.scope.repositoryId',
        'results[].report.codeAdvice.ownership[].itemId', 'results[].report.codeAdvice.ownership[].coverage.workers',
        'results[].report.codeAdvice.fileClaims.status'] } }).results[0].report.codeAdvice;
    for (const reverse of [false, true]) {
      const result = advice(reverse);
      expect(result.status, JSON.stringify(result)).toBe('measured');
      const [first, second] = reverse ? [...itemIds].reverse() : itemIds;
      if (activeItems.length === itemIds.length) {
        expect(result.ordering).toContainEqual(expect.objectContaining({ producer: first, consumer: second,
          sourcePath: consumer, targetPath: producer }));
        expect(result.proposedOrder.indexOf(first)).toBeLessThan(result.proposedOrder.indexOf(second));
        expect(result.overlaps).toContainEqual({ items: itemIds, paths: [shared] });
      } else {
        // Completed tasks are excluded by the maintained planner. Verify that
        // exclusion instead of resurrecting a terminal claim for the fixture.
        const terminalIds = itemIds.filter(id => !expectedWorkers.has(id));
        expect(result.ordering).toEqual([]);
        expect(result.overlaps).toEqual([]);
        for (const id of terminalIds) expect(result.proposedOrder).not.toContain(id);
      }
      expect(result.scope.repositoryId).toBeTruthy();
      expect(result.ownership).toHaveLength(activeItems.length);
      for (const row of result.ownership as { itemId: string; coverage: { workers: string[] } }[]) {
        expect(expectedWorkers.has(row.itemId)).toBe(true);
        expect(row.coverage.workers).toEqual(expectedWorkers.get(row.itemId));
      }
      expect(result.fileClaims.status).toBe('measured');
    }
    expect(call('plans:items', itemArgs)).toEqual(before);
    expect(call('locks:queue', claimArgs)).toEqual(claims);
  }, nativeCliTestTimeout(['coord:whoami', 'plans:items', 'locks:queue', ...Array<string>(3).fill('dev:pipeline_position'),
    'plans:lint', 'plans:lint', 'plans:items', 'locks:queue']));
});

describe.runIf(Boolean(baseUrl))('native P021 real CLI source/path expansion', () => {
  it('expands budget-omitted captured records through capability:read after the source changes', () => {
    const route = nativeCliCall(baseUrl!, 'dev:pipeline_position', {
      path: 'packages/operator-core/lib/code-intelligence/packer-facade.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] },
    }, spawnSync, { allowProjectedPartial: true });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const project = mkdtempSync(join(tmpdir(), 'native-bundle-cli-'));
    let artifact: string | null = null;
    try {
      writeFileSync(join(project, 'target.ts'), 'export function cliBundleTarget() { return "CAPTURED_CLI_LITERAL"; }\n');
      for (let index = 0; index < 4; index++) writeFileSync(join(project, `client${index}.ts`),
        `import { cliBundleTarget } from "./target";\nexport function client${index}() { return cliBundleTarget(); }\n`);
      const result = call('code:pack', { op: 'diff', rootPath: project, include: ['*.ts'],
        explain: { symbol: 'cliBundleTarget', file: 'target.ts', paths: ['.'], phase: 'pre-edit' },
        projection: { pick: ['answer.error', 'report.bundle'] } });
      expect(result.answer.error).toBeNull();
      const bundle = result.report.bundle;
      expect(bundle.omitted.symbols + bundle.omitted.edges + bundle.omitted.paths).toBeGreaterThan(0);
      expect(bundle.coverage.sourceCompleteness).toBe('unverified');
      artifact = bundle.expansion.args.file_path;
      writeFileSync(join(project, 'target.ts'), 'export function cliBundleTarget() { return "NEW_CLI_LITERAL"; }\n');
      const pages: Buffer[] = [];
      let cursor = bundle.expansion;
      for (let pageIndex = 0; cursor && pageIndex < 16; pageIndex++) {
        const page = call(cursor.tool, cursor.args);
        expect(page.ok).toBe(true);
        const bytes = Buffer.from(page.data, 'base64');
        expect(bytes.toString('base64')).toBe(page.data);
        expect(bytes.length).toBe(page.byte_length);
        expect(page.byte_offset).toBe(pages.reduce((total, row) => total + row.length, 0));
        pages.push(bytes);
        expect(Boolean(page.next_cursor)).toBe(!page.eof);
        cursor = page.next_cursor;
      }
      expect(cursor).toBeNull();
      const document = Buffer.concat(pages).toString('utf8');
      expect(createHash('sha256').update(document).digest('hex')).toBe(bundle.expansion.sha256);
      const expanded = JSON.parse(document);
      expect(expanded.context.paths).toHaveLength(4);
      expect(expanded.context.edges).toHaveLength(4);
      expect(document).toContain('CAPTURED_CLI_LITERAL');
      expect(document).not.toContain('NEW_CLI_LITERAL');
    } finally {
      if (artifact) rmSync(artifact, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, nativeCliTestTimeout(['dev:pipeline_position', 'code:pack', ...Array<string>(16).fill('capability:read')]));
});

describe.runIf(Boolean(baseUrl))('native P014 required BAR real CLI interface change report', () => {
  it('exposes the changed response field and its incompatible registered fixture client, then clears the mismatch after the client adapts', () => {
    const route = nativeCliCall(baseUrl!, 'dev:pipeline_position', {
      path: 'packages/operator-core/lib/code-intelligence/first-party-callers.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] },
    }, spawnSync, { allowProjectedPartial: true });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const project = mkdtempSync(join(tmpdir(), 'native-interface-cli-'));
    const args = { op: 'diff', include: ['*.ts'], rootPath: project,
      explain: { symbol: 'readApi', file: 'target.ts', paths: ['.'], phase: 'pre-edit' },
      projection: { pick: ['answer.error', 'report.interfaces', 'report.sourceFingerprint', 'report.freshness'] } };
    try {
      writeFileSync(join(project, 'target.ts'), 'export interface Response { value: string; }\nexport function readApi(): Response { return { value: "ok" }; }\n');
      writeFileSync(join(project, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().value.length; }\n');
      writeFileSync(join(project, 'contract.ts'), 'import { defineTool } from "@papercusp/agent-mcp";\nimport { z } from "zod";\nimport { readApi } from "./target";\nconst request = z.object({}); const result = z.object({ value: z.string() });\nexport const tool = defineTool({ name: "native-p014-fixture:read", args: request, result, handler: readApi });\n');
      const before = call('code:pack', args);
      expect(before.answer.error).toBeNull();
      expect(before.report.interfaces.status).toBe('measured');
      expect(before.report.interfaces.mismatchedConsumers).toEqual([]);
      expect(before.report.interfaces.registrations).toContainEqual(expect.objectContaining({ name: 'native-p014-fixture:read',
        factoryAuthority: 'maintained-import', responseValidator: expect.objectContaining({ path: 'contract.ts' }), runtimeRegistered: 'unmeasured' }));
      writeFileSync(join(project, 'target.ts'), 'export interface Response { label: string; }\nexport function readApi(): Response { return { label: "ok" }; }\n');
      const after = call('code:pack', { ...args, explain: { ...args.explain, previousFingerprint: before.report.sourceFingerprint } });
      expect(after.report.freshness).toBe('changed');
      expect(after.report.interfaces.diagnostics).toContainEqual(expect.objectContaining({ code: 2339,
        site: expect.objectContaining({ path: 'client.ts', line1: 2 }), message: expect.stringContaining("'value'") }));
      expect(after.report.interfaces.mismatchedConsumers).toContainEqual(expect.objectContaining({ path: 'client.ts', line1: 2 }));
      writeFileSync(join(project, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().label.length; }\n');
      expect(call('code:pack', args).report.interfaces.mismatchedConsumers).toEqual([]);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, nativeCliTestTimeout(['dev:pipeline_position', 'code:pack', 'code:pack', 'code:pack']) + 60_000);
});

describe.runIf(Boolean(baseUrl && taskBriefItem))('native P012 required BAR real CLI claim and resume', () => {
  it('attributes claim/resume source to the held task and registered repository', () => {
    const identity = call('coord:whoami', {});
    const item = call('work_items:get', { id: taskBriefItem, harness: 'papercusp',
      projection: { pick: ['results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.payload.paths'] } });
    const subject = item.results[0].workItem;
    // A current-build acceptance run may idempotently claim only its own task.
    // This test creates no work items and does not steal another session's lane.
    expect(subject.assignee).toBe(identity.ownerId);
    expect(subject.payload?.paths?.length, 'Task brief fixture requires stored payload.paths on its caller-owned item').toBeGreaterThan(0);
    const route = projectedRoute({ path: 'packages/operator-core/lib/code-intelligence/task-brief.ts',
      testClass: 'operator-api', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.readiness).toBe('ready');
    expect(route.servingRuntimes.some((row: { runtime: string; containsChange: boolean | null }) =>
      row.runtime === 'staging-operator' && row.containsChange === true)).toBe(true);
    const claimed = call('work_items:claim', { row: `${taskBriefItem},self,papercusp`,
      projection: { pick: ['results[].taskBrief.status', 'results[].taskBrief.repository',
        'results[].taskBrief.recover', 'results[].taskBrief.scope.paths', 'results[].taskBrief.files[].path',
        'results[].taskBrief.files[].sha256', 'results[].taskBrief.sourceFingerprint',
        'results[].taskBrief.exclusions', 'results[].taskBrief.graph'] } });
    const brief = claimed.results?.[0]?.taskBrief;
    expect(brief?.status, JSON.stringify(claimed)).toBe('current');
    expect(brief.repository.workspaceId).toBe(identity.workspaceId);
    expect(brief.recover).toMatchObject({ tool: 'code:pack', args: { rootPath: brief.repository.rootPath } });
    expect(brief.scope.paths.length).toBeGreaterThan(0);
    expect(brief.scope.paths.every((path: string) => subject.payload.paths.includes(path))).toBe(true);
    for (const file of brief.files) {
      expect(file.sha256).toBe(createHash('sha256').update(readFileSync(join(brief.repository.rootPath, file.path))).digest('hex'));
    }
    const resumed = call('work_items:get', { id: taskBriefItem, harness: 'papercusp', resume: true,
      projection: { pick: ['results[].resume.taskBrief.status', 'results[].resume.taskBrief.repository',
        'results[].resume.taskBrief.sourceFingerprint', 'results[].resume.taskBrief.scope.paths',
        'results[].resume.taskBrief.exclusions', 'results[].resume.taskBrief.graph'] } });
    const refreshed = resumed.results[0].resume.taskBrief;
    expect(refreshed?.status, JSON.stringify(resumed)).toBe('current');
    expect(refreshed.repository).toEqual(brief.repository);
    expect(refreshed.sourceFingerprint).toBe(brief.sourceFingerprint);
    expect(refreshed.scope.paths).toEqual(brief.scope.paths);
  }, nativeCliTestTimeout(['coord:whoami', 'work_items:get', 'dev:pipeline_position', 'work_items:claim', 'work_items:get']));
});

describe.runIf(Boolean(baseUrl))('native P017 required BAR real CLI runtime provenance', () => {
  it('identifies a containing current-build artifact and keeps a newer private source distinct', async () => {
    const sourcePath = 'packages/operator-core/lib/code-intelligence/source-runtime-provenance.ts';
    const route = call('dev:pipeline_position', { path: sourcePath, testClass: 'operator-api', sourceRuntimeOnly: true,
      projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] } });
    expect(route.currentBuildTestRoute.id).toBe('operator-api');
    expect(route.servingRuntimes.some((runtime: { runtime: string; containsChange: boolean | null }) =>
      runtime.runtime === 'staging-operator' && runtime.containsChange === true)).toBe(true);
    const rootProbe = call('dev:pipeline_position', { path: sourcePath, sourceRuntimeOnly: true,
      projection: { pick: ['repoRoot'] } });
    expect(typeof rootProbe.repoRoot).toBe('string');
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const captured = hash(join(rootProbe.repoRoot, sourcePath));
    const oracle = call('dev:pipeline_position', { path: sourcePath, expectedSourceSha256: captured, sourceRuntimeOnly: true });
    const runtime = oracle.servingRuntimes.find((row: { runtime: string }) => row.runtime === 'staging-operator');
    expect(oracle.acceptedSource.matches).toBe(true);
    expect(runtime.containsChange).toBe(true);
    const query = (name: string, file: string, selected = 'staging-operator') => call('graph:query', {
      op: 'symbol', name, file_path: file, paths: [file], runtime: selected, runtime_limit: 8,
      projection: { pick: ['error', 'evidence.sourceScope', 'evidence.siteIdentities', 'runtimeProvenance'] },
    });
    const loaded = query('sourceRuntimeProvenance', sourcePath);
    expect(loaded.error).toBeNull();
    const loadedFile = loaded.runtimeProvenance.files.find((row: { path: string }) => row.path === sourcePath);
    expect(loadedFile).toMatchObject({ capturedSourceSha256: captured, editedSourceSha256: captured,
      artifact: { buildSha: runtime.buildSha }, containsCapturedSource: true });
    expect(loaded.runtimeProvenance.repositoryId).toBe(loaded.evidence.sourceScope.repositoryId);

    // Explicit file scope lets the real compiler read this ignored, private source.
    // It cannot enter git-sync or either loaded artifact, and no product file is edited.
    const scratch = join(rootProbe.repoRoot, '.papercusp/scratch');
    mkdirSync(scratch, { recursive: true });
    const project = mkdtempSync(join(scratch, 'native-runtime-e2e-'));
    const file = join(project, 'target.ts');
    const rel = relative(rootProbe.repoRoot, file).split('\\').join('/');
    try {
      writeFileSync(file, 'export function nativeRuntimePrivateTarget() { return 1; }\n');
      const beforeHash = hash(file);
      const before = query('nativeRuntimePrivateTarget', rel);
      expect(before.error).toBeNull();
      expect(before.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: beforeHash,
        containsCapturedSource: null, artifact: expect.objectContaining({ buildSha: expect.stringMatching(/^[a-f0-9]{4,64}$/) }) })]);
      writeFileSync(file, 'export function nativeRuntimePrivateTarget() { return 2; }\n');
      const afterHash = hash(file);
      expect(afterHash).not.toBe(beforeHash);
      const after = query('nativeRuntimePrivateTarget', rel, 'release-operator');
      const negativeOracle = call('dev:pipeline_position', { path: rel, expectedSourceSha256: afterHash, sourceRuntimeOnly: true });
      const release = negativeOracle.servingRuntimes.find((row: { runtime: string }) => row.runtime === 'release-operator');
      // The production blob reader treats an absent artifact path as unknown.
      // Preserve that uncertainty rather than upgrading it to a measured mismatch.
      expect(release.containsChange).toBeNull();
      expect(after.error).toBeNull();
      expect(after.runtimeProvenance.files).toEqual([expect.objectContaining({ capturedSourceSha256: afterHash,
        editedSourceSha256: afterHash, artifact: expect.objectContaining({ buildSha: release.buildSha }), containsCapturedSource: null })]);
      expect(after.runtimeProvenance.files[0].reason).toMatch(/unmeasured/);
      expect(after.runtimeProvenance.sourceFingerprint).not.toBe(before.runtimeProvenance.sourceFingerprint);
      expect(after.evidence.siteIdentities[0].contentHash).toBe(afterHash);
      expect(after.runtimeProvenance.limitations.join(' ')).toMatch(/neither establishes runtime execution/);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, nativeCliTestTimeout(['dev:pipeline_position', 'dev:pipeline_position', 'dev:pipeline_position',
    'graph:query', 'graph:query', 'graph:query', 'dev:pipeline_position']));
});

function call(name: string, args: Record<string, unknown>) {
  return nativeCliCall(baseUrl!, name, args);
}

/**
 * Projected current-build route read. dev:pipeline_position marks unpicked
 * prose fields (verdict detail) as text-truncated, so its door is a
 * non-recoverable projected partial; accept only the complete projection item,
 * exactly as P014/P021 do. Every other read stays fail-closed.
 */
function projectedRoute(args: Record<string, unknown> & { projection: { pick: string[] } }) {
  return nativeCliCall(baseUrl!, 'dev:pipeline_position', args, spawnSync, { allowProjectedPartial: true });
}

describe.runIf(Boolean(baseUrl))('native P010 required BAR real CLI change report', () => {
  it('cites both reference consumers and rechecks the remaining consumer after a source edit', async () => {
    const route = projectedRoute({
      path: 'packages/operator-core/lib/agent-tools/lsp/pack.ts', testClass: 'operator-api',
      marker: 'previousFingerprint', projection: { pick: ['currentBuildTestRoute', 'servingRuntimes'] },
    });
    expect(route.currentBuildTestRoute.id).toBe('operator-api');
    expect(route.servingRuntimes.some((runtime: { runtime: string; containsChange: boolean | null }) =>
      runtime.runtime === 'staging-operator' && runtime.containsChange === true)).toBe(true);
    const health = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(10_000) });
    expect(health.ok).toBe(true);
    const build = await health.json() as { sha: string };
    const project = mkdtempSync(join(tmpdir(), 'native-ecosystem-e2e-'));
    const git = (args: string[]) => {
      const result = spawnSync('git', args, { cwd: project, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 1; }\n');
      writeFileSync(join(project, 'first.ts'), 'import { changedTarget } from "./target";\nexport function first() { return changedTarget(); }\n');
      writeFileSync(join(project, 'second.ts'), 'import { changedTarget as alias } from "./target";\nexport function second() { return alias(); }\n');
      git(['init', '-q']);
      git(['config', 'user.name', 'native BAR private fixture']);
      git(['config', 'user.email', 'fixture@example.invalid']);
      git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'reference fixture']);
      writeFileSync(join(project, 'target.ts'), 'export function changedTarget() { return 2; }\n');
      const args = {
        op: 'diff', include: ['*.ts'], rootPath: project, baseRef: 'HEAD',
        explain: { symbol: 'changedTarget', file: 'target.ts', paths: ['.'], phase: 'pre-review' },
        projection: { pick: ['answer.error', 'answer.backend', 'report.changed', 'report.consumers',
          'report.sourceFingerprint', 'report.freshness', 'report.provenance.runtime', 'report.limitations'] },
      };
      const first = call('code:pack', args);
      expect(first.answer.error).toBeNull();
      expect(first.answer.backend).toBe('typescript-service');
      expect(first.report.changed).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'target.ts' })]));
      expect(first.report.consumers).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'first.ts', line1: 2 }),
        expect.objectContaining({ path: 'second.ts', line1: 2 }),
      ]));
      expect(first.report.provenance.runtime.sha).toBe(build.sha);
      writeFileSync(join(project, 'first.ts'), 'export function first() { return 2; }\n');
      const edited = call('code:pack', { ...args,
        explain: { ...args.explain, previousFingerprint: first.report.sourceFingerprint } });
      expect(edited.report.freshness).toBe('changed');
      expect(edited.report.consumers).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'second.ts', line1: 2 }),
      ]));
      expect(edited.report.consumers.some((consumer: { path: string }) => consumer.path === 'first.ts')).toBe(false);
      expect(edited.report.limitations.some((line: string) => line.includes('runtime execution'))).toBe(true);
    } finally { rmSync(project, { recursive: true, force: true }); }
  }, nativeCliTestTimeout(['dev:pipeline_position', 'code:pack', 'code:pack']) + 80_000);
});
