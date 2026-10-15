/**
 * spawn-admission.integration.test.ts — atomic spawn admission against real PG
 * (audit P-017 + P-039, EI-73).
 *
 * Proves the two race fixes with REAL concurrency:
 *   • N concurrent admissions against a cap of 1 admit exactly ONE spawn
 *     (the advisory-lock-serialized reclaim+count+record closes the
 *     read-committed gap the old sequence had);
 *   • two concurrent admissions sharing an idempotencyKey produce ONE row —
 *     the loser gets `duplicate` with the winner's spawnId (a route-timeout
 *     retry no longer double-spawns).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { admitSpawn } from './operator-spawn';

// Replay the canonical schema so pre-admission reclaim and its claim surfaces
// cannot drift from a parallel handwritten table definition.
const WS = 'default';
let db: OrgTestDb;

function recordRow(spawnId: string, role = 'worker') {
  return async (tx: Parameters<Parameters<typeof admitSpawn>[1]['record']>[0]) => {
    await tx`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, parent_role, child_role, run_id, status)
      VALUES (${spawnId}, ${WS}, 'papercup', 'operator', ${role}, ${'r-' + spawnId}, 'running')`;
  };
}

async function rowCount(): Promise<number> {
  const rows = await db.adminSql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents WHERE workspace_id = ${WS}`;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createOrgTestDb();
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.adminSql`TRUNCATE harness_shared.spawned_agents`; });

describe('admitSpawn (P-017 + P-039, real PG)', () => {
  it('admits below the cap and records the row', async () => {
    const { admission } = await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-a', idempotencyKey: null, cap: 2, record: recordRow('s-a'),
    });
    expect(admission).toEqual({ kind: 'admitted' });
    expect(await rowCount()).toBe(1);
  });

  it('rejects over the cap without recording', async () => {
    await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-a', idempotencyKey: null, cap: 1, record: recordRow('s-a'),
    });
    const { admission } = await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-b', idempotencyKey: null, cap: 1, record: recordRow('s-b'),
    });
    expect(admission).toEqual({ kind: 'over_cap', running: 1, cap: 1 });
    expect(await rowCount()).toBe(1);
  });

  it('CONCURRENT: 8 simultaneous admissions at cap=1 admit exactly one (P-039)', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        admitSpawn(db.adminSql, {
          workspaceId: WS,
          spawnId: `s-race-${i}`,
          idempotencyKey: null,
          cap: 1,
          record: recordRow(`s-race-${i}`),
        }),
      ),
    );
    const admitted = results.filter((r) => r.admission.kind === 'admitted');
    const overCap = results.filter((r) => r.admission.kind === 'over_cap');
    expect(admitted).toHaveLength(1);
    expect(overCap).toHaveLength(7);
    expect(await rowCount()).toBe(1); // no ceiling overshoot, ever
  });

  it('roleCap counts only that role while the global cap still counts every running spawn', async () => {
    await admitSpawn(db.adminSql, {
      workspaceId: WS,
      spawnId: 's-doc',
      idempotencyKey: null,
      cap: 3,
      roleCap: { role: 'cup', cap: 1 },
      record: recordRow('s-doc', 'doc-steward'),
    });

    const bee = await admitSpawn(db.adminSql, {
      workspaceId: WS,
      spawnId: 's-bee',
      idempotencyKey: null,
      cap: 3,
      roleCap: { role: 'cup', cap: 1 },
      record: recordRow('s-bee', 'cup'),
    });
    expect(bee.admission).toEqual({ kind: 'admitted' });

    const secondBee = await admitSpawn(db.adminSql, {
      workspaceId: WS,
      spawnId: 's-bee-2',
      idempotencyKey: null,
      cap: 3,
      roleCap: { role: 'cup', cap: 1 },
      record: recordRow('s-bee-2', 'cup'),
    });
    expect(secondBee.admission).toEqual({ kind: 'over_cap', running: 1, cap: 1, role: 'cup' });

    const docAgainstGlobal = await admitSpawn(db.adminSql, {
      workspaceId: WS,
      spawnId: 's-doc-2',
      idempotencyKey: null,
      cap: 2,
      roleCap: { role: 'cup', cap: 10 },
      record: recordRow('s-doc-2', 'doc-steward'),
    });
    expect(docAgainstGlobal.admission).toEqual({ kind: 'over_cap', running: 2, cap: 2 });
    expect(await rowCount()).toBe(2);
  });

  it('CONCURRENT: two admissions sharing an idempotencyKey yield one row + a duplicate pointing at it (P-017/EI-73)', async () => {
    const [a, b] = await Promise.all([
      admitSpawn(db.adminSql, {
        workspaceId: WS, spawnId: 's-idem-a', idempotencyKey: 'retry-1', cap: 10, record: recordRow('s-idem-a'),
      }),
      admitSpawn(db.adminSql, {
        workspaceId: WS, spawnId: 's-idem-b', idempotencyKey: 'retry-1', cap: 10, record: recordRow('s-idem-b'),
      }),
    ]);
    const kinds = [a.admission.kind, b.admission.kind].sort();
    expect(kinds).toEqual(['admitted', 'duplicate']);
    const dup = (a.admission.kind === 'duplicate' ? a : b).admission as { kind: 'duplicate'; spawnId: string };
    const winner = a.admission.kind === 'admitted' ? 's-idem-a' : 's-idem-b';
    expect(dup.spawnId).toBe(winner);
    expect(await rowCount()).toBe(1);
  });

  it('a SEQUENTIAL retry with the same key dedupes against the committed row', async () => {
    await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-first', idempotencyKey: 'k1', cap: 10, record: recordRow('s-first'),
    });
    const { admission } = await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-second', idempotencyKey: 'k1', cap: 10, record: recordRow('s-second'),
    });
    expect(admission).toEqual({ kind: 'duplicate', spawnId: 's-first' });
    expect(await rowCount()).toBe(1);
  });

  it('different keys spawn independently', async () => {
    await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-k1', idempotencyKey: 'k1', cap: 10, record: recordRow('s-k1'),
    });
    const { admission } = await admitSpawn(db.adminSql, {
      workspaceId: WS, spawnId: 's-k2', idempotencyKey: 'k2', cap: 10, record: recordRow('s-k2'),
    });
    expect(admission).toEqual({ kind: 'admitted' });
    expect(await rowCount()).toBe(2);
  });
});
