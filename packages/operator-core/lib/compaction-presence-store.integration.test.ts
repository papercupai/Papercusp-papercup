/**
 * compaction-presence-store.integration.test.ts — the agent-managed-compaction
 * data-layer round-trips against a REAL Postgres (agent-managed-compaction-2026-07-01
 * P-006 / P-009). PgPresenceStore.setCompactionLimit / setContextEstimate persist to
 * coord_presence and read back via get(); a later write preserves the limit; setters
 * no-op on an unknown owner. Mirrors the coord-capability-pg-stores rig.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *   lib/compaction-presence-store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { PgPresenceStore, ensureCoordPresenceTable } from '@papercusp/coordination/presence';

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `compaction_${randomBytes(5).toString('hex')}`;
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
async function addSession(
  ownerId: string,
  nativeSessionId: string,
  startedAt = new Date(),
): Promise<{ nativeSessionId: string; advSessionId: number }> {
  const [row] = await sql<{ id: number | string }[]> `
    INSERT INTO harness_shared.adv_sessions (coord_owner_id, session_id, agent, started_at)
    VALUES (${ownerId}, ${nativeSessionId}, 'claude', ${startedAt})
    RETURNING id
  `;
  return { nativeSessionId, advSessionId: Number(row.id) };
}

describe('PgPresenceStore compaction columns (agent-managed-compaction)', () => {
  it('bootstrap seeds an unset limit atomically and preserves a later owner choice', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    await s.setCompactionLimit(o, 20_000, { explicit: true, onlyIfUnset: true });
    expect(await s.get(o)).toMatchObject({ compactionLimit: 20_000, compactionLimitExplicit: true });
    await s.setCompactionLimit(o, 30_000, { explicit: true });
    await s.setCompactionLimit(o, 20_000, { explicit: true, onlyIfUnset: true });
    expect(await s.get(o)).toMatchObject({ compactionLimit: 30_000, compactionLimitExplicit: true });
    await s.setCompactionLimit(o, 40_000, { explicit: false });
    await s.setCompactionLimit(o, 20_000, { explicit: true, onlyIfUnset: true });
    expect(await s.get(o)).toMatchObject({ compactionLimit: 40_000, compactionLimitExplicit: false });
  });

  it('setCompactionLimit persists and a later write preserves it', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { intent: 'work' });
    await s.setCompactionLimit(o, 160_000, { explicit: true });
    expect((await s.get(o))?.compactionLimit).toBe(160_000);
    expect((await s.get(o))?.compactionLimitExplicit).toBe(true);
    // ON CONFLICT DO UPDATE must NOT wipe the limit on a later declare/heartbeat.
    await s.write(identity(o), { intent: 'more' });
    expect((await s.get(o))?.compactionLimit).toBe(160_000);
    expect((await s.get(o))?.compactionLimitExplicit).toBe(true);
  });

  it('preserves provenance for derived writes and can mark a watchdog seed non-explicit', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    await s.setCompactionLimit(o, 500_000, { explicit: false });
    expect((await s.get(o))?.compactionLimitExplicit).toBe(false);
    // A derived repair omits provenance and must not accidentally turn a seed
    // into an explicit override.
    await s.setCompactionLimit(o, 400_000);
    expect((await s.get(o))?.compactionLimitExplicit).toBe(false);
    await s.setCompactionLimit(o, 680_000, { explicit: true });
    await s.setCompactionLimit(o, 670_000);
    expect((await s.get(o))?.compactionLimitExplicit).toBe(true);
  });

  it('a derived write must not clobber an explicitly-set limit (EI-23739064535335014)', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    // The agent explicitly raises its own limit via config:set-compaction-limit.
    await s.setCompactionLimit(o, 600_000, { explicit: true });
    expect((await s.get(o))?.compactionLimit).toBe(600_000);
    // A default-derived repair (watchdog recompute / model-default seed) omits
    // provenance. Before the fix it reverted the VALUE while preserving the flag, so
    // the row claimed the agent chose 250_000 and the session was force-compacted
    // against a limit it had explicitly raised — losing its context for zero work.
    await s.setCompactionLimit(o, 250_000);
    expect((await s.get(o))?.compactionLimit).toBe(600_000);
    expect((await s.get(o))?.compactionLimitExplicit).toBe(true);
    // The guard must protect the value, NOT freeze it: an authoritative write wins.
    await s.setCompactionLimit(o, 300_000, { explicit: true });
    expect((await s.get(o))?.compactionLimit).toBe(300_000);
  });

  it('a derived write still applies when nothing explicit is on record', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    // NULL provenance — `IS NOT TRUE`, not `= false`, is what keeps this working.
    await s.setCompactionLimit(o, 400_000);
    expect((await s.get(o))?.compactionLimit).toBe(400_000);
    // An explicitly NON-explicit seed stays derived and remains overwritable.
    await s.setCompactionLimit(o, 450_000, { explicit: false });
    await s.setCompactionLimit(o, 480_000);
    expect((await s.get(o))?.compactionLimit).toBe(480_000);
    expect((await s.get(o))?.compactionLimitExplicit).toBe(false);
  });

  it('setContextEstimate persists tokens + a timestamp', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    const current = await addSession(o, 'native-current');
    await expect(s.setContextEstimate(o, 144_000, current)).resolves.toBe(true);
    const rec = await s.get(o);
    expect(rec?.contextTokens).toBe(144_000);
    expect(rec?.contextEstimatedAt).toBeTruthy();
  });

  it('rejects a predecessor write after the selected row changes native session id', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    const predecessor = await addSession(o, 'native-predecessor');
    await expect(s.setContextEstimate(o, 380_000, predecessor)).resolves.toBe(true);

    await sql `
      UPDATE harness_shared.adv_sessions
         SET session_id = 'native-successor', started_at = now() + interval '1 second'
       WHERE id = ${predecessor.advSessionId}
    `;
    await s.clearContextEstimate(o);

    await expect(s.setContextEstimate(o, 380_000, predecessor)).resolves.toBe(false);
    expect((await s.get(o))?.contextTokens).toBeNull();
    await expect(s.setContextEstimate(o, 12_000, {
      nativeSessionId: 'native-successor',
      advSessionId: predecessor.advSessionId,
    })).resolves.toBe(true);
    expect((await s.get(o))?.contextTokens).toBe(12_000);
  });

  it('fences against the latest adv session using resolver ordering', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    const older = await addSession(o, 'native-older', new Date(Date.now() - 60_000));
    const newer = await addSession(o, 'native-newer', new Date(Date.now() + 60_000));

    await expect(s.setContextEstimate(o, 300_000, older)).resolves.toBe(false);
    await expect(s.setContextEstimate(o, 20_000, newer)).resolves.toBe(true);
    expect((await s.get(o))?.contextTokens).toBe(20_000);
  });

  it('clearContextEstimate invalidates the observation but preserves the configured limit', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    await s.setCompactionLimit(o, 400_000, { explicit: true });
    const current = await addSession(o, 'native-current');
    await s.setContextEstimate(o, 380_000, current);

    await s.clearContextEstimate(o);

    const rec = await s.get(o);
    expect(rec?.contextTokens ?? null).toBeNull();
    expect(rec?.contextEstimatedAt ?? null).toBeNull();
    expect(rec?.compactionLimit).toBe(400_000);
    expect(rec?.compactionLimitExplicit).toBe(true);
  });

  it('setters no-op for an unknown owner (no row created)', async () => {
    const s = store();
    const o = `ghost_${randomBytes(4).toString('hex')}`;
    await s.setCompactionLimit(o, 100_000);
    await expect(s.setContextEstimate(o, 50_000, { nativeSessionId: 'missing' })).resolves.toBe(false);
    expect(await s.get(o)).toBeNull();
  });

  it('fresh presence has null compaction columns by default', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), {});
    const rec = await s.get(o);
    expect(rec?.compactionLimit ?? null).toBeNull();
    expect(rec?.compactionLimitExplicit).toBe(false);
    expect(rec?.contextTokens ?? null).toBeNull();
  });
});

/**
 * EI-19418749207847685 — a carry-respawn reuses the ownerId but starts a NEW
 * process, so the cached context estimate describes a session that no longer
 * exists. The age-based staleness guard in deriveContextPressure CANNOT catch
 * this: the estimate is genuinely recent, just not about this process, so the
 * bucket is asserted with full confidence. Observed live — a session respawned
 * at 4% context read `critical` for ~12 minutes, which is precisely the cue the
 * playbook says to self-compact on, so the stale value drives a fresh context to
 * discard itself and respawn into the same reading.
 *
 * The guard is the pid transition. These tests pin BOTH directions, because a
 * fix that over-clears is its own bug: the estimate must survive every
 * same-process re-declare (coord:orient re-declares intent on EVERY wake), or
 * the watchdog's reading is wiped faster than it is written and the bucket
 * degrades to a permanent `null`.
 */
