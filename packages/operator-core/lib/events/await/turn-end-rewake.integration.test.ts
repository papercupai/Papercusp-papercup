/**
 * turn-end-rewake against a real event_awaits table (WI-6554700010018567): one pending timer per
 * agent, the no-progress budget counted from fired rows, and cancellation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { armTurnEndRewake, cancelTurnEndRewake, turnEndRewakeKey } = await import('./turn-end-rewake');

const OWNER = 'su-rewake-it-owner';
const KEY = turnEndRewakeKey(OWNER);
const held = [{ id: 'WI-REWAKE-1', harness: 'papercusp', status: 'wip', eventBlockers: [] }];

describe('turn-end rewake on real PG (WI-6554700010018567)', () => {
  let db: OrgTestDb | null = null;
  const sql = () => db!.adminSql;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await sql()`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${OWNER}`;
  });

  const rows = () =>
    sql()<Array<{ id: number; expires_ts: Date | null; timeout_behavior: string; once: boolean; note: string | null }>>`
      SELECT id, expires_ts, timeout_behavior, once, note FROM harness_shared.event_awaits
       WHERE subscriber_id = ${OWNER} AND event_key = ${KEY}
         AND fired_at IS NULL AND cancelled_at IS NULL AND superseded_at IS NULL`;

  const fireAll = () =>
    sql()`UPDATE harness_shared.event_awaits SET fired_at = now(), fired_reason = 'timeout'
           WHERE subscriber_id = ${OWNER} AND event_key = ${KEY} AND fired_at IS NULL AND cancelled_at IS NULL`;

  it('arms one bounded wake-on-timeout await, and a second refused stop replaces it', async () => {
    const first = await armTurnEndRewake({ ownerId: OWNER, held, deps: { random: () => 0 } });
    expect(first).toMatchObject({ kind: 'armed', attempt: 1, timeoutSec: 720 });
    const [row] = await rows();
    expect(row).toMatchObject({ timeout_behavior: 'wake', once: true });
    expect(row.note).toContain('turn-end rewake 1 of 2');
    const deadlineSec = (new Date(row.expires_ts!).getTime() - Date.now()) / 1000;
    expect(deadlineSec).toBeGreaterThan(600);
    expect(deadlineSec).toBeLessThan(800);

    await armTurnEndRewake({ ownerId: OWNER, held, deps: { random: () => 1 } });
    const pending = await rows();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(row.id);
  });

  it('counts fired timers without progress and stops arming after two', async () => {
    await armTurnEndRewake({ ownerId: OWNER, held });
    await fireAll();
    expect(await armTurnEndRewake({ ownerId: OWNER, held })).toMatchObject({ kind: 'armed', attempt: 2 });
    await fireAll();
    expect(await armTurnEndRewake({ ownerId: OWNER, held })).toEqual({ kind: 'exhausted', firedWithoutProgress: 2 });
    expect(await rows()).toHaveLength(0);
  });

  it('cancel leaves no pending timer', async () => {
    await armTurnEndRewake({ ownerId: OWNER, held });
    expect(await rows()).toHaveLength(1);
    await cancelTurnEndRewake({ ownerId: OWNER });
    expect(await rows()).toHaveLength(0);
  });
});
