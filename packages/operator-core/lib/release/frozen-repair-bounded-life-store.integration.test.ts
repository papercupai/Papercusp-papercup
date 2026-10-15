/**
 * P-021 (green-main-cycle-time-2026-10-08, D-023/D-025): real-Postgres regression for the frozen
 * repair queue's bounded-life STORE.
 *
 * The decision is pure and unit-tested in `frozen-repair-bounded-life.test.ts`. What only a real
 * database can pin is the store's write contract on `harness_shared.routines.metadata`:
 *   - the retire and its record land in ONE row update (the queue is never cleared without the
 *     record, and the record survives the queue's removal because it lives BESIDE it);
 *   - every guard is re-checked against the LOCKED row, so a changed queue, a live fixer, a young
 *     queue or a second retire inside the 24h window writes nothing;
 *   - unrelated routine metadata is preserved.
 *
 * Fixer liveness is injected: `releaseFixerSpawnAlive` has its own tests, and the store's contract
 * is only how it treats each of the three answers (true / null / false).
 *
 * Run: npm run test:file -- packages/operator-core/lib/release/frozen-repair-bounded-life-store.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
const liveness = vi.hoisted(() => ({ alive: false as boolean | null, probed: [] as string[] }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('./fixer-liveness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fixer-liveness')>()),
  releaseFixerSpawnAlive: async (_sql: unknown, spawnId: string) => {
    liveness.probed.push(spawnId);
    return liveness.alive;
  },
}));
// The edit-time marker is a filesystem projection; keep this DB test's fixture isolated.
vi.mock('./frozen-repair-edit-marker', () => ({ projectFrozenRepairMarker: () => {} }));

import {
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS,
  FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS,
  buildFrozenRepairBoundedLifeRecord,
  decideFrozenRepairBoundedLife,
  type FrozenRepairBoundedLifeRecord,
} from './frozen-repair-bounded-life';
import {
  FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY,
  readFrozenRepairBoundedLifeState,
  recordFrozenRepairBoundedLifeEscalation,
  retireFrozenRepairQueueForBoundedLife,
} from './frozen-repair-bounded-life-store';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-frozen-repair-bounded-life', installSlug: 'papercusp' };

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const C = 'c'.repeat(40);
const H = 'd'.repeat(40);
const RECUT = 'e'.repeat(40);

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
  liveness.alive = false;
  liveness.probed = [];
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
});

function queue(
  counts: number[],
  ageMs: number,
  extra: Partial<FrozenCandidateRepairQueue> = {},
): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4,
    phase: 'awaiting-fixer',
    candidate: C,
    base: null,
    repairHead: H,
    attempts: 1,
    openedAtMs: NOW - ageMs,
    updatedAtMs: NOW - 1,
    fixerSpawnId: null,
    failingTests: [],
    signature: [],
    convergenceRounds: counts.map((failingCount, index) => ({ round: index + 1, head: H, failingCount, atMs: NOW })),
    ...extra,
  };
}

/** A non-improving queue: 4 rounds since the low of 3. */
const NON_IMPROVING = [3, 5, 8, 12, 28];

function recordFor(q: FrozenCandidateRepairQueue, nowMs = NOW): FrozenRepairBoundedLifeRecord {
  const decision = decideFrozenRepairBoundedLife(q, { nowMs, state: null });
  if (decision.kind !== 'retire') throw new Error(`fixture must retire, got ${decision.kind}`);
  return buildFrozenRepairBoundedLifeRecord({
    queue: q,
    decision,
    nowMs,
    target: { sha: RECUT, source: 'staging-tip' },
    carry: { carriedPaths: [{ path: 'a.ts', status: 'contained' }], readmitPaths: [], truncated: false },
  });
}

