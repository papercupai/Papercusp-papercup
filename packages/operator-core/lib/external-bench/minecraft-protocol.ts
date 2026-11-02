/** Minecraft P-001: host-owned protocol and task-material boundary.
 * Reuses the benchmark canonical JSON format. Runtime/accounting adapters must
 * enter through withMinecraftPreflight before allocating any inference attempt.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './reproducibility/canonical-json';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const exactVersion = z.string().regex(/^\d+\.\d+\.\d+$/);
const seed = z.string().regex(/^(?:0|-?[1-9]\d*)$/).refine(value => {
  if (value.length > 20 || !/^(?:0|-?[1-9]\d*)$/.test(value)) return false;
  const n = BigInt(value);
  return n >= -(2n ** 63n) && n < 2n ** 63n;
}, 'Minecraft seeds must be exact signed 64-bit decimal strings');
const objective = z.enum(['iron-tools', 'nether-entry', 'ender-dragon']);
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const MINECRAFT_TASK_SETS = Object.freeze({
  'minecraft-pilot': Object.freeze(['iron-tools', 'nether-entry'] as const),
  'minecraft-ender-dragon': Object.freeze(['ender-dragon'] as const),
});

/** Server advancements, collected by the host, define these objectives. */
export const MINECRAFT_OBJECTIVES = Object.freeze({
  'iron-tools': 'minecraft:story/iron_tools',
  'nether-entry': 'minecraft:nether/root',
  'ender-dragon': 'minecraft:end/kill_dragon',
});

const rules = z.object({
  version: z.literal('1.20.4'), difficulty: z.literal('easy'),
  gameMode: z.literal('survival'), cheats: z.literal(false),
}).strict();
const pins = z.object({
  serverImage: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/),
  serverJarSha256: digest, mineflayerVersion: exactVersion, pathfinderVersion: exactVersion,
}).strict();

export const minecraftProtocolSchema = z.object({
  schemaVersion: z.literal(1), runId: id, armId: id, taskId: id,
  manifestHash: digest, selectionHash: digest, worldSeed: seed, objective,
  rules, pins,
  participants: z.array(id).min(1).max(4).refine(unique, 'Participants must be distinct'),
  observations: z.array(z.enum([
    'position', 'health', 'inventory', 'blocks', 'entities', 'advancements', 'team-chat',
  ])).min(1).refine(unique),
  actions: z.array(z.enum(['move', 'mine', 'craft', 'interact', 'attack', 'team-chat']))
    .min(1).refine(unique),
  limits: z.object({
    maxWallClockMs: z.number().int().positive().max(72_000_000),
    maxProgramMs: z.number().int().positive().max(60_000),
    maxUsd: z.number().finite().positive().max(20),
  }).strict(),
}).strict();
export type MinecraftProtocol = z.infer<typeof minecraftProtocolSchema>;
export interface FrozenMinecraftTrial {
  readonly trialId: string;
  readonly protocol: Readonly<MinecraftProtocol>;
}
const issuedTrials = new WeakSet<FrozenMinecraftTrial>();
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function freezeMinecraftTrial(input: unknown): FrozenMinecraftTrial {
  // Parse once: no aliases to mutable launcher inputs survive admission.
  const protocol = minecraftProtocolSchema.parse(input);
  protocol.participants.sort();
  protocol.observations.sort();
  protocol.actions.sort();
  const trial = freeze({ trialId: hash(protocol), protocol });
  issuedTrials.add(trial);
  return trial;
}

export function assertMinecraftTrialIdentity(expectedTrialId: string, input: unknown): FrozenMinecraftTrial {
  digest.parse(expectedTrialId);
  const trial = freezeMinecraftTrial(input);
  if (trial.trialId !== expectedTrialId) throw new Error('Minecraft trial identity changed');
  return trial;
}

/** Measured by the maintained runtime adapter, never inferred from model text. */
export const minecraftRuntimeMeasurementSchema = z.object({
  serverInstanceId: id, serverReady: z.literal(true), javaMajor: z.literal(17),
  trialId: digest, worldSeed: seed, rules, pins,
}).strict();

export async function withMinecraftPreflight<T>(
  input: unknown, runtimeMeasurement: unknown, expectedTrialId: string,
  dispatch: (trial: FrozenMinecraftTrial) => Promise<T>,
): Promise<T> {
  const trial = assertMinecraftTrialIdentity(expectedTrialId, input);
  const actual = minecraftRuntimeMeasurementSchema.parse(runtimeMeasurement);
  if (actual.trialId !== trial.trialId || actual.worldSeed !== trial.protocol.worldSeed
    || canonicalJson(actual.rules) !== canonicalJson(trial.protocol.rules)
    || canonicalJson(actual.pins) !== canonicalJson(trial.protocol.pins)) {
    throw new Error('Minecraft runtime does not match frozen prerequisites');
  }
  // The callback is the existing launch/accounting seam: no request identities,
  // reservations, cached calls or provider attempts may be created before here.
  return dispatch(trial);
}

