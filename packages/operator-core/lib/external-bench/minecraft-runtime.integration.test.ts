import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freezeMinecraftTrial } from './minecraft-protocol';
import { freezeMinecraftWorldBaseline, readMinecraftInitialWorld, startMinecraftRuntime, type MinecraftRuntime } from './minecraft-runtime';
import { readRestoredBenchmarkContext, restoreBenchmarkContext, type BenchmarkContextInput } from './reproducibility/context';
import { collectMinecraftEvidence, exportMinecraftEvidence, gradeMinecraftEvidence,
  readMinecraftEvidenceExport } from './minecraft-evidence';
import { liveProcExec } from './grader/index';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';
import { captureIsolatedWorker, isolatedTestFileWorkerOptions, isolatedWorkerFailureDetail,
  recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const assets = fileURLToPath(new URL('../../vendor/minecraft-runtime/', import.meta.url));
const pins = JSON.parse(await readFile(join(assets, 'runtime-pins.json'), 'utf8'));
let root: string, jar: string, botImage: string;
const runtimes: MinecraftRuntime[] = [];
const filePath = 'packages/operator-core/lib/external-bench/minecraft-runtime.integration.test.ts';
const repoRoot = resolve(import.meta.dirname, '../../../..');
const worker = process.env.PC_MINECRAFT_RUNTIME_WORKER === '1';

if (worker) {
if (!/^test-runtime-/.test(process.env.PAPERCUSP_WORKSPACE_ID ?? '')
  || process.env.PAPERCUSP_SKIP_PG_DISCOVERY !== '1') {
  throw Error('Minecraft proof worker requires the owned isolated runtime');
}
beforeAll(async () => {
  // Fail the expensive setup at its actual prerequisite, with bounded diagnostics.
  const daemon = await liveProcExec('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15_000 });
  if (daemon.code !== 0 || !daemon.stdout.trim()) throw Error(`Minecraft Docker preflight failed (${daemon.code}): ${daemon.stderr.slice(-2000)}`);
  root = await mkdtemp(join(tmpdir(), 'mc-runtime-real-')); jar = join(root, 'server.jar');
  const response = await fetch(pins.serverUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw Error(`Minecraft download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(pins.serverJarSha256);
  await writeFile(jar, bytes);
  for (const image of [pins.serverImage, pins.nodeImage]) {
    const pull = await liveProcExec('docker', ['pull', image], { timeoutMs: 180_000 });
    if (pull.code) throw Error(`Pinned Minecraft image unavailable: ${pull.stderr}`);
  }
  const iid = join(root, 'image-id');
  const build = await liveProcExec('docker', ['build', '--build-arg', `NODE_IMAGE=${pins.nodeImage}`,
    '--iidfile', iid, assets], { timeoutMs: 180_000 });
  if (build.code) throw Error(`Minecraft bot build failed: ${build.stderr}`);
  botImage = (await readFile(iid, 'utf8')).trim();
}, 420_000);
afterAll(async () => { for (const runtime of runtimes) await runtime.dispose(); if (root) await rm(root, { recursive: true, force: true }); }, 120_000);

function trial(suffix: string) {
  return freezeMinecraftTrial({ schemaVersion: 1, runId: `real-${suffix}`, armId: 'scripted-no-llm', taskId: 'iron',
    manifestHash: 'a'.repeat(64), selectionHash: 'b'.repeat(64), worldSeed: '12345', objective: 'iron-tools',
    rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
    pins: { serverImage: pins.serverImage, serverJarSha256: pins.serverJarSha256,
      mineflayerVersion: pins.mineflayerVersion, pathfinderVersion: pins.pathfinderVersion },
    participants: ['alice'], observations: ['position', 'health', 'inventory', 'team-chat'], actions: ['team-chat'],
    limits: { maxWallClockMs: 240_000, maxProgramMs: 10_000, maxUsd: 1 } });
}
describe('real Minecraft/Mineflayer isolation and cancellation (scripted, no model use)', () => {
  it('resets the real saved world and permitted memory after a completed trial is contaminated', async () => {
    const frozenTrial = trial('reset');
    const preparation = await startMinecraftRuntime({ trial: frozenTrial, serverJar: jar, botImage,
      acceptEula: true, readyTimeoutMs: 180_000 }); runtimes.push(preparation);
    const baseline = await freezeMinecraftWorldBaseline(preparation);
    try {
      const snapshotRoot = join(root, 'reset-context'); await mkdir(snapshotRoot);
      const corpus = JSON.stringify({ entries: [{ key: 'public:objective', text: 'Obtain iron tools.' }] });
      const memory = JSON.stringify({ entries: [{ key: 'memory:permitted', text: 'Fresh permitted initial memory.' }] });
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      await writeFile(join(snapshotRoot, 'corpus.json'), corpus); await writeFile(join(snapshotRoot, 'memory.json'), memory);
      const context: BenchmarkContextInput['context'] = { corpusRef: 'corpus.json', memoryRef: 'memory.json',
        corpusHash: sha(corpus), memoryHash: sha(memory), isolation: 'fresh-per-assignment',
        forbiddenSources: ['other-arm-solutions', 'hidden-grader-answers'] };
      const restoreMemory = async (ordinal: number) => {
        const checkout = join(root, `reset-assignment-${ordinal}`); await mkdir(checkout);
        const input: BenchmarkContextInput = { checkout, snapshotRoot, context,
          binding: { workspaceId: 'minecraft-reset', runId: frozenTrial.protocol.runId, preregHash: 'a'.repeat(64),
            assignmentId: `bench-assignment:reset-${ordinal}`, harnessSlug: `xbench-reset-${ordinal}` } };
        return { input, receipt: restoreBenchmarkContext(input) };
      };
      const firstMemory = await restoreMemory(1);
      const first = await startMinecraftRuntime({ trial: frozenTrial, serverJar: jar, botImage,
        acceptEula: true, readyTimeoutMs: 180_000, worldBaseline: baseline }); runtimes.push(first);
      const initialWorld = readMinecraftInitialWorld(first);
      expect((await first.execute('alice', 'return await bot.position()')).ok).toBe(true);
      const stopped = await first.stop();
      expect(stopped).toMatchObject({ removed: true, errors: [] });
      // Change the COMPLETED assignment only, including its actual saved world.
      await writeFile(join(stopped.evidenceDir, 'world', 'level.dat'), 'EARLIER_TRIAL_WORLD');
      await writeFile(firstMemory.receipt.memoryPath, 'EARLIER_TRIAL_MEMORY');
      expect(() => readRestoredBenchmarkContext(firstMemory.input)).toThrow(/bytes differ/);
      const secondMemory = await restoreMemory(2);
      const second = await startMinecraftRuntime({ trial: frozenTrial, serverJar: jar, botImage,
        acceptEula: true, readyTimeoutMs: 180_000, worldBaseline: baseline }); runtimes.push(second);
      expect(readMinecraftInitialWorld(second)).toEqual(initialWorld);
      expect(initialWorld.worldSha256).toBe(baseline.worldSha256);
      expect(readRestoredBenchmarkContext(secondMemory.input).memoryHash).toBe(sha(memory));
      expect(await readFile(secondMemory.receipt.memoryPath, 'utf8')).toBe(memory);
      expect(secondMemory.receipt.contextText).not.toContain('EARLIER_TRIAL');
      expect(await second.execute('alice', 'return await bot.inventory()')).toEqual({ ok: true, value: [] });
      expect(await second.stop()).toMatchObject({ removed: true, errors: [] });
    } finally { await baseline.dispose(); }
  }, 600_000);
  it('connects an enrolled bot, enforces RPC permissions and host isolation, then cancels an active program with verified cleanup', async () => {
    const controller = new AbortController();
    const runtime = await startMinecraftRuntime({ trial: trial('connect'), serverJar: jar, botImage,
      acceptEula: true, signal: controller.signal, readyTimeoutMs: 180_000 }); runtimes.push(runtime);
    expect(runtime.measurement).toMatchObject({ trialId: runtime.trial.trialId, serverReady: true, javaMajor: 17 });
    const position = await runtime.execute('alice', 'return await bot.position()');
    expect(position.ok).toBe(true); expect(position.value).toHaveProperty('dimension');
    const inventory = await runtime.execute('alice', 'return await bot.inventory()');
    expect(inventory).toEqual({ ok: true, value: [] });
    const denied = await runtime.execute('alice', 'return await bot.move({x:0,y:80,z:0})');
    expect(denied).toMatchObject({ ok: false, error: 'Frozen permission denied' });
    const admin = await runtime.execute('alice', 'return await bot["team-chat"]({message:"/op alice"})');
    expect(admin).toMatchObject({ ok: false, error: 'Administrative chat is forbidden' });
    const boundary = await runtime.execute('alice', 'const fs=process.getBuiltinModule("fs"); return {world:fs.existsSync("/data"),docker:fs.existsSync("/var/run/docker.sock"),token:Object.keys(process.env).some(k=>/TOKEN|SECRET|API_KEY/.test(k))}');
    expect(boundary).toEqual({ ok: true, value: { world: false, docker: false, token: false } });
    const program = runtime.execute('alice', 'while(true) {}');
    setTimeout(() => controller.abort(), 500);
    await expect(program).rejects.toThrow(/cancelled|timed out/);
    expect(await runtime.stop()).toMatchObject({ removed: true, errors: [] });
    const evidence = await collectMinecraftEvidence(runtime);
    const grade = gradeMinecraftEvidence(runtime.trial, evidence);
    // A trustworthy no-progress result is a scored trial, rather than a missing-evidence error.
    expect(grade).toMatchObject({ score: 0, resolved: false,
      rawGraderOutput: { trialId: runtime.trial.trialId, runtimeId: runtime.runtimeId } });
    expect(grade.graderError).toBeUndefined();
    for (const changed of [
      { taskId: 'foreign-trial' },
      { runId: 'foreign-run' },
      { participants: ['mallory'] },
    ]) {
      const foreign = freezeMinecraftTrial({ ...runtime.trial.protocol, ...changed });
      expect(gradeMinecraftEvidence(foreign, evidence)).toMatchObject({ score: null,
        resolved: false, graderError: 'Foreign Minecraft trial evidence' });
    }
    const serialized = exportMinecraftEvidence(evidence);
    const retainedHostDigest = createHash('sha256').update(serialized).digest('hex');
    expect(gradeMinecraftEvidence(runtime.trial,
      readMinecraftEvidenceExport(serialized, retainedHostDigest))).toEqual(grade);
    const replay = JSON.parse(serialized);
    expect(replay.trialId).toBe(runtime.trial.trialId);
    expect(replay.runtimeId).toBe(runtime.runtimeId);
    expect(replay.snapshot.files['server.log']).toContain('Done (');
    const events = (replay.snapshot.files['programs.jsonl'] as string).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ event: 'program-error', participant: 'alice' }));
    const live = await liveProcExec('docker', ['ps', '-aq', '--filter', `label=papercusp.minecraft-runtime=${runtime.runtimeId}`], { timeoutMs: 15_000 });
    expect(live.code).toBe(0); expect(live.stdout.trim()).toBe('');
  }, 300_000);
});
} else {
  const options = isolatedTestFileWorkerOptions(process.env, 1);
  it('retains real Minecraft connection, isolation, cancellation and reset with original private-runtime cleanup', async context => {
    const sources = [
      'packages/operator-core/lib/external-bench/minecraft-runtime.ts',
      'packages/operator-core/lib/external-bench/minecraft-protocol.ts',
      'packages/operator-core/lib/external-bench/minecraft-evidence.ts',
      'packages/operator-core/lib/external-bench/reproducibility/context.ts',
    ];
    const runId = await recordIsolatedIntegrationProof({
      root: repoRoot, filePath, sourcePaths: [...sources,
        'packages/operator-core/lib/external-bench/reproducibility/canonical-json.ts',
        'packages/operator-core/lib/external-bench/grader/index.ts',
        ...['package.json', 'package-lock.json', 'runtime-pins.json', 'Dockerfile',
          'bot.cjs', 'program.cjs', 'THIRD_PARTY_NOTICES.md']
          .map(name => `packages/operator-core/vendor/minecraft-runtime/${name}`),
        'scripts/test-files.mjs'],
      retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/test-receipts.ndjson',
        'phases/execute/executed-source-map.json'],
      execute: async (observe, evidenceDir) => {
        const receipts = join(evidenceDir, 'test-receipts.ndjson');
        const mapPath = join(evidenceDir, 'executed-source-map.json');
        const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
          PC_MINECRAFT_RUNTIME_WORKER: '1',
          PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'papercusp-workspace',
          PC_EXECUTED_SOURCE_MAP_OUT: mapPath,
          PAPERCUSP_TEST_RUNS_DB_URL: resolveExecutedMapPgUrl().url,
          PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
          PAPERCUSP_TEST_RUN_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts };
        delete env.PC_HEAVY_PREEMPT_READY_FILE;
        delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
        const child = spawn(process.execPath, [join(repoRoot, 'scripts/with-test-pg.mjs'),
          '--isolated-runtime', '--', process.execPath,
          '--import', join(repoRoot, 'scripts/lib/committed-source-loader.mjs'),
          join(repoRoot, 'scripts/test-files.mjs'), filePath], {
          cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env,
        });
        observe(child);
        try {
          const result = await captureIsolatedWorker(child, evidenceDir, options);
          expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
            timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
          const rows = readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          const row = rows.find(value => value.filePath === filePath);
          expect(row).toMatchObject({ outcome: 'inserted', row: { status: 'pass', executionDetails: {
            passed: 2, failed: 0, skipped: 0, collectionFailed: false,
          } } });
          for (const title of ['resets the real saved world and permitted memory',
            'connects an enrolled bot, enforces RPC permissions and host isolation']) {
            expect(row.row.executionDetails.passedCaseTitles.some((passed: string) => passed.includes(title))).toBe(true);
          }
          const map = JSON.parse(readFileSync(mapPath, 'utf8'));
          const original = map.rows.find((value: any) => value.testFile === filePath)?.sourceEvidence;
          expect(original?.status).toBe('stable');
          for (const source of sources) {
            expect(original.sources.find((value: any) => value.path === source)).toMatchObject({
              basis: 'vite-pre-transform',
              sha256: createHash('sha256').update(readFileSync(join(repoRoot, source))).digest('hex'),
            });
          }
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        }
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
    console.info('MINECRAFT_RUNTIME_PROOF_RUN ' + runId);
  }, options.testTimeoutMs);
}
