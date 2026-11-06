/** EI-27740004761558804: current-build writer and retained replay lifetime proof. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const filePath = 'packages/operator-core/lib/measurement-replay-background.integration.test.ts';
const workerOptions = isolatedWorkerOptions(450_000);
const sourcePaths = [
  filePath,
  'packages/operator-core/lib/measurement-replay-background.fixture.ts',
  'packages/operator-core/lib/harness/routines/rubric-rescore-action.ts',
  'packages/operator-core/lib/check-results-ledger.ts',
  'packages/operator-core/lib/rubrics-criterion-checks.ts',
  'packages/operator-core/lib/continuity-probes.ts',
  'packages/operator-core/lib/measurement-provenance.ts',
  'packages/operator-core/lib/rubric-instrument-registry.ts',
  'packages/operator-core/lib/retained-sql.ts',
  'packages/operator-core/lib/retained-replay-identity.ts',
  'packages/operator-core/lib/retained-replay-sources.json',
  'apps/operator/bin/bundle-host-common.sh',
  'packages/operator-core/test/compiled-library-fixture.ts',
  'scripts/check-bundled-cli-entry-guards.mjs',
  'scripts/check-no-hand-rolled-cli-entry.mjs',
  'scripts/lib/strip-comments-and-strings.mjs',
  'packages/operator-core/lib/util/cli-entry.ts',
  'packages/operator-core/lib/pg-read-query.ts',
  'libs/test-config/src/execution-details.ts',
];

it('persists and replays original command and SQL measurements after private live inputs change', async context => {
  const hashes = Object.fromEntries(sourcePaths.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  const runId = await recordIsolatedIntegrationProof({ root, filePath, sourcePaths,
    execute: async (observe, evidenceDir) => {
      const child = spawn(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath, '--import', 'tsx',
        resolve(root, 'packages/operator-core/lib/measurement-replay-background.fixture.ts')], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          MEASUREMENT_REPLAY_SOURCE_ROOT: root,
          MEASUREMENT_REPLAY_SOURCE_HASHES: JSON.stringify(hashes) },
      });
      observe(child);
      try {
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        expect(result, result.output.slice(-12_000)).toMatchObject({ code: 0, signal: null,
          timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = result.output.split('\n').find(row => row.startsWith('MEASUREMENT_REPLAY_RECEIPT '));
        expect(line, result.output.slice(-8_000)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('MEASUREMENT_REPLAY_RECEIPT '.length));
        expect(receipt.sourceHashes).toEqual(hashes);
        expect(receipt.workspaceId).toMatch(/^test-runtime-/);
        expect(receipt).toMatchObject({ recorded: 3, command: { value: 120, replay: 120 },
          sql: { value: 20, replay: 20 }, scoped: { value: 20, replay: 20, sqlReplay: 'unavailable' },
          liveAfterMutation: { command: 0, sql: 500 } });
        expect(receipt.crossRuntime).toMatchObject({
          sourceToCompiled: { command: { status: 'reproduced', value: 120 }, sql: { status: 'reproduced', value: 20 } },
          compiledToSource: { command: { status: 'reproduced', value: 0 }, sql: { status: 'reproduced', value: 500 } },
          changedArgv: { command: { status: 'unavailable' }, sql: { status: 'reproduced' } },
        });
        expect(receipt.crossRuntime.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
        console.info('MEASUREMENT_REPLAY_VERIFIED ' + JSON.stringify(receipt));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, workerOptions.testTimeoutMs);
