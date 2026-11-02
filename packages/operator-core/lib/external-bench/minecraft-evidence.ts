/** Host-collected Minecraft scoring. Participant output is replay data, never an oracle. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './reproducibility/canonical-json';
import { assertMinecraftTrialIdentity, minecraftProtocolSchema, MINECRAFT_OBJECTIVES, type FrozenMinecraftTrial } from './minecraft-protocol';
import { minecraftOfflinePlayerUuid, readMinecraftRuntimeSnapshot,
  type MinecraftRuntime, type MinecraftRuntimeSnapshot } from './minecraft-runtime';
import type { GradeResult } from './types';

const criteria = { 'iron-tools': 'iron_pickaxe', 'nether-entry': 'entered_nether', 'ender-dragon': 'killed_dragon' } as const;
const advancementFile = z.record(z.string(), z.unknown());
const advancement = z.object({ done: z.boolean(), criteria: z.record(z.string(), z.string()) }).strict();
const statsFile = z.object({ DataVersion: z.number().int(), stats: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())) }).strict();
const issued = new WeakSet<MinecraftEvidence>();
export interface MinecraftEvidence {
  readonly schemaVersion: 1;
  readonly trialId: string;
  readonly runtimeId: string;
  readonly sha256: string;
  readonly snapshot: MinecraftRuntimeSnapshot;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export async function collectMinecraftEvidence(runtime: MinecraftRuntime): Promise<MinecraftEvidence> {
  const snapshot = await readMinecraftRuntimeSnapshot(runtime);
  const evidence = freeze({ schemaVersion: 1 as const, trialId: snapshot.trial.trialId, runtimeId: snapshot.runtimeId,
    sha256: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'), snapshot });
  issued.add(evidence);
  return evidence;
}
/** Export retains the exact raw server files, program source/results and trusted event logs. */
export function exportMinecraftEvidence(evidence: MinecraftEvidence): string {
  if (!issued.has(evidence)) throw Error('Untrusted Minecraft evidence');
  return canonicalJson(evidence);
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const archivedEvidence = z.object({
  schemaVersion: z.literal(1), trialId: digest, runtimeId: z.string().min(1).max(200), sha256: digest,
  snapshot: z.object({
    runtimeId: z.string().min(1).max(200),
    trial: z.object({ trialId: digest, protocol: minecraftProtocolSchema }).strict(),
    startedAtMs: z.number().int().nonnegative().safe(), stoppedAtMs: z.number().int().nonnegative().safe(),
    files: z.record(z.string().min(1).max(400), z.string().nullable()).refine(files =>
      Object.keys(files).length <= 100 && Object.values(files).reduce((bytes, file) =>
        bytes + (file == null ? 0 : Buffer.byteLength(file)), 0) <= 32 * 1024 * 1024),
    provenance: z.object({ source: z.literal('host-collected-server-files'), deterministicReplay: z.literal(false),
      nondeterministicInputs: z.array(z.string().min(1).max(200)).min(1).max(20) }).strict(),
  }).strict(),
}).strict();
/** Host-only archive reader. The expected SHA must come from the retained host
 * result/artifact record, never from the submitted bundle or participant text.
 * Re-scoring is deterministic; re-running the game is explicitly not claimed. */
export function readMinecraftEvidenceExport(serialized: string, expectedArchiveSha256: string): MinecraftEvidence {
  digest.parse(expectedArchiveSha256);
  if (Buffer.byteLength(serialized) > 64 * 1024 * 1024
    || createHash('sha256').update(serialized).digest('hex') !== expectedArchiveSha256) {
    throw Error('Minecraft archive does not match retained host digest');
  }
  const evidence = archivedEvidence.parse(JSON.parse(serialized));
  assertMinecraftTrialIdentity(evidence.trialId, evidence.snapshot.trial.protocol);
  if (evidence.snapshot.trial.trialId !== evidence.trialId || evidence.runtimeId !== evidence.snapshot.runtimeId
    || createHash('sha256').update(canonicalJson(evidence.snapshot)).digest('hex') !== evidence.sha256) {
    throw Error('Minecraft archive trial, runtime or snapshot digest changed');
  }
  freeze(evidence); issued.add(evidence);
  return evidence;
}
function completionTime(text: string, start: number, end: number): number {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-])(\d\d)(\d\d)$/.exec(text);
  if (!match) throw Error('Malformed Minecraft advancement timestamp');
  const offset = (Number(match[4]) * 60 + Number(match[5])) * (match[3] === '+' ? 1 : -1);
  const value = Date.parse(`${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`);
  if (!Number.isFinite(value) || new Date(value + offset * 60_000).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`
    || value < start - 999 || value > end + 999) throw Error('Minecraft advancement outside trial interval');
  return value;
}
export function gradeMinecraftEvidence(trialInput: FrozenMinecraftTrial, input: unknown): GradeResult {
  const trial = assertMinecraftTrialIdentity(trialInput.trialId, trialInput.protocol);
  const base = { instanceId: trial.protocol.taskId, prefix: trial.protocol.armId,
    graderFamily: 'minecraft', graderVersion: 'minecraft@1.20.4/server-advancements-v1' };
  try {
    if (!input || typeof input !== 'object' || !issued.has(input as MinecraftEvidence)) throw Error('Untrusted Minecraft evidence');
    const evidence = input as MinecraftEvidence;
    const { snapshot } = evidence;
    if (evidence.trialId !== trial.trialId || snapshot.trial.trialId !== trial.trialId) throw Error('Foreign Minecraft trial evidence');
    if (!Number.isSafeInteger(snapshot.startedAtMs) || !Number.isSafeInteger(snapshot.stoppedAtMs)
      || snapshot.stoppedAtMs < snapshot.startedAtMs) throw Error('Invalid Minecraft evidence interval');
    if (createHash('sha256').update(canonicalJson(snapshot)).digest('hex') !== evidence.sha256) throw Error('Minecraft evidence digest changed');
    const milestones: Array<{ participant: string; objective: string; atMs: number; elapsedMs: number }> = [];
    const deaths: Record<string, number> = {};
    const lastAllowed = Math.min(snapshot.stoppedAtMs, snapshot.startedAtMs + trial.protocol.limits.maxWallClockMs);
    for (const participant of trial.protocol.participants) {
      const uuid = minecraftOfflinePlayerUuid(participant);
      const raw = snapshot.files[`world/world/advancements/${uuid}.json`];
      const stats = snapshot.files[`world/world/stats/${uuid}.json`];
      if (raw == null || stats == null) throw Error(`Missing enrolled-player server evidence: ${participant}`);
      const parsed = advancementFile.parse(JSON.parse(raw));
      if (!Number.isInteger(parsed.DataVersion)) throw Error('Missing Minecraft advancement DataVersion');
      const counts = statsFile.parse(JSON.parse(stats));
      deaths[participant] = counts.stats['minecraft:custom']?.['minecraft:deaths'] ?? 0;
      for (const [objective, key] of Object.entries(MINECRAFT_OBJECTIVES)) {
        if (!(key in parsed)) continue;
        const progress = advancement.parse(parsed[key]);
        const expected = criteria[objective as keyof typeof criteria];
        if (!progress.done) continue;
        if (!Object.hasOwn(progress.criteria, expected)) throw Error(`Incomplete server advancement: ${key}`);
        const atMs = completionTime(progress.criteria[expected]!, snapshot.startedAtMs, lastAllowed);
        milestones.push({ participant, objective, atMs, elapsedMs: Math.max(0, atMs - snapshot.startedAtMs) });
      }
    }
    if (snapshot.files['programs.jsonl'] == null || snapshot.files['server.log'] == null || snapshot.files['bot.log'] == null) {
      throw Error('Incomplete Minecraft replay');
    }
    for (const line of snapshot.files['programs.jsonl']!.split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (!event || !trial.protocol.participants.includes(event.participant) || !Number.isSafeInteger(event.atMs)
        || !['program-start', 'program-end', 'program-error'].includes(event.event)) throw Error('Malformed Minecraft program replay');
    }
    const resolved = milestones.some(milestone => milestone.objective === trial.protocol.objective);
    return { ...base, resolved, score: resolved ? 1 : 0,
      rawGraderOutput: { trialId: trial.trialId, runtimeId: evidence.runtimeId, evidenceSha256: evidence.sha256, milestones, deaths } };
  } catch (error) {
    return { ...base, resolved: false, score: null, graderError: error instanceof Error ? error.message : String(error),
      rawGraderOutput: { trialId: trial.trialId, note: 'No trustworthy server verdict' } };
  }
}
