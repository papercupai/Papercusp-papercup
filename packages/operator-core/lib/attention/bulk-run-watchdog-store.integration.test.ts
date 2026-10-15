/**
 * bulk-run-watchdog-store.integration.test.ts — the P-002 run-watchdog SQL
 * against real Postgres (autonomous-inbox-resolution-2026-08-31, P-002).
 *
 * The watchdog's unit tests (bulk-run-watchdog.test.ts) cover the pure decision
 * core with injected facts. They cannot cover the part most likely to be wrong:
 * the SQL itself. Three shapes here have no unit-test reachability at all —
 *
 *   - `readWatchdogRunRows`'s two LEFT JOIN LATERAL legs, which are selected by
 *     an `ON r.run_kind <> 'plan-cleanup'` / `ON r.run_kind = 'plan-cleanup'`
 *     condition. A join predicate that picks the wrong leg does not error; it
 *     silently reports zero derived counters, which reads as "no drift".
 *     bulk-7d35ee41 — the run that motivated P-002, claiming 5 auto + 19
 *     recommended with ZERO findings rows — is a plan-cleanup run, so the
 *     cleanup leg is the one that actually had to work.
 *   - the findings-leg column set (disposition / recommendation_kind /
 *     retry_condition / error / decided_at), which only exists on
 *     plan_cleanup_run_findings.
 *   - `strandStaleRun`'s staleness predicate, which lives INSIDE the UPDATE's
 *     WHERE rather than in a preceding read.
 *
 * That last one carries this file's falsifiability control. A guard that only
 * ever proves it CAN strand a run is half a guard: the property that matters in
 * production is that it REFUSES to strand a live one, because the failure mode
 * is killing a resolver that was still working. So every stranding assertion
 * here is paired with a live-run control asserting `marked: 0`.
 *
 * Follows the org-fixture mock pattern of bulk-run-store.integration.test.ts:
 * the store routes through `getOrgPg().sql` as the table owner, so we mock it
 * to the fixture's admin (RLS-bypass) client and mock the workspace resolver.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-watchdog-test' }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

const {
  createRun,
  getRun,
  getRunItems,
  setRunPhase,
  unsafeSetRunPhaseForFixtures,
  readWatchdogRunRows,
  reconcileRunCounters,
  strandStaleRun,
  RUN_HEARTBEAT_STALE_MS,
  RESOLVER_ACTIVITY_MAX_SILENCE_MS,
} = await import('./bulk-run-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

/** A three-item inbox snapshot, shaped like what InboxPane posts. */
function seed(prefix: string) {
  return [
    {
      itemId: `coord-escalation:${prefix}-1`,
      kind: 'coord-escalation',
      title: 'Quarantine the flaky gate test?',
      ref: { kind: 'coord-escalation', msgId: `${prefix}-m1` },
      ownerAgentId: 'su-aaa',
    },
    {
      itemId: `work-item-needs-human:${prefix}-2`,
      kind: 'work-item-needs-human',
      title: 'Need the PostHog key',
      ref: { kind: 'work-item-needs-human', workItemId: 'WI-1' },
      ownerAgentId: 'su-bbb',
    },
    {
      itemId: `smoke-fail:${prefix}-3`,
      kind: 'smoke-fail',
      title: 'Desktop smoke red',
      ref: { kind: 'smoke-fail' },
      ownerAgentId: null,
    },
  ];
}

