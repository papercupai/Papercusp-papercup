/**
 * BM25 index maintenance, the body of the `bm25Maintenance` DBOS scheduled workflow (plan
 * bm25-lexical-search-evoke-adoption-2026-10-10: requirement R-8, item P-006).
 *
 * Against a preloaded pg_textsearch server: a deferred large-table index is built
 * CONCURRENTLY at most one per run, an INVALID index is dropped and rebuilt, a healthy set is
 * left alone, and an index that bm25_needs_compaction reports as eligible is compacted within
 * the per-run step budget until it no longer needs it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createDedicatedOrgPg, _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { BM25_MAX_BLOAT_RATIO, estimateBm25LiveBytes, parseBm25SegmentTotals, runBm25Maintenance } from './bm25-maintenance';
import { resetBm25Availability } from './rank';
import { rankWorkItemIds, seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

let db: Bm25TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
  resetBm25Availability();
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('index maintenance workflow body (P-006)', () => {
  it('counts required metapage and page-map storage in a fresh small index live-byte estimate', async () => {
    await sql.unsafe(`CREATE TABLE harness_shared.fresh_small_probe (id int, body text);
      INSERT INTO harness_shared.fresh_small_probe SELECT g, 'heron wading bird' FROM generate_series(1, 257) g;
      CREATE INDEX fresh_small_probe_bm25 ON harness_shared.fresh_small_probe USING bm25 (body)
        WITH (text_config = 'english', compaction = 'manual');`);
    const [{ bytes, summary }] = await sql<{ bytes: string; summary: string }[]>`
      SELECT pg_relation_size('harness_shared.fresh_small_probe_bm25'::regclass)::text AS bytes,
        public.bm25_summarize_index('harness_shared.fresh_small_probe_bm25') AS summary`;
    const totals = parseBm25SegmentTotals(summary)!;
    expect(totals).toMatchObject({ segments: 1, alive: 257, docs: 257 });
    // pg_textsearch 1.5.x stores block0 metadata and a page-map block in
    // addition to the segment's data pages, even immediately after CREATE.
    expect(Number(bytes)).toBe((totals.pages + 2) * 8192);
    console.info('BM25_FRESH_SMALL_STORAGE ' + JSON.stringify({ bytes: Number(bytes), totals,
      estimatedLiveBytes: estimateBm25LiveBytes(totals) }));
    expect(estimateBm25LiveBytes(totals)).toBe(Number(bytes));
  });

  it('reclaims actual small-index bloat under default settings while leaving a fresh small index alone', async () => {
    const qualified = 'harness_shared.small_reclaim_probe_bm25';
    try {
      await sql.unsafe(`CREATE TABLE harness_shared.small_reclaim_probe (id serial, body text);
        CREATE INDEX small_reclaim_probe_bm25 ON harness_shared.small_reclaim_probe USING bm25 (body)
          WITH (text_config = 'english', compaction = 'manual');`);
      for (let s = 0; s < 4; s++) {
        await sql`INSERT INTO harness_shared.small_reclaim_probe (body)
          SELECT 'smalltok' || md5(g::text) FROM generate_series(${s * 100 + 1}::int, ${(s + 1) * 100}::int) g`;
        await sql`SELECT public.bm25_spill_index(${qualified})`;
      }
      const result = await runBm25Maintenance(sql);
      expect(result.errors).toEqual([]);
      expect(result.reclaimed?.index).toBe(qualified);
      expect(result.reclaimed!.beforeBytes).toBeLessThan(8 * 1024 * 1024);
      expect(result.reclaimed!.afterBytes).toBeLessThan(result.reclaimed!.beforeBytes);
      expect(result.pendingReclaims).not.toContain('harness_shared.fresh_small_probe_bm25');
      const [{ bytes, summary }] = await sql<{ bytes: string; summary: string }[]>`
        SELECT pg_relation_size(${qualified}::regclass)::text AS bytes, public.bm25_summarize_index(${qualified}) AS summary`;
      expect(Number(bytes) / estimateBm25LiveBytes(parseBm25SegmentTotals(summary)!)).toBeLessThan(1.5);
      expect((await runBm25Maintenance(sql)).reclaimed).toBeNull();
    } finally {
      await sql.unsafe('DROP TABLE IF EXISTS harness_shared.small_reclaim_probe');
    }
  });

  it('reclaims a bloated index even when its compaction budget leaves debt unsettled', async () => {
    const qualified = 'harness_shared.unsettled_reclaim_probe_bm25';
    try {
      await sql.unsafe(`CREATE TABLE harness_shared.unsettled_reclaim_probe (id serial PRIMARY KEY, body text);
        CREATE INDEX unsettled_reclaim_probe_bm25 ON harness_shared.unsettled_reclaim_probe USING bm25 (body)
          WITH (text_config = 'english', compaction = 'manual');`);
      for (let s = 0; s < 4; s++) {
        await sql`INSERT INTO harness_shared.unsettled_reclaim_probe (body)
          SELECT 'unsettledtok' || md5(g::text) FROM generate_series(${s * 100 + 1}::int, ${(s + 1) * 100}::int) g`;
        await sql`SELECT public.bm25_spill_index(${qualified})`;
      }
      await sql.unsafe('DELETE FROM harness_shared.unsettled_reclaim_probe WHERE id <= 320');
      await sql.unsafe('VACUUM harness_shared.unsettled_reclaim_probe');
      const [{ bytes, summary, needs }] = await sql<{ bytes: string; summary: string; needs: boolean }[]>`
        SELECT pg_relation_size(${qualified}::regclass)::text AS bytes,
          public.bm25_summarize_index(${qualified}) AS summary,
          public.bm25_needs_compaction(${qualified}::regclass) AS needs`;
      const ratio = Number(bytes) / estimateBm25LiveBytes(parseBm25SegmentTotals(summary)!);
      expect(needs, 'fixture must have actual unsettled compaction debt').toBe(true);
      expect(ratio, 'fixture must have measured bloat independently of compaction debt').toBeGreaterThan(BM25_MAX_BLOAT_RATIO);
      const result = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
      expect(result.errors).toEqual([]);
      expect(result.compacted.find(c => c.index === qualified)).toEqual({ index: qualified, steps: 0, stillNeeds: true });
      expect(result.reclaimed?.index, 'unsettled compaction must not hide a bloated index from reclaim').toBe(qualified);
      expect(result.reclaimed!.afterBytes).toBeLessThan(result.reclaimed!.beforeBytes);
      const [{ remaining, afterBytes, afterSummary, afterNeeds }] = await sql<{
        remaining: number; afterBytes: string; afterSummary: string; afterNeeds: boolean;
      }[]>`SELECT (SELECT count(*)::int FROM harness_shared.unsettled_reclaim_probe) AS remaining,
        pg_relation_size(${qualified}::regclass)::text AS "afterBytes",
        public.bm25_summarize_index(${qualified}) AS "afterSummary",
        public.bm25_needs_compaction(${qualified}::regclass) AS "afterNeeds"`;
      expect(remaining).toBe(80);
      expect(afterNeeds).toBe(false);
      expect(Number(afterBytes) / estimateBm25LiveBytes(parseBm25SegmentTotals(afterSummary)!)).toBeLessThan(1.5);
      expect((await runBm25Maintenance(sql, { maxCompactionSteps: 0 })).reclaimed).toBeNull();
    } finally {
      await sql.unsafe('DROP TABLE IF EXISTS harness_shared.unsettled_reclaim_probe');
    }
  });

  it('holds session settings and advisory locks on one backend, then releases the lock when its dedicated client closes', async () => {
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', `postgres://postgres@${db.connection.host}:${db.connection.port}/${db.runTag}`);
    vi.stubEnv('PAPERCUSP_PGBOUNCER', '1');
    _resetUrlCacheForTests();
    const { sql: direct } = createDedicatedOrgPg('bm25-session-proof', { max: 1, sessionAffinity: true });
    const key = `bm25-session-proof:${db.runTag}`;
    try {
      const [before] = await direct<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await direct`SET lock_timeout = '23s'`;
      const [{ acquired }] = await direct<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`;
      expect(acquired).toBe(true);
      for (let i = 0; i < 3; i++) {
        const [after] = await direct<{ pid: number; timeout: string }[]>`
          SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS timeout`;
        expect(after).toEqual({ pid: before.pid, timeout: '23s' });
      }
      const [{ blocked }] = await sql<{ blocked: boolean }[]>`SELECT NOT pg_try_advisory_lock(hashtext(${key})) AS blocked`;
      expect(blocked).toBe(true);
    } finally {
      await direct.end({ timeout: 5 });
      vi.unstubAllEnvs();
      _resetUrlCacheForTests();
    }
    const verifier = await sql.reserve();
    try {
      expect((await verifier<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${key})) AS acquired`)[0].acquired).toBe(true);
    } finally {
      await verifier`SELECT pg_advisory_unlock(hashtext(${key}))`;
      verifier.release();
    }
  });

  const wiIndexOutcome = async (): Promise<string[]> =>
    (await sql<{ outcome: string }[]>`
      SELECT outcome FROM harness_shared.bm25_ensure_indexes() WHERE corpus_index = 'work_items_bm25'`).map(r => r.outcome);

  it('builds a deferred large-table index CONCURRENTLY, at most one per run', async () => {
    await sql.unsafe('DROP INDEX harness_shared.work_items_bm25; ANALYZE harness_shared.work_items;');
    // largeTableRows 10 makes the 400-row work_items "large", so ensure defers it.
    const report = await runBm25Maintenance(sql, { largeTableRows: 10, maxCompactionSteps: 0 });
    expect(report.errors).toEqual([]);
    expect(report.engineSkipped).toBeNull();
    expect(report.ensure.find(r => r.corpusIndex === 'work_items_bm25')?.outcome).toBe('deferred:build-concurrently');
    expect(report.built).toBe('work_items_bm25');
    expect(report.rebuiltInvalid).toBe(false);
    expect(await wiIndexOutcome()).toEqual(['present']);
    expect((await rankWorkItemIds(sql, 'quokka'))[0]).toBe(1);
  });

  it('drops and rebuilds an INVALID index (a dead CONCURRENTLY build), which IF NOT EXISTS would skip forever', async () => {
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.work_items_bm25'::regclass`);
    expect(await wiIndexOutcome()).toEqual(['invalid']);
    const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
    expect(report.errors).toEqual([]);
    expect(report.built).toBe('work_items_bm25');
    expect(report.rebuiltInvalid).toBe(true);
    expect(await wiIndexOutcome()).toEqual(['present']);
    expect((await rankWorkItemIds(sql, 'narwhal'))[0]).toBe(5);
  });

  it('waits out an older writer instead of failing under the pool lock_timeout, and rebuilds the INVALID index a timed-out build left', async () => {
    // The live pool role sets lock_timeout = 15s, and a fleet always has some transaction on
    // work_items older than that, so every CONCURRENTLY build was cancelled (dev box,
    // 2026-10-11). Here a pool whose sessions default to 200 ms stands in for the role.
    const tight = postgres({
      ...db.connection, user: 'postgres', database: db.runTag, max: 2, onnotice: () => {},
      connection: { lock_timeout: 200 },
    });
    const holder = await sql.reserve();
    /**
     * Opens a writer transaction on work_items, which CONCURRENTLY must wait for, and ends it
     * after holdMs. The end is returned wrapped: an async function returning a bare promise
     * would flatten it, so awaiting the open would also wait for the end.
     */
    const holdWriter = async (holdMs: number): Promise<{ ended: Promise<void> }> => {
      await holder`BEGIN`;
      await holder`UPDATE harness_shared.work_items SET notes = 'held' WHERE id = 1`;
      const ended = new Promise<void>(resolve => {
        setTimeout(() => { holder`ROLLBACK`.then(() => resolve(), () => resolve()); }, holdMs);
      });
      return { ended };
    };
    try {
      await sql.unsafe('DROP INDEX IF EXISTS harness_shared.work_items_bm25');
      resetBm25Availability();

      // CONTROL: the same build under the same writer, at the pool's lock_timeout, is
      // cancelled. Without this the harness could pass without ever making the build wait.
      const firstHold = await holdWriter(1_500);
      const [{ ddl }] = await tight<{ ddl: string }[]>`SELECT harness_shared.bm25_index_ddl('work_items_bm25', true) AS ddl`;
      await expect(tight.unsafe(ddl)).rejects.toThrow(/lock timeout/);
      await firstHold.ended;
      expect(await wiIndexOutcome()).toEqual(['invalid']);

      // The real run, through the same tight pool and under the same kind of writer.
      const secondHold = await holdWriter(1_500);
      const report = await runBm25Maintenance(tight, { largeTableRows: 10, maxCompactionSteps: 0 });
      await secondHold.ended;
      expect(report.errors).toEqual([]);
      expect(report.built).toBe('work_items_bm25');
      expect(report.rebuiltInvalid).toBe(true);
      expect(await wiIndexOutcome()).toEqual(['present']);
      // The session override is reset, so the pool's own lock_timeout survives the run.
      const [{ lt }] = await tight<{ lt: string }[]>`SELECT current_setting('lock_timeout') AS lt`;
      expect(lt).toBe('200ms');
    } finally {
      try { await holder`ROLLBACK`; } catch { /* already ended */ }
      holder.release();
      await tight.end();
      resetBm25Availability();
    }
  }, 120_000);

  it('leaves an index alone while another run holds the concurrent-DDL lock, so it never drops a build in progress', async () => {
    const other = await sql.reserve();
    try {
      await other`SELECT pg_advisory_lock(hashtext('bm25-maintenance:concurrent-ddl'))`;
      await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.work_items_bm25'::regclass`);
      const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
      expect(report.errors).toEqual([]);
      expect(report.built).toBeNull();
      expect(report.rebuiltInvalid).toBe(false);
      expect(report.pendingBuilds).toContain('work_items_bm25');
      expect(await wiIndexOutcome()).toEqual(['invalid']);
    } finally {
      await other`SELECT pg_advisory_unlock(hashtext('bm25-maintenance:concurrent-ddl'))`;
      other.release();
    }
    const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
    expect(report.built).toBe('work_items_bm25');
    expect(await wiIndexOutcome()).toEqual(['present']);
  });

  /**
   * Makes `<work_items_bm25>_<suffix>` the way a REINDEX CONCURRENTLY that died leaves it:
   * a second bm25 index on the same column, ready (it takes writes) but INVALID.
   */
  const makeRebuildLeftover = async (suffix: string): Promise<string> => {
    const name = `work_items_bm25_${suffix}`;
    const [{ def }] = await sql<{ def: string }[]>`
      SELECT pg_get_indexdef('harness_shared.work_items_bm25'::regclass) AS def`;
    await sql.unsafe(def.replace(/INDEX work_items_bm25 ON/, `INDEX ${name} ON`));
    await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.${name}'::regclass`);
    return name;
  };
  const indexExists = async (name: string): Promise<boolean> =>
    (await sql<{ found: boolean }[]>`SELECT to_regclass(${`harness_shared.${name}`}) IS NOT NULL AS found`)[0]!.found;

  it('drops the INVALID _ccnew / _ccold copies a dead REINDEX CONCURRENTLY left, and never the index they copied', async () => {
    const ccnew = await makeRebuildLeftover('ccnew');
    const ccold = await makeRebuildLeftover('ccold1');
    expect(await indexExists(ccnew)).toBe(true);
    const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
    expect(report.errors).toEqual([]);
    expect(report.droppedOrphans).toEqual([`harness_shared.${ccnew}`, `harness_shared.${ccold}`]);
    expect(await indexExists(ccnew)).toBe(false);
    expect(await indexExists(ccold)).toBe(false);
    expect(await wiIndexOutcome()).toEqual(['present']);
    expect((await rankWorkItemIds(sql, 'quokka'))[0]).toBe(1);
  });

  it('leaves a REINDEX leftover alone while another run holds the concurrent-DDL lock, since that run may own it', async () => {
    const ccnew = await makeRebuildLeftover('ccnew');
    const other = await sql.reserve();
    try {
      await other`SELECT pg_advisory_lock(hashtext('bm25-maintenance:concurrent-ddl'))`;
      const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
      expect(report.errors).toEqual([]);
      expect(report.droppedOrphans).toEqual([]);
      expect(await indexExists(ccnew)).toBe(true);
    } finally {
      await other`SELECT pg_advisory_unlock(hashtext('bm25-maintenance:concurrent-ddl'))`;
      other.release();
    }
    const report = await runBm25Maintenance(sql, { maxCompactionSteps: 0 });
    expect(report.droppedOrphans).toEqual([`harness_shared.${ccnew}`]);
    expect(await indexExists(ccnew)).toBe(false);
  });

  it('reports nothing to do on a healthy set and never exceeds the compaction step budget', async () => {
    const report = await runBm25Maintenance(sql, { maxCompactionSteps: 2 });
    expect(report.errors).toEqual([]);
    expect(report.built).toBeNull();
    expect(report.pendingBuilds).toEqual([]);
    for (const c of report.compacted) expect(c.steps).toBeLessThanOrEqual(2);
  });

  // Measured on pg_textsearch 1.5.1 (2026-10-11): with compaction = 'manual', two or more
  // level-0 segments make bm25_needs_compaction true, and at the default
  // segments_per_level (8) one bm25_compact_step merges them all into level 1
  // ({3} -> {0,1}). A scratch table keeps the shared work_items fixture untouched.
  it('compacts an index that needs it, stops at the step budget, and finishes on the next run', async () => {
    const idx = 'harness_shared.compaction_probe_bm25';
    await sql.unsafe(`
      CREATE TABLE harness_shared.compaction_probe (id serial PRIMARY KEY, body text);
      CREATE INDEX compaction_probe_bm25 ON harness_shared.compaction_probe USING bm25 (body)
        WITH (text_config = 'english', compaction = 'manual');`);
    try {
      for (const word of ['heron', 'egret', 'ibis']) {
        await sql.unsafe(`INSERT INTO harness_shared.compaction_probe (body)
          SELECT '${word} wading bird ' || g FROM generate_series(1, 40) g`);
        await sql`SELECT public.bm25_spill_index(${idx})`;
      }
      const levels = async () =>
        (await sql<{ l: number[] }[]>`SELECT public.bm25_level_counts(${idx}::regclass) AS l`)[0]!.l.map(Number);
      const needs = async () =>
        (await sql<{ n: boolean }[]>`SELECT public.bm25_needs_compaction(${idx}::regclass) AS n`)[0]!.n;
      expect((await levels())[0]).toBe(3);
      expect(await needs()).toBe(true);

      // A zero budget reports the debt without touching the index.
      const compactionOnly = { reclaimMinBytes: Number.MAX_SAFE_INTEGER };
      const first = await runBm25Maintenance(sql, { ...compactionOnly, maxCompactionSteps: 0 });
      expect(first.errors).toEqual([]);
      expect(first.compacted.find(c => c.index === idx)).toEqual({ index: idx, steps: 0, stillNeeds: true });
      expect((await levels())[0]).toBe(3);

      const second = await runBm25Maintenance(sql, compactionOnly);
      expect(second.errors).toEqual([]);
      expect(second.compacted.find(c => c.index === idx)).toEqual({ index: idx, steps: 1, stillNeeds: false });
      expect((await levels())[0]).toBe(0);
      expect(await needs()).toBe(false);

      const third = await runBm25Maintenance(sql, compactionOnly);
      expect(third.compacted.find(c => c.index === idx)).toBeUndefined();

      // Every row survives the merges and still matches.
      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.compaction_probe WHERE body <@> 'egret' < 0`;
      expect(n).toBe(40);
    } finally {
      await sql.unsafe('DROP TABLE IF EXISTS harness_shared.compaction_probe');
    }
  });

  // Plan decision D-010, measured on pg_textsearch 1.5.1: compaction merges segments into new
  // pages and never returns the old ones, so a churned index file sits far above its live data.
  // Two scratch indexes get four spilled level-0 segments each; the first run compacts both and
  // must rebuild exactly ONE with REINDEX CONCURRENTLY, leaving the other pending for the next
  // run. The floor is lowered to 1 MiB so these indexes qualify and the 400-row fixture's do not.
  it('reclaims a bloated index with REINDEX CONCURRENTLY, at most one per run, and the other on the next run', async () => {
    const tables = ['reclaim_probe_a', 'reclaim_probe_b'];
    const idx = (t: string) => `harness_shared.${t}_bm25`;
    const opts = { reclaimMinBytes: 1024 * 1024 };
    try {
      for (const t of tables) {
        await sql.unsafe(`
          CREATE TABLE harness_shared.${t} (id serial PRIMARY KEY, body text);
          CREATE INDEX ${t}_bm25 ON harness_shared.${t} USING bm25 (body)
            WITH (text_config = 'english', compaction = 'manual');`);
        for (let s = 0; s < 4; s++) {
          await sql.unsafe(`INSERT INTO harness_shared.${t} (body)
            SELECT 'tok' || md5('${t}' || g) FROM generate_series(${s * 3000 + 1}, ${(s + 1) * 3000}) g`);
          await sql`SELECT public.bm25_spill_index(${idx(t)})`;
        }
      }
      const bytes = async (qualified: string) =>
        Number((await sql<{ b: string }[]>`SELECT pg_relation_size(${qualified}::regclass) AS b`)[0]!.b);

      const first = await runBm25Maintenance(sql, opts);
      expect(first.errors).toEqual([]);
      expect(first.built).toBeNull();
      expect(first.reclaimed, 'maintenance must reclaim one bloated index on the first run').not.toBeNull();
      const target = first.reclaimed!;
      expect(tables.map(idx)).toContain(target.index);
      expect(target.ratio).toBeGreaterThan(BM25_MAX_BLOAT_RATIO);
      expect(target.afterBytes).toBeLessThan(target.beforeBytes);
      const other = tables.map(idx).find(i => i !== target.index)!;
      expect(first.pendingReclaims).toEqual([other]);
      const otherBefore = await bytes(other);

      const second = await runBm25Maintenance(sql, opts);
      expect(second.errors).toEqual([]);
      expect(second.reclaimed, 'maintenance must reclaim the remaining bloated index on the next run').not.toBeNull();
      expect(second.reclaimed?.index).toBe(other);
      expect(second.pendingReclaims).toEqual([]);
      expect(await bytes(other)).toBeLessThan(otherBefore);

      const third = await runBm25Maintenance(sql, opts);
      expect(third.errors).toEqual([]);
      expect(third.reclaimed).toBeNull();
      expect(third.pendingReclaims).toEqual([]);

      // The rebuilt indexes still answer for every row. A computed query names its index the
      // way the lexical seam does: bare `<@>` resolves an index only for a literal right side
      // ("no BM25 index found for text <@> text expression" otherwise).
      for (const t of tables) {
        const [{ n }] = await sql.unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM harness_shared.${t}
            WHERE body <@> to_bm25query('tok' || md5('${t}' || 7), '${idx(t)}') < 0`);
        expect(n).toBe(1);
      }
    } finally {
      for (const t of tables) await sql.unsafe(`DROP TABLE IF EXISTS harness_shared.${t}`);
    }
  });

  // EI-25667725192013388: ensure used to build small-table indexes inline, all inside one
  // function call, so each table's ShareLock lasted until the LAST build committed
  // (harness_plans INSERTs waited ~170 s on 2026-10-11). A run must build every missing
  // index CONCURRENTLY, so a writer with a short lock_timeout never times out meanwhile.
  it('builds every missing index CONCURRENTLY, so writes to indexed tables never wait on its locks', async () => {
    await sql.unsafe(`
      INSERT INTO harness_shared.work_items (id, ws, title, summary)
      SELECT g, 'w0', 'bulk item ' || g || ' ' || md5(g::text), 'bulk summary ' || md5((g * 3)::text)
        FROM generate_series(100001, 140000) g;
      ANALYZE harness_shared.work_items;`);
    const dropBoth = async () => {
      await sql.unsafe('DROP INDEX harness_shared.work_items_bm25; DROP INDEX harness_shared.harness_plans_bm25;');
      resetBm25Availability();
    };
    /** Runs `body` while a writer with a 300 ms lock_timeout writes to both indexed tables. */
    const underWrites = async (tag: string, body: () => Promise<void>) => {
      const writer = await sql.reserve();
      await writer`SET lock_timeout = '300ms'`;
      let writing = true;
      let writes = 0;
      const lockErrors: string[] = [];
      const loop = (async () => {
        for (let n = 0; writing; n++) {
          try {
            await writer`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, content)
                         VALUES ('ws1', 'h', ${`lock-probe-${tag}-${n}`}, 'probe', 'probe')`;
            await writer`UPDATE harness_shared.work_items SET notes = ${`${tag}${n}`} WHERE id = 100001`;
            writes += 1;
          } catch (err) {
            lockErrors.push(err instanceof Error ? err.message : String(err));
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })();
      try {
        await body();
      } finally {
        writing = false;
        await loop;
        writer.release();
      }
      return { writes, lockErrors };
    };
    const ensureOutcomes: string[] = [];
    try {
      // CONTROL: the old inline path (threshold above the table) must trip the writer's
      // lock_timeout, or this harness could not see the bug it guards against.
      await dropBoth();
      const control = await underWrites('control', async () => {
        const r = await runBm25Maintenance(sql, { largeTableRows: 1_000_000 });
        expect(r.ensure.map(e => e.outcome)).toContain('created');
      });
      expect(control.lockErrors.length).toBeGreaterThan(0);

      // The real run: defaults, one CONCURRENTLY build per run, until nothing is left.
      await dropBoth();
      const real = await underWrites('real', async () => {
        for (let i = 0; i < 4; i++) {
          const r = await runBm25Maintenance(sql);
          expect(r.errors).toEqual([]);
          ensureOutcomes.push(...r.ensure.map(e => e.outcome));
          if (!r.built && r.pendingBuilds.length === 0) break;
        }
      });
      expect(ensureOutcomes).not.toContain('created');
      expect(ensureOutcomes).toContain('deferred:build-concurrently');
      expect(real.lockErrors).toEqual([]);
      expect(real.writes).toBeGreaterThan(0);
    } finally {
      await sql.unsafe(`
        DELETE FROM harness_shared.work_items WHERE id BETWEEN 100001 AND 140000;
        DELETE FROM harness_shared.harness_plans WHERE plan_slug LIKE 'lock-probe-%';`);
    }
    const valid = await sql<{ relname: string }[]>`
      SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname IN ('work_items_bm25', 'harness_plans_bm25') AND i.indisvalid ORDER BY 1`;
    expect(valid.map(v => v.relname)).toEqual(['harness_plans_bm25', 'work_items_bm25']);
  }, 300_000);
});
