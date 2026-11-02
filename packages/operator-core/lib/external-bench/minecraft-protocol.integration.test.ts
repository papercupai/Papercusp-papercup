/** Real host admission + PostgreSQL reservation ledger. Runtime measurements
 * are synthetic here; real server/Mineflayer connection is covered by P-002. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { registerLearningLoop, reserveLearningSpend, settleLearningSpend,
  listLearningSpendReservations } from '../learning-governor/store';
import { freezeMinecraftManifest, freezeMinecraftSelection, freezeMinecraftTrial,
  readMinecraftTaskMaterial, withMinecraftAssignment, type MinecraftProtocol } from './minecraft-protocol';

let db: FreshPgDb;
const workspaceId = 'minecraft-protocol-private-test';
const sha = (n: number) => n.toString(16).padStart(64, '0');
beforeAll(async () => {
  db = await createFreshPgDb('minecraftprotocol');
  for (const name of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql']) {
    const body = readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url), 'utf8')
      .split('\n').filter(line => !/\bGRANT\b|^\s*\\/.test(line)).join('\n');
    await db.sql.unsafe(body);
  }
  await db.sql.unsafe('ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text');
  await db.sql.unsafe('ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text');
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

function fixture() {
  const material = (taskId: string, n: number) => ({ taskId, worldSeed: String(n),
    objective: 'iron-tools', referenceSha256: sha(n * 3), scoringFixtureSha256: sha(n * 3 + 1),
    exampleSha256: [sha(n * 3 + 2)] });
  const manifest = freezeMinecraftManifest({ schemaVersion: 1, revision: 1,
    train: [material('train', 1)], dev: [material('dev', 2)], heldOut: [material('held', 3)] });
  const runId = randomUUID();
  const selectionInput = { runId, armId: 'stock', modelId: 'frozen-model',
    promptSha256: sha(20), configurationSha256: sha(21), sources: [{ taskId: 'dev', kind: 'outcome' }] };
  const selection = freezeMinecraftSelection(manifest, selectionInput);
  const protocol: MinecraftProtocol = { schemaVersion: 1, runId, armId: 'stock', taskId: 'held',
    manifestHash: manifest.manifestHash, selectionHash: selection.selectionHash,
    worldSeed: '3', objective: 'iron-tools',
    rules: { version: '1.20.4', difficulty: 'easy', gameMode: 'survival', cheats: false },
    pins: { serverImage: `minecraft/server@sha256:${sha(10)}`, serverJarSha256: sha(11),
      mineflayerVersion: '4.32.0', pathfinderVersion: '2.4.5' },
    participants: ['alice'], observations: ['inventory'], actions: ['craft'],
    limits: { maxUsd: 2, maxWallClockMs: 60_000, maxProgramMs: 1000 } };
  const trial = freezeMinecraftTrial(protocol);
  const measured = { serverInstanceId: `server-${runId}`, serverReady: true, javaMajor: 17,
    trialId: trial.trialId, worldSeed: protocol.worldSeed, rules: protocol.rules, pins: protocol.pins };
  return { manifest, selection, selectionInput, protocol, trial, measured };
}

describe('Minecraft held-out admission precedes real reservation accounting', () => {
  it('denies preassignment exposure and drift without ledger rows, then admits and settles the bound positive control', async () => {
    const f = fixture(); const loopId = `benchmark:${f.protocol.runId}`;
    await registerLearningLoop(db.sql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: 20,
      enabled: true, meta: {} });
    let dispatches = 0;
    const launch = async (trial: typeof f.trial, assignment: Parameters<typeof readMinecraftTaskMaterial>[1]['assignment']) => {
      expect(readMinecraftTaskMaterial(f.manifest, { taskId: 'held', participantId: 'alice', kind: 'seed', assignment })).toBe('3');
      expect(() => readMinecraftTaskMaterial(f.manifest, { taskId: 'held', participantId: 'alice', kind: 'scorer', assignment })).toThrow(/host-only/);
      const reservation = await reserveLearningSpend(db.sql, { workspaceId, loopId,
        requestedUsd: trial.protocol.limits.maxUsd, floorUsd: 0, attemptKind: 'evaluation', note: trial.trialId });
      expect(reservation.ok).toBe(true); dispatches++;
      return reservation;
    };
    for (const kind of ['seed', 'objective', 'reference', 'scorer', 'examples'] as const) {
      expect(() => readMinecraftTaskMaterial(f.manifest, { taskId: 'held', participantId: 'alice', kind })).toThrow(/before assignment/);
    }
    const invalid = [
      { protocol: f.protocol, measured: { ...f.measured, serverReady: false }, selection: f.selection },
      { protocol: f.protocol, measured: { ...f.measured, worldSeed: '4' }, selection: f.selection },
      { protocol: f.protocol, measured: f.measured, selection: { ...f.selection } },
      { protocol: { ...f.protocol, selectionHash: sha(99) }, measured: f.measured, selection: f.selection },
    ];
    for (const input of invalid) {
      await expect(withMinecraftAssignment(f.manifest, input.selection, input.protocol, input.measured,
        f.trial.trialId, 'alice', launch)).rejects.toThrow();
    }
    for (const kind of ['content', 'outcome']) {
      expect(() => freezeMinecraftSelection(f.manifest, { ...f.selectionInput, sources: [{ taskId: 'held', kind }] })).toThrow(/cannot tune/);
    }
    expect(dispatches).toBe(0);
    expect(await listLearningSpendReservations(db.sql, { workspaceId, loopId })).toEqual([]);
    const admitted = await withMinecraftAssignment(f.manifest, f.selection, f.protocol, f.measured,
      f.trial.trialId, 'alice', launch);
    if (!admitted.ok) throw new Error('Positive control reservation refused');
    const rows = await listLearningSpendReservations(db.sql, { workspaceId, loopId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reservedUsd: 2, status: 'open', note: f.trial.trialId });
    expect(() => freezeMinecraftSelection(f.manifest, { ...f.selectionInput, modelId: 'post-outcome-model' })).toThrow(/already frozen/);
    expect((await settleLearningSpend(db.sql, { workspaceId, reservationId: rows[0].id,
      usedUsd: 0, disposition: 'cancelled' })).ok).toBe(true);
    expect(dispatches).toBe(1);
    expect((await listLearningSpendReservations(db.sql, { workspaceId, loopId }))[0]).toMatchObject({ usedUsd: 0, status: 'cancelled' });
  });
});
