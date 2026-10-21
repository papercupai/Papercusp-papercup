/**
 * Continuous spec conformance (R-23, spec-driven-tooling-integration-2026-10-05 P-031).
 *
 * "Deterministic checks run on commit, on work-item transitions and on a schedule."
 * `system:spec-conformance-sweep` is ONE recurring routine (seeded by
 * ../harness/routines/seed-spec-conformance-sweep-routine.ts) that, on every tick, looks at
 * each live plan with parseable requirements and runs its conformance when:
 *
 *  - `never-run`              the plan has no watermark yet;
 *  - `footprint-changed`      a commit after the watermarked head touched a path inside the
 *                             plan's declared `## Conformance` footprint (the "on commit" leg);
 *  - `work-item-transitioned` a plan-linked work-item changed state after the watermark
 *                             (max `work_items.state_changed_at` over `source_plan_slug`);
 *  - `previously-drifting`  the prior conformance result still reported a drifting
 *                             requirement, so it gets another bounded verification pass;
 *  - `previous-run-failed`  the prior sweep could not record a conformance result, so a
 *                             transient write or dependency failure is retried;
 *  - `interval-elapsed`       the per-plan interval passed since the last run.
 *
 * The two retry triggers wait out `retryBackoffSec` since the last run, and one slot per tick
 * is reserved for a STARVED interval-only plan, so a few plans that fail or drift on every
 * run cannot monopolise the per-tick cap (WI-6554700010019378).
 *
 * A run is the existing {@link runPlanConformance} (checks + drift alarms) with the existing
 * production deps, plus {@link reconcilePlanFootprint} when the plan declares a footprint.
 * The watermark lives in `harness_shared.spec_conformance_state` (migration 1507). The
 * transition watermark is read AFTER the run, so work-item writes the run itself causes can
 * never re-trigger it. Bounded per tick (`maxRunsPerTick`); the rest is deferred, not lost —
 * a deferred plan keeps its trigger and leads the next tick by priority.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx, type SystemActionResult } from '../harness/routines/system-actions';
import { evaluateRequirementEnforcement } from './conformance-contract';
import { loadConformanceReportPlans } from './conformance-report';
import { runPlanConformance, type ConformanceRunOutcome } from './conformance-run';
import { productionConformanceDeps } from './conformance-run-deps';
import { compileFootprint, reconcilePlanFootprint, type FootprintCommitWindow, type FootprintOutcome } from './footprint';
import { createFootprintDeps } from './footprint-deps';

export const SPEC_CONFORMANCE_SWEEP_ACTION = 'spec-conformance-sweep';
export const SPEC_CONFORMANCE_SWEEP_TARGET_ROLE = `system:${SPEC_CONFORMANCE_SWEEP_ACTION}`;
/** Routine cadence: how often the sweep looks for triggered plans. */
export const SPEC_CONFORMANCE_SWEEP_INTERVAL_SEC = 900;
/** Per-plan floor: a plan with no other trigger still runs this often. */
export const SPEC_CONFORMANCE_PLAN_INTERVAL_SEC = 6 * 60 * 60;
export const SPEC_CONFORMANCE_MAX_RUNS_PER_TICK = 4;
/**
 * Retry backoff for the RETRY triggers (`previous-run-failed`, `previously-drifting`): they
 * re-fire only once this long has passed since the plan's last run. Without it a plan whose
 * conformance fails deterministically re-runs on EVERY tick, and a handful of such plans
 * fill every per-tick slot so the interval tier never runs (WI-6554700010019378: ~100 plans
 * unrun for 3 days behind 8 perpetually-retrying ones).
 */
export const SPEC_CONFORMANCE_RETRY_BACKOFF_SEC = 60 * 60;
/**
 * Starvation floor: an interval-only plan whose last run is at least this many plan
 * intervals old is STARVED, and one slot per tick is reserved for the oldest such plan
 * whenever the cap is at least 2 and no interval-only plan was otherwise selected.
 */