async function seed(metadata: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-frozen-repair-bounded-life', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

async function metadata(): Promise<Record<string, unknown>> {
  const rows = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  const raw = rows[0]?.metadata as unknown;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
}

describe('P-021 bounded-life store (real Postgres)', () => {
  it('the fixture queue survives the JSON round trip the store reads it through', () => {
    const q = queue(NON_IMPROVING, HOUR);
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)))).toMatchObject({
      candidate: C,
      repairHead: H,
      updatedAtMs: NOW - 1,
      fixerSpawnId: null,
    });
  });

  it('retires a non-improving queue and records the retirement in the SAME row write, preserving unrelated metadata', async () => {
    const q = queue(NON_IMPROVING, HOUR);
    await seed({
      repair_queue: q,
      gate_health: {
        consecutive_reds: 7,
        convergence: { stalled: true },
        inconclusive: { status: 'repair-in-progress' },
      },
      unrelated_key: { keep: 'me' },
    });
    const record = recordFor(q);

    await expect(retireFrozenRepairQueueForBoundedLife(target, q, record)).resolves.toEqual({ retired: true });

    const after = await metadata();
    expect(after.repair_queue).toBeUndefined();
    expect(after.unrelated_key).toEqual({ keep: 'me' });
    expect(after.gate_health).toEqual({ consecutive_reds: 7 });
    const state = after[FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY] as Record<string, unknown>;
    expect(state).toMatchObject({
      schemaVersion: 1,
      lastRetire: { trigger: 'non-improving', candidate: C, repairHead: H, recutTarget: RECUT, roundsSinceLow: 4 },
      lastRateLimitedEscalation: null,
    });
    expect((state.history as unknown[]).length).toBe(1);
    // The reader parses exactly what the writer stored.
    await expect(readFrozenRepairBoundedLifeState(target)).resolves.toMatchObject({
      lastRetire: { candidate: C, retiredAtMs: NOW, trigger: 'non-improving' },
    });
  });

  it('retires an over-24h queue on the age trigger even while it is still improving', async () => {
    const q = queue([12, 9, 7], FROZEN_REPAIR_BOUNDED_LIFE_MAX_AGE_MS + HOUR);
    await seed({ repair_queue: q });
    await expect(retireFrozenRepairQueueForBoundedLife(target, q, recordFor(q))).resolves.toEqual({ retired: true });
    expect((await metadata()).repair_queue).toBeUndefined();
    await expect(readFrozenRepairBoundedLifeState(target)).resolves.toMatchObject({
      lastRetire: { trigger: 'age' },
    });
  });

  it('writes nothing when the locked row holds a DIFFERENT queue than the caller decided on', async () => {
    const decidedOn = queue(NON_IMPROVING, HOUR);
    const moved = { ...decidedOn, repairHead: 'f'.repeat(40), updatedAtMs: NOW };
    await seed({ repair_queue: moved });

    await expect(retireFrozenRepairQueueForBoundedLife(target, decidedOn, recordFor(decidedOn))).resolves.toEqual({
      retired: false,
      refusal: 'identity-mismatch',
    });
    const after = await metadata();
    expect(after.repair_queue).toMatchObject({ repairHead: 'f'.repeat(40) });
    expect(after[FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY]).toBeUndefined();
  });

  it('refuses a young, improving queue (within bounds) and leaves it untouched', async () => {
    const decided = queue(NON_IMPROVING, HOUR);
    // The row's queue is the same identity but its rounds show a new low — the locked re-check wins.
    const stored = { ...decided, convergenceRounds: queue([9, 7, 5], HOUR).convergenceRounds };
    await seed({ repair_queue: stored });
    await expect(retireFrozenRepairQueueForBoundedLife(target, decided, recordFor(decided))).resolves.toEqual({
      retired: false,
      refusal: 'within-bounds',
    });
    expect((await metadata()).repair_queue).toMatchObject({ candidate: C });
  });

  it('refuses a second retirement inside the 24h window, then allows one after it', async () => {
    const first = queue(NON_IMPROVING, HOUR);
    await seed({ repair_queue: first });
    await expect(retireFrozenRepairQueueForBoundedLife(target, first, recordFor(first))).resolves.toEqual({ retired: true });

    // A NEW frozen queue (re-cut candidate) that is also non-improving, one hour later.
    const second = queue(NON_IMPROVING, HOUR, { candidate: RECUT, openedAtMs: NOW, updatedAtMs: NOW + HOUR - 1 });
    await sql`
      UPDATE harness_shared.routines
         SET metadata = metadata || jsonb_build_object('repair_queue', ${JSON.stringify(second)}::text::jsonb)
       WHERE workspace_id = ${target.workspaceId}`;
    const inWindow = recordFor(second, NOW);
    const blocked = { ...inWindow, retiredAtMs: NOW + HOUR };
    await expect(retireFrozenRepairQueueForBoundedLife(target, second, blocked)).resolves.toEqual({
      retired: false,
      refusal: 'rate-limited',
    });
    expect((await metadata()).repair_queue).toMatchObject({ candidate: RECUT });

    const afterWindow = { ...inWindow, retiredAtMs: NOW + FROZEN_REPAIR_BOUNDED_LIFE_RETIRE_WINDOW_MS + 1 };
    await expect(retireFrozenRepairQueueForBoundedLife(target, second, afterWindow)).resolves.toEqual({ retired: true });
    const state = await readFrozenRepairBoundedLifeState(target);
    expect(state?.history.map((r) => r.candidate)).toEqual([RECUT, C]);
  });

  it('defers while a promotion is in flight, before it ever probes the fixer', async () => {
    // A verification phase only parses when a fixer (or an admission) got the queue there.
    const q = queue(NON_IMPROVING, HOUR, { fixerSpawnId: 'spawn-fixer-promoting' });
    const promoting = { ...q, phase: 'ready-to-promote' as const };
    expect(parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(promoting)))).not.toBeNull();
    await seed({ repair_queue: promoting });
    await expect(retireFrozenRepairQueueForBoundedLife(target, q, recordFor(q))).resolves.toEqual({
      retired: false,
      refusal: 'promoting',
    });
    expect(liveness.probed).toEqual([]);
    expect((await metadata()).repair_queue).toMatchObject({ phase: 'ready-to-promote' });
  });

  it.each([
    [true, 'live-fixer'],
    [null, 'liveness-unknown'],
  ] as const)('never retires under a fixer whose liveness is %s (refusal %s)', async (alive, refusal) => {
    liveness.alive = alive;
    const q = queue(NON_IMPROVING, HOUR, { fixerSpawnId: 'spawn-fixer-1' });
    await seed({ repair_queue: q });
    await expect(retireFrozenRepairQueueForBoundedLife(target, q, recordFor(q))).resolves.toEqual({
      retired: false,
      refusal,
    });
    expect(liveness.probed).toEqual(['spawn-fixer-1']);
    const after = await metadata();
    expect(after.repair_queue).toMatchObject({ fixerSpawnId: 'spawn-fixer-1' });
    expect(after[FROZEN_REPAIR_BOUNDED_LIFE_METADATA_KEY]).toBeUndefined();
  });

  it('retires under a fixer that is provably not alive', async () => {
    liveness.alive = false;
    const q = queue(NON_IMPROVING, HOUR, { fixerSpawnId: 'spawn-fixer-dead' });
    await seed({ repair_queue: q });
    await expect(retireFrozenRepairQueueForBoundedLife(target, q, recordFor(q))).resolves.toEqual({ retired: true });
    expect(liveness.probed).toEqual(['spawn-fixer-dead']);
  });

  it('records a rate-limited escalation beside the queue without touching it or the retirement history', async () => {
    const q = queue(NON_IMPROVING, HOUR);
    await seed({ repair_queue: q });
    await retireFrozenRepairQueueForBoundedLife(target, q, recordFor(q));
    const next = queue(NON_IMPROVING, HOUR, { candidate: RECUT });
    await sql`
      UPDATE harness_shared.routines
         SET metadata = metadata || jsonb_build_object('repair_queue', ${JSON.stringify(next)}::text::jsonb)
       WHERE workspace_id = ${target.workspaceId}`;

    await recordFrozenRepairBoundedLifeEscalation(target, {
      candidate: RECUT,
      trigger: 'non-improving',
      atMs: NOW + HOUR,
      lastRetireAtMs: NOW,
    });

    const after = await metadata();
    expect(after.repair_queue).toMatchObject({ candidate: RECUT });
    const state = await readFrozenRepairBoundedLifeState(target);
    expect(state).toMatchObject({
      lastRetire: { candidate: C, retiredAtMs: NOW },
      lastRateLimitedEscalation: { candidate: RECUT, lastRetireAtMs: NOW },
    });
    expect(state?.history).toHaveLength(1);
  });

  it('escalation recording is a no-op when the install has no gate routine row', async () => {
    await recordFrozenRepairBoundedLifeEscalation(target, {
      candidate: C,
      trigger: 'age',
      atMs: NOW,
      lastRetireAtMs: NOW - HOUR,
    });
    const rows = await sql`SELECT 1 FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
    expect(rows).toHaveLength(0);
    await expect(readFrozenRepairBoundedLifeState(target)).resolves.toBeNull();
  });
});
