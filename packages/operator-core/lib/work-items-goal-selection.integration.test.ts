import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', async (original) => ({
  ...(await original<object>()), activeWorkspaceId: () => 'default',
}));
const { createOrgTestDb } = await import('../test/_org-test-db');
const wi = await import('./work-items');
const { claimIssue } = await import('./issues-engineer');
const { getNextWorkItem, getNextWorkItemDefault } = await import('./scheduler/get-next');
const { getNextForBee } = await import('./scheduler/claim-spec-store');
const { DEFAULT_CLAIM_SPEC } = await import('./scheduler/claim-spec');
const { claimNextAgentReview, claimNextVerificationTask, claimNextVerificationWork } = await import('./harness/improvements/agent-review');
const { lockGoalPlanClaimSelections, applyGoalPropertyWrite } = await import('./typed-properties-db');
const { createFleetIfAbsent, claimFleetLaunchSlot } = await import('./agent-fleets-store');
const { createVerificationTask } = await import('./harness/improvements/agent-review-policy');
const { ensureOrderedSelectionPolicyDatatype } = await import('./goals/package-property-datatypes');

const WS = 'default';
const H = 'collection-claim-fixture';
const GOAL = 'collection-claim-goal';
const EXCLUDED = `plan:${H}/excluded`;
const SELECTED = `plan:${H}/selected`;
const definition = {
  worklist: { datatype: 'plan-ref-list', editable_by: 'both', default: [EXCLUDED, SELECTED],
    collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
      selectable: true, defaultSelected: true } },
  worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
    default: { order: [], excluded: [] } },
};
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  await ensureOrderedSelectionPolicyDatatype(h.sql, WS);
}, 120_000);
afterAll(async () => { setFlagOverridesForTest({}); await db?.cleanup(); });
beforeEach(async () => {
  await h.sql`DELETE FROM harness_shared.work_items WHERE harness_slug = ${H}`;
  await h.sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${H}`;
  await h.sql`DELETE FROM harness_shared.goals WHERE id = ${GOAL}`;
  await h.sql`INSERT INTO harness_shared.goals (workspace_id, id, install_slug, title, status, property_schema)
    VALUES (${WS}, ${GOAL}, ${H}, 'Generic ordered plan fixture', 'active', ${JSON.stringify(definition)}::jsonb)`;
  for (const slug of ['excluded', 'selected']) {
    await h.sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, op_status, goal_id)
      VALUES (${WS}, ${H}, ${slug}, ${slug}, 'ready', NULL, ${GOAL})`;
  }
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false });
  await policy([EXCLUDED]);
});

async function policy(excluded: string[], order: string[] = []) {
  return h.sql.begin(async (tx) => {
    const [goal] = await tx`SELECT properties FROM harness_shared.goals
      WHERE workspace_id = ${WS} AND id = ${GOAL} FOR UPDATE`;
    const result = await applyGoalPropertyWrite(tx as unknown as postgres.Sql, {
      workspaceId: WS, goalId: GOAL, property: 'worklist_policy', value: { excluded, order },
      expectedVersion: goal.properties.worklist_policy?.version ?? 0, provenance: 'owner-edit', actorId: 'owner-ui',
    });
    expect(result.ok).toBe(true);
    return result;
  });
}

