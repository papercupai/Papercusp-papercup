/** EI-25600623966462999: real detached exits after the boot window. */
import { fork } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const workerOptions = isolatedWorkerOptions(45_000);

it('reports a real post-boot launcher refusal while preserving a completed native receipt', async context => {
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath: 'packages/operator-core/lib/console-spawn-kickoff.integration.test.ts',
    sourcePaths: ['packages/operator-core/lib/console-spawn.ts',
      'packages/operator-core/lib/task-manager/enroll-sync.ts',
      'packages/operator-core/test/isolated-integration-proof.ts', 'scripts/with-test-pg.mjs'],
    execute: async (observe, evidenceDir) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1' };
      // This plain worker writes lifecycle evidence through the maintained
      // helper. Only the outer Vitest runner owns its reporter/source-map sinks.
      for (const key of ['PC_EXECUTED_SOURCE_MAP_OUT', 'PC_EXECUTED_SOURCE_MAP_RESULT',
        'PC_EXECUTED_SOURCE_MAP_WORKSPACE', 'PAPERCUSP_TEST_RUN_RECEIPT_FILE']) delete env[key];
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '--input-type=module', '-e', String.raw`
          import assert from 'node:assert/strict';
          import { readFileSync } from 'node:fs';
          import { join } from 'node:path';
          import postgres from 'postgres';
          import { spawnHeadless, KICKOFF_PROOF_PATH_ENV, KICKOFF_PROOF_TOKEN_ENV }
            from './packages/operator-core/lib/console-spawn.ts';
          assert.match(process.env.PAPERCUSP_WORKSPACE_ID, /^test-runtime-/);
          assert.match(process.env.HOME, /papercusp-test-runtime-.*\/home$/);
          const url = new URL(process.env.HARNESS_ADMIN_DATABASE_URL);
          assert.equal(url.port, process.env.PAPERCUSP_PG_PORT);
          const sql = postgres(url.toString(), { max: 1 });
          const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
          try {
            const [server] = await sql.unsafe('SELECT inet_server_port() AS port');
            assert.equal(String(server.port), process.env.PAPERCUSP_PG_PORT);
            await sql.unsafe('CREATE TABLE public.kickoff_runtime_proof (outcome text PRIMARY KEY)');
            for (const delivered of [false, true]) {
              const launcher = [
                "const fs = require('node:fs');",
                'setTimeout(() => {',
                delivered ? 'fs.writeFileSync(process.env[' + JSON.stringify(KICKOFF_PROOF_PATH_ENV) +
                  '], JSON.stringify({ token: process.env[' + JSON.stringify(KICKOFF_PROOF_TOKEN_ENV) +
                  '], persisted: true, nativeRef: "fixture:delivered", reason: null }));' :
                  'console.error("TRACKED_FORK_REFUSED_FIXTURE");',
                'process.exit(' + (delivered ? 0 : 2) + '); }, 8500);',
              ].join('\n');
              const result = await spawnHeadless({
                envelope: { cwd: process.cwd(), env: {},
                  greetingCmd: quote(process.execPath) + ' -e ' + quote(launcher) },
                label: delivered ? 'kickoff-receipt-control' : 'kickoff-exit-control',
                logDir: join(process.env.HOME, 'logs'),
                spawnCommandProbes: { hasSystemdRun: () => false }, kickoffProof: true,
              });
              if (delivered) {
                assert.equal(result.status, 'ok', result.error);
                assert.deepEqual(result.kickoffProof,
                  { persisted: true, nativeRef: 'fixture:delivered', reason: null });
                const exit = await result.childExit;
                assert.equal(exit.code, 0);
              } else {
                assert.equal(result.status, 'error', JSON.stringify(result));
                assert.equal(result.code, 502);
                assert.match(result.error, /ended before kickoff proof \(exit 2\)/);
                assert.match(result.error, /TRACKED_FORK_REFUSED_FIXTURE/);
                assert.match(readFileSync(result.logPath, 'utf8'), /TRACKED_FORK_REFUSED_FIXTURE/);
                assert.ok(!result.error.includes('kickoff-proof-timeout'));
              }
              const outcome = delivered ? 'delivered' : 'refused';
              await sql.unsafe('INSERT INTO public.kickoff_runtime_proof (outcome) VALUES ($1)', [outcome]);
              console.log('KICKOFF_RUNTIME_RESULT ' + JSON.stringify({ outcome, status: result.status,
                code: result.code ?? null, proof: result.kickoffProof ?? null, workspace: process.env.PAPERCUSP_WORKSPACE_ID }));
            }
            const rows = await sql.unsafe('SELECT outcome FROM public.kickoff_runtime_proof ORDER BY outcome');
            assert.deepEqual(rows.map(row => row.outcome), ['delivered', 'refused']);
          } finally { await sql.end(); }
          process.exit(0);
        `,
      ], { cwd: root, detached: true, execArgv: [],
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
      expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      const outcomes = result.output.split('\n').filter(line => line.startsWith('KICKOFF_RUNTIME_RESULT '))
        .map(line => JSON.parse(line.slice('KICKOFF_RUNTIME_RESULT '.length)));
      expect(outcomes).toMatchObject([
        { outcome: 'refused', status: 'error', code: 502 },
        { outcome: 'delivered', status: 'ok', proof: { persisted: true, nativeRef: 'fixture:delivered' } },
      ]);
      expect(outcomes).toHaveLength(2);
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ISOLATED_KICKOFF_PROOF_RUN ' + runId);
}, workerOptions.testTimeoutMs);
