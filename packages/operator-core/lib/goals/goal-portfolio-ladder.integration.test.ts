import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getBuildInfo } from '../build-info';
import { readGoalPortfolioBrief } from '../goal-launch-settings';
import { GOAL_OWNER_REPORT_FIELD, GOAL_OWNER_REPORT_SCHEMA_VERSION } from '../goal-owner-report';
import { applyGoalPropertyWrite } from '../typed-properties-db';
import { resolveGoalHolders } from './holder';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';

const WS = 'ws-goal-ladder-p019';
const GOAL = 'goal-ladder-p019';
let db: OrgTestDb;
let globalPg: BaselineCoordFixture;

beforeAll(async () => {
  db = await createOrgTestDb();
  // Holder liveness also reads through getOrgPg(). Bind that maintained
  // connection to this SAME private DB, never the live operator or shared fixture.
  globalPg = await setupBaselineCoordFixture({ dsn: db.adminDsn });
}, 300_000);
afterAll(async () => {
  await globalPg?.dispose();
  if (db) await db.cleanup();
}, 120_000);

describe('canonical GOAL portfolio ladder (real Postgres)', () => {
  it('uses the exact qualified closure for two terminal plans with the same slug', async () => {
    const sql = db.adminSql;
    const goal = 'qualified-closure-goal';
    const slug = 'qualified-closure-plan';
    const harnesses = ['closure-a', 'closure-b'];
    await sql`INSERT INTO harness_shared.goals
      (workspace_id, id, install_slug, title, status, properties)
      VALUES (${WS}, ${goal}, 'papercusp', 'Qualified closure', 'active',
        ${sql.json({ worklist: { value: harnesses.map((h) => `plan:${h}/${slug}`) } })})`;
    for (const [index, harness] of harnesses.entries()) {
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status)
        VALUES (${WS}, ${harness}, ${slug}, ${harness}, 'shipped')`;
      const [plan] = await sql`SELECT version, acceptance_bar_epoch FROM harness_shared.harness_plans
        WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND plan_slug = ${slug}`;
      const fingerprint = { planVersion: String(plan.version), acceptanceBarEpoch: plan.acceptance_bar_epoch,
        itemsWatermark: null, auditSeq: null, specBindings: null, rubrics: [],
        scorecardWatermark: null, metaScorecardWatermark: null };
      const buildSha = getBuildInfo().sha;
      if (!buildSha) throw new Error('test requires a resolved evaluator build SHA');
      await sql`INSERT INTO harness_shared.plan_closure_observations_by_build
        (workspace_id, harness_slug, plan_slug, build_sha, satisfied, fingerprint, observed_at)
        VALUES (${WS}, ${harness}, ${slug}, ${buildSha.toLowerCase()}, ${index === 0}, ${sql.json(fingerprint)}, now())`;
    }
    const brief = await readGoalPortfolioBrief({ workspaceId: WS, goalId: goal, sql });
    expect(brief?.worklist.find((p) => p.harness === harnesses[0])?.placement.state).toBe('terminal');
    expect(brief?.worklist.find((p) => p.harness === harnesses[1])?.placement.state).toBe('awaiting-closure');
  }, 60_000);

  it('joins a live pot link, exact plan goal stamp and source-plan work item into one typed verdict', async () => {
    const sql = db.adminSql;
    await sql`
      INSERT INTO harness_shared.goals
        (workspace_id, id, install_slug, title, status, standing, properties, metadata)
      VALUES (${WS}, ${GOAL}, 'papercusp', 'Ladder goal', 'active', true,
              ${sql.json({ worklist: { value: ['plan:papercusp/alpha'] } })}, ${sql.json({})})`;
    await sql`
      INSERT INTO harness_shared.goal_pots
        (workspace_id, goal_id, harness_slug, role, kill_criterion)
      VALUES (${WS}, ${GOAL}, 'papercusp', 'owner', 'stop if the plan no longer serves this goal')`;
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, goal_id)
      VALUES (${WS}, 'papercusp', 'alpha', 'Alpha', 'active', ${GOAL})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, source_plan_slug,
         source_plan_item_ids, goal_id)
      VALUES (${WS}, 'papercusp', 'WI-ladder', 'task', 'open', 'alpha', ARRAY['P-001'], ${GOAL})`;

    const read = () => readGoalPortfolioBrief({
      workspaceId: WS, goalId: GOAL, sql,
      launch: {
        goalBrief: {
          title: 'Ladder goal', body: null, killCriterion: null, budgetCents: null,
          budgetWindowSec: null, standing: true,
        },
        settings: null, budget: null,
        ceilings: { maxAgents: 12, maxPerFleet: 5 },
        headcount: { total: 0, fleet: 0 },
      },
    });
    const healthy = await read();
    expect(healthy?.attribution).toMatchObject({
      status: 'healthy', checked: { pots: 1, plans: 1, workItems: 1 }, issues: [],
    });
    expect(healthy?.pots[0]).toMatchObject({
      harness: 'papercusp', role: 'owner', killCriterion: 'stop if the plan no longer serves this goal',
    });

    await sql`UPDATE harness_shared.goals
      SET launch_settings = ${sql.json({ intendedParallelPlanFleets: 2 })}
      WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    const liveWidth = await readGoalPortfolioBrief({ workspaceId: WS, goalId: GOAL, sql });
    expect(liveWidth?.launch).toMatchObject({ intendedParallelPlanFleets: 2 });
    expect(liveWidth?.launch.ceilings).toEqual({ maxAgents: 12, maxPerFleet: 5 });

    await sql`UPDATE harness_shared.work_items SET goal_id = NULL
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    expect((await read())?.attribution?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-ladder' }),
    ]));

    // WI-10005269: a federation-owned (origin='remote') unstamped row cannot be stamped by any
    // local verb, so it must be reported as `remoteOwned`, never as an actionable issue — and the
    // local unstamped row must keep failing the ladder (the split is by origin, not a blanket skip).
    await sql`UPDATE harness_shared.work_items SET goal_id = ${GOAL}
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, source_plan_slug,
         source_plan_item_ids, goal_id, origin)
      VALUES (${WS}, 'papercusp', 'WI-ladder-remote', 'task', 'open', 'alpha', ARRAY['P-002'], NULL, 'remote')`;
    const remoteOnly = (await read())?.attribution;
    expect(remoteOnly).toMatchObject({
      status: 'healthy', issues: [], remoteOwned: ['WI-ladder-remote'],
      checked: { pots: 1, plans: 1, workItems: 2 },
    });
    await sql`UPDATE harness_shared.work_items SET goal_id = NULL
      WHERE workspace_id = ${WS} AND feature_id = 'WI-ladder'`;
    const mixed = (await read())?.attribution;
    expect(mixed?.status).toBe('incomplete');
    expect(mixed?.issues).toEqual([
      expect.objectContaining({ code: 'unstamped-work-item', ref: 'WI-ladder' }),
    ]);
    expect(mixed?.remoteOwned).toEqual(['WI-ladder-remote']);
  }, 60_000);

  it('builds the owner report from exact goal evidence and the watchdog report watermark', async () => {
    const sql = db.adminSql;
    const goal = 'goal-report-p021';
    const owner = 'su-report-p021';
    const t0 = '2026-09-25T19:00:00.000Z';
    const t1 = '2026-09-25T19:30:00.000Z';
    const t2 = '2026-09-25T20:00:00.000Z';
    const t3 = '2026-09-25T20:15:00.000Z';
    await sql`
      INSERT INTO harness_shared.goals
        (workspace_id, id, install_slug, title, status, standing, created_at, properties, metadata)
      VALUES (${WS}, ${goal}, 'papercusp', 'Report goal', 'active', true, ${t0}::timestamptz,
              ${sql.json({ worklist: { value: ['plan:papercusp/report-alpha'] } })}, ${sql.json({})})`;
    await sql`
      INSERT INTO harness_shared.agent_modes
        (workspace_id, owner_id, axis_key, mode, subject, set_by, set_at)
      VALUES (${WS}, ${owner}, 'goal', 'goal', ${goal}, 'test', ${t0}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${WS}, 'messages', 'p021-real-report', ${sql.json({
        from: owner, to: ['human'],
        [GOAL_OWNER_REPORT_FIELD]: {
          schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION, goalId: goal,
          moved: 'previous report', cost: 'measured', ownerWalled: 'none', killed: 'none',
        },
      })}, ${t1}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${WS}, 'escalations', 'p021-unrelated-ping', ${sql.json({
        from: owner, body: 'Routine note without a four-field goal report',
      })}, ${t3}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, goal_id, updated_at)
      VALUES (${WS}, 'papercusp', 'report-alpha', 'Report alpha', 'shipped', ${goal}, ${t2}::timestamptz)`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, closed_ts)
      VALUES (${WS}, 'papercusp', 'WI-report-done', 'task', 'done', ${goal}, ${Date.parse(t2)}, ${Date.parse(t2)})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, payload)
      VALUES (${WS}, 'papercusp', 'WI-report-wall', 'task', 'open', ${goal}, ${Date.parse(t2)},
              ${sql.json({ needsOwnerAction: true, ownerAsk: 'provide the domain credential' })})`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, payload)
      VALUES (${WS}, 'papercusp', 'WI-report-old-wall', 'task', 'done', ${goal}, ${Date.parse(t0)},
              ${sql.json({ needsOwnerAction: true, ownerAsk: 'obsolete approval' })})`;
    // EI-25697679635517900: production owner asks are active human blockers,
    // without ownerAction/ownerAsk. The old deployed query lost those actions.
    const blockerActions = [
      { ref: 'WI-report-github', summary: 'Register the GitHub App and set the three Worker secrets',
        nextVerb: 'Register the App, set its secrets, and install it on the mirrors' },
      { ref: 'WI-report-release', summary: 'Authorize the Worker bundle deploy or rescope the acceptance bars',
        nextVerb: 'Record the release decision before deploying the bundle' },
      { ref: 'WI-report-inference', summary: '',
        nextVerb: 'Reply with a request/USD cap or decline the paid quality fixture and startup experiment' },
    ];
    for (const wall of blockerActions) {
      await sql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, goal_id, updated_ts, payload)
        VALUES (${WS}, 'papercusp', ${wall.ref}, 'task', 'needs-human', ${goal}, ${Date.parse(t2)},
          ${sql.json({ externalBlockers: [
            { kind: 'human', status: 'cleared', summary: 'superseded owner ask', createdAt: t0 },
            { kind: 'human', status: 'active', summary: wall.summary, nextVerb: wall.nextVerb, createdAt: t2 },
          ] })})`;
    }
    // Distinguish missing stored asks from a reader that ignores the blocker
    // writer's shape: the legacy expression loses all three on these SAME rows.
    const legacy = await sql`SELECT feature_id,
      COALESCE(NULLIF(payload->>'ownerAction', ''), NULLIF(payload->>'ownerAsk', ''),
        'open this work item for the exact owner action') AS action
      FROM harness_shared.work_items WHERE workspace_id = ${WS} AND goal_id = ${goal}
        AND feature_id = ANY(${blockerActions.map((wall) => wall.ref)}::text[])`;
    expect(legacy).toHaveLength(blockerActions.length);
    expect(legacy.every((wall) => wall.action === 'open this work item for the exact owner action')).toBe(true);
    await sql`
      INSERT INTO harness_shared.goal_pots
        (workspace_id, goal_id, harness_slug, role, kill_criterion, removed_at)
      VALUES (${WS}, ${goal}, 'papercusp', 'owner', 'stop if the work is no longer useful', ${t2}::timestamptz)`;

    const read = (artifactReads: Array<{ ref: string; readAt: string }> = []) => readGoalPortfolioBrief({
      workspaceId: WS, goalId: goal, sql, now: new Date(t3), reportArtifactReads: artifactReads,
      launch: {
        goalBrief: { title: 'Report goal', body: null, killCriterion: 'stop if done',
          budgetCents: 1000, budgetWindowSec: null, standing: true },
        settings: null,
        budget: { budgetCents: 1000, spentCents: 340, spentCentsAt: t2,
          spentCentsSource: 'goal-lineage-rollup', unmeasuredPricedSpend: false,
          interactiveUsageFreshnessStatus: null, interactiveUsageLastIngestedAtMs: null },
        ceilings: { maxAgents: 12, maxPerFleet: 5 },
        headcount: { total: 0, fleet: 0 },
      },
    });
    const unread = await read();
    const elected = await resolveGoalHolders(sql, { workspaceId: WS, goalId: goal });
    expect(elected.elected?.ownerId).toBe(owner);
    expect(unread?.degradedReasons.filter((reason) => reason.includes('holder liveness read failed')).join('\n')).toBe('');
    expect(unread?.continuity.lastOwnerReportAt).toBe(t1);
    expect(unread?.reporting?.cadence?.lastReportAt).toBe(t1);
    expect(unread?.reporting?.draft.fields.cost).toContain('340c / 1000c; coverage=measured; source=goal-lineage-rollup');
    expect(unread?.reporting?.draft.fields.ownerWalled).toContain('WI-report-wall: provide the domain credential');
    expect(unread?.reporting?.draft.fields.ownerWalled).not.toContain('obsolete approval');
    for (const wall of blockerActions) {
      expect(unread?.reporting?.draft.fields.ownerWalled).toContain(`${wall.ref}: ${wall.summary || wall.nextVerb}`);
    }
    expect(unread?.reporting?.draft.fields.ownerWalled).not.toContain('superseded owner ask');
    expect(unread?.reporting?.draft.fields.ownerWalled).not.toContain('open this work item');
    expect(unread?.queue.needsHuman).toBe(4);
    expect(unread?.reporting?.draft.fields.killed).toContain('pot:papercusp');
    expect(unread?.reporting?.draft.fields.moved).toContain('completion unverified (artifact unread)');
    expect(unread?.reporting?.draft.unreadArtifacts).toEqual(expect.arrayContaining([
      'plan:papercusp/report-alpha', 'work-item:WI-report-done',
    ]));

    const verified = await read([
      { ref: 'plan:papercusp/report-alpha', readAt: t3 },
      { ref: 'work-item:WI-report-done', readAt: t3 },
    ]);
    expect(verified?.reporting?.draft.unreadArtifacts).toEqual([]);
    expect(verified?.reporting?.draft.fields.moved).toContain('artifact work-item:WI-report-done read');
  }, 90_000);
});

describe('opt-in active workspace plan pool (P-003, real Postgres)', () => {
  const declaration = {
    worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both', collection: {
      source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
      selectable: true, defaultSelected: true,
    } },
    worklist_policy: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
  };
  const stored = (value: string[] | { order: string[]; excluded: string[] }) => ({ value, version: 7, edited_at: '2026-10-08T01:00:00.000Z',
    edited_by: 'original-owner', provenance: 'owner-edit' });
  async function fixture(name: string) {
    const workspace = `ws-p003-${name}`;
    const goal = `goal-p003-${name}`;
    const sql = db.adminSql;
    const properties = { worklist: stored(['plan:p003/two', 'plan:p003/one']) };
    await sql`INSERT INTO harness_shared.goals
      (workspace_id, id, install_slug, title, status, property_schema, properties)
      VALUES (${workspace}, ${goal}, 'p003', 'Private discovery fixture', 'active',
        ${sql.json(declaration)}, ${sql.json(properties)})`;
    await sql`INSERT INTO harness_shared.goal_pots
      (workspace_id, goal_id, harness_slug, role, kill_criterion)
      VALUES (${workspace}, ${goal}, 'p003', 'owner', 'Stop when this private test finishes')`;
    const plan = async (slug: string, status = 'active', harness = 'p003', planGoal: string | null = null,
      planWorkspace = workspace) => {
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, goal_id)
        VALUES (${planWorkspace}, ${harness}, ${slug}, ${slug}, ${status}, ${planGoal})`;
      await sql`INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, item_text, status, seq)
        VALUES (${planWorkspace}, ${harness}, ${slug}, 'P-001', 'Private ready work', 'todo', 1)`;
    };
    await plan('one');
    await plan('two');
    const read = () => readGoalPortfolioBrief({ workspaceId: workspace, goalId: goal, sql, claimability: 'skip',
      launch: { goalBrief: { title: 'Private discovery fixture', body: null, killCriterion: 'Stop when done',
        budgetCents: null, budgetWindowSec: null, standing: false }, settings: null, budget: null,
        ceilings: { maxAgents: 12, maxPerFleet: 5 }, headcount: { total: 0, fleet: 0 } } });
    const policy = (value: unknown, expectedVersion = 0) => sql.begin((tx) =>
      applyGoalPropertyWrite(tx as unknown as typeof sql, { workspaceId: workspace, goalId: goal,
        property: 'worklist_policy', value, expectedVersion, actorId: 'private-owner', provenance: 'owner-edit' }));
    return { workspace, goal, sql, plan, read, policy, properties };
  }

  it('attaches each plan\'s newest fleet once, decoding a JSON-string headcount_config (WI-10008214)', async () => {
    const fx = await fixture('fleet');
    const fleet = async (workspace: string, slug: string, config: Record<string, unknown> | null,
      encoding: 'object' | 'string', updatedAt: number, target: number) => {
      const text = config === null ? null : JSON.stringify(config);
      await fx.sql`INSERT INTO harness_shared.agent_fleets
        (workspace_id, fleet_slug, created_at, updated_at, headcount_target, headcount_config)
        VALUES (${workspace}, ${slug}, ${updatedAt}, ${updatedAt}, ${target},
          CASE WHEN ${text}::text IS NULL THEN NULL
               WHEN ${encoding} = 'string' THEN to_jsonb(${text}::text)
               ELSE ${text}::jsonb END)`;
    };
    await fleet(fx.workspace, 'one-older', { plan: 'one', harness: 'p003' }, 'object', 1_000, 1);
    await fleet(fx.workspace, 'one-newest', { plan: 'one', harness: 'p003' }, 'string', 3_000, 2);
    await fleet(fx.workspace, 'two-other-harness', { plan: 'two', harness: 'elsewhere' }, 'object', 4_000, 3);
    await fleet('different-workspace', 'two-foreign', { plan: 'two', harness: 'p003' }, 'object', 5_000, 4);
    await fleet(fx.workspace, 'unscoped', null, 'object', 6_000, 5);
    await fleet(fx.workspace, 'no-plan-key', { harness: 'p003' }, 'string', 7_000, 6);

    // Capture the worklist statement so its plan shape can be checked below.
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const capture = postgres(db.adminDsn, { max: 1, debug: (_c, text, params) => {
      statements.push({ text, params: [...(params ?? [])] });
    } });
    try {
      const brief = await readGoalPortfolioBrief({ workspaceId: fx.workspace, goalId: fx.goal,
        sql: capture as unknown as typeof fx.sql, claimability: 'skip',
        launch: { goalBrief: { title: 'Private discovery fixture', body: null, killCriterion: 'Stop when done',
          budgetCents: null, budgetWindowSec: null, standing: false }, settings: null, budget: null,
          ceilings: { maxAgents: 12, maxPerFleet: 5 }, headcount: { total: 0, fleet: 0 } } });
      expect(brief?.degradedReasons.filter((r) => r.includes('portfolio read failed'))).toEqual([]);
      const byRef = new Map(brief?.worklist.map((p) => [p.ref, p.placement.fleet]));
      expect(byRef.get('plan:p003/one')).toMatchObject({ slug: 'one-newest', target: 2 });
      expect(byRef.get('plan:p003/two')).toBeNull();

      // The plans subquery is pulled up into its aggregate. Any second reference to its
      // jsonb_build_object (an ORDER BY over plan_row, say) makes Postgres plan, and run,
      // every per-plan SubPlan twice. Each per-plan relation must appear exactly once.
      const worklist = statements.find((s) => /WITH goal_row AS/.test(s.text));
      expect(worklist).toBeDefined();
      const [row] = await db.adminSql.unsafe(`EXPLAIN (FORMAT JSON) ${worklist!.text}`, worklist!.params as never[]);
      const relations: Record<string, number> = {};
      const walk = (node: Record<string, unknown>) => {
        const name = node['Relation Name'];
        if (typeof name === 'string') relations[name] = (relations[name] ?? 0) + 1;
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
      };
      walk(((Object.values(row)[0] as Array<{ Plan: Record<string, unknown> }>)[0]).Plan);
      expect({ plan_items: relations.plan_items, plan_item_claims: relations.plan_item_claims,
        cup_claim_specs: relations.cup_claim_specs }).toEqual({ plan_items: 1, plan_item_claims: 1, cup_claim_specs: 1 });
    } finally {
      await capture.end();
    }
  });

  it('discovers newly active plans after saved order without changing any stored worklist or attribution', async () => {
    const fx = await fixture('append');
    await fx.plan('pending', 'draft');
    await fx.plan('archived');
    await fx.sql`UPDATE harness_shared.harness_plans SET archived = true
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'archived'`;
    await fx.plan('foreign', 'active', 'p003', null, 'different-workspace');
    expect((await fx.read())?.worklist.map((p) => p.ref)).toEqual(['plan:p003/two', 'plan:p003/one']);
    await fx.sql`UPDATE harness_shared.harness_plans SET status = 'active'
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'pending'`;
    const refreshed = await fx.read();
    expect(refreshed?.degradedReasons.filter((r) => r.includes('portfolio read failed'))).toEqual([]);
    expect(refreshed?.worklist.map((p) => [p.ref, p.selected])).toEqual([
      ['plan:p003/two', true], ['plan:p003/one', true], ['plan:p003/pending', true],
    ]);
    expect(refreshed?.collection).toEqual({ source: 'active-workspace-plans', policyVersion: 0, available: true });
    expect(refreshed?.attribution?.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unstamped-plan' }),
    ]));
    const [goal] = await fx.sql`SELECT properties FROM harness_shared.goals
      WHERE workspace_id = ${fx.workspace} AND id = ${fx.goal}`;
    expect(goal.properties).toEqual(fx.properties);
    const plans = await fx.sql`SELECT goal_id FROM harness_shared.harness_plans WHERE workspace_id = ${fx.workspace}`;
    expect(plans.every((p) => p.goal_id === null)).toBe(true);
  });

  it('persisted reorder/exclusion controls the next placement and survives deactivation and reactivation', async () => {
    const fx = await fixture('policy');
    await fx.plan('new');
    expect(await fx.policy({ order: ['plan:p003/one', 'plan:p003/two'], excluded: ['plan:p003/one'] }))
      .toMatchObject({ ok: true, entry: { version: 1 } });
    const before = await fx.read();
    expect(before?.worklist.map((p) => p.ref)).toEqual(['plan:p003/one', 'plan:p003/two', 'plan:p003/new']);
    expect(before?.worklist[0]).toMatchObject({ selected: false, placement: { reconciliation: { toolCall: null } } });
    expect(before?.worklist.find((p) => p.placement.reconciliation.toolCall)?.ref).toBe('plan:p003/two');
    await fx.sql`UPDATE harness_shared.harness_plans SET status = 'draft'
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'new'`;
    expect((await fx.read())?.worklist.map((p) => p.ref)).not.toContain('plan:p003/new');
    await fx.sql`UPDATE harness_shared.harness_plans SET status = 'active'
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'new'`;
    const reactivated = await fx.read();
    expect(reactivated?.worklist[0]).toMatchObject({ ref: 'plan:p003/one', selected: false });
    expect(reactivated?.collection?.policyVersion).toBe(1);
    expect(await fx.policy({ order: ['plan:p003/one', 'plan:p003/two'], excluded: [] }, 1))
      .toMatchObject({ ok: true, entry: { version: 2 } });
    expect((await fx.read())?.worklist.find((p) => p.placement.reconciliation.toolCall)?.ref).toBe('plan:p003/one');
  });

  it('keeps peer claims and other-goal ownership intact and distinguishes qualified equal-slug plans', async () => {
    const fx = await fixture('ownership');
    await fx.plan('one', 'active', 'other-harness');
    await fx.plan('owned', 'active', 'p003', 'different-goal');
    await fx.sql`INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES (${fx.workspace}, 'p003', 'two', 'P-001', 'peer-source-owner', now() + interval '1 hour')`;
    const before = await fx.sql`SELECT owner, expires_ts FROM harness_shared.plan_item_claims
      WHERE workspace_id = ${fx.workspace}`;
    const result = await fx.read();
    expect(result?.worklist.filter((p) => p.slug === 'one').map((p) => [p.ref, p.ambiguousMatches])).toEqual([
      ['plan:p003/one', 1], ['plan:other-harness/one', 1],
    ]);
    expect(result?.worklist.find((p) => p.slug === 'owned')).toMatchObject({ selected: true,
      placement: { state: 'blocked', reconciliation: { action: 'none', toolCall: null,
        reason: expect.stringContaining('another goal') } } });
    expect(await fx.sql`SELECT owner, expires_ts FROM harness_shared.plan_item_claims
      WHERE workspace_id = ${fx.workspace}`).toEqual(before);
    const [owned] = await fx.sql`SELECT goal_id FROM harness_shared.harness_plans
      WHERE workspace_id = ${fx.workspace} AND plan_slug = 'owned'`;
    expect(owned.goal_id).toBe('different-goal');
  });

  it('a corrupt owner policy disables new placement visibly instead of treating it as an empty policy', async () => {
    const fx = await fixture('unavailable');
    await fx.sql`UPDATE harness_shared.goals SET properties = properties ||
      ${fx.sql.json({ worklist_policy: { ...stored({ order: [], excluded: [] }), provenance: 'agent-edit' } })}
      WHERE workspace_id = ${fx.workspace} AND id = ${fx.goal}`;
    const result = await fx.read();
    expect(result?.collection).toMatchObject({ available: false, reason: expect.stringContaining('not owner-authored') });
    expect(result?.worklist).toHaveLength(2);
    expect(result?.worklist.every((p) => p.selected === false && p.placement.reconciliation.toolCall === null)).toBe(true);
    expect(result?.degradedReasons).toEqual(expect.arrayContaining([expect.stringContaining('selection unavailable')]));
  });

  it('an unknown collection source stays unavailable and cannot fall back to unprotected manual placement', async () => {
    const fx = await fixture('invalid-declaration');
    expect(await fx.policy({ order: [], excluded: ['plan:p003/one'] })).toMatchObject({ ok: true });
    await fx.sql`UPDATE harness_shared.goals SET property_schema =
      jsonb_set(property_schema, '{worklist,collection,source}', '"unknown-provider"'::jsonb)
      WHERE workspace_id = ${fx.workspace} AND id = ${fx.goal}`;
    const result = await fx.read();
    expect(result?.collection).toMatchObject({ source: 'unknown', available: false });
    expect(result?.worklist).toHaveLength(2);
    expect(result?.worklist.every((p) => p.selected === false && p.placement.reconciliation.toolCall === null)).toBe(true);
    const [row] = await fx.sql`SELECT properties->'worklist_policy'->'value' AS policy
      FROM harness_shared.goals WHERE workspace_id = ${fx.workspace} AND id = ${fx.goal}`;
    expect(row.policy).toEqual({ order: [], excluded: ['plan:p003/one'] });
  });
});
