/**
 * presence-current-files.integration.test.ts — the omitted-means-UNTOUCHED contract for
 * coord_presence.current_files, against a REAL Postgres (EI-18776963284535761).
 *
 * THE BUG THIS GUARDS: `PgPresenceStore.write` used to serialize
 * `input.currentFiles ?? []`, so an OMITTED field CLEARED the column. `coord:orient` —
 * the mandated every-wake bootstrap every agent calls — re-declares intent WITHOUT
 * current_files, so every agent silently wiped its own declared file set on every wake.
 * Measured on the live box before the fix: 113 live presence rows, 0 with any file.
 * Three collision-avoidance consumers read that column (locks enrich-busy's
 * `holder_focused`, place_batch's touch-set exclusion, git-sync derived attribution),
 * so all three were reading a permanently-dead signal.
 *
 * WHY REAL PG AND NOT A MOCK: the whole fix is one SQL/driver-level claim — that a JS
 * `undefined` marshalled as a bound NULL through `COALESCE($n::text::jsonb, <existing>)`
 * actually preserves the stored row, and that the NOT NULL column still accepts a fresh
 * insert whose parameter is null. A fake `sql` that records interpolated values proves
 * only that we PASSED null, which is the author's mental model, not the system's
 * behaviour. Mirrors the compaction-presence-store rig (own database, own schema) so it
 * does not depend on the shared baseline container's migration state.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *   lib/presence-current-files.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { PgPresenceStore, ensureCoordPresenceTable } from '@papercusp/coordination/presence';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `curfiles_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });
  await ensureCoordPresenceTable(sql);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.adv_sessions (
      id bigserial PRIMARY KEY,
      coord_owner_id text,
      session_id text,
      agent text,
      started_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const store = () => new PgPresenceStore({ getSql: () => sql, ensureSchema: async () => {} });
const identity = (ownerId: string) => ({
  ownerId,
  ownerLabel: 'test',
  source: 'test',
  workspaceId: 'default',
});
const owner = () => `own_${randomBytes(4).toString('hex')}`;
async function addSession(ownerId: string): Promise<{ nativeSessionId: string; advSessionId: number }> {
  const nativeSessionId = `native_${randomBytes(4).toString('hex')}`;
  const [row] = await sql<{ id: number | string }[]>`
    INSERT INTO harness_shared.adv_sessions (coord_owner_id, session_id, agent)
    VALUES (${ownerId}, ${nativeSessionId}, 'claude')
    RETURNING id
  `;
  return { nativeSessionId, advSessionId: Number(row.id) };
}

/** Read the column back through the store's own getter (not raw SQL). */
async function filesOf(ownerId: string): Promise<string[] | undefined> {
  return (await store().get(ownerId))?.currentFiles;
}

