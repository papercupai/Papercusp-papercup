/**
 * P-010 (green-main-cycle-time-2026-10-08, D-026/D-027): real-Postgres regression for the frozen
 * repair CARRY's write contract on `harness_shared.routines.metadata`.
 *
 * The carry check is pure and unit-tested in `frozen-repair-carry.test.ts`. What only a real
 * database can pin:
 *   - BOTH retire paths (P-021's bounded life and the owner's `release:repair-queue` retire) write
 *     the pending carry in the SAME row update that deletes the queue, so a restart between the
 *     retire and the next cut cannot lose the fixes;
 *   - a retire that finds an unconsumed carry unions with it instead of overwriting it;
 *   - the gate's consume is a compare-and-swap: it replaces exactly the carry it assessed with the
 *     record, and a carry replaced in between is left for the next cut.
 *
 * Run: npm run test:file -- packages/operator-core/lib/release/frozen-repair-carry-store.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
// The edit-time marker is a filesystem projection; keep this DB test's fixture isolated.
vi.mock('./frozen-repair-edit-marker', () => ({ projectFrozenRepairMarker: () => {} }));

import {
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from './frozen-candidate-repair-queue';
import { buildFrozenRepairBoundedLifeRecord, decideFrozenRepairBoundedLife } from './frozen-repair-bounded-life';
import { retireFrozenRepairQueueForBoundedLife } from './frozen-repair-bounded-life-store';
import {
  FROZEN_REPAIR_CARRY_LAST_METADATA_KEY,
  FROZEN_REPAIR_CARRY_METADATA_KEY,
  buildFrozenRepairCarryRecord,
  type FrozenRepairCutCarryAssessment,
  type FrozenRepairPendingCarry,
} from './frozen-repair-carry';
import { consumeFrozenRepairCarry, readFrozenRepairPendingCarry } from './frozen-repair-carry-store';
import { retireFrozenCandidateRepairQueue } from '../harness/routines/release-actions';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-frozen-repair-carry', installSlug: 'papercusp' };

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const C = 'c'.repeat(40);
const H = 'd'.repeat(40);
const C2 = 'e'.repeat(40);
const H2 = '9'.repeat(40);
const TIP = 'b'.repeat(40);

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
});

function admission(paths: string[], blobs: Record<string, string | null>, from: string, to: string): FrozenRepairAdmission {
  return {
    atMs: NOW - HOUR,
    actor: 'su-test',
    source: { ref: 'staging', sha: 'f'.repeat(40) },
    fromRepairHead: from,
    toRepairHead: to,
    paths,
    unchanged: [],
    blobs,
  };
}

/** A non-improving queue (4 rounds since the low of 3), so the bounded-life rule retires it. */
function queue(extra: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4,
    phase: 'awaiting-fixer',
    candidate: C,
    base: null,
    repairHead: H,
    attempts: 1,
    openedAtMs: NOW - HOUR,
    updatedAtMs: NOW - 1,
    fixerSpawnId: null,
    failingTests: [],
    signature: [],
    convergenceRounds: [3, 5, 8, 12, 28].map((failingCount, index) => ({
      round: index + 1,
      head: H,
      failingCount,
      atMs: NOW,
    })),
    admissions: [admission(['a.ts', 'b.ts'], { 'a.ts': 'blob-a', 'b.ts': 'blob-b' }, C, H)],
    ...extra,
  };
}

function boundedLifeRecord(q: FrozenCandidateRepairQueue) {
  const decision = decideFrozenRepairBoundedLife(q, { nowMs: NOW, state: null });
  if (decision.kind !== 'retire') throw new Error(`fixture must retire, got ${decision.kind}`);
  return buildFrozenRepairBoundedLifeRecord({
    queue: q,
    decision,
    nowMs: NOW,
    target: { sha: TIP, source: 'staging-tip' },
    carry: { carriedPaths: [], readmitPaths: [], truncated: false },
  });
}

