import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { ensurePapercuspTmpdir, tmpdirHasCriticalHeadroom } from '@papercusp/test-config/tmpdir-guard';
import { tmpdir } from 'node:os';
import { defaultEvidenceRoot } from '@papercusp/verification-harness';
import type { SeedObserverFixtureInput, SeedObserverFixtureEvent } from '../test/fixtures/seed-restore-observer-worker.mts';
import { captureIsolatedWorker, isolatedWorkerFailureDetail, isolatedWorkerOptions,
  recordIsolatedIntegrationProof, withIsolatedIntegrationSourceObserver } from '../test/isolated-integration-proof';
import { createCdpClient, closeInspector, readSeedRestoreDiagnostics,
  captureSeedRestorePhases, waitForInspectorClosed } from '../../../scripts/cdp-inspector.mjs';
// @ts-ignore -- same maintained kernel listener/entry lifetime pin as CPU capture.
import { readInspectorProcessIdentity } from '../../../scripts/cpu-sample.mjs';
import { createTextCollector } from './child-output';

const root = resolve(import.meta.dirname, '../../..');
const workerPath = 'packages/operator-core/test/fixtures/seed-restore-observer-worker.mts';
const entry = join(root, workerPath);
const fixtureSources = [workerPath, 'libs/generic/seed-bundle/src/restore.ts',
  'libs/generic/seed-bundle/src/registry.ts', 'libs/generic/seed-bundle/src/manifest.ts'].sort();
const bootstrapSources = [...fixtureSources,
  'packages/operator-core/lib/harness/bootstrap-papercusp-hive.ts',
  'packages/operator-core/lib/sync/hyperbee/restore-hive-seed.ts',
  'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts',
  'packages/operator-core/lib/build-info.ts'];
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
  const evidenceRoot = defaultEvidenceRoot('isolated-integration');
  await mkdir(evidenceRoot, { recursive: true });
  for (const path of [tmpdir(), evidenceRoot]) {
    assert.ok(tmpdirHasCriticalHeadroom(path), 'private proof storage preflight: ' + path);
    const stat = statfsSync(path);
    assert.ok(stat.bavail * stat.bsize >= 2 * 1024 ** 3 + 64 * 1024 ** 2,
      'planned private PG (2GiB) and synthetic source/seed/target (64MiB) footprint');
  }
  await withIsolatedIntegrationSourceObserver(async () => true);
}, 180_000);

