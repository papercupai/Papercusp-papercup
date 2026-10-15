import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  clearPendingCarryRespawn,
  consumePendingCarryRespawn,
  PENDING_CARRY_RESPAWN_TTL_MS,
  restorePendingCarryRespawn,
  savePendingCarryRespawn,
  markSessionBriefShutdown,
  attestLifecycleConsumerView,
} from './session-brief';

const here = dirname(fileURLToPath(import.meta.url));
const sessionBriefMigration = resolve(
  here,
  '../../../libs/papercusp/libs/db/sql/322-session-briefs-ei1742.sql',
);
// Keep migration state isolated: prove the helper rejects the pre-migration
// schema, then apply the migration to this throwaway database and exercise the
// migrated write/consume/restore path.
const pendingCarryMigration = resolve(
  here,
  '../../../libs/papercusp/libs/db/sql/1340-session-brief-pending-carry-respawn.sql',
);
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-carry-respawn-${RUN}`;
const WORKSPACE = `carry-respawn-${RUN}`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('session-brief-carry-respawn');
  await applyMigrationForTest(db.sql, sessionBriefMigration);
  await applyMigrationForTest(db.sql, resolve(here, '../../../libs/papercusp/libs/db/sql/595-agent-control-anchor.sql'));
  await applyMigrationForTest(db.sql, resolve(here, '../../../libs/papercusp/libs/db/sql/596-agent-control-transitions.sql'));
}, 90_000);

afterAll(async () => db?.cleanup());

describe('pending carry-respawn on real Postgres', () => {
  it.each([null, {}, { modes: ['auto'], lifecycle: { released: { fleet: 'test', at: '2026-10-06T22:00:00Z', by: 'su-leader' } } }])
    ('persists a consumer-readable managed-shutdown cutoff on a brief with control_state %j', async (controlState) => {
      const ownerId = `${OWNER}-shutdown-${Math.random().toString(36).slice(2)}`;
      const shutdown = { at: '2026-10-06T22:07:55.842Z', by: ownerId };
      await db.sql`
        INSERT INTO harness_shared.session_briefs
          (owner_id, workspace_id, control_state, control_generation, control_transition)
        VALUES (${ownerId}, ${WORKSPACE}, ${controlState === null ? null : JSON.stringify(controlState)}::text::jsonb, 7, '{"pending":true}'::jsonb)
      `;
      // postgres-js encodes a string parameter already typed jsonb AGAIN.
      // Assert the seed precondition before judging the production writer;
      // otherwise a JSON scalar looks like a failure to update an object.
      const [seed] = await db.sql`
        SELECT control_state, jsonb_typeof(control_state) AS kind
          FROM harness_shared.session_briefs WHERE owner_id = ${ownerId}
      `;
      expect(seed.control_state).toEqual(controlState);
      expect(seed.kind).toBe(controlState === null ? null : 'object');
      expect(await markSessionBriefShutdown(ownerId, WORKSPACE, shutdown, { sql: db.sql })).toBe(true);
      const [row] = await db.sql`
        SELECT control_state, control_generation, control_transition FROM harness_shared.session_briefs WHERE owner_id = ${ownerId}
      `;
      expect(attestLifecycleConsumerView('shutdown', shutdown, row.control_state).divergedFromWrite).toBe(false);
      expect(row.control_state).toMatchObject({ ...(controlState ?? {}), lifecycle: { ...(controlState?.lifecycle ?? {}), shutdown } });
      expect(Number(row.control_generation)).toBe(8);
      expect(row.control_transition).toBeNull();
      expect(await markSessionBriefShutdown(ownerId, WORKSPACE, shutdown, { sql: db.sql })).toBe(true);
      const [replayed] = await db.sql`SELECT control_generation FROM harness_shared.session_briefs WHERE owner_id = ${ownerId}`;
      expect(Number(replayed.control_generation)).toBe(8);
    });

  it('proves the migration requirement and one-shot consume safety across concurrent bootstrap, restore and clear', async () => {
    const nowMs = Date.now();
    const payload = {
      firstPrompt: 'Continue the verified active task.',
      systemPromptAddendum: 'Persisted carry document for the successor.',
    };

    await expect(savePendingCarryRespawn(
      { ownerId: OWNER, workspaceId: WORKSPACE },
      payload,
      { sql: db.sql, nowMs, nonce: 'before-migration' },
    )).rejects.toThrow(/pending_carry_respawn/);

    await applyMigrationForTest(db.sql, pendingCarryMigration);
    const concurrentOwner = `${OWNER}-concurrent`;
    const concurrentNonce = 'carry-concurrent-1';
    const concurrentSlot = await savePendingCarryRespawn(
      { ownerId: concurrentOwner, workspaceId: WORKSPACE },
      payload,
      { sql: db.sql, nowMs, nonce: concurrentNonce },
    );
    expect(concurrentSlot?.nonce).toBe(concurrentNonce);

    // The fixture pool has independent connections; both bootstrap consumers
    // race for the same row lock and exactly one may receive the one-shot slot.
    const concurrentConsumers = await Promise.all([
      consumePendingCarryRespawn(concurrentOwner, { sql: db.sql, nowMs: nowMs + 1 }),
      consumePendingCarryRespawn(concurrentOwner, { sql: db.sql, nowMs: nowMs + 1 }),
    ]);
    expect(concurrentConsumers.filter((slot) => slot !== null)).toHaveLength(1);
    expect(concurrentConsumers.filter((slot) => slot === null)).toHaveLength(1);
    expect(concurrentConsumers.find((slot) => slot !== null)).toMatchObject({ nonce: concurrentNonce });
    const concurrentlyConsumed = await db.sql`
      SELECT pending_carry_respawn
        FROM harness_shared.session_briefs
       WHERE owner_id = ${concurrentOwner}
    `;
    expect(concurrentlyConsumed[0]?.pending_carry_respawn).toBeNull();

    const original = await savePendingCarryRespawn(
      { ownerId: OWNER, workspaceId: WORKSPACE },
      payload,
      { sql: db.sql, nowMs, nonce: 'carry-nonce-1' },
    );
    expect(original).toMatchObject({
      nonce: 'carry-nonce-1',
      createdAtMs: nowMs,
      expiresAtMs: nowMs + PENDING_CARRY_RESPAWN_TTL_MS,
      ...payload,
    });

    await expect(consumePendingCarryRespawn(OWNER, { sql: db.sql, nowMs: nowMs + 1 }))
      .resolves.toEqual(original);
    await expect(consumePendingCarryRespawn(OWNER, { sql: db.sql, nowMs: nowMs + 2 }))
      .resolves.toBeNull();

    expect(await restorePendingCarryRespawn(
      OWNER,
      WORKSPACE,
      original!,
      { sql: db.sql, nowMs: nowMs + 3 },
    )).toBe(true);

    const newer = await savePendingCarryRespawn(
      { ownerId: OWNER, workspaceId: WORKSPACE },
      { ...payload, firstPrompt: 'Continue the newer active task.' },
      { sql: db.sql, nowMs: nowMs + 4, nonce: 'carry-nonce-2' },
    );
    expect(newer?.nonce).toBe('carry-nonce-2');
    expect(await restorePendingCarryRespawn(
      OWNER,
      WORKSPACE,
      original!,
      { sql: db.sql, nowMs: nowMs + 5 },
    )).toBe(false);
    await expect(clearPendingCarryRespawn(OWNER, 'carry-nonce-1', { sql: db.sql }))
      .resolves.toBe(false);

    const persisted = await db.sql`
      SELECT pending_carry_respawn
        FROM harness_shared.session_briefs
       WHERE owner_id = ${OWNER}
    `;
    expect(persisted[0]?.pending_carry_respawn).toMatchObject({ nonce: 'carry-nonce-2' });
    await expect(clearPendingCarryRespawn(OWNER, 'carry-nonce-2', { sql: db.sql }))
      .resolves.toBe(true);
    const cleared = await db.sql`
      SELECT pending_carry_respawn
        FROM harness_shared.session_briefs
       WHERE owner_id = ${OWNER}
    `;
    expect(cleared[0]?.pending_carry_respawn).toBeNull();
  }, 30_000);
});
