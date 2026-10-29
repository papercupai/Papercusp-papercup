import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import {
  captureIsolatedWorker,
  isolatedWorkerFailureDetail,
  isolatedWorkerOptions,
  recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');
// The outer Vitest case and file router must outlive every independently
// bounded private-worker phase. recordIsolatedIntegrationProof checks the file
// runner allowance before it allocates the disposable runtime.
const workerOptions = isolatedWorkerOptions(120_000, process.env, 120_000, {
  // The migration boot has measured at about four minutes. Keep enough room for
  // that distinct bootstrap progress while ensuring the composed proof fits the
  // maintained test-file router's 600s ceiling.
  bootstrapMaxMs: 325_000,
  finalizeMaxMs: 45_000,
  teardownMaxMs: 45_000,
});
const parentBlueprintYaml = [
  'id: parent',
  'workItem:',
  '  kind: feature',
  'spine:',
  '  edges:',
  '    DONE:',
  '      to: done',
  'fleet:',
  '  workerRoles:',
  '    - id: su',
  '      capabilities:',
  '        - "work_items:write"',
  '',
].join('\n');
const baseBlueprintYaml = 'id: sales-pot\nextends: parent\n';
const governedBlueprintYaml = [
  'id: sales-pot',
  'extends: parent',
  'fleet:',
  '  workerRoles:',
  '    - id: su',
  '      capabilities:',
  '        - "coord:read"',
  '',
].join('\n');

beforeAll(async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'identity-tool-surface-preflight-'));
  const sourceDir = join(fixtureRoot, '.papercusp');
  const blueprintsDir = join(sourceDir, 'blueprints');
  const parentDir = join(blueprintsDir, 'parent');
  try {
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, 'blueprint.yaml'), parentBlueprintYaml);
    writeFileSync(join(sourceDir, 'blueprint.yaml'), baseBlueprintYaml);
    const [{ loadBlueprintFromFile }, { operatorResolveExtends }] = await Promise.all([
      import('@papercusp/orchestrator/blueprint'),
      import('../blueprint/installed-blueprints'),
    ]);
    const loaded = loadBlueprintFromFile(join(sourceDir, 'blueprint.yaml'),
      operatorResolveExtends({ localDirs: [blueprintsDir] }));
    expect(loaded.blueprint).toMatchObject({
      workItem: { kind: 'feature' },
      spine: { edges: { DONE: { to: 'done' } } },
    });

    // Check the chosen candidates' declarations without importing the complete
    // agent-tool bootstrap (whose unrelated integrations can open operator PG).
    for (const [path, name, capability] of [
      ['packages/operator-core/lib/agent-tools/coordination/tools/inbox.ts', 'coord:inbox', 'coord:read'],
      ['packages/operator-core/lib/agent-tools/coordination/tools/feed.ts', 'coord:feed', 'audit:read'],
    ]) {
      const source = readFileSync(join(root, path), 'utf8');
      expect(source).toMatch(new RegExp(`name:\\s*['\"]${name}['\"]`));
      expect(source).toMatch(new RegExp(`capability:\\s*['\"]${capability}['\"]`));
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

it('measures the production identity policy read in a private background runtime', async () => {
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/capability-envelope/identity-tool-surface.integration.test.ts',
    minimumFileRunTimeoutMs: workerOptions.testTimeoutMs,
    sourcePaths: [
      'packages/operator-core/lib/agent-tools/index.ts',
      'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
      'packages/operator-core/lib/capability-envelope/identity-tool-surface.ts',
      'packages/operator-core/lib/operator-state-pg.ts',
      'scripts/with-test-pg.mjs',
      'scripts/lib/with-test-pg-cleanup.mjs',
      'libs/papercusp/packages/orchestrator/src/blueprint/loader.ts',
    ],
    retainedArtifacts: [
      'phases/execute/identity-surface-receipt.json',
      'phases/execute/worker-progress.ndjson',
    ],
    execute: async (observe, evidenceDir) => {
      const probe = String.raw`
        import assert from 'node:assert/strict';
        import { execFileSync } from 'node:child_process';
        import { createHash } from 'node:crypto';
        import { appendFile, mkdir, writeFile } from 'node:fs/promises';
        import { readFileSync } from 'node:fs';
        import { dirname, join } from 'node:path';
        import { tmpdir } from 'node:os';
        import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

        const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
        const home = process.env.HOME;
        const progressFile = process.env.PAPERCUSP_ISOLATED_PROGRESS_FILE;
        const progress = async (stage, evidence = {}) => {
          assert.ok(progressFile, 'isolated worker progress path must be configured');
          await appendFile(progressFile, JSON.stringify({ stage, observedAt: new Date().toISOString(), ...evidence }) + '\n');
        };
        let resetForTests;
        try {
        await progress('db-org-reset-import-start');
        const dbOrg = await import('@papercusp/db-org');
        resetForTests = dbOrg._resetForTests;
        assert.equal(typeof resetForTests, 'function');
        await progress('db-org-reset-import-complete');
        await progress('runtime-env-validation-start');
        assert.ok(workspaceId && workspaceId.startsWith('test-runtime-'));
        assert.equal(process.env.PAPERCUSP_WORKSPACE, workspaceId);
        assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
        assert.equal(process.env.PAPERCUSP_HOME, join(home, '.papercusp'));
        assert.equal(tmpdir(), join(dirname(home), 'tmp'));
        assert.equal(process.env.PAPERCUSP_SID, undefined);
        assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
        await progress('runtime-env-validation-complete');

        await progress('private-database-connect-start');
        const postgres = (await import('postgres')).default;
        const databaseUrl = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
        assert.equal(databaseUrl.port, process.env.PAPERCUSP_PG_PORT);
        const sql = postgres(databaseUrl.toString(), { max: 1 });
        let privateDatabase;
        try {
          const [row] = await sql.unsafe('SELECT current_database() AS name, inet_server_port() AS port');
          privateDatabase = { name: row.name, port: Number(row.port) };
          assert.equal(privateDatabase.port, Number(process.env.PAPERCUSP_PG_PORT));
        } finally {
          await sql.end();
        }
        await progress('private-database-connect-complete', { port: privateDatabase.port });

        await progress('agent-tools-bootstrap-start');
        await import('./packages/operator-core/lib/agent-tools/index.ts');
        await progress('agent-tools-bootstrap-complete');
        await progress('identity-modules-import-start');
        const [{ compileAgentSpecification }, { listAllProjectedTools },
          { readOperatorState, writeOperatorState },
          { checkIdentityGrantKernel, readIdentityGrantPolicy },
          { resolveIdentityToolSurface }] = await Promise.all([
          import('@papercusp/orchestrator/blueprint'),
          import('@papercusp/agent-mcp'),
          import('./packages/operator-core/lib/operator-state-pg.ts'),
          import('./packages/operator-core/lib/capability-envelope/identity-grants-port.ts'),
          import('./packages/operator-core/lib/capability-envelope/identity-tool-surface.ts'),
        ]);
        await progress('identity-modules-import-complete');

        const potPath = join(home, 'identity-policy-pot');
        const sourceDir = join(potPath, '.papercusp');
        const blueprintDir = join(sourceDir, 'blueprints');
        await mkdir(blueprintDir, { recursive: true });
        const parentBlueprintDir = join(blueprintDir, 'parent');
        await mkdir(parentBlueprintDir, { recursive: true });
        await writeFile(join(parentBlueprintDir, 'blueprint.yaml'), ${JSON.stringify(parentBlueprintYaml)});
        const blueprintPath = join(sourceDir, 'blueprint.yaml');
        await writeFile(blueprintPath, ${JSON.stringify(baseBlueprintYaml)});

        const registry = { projects: [
          { slug: 'sales', path: potPath, hive_slug: 'sales-pot' },
          { slug: 'sales-pot', path: potPath, harness_kind: 'hive' },
        ] };
        await writeOperatorState('harness_registry', registry, workspaceId);
        await progress('private-state-readback-start');
        assert.deepEqual(await readOperatorState('harness_registry', workspaceId, { fresh: true }), registry);
        await progress('private-state-readback-complete');

        const input = { workspaceId, harnessSlug: 'sales', role: 'su', classRefs: [] };
        await progress('inherited-role-rejection-start');
        await assert.rejects(
          () => readIdentityGrantPolicy(input),
          /no explicit role capability ceiling/,
          'an inherited worker role must not count as administrator authorization',
        );
        await progress('inherited-role-rejection-complete');

        await writeFile(blueprintPath, ${JSON.stringify(governedBlueprintYaml)});

        await progress('projected-tool-catalog-start');
        const projected = listAllProjectedTools();
        assert.ok(projected.length > 100, 'expected the production tool registry, got ' + projected.length);
        await progress('projected-tool-catalog-complete', { candidateCount: projected.length });
        const candidate = (name) => {
          const tool = projected.find((entry) => entry.expose.mcp?.name === name);
          assert.ok(tool, 'missing projected tool ' + name);
          return { name, capabilities: tool.capabilities };
        };
        const candidates = [candidate('coord:inbox'), candidate('coord:feed'),
          candidate('work_items:complete'), candidate('coord:orient'), candidate('work_items:get')];
        const artifact = compileAgentSpecification({
          source: {
            id: 'identity-policy-background-proof',
            workItem: { kind: 'feature' },
            spine: { edges: { DONE: { to: 'done' } } },
            grants: { requires: [] },
          },
          prompt: { role: 'worker', text: 'Use only tools admitted by the administrator role.' },
          inputClosure: [],
        });
        const state = {
          activation: { applied: {
            specificationRevision: artifact.specificationRevision,
            stateRevision: 'identity-policy-background-proof',
          } },
          identityLaunchRecord: {
            workspaceId,
            harnessSlug: 'sales',
            specificationRevision: artifact.specificationRevision,
            stateRevision: 'identity-policy-background-proof',
            specificationArtifact: artifact,
            acceptedOperation: {
              kind: 'blueprint-operation-worker',
              workItemId: 'WI-1',
              operationId: 'identity-policy-read',
              specificationRevision: artifact.specificationRevision,
              requiredTools: ['coord:inbox'],
              pin: {
                kind: 'blueprint-operation',
                harnessSlug: 'sales',
                operationId: 'identity-policy-read',
                specificationRevision: artifact.specificationRevision,
                operationVersion: '1.0.0',
                input: {},
              },
            },
          },
          identityLaunchRecordVersion: { sessionId: 'identity-policy-background-proof', rowVersion: '1' },
          controlGeneration: 1,
        };
        const ctx = {
          workspaceId,
          role: 'su',
          uiClientId: 'identity-policy-background-proof',
          isSuperuser: true,
          log: () => {},
          signal: new AbortController().signal,
          progress: () => {},
          emit: () => {},
        };
        let policyReadCount = 0;
        let policyReadMs = 0;
        let policy;
        const readPolicy = async (request) => {
          policyReadCount += 1;
          const startedAt = performance.now();
          policy = await readIdentityGrantPolicy(request);
          policyReadMs = performance.now() - startedAt;
          return policy;
        };
        const eventLoop = monitorEventLoopDelay({ resolution: 10 });
        eventLoop.enable();
        await new Promise((resolve) => setTimeout(resolve, 20));
        eventLoop.reset();
        const startedAt = performance.now();
        await progress('identity-policy-resolution-start');
        const surface = await resolveIdentityToolSurface(ctx, candidates, {
          readState: async () => state,
          readPolicy,
          check: checkIdentityGrantKernel,
        });
        const elapsedMs = performance.now() - startedAt;
        await progress('identity-policy-resolution-complete', { policyReadCount, policyReadMs, elapsedMs });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const eventLoopMaxMs = eventLoop.max / 1e6;
        eventLoop.disable();

        assert.equal(surface.kind, 'governed');
        assert.equal(policyReadCount, 1, 'one policy read should serve the whole listed surface');
        assert.deepEqual(policy.ceilings[1], { allowCapabilities: ['coord:read'] });
        assert.ok(!policy.ceilings[1].allowCapabilities.includes('work_items:write'));
        assert.ok(surface.admitted.has('coord:inbox'));
        assert.ok(!surface.admitted.has('coord:feed'));
        assert.ok(!surface.admitted.has('work_items:complete'));

        const sourcePaths = [
          'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
          'packages/operator-core/lib/capability-envelope/identity-tool-surface.ts',
        ];
        const sourceHashes = Object.fromEntries(sourcePaths.map((path) => [path,
          createHash('sha256').update(readFileSync(path)).digest('hex')]));
        const receipt = {
          schemaVersion: 1,
          build: { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes },
          environment: {
            workspaceId,
            home,
            papercuspHome: process.env.PAPERCUSP_HOME,
            tmp: tmpdir(),
            backgroundWorkers: process.env.PAPERCUSP_BACKGROUND_WORKERS,
          },
          privateDatabase,
          privateStateReadback: true,
          inheritedRoleRejected: true,
          policy: {
            candidates: candidates.map(({ name, capabilities }) => ({ name, capabilities })),
            policyReadCount,
            policyReadMs,
            elapsedMs,
            eventLoopMaxMs,
            administratorCeiling: policy.ceilings[1],
            admitted: [...surface.admitted].sort(),
          },
        };
        await progress('identity-policy-receipt-created', { policyReadMs, elapsedMs, eventLoopMaxMs });
        console.log('IDENTITY_POLICY_BACKGROUND_RECEIPT ' + JSON.stringify(receipt));
        } finally {
          if (resetForTests) {
            await progress('operator-pg-pool-reset-start');
            await resetForTests();
            await progress('operator-pg-pool-reset-complete', {
              activeResources: process.getActiveResourcesInfo(),
              activeHandleTypes: process._getActiveHandles().map(handle => handle.constructor?.name ?? typeof handle),
              activeRequestTypes: process._getActiveRequests().map(request => request.constructor?.name ?? typeof request),
            });
          }
        }
      `;
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0',
        PAPERCUSP_ISOLATED_PROGRESS_FILE: join(evidenceDir, 'worker-progress.ndjson') };
      for (const key of ['PAPERCUSP_TEST_RUNS_DB_URL', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE',
        'PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT', 'PC_EXECUTED_SOURCE_MAP_WORKSPACE']) delete env[key];
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
        process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
        cwd: root,
        detached: true,
        env,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
      const failureDetail = isolatedWorkerFailureDetail(result.output);
      expect(result, failureDetail).toMatchObject({
        code: 0,
        signal: null,
        timedOut: false,
        exitWaitTimedOut: false,
        stdioDrainTimedOut: false,
      });
      const line = result.output.split('\n').find(value => value.startsWith('IDENTITY_POLICY_BACKGROUND_RECEIPT '));
      expect(line, failureDetail).toBeTruthy();
      const worker = JSON.parse(line!.slice('IDENTITY_POLICY_BACKGROUND_RECEIPT '.length));
      expect(worker).toMatchObject({
        environment: { backgroundWorkers: '1', workspaceId: expect.stringMatching(/^test-runtime-/) },
        privateStateReadback: true,
        inheritedRoleRejected: true,
        policy: { policyReadCount: 1, administratorCeiling: { allowCapabilities: ['coord:read'] } },
      });
      const cleanupStages = result.output.split('\n')
        .filter(value => value.startsWith('[with-test-pg] cleanup '))
        .map(value => JSON.parse(value.slice('[with-test-pg] cleanup '.length)));
      const cleanup = cleanupStages.find(value => value.stage === 'complete');
      expect(cleanup).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      const progressRows = readFileSync(join(evidenceDir, 'worker-progress.ndjson'), 'utf8')
        .trim().split('\n').map(value => JSON.parse(value));
      const progressStages = progressRows.map(value => value.stage);
      expect(progressStages).toContain('db-org-reset-import-start');
      expect(progressStages).toContain('db-org-reset-import-complete');
      expect(progressStages).toContain('operator-pg-pool-reset-start');
      expect(progressStages).toContain('operator-pg-pool-reset-complete');
      expect(progressStages.at(-1)).toBe('operator-pg-pool-reset-complete');
      writeFileSync(join(evidenceDir, 'identity-surface-receipt.json'),
        JSON.stringify({ worker, cleanup }, null, 2), { flag: 'wx' });
    },
  });
  expect(runId).toBeTruthy();
}, workerOptions.testTimeoutMs);
