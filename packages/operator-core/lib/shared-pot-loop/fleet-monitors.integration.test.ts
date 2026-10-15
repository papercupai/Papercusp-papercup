/**
 * fleet-monitors.integration.test.ts — P-012 + P-013 of
 * `shared-hive-loop-e2e-testing-2026-06-10` on the hermetic 2-swarm rig: the
 * monitors run against REAL failure states the Phase-1 scenarios proved are
 * reachable, not fabricated rows.
 *
 *  1. P-012 double-completion detector — swarm B holds a LIVE lease on an
 *     item; swarm A settles it anyway and the terminal write federates in
 *     (origin remote). The scanner on B fires with both sides' forensics;
 *     declaring redundancy silences it; the completing swarm stays quiet.
 *  2. P-013 orphaned-taken_by sweep — the EXACT P-003 starvation state (dead
 *     holder's taken_by federated, no live lease row, claim_next blind):
 *     the sweep returns the item to the backlog and claim_next can claim it
 *     again — the starvation fix, proven end to end.
 *  3. P-013 outbox health — undrained depth/age vs SLO, breach and recovery.
 *  4. P-013 convergence-lag probe — write-on-A / arrive-on-B with SLO.
 *  5. The aggregated monitor pass collects incidents through the injected
 *     fileIncident sink (the routine-body shape the scheduling home runs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootCompositionRig, type CompositionRig } from './composition-rig';
import {
  measureConvergenceLag,
  runSharedHiveMonitorPass,
  scanDoubleCompletionSignals,
  scanOutboxHealth,
  sweepOrphanedTakenBy,
  type MonitorIncident,
} from './fleet-monitors';

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

beforeEach(() => {
  // A release now reaches the real await-event delivery path in this faithful
  // fixture. The engine deliberately narrates successful wake outcomes through
  // console.warn; await-event integration suites suppress that expected noise
  // under the global fail-on-console guard.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('P-012 + P-013 — the live-fleet monitor family on real failure states', () => {
  it(
    'double-completion scanner fires on the contested item; orphan sweep unblocks the P-003 starvation; outbox + lag probes judge SLOs; the pass aggregates',
    async () => {
      rig = await bootCompositionRig({ harnessSlug: 'shl-mon' });
      const { a, b } = rig.cells;
      const HARNESS = 'shl-mon';
      const { acquireClaimLocal } = await import('../work-item-claims');

      // F-504 is a DECLARED fan-out (redundancy=2, federates with the row) —
      // the same double-completion shape must stay quiet for it.
      await rig.seedBacklog(a, [{ id: 'F-501' }, { id: 'F-502' }, { id: 'F-504', redundancy: 2 }]);
      expect((await rig.converge()).fixedPoint).toBe(true);

      // ════ 1. P-012: the double-completion state ════
      // B takes LIVE leases on F-501 and F-504 in ITS local claims table…
      for (const id of ['F-501', 'F-504']) {
        const bClaim = await rig.runAsCell(b, () =>
          acquireClaimLocal({
            workspaceId: rig!.workspaceId,
            harnessSlug: HARNESS,
            workItemId: id,
            owner: b.owner,
            holderPubkey: b.electionPubkey,
            intent: `monitor-test: B believes it owns ${id}`,
          }),
        );
        expect(bClaim.ok).toBe(true);
      }
      // …and swarm A settles BOTH anyway; the completions federate in.
      await rig.runFakePipeline(a, 'F-501');
      await rig.runFakePipeline(a, 'F-504');
      expect((await rig.converge()).fixedPoint).toBe(true);

      const signals = await scanDoubleCompletionSignals(b.sql, { workspaceId: rig.workspaceId, harness: HARNESS });
      // Fires for the exactly-once item ONLY — the declared fan-out stays quiet.
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        workItemId: 'F-501',
        localClaim: { owner: b.owner, holderPubkey: b.electionPubkey },
        remote: { status: 'passed' },
      });
      // Forensics carry the remote author (A's announce identity), not ours.
      expect(signals[0].remote.authorPubkey).toBeTruthy();
      expect(signals[0].remote.authorPubkey).not.toBe(b.electionPubkey);
      // The COMPLETING swarm sees nothing (its row is origin local, no foreign lease).
      expect(await scanDoubleCompletionSignals(a.sql, { workspaceId: rig.workspaceId, harness: HARNESS })).toEqual([]);

      // ════ 2. P-013: the orphaned-taken_by sweep (the P-003 starvation fix) ════
      // The starved state: A claims F-502 (taken_by federates), then dies — its
      // mem-store lease is invisible to PG and lapses with it; the PG claims
      // table holds no live row; claim_next on B is blind to the item forever.
      const cA = await rig.claimNext(a);
      expect(cA?.item.id).toBe('F-502');
      expect((await rig.converge()).fixedPoint).toBe(true);
      expect(await rig.claimNext(b), 'precondition: claim_next must be starved').toBeNull();

      // B (re-elected authority in the P-003 continuation) runs the sweep —
      // nowMs is advanced past the grace window instead of sleeping.
      const swept = await sweepOrphanedTakenBy(b.sql, {
        workspaceId: rig.workspaceId,
        harness: HARNESS,
        nowMs: Date.now() + 6 * 60_000,
      });
      expect(swept.cleared).toHaveLength(1);
      expect(swept.cleared[0]).toMatchObject({ workItemId: 'F-502', takenBy: a.owner });
      // The starvation is broken: claim_next can take the item again.
      const reclaimed = await rig.claimNext(b);
      expect(reclaimed?.item.id).toBe('F-502');
      await rig.runFakePipeline(b, 'F-502');

      // ════ 3. P-013: outbox health ════
      // The pipeline writes above left fresh undrained rows on B.
      const tight = await scanOutboxHealth(b.sql, {
        maxDepth: 0, maxAgeMs: 1, workspaceId: rig.workspaceId, harness: HARNESS,
      });
      expect(tight.undrainedDepth).toBeGreaterThan(0);
      expect(tight.breaches.length).toBeGreaterThan(0);
      expect((await rig.converge()).fixedPoint).toBe(true);
      // Canonical cells retain template-plan and pot-member CDC in other
      // scopes. Judge the same harness stream that converge() actually drains.
      const healthy = await scanOutboxHealth(b.sql, {
        maxDepth: 10_000, maxAgeMs: 30 * 60_000, workspaceId: rig.workspaceId, harness: HARNESS,
      });
      expect(healthy.undrainedDepth).toBe(0);
      expect(healthy.breaches).toEqual([]);

      // Regression for EI-7179: orphaned / unbooted scopes can legitimately sit
      // in substrate_outbox until the global backstop GC horizon. A monitor pass
      // for one live hive must not file an outbox-health incident for another
      // harness's debris.
      await b.sql`
        INSERT INTO harness_shared.substrate_outbox
          (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
        VALUES
          (${rig.workspaceId}, 'other-harness', 'harness_features', 'put', 'F-OTHER', '{}'::jsonb,
           ${Date.now() - 60 * 60_000}, NULL)`;
      const globalOther = await scanOutboxHealth(b.sql, { maxDepth: 0, maxAgeMs: 1 });
      expect(globalOther.undrainedDepth).toBeGreaterThan(0);
      const scopedOther = await scanOutboxHealth(b.sql, {
        maxDepth: 0,
        maxAgeMs: 1,
        workspaceId: rig.workspaceId,
        harness: HARNESS,
      });
      expect(scopedOther.undrainedDepth).toBe(0);

      // Regression for EI-21009625512310918: a QUARANTINED row (WI-3896's
      // poison-row triage, mig 645) is DELIBERATELY left undrained forever —
      // it must not count toward this scan's depth/age SLO, exactly as
      // `load-drain-stats.ts`'s `loadSubstrateDrainStats` already excludes it
      // over the same table. Before the fix this ancient quarantined row alone
      // made a fully-healthy harness report a permanent, ever-worsening
      // outbox-health breach.
      await b.sql`
        INSERT INTO harness_shared.substrate_outbox
          (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at, quarantined_at)
        VALUES
          (${rig.workspaceId}, ${HARNESS}, 'harness_features', 'put', 'F-POISON', '{}'::jsonb,
           ${Date.now() - 60 * 60_000}, NULL, ${Date.now() - 30 * 60_000})`;
      const quarantineExcluded = await scanOutboxHealth(b.sql, {
        maxDepth: 0,
        maxAgeMs: 1,
        workspaceId: rig.workspaceId,
        harness: HARNESS,
      });
      expect(quarantineExcluded.undrainedDepth).toBe(0);
      expect(quarantineExcluded.oldestUndrainedAgeMs).toBeNull();
      expect(quarantineExcluded.breaches).toEqual([]);

      // ════ 4. P-013: the convergence-lag probe ════
      const probe = await measureConvergenceLag({
        write: async () => {
          await rig!.seedBacklog(a, [{ id: 'F-PROBE' }]);
        },
        arrived: async () => {
          await rig!.converge({ maxPasses: 1 });
          const rows = await b.sql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM harness_shared.harness_features_consolidated
             WHERE harness_slug = ${HARNESS} AND feature_id = 'F-PROBE'`;
          return Number(rows[0].n) > 0;
        },
        sloMs: 30_000,
        pollMs: 100,
      });
      expect(probe.arrived).toBe(true);
      expect(probe.breach).toBe(false);

      // ════ 5. The aggregated pass through the injected incident sink ════
      const filed: MonitorIncident[] = [];
      const report = await runSharedHiveMonitorPass({
        sql: b.sql,
        workspaceId: rig.workspaceId,
        harness: HARNESS,
        isAuthority: true,
        presence: [{ devicePubkey: a.electionPubkey, lastSeenMs: Date.now() - 60 * 60_000 }],
        liveLeases: [{ workItemId: 'F-501', holderPubkey: a.electionPubkey, expiresTsMs: Date.now() + 60_000 }],
        slo: { outboxMaxDepth: 10_000, outboxMaxAgeMs: 30 * 60_000, presenceStaleMs: 10 * 60_000 },
        fileIncident: async (i) => {
          filed.push(i);
        },
      });
      const kinds = report.incidents.map((i) => i.kind).sort();
      expect(kinds).toContain('double-completion'); // F-501 is still contested on B
      expect(kinds).toContain('presence-ghost'); // the dead swarm anchors a live lease
      expect(kinds).not.toContain('outbox-health'); // unrelated harness debris is outside this pass
      expect(filed).toEqual(report.incidents); // every incident reached the sink

      // ════ 6. The peer-federation leg RAN — it did not silently stop covering ════
      // EI-20617273180156712. This leg catches its OWN scan errors and degrades to
      // unmeasured (by design — a throw here would take the whole pass down with
      // it). The cost of that design is that a fixture which drifts behind the
      // reader stops measuring while this suite stays green: first as 42P01 when
      // substrate_merge_cursor was absent entirely (why migration 493 is loaded
      // into the rig), and now as 42703 if 685's `apply_binding` were missing,
      // since the judge selects that column to separate live cursors from residue.
      //
      // So assert the INSTRUMENT worked, not the reading. `measured:false` is a
      // legitimate outcome here (this rig federates no remote logs); 'scan-failed'
      // never is — it means the query itself broke.
      expect(report.peers.unmeasuredReason).not.toBe('scan-failed');
      expect(report.peers.scanError).toBeUndefined();
      // Pin the value actually observed, so the assertion above cannot pass
      // vacuously against some future undefined/renamed field. 'own-log-only'
      // and 'own-log-unknown' joined the set when the judge stopped counting our
      // OWN log as a peer: this rig boots no remote logs, so own-log-only is its
      // honest steady state, and own-log-unknown is what it reports when no
      // substrate_booted_handles_status row exists to identify the own log.
      expect([
        null,
        'no-remote-logs',
        'scope-dormant',
        'own-log-only',
        'own-log-unknown',
      ]).toContain(report.peers.unmeasuredReason);
    },
    240_000,
  );
});
