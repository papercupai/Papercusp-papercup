/** Durable system actions for work-item admission P-003/P-004. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { AdmissionRecoveryDeps } from '../../work-item-admission-recovery';
import { captureImprovement } from '../improvements/capture-core';
import { notifySyncInvalidate } from '../../sync-sse';
import { reapStrandedAdmissionRuns, type ReapedAdmissionRun } from '../../admission-runs-reaper';
import {
  DEFAULT_PROMOTER_BATCH_SIZE,
  DEFAULT_PROMOTER_LIVENESS_MINUTES,
  DEFAULT_PROMOTER_TICK_MINUTES,
  readPromoterLiveness,
  runWorkItemAdmissionFailOpen,
  runWorkItemAdmissionPromoter,
  settleAdmissionRunReplacedByRecovery,
  normalizeAdmissionTargetIds,
  WORK_ITEM_ADMISSION_FAIL_OPEN,
  WORK_ITEM_ADMISSION_PROMOTER,
  type FailOpenRunResult,
  type PromoterRunResult,
  type PromoterLlmCall,
} from '../../work-items-admission-promoter';
import { optionalModelSpec } from '../../learning/model-policy';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { computeNextFire, type ScheduleTrigger } from './schedule-next';

const ordinarySlotSchema = z.object({
  dueAt: z.string().refine((value) => Number.isFinite(Date.parse(value))).nullable(),
  runId: z.string().min(1).optional(),
  completedRunIds: z.array(z.string()).max(2).optional(),
  result: z.custom<PromoterRunResult>((value) => !!value && typeof value === 'object' &&
    typeof (value as PromoterRunResult).runId === 'string').optional(),
});
type OrdinarySlot = z.infer<typeof ordinarySlotSchema>;
type OrdinaryRoutine = {
  id: string; trigger_config: ScheduleTrigger; metadata: Record<string, unknown> | null; now: Date;
};

async function ordinaryRoutine(sql: Sql, options: ReturnType<typeof admissionPromoterOptions>) {
  const rows = await sql<(Omit<OrdinaryRoutine, 'now'> & { now: Date | string })[]>`
    SELECT id, trigger_config, metadata, now() AS now FROM harness_shared.routines
     WHERE workspace_id = ${options.workspaceId} AND install_slug = ${options.harnessSlug}
       AND name = ${WORK_ITEM_ADMISSION_PROMOTER}
       AND target_role = ${`system:${WORK_ITEM_ADMISSION_PROMOTER}`} AND active = true
       AND (trigger_config->>'cron' IS NOT NULL OR trigger_config->>'rrule' IS NOT NULL)
     FOR UPDATE`;
  if (rows.length !== 1) throw new Error('ordinary admission requires one active recurring promoter');
  const routine = rows[0]!;
  // The operator's SQL transport can return raw timestamptz strings. Normalize
  // before both deadline comparison and recurrence calculation; the fresh-PG
  // connection's default Date parser otherwise hides this production boundary.
  const now = routine.now instanceof Date ? routine.now : new Date(routine.now);
  if (!Number.isFinite(now.getTime())) throw new Error('ordinary admission requires a valid database clock');
  return { ...routine, now };
}

function nextOrdinaryDeadline(routine: OrdinaryRoutine): string | null {
  const next = computeNextFire(routine.trigger_config, routine.now);
  return next?.toISOString() ?? null;
}

async function claimOrdinarySlot(
  sql: Sql, options: ReturnType<typeof admissionPromoterOptions>, force = false,
): Promise<OrdinarySlot | null> {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Sql;
    const routine = await ordinaryRoutine(tx, options);
    const slot = ordinarySlotSchema.parse(routine.metadata?.admissionOrdinarySlot ?? {
      // Legacy accelerated rows have lost their natural deadline. Establish the
      // next recurring boundary once; subsequent requests cannot postpone it.
      dueAt: nextOrdinaryDeadline(routine),
    });
    if (slot.completedRunIds?.includes(options.runId) && slot.result) return slot;
    const claimed = slot.runId || force || slot.dueAt !== null && Date.parse(slot.dueAt) <= routine.now.getTime();
    const next = claimed ? { ...slot, runId: slot.runId ?? options.runId } : slot;
    await tx`UPDATE harness_shared.routines SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb), '{admissionOrdinarySlot}',
      ${JSON.stringify(next)}::text::jsonb) WHERE id = ${routine.id}`;
    return claimed ? next : null;
  });
}

async function finishOrdinarySlot(
  sql: Sql, options: ReturnType<typeof admissionPromoterOptions>, result: PromoterRunResult,
): Promise<void> {
  await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Sql;
    const routine = await ordinaryRoutine(tx, options);
    const slot = ordinarySlotSchema.parse(routine.metadata?.admissionOrdinarySlot);
    if (slot.runId !== result.runId) throw new Error('ordinary admission slot changed during execution');
    const next = { dueAt: nextOrdinaryDeadline(routine),
      completedRunIds: [...new Set([result.runId, options.runId])], result };
    // The run ledger outlives later slot cycles, so an old workflow replay must
    // never fall back to exact recovery after its metadata witness is replaced.
    await tx`UPDATE harness_shared.admission_runs SET detail = jsonb_set(
      detail, '{ordinarySlotResult}', ${JSON.stringify(result)}::text::jsonb)
      WHERE id = ${result.runId} AND workspace_id = ${options.workspaceId}
        AND harness_slug = ${options.harnessSlug} AND detail->>'status' = 'complete'`;
    await tx`UPDATE harness_shared.routines SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb), '{admissionOrdinarySlot}', ${JSON.stringify(next)}::text::jsonb),
      next_fire_at = CASE WHEN EXISTS (
        SELECT 1 FROM harness_shared.work_items
         WHERE workspace_id = ${options.workspaceId} AND harness_slug = ${options.harnessSlug}
           AND payload #>> '{_admissionRecovery,routineId}' = ${routine.id}
           AND payload #>> '{_admissionRecovery,state}' = 'queued'
      ) THEN LEAST(COALESCE(next_fire_at, now()), now()) ELSE next_fire_at END
      WHERE id = ${routine.id}`;
  });
}

async function completedOrdinaryResult(
  sql: Sql, options: ReturnType<typeof admissionPromoterOptions>, runId: string, storedOnly = false,
): Promise<PromoterRunResult | null> {
  const [row] = await sql<{ result: PromoterRunResult }[]>`
    SELECT COALESCE(detail->'ordinarySlotResult', jsonb_build_object(
      'runId', id, 'batchSize', batch_size, 'flaggedPairs', detail->'flaggedPairs',
      'promoted', promoted, 'merged', merged, 'held', held,
      'modelCalled', model_id IS NOT NULL, 'tokensIn', tokens_in, 'tokensOut', tokens_out,
      'censusBefore', census_before, 'censusAfter', census_after,
      'guardRefusals', detail->'guardRefusals', 'writerCoverageGap', detail->'writerCoverageGap'
    )) AS result FROM harness_shared.admission_runs
     WHERE id = ${runId} AND workspace_id = ${options.workspaceId}
       AND harness_slug = ${options.harnessSlug} AND run_kind = 'promoter-tick'
       AND detail->>'mode' = 'promoter' AND detail->>'status' = 'complete'
       AND (${storedOnly} AND detail ? 'ordinarySlotResult'
         OR ${!storedOnly} AND detail ? 'componentScreening')`;
  return row?.result ?? null;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function runId(action: string): string {
  return DBOS.workflowID?.trim() || `${action}:${randomUUID()}`;
}

export interface AdmissionPromoterActionDeps {
  run: (ctx: SystemActionCtx) => Promise<PromoterRunResult>;
  alarm: (ctx: SystemActionCtx, result: PromoterRunResult) => Promise<void>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

export function admissionPromoterOptions(ctx: SystemActionCtx) {
  const payload = ctx.payloadTemplate ?? {};
  const targetItemIds = normalizeAdmissionTargetIds(payload.targetItemIds);
  return {
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId: runId(WORK_ITEM_ADMISSION_PROMOTER),
    batchSize: positiveInteger(payload.batchSize, DEFAULT_PROMOTER_BATCH_SIZE),
    recentTerminalDays: positiveInteger(payload.recentTerminalDays, 30),
    model: optionalModelSpec(payload.model, 'admission promoter'),
    ...(targetItemIds === undefined ? {} : { targetItemIds }),
  };
}

async function productionPromoter(ctx: SystemActionCtx): Promise<PromoterRunResult> {
  if (process.env.VITEST) throw new Error('production admission promoter must not run from a unit test');
  const options = admissionPromoterOptions(ctx);
  if (process.env.PAPERCUSP_WORK_ITEM_ADMISSION_PROMOTER === 'off') {
    throw new Error('work-item admission promoter is disabled by PAPERCUSP_WORK_ITEM_ADMISSION_PROMOTER=off');
  }
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { gatewayLlmEnv } = await import('../../inference-gateway/spawn-env');
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const { llmCall } = await import('../../llm-testing/llm-client');
  const { authorizeAdmissionRecovery } = await import('../../work-item-admission-recovery');
  const { assignAndWakeActionableWorkItems } = await import('../../agent-tools/coordination/actionable-work-item-dispatch');
  return runAdmissionPromoterWithRecovery(options, {
    sql: getOrgPg().sql,
    authorize: authorizeAdmissionRecovery,
    dispatch: assignAndWakeActionableWorkItems,
    llmCall: (input) => llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug }),
  });
}

/** The production composition, with explicit I/O so fresh-PG integration tests
 * exercise the same wiring without bypassing the live-runtime VITEST guard.
 * This is not another scheduler: the existing system action remains its caller.
 */
