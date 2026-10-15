/**
 * carry-brief.integration.test.ts — selective deferred-work discovery against
 * the fully migrated PostgreSQL schema.
 *
 * The unit suite pins the evidence-first UNION shape and builder concurrency.
 * This test supplies the independent database oracle: representative authored,
 * commented, dual-source, terminal, assigned, old, and unrelated-history rows
 * are persisted first, then the production reader must return only the exact
 * eligible population with the same source flags the carry renderer consumes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import { readDeferredWorkItems } from './carry-brief';

const WS = 'carry-brief-selective-test';
const HARNESS = 'papercusp';
const OWNER = 'su-carry-owner';
const OTHER_OWNER = 'su-unrelated-owner';
const SESSION_STARTED_AT_MS = Date.parse('2026-09-14T04:00:00.000Z');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

async function seedWorkItem(
  id: string,
  opts: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    createdAtMs?: number;
    createdBy?: string;
    lane?: string | null;
  } = {},
): Promise<void> {
  // `lane` is a GENERATED column (payload->>'lane'), so it is seeded via payload.
  const payload: postgres.JSONValue = {
    ...(opts.createdBy ? { _ei: { created_by: opts.createdBy } } : {}),
    ...(opts.lane ? { lane: opts.lane } : {}),
  };
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, item_kind,
       status, taken_by, created_ts, updated_ts, payload)
    VALUES
      (${WS}, ${HARNESS}, ${id}, ${`title ${id}`}, ${`body ${id}`},
       ${opts.kind ?? 'bug'}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${opts.createdAtMs ?? SESSION_STARTED_AT_MS - 1_000},
       ${opts.createdAtMs ?? SESSION_STARTED_AT_MS - 1_000}, ${db.adminSql.json(payload)})
  `;
}

async function seedThread(
  threadId: string,
  parentKind: 'issue' | 'feature',
  parentRef: string,
  authors: readonly string[],
): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.coord_threads
      (workspace_id, thread_id, parent_kind, parent_ref, title)
    VALUES (${WS}, ${threadId}, ${parentKind}, ${parentRef}, ${threadId})
  `;
  for (const [index, author] of authors.entries()) {
    await db.adminSql`
      INSERT INTO harness_shared.coord_thread_posts
        (workspace_id, thread_id, author_id, body, created_at)
      VALUES
        (${WS}, ${threadId}, ${author}, ${`post ${index}`},
         to_timestamp(${SESSION_STARTED_AT_MS + index + 1}::double precision / 1000.0))
    `;
  }
}

describe('readDeferredWorkItems — selective PostgreSQL parity', () => {
  it('returns only current-session authored/commented unheld non-terminal rows with exact source flags', async () => {
    await seedWorkItem('EI-authored', {
      kind: 'bug',
      createdAtMs: SESSION_STARTED_AT_MS + 1,
      createdBy: OWNER,
    });
    await seedWorkItem('WI-commented-feature', { kind: 'feature' });
    await seedThread('thread-commented-feature', 'feature', `${HARNESS}#WI-commented-feature`, [OWNER, OWNER]);
    await seedWorkItem('EI-both', {
      kind: 'change',
      createdAtMs: SESSION_STARTED_AT_MS + 2,
      createdBy: OWNER,
    });
    await seedThread('thread-both', 'issue', 'EI-both', [OWNER]);

    // Each row below has tempting positive evidence but fails one load-bearing
    // eligibility predicate. None may leak into the bounded carry list.
    await seedWorkItem('EI-terminal', {
      status: 'done',
      createdAtMs: SESSION_STARTED_AT_MS + 3,
      createdBy: OWNER,
    });
    await seedThread('thread-terminal', 'issue', 'EI-terminal', [OWNER]);
    await seedWorkItem('EI-assigned', {
      takenBy: 'su-peer',
      createdAtMs: SESSION_STARTED_AT_MS + 4,
      createdBy: OWNER,
    });
    await seedThread('thread-assigned', 'issue', 'EI-assigned', [OWNER]);
    await seedWorkItem('EI-old', {
      createdAtMs: SESSION_STARTED_AT_MS - 1,
      createdBy: OWNER,
    });
    // WI-10004968: observation-lane reflections (e.g. a loop:checkpoint insight)
    // are never claimable work, whether authored or commented this session.
    await seedWorkItem('EI-observation-authored', {
      kind: 'change',
      createdAtMs: SESSION_STARTED_AT_MS + 5,
      createdBy: OWNER,
      lane: 'observation',
    });
    await seedWorkItem('EI-observation-commented', { kind: 'change', lane: 'observation' });
    await seedThread('thread-observation', 'issue', 'EI-observation-commented', [OWNER]);
    await seedWorkItem('WI-unrelated-history', { kind: 'feature' });
    await seedThread(
      'thread-unrelated-history',
      'feature',
      `${HARNESS}#WI-unrelated-history`,
      Array.from({ length: 25 }, () => OTHER_OWNER),
    );

    const rows = await readDeferredWorkItems(OWNER, WS, {
      sql: db.adminSql,
      sessionStartedAtMs: SESSION_STARTED_AT_MS,
    });

    expect(rows).toHaveLength(3);
    expect(new Map(rows.map((row) => [row.id, row.source]))).toEqual(
      new Map([
        ['EI-authored', 'created'],
        ['WI-commented-feature', 'commented'],
        ['EI-both', 'created-and-commented'],
      ]),
    );
    expect(rows.map((row) => row.id)).not.toEqual(
      expect.arrayContaining([
        'EI-terminal',
        'EI-assigned',
        'EI-old',
        'EI-observation-authored',
        'EI-observation-commented',
        'WI-unrelated-history',
      ]),
    );
    expect(rows.find((row) => row.id === 'WI-commented-feature')).toMatchObject({
      harness: HARNESS,
      kind: 'feature',
      title: 'title WI-commented-feature',
      body: 'body WI-commented-feature',
    });
  });
});
