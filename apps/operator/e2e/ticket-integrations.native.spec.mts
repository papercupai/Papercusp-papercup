import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { recordNativeCollectionJourney } from './_ongoing-work-native-fixture';

const execute = promisify(execFile);

// Run via run-operator-e2e-isolated.sh. Reuse the registered shell assertions;
// Playwright's existing reporter supplies the measured e2e execution receipt.
test('native ticket integrations list providers and persist isolated source configuration', async ({}, info) => {
  test.setTimeout(240_000);
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const receiptPath = process.env.VERIFY_TAURI_SOURCE_RECEIPT;
  const phase = process.env.VH_PHASE_DIR;
  expect(root, 'frozen verifier source required').toBeTruthy();
  expect(receiptPath, 'original source receipt required').toBeTruthy();
  expect(phase, 'owned native assertion phase required').toBeTruthy();
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED).toBe('1');
  expect(process.env.VERIFY_TAURI_PID, 'native bridge required').toBeTruthy();

  const sourceReceipt = JSON.parse(await readFile(receiptPath!, 'utf8'));
  // The script and custody helper are tested inputs, not merely nearby files.
  for (const path of ['scripts/tauri-surface-verify-ticket-integrations.sh',
    'apps/operator/e2e/_ongoing-work-native-fixture.ts']) {
    expect(sourceReceipt.testedInputs.some((input: { path: string }) => input.path === path), path).toBeTruthy();
  }
  const completedRuntime = await recordNativeCollectionJourney({
    sourceRoot: root!, sourceReceipt,
    verifierRunId: basename(dirname(dirname(phase!))),
    testPath: 'apps/operator/e2e/ticket-integrations.native.spec.mts',
    run: async () => {
      let stdout: string, stderr: string;
      try {
        ({ stdout, stderr } = await execute('bash',
          [join(root!, 'scripts/tauri-surface-verify-ticket-integrations.sh')],
          { cwd: root!, env: process.env, timeout: 210_000, maxBuffer: 4 * 1024 * 1024 }));
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
        const output = (failure.stdout ?? '') + (failure.stderr ?? '');
        await info.attach('ticket-integrations-native-failure', {
          body: output, contentType: 'text/plain',
        });
        throw new Error(`Native ticket assertions failed (${failure.code ?? 'unknown'}):\n${output.slice(-12000)}`, { cause: error });
      }
      await info.attach('ticket-integrations-native-output', {
        body: stdout + stderr, contentType: 'text/plain',
      });
      expect(stdout).toContain('P007_TAURI_SURFACE_VERIFY_OK leg=ticket-integrations');
      expect(stdout).toContain('negative control: an unregistered provider is not reported');
      expect(stdout).toContain('Connect Linear and Connect Asana offered');
    },
  });
  await info.attach('native-completed-runtime', {
    body: JSON.stringify({ completedRuntime,
      runtimeUnits: [`verify-tauri-headless:${process.env.VERIFY_TAURI_PID}`] }),
    contentType: 'application/json',
  });
});
