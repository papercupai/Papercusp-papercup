/** EI-25380500579773160: maintained current-build scorecards:list spill proof. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../../test/isolated-integration-proof';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const workerOptions = isolatedWorkerOptions(450_000);
const filePath = 'packages/operator-core/lib/agent-tools/scorecards/list-result-door-background.integration.test.ts';
const sourcePaths = [
  filePath,
  'packages/operator-core/lib/agent-tools/scorecards/list.ts',
  'packages/operator-core/lib/scorecards.ts',
  'packages/operator-core/lib/sync-resolver/scorecard-history-list-query.ts',
  'packages/operator-core/lib/result-door.ts',
  'packages/operator-core/lib/scratch-reference.ts',
  'packages/operator-core/lib/scratch-gc.ts',
  'packages/operator-core/lib/agent-tools/tools/invoke.ts',
  'packages/operator-core/test/_scorecards-list-result-door-child.ts',
  'packages/operator-core/test/isolated-integration-proof.ts',
  'scripts/with-test-pg.mjs',
  'scripts/test-files.mjs',
  'scripts/lib/batch-watchdog.mjs',
];

const sha256 = (path: string) =>
  createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');

it('spills and reads back a real 100-row scorecards:list result in a private isolated Postgres runtime', async (context) => {
  const expectedSourceHashes = Object.fromEntries(sourcePaths.map((path) => [path, sha256(path)]));
  const runId = await recordIsolatedIntegrationProof({
    root,
    filePath,
    sourcePaths,
    execute: async (observe, evidenceDir) => {
      const child = spawn(process.execPath, [
        resolve(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime',
        '--',
        process.execPath,
        '--import',
        'tsx',
        resolve(root, 'packages/operator-core/test/_scorecards-list-result-door-child.ts'),
      ], {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          PC_ISOLATED_RUNTIME_PROOF: '1',
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          SCORECARDS_EXPECTED_SOURCE_HASHES: JSON.stringify(expectedSourceHashes),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      observe(child);

      child.stdout!.on('data', (chunk) => {
        const text = String(chunk);
        for (const line of text.split('\n')) {
          if (line.startsWith('SCORECARDS_LIST_RESULT_DOOR_RECEIPT ')) console.info(line);
        }
      });

      try {
        const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
        const output = result.output;
        expect(result, output.slice(-12_000)).toMatchObject({ code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        const line = output.split('\n').find((row) => row.startsWith('SCORECARDS_LIST_RESULT_DOOR_RECEIPT '));
        expect(line, output.slice(-8_000)).toBeTruthy();
        const receipt = JSON.parse(line!.slice('SCORECARDS_LIST_RESULT_DOOR_RECEIPT '.length));
        expect(receipt.build.sourceHashes).toEqual(expectedSourceHashes);
        expect(receipt.runtime.workspaceId).toMatch(/^test-runtime-/);
        expect(receipt.runtime.pgPort).toBeTruthy();
        expect(receipt.list.rowCount).toBe(100);
        expect(receipt.list.outputBytes).toBeGreaterThan(100_000);
        expect(receipt.list.storedEvidence).toEqual({
          rows: 100,
          minChars: 2_000,
          maxChars: 2_000,
          totalChars: 200_000,
        });
        expect(receipt.list.returnedEvidence).toEqual({
          rows: 100,
          minBytes: 2_000,
          maxBytes: 2_000,
          totalBytes: 200_000,
        });
        expect(receipt.invoke.nestedDispatches).toBe(1);
        expect(receipt.resultDoor).toMatchObject({
          truncated: true,
          spillFailed: false,
          upstreamProjected: false,
          readbackIntegrity: 'verified',
        });
        expect(receipt.resultDoor.spillUri).toMatch(/^papercusp:\/\/scratch\//);
        expect(receipt.resultDoor.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(receipt.resultDoor.readback).toMatchObject({
          mode: 'direct-scratch-reference-parser',
          payloadBytes: receipt.resultDoor.manifest.byteCount,
          payloadSha256: receipt.resultDoor.manifest.sha256,
          scorecardRows: 100,
          firstIssueId: 'EI-sclrd-0001',
          lastIssueId: 'EI-sclrd-0100',
        });

        const runtimeRoot = receipt.runtime.runtimeRoot as string;
        const dataDir = output.match(/datadir ([^\)\n]+)/)?.[1];
        expect(dataDir, output.slice(-8_000)).toBeTruthy();
        expect(existsSync(runtimeRoot)).toBe(false);
        expect(existsSync(dataDir!)).toBe(false);
        console.info('SCORECARDS_LIST_RESULT_DOOR_VERIFIED ' + JSON.stringify({
          runId: receipt.runId,
          build: receipt.build,
          runtime: receipt.runtime,
          list: receipt.list,
          invoke: receipt.invoke,
          resultDoor: receipt.resultDoor,
          cleanup: { runtimeRemoved: true, pgDataRemoved: true },
        }));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
}, workerOptions.testTimeoutMs);