describe('coord_presence.current_files omission semantics (EI-18776963284535761)', () => {
  it('a declared file set round-trips', async () => {
    const o = owner();
    await store().write(identity(o), { intent: 'editing the resolver', currentFiles: ['a.ts', 'b.ts'] });
    expect(await filesOf(o)).toEqual(['a.ts', 'b.ts']);
  });

  // THE REGRESSION GUARD. This is the exact coord:orient shape: a later declare that
  // carries an intent but no current_files. Before the fix it returned [].
  it('a later write that OMITS current_files leaves the declared set untouched', async () => {
    const o = owner();
    await store().write(identity(o), { intent: 'editing the resolver', currentFiles: ['a.ts'] });
    await store().write(identity(o), { intent: 'now reviewing the plan' }); // ← orient's re-declare
    expect(await filesOf(o)).toEqual(['a.ts']);
  });

  it('survives repeated omitting writes (a long-lived agent waking many times)', async () => {
    const o = owner();
    await store().write(identity(o), { intent: 'start', currentFiles: ['a.ts'] });
    for (let i = 0; i < 5; i++) await store().write(identity(o), { intent: `wake ${i}` });
    expect(await filesOf(o)).toEqual(['a.ts']);
  });

  // The other half of the contract — omitted is untouched, but an EXPLICIT [] must still
  // clear, exactly as `items: []` releases a whole lane. Without this, "untouched" would
  // leave agents no way to say "I am off those files".
  it('an EXPLICIT [] clears the declared set', async () => {
    const o = owner();
    await store().write(identity(o), { intent: 'x', currentFiles: ['a.ts'] });
    await store().write(identity(o), { intent: 'x', currentFiles: [] });
    expect(await filesOf(o)).toEqual([]);
  });

  it('an explicit list REPLACES the previous one (not a union)', async () => {
    const o = owner();
    await store().write(identity(o), { intent: 'x', currentFiles: ['a.ts', 'b.ts'] });
    await store().write(identity(o), { intent: 'x', currentFiles: ['c.ts'] });
    expect(await filesOf(o)).toEqual(['c.ts']);
  });

  // Guards the VALUES-clause half of the fix: the column is NOT NULL, so a FIRST write
  // that omits current_files must still insert '[]' rather than failing on a null bind.
  it('a FIRST write that omits current_files inserts an empty set, not NULL', async () => {
    const o = owner();
    await store().write(identity(o), { intent: 'brand new agent' });
    expect(await filesOf(o)).toEqual([]);
    const [row] = await sql<{ current_files: unknown }[]>`
      SELECT current_files FROM harness_shared.coord_presence WHERE owner_id = ${o}`;
    expect(row?.current_files).not.toBeNull();
  });
});

describe('supervisor liveness across declarations (EI-25888806017497809)', () => {
  it('preserves a supervisor heartbeat when the next declaration omits liveness', async () => {
    const o = owner();
    const presence = store();
    await presence.write(identity(o), { intent: 'registered' });
    await presence.touchHeartbeat(o, { host: 'supervisor-box', pid: 4242, tty: '/dev/pts/42' });
    await presence.setContextEstimate(o, 1234, await addSession(o));

    await presence.write(identity(o), { intent: 'implementing the assigned lane' });

    expect(await presence.get(o)).toMatchObject({
      intent: 'implementing the assigned lane',
      host: 'supervisor-box', pid: 4242, tty: '/dev/pts/42', contextTokens: 1234,
    });
  });

  it('keeps first registration unknown and permits an explicit liveness clear', async () => {
    const o = owner();
    const presence = store();
    await presence.write(identity(o), { intent: 'registered' });
    expect(await presence.get(o)).toMatchObject({ host: '', pid: null, tty: null });
    await presence.touchHeartbeat(o, { host: 'supervisor-box', pid: 4242, tty: '/dev/pts/42' });
    await presence.write(identity(o), { host: '', pid: null, tty: null });
    expect(await presence.get(o)).toMatchObject({ host: '', pid: null, tty: null });
  });

  it('accepts a new process binding and invalidates the previous context estimate', async () => {
    const o = owner();
    const presence = store();
    await presence.write(identity(o), { host: 'old-box', pid: 4242, tty: '/dev/pts/42' });
    await presence.setContextEstimate(o, 1234, await addSession(o));
    await presence.write(identity(o), { host: 'new-box', pid: 5555, tty: '/dev/pts/55' });
    expect(await presence.get(o)).toMatchObject({
      host: 'new-box', pid: 5555, tty: '/dev/pts/55',
      contextTokens: null, contextEstimatedAt: null,
    });
  });

  it('does not restore retired liveness when the owner registers again', async () => {
    const o = owner();
    const presence = store();
    await presence.write(identity(o), { host: 'old-box', pid: 4242, tty: '/dev/pts/42' });
    await presence.clear(o);
    await presence.write(identity(o), { intent: 'new native continuation' });
    expect(await presence.get(o)).toMatchObject({ host: '', pid: null, tty: null });
    await presence.touchHeartbeat(o, { host: 'new-box', pid: 5555 });
    expect(await presence.get(o)).toMatchObject({ host: 'new-box', pid: 5555, tty: null });
  });
});
