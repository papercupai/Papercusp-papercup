/** Canonical PG writers -> portfolio receipt; no paid/native agent is spawned. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { readGoalPortfolioBrief } from './goal-launch-settings';
import { applyGoalPropertyWrite } from './typed-properties-db';
import { seedPlan, cleanupPlans } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import { createFleetIfAbsent, setFleetHeadcountTarget, setFleetLeader, setFleetLaunchTransaction } from './agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from './agent-tools/coordination/presence';
import { DEFAULT_CLAIM_SPEC } from './scheduler/claim-spec';
import { setClaimSpec } from './scheduler/claim-spec-store';
import { acquireClaim } from './plan-items/claims';
import { createWorkItem } from './work-items';
import { runWithWorkspaceIfConcrete } from './workspace-als';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const HARNESS = `zzz-placement-${RUN}`;
const PLAN = `plan-${RUN}`;
const GOAL = `goal-${RUN}`;
const FLEET = `fleet-${RUN}`;
const HOLDER = `su-holder-${RUN}`;
const LEADER = `su-leader-${RUN}`;
const MEMBER = `su-member-${RUN}`;
const OUTSIDER = `su-outsider-${RUN}`;
const OWNERS = [HOLDER, LEADER, MEMBER, OUTSIDER];
const activityScopeControl = process.env.PAPERCUSP_PLAN_ACTIVITY_SCOPE_CONTROL;
if (activityScopeControl && !['drain', 'test'].includes(activityScopeControl)) {
  throw new Error(`Unknown permanent plan activity scope control: ${activityScopeControl}`);
}
let fx: BaselineCoordFixture;

async function writeFixturePlan(status = 'ready', items = '- **P-001** `wip` Implement the outcome') {
  const body = `---\ntitle: Productive plan\nslug: ${PLAN}\nstatus: ${status}\n---\n\n## Build\n\n${items}\n`;
  await seedPlan(fx.admin, WS, HARNESS, PLAN, body);
  const idx = deriveIndexFromContent(body);
  await fx.admin.begin(async (tx) => {
    await tx`UPDATE harness_shared.harness_plans SET title = ${idx.title}, status = ${idx.status}
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN }, idx);
  });
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Placement claim fixture', body: 'Productive delegated plan execution', status: 'active',
    killCriterion: 'A launch receipt is confused with a member claim.' });
  expect((await setMode({ workspaceId: WS, ownerId: HOLDER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'P003 isolated PG claim proof', setBy: HOLDER, sql: fx.admin })).ok).toBe(true);
  // Lifecycle eligibility is an explicit fixture input; this does not attest plan activation.
  await writeFixturePlan();
  await fx.admin.begin(async (tx) => {
    const written = await applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
      workspaceId: WS, goalId: GOAL, property: 'worklist', value: [`plan:${HARNESS}/${PLAN}`],
      expectedVersion: 0, actorId: HOLDER, provenance: 'agent-edit',
    });
    expect(written.ok).toBe(true);
  });
}, 150_000);

beforeEach(async () => {
  await writeFixturePlan();
  for (const ownerId of OWNERS) await heartbeatPresence({ ownerId, ownerLabel: ownerId,
    source: 'omp-hook-session', workspaceId: WS, userId: null });
  expect((await createFleetIfAbsent({ workspaceId: WS, fleetSlug: FLEET,
    leaderOwnerId: LEADER, title: 'Plan fleet fixture' }, fx.admin)).created).toBe(true);
  await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: FLEET, target: 1,
    config: { plan: PLAN, harness: HARNESS, agent: 'codex', model: 'gpt-6-sol', effort: 'xhigh', supervise: false }, sql: fx.admin });
  await setPresenceFleet(WS, LEADER, FLEET, 'leader', fx.admin);
  await setPresenceFleet(WS, MEMBER, FLEET, 'member', fx.admin);
  await setPresenceFleet(WS, OUTSIDER, `${FLEET}-other`, 'member', fx.admin);
  expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER,
    spec: { ...DEFAULT_CLAIM_SPEC, specId: 'fixture-plan', view: { filter: { field: 'plan', op: '=', value: PLAN } } },
  }, fx.admin)).ok).toBe(true);
  expect(await setFleetLaunchTransaction({ workspaceId: WS, fleetSlug: FLEET, sql: fx.admin,
    transaction: { version: 1, transactionId: 'fixture-verified-launch', launcherOwnerId: HOLDER,
      requestedAt: Date.now(), updatedAt: Date.now(), state: 'verified', requestedMemberIds: [MEMBER],
      openedMemberIds: [MEMBER], verifiedMemberIds: [MEMBER], workerReadyMemberIds: [],
      failed: [], waves: [], recovery: { retryOwnerIds: [], nextAction: 'verify member pickup' } },
  })).toBe(true);
}, 90_000);

afterEach(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.plan_item_claims WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  // HARNESS is unique to this fixture across workspaces; creator provenance is
  // payload-owned on issue rows, not a created_by base-table column.
  await fx.admin`DELETE FROM harness_shared.work_items WHERE harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.cup_claim_specs WHERE workspace_id = ${WS} AND bee_id = ${`fleet:${FLEET}`}`;
  await fx.admin`DELETE FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
  await fx.admin`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${WS} AND owner_id = ANY(${OWNERS}::text[])`;
  await fx.admin`DELETE FROM harness_shared.fleet_membership_events WHERE workspace_id = ${WS} AND owner_id = ANY(${OWNERS}::text[])`;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${LEADER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${LEADER}`;
});
afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.plan_decisions WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${HOLDER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${HOLDER}`;
  await fx.admin`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${WS} AND owner_id = ANY(${OWNERS}::text[])`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND id = ${HARNESS}`;
  await fx.dispose();
});

async function lease(owner = MEMBER, itemId = 'P-001') {
  const result = await acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN,
    itemId, owner, intent: 'Isolated claimed plan work', ttlSec: 1200 });
  expect(result.ok).toBe(true);
  return result;
}
async function claimedWork(owner = MEMBER, planSlug = PLAN, itemId = 'P-001') {
  // Canonical atomic create+claim writer, rather than inserting a fabricated taken_by row.
  // The public dispatch seat establishes workspace ALS for issue-family writers.
  const work = await runWithWorkspaceIfConcrete(WS, () => createWorkItem({ workspaceId: WS, harness: HARNESS, kind: 'task',
    title: `Placement claim ${owner}`, summary: 'Isolated P003 verification work',
    createdBy: LEADER, assignee: owner, sourcePlanSlug: planSlug, sourcePlanItemIds: [itemId] }));
  const rows = await fx.admin`SELECT workspace_id, feature_id, harness_slug, status, taken_by, source_plan_slug, source_plan_item_ids
    FROM harness_shared.work_items WHERE harness_slug = ${HARNESS} AND feature_id = ${work.id}`;
  expect(rows).toMatchObject([{ workspace_id: WS, feature_id: work.id, harness_slug: HARNESS, taken_by: owner,
    source_plan_slug: planSlug, source_plan_item_ids: [itemId] }]);
  return work;
}
async function placement() {
  const p = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL });
  expect(p).not.toBeNull();
  expect(p!.degradedReasons.filter((r) => /portfolio read failed/.test(r))).toEqual([]);
  expect(p!.worklist).toHaveLength(1);
  return p!.worklist[0]!.placement;
}

describe('canonical plan lifecycle blocker receipts', () => {
  it('refuses a persisted draft even with a dependency-free todo item', async () => {
    await writeFixturePlan('draft', '- **P-001** `todo` Implement the outcome');
    expect(await placement()).toMatchObject({ state: 'blocked',
      reconciliation: { action: 'resolve-plan-blockers', toolCall: null } });
    expect((await placement()).reconciliation.reason).toMatch(/draft.*cannot launch/i);
  });
  it('names the dependency blocker without opening a launch transaction', async () => {
    await writeFixturePlan('ready', '- **P-001** `todo` First (blocked-by: P-002)\n- **P-002** `todo` Second (blocked-by: P-001)');
    await fx.admin`DELETE FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
    expect(await placement()).toMatchObject({ state: 'blocked', launchTransaction: null,
      reconciliation: { action: 'resolve-plan-blockers', toolCall: null } });
    expect((await placement()).reconciliation.reason).toMatch(/dependency-free todo/i);
  });
  it('emits the existing plan-fleet launch call for the persisted eligible control', async () => {
    await writeFixturePlan('ready', '- **P-001** `todo` Implement the outcome');
    await fx.admin`DELETE FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
    expect(await placement()).toMatchObject({ state: 'unplaced', launchTransaction: null,
      reconciliation: { action: 'launch-plan-fleet',
        toolCall: { tool: 'fleet:launch-on-plan', args: { plan: PLAN, harness: HARNESS, leader: 'spawn' } } } });
  });
});

describe('canonical delegated-member claim receipt', () => {
  it.each([
    { activity: 'drain', mode: 'repaired' }, { activity: 'test', mode: 'repaired' },
    { activity: 'drain', mode: 'outer control' }, { activity: 'test', mode: 'outer control' },
  ])('does not duplicate a plan fleet for canonical $activity activity held by another fleet member: $mode', async ({ activity, mode }) => {
    // Both activities can have live leaders, members and a real plan lease.
    // Only the explicit plan allocation distinguishes them from a plan fleet.
    expect((await setMode({ workspaceId: WS, ownerId: LEADER, modeId: activity,
      subject: GOAL, enabled: true, reason: 'Isolated exclusion proof', setBy: LEADER, sql: fx.admin })).ok).toBe(true);
    await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: FLEET, target: 1,
      config: { plan: `${PLAN}-${activity}`, harness: HARNESS, agent: 'codex', role: activity }, sql: fx.admin });
    expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER,
      spec: { ...DEFAULT_CLAIM_SPEC, specId: `fixture-${activity}`,
        view: { filter: { field: 'goal', op: '=', value: GOAL } } },
    }, fx.admin)).ok).toBe(true);
    const work = await claimedWork();
    await lease();
    // Read persisted inputs directly, independently of the portfolio adapter.
    // A passing receipt cannot hide a fixture writer that stored the wrong scope.
    const assertPersistedScope = async (plan: string, field: string, value: string) => {
      const fleets = await fx.admin`SELECT headcount_config FROM harness_shared.agent_fleets
        WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
      expect(fleets).toMatchObject([{ headcount_config: { plan, harness: HARNESS, role: activity } }]);
      const specs = await fx.admin`SELECT spec FROM harness_shared.cup_claim_specs
        WHERE workspace_id = ${WS} AND bee_id = ${`fleet:${FLEET}`}`;
      expect(specs).toMatchObject([{ spec: { view: { filter: { field, op: '=', value } } } }]);
      const claims = await fx.admin`SELECT taken_by, source_plan_slug, source_plan_item_ids
        FROM harness_shared.work_items WHERE harness_slug = ${HARNESS} AND feature_id = ${work.id}`;
      expect(claims).toMatchObject([{ taken_by: MEMBER, source_plan_slug: PLAN, source_plan_item_ids: ['P-001'] }]);
    };
    await assertPersistedScope(`${PLAN}-${activity}`, 'goal', GOAL);
    const assertExcluded = (row: Awaited<ReturnType<typeof placement>>) => expect(row, `plan-activity-exclusion:${activity}`).toMatchObject({
      state: 'blocked', fleet: null, launchTransaction: null,
      activeLane: { ownerId: MEMBER, ownerFleet: FLEET, holderLive: true },
      reconciliation: { consistent: false, action: 'reconcile-plan-lane-holder',
        reason: expect.stringContaining(FLEET), toolCall: null },
    });
    if (mode === 'outer control') assertExcluded(await placement());
    if (mode === 'outer control' || activityScopeControl === activity) {
      // Wrong adapter: promote goal activity into the reader's actual plan
      // scope inputs. Keep the literal oracle below and all liveness intact.
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: FLEET, target: 1,
        config: { plan: PLAN, harness: HARNESS, agent: 'codex', role: activity }, sql: fx.admin });
      expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER,
        spec: { ...DEFAULT_CLAIM_SPEC, specId: `fixture-${activity}-wrong-plan-scope`,
          view: { filter: { field: 'plan', op: '=', value: PLAN } } },
      }, fx.admin)).ok).toBe(true);
      await assertPersistedScope(PLAN, 'plan', PLAN);
    }
    const row = await placement();
    if (mode === 'outer control') {
      expect(() => assertExcluded(row)).toThrowError();
      expect(row.state).toBe('working');
      // Distinguish the fixture oracle from the production receipt: role is
      // persisted fixture provenance, while admission reads plan/harness scope.
      // A broken fixture writer must be caught even when admission stays green.
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: FLEET, target: 1,
        config: { plan: PLAN, harness: HARNESS, agent: 'codex', role: 'wrong-fixture-role' }, sql: fx.admin });
      expect((await placement()).state).toBe('working');
      await expect(assertPersistedScope(PLAN, 'plan', PLAN)).rejects.toThrow();
      await setFleetHeadcountTarget({ workspaceId: WS, fleetSlug: FLEET, target: 1,
        config: { plan: PLAN, harness: HARNESS, agent: 'codex', role: activity }, sql: fx.admin });
      await assertPersistedScope(PLAN, 'plan', PLAN);
      expect((await placement()).state).toBe('working');
      return;
    }
    assertExcluded(row);
    expect(row.state).not.toBe('working');
    expect(row.state).not.toBe('independently-led');
  });
  it('keeps a verified launch without a member claim admitting and preserves the one fleet', async () => {
    expect(await placement()).toMatchObject({ state: 'admitting', activeLane: null, reconciliation: { consistent: false, toolCall: null } });
    expect((await createFleetIfAbsent({ workspaceId: WS, fleetSlug: FLEET, leaderOwnerId: LEADER }, fx.admin)).created).toBe(false);
    const fleets = await fx.admin`SELECT fleet_slug FROM harness_shared.agent_fleets WHERE workspace_id = ${WS} AND fleet_slug = ${FLEET}`;
    expect(fleets).toHaveLength(1);
    expect((await placement()).reconciliation.toolCall).toBeNull();
  });
  it('only reports working after the real member work-item claim and matching TTL lease both exist', async () => {
    await lease();
    expect((await placement()).state).not.toBe('working');
    const work = await claimedWork();
    expect(await placement()).toMatchObject({ state: 'working', activeLane: { ownerId: MEMBER, workItemId: work.id },
      fleet: { leaderOwnerId: LEADER, planScoped: true, planAdmitted: true }, reconciliation: { consistent: true, action: 'none' } });
  });
  it('does not substitute a claimed self-contained bare item for the required organizing plan', async () => {
    await lease();
    const bare = await runWithWorkspaceIfConcrete(WS, () => createWorkItem({
      workspaceId: WS, harness: HARNESS, kind: 'task',
      title: `Self-contained spelling correction ${RUN}`,
      summary: 'An unrelated one-file correction; it does not implement the planned outcome.',
      createdBy: LEADER, assignee: MEMBER,
    }));
    const bareRows = await fx.admin`SELECT taken_by, source_plan_slug, source_plan_item_ids
      FROM harness_shared.work_items WHERE harness_slug = ${HARNESS} AND feature_id = ${bare.id}`;
    expect(bareRows).toMatchObject([{ taken_by: MEMBER, source_plan_slug: null }]);
    expect(bareRows[0]!.source_plan_item_ids ?? []).toEqual([]);
    // A real, permitted bare item and a plan lease still cannot stand in for
    // organizing and claiming this necessary plan's work.
    expect(await placement()).toMatchObject({ state: 'admitting', activeLane: { ownerId: MEMBER, workItemId: null },
      reconciliation: { consistent: false, toolCall: null } });
    const organized = await claimedWork();
    expect(await placement()).toMatchObject({ state: 'working',
      activeLane: { ownerId: MEMBER, workItemId: organized.id } });
    expect((await placement()).activeLane?.workItemId).not.toBe(bare.id);
  });
  it('retains one accountable execution owner when another worker competes for the same plan lane', async () => {
    await lease();
    const work = await claimedWork();
    const competing = await acquireClaim({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN,
      itemId: 'P-001', owner: OUTSIDER, intent: 'Competing ownership attempt', ttlSec: 1200 });
    expect(competing).toMatchObject({ ok: false, conflict: { owner: MEMBER } });
    const owners = await fx.admin`SELECT owner FROM harness_shared.plan_item_claims
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}
        AND item_id = 'P-001'`;
    expect(owners).toEqual([{ owner: MEMBER }]);
    expect(await placement()).toMatchObject({ state: 'working',
      activeLane: { ownerId: MEMBER, workItemId: work.id },
      fleet: { leaderOwnerId: LEADER }, reconciliation: { consistent: true, action: 'none' } });
  });
  it('does not count the leader claimed work item and lease as independent member pickup', async () => {
    await lease(LEADER); await claimedWork(LEADER);
    expect(await placement()).toMatchObject({ state: 'admitting', reconciliation: { consistent: false, toolCall: null } });
  });
  it('does not count another fleet member even when the claimed work item and lease match', async () => {
    await lease(OUTSIDER); await claimedWork(OUTSIDER);
    expect((await placement()).state).not.toBe('working');
  });
  it('requires the work item to name the same plan and item as the lease', async () => {
    await lease(); await claimedWork(MEMBER, `${PLAN}-other`);
    expect((await placement()).state).not.toBe('working');
    await claimedWork(MEMBER, PLAN, 'P-999');
    expect((await placement()).state).not.toBe('working');
    await claimedWork();
    expect((await placement()).state).toBe('working');
  });
  it('rechecks the current positive filter rather than trusting the launch transaction', async () => {
    await lease(); await claimedWork();
    expect((await placement()).state).toBe('working');
    expect((await setClaimSpec({ workspaceId: WS, cupId: `fleet:${FLEET}`, updatedBy: LEADER,
      spec: { ...DEFAULT_CLAIM_SPEC, specId: 'wrong-lane', view: { filter: { field: 'plan', op: '=', value: 'different-plan' } } },
    }, fx.admin)).ok).toBe(true);
    expect(await placement()).toMatchObject({ state: 'blocked', reconciliation: { consistent: false, toolCall: null } });
  });
  it('does not treat the current GOAL holder as the independent leader', async () => {
    await lease(); await claimedWork();
    await setFleetLeader(WS, FLEET, HOLDER, fx.admin);
    expect((await placement()).state).toBe('blocked');
  });
  it('drops working when the member lease expires without instructing a duplicate launch', async () => {
    await lease(); await claimedWork();
    expect((await placement()).state).toBe('working');
    await fx.admin`UPDATE harness_shared.plan_item_claims SET expires_ts = now() - interval '1 second'
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(await placement()).toMatchObject({ state: 'admitting', reconciliation: { consistent: false, toolCall: null } });
  });
});
