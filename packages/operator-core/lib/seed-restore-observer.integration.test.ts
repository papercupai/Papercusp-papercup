import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { ensurePapercuspTmpdir, tmpdirHasCriticalHeadroom } from '@papercusp/test-config/tmpdir-guard';
import { tmpdir } from 'node:os';
import type { SeedObserverFixtureInput, SeedObserverFixtureEvent } from '../test/fixtures/seed-restore-observer-worker.mts';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof, withIsolatedIntegrationSourceObserver } from '../test/isolated-integration-proof';
import { createCdpClient, closeInspector, readSeedRestoreDiagnostics,
  captureSeedRestorePhases, waitForInspectorClosed } from '../../../scripts/cdp-inspector.mjs';
// @ts-ignore -- same maintained kernel listener/entry lifetime pin as CPU capture.
import { readInspectorProcessIdentity } from '../../../scripts/cpu-sample.mjs';

const root = resolve(import.meta.dirname, '../../..');
const workerPath = 'packages/operator-core/test/fixtures/seed-restore-observer-worker.mts';
const entry = join(root, workerPath);
const fixtureSources = [workerPath, 'libs/generic/seed-bundle/src/restore.ts',
  'libs/generic/seed-bundle/src/registry.ts', 'libs/generic/seed-bundle/src/manifest.ts'].sort();
const sourcePaths = [...fixtureSources, 'scripts/with-test-pg.mjs', 'scripts/cdp-inspector.mjs',
  'scripts/cpu-sample.mjs', 'scripts/proc-guard.mjs',
  'packages/operator-core/test/isolated-integration-proof.ts'];
const options = isolatedWorkerOptions(120_000);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const eventPrefix = 'SEED_RESTORE_OBSERVER_EVENT ';

// The parent source observer must be usable before recordIsolatedIntegrationProof
// freezes source. Setup work is not charged to the bounded CDP observation.
beforeAll(async () => {
  ensurePapercuspTmpdir();
  assert.ok(tmpdirHasCriticalHeadroom(tmpdir()), 'private runtime storage preflight');
  await withIsolatedIntegrationSourceObserver(async () => true);
}, 180_000);

