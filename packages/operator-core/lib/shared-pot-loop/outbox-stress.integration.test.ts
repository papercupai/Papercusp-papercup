/**
 * outbox-stress.integration.test.ts — P-006 of
 * `shared-hive-loop-e2e-testing-2026-06-10`: a sustained write storm on one
 * swarm, against the SCOPED, batched outbox GC that closed the 102GB incident
 * (EI-125 — drainOutboxOnce's per-(workspace,harness) bounded GC, landed in
 * the audit's P-001 pass).
 *
 * The storm: thousands of feature INSERTs plus an UPDATE wave on swarm A —
 * every row CDC-captured into `substrate_outbox`. The oracles:
 *
 *   - the drain KEEPS UP: every drive makes progress (bounded batches, never
 *     a stall) and the undrained depth goes monotonically down to ZERO;
 *   - NO AMPLIFICATION: total outbox rows ever created stay ≤ the writes the
 *     storm performed (the capture guards hold under load — no echo growth,
 *     the 102GB failure shape);
 *   - CONVERGENCE UNDER LOAD: swarm B's PG ends with every stormed row, the
 *     last-wave content included, and the fixed point HOLDS;
 *   - OWN-LOG COMPACTION completes and publishes a snapshot covering the storm;
 *   - the convergence LAG is measured and reported (storm-end → B fixpoint),
 *     asserted only against a generous ceiling — the number is the artifact,
 *     the P-013 probe productionizes it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import { listBootHistory } from '../sync/hyperbee/boot-history';
import { findLatestCompleteSnapshot } from '../sync/hyperbee/read-merge';

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { currentCellSql } = await import('./cell-scope');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => {
      const sql = currentCellSql();
      if (!sql) throw new Error('getOrgPg outside cell scope — wrap the call in rig.runAsCell()');
      return { sql };
    },
  };
});

let rig: CompositionRig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const STORM_INSERTS = 2_000;
const STORM_UPDATES = 500;

describe('P-006 — outbox stress: write storm drains bounded, no amplification, convergence lag measured', () => {
  it(
    `${STORM_INSERTS} inserts + ${STORM_UPDATES} updates on A drain to zero and fully reach B`,
    async () => {
      rig = await bootCompositionRig({ harnessSlug: 'shl-storm' });
      const { a, b } = rig.cells;
      const HARNESS = 'shl-storm';
      const workspaceId = rig.workspaceId;
      const now = rig.now();

      // Canonical template and membership seeds retain their own CDC scopes.
      // They must survive boot without entering this harness's storm oracle.
      const [seedRows] = await a.sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
         WHERE NOT (workspace_id = ${rig.workspaceId} AND harness_slug = ${HARNESS})`;
      expect(seedRows.n).toBeGreaterThan(0);
      expect(await rig.outboxDepth(a)).toBe(0);

      // ── The storm (set-based, so the test stresses the SYSTEM, not the test). ──
      await a.sql`
        INSERT INTO harness_shared.harness_features_consolidated
          (workspace_id, harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_human_review, ts, created_ts, updated_ts)
        SELECT ${rig.workspaceId}, ${HARNESS}, 'F-S' || lpad(n::text, 5, '0'),
               'storm item ' || n, 'outbox stress storm', 'todo', 0,
               'feature', FALSE, ${now}::bigint + n, ${now}::bigint + n, ${now}::bigint + n
          FROM generate_series(1, ${STORM_INSERTS}) AS n`;
      // An update WAVE over a slice of them (captured again — second op per row).
      await a.sql`
        UPDATE harness_shared.harness_features_consolidated
           SET status = 'in-progress', updated_ts = ${rig.now()}
         WHERE harness_slug = ${HARNESS}
           AND feature_id <= 'F-S' || lpad(${STORM_UPDATES}::text, 5, '0')`;

      const TOTAL_WRITES = STORM_INSERTS + STORM_UPDATES;
      const depthAfterStorm = await rig.outboxDepth(a);
      expect(depthAfterStorm).toBe(TOTAL_WRITES); // every write captured exactly once

      // ── Drain under observation: monotone progress, bounded, to zero. ──
      const stormEnd = Date.now();
      let lastDepth = depthAfterStorm;
      let drives = 0;
      const { drainOutboxOnce } = await import('../sync/hyperbee/outbox-drain');
      while (lastDepth > 0) {
        const drained = await drainOutboxOnce(a.handle, a.sql);
        drives++;
        expect(drained, `drive ${drives}: the drain stalled with ${lastDepth} undrained rows`).toBeGreaterThan(0);
        const depth = await rig.outboxDepth(a);
        expect(depth, `drive ${drives}: depth grew under drain (amplification)`).toBeLessThan(lastDepth);
        lastDepth = depth;
        expect(drives).toBeLessThan(200); // hard runaway stop
      }
      expect(await rig.outboxDepth(a)).toBe(0);

      // NO AMPLIFICATION in the same workspace/harness stream whose pending
      // depth was measured above. Unrelated seed CDC is not a storm write.
      const everRows = await a.sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
         WHERE workspace_id = ${rig.workspaceId} AND harness_slug = ${HARNESS}`;
      expect(Number(everRows[0].n)).toBe(TOTAL_WRITES);

      // CONTROL: one unexpected captured event in the driven stream still
      // fails the exact cumulative oracle. The failed transaction rolls back
      // its write and CDC before the real convergence checks continue.
      const echoAt = rig.now();
      await expect(a.sql.begin(async (tx) => {
        await tx`UPDATE harness_shared.harness_features_consolidated
                    SET title = title || ' unexpected echo', updated_ts = ${echoAt}
                  WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS}
                    AND feature_id = 'F-S00001'`;
        const [withEcho] = await tx<Array<{ n: number }>>`
          SELECT COUNT(*)::int AS n FROM harness_shared.substrate_outbox
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${HARNESS}`;
        expect(withEcho.n).toBe(TOTAL_WRITES);
      })).rejects.toThrow(`expected ${TOTAL_WRITES + 1} to be ${TOTAL_WRITES}`);

      // ── Convergence under load: B ends with EVERY stormed row + fixpoint holds. ──
      const settle = await rig.converge({ maxPasses: 60 });
      const lagMs = Date.now() - stormEnd;
      expect(settle.fixedPoint, 'storm never settled to a held fixed point').toBe(true);
      const onB = await b.sql<Array<{ n: number; in_progress: number }>>`
        SELECT COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE status = 'in-progress')::int AS in_progress
          FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${HARNESS} AND origin = 'remote'`;
      expect(Number(onB[0].n)).toBe(STORM_INSERTS);
      expect(Number(onB[0].in_progress)).toBe(STORM_UPDATES); // the update wave arrived too

      // Compaction runs off the merge gate. A held fixed point can therefore
      // precede its outcome, and a swallowed scope failure must fail this test.
      const compactionOutcomes = () => listBootHistory({
        workspaceId,
        harnessSlug: HARNESS,
        kinds: ['own_log_compaction'],
      }).map((entry) => entry.message ?? '').filter((message) =>
        /^own log compaction: |^log compaction failed/.test(message),
      );
      await expect.poll(compactionOutcomes, { timeout: 60_000 }).not.toHaveLength(0);
      const outcomes = compactionOutcomes();
      expect(outcomes.filter((message) => message.startsWith('log compaction failed')), outcomes.join('\n')).toEqual([]);
      const snapshot = await findLatestCompleteSnapshot(a.handle.ownLog);
      expect(snapshot, 'compaction did not publish a complete snapshot').not.toBeNull();
      expect(snapshot!.coversUpTo).toBeGreaterThanOrEqual(TOTAL_WRITES);

      // The lag is the artifact (the P-013 probe productionizes it); the
      // assertion is only a generous ceiling so a real regression still trips.
       
      console.log(
        `[P-006] storm=${TOTAL_WRITES} writes, drains=${drives}, A-drain+B-converge lag=${(lagMs / 1000).toFixed(1)}s`,
      );
      expect(lagMs).toBeLessThan(120_000);

      // Echo residue: nothing re-enqueued on either side after settle.
      expect(await rig.outboxDepth(a)).toBe(0);
      expect(await rig.outboxDepth(b)).toBe(0);
    },
    240_000,
  );
});
