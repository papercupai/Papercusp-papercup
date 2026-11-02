import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freezeMinecraftTrial, MINECRAFT_OBJECTIVES } from './minecraft-protocol';
import { startMinecraftRuntime, minecraftOfflinePlayerUuid, type MinecraftRuntime } from './minecraft-runtime';
import { collectMinecraftEvidence, exportMinecraftEvidence, gradeMinecraftEvidence } from './minecraft-evidence';
import { canonicalJson } from './reproducibility/canonical-json';
import type { ProcExec } from './grader/swe-bench-pro';

const roots: string[] = [], runtimes: MinecraftRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const objectiveCriteria = { 'iron-tools': 'iron_pickaxe', 'nether-entry': 'entered_nether', 'ender-dragon': 'killed_dragon' } as const;
const stamp = (at = Date.now()) => new Date(at).toISOString().slice(0, 19).replace('T', ' ') + ' +0000';
function progress(objective: keyof typeof MINECRAFT_OBJECTIVES, time = stamp()) {
  return { [MINECRAFT_OBJECTIVES[objective]]: { done: true, criteria: { [objectiveCriteria[objective]]: time } }, DataVersion: 3700 };
}
/** Unit controls use a host-owned fixture world; the real server test is separate. */
async function fixture(objective: keyof typeof MINECRAFT_OBJECTIVES = 'iron-tools') {
  const root = await mkdtemp(join(tmpdir(), 'mc-evidence-unit-')); roots.push(root);
  const jar = join(root, 'server.jar'); await writeFile(jar, 'jar');
  const sha = 'a'.repeat(64);
  const trial = freezeMinecraftTrial({ schemaVersion: 1, runId: 'evidence', armId: 'stock', taskId: objective,
    manifestHash: sha, selectionHash: sha, worldSeed: '123', objective,
    rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
    pins: { serverImage: `minecraft/server@sha256:${sha}`, serverJarSha256: createHash('sha256').update('jar').digest('hex'),
      mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
    participants: ['alice'], observations: ['position'], actions: ['move'],
    limits: { maxWallClockMs: 60_000, maxProgramMs: 1000, maxUsd: 1 } });
  let world = '';
  const exec: ProcExec = async (_cmd, args) => {
    let stdout = '';
    if (args[0] === 'run' && args.includes('/opt/server.jar')) {
      world = args.find(arg => arg.endsWith('target=/data'))!.split('source=')[1]!.split(',target=')[0]!;
    }
    if (args[0] === 'run' && args.includes('-p')) stdout = '["4.32.0","2.4.5"]';
    if (args[0] === 'run' && args.includes('/app/program.cjs')) stdout = '{"ok":true,"value":"model claims a win"}';
    if (args[0] === 'logs') stdout = args.at(-1)!.endsWith('-bot')
      ? '{"ready":true,"participants":["alice"]}\n{"event":"team-chat","participant":"alice","message":"hello"}\n{"event":"death","participant":"alice"}'
      : 'Done (0.1s)!';
    if (args[0] === 'inspect') stdout = 'true';
    return { code: 0, stdout, stderr: args[0] === 'exec' ? 'openjdk version "17.0.1"' : '' };
  };
  const runtime = await startMinecraftRuntime({ trial, exec, serverJar: jar, botImage: `sha256:${sha}`, acceptEula: true, workRoot: root });
  runtimes.push(runtime);
  const advances = join(world, 'world', 'advancements'), stats = join(world, 'world', 'stats');
  await mkdir(advances, { recursive: true }); await mkdir(stats, { recursive: true });
  const playerFile = join(advances, `${minecraftOfflinePlayerUuid('alice')}.json`);
  await writeFile(playerFile, JSON.stringify(progress(objective)));
  await writeFile(join(stats, `${minecraftOfflinePlayerUuid('alice')}.json`), JSON.stringify({ DataVersion: 3700,
    stats: { 'minecraft:custom': { 'minecraft:deaths': 2 } } }));
  return { runtime, trial, root, world, playerFile };
}
describe('Minecraft trusted server evidence and replay', () => {
  it.each(Object.keys(MINECRAFT_OBJECTIVES) as Array<keyof typeof MINECRAFT_OBJECTIVES>)('scores the server %s milestone and preserves its trial/player/time', async objective => {
    const f = await fixture(objective); const proof = await collectMinecraftEvidence(f.runtime);
    expect(gradeMinecraftEvidence(f.trial, proof)).toMatchObject({ resolved: true, score: 1,
      rawGraderOutput: { trialId: f.trial.trialId, deaths: { alice: 2 }, milestones: [{ participant: 'alice', objective }] } });
    expect(Object.isFrozen(proof.snapshot.files)).toBe(true);
  });
  it('keeps a valid no-progress outcome in the denominator despite model win text', async () => {
    const f = await fixture(); await writeFile(f.playerFile, '{"DataVersion":3700}');
    await f.runtime.execute('alice', 'return "I won"');
    const proof = await collectMinecraftEvidence(f.runtime);
    expect(gradeMinecraftEvidence(f.trial, proof)).toMatchObject({ score: 0, resolved: false });
    const exported = JSON.parse(exportMinecraftEvidence(proof));
    const events = (exported.snapshot.files['programs.jsonl'] as string).trim().split('\n').map(line => JSON.parse(line));
    expect(events[0]).toMatchObject({ event: 'program-start', participant: 'alice', source: 'return "I won"' });
    expect(exported.snapshot.files['programs.jsonl']).toContain('model claims a win');
    expect(exported.snapshot.files['bot.log']).toContain('team-chat');
    expect(exported.snapshot.files['bot.log']).toContain('death');
    expect(exported.sha256).toBe(proof.sha256);
    expect(exported.snapshot.provenance).toEqual({ source: 'host-collected-server-files', deterministicReplay: false,
      nondeterministicInputs: ['server-tick-and-process-scheduling', 'entity-behaviour-and-game-randomness',
        'bot-network-and-action-timing'] });
  });
  it('re-scores an immutable host export in a fresh reader and rejects altered trial/player/time/scoring observations', async () => {
    const f = await fixture(); const proof = await collectMinecraftEvidence(f.runtime);
    const terminal = gradeMinecraftEvidence(f.trial, proof);
    const serialized = exportMinecraftEvidence(proof);
    const retainedHostDigest = createHash('sha256').update(serialized).digest('hex');
    vi.resetModules();
    const fresh = await import('./minecraft-evidence');
    expect(fresh.gradeMinecraftEvidence(f.trial, proof)).toMatchObject({ score: null, resolved: false });
    const restored = fresh.readMinecraftEvidenceExport(serialized, retainedHostDigest);
    expect(fresh.gradeMinecraftEvidence(f.trial, restored)).toEqual(terminal);
    expect(Object.isFrozen(restored.snapshot.files)).toBe(true);
    const player = `world/world/advancements/${minecraftOfflinePlayerUuid('alice')}.json`;
    const changes: Array<(archive: any) => void> = [
      archive => { archive.trialId = 'b'.repeat(64); },
      archive => { archive.snapshot.trial.protocol.participants = ['mallory']; },
      archive => { archive.snapshot.stoppedAtMs += 60_000; },
      archive => { archive.snapshot.files[player] = JSON.stringify(progress('iron-tools', stamp(Date.now() - 3_600_000))); },
      archive => { delete archive.snapshot.files[player]; },
      archive => { archive.snapshot.files[player] = '{"DataVersion":3700}'; },
    ];
    for (const change of changes) {
      const altered = JSON.parse(serialized); change(altered);
      expect(() => fresh.readMinecraftEvidenceExport(JSON.stringify(altered), retainedHostDigest)).toThrow(/retained host digest/);
    }
    expect(() => fresh.readMinecraftEvidenceExport(serialized, 'b'.repeat(64))).toThrow(/retained host digest/);
    expect(() => fresh.readMinecraftEvidenceExport(serialized, '')).toThrow();
  });
  it('rejects a self-consistent forged archive against the independently retained host digest', async () => {
    const f = await fixture(); const proof = await collectMinecraftEvidence(f.runtime);
    const serialized = exportMinecraftEvidence(proof);
    const retainedHostDigest = createHash('sha256').update(serialized).digest('hex');
    const fresh = await import('./minecraft-evidence');
    expect(fresh.gradeMinecraftEvidence(f.trial,
      fresh.readMinecraftEvidenceExport(serialized, retainedHostDigest))).toMatchObject({ score: 1 });
    const forged = JSON.parse(serialized);
    forged.snapshot.files[`world/world/advancements/${minecraftOfflinePlayerUuid('alice')}.json`] = '{"DataVersion":3700}';
    // Recompute the bundle's own snapshot hash so only the independent host anchor can reject it.
    forged.sha256 = createHash('sha256').update(canonicalJson(forged.snapshot)).digest('hex');
    expect(() => fresh.readMinecraftEvidenceExport(canonicalJson(forged), retainedHostDigest)).toThrow();
  });
  it.each(['', '{', '{}', 'null', '{"DataVersion":3700,"minecraft:story/iron_tools":{"done":true,"criteria":{}}}',
    '{"DataVersion":3700,"minecraft:story/iron_tools":{"done":"true","criteria":{"iron_pickaxe":"2026-01-01 00:00:00 +0000"}}}'])('refuses malformed or incomplete server evidence %s', async raw => {
    const f = await fixture(); await writeFile(f.playerFile, raw);
    expect(gradeMinecraftEvidence(f.trial, await collectMinecraftEvidence(f.runtime))).toMatchObject({ score: null, resolved: false, graderError: expect.any(String) });
  });
  it.each([stamp(Date.now() - 3_600_000), stamp(Date.now() + 3_600_000), '2026-02-31 01:02:03 +0000', 'win-now'])('refuses a milestone outside the frozen trial or an invalid timestamp %s', async time => {
    const f = await fixture(); await writeFile(f.playerFile, JSON.stringify(progress('iron-tools', time)));
    expect(gradeMinecraftEvidence(f.trial, await collectMinecraftEvidence(f.runtime))).toMatchObject({ score: null, resolved: false });
  });
  it('does not award a win for an unfinished advancement', async () => {
    const f = await fixture();
    const record = { DataVersion: 3700, 'minecraft:story/iron_tools': { done: false, criteria: { iron_pickaxe: stamp() } } };
    await writeFile(f.playerFile, JSON.stringify(record));
    expect(gradeMinecraftEvidence(f.trial, await collectMinecraftEvidence(f.runtime))).toMatchObject({ score: 0, resolved: false });
  });
  it('refuses missing enrolled-player files even when a foreign player has a winning file', async () => {
    const f = await fixture(); await rm(f.playerFile);
    await writeFile(join(f.world, 'world', 'advancements', `${minecraftOfflinePlayerUuid('mallory')}.json`), JSON.stringify(progress('iron-tools')));
    expect(gradeMinecraftEvidence(f.trial, await collectMinecraftEvidence(f.runtime))).toMatchObject({ score: null, resolved: false, graderError: expect.stringContaining('Missing enrolled-player') });
  });
  it('rejects JSON/copied/caller-minted evidence and foreign trial identity', async () => {
    const f = await fixture(); const proof = await collectMinecraftEvidence(f.runtime);
    for (const fake of [{ ...proof }, JSON.parse(exportMinecraftEvidence(proof)), { resolved: true }, null]) {
      expect(gradeMinecraftEvidence(f.trial, fake)).toMatchObject({ score: null, resolved: false });
    }
    const foreign = freezeMinecraftTrial({ ...f.trial.protocol, runId: 'foreign' });
    expect(gradeMinecraftEvidence(foreign, proof)).toMatchObject({ score: null, resolved: false, graderError: expect.stringContaining('Foreign') });
    await expect(collectMinecraftEvidence({ ...f.runtime })).rejects.toThrow(/owned runtime/);
  });
  it('refuses symlinked server evidence instead of reading host files', async () => {
    const f = await fixture(); const outside = join(f.root, 'outside.json');
    await writeFile(outside, JSON.stringify(progress('iron-tools'))); await rm(f.playerFile); await symlink(outside, f.playerFile);
    await expect(collectMinecraftEvidence(f.runtime)).rejects.toThrow();
  });
});