for (const phase of ['verify', 'restore', 'bootstrap'] as const) {
it.runIf(process.platform === 'linux')(
  phase === 'bootstrap' ? 'qualifies production bootstrap seed restore with real providers and private state'
    : `qualifies a real isolated CDP child while provider.${phase} is held and proves original teardown`,
  async context => {
    let inputPath = '';
    let inputs: SeedObserverFixtureInput;
    const runId = await recordIsolatedIntegrationProof({ root,
      filePath: 'packages/operator-core/lib/seed-restore-observer.integration.test.ts',
      sourcePaths: phase === 'bootstrap' ? [...sourcePaths, ...bootstrapSources] : sourcePaths,
      retainedArtifacts: ['phases/prepare/fixture-inputs.json', 'phases/execute/seed-restore-observation.json'],
      prepare: async evidenceDir => {
        // Recheck the pre-freeze admission on the actual retained-evidence path.
        for (const path of [tmpdir(), evidenceDir]) assert.ok(tmpdirHasCriticalHeadroom(path), 'private proof storage preflight: ' + path);
        const files = (phase === 'bootstrap' ? bootstrapSources : fixtureSources)
          .map(path => ({ path, sha256: digest(readFileSync(join(root, path))) }));
        inputs = { phase, files, buildSha: digest(JSON.stringify(files)), entrySha256: digest(readFileSync(entry)) };
        inputPath = join(evidenceDir, 'fixture-inputs.json');
        const storage = [tmpdir(), evidenceDir].map(path => {
          const stat = statfsSync(path);
          return { path, availableBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
        });
        await writeFile(inputPath, JSON.stringify({ ...inputs, storage,
          plannedFootprint: { privatePgBytes: 2 * 1024 ** 3, sourceSeedTargetBytes: 64 * 1024 ** 2 },
          footprint: 'two synthetic records, three tiny corestores plus canonical migrated private PG; no installed seed' }), { flag: 'wx' });
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
        createTextCollector(child.stderr, { retainText: false, onDecodedText: text => {
          stderr += text;
          const endpoint = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+(?=\s)/)?.[0];
          if (endpoint) resolveEndpoint(endpoint);
        } });
        createTextCollector(child.stdout, { retainText: false, onDecodedText: text => {
          stdout += text;
          const lines = stdout.split('\n');
          stdout = lines.pop()!;
          for (const line of lines) {
            if (!line.startsWith(eventPrefix)) continue;
            const value = JSON.parse(line.slice(eventPrefix.length));
            if (value.kind === 'ready') resolveReady(value);
            if (value.kind === 'held') resolveHeld(value);
          }
        } });
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
            return await Promise.race([action(), exitedBefore, new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('120s original observation deadline')), remaining);
            })]);
          } finally { clearTimeout(timeout); }
        };
        try {
          const ready = await Promise.race([readyPromise, exitedBefore]);
          const startedAt = Date.now();
          deadline = startedAt + 120_000;
          const lifecycle = JSON.parse(readFileSync(join(evidenceDir, 'lifecycle-observation.json'), 'utf8')).lifecycle;
          const expectedBuildSha = phase === 'bootstrap' ? ready.buildSha : inputs!.buildSha;
          expect(ready).toMatchObject({ phase, pid: lifecycle.worker.pid, entry,
            sourceSha256: inputs!.entrySha256, buildSha: expectedBuildSha, files: inputs!.files });
          if (phase === 'bootstrap') {
            assert.ok(ready.bootstrap);
            expect(ready.processInstanceId).toBeNull();
            expect(ready.bootstrap.sourceReceiptSha256).toBe(inputs!.buildSha);
            expect(ready.bootstrap.buildInfo.sha).toBe(ready.buildSha);
            expect(ready.bootstrap.buildProvenance).toMatch(/^bare-tsx development git fallback: [0-9a-f]{40}$/);
            expect(ready.bootstrap.runtime).toMatchObject({ home: join(lifecycle.runtimeRoot, 'home'),
              pgPort: String(lifecycle.pgPort), skipDiscovery: '1' });
            expect(ready.bootstrap.runtime.workspaceId).toMatch(/^test-runtime-/);
            for (const path of Object.values(ready.bootstrap.paths)) expect(path.startsWith(lifecycle.runtimeRoot + '/')).toBe(true);
            expect(ready.bootstrap.paths.targetStoreDir).toBe(join(ready.bootstrap.runtime.workspacesRoot,
              'papercusp-workspace', '.papercusp', 'papercusp', 'hyperbee'));
          }
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
            expectedBuildSha, expectedSourceSha256: inputs!.entrySha256 };
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
          expect(operation).toMatchObject({ pid: ready.pid, status: phase === 'bootstrap' ? 'succeeded' : 'running', droppedEvents: 0,
            identity: { processInstanceId: ready.processInstanceId } });
          if (phase === 'bootstrap') {
            expect(operation.identity).toMatchObject({ buildSha: ready.buildSha, sourceSha256: inputs!.entrySha256, script: entry });
            expect(operation.events.map((event: { kind: string; phase: string; state: string }) =>
              [event.kind, event.phase, event.state])).toEqual([
              ['corestore', 'resolve', 'started'], ['corestore', 'resolve', 'succeeded'],
              ['corestore', 'verify', 'started'], ['corestore', 'verify', 'succeeded'],
              ['corestore', 'restore', 'started'], ['corestore', 'restore', 'succeeded'],
            ]);
            expect(operation.outcomeOk).toBe(true);
            assert.ok(held.bootstrap);
            expect(held.bootstrap.restoredRecords).toEqual(ready.bootstrap!.records);
            expect(held.bootstrap.restoredRecords).toHaveLength(2);
            expect(held.bootstrap.seedAfter).toBe(ready.bootstrap!.seedBefore);
            expect(held.bootstrap.sourceAfter).toBe(ready.bootstrap!.sourceBefore);
            expect(held.bootstrap.joinCalls).toBe(1);
            expect(held.bootstrap.unexpectedEffects).toEqual([]);
          } else {
            expect(operation.events.at(-1)).toMatchObject({ kind: 'corestore', phase, state: 'started' });
            expect(operation.events).not.toContainEqual(expect.objectContaining({ phase, state: 'succeeded' }));
            if (phase === 'verify') expect(operation.events.some((event: { phase: string }) => event.phase === 'restore')).toBe(false);
            else expect(operation.events).toContainEqual(expect.objectContaining({ phase: 'verify', state: 'succeeded' }));
          }
          await expect(within(() => readSeedRestoreDiagnostics(client!, {
            ...expected, expectedSourceSha256: '0'.repeat(64), expectedOperationId: operation.id,
          }))).rejects.toThrow('source identity mismatch');
          const markerBytes = readFileSync(ready.marker);
          expect(ready.marker).toBe(join(lifecycle.runtimeRoot, 'home', 'seed-restore-observer-marker.json'));
          expect(JSON.parse(markerBytes.toString())).toEqual({ pid: ready.pid, processInstanceId: ready.processInstanceId, phase });
          receipt = { ...receipt, expected, processPin, processInstanceId: ready.processInstanceId,
            lifecycle, unsupported, held: snapshot, operationId: operation.id,
            ...(phase === 'bootstrap' ? { bootstrap: held.bootstrap } : {}),
            privateState: { path: ready.marker, sha256: digest(markerBytes) } };
          // Retain the sample before releasing the provider or post-restore join.
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