async function seed(metadata: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-frozen-repair-carry', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

async function metadata(): Promise<Record<string, unknown>> {
  const rows = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  const raw = rows[0]?.metadata as unknown;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

function assessment(pending: FrozenRepairPendingCarry, candidate: string): FrozenRepairCutCarryAssessment {
  return {
    fromCandidate: pending.fromCandidate,
    reason: pending.reason,
    candidate,
    stagingTip: TIP,
    entries: pending.admitted.map((entry) => ({ path: entry.path, status: 'carried-via-staging' as const })),
    missing: [],
    unverified: [],
    advanceToTip: false,
  };
}

describe('P-010 frozen repair carry store (real Postgres)', () => {
  it('the fixture queue (with admissions) survives the JSON round trip the stores read it through', () => {
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue())))?.admissions).toHaveLength(1);
  });

  it('a bounded-life retire writes the pending carry in the SAME write that deletes the queue', async () => {
    const q = queue();
    await seed({ repair_queue: q, unrelated_key: { keep: 'me' } });
    await expect(retireFrozenRepairQueueForBoundedLife(target, q, boundedLifeRecord(q))).resolves.toEqual({
      retired: true,
    });
    const after = await metadata();
    expect(after.repair_queue).toBeUndefined();
    expect(after.unrelated_key).toEqual({ keep: 'me' });
    await expect(readFrozenRepairPendingCarry(target)).resolves.toEqual({
      schemaVersion: 1,
      fromCandidate: C,
      fromRepairHead: H,
      reason: 'bounded-life',
      retiredAtMs: NOW,
      admitted: [
        { path: 'a.ts', blob: 'blob-a' },
        { path: 'b.ts', blob: 'blob-b' },
      ],
      truncated: false,
    });
  });

  it('a refused bounded-life retire writes no carry', async () => {
    const decidedOn = queue();
    await seed({ repair_queue: { ...decidedOn, repairHead: H2, updatedAtMs: NOW } });
    await expect(
      retireFrozenRepairQueueForBoundedLife(target, decidedOn, boundedLifeRecord(decidedOn)),
    ).resolves.toEqual({ retired: false, refusal: 'identity-mismatch' });
    expect((await metadata())[FROZEN_REPAIR_CARRY_METADATA_KEY]).toBeUndefined();
  });

  it('a retired queue that admitted nothing writes no carry key at all', async () => {
    const q = queue({ admissions: [] });
    await seed({ repair_queue: q });
    await expect(retireFrozenRepairQueueForBoundedLife(target, q, boundedLifeRecord(q))).resolves.toEqual({
      retired: true,
    });
    expect(Object.keys(await metadata())).not.toContain(FROZEN_REPAIR_CARRY_METADATA_KEY);
    await expect(readFrozenRepairPendingCarry(target)).resolves.toBeNull();
  });

  it('the owner retire writes the pending carry too, unioned with an unconsumed one', async () => {
    const first = queue();
    await seed({ repair_queue: first });
    await retireFrozenRepairQueueForBoundedLife(target, first, boundedLifeRecord(first));

    // A queue opened on an explicit candidate before any fresh cut consumed the first carry.
    const second = queue({
      candidate: C2,
      repairHead: H2,
      admissions: [admission(['b.ts', 'c.ts'], { 'b.ts': 'blob-b2', 'c.ts': null }, C2, H2)],
    });
    await sql`
      UPDATE harness_shared.routines
         SET metadata = metadata || jsonb_build_object('repair_queue', ${JSON.stringify(second)}::text::jsonb)
       WHERE workspace_id = ${target.workspaceId}`;
    const outcome = await retireFrozenCandidateRepairQueue(target, second);
    expect(outcome).toMatchObject({ retired: true });

    const pending = await readFrozenRepairPendingCarry(target);
    expect(pending).toMatchObject({ fromCandidate: C2, fromRepairHead: H2, reason: 'owner-retire' });
    expect(pending?.admitted).toEqual([
      { path: 'a.ts', blob: 'blob-a' },
      { path: 'b.ts', blob: 'blob-b2' },
      { path: 'c.ts', blob: null },
    ]);
  });

  it('consume swaps exactly the assessed carry for its record; a replaced carry is left for the next cut', async () => {
    const q = queue();
    await seed({ repair_queue: q });
    await retireFrozenRepairQueueForBoundedLife(target, q, boundedLifeRecord(q));
    const pending = await readFrozenRepairPendingCarry(target);
    if (!pending) throw new Error('fixture must leave a pending carry');
    const record = buildFrozenRepairCarryRecord({
      pending,
      initial: assessment(pending, TIP),
      judged: assessment(pending, TIP),
      nowMs: NOW + 1,
    });

    // A stale view of the carry (a newer retire replaced it) consumes nothing.
    const stale = { ...pending, retiredAtMs: pending.retiredAtMs - 1 };
    await expect(consumeFrozenRepairCarry(target, stale, record)).resolves.toBe(false);
    expect((await metadata())[FROZEN_REPAIR_CARRY_METADATA_KEY]).toBeDefined();

    await expect(consumeFrozenRepairCarry(target, pending, record)).resolves.toBe(true);
    const after = await metadata();
    expect(after[FROZEN_REPAIR_CARRY_METADATA_KEY]).toBeUndefined();
    expect(after[FROZEN_REPAIR_CARRY_LAST_METADATA_KEY]).toMatchObject({
      fromCandidate: C,
      judgedCandidate: TIP,
      advancedToTip: false,
    });
    // Consuming twice is a no-op, not a second record.
    await expect(consumeFrozenRepairCarry(target, pending, record)).resolves.toBe(false);
  });
});