const materialTask = z.object({
  taskId: id, worldSeed: seed, objective,
  referenceSha256: digest, scoringFixtureSha256: digest,
  exampleSha256: z.array(digest).refine(unique),
}).strict();
type MaterialTask = z.infer<typeof materialTask>;
const manifestInput = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive(),
  train: z.array(materialTask).min(1), dev: z.array(materialTask).min(1),
  heldOut: z.array(materialTask).min(1),
}).strict();
type ManifestInput = z.infer<typeof manifestInput>;
type Partition = 'train' | 'dev' | 'heldOut';
export interface FrozenMinecraftManifest {
  readonly manifestHash: string;
  readonly revision: number;
  readonly counts: Readonly<Record<Partition, number>>;
}
// These tables are host-only. Serializing a manifest or an assignment never
// serializes held-out material, and a copied/forged handle has no authority.
const manifests = new WeakMap<FrozenMinecraftManifest, ManifestInput>();
export interface MinecraftAssignment {
  readonly trialId: string;
  readonly taskId: string;
  readonly participantId: string;
}
const assignments = new WeakMap<MinecraftAssignment, {
  manifest: FrozenMinecraftManifest; trial: FrozenMinecraftTrial;
}>();

export function freezeMinecraftManifest(input: unknown): FrozenMinecraftManifest {
  const parsed = manifestInput.parse(input);
  const taskIds = new Set<string>();
  const materialOwners = new Map<string, Partition>();
  for (const partition of ['train', 'dev', 'heldOut'] as const) {
    parsed[partition].sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
    for (const task of parsed[partition]) {
      if (taskIds.has(task.taskId)) throw new Error('Minecraft task partitions overlap');
      taskIds.add(task.taskId);
      const materials = [
        `world:${task.worldSeed}`, `blob:${task.referenceSha256}`,
        `blob:${task.scoringFixtureSha256}`, ...task.exampleSha256.map(sha => `blob:${sha}`),
      ];
      for (const material of materials) {
        const prior = materialOwners.get(material);
        if (prior && prior !== partition) throw new Error('Minecraft material crosses task partitions');
        materialOwners.set(material, partition);
      }
    }
  }
  const manifest = freeze({ manifestHash: hash(parsed), revision: parsed.revision,
    counts: { train: parsed.train.length, dev: parsed.dev.length, heldOut: parsed.heldOut.length } });
  manifests.set(manifest, freeze(parsed));
  return manifest;
}

function manifestData(manifest: FrozenMinecraftManifest): ManifestInput {
  const data = manifests.get(manifest);
  if (!data) throw new Error('Unknown Minecraft manifest handle');
  return data;
}

function findTask(manifest: FrozenMinecraftManifest, taskId: string): { task: MaterialTask; partition: Partition } {
  const data = manifestData(manifest);
  for (const partition of ['train', 'dev', 'heldOut'] as const) {
    const task = data[partition].find(candidate => candidate.taskId === taskId);
    if (task) return { task, partition };
  }
  throw new Error('Unknown Minecraft task');
}

export function minecraftPublicTaskIds(manifest: FrozenMinecraftManifest): readonly string[] {
  const data = manifestData(manifest);
  return Object.freeze([...data.train, ...data.dev].map(task => task.taskId));
}

export function assignMinecraftTask(
  manifest: FrozenMinecraftManifest, trial: FrozenMinecraftTrial, participantId: string,
  selection: FrozenMinecraftSelection,
): MinecraftAssignment {
  if (!issuedTrials.has(trial) || trial.protocol.manifestHash !== manifest.manifestHash) {
    throw new Error('Minecraft assignment has a foreign trial/manifest');
  }
  if (selections.get(selection) !== manifest
    || selection.selectionHash !== trial.protocol.selectionHash
    || selection.runId !== trial.protocol.runId || selection.armId !== trial.protocol.armId) {
    throw new Error('Minecraft assignment requires its frozen model/prompt/configuration selection');
  }
  const { task } = findTask(manifest, trial.protocol.taskId);
  if (task.worldSeed !== trial.protocol.worldSeed || task.objective !== trial.protocol.objective
    || !trial.protocol.participants.includes(participantId)) {
    throw new Error('Minecraft assignment does not match the frozen task/participant');
  }
  const assignment = Object.freeze({ trialId: trial.trialId, taskId: task.taskId, participantId });
  assignments.set(assignment, { manifest, trial });
  return assignment;
}

