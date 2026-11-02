/**
 * system:rubric-rescore — re-run a rubric's executable checks on a schedule and raise an alert
 * when a criterion falls below its bar. Plan test-rubric-unification-2026-10-12 P-008 (R-8),
 * bound by D-008 (which corrects the wording of D-004 rule 3).
 *
 * Fired by a PLAN SCHEDULE, not a bespoke scheduler: plans:set-schedule { schedule: { action:
 * { system: 'rubric-rescore', input: { rubricRef } } } } + plans:arm-schedule materialize the
 * `plan-schedule-<template>` routine targeting `system:rubric-rescore` (this action is
 * registered `planSchedulable`). The routine payload is `{ templateSlug, harnessSlug, input }`.
 *
 * One fire, deterministic, no model turn:
 *   1. BEFORE — the verdict of every executable criterion from its latest ledger rows, judged by
 *      the same P-007 rules scorecards:emit { fromLedger } uses (ledgerCheckBindings +
 *      judgeLedgerRow against the criterion's CURRENT threshold; error > fail > pass).
 *   2. RUN — every command/opt-in platform instrument check and every typed probe check
 *      (P-004/P-006), each executed result written as one results-ledger row (P-006).
 *   3. AFTER — the same verdicts re-read from the ledger.
 *   4. For every criterion that moved pass → fail, emit `rubric:criterion-regressed:<rubricRef>`
 *      with { criterionKey, before, after, testRunId }. A criterion that stays at its bar, has no
 *      prior verdict, or moves to `error` (nothing measured) emits nothing: an alert means the
 *      bar was MET and now is NOT, never "we could not measure".
 *
 * The standing alert is a `watch:create { pattern: 'rubric:criterion-regressed:<rubricRef>',
 * targetKind: 'event', wake: false }` — an inbox notice on each crossing.
 */
import { getOrgPg } from '@papercusp/db-org';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { getRubric } from '../../rubrics';
import { parseRequirementBars } from '../../acceptance-bar-seed';
import { readLiveAcceptanceCriteria } from '../../acceptance-live-requirements';
import {
  probeCheckResults,
  readLatestRubricCheckResults,
  recordRubricCheckResults,
  runInstrumentChecks,
  type LatestRubricCheckResult,
  type RubricCheckResult,
} from '../../check-results-ledger';
import { judgeLedgerRow, ledgerCheckBindings, ledgerRowMatchesBinding, type LedgerFillCriterion } from '../../scorecard-ledger-fill';
import { retainMeasurementProvenance } from '../../measurement-provenance';
import { evaluateCriterionProbeChecks, type CheckedCriterion } from '../../rubrics-criterion-checks';
import { emitAwaitedEvent } from '../../events/await/engine';
import { dispatchPaletteTarget } from '../../capabilities/invoke';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from './system-actions';

export const RUBRIC_RESCORE_ACTION = 'rubric-rescore';

/** The awaitable key a crossing fires; the watch subscribes to exactly this. */
export function rubricCriterionRegressedKey(rubricRef: string): string {
  return `rubric:criterion-regressed:${rubricRef}`;
}

export type CriterionLedgerVerdict = 'pass' | 'fail' | 'error';

export interface RubricCriterionRegressedPayload {
  rubricRef: string;
  criterionKey: string;
  before: 'pass';
  after: 'fail';
  /** The results-ledger row that decided the failing verdict. */
  testRunId: number;
}

type RescoreCriterion = LedgerFillCriterion & CheckedCriterion;

/**
 * The ledger verdict of one executable criterion, or null when it is not executable or any of its
 * checks has no row yet (unknown — never a crossing endpoint).
 */
export function criterionLedgerVerdict(
  criterion: LedgerFillCriterion,
  latest: ReadonlyMap<string, LatestRubricCheckResult>,
): { verdict: CriterionLedgerVerdict; testRunId: number } | null {
  const bindings = ledgerCheckBindings(criterion);
  if (!bindings) return null;
  const judged: Array<{ verdict: CriterionLedgerVerdict; testRunId: number }> = [];
  for (const binding of bindings) {
    const row = latest.get(binding.id);
    if (!row || !ledgerRowMatchesBinding(binding, row)) return null;
    judged.push({ verdict: judgeLedgerRow(binding, row), testRunId: row.testRunId });
  }
  return judged.find((j) => j.verdict === 'error') ?? judged.find((j) => j.verdict === 'fail') ?? judged[0] ?? null;
}