export async function runAdmissionPromoterWithRecovery(
  options: ReturnType<typeof admissionPromoterOptions>,
  deps: Pick<AdmissionRecoveryDeps, 'authorize' | 'dispatch' | 'lockSql'> & { sql: Sql; llmCall: PromoterLlmCall },
): Promise<PromoterRunResult> {
  const { withAdmissionPromoterLock } = await import('../../work-item-admission-recovery');
  // Explicit targets retain their original scope and never consume an ordinary slot.
  if (options.targetItemIds !== undefined) {
    return runWorkItemAdmissionPromoter({ ...options, sql: deps.sql, llmCall: deps.llmCall });
  }
  const result = await withAdmissionPromoterLock(options, deps.lockSql, () => admissionPromoterPass(options, deps));
  // Another workflow owns this invocation. As in the per-request lock, a losing
  // consumer performs no writes and leaves the owning workflow to finish.
  return result ?? { runId: options.runId, batchSize: 0, flaggedPairs: 0,
    promoted: 0, merged: 0, held: 0, modelCalled: false, tokensIn: 0, tokensOut: 0,
    censusBefore: 0, censusAfter: 0, guardRefusals: [], writerCoverageGap: [] };
}

async function admissionPromoterPass(
  options: ReturnType<typeof admissionPromoterOptions>,
  deps: Pick<AdmissionRecoveryDeps, 'authorize' | 'dispatch' | 'lockSql'> & { sql: Sql; llmCall: PromoterLlmCall },
): Promise<PromoterRunResult> {
  const { runAdmissionRecoveries, readAuthorizedComponentScreening } = await import('../../work-item-admission-recovery');
  const completed = await completedOrdinaryResult(deps.sql, options, options.runId, true);
  if (completed) return completed;
  const { runAdmissionReviews } = await import('../../work-item-admission-review');
  const reviewed = await runAdmissionReviews(options, deps.sql, deps.llmCall);
  if (reviewed) return reviewed;
  let ordinarySlot = options.targetItemIds === undefined ? await claimOrdinarySlot(deps.sql, options) : null;
  if (ordinarySlot?.completedRunIds?.includes(options.runId) && ordinarySlot.result) return ordinarySlot.result;
  const recoveryRuns: PromoterRunResult[] = [];
  const recovered = ordinarySlot ? 0 : await runAdmissionRecoveries(options, {
    authorize: deps.authorize,
    dispatch: deps.dispatch,
    lockSql: deps.lockSql,
    screen: async (scope, beforePersist) => {
      const result = await runWorkItemAdmissionPromoter({
        ...options,
        sql: deps.sql,
        runId: `${options.runId}:recovery:${scope.workItemId}`,
        targetItemIds: [scope.workItemId],
        beforePersist,
        llmCall: deps.llmCall,
      });
      recoveryRuns.push(result);
      return result;
    },
  }, deps.sql);
  // A request-accelerated fire must not also accelerate writes to unrelated items.
  // A due persisted ordinary slot instead gets its own invocation before recovery.
  if (recovered > 0) {
    await settleAdmissionRunReplacedByRecovery(deps.sql, {
      runId: options.runId,
      workspaceId: options.workspaceId,
      harnessSlug: options.harnessSlug,
      recoveryRunIds: recoveryRuns.map((run) => run.runId),
    });
    return recoveryRuns.reduce<PromoterRunResult>((total, run) => ({
      ...total,
      batchSize: total.batchSize + run.batchSize, flaggedPairs: total.flaggedPairs + run.flaggedPairs,
      promoted: total.promoted + run.promoted, merged: total.merged + run.merged, held: total.held + run.held,
      modelCalled: total.modelCalled || run.modelCalled, tokensIn: total.tokensIn + run.tokensIn,
      tokensOut: total.tokensOut + run.tokensOut,
      censusBefore: recoveryRuns[0]!.censusBefore, censusAfter: run.censusAfter,
      guardRefusals: [...(total.guardRefusals ?? []), ...(run.guardRefusals ?? [])],
      writerCoverageGap: [...total.writerCoverageGap, ...run.writerCoverageGap],
    }), {
      runId: options.runId, batchSize: 0, flaggedPairs: 0, promoted: 0, merged: 0, held: 0,
      modelCalled: false, tokensIn: 0, tokensOut: 0, censusBefore: 0, censusAfter: 0,
      guardRefusals: [], writerCoverageGap: [],
    });
  }
  if (options.targetItemIds === undefined && !ordinarySlot) {
    ordinarySlot = await claimOrdinarySlot(deps.sql, options, true);
  }
  if (ordinarySlot?.runId) {
    // The ordinary writer may have committed immediately before its host died,
    // leaving the slot unsettled. Reuse that committed result without model I/O.
    const result = await completedOrdinaryResult(deps.sql, options, ordinarySlot.runId);
    if (result) {
      await finishOrdinarySlot(deps.sql, options, result);
      return result;
    }
  }
  const componentScreening = options.targetItemIds === undefined
    ? await readAuthorizedComponentScreening(options, deps, deps.sql) : undefined;
  const result = await runWorkItemAdmissionPromoter({
    ...options,
    runId: ordinarySlot?.runId ?? options.runId,
    sql: deps.sql,
    llmCall: deps.llmCall,
    componentScreeningItemIds: componentScreening?.itemIds,
    componentScreening,
    ...(ordinarySlot ? { beforePersist: async () => {
      await deps.sql.begin(async (rawTx) => {
        const routine = await ordinaryRoutine(rawTx as unknown as Sql, options);
        if (ordinarySlotSchema.parse(routine.metadata?.admissionOrdinarySlot).runId !== ordinarySlot!.runId) {
          throw new Error('ordinary admission slot changed before persistence');
        }
      });
    } } : {}),
  });
  if (ordinarySlot) await finishOrdinarySlot(deps.sql, options, result);
  return result;
}