export function readMinecraftTaskMaterial(
  manifest: FrozenMinecraftManifest,
  request: { taskId: string; participantId: string;
    kind: 'objective' | 'seed' | 'reference' | 'scorer' | 'examples'; assignment?: MinecraftAssignment },
): string | readonly string[] {
  const { task, partition } = findTask(manifest, request.taskId);
  if (partition === 'heldOut') {
    const grant = request.assignment && assignments.get(request.assignment);
    if (!grant || grant.manifest !== manifest || request.assignment!.taskId !== task.taskId
      || request.assignment!.participantId !== request.participantId
      || grant.trial.trialId !== request.assignment!.trialId) {
      throw new Error('Held-out Minecraft task is inaccessible before assignment');
    }
    if (request.kind === 'reference' || request.kind === 'scorer') {
      throw new Error('Held-out Minecraft grading material is host-only');
    }
  }
  switch (request.kind) {
    case 'objective': return task.objective;
    case 'seed': return task.worldSeed;
    case 'reference': return task.referenceSha256;
    case 'scorer': return task.scoringFixtureSha256;
    case 'examples': return task.exampleSha256;
    default: throw new Error('Unknown Minecraft material kind');
  }
}

const selectionInput = z.object({
  runId: id, armId: id,
  modelId: id, promptSha256: digest, configurationSha256: digest,
  sources: z.array(z.object({ taskId: id, kind: z.enum(['content', 'outcome']) }).strict()),
}).strict();
export type FrozenMinecraftSelection = Readonly<z.infer<typeof selectionInput> & {
  manifestHash: string; selectionHash: string;
}>;
const selections = new WeakMap<FrozenMinecraftSelection, FrozenMinecraftManifest>();
const runSelections = new WeakMap<FrozenMinecraftManifest, Map<string, FrozenMinecraftSelection>>();

export function freezeMinecraftSelection(manifest: FrozenMinecraftManifest, input: unknown): FrozenMinecraftSelection {
  const selection = selectionInput.parse(input);
  manifestData(manifest);
  for (const source of selection.sources) {
    if (findTask(manifest, source.taskId).partition === 'heldOut') {
      throw new Error('Held-out Minecraft content/outcomes cannot tune the scored comparison');
    }
  }
  const value = { manifestHash: manifest.manifestHash, ...selection };
  const frozen = freeze({ ...value, selectionHash: hash(value) });
  const key = canonicalJson([selection.runId, selection.armId]);
  let byRun = runSelections.get(manifest);
  if (!byRun) { byRun = new Map(); runSelections.set(manifest, byRun); }
  const prior = byRun.get(key);
  if (prior && prior.selectionHash !== frozen.selectionHash) {
    throw new Error('Minecraft model/prompt/configuration selection is already frozen for this run/arm');
  }
  if (prior) return prior;
  byRun.set(key, frozen);
  selections.set(frozen, manifest);
  return frozen;
}

/** Assignment admission for maintained launchers. All task access and accounting
 * allocation occurs after runtime validation and selection/manifest binding. */
export async function withMinecraftAssignment<T>(
  manifest: FrozenMinecraftManifest, selection: FrozenMinecraftSelection,
  input: unknown, runtimeMeasurement: unknown, expectedTrialId: string,
  participantId: string,
  dispatch: (trial: FrozenMinecraftTrial, assignment: MinecraftAssignment) => Promise<T>,
): Promise<T> {
  return withMinecraftPreflight(input, runtimeMeasurement, expectedTrialId, async trial => {
    const assignment = assignMinecraftTask(manifest, trial, participantId, selection);
    return dispatch(trial, assignment);
  });
}

/** Host-frozen baseline identities. Runtime admission must measure these again;
 * declaring a digest here is not proof that a world or memory was reset. */
const initialStateSchema = z.object({ worldSha256: digest, memorySha256: digest }).strict();
export type MinecraftInitialState = z.infer<typeof initialStateSchema>;
export interface MinecraftPairArm {
  trial: FrozenMinecraftTrial;
  selection: FrozenMinecraftSelection;
  initialState: MinecraftInitialState;
}
export interface FrozenMinecraftPair {
  readonly pairId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly orderSeed: string;
  readonly armOrder: readonly string[];
  readonly assignments: readonly { armId: string; trialId: string }[];
}
const pairedArms = new WeakMap<FrozenMinecraftPair, ReadonlyMap<string, {
  trial: FrozenMinecraftTrial; initialState: Readonly<MinecraftInitialState>;
}>>();