export interface RubricRescoreDeps {
  getRubric?: (ref: string) => Promise<{
    rubricId: string;
    workspaceId?: string | null;
    subjectHarnessSlug?: string | null;
    kind?: string | null;
    subjectPlan?: string | null;
    criteria: ReadonlyArray<RescoreCriterion>;
  } | null>;
  readLatest?: typeof readLatestRubricCheckResults;
  runInstruments?: typeof runInstrumentChecks;
  evaluateProbes?: typeof evaluateCriterionProbeChecks;
  dispatchTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  record?: (results: ReadonlyArray<RubricCheckResult>, scope: Parameters<typeof recordRubricCheckResults>[1]) => Promise<number[]>;
  emit?: typeof emitAwaitedEvent;
}

export interface RubricRescoreOutcome {
  rubricRef: string;
  executed: number;
  testRunIds: number[];
  crossings: RubricCriterionRegressedPayload[];
  /** Probe criteria that could not be judged this fire; each keeps its prior ledger rows. */
  probeError?: string;
}

/**
 * Tools a re-score probe may reach through the palette chokepoint WITH confirmation.
 *
 * The scheduled re-score has no agent MCP context, so its probes go through
 * dispatchPaletteTarget, whose guard classes dev:pg_query as high-tier (raw SQL) and refuses it
 * with confirmation_required unless confirmed. Every scheduled fire on 2026-10-13 lost all 13 sql
 * probe rows that way. Confirming is safe for exactly this tool: the probe layer has already
 * accepted only a single SELECT or WITH...SELECT, and dev:pg_query runs it in a READ ONLY
 * transaction with a row cap and statement timeout. Any other tool keeps the unconfirmed path.
 */
export const RESCORE_CONFIRMED_PROBE_TOOLS: ReadonlySet<string> = new Set(['dev:pg_query']);

/** The default re-score probe dispatcher (palette chokepoint, harness-scoped). */
export function rescoreProbeDispatcher(
  harness: string | undefined,
  dispatch: typeof dispatchPaletteTarget = dispatchPaletteTarget,
  workspaceId?: string,
): (name: string, args: Record<string, unknown>) => ReturnType<typeof dispatchPaletteTarget> {
  return (name, args) =>
    runWithWorkspaceIfConcrete(workspaceId, () => dispatch({
      name,
      args,
      ...(RESCORE_CONFIRMED_PROBE_TOOLS.has(name) ? { confirmed: true } : {}),
      ...(harness ? { harness } : {}),
    }));
}

