/**
 * R6's deterministic obligation plane and P005's typed refusal reader path,
 * not a manual rubric grade or LLM trial.
 * The review remains an assertion; plan coverage here is controlled fixture evidence.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { setMode } from './modes/store';
import { readAgentObligationAgenda, defaultAgentObligationReaderDeps } from './agent-obligation-reader';
import type { GoalLaunchRefusal } from './goal-launch-settings';
import { applyGoalPropertyWrite } from './typed-properties-db';
import { seedPlan, cleanupPlans } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './agent-tools/plans/derive-index';
import { writePlanIndexRows } from './agent-tools/plans/plan-index-rows';
import recordTool, { ideatePassRecordArgs } from './agent-tools/scout/ideate-pass-record';
import { readGoalHarness, recordGoalPlacementTurnEnd } from './goal-placement-turn-receipts';
import { readVerbatimTail } from './turn-journal';
import { createPgTelemetryStore } from './activity-pg-store';
import { preflightExactPlanAdmission, type ExactPlanAdmission } from './agent-tools/plans/plan-admission-preflight';
import { createWorkItem } from './work-items';
import { runWithWorkspaceIfConcrete } from './workspace-als';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = 'default';
const OWNER = `su-review-verdict-${RUN}`;
const GOAL = `review-verdict-${RUN}`;
const HARNESS = `zzz-review-verdict-${RUN}`;
const SLUG = `checkout-retry-${RUN}`;
const PLAN = `plan:${HARNESS}/${SLUG}`;
const READY_SLUG = `checkout-ready-${RUN}`;
const READY_PLAN = `plan:${HARNESS}/${READY_SLUG}`;
let fx: BaselineCoordFixture;
let readyWorkItemId: string | null = null;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Checkout retry contract', body: 'Document the checkout retry contract.', status: 'active',
    killCriterion: 'A zero-idea review hides an uncovered need or invents new-plan demand.' });
  expect((await setMode({ workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'Isolated R6 obligation-plane fixture', setBy: OWNER, sql: fx.admin })).ok).toBe(true);
  const content = `---\ntitle: Checkout retry contract\nslug: ${SLUG}\nstatus: ready\n---\n\n## Build\n\n- **P-001** \`todo\` Document the checkout retry contract\n`;
  await seedPlan(fx.admin, WS, HARNESS, SLUG, content);
  const index = deriveIndexFromContent(content);
  await fx.admin.begin(async (tx) => {
    await tx`UPDATE harness_shared.harness_plans SET title = ${index.title}, status = ${index.status}
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG }, index);
    expect((await applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
      workspaceId: WS, goalId: GOAL, property: 'worklist', value: [PLAN], expectedVersion: 0,
      actorId: OWNER, provenance: 'agent-edit',
    })).ok).toBe(true);
  });
}, 150_000);

afterEach(async () => {
  if (fx) await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
  if (fx) await fx.admin`DELETE FROM harness_shared.agent_activity WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
});
afterAll(async () => {
  if (!fx) return;
  if (readyWorkItemId) await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${readyWorkItemId}`;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await fx.admin`DELETE FROM harness_shared.plan_decisions WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(fx.admin, WS, HARNESS);
  await fx.admin`DELETE FROM harness_shared.projects WHERE workspace_id = ${WS} AND id = ${HARNESS}`;
  await fx.dispose();
});

async function record(disposition: 'existing-plans-sufficient' | 'plan-needed') {
  const result = await recordTool.handler(ideatePassRecordArgs.parse({ ideasFiled: 0, goalReview: {
    goalId: GOAL, disposition, planRefs: [PLAN], evidenceRefs: [`goal:${GOAL}`, PLAN],
    rationale: disposition === 'plan-needed'
      ? 'The existing plan covers documenting retries, but not reconciliation.'
      : 'The existing plan covers the goal outcome of documenting the retry contract.',
    ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Reconcile failed payments.' } : {}),
    // P-003: a real coverage planRef, resolved against harness_plans by the live handler.
    ...(disposition === 'existing-plans-sufficient'
      ? { coverage: [{ need: 'retry contract', itemRefs: ['WI-fixture-1', 'WI-fixture-2', 'WI-fixture-3'], planRef: PLAN }] } : {}),
  } }), { isSuperuser: true, uiClientId: OWNER, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
  });
  expect('isError' in result && result.isError === true).toBe(false);
}

async function readAgenda(refusal: GoalLaunchRefusal | null = null, admission: 'controlled-ready' | 'canonical' = 'controlled-ready') {
  return readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER,
    // Real mode/goal/portfolio/tick/authority/obligation reads. Unrelated admission
    // and final acceptance are controlled for review/budget cases. The canonical
    // admission cases below opt into the production preflight explicitly.
    deps: { planSlugs: async () => [], ownerDirectives: async () => [], waitingOn: async () => [], 
      fleetStaffing: async () => [],
      strandedGoalWork: async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false }),
      ownerReport: async () => null,
      planAcceptance: async () => ({ satisfied: true, buildProvenance: { sha: null, version: 'fixture' } }),
      ...(admission === 'controlled-ready' ? { planAdmission: async () => ({
        ready: true, status: 'ready', reason: 'ready', message: 'controlled admission for non-admission test',
        requestedSeats: 1, executableWidth: 1,
      } as ExactPlanAdmission) } : {}),
      goalLaunch: async () => ({ goalId: GOAL, settings: null, goalBrief: null, effective: {},
        ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null },
        budget: null, refusal, degraded: false, degradedReasons: [] }),
      planFleet: async () => ({ status: 'known', alert: null, applicablePlanCount: 0 }),
    },
  });
}
async function agenda(refusal: GoalLaunchRefusal | null = null) { return (await readAgenda(refusal)).agenda; }

describe('P005 canonical exact-plan admission', () => {
  it('reports real promotion lag as a plan repair without offering a launch', async () => {
    const result = (await readAgenda(null, 'canonical')).agenda;
    const row = result.evaluations.find((entry) => entry.family === 'plan-placement');
    expect(row).toMatchObject({ status: 'blocked', scope: { planSlug: SLUG },
      action: { kind: 'repair', targetRef: PLAN, summary: expect.stringContaining('plans:start') } });
    expect(row?.reason).toContain('Actionable plan items lack a promoted row: P-001.');
    expect(row?.action?.tool).toBeUndefined();
  }, 90_000);
});

describe('native turn-end policy observation from canonical goal sources', () => {
  it('stores the real goal/plan policy with native completion, without calling a later read eligibility', async () => {
    await record('existing-plans-sufficient');
    const directory = await mkdtemp(join(tmpdir(), 'goal-policy-native-'));
    try {
      const native = { sourceKind: 'codex' as const, sessionId: `${OWNER}-native`, filePath: join(directory, 'session.jsonl') };
      const completedAt = new Date(Date.now() - 1000).toISOString();
      await writeFile(native.filePath, ['user', 'assistant'].map((role) => JSON.stringify({
        type: 'response_item', timestamp: completedAt, payload: { type: 'message', role,
          ...(role === 'assistant' ? { phase: 'final_answer' } : {}),
          internal_chat_message_metadata_passthrough: { turn_id: 'completed-decision' },
          content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: 'Native fixture response' }] },
      })).join('\n') + '\n');
      const result = await recordGoalPlacementTurnEnd({ ownerId: OWNER, workspaceId: WS,
        nativeSessionId: native.sessionId, sourceKind: 'codex' }, {
        current: async () => native,
        goalSubject: (ownerId, workspaceId) => defaultAgentObligationReaderDeps().goalSubject(workspaceId, ownerId),
        goalHarness: readGoalHarness,
        tail: (source) => readVerbatimTail(source.filePath, source.sourceKind, 50),
        agenda: async () => readAgenda(), append: createPgTelemetryStore().append, now: Date.now,
      });
      expect(result.recorded).toBe(true);
      const rows = await fx.admin`SELECT detail FROM harness_shared.agent_activity WHERE workspace_id = ${WS} AND owner_id = ${OWNER}
        AND detail ? 'goalPlacementTurnEnd'`;
      expect(rows).toHaveLength(1);
      const proof = rows[0]!.detail.goalPlacementTurnEnd;
      expect(proof).toMatchObject({ goalId: GOAL, completedTurnRef: `codex:${native.sessionId}:completed-decision`, completedAt,
        rows: [{ planSlug: SLUG, planRef: PLAN, status: 'due', applicableDemand: 1, actionKind: 'delegate' }] });
      expect(Date.parse(proof.observedAt)).toBeGreaterThanOrEqual(Date.parse(completedAt));
      expect(proof).not.toHaveProperty('eligibleAtCompletion');
      expect(proof).not.toHaveProperty('opportunities');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 90_000);
});

describe('R6 public review-to-obligation verdicts', () => {
  it('review.sufficient: zero new ideas creates no planning penalty while execution remains due', async () => {
    await record('existing-plans-sufficient');
    const rows = await fx.admin`SELECT ideas_routed, detail FROM harness_shared.scout_ticks
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ideas_routed: 0, detail: { goalReview: { planRefs: [PLAN] } } });
    const result = await agenda();
    expect(result.evaluations.find((r) => r.family === 'planning-needed')).toMatchObject({ status: 'satisfied', applicableDemand: 0 });
    expect(result.primary[0]).toMatchObject({ family: 'plan-placement', status: 'due', action: { targetRef: PLAN } });
  }, 90_000);

  it('review.missing.evidence: no scoped review leaves the review obligation due', async () => {
    const rows = await fx.admin`SELECT id FROM harness_shared.scout_ticks
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    expect(rows).toHaveLength(0);
    const result = await agenda();
    expect(result.evaluations.find((r) => r.family === 'planning-needed')).toMatchObject({ status: 'due' });
    expect(result.primary.some((r) => r.family === 'planning-needed')).toBe(true);
  }, 90_000);

  it('a malformed record remains an attributed measurement gap, not proved neglect', async () => {
    await record('existing-plans-sufficient');
    expect((await agenda()).evaluations.find((r) => r.family === 'planning-needed')?.status).toBe('satisfied');
    // Controlled corrupt/legacy record, not a way to bypass the production writer.
    await fx.admin`UPDATE harness_shared.scout_ticks SET detail = jsonb_set(detail, '{goalReview,evidenceRefs}', '[]'::jsonb)
      WHERE workspace_id = ${WS} AND detail->>'owner' = ${OWNER}`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await agenda();
      expect(result.evaluations.find((r) => r.family === 'planning-needed')).toMatchObject({
        status: 'unknown', measurementFailure: { code: 'canonical-goal-planning-read-failed' },
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(
        'Latest scoped goal review is invalid; absence is not established.',
      ));
    } finally {
      warning.mockRestore();
    }
  }, 90_000);

  it('review.neglected: recording the need alone does not clear its follow-through obligation', async () => {
    await record('plan-needed');
    const result = await agenda();
    const planning = result.evaluations.find((r) => r.family === 'planning-needed');
    expect(planning).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(planning?.reason).toContain('Reconcile failed payments.');
    // No claim of two elapsed decision opportunities or a manual fail rating.
    expect(result.primary[0]?.family).toBe('plan-placement');
  }, 90_000);
});

describe('P005 formed launch refusal through the canonical PG agenda', () => {
  it.each([
    ['goal_budget_unmeasurable', /budget measurement/i, /repair.*authoritative.*spend.*measurement/i],
    ['goal_budget_exceeded', /goal budget/i, /owner.*budget.*direction/i],
    ['goal_max_agents', /goal headcount/i, /within.*goal.*ceiling/i],
    ['fleet_max_agents', /fleet headcount/i, /within.*fleet.*ceiling/i],
  ] as const)('retains %s scope and a bounded non-launch repair', async (reason, title, repair) => {
    // This seam supplies the typed resolver output, not a fabricated spend
    // measurement. Resolver enforcement has separate goal-launch-settings tests.
    const refusal: GoalLaunchRefusal = { reason, current: reason === 'goal_budget_unmeasurable' ? null : 10,
      limit: 10, requested: 1, currentScope: 'fixture:canonical-refusal', message: `Refused: ${reason}` };
    const result = await agenda(refusal);
    const row = result.evaluations.find((entry) => entry.family === 'plan-placement');
    expect(row).toMatchObject({ status: 'blocked', scope: { goalId: GOAL, planSlug: SLUG },
      reason: refusal.message, action: { kind: 'repair', targetRef: `goal:${GOAL}` } });
    expect(row?.title).toMatch(title);
    expect(row?.action?.summary).toMatch(repair);
    expect(row?.action?.tool).toBeUndefined();
    expect(result.primary[0]?.id).toBe(row?.id);
  }, 90_000);
});

describe('P005 real PG independent-lane selection', () => {
  it('advances the later promoted plan without treating the earlier promotion gap as a prerequisite', async () => {
    const content = `---\ntitle: Ready checkout plan\nslug: ${READY_SLUG}\nstatus: ready\n---\n\n## Build\n\n- **P-001** \`todo\` Document ready checkout behavior\n`;
    await seedPlan(fx.admin, WS, HARNESS, READY_SLUG, content);
    const index = deriveIndexFromContent(content);
    await fx.admin.begin(async (tx) => {
      await tx`UPDATE harness_shared.harness_plans SET title = ${index.title}, status = ${index.status}
        WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${READY_SLUG}`;
      await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0],
        { workspaceId: WS, harnessSlug: HARNESS, planSlug: READY_SLUG }, index);
      expect((await applyGoalPropertyWrite(tx as unknown as typeof fx.admin, {
        workspaceId: WS, goalId: GOAL, property: 'worklist', value: [PLAN, READY_PLAN], expectedVersion: 1,
        actorId: OWNER, provenance: 'agent-edit',
      })).ok).toBe(true);
    });
    const work = await runWithWorkspaceIfConcrete(WS, () => createWorkItem({
      workspaceId: WS, harness: HARNESS, kind: 'task', title: 'Ready checkout verification',
      summary: 'Promoted work on the later independent plan', createdBy: OWNER,
      sourcePlanSlug: READY_SLUG, sourcePlanItemIds: ['P-001'],
    }));
    readyWorkItemId = work.id;
    const admission = await preflightExactPlanAdmission({ workspaceId: WS, harnessSlug: HARNESS,
      planSlug: READY_SLUG, actor: OWNER, specId: `goal-obligation-${HARNESS}-${READY_SLUG}-plan-fleet-plan`,
      fleetSlug: `${HARNESS}-${READY_SLUG}-plan-fleet`, requestedSeats: 1 });
    expect(admission).toMatchObject({ ready: true, reason: 'ready', requestedSeats: 1 });
    const result = (await readAgenda(null, 'canonical')).agenda;
    const row = result.evaluations.find((entry) => entry.family === 'plan-placement');
    expect(row).toMatchObject({ status: 'due', scope: { planSlug: READY_SLUG },
      action: { kind: 'delegate', targetRef: READY_PLAN, args: { plan: READY_SLUG } } });
    expect(row?.action?.tool).toBe('fleet:launch-on-plan');
  }, 90_000);
});
