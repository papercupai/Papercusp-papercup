import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, type TestContext } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const filePath = 'packages/operator-core/lib/harness/git-sync/run-git-sync-timing.integration.test.ts';
const sourcePaths = [
  'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
  'packages/operator-core/lib/harness/git-sync/git-fetch-headroom.ts',
];
const sidecarSourcePaths = [
  'packages/operator-core/lib/fleet/git-via-sidecar.ts',
  'packages/operator-core/lib/fleet/spawner-sidecar-server.ts',
  'packages/operator-core/lib/fleet/sidecar-exec-process.ts',
  'packages/operator-core/lib/resource-governor/execution.ts',
  'packages/operator-core/lib/resource-governor/admission-cutover-store.ts',
  'packages/operator-core/lib/resource-governor/admission-ledger-store.ts',
  'packages/operator-core/lib/task-manager/managed-spawn.ts',
  'scripts/with-test-pg.mjs',
];
const options = isolatedWorkerOptions(90_000);

it.for(['local', 'sidecar'] as const)('persists real Git setup and pointer timing through %s in an isolated current-source background runtime', { timeout: options.testTimeoutMs }, async (mode: 'local' | 'sidecar', context: TestContext) => {
  const paths = [...sourcePaths, ...(mode === 'sidecar' ? sidecarSourcePaths : [])];
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths: paths,
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/timing-control.json', ...(mode === 'sidecar' ? ['phases/execute/sidecar.log'] : [])],
    execute: async (observe, evidenceDir) => {
      const probe = `
        import assert from 'node:assert/strict';
        import { execFileSync, spawn } from 'node:child_process';
        import { createHash } from 'node:crypto';
        import { mkdir, readFile, writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        import postgres from 'postgres';
        import { runGitSync } from './packages/operator-core/lib/harness/git-sync/run-git-sync.ts';
        import { getSidecarFallbackStats } from './packages/operator-core/lib/fleet/git-via-sidecar.ts';
        import { closeSpawnerIpcClient } from './packages/operator-core/lib/fleet/spawner-ipc-client.ts';
        import { managedSpawn, markManagedSpawnTeardown } from './packages/operator-core/lib/task-manager/managed-spawn.ts';
        import { newTaskId, scopeUnitForTask } from './packages/operator-core/lib/task-manager/types.ts';
        import { killScopeUnit } from './packages/operator-core/lib/task-manager/control.ts';

        try {
        const home = process.env.HOME;
        assert.equal(process.env.PAPERCUSP_HOME, join(home, '.papercusp'));
        assert.match(process.env.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
        assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
        assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
        assert.equal(process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR, '0');
        assert.equal(process.env.OPENAI_API_KEY, undefined);
        assert.equal(process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET, undefined);
        const mode = ${JSON.stringify(mode)};
        const paths = ${JSON.stringify(paths)};
        const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path =>
          [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
        const before = await hashes();
        const fixture = join(home, 'timing-fixture');
        const seed = join(fixture, 'seed');
        const repo = join(fixture, 'repo');
        await mkdir(fixture);
        const git = (cwd, ...args) => execFileSync('git', args, {
          cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        const configure = cwd => {
          git(cwd, 'config', 'user.email', 'timing@test.invalid');
          git(cwd, 'config', 'user.name', 'Isolated timing control');
          git(cwd, 'config', 'commit.gpgsign', 'false');
        };
        for (const path of [seed, repo]) {
          git(fixture, 'init', '-q', '-b', 'main', path);
          configure(path);
          await writeFile(join(path, 'baseline.txt'), 'baseline\\n');
          git(path, 'add', '-A');
          git(path, 'commit', '--no-verify', '-qm', 'fixture baseline');
        }
        git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', seed, 'libs/child');
        configure(join(repo, 'libs/child'));
        git(repo, 'add', '-A');
        git(repo, 'commit', '--no-verify', '-qm', 'fixture submodule');
        await writeFile(join(repo, 'root-work.txt'), 'root work\\n');
        await writeFile(join(repo, 'libs/child/child-work.txt'), 'child work\\n');

        const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
        let sidecar;
        let sidecarExit;
        let sidecarOutput = '';
        let sidecarIdentity;
        let sidecarScope;
        const stopSidecar = async () => {
          if (!sidecar) return;
          closeSpawnerIpcClient();
          if (sidecar.exitCode === null && sidecar.signalCode === null) {
            markManagedSpawnTeardown(sidecar);
            const killed = await killScopeUnit(sidecarScope, { signal: 'SIGTERM' });
            assert.ok(killed.ok, JSON.stringify(killed));
          }
          const exit = await sidecarExit;
          assert.equal(exit.code, 0, JSON.stringify(exit));
          await assert.rejects(readFile(process.env.PAPERCUSP_SPAWNER_IPC_SOCKET), { code: 'ENOENT' });
          sidecar = undefined;
        };
        try {
          if (mode === 'sidecar') {
            // Only the diagnostic threshold changes. Admission, execution and
            // persistence use the production defaults in a separate process.
            process.env.PAPERCUSP_SPAWNER_IPC_SOCKET = join(process.env.TMPDIR, 'timing.sock');
            process.env.PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR = '1';
            process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE = '0';
            const serverCode = ${JSON.stringify(`
              import { createHash } from 'node:crypto';
              import { readFile } from 'node:fs/promises';
              import { runSpawnerSidecarServer } from './packages/operator-core/lib/fleet/spawner-sidecar-server.ts';
              const paths = JSON.parse(process.env.PC_TIMING_SOURCE_PATHS);
              const hashes = Object.fromEntries(await Promise.all(paths.map(async path =>
                [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
              const server = runSpawnerSidecarServer({ slowExecMs: 0 });
              server.once('listening', () => console.log('TIMING_SIDECAR_READY ' + JSON.stringify({ pid: process.pid, hashes })));
            `)};
            const taskId = newTaskId();
            let ready;
            const readyPromise = new Promise(resolve => { ready = resolve; });
            const argv = ['--import', 'tsx', '--input-type=module', '-e', serverCode];
            const managed = await managedSpawn(process.execPath, argv, {
              class: 'sidecar', title: 'isolated Git timing sidecar', launchedBy: 'test:git-sync-timing', argv,
            }, { taskId, requireConfinement: true, requireRegistration: true,
              spawnOptions: { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
                  PAPERCUSP_SPAWNER_SCOPE_UNIT: scopeUnitForTask(taskId),
                  PC_TIMING_SOURCE_PATHS: JSON.stringify(paths), PAPERCUSP_ADMISSION_CONTEXT: '' } },
              onSpawn: child => {
                sidecar = child;
                sidecarScope = scopeUnitForTask(taskId);
                sidecarExit = new Promise((resolve, reject) => {
                  child.once('error', reject);
                  child.once('close', (code, signal) => resolve({ code, signal }));
                });
                for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
                  sidecarOutput += String(chunk);
                  const line = sidecarOutput.split('\\n').find(line => line.startsWith('TIMING_SIDECAR_READY '));
                  if (line) { try { ready(JSON.parse(line.slice('TIMING_SIDECAR_READY '.length))); } catch {} }
                });
              },
            });
            assert.equal(managed.confined, true);
            sidecarIdentity = await Promise.race([
              readyPromise,
              sidecarExit.then(exit => { throw new Error('sidecar exited before ready: ' + JSON.stringify(exit) + sidecarOutput); }),
            ]);
            assert.notEqual(sidecarIdentity.pid, process.pid);
            assert.deepEqual(sidecarIdentity.hashes, before);
          }
          // This table is private to the disposable migrated database. It
          // exercises the existing durable-step seam without a shared DBOS run.
          await sql.unsafe("CREATE TABLE public.timing_control_steps (name text PRIMARY KEY, output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object'))");
          const logs = [];
          const outcome = await runGitSync('isolated-timing-control', {
            repoPath: repo,
            config: { push: false, pushSubmoduleOrigins: false },
            log: line => logs.push(line),
            step: async (name, execute) => {
              const output = await execute();
              await sql.unsafe('INSERT INTO public.timing_control_steps VALUES ($1, $2::text::jsonb)',
                [name, JSON.stringify(output)]);
              return output;
            },
          });
          assert.equal(outcome.status, 'synced', JSON.stringify(outcome));
          const rows = await sql.unsafe('SELECT name, output FROM public.timing_control_steps ORDER BY name');
          for (const row of rows) assert.equal(typeof row.output, 'object', row.name);
          const outputs = new Map(rows.map(row => [row.name, row.output]));
          const setup = outputs.get('git-sync:submodules').submoduleTiming;
          const pointer = outputs.get('git-sync:pointer-bump').pointerBumpTiming;
          assert.equal(setup.sourceUrl, new URL('./packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
            'file://' + process.cwd() + '/').href);
          assert.equal(setup.pid, process.pid);
          assert.equal(setup.repoRoot, repo);
          assert.equal(pointer.pid, process.pid);
          assert.equal(pointer.repoRoot, repo);
          assert.notEqual(pointer.runId, setup.runId);
          assert.deepEqual(setup.setupSteps.map(step => step.name), [
            'url-sync', 'discovery', 'early-root-guards', 'early-root-migration-census',
            'early-root-commit', 'early-root-proof', 'remainder',
          ]);
          for (const step of setup.setupSteps) assert.ok(Number.isFinite(step.durationMs) && step.durationMs >= 0);
          const sum = setup.setupSteps.reduce((total, step) => total + step.durationMs, 0);
          assert.ok(Math.abs(sum - setup.setupMs) <= setup.setupSteps.length, 'rounded setup partition');
          assert.ok(pointer.durationMs >= pointer.commitDurationMs);
          assert.equal(git(repo, 'show', 'HEAD:root-work.txt'), 'root work');
          assert.equal(git(join(repo, 'libs/child'), 'show', 'HEAD:child-work.txt'), 'child work');
          assert.equal(git(repo, 'rev-parse', 'HEAD:libs/child'), git(join(repo, 'libs/child'), 'rev-parse', 'HEAD'));
          const events = logs.filter(line => line.startsWith('[git-sync:submodule-timing] '))
            .map(line => JSON.parse(line.slice('[git-sync:submodule-timing] '.length)));
          assert.equal(events.filter(event => event.event === 'setup-step' && event.runId === setup.runId).length, 7);
          let sidecarProof;
          if (mode === 'sidecar') {
            assert.deepEqual(getSidecarFallbackStats(), { total: 0, bySubsystem: {} }, 'no local fallback');
            // Wait for the server's final log writes and exact socket teardown
            // before inspecting its request-settled records.
            await stopSidecar();
            await writeFile(process.env.PC_TIMING_SIDECAR_LOG, sidecarOutput);
            const requests = sidecarOutput.split('\\n')
              .filter(line => line.startsWith('[spawner-process-exec-stage] '))
              .map(line => JSON.parse(line.slice('[spawner-process-exec-stage] '.length)));
            const settled = requests.filter(row => row.event === 'request-settled');
            for (const runId of [setup.runId, pointer.runId]) {
              assert.ok(settled.some(row => row.diagnosticTags?.runId === runId), 'phase reached sidecar: ' + runId);
            }
            assert.ok(settled.some(row => row.diagnosticTags?.gitSubcommand === 'commit-tree'), 'real attributed commit reached sidecar');
            for (const row of requests) {
              assert.equal(row.sidecarPid, sidecarIdentity.pid);
              assert.equal(row.poolAcquisitionContext?.requestId, row.diagnosticRequestId);
              assert.equal(row.poolAcquisitionContext?.operation, 'spawner.process.exec');
              assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
            }
            const receipts = await sql.unsafe(
              'SELECT receipt_id, state, record FROM harness_shared.resource_governor_admissions WHERE workspace_id = $1 AND namespace = $2',
              [process.env.PAPERCUSP_WORKSPACE_ID, 'agent-process']);
            assert.ok(receipts.length > 0, 'production admission wrote private receipts');
            for (const row of receipts) {
              assert.equal(row.state, 'completed', JSON.stringify(row));
              assert.equal(row.record.metadata.processKind, 'sidecar-exec');
              assert.equal(row.record.metadata.command, 'git');
            }
            assert.ok(receipts.some(row => row.record.metadata.gitSubcommand === 'commit-tree'));
            sidecarProof = { identity: sidecarIdentity, requests, receipts,
              fallback: getSidecarFallbackStats(), stopped: true };
          }
          assert.deepEqual(await hashes(), before, 'source remained stable through execution');
          const proof = { home, workspace: process.env.PAPERCUSP_WORKSPACE_ID,
            head: git(process.cwd(), 'rev-parse', 'HEAD'), hashes: before,
            runner: mode === 'local' ? 'default local Git; sidecar and shared-host contention excluded'
              : 'real IPC sidecar with default production admission; shared-host contention excluded',
            ...(sidecarProof ? { sidecar: sidecarProof } : {}),
            privateDatabase: true, stepsPersisted: rows.map(row => row.name), setup, pointer };
          await writeFile(process.env.PC_TIMING_CONTROL_OUTPUT, JSON.stringify(proof, null, 2));
          console.log('GIT_SYNC_TIMING_CONTROL ' + JSON.stringify({ setupMs: setup.setupMs,
            setupSteps: setup.setupSteps, pointerMs: pointer.durationMs }));
        } finally {
          try { await stopSidecar(); }
          finally {
            if (mode === 'sidecar') await writeFile(process.env.PC_TIMING_SIDECAR_LOG, sidecarOutput);
            await sql.end({ timeout: 5 });
          }
        }
        } catch (error) {
          console.error('GIT_SYNC_TIMING_CONTROL_FAILURE ' + (error?.stack ?? String(error)));
          process.exit(1);
        }
      `;
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', ...(mode === 'sidecar' ? ['--managed-tasks'] : []),
        '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PC_TIMING_CONTROL_OUTPUT: join(evidenceDir, 'timing-control.json'),
          PC_TIMING_SIDECAR_LOG: join(evidenceDir, 'sidecar.log'),
          OPENAI_API_KEY: 'forbidden-private-runtime-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-runtime-canary.sock' },
      });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, options);
      expect(result, isolatedWorkerFailureDetail(result.output, result)).toMatchObject({
        code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
      });
      const proof = JSON.parse(readFileSync(join(evidenceDir, 'timing-control.json'), 'utf8'));
      expect(proof.stepsPersisted).toEqual(['git-sync:pointer-bump', 'git-sync:push', 'git-sync:submodules']);
      expect(proof.hashes).toEqual(Object.fromEntries(paths.map(path => [path,
        // Compare the retained child identity with the same canonical source.
        // The proof helper also retains source and complete lifetime receipts.
        createSourceHash(path),
      ])));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
});

function createSourceHash(path: string): string {
  return createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
}