/**
 * EI-21728201456300634 and EI-21866311570152646 both fired this alarm on a raw global census
 * rise, and both closed as false alarms after real investigation found zero corresponding
 * `dedup_edges`/`dedup_adjudications` activity for the flagged run. Root cause: the raw
 * censusBefore/censusAfter delta compares a live, workspace-wide count across two non-atomic
 * wall-clock reads separated by real time (an LLM call in between) — on a fleet that creates
 * near-duplicate work items continuously, new `dedup_edges` rows routinely appear in that
 * window, and a `hold` verdict deliberately never retires its pair (it means "still needs
 * review", not "resolved"). Neither is a writer defect, so the raw delta is not a usable
 * regression signal — see judgedPairsMissingAdjudication's doc comment.
 *
 * The alarm now fires on `writerCoverageGap`: pairs THIS run rendered a final (non-hold)
 * judgement for that still lack a `dedup_adjudications` row after persisting. That is scoped
 * to exact pair identity, so it cannot be tripped by concurrent corpus growth or by a
 * legitimate hold, and a non-empty result is a genuine writer defect.
 */
async function productionCensusRiseAlarm(ctx: SystemActionCtx, result: PromoterRunResult): Promise<void> {
  if (result.writerCoverageGap.length === 0) return;
  const gap = result.writerCoverageGap;
  await captureImprovement({
    title: `Work-item admission writer failed to persist ${gap.length} judged pair(s) for ${ctx.installSlug}`,
    kind: 'bug',
    severity: 'major',
    body:
      `Promoter run ${result.runId} rendered a final (non-hold) judgement for ${gap.length} pair(s) ` +
      `that still have no harness_shared.dedup_adjudications row after persisting: ` +
      `${gap.slice(0, 10).join(', ')}${gap.length > 10 ? ', …' : ''}. This is the writer failing to ` +
      `retire a pair it explicitly judged — a genuine coverage gap, not organic corpus growth. ` +
      `Inspect the run in /admin/admission and repair persistAdmissionPlan's adjudication insert ` +
      `for these pairs before the next bulk pass.`,
    foundDuring: `${WORK_ITEM_ADMISSION_PROMOTER} routine`,
    dedupScope: 'open',
    watchdogKey: `work-item-admission-census-rise:${ctx.installSlug}`,
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemAdmissionPromoterAction(overrides: Partial<AdmissionPromoterActionDeps> = {}) {
  const deps: AdmissionPromoterActionDeps = {
    run: productionPromoter,
    alarm: productionCensusRiseAlarm,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_PROMOTER}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    if (result.writerCoverageGap.length > 0) await deps.alarm(ctx, result);
    deps.log(
      `${ctx.installSlug}: run=${result.runId} batch=${result.batchSize} pairs=${result.flaggedPairs} ` +
        `promoted=${result.promoted} merged=${result.merged} held=${result.held} ` +
        `census=${result.censusBefore}->${result.censusAfter} writerCoverageGap=${result.writerCoverageGap.length}`,
    );
  };
}

export interface AdmissionFailOpenActionDeps {
  run: (ctx: SystemActionCtx) => Promise<FailOpenRunResult>;
  /**
   * The promoter's deterministic path, run here while the model promoter is stale or paused
   * (WI-10004725, plan work-queue-bulk-cleanup-remediation-2026-10-01 P-007). Pausing the
   * promoter routine for LLM spend (2026-09-15) also stopped the promotions that never needed a
   * model, so for 15 days every filing aged into fail-open as `unreviewed` debt. The fail-open
   * tick is the one admission action that is never paused for spend, so the model-free
   * promotions live here too. Returns null when the model promoter is live (it runs this path
   * itself) and the result of the pass otherwise.
   */
  noModelPromote: (ctx: SystemActionCtx) => Promise<PromoterRunResult | null>;
  /**
   * Settle stranded admission_runs rows (WI-10004726, plan
   * work-queue-bulk-cleanup-remediation-2026-10-01 P-008). It runs here because the
   * fail-open tick is the one admission action that fires every tick, workspace-wide,
   * independent of model spend. It also expires bulk-stage leases that stopped
   * renewing; active leases remain available for their stage-resumption path.
   */
  reap: (ctx: SystemActionCtx, reaperRunId: string) => Promise<ReapedAdmissionRun[]>;
  alarm: (ctx: SystemActionCtx, result: FailOpenRunResult) => Promise<void>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

async function productionReap(ctx: SystemActionCtx, reaperRunId: string): Promise<ReapedAdmissionRun[]> {
  return reapStrandedAdmissionRuns(getOrgPg().sql, {
    workspaceId: ctx.workspaceId,
    reaperRunId,
    nowMs: Date.now(),
  });
}

async function productionNoModelPromote(ctx: SystemActionCtx): Promise<PromoterRunResult | null> {
  // The promoter kill switch covers its model-free path too.
  if (process.env.PAPERCUSP_WORK_ITEM_ADMISSION_PROMOTER === 'off') return null;
  const payload = ctx.payloadTemplate ?? {};
  const sql = getOrgPg().sql;
  const liveness = await readPromoterLiveness(
    sql,
    ctx.workspaceId,
    ctx.installSlug,
    Date.now(),
    positiveInteger(payload.staleMinutes, DEFAULT_PROMOTER_LIVENESS_MINUTES),
  );
  if (!liveness.stale) return null;
  return runWorkItemAdmissionPromoter({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    sql,
    runId: `${runId(WORK_ITEM_ADMISSION_FAIL_OPEN)}:no-model`,
    batchSize: positiveInteger(payload.noModelBatchSize, DEFAULT_PROMOTER_BATCH_SIZE),
    noModel: true,
    llmCall: async () => {
      throw new Error('the no-model admission pass must never call a model');
    },
  });
}

async function productionFailOpen(ctx: SystemActionCtx): Promise<FailOpenRunResult> {
  const payload = ctx.payloadTemplate ?? {};
  return runWorkItemAdmissionFailOpen({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId: runId(WORK_ITEM_ADMISSION_FAIL_OPEN),
    tickMinutes: positiveInteger(payload.tickMinutes, DEFAULT_PROMOTER_TICK_MINUTES),
    staleMinutes: positiveInteger(payload.staleMinutes, DEFAULT_PROMOTER_LIVENESS_MINUTES),
    // Workspace-wide on purpose. This routine is seeded once, for the operator home harness,
    // by a hand-run script with no callers — so a harness-scoped guard silently guards exactly
    // one harness while every other one starves forever with no error anywhere.
    scope: 'workspace',
  });
}

async function productionLivenessAlarm(ctx: SystemActionCtx, result: FailOpenRunResult): Promise<void> {
  if (!result.liveness.stale) return;
  await captureImprovement({
    title: `Work-item admission promoter is stale for ${ctx.installSlug}`,
    kind: 'bug',
    severity: 'major',
    body:
      `${result.liveness.reason}. The independent fail-open action remains live and admitted ` +
      `${result.autoPromoted.length} row(s) as admission='unreviewed' on this tick, so queue ` +
      `distribution is not silently starved. Restore the durable ${WORK_ITEM_ADMISSION_PROMOTER} ` +
      `routine and verify a detail.mode='promoter', detail.status='complete' admission_runs row.`,
    foundDuring: `${WORK_ITEM_ADMISSION_FAIL_OPEN} routine`,
    dedupScope: 'open',
    watchdogKey: `work-item-admission-promoter-liveness:${ctx.installSlug}`,
  });
}

export function makeWorkItemAdmissionFailOpenAction(overrides: Partial<AdmissionFailOpenActionDeps> = {}) {
  const deps: AdmissionFailOpenActionDeps = {
    run: productionFailOpen,
    noModelPromote: productionNoModelPromote,
    reap: productionReap,
    alarm: productionLivenessAlarm,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_FAIL_OPEN}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    // BEFORE the sweep: a clean row promoted here is admitted reviewed instead of aging into
    // `unreviewed` debt. A failure here must never cost the tick its admissions, and it is
    // always logged, so a silent no-model pass is distinguishable from a skipped one.
    let noModelSummary: string;
    try {
      const pass = await deps.noModelPromote(ctx);
      noModelSummary = pass === null
        ? 'no-model=skipped(promoter live)'
        : `no-model run=${pass.runId} promoted=${pass.promoted} merged=${pass.merged} ` +
          `deferred-to-model=${pass.deferredToModel ?? 0}`;
    } catch (error) {
      noModelSummary = `no-model=ERROR (${error instanceof Error ? error.message : String(error)})`;
    }
    const result = await deps.run(ctx);
    // A reaper failure must never cost the fail-open its admissions, and a silent reaper is
    // how the stranded rows were missed for weeks. So it runs after the admission work, and
    // its outcome is always logged, including a failure.
    let reapedSummary: string;
    try {
      const reaped = await deps.reap(ctx, result.runId);
      reapedSummary = reaped.length === 0
        ? 'reaped-stranded=0'
        : `reaped-stranded=${reaped.length} [${reaped.map((row) => `${row.runKind}:${row.id}`).join(',')}]`;
    } catch (error) {
      reapedSummary = `reaped-stranded=ERROR (${error instanceof Error ? error.message : String(error)})`;
    }
    await deps.invalidate();
    if (result.liveness.stale) await deps.alarm(ctx, result);
    const byHarness = Object.entries(result.autoPromotedByHarness)
      .map(([harness, ids]) => `${harness}=${ids.length}`)
      .sort()
      .join(',');
    // Rows the work-scope policy deliberately held back. Logged even though the hold is
    // correct: without it, a policy-held harness and a harness nothing is watching look
    // identical in the only admission mechanism that currently runs.
    const heldEntries = Object.entries(result.heldByScope ?? {}).filter(([, count]) => count > 0);
    const heldByScope = heldEntries
      .map(([harness, count]) => `${harness}=${count}`)
      .sort()
      .join(',');
    const heldTotal = heldEntries.reduce((sum, [, count]) => sum + count, 0);
    deps.log(
      `${ctx.installSlug}: run=${result.runId} scope=${result.scope} ` +
        `auto-promoted=${result.autoPromoted.length}${byHarness ? ` [${byHarness}]` : ''} ` +
        `held-by-scope=${heldTotal}${heldByScope ? ` [${heldByScope}]` : ''} ` +
        `liveness=${result.liveness.stale ? 'STALE' : 'healthy'} (${result.liveness.reason}) ` +
        `review-moot=${result.reviewMoot?.closed ?? 0} ` +
        `${noModelSummary} ` +
        reapedSummary,
    );
  };
}

registerSystemAction(WORK_ITEM_ADMISSION_PROMOTER, makeWorkItemAdmissionPromoterAction());
registerSystemAction(WORK_ITEM_ADMISSION_FAIL_OPEN, makeWorkItemAdmissionFailOpenAction());
