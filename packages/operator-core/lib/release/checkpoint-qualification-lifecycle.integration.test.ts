/** Real Postgres regression for the shared qualification/repair row. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyReadPaths, writeExecutedSourceMapSnapshot } from '../../../../libs/test-config/src/executed-source-map-reporter';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('../pg-bounded-txn', () => ({
  boundedOrgTxn: async (run: (tx: Sql) => Promise<unknown>) => db.sql!.begin(async (tx) => run(tx as unknown as Sql)),
}));
// Queue projection is a separate filesystem optimization; keep this DB test's fixture isolated.
vi.mock('./frozen-repair-edit-marker', () => ({ projectFrozenRepairMarker: () => {} }));

import {
  beginQualificationTransaction,
  beginStoredQualification,
  cancelStoredQualification,
  composeStoredQualificationWork,
  checkpointPidIdentity,
  classifyScheduledQualificationJoin,
  configureRunnerLivenessProber,
  projectCheckpointQualificationState,
  probeRunnerLiveness,
  readStoredQualification,
  recordStoredQualificationRunnerProgress,
  recordStoredQualificationChildScope,
  recordStoredQualificationProgressObservation,
  qualificationProgressFence,
  recordStoredQualificationWorkProgress,
  recordStoredQualificationWorkYield,
  recordStoredQualificationNativeCompletion,
  recordStoredQualificationNativeProducer,
  recoverStoredQualificationNativeCompletions,
  continueStoredQualificationWork,
  type QualificationWorkProgressInput,
  recordStoredQualificationScheduledFire,
  recordStoredQualificationVerdict,
  recordStoredQualificationComposedVerdict,
  reserveQualificationRunner,
  reserveStoredQualificationRunner,
  settleQualificationTransaction,
  type RunnerLiveness,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  parseFrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  reconcileGateVerdictFreshnessWithRepairQueue,
  type FrozenRepairConvergenceReading,
} from './gate-verdict-freshness';
import { fireAwaitsForKey, registerAwait } from '../events/await/store';
import { writeFrozenCandidateRepairQueue } from '../harness/routines/release-actions';
import { evaluatePartialTaskContinuation, registerPartialNativeProducer, partialCurrentExecutionFingerprint,
  partialTaskCommandInputs, preparePartialTaskCommandDefinitions, readPartialTaskCommandCompletion } from '../../../../scripts/lib/partial-task-resume.mjs';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';
import { syncBudgetedTaskNativeExecutionReceipt, writeBudgetedTaskNativeExecutionReceipt } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
import { vitestConfigLoaderPolicy } from '../../../../scripts/lib/vitest-host-preflight.mjs';
import { captureRuntimeProofIdentity, runtimeProofFingerprint } from '../../../../scripts/lib/runtime-compatibility.mjs';
import { createQualificationYieldBoundary, resolveQualificationYieldBudget } from '../../../../scripts/lib/batch-watchdog.mjs';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-checkpoint-lifecycle', installSlug: 'papercusp' };

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
});

async function seed(metadata: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-checkpoint-lifecycle', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

async function metadata(): Promise<Record<string, unknown>> {
  const rows = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  return rows[0]!.metadata;
}

describe('checkpoint qualification lifecycle (real row lock and JSONB)', () => {
  it('progress-before-stop: re-reads an advancing enrolled payload before a stale stop decision', async () => {
    const nowMs = Date.now();
    const owner = { attemptId: 'stop-race', candidate: 'candidate-stop-race', runnerId: 'runner-stop-race',
      runId: 'run-stop-race', pid: 42, pidIdentity: 'boot:42', unit: 'pc-stoproot.scope',
      leaseDurationMs: 1000, started: true, nowMs: nowMs - 2000 };
    const current = reserveQualificationRunner(beginQualificationTransaction(null, owner).transaction, owner).transaction;
    await seed({ qualificationTransaction: current });
    // A cleanup decision was made before a payload was enrolled or its selected
    // completion became durable. The receiver must use the current locked row.
    const staleDecision = { attemptId: current.attemptId, unit: owner.unit, reason: 'stale-cleanup', nowMs };
    expect((await recordStoredQualificationChildScope(target, {
      ...owner, unit: 'pc-stopchild.scope', operation: 'enroll', nowMs,
    })).status).toBe('updated');
    const progressAtMs = Date.now();
    const work: QualificationWorkProgressInput = { ...owner, nowMs: progressAtMs, repairHead: null, root: '/repo',
      taskKey: 'stop-race-work', runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [],
      manifest: { schemaVersion: 1, units: [{ id: 'selected', kind: 'test', path: 'selected.test.ts' }] },
      updates: [{ receipt: { unitId: 'selected', completionId: 'new-progress', observedAtMs: progressAtMs,
        state: 'pass', firstAttemptVerdict: 'pass', worktreeDirty: false, observedCount: 1,
        proof: { recordedSha: owner.candidate, runContext: 'ci', runnerIdentity: 'proof-v3 node',
          executedModules: ['selected.test.ts'], readPaths: [], inputsCaptured: true, opaqueReasons: [] } } }] };
    expect(await recordStoredQualificationWorkProgress(target, work)).toMatchObject({ status: 'updated' });
    const beforeStop = await metadata();
    expect(beforeStop.qualificationTransaction).toMatchObject({
      currentPhysicalRunner: { id: owner.runnerId, childScopeUnits: ['pc-stopchild.scope'] },
      continuation: { receipts: [{ completionId: 'new-progress' }] },
    });
    const stop = vi.fn(async () => ({ stopped: true }));
    expect(await cancelStoredQualification(target, staleDecision, stop)).toMatchObject({
      status: 'conflict', refusalReason: 'child-scope-custody-held',
    });
    expect(stop).not.toHaveBeenCalled();
    expect(await metadata()).toEqual(beforeStop);
  });

  it('independent observer persists selected work and rejects retired generations in real JSONB', async () => {
    const nowMs = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      const owner = { attemptId: 'observer-attempt', candidate: 'observer-candidate', runnerId: 'observer-runner',
        runId: 'observer-run', pid: 42, pidIdentity: 'boot:42', unit: 'pc-observerroot.scope',
        leaseDurationMs: 60_000, started: true, nowMs: nowMs - 1000 };
      const current = reserveQualificationRunner(beginQualificationTransaction(null, {
        ...owner, nowMs: nowMs - 2000,
      }).transaction, owner).transaction;
      current.currentPhysicalRunner = { ...current.currentPhysicalRunner!, phase: 'suite', phaseEnteredAtMs: nowMs - 1000 };
      await seed({ qualificationTransaction: current });
      const input: QualificationWorkProgressInput = { ...owner, repairHead: null, root: '/repo', taskKey: 'observer-work',
        runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [], nowMs,
        manifest: { schemaVersion: 1, units: [{ id: 'selected', kind: 'test', path: 'selected.test.ts' }] }, updates: [] };
      expect((await recordStoredQualificationWorkProgress(target, input)).status).toBe('updated');
      const sample = { fence: qualificationProgressFence(current, target), observerGeneration: 'first-observer',
        sequence: 1, sampledAtMs: nowMs, monotonicAtMs: 1000, telemetryHealthy: true };
      expect((await recordStoredQualificationProgressObservation(target, sample)).status).toBe('updated');
      expect((await metadata()).qualificationTransaction).toMatchObject({
        progressObservation: { health: 'baseline', semantic: 'unknown', completedUnits: [] },
      });
      expect((await recordStoredQualificationWorkProgress(target, { ...input, nowMs: nowMs + 500, updates: [
        { receipt: { unitId: 'selected', completionId: 'first-completion', observedAtMs: nowMs + 500,
          state: 'pass', firstAttemptVerdict: 'pass', worktreeDirty: false, observedCount: 1,
          proof: { recordedSha: owner.candidate, runContext: 'ci', runnerIdentity: input.runnerIdentity,
            executedModules: ['selected.test.ts'], readPaths: [], inputsCaptured: true, opaqueReasons: [] } } },
      ] })).status).toBe('updated');
      expect((await recordStoredQualificationProgressObservation(target, {
        ...sample, sequence: 2, sampledAtMs: nowMs + 1000, monotonicAtMs: 2000,
      })).status).toBe('updated');
      const beforeRestart = (await metadata()).qualificationTransaction;
      expect(beforeRestart).toMatchObject({ progressObservation: { health: 'healthy', semantic: 'advancing',
        completedUnits: ['selected'], lastUsefulProgressMonotonicMs: 2000 },
        currentPhysicalRunner: current.currentPhysicalRunner });
      expect((await recordStoredQualificationProgressObservation(target, {
        ...sample, observerGeneration: 'replacement-observer', sampledAtMs: nowMs + 2000, monotonicAtMs: 1,
      })).status).toBe('updated');
      const restarted = (await metadata()).qualificationTransaction;
      expect(restarted).toMatchObject({ progressObservation: { health: 'baseline', semantic: 'unknown',
        retiredObserverGenerations: ['first-observer'], lastUsefulProgressMonotonicMs: null } });
      expect(await recordStoredQualificationProgressObservation(target, {
        ...sample, sequence: 3, sampledAtMs: nowMs + 3000, monotonicAtMs: 4000,
      })).toMatchObject({ status: 'conflict', refusalReason: 'observer-retired-generation' });
      expect((await metadata()).qualificationTransaction).toEqual(restarted);
    } finally { clock.mockRestore(); }
  });

  it.each(['complete', 'live-predecessor', 'unknown-predecessor', 'missing-terminal', 'terminal-error',
    'prefix-error', 'missing-post', 'old-fence', 'source-drift', 'different-task'] as const)(
    'composes a dead native prefix with only its remaining file: %s', async scenario => {
      const root = mkdtempSync(join(tmpdir(), 'qualification-prefix-source-'));
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      let fixture: Awaited<ReturnType<typeof nativeRecoveryFixture>> | undefined;
      try {
        git('init', '--quiet');
        for (const file of ['native.test.ts', 'remaining.test.ts', 'input.json']) writeFileSync(join(root, file), '{}\n');
        git('add', '.');
        git('-c', 'user.name=Qualification fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '--quiet', '-m', 'fixture');
        fixture = await nativeRecoveryFixture({ root, candidate: git('rev-parse', 'HEAD') });
        fixture.input.manifest.units.push({ id: 'remaining', kind: 'test', path: 'remaining.test.ts' },
          { id: 'post', kind: 'post-suite', path: 'input.json' });
        const specifications = fixture.observation.selectedSpecifications;
        specifications.push({ ...specifications[0]!, testFile: 'remaining.test.ts' });
        fixture.snapshot.nativeRun.selectedManifest = { specifications: structuredClone(specifications),
          sha256: createHash('sha256').update(JSON.stringify(specifications)).digest('hex') };
        fixture.save();
        const first = fixture.enroll();
        expect((await recordStoredQualificationNativeProducer(target, fixture.input, first)).status).toBe('updated');
        expect((await recoverStoredQualificationNativeCompletions(target, fixture.input, first.classifyReadPaths)).status)
          .toBe('updated');
        const banked = await readStoredQualification(target);
        expect(banked).toMatchObject({ transaction: { continuation: { receipts: [
          expect.objectContaining({ unitId: 'native', completionId: 'native-completion' }),
        ] } } });
        expect((await reserveStoredQualificationRunner(target, { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
          pid: 43, pidIdentity: 'boot:43', incumbentLiveness: 'dead', nowMs: 500 })).status).toBe('updated');
        const input = { ...fixture.input, runnerId: 'runner-two', runId: 'run-two', pidIdentity: 'boot:43', nowMs: 900 };
        const stored = await readStoredQualification(target);
        if (stored.status !== 'present') throw new Error('fixture qualification missing');
        expect(evaluatePartialTaskContinuation({ root, taskKey: input.taskKey, continuation: stored.transaction.continuation },
          { ...input, sourceCommit: input.candidate })).toMatchObject({ reused: ['native'], run: ['post', 'remaining'] });

        // Execute/enroll only the missing file. The old completed file is never
        // included in this producer's independent selection or output population.
        const path = join(fixture.directory, 'remaining.json');
        const selected = [specifications[1]!];
        const taskKey = scenario === 'different-task' ? 'another-task' : first.taskKey;
        const producer = registerPartialNativeProducer(path, { attemptId: input.attemptId, runGroupId: input.runId,
          root, taskKey, workspaceName: first.workspaceName, sourceCommit: input.candidate, registeredAtMs: 550,
          command: { cwd: root, cmd: 'npm', argv: ['run', 'test'] }, selectedSpecifications: selected }, { NODE_ENV: 'test' });
        expect((await recordStoredQualificationNativeProducer(target, input, { ...first, taskKey, path,
          producerPath: producer.path, selectedSpecifications: selected })).status).toBe('updated');
        const remaining = structuredClone(fixture.snapshot);
        remaining.completionCheckpoint.runGroupId = input.runId;
        remaining.rows[0]!.testFile = 'remaining.test.ts';
        remaining.rows[0]!.executedModules = ['remaining.test.ts'];
        remaining.nativeRun.selectedManifest = { specifications: structuredClone(selected),
          sha256: createHash('sha256').update(JSON.stringify(selected)).digest('hex') };
        const file = remaining.nativeRun.files[0]!;
        Object.assign(file, { testFile: 'remaining.test.ts', completionId: 'remaining-completion', observedAtMs: 650 });
        file.proof.sourceEvidence.sources[0]!.path = 'remaining.test.ts';
        remaining.nativeRun.startedAtMs = 600;
        if (scenario !== 'missing-terminal') Object.assign(remaining.nativeRun,
          { finishedAtMs: 700, terminalHook: 'onTestRunEnd', reason: 'passed', unhandledErrorCount: 0, modulePopulationMatched: true });
        if (scenario === 'terminal-error') Object.assign(remaining.nativeRun, { reason: 'failed', unhandledErrorCount: 1 });
        writeExecutedSourceMapSnapshot(path, remaining);
        if (scenario === 'prefix-error') {
          Object.assign(fixture.snapshot.nativeRun, { finishedAtMs: 280, reason: 'failed', unhandledErrorCount: 1 });
          fixture.save();
        }
        if (scenario !== 'missing-post') expect((await recordStoredQualificationWorkProgress(target, { ...input,
          updates: [{ receipt: { unitId: 'post', completionId: 'post-completion', state: 'pass', observedAtMs: 750,
            observedCount: 1, worktreeDirty: false, proof: { recordedSha: input.candidate, runContext: input.runContext,
              runnerIdentity: input.runnerIdentity, executedModules: ['input.json'], inputsCaptured: true,
              readPaths: [], opaqueReasons: [] } } }] })).status).toBe('updated');
        if (scenario === 'source-drift') writeFileSync(join(root, 'input.json'), '{"changed":true}\n');
        configureRunnerLivenessProber(() => scenario === 'live-predecessor' ? 'live' :
          scenario === 'unknown-predecessor' ? 'unknown' : 'dead');
        const before = await readStoredQualification(target);
        const request = { ...input, ...(scenario === 'old-fence' ? { runnerId: 'runner-one' } : {}) };
        const composed = await composeStoredQualificationWork(target, request, { classifyReadPaths: first.classifyReadPaths });
        if (scenario !== 'complete') {
          expect(composed).toMatchObject({ status: 'conflict' });
          expect(await readStoredQualification(target)).toEqual(before);
          return;
        }
        expect(composed).toMatchObject({ status: 'updated', transaction: { outcome: { kind: 'pending' },
          continuation: { receipts: expect.arrayContaining([
            expect.objectContaining({ unitId: 'native', completionId: 'native-completion' }),
            expect.objectContaining({ unitId: 'remaining', completionId: 'remaining-completion' }),
          ]) } } });
        const result = await recordStoredQualificationComposedVerdict(target, input, {
          candidate: input.candidate, runId: input.runId, reason: 'advanced', green: true, nowMs: 1000,
          terminalEvent: { status: 'qualification-prefix-composition-fixture', detail: { scenario } },
        }, { classifyReadPaths: first.classifyReadPaths });
        expect(result).toMatchObject({ status: 'updated', transaction: { outcome: { kind: 'green' }, currentPhysicalRunner: null } });
      } finally { configureRunnerLivenessProber(null); fixture?.cleanup(); rmSync(root, { recursive: true, force: true }); }
    }, 30_000,
  );
  it.each(['complete', 'missing-post', 'partial-native', 'native-error', 'missing-output', 'source-drift', 'old-fence'])(
    'composes the frozen full manifest atomically: %s', async scenario => {
      const root = mkdtempSync(join(tmpdir(), 'qualification-composition-source-'));
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      let fixture: Awaited<ReturnType<typeof nativeRecoveryFixture>> | undefined;
      try {
        // This is a disposable fixture repository, never the shared checkout.
        git('init', '--quiet');
        writeFileSync(join(root, 'native.test.ts'), 'export const native = true;\n');
        writeFileSync(join(root, 'input.json'), '{}\n');
        git('add', 'native.test.ts', 'input.json');
        git('-c', 'user.name=Qualification fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
        fixture = await nativeRecoveryFixture({ root, candidate: git('rev-parse', 'HEAD') });
        const input = fixture.input;
        input.manifest.units.push({ id: 'guard', kind: 'guard', path: 'input.json' },
          { id: 'post', kind: 'post-suite', path: 'input.json' });
        const observation = fixture.enroll();
        expect((await recordStoredQualificationNativeProducer(target, input, observation)).status).toBe('updated');
        expect((await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths)).status).toBe('updated');
        const proof = { recordedSha: input.candidate, runContext: input.runContext, runnerIdentity: input.runnerIdentity,
          executedModules: ['input.json'], inputsCaptured: true, readPaths: [], opaqueReasons: [] };
        expect((await recordStoredQualificationWorkProgress(target, { ...input, updates:
          ['guard', ...(scenario === 'missing-post' ? [] : ['post'])].map(id => ({ receipt: {
            unitId: id, completionId: `${id}-completion`, state: 'pass' as const, observedAtMs: 280,
            observedCount: 1, worktreeDirty: false, proof,
          } })) })).status).toBe('updated');
        if (scenario !== 'partial-native') Object.assign(fixture.snapshot.nativeRun, {
          finishedAtMs: 290, reason: 'passed', unhandledErrorCount: 0, modulePopulationMatched: true,
        });
        if (scenario === 'native-error') Object.assign(fixture.snapshot.nativeRun, { reason: 'failed', unhandledErrorCount: 1 });
        fixture.save();
        if (scenario === 'missing-output') rmSync(observation.path);
        if (scenario === 'source-drift') writeFileSync(join(root, 'input.json'), '{"changed":true}\n');
        const verdict = { candidate: input.candidate, runId: input.runId, reason: 'advanced', green: true,
          nowMs: 400, terminalEvent: { status: 'qualification-composition-fixture', detail: { scenario } } };
        const currentDefinition = vi.fn(() => { throw new Error('eligible retained commands must not execute or reauthenticate as current'); });
        const compositionOptions = { classifyReadPaths: observation.classifyReadPaths,
          currentCommandDefinition: currentDefinition };
        const composed = await composeStoredQualificationWork(target,
          { ...input, ...(scenario === 'old-fence' ? { runnerId: 'old' } : {}) },
          compositionOptions);
        expect(composed.status).toBe(scenario === 'complete' ? 'idempotent' : 'conflict');
        // Even a complete population cannot settle or release the physical owner
        // before the caller has performed its promotion decision.
        expect(await readStoredQualification(target)).toMatchObject({ transaction: { outcome: { kind: 'pending' },
          currentPhysicalRunner: { id: input.runnerId } } });
        const result = await recordStoredQualificationComposedVerdict(target,
          { ...input, ...(scenario === 'old-fence' ? { runnerId: 'old' } : {}) }, verdict,
          compositionOptions);
        expect(currentDefinition).not.toHaveBeenCalled();
        if (scenario === 'complete') {
          expect(result).toMatchObject({ status: 'updated', transaction: { outcome: { kind: 'green' },
            currentPhysicalRunner: null, continuation: { receipts: expect.arrayContaining([
              expect.objectContaining({ unitId: 'native' }), expect.objectContaining({ unitId: 'guard' }),
              expect.objectContaining({ unitId: 'post' }),
            ]) } } });
          expect(await readStoredQualification(target)).toMatchObject({ transaction: { outcome: { kind: 'green' } } });
        } else {
          expect(result).toMatchObject({ status: 'conflict' });
          expect(await readStoredQualification(target)).toMatchObject({ transaction: { outcome: { kind: 'pending' },
            currentPhysicalRunner: { id: input.runnerId } } });
        }
        const events = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM harness_shared.pipeline_events
          WHERE workspace_id = ${target.workspaceId} AND status = 'qualification-composition-fixture'
            AND detail->>'scenario' = ${scenario}`;
        expect(events[0]?.count).toBe(scenario === 'complete' ? 1 : 0);
      } finally { fixture?.cleanup(); rmSync(root, { recursive: true, force: true }); }
    }, 30_000,
  );
  it.each(['SIGTERM', 'SIGKILL'] as const)('resumes the independent population after a real native %s before its first snapshot', async signal => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const fixtureRoot = join(root, 'libs/test-config/src/__fixtures__/durable-completion');
    const config = join(fixtureRoot, 'vitest.config.ts');
    const argv = [join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs'),
      'run', '--root', fixtureRoot, '--config', config];
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim();
    const owner = { attemptId: 'native-crash-attempt', candidate, runnerId: 'native-crash-one',
      runId: 'native-crash-run-one', leaseDurationMs: 120_000 };
    // Discovery runs BEFORE the producer; surviving OUT files never define selection.
    const discovery = execFileSync(process.execPath, [join(root, 'scripts/resolve-vitest-config-contracts.mjs')], {
      cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      input: JSON.stringify({ requests: [{ root: fixtureRoot, repositoryRoot: root, config,
        enumerateFiles: true, enumerateSpecifications: true }] }),
    });
    const marker = 'PC_VITEST_CONFIG_CONTRACTS=';
    const line = discovery.split(/\r?\n/).find(value => value.startsWith(marker));
    const selected = JSON.parse(line!.slice(marker.length)).results[0];
    expect(selected.ok, discovery).toBe(true);
    const specifications: Array<{ testFile: string }> = selected.selectedSpecifications;
    expect(specifications).toHaveLength(3);
    await seed();
    expect((await beginStoredQualification(target, owner)).status).toBe('updated');
    const directory = mkdtempSync(join(tmpdir(), 'qualification-native-crash-'));
    const outPath = join(directory, 'out.json');
    Object.assign(env, {
      PC_COMPLETION_CRASH_WINDOW: 'before-first-snapshot', PC_COMPLETION_CRASH_SIGNAL: signal,
      PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/durable-completion-fixture',
      PC_EXECUTED_SOURCE_MAP_OUT: outPath, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
      PC_EXECUTED_INPUTS_DIR: join(directory, 'inputs'),
      PAPERCUSP_TEST_RUN_GROUP: owner.runId,
      PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: owner.attemptId,
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/native-crash-fixture',
    });
    const policy = vitestConfigLoaderPolicy(argv, env);
    const child = spawn(process.execPath, [...policy.vitestArgs, ...policy.configLoaderArgs], { cwd: fixtureRoot, env, detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
    const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const stopOwnedTree = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(stopOwnedTree, 120_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => reject(new Error(`native fixture exited before enrollment: ${output}`)));
        child.on('message', message => {
          if ((message as { kind?: string; pid?: number })?.kind === 'native-pre-snapshot-ready') resolve();
        });
      });
      const pidIdentity = checkpointPidIdentity(child.pid!);
      expect(pidIdentity).not.toBeNull();
      const input: QualificationWorkProgressInput = { ...owner, pidIdentity: pidIdentity!,
        root, taskKey: 'qualification', repairHead: null, runContext: 'clean-local',
        runnerIdentity: `proof-v3 ${process.version} ${process.platform} ${process.arch}`,
        retryStates: [], updates: [], manifest: { schemaVersion: 1,
          units: specifications.map(spec => ({ id: spec.testFile, kind: 'test' as const, path: spec.testFile })) } };
      expect((await reserveStoredQualificationRunner(target, { ...owner, pid: child.pid!, pidIdentity, started: true,
        evidenceRefs: [`checkpoint-run:${owner.runId}`] })).status).toBe('updated');
      const registration = registerPartialNativeProducer(outPath, { attemptId: owner.attemptId,
        sourceCommit: candidate, runGroupId: owner.runId, root, taskKey: 'native-fixture',
        workspaceName: env.PC_EXECUTED_SOURCE_MAP_WORKSPACE, registeredAtMs: Date.now(),
        selectedSpecifications: specifications, command: { cmd: process.execPath, argv, cwd: fixtureRoot } }, env);
      expect((await recordStoredQualificationNativeProducer(target, input, { path: outPath,
        producerPath: registration.path, taskKey: 'native-fixture', workspaceName: env.PC_EXECUTED_SOURCE_MAP_WORKSPACE!,
        selectedSpecifications: specifications })).status).toBe('updated');
      child.send({ kind: 'native-producer-registered' });
      expect(await stopped, output).toEqual({ code: null, signal });
      stopOwnedTree();
      expect(output).toContain(`REAL_COMPLETION_WRITE_INTERRUPTED phase=before-first-snapshot signal=${signal}`);
      expect(existsSync(outPath)).toBe(false);
      // The production prober measures the exact dead PID; no supplied liveness verdict.
      const replacement = { ...owner, runnerId: 'native-crash-two', runId: 'native-crash-run-two',
        pid: process.pid, pidIdentity: checkpointPidIdentity(process.pid)!, started: true };
      expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('updated');
      const resumed = { ...input, ...replacement };
      expect(await recoverStoredQualificationNativeCompletions(target, resumed, undefined, { recoverMissingSnapshots: true }))
        .toMatchObject({ status: 'updated', transaction: { continuation: { receipts: [], nativeProducers: [
          { missingSnapshot: { runnerId: owner.runnerId } },
        ] } } });
      const execute = vi.fn(async (_unit: { path: string }) => { throw new Error('replacement-boundary'); });
      await expect(continueStoredQualificationWork(target, resumed, execute)).rejects.toThrow('replacement-boundary');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(specifications.some(spec => spec.testFile === execute.mock.calls[0]?.[0]?.path)).toBe(true);
      expect(await readStoredQualification(target)).toMatchObject({ transaction: { attemptId: owner.attemptId,
        candidate, runId: replacement.runId, continuation: { manifest: input.manifest, receipts: [] } } });
    } finally {
      clearTimeout(timer);
      stopOwnedTree();
      await stopped;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 150_000);

  it.each(['SIGTERM', 'SIGKILL', 'primary-yield'] as const)('keeps a real acknowledged file banked across %s and executes only its unfinished peer', async scenario => {
    const signal = scenario === 'primary-yield' ? 'SIGTERM' : scenario;
    const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const directory = mkdtempSync(join(tmpdir(), 'qualification-banked-native-'));
    const root = join(directory, 'source');
    const fixtureRoot = join(root, 'libs/test-config/src/__fixtures__/durable-completion');
    const config = join(fixtureRoot, 'vitest.config.ts');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
    const children: Array<ReturnType<typeof spawn>> = [];
    let dependencyLease: string | undefined;
    const generationScript = join(sourceRoot, 'apps/operator/bin/release/dependency-generation.sh');
    const stop = (child: ReturnType<typeof spawn>) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!['PC_', 'VITEST', 'PAPERCUSP_TEST_', 'PAPERCUSP_CHECKPOINT_', 'PAPERCUSP_MUTATION_', 'AFFECTED_']
        .some(prefix => key.startsWith(prefix))) env[key] = value;
    }
    const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
    // This copied repository is clean and committed. Retain the inherited
    // committed-source guard while using its source-attested bundle support so
    // Vite supplies the configuration dependency census required by pass reuse.
    const argv = [vitest, 'run', '--root', fixtureRoot, '--config', config, '--configLoader', 'bundle'];
    const start = (environment: NodeJS.ProcessEnv) => {
      const policy = vitestConfigLoaderPolicy(argv, environment);
      const child = spawn(process.execPath, [...policy.vitestArgs, ...policy.configLoaderArgs], {
        cwd: fixtureRoot, env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      let output = '';
      child.stdout!.on('data', chunk => { output += chunk; });
      child.stderr!.on('data', chunk => { output += chunk; });
      const timer = setTimeout(() => stop(child), 120_000);
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      return { child, closed, output: () => output };
    };
    try {
      // A small independent source repository gives the native recorder a real
      // clean SHA even while peers edit the shared checkout. Copy the maintained
      // reporter/config/helpers; no substitute reporter or authored OUT is used.
      mkdirSync(join(root, 'libs/test-config'), { recursive: true });
      cpSync(join(sourceRoot, 'libs/test-config/src'), join(root, 'libs/test-config/src'), { recursive: true });
      cpSync(join(sourceRoot, 'libs/test-config/package.json'), join(root, 'libs/test-config/package.json'));
      mkdirSync(join(root, 'libs/generic'), { recursive: true });
      cpSync(join(sourceRoot, 'libs/generic/module-singleton'), join(root, 'libs/generic/module-singleton'), { recursive: true });
      mkdirSync(join(root, 'libs/test-config/node_modules/@papercusp'), { recursive: true });
      symlinkSync(join(root, 'libs/generic/module-singleton'), join(root, 'libs/test-config/node_modules/@papercusp/module-singleton'), 'dir');
      cpSync(join(sourceRoot, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
      cpSync(join(sourceRoot, 'package-lock.json'), join(root, 'package-lock.json'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'qualification-fixture', private: true, type: 'module', scripts: {
        preguard: 'node -e "console.log(111)"', guard: 'node -e "console.log(222)"',
        postguard: 'node -e "console.log(333)"', after: 'node -e "console.log(444)"',
      } }));
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n.vitest-tmp/\n');
      if (existsSync(join(sourceRoot, 'node_modules/.papercusp-dependency-generation'))) {
        symlinkSync(join(sourceRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
      } else {
        // A mutable development install cannot grant a reusable prefix. Select
        // and lease the maintained, already-published exact-input generation;
        // link its actual dependency bytes and copy its real immutable marker.
        // This never installs packages or invents a generation for this fixture.
        // Hermetic setup clears live generation-root environment overrides.
        // A maintained committed clone has a local origin: read its existing
        // store record, then still select by THIS checkout's exact inputs.
        const origin = execFileSync('git', ['-C', sourceRoot, 'remote', 'get-url', 'origin'],
          { encoding: 'utf8', timeout: 10_000 }).trim();
        const storeOwner = origin.startsWith('/') && existsSync(origin) ? origin : sourceRoot;
        const selected = execFileSync('bash', ['-c',
          'source "$1"; store=$(dependency_generation_resolve_root "$4"); ' +
          'dependency_generation_select_inputs "$2" "$store" || exit $?; ' +
          'dependency_generation_acquire_selector_lease "$store" "$DEPENDENCY_GENERATION_ID" "$3" "$DEPENDENCY_GENERATION_TOKEN" || exit $?; ' +
          'printf "FIXTURE_GENERATION=%s\\nFIXTURE_LEASE=%s\\n" "$DEPENDENCY_GENERATION_PATH" "$DEPENDENCY_GENERATION_SELECTOR_LEASE"',
          '--', generationScript, sourceRoot, String(process.pid), storeOwner],
        { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
        const generation = selected.split('\n').find(line => line.startsWith('FIXTURE_GENERATION='))?.slice('FIXTURE_GENERATION='.length);
        dependencyLease = selected.split('\n').find(line => line.startsWith('FIXTURE_LEASE='))?.slice('FIXTURE_LEASE='.length);
        if (!generation || !dependencyLease) throw new Error('immutable fixture dependency selection unmeasured');
        const modules = join(generation, 'tree/node_modules');
        mkdirSync(join(root, 'node_modules'));
        for (const entry of readdirSync(modules).filter(entry => entry !== '.papercusp-dependency-generation'))
          symlinkSync(join(modules, entry), join(root, 'node_modules', entry));
        const marker = Object.fromEntries(readFileSync(join(generation, '.papercusp-dependency-generation'), 'utf8')
          .trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        // The same two-field projection setup-release-checkout materializes;
        // identity/source are from the native selector's leased publication.
        writeFileSync(join(root, 'node_modules/.papercusp-dependency-generation'),
          `identity=${marker.identity}\nsource=${marker.source}\n`);
      }
      // Tests import Vitest from this materialization; launch that same module
      // graph so a mutable-install Vitest cannot drive immutable-install tests.
      argv[0] = join(root, 'node_modules/vitest/vitest.mjs');
      git('init', '--quiet');
      git('add', '.');
      git('-c', 'user.name=Qualification fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'native continuation source fixture');
      const candidate = git('rev-parse', 'HEAD');
      const owner = { attemptId: 'native-banked-attempt', candidate, runnerId: 'native-banked-one',
        runId: 'native-banked-run-one', leaseDurationMs: 120_000 };
      const outPath = join(directory, 'prefix.json');
      Object.assign(env, { PC_COMPLETION_CONTINUATION_FIXTURE: '1',
        PC_COMPLETION_CRASH_WINDOW: scenario === 'primary-yield' ? scenario : 'after-first-bank', PC_COMPLETION_CRASH_SIGNAL: signal,
        PC_EXECUTED_SOURCE_MAP_WORKSPACE: '@papercusp/durable-completion-fixture',
        PC_EXECUTED_SOURCE_MAP_OUT: outPath, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1',
        PC_EXECUTED_INPUTS_DIR: join(directory, 'inputs-one'), PAPERCUSP_TEST_RUN_GROUP: owner.runId,
        PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID: owner.attemptId,
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://127.0.0.1:1/native-banked-fixture' });
      const trace = await import(pathToFileURL(join(root, 'scripts/lib/vitest-startup-trace.mjs')).href);
      // The router already preloads the shared observer. This fixture owns a
      // copied source graph: replace that observer rather than installing both
      // and turning each real lifecycle spawn into two observations.
      const inheritedTrace = nativeProcessTraceEnv({ PC_EXECUTED_SOURCE_MAP_OUT: outPath }).NODE_OPTIONS!;
      env.NODE_OPTIONS = (env.NODE_OPTIONS ?? '').replaceAll(inheritedTrace, '').trim();
      Object.assign(env, trace.nativeProcessTraceEnv(env));
      const discover = (environment: NodeJS.ProcessEnv) => {
        const output = execFileSync(process.execPath, [join(sourceRoot, 'scripts/resolve-vitest-config-contracts.mjs')], {
          cwd: sourceRoot, env: environment, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
          input: JSON.stringify({ requests: [{ root: fixtureRoot, repositoryRoot: root, config,
            env: { PC_TEST_FILTER_LIST: environment.PC_TEST_FILTER_LIST },
            enumerateFiles: true, enumerateSpecifications: true }] }),
        });
        const marker = 'PC_VITEST_CONFIG_CONTRACTS=';
        const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker));
        expect(lines, output).toHaveLength(1);
        const result = JSON.parse(lines[0]!.slice(marker.length)).results[0];
        expect(result.ok, output).toBe(true);
        return result.selectedSpecifications as Array<{ testFile: string }>;
      };
      const specifications = discover(env);
      expect(specifications).toHaveLength(2);
      await seed();
      expect((await beginStoredQualification(target, owner)).status).toBe('updated');
      const quantumStartedAtMs = Date.now();
      const first = start(env);
      const firstBank = new Promise<void>((resolve, reject) => {
        first.child.on('message', message => {
          if ((message as { kind?: string })?.kind === 'native-first-bank-ready') resolve();
        });
        first.child.once('close', () => {
          if (scenario === 'primary-yield') reject(new Error(`native fixture exited before durable yield: ${first.output()}`));
        });
      });
      await new Promise<void>((resolve, reject) => {
        first.child.once('error', reject);
        first.child.once('close', () => reject(new Error(`native fixture exited before enrollment: ${first.output()}`)));
        first.child.on('message', message => {
          if ((message as { kind?: string })?.kind === 'native-pre-snapshot-ready') resolve();
        });
      });
      const pidIdentity = checkpointPidIdentity(first.child.pid!)!;
      expect(pidIdentity).toBeTruthy();
      const runtime = runtimeProofFingerprint(captureRuntimeProofIdentity({ root, environment: env, executable: process.execPath }));
      expect(runtime).toBeTruthy();
      const input: QualificationWorkProgressInput = { ...owner, pidIdentity, root, taskKey: 'qualification',
        repairHead: null, runContext: 'clean-local', runnerIdentity: `proof-v3 ${runtime}`,
        retryStates: [], updates: [], manifest: { schemaVersion: 1,
          units: [...specifications.map(spec => ({ id: spec.testFile, kind: 'test' as const, path: spec.testFile })),
            { id: 'guard:qualification-fixture :: guard', kind: 'guard', path: 'package.json' },
            { id: 'post:after', kind: 'post-suite', path: 'package.json' }] } };
      expect((await reserveStoredQualificationRunner(target, { ...owner, pid: first.child.pid!, pidIdentity,
        started: true, evidenceRefs: [`checkpoint-run:${owner.runId}`] })).status).toBe('updated');
      const enroll = async (progress: QualificationWorkProgressInput, path: string, selectedSpecifications: typeof specifications) => {
        const registration = registerPartialNativeProducer(path, { attemptId: owner.attemptId, sourceCommit: candidate,
          runGroupId: progress.runId, root, taskKey: 'native-fixture', workspaceName: env.PC_EXECUTED_SOURCE_MAP_WORKSPACE!,
          registeredAtMs: Date.now(), selectedSpecifications, command: { cmd: process.execPath, argv, cwd: fixtureRoot } }, env);
        const tracked = new Set(git('ls-files').split('\n'));
        const classifier = (reads: unknown, repoRoot: string) => classifyReadPaths(reads as string[], {
          repoRoot, isTracked: path => tracked.has(path) || [...tracked].some(file => file.startsWith(`${path}/`)), exists: existsSync,
        });
        expect((await recordStoredQualificationNativeProducer(target, progress, { path, producerPath: registration.path,
          taskKey: 'native-fixture', workspaceName: env.PC_EXECUTED_SOURCE_MAP_WORKSPACE!, selectedSpecifications })).status).toBe('updated');
        return classifier;
      };
      const classifier = await enroll(input, outPath, specifications);
      first.child.send({ kind: 'native-producer-registered' });
      if (scenario === 'primary-yield') {
        await firstBank;
        const budget = resolveQualificationYieldBudget({ startedAtMs: quantumStartedAtMs,
          quantumMs: Date.now() - quantumStartedAtMs + 50, deadlineEpochMs: Date.now() + 20_000,
          orphanDeadlineEpochMs: Date.now() + 25_000, yieldReserveMs: 5_000, cleanupReserveMs: 2_000 });
        if (budget.status !== 'ready') throw new Error(`yield budget refused: ${budget.reason}`);
        const identity = partialCurrentExecutionFingerprint({ ...input, sourceCommit: candidate })!;
        let receipts: Array<{ unitId: string; completionId: string }> = [];
        let boundary: ReturnType<typeof createQualificationYieldBoundary> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            boundary = createQualificationYieldBoundary({ identity, budget,
              unitIds: input.manifest.units.map(unit => unit.id),
              readDurableProgress: async () => {
                const recovered = await recoverStoredQualificationNativeCompletions(target, input, classifier);
                expect(recovered.status).toBe('updated');
                const stored = await readStoredQualification(target);
                if (stored.status !== 'present' || !stored.transaction.continuation)
                  throw new Error('yield progress missing');
                receipts = stored.transaction.continuation.receipts;
                return { status: 'ready', identity, receipts: stored.transaction.continuation.receipts };
              },
              commitYield: async (cursor, signal) => {
                const saved = await recordStoredQualificationWorkYield(target, input, {
                  runnerId: input.runnerId, runId: input.runId, savedAtMs: Date.now(),
                  executionCutoffEpochMs: cursor.budget.executionCutoffEpochMs,
                  yieldDeadlineEpochMs: cursor.budget.yieldDeadlineEpochMs,
                  cleanupDeadlineEpochMs: cursor.budget.cleanupDeadlineEpochMs,
                  orphanDeadlineEpochMs: cursor.budget.orphanDeadlineEpochMs,
                  callerDeadlineEpochMs: cursor.budget.callerDeadlineEpochMs,
                  completed: cursor.completedUnitIds.map(unitId => ({ unitId,
                    completionId: receipts.find(receipt => receipt.unitId === unitId)!.completionId })),
                  pendingUnitIds: [...cursor.pendingUnitIds],
                }, signal);
                return saved.status === 'updated';
              },
              onYield: () => resolve(), onKill: decision => reject(new Error(`primary yield killed: ${decision.reason}`)),
            });
          });
          expect(boundary!.state).toBe('yielded');
          const yielded = await readStoredQualification(target);
          expect(yielded).toMatchObject({ transaction: { outcome: { kind: 'pending' },
            currentPhysicalRunner: { id: owner.runnerId }, continuation: { lastYield: {
              runnerId: owner.runnerId, runId: owner.runId,
              completed: receipts.map(({ unitId, completionId }) => ({ unitId, completionId })),
              pendingUnitIds: input.manifest.units.map(unit => unit.id).filter(id => !receipts.some(receipt => receipt.unitId === id)),
              callerDeadlineEpochMs: budget.callerDeadlineEpochMs,
            } } } });
          expect(await probeRunnerLiveness(yielded.status === 'present' ? yielded.transaction.currentPhysicalRunner : null)).toBe('live');
          // Cleanup starts only after the cursor is read back, before handoff.
          process.kill(-first.child.pid!, signal);
        } finally { boundary?.stop(); }
      }
      // Native Vitest handles a parent-requested TERM and exits with 128+15.
      // The crash fixtures remove that handler and retain the signal directly.
      expect(await first.closed, first.output()).toEqual(scenario === 'primary-yield'
        ? { code: 143, signal: null } : { code: null, signal });
      stop(first.child);
      expect(first.output()).toContain('COMPLETION_ACK ids=');
      if (scenario !== 'primary-yield')
        expect(first.output()).toContain(`REAL_COMPLETION_WRITE_INTERRUPTED phase=after-first-bank signal=${signal}`);
      const prefixBytes = readFileSync(outPath);
      const snapshot = JSON.parse(prefixBytes.toString('utf8'));
      expect(snapshot.worktreeDirty).toBe(false);
      expect(snapshot.recordedSha).toBe(candidate);
      const producer = JSON.parse(readFileSync(`${outPath}.producer.json`, 'utf8'));
      expect(snapshot.nativeRun.startedAtMs).toBeGreaterThanOrEqual(producer.registeredAtMs);
      expect(snapshot.nativeRun.files).toHaveLength(1);
      const bankedFile = snapshot.nativeRun.files[0].testFile as string;
      const bankedId = snapshot.nativeRun.files[0].completionId as string;
      expect(snapshot.nativeRun.files[0].state, first.output()).toBe('passed');
      const replacement = { ...owner, runnerId: 'native-banked-two', runId: 'native-banked-run-two',
        pid: process.pid, pidIdentity: checkpointPidIdentity(process.pid)!, started: true };
      expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('updated');
      const resumed = { ...input, ...replacement };
      // Corrupt durable bytes and a stale writer must fail without advancing the bank.
      writeFileSync(outPath, '{"nativeRun":');
      expect(await recoverStoredQualificationNativeCompletions(target, resumed, classifier)).toMatchObject({ status: 'conflict' });
      writeFileSync(outPath, prefixBytes);
      expect(await recoverStoredQualificationNativeCompletions(target, input, classifier)).toMatchObject({ status: 'conflict' });
      const recovered = await recoverStoredQualificationNativeCompletions(target, resumed, classifier);
      expect({ status: recovered.status, ...('refusalReason' in recovered ? { refusalReason: recovered.refusalReason } : {}) })
        // Primary yield already authenticated and banked this exact completion.
        .toEqual({ status: scenario === 'primary-yield' ? 'idempotent' : 'updated' });
      const stored = await readStoredQualification(target);
      if (stored.status !== 'present') throw new Error('banked qualification missing');
      const grade = () => evaluatePartialTaskContinuation({ root, taskKey: input.taskKey,
        continuation: stored.transaction.continuation }, { ...resumed, sourceCommit: candidate });
      expect(grade()).toMatchObject({ reused: [bankedFile], run: specifications.filter(spec => spec.testFile !== bankedFile)
        .map(spec => spec.testFile).concat(['guard:qualification-fixture :: guard', 'post:after']).sort(), verdict: 'incomplete' });
      expect(await composeStoredQualificationWork(target, resumed, { classifyReadPaths: classifier }))
        .toMatchObject({ status: 'conflict', refusalReason: 'native-successor-terminal-unmeasured' });
      const remaining = specifications.filter(spec => spec.testFile !== bankedFile);
      const filter = join(directory, 'remaining-files.json');
      writeFileSync(filter, JSON.stringify(remaining.map(spec => relative(fixtureRoot, join(root, spec.testFile)))));
      const nextOut = join(directory, 'remaining.json');
      const nextEnv: NodeJS.ProcessEnv = { ...env, PC_TEST_FILTER_LIST: filter, PC_EXECUTED_SOURCE_MAP_OUT: nextOut,
        PC_EXECUTED_INPUTS_DIR: join(directory, 'inputs-two'), PAPERCUSP_TEST_RUN_GROUP: replacement.runId };
      delete nextEnv.PC_COMPLETION_CRASH_WINDOW;
      delete nextEnv.PC_COMPLETION_CRASH_SIGNAL;
      expect(discover(nextEnv)).toEqual(remaining);
      await enroll(resumed, nextOut, remaining);
      const second = start(nextEnv);
      expect(await second.closed, second.output()).toEqual({ code: 0, signal: null });
      const completed = JSON.parse(readFileSync(nextOut, 'utf8'));
      expect(completed.nativeRun.files.map((file: { testFile: string }) => file.testFile))
        .toEqual(remaining.map(spec => spec.testFile));
      expect(completed.nativeRun.files.some((file: { testFile: string }) => file.testFile === bankedFile)).toBe(false);
      // Actual original npm guard + post commands discharge their separately
      // frozen obligations. Their runtime reuse closure is deliberately opaque.
      const evidenceRoot = join(directory, 'commands');
      const task = 'qualification-fixture :: guard';
      const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
      const selection = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
        taskInventory: [{ id: task, dir: '.', command: scripts.guard, isInvariantGuard: true }],
        tasks: [], unenumerated: [], commandObligations: [] };
      const prepared = preparePartialTaskCommandDefinitions({ root, selection, evidenceRoot,
        postSuite: { schemaVersion: 1, coverage: 'complete', units: [{ id: 'post:after', kind: 'post-suite', path: 'package.json' }] },
        invocations: [{ task, cwd: root, argv: ['npm', 'run', 'guard'] }] });
      expect(prepared.status).toBe('ready');
      const guardDefinition = prepared.definitions[0]!;
      const source = () => ({ commit: git('rev-parse', 'HEAD'), clean: !git('status', '--porcelain') });
      const capture = async (script: string, task: string, ignoreScripts = false) => {
        const traceOut = join(directory, `${script}-${ignoreScripts}.trace.json`);
        const environment = trace.nativeProcessTraceEnv({ ...env, PC_EXECUTED_SOURCE_MAP_OUT: traceOut,
          npm_config_ignore_scripts: String(ignoreScripts) });
        const sourceBefore = source(), before = partialTaskCommandInputs(root, '.');
        const startedAtMs = Date.now();
        const child = spawn('npm', ['run', script], { cwd: root, env: environment, detached: true,
          stdio: ['ignore', 'pipe', 'pipe'] });
        children.push(child);
        const childIdentity = checkpointPidIdentity(child.pid!)!;
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        child.stdout!.on('data', chunk => stdout.push(chunk));
        child.stderr!.on('data', chunk => stderr.push(chunk));
        const timer = setTimeout(() => stop(child), 30_000);
        const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
        });
        expect(outcome).toEqual({ code: 0, signal: null });
        const saved = writeBudgetedTaskNativeExecutionReceipt(evidenceRoot, {
          task, attempt: resumed.runId, cwd: root, command: ['npm', 'run', script],
          invocation: { command: ['npm', 'run', script], environmentSha256: createHash('sha256')
            .update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))).digest('hex') },
          originalCommand: scripts[script], before, after: partialTaskCommandInputs(root, '.'),
          currentExecution: { schemaVersion: 1, fingerprint: partialCurrentExecutionFingerprint({ ...resumed, sourceCommit: candidate }),
            childPid: child.pid!, childIdentity, sourceBefore, sourceAfter: source() },
          processTrace: { out: traceOut, rootPid: child.pid! }, startedAtMs, finishedAtMs: Date.now(),
          exitCode: outcome.code, signal: outcome.signal, error: null, captureComplete: true,
          stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
        });
        syncBudgetedTaskNativeExecutionReceipt(saved);
        return saved;
      };
      const current = await readStoredQualification(target);
      if (current.status !== 'present') throw new Error('current command fence missing');
      const expected = () => ({ ...resumed, sourceCommit: candidate,
        runnerReservedAtMs: current.transaction.currentPhysicalRunner!.reservedAtMs, nowMs: Date.now() });
      const ignored = await capture('guard', task, true);
      expect(readPartialTaskCommandCompletion(ignored, expected(), guardDefinition)).toMatchObject({ status: 'refused' });
      // Even a stored zero-exit receipt cannot bypass the task lifecycle check.
      const guardReceipt = (saved: typeof ignored) => ({ unitId: `guard:${task}`, completionId: `${saved.receipt.sha256}:guard:${task}`,
        observedAtMs: saved.observation.execution.finishedAtMs, state: 'pass' as const, observedCount: 1,
        proof: { commandOutcomes: [{ command: task, root: saved.root, receipt: saved.receipt }],
          opaqueReasons: ['task-command-runtime-inputs-unmeasured'] } });
      const invalid = guardReceipt(ignored);
      expect((await recordStoredQualificationWorkProgress(target, { ...resumed, updates: [{ receipt: invalid }] })).status).toBe('updated');
      const options = { classifyReadPaths: classifier, currentCommandDefinition: (unit: { kind: string }) =>
        unit.kind === 'guard' ? guardDefinition : postDefinition };
      let postDefinition: unknown;
      expect(await composeStoredQualificationWork(target, resumed, options)).toMatchObject({ status: 'conflict' });
      const guard = readPartialTaskCommandCompletion(await capture('guard', task), expected(), guardDefinition);
      expect(guard.status, JSON.stringify(guard)).toBe('ready');
      expect((await recordStoredQualificationWorkProgress(target, { ...resumed, updates: guard.receipts.map(receipt =>
        ({ receipt, supersedesCompletionId: invalid.completionId })) })).status).toBe('updated');
      const post = await capture('after', 'post:after');
      postDefinition = { evidenceRoot, commands: [{ id: 'after', task: 'post:after', argv: ['npm', 'run', 'after'],
        cwd: root, originalCommand: scripts.after, inputs: partialTaskCommandInputs(root, '.'), exitCodes: [0] }] };
      expect((await recordStoredQualificationWorkProgress(target, { ...resumed, updates: [{ receipt: {
        unitId: 'post:after', completionId: post.receipt.sha256, observedAtMs: post.observation.execution.finishedAtMs,
        state: 'pass', observedCount: 1, proof: { commandOutcomes: [{ command: 'after', root: post.root, receipt: post.receipt }],
          opaqueReasons: ['post-suite-runtime-inputs-unmeasured'] },
      } }] })).status).toBe('updated');
      const composed = await composeStoredQualificationWork(target, resumed, options);
      expect(composed.status, JSON.stringify({ reason: 'refusalReason' in composed ? composed.refusalReason : null,
        dirty: completed.worktreeDirty, porcelain: git('status', '--porcelain'),
        config: completed.configSources.status,
        rows: completed.rows.map((row: { testFile: string; inputsCaptured: boolean; opaqueReasons: string[] }) =>
          ({ file: row.testFile, captured: row.inputsCaptured, opaque: row.opaqueReasons })) }))
        .toBe('updated');
      expect(composed)
        .toMatchObject({ status: 'updated', transaction: { outcome: { kind: 'pending' }, continuation: {
          receipts: expect.arrayContaining([expect.objectContaining({ unitId: bankedFile, completionId: bankedId })]),
        } } });
      const final = await readStoredQualification(target);
      expect(final).toMatchObject({ transaction: { attemptId: owner.attemptId, candidate,
        continuation: { receipts: expect.arrayContaining(remaining.map(spec => expect.objectContaining({ unitId: spec.testFile }))) } } });
      expect(git('status', '--porcelain')).toBe('');
      expect(await recordStoredQualificationComposedVerdict(target, resumed, { candidate, runId: resumed.runId,
        reason: 'advanced', green: true, terminalEvent: { status: 'real-native-guard-post-composition', detail: { scenario, signal } } }, options))
        .toMatchObject({ status: 'updated', transaction: { outcome: { kind: 'green' }, currentPhysicalRunner: null } });
    } finally {
      for (const child of children) stop(child);
      if (dependencyLease) execFileSync('bash', ['-c',
        'source "$1"; DEPENDENCY_GENERATION_SELECTOR_LEASE="$2"; dependency_generation_release_selector_lease',
        '--', generationScript, dependencyLease], { timeout: 10_000 });
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);

  it('recovers a producer killed before its first snapshot only after a measured dead handoff', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      const observation = fixture.enroll();
      rmSync(observation.path);
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('updated');
      const options = { recoverMissingSnapshots: true };
      expect(await recoverStoredQualificationNativeCompletions(target, fixture.input, observation.classifyReadPaths, options))
        .toMatchObject({ status: 'conflict', refusalReason: 'native-producer-not-proved-dead' });
      expect((await reserveStoredQualificationRunner(target, { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
        pid: 43, pidIdentity: 'boot:43', incumbentLiveness: 'dead', nowMs: 500 })).status).toBe('updated');
      const input = { ...fixture.input, runnerId: 'runner-two', runId: 'run-two', pidIdentity: 'boot:43', nowMs: 600 };
      for (const liveness of ['live', 'unknown'] as const) {
        configureRunnerLivenessProber(() => liveness);
        expect(await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths, options))
          .toMatchObject({ status: 'conflict', refusalReason: 'native-producer-not-proved-dead' });
      }
      configureRunnerLivenessProber(() => 'dead');
      // Recovery remains explicit; the default still refuses a missing artifact.
      expect(await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths))
        .toMatchObject({ status: 'conflict', refusalReason: 'snapshot-unreadable' });
      expect(await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths, options))
        .toMatchObject({ status: 'updated', transaction: { continuation: { receipts: [], nativeProducers: [
          { missingSnapshot: { runnerId: 'runner-one', confirmedAtMs: 600 } },
        ] } } });
      expect((await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths, options)).status)
        .toBe('idempotent');
      const execute = vi.fn(async () => { throw new Error('unacknowledged replacement'); });
      await expect(continueStoredQualificationWork(target, input, execute, options)).rejects.toThrow('unacknowledged replacement');
      expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 'native', kind: 'test', path: 'native.test.ts' });
      const before = await readStoredQualification(target);
      fixture.save(); // A late old writer cannot silently add evidence after retirement.
      expect(await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths, options))
        .toMatchObject({ status: 'conflict', refusalReason: 'retired-native-output-appeared' });
      expect(await readStoredQualification(target)).toEqual(before);
    } finally { configureRunnerLivenessProber(null); fixture.cleanup(); }
  });

  it.each(['banked', 'corrupt'] as const)('never retires a %s native artifact as missing', async damage => {
    const fixture = await nativeRecoveryFixture();
    try {
      const observation = fixture.enroll();
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('updated');
      if (damage === 'banked') {
        expect((await recoverStoredQualificationNativeCompletions(target, fixture.input, observation.classifyReadPaths)).status)
          .toBe('updated');
        rmSync(observation.path);
      } else writeFileSync(observation.path, '{corrupt');
      expect((await reserveStoredQualificationRunner(target, { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
        pid: 43, pidIdentity: 'boot:43', incumbentLiveness: 'dead', nowMs: 500 })).status).toBe('updated');
      const input = { ...fixture.input, runnerId: 'runner-two', runId: 'run-two', pidIdentity: 'boot:43', nowMs: 600 };
      configureRunnerLivenessProber(() => 'dead');
      const before = await readStoredQualification(target);
      expect(await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths,
        { recoverMissingSnapshots: true })).toMatchObject({ status: 'conflict', refusalReason: damage === 'banked'
          ? 'missing-native-output-has-banked-receipts' : 'snapshot-unreadable' });
      expect(await readStoredQualification(target)).toEqual(before);
    } finally { configureRunnerLivenessProber(null); fixture.cleanup(); }
  });

  it('persists an admitted retry predecessor and replays its archived receipt without hiding later demotion', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      fixture.input.retryStates = ['fail'];
      const first = fixture.enroll();
      fixture.snapshot.nativeRun.files[0]!.state = 'failed';
      fixture.snapshot.nativeRun.files[0]!.firstAttemptVerdict = 'fail';
      fixture.snapshot.nativeRun.files[0]!.cases[0]!.status = 'fail';
      Object.assign(fixture.snapshot.nativeRun, { finishedAtMs: 280, reason: 'failed', unhandledErrorCount: 0,
        modulePopulationMatched: true });
      fixture.save();
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, first)).status).toBe('updated');
      expect((await recoverStoredQualificationNativeCompletions(target, fixture.input, first.classifyReadPaths)).status).toBe('updated');
      expect((await reserveStoredQualificationRunner(target, { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
        pid: 43, pidIdentity: 'boot:43', incumbentLiveness: 'dead', nowMs: 500 })).status).toBe('updated');
      const input = { ...fixture.input, runnerId: 'runner-two', runId: 'run-two', pidIdentity: 'boot:43', nowMs: 900 };
      const out = join(fixture.directory, 'retry.json');
      const producer = registerPartialNativeProducer(out, {
        attemptId: input.attemptId, runGroupId: input.runId, root: input.root, taskKey: first.taskKey,
        workspaceName: first.workspaceName, sourceCommit: input.candidate, registeredAtMs: 550,
        selectedSpecifications: first.selectedSpecifications, command: { cwd: '/repo', cmd: 'npm', argv: ['run', 'test'] },
      }, { NODE_ENV: 'test' });
      const observation = { ...first, path: out, producerPath: producer.path };
      const before = await readStoredQualification(target);
      expect(await recordStoredQualificationNativeProducer(target, input, observation)).toMatchObject({
        status: 'conflict', refusalReason: 'native-producer-predecessor-mismatch' });
      expect(await readStoredQualification(target)).toEqual(before);
      expect((await recordStoredQualificationNativeProducer(target, input, { ...observation,
        supersedesCompletionIds: { native: 'native-completion' } })).status).toBe('updated');
      const retry = structuredClone(fixture.snapshot);
      retry.completionCheckpoint.runGroupId = 'run-two';
      Object.assign(retry.nativeRun, { startedAtMs: 600, finishedAtMs: 800, reason: 'passed' });
      Object.assign(retry.nativeRun.files[0]!, { state: 'passed', firstAttemptVerdict: 'pass',
        completionId: 'retry-completion', observedAtMs: 700, cases: [{ status: 'pass' }] });
      writeExecutedSourceMapSnapshot(out, retry);
      expect(await recoverStoredQualificationNativeCompletions(target, input, first.classifyReadPaths))
        .toMatchObject({ status: 'updated', transaction: { continuation: {
          receipts: [{ completionId: 'retry-completion', state: 'pass' }],
          supersededReceipts: [{ completionId: 'native-completion', state: 'fail' }],
          nativeProducers: [{}, { supersedesCompletionIds: { native: 'native-completion' } }],
        } } });
      expect((await recoverStoredQualificationNativeCompletions(target, input, first.classifyReadPaths)).status).toBe('idempotent');
      const after = await readStoredQualification(target);
      fixture.snapshot.nativeRun.files[0]!.state = 'error';
      fixture.save();
      expect((await recoverStoredQualificationNativeCompletions(target, input, first.classifyReadPaths)).status).toBe('conflict');
      expect(await readStoredQualification(target)).toEqual(after);
    } finally { fixture.cleanup(); }
  });

  it('retains enrolled task identity across JSONB and runner replacement, recovering only its recorded OUT', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      const observation = fixture.enroll();
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('updated');
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('idempotent');
      expect((await recordStoredQualificationWorkProgress(target, fixture.input)).status).toBe('idempotent');
      expect((await reserveStoredQualificationRunner(target, { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
        pid: 43, pidIdentity: 'boot:43', incumbentLiveness: 'dead', nowMs: 500 })).status).toBe('updated');
      const input = { ...fixture.input, runnerId: 'runner-two', runId: 'run-two', pidIdentity: 'boot:43', nowMs: 600 };
      expect((await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths)).status).toBe('updated');
      expect((await recoverStoredQualificationNativeCompletions(target, input, observation.classifyReadPaths)).status).toBe('idempotent');
      const stored = await readStoredQualification(target);
      expect(stored).toMatchObject({ status: 'present', transaction: { continuation: {
        nativeProducers: [{ taskKey: '@fixture/native::test', runGroupId: 'run-one' }],
        receipts: [{ unitId: 'native', completionId: 'native-completion' }],
      } } });
      expect(await recoverStoredQualificationNativeCompletions(target, fixture.input, observation.classifyReadPaths))
        .toMatchObject({ status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    } finally { fixture.cleanup(); }
  });

  it('rolls back the whole recovery batch when a later enrolled OUT is missing', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      fixture.input.manifest.units.push({ id: 'other', kind: 'test', path: 'other.test.ts' });
      const first = fixture.enroll();
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, first)).status).toBe('updated');
      const specifications = [{ ...first.selectedSpecifications[0]!, testFile: 'other.test.ts' }];
      const out = join(fixture.directory, 'missing.json');
      const producer = registerPartialNativeProducer(out, {
        attemptId: fixture.input.attemptId, runGroupId: fixture.input.runId, root: fixture.input.root,
        taskKey: '@fixture/other::test', workspaceName: '@fixture/other', sourceCommit: fixture.input.candidate,
        registeredAtMs: 210, selectedSpecifications: specifications,
        command: { cwd: '/repo', cmd: 'npm', argv: ['run', 'test'] },
      }, { NODE_ENV: 'test' });
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, {
        path: out, producerPath: producer.path, taskKey: '@fixture/other::test', workspaceName: '@fixture/other',
        selectedSpecifications: specifications,
      })).status).toBe('updated');
      const before = await readStoredQualification(target);
      expect(await recoverStoredQualificationNativeCompletions(target, fixture.input, first.classifyReadPaths))
        .toMatchObject({ status: 'conflict', refusalReason: 'snapshot-unreadable' });
      expect(await readStoredQualification(target)).toEqual(before);
      expect(before).toMatchObject({ transaction: { continuation: { receipts: [] } } });
    } finally { fixture.cleanup(); }
  });

  it.each(['producer-tamper', 'terminal-demotion'] as const)('refuses %s after banking a native pass', async damage => {
    const fixture = await nativeRecoveryFixture();
    try {
      const observation = fixture.enroll();
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('updated');
      expect((await recoverStoredQualificationNativeCompletions(target, fixture.input, observation.classifyReadPaths)).status).toBe('updated');
      const before = await readStoredQualification(target);
      if (damage === 'producer-tamper') {
        const producer = JSON.parse(readFileSync(observation.producerPath, 'utf8'));
        const { integrity: _seal, ...body } = producer;
        body.environmentDigest = 'f'.repeat(64);
        writeFileSync(observation.producerPath, JSON.stringify({ ...body, integrity: { schemaVersion: 1,
          sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') } }));
      } else {
        fixture.snapshot.nativeRun.gaps.push('terminal-unhandled-error' as never);
        fixture.save();
      }
      expect(await recoverStoredQualificationNativeCompletions(target, fixture.input, observation.classifyReadPaths))
        .toMatchObject({ status: 'conflict', refusalReason: damage === 'producer-tamper'
          ? 'native-producer-reference-mismatch' : 'continuation-completion-id-conflict' });
      expect(await readStoredQualification(target)).toEqual(before);
    } finally { fixture.cleanup(); }
  });

  it.each(['selection', 'clock', 'manifest'] as const)('does not enroll a native producer with mismatched %s', async damage => {
    const fixture = await nativeRecoveryFixture();
    try {
      const observation = fixture.enroll();
      const before = await readStoredQualification(target);
      if (damage === 'selection') observation.selectedSpecifications[0]!.testNamePattern = 'only-one-case';
      if (damage === 'clock') fixture.input.nowMs = 209;
      if (damage === 'manifest') fixture.input.manifest.units = [{ id: 'guard', kind: 'guard', path: 'native.test.ts' }];
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('conflict');
      expect(await readStoredQualification(target)).toEqual(before);
    } finally { fixture.cleanup(); }
  });

  it('stops continuation before execution and before final composition when the latest native artifact is demoted', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      fixture.input.manifest.units.push({ id: 'guard', kind: 'guard', path: 'guard.mjs' });
      const observation = fixture.enroll();
      expect((await recordStoredQualificationNativeProducer(target, fixture.input, observation)).status).toBe('updated');
      expect((await recoverStoredQualificationNativeCompletions(target, fixture.input, observation.classifyReadPaths)).status).toBe('updated');
      const execute = vi.fn(async (unit: { id: string }) => {
        fixture.snapshot.nativeRun.gaps.push('terminal-unhandled-error' as never);
        fixture.save();
        return { unitId: unit.id, completionId: 'guard-completion', observedAtMs: 275,
          state: 'pass' as const, worktreeDirty: false, observedCount: 1,
          proof: { recordedSha: fixture.input.candidate, runContext: fixture.input.runContext,
            runnerIdentity: fixture.input.runnerIdentity, executedModules: ['guard.mjs'],
            readPaths: [], inputsCaptured: true, opaqueReasons: [] } };
      });
      const options = { classifyReadPaths: observation.classifyReadPaths };
      expect(await continueStoredQualificationWork(target, fixture.input, execute, options))
        .toMatchObject({ status: 'refused', reason: 'completion-conflict', executed: ['guard'] });
      expect(execute).toHaveBeenCalledTimes(1);
      execute.mockClear();
      expect(await continueStoredQualificationWork(target, fixture.input, execute, options))
        .toMatchObject({ status: 'refused', reason: 'custody-conflict', executed: [] });
      expect(execute).not.toHaveBeenCalled();
    } finally { fixture.cleanup(); }
  });

  it('recovers native OUT through the current fence and replays identically after JSONB key reordering', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      expect((await recordStoredQualificationNativeCompletion(target, fixture.input, fixture.observation)).status).toBe('updated');
      expect((await recordStoredQualificationNativeCompletion(target, fixture.input, fixture.observation)).status).toBe('idempotent');
      const stored = await readStoredQualification(target);
      expect(stored).toMatchObject({ status: 'present', transaction: { continuation: {
        receipts: [{ unitId: 'native', completionId: 'native-completion', proof: { inputsCaptured: true, opaqueReasons: [] } }],
      } } });
    } finally { fixture.cleanup(); }
  });

  it('adopts an ended physical run only inside its recorded custody window and never accepts its late write', async () => {
    const fixture = await nativeRecoveryFixture();
    try {
      expect((await reserveStoredQualificationRunner(target, { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
        pid: 43, pidIdentity: 'boot:43', evidenceRefs: ['checkpoint-run:run-two'],
        incumbentLiveness: 'dead', nowMs: 500 })).status).toBe('updated');
      const input = { ...fixture.input, runnerId: 'runner-two', runId: 'run-two', pidIdentity: 'boot:43', nowMs: 600 };
      expect((await recordStoredQualificationNativeCompletion(target, input, fixture.observation)).status).toBe('updated');
      const before = await readStoredQualification(target);
      fixture.snapshot.nativeRun.files[0]!.observedAtMs = 501;
      fixture.snapshot.nativeRun.files[0]!.completionId = 'late-completion';
      fixture.save();
      expect(await recordStoredQualificationNativeCompletion(target, input, fixture.observation)).toMatchObject({
        status: 'conflict', refusalReason: 'native-physical-run-unmeasured-or-outside-custody' });
      const after = await readStoredQualification(target);
      expect(after).toEqual(before);
      expect(await recordStoredQualificationNativeCompletion(target, fixture.input, fixture.observation)).toMatchObject({
        status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    } finally { fixture.cleanup(); }
  });

  it.each(['run-error', 'config-drift', 'source-drift'] as const)('refuses %s demotion of an already banked native completion', async damage => {
    const fixture = await nativeRecoveryFixture();
    try {
      expect((await recordStoredQualificationNativeCompletion(target, fixture.input, fixture.observation)).status).toBe('updated');
      const before = await readStoredQualification(target);
      if (damage === 'run-error') fixture.snapshot.nativeRun.gaps.push('terminal-unhandled-error' as never);
      if (damage === 'config-drift') fixture.snapshot.configSources.status = 'changed';
      if (damage === 'source-drift') fixture.snapshot.nativeRun.files[0]!.proof.sourceEvidence.status = 'changed';
      fixture.save();
      expect(await recordStoredQualificationNativeCompletion(target, fixture.input, fixture.observation)).toMatchObject({
        status: 'conflict', refusalReason: 'continuation-completion-id-conflict' });
      // The caller must stop on this refusal; old receipts are not a final-run verdict.
      expect(await readStoredQualification(target)).toEqual(before);
    } finally { fixture.cleanup(); }
  });

  it.each(['foreign-group', 'before-custody', 'filtered-selection'] as const)('refuses native %s without changing the qualification row', async damage => {
    const fixture = await nativeRecoveryFixture();
    try {
      const before = await readStoredQualification(target);
      if (damage === 'foreign-group') fixture.snapshot.completionCheckpoint.runGroupId = 'unknown-run';
      if (damage === 'before-custody') fixture.snapshot.nativeRun.startedAtMs = 199;
      if (damage === 'filtered-selection') {
        fixture.snapshot.nativeRun.selectedManifest.specifications[0]!.testNamePattern = 'one-case';
        fixture.snapshot.nativeRun.selectedManifest.sha256 = createHash('sha256')
          .update(JSON.stringify(fixture.snapshot.nativeRun.selectedManifest.specifications)).digest('hex');
      }
      fixture.save();
      expect((await recordStoredQualificationNativeCompletion(target, fixture.input, fixture.observation)).status).toBe('conflict');
      expect(await readStoredQualification(target)).toEqual(before);
    } finally { fixture.cleanup(); }
  });

  it('executes only remaining eligible units after an unacknowledged callback interruption', async () => {
    await seed();
    await beginStoredQualification(target, { attemptId: 'attempt-execute', candidate: 'candidate-execute', nowMs: 100 });
    const owner = { attemptId: 'attempt-execute', candidate: 'candidate-execute', runnerId: 'runner-one', runId: 'run-one',
      pid: 42, pidIdentity: 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 };
    expect((await reserveStoredQualificationRunner(target, owner)).status).toBe('updated');
    const units = [
      { id: 'finished', kind: 'test' as const, path: 'finished.test.ts' },
      { id: 'guard', kind: 'guard' as const, path: 'guard.mjs' },
      { id: 'pending', kind: 'test' as const, path: 'pending.test.ts' },
      { id: 'post', kind: 'post-suite' as const, path: 'post.mjs' },
    ];
    const receipt = (unit: typeof units[number]) => ({ unitId: unit.id, completionId: `completion:${unit.id}`,
      observedAtMs: 250, state: 'pass' as const, firstAttemptVerdict: 'pass' as const,
      worktreeDirty: false, observedCount: 1, proof: { recordedSha: owner.candidate,
        runContext: 'ci', runnerIdentity: 'proof-v3 node', executedModules: [unit.path],
        readPaths: [], inputsCaptured: true, opaqueReasons: [] } });
    const input: QualificationWorkProgressInput = { ...owner, repairHead: null, root: '/repo', taskKey: 'qualification',
      runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [], nowMs: 300,
      manifest: { schemaVersion: 1, units }, updates: [{ receipt: receipt(units[0]!) }] };
    const dir = mkdtempSync(join(tmpdir(), 'qualification-starts-')), starts = join(dir, 'starts.jsonl');
    const observe = (id: string) => execFileSync(process.execPath, ['-e',
      'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({id:process.argv[2],pid:process.pid})+"\\n")',
      starts, id], { timeout: 5_000, maxBuffer: 64 * 1024 });
    try {
      await expect(continueStoredQualificationWork(target, input, async unit => {
        observe(unit.id);
        if (unit.id === 'pending') throw new Error('unacknowledged-worker-stop');
        return receipt(unit);
      })).rejects.toThrow('unacknowledged-worker-stop');
      const interrupted = await readStoredQualification(target);
      expect(interrupted.status).toBe('present');
      if (interrupted.status !== 'present') throw new Error('missing durable progress');
      expect(interrupted.transaction.continuation!.receipts.map(value => value.unitId).sort()).toEqual(['finished', 'guard']);
      const result = await continueStoredQualificationWork(target, { ...input, updates: [] }, async unit => {
        observe(unit.id); return receipt(unit);
      });
      expect(result).toMatchObject({ status: 'settled', executed: ['pending', 'post'], evaluation: {
        verdict: 'green', run: [], counts: { selected: 4, passed: 4, pending: 0 } } });
      const actual = readFileSync(starts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(actual.map(row => row.id)).toEqual(['guard', 'pending', 'pending', 'post']);
      expect(new Set(actual.map(row => row.pid)).size).toBe(4);
      expect(await continueStoredQualificationWork(target, { ...input, runnerId: 'other', updates: [] }, async () => {
        throw new Error('a losing runner must not start');
      })).toMatchObject({ status: 'refused', executed: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('resumes command and post-suite phases without executing or hiding outstanding test work', async () => {
    await seed();
    await beginStoredQualification(target, { attemptId: 'attempt-phases', candidate: 'candidate-phases', nowMs: 100 });
    const owner = { attemptId: 'attempt-phases', candidate: 'candidate-phases', runnerId: 'runner-one', runId: 'run-one',
      pid: 42, pidIdentity: 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 };
    expect((await reserveStoredQualificationRunner(target, owner)).status).toBe('updated');
    const units = [
      { id: 'test', kind: 'test' as const, path: 'pending.test.ts' },
      { id: 'command', kind: 'guard' as const, path: 'guard.mjs' },
      { id: 'post', kind: 'post-suite' as const, path: 'post.mjs' },
    ];
    const receipt = (unit: typeof units[number]) => ({ unitId: unit.id, completionId: `completion:${unit.id}`,
      observedAtMs: 250, state: 'pass' as const, firstAttemptVerdict: 'pass' as const,
      worktreeDirty: false, observedCount: 1, proof: { recordedSha: owner.candidate,
        runContext: 'ci', runnerIdentity: 'proof-v3 node', executedModules: [unit.path],
        readPaths: [], inputsCaptured: true, opaqueReasons: [] } });
    const input: QualificationWorkProgressInput = { ...owner, repairHead: null, root: '/repo', taskKey: 'qualification',
      runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [], nowMs: 300,
      manifest: { schemaVersion: 1, units }, updates: [] };
    const dir = mkdtempSync(join(tmpdir(), 'qualification-command-phases-')), starts = join(dir, 'starts.jsonl');
    const observe = (id: string) => execFileSync(process.execPath, ['-e',
      'require("node:fs").appendFileSync(process.argv[1], JSON.stringify({id:process.argv[2],pid:process.pid})+"\\n")',
      starts, id], { timeout: 5_000, maxBuffer: 64 * 1024 });
    try {
      // An observed zero exit without dependency proof is retained as evidence,
      // but remains executable. Diagnostic receipts cannot authorize a skip.
      expect(await continueStoredQualificationWork(target, input, async unit => {
        observe(unit.id);
        const { proof: _proof, ...observed } = receipt(unit);
        return { ...observed, completionId: 'unmeasured-command' };
      }, { unitIds: ['command'] })).toMatchObject({ status: 'settled', executed: ['command'],
        evaluation: { verdict: 'incomplete', reused: [], run: ['command', 'post', 'test'] } });
      await expect(continueStoredQualificationWork(target, input, async unit => {
        observe(unit.id);
        if (unit.id === 'post') {
          const stored = await readStoredQualification(target);
          expect(stored.status).toBe('present');
          if (stored.status !== 'present') throw new Error('missing durable command outcome');
          expect(stored.transaction.continuation!.receipts.map(value => value.unitId)).toEqual(['command']);
          throw new Error('post-command-interruption');
        }
        return receipt(unit);
      }, { unitIds: ['command', 'post'] })).rejects.toThrow('post-command-interruption');
      const result = await continueStoredQualificationWork(target, input, async unit => {
        observe(unit.id); return receipt(unit);
      }, { unitIds: ['command', 'post'] });
      expect(result).toMatchObject({ status: 'settled', executed: ['post'], evaluation: {
        verdict: 'incomplete', run: ['test'], reused: ['command', 'post'],
        counts: { selected: 3, passed: 2, pending: 1 } } });
      const before = await readStoredQualification(target);
      const forbidden = vi.fn(async () => { throw new Error('must not start another command'); });
      for (const [unitIds, reason] of [
        [[], 'unit-selection-invalid'], [['command', 'command'], 'unit-selection-invalid'],
        [['missing'], 'unit-selection-outside-manifest'],
      ] as const) {
        expect(await continueStoredQualificationWork(target, input, forbidden, { unitIds }))
          .toEqual({ status: 'refused', reason, executed: [] });
      }
      expect(await continueStoredQualificationWork(target,
        { ...input, updates: [{ receipt: receipt(units[0]!) }] }, forbidden, { unitIds: ['post'] }))
        .toEqual({ status: 'refused', reason: 'unit-selection-mixed-updates', executed: [] });
      expect(await continueStoredQualificationWork(target, { ...input, runnerId: 'other' }, forbidden,
        { unitIds: ['post'] })).toMatchObject({ status: 'refused', executed: [] });
      expect(forbidden).not.toHaveBeenCalled();
      expect(await readStoredQualification(target)).toEqual(before);
      // A scoped completion never settles the qualification or authorizes green.
      if (before.status !== 'present') throw new Error('missing live qualification');
      expect(before.transaction.phase).toBe('running');
      expect(before.transaction.outcome).toEqual({ kind: 'pending' });
      expect(await continueStoredQualificationWork(target, input, async unit => {
        observe(unit.id); return receipt(unit);
      }, { unitIds: ['test'] })).toMatchObject({ status: 'settled', executed: ['test'],
        evaluation: { verdict: 'green', run: [], counts: { selected: 3, passed: 3 } } });
      const actual = readFileSync(starts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(actual.map(row => row.id)).toEqual(['command', 'command', 'post', 'post', 'test']);
      expect(new Set(actual.map(row => row.pid)).size).toBe(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists production post-suite native output in the real row before a later command interruption', async () => {
    const { createCheckpointQualificationPostSuiteExecutor, runCmd } = await import('../../../../apps/operator/lib/release/green-checkpoint');
    await seed();
    const nowMs = Date.now();
    const root = mkdtempSync(join(tmpdir(), 'qualification-post-suite-output-'));
    try {
      const source = 'console.log(12345);\n';
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'lint:tsc': 'node guard.mjs' } }));
      writeFileSync(join(root, 'guard.mjs'), source);
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 }).trim();
      git('init', '--quiet'); git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
      const candidate = git('rev-parse', 'HEAD');
      await beginStoredQualification(target, { attemptId: 'attempt-post', candidate, nowMs });
      const owner = { attemptId: 'attempt-post', candidate, runnerId: 'runner-post', runId: 'run-post',
        pid: 42, pidIdentity: 'boot:42', leaseDurationMs: 60_000, started: true, nowMs: nowMs + 1 };
      expect((await reserveStoredQualificationRunner(target, owner)).status).toBe('updated');
      const input: QualificationWorkProgressInput = { ...owner, nowMs: nowMs + 2, repairHead: null, root,
        taskKey: 'qualification', manifest: { schemaVersion: 1, units: [
          { id: 'test:pending.test.ts', kind: 'test', path: 'pending.test.ts' },
          { id: 'post:lint:tsc', kind: 'post-suite', path: 'package.json' },
          { id: 'post:lint:tsc:operator', kind: 'post-suite', path: 'package.json' },
        ] }, retryStates: [], runContext: 'ci', runnerIdentity: 'proof-v3 node', updates: [] };
      const execute = createCheckpointQualificationPostSuiteExecutor({ target, progress: input }, async (cmd, args, options) => {
        if (args.includes('lint:tsc:operator')) {
          const saved = await readStoredQualification(target);
          expect(saved.status).toBe('present');
          if (saved.status !== 'present') throw new Error('missing qualification');
          expect(saved.transaction.continuation!.receipts.map(row => row.unitId)).toEqual(['post:lint:tsc']);
          throw new Error('following post-suite command interrupted');
        }
        return runCmd(cmd, args, { ...options, timeoutMs: 10_000 });
      });
      expect(await execute('npm', ['run', 'lint:tsc'], { cwd: root })).toMatchObject({ code: 0 });
      await expect(execute('npm', ['run', 'lint:tsc:operator'], { cwd: root }))
        .rejects.toThrow('following post-suite command interrupted');
      const saved = await readStoredQualification(target);
      if (saved.status !== 'present') throw new Error('missing durable post-suite outcome');
      expect(saved.transaction.continuation!.receipts).toMatchObject([
        { unitId: 'post:lint:tsc', state: 'pass', proof: { opaqueReasons: ['post-suite-runtime-inputs-unmeasured'] } },
        { unitId: 'post:lint:tsc:operator', state: 'infra' },
      ]);
      const outcomes = saved.transaction.continuation!.receipts[0]!.proof?.commandOutcomes;
      if (!Array.isArray(outcomes)) throw new Error('missing command artifacts');
      const pin = outcomes[0], bytes = readFileSync(join(pin.root, pin.receipt.ref));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.receipt.sha256);
      const artifact = JSON.parse(bytes.toString());
      expect(artifact.execution).toMatchObject({ command: ['npm', 'run', 'lint:tsc'], cwd: root, exitCode: 0 });
      expect(artifact).toMatchObject({ originalCommand: 'node guard.mjs', sourceInputsUnchanged: true,
        runtimeClosure: 'unmeasured', orderedChainQualified: false });
      const loaded = artifact.processTrace.loaderSources.entries.find((entry: { url: string }) => entry.url.endsWith('/guard.mjs'));
      expect(loaded, 'the acknowledged row must resolve its archived native loader bytes').toBeDefined();
      const loadedBytes = readFileSync(join(pin.root, loaded.artifact.ref));
      expect(loadedBytes.toString()).toBe(source);
      expect(createHash('sha256').update(loadedBytes).digest('hex')).toBe(loaded.artifact.sha256);
      expect(readFileSync(join(pin.root, artifact.execution.logs.stdout.ref), 'utf8')).toContain('12345');
      expect(evaluatePartialTaskContinuation({ root, taskKey: input.taskKey, continuation: saved.transaction.continuation },
        { ...input, sourceCommit: input.candidate })).toMatchObject({ status: 'ready', verdict: 'incomplete', reused: [],
        invalidated: [{ id: 'post:lint:tsc', reason: 'pass-proof-invalid-or-unmeasured' }] });
      expect(saved.transaction.outcome).toEqual({ kind: 'pending' });
      // A scoped driver fixture supplies an independently eligible proof. This
      // does not turn production raw source observations into runtime closure.
      const original = saved.transaction.continuation!.receipts[0]!;
      const qualified = { ...original, completionId: 'qualified-post-fixture', worktreeDirty: false,
        proof: { ...original.proof, recordedSha: candidate, runContext: input.runContext,
          runnerIdentity: input.runnerIdentity, executedModules: ['package.json'],
          inputsCaptured: true, readPaths: [], opaqueReasons: [] } };
      expect((await recordStoredQualificationWorkProgress(target, { ...input,
        updates: [{ receipt: qualified, supersedesCompletionId: original.completionId }] })).status).toBe('updated');
      const child = vi.fn().mockRejectedValue(new Error('completed command reran'));
      const resume = () => createCheckpointQualificationPostSuiteExecutor({ target, progress: input }, child);
      expect(await resume()('npm', ['run', 'lint:tsc'], { cwd: root }))
        .toMatchObject({ code: 0, stdout: expect.stringContaining('12345') });
      expect(child).not.toHaveBeenCalled();
      const resumed = await readStoredQualification(target);
      if (resumed.status !== 'present') throw new Error('missing resumed qualification');
      expect(resumed.transaction.continuation!.receipts[0]!.completionId).toBe(qualified.completionId);
      expect(evaluatePartialTaskContinuation({ root, taskKey: input.taskKey, continuation: resumed.transaction.continuation },
        { ...input, sourceCommit: candidate })).toMatchObject({ verdict: 'incomplete', reused: ['post:lint:tsc'] });
      writeFileSync(join(pin.root, loaded.artifact.ref), 'console.log(99999);\n');
      await expect(resume()('npm', ['run', 'lint:tsc'], { cwd: root })).rejects.toThrow('reuse-artifact-digest');
      expect(child).not.toHaveBeenCalled();
      const refused = await readStoredQualification(target);
      if (refused.status !== 'present') throw new Error('missing refused qualification');
      expect(refused.transaction.continuation!.receipts).toEqual(resumed.transaction.continuation!.receipts);
      expect(refused.transaction.outcome).toEqual({ kind: 'pending' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers exact pending test, guard and post-suite units from durable JSONB after runner replacement', async () => {
    await seed();
    await beginStoredQualification(target, { attemptId: 'attempt-work', candidate: 'candidate-work', nowMs: 100 });
    const owner = { attemptId: 'attempt-work', candidate: 'candidate-work', runnerId: 'runner-one', runId: 'run-one',
      pid: 42, pidIdentity: 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 };
    expect((await reserveStoredQualificationRunner(target, owner)).status).toBe('updated');
    const input: QualificationWorkProgressInput = { ...owner, repairHead: null, root: '/repo', taskKey: 'qualification',
      runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [], nowMs: 300,
      manifest: { schemaVersion: 1, units: [
        { id: 'finished', kind: 'test', path: 'finished.test.ts' },
        { id: 'pending', kind: 'test', path: 'pending.test.ts' },
        { id: 'guard', kind: 'guard', path: 'guard.mjs' },
        { id: 'post', kind: 'post-suite', path: 'post.mjs' },
      ] }, updates: [{ receipt: { unitId: 'finished', completionId: 'durable-completion', observedAtMs: 250,
        state: 'pass', firstAttemptVerdict: 'pass', worktreeDirty: false, observedCount: 1,
        proof: { recordedSha: 'candidate-work', runContext: 'ci', runnerIdentity: 'proof-v3 node',
          executedModules: ['finished.test.ts'], readPaths: [], inputsCaptured: true, opaqueReasons: [] } } }] };
    expect((await recordStoredQualificationWorkProgress(target, input)).status).toBe('updated');
    const replacement = { ...owner, runnerId: 'runner-two', runId: 'run-two', pid: 43, pidIdentity: 'boot:43',
      incumbentLiveness: 'dead' as const, nowMs: 50_000 };
    expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('updated');
    const recovered = await readStoredQualification(target);
    expect(recovered.status).toBe('present');
    if (recovered.status !== 'present') throw new Error('missing recovered qualification');
    const checkpoint = { root: input.root, taskKey: input.taskKey, continuation: { ...recovered.transaction.continuation,
      attemptId: input.attemptId, candidate: input.candidate, repairHead: null } };
    // Independent population established before reading the production evaluator's answer.
    const pending = ['guard', 'pending', 'post'];
    expect(evaluatePartialTaskContinuation(checkpoint, { ...input, sourceCommit: input.candidate }))
      .toMatchObject({ status: 'ready', verdict: 'incomplete', run: pending, reused: ['finished'],
        counts: { selected: 4, passed: 1, pending: 3 } });
    const beforeLateWrite = JSON.stringify(recovered.transaction);
    expect(await recordStoredQualificationWorkProgress(target, { ...input, nowMs: 50_100 })).toMatchObject({
      status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    const afterLateWrite = await readStoredQualification(target);
    expect(afterLateWrite.status).toBe('present');
    if (afterLateWrite.status === 'present') expect(JSON.stringify(afterLateWrite.transaction)).toBe(beforeLateWrite);
  });

  it('preserves a mixed durable failure frontier through runner death, replay and full composition', async () => {
    const { CHECKPOINT_QUALIFICATION_METADATA_KEY } = await import('./checkpoint-qualification-transaction');
    const root = mkdtempSync(join(tmpdir(), 'qualification-mixed-frontier-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let fixture: Awaited<ReturnType<typeof nativeRecoveryFixture>> | undefined;
    try {
      git('init', '--quiet');
      for (const file of ['native.test.ts', 'input.json']) writeFileSync(join(root, file), '{}\n');
      git('add', '.');
      git('-c', 'user.name=Qualification fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'mixed frontier fixture');
      const candidate = git('rev-parse', 'HEAD');
      const pidIdentity = checkpointPidIdentity(child.pid!)!;
      expect(pidIdentity).toBeTruthy();
      fixture = await nativeRecoveryFixture({ root, candidate, runner: { pid: child.pid!, pidIdentity } });
      const input = fixture.input;
      input.retryStates = ['fail', 'infra'];
      // Freeze the full population independently of receipts and evaluator output.
      const selected = ['native', 'guard-failed', 'post-infra', 'guard-pending', 'post-pending'];
      input.manifest.units.push(
        { id: 'guard-failed', kind: 'guard', path: 'input.json' },
        { id: 'post-infra', kind: 'post-suite', path: 'input.json' },
        { id: 'guard-pending', kind: 'guard', path: 'input.json' },
        { id: 'post-pending', kind: 'post-suite', path: 'input.json' },
      );
      Object.assign(fixture.snapshot.nativeRun, { finishedAtMs: 290, terminalHook: 'onTestRunEnd',
        reason: 'passed', unhandledErrorCount: 0, modulePopulationMatched: true });
      fixture.save();
      const observation = fixture.enroll();
      const options = { classifyReadPaths: observation.classifyReadPaths };
      expect((await recordStoredQualificationNativeProducer(target, input, observation)).status).toBe('updated');
      expect((await recoverStoredQualificationNativeCompletions(target, input, options.classifyReadPaths)).status).toBe('updated');
      const receipt = (unitId: string, state: 'pass' | 'fail' | 'infra', completionId: string, observedAtMs = 280) => ({
        unitId, state, completionId, observedAtMs, observedCount: 1, worktreeDirty: false,
        proof: { recordedSha: candidate, runContext: input.runContext, runnerIdentity: input.runnerIdentity,
          executedModules: ['input.json'], readPaths: [], inputsCaptured: true, opaqueReasons: [] },
      });
      expect((await recordStoredQualificationWorkProgress(target, { ...input, updates: [
        { receipt: receipt('guard-failed', 'fail', 'failed-before-crash') },
        { receipt: receipt('post-infra', 'infra', 'infra-before-crash') },
      ] })).status).toBe('updated');
      const beforeCrash = await readStoredQualification(target);
      if (beforeCrash.status !== 'present') throw new Error('mixed frontier missing before crash');
      const banked = structuredClone(beforeCrash.transaction.continuation!.receipts);
      const evaluate = (transaction: typeof beforeCrash.transaction, progress = input) =>
        evaluatePartialTaskContinuation({ root, taskKey: input.taskKey, continuation: transaction.continuation },
          { ...progress, sourceCommit: candidate });
      expect(evaluate(beforeCrash.transaction)).toMatchObject({ verdict: 'red', reused: ['native'],
        retainedFailures: ['guard-failed'], infrastructure: ['post-infra'], run: ['guard-failed', 'guard-pending', 'post-infra', 'post-pending'],
        counts: { selected: 5, passed: 1, failed: 1, infrastructure: 1, pending: 2 } });
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
      expect(await probeRunnerLiveness(beforeCrash.transaction.currentPhysicalRunner)).toBe('dead');
      const replacement = { ...fixture.owner, runnerId: 'runner-two', runId: 'run-two',
        pid: process.pid, pidIdentity: checkpointPidIdentity(process.pid)!, nowMs: 500 };
      expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('updated');
      const resumed = { ...input, ...replacement, nowMs: 900 };
      const recovered = await readStoredQualification(target);
      if (recovered.status !== 'present') throw new Error('mixed frontier missing after crash');
      expect(recovered.transaction.candidate).toBe(candidate);
      expect(recovered.transaction.continuation!.manifest.units.map(unit => unit.id)).toEqual(selected);
      expect(recovered.transaction.continuation!.receipts).toEqual(banked);
      expect(evaluate(recovered.transaction, resumed)).toEqual(evaluate(beforeCrash.transaction));
      // Replay of a passing receipt must not eclipse either unresolved result.
      expect((await recoverStoredQualificationNativeCompletions(target, resumed, options.classifyReadPaths)).status).toBe('idempotent');
      const executed: string[] = [];
      const continued = await continueStoredQualificationWork(target, resumed, async unit => {
        executed.push(unit.id);
        return receipt(unit.id, 'pass', 'finished:' + unit.id, 700);
      }, { ...options, unitIds: ['guard-pending', 'post-pending'] });
      expect(executed).toEqual(['guard-pending', 'post-pending']);
      expect(continued).toMatchObject({ status: 'settled', evaluation: { verdict: 'red',
        reused: ['guard-pending', 'native', 'post-pending'], retainedFailures: ['guard-failed'],
        infrastructure: ['post-infra'], counts: { selected: 5, passed: 3, failed: 1, infrastructure: 1, pending: 0 } } });
      const full = await readStoredQualification(target);
      if (full.status !== 'present') throw new Error('continued mixed frontier missing');
      expect(await composeStoredQualificationWork(target, resumed, options)).toMatchObject({
        status: 'conflict', refusalReason: 'continuation-verdict-not-green' });
      expect(await readStoredQualification(target)).toEqual(full);
      const metadataBeforeDeletion = await metadata();
      for (const missing of ['guard-failed', 'post-infra']) {
        const corrupted = structuredClone(metadataBeforeDeletion);
        const transaction = structuredClone(full.transaction);
        transaction.continuation!.receipts = transaction.continuation!.receipts.filter(row => row.unitId !== missing);
        corrupted[CHECKPOINT_QUALIFICATION_METADATA_KEY] = transaction;
        await sql`UPDATE harness_shared.routines SET metadata = ${JSON.stringify(corrupted)}::text::jsonb
          WHERE workspace_id = ${target.workspaceId}`;
        const missingOutcome = await readStoredQualification(target);
        if (missingOutcome.status !== 'present') throw new Error('deletion counterexample unreadable');
        expect(evaluate(missingOutcome.transaction, resumed)).toMatchObject({ run: ['guard-failed', 'post-infra'],
          counts: { selected: 5, passed: 3, pending: 1 } });
        expect(await composeStoredQualificationWork(target, resumed, options)).toMatchObject({
          status: 'conflict', refusalReason: 'continuation-verdict-not-green' });
      }
      await sql`UPDATE harness_shared.routines SET metadata = ${JSON.stringify(metadataBeforeDeletion)}::text::jsonb
        WHERE workspace_id = ${target.workspaceId}`;
      expect(await recordStoredQualificationWorkProgress(target, { ...resumed, retryStates: [] })).toMatchObject({
        status: 'conflict', refusalReason: 'continuation-policy-mismatch' });
      const repaired = await continueStoredQualificationWork(target, resumed, async unit => {
        executed.push(unit.id);
        return receipt(unit.id, 'pass', 'repaired:' + unit.id, 800);
      }, options);
      expect(executed).toEqual(['guard-pending', 'post-pending', 'guard-failed', 'post-infra']);
      expect(repaired).toMatchObject({ status: 'settled', evaluation: { verdict: 'green',
        counts: { selected: 5, passed: 5, failed: 0, infrastructure: 0, pending: 0 } } });
      expect(await recordStoredQualificationComposedVerdict(target, resumed, { candidate, runId: resumed.runId,
        reason: 'advanced', green: true, nowMs: 1000,
        terminalEvent: { status: 'mixed-frontier-composition-fixture', detail: { selected } } }, options))
        .toMatchObject({ status: 'updated', transaction: { outcome: { kind: 'green' }, currentPhysicalRunner: null } });
    } finally {
      child.kill('SIGKILL');
      await closed;
      fixture?.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('serializes competing continuation custody requests and refuses the losing writer', async () => {
    await seed();
    await beginStoredQualification(target, { attemptId: 'attempt-race', candidate: 'candidate-race', nowMs: 100 });
    const reserve = (number: number) => ({ attemptId: 'attempt-race', candidate: 'candidate-race',
      runnerId: `runner-${number}`, runId: `run-${number}`, pid: number + 40, pidIdentity: `boot:${number + 40}`,
      leaseDurationMs: 1000, started: true, incumbentLiveness: 'unknown' as const, nowMs: 200 });
    const requests = [reserve(1), reserve(2)];
    const results = await Promise.all(requests.map(input => reserveStoredQualificationRunner(target, input)));
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'updated']);
    const loser = requests[results.findIndex(result => result.status === 'conflict')]!;
    expect(await recordStoredQualificationWorkProgress(target, { ...loser, repairHead: null, root: '/repo',
      taskKey: 'qualification', runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [],
      updates: [], manifest: { schemaVersion: 1, units: [{ id: 'a', kind: 'test', path: 'a.test.ts' }] }, nowMs: 300 }))
      .toMatchObject({ status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    const stored = await readStoredQualification(target);
    expect(stored.status).toBe('present');
    if (stored.status === 'present') expect(stored.transaction.continuation).toBeUndefined();
  });

  it.each(['skipped-locked', 'migrations-pending'])(
    'persists %s as a pre-suite no-verdict outcome',
    async (reason) => {
      await seed();
      expect((await beginStoredQualification(target, {
        attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
      })).status).toBe('updated');
      expect((await recordStoredQualificationVerdict(target, {
        attemptId: 'attempt-1', candidate: 'candidate-1',
        reason, green: null, nowMs: 200,
      })).status).toBe('updated');
      const stored = await readStoredQualification(target);
      expect(stored).toMatchObject({ status: 'present', transaction: {
        phase: 'waiting',
        outcome: { kind: 'pre-suite-no-verdict', reason },
      } });
      if (stored.status === 'present') {
        expect(projectCheckpointQualificationState(stored.transaction, 300).clocks).toMatchObject({
          lastStartedAtMs: null, lastTerminalVerdictAtMs: null,
        });
      }
    },
  );

  it('classifies a persisted converging repair as non-terminal while retaining red uncertainty', async () => {
    await seed({
      repair_queue: { phase: 'ready-to-verify' },
      gate_health: { inconclusive: { status: 'repair-in-progress' } },
    });
    const stored = await metadata();
    const queue = stored.repair_queue as FrozenRepairConvergenceReading;
    const gateHealth = stored.gate_health as { inconclusive: { status: string } };
    const freshness = { stale: true, reason: 'no new verdict', reasonCode: 'writer-starved' as const };
    const result = reconcileGateVerdictFreshnessWithRepairQueue(freshness, {
      status: gateHealth.inconclusive.status,
      phase: queue.phase,
    });
    expect(result).toMatchObject({ stale: true, reasonCode: 'repair-converging' });
    expect(result.reason).toMatch(/recorded 'repair-in-progress'/);
    expect(reconcileGateVerdictFreshnessWithRepairQueue(freshness, {
      status: null, phase: 'blocked',
    })).toEqual(freshness);
  });

  it('joins one physical runner, separates clocks, and refuses stale terminal identity', async () => {
    await seed();
    const begun = await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 1_000,
    });
    expect(begun.status).toBe('updated');
    expect((await recordStoredQualificationScheduledFire(target, 'attempt-1', 2_000)).status).toBe('updated');
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', leaseDurationMs: 1_000_000,
      started: false, nowMs: 2_100,
    })).status).toBe('updated');
    const pidIdentity = checkpointPidIdentity(process.pid)!;
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: process.pid, pidIdentity, leaseDurationMs: 1_000_000, started: true, nowMs: 2_200,
    })).status).toBe('updated');
    expect((await recordStoredQualificationRunnerProgress(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      pidIdentity, phase: 'suite', nowMs: 3_000,
    })).status).toBe('updated');
    expect((await recordStoredQualificationScheduledFire(target, 'attempt-1', 4_000)).status).toBe('updated');
    const running = await readStoredQualification(target);
    expect(running.status).toBe('present');
    if (running.status !== 'present') return;
    expect(running.transaction).toMatchObject({
      runId: 'run-1', lastScheduledAtMs: 4_000, lastStartedAtMs: 2_200,
      lastProgressAtMs: 3_000, currentPhysicalRunner: { phase: 'suite', pidIdentity },
    });
    expect(projectCheckpointQualificationState(running.transaction, 4_500, 'live')).toMatchObject({
      lease: { holder: 'fire-1', acquiredAtMs: 2_100, expiresAtMs: 1_002_200, expired: false },
      runnerHealth: { liveness: 'live', phase: 'suite', progressAgeMs: 1_500 },
      clocks: {
        lastScheduledAtMs: 4_000, lastStartedAtMs: 2_200,
        lastProgressAtMs: 3_000, lastTerminalVerdictAtMs: null,
      },
      agesMs: { scheduled: 500, started: 2_300, progress: 1_500, terminal: null },
    });
    expect(classifyScheduledQualificationJoin(running.transaction,
      await probeRunnerLiveness(running.transaction.currentPhysicalRunner))).toBe('join');

    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-other', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_000,
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-1', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_100,
    })).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-other', candidate: 'candidate-1',
      reason: 'advanced', green: true, nowMs: 5_200,
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-1', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_200,
    })).status).toBe('terminal');
    const terminal = await readStoredQualification(target);
    expect(terminal).toMatchObject({ status: 'present', transaction: {
      phase: 'terminal', lastScheduledAtMs: 4_000, lastProgressAtMs: 3_000,
      lastTerminalVerdictAtMs: 5_100, outcome: { kind: 'red' },
    } });
  });

  it('awaits async runner probes under the same qualification row lock', async () => {
    await seed();
    expect((await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    })).status).toBe('updated');
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', unit: 'probe.service',
      leaseDurationMs: 1_000_000, started: false, nowMs: 200,
    })).status).toBe('updated');

    let resolveFirst: ((value: RunnerLiveness) => void) | undefined;
    let resolveSecond: ((value: RunnerLiveness) => void) | undefined;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    let probeCount = 0;
    configureRunnerLivenessProber(() => {
      probeCount += 1;
      return new Promise<RunnerLiveness>((resolve) => {
        if (probeCount === 1) {
          resolveFirst = resolve;
          markFirstStarted();
        } else {
          resolveSecond = resolve;
          markSecondStarted();
        }
      });
    });

    let beginSettled = false;
    try {
      const begin = beginStoredQualification(target, {
        attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
      }).then((result) => { beginSettled = true; return result; });
      await firstStarted;
      const reserve = reserveStoredQualificationRunner(target, {
        attemptId: 'attempt-1', runnerId: 'fire-2',
        leaseDurationMs: 1_000_000, started: false, nowMs: 400,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(beginSettled).toBe(false);
      expect(probeCount).toBe(1);
      resolveFirst?.('live');
      await expect(begin).resolves.toMatchObject({ status: 'conflict' });

      await secondStarted;
      expect(probeCount).toBe(2);
      resolveSecond?.('live');
      await expect(reserve).resolves.toMatchObject({ status: 'conflict' });
    } finally {
      resolveFirst?.('unknown');
      resolveSecond?.('unknown');
      configureRunnerLivenessProber(null);
    }
  });

  it('commits predecessor reconciliation and successor qualification in the same row update', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await seed({ qualificationTransaction: terminal, repair_queue: admitted });
    const next = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(next).toMatchObject({ status: 'updated', repairQueueReconciliation: { status: 'preserved' } });
    const stored = await metadata();
    expect(stored.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2', candidate: 'repair-1' });
    expect(stored.repair_queue).toMatchObject({
      candidate: 'candidate-1', repairHead: 'repair-1', qualificationAttemptId: 'attempt-2',
    });
  });

  it('hands an abandoned runner queue to its successor before gate self-heal writes', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const abandoned = reserveQualificationRunner(first, {
      attemptId: 'attempt-1', runnerId: 'dead-runner', candidate: 'candidate-1',
      leaseDurationMs: 1_000, nowMs: 200,
    }).transaction;
    const red = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const admitted = markFrozenRepairAdmitted(red, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await seed({ qualificationTransaction: abandoned, repair_queue: admitted });

    const successor = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', requiredAncestorSha: 'repair-1',
      incumbentLiveness: 'dead', nowMs: 100_000,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(successor).toMatchObject({
      status: 'updated', repairQueueReconciliation: { status: 'preserved' },
    });
    const handedOff = await metadata();
    expect(handedOff.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2' });
    expect(handedOff.repair_queue).toMatchObject({
      repairHead: 'repair-1', qualificationAttemptId: 'attempt-2',
    });

    const queue = parseFrozenCandidateRepairQueue(handedOff.repair_queue)!;
    const healed = markFrozenRepairAdmitted(queue, {
      atMs: 100_100, actor: 'gate', source: { ref: 'writer', sha: 'repair-2' },
      fromRepairHead: 'repair-1', toRepairHead: 'repair-2',
      paths: ['artifact.json'], unchanged: [], blobs: { 'artifact.json': 'blob-2' },
    });
    await expect(writeFrozenCandidateRepairQueue(target, healed, {
      expectedUpdatedAtMs: queue.updatedAtMs,
    })).resolves.toBeUndefined();
    expect((await metadata()).repair_queue).toMatchObject({
      repairHead: 'repair-2', qualificationAttemptId: 'attempt-2',
    });
  });

  it('preserves an unknown live PID even after lease expiry, then reclaims only a proved changed identity', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    await seed({ qualificationTransaction: {
      ...ready, phase: 'running', currentPhysicalRunner: {
        id: 'old-runner', candidate: 'candidate-1', reservedAtMs: 100,
        leaseExpiresAtMs: 200, evidenceRefs: [], pid: process.pid, pidIdentity: null,
      },
    } });
    const unknown = await readStoredQualification(target);
    expect(unknown.status).toBe('present');
    if (unknown.status !== 'present') return;
    expect(projectCheckpointQualificationState(unknown.transaction, 1_000, 'unknown')).toMatchObject({
      lease: { holder: 'old-runner', expired: true },
      runnerHealth: { liveness: 'unknown' },
      safeNextAction: { code: 'inspect-runner-liveness' },
    });
    const replacement = { attemptId: 'attempt-1', runnerId: 'new-runner', leaseDurationMs: 1_000, nowMs: 1_000 };
    expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('conflict');
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(metadata, '{qualificationTransaction,currentPhysicalRunner,pidIdentity}',
                                  '"old-boot:1"'::jsonb, true)
       WHERE workspace_id = ${target.workspaceId}`;
    const reclaimed = await reserveStoredQualificationRunner(target, replacement);
    expect(reclaimed).toMatchObject({ status: 'updated', transaction: {
      currentPhysicalRunner: { id: 'new-runner' },
      consumedPhysicalRuns: [{ id: 'old-runner', outcome: {
        kind: 'pre-suite-no-verdict', reason: 'runner-vanished',
      } }],
    } });
  });

  it('leaves a foreign repair queue and predecessor qualification byte-identical on conflict', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const foreign = createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'foreign-attempt', base: null, nowMs: 150,
    });
    await seed({ qualificationTransaction: terminal, repair_queue: foreign });
    const before = await metadata();
    const result = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(result.status).toBe('conflict');
    expect(await metadata()).toEqual(before);
  });

  it('fires only the exact candidate await once on the durable event store', async () => {
    const key = 'green-checkpoint:red:papercusp-lifecycle-test';
    const a = await registerAwait({
      subscriberId: 'su-candidate-a', eventKey: key,
      payloadFilter: { sha: { startsWith: 'candidate-a' } },
    });
    const b = await registerAwait({
      subscriberId: 'su-candidate-b', eventKey: key,
      payloadFilter: { sha: { startsWith: 'candidate-b' } },
    });
    const first = await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-a123', runId: 'run-a' } });
    expect(first.map((row) => row.id)).toEqual([a.id]);
    expect(await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-a123', runId: 'run-a' } })).toEqual([]);
    const second = await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-b123', runId: 'run-b' } });
    expect(second.map((row) => row.id)).toEqual([b.id]);
  });

  it('moves an admitted repair head and its qualification handoff in one row CAS', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    await seed({ qualificationTransaction: terminal, repair_queue: redQueue });
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await writeFrozenCandidateRepairQueue(target, admitted, { expectedUpdatedAtMs: redQueue.updatedAtMs });
    const handoff = await metadata();
    expect(handoff.repair_queue).toMatchObject({ repairHead: 'repair-1', qualificationAttemptId: 'attempt-1' });
    expect(handoff.qualificationTransaction).toMatchObject({
      attemptId: 'attempt-1', outcome: { kind: 'red' }, pendingRepairHead: 'repair-1',
    });
    const successor = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(successor.status).toBe('updated');
    const after = await metadata();
    expect(after.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2', pendingRepairHead: null });
    expect(after.repair_queue).toMatchObject({ repairHead: 'repair-1', qualificationAttemptId: 'attempt-2' });
  });

  it('rejects an admitted head whose qualification owner differs and writes neither half', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'foreign-attempt', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    await seed({ qualificationTransaction: terminal, repair_queue: redQueue });
    const before = await metadata();
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await expect(writeFrozenCandidateRepairQueue(target, admitted, {
      expectedUpdatedAtMs: redQueue.updatedAtMs,
    })).rejects.toThrow();
    expect(await metadata()).toEqual(before);
  });

  it('commits one terminal pipeline result with qualification and rolls both back on event failure', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    await seed({ qualificationTransaction: ready });
    const terminal = {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-1',
      reason: 'not-green', green: false, nowMs: 200,
      terminalEvent: { status: 'not-green', detail: { runId: 'run-1', candidate: 'candidate-1' } },
    };
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('terminal');
    const events = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.pipeline_events
       WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
         AND kind = 'green_checkpoint' AND detail->>'runId' = 'run-1'`;
    expect(events[0].n).toBe(1);
    expect((await metadata()).qualificationTransaction).toMatchObject({
      phase: 'terminal', lastTerminalVerdictAtMs: 200,
    });

    const second = beginQualificationTransaction(null, {
      attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
    }).transaction;
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(metadata, '{qualificationTransaction}', ${JSON.stringify(second)}::text::jsonb, true)
       WHERE workspace_id = ${target.workspaceId}`;
    await sql`ALTER TABLE harness_shared.pipeline_events ADD CONSTRAINT checkpoint_lifecycle_reject_test
      CHECK (status <> 'forced-fail')`;
    try {
      const failed = await recordStoredQualificationVerdict(target, {
        attemptId: 'attempt-2', candidate: 'candidate-2', runId: 'run-2',
        reason: 'not-green', green: false, nowMs: 400,
        terminalEvent: { status: 'forced-fail', detail: { runId: 'run-2' } },
      });
      expect(failed.status).toBe('unreadable');
      expect((await metadata()).qualificationTransaction).toMatchObject({
        attemptId: 'attempt-2', phase: 'ready', outcome: { kind: 'pending' },
      });
      const rolledBack = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.pipeline_events
         WHERE workspace_id = ${target.workspaceId} AND detail->>'runId' = 'run-2'`;
      expect(rolledBack[0].n).toBe(0);
    } finally {
      await sql`ALTER TABLE harness_shared.pipeline_events DROP CONSTRAINT checkpoint_lifecycle_reject_test`;
    }
  });
});

/** Native artifact contract fixture; actual Vitest crash proof remains in the recorder suite. */
async function nativeRecoveryFixture(options: { root?: string; candidate?: string;
  runner?: { pid: number; pidIdentity: string } } = {}) {
  await seed();
  await beginStoredQualification(target, { attemptId: 'attempt-native', candidate: options.candidate ?? 'candidate-native', nowMs: 100 });
  const owner = { attemptId: 'attempt-native', candidate: options.candidate ?? 'candidate-native', runnerId: 'runner-one', runId: 'run-one',
    evidenceRefs: ['checkpoint-run:run-one'], pid: options.runner?.pid ?? 42,
    pidIdentity: options.runner?.pidIdentity ?? 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 };
  expect((await reserveStoredQualificationRunner(target, owner)).status).toBe('updated');
  const input: QualificationWorkProgressInput = { ...owner, repairHead: null, root: options.root ?? '/repo', taskKey: 'qualification',
    runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [], updates: [], nowMs: 300,
    manifest: { schemaVersion: 1, units: [{ id: 'native', kind: 'test', path: 'native.test.ts' }] } };
  const specifications = [{ testFile: 'native.test.ts', projectName: null, pool: 'forks',
    testNamePattern: null as string | null, testLines: null, testIds: null, testTagsFilter: null }];
  const snapshot = { workspaceName: '@fixture/native', recordedSha: owner.candidate, worktreeDirty: false,
    completionCheckpoint: { schemaVersion: 1, qualificationAttemptId: owner.attemptId,
      runGroupId: owner.runId, runContext: input.runContext, runnerIdentity: input.runnerIdentity, state: 'partial', noPersist: true },
    configSources: { status: 'unchanged' },
    rows: [{ testFile: 'native.test.ts', executedModules: ['native.test.ts'], readPaths: [join(input.root, 'input.json')],
      inputsCaptured: true, opaqueReasons: [] }],
    nativeRun: { schemaVersion: 'native-vitest-run-v1', startedAtMs: 220, finishedAtMs: null, gaps: [],
      terminalHook: null, reason: null, unhandledErrorCount: null, modulePopulationMatched: false,
      selectedManifest: { specifications: structuredClone(specifications), sha256: createHash('sha256')
        .update(JSON.stringify(specifications)).digest('hex') },
      files: [{ testFile: 'native.test.ts', state: 'passed', firstAttemptVerdict: 'pass',
        completionId: 'native-completion', observedAtMs: 250, cases: [{ status: 'pass' }],
        proof: { sourceEvidence: { schemaVersion: 'vite-collected-source-evidence-v1', status: 'stable', reasons: [],
          sources: [{ path: 'native.test.ts', sha256: 'a'.repeat(64), currentSha256: 'a'.repeat(64) }] } } }] } };
  const directory = mkdtempSync(join(tmpdir(), 'native-qualification-')), file = join(directory, 'out.json');
  const save = () => writeExecutedSourceMapSnapshot(file, snapshot);
  save();
  const observation = { path: file, workspaceName: snapshot.workspaceName,
    selectedSpecifications: specifications,
    classifyReadPaths: (reads: unknown, root: string) => classifyReadPaths(reads as string[], {
      repoRoot: root, isTracked: path => path === 'input.json', exists: () => false,
    }) };
  const enroll = () => {
    const taskKey = '@fixture/native::test';
    const producer = registerPartialNativeProducer(file, {
      attemptId: input.attemptId, runGroupId: input.runId, root: input.root, taskKey,
      workspaceName: snapshot.workspaceName, sourceCommit: input.candidate, registeredAtMs: 210,
      selectedSpecifications: structuredClone(specifications), command: { cwd: input.root, cmd: 'npm', argv: ['run', 'test'] },
    }, { NODE_ENV: 'test' });
    return { ...observation, selectedSpecifications: structuredClone(specifications), taskKey, producerPath: producer.path };
  };
  return { owner, input, snapshot, save, observation, enroll, directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