export const SPEC_CONFORMANCE_STARVATION_INTERVALS = 2;
/** Plan statuses the sweep covers — the same live population the census reports on. */
export const SPEC_CONFORMANCE_SWEEP_STATUSES: readonly string[] = ['active', 'ready'];

export type SweepTrigger =
  | 'never-run'
  | 'footprint-changed'
  | 'work-item-transitioned'
  | 'previously-drifting'
  | 'previous-run-failed'
  | 'interval-elapsed';

export interface SweepOutcomeWatermark {
  /** Requirement bar keys that were still drifting at the end of the prior run. */
  drifting?: readonly string[];
  /** A bounded error from the prior sweep attempt, when no conformance result was recorded. */
  error?: string | null;
}

export interface SweepWatermark {
  lastRunAt: string;
  footprintHeadSha: string | null;
  lastTransitionAt: string | null;
  /** Bounded prior-run summary used to retry an unresolved drift finding. */
  lastOutcome?: SweepOutcomeWatermark | null;
}

export interface SweepCandidate {
  key: string;
  watermark: SweepWatermark | null;
  footprintChanged: boolean;
  /** Current max state_changed_at over the plan's linked work-items. */
  lastTransitionAt: string | null;
}

export interface SweepSelection {
  selected: Array<{ key: string; triggers: SweepTrigger[] }>;
  deferred: Array<{ key: string; triggers: SweepTrigger[] }>;
  idle: string[];
}

export const sweepPlanKey = (harnessSlug: string, planSlug: string) => `${harnessSlug}/${planSlug}`;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Why `candidate` should run now (empty = it should not). Pure. */
export function sweepTriggersFor(
  candidate: SweepCandidate,
  nowMs: number,
  planIntervalSec: number,
  retryBackoffSec: number = SPEC_CONFORMANCE_RETRY_BACKOFF_SEC,
): SweepTrigger[] {
  const wm = candidate.watermark;
  if (!wm) return ['never-run'];
  const triggers: SweepTrigger[] = [];
  if (candidate.footprintChanged) triggers.push('footprint-changed');
  const current = ms(candidate.lastTransitionAt);
  const seen = ms(wm.lastTransitionAt);
  if (current !== null && (seen === null || current > seen)) triggers.push('work-item-transitioned');
  const last = ms(wm.lastRunAt);
  // Retry triggers wait out a backoff since the last run, so a deterministic failure or a
  // persistent drift cannot re-run every tick and starve everything else.
  const retryDue = last === null || nowMs - last >= retryBackoffSec * 1000;
  if (retryDue && (wm.lastOutcome?.drifting?.length ?? 0) > 0) triggers.push('previously-drifting');
  if (retryDue && typeof wm.lastOutcome?.error === 'string' && wm.lastOutcome.error.length > 0) triggers.push('previous-run-failed');
  if (last === null || nowMs - last >= planIntervalSec * 1000) triggers.push('interval-elapsed');
  return triggers;
}

const priority = (triggers: SweepTrigger[]) =>
  triggers.includes('never-run') ? 0 : triggers.some((t) => t !== 'interval-elapsed') ? 1 : 2;

/**
 * Pick at most `maxRunsPerTick` triggered plans: never-run first, then commit/transition
 * triggers, then interval-only — oldest run first within a tier. When the cap is at least 2
 * and no interval-only plan made the cut, the last slot goes to the oldest STARVED
 * interval-only plan (last run >= `starvationIntervals` plan intervals ago), so the
 * interval tier always makes progress however many event/retry triggers are pending. Pure.
 */