describe('bulk-run watchdog store (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  // Single-flight holds at most one pending/running run per workspace PER KIND,
  // so each test gets its own workspace rather than inheriting a run another
  // test left mid-flight.
  let wsSeq = 0;
  beforeEach(() => {
    wsSeq += 1;
    h.ws = `ws-watchdog-test-${wsSeq}`;
  });

  /** Backdate a run's liveness clock past the stale threshold. */
  async function makeStale(runId: string, ageMs = RUN_HEARTBEAT_STALE_MS * 6) {
    const secs = Math.round(ageMs / 1000);
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_runs
         SET heartbeat_at = now() - make_interval(secs => ${secs}),
             started_at   = now() - make_interval(secs => ${secs}),
             created_at   = now() - make_interval(secs => ${secs})
       WHERE workspace_id = ${h.ws} AND run_id = ${runId}
    `;
  }

  /** Insert one plan-cleanup finding; findings accrue during a run. */
  async function addFinding(
    runId: string,
    findingId: string,
    outcome: string,
    position: number,
  ) {
    await db.adminSql`
      INSERT INTO harness_shared.plan_cleanup_run_findings
        (workspace_id, run_id, finding_id, finding_kind, plan_slug, target,
         from_state, to_state, confidence, evidence, position, outcome)
      VALUES (${h.ws}, ${runId}, ${findingId}, 'flip-to-done', 'some-plan',
              'P-001', 'wip', 'done', 'recommended', '[]'::jsonb,
              ${position}, ${outcome})
    `;
  }

  async function findingRows(runId: string) {
    return await db.adminSql<
      Array<{
        finding_id: string;
        outcome: string;
        disposition: string | null;
        recommendation_kind: string | null;
        retry_condition: string | null;
        error: string | null;
        decided_at: Date | null;
      }>
    >`
      SELECT finding_id, outcome, disposition, recommendation_kind,
             retry_condition, error, decided_at
        FROM harness_shared.plan_cleanup_run_findings
       WHERE workspace_id = ${h.ws} AND run_id = ${runId}
       ORDER BY position
    `;
  }

  function row(rows: Awaited<ReturnType<typeof readWatchdogRunRows>>, runId: string) {
    const found = rows.find((r) => r.runId === runId);
    if (!found) throw new Error(`watchdog rows did not include ${runId}`);
    return found;
  }

  // ---------------------------------------------------------------- read leg

  it('derives an inbox run\'s counters from its OWN item rows, not from the stored columns', async () => {
    const run = await createRun({ items: seed('r1'), harnessSlug: 'papercusp' });
    await setRunPhase({ runId: run.runId, phase: 'running' });

    const items = await getRunItems(run.runId);
    // Two decided, one still pending — the shape the watchdog has to recognise.
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved', decided_at = now(),
             -- migration 1063: new auto_resolved rows must carry a compensation
             -- handle; this fixture never exercises reversal, so a minimal
             -- honest handle satisfies the constraint without claiming more.
             revert_handle = '{"kind":"test-fixture"}'::jsonb,
             reversal_window_until = now() + interval '72 hours'
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
         AND item_id = ${items[0]!.itemId}
    `;
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'recommended', decided_at = now()
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
         AND item_id = ${items[1]!.itemId}
    `;

    const r = row(await readWatchdogRunRows(), run.runId);
    expect(r.runKind).toBe('inbox-resolve');
    expect(r.derived.autoResolved).toBe(1);
    expect(r.derived.recommended).toBe(1);
    expect(r.undecided).toBe(1);
  });

  // This is the leg that bulk-7d35ee41 exercised in production. If the LATERAL
  // ON conditions were swapped or dropped, a cleanup run would read back all
  // zeroes here — indistinguishable from a healthy run with nothing to do.
  it('derives a plan-cleanup run\'s counters from the FINDINGS table, not the items table', async () => {
    const run = await createRun({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: ['some-plan'],
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: run.runId, phase: 'running' });

    await addFinding(run.runId, 'f-1', 'auto_applied', 0);
    await addFinding(run.runId, 'f-2', 'accepted', 1);
    await addFinding(run.runId, 'f-3', 'recommended', 2);
    await addFinding(run.runId, 'f-4', 'pending', 3);

    const r = row(await readWatchdogRunRows(), run.runId);
    expect(r.runKind).toBe('plan-cleanup');
    // auto_applied AND accepted both count as auto-resolved on the cleanup leg;
    // an items-table read would report 0 for every one of these.
    expect(r.derived.autoResolved).toBe(2);
    expect(r.derived.recommended).toBe(1);
    expect(r.undecided).toBe(1);
  });

  it('reports stored-vs-derived DRIFT, which is the bulk-7d35ee41 signature', async () => {
    const run = await createRun({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: ['some-plan'],
      harnessSlug: 'papercusp',
    });
    // The production shape exactly: counters claim work that has no rows.
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_runs
         SET auto_resolved = 5, recommended = 19
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
    `;

    const r = row(await readWatchdogRunRows(), run.runId);
    expect(r.stored.autoResolved).toBe(5);
    expect(r.stored.recommended).toBe(19);
    // ZERO findings rows exist, so the derivation must say so rather than
    // echoing the stored columns back.
    expect(r.derived.autoResolved).toBe(0);
    expect(r.derived.recommended).toBe(0);

    await reconcileRunCounters(run.runId);

    const after = row(await readWatchdogRunRows(), run.runId);
    expect(after.stored.autoResolved).toBe(0);
    expect(after.stored.recommended).toBe(0);
  });

  it('reconciles an inbox run\'s drifted counters back to its item rows', async () => {
    const run = await createRun({ items: seed('r4'), harnessSlug: 'papercusp' });
    const items = await getRunItems(run.runId);
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved', decided_at = now(),
             -- migration 1063: new auto_resolved rows must carry a compensation
             -- handle; this fixture never exercises reversal, so a minimal
             -- honest handle satisfies the constraint without claiming more.
             revert_handle = '{"kind":"test-fixture"}'::jsonb,
             reversal_window_until = now() + interval '72 hours'
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
         AND item_id = ${items[0]!.itemId}
    `;
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_runs SET auto_resolved = 99
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
    `;

    expect(row(await readWatchdogRunRows(), run.runId).stored.autoResolved).toBe(99);
    await reconcileRunCounters(run.runId);
    expect(row(await readWatchdogRunRows(), run.runId).stored.autoResolved).toBe(1);
  });

  // ------------------------------------------------------------- strand leg

  it('strands a STALE inbox run: phase fails, pending items become retryable', async () => {
    const run = await createRun({ items: seed('s1'), harnessSlug: 'papercusp' });
    await setRunPhase({ runId: run.runId, phase: 'running' });

    const items = await getRunItems(run.runId);
    // One genuinely decided item, which must survive untouched.
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_run_items
         SET outcome = 'auto_resolved', disposition = 'auto_resolved', decided_at = now(),
             revert_handle = '{"kind":"test-fixture"}'::jsonb,
             reversal_window_until = now() + interval '72 hours'
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
         AND item_id = ${items[0]!.itemId}
    `;
    await makeStale(run.runId);

    const res = await strandStaleRun({ runId: run.runId, reason: 'resolver went away' });
    expect(res.phase).toBe('failed');
    expect(res.marked).toBe(2); // the two still-pending items, not all three

    const after = await getRunItems(run.runId);
    const byId = new Map(after.map((i) => [i.itemId, i]));

    // The dead resolver's actual achievement survives.
    expect(byId.get(items[0]!.itemId)!.outcome).toBe('auto_resolved');

    // The abandoned ones say what the honest next step is, which is what lets a
    // report distinguish "judged unresolvable" from "nobody ever looked".
    const stranded = byId.get(items[1]!.itemId)!;
    expect(stranded.outcome).toBe('failed');
    expect(stranded.recommendationKind).toBe('retry_needed');

    // Failing is RECOVERABLE: restartRun accepts phase 'failed'.
    expect((await getRun(run.runId))?.phase).toBe('failed');
  });

  // FALSIFIABILITY CONTROL. Without this, every assertion above would still
  // pass if the staleness predicate were deleted from the WHERE — the guard
  // would strand everything, including live resolvers, and look green.
  it('REFUSES to strand a LIVE inbox run — marked:0, phase untouched', async () => {
    const run = await createRun({ items: seed('s2'), harnessSlug: 'papercusp' });
    await setRunPhase({ runId: run.runId, phase: 'running' });
    // Deliberately NOT backdated: a fresh heartbeat means a working resolver.
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_runs SET heartbeat_at = now()
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
    `;

    const res = await strandStaleRun({ runId: run.runId, reason: 'should not fire' });
    expect(res.marked).toBe(0);
    expect(res.phase).toBe(null);

    // Nothing moved: the run is still running and every item still pending.
    expect((await getRun(run.runId))?.phase).toBe('running');
    const after = await getRunItems(run.runId);
    expect(after.every((i) => i.outcome === 'pending')).toBe(true);
    expect(after.every((i) => i.error === null)).toBe(true);
  });

  // WI-10004887: the heartbeat is one witness, not the only one. The strand write
  // itself must re-check the resolver's own activity, so a resolver that acts
  // between the watchdog's read and this UPDATE wins the race like a heartbeat.
  describe('resolver activity re-checked inside the strand write (WI-10004887)', () => {
    // Default 10m: stale for the heartbeat rule, well inside the 30m ceiling.
    // (makeStale's own default is 30m, which sits exactly on that ceiling.)
    async function staleRunOwnedBy(prefix: string, owner: string, ageMs = RUN_HEARTBEAT_STALE_MS * 2) {
      const run = await createRun({ items: seed(prefix), harnessSlug: 'papercusp' });
      await setRunPhase({ runId: run.runId, phase: 'running' });
      await makeStale(run.runId, ageMs);
      await db.adminSql`
        UPDATE harness_shared.attention_bulk_runs SET resolver_owner = ${owner}
         WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
      `;
      return run;
    }

    it('REFUSES while the resolver has a fresh agent_activity row (busy on non-run tools)', async () => {
      const owner = `su-busy-activity-${h.ws}`;
      const run = await staleRunOwnedBy('r1', owner);
      await db.adminSql`
        INSERT INTO harness_shared.agent_activity (owner_id, kind) VALUES (${owner}, 'tool')
      `;
      const res = await strandStaleRun({ runId: run.runId, reason: 'should not fire' });
      expect(res).toEqual({ marked: 0, phase: null });
      expect((await getRun(run.runId))?.phase).toBe('running');
    });

    it('REFUSES while the resolver has a fresh tool_invocations row (polling its inbox)', async () => {
      const owner = `su-busy-tools-${h.ws}`;
      const run = await staleRunOwnedBy('r2', owner);
      await db.adminSql`
        INSERT INTO harness_shared.tool_invocations
               (workspace_id, harness_slug, plugin_name, role, spawn_id, status, tool_name, window_key, coord_owner_id, invoked_at)
        VALUES (${h.ws}, 'papercusp', 'agent-mcp', 'su', 'spawn-test', 'ok', 'coord:inbox', 'w', ${owner}, now())
      `;
      const res = await strandStaleRun({ runId: run.runId, reason: 'should not fire' });
      expect(res.marked).toBe(0);
      expect((await getRun(run.runId))?.phase).toBe('running');
    });

    it('STRANDS once the resolver itself went quiet past the heartbeat threshold', async () => {
      const owner = `su-quiet-${h.ws}`;
      const run = await staleRunOwnedBy('r3', owner);
      const secs = Math.round((RUN_HEARTBEAT_STALE_MS * 2) / 1000);
      await db.adminSql`
        INSERT INTO harness_shared.agent_activity (owner_id, kind, created_at)
        VALUES (${owner}, 'tool', now() - make_interval(secs => ${secs}))
      `;
      const res = await strandStaleRun({ runId: run.runId, reason: 'resolver went quiet' });
      expect(res.phase).toBe('failed');
      expect(res.marked).toBe(3);
    });

    it('STRANDS a resolver that NEVER acted — no agent_activity and no tool_invocations rows at all', async () => {
      // Measured 2026-10-01 (bulk-e6dc3abf): a codex resolver that never took its
      // kickoff turn has no activity rows, the scalar activity subquery is NULL, and
      // NOT(NULL) refused the strand on every sweep until the 30m ceiling.
      const owner = `su-never-acted-${h.ws}`;
      const run = await staleRunOwnedBy('r5', owner);
      const res = await strandStaleRun({ runId: run.runId, reason: 'resolver never acted' });
      expect(res.phase).toBe('failed');
      expect(res.marked).toBe(3);
    });

    it('STRANDS a busy resolver once the run has had no heartbeat past the silence ceiling', async () => {
      const owner = `su-busy-elsewhere-${h.ws}`;
      const run = await staleRunOwnedBy('r4', owner, RESOLVER_ACTIVITY_MAX_SILENCE_MS + 60_000);
      await db.adminSql`
        INSERT INTO harness_shared.agent_activity (owner_id, kind) VALUES (${owner}, 'tool')
      `;
      const res = await strandStaleRun({ runId: run.runId, reason: 'run not advancing' });
      expect(res.phase).toBe('failed');
      expect(res.marked).toBe(3);
    });

    it('readWatchdogRunRows exposes the resolver owner the action looks up', async () => {
      const owner = `su-row-${h.ws}`;
      const run = await staleRunOwnedBy('r5', owner);
      const rows = await readWatchdogRunRows();
      expect(rows.find((r) => r.runId === run.runId)?.resolverOwner).toBe(owner);
    });
  });

  it('strands a STALE plan-cleanup run through the FINDINGS table', async () => {
    const run = await createRun({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: ['some-plan'],
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: run.runId, phase: 'running' });
    await addFinding(run.runId, 'g-1', 'auto_applied', 0);
    await addFinding(run.runId, 'g-2', 'pending', 1);
    await addFinding(run.runId, 'g-3', 'pending', 2);
    await makeStale(run.runId);

    const res = await strandStaleRun({ runId: run.runId, reason: 'cleanup resolver died' });
    expect(res.phase).toBe('failed');
    expect(res.marked).toBe(2);

    const rows = await findingRows(run.runId);
    const decided = rows.find((r) => r.finding_id === 'g-1')!;
    // The applied finding is untouched — no disposition/error backfilled onto it.
    expect(decided.outcome).toBe('auto_applied');
    expect(decided.error).toBe(null);

    // Every findings-leg column the UPDATE names must actually exist and be set;
    // this is the assertion that would have caught a wrong column name.
    for (const id of ['g-2', 'g-3']) {
      const f = rows.find((r) => r.finding_id === id)!;
      expect(f.outcome).toBe('failed');
      expect(f.disposition).toBe('failed');
      expect(f.recommendation_kind).toBe('retry_needed');
      expect(f.retry_condition).toBe('restart the run');
      expect(f.error).toBe('cleanup resolver died');
      expect(f.decided_at).not.toBe(null);
    }
  });

  // The cleanup-leg half of the falsifiability control above.
  it('REFUSES to strand a LIVE plan-cleanup run — findings untouched', async () => {
    const run = await createRun({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: ['some-plan'],
      harnessSlug: 'papercusp',
    });
    await setRunPhase({ runId: run.runId, phase: 'running' });
    await addFinding(run.runId, 'l-1', 'pending', 0);
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_runs SET heartbeat_at = now()
       WHERE workspace_id = ${h.ws} AND run_id = ${run.runId}
    `;

    const res = await strandStaleRun({ runId: run.runId, reason: 'should not fire' });
    expect(res.marked).toBe(0);
    expect(res.phase).toBe(null);

    const rows = await findingRows(run.runId);
    expect(rows[0]!.outcome).toBe('pending');
    expect(rows[0]!.error).toBe(null);
  });

  it('leaves an ALREADY-TERMINAL run alone even when it is ancient', async () => {
    const run = await createRun({ items: seed('t1'), harnessSlug: 'papercusp' });
    await setRunPhase({ runId: run.runId, phase: 'running' });
    await unsafeSetRunPhaseForFixtures({ runId: run.runId, phase: 'complete' });
    await makeStale(run.runId);

    // The WHERE restricts to phase IN ('pending','running'), so a finished run
    // can never be re-failed by a late watchdog pass.
    const res = await strandStaleRun({ runId: run.runId, reason: 'late pass' });
    expect(res.marked).toBe(0);
    expect(res.phase).toBe(null);
    expect((await getRun(run.runId))?.phase).toBe('complete');
  });
});