describe('context estimate is invalidated on a pid change (carry-respawn)', () => {
  it('write() with a NEW pid clears the dead session estimate but keeps the limit', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { pid: 1001 });
    const current = await addSession(o, 'native-current');
    await s.setCompactionLimit(o, 400_000);
    await s.setContextEstimate(o, 380_000, current); // predecessor died at ~95%
    expect((await s.get(o))?.contextTokens).toBe(380_000);

    // The carry-respawn: same ownerId, new process.
    await s.write(identity(o), { pid: 2002 });

    const rec = await s.get(o);
    expect(rec?.pid).toBe(2002);
    expect(rec?.contextTokens ?? null).toBeNull();
    expect(rec?.contextEstimatedAt ?? null).toBeNull();
    // The LIMIT is configuration, not an observation of the dead process — it
    // must survive, or every respawned session loses its compaction target.
    expect(rec?.compactionLimit).toBe(400_000);
  });

  it('write() with the SAME pid preserves the estimate', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { pid: 1001 });
    const current = await addSession(o, 'native-current');
    await s.setContextEstimate(o, 144_000, current);
    // coord:orient re-declares intent on every wake — same process, so this must
    // not wipe the reading the watchdog just took.
    await s.write(identity(o), { intent: 'next wake', pid: 1001 });
    expect((await s.get(o))?.contextTokens).toBe(144_000);
  });

  it('write() with NO pid reported preserves the estimate', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { pid: 1001 });
    const current = await addSession(o, 'native-current');
    await s.setContextEstimate(o, 144_000, current);
    // A caller that does not know its own pid must never invalidate a valid
    // estimate — same preserve-on-omission rule touchHeartbeat uses for pid/host.
    await s.write(identity(o), { intent: 'no pid this time' });
    expect((await s.get(o))?.contextTokens).toBe(144_000);
  });

  it('touchHeartbeat with a NEW pid clears the dead session estimate', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { pid: 1001 });
    const current = await addSession(o, 'native-current');
    await s.setContextEstimate(o, 380_000, current);
    await s.touchHeartbeat(o, { pid: 2002, host: 'box' });
    const rec = await s.get(o);
    expect(rec?.pid).toBe(2002);
    expect(rec?.contextTokens ?? null).toBeNull();
    expect(rec?.contextEstimatedAt ?? null).toBeNull();
  });

  it('touchHeartbeat with the SAME pid preserves the estimate', async () => {
    const s = store();
    const o = owner();
    await s.write(identity(o), { pid: 1001 });
    const current = await addSession(o, 'native-current');
    await s.setContextEstimate(o, 144_000, current);
    // The 60s supervisor keepalive beats constantly with an unchanged pid.
    await s.touchHeartbeat(o, { pid: 1001 });
    expect((await s.get(o))?.contextTokens).toBe(144_000);
    await s.touchHeartbeat(o, { pid: 1001, host: 'box' });
    expect((await s.get(o))?.contextTokens).toBe(144_000);
  });
});