/** Re-run a rubric's executable checks and emit one event per pass → fail crossing. */
export async function rescoreRubric(
  input: { rubricRef: string; workspaceId: string; harnessSlug: string | null },
  deps: RubricRescoreDeps = {},
): Promise<RubricRescoreOutcome> {
  const stored = await (deps.getRubric ?? (getRubric as NonNullable<RubricRescoreDeps['getRubric']>))(input.rubricRef);
  if (!stored) throw new Error(`rubric_rescore_rubric_not_found: ${input.rubricRef}`);
  const workspaceId = stored.workspaceId ?? input.workspaceId;
  // Acceptance checks are a live view, just as in rubrics:get. The persisted seed
  // can still say instrument:none after the subject plan names a runnable check.
  const live = await readLiveAcceptanceCriteria(stored, {
    readSubjectPlanContent: async ({ planSlug, harnessSlug }) => {
      const { getPlanRow } = await import('../../agent-tools/plans/source');
      const row = await getPlanRow(planSlug, { workspaceId, ...(harnessSlug ? { harnessSlug } : {}) });
      return row ? { content: row.content, version: row.version } : null;
    },
    parseRequirementBars: content => {
      const parsed = parseRequirementBars(content);
      return parsed.ok
        ? { ok: true, bars: parsed.bars.map(bar => ({ barKey: bar.barKey, ...(bar.criterion ? { criterion: bar.criterion } : {}) })) }
        : { ok: false, problems: parsed.problems };
    },
  });
  if (live.status.source === 'stored-rubric' && live.status.reason !== 'not-a-plan-acceptance-rubric') {
    throw new Error(`rubric_rescore_live_requirements_unavailable: ${stored.rubricId}: ${live.status.reason}`);
  }
  const rubric = { ...stored, criteria: live.criteria };
  const rubricRef = rubric.rubricId;
  const harnessSlug = rubric.subjectHarnessSlug ?? input.harnessSlug;
  const readLatest = deps.readLatest ?? readLatestRubricCheckResults;
  const executable = rubric.criteria.filter((c) => ledgerCheckBindings(c) !== null);

  const latestBefore = await readLatest({ rubricRef, workspaceId });
  const before = new Map(executable.map((c) => [c.key, criterionLedgerVerdict(c, latestBefore)] as const));

  const results: RubricCheckResult[] = [
    ...(await (deps.runInstruments ?? runInstrumentChecks)({ rubricRef, criteria: executable, workspaceId,
      ...(harnessSlug ? { harnessSlug } : {}) })),
  ];
  const probeErrors: string[] = [];
  const probeCriteria = executable.filter((c) => (c.check as { kind?: string } | undefined)?.kind === 'probe');
  if (probeCriteria.length > 0) {
    const harness = harnessSlug ?? undefined;
    const dispatchTool = deps.dispatchTool ?? rescoreProbeDispatcher(harness, undefined, workspaceId);
    const evaluateProbes = deps.evaluateProbes ?? evaluateCriterionProbeChecks;
    // One evaluation per criterion. The evaluator fails closed for a whole batch (right for a
    // scorecard, which must not grade around an unjudged check), but a re-score that dropped every
    // probe because one timed out would leave the rest unmeasured. An unjudgeable attempt records
    // an error for each child; older successes remain history, never the current grade. `unknown` ratings run the probe without
    // asserting a rating it could contradict.
    for (const criterion of probeCriteria) {
      const startedAt = new Date().toISOString();
      let failure: string | undefined;
      try {
        const evaluation = await evaluateProbes({ criteria: [criterion], ratings: { [criterion.key]: { rating: 'unknown' } }, dispatchTool });
        if (evaluation.ok) results.push(...probeCheckResults(rubricRef, evaluation.checkRuns, [criterion]));
        else failure = `${evaluation.criterionKey ?? criterion.key}: ${evaluation.error}: ${evaluation.detail}`;
      } catch (error) {
        failure = `${criterion.key}: probe threw: ${String(error)}`;
      }
      if (failure) {
        probeErrors.push(failure);
        const finishedAt = new Date().toISOString();
        const check = criterion.check as { probe?: unknown; all?: unknown[] };
        for (const [index, binding] of (ledgerCheckBindings(criterion) ?? []).entries()) {
          results.push({ verdict: 'error', measuredAt: finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(startedAt), detail: failure.slice(0, 2000),
            check: { id: binding.id, rubricRef, criterionKey: criterion.key, kind: 'probe', value: null,
              unit: binding.unit ?? null, provenance: retainMeasurementProvenance({
                procedure: check.all?.[index] ?? check.probe, result: { error: failure }, startedAt, finishedAt,
              }) } });
        }
      }
    }
  }
  const probeError = probeErrors.length > 0
    ? `${probeErrors.length} of ${probeCriteria.length} probe criteria unjudged; ${probeErrors.join(' | ')}`
    : undefined;

  const testRunIds = results.length > 0
    ? await (deps.record ?? ((r, s) => recordRubricCheckResults(r, s, getOrgPg().sql as never)))(results, {
        workspaceId,
        harnessSlug: harnessSlug ?? null,
      })
    : [];

  const latestAfter = await readLatest({ rubricRef, workspaceId });
  const crossings: RubricCriterionRegressedPayload[] = [];
  for (const criterion of executable) {
    const was = before.get(criterion.key);
    const now = criterionLedgerVerdict(criterion, latestAfter);
    if (was?.verdict === 'pass' && now?.verdict === 'fail') {
      crossings.push({ rubricRef, criterionKey: criterion.key, before: 'pass', after: 'fail', testRunId: now.testRunId });
    }
  }
  const emit = deps.emit ?? emitAwaitedEvent;
  for (const crossing of crossings) {
    await emit({
      key: rubricCriterionRegressedKey(rubricRef),
      payload: crossing,
      summary: `rubric ${rubricRef}: criterion '${crossing.criterionKey}' fell below its bar (test_runs #${crossing.testRunId})`,
      source: `system:${RUBRIC_RESCORE_ACTION}`,
      workspaceId,
    });
  }
  return { rubricRef, executed: results.length, testRunIds, crossings, ...(probeError ? { probeError } : {}) };
}

/** The routine handler: payload `{ templateSlug, harnessSlug, input: { rubricRef } }`. */
export async function runRubricRescoreAction(ctx: SystemActionCtx, deps: RubricRescoreDeps = {}): Promise<SystemActionResult> {
  const payload = (ctx.payloadTemplate ?? {}) as { harnessSlug?: unknown; input?: { rubricRef?: unknown } };
  const rubricRef = typeof payload.input?.rubricRef === 'string' ? payload.input.rubricRef.trim() : '';
  if (!rubricRef) throw new Error('rubric_rescore_rubric_ref_required');
  const harnessSlug = typeof payload.harnessSlug === 'string' ? payload.harnessSlug : ctx.installSlug;
  const outcome = await rescoreRubric({ rubricRef, workspaceId: ctx.workspaceId, harnessSlug }, deps);
  return {
    diagnostics: { rubricRescore: outcome },
    ...(outcome.probeError ? { softError: `rubric-rescore probe batch: ${outcome.probeError}`.slice(0, 600) } : {}),
  };
}

registerSystemAction(RUBRIC_RESCORE_ACTION, runRubricRescoreAction, { scheduling: 'on-demand', planSchedulable: true });
