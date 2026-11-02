import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freezeMinecraftTrial } from './minecraft-protocol';
import { startMinecraftRuntime, type MinecraftRuntime } from './minecraft-runtime';
import { collectMinecraftEvidence, exportMinecraftEvidence, gradeMinecraftEvidence,
  readMinecraftEvidenceExport } from './minecraft-evidence';
import { liveProcExec } from './grader/index';

const assets = fileURLToPath(new URL('../../vendor/minecraft-runtime/', import.meta.url));
const pins = JSON.parse(await readFile(join(assets, 'runtime-pins.json'), 'utf8'));
let root: string, jar: string, botImage: string;
const runtimes: MinecraftRuntime[] = [];
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
