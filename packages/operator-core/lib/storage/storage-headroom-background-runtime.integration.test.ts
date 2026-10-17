/** P-011 current-build acceptance on the maintained private background route. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const filePath = 'packages/operator-core/lib/storage/storage-headroom-background-runtime.integration.test.ts';
const assertion = 'packages/operator-core/lib/storage/disk-consumer-census.integration.test.ts';
const sources = [
  'packages/operator-core/lib/storage/disk-consumer-census.ts',
  'packages/operator-core/lib/storage/storage-growth-alarm.ts',
  'packages/operator-core/lib/dbos/routine-tick-overlap-guard.ts',
];
const selected = ['reports each consumer’s 24h growth', 'admits the oldest census pass'];
const options = isolatedTestFileWorkerOptions(process.env, 1);

it('fires the saved-census alarm and sheds overlapping starts in the observed private background runtime', async context => {
  let environmentObserved = false;
  let environmentError: unknown;
  const runId = await recordIsolatedIntegrationProof({
    root, filePath, sourcePaths: [assertion, ...sources,
      'packages/operator-core/lib/dbos/periodic-workflows.ts',
      'packages/operator-core/test/isolated-integration-proof.ts',
      'scripts/with-test-pg.mjs', 'scripts/test-files.mjs'],
    retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
      'phases/execute/headroom-test-receipts.ndjson', 'phases/execute/executed-source-map.json'],
    execute: async (observe, evidenceDir) => {
      const receipts = join(evidenceDir, 'headroom-test-receipts.ndjson');
      const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, join(root, 'scripts/test-files.mjs'),
        assertion, '--', '-t', selected.join('|')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'papercusp-workspace',
          PC_EXECUTED_SOURCE_MAP_OUT: join(evidenceDir, 'executed-source-map.json'),
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp', PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          OPENAI_API_KEY: 'forbidden-private-headroom-canary',
          PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/forbidden-private-headroom-canary.sock',
        },
      });
      observe(child);
      child.on('message', (message: any) => {
        if (message.kind !== 'isolated-runtime-start') return;
        try {
          const env = Object.fromEntries(readFileSync(`/proc/${message.childPid}/environ`, 'utf8')
            .split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]));
          expect(env).not.toHaveProperty('OPENAI_API_KEY');
          expect(env).not.toHaveProperty('PAPERCUSP_SUBSTRATE_IPC_SOCKET');
          expect(env.HOME).not.toBe(process.env.HOME);
          expect(env.PAPERCUSP_HOME).toBe(join(env.HOME!, '.papercusp'));
          expect(env.PAPERCUSP_BACKGROUND_WORKERS).toBe('1');
          expect(env.PAPERCUSP_DBOS_ROUTINES).toBe('0');
          expect(new URL(env.HARNESS_ADMIN_DATABASE_URL!).port).toBe(String(message.pgPort));
          expect(env.PAPERCUSP_WORKSPACE_ID).toMatch(/^test-runtime-/);
          environmentObserved = true;
        } catch (error) { environmentError = error; }
      });
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        expect(environmentError).toBeUndefined();
        expect(environmentObserved).toBe(true);
        const map = JSON.parse(readFileSync(join(evidenceDir, 'executed-source-map.json'), 'utf8'));
        const original = map.rows.find((value: any) => value.testFile === assertion)?.sourceEvidence;
        expect(original?.status).toBe('stable');
        for (const source of sources) expect(original.sources.find((value: any) => value.path === source))
          .toMatchObject({ basis: 'vite-pre-transform', sha256: createHash('sha256').update(readFileSync(join(root, source))).digest('hex') });
        const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const row = rows.find(value => value.filePath === assertion);
        expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
          passed: selected.length, failed: 0, collectionFailed: false,
        } } });
        for (const title of selected) expect(row.row.executionDetails.passedCaseTitles.some((passed: string) => passed.includes(title))).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, options.testTimeoutMs);
