/** P-007: the advertised complete-agenda recovery must reach the canonical reader. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { assertFact } from '../../../agent-facts/store';
import { runWithWorkspace } from '../../../workspace-als';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { __setCachedReadEnabledForTests, resetOperatorCacheForTests } from '../../../cache';
import { _refreshCacheLayerForTests } from '../../../cache/instance';
import { _refreshL2FlagForTests, getL2Store } from '../../../cache/l2-tier';
import { seedPlan } from '../../plans/__tests__/_pg-tool-fixture';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../../_baseline-coord-fixture';
import { setMode } from '../../../modes/store';
import { recordOwnerDirective } from '../../../owner-directives';
import * as obligationReader from '../../../agent-obligation-reader';
import * as goalSettings from '../../../goal-launch-settings';
import * as ownerReportHistory from '../../../system-health/goal-owner-report-watchdog';
import { formatAgentObligationLine } from '../../../agent-obligations';
import { cancelAwait, registerAwait } from '../../../events/await/store';
import { inboxWakeKey } from '../inbox-wake';
import {
  buildTurnStartOrientationBlock,
  ORIENTATION_CURSOR_SURFACE,
  type OrientationDeps,
} from '../../../turn-start-orientation';
import orientTool from './orient';
import * as pipelineHealth from '../pipeline-health';
// Production boot registers compound folds before serving coord:orient.
import '../../fleet/assignments';
import './whoami';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-orient-obligations-${RUN}`;
const NON_GOAL_OWNER = `su-orient-obligations-non-goal-${RUN}`;
const GOAL = `orient-obligations-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

afterEach(() => vi.restoreAllMocks());

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  // The agenda's steady-state deadline must not include creating/migrating
  // the fixture's separate locks database. Exercise the real dependency
  // during setup, just as the host prepares its stores before serving reads.
  const waitingOnStarted = performance.now();
  await expect(obligationReader.defaultAgentObligationReaderDeps().waitingOn(WS, OWNER))
    .resolves.toEqual([]);
  console.info('ORIENT_OBLIGATIONS_PREFLIGHT ' + JSON.stringify({
    waitingOnPrepared: true, elapsedMs: performance.now() - waitingOnStarted,
  }));
  await insertGoalRow(fx.admin, {
    id: GOAL,
    installSlug: 'papercusp',
    workspaceId: WS,
    title: 'Complete agenda recovery integration',
    body: 'A controlled goal used only in the isolated PostgreSQL fixture.',
    killCriterion: 'The recovery tool omits the complete obligation agenda.',
    status: 'active',
  });
  const mode = await setMode({
    workspaceId: WS,
    ownerId: OWNER,
    modeId: 'goal',
    subject: GOAL,
    enabled: true,
    reason: 'P-007 isolated production-consumer test',
    setBy: OWNER,
    sql: fx.admin,
  });
  expect(mode.ok).toBe(true);
  // Production boot loads the fleet reader before steady-state orientation.
  // Include its real import/store preparation alongside waitingOn above.
  const planFleetStarted = performance.now();
  await expect(obligationReader.defaultAgentObligationReaderDeps().planFleet(WS, GOAL))
    .resolves.toMatchObject({ status: 'known', applicablePlanCount: 0 });
  console.info('ORIENT_OBLIGATIONS_PREFLIGHT ' + JSON.stringify({
    planFleetPrepared: true, elapsedMs: performance.now() - planFleetStarted,
  }));
}, 150_000);

afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.coord_read_cursors WHERE owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

async function readOrientation(overrides: Record<string, unknown> = {}, ownerId = OWNER) {
  const result = await runWithWorkspace(WS, () => orientTool.handler(
    {
      mode: 'monitor',
      harness: 'papercusp',
      claimableLimit: 0,
      memoryLimit: 0,
      includeFleet: false,
      includeInbox: false,
      includePlanEvents: false,
      includeCatchup: false,
      includeRecipes: false,
      ...overrides,
    },
    {
      isSuperuser: true,
      uiClientId: ownerId,
      workspaceId: WS,
      harnessSlug: 'papercusp',
      metadata: vi.fn(),
      log: vi.fn(),
      progress: vi.fn(),
    } as never,
  ));
  return (result as { data: {
    obligations: obligationReader.AgentObligationBrief;
    goalPortfolio: goalSettings.GoalPortfolioBrief | null;
    facts?: Array<{ scope: string; ref: string | null; body: string }> | null;
    factsNarrowed?: unknown;
  } }).data;
}

describe('complete agenda recovery through coord:orient', () => {
  it('filters the real inbox listener while preserving a real substantive await through Orientation', async () => {
    vi.spyOn(pipelineHealth, 'fetchOrientPipeline').mockResolvedValue(null);
    const listener = inboxWakeKey(NON_GOAL_OWNER);
    const dependency = `work-item:done:WI-orient-wait-${RUN}`;
    const awaits = await runWithWorkspace(WS, async () => [
      await registerAwait({ subscriberId: NON_GOAL_OWNER, eventKey: listener, timeoutSec: null,
        timeoutBehavior: 'expire', policy: 'wake' }),
      await registerAwait({ subscriberId: NON_GOAL_OWNER, eventKey: dependency, timeoutSec: null,
        timeoutBehavior: 'wake', policy: 'wake' }),
    ]);
    try {
      const source = await runWithWorkspace(WS, () =>
        obligationReader.defaultAgentObligationReaderDeps().waitingOn(WS, NON_GOAL_OWNER));
      expect(source).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'event-await', key: listener }),
        expect.objectContaining({ kind: 'event-await', key: dependency }),
      ]));
      const read = await readOrientation({}, NON_GOAL_OWNER);
      expect(read.obligations).toBeTruthy();
      const rows = read.obligations.evaluations.filter(row => row.family === 'waiting-on');
      expect(rows.map(row => row.title)).toEqual([`Awaiting ${dependency}`]);
      expect(rows[0]?.status).toBe('blocked');
      expect(rows[0]?.priority).toBe('normal');
      expect(formatAgentObligationLine(rows[0]!, 'action')).toContain(`[BLOCKED] Awaiting ${dependency}`);
    } finally {
      await runWithWorkspace(WS, () => Promise.all(awaits.map(row =>
        cancelAwait({ awaitId: row.id, subscriberId: NON_GOAL_OWNER }))));
    }
  }, 90_000);

  it('delivers the canonical agenda to an attributable non-GOAL session', async () => {
    await recordOwnerDirective({
      workspaceId: WS,
      ownerId: NON_GOAL_OWNER,
      sessionRef: `session-${RUN}`,
      sourceTurnRef: `turn-${RUN}`,
      verbatimText: 'Deliver ordinary obligations to this non-GOAL session.',
      recordedBy: NON_GOAL_OWNER,
      capturedByHook: true,
    }, fx.admin);
    try {
      const read = await readOrientation({}, NON_GOAL_OWNER);

      expect(read.goalPortfolio).toBeUndefined();
      expect(read.obligations).toBeTruthy();
      expect(read.obligations.evaluations.map(entry => entry.family)).toContain('owner-directive');
    } finally {
      await fx.admin`
        DELETE FROM harness_shared.owner_directives
        WHERE workspace_id = ${WS} AND owner_id = ${NON_GOAL_OWNER}
      `;
    }
  }, 90_000);

  it('keeps proceed advice and retained requester history out of the reporting agenda', async () => {
    // The gate/deploy reader is outside this consultation contract and points
    // at a host runtime. Keep its established null fallback deterministic;
    // the real PostgreSQL agenda providers below remain enabled.
    const pipeline = vi.spyOn(pipelineHealth, 'fetchOrientPipeline').mockResolvedValue(null);
    const agendaRead = vi.spyOn(obligationReader, 'readAgentObligationAgenda');
    const ids = [`consult-proceed-${RUN}`, `consult-history-${RUN}`];
    const history = {
      answer: 'Reuse the existing routing seam.',
      reconciliation: { by: OWNER, at: new Date().toISOString(), disposition: 'confirmed' },
    };
    try {
      await fx.admin`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, responder_id, state,
           question, latency_contract, outcome, expires_at)
        VALUES
          (${WS}, ${ids[0]}, ${OWNER}, 'isolated-expert', 'active',
           'Which existing routing seam applies?', 'proceed', NULL, now() + interval '1 hour'),
          (${WS}, ${ids[1]}, ${OWNER}, 'isolated-expert', 'closed_answered',
           'Which existing routing seam applies?', 'proceed', ${fx.admin.json(history)}, now())
      `;
      const before = await fx.admin`
        SELECT conversation_id, requester_id, state, outcome FROM harness_shared.consult_state
        WHERE workspace_id = ${WS} AND conversation_id = ANY(${ids}) ORDER BY conversation_id
      `;
      expect(before).toHaveLength(2);
      expect(before.find(row => row.conversation_id === ids[1])?.outcome).toEqual(history);

      const read = await readOrientation();

      expect(pipeline).toHaveBeenCalled();
      // A real goal and its normal placement obligation are the positive
      // control: an empty or disconnected agenda must not prove retirement.
      expect(read.goalPortfolio?.goal.id).toBe(GOAL);
      expect(read.obligations.evaluations.map(entry => entry.ruleId)).toContain('goal-plan-placement');
      expect(agendaRead).toHaveBeenCalledTimes(1);
      const canonical: Awaited<ReturnType<typeof obligationReader.readAgentObligationAgenda>> =
        await agendaRead.mock.results[0].value;
      expect(canonical.degradedSources.filter(source => source.includes('waiting-on'))).toEqual([]);
      expect(read.obligations.evaluations.map(entry => entry.family)).not.toContain('consult-reconciliation');
      expect(JSON.stringify(read.obligations)).not.toContain('consult:reconcile');
      const after = await fx.admin`
        SELECT conversation_id, requester_id, state, outcome FROM harness_shared.consult_state
        WHERE workspace_id = ${WS} AND conversation_id = ANY(${ids}) ORDER BY conversation_id
      `;
      expect(after).toEqual(before);
    } finally {
      await fx.admin`
        DELETE FROM harness_shared.consult_state
        WHERE workspace_id = ${WS} AND conversation_id = ANY(${ids})
      `;
    }
  }, 90_000);

  it.each(['paused', 'achieved', 'killed'])(
    'does not deliver a pre-stop reporting receipt after the canonical goal becomes %s',
    async (status) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      const readAgenda = obligationReader.readAgentObligationAgenda;
      vi.spyOn(obligationReader, 'readAgentObligationAgenda')
        .mockImplementation((input) => readAgenda({ ...input, now: dueAt }));
      const priorReport = await ownerReportHistory.readGoalOwnerReportObligation(fx.admin, {
        workspaceId: WS, ownerId: OWNER, goalId: GOAL,
      }, dueAt.getTime());
      expect(priorReport?.obligation).toBe('overdue');
      // Capture a real due receipt and reproduce the torn read: reporting
      // retains this pre-stop generation while the portfolio observes the stop.
      vi.spyOn(ownerReportHistory, 'readGoalOwnerReportObligation').mockResolvedValue(priorReport);
      const before = await readOrientation();
      expect(before.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report')?.status).toBe('due');
      await fx.admin`
        UPDATE harness_shared.goals SET status = ${status}
        WHERE workspace_id = ${WS} AND id = ${GOAL}
      `;
      try {
        const after = await readOrientation();
        expect(after.goalPortfolio?.goal.status).toBe(status);
        const report = after.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report');
        const placement = after.obligations.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement');
        expect(report?.status).toBe('not-applicable');
        expect(report?.action).toBeUndefined();
        expect(placement?.status).toBe('not-applicable');
        expect(placement?.changeSignal).toBeUndefined();
        expect(after.obligations.primary.filter((entry) => entry.scope.goalId === GOAL)).toEqual([]);
        const rows = await fx.admin`
          SELECT status FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}
        `;
        expect(rows[0]?.status).toBe(status);
      } finally {
        // Only the disposable fixture goal is restored for sibling tests.
        await fx.admin`
          UPDATE harness_shared.goals SET status = 'active'
          WHERE workspace_id = ${WS} AND id = ${GOAL}
        `;
      }
    }, 90_000,
  );

  it('keeps an omitted real agenda unseen until a full warm delivery and re-delivers after a cold boundary', async () => {
    // The newly enabled holder is initially inside the reporting grace period.
    // Advance the reader's supported clock, retaining its real PostgreSQL data
    // and provider evaluation, to exercise an actual due opportunity.
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const readAgenda = obligationReader.readAgentObligationAgenda;
    const read = vi.spyOn(obligationReader, 'readAgentObligationAgenda')
      .mockImplementation((input) => readAgenda({ ...input, now: dueAt }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await readOrientation();
    const canonical = await read.mock.results[0].value;
    const brief = obligationReader.projectAgentTurnStartObligationBrief(canonical.agenda);
    const actionLines = brief.projection.text.split('\n').filter(Boolean);
    expect(actionLines.length, JSON.stringify({
      receipt: brief.projection.receipt,
      primary: canonical.agenda.primary.map((entry: obligationReader.AgentObligationBrief['evaluations'][number]) => ({
        ruleId: entry.ruleId, status: entry.status, chars: formatAgentObligationLine(entry).length,
      })),
    })).toBeGreaterThan(0);
    expect(brief.evaluations.some((entry) => entry.scope.goalId === GOAL)).toBe(true);
    let epoch = 1;
    // Unrelated orientation sources are stable; the agenda, projection, final
    // composer and PostgreSQL cursor are the production path under test.
    const deps: OrientationDeps = {
      planDecisions: async () => undefined,
      // Lock transitions are unrelated to the agenda under test — undefined is
      // the silent value, so this fixture asserts no lock posture.
      lockTransitions: async () => undefined,
      coupledPeers: async () => null,
      held: async () => [],
      historyUpdates: async () => [],
      effortUpdates: async () => [],
      openChecks: async () => [],
      // Unrelated to the agenda under test — null keeps the verdict line silent.
      authorityVerdict: async () => null,
      inbox: async () => ({ count: 3, newest: [] }),
      announcedGates: async () => [],
      openAsks: async () => null,
      modes: async () => [],
      loopArmed: async () => true,
      loopFireWithheld: async () => false,
      improvementTriage: async () => null,
      executableFrontier: async () => null,
      obligations: async () => brief,
      neverDropFacts: async () => [],
      toolSurface: async () => null,
      carryBlindWindow: async () => null,
      contextEpoch: async () => epoch,
    };
    const deliver = async (budgetChars: number) => (await buildTurnStartOrientationBlock({
      ownerId: OWNER, workspaceId: WS, budgetChars, deps,
    })).block;
    const cursor = async () => {
      const rows = await fx.admin`
        SELECT committed, pending FROM harness_shared.coord_read_cursors
        WHERE owner_id = ${OWNER} AND surface = ${ORIENTATION_CURSOR_SURFACE}
      `;
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    expect(await deliver(40)).toBe('');
    expect((await cursor()).pending).toBeNull();
    const crowded = await deliver(200);
    expect(crowded.length).toBeLessThanOrEqual(200);
    // The crowded delivery must still route to the complete agenda: either the
    // obligations row's own detailRef, or (D-027) the omission marker naming it.
    const recoveryPointer = crowded.includes(brief.detailRef)
      || /^- \+\d+ orientation rows omitted \([^)]*\bobligations\b[^)]*\) — coord:orient$/m.test(crowded);
    expect(recoveryPointer, crowded).toBe(true);
    expect(actionLines.some((line) => !crowded.includes(line))).toBe(true);
    expect((await cursor()).pending.obligations).not.toBe(brief.sourceGeneration);

    // Exercise the emitted recovery door in the same actual goal/owner scope.
    const recovered = await readOrientation();
    expect(recovered.obligations.evaluations.map((entry) => entry.id)).toEqual(
      canonical.agenda.evaluations.map((entry: { id: string }) => entry.id),
    );
    expect(recovered.obligations.evaluations.some((entry) => entry.scope.goalId === GOAL)).toBe(true);
    const warm = await deliver(2_000);
    for (const line of actionLines) expect(warm).toContain(line);
    expect((await cursor()).pending.obligations).toBe(brief.sourceGeneration);

    // P-002 CLASS-B RE-INJECT POLICY. A class-B row is discharged by
    // DISPOSITION, not by DELIVERY — so an identical next turn must RE-EMIT the
    // rows rather than fall silent. This assertion used to read `.toBe('')`,
    // which encoded exactly the one-shot behaviour P-002 replaced: the agenda
    // was committed as "seen" and an undispositioned owner directive never
    // reappeared.
    //
    // Note what is re-emitted: the ROW, not the whole block. Re-sending the
    // block would repeat unchanged held items/gates/facts and manufacture the
    // signal decay D-003 withdrew the triage line for.
    const reinjected = await deliver(2_000);
    for (const line of actionLines) expect(reinjected).toContain(line);
    // ...and it re-emits DESPITE the generation being committed, which is the
    // whole contract. Suppression itself is still guarded — the discharged
    // control lives in turn-start-class-b-reinject.test.ts, so a change that
    // made orientation unconditionally chatty fails THERE, not silently here.
    expect((await cursor()).committed.obligations).toBe(brief.sourceGeneration);

    epoch += 1;
    const cold = await deliver(2_000);
    for (const line of actionLines) expect(cold).toContain(line);
    const reinjectedAfterCold = await deliver(2_000);
    for (const line of actionLines) expect(reinjectedAfterCold).toContain(line);
  }, 90_000);

  it('preserves representative facts, worklists and exact obligation actions before matched R-5 timing', async () => {
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const realAgenda = obligationReader.readAgentObligationAgenda;
    type Arm = 'shared-portfolio' | 'independent-portfolio';
    let arm: Arm = 'shared-portfolio';
    const guardOnly = process.env.PAPERCUSP_R5_ORIENT_GUARD_ONLY === '1';
    const windowCount = guardOnly ? 0 : 10;
    // Only the supported observation clock is fixed. Every provider and store
    // remains real PostgreSQL; expected values below come from the seed contract.
    vi.spyOn(obligationReader, 'readAgentObligationAgenda')
      .mockImplementation(input => {
        // A current-code counterfactual: use the reader's production default
        // portfolio read instead of orient's shared promise. No fake providers.
        const { goalPortfolio: _shared, ...otherDeps } = input.deps ?? {};
        return realAgenda({ ...input, now: dueAt,
          ...(arm === 'independent-portfolio' ? { deps: otherDeps } : {}),
        });
      });
    const sources = [
      'packages/operator-core/lib/agent-tools/coordination/tools/orient.ts',
      'packages/operator-core/lib/agent-tools/coordination/tools/orient-obligations.integration.test.ts',
      'packages/operator-core/lib/agent-obligation-reader.ts',
      'packages/operator-core/lib/agent-obligation-providers.ts',
      'packages/operator-core/lib/agent-obligations.ts',
      'packages/operator-core/lib/agent-facts/store.ts',
      'packages/operator-core/lib/goal-launch-settings.ts',
      'packages/operator-core/lib/agent-tools/plans/__tests__/_pg-tool-fixture.ts',
      'packages/operator-core/lib/agent-tools/plans/plan-admission-preflight.ts',
      'packages/operator-core/lib/cache/instance.ts',
      'packages/operator-core/lib/cache/pg-l2-store.ts',
      'packages/operator-core/lib/goals/plan-closure-observations.ts',
      'packages/operator-core/lib/plan-acceptance-gate.ts',
      'packages/operator-core/lib/cache/cached-read.ts',
      'packages/operator-core/lib/cache/l2-tier.ts',
    ];
    const hashes = () => sources.map(path => ({ path,
      sha256: createHash('sha256').update(readFileSync(resolve(__dirname, '../../../../../..', path))).digest('hex'),
    }));
    const snapshots: unknown[] = [];
    const windows: Array<{ window: number; arm: Arm; samples: Array<{ phase: string; ms: number }>; complete: boolean }> = [];
    const report: Record<string, unknown> = { schemaVersion: 3, incomplete: true,
      sourceStart: hashes(), snapshots,
      startedAt: new Date().toISOString(), phaseProgress: [],
      buildIdentity: { pid: process.pid, parentPid: process.ppid, nodeVersion: process.version,
        repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: resolve(__dirname, '../../../../../..'), encoding: 'utf8',
        }).trim(),
        testRunGroup: process.env.PAPERCUSP_TEST_RUN_GROUP ?? null,
        ledgerHarness: process.env.PAPERCUSP_TEST_RUN_HARNESS ?? null,
        qualification: 'Named source hashes below identify the read files; repository HEAD alone does not identify dirty bytes or the full loaded import graph.',
      },
      windows, mode: guardOnly ? 'guard-only' : 'guard-and-performance',
      workload: { plans: 8, itemsPerPlan: 128, workItems: 128, visibleFacts: 3,
        windows: windowCount, warmReads: 20, concurrency: 8 },
      scope: 'Production orient handler with real GOAL providers, plan/queue sources and fact store. Orientation only; no whole R-5 or shipment claim.',
      baselineDefinition: 'Current production reader performs its own portfolio read instead of sharing orient\'s promise. This is a source-read counterfactual, not a historical checkout.',
      coldDefinition: 'Reset the operator L1 and clear this fixture workspace from durable L2. PostgreSQL buffers, connections, imports and independent source caches remain warm.',
      limitations: ['Named hashes are not the complete imported graph.', 'The initial process read is recorded separately, not erased by warmup.', 'No HTTP transport, deployed-runtime or historical-source claim.'],
    };
    const publish = () => {
      if (process.env.PAPERCUSP_R5_ORIENT_PHASE_REPORT) {
        writeFileSync(process.env.PAPERCUSP_R5_ORIENT_PHASE_REPORT, JSON.stringify(report, null, 2) + '\n');
      }
    };
    const progress = (phase: string) => {
      report.currentPhase = phase;
      (report.phaseProgress as Array<{ phase: string; at: string }>).push({ phase, at: new Date().toISOString() });
      publish();
    };
    const key = `r5-orient-${RUN}`;
    const slugs = Array.from({ length: 8 }, (_, n) => `${key}-plan-${n}`);
    const refs = slugs.map(slug => `plan:papercusp/${slug}`);
    const seedPopulation = async () => {
      for (const slug of slugs) {
        progress(`seed-plan:${slug}`);
        const body = `---\ntitle: ${slug}\nstatus: draft\n---\n\n## Work\n` +
          Array.from({ length: 128 }, (_, n) => `- **P-${String(n + 1).padStart(3, '0')}** \`todo\` Representative orientation item ${n}`).join('\n');
        await seedPlan(fx.admin, WS, 'papercusp', slug, body);
        await fx.admin`UPDATE harness_shared.harness_plans SET title = ${slug}, status = 'draft', goal_id = ${GOAL}
          WHERE workspace_id = ${WS} AND harness_slug = 'papercusp' AND plan_slug = ${slug}`;
        await fx.admin`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, status, item_text)
          SELECT ${WS}, 'papercusp', ${slug}, 'P-' || lpad(n::text, 3, '0'), n, 'todo', 'Representative orientation item ' || n
          FROM generate_series(1, 128) n`;
      }
      await fx.admin`UPDATE harness_shared.goals SET properties = jsonb_set(COALESCE(properties, '{}'::jsonb), '{worklist}',
        ${fx.admin.json({ value: refs })}::jsonb, true) WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      await fx.admin`INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, title, status, item_kind, goal_id, payload)
        SELECT ${WS}, 'papercusp', ${key} || '-WI-' || n, 'Representative goal queue item ' || n,
          (ARRAY['open','blocked','done','needs-human'])[1 + (n % 4)], 'task', ${GOAL},
          CASE WHEN n % 4 = 1 THEN jsonb_build_object(
            'blockedReason', 'Representative fixture prerequisite', 'blockedAt', now()) ELSE '{}'::jsonb END
        FROM generate_series(1, 128) n`;
      // Populate the same canonical persisted observations production reads.
      // The actual gate must independently reject these uncontracted seed plans.
      const { evaluatePlanAcceptanceGate } = await import('../../../plan-acceptance-gate');
      const observations: Array<{ slug: string; code: string | undefined; satisfied: boolean; ms: number }> = [];
      report.closurePreflight = observations;
      for (const slug of slugs) {
        progress(`closure-preflight-start:${slug}`);
        const start = performance.now();
        const gate = await runWithWorkspace(WS, () => evaluatePlanAcceptanceGate(slug, { harnessSlug: 'papercusp' }));
        observations.push({ slug, code: gate.code, satisfied: gate.satisfied, ms: performance.now() - start });
        progress(`closure-preflight-observed:${slug}`);
        expect(gate.satisfied).toBe(false);
        expect(gate.code).toBe('acceptance_bar_contract_not_ready');
      }
      progress('closure-preflight-passed');
    };
    const fact = async (scope: 'owner' | 'harness', factKey: string, body: string, audienceScope?: string) => {
      const receipt = await assertFact({ workspaceId: WS, scope,
        scopeRef: scope === 'owner' ? OWNER : 'papercusp', key: factKey, body,
        createdBy: OWNER, ttlSec: 3_600, ...(audienceScope ? { audienceScope } : {}),
      }, fx.admin);
      expect(receipt.key).toBe(factKey);
      expect(receipt.body).toBe(body);
    };
    const expectedFacts = (changed: boolean) => [
      { scope: 'owner', ref: OWNER, body: `R-5 ordinary owner fact ${key}${changed ? ' updated' : ''}` },
      { scope: 'owner', ref: OWNER, body: `R-5 owner guard rail ${key}` },
      { scope: 'harness', ref: 'papercusp', body: `R-5 harness fact ${key}` },
    ].sort((a, b) => a.body.localeCompare(b.body));
    const read = async (phase: string, changed = false, paused = false, record = true) => {
      if (record) progress(`read-start:${phase}`);
      const start = performance.now();
      const data = await readOrientation({ mode: 'full' });
      const ms = performance.now() - start;
      // Harness-scoped facts are shared by every run of this file: a run killed before its
      // `finally` leaves a 1h-TTL harness fact behind. Compare only this run's marker; the
      // hidden fleet fact carries it too, so an audience-scope leak still fails here.
      const facts = (data.facts ?? []).map(({ scope, ref, body }) => ({ scope, ref, body }))
        .filter(({ body }) => body.includes(key))
        .sort((a, b) => a.body.localeCompare(b.body));
      const states = data.obligations?.evaluations.map(row => ({ ruleId: row.ruleId, status: row.status }))
        .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
      if (record) {
        snapshots.push({ phase, arm, ms, facts, states, obligations: data.obligations,
          worklist: data.goalPortfolio?.worklist, queue: data.goalPortfolio?.queue });
        publish();
      }
      expect(data.factsNarrowed).toBeUndefined();
      expect(facts).toEqual(expectedFacts(changed));
      expect(data.goalPortfolio?.goal.id).toBe(GOAL);
      expect(data.goalPortfolio?.goal.status).toBe(paused ? 'paused' : 'active');
      expect(data.goalPortfolio?.worklist.map(row => row.ref)).toEqual(refs);
      for (const [n, plan] of data.goalPortfolio!.worklist.entries()) {
        expect(plan).toMatchObject({ ordinal: n + 1, harness: 'papercusp', slug: slugs[n], title: slugs[n], status: 'draft',
          counts: { todo: 128, wip: 0, blocked: 0, needsHuman: 0, done: 0 },
          next: { id: 'P-001', blockedBy: [] } });
      }
      expect(data.goalPortfolio?.queue).toMatchObject({ total: 128, terminal: 32, inFlight: 0, blocked: 32, needsHuman: 32 });
      expect(states).toEqual([
        { ruleId: 'goal-owner-report', status: paused ? 'not-applicable' : 'due' },
        { ruleId: 'goal-plan-placement', status: paused ? 'not-applicable' : 'blocked' },
        { ruleId: 'goal-planning-needed', status: paused ? 'not-applicable' : 'due' },
        { ruleId: 'owner-directive-disposition', status: 'not-applicable' },
        { ruleId: 'waiting-on-progress', status: 'not-applicable' },
        ...slugs.map(() => ({ ruleId: 'plan-independent-verification', status: 'due' })),
      ].sort((a, b) => a.ruleId.localeCompare(b.ruleId)));
      expect(data.obligations.evaluations.every(row => row.scope.workspaceId === WS && row.scope.ownerId === OWNER)).toBe(true);
      expect(data.obligations.primary.map(row => row.ruleId).sort())
        .toEqual([...slugs.map(() => 'plan-independent-verification'),
          ...(paused ? [] : ['goal-owner-report', 'goal-plan-placement', 'goal-planning-needed'])].sort());
      const byRule = new Map(data.obligations.evaluations.map(row => [row.ruleId, row]));
      const verification = data.obligations.evaluations.filter(row => row.ruleId === 'plan-independent-verification');
      expect(verification.map(row => row.scope.planSlug).sort()).toEqual([...slugs].sort());
      for (const row of verification) {
        expect(row.action).toEqual({ kind: 'repair', targetRef: row.scope.planSlug,
          summary: 'repair acceptance_bar_contract_not_ready before requesting a grader', continuesCurrentWork: false });
        expect(row.authority).toMatchObject({ kind: 'policy', sourceRef: 'plan-acceptance-gate' });
        expect(row.clearsWhen).toMatchObject({ evidenceKind: 'verdict', sourceRef: 'evaluatePlanAcceptanceGate' });
        expect(row.evidence.map(e => e.ref)).toEqual([`plan-acceptance:${row.scope.planSlug}:${row.sourceGeneration}`]);
      }
      for (const row of data.obligations.evaluations) {
        expect(row.responsibleOwnerId).toBe(OWNER);
        expect(row.measurementFailure).toBeUndefined();
        expect(row.sourceGeneration).toBeTruthy();
        expect(row.id).toMatch(/^obl:/);
        expect(row.evidence.every(e => !!e.ref && !!e.observedAt)).toBe(true);
      }
      expect(byRule.get('goal-owner-report')).toMatchObject({
        authority: { kind: 'policy', sourceRef: 'system-health/goal-owner-report-watchdog' },
        clearsWhen: { evidenceKind: 'delivery', sourceRef: 'makeReadGoalModeOwners:three-source-report-union' },
      });
      expect(byRule.get('goal-plan-placement')).toMatchObject({
        authority: { kind: 'policy', sourceRef: 'goal-launch-settings+system-health/goal-drain-fleet-watchdog' },
        clearsWhen: { sourceRef: 'GoalPortfolioBrief.worklist[].placement+resolvePlanClosure+resolveGoalLaunch+classifyGoalPlanFleetCoverage' },
      });
      expect(byRule.get('goal-planning-needed')).toMatchObject({
        authority: { kind: 'policy', sourceRef: 'modes/registry:goal+scout_ticks.goalReview' },
        clearsWhen: { sourceRef: 'scout_ticks.detail.goalReview+GoalPortfolioBrief' },
      });
      if (!paused) {
        expect(byRule.get('goal-owner-report')?.action).toEqual({ kind: 'report',
          summary: 'send MOVED / COST / OWNER-WALLED / KILLED / NEXT WAKE on a canonical owner-facing rail now', tool: 'coord:send', args: { to: ['human'] } });
        expect(byRule.get('goal-owner-report')?.evidence.map(row => row.ref)).toEqual([`goal-owner-report:${GOAL}:baseline`]);
        expect(byRule.get('goal-plan-placement')?.action).toEqual({ kind: 'repair', targetRef: refs[0],
          summary: 'The plan is draft and cannot launch until its lifecycle/start gate is satisfied.' });
        expect(byRule.get('goal-planning-needed')?.action).toEqual({ kind: 'inspect', targetRef: `goal:${GOAL}`, recoveryRef: 'coord:orient',
          summary: 'Review uncovered goal outcomes; staff executable plans first, then record a supported planning disposition.' });
      } else {
        for (const rule of ['goal-owner-report', 'goal-plan-placement', 'goal-planning-needed']) expect(byRule.get(rule)?.action).toBeUndefined();
      }
      return ms;
    };
    const pendingL2: Promise<unknown>[] = [];
    const settleL2 = async () => { await Promise.all(pendingL2.splice(0)); };
    publish();
    try {
      progress('fixture-identity');
      const [databaseIdentity] = await fx.admin`SELECT current_database() AS database,
        current_user AS database_user, pg_backend_pid() AS backend_pid,
        inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
        pg_postmaster_start_time()::text AS postmaster_started_at, version() AS server_version`;
      report.databaseIdentity = databaseIdentity;
      expect(databaseIdentity?.database).toBeTruthy();
      progress('cache-setup');
      setFlagOverridesForTest({ 'papercusp-cache-layer': true, 'papercusp-cache-l2': true });
      resetOperatorCacheForTests();
      __setCachedReadEnabledForTests(true);
      await _refreshCacheLayerForTests();
      await _refreshL2FlagForTests();
      const store = getL2Store();
      const set = store.set.bind(store);
      vi.spyOn(store, 'set').mockImplementation((...args) => {
        const pending = set(...args); pendingL2.push(pending); return pending;
      });
      await seedPopulation();
      await fact('owner', key, expectedFacts(false).find(row => row.body.startsWith('R-5 ordinary'))!.body);
      await fact('owner', `guard-rail:${key}`, `R-5 owner guard rail ${key}`);
      await fact('harness', key, `R-5 harness fact ${key}`);
      await fact('owner', `hidden-${key}`, `R-5 hidden fleet fact ${key}`, `fleet:unjoined-${RUN}`);
      await read('seeded-guard');
      await fact('owner', key, `R-5 ordinary owner fact ${key} updated`);
      await read('fact-write-guard', true);
      await fx.admin`UPDATE harness_shared.goals SET status = 'paused' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      await read('goal-stop-guard', true, true);
      await fx.admin`UPDATE harness_shared.goals SET status = 'active' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      arm = 'independent-portfolio';
      await read('independent-source-guard', true);
      report.phaseGuardsPassed = true;
      progress('phase-guards-passed');
      const cold = async () => {
        await settleL2();
        resetOperatorCacheForTests();
        await getL2Store().clearWorkspace(WS);
      };
      for (let window = 0; window < windowCount; window++) {
        const arms: Arm[] = window % 2 ? ['shared-portfolio', 'independent-portfolio'] : ['independent-portfolio', 'shared-portfolio'];
        for (const nextArm of arms) {
          arm = nextArm;
          progress(`matrix-window:${window}:${arm}`);
          const row = { window, arm, samples: [] as Array<{ phase: string; ms: number }>, complete: false };
          windows.push(row); publish();
          await cold();
          row.samples.push({ phase: 'cold', ms: await read('cold', true, false, false) });
          for (let i = 0; i < 20; i++) row.samples.push({ phase: 'warm', ms: await read('warm', true, false, false) });
          row.samples.push(...await Promise.all(Array.from({ length: 8 }, async () => ({ phase: 'warm-concurrent', ms: await read('warm-concurrent', true, false, false) }))));
          await cold();
          row.samples.push(...await Promise.all(Array.from({ length: 8 }, async () => ({ phase: 'cold-concurrent', ms: await read('cold-concurrent', true, false, false) }))));
          row.complete = true; publish();
        }
      }
      const summary = guardOnly ? [] : (['shared-portfolio', 'independent-portfolio'] as Arm[]).map(value => ({ arm: value,
        phases: Object.fromEntries(['cold', 'warm', 'warm-concurrent', 'cold-concurrent'].map(phase => {
          const times = windows.filter(row => row.arm === value).flatMap(row => row.samples).filter(s => s.phase === phase).map(s => s.ms).sort((a, b) => a - b);
          return [phase, { reads: times.length, p95Ms: times[Math.ceil(times.length * .95) - 1], maxMs: times.at(-1) }];
        })),
      }));
      report.summary = summary;
      if (!guardOnly) for (const result of Object.values(summary[0]!.phases)) expect(result.p95Ms).toBeLessThanOrEqual(5_000);
      await fact('owner', key, expectedFacts(false).find(row => row.body.startsWith('R-5 ordinary'))!.body);
      arm = 'shared-portfolio';
      await read('final-fact-write-guard');
      report.sourceEnd = hashes();
      expect(report.sourceEnd).toEqual(report.sourceStart);
      report.incomplete = false;
      report.completedAt = new Date().toISOString();
      progress('completed');
    } catch (error) {
      report.error = error instanceof Error ? error.stack : String(error);
      report.failedAt = new Date().toISOString();
      throw error;
    } finally {
      publish();
      await settleL2();
      await getL2Store().clearWorkspace(WS);
      await fx.admin`UPDATE harness_shared.goals SET status = 'active' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      await fx.admin`DELETE FROM harness_shared.agent_facts WHERE created_by = ${OWNER} AND key IN (${key}, ${`guard-rail:${key}`}, ${`hidden-${key}`})`;
      await fx.admin`UPDATE harness_shared.goals SET properties = COALESCE(properties, '{}'::jsonb) - 'worklist' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND goal_id = ${GOAL}`;
      await fx.admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND plan_slug = ANY(${slugs})`;
      await fx.admin`DELETE FROM harness_shared.plan_closure_observations WHERE workspace_id = ${WS} AND plan_slug = ANY(${slugs})`;
      for (const slug of slugs) await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = 'papercusp' AND plan_slug = ${slug}`;
      resetOperatorCacheForTests();
      __setCachedReadEnabledForTests(false);
      setFlagOverridesForTest(null);
    }
  }, 600_000);

  it('returns the canonical full agenda from the production handler', async () => {
    // Observe the real read without replacing it. A second read can legitimately
    // have a different timeout/generation, so compare delivery to its own source.
    const read = vi.spyOn(obligationReader, 'readAgentObligationAgenda');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = await readOrientation();
    expect(data.obligations, 'the recovery target must expose an agenda, not an absent/null fold').toBeTruthy();
    const obligations = data.obligations as obligationReader.AgentObligationBrief;
    expect(obligations.evaluations.length).toBeGreaterThan(0);
    expect(obligations.evaluations.every((entry) => typeof entry.id === 'string' && entry.id.length > 0)).toBe(true);
    expect(obligations.detailRef).toBe('coord:orient for the complete obligation agenda');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, ownerId: OWNER, goalId: GOAL }));
    const canonical = await read.mock.results[0].value;
    expect(obligations.evaluations).toEqual(canonical.agenda.evaluations);
    expect(obligations.primary).toEqual(canonical.agenda.primary);
    expect(obligations.evaluations.map((entry) => entry.ruleId)).toEqual(
      expect.arrayContaining(['goal-plan-placement', 'goal-owner-report']),
    );
    for (const entry of obligations.evaluations.filter((entry) => entry.status === 'unknown')) {
      expect(entry.measurementFailure?.detail).toBeTruthy();
      expect(entry.measurementFailure?.retry).toBeTruthy();
    }
    for (const [warning] of warnings.mock.calls) {
      expect(String(warning)).toMatch(/^\[bounded-timeout\] agent-obligations:/);
      expect(canonical.degradedSources.length).toBeGreaterThan(0);
      expect(obligations.evaluations.some((entry) => entry.status === 'unknown')).toBe(true);
    }
  }, 90_000);

  it.each(['brief-only', 'baseline'] as const)(
    'withholds the agenda from orient under the %s experiment arm, as the turn-start surface does (R-4 / D-047)',
    async (arm) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const read = vi.spyOn(obligationReader, 'readAgentObligationAgenda');
      const [original] = await fx.admin`
        SELECT launch_settings FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}
      `;
      await fx.admin`
        UPDATE harness_shared.goals
           SET launch_settings = COALESCE(launch_settings, '{}'::jsonb) || ${fx.admin.json({ behaviorArm: arm })}
        WHERE workspace_id = ${WS} AND id = ${GOAL}
      `;
      try {
        const data = (await readOrientation()) as Awaited<ReturnType<typeof readOrientation>> & {
          obligationsWithheldBy?: string;
        };
        expect(data.obligations).toBeNull();
        expect(data.obligationsWithheldBy).toBe('experiment-arm');
        expect(read).not.toHaveBeenCalled();
      } finally {
        await fx.admin`
          UPDATE harness_shared.goals
             SET launch_settings = ${original?.launch_settings == null ? null : fx.admin.json(original.launch_settings)}
          WHERE workspace_id = ${WS} AND id = ${GOAL}
        `;
      }
      // Calibration: the same holder on the default (full) arm gets the agenda back.
      const restored = (await readOrientation()) as Awaited<ReturnType<typeof readOrientation>> & {
        obligationsWithheldBy?: string;
      };
      expect(restored.obligations).toBeTruthy();
      expect(restored.obligationsWithheldBy).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(1);
    }, 90_000,
  );

  it('preserves a failed portfolio read as unknown and recovers through the same scoped tool', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = `P007 controlled portfolio read failure ${RUN}`;
    // orient reads the portfolio ONCE through the staged reader and hands the obligation
    // fold its uncounted snapshot (EI-25191349922959563), so the failure is injected there.
    // Spying on the exported readGoalPortfolioBrief measured nothing: orient never calls it
    // (WI-10006747). The rejection is pre-handled so it cannot surface as an unhandled one.
    const rejected = Promise.reject(new Error(failure));
    rejected.catch(() => undefined);
    const portfolio = vi
      .spyOn(goalSettings, 'readGoalPortfolioBriefStaged')
      .mockReturnValueOnce({ snapshot: rejected, counted: rejected });
    const failed = await readOrientation();
    expect(portfolio).toHaveBeenCalledWith({ workspaceId: WS, goalId: GOAL, attestOwnerId: OWNER });
    const placement = failed.obligations.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement');
    expect(placement?.status).toBe('unknown');
    expect(placement?.measurementFailure?.detail).toContain(failure);
    expect(placement?.measurementFailure?.retry).toBeTruthy();
    expect(placement?.scope).toMatchObject({ workspaceId: WS, ownerId: OWNER, goalId: GOAL });
    expect(failed.obligations.detailRef).toBe('coord:orient for the complete obligation agenda');

    portfolio.mockRestore();
    const recovered = await readOrientation();
    expect(recovered.goalPortfolio).toBeTruthy();
    const recoveredPlacement = recovered.obligations.evaluations.find((entry) => entry.ruleId === 'goal-plan-placement');
    expect(recoveredPlacement?.scope).toEqual(placement?.scope);
    expect(recoveredPlacement?.measurementFailure?.detail ?? '').not.toContain(failure);
    for (const [warning] of warnings.mock.calls) {
      expect(String(warning)).toMatch(/^\[bounded-timeout\] (?:agent-obligations:|orient:goalPortfolio)/);
    }
  }, 90_000);

  it('keeps unreadable report history unknown and executes its emitted recovery in the same scope', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = `P007 controlled report-history read failure ${RUN}`;
    // This is the production three-rail history reader, shared by the handler
    // and obligation provider. Fail both reads, not whichever happens to race first.
    const history = vi.spyOn(ownerReportHistory, 'readGoalOwnerReportObligation')
      .mockRejectedValue(new Error(failure));
    const failed = await readOrientation();
    const report = failed.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report');
    expect(report?.status).toBe('unknown');
    expect(report?.scope).toMatchObject({ workspaceId: WS, ownerId: OWNER, goalId: GOAL });
    expect(report?.measurementFailure?.detail).toContain(failure);
    expect(report?.measurementFailure?.retry).toContain('readGoalOwnerReportObligation');
    expect(report?.action).toMatchObject({ kind: 'inspect', targetRef: 'readGoalOwnerReportObligation' });
    expect(failed.obligations.projection.text).toContain('UNKNOWN');

    history.mockRestore();
    // Resolve the emitted target, then actually execute it against the same
    // isolated PostgreSQL scope. A string-presence assertion alone is not recovery.
    const recoveryReaders = {
      readGoalOwnerReportObligation: ownerReportHistory.readGoalOwnerReportObligation,
    };
    const recovery = recoveryReaders[report!.action!.targetRef as keyof typeof recoveryReaders];
    expect(recovery).toBeTypeOf('function');
    const recoveredHistory = await recovery(fx.admin, {
      workspaceId: report!.scope.workspaceId,
      ownerId: report!.scope.ownerId!,
      goalId: report!.scope.goalId!,
    });
    expect(recoveredHistory?.obligation).toBe('not-due');
    expect(recoveredHistory?.lastReportAt).toBeNull();

    // The goal is genuinely within its initial reporting grace period. Its
    // measured no-demand must differ from the failed-history UNKNOWN above.
    const recovered = await readOrientation();
    const recoveredReport = recovered.obligations.evaluations.find((entry) => entry.ruleId === 'goal-owner-report');
    expect(recoveredReport?.scope).toEqual(report?.scope);
    expect(recoveredReport).toMatchObject({
      status: 'not-applicable',
      title: 'Owner report is not due yet',
      applicableDemand: 0,
    });
    expect(recoveredReport?.reason).toMatch(/^not due:/);
    expect(recoveredReport?.measurementFailure).toBeUndefined();
    expect(recoveredReport?.reason).not.toContain(failure);
  }, 90_000);
});