export function selectSweepRuns(
  candidates: ReadonlyArray<SweepCandidate>,
  opts: {
    nowMs: number;
    planIntervalSec: number;
    maxRunsPerTick: number;
    retryBackoffSec?: number;
    starvationIntervals?: number;
  },
): SweepSelection {
  const triggered: Array<{ key: string; triggers: SweepTrigger[]; lastRun: number }> = [];
  const idle: string[] = [];
  for (const candidate of candidates) {
    const triggers = sweepTriggersFor(candidate, opts.nowMs, opts.planIntervalSec, opts.retryBackoffSec);
    if (triggers.length === 0) idle.push(candidate.key);
    else triggered.push({ key: candidate.key, triggers, lastRun: ms(candidate.watermark?.lastRunAt) ?? -1 });
  }
  triggered.sort((a, b) => priority(a.triggers) - priority(b.triggers) || a.lastRun - b.lastRun || a.key.localeCompare(b.key));
  const cap = Math.max(0, Math.floor(opts.maxRunsPerTick));
  const selected = triggered.slice(0, cap);
  const deferred = triggered.slice(cap);
  const starvedBeforeMs =
    opts.nowMs - (opts.starvationIntervals ?? SPEC_CONFORMANCE_STARVATION_INTERVALS) * opts.planIntervalSec * 1000;
  if (cap >= 2 && !selected.some((t) => priority(t.triggers) === 2)) {
    // `deferred` is sorted, so the first interval-only entry is the oldest one.
    const starved = deferred.findIndex((t) => priority(t.triggers) === 2 && t.lastRun <= starvedBeforeMs);
    if (starved >= 0) {
      const [floor] = deferred.splice(starved, 1);
      deferred.unshift(selected.pop()!);
      selected.push(floor);
    }
  }
  const strip = ({ key, triggers }: { key: string; triggers: SweepTrigger[] }) => ({ key, triggers });
  return { selected: selected.map(strip), deferred: deferred.map(strip), idle };
}

// ---------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------

export interface SweepPlan {
  planSlug: string;
  harnessSlug: string;
  content: string;
}

export interface SweepWatermarkWrite extends SweepWatermark {
  planSlug: string;
  harnessSlug: string;
  triggers: SweepTrigger[];
  outcome: Record<string, unknown>;
}

export interface SpecConformanceSweepDeps {
  listPlans(): Promise<SweepPlan[]>;
  readWatermarks(): Promise<ReadonlyMap<string, SweepWatermark>>;
  /** Max state_changed_at per plan key over its linked work-items (absent = none). */
  lastTransitions(plans: ReadonlyArray<SweepPlan>): Promise<ReadonlyMap<string, string | null>>;
  footprintWindow(plan: SweepPlan, sinceSha: string | null): Promise<FootprintCommitWindow>;
  runConformance(plan: SweepPlan): Promise<ConformanceRunOutcome>;
  reconcileFootprint(plan: SweepPlan, sinceSha: string | null, window: FootprintCommitWindow): Promise<FootprintOutcome>;
  writeWatermark(row: SweepWatermarkWrite): Promise<void>;
  now?(): number;
}

export interface SpecConformanceSweepOptions {
  planIntervalSec?: number;
  maxRunsPerTick?: number;
  retryBackoffSec?: number;
  starvationIntervals?: number;
}

export interface SweepPlanResult {
  key: string;
  triggers: SweepTrigger[];
  ok: boolean;
  summary: Record<string, unknown>;
}

