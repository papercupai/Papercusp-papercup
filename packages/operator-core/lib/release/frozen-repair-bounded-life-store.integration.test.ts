/** D-090/P-041: the real queue reader never retires an exhausted candidate. */
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
import { readFrozenCandidateRepairQueueState } from '../harness/routines/release-actions';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-frozen-repair-bounded-life', installSlug: 'papercusp' };

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const C = 'c'.repeat(40);
const H = 'd'.repeat(40);

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

describe('P-041: reading exhausted candidates cannot clear persisted queues', () => {
  it.each([
    { counts: NON_IMPROVING, ageMs: HOUR },
    { counts: [10, 8, 6], ageMs: 25 * HOUR },
    { counts: [1, 100, 1000, 10000, 100000], ageMs: 365 * 24 * HOUR },
  ])('preserves exact queue and unrelated metadata for $ageMs', async ({ counts, ageMs }) => {
    const q = queue(counts, ageMs);
    const original = { repair_queue: q, unrelated: { keep: true },
      gate_health: { inconclusive: { status: 'repair-in-progress' } } };
    await seed(original);
    expect(parseFrozenCandidateRepairQueue((await metadata()).repair_queue)).not.toBeNull();
    await expect(readFrozenCandidateRepairQueueState(target)).resolves.toMatchObject({
      status: 'value', queue: q,
    });
    expect(await metadata()).toEqual(original);
    expect(liveness.probed).toEqual([]);
  });
});
