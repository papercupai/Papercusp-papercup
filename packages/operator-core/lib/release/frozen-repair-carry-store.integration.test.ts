/**
 * P-010 (green-main-cycle-time-2026-10-08, D-026/D-027): real-Postgres regression for the frozen
 * repair CARRY's write contract on `harness_shared.routines.metadata`.
 *
 * The carry check is pure and unit-tested in `frozen-repair-carry.test.ts`. What only a real
 * database can pin:
 *   - the owner's explicit `release:repair-queue` retire writes
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
import {
  FROZEN_REPAIR_CARRY_LAST_METADATA_KEY,
  FROZEN_REPAIR_CARRY_METADATA_KEY,
  buildFrozenRepairCarryRecord,
  type FrozenRepairCutCarryAssessment,
  type FrozenRepairPendingCarry,
} from './frozen-repair-carry';
import { consumeFrozenRepairCarry, readFrozenRepairPendingCarry } from './frozen-repair-carry-store';
import { retireFrozenCandidateRepairQueue } from '../harness/routines/release-actions';
import { beginQualificationTransaction, commitPreparedCheckpointSelection, readPreparedCheckpointSelection,
  type PreparedCheckpointSelectionRecord } from './checkpoint-qualification-transaction';

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

/** A non-improving queue whose age and trajectory must never retire it automatically. */
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

describe('prepared checkpoint selection and carry share durable authority', () => {
  async function fixture() {
    const pending: FrozenRepairPendingCarry = { schemaVersion: 1, fromCandidate: C, fromRepairHead: H,
      retiredAtMs: NOW, reason: 'owner-retire', admitted: [{ path: 'a.ts', blob: 'a'.repeat(40) }], truncated: false };
    const selection: PreparedCheckpointSelectionRecord = {
      schemaVersion: 1, attemptId: 'prepared-attempt', integrationRoot: '/integration', checkpointRoot: '/checkpoint',
      candidate: TIP, tip: TIP, base: C, candidateSource: 'tip', quietCutApplied: false, freezeCut: null,
      generation: { candidate: TIP, identity: 'generation-1', token: 'v3:token', inputFingerprint: '1'.repeat(64),
        root: '/generations', reused: true },
      carry: buildFrozenRepairCarryRecord({ pending, initial: assessment(pending, TIP), judged: assessment(pending, TIP), nowMs: NOW + 1 }),
      queue: null,
    };
    await seed({ qualificationTransaction: beginQualificationTransaction(null, {
      attemptId: selection.attemptId, candidate: TIP, nowMs: NOW,
    }).transaction, [FROZEN_REPAIR_CARRY_METADATA_KEY]: pending, unrelated: { retained: true } });
    return { pending, selection, requested: { attemptId: selection.attemptId,
      integrationRoot: selection.integrationRoot, checkpointRoot: selection.checkpointRoot } };
  }

  it('persists selection and consumed carry together and recovers from a new read', async () => {
    const f = await fixture();
    expect(await readPreparedCheckpointSelection(target, f.requested)).toBeNull();
    expect(await commitPreparedCheckpointSelection(target, f.selection, { queue: null, pendingCarry: f.pending })).toBe(true);
    expect(await readPreparedCheckpointSelection(target, f.requested)).toEqual(f.selection);
    const after = await metadata();
    expect(after[FROZEN_REPAIR_CARRY_METADATA_KEY]).toBeUndefined();
    expect(after[FROZEN_REPAIR_CARRY_LAST_METADATA_KEY]).toEqual(f.selection.carry);
    expect(after.unrelated).toEqual({ retained: true });
    expect(await commitPreparedCheckpointSelection(target, f.selection, { queue: null, pendingCarry: f.pending })).toBe(false);
    expect(await metadata()).toEqual(after);
  });

  it.each(['queue', 'carry', 'attempt'] as const)('refuses stale %s authority without a partial write', async kind => {
    const f = await fixture();
    const before = await metadata();
    if (kind === 'queue') before.repair_queue = queue();
    if (kind === 'carry') before[FROZEN_REPAIR_CARRY_METADATA_KEY] = { ...f.pending, retiredAtMs: NOW + 2 };
    if (kind === 'attempt') (before.qualificationTransaction as { attemptId: string }).attemptId = 'successor';
    await sql`UPDATE harness_shared.routines SET metadata = ${JSON.stringify(before)}::jsonb
      WHERE workspace_id = ${target.workspaceId}`;
    expect(await commitPreparedCheckpointSelection(target, f.selection, { queue: null, pendingCarry: f.pending })).toBe(false);
    expect(await metadata()).toEqual(before);
  });

  it('serializes concurrent commits so only one consumes, then refuses mismatched recovery roots', async () => {
    const f = await fixture();
    const results = await Promise.all([1, 2].map(() => commitPreparedCheckpointSelection(target,
      f.selection, { queue: null, pendingCarry: f.pending })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await readPreparedCheckpointSelection(target, f.requested)).toEqual(f.selection);
    await expect(readPreparedCheckpointSelection(target, { ...f.requested, checkpointRoot: '/different' }))
      .rejects.toThrow(/mismatch/);
    await expect(readPreparedCheckpointSelection(target, { ...f.requested, attemptId: 'different' }))
      .rejects.toThrow(/mismatch/);
  });

  it('a malformed stored selection remains unreadable instead of becoming an absent proposal', async () => {
    const f = await fixture();
    await commitPreparedCheckpointSelection(target, f.selection, { queue: null, pendingCarry: f.pending });
    await sql`UPDATE harness_shared.routines SET metadata = jsonb_set(metadata,
      '{qualificationTransaction,preparedSelection,schemaVersion}', '2'::jsonb)
      WHERE workspace_id = ${target.workspaceId}`;
    await expect(readPreparedCheckpointSelection(target, f.requested)).rejects.toThrow(/authority unavailable/);
    expect((await metadata())[FROZEN_REPAIR_CARRY_LAST_METADATA_KEY]).toEqual(f.selection.carry);
  });
});

describe('P-010 frozen repair carry store (real Postgres)', () => {
  it('the fixture queue (with admissions) survives the JSON round trip the stores read it through', () => {
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue())))?.admissions).toHaveLength(1);
  });

  it('the owner retire writes the pending carry too, unioned with an unconsumed one', async () => {
    const first = queue();
    await seed({ repair_queue: first });
    await expect(retireFrozenCandidateRepairQueue(target, first)).resolves.toMatchObject({ retired: true });

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
    await expect(retireFrozenCandidateRepairQueue(target, q)).resolves.toMatchObject({ retired: true });
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
