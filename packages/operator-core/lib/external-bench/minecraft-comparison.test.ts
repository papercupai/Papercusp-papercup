import { describe, expect, it } from 'vitest';
import { freezeMinecraftManifest, freezeMinecraftPair, freezeMinecraftSelection, freezeMinecraftTrial,
  inspectMinecraftPairAssignment, type MinecraftPairArm } from './minecraft-protocol';

const sha = (n: number) => n.toString(16).padStart(64, '0');
function fixture() {
  const task = (taskId: string, n: number) => ({ taskId, worldSeed: String(n), objective: 'iron-tools',
    referenceSha256: sha(n * 10), scoringFixtureSha256: sha(n * 10 + 1), exampleSha256: [] });
  const manifest = freezeMinecraftManifest({ schemaVersion: 1, revision: 1,
    train: [task('train', 1)], dev: [task('dev', 2)], heldOut: [task('held', 3)] });
  const initialState = { worldSha256: sha(90), memorySha256: sha(91) };
  const arm = (armId: string, participants = ['alice'], change: Record<string, unknown> = {}): MinecraftPairArm => {
    const selection = freezeMinecraftSelection(manifest, { runId: 'comparison', armId, modelId: 'frozen-model',
      promptSha256: sha(80), configurationSha256: sha(81), sources: [] });
    const trial = freezeMinecraftTrial({ schemaVersion: 1, runId: 'comparison', armId, taskId: 'held',
      manifestHash: manifest.manifestHash, selectionHash: selection.selectionHash, worldSeed: '3', objective: 'iron-tools',
      rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
      pins: { serverImage: `minecraft/server@sha256:${sha(70)}`, serverJarSha256: sha(71),
        mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
      participants, observations: ['position', 'inventory'], actions: ['move', 'mine'],
      limits: { maxWallClockMs: 60_000, maxProgramMs: 1000, maxUsd: 2 }, ...change });
    return { trial, selection, initialState: { ...initialState } };
  };
  return { manifest, arm, initialState, arms: [arm('stock'), arm('repeated'), arm('coordinated', ['alice', 'bob'])] };
}

describe('Minecraft immutable paired comparison admission', () => {
  it('freezes one total budget and deterministic randomized order for all three arms', () => {
    const f = fixture();
    const pair = freezeMinecraftPair(f.manifest, { arms: f.arms, orderSeed: sha(100) });
    const reordered = freezeMinecraftPair(f.manifest, { arms: [...f.arms].reverse(), orderSeed: sha(100) });
    expect(reordered).toEqual(pair);
    expect([...pair.armOrder].sort()).toEqual(['coordinated', 'repeated', 'stock']);
    expect(pair.assignments).toHaveLength(3);
    expect(new Set(pair.assignments.map(a => a.trialId)).size).toBe(3);
    expect(Object.isFrozen(pair.armOrder)).toBe(true);
    expect(freezeMinecraftPair(f.manifest, { arms: f.arms, orderSeed: sha(101) }).pairId).not.toBe(pair.pairId);
    for (const arm of f.arms) expect(inspectMinecraftPairAssignment(pair, arm.trial.protocol.armId,
      { trialId: arm.trial.trialId, protocol: arm.trial.protocol, initialState: f.initialState }).paired).toBe(true);
  });
  it.each(['worldSeed', 'objective', 'rules', 'pins', 'observations', 'actions', 'limits'])(
    'refuses a different %s before paired execution', field => {
      const f = fixture();
      const values: Record<string, unknown> = { worldSeed: '4', objective: 'nether-entry',
        rules: { ...f.arms[0].trial.protocol.rules, cheats: true },
        pins: { ...f.arms[0].trial.protocol.pins, serverJarSha256: sha(72) },
        observations: ['position'], actions: ['move'],
        limits: { ...f.arms[0].trial.protocol.limits, maxUsd: 3 } };
      expect(() => freezeMinecraftPair(f.manifest,
        { arms: [f.arms[0], f.arm('other', ['alice'], { [field]: values[field] })], orderSeed: sha(100) })).toThrow();
    });
  it.each(['worldSha256', 'memorySha256'] as const)('refuses unequal initial %s and snapshots baseline input', field => {
    const f = fixture(); const second = f.arms[1];
    second.initialState[field] = sha(99);
    expect(() => freezeMinecraftPair(f.manifest, { arms: f.arms, orderSeed: sha(100) })).toThrow(/inputs differ/);
    second.initialState[field] = f.initialState[field];
    const pair = freezeMinecraftPair(f.manifest, { arms: f.arms, orderSeed: sha(100) });
    second.initialState[field] = sha(99);
    expect(inspectMinecraftPairAssignment(pair, second.trial.protocol.armId,
      { trialId: second.trial.trialId, protocol: second.trial.protocol, initialState: second.initialState }))
      .toMatchObject({ paired: false, deviations: ['initialState'] });
  });
  it('retains the original assignment identity when trial, protocol or reset measurement deviates', () => {
    const f = fixture(); const pair = freezeMinecraftPair(f.manifest, { arms: f.arms, orderSeed: sha(100) });
    const arm = f.arms[0];
    const result = inspectMinecraftPairAssignment(pair, 'stock', { trialId: sha(99),
      protocol: { ...arm.trial.protocol, worldSeed: '4' }, initialState: {} });
    expect(result).toEqual({ pairId: pair.pairId, armId: 'stock', trialId: arm.trial.trialId,
      paired: false, deviations: ['trialId', 'protocol', 'initialState'] });
  });
  it('rejects copied handles, unknown arms, duplicate arms and foreign selections', () => {
    const f = fixture(); const pair = freezeMinecraftPair(f.manifest, { arms: f.arms, orderSeed: sha(100) });
    const measurement = { trialId: f.arms[0].trial.trialId, protocol: f.arms[0].trial.protocol, initialState: f.initialState };
    expect(() => inspectMinecraftPairAssignment({ ...pair }, 'stock', measurement)).toThrow(/handle/);
    expect(() => inspectMinecraftPairAssignment(pair, 'foreign', measurement)).toThrow(/arm/);
    expect(() => freezeMinecraftPair(f.manifest, { arms: [f.arms[0], f.arms[0]], orderSeed: sha(100) })).toThrow(/Duplicate/);
    expect(() => freezeMinecraftPair(f.manifest, { arms: [{ ...f.arms[0], selection: { ...f.arms[0].selection } }, f.arms[1]],
      orderSeed: sha(100) })).toThrow(/selection/);
  });
});
