/**
 * stranded-checkpoint-scan.integration.test.ts — the SQL population behind
 * work_items:stranded, against real Postgres.
 *
 * The classifier has extensive PG-free coverage in stranded-checkpoint-scan.test.ts.
 * This suite pins the load-bearing boundary that a pure classifier cannot see: the
 * scanner must apply the shared WI-2797 claim-hold floor before it counts or returns
 * an open issue-family row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { CARRY_NOTES_DDL, HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import { workItemCheckpointScope } from './work-item-checkpoint';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { scanStrandedCheckpoints } = await import('./stranded-checkpoint-scan');

const WS = 'default';
const HARNESS = 'papercusp';
const DAY = 86_400_000;
const daysAgo = (n: number) => Date.now() - n * DAY;

let db: FreshPgDb;

async function seedIssue(id: string, payload: postgres.JSONValue | null = null) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, payload)
    VALUES
      (${WS}, ${HARNESS}, ${id}, 'bug', ${`stranded fixture ${id}`}, 'open', ${daysAgo(10)}, ${daysAgo(10)}, ${payload == null ? null : db.sql.json(payload)})`;
}

async function seedCheckpoint(id: string, note: string, updatedTs = daysAgo(10)) {
  await db.sql`
    INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts)
    VALUES (${WS}, ${workItemCheckpointScope(HARNESS, id)}, ${note}, ${updatedTs})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('stranded-checkpoint-scan');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(CARRY_NOTES_DDL);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.carry_notes`;
});

describe('scanStrandedCheckpoints claim-hold population floor (WI-2797)', () => {
  it('excludes a claim-held issue before classifier counts while retaining unheld work', async () => {
    await seedIssue('EI-held', { _claimHold: true });
    await seedIssue('EI-free');
    const note = 'EI fixture DONE + VERIFIED + plan item FLIPPED to done. Nothing left here.';
    await seedCheckpoint('EI-held', note);
    await seedCheckpoint('EI-free', note);

    const result = await scanStrandedCheckpoints({
      workspaceId: WS,
      harness: HARNESS,
      limit: 10,
      minAgeDays: 2,
    });

    expect(result.scanned).toBe(1);
    expect(result.matched).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['EI-free']);
  });

  /**
   * WI-10006562: the own-node flag is computed in SQL with the SAME own-key predicate the
   * claim gate uses (issueOwnAuthorWhereSql). A key is "own" when some local row carries it.
   */
  it('labels an own-node row stranded at origin=remote closable, and a peer row not', async () => {
    const note = 'EI fixture DONE + VERIFIED + plan item FLIPPED to done. Nothing left here.';
    const seedFed = async (id: string, origin: 'local' | 'remote', key: string) => {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, updated_ts, origin, author_pubkey)
        VALUES (${WS}, ${HARNESS}, ${id}, 'bug', ${`fed fixture ${id}`}, 'open', ${daysAgo(10)}, ${daysAgo(10)}, ${origin}, ${key})`;
    };
    await seedFed('EI-own-local', 'local', 'own-key');
    await seedFed('EI-own-echo', 'remote', 'own-key');
    await seedFed('EI-peer', 'remote', 'peer-key');
    for (const id of ['EI-own-local', 'EI-own-echo', 'EI-peer']) await seedCheckpoint(id, note);

    const result = await scanStrandedCheckpoints({ workspaceId: WS, harness: HARNESS, limit: 10 });

    const byId = Object.fromEntries(result.candidates.map((c) => [c.id, c]));
    expect(byId['EI-own-echo']).toMatchObject({ origin: 'remote', ownNodeAuthored: true, closableLocally: true });
    expect(byId['EI-peer']).toMatchObject({ origin: 'remote', ownNodeAuthored: false, closableLocally: false });
    expect(byId['EI-own-local']).toMatchObject({ origin: 'local', ownNodeAuthored: false, closableLocally: true });
    expect(result.matchedNotClosableLocally).toBe(1);
  });

  it('keeps the SQL floor fails-open for a null payload row', async () => {
    await seedIssue('EI-null-payload');
    await seedCheckpoint('EI-null-payload', 'EI fixture DONE + VERIFIED + plan item FLIPPED to done.');

    const result = await scanStrandedCheckpoints({
      workspaceId: WS,
      harness: HARNESS,
      limit: 10,
      minAgeDays: 2,
    });

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['EI-null-payload']);
  });
});