function pairInputs(arm: MinecraftPairArm) {
  const { protocol } = arm.trial;
  return {
    runId: protocol.runId, taskId: protocol.taskId, manifestHash: protocol.manifestHash,
    worldSeed: protocol.worldSeed, objective: protocol.objective, rules: protocol.rules,
    pins: protocol.pins, observations: protocol.observations, actions: protocol.actions,
    limits: protocol.limits, modelId: arm.selection.modelId,
    promptSha256: arm.selection.promptSha256, initialState: initialStateSchema.parse(arm.initialState),
  };
}

/** Freeze pairing before runtime/provider allocation. Arm-specific participant
 * counts and coordination configuration remain in each exact trial identity;
 * the model, gameplay surface, baseline and TOTAL trial limits must match.
 * The seeded permutation is retained, independent of caller array ordering. */
export function freezeMinecraftPair(manifest: FrozenMinecraftManifest, input: {
  arms: readonly MinecraftPairArm[]; orderSeed: string;
}): FrozenMinecraftPair {
  manifestData(manifest);
  digest.parse(input.orderSeed);
  if (input.arms.length < 2 || input.arms.length > 8) throw Error('Minecraft pair needs 2–8 arms');
  const arms = [...input.arms].sort((a, b) => a.trial.protocol.armId < b.trial.protocol.armId ? -1 : 1);
  const byId = new Map<string, { trial: FrozenMinecraftTrial; initialState: Readonly<MinecraftInitialState> }>();
  let common: string | undefined;
  for (const arm of arms) {
    const { trial, selection } = arm;
    if (!issuedTrials.has(trial)) throw Error('Minecraft pair requires an issued trial');
    // Reuse the existing private material/selection boundary, including seed,
    // objective and run/arm identity, without allocating inference authority.
    assignMinecraftTask(manifest, trial, trial.protocol.participants[0]!, selection);
    if (byId.has(trial.protocol.armId)) throw Error('Duplicate Minecraft pair arm');
    const inputs = pairInputs(arm), encoded = canonicalJson(inputs);
    if (common !== undefined && common !== encoded) throw Error('Minecraft pair inputs differ');
    common = encoded;
    byId.set(trial.protocol.armId, { trial, initialState: freeze(inputs.initialState) });
  }
  const commonHash = hash(JSON.parse(common!));
  const armOrder = [...byId.keys()].sort((a, b) => {
    const left = hash([input.orderSeed, commonHash, a]), right = hash([input.orderSeed, commonHash, b]);
    return left < right ? -1 : left > right ? 1 : a < b ? -1 : 1;
  });
  const assignments = [...byId].map(([armId, { trial }]) => ({ armId, trialId: trial.trialId }));
  const identity = { runId: arms[0].trial.protocol.runId, taskId: arms[0].trial.protocol.taskId,
    commonHash, orderSeed: input.orderSeed, armOrder, assignments };
  const pair = freeze({ pairId: hash(identity), runId: identity.runId, taskId: identity.taskId,
    orderSeed: input.orderSeed, armOrder, assignments });
  pairedArms.set(pair, byId);
  return pair;
}

/** Return an explicit unpaired disposition for every measured deviation. The
 * launcher must retain this assignment in its denominator and refuse inference;
 * it must never silently drop it or present it as a valid paired result. */
export function inspectMinecraftPairAssignment(pair: FrozenMinecraftPair, armId: string, measurement: {
  trialId: string; protocol: unknown; initialState: unknown;
}): { pairId: string; armId: string; trialId: string; paired: boolean; deviations: string[] } {
  const arms = pairedArms.get(pair);
  if (!arms) throw Error('Unknown Minecraft pair handle');
  const arm = arms.get(armId);
  if (!arm) throw Error('Unknown Minecraft pair arm');
  const deviations: string[] = [];
  if (measurement.trialId !== arm.trial.trialId) deviations.push('trialId');
  try { assertMinecraftTrialIdentity(arm.trial.trialId, measurement.protocol); }
  catch { deviations.push('protocol'); }
  const state = initialStateSchema.safeParse(measurement.initialState);
  if (!state.success || canonicalJson(state.data) !== canonicalJson(arm.initialState)) deviations.push('initialState');
  return { pairId: pair.pairId, armId, trialId: arm.trial.trialId, paired: deviations.length === 0, deviations };
}
