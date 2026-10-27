import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  captureIsolatedWorker,
  isolatedWorkerOptions,
  recordIsolatedIntegrationProof,
} from '../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../..');

it('measures the production identity policy read in a private background runtime', async () => {
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/capability-envelope/identity-tool-surface.integration.test.ts',
    sourcePaths: [
      'packages/operator-core/lib/agent-tools/index.ts',
      'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
      'packages/operator-core/lib/capability-envelope/identity-tool-surface.ts',
      'packages/operator-core/lib/operator-state-pg.ts',
      'scripts/with-test-pg.mjs',
      'scripts/lib/with-test-pg-cleanup.mjs',
      'libs/papercusp/packages/orchestrator/src/blueprint/loader.ts',
    ],
    retainedArtifacts: ['phases/execute/identity-surface-receipt.json'],
    execute: async (observe, evidenceDir) => {
      const probe = String.raw`
        import assert from 'node:assert/strict';
        import { execFileSync } from 'node:child_process';
        import { createHash } from 'node:crypto';
        import { mkdir, writeFile } from 'node:fs/promises';
        import { readFileSync } from 'node:fs';
        import { dirname, join } from 'node:path';
        import { tmpdir } from 'node:os';
        import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

        const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
        const home = process.env.HOME;
        assert.ok(workspaceId && workspaceId.startsWith('test-runtime-'));
        assert.equal(process.env.PAPERCUSP_WORKSPACE, workspaceId);
        assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
        assert.equal(process.env.PAPERCUSP_HOME, join(home, '.papercusp'));
        assert.equal(tmpdir(), join(dirname(home), 'tmp'));
        assert.equal(process.env.PAPERCUSP_SID, undefined);
        assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');

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

        await import('./packages/operator-core/lib/agent-tools/index.ts');
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

        const potPath = join(home, 'identity-policy-pot');
        const sourceDir = join(potPath, '.papercusp');
        const blueprintDir = join(sourceDir, 'blueprints');
        await mkdir(blueprintDir, { recursive: true });
        await writeFile(join(blueprintDir, 'parent.yaml'), [
          'id: parent',
          'fleet:',
          '  workerRoles:',
          '    - id: su',
          '      capabilities:',
          '        - "work_items:write"',
          '',
        ].join('\n'));
        const blueprintPath = join(sourceDir, 'blueprint.yaml');
        await writeFile(blueprintPath, 'id: sales-pot\nextends: parent\n');

        const registry = { projects: [
          { slug: 'sales', path: potPath, hive_slug: 'sales-pot' },
          { slug: 'sales-pot', path: potPath, harness_kind: 'hive' },
        ] };
        await writeOperatorState('harness_registry', registry, workspaceId);
        assert.deepEqual(await readOperatorState('harness_registry', workspaceId, { fresh: true }), registry);

        const input = { workspaceId, harnessSlug: 'sales', role: 'su', classRefs: [] };
        await assert.rejects(
          () => readIdentityGrantPolicy(input),
          /no explicit role capability ceiling/,
          'an inherited worker role must not count as administrator authorization',
        );

        await writeFile(blueprintPath, [
          'id: sales-pot',
          'extends: parent',
          'fleet:',
          '  workerRoles:',
          '    - id: su',
          '      capabilities:',
          '        - "coord:read"',
          '',
        ].join('\n'));

        const projected = listAllProjectedTools();
        assert.ok(projected.length > 100, 'expected the production tool registry, got ' + projected.length);
        const candidate = (name) => {
          const tool = projected.find((entry) => entry.expose.mcp?.name === name);
          assert.ok(tool, 'missing projected tool ' + name);
          return { name, capabilities: tool.capabilities };
        };
        const candidates = [candidate('coord:feed'), candidate('work_items:complete'),
          candidate('coord:orient'), candidate('work_items:get')];
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
        const surface = await resolveIdentityToolSurface(ctx, candidates, {
          readState: async () => state,
          readPolicy,
          check: checkIdentityGrantKernel,
        });
        const elapsedMs = performance.now() - startedAt;
        await new Promise((resolve) => setTimeout(resolve, 20));
        const eventLoopMaxMs = eventLoop.max / 1e6;
        eventLoop.disable();

        assert.equal(surface.kind, 'governed');
        assert.equal(policyReadCount, 1, 'one policy read should serve the whole listed surface');
        assert.deepEqual(policy.ceilings[1], { allowCapabilities: ['coord:read'] });
        assert.ok(!policy.ceilings[1].allowCapabilities.includes('work_items:write'));
        assert.ok(surface.admitted.has('coord:feed'));
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
        console.log('IDENTITY_POLICY_BACKGROUND_RECEIPT ' + JSON.stringify(receipt));
      `;
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0' };
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
      const result = await captureIsolatedWorker(child, evidenceDir, isolatedWorkerOptions(120_000));
      expect(result, result.output.slice(-6000)).toMatchObject({
        code: 0,
        signal: null,
        timedOut: false,
        exitWaitTimedOut: false,
        stdioDrainTimedOut: false,
      });
      const line = result.output.split('\n').find(value => value.startsWith('IDENTITY_POLICY_BACKGROUND_RECEIPT '));
      expect(line, result.output.slice(-6000)).toBeTruthy();
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
      writeFileSync(join(evidenceDir, 'identity-surface-receipt.json'),
        JSON.stringify({ worker, cleanup }, null, 2), { flag: 'wx' });
    },
  });
  expect(runId).toBeTruthy();
}, 240_000);