export interface SpecConformanceSweepOutcome {
  scanned: number;
  candidates: number;
  skipped: Array<{ key: string; reason: string }>;
  ran: SweepPlanResult[];
  deferred: Array<{ key: string; triggers: SweepTrigger[] }>;
  idle: number;
  footprintProbeErrors: Array<{ key: string; error: string }>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

function summarizeOutcome(outcome: ConformanceRunOutcome, footprint: FootprintOutcome | null): Record<string, unknown> {
  return {
    applicable: outcome.applicable,
    executed: outcome.executed,
    requirements: outcome.requirements.length,
    drifting: outcome.requirements.filter((req) => req.drifting).map((req) => req.barKey),
    unmeasured: outcome.requirements.filter((req) => req.unmeasured).length,
    alarmsOpened: outcome.alarmsOpened,
    alarmsClosed: outcome.alarmsClosed,
    unbound: outcome.unbound.length,
    unevaluable: outcome.unevaluable.length,
    contractProblems: outcome.contractProblems.length,
    ...(footprint
      ? {
          footprint: footprint.ok
            ? { uncovered: footprint.uncovered.length, commitsScanned: footprint.commitsScanned, finding: footprint.finding }
            : { problems: footprint.problems.length },
        }
      : {}),
  };
}

/** One sweep tick. Never throws for a single plan's failure — it is recorded and skipped. */
export async function runSpecConformanceSweep(
  opts: SpecConformanceSweepOptions,
  deps: SpecConformanceSweepDeps,
): Promise<SpecConformanceSweepOutcome> {
  const now = deps.now ?? (() => Date.now());
  const planIntervalSec = opts.planIntervalSec ?? SPEC_CONFORMANCE_PLAN_INTERVAL_SEC;
  const maxRunsPerTick = opts.maxRunsPerTick ?? SPEC_CONFORMANCE_MAX_RUNS_PER_TICK;
  const plans = await deps.listPlans();
  const outcome: SpecConformanceSweepOutcome = {
    scanned: plans.length,
    candidates: 0,
    skipped: [],
    ran: [],
    deferred: [],
    idle: 0,
    footprintProbeErrors: [],
  };

  const live: Array<{ plan: SweepPlan; key: string; globs: string[] }> = [];
  for (const plan of plans) {
    const key = sweepPlanKey(plan.harnessSlug, plan.planSlug);
    try {
      const report = evaluateRequirementEnforcement(plan.content);
      if (!report.applicable) {
        outcome.skipped.push({ key, reason: 'no-requirements' });
        continue;
      }
      live.push({ plan, key, globs: report.footprint });
    } catch (err) {
      outcome.skipped.push({ key, reason: `unevaluable: ${errText(err)}` });
    }
  }
  outcome.candidates = live.length;
  if (live.length === 0) return outcome;

  const watermarks = await deps.readWatermarks();
  const transitions = await deps.lastTransitions(live.map((entry) => entry.plan));
  const windows = new Map<string, FootprintCommitWindow>();
  const candidates: SweepCandidate[] = [];
  for (const entry of live) {
    const watermark = watermarks.get(entry.key) ?? null;
    let footprintChanged = false;
    if (watermark && entry.globs.length > 0) {
      try {
        const window = await deps.footprintWindow(entry.plan, watermark.footprintHeadSha);
        windows.set(entry.key, window);
        const inFootprint = compileFootprint(entry.globs);
        footprintChanged = window.commits.some((commit) => commit.paths.some(inFootprint));
      } catch (err) {
        outcome.footprintProbeErrors.push({ key: entry.key, error: errText(err) });
      }
    }
    candidates.push({ key: entry.key, watermark, footprintChanged, lastTransitionAt: transitions.get(entry.key) ?? null });
  }

  const selection = selectSweepRuns(candidates, {
    nowMs: now(),
    planIntervalSec,
    maxRunsPerTick,
    retryBackoffSec: opts.retryBackoffSec,
    starvationIntervals: opts.starvationIntervals,
  });
  outcome.deferred = selection.deferred;
  outcome.idle = selection.idle.length;
  const byKey = new Map(live.map((entry) => [entry.key, entry]));

  for (const pick of selection.selected) {
    const entry = byKey.get(pick.key)!;
    const watermark = watermarks.get(pick.key) ?? null;
    let headSha = watermark?.footprintHeadSha ?? null;
    let summary: Record<string, unknown>;
    let ok = true;
    try {
      let footprint: FootprintOutcome | null = null;
      if (entry.globs.length > 0) {
        const sinceSha = watermark?.footprintHeadSha ?? null;
        const window = windows.get(pick.key) ?? (await deps.footprintWindow(entry.plan, sinceSha));
        footprint = await deps.reconcileFootprint(entry.plan, sinceSha, window);
        headSha = window.headSha ?? headSha;
      }
      const run = await deps.runConformance(entry.plan);
      summary = summarizeOutcome(run, footprint);
    } catch (err) {
      ok = false;
      summary = { error: errText(err) };
    }
    // Post-run read: absorbs any transition the run itself caused (see module doc).
    let lastTransitionAt = transitions.get(pick.key) ?? null;
    try {
      lastTransitionAt = (await deps.lastTransitions([entry.plan])).get(pick.key) ?? lastTransitionAt;
    } catch {
      /* keep the pre-run reading */
    }
    await deps.writeWatermark({
      planSlug: entry.plan.planSlug,
      harnessSlug: entry.plan.harnessSlug,
      lastRunAt: new Date(now()).toISOString(),
      footprintHeadSha: headSha,
      lastTransitionAt,
      triggers: pick.triggers,
      outcome: summary,
    });
    outcome.ran.push({ key: pick.key, triggers: pick.triggers, ok, summary });
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------
// Production deps + system action
// ---------------------------------------------------------------------------------------

const toIso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' && value ? new Date(value).toISOString() : null;

export function productionSweepDeps(input: { workspaceId: string }): SpecConformanceSweepDeps {
  const sql = () => getOrgPg().sql;
  const { workspaceId } = input;
  return {
    async listPlans() {
      const plans = await loadConformanceReportPlans({ workspaceId, statuses: SPEC_CONFORMANCE_SWEEP_STATUSES });
      return plans.map(({ planSlug, harnessSlug, content }) => ({ planSlug, harnessSlug, content }));
    },
    async readWatermarks() {
      const rows = await sql()<Array<{
        harness_slug: string;
        plan_slug: string;
        last_run_at: Date;
        footprint_head_sha: string | null;
        last_transition_at: Date | null;
        last_outcome: unknown;
      }>>`
        SELECT harness_slug, plan_slug, last_run_at, footprint_head_sha, last_transition_at, last_outcome
          FROM harness_shared.spec_conformance_state
         WHERE workspace_id = ${workspaceId}`;
      return new Map(rows.map((row) => {
        const lastOutcome = row.last_outcome && typeof row.last_outcome === 'object'
          ? row.last_outcome as { drifting?: unknown; error?: unknown }
          : null;
        const drifting = Array.isArray(lastOutcome?.drifting)
          ? lastOutcome.drifting.filter((barKey): barKey is string => typeof barKey === 'string')
          : [];
        const error = typeof lastOutcome?.error === 'string' && lastOutcome.error.length > 0 ? lastOutcome.error : null;
        return [
          sweepPlanKey(row.harness_slug, row.plan_slug),
          {
            lastRunAt: toIso(row.last_run_at) ?? new Date(0).toISOString(),
            footprintHeadSha: row.footprint_head_sha,
            lastTransitionAt: toIso(row.last_transition_at),
            lastOutcome: { drifting, error },
          },
        ] as const;
      }));
    },
    async lastTransitions(plans) {
      if (plans.length === 0) return new Map();
      const slugs = [...new Set(plans.map((plan) => plan.planSlug))];
      const rows = await sql()<Array<{ harness_slug: string; source_plan_slug: string; last: Date | null }>>`
        SELECT harness_slug, source_plan_slug, max(state_changed_at) AS last
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND source_plan_slug = ANY(${slugs}::text[])
         GROUP BY harness_slug, source_plan_slug`;
      return new Map(rows.map((row) => [sweepPlanKey(row.harness_slug, row.source_plan_slug), toIso(row.last)]));
    },
    footprintWindow(plan, sinceSha) {
      return createFootprintDeps({ workspaceId, harnessSlug: plan.harnessSlug, planSlug: plan.planSlug }).listCommitsSince(sinceSha);
    },
    runConformance(plan) {
      return runPlanConformance(
        { planSlug: plan.planSlug, harnessSlug: plan.harnessSlug, planContent: plan.content },
        productionConformanceDeps({ workspaceId, harnessSlug: plan.harnessSlug, planSlug: plan.planSlug }),
      );
    },
    reconcileFootprint(plan, sinceSha, window) {
      const footprintDeps = createFootprintDeps({ workspaceId, harnessSlug: plan.harnessSlug, planSlug: plan.planSlug });
      return reconcilePlanFootprint(
        { planSlug: plan.planSlug, harnessSlug: plan.harnessSlug, planContent: plan.content, sinceSha },
        { ...footprintDeps, listCommitsSince: async () => window },
      );
    },
    async writeWatermark(row) {
      await sql()`
        INSERT INTO harness_shared.spec_conformance_state
          (workspace_id, harness_slug, plan_slug, last_run_at, footprint_head_sha, last_transition_at, last_triggers, last_outcome, updated_at)
        VALUES (${workspaceId}, ${row.harnessSlug}, ${row.planSlug}, ${row.lastRunAt}, ${row.footprintHeadSha},
                ${row.lastTransitionAt}, ${row.triggers}::text[], ${JSON.stringify(row.outcome)}::jsonb, now())
        ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
          last_run_at        = EXCLUDED.last_run_at,
          footprint_head_sha = EXCLUDED.footprint_head_sha,
          last_transition_at = EXCLUDED.last_transition_at,
          last_triggers      = EXCLUDED.last_triggers,
          last_outcome       = EXCLUDED.last_outcome,
          updated_at         = now()`;
    },
  };
}

const positiveInt = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** The routine handler. Tunables (all optional) ride the routine's payload template. */
export async function runSpecConformanceSweepAction(
  ctx: SystemActionCtx,
  deps?: SpecConformanceSweepDeps,
): Promise<SystemActionResult> {
  const payload = (ctx.payloadTemplate ?? {}) as Record<string, unknown>;
  const outcome = await runSpecConformanceSweep(
    {
      planIntervalSec: positiveInt(payload.planIntervalSec, SPEC_CONFORMANCE_PLAN_INTERVAL_SEC),
      maxRunsPerTick: positiveInt(payload.maxRunsPerTick, SPEC_CONFORMANCE_MAX_RUNS_PER_TICK),
      retryBackoffSec: positiveInt(payload.retryBackoffSec, SPEC_CONFORMANCE_RETRY_BACKOFF_SEC),
      starvationIntervals: positiveInt(payload.starvationIntervals, SPEC_CONFORMANCE_STARVATION_INTERVALS),
    },
    deps ?? productionSweepDeps({ workspaceId: ctx.workspaceId }),
  );
  return {
    diagnostics: {
      specConformanceSweep: {
        scanned: outcome.scanned,
        candidates: outcome.candidates,
        ran: outcome.ran.map((run) => ({ key: run.key, triggers: run.triggers, ok: run.ok })),
        failed: outcome.ran.filter((run) => !run.ok).length,
        deferred: outcome.deferred.length,
        idle: outcome.idle,
        skipped: outcome.skipped.length,
        footprintProbeErrors: outcome.footprintProbeErrors.length,
      },
    },
  };
}

/** The `harness_shared.routines` row the seed script upserts (exported so the shape is tested). */
export function specConformanceSweepRoutineRow(input: { installSlug: string; workspaceId: string; active: boolean }) {
  return {
    id: `rt_${input.installSlug}_${SPEC_CONFORMANCE_SWEEP_ACTION}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
    install_slug: input.installSlug,
    name: SPEC_CONFORMANCE_SWEEP_ACTION,
    trigger_kind: 'cron' as const,
    trigger_config: { interval_sec: SPEC_CONFORMANCE_SWEEP_INTERVAL_SEC },
    target_role: SPEC_CONFORMANCE_SWEEP_TARGET_ROLE,
    concurrency: 'skip' as const,
    catchup: 'skip-old' as const,
    active: input.active,
    tier: 'ephemeral' as const,
    workspace_id: input.workspaceId,
  };
}

registerSystemAction(SPEC_CONFORMANCE_SWEEP_ACTION, (ctx) => runSpecConformanceSweepAction(ctx), {
  scheduling: 'standing',
});