async function seed(id: string, kind = 'feature', plan = 'excluded', holder: string | null = null,
  payload: Record<string, unknown> = {}) {
  await h.sql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, status, admission, goal_id,
      source_plan_slug, taken_by, created_ts, updated_ts, payload)
    VALUES (${WS}, ${H}, ${id}, ${kind}, ${id}, 'open', 'admitted', ${GOAL}, ${plan}, ${holder},
      ${plan === 'excluded' ? 1 : 2}, 0, ${JSON.stringify(payload)}::jsonb)`;
}

describe('canonical goal selection at new-work claim boundaries', () => {
  it.each(['feature', 'bug'])('refuses by-id %s, while selected work remains claimable', async (kind) => {
    await seed('WI-excluded', kind);
    await seed('WI-selected', kind, 'selected');
    expect(await wi.claimWorkItem('WI-excluded', 'worker', { harness: H })).toBeNull();
    expect((await wi.claimWorkItem('WI-selected', 'worker', { harness: H }))?.id).toBe('WI-selected');
  });

  it('the bottom issue writer also refuses direct calls', async () => {
    await seed('EI-excluded', 'bug');
    expect(await claimIssue('EI-excluded', 'worker', { workspaceId: WS })).toBeNull();
    await seed('EI-selected', 'bug', 'selected');
    expect((await claimIssue('EI-selected', 'worker', { workspaceId: WS }))?.id).toBe('EI-selected');
  });

  it.each(['feature', 'bug'] as const)('creating a born-assigned %s cannot bypass the exclusion', async (kind) => {
    await expect(wi.createWorkItem({ kind, id: 'WI-born', harness: H, workspaceId: WS,
      title: 'Born assigned fixture', sourcePlanSlug: 'excluded', assignee: 'worker', createdBy: 'worker' }))
      .rejects.toThrow('goal_plan_excluded');
    const rows = await h.sql`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND feature_id = 'WI-born'`;
    expect(rows).toHaveLength(0);
    const selected = await wi.createWorkItem({ kind, id: 'WI-born-selected', harness: H, workspaceId: WS,
      title: 'Selected born assigned fixture', sourcePlanSlug: 'selected', assignee: 'worker', createdBy: 'worker' });
    expect(selected).toMatchObject({ id: 'WI-born-selected', assignee: 'worker' });
  });

  it('a new reservation and an orphan reservation rebind cannot bypass exclusion', async () => {
    const payload = { plan_item: { harness_slug: H, plan_slug: 'excluded', item_id: 'P-001' }, fleet_slug: 'orphan' };
    await expect(wi.createWorkItem({ kind: 'feature', id: 'WI-reserved-born', harness: H, workspaceId: WS,
      title: 'Reserved fixture', sourcePlanSlug: 'excluded', payload, createdBy: 'launcher' }))
      .rejects.toThrow('goal_plan_excluded');
    await seed('WI-reserved', 'feature', 'excluded', null, payload);
    expect(await wi.rebindOrphanedPlanFleetReservation({ id: 'WI-reserved', harness: H, workspaceId: WS,
      fleetSlug: 'new-fleet' })).toBe(false);
    const [row] = await h.sql`SELECT payload FROM harness_shared.work_items WHERE feature_id = 'WI-reserved'`;
    expect(row.payload.fleet_slug).toBe('orphan');
    await seed('WI-reserved-selected', 'feature', 'selected', null,
      { plan_item: { harness_slug: H, plan_slug: 'selected', item_id: 'P-001' }, fleet_slug: 'orphan' });
    expect(await wi.rebindOrphanedPlanFleetReservation({ id: 'WI-reserved-selected', harness: H, workspaceId: WS,
      fleetSlug: 'new-fleet' })).toBe(true);
  });

  it('final fleet registry placement rejects an excluded goal-stamped plan before reservation', async () => {
    await expect(createFleetIfAbsent({ workspaceId: WS, fleetSlug: 'excluded-plan-fleet', owner: 'launcher',
      planSelection: { harness: H, planSlug: 'excluded', goalId: GOAL, actorId: 'launcher' } }, h.sql))
      .rejects.toThrow('goal_plan_excluded');
    const rows = await h.sql`SELECT fleet_slug FROM harness_shared.agent_fleets
      WHERE workspace_id = ${WS} AND fleet_slug = 'excluded-plan-fleet'`;
    expect(rows).toHaveLength(0);
  });

  it('an existing fleet cannot take a launch slot from a stale selected portfolio', async () => {
    await policy([]);
    await createFleetIfAbsent({ workspaceId: WS, fleetSlug: 'existing-plan-fleet', owner: 'launcher' }, h.sql);
    await policy([EXCLUDED]);
    await expect(claimFleetLaunchSlot({ workspaceId: WS, fleetSlug: 'existing-plan-fleet', count: 1,
      windowMs: 30_000, sql: h.sql,
      planSelection: { harness: H, planSlug: 'excluded', goalId: GOAL, actorId: 'launcher' } }))
      .rejects.toThrow('goal_plan_excluded');
    const [row] = await h.sql`SELECT last_launch_at FROM harness_shared.agent_fleets
      WHERE workspace_id = ${WS} AND fleet_slug = 'existing-plan-fleet'`;
    expect(row.last_launch_at).toBeNull();
  });

  it.each(['feature', 'bug'])('claim_next skips excluded %s even when it is oldest', async (kind) => {
    await seed('WI-excluded', kind);
    await seed('WI-selected', kind, 'selected');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'worker' }))?.id).toBe('WI-selected');
  });

  it('the direct issue next-pick refuses an excluded-only queue', async () => {
    await seed('EI-excluded', 'bug');
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'worker' }, WS)).toBeNull();
    await seed('EI-selected', 'bug', 'selected');
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'worker' }, WS))?.id).toBe('EI-selected');
  });

  it.each(['feature', 'bug'])('the spec-driven scheduler preserves exclusion for %s', async (kind) => {
    await seed('WI-excluded', kind);
    await seed('WI-selected', kind, 'selected');
    const result = await getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: 'worker' },
      { harness: H, workspaceId: WS, client: h.sql });
    expect(result?.workItem.id).toBe('WI-selected');
  });

  it('the standing-drain wrapper cannot pick an excluded goal-stamped plan', async () => {
    await seed('WI-excluded');
    expect(await getNextForBee({ cupId: 'drainer', harness: H, workspaceId: WS, ignoreStoredSpec: true })).toBeNull();
    await seed('WI-selected', 'feature', 'selected');
    expect((await getNextForBee({ cupId: 'drainer', harness: H, workspaceId: WS, ignoreStoredSpec: true }))?.workItem.id)
      .toBe('WI-selected');
  });

  it.each(['feature', 'bug'])('the default scheduler skips excluded %s and claims its selected control', async (kind) => {
    await seed('WI-excluded', kind);
    await seed('WI-selected', kind, 'selected');
    const result = await getNextWorkItemDefault({ assignee: 'worker' },
      { harness: H, workspaceId: WS, client: h.sql });
    expect(result?.workItem.id).toBe('WI-selected');
  });

  it('the pending-review picker reaches the real claim writer for excluded and selected plans', async () => {
    const review = { agentReview: { status: 'pending', submittedBy: 'author', ledgerIdeaId: 'EI-review', round: 2 } };
    await seed('EI-review-excluded', 'change', 'excluded', null, review);
    expect(await claimNextAgentReview({ reviewer: 'reviewer', harnessSlug: H })).toBeNull();
    await seed('EI-review-selected', 'change', 'selected', null, review);
    expect((await claimNextAgentReview({ reviewer: 'reviewer', harnessSlug: H }))?.id).toBe('EI-review-selected');
    const [excluded] = await h.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'EI-review-excluded'`;
    expect(excluded.taken_by).toBeNull();
  });

  it.each(['task', 'work'])('verification %s delegation cannot claim an excluded plan', async (path) => {
    await seed('WI-excluded', 'feature', 'excluded', null,
      { verification: createVerificationTask({ subject: 'WI-subject', check: 'reproduction',
        reporters: ['author'], implementers: ['author'] }) });
    const result = path === 'task'
      ? await claimNextVerificationTask({ verifier: 'verifier', harnessSlug: H })
      : await claimNextVerificationWork({ verifier: 'verifier', harnessSlug: H });
    expect(result).toBeNull();
    await seed('WI-selected', 'feature', 'selected', null,
      { verification: createVerificationTask({ subject: 'WI-subject', check: 'reproduction',
        reporters: ['author'], implementers: ['author'] }) });
    const control = path === 'task'
      ? await claimNextVerificationTask({ verifier: 'verifier', harnessSlug: H })
      : await claimNextVerificationWork({ verifier: 'verifier', harnessSlug: H });
    expect(control && ('workItem' in control ? control.workItem.id : control.id)).toBe('WI-selected');
  });

  it('owner order wins over source age and a scheduler rank', async () => {
    await policy([], [SELECTED, EXCLUDED]);
    await seed('WI-old');
    await seed('WI-priority', 'feature', 'selected');
    expect((await wi.claimNextWorkItem({ harness: H, assignee: 'worker' }))?.id).toBe('WI-priority');
    await wi.releaseWorkItem('WI-priority', { harness: H });
    const result = await getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: 'other-worker' },
      { harness: H, workspaceId: WS, client: h.sql });
    expect(result?.workItem.id).toBe('WI-priority');
  });

  it('owner priority cannot bypass an unmet plan dependency or starve a later eligible plan', async () => {
    await policy([], [EXCLUDED, SELECTED]);
    const items = [
      { id: 'P-001', status: 'todo', text: 'Blocked work', blockedBy: ['P-000'] },
      { id: 'P-000', status: 'todo', text: 'Prerequisite', blockedBy: [] },
    ];
    await h.sql`UPDATE harness_shared.harness_plans SET items = ${JSON.stringify(items)}::text::jsonb
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = 'excluded'`;
    await seed('WI-blocked', 'feature', 'excluded', null,
      { plan_item: { harness_slug: H, plan_slug: 'excluded', item_id: 'P-001' } });
    await seed('WI-eligible', 'feature', 'selected');

    const picked = await getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: 'worker' },
      { harness: H, workspaceId: WS, client: h.sql });
    expect(picked?.workItem.id).toBe('WI-eligible');
    const [blocked] = await h.sql`SELECT taken_by FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = 'WI-blocked'`;
    expect(blocked.taken_by).toBeNull();

    items[1].status = 'done';
    await h.sql`UPDATE harness_shared.harness_plans SET items = ${JSON.stringify(items)}::text::jsonb
      WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = 'excluded'`;
    await wi.releaseWorkItem('WI-eligible', { harness: H });
    const unblocked = await getNextWorkItem(DEFAULT_CLAIM_SPEC, { assignee: 'worker' },
      { harness: H, workspaceId: WS, client: h.sql });
    expect(unblocked?.workItem.id).toBe('WI-blocked');
  });

  it('a peer hold remains authoritative and an existing holder may finish after exclusion', async () => {
    await seed('WI-current', 'feature', 'excluded', 'worker');
    expect((await wi.claimWorkItem('WI-current', 'worker', { harness: H }))?.id).toBe('WI-current');
    expect(await wi.claimWorkItem('WI-current', 'peer', { harness: H })).toBeNull();
    await seed('WI-next');
    expect(await wi.claimWorkItem('WI-next', 'worker', { harness: H })).toBeNull();
    const [row] = await h.sql`SELECT taken_by FROM harness_shared.work_items WHERE feature_id = 'WI-current'`;
    expect(row.taken_by).toBe('worker');
  });

  it('a held atomic step can finish after owner deselection, but its next claim is denied', async () => {
    await policy([]);
    await seed('WI-current', 'bug');
    await seed('WI-next');
    const current = await wi.claimWorkItem('WI-current', 'worker', { harness: H });
    expect(current?.id).toBe('WI-current');
    let releaseStep!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseStep = resolve; });
    const step = (async () => {
      await barrier;
      const result = await wi.updateWorkItem('WI-current', { title: 'atomic step completed' }, 'worker', { harness: H });
      return result;
    })();
    await policy([EXCLUDED]);
    releaseStep();
    const finished = await step;
    expect(finished.ok && finished.item.title).toBe('atomic step completed');
    expect(await wi.claimWorkItem('WI-next', 'worker', { harness: H })).toBeNull();
  });

  it('an owner write between candidate discovery and final admission invalidates the stale candidate', async () => {
    await policy([]);
    await seed('WI-race');
    const discovered = await h.sql`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = 'WI-race'`;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const claim = (async () => { await barrier; return wi.claimWorkItem(discovered[0].feature_id, 'worker', { harness: H }); })();
    await policy([EXCLUDED]);
    release();
    expect(await claim).toBeNull();
  });

  it('policy row locking prevents a stale read while the owner writer is uncommitted', async () => {
    await policy([]);
    let writerReady!: () => void;
    const ready = new Promise<void>((resolve) => { writerReady = resolve; });
    let commit!: () => void;
    const barrier = new Promise<void>((resolve) => { commit = resolve; });
    let writerPid = 0;
    const writer = h.sql.begin(async (tx) => {
      const [process] = await tx`SELECT pg_backend_pid() AS pid`;
      writerPid = process.pid;
      await tx`SELECT id FROM harness_shared.goals WHERE id = ${GOAL} FOR UPDATE`;
      const result = await applyGoalPropertyWrite(tx as unknown as postgres.Sql, {
        workspaceId: WS, goalId: GOAL, property: 'worklist_policy', value: { order: [], excluded: [EXCLUDED] },
        expectedVersion: 2, provenance: 'owner-edit', actorId: 'owner-ui',
      });
      expect(result.ok).toBe(true);
      writerReady();
      await barrier;
    });
    await ready;
    let readerPid = 0;
    let readerStarted!: () => void;
    const started = new Promise<void>((resolve) => { readerStarted = resolve; });
    const admission = h.sql.begin(async (tx) => {
      const [process] = await tx`SELECT pg_backend_pid() AS pid`;
      readerPid = process.pid;
      readerStarted();
      return lockGoalPlanClaimSelections(tx as unknown as postgres.Sql, WS);
    });
    try {
      await started;
      // Observe the actual PostgreSQL lock edge before committing. Without FOR
      // SHARE a reader can finish on the old policy, so merely racing commit
      // against a read is not a distinguishing test of the admission fence.
      await vi.waitFor(async () => {
        // adminSql has two connections, both occupied by writer and reader.
        // Observe through the fixture's independent app pool so the instrument
        // does not queue behind the very transactions it is measuring.
        const [locks] = await db.appSql`SELECT pg_blocking_pids(${readerPid}) AS blockers`;
        expect(locks.blockers).toContain(writerPid);
      }, { timeout: 5_000, interval: 20 });
    } finally {
      commit();
      await Promise.all([writer, admission]);
    }
    const selections = await admission;
    expect(selections[0].policyVersion).toBe(3);
    expect(selections[0].selected).not.toContain(EXCLUDED);
  });
});
