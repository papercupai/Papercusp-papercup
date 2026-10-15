/**
 * The turn-provenance re-derivation pass must CLAIM its rows, not queue behind
 * them (WI-10006752).
 *
 * Measured 2026-10-06: the pass rewrote 5,000 session_turns rows per statement
 * (mean 124.7 s, max 711 s) without locking them first, so two overlapping runs
 * read the same head of the backlog and the second one's UPDATE waited on the
 * first one's row locks until lock_timeout killed it. All 25 sampled lock waits
 * on session_turns were this UPDATE waiting on itself.
 *
 * This runs the real pass against real Postgres:
 *  1. A second connection holds one stale row FOR UPDATE, the way an in-flight
 *     writer does. The pass must return promptly (no wait) having rewritten the
 *     other rows, and must leave the held row stale for a later pass.
 *  2. After the hold is released, the next pass picks that row up.
 *  3. Two concurrent passes over the same backlog rewrite each row once in total.
 *  4. A stale row whose verdict re-derives UNCHANGED is neither written nor
 *     locked (xmin and xmax stay put) and keeps its older version, and the lap
 *     after that finds the table clean (WI-10006788).
 *  5. No index covers the turn_origin* columns, so the rewrites stay
 *     HOT-eligible (WI-10006788, migration 1405).
 * Removing `SKIP LOCKED` makes (1) time out; removing the claim entirely makes
 * (3) double-count; writing every stale row again fails (4); re-adding an index
 * on turn_origin_classifier_version fails (5).
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');

it('re-derivation pass skips rows another writer holds and never rewrites a row twice', () => {
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { insertTurns, backfillTurnProvenanceOnce, newProvenanceLap } from './packages/operator-core/lib/search/session-ingest.ts';
    import { MACHINE_SURFACE_CATALOGUE_VERSION } from './packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts';
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
    const sql = getOrgPg().sql;
    const current = MACHINE_SURFACE_CATALOGUE_VERSION;
    const stale = current - 1;
    const ids = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const now = new Date();
    let holder = null;
    const versions = async () => sql\`SELECT session_id, turn_origin_classifier_version AS v
      FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
    // Stale AND wrong: an assistant turn re-derives to 'not-user-turn', so every
    // row needs a rewrite (the pass writes only verdicts that change).
    const markAllStale = () => sql\`UPDATE harness_shared.session_turns
      SET turn_origin_classifier_version = \${stale}, turn_origin_verdict = 'owner-typed'
      WHERE workspace_id = \${workspace}\`;
    try {
      await insertTurns(sql, ids.map((id, i) => ({
        workspace_id: workspace, source_kind: 'codex', session_id: 'skip-' + id, turn_idx: 0,
        ts: new Date(now.getTime() + i).toISOString(), owner: 'synthetic-owner', harness_slug: 'synthetic',
        cwd: null, speaker: 'assistant', text: 'reply ' + id, prompt_hash: null,
      })));
      await markAllStale();
      assert.equal((await versions()).length, ids.length);

      // 1. A concurrent writer holds h2.
      holder = await sql.reserve();
      await holder\`BEGIN\`;
      await holder\`SELECT 1 FROM harness_shared.session_turns
        WHERE workspace_id = \${workspace} AND session_id = 'skip-h2' FOR UPDATE\`;
      const started = Date.now();
      let timer;
      const first = await Promise.race([
        backfillTurnProvenanceOnce(sql, 10),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(
          'the pass WAITED on a row another writer holds (no return within 5 s)')), 5000); }),
      ]);
      clearTimeout(timer);
      console.log('SKIP_LOCKED_HELD ' + JSON.stringify({ first, elapsedMs: Date.now() - started }));
      // The read takes no locks, so all five are examined; only four are written.
      assert.equal(first.scanned, 5);
      assert.equal(first.updated, 4);
      for (const r of await versions()) {
        assert.equal(r.v, r.session_id === 'skip-h2' ? stale : current, r.session_id);
      }

      // 2. Released: the next pass picks the skipped row up.
      await holder\`ROLLBACK\`;
      holder.release();
      holder = null;
      const second = await backfillTurnProvenanceOnce(sql, 10);
      assert.equal(second.scanned, 1);
      assert.equal(second.updated, 1);
      for (const r of await versions()) assert.equal(r.v, current, r.session_id);
      assert.deepEqual(await backfillTurnProvenanceOnce(sql, 10), { scanned: 0, updated: 0, more: false });

      // 3. Two concurrent passes over the same backlog rewrite each row once.
      // markAllStale moves versions BACKWARDS, which production never does (a
      // catalogue bump restarts the lap), so start a fresh lap here.
      await markAllStale();
      const lap = newProvenanceLap();
      const [a, b] = await Promise.all([
        backfillTurnProvenanceOnce(sql, ids.length, lap),
        backfillTurnProvenanceOnce(sql, ids.length, lap),
      ]);
      console.log('SKIP_LOCKED_CONCURRENT ' + JSON.stringify({ a, b }));
      assert.equal(a.updated + b.updated, ids.length);
      for (const r of await versions()) assert.equal(r.v, current, r.session_id);

      // 4. A stale row whose verdict re-derives unchanged is not touched.
      await sql\`UPDATE harness_shared.session_turns SET turn_origin_classifier_version = \${stale}
        WHERE workspace_id = \${workspace}\`;
      const tuples = () => sql\`SELECT session_id, xmin::text AS xmin, xmax::text AS xmax
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      const tuplesBefore = await tuples();
      const unchangedLap = newProvenanceLap();
      const examined = await backfillTurnProvenanceOnce(sql, 10, unchangedLap);
      console.log('SKIP_LOCKED_UNCHANGED ' + JSON.stringify(examined));
      assert.equal(examined.scanned, ids.length);
      assert.equal(examined.updated, 0);
      assert.deepEqual(await tuples(), tuplesBefore, 'an unchanged row must be neither written nor locked');
      for (const r of await versions()) assert.equal(r.v, stale, r.session_id);
      assert.deepEqual(await backfillTurnProvenanceOnce(sql, 10, unchangedLap), { scanned: 0, updated: 0, more: false });
      assert.notEqual(unchangedLap.cleanAt, null);

      // 5. Nothing the pass writes is indexed, so its rewrites can be HOT.
      const covering = await sql\`SELECT indexrelid::regclass::text AS name
        FROM pg_index WHERE indrelid = 'harness_shared.session_turns'::regclass
         AND pg_get_indexdef(indexrelid) ~ 'turn_origin'\`;
      assert.deepEqual(covering.map((r) => r.name), [], 'an index on a turn_origin* column makes every provenance rewrite non-HOT');
      const positiveControl = await sql\`SELECT count(*)::int AS n FROM pg_index
        WHERE indrelid = 'harness_shared.session_turns'::regclass AND pg_get_indexdef(indexrelid) ~ 'text_embedding'\`;
      assert.ok(positiveControl[0].n > 0, 'the index-definition probe must see the session_turns indexes at all');
      console.log('SKIP_LOCKED_RESULT ok');
    } finally {
      if (holder) { await holder\`ROLLBACK\`.catch(() => {}); holder.release(); }
      await sql.end();
    }
  `.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: probe, encoding: 'utf8', timeout: 10000 });
  expect(syntax.status, syntax.stderr).toBe(0);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env },
  });
  if (result.status !== 0) process.stderr.write(result.stdout.slice(-5000) + '\n' + result.stderr.slice(-2000));
  expect(result.status, result.stdout.slice(-5000) + '\n' + result.stderr.slice(-5000)).toBe(0);
  expect(result.stdout).toContain('SKIP_LOCKED_RESULT ok');
}, 200000);