for (const phase of ['verify', 'restore'] as const) {
it.runIf(process.platform === 'linux')(
  `qualifies a real isolated CDP child while provider.${phase} is held and proves original teardown`,
  async context => {
    let inputPath = '';
    let inputs: SeedObserverFixtureInput;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/seed-restore-observer.integration.test.ts',
      sourcePaths,
      retainedArtifacts: ['phases/prepare/fixture-inputs.json', 'phases/execute/seed-restore-observation.json'],
      prepare: async evidenceDir => {
        const files = fixtureSources.map(path => ({ path, sha256: digest(readFileSync(join(root, path))) }));
        inputs = { phase, files, buildSha: digest(JSON.stringify(files)), entrySha256: digest(readFileSync(entry)) };
        inputPath = join(evidenceDir, 'fixture-inputs.json');
        await writeFile(inputPath, JSON.stringify(inputs), { flag: 'wx' });
      },
      execute: async (observe, evidenceDir) => {
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', FORCE_COLOR: '0' };
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
          process.execPath, '--import', 'tsx', '--inspect=127.0.0.1:0', entry, phase, inputPath],
        { cwd: root, detached: true, env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        observe(child);
        let resolveReady!: (value: SeedObserverFixtureEvent) => void;
        let resolveHeld!: (value: SeedObserverFixtureEvent) => void;
        let resolveEndpoint!: (value: string) => void;
        const readyPromise = new Promise<SeedObserverFixtureEvent>(resolve => { resolveReady = resolve; });
        const heldPromise = new Promise<SeedObserverFixtureEvent>(resolve => { resolveHeld = resolve; });
        const endpointPromise = new Promise<string>(resolve => { resolveEndpoint = resolve; });
        let stdout = '', stderr = '';
        child.stderr!.on('data', chunk => {
          stderr += String(chunk);
          const endpoint = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+(?=\s)/)?.[0];
          if (endpoint) resolveEndpoint(endpoint);
        });
        child.stdout!.on('data', chunk => {
          stdout += String(chunk);
          const lines = stdout.split('\n');
          stdout = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith(eventPrefix)) continue;
            const value = JSON.parse(line.slice(eventPrefix.length));
            if (value.kind === 'ready') resolveReady(value);
            if (value.kind === 'held') resolveHeld(value);
          }
        });
        const captured = captureIsolatedWorker(child, evidenceDir, options);
        // Keep the original capture alive on all failures so its teardown can
        // still be observed and retained; never replace it with another child.
        const exitedBefore = captured.then(result => { throw new Error(isolatedWorkerFailureDetail(result.output)); });
        void exitedBefore.catch(() => {});
        let client: ReturnType<typeof createCdpClient> | undefined;
        let deadline = 0;
        let observationError: unknown;
        let inspectorPort: number | undefined;
        let receipt: Record<string, unknown> = { phase, evidencePlane: 'current-source-fixture' };
        const within = async <T>(action: () => Promise<T>): Promise<T> => {
          const remaining = deadline - Date.now();
          assert.ok(remaining > 0, '120s original observation deadline');
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([action(), new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('120s original observation deadline')), remaining);
            })]);
          } finally { clearTimeout(timeout); }
        };
        try {
          const ready = await Promise.race([readyPromise, exitedBefore]);
          const startedAt = Date.now();
          deadline = startedAt + 120_000;
          const lifecycle = JSON.parse(readFileSync(join(evidenceDir, 'lifecycle-observation.json'), 'utf8')).lifecycle;
          expect(ready).toMatchObject({ phase, pid: lifecycle.worker.pid, entry,
            sourceSha256: inputs!.entrySha256, buildSha: inputs!.buildSha, files: inputs!.files });
          // stdout readiness and stderr inspector publication have independent
          // delivery order. Await a complete URL from its own stream, bounded
          // by the original observation deadline and original worker lifetime.
          const endpoint = await within(() => Promise.race([endpointPromise, exitedBefore]));
          inspectorPort = Number(new URL(endpoint).port);
          const processPin = readInspectorProcessIdentity({ pid: ready.pid, port: inspectorPort,
            expectedEntry: entry, expectedArg: phase });
          client = createCdpClient(endpoint, { requestTimeoutMs: 2_000,
            webSocketOptions: { handshakeTimeout: 2_000, maxPayload: 1024 * 1024 } });
          await within(() => client!.connect());
          const expected = { expectedPid: ready.pid, expectedEntry: entry,
            expectedBuildSha: inputs!.buildSha, expectedSourceSha256: inputs!.entrySha256 };
          const unsupported = await within(() => readSeedRestoreDiagnostics(client!, expected));
          expect(unsupported).toMatchObject({ available: false, reason: 'seed restore phase journal unavailable' });
          const control = (method: 'begin' | 'release' | 'finish') => within(() => client!.evaluate(
            `(() => { if (process.pid !== ${ready.pid}) throw Error('fixture PID mismatch');
              return globalThis[Symbol.for('@papercusp/test.seed-restore-observer-control')].${method}(); })()`,
            { returnByValue: true }));
          await control('begin');
          const held = await within(() => Promise.race([heldPromise, exitedBefore]));
          expect(held.processInstanceId).toBe(ready.processInstanceId);
          const snapshot = await within(() => readSeedRestoreDiagnostics(client!, expected));
          expect(snapshot.available).toBe(true);
          assert.ok(snapshot.available);
          expect(snapshot.operations).toHaveLength(1);
          const operation = snapshot.operations[0];
          expect(operation).toMatchObject({ pid: ready.pid, status: 'running', droppedEvents: 0,
            identity: { processInstanceId: ready.processInstanceId } });
          expect(operation.events.at(-1)).toMatchObject({ kind: 'corestore', phase, state: 'started' });
          expect(operation.events).not.toContainEqual(expect.objectContaining({ phase, state: 'succeeded' }));
          if (phase === 'verify') expect(operation.events.some((event: { phase: string }) => event.phase === 'restore')).toBe(false);
          else expect(operation.events).toContainEqual(expect.objectContaining({ phase: 'verify', state: 'succeeded' }));
          await expect(within(() => readSeedRestoreDiagnostics(client!, {
            ...expected, expectedSourceSha256: '0'.repeat(64), expectedOperationId: operation.id,
          }))).rejects.toThrow('source identity mismatch');
          const markerBytes = readFileSync(ready.marker);
          expect(ready.marker).toBe(join(lifecycle.runtimeRoot, 'home', 'seed-restore-observer-marker.json'));
          expect(JSON.parse(markerBytes.toString())).toEqual({ pid: ready.pid, processInstanceId: ready.processInstanceId, phase });
          receipt = { ...receipt, expected, processPin, processInstanceId: ready.processInstanceId,
            lifecycle, unsupported, held: snapshot, operationId: operation.id,
            privateState: { path: ready.marker, sha256: digest(markerBytes) } };
          // Retain the distinguishing sample BEFORE releasing the provider.
          await writeFile(join(evidenceDir, 'seed-restore-observation.json'), JSON.stringify(receipt));
          await control('release');
          const terminal = await within(() => captureSeedRestorePhases(client!, { ...expected,
            expectedOperationId: operation.id, durationMs: Math.max(1, deadline - Date.now()) }));
          expect(terminal.operation).toMatchObject({ id: operation.id, status: 'succeeded', outcomeOk: true });
          expect(terminal.operation.events.at(-1)).toMatchObject({ phase: 'restore', state: 'succeeded' });
          await control('finish');
          await within(() => closeInspector(client!, inspectorPort!));
          client = undefined;
          receipt = { ...receipt, terminal, inspectorClosed: true, observationMs: Date.now() - startedAt };
          await writeFile(join(evidenceDir, 'seed-restore-observation.json'), JSON.stringify(receipt));
        } catch (error) {
          observationError = error;
          receipt = { ...receipt, observationError: error instanceof Error ? error.message : String(error) };
        } finally {
          client?.close();
          // Stop only our owned original supervisor. Its signal handler joins
          // the process group and PG cleanup before returning a terminal result.
          if (observationError && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          const result = await captured;
          receipt = { ...receipt, workerExit: { code: result.code, signal: result.signal, timedOut: result.timedOut } };
          await writeFile(join(evidenceDir, 'seed-restore-observation.json'), JSON.stringify(receipt));
          const original = JSON.parse(readFileSync(join(evidenceDir, 'lifecycle-observation.json'), 'utf8'));
          expect(original.ended).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
          expect(existsSync(original.lifecycle.runtimeRoot)).toBe(false);
          expect(existsSync(original.lifecycle.dataDir)).toBe(false);
          if (inspectorPort !== undefined) expect(await waitForInspectorClosed(inspectorPort)).toBe(true);
          if (observationError) throw observationError;
          expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
            timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
        }
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('SEED_RESTORE_OBSERVER_PROOF_RUN ' + JSON.stringify({ phase, runId }));
  }, options.testTimeoutMs);
}
