import { describe, expect, it, vi } from 'vitest';
import {
  MINECRAFT_OBJECTIVES, MINECRAFT_TASK_SETS, assertMinecraftTrialIdentity,
  assignMinecraftTask, freezeMinecraftManifest, freezeMinecraftSelection,
  freezeMinecraftTrial, minecraftPublicTaskIds, readMinecraftTaskMaterial,
  minecraftProtocolSchema, withMinecraftPreflight, type MinecraftProtocol,
} from './minecraft-protocol';

const sha = (n: number) => n.toString(16).padStart(64, '0');
const task = (taskId: string, n: number) => ({ taskId, worldSeed: String(n),
  objective: 'iron-tools' as const, referenceSha256: sha(n * 3),
  scoringFixtureSha256: sha(n * 3 + 1), exampleSha256: [sha(n * 3 + 2)] });
const manifestInput = () => ({ schemaVersion: 1, revision: 1,
  train: [task('train-iron', 1)], dev: [task('dev-iron', 2)], heldOut: [task('held-iron', 3)] });
const protocol = (manifestHash = sha(9)): MinecraftProtocol => ({
  schemaVersion: 1, runId: 'minecraft-run-1', armId: 'stock', taskId: 'held-iron',
  manifestHash, selectionHash: sha(50), worldSeed: '3', objective: 'iron-tools',
  rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
  pins: { serverImage: `minecraft/server@sha256:${sha(10)}`, serverJarSha256: sha(11),
    mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
  participants: ['alice', 'bob'], observations: ['position', 'inventory'],
  actions: ['move', 'craft'], limits: { maxUsd: 2, maxWallClockMs: 60_000, maxProgramMs: 1_000 },
});
const runtime = (p: MinecraftProtocol) => ({ serverInstanceId: 'isolated-server-1',
  serverReady: true, javaMajor: 17, trialId: freezeMinecraftTrial(p).trialId,
  worldSeed: p.worldSeed, rules: structuredClone(p.rules), pins: structuredClone(p.pins) });

describe('Minecraft stable task roster and frozen trial identity', () => {
  it('publishes stable pilot/dragon objectives with authoritative advancement semantics', () => {
    expect(MINECRAFT_TASK_SETS).toEqual({ 'minecraft-pilot': ['iron-tools', 'nether-entry'],
      'minecraft-ender-dragon': ['ender-dragon'] });
    expect(MINECRAFT_OBJECTIVES).toEqual({ 'iron-tools': 'minecraft:story/iron_tools',
      'nether-entry': 'minecraft:nether/root', 'ender-dragon': 'minecraft:end/kill_dragon' });
    expect(Object.isFrozen(MINECRAFT_TASK_SETS['minecraft-pilot'])).toBe(true);
  });

  it('canonicalizes unordered permission/participant sets and object property order', () => {
    const p = protocol(); const same = structuredClone(p);
    same.actions.reverse(); same.observations.reverse(); same.participants.reverse();
    expect(freezeMinecraftTrial(same).trialId).toBe(freezeMinecraftTrial(p).trialId);
    expect(assertMinecraftTrialIdentity(freezeMinecraftTrial(p).trialId, same).protocol).toEqual(
      freezeMinecraftTrial(p).protocol);
  });

  const changes: Array<[string, (p: MinecraftProtocol) => void]> = [
    ['seed', p => { p.worldSeed = '4'; }], ['objective', p => { p.objective = 'nether-entry'; }],
    ['run', p => { p.runId = 'other-run'; }], ['arm', p => { p.armId = 'papercusp'; }],
    ['task', p => { p.taskId = 'other-task'; }], ['manifest', p => { p.manifestHash = sha(33); }],
    ['selection', p => { p.selectionHash = sha(34); }],
    ['team', p => { p.participants = ['alice']; }], ['actions', p => { p.actions = ['move']; }],
    ['observations', p => { p.observations = ['position']; }],
    ['server image', p => { p.pins.serverImage = `minecraft/server@sha256:${sha(77)}`; }],
    ['server bytes', p => { p.pins.serverJarSha256 = sha(78); }],
    ['Mineflayer', p => { p.pins.mineflayerVersion = '4.33.0'; }],
    ['pathfinder', p => { p.pins.pathfinderVersion = '2.4.6'; }],
    ['budget', p => { p.limits.maxUsd = 1; }],
    ['deadline', p => { p.limits.maxWallClockMs = 30_000; }],
    ['program deadline', p => { p.limits.maxProgramMs = 500; }],
  ];
  it.each(changes)('refuses a changed %s under the previous trial identity', (_label, change) => {
    const p = protocol(); const first = freezeMinecraftTrial(p); change(p);
    expect(() => assertMinecraftTrialIdentity(first.trialId, p)).toThrow(/identity changed/);
  });

  it.each(['9223372036854775807', '-9223372036854775808'])('preserves exact seed %s', worldSeed => {
    expect(freezeMinecraftTrial({ ...protocol(), worldSeed }).protocol.worldSeed).toBe(worldSeed);
  });
  it.each(['9223372036854775808', '-9223372036854775809', '1.2', '03', '-0', 42])(
    'refuses an imprecise or noncanonical seed %s', worldSeed => {
      expect(() => freezeMinecraftTrial({ ...protocol(), worldSeed })).toThrow();
    });
  it.each(['bad-seed', '1.2', '1'.repeat(1000)])('returns a validation refusal for malformed/oversized seed %s', worldSeed => {
    expect(minecraftProtocolSchema.safeParse({ ...protocol(), worldSeed }).success).toBe(false);
  });

  it('snapshots and deeply freezes caller inputs', () => {
    const p = protocol(); const frozen = freezeMinecraftTrial(p); p.actions.push('attack');
    expect(frozen.protocol.actions).toEqual(['craft', 'move']);
    expect(() => frozen.protocol.actions.push('attack')).toThrow();
    expect(Object.isFrozen(frozen.protocol.pins)).toBe(true);
  });
});

describe('Minecraft preflight precedes every inference/accounting side effect', () => {
  const invalidProtocols: Array<[string, (p: any) => void]> = [
    ['version', p => { p.rules.version = '1.21'; }],
    ['difficulty', p => { p.rules.difficulty = 'peaceful'; }],
    ['mode', p => { p.rules.gameMode = 'creative'; }],
    ['cheats', p => { p.rules.cheats = true; }],
    ['missing image', p => { delete p.pins.serverImage; }],
    ['mutable image tag', p => { p.pins.serverImage = 'minecraft:latest'; }],
    ['missing server digest', p => { delete p.pins.serverJarSha256; }],
    ['unpinned Mineflayer', p => { p.pins.mineflayerVersion = '^4.32.0'; }],
    ['unpinned pathfinder', p => { p.pins.pathfinderVersion = 'latest'; }],
    ['empty participants', p => { p.participants = []; }],
    ['duplicate participants', p => { p.participants = ['alice', 'alice']; }],
    ['unknown observation', p => { p.observations.push('host-files'); }],
    ['unknown action', p => { p.actions.push('operator-command'); }],
    ['empty actions', p => { p.actions = []; }],
    ['unbounded spend', p => { p.limits.maxUsd = Infinity; }],
    ['unbounded program', p => { delete p.limits.maxProgramMs; }],
    ['undeclared field', p => { p.extra = 'ignored'; }],
  ];
  it.each(invalidProtocols)('refuses %s without creating any inference identity or reservation', async (_label, invalidate) => {
    const good = protocol(); const p = structuredClone(good); invalidate(p);
    const counters = { attempts: 0, requests: 0, reservations: 0, dispatches: 0 };
    const launch = vi.fn(async () => { for (const k of Object.keys(counters) as Array<keyof typeof counters>) counters[k]++; });
    await expect(withMinecraftPreflight(p, runtime(good), freezeMinecraftTrial(good).trialId, launch)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    expect(counters).toEqual({ attempts: 0, requests: 0, reservations: 0, dispatches: 0 });
  });

  it.each(['serverReady', 'javaMajor', 'serverInstanceId', 'trialId', 'worldSeed', 'rules', 'pins'])(
    'refuses missing measured prerequisite %s before launch', async key => {
      const p = protocol(); const measured: any = runtime(p); delete measured[key];
      const launch = vi.fn();
      await expect(withMinecraftPreflight(p, measured, freezeMinecraftTrial(p).trialId, launch)).rejects.toThrow();
      expect(launch).not.toHaveBeenCalled();
    });
  it.each(['trialId', 'worldSeed'] as const)('refuses a foreign measured %s before launch', async key => {
    const p = protocol(); const measured = runtime(p);
    measured[key] = key === 'trialId' ? sha(99) : '99';
    const launch = vi.fn();
    await expect(withMinecraftPreflight(p, measured, freezeMinecraftTrial(p).trialId, launch)).rejects.toThrow(/prerequisites/);
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(['serverImage', 'serverJarSha256', 'mineflayerVersion', 'pathfinderVersion'] as const)(
    'refuses a measured %s mismatch', async key => {
      const p = protocol(); const measured = runtime(p);
      measured.pins[key] = key.endsWith('Version') ? '1.0.0' : key === 'serverImage'
        ? `minecraft/other@sha256:${sha(99)}` : sha(99);
      const launch = vi.fn();
      await expect(withMinecraftPreflight(p, measured, freezeMinecraftTrial(p).trialId, launch)).rejects.toThrow(/prerequisites/);
      expect(launch).not.toHaveBeenCalled();
    });

  it('admits the compatible positive control once and retains its immutable snapshot across an admission race', async () => {
    const p = protocol(); const original = freezeMinecraftTrial(p);
    const launch = vi.fn(async (trial) => { await Promise.resolve(); return trial.protocol.worldSeed; });
    const pending = withMinecraftPreflight(p, runtime(p), original.trialId, launch);
    p.worldSeed = '4'; p.pins.serverJarSha256 = sha(99);
    expect(await pending).toBe('3'); expect(launch).toHaveBeenCalledTimes(1);
    const invalid = invalidProtocols.map(async ([, change]) => {
      const input = protocol(); change(input);
      await expect(withMinecraftPreflight(input, runtime(protocol()), original.trialId, launch)).rejects.toThrow();
    });
    await Promise.all(invalid); expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('Minecraft manifest, assignment and configuration-selection boundary', () => {
  it('exposes train/dev ids without serializing any held-out objective, seed, gold, scorer or example', () => {
    const manifest = freezeMinecraftManifest(manifestInput());
    expect(minecraftPublicTaskIds(manifest)).toEqual(['train-iron', 'dev-iron']);
    expect(Object.keys(manifest).sort()).toEqual(['counts', 'manifestHash', 'revision']);
    expect(JSON.stringify(manifest)).not.toContain('held-iron');
    expect(readMinecraftTaskMaterial(manifest, { taskId: 'train-iron', participantId: 'alice', kind: 'seed' })).toBe('1');
    expect(readMinecraftTaskMaterial(manifest, { taskId: 'dev-iron', participantId: 'alice', kind: 'reference' })).toBe(sha(6));
  });
  it.each(['objective', 'seed', 'reference', 'scorer', 'examples'] as const)(
    'denies held-out %s before assignment', kind => {
      const manifest = freezeMinecraftManifest(manifestInput());
      expect(() => readMinecraftTaskMaterial(manifest, { taskId: 'held-iron', participantId: 'alice', kind }))
        .toThrow(/before assignment/);
    });
  it('grants only the assigned task/player, keeps scoring private and rejects copied/foreign grants', () => {
    const manifest = freezeMinecraftManifest(manifestInput());
    const selection = freezeMinecraftSelection(manifest, { runId: 'minecraft-run-1', armId: 'stock',
      modelId: 'frozen-model', promptSha256: sha(50), configurationSha256: sha(51), sources: [] });
    const trial = freezeMinecraftTrial({ ...protocol(manifest.manifestHash), selectionHash: selection.selectionHash });
    const assignment = assignMinecraftTask(manifest, trial, 'alice', selection);
    const request = { taskId: 'held-iron', participantId: 'alice', kind: 'objective' as const, assignment };
    expect(readMinecraftTaskMaterial(manifest, request)).toBe('iron-tools');
    expect(readMinecraftTaskMaterial(manifest, { ...request, kind: 'seed' })).toBe('3');
    for (const kind of ['reference', 'scorer'] as const) {
      expect(() => readMinecraftTaskMaterial(manifest, { ...request, kind })).toThrow(/host-only/);
    }
    expect(() => readMinecraftTaskMaterial(manifest, { ...request, participantId: 'bob' })).toThrow(/before assignment/);
    expect(() => readMinecraftTaskMaterial(manifest, { ...request, assignment: { ...assignment } })).toThrow(/before assignment/);
    const other = freezeMinecraftManifest(manifestInput());
    expect(() => readMinecraftTaskMaterial(other, request)).toThrow(/before assignment/);
    expect(() => assignMinecraftTask(manifest, trial, 'mallory', selection)).toThrow(/participant/);
    expect(() => assignMinecraftTask(manifest, { ...trial }, 'alice', selection)).toThrow(/foreign/);
    expect(() => assignMinecraftTask(manifest, trial, 'alice', { ...selection })).toThrow(/selection/);
    expect(() => minecraftPublicTaskIds({ ...manifest })).toThrow(/Unknown/);
  });
  it.each(['train', 'dev', 'heldOut'] as const)('rejects a missing/empty %s partition', partition => {
    const input: any = manifestInput(); delete input[partition];
    expect(() => freezeMinecraftManifest(input)).toThrow();
    input[partition] = []; expect(() => freezeMinecraftManifest(input)).toThrow();
  });
  it.each(['taskId', 'worldSeed', 'referenceSha256', 'scoringFixtureSha256', 'exampleSha256'] as const)(
    'rejects cross-partition overlap in %s', field => {
      const input = manifestInput(); (input.dev[0] as any)[field] = input.heldOut[0][field];
      expect(() => freezeMinecraftManifest(input)).toThrow(/overlap|crosses/);
    });
  it('requires a versioned manifest and snapshots all material before caller mutation', () => {
    expect(() => freezeMinecraftManifest({ ...manifestInput(), revision: 0 })).toThrow();
    const input = manifestInput(); const manifest = freezeMinecraftManifest(input);
    input.train[0].worldSeed = '99'; input.heldOut[0].exampleSha256.push(sha(99));
    expect(readMinecraftTaskMaterial(manifest, { taskId: 'train-iron', participantId: 'alice', kind: 'seed' })).toBe('1');
    expect(freezeMinecraftManifest(input).manifestHash).not.toBe(manifest.manifestHash);
  });
  it('keeps the manifest identity independent of ambient locale collation', () => {
    const input = manifestInput(); input.train[0].taskId = 'z-task';
    input.train.push(task('A-task', 4));
    const expected = freezeMinecraftManifest(input).manifestHash;
    const collation = vi.spyOn(String.prototype, 'localeCompare').mockReturnValue(1);
    try { expect(freezeMinecraftManifest(input).manifestHash).toBe(expected); }
    finally { collation.mockRestore(); }
  });
  it.each(['content', 'outcome'] as const)('refuses held-out %s as configuration-selection provenance', kind => {
    const manifest = freezeMinecraftManifest(manifestInput());
    const selection = { runId: 'minecraft-run-1', armId: 'stock',
      modelId: 'frozen-model', promptSha256: sha(50), configurationSha256: sha(51),
      sources: [{ taskId: 'train-iron', kind }] };
    const accepted = freezeMinecraftSelection(manifest, selection);
    expect(accepted.manifestHash).toBe(manifest.manifestHash);
    expect(Object.isFrozen(accepted.sources)).toBe(true);
    expect(() => freezeMinecraftSelection(manifest, { ...selection, sources: [{ taskId: 'held-iron', kind }] }))
      .toThrow(/cannot tune/);
    expect(() => freezeMinecraftSelection(manifest, { ...selection, sources: [{ taskId: 'unknown-task', kind }] }))
      .toThrow(/Unknown/);
  });
  it('retains the first selection and rejects tuning after assignment while isolating arms', () => {
    const manifest = freezeMinecraftManifest(manifestInput());
    const input = { runId: 'minecraft-run-1', armId: 'stock', modelId: 'frozen-model',
      promptSha256: sha(50), configurationSha256: sha(51), sources: [] };
    const selection = freezeMinecraftSelection(manifest, input);
    const trial = freezeMinecraftTrial({ ...protocol(manifest.manifestHash), selectionHash: selection.selectionHash });
    assignMinecraftTask(manifest, trial, 'alice', selection);
    expect(freezeMinecraftSelection(manifest, input)).toBe(selection);
    for (const changed of [{ modelId: 'tuned-model' }, { promptSha256: sha(52) }, { configurationSha256: sha(53) }]) {
      expect(() => freezeMinecraftSelection(manifest, { ...input, ...changed })).toThrow(/already frozen/);
    }
    const other = freezeMinecraftSelection(manifest, { ...input, armId: 'other' });
    expect(() => assignMinecraftTask(manifest, trial, 'alice', other)).toThrow(/selection/);
  });
});
