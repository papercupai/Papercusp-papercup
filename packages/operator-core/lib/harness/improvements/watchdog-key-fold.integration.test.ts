/**
 * bug-inflow-one-problem-one-row-2026-10-18 P-008 (R-7): the backlog fold on a real PG.
 *
 *  - SPEC-P-008: the dry run reports per-key fold counts and writes nothing.
 *  - SPEC-P-008-APPLY: apply marks every non-canonical open row on a shared key
 *    dropped with duplicate_of naming the canonical row (and only those rows).
 *  - SPEC-P-008-LINKS: apply sets duplicate_of on the source row of every existing
 *    `duplicates` edge that lacks one (first edge wins; non-work-item targets ignored).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';
import type { WatchdogKeyCollision } from './watchdog-key-migration';
import {
  backfillDuplicateOfFromLinks,
  foldWatchdogKeyCollisions,
  planWatchdogKeyFolds,
} from './watchdog-key-fold';

const WS = 'ws1';
const H = 'h1';
const KEY = 'repeated-tool-error:plans:list:structural:invalid_args:slug';
const OLD = 'repeated-tool-error:plans:list:structural:abc123';

const COORD_LINKS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_links (
    id bigserial PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT 'default',
    src_kind text NOT NULL, src_ref text NOT NULL,
    dst_kind text NOT NULL, dst_ref text NOT NULL,
    rel text NOT NULL, created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

interface Row {
  feature_id: string;
  workspace_id: string;
  status: string;
  duplicate_of: string | null;
  duplicate_source: string | null;
  duplicate_confidence: number | null;
  duplicate_evidence: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}

describe('watchdog-key fold + duplicates-link backfill (P-008)', () => {
  let db: FreshPgDb;

  async function insert(id: string, opts: { ws?: string; status?: string; takenBy?: string; payload?: object; dup?: string } = {}) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, workspace_id, title, status, item_kind, payload, created_ts, taken_by, duplicate_of, duplicate_source)
      VALUES (${H}, ${id}, ${opts.ws ?? WS}, ${`title ${id}`}, ${opts.status ?? 'open'}, 'bug',
              ${db.sql.json((opts.payload ?? {}) as never)}, 0, ${opts.takenBy ?? null},
              ${opts.dup ?? null}, ${opts.dup ? 'agent' : null})`;
  }

  async function rows(): Promise<Row[]> {
    return db.sql<Row[]>`
      SELECT feature_id, workspace_id, status, duplicate_of, duplicate_source, duplicate_confidence,
             duplicate_evidence, payload
        FROM harness_shared.work_items ORDER BY workspace_id, feature_id`;
  }

  async function row(id: string): Promise<Row> {
    const [r] = (await rows()).filter((x) => x.feature_id === id);
    return r;
  }

  const collision = (id: string): WatchdogKeyCollision => ({ id, oldKey: OLD, newKey: KEY, heldBy: 'EI-CANON' });
  const COLLISIONS = ['EI-L1', 'EI-L2', 'EI-CLAIMED', 'EI-OTHERWS', 'EI-DONE'].map(collision);

  beforeAll(async () => {
    db = await createFreshPgDb('watchdog-key-fold');
    await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    await db.sql.unsafe(COORD_LINKS_DDL);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.work_items`;
    await db.sql`DELETE FROM harness_shared.coord_links`;
    await insert('EI-CANON', { payload: { watchdogKey: KEY, repeatCount: 3 } });
    await insert('EI-L1', { payload: { watchdogKey: OLD, repeatCount: 2 } });
    await insert('EI-L2', { payload: { watchdogKey: OLD } });
    await insert('EI-CLAIMED', { payload: { watchdogKey: OLD }, takenBy: 'su-someone' });
    await insert('EI-OTHERWS', { ws: 'ws2', payload: { watchdogKey: OLD } });
    await insert('EI-DONE', { status: 'done', payload: { watchdogKey: OLD } });
  });

  it('plans one group per shared key onto the row holding it', () => {
    const plan = planWatchdogKeyFolds([...COLLISIONS, collision('EI-L1')]);
    expect(plan).toEqual([{ key: KEY, canonical: 'EI-CANON', folded: ['EI-L1', 'EI-L2', 'EI-CLAIMED', 'EI-OTHERWS', 'EI-DONE'] }]);
  });

  it('dry run reports per-key fold counts and writes nothing', async () => {
    const before = await rows();
    const dropped: string[] = [];
    const res = await foldWatchdogKeyCollisions(COLLISIONS, { sql: db.sql, dropDuplicate: async (id) => { dropped.push(id); } });
    expect(res.dryRun).toBe(true);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ key: KEY, canonical: 'EI-CANON' });
    expect(res.groups[0].folded).toHaveLength(5);
    expect(res.folded).toBe(2);
    expect(res.skipped.sort()).toEqual(['EI-CLAIMED', 'EI-DONE', 'EI-OTHERWS']);
    expect(dropped).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it('apply drops each open, unclaimed loser with duplicate_of naming the canonical row', async () => {
    const dropped: string[] = [];
    const drop = async (id: string) => {
      dropped.push(id);
      await db.sql`UPDATE harness_shared.work_items SET status = 'dropped' WHERE feature_id = ${id}`;
    };
    const res = await foldWatchdogKeyCollisions(COLLISIONS, { sql: db.sql, dropDuplicate: drop }, { dryRun: false });
    expect(res.folded).toBe(2);
    expect(dropped.sort()).toEqual(['EI-L1', 'EI-L2']);
    for (const id of ['EI-L1', 'EI-L2']) {
      const r = await row(id);
      expect(r.status).toBe('dropped');
      expect(r.duplicate_of).toBe('EI-CANON');
      expect(r.duplicate_source).toBe('fold');
      expect(r.duplicate_confidence).toBe(1);
      expect(r.duplicate_evidence).toEqual({ matchedOn: 'structural-key', key: KEY });
      expect(r.payload.watchdogKeyFoldedInto).toBe('EI-CANON');
    }
    // The canonical row stays open and carries the folded occurrences: 3 + 2 + 1.
    const canon = await row('EI-CANON');
    expect(canon.status).toBe('open');
    expect(canon.duplicate_of).toBeNull();
    expect(canon.payload.repeatCount).toBe(6);
    // Claimed, other-workspace and terminal rows keep their own disposition.
    for (const id of ['EI-CLAIMED', 'EI-OTHERWS', 'EI-DONE']) expect((await row(id)).duplicate_of).toBeNull();
    expect((await row('EI-CLAIMED')).status).toBe('open');
    // A second apply is a no-op.
    const again = await foldWatchdogKeyCollisions(COLLISIONS, { sql: db.sql, dropDuplicate: drop }, { dryRun: false });
    expect(again.folded).toBe(0);
    expect((await row('EI-CANON')).payload.repeatCount).toBe(6);
  });

  it('link backfill stamps duplicate_of from pre-1534 duplicates edges, first edge wins', async () => {
    await insert('EI-A');
    await insert('EI-B');
    await insert('EI-C', { status: 'done' });
    await insert('EI-E', { dup: 'EI-B' });
    await insert('EI-G');
    await insert('EI-P');
    await insert('EI-M');
    await insert('WI-F1');
    const link = (src: [string, string], dst: [string, string], at: string) => db.sql`
      INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_by, created_at)
      VALUES (${WS}, ${src[0]}, ${src[1]}, ${dst[0]}, ${dst[1]}, 'duplicates', 'su-x', ${at}::timestamptz)`;
    await link(['issue', 'EI-A'], ['issue', 'EI-B'], '2026-10-01T00:00:00Z');
    await link(['feature', `${H}#WI-F1`], ['issue', 'EI-B'], '2026-10-01T00:00:00Z');
    await link(['issue', 'EI-C'], ['issue', 'EI-B'], '2026-10-01T00:00:00Z'); // terminal source: stamped, not open
    await link(['issue', 'EI-E'], ['issue', 'EI-A'], '2026-10-01T00:00:00Z'); // already has a verdict
    await link(['issue', 'EI-G'], ['issue', 'EI-B'], '2026-10-01T00:00:00Z'); // first edge
    await link(['issue', 'EI-G'], ['issue', 'EI-A'], '2026-10-02T00:00:00Z'); // later edge loses
    await link(['issue', 'EI-P'], ['plan', 'some-plan'], '2026-10-01T00:00:00Z'); // not a work-item target
    await link(['issue', 'EI-M'], ['issue', 'EI-MISSING'], '2026-10-01T00:00:00Z'); // target absent

    const before = await rows();
    const dry = await backfillDuplicateOfFromLinks({ sql: db.sql });
    expect(dry).toEqual({ dryRun: true, stamped: 4, open: 3 });
    expect(await rows()).toEqual(before);

    const applied = await backfillDuplicateOfFromLinks({ sql: db.sql }, { dryRun: false });
    expect(applied).toEqual({ dryRun: false, stamped: 4, open: 3 });
    const verdict = async (id: string) => {
      const r = await row(id);
      return [r.duplicate_of, r.duplicate_source];
    };
    expect(await verdict('EI-A')).toEqual(['EI-B', 'agent']);
    expect(await verdict('WI-F1')).toEqual(['EI-B', 'agent']);
    expect(await verdict('EI-C')).toEqual(['EI-B', 'agent']);
    expect(await verdict('EI-G')).toEqual(['EI-B', 'agent']);
    expect(await verdict('EI-E')).toEqual(['EI-B', 'agent']); // pre-existing verdict untouched
    expect(await verdict('EI-P')).toEqual([null, null]);
    expect(await verdict('EI-M')).toEqual([null, null]);
    expect((await row('EI-A')).duplicate_evidence).toEqual({ matchedOn: 'agent-link', by: 'su-x', backfill: true });

    const again = await backfillDuplicateOfFromLinks({ sql: db.sql }, { dryRun: false });
    expect(again.stamped).toBe(0);
  });
});
