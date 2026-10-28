/**
 * `system:acceptance-grading-sweep` — the routine-engine registration for the
 * acceptance-grading stall sweep (acceptance-grading-stall-sweep-2026-08-26 P-002 /
 * P-004).
 *
 * The decision logic lives in `../../acceptance-grading-sweep.ts` (pure) and the
 * orchestration in `../../acceptance-grading-sweep-run.ts` (dependency-injected and
 * unit-tested against fakes). This module is the thin adapter that supplies
 * production implementations, exactly as `consult-expiry-action.ts` does for the
 * consult expiry sweep.
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine by
 * `seed-acceptance-grading-sweep-routine.ts` — an operator-HOME-level substrate
 * concern (one sweep serves every workspace's plans), not a per-blueprint-install
 * one; mirrors the documented deviation in consult-expiry-action.ts and
 * supervision-reconcile-action.ts.
 *
 * WHY IT EXISTS. A plan ships only after an INDEPENDENT grader emits a scorecard,
 * and the grader is recruited lazily by the ship attempt's own refusal. Recovery is
 * therefore pull-triggered: a dead GRADER heals on the next ship attempt, but a dead
 * CREATOR means no attempt is ever made again. This routine is the clock that the
 * grader leg otherwise does not have.
 *
 * The same bounded clock also reconciles pending grading-integrity auditors. A
 * quota/auth terminal can arrive after the launch transaction's startup probe;
 * re-running the idempotent dispatcher here lets that delayed failure reach its
 * safe retirement/fallback path instead of leaving the target scorecard pending.
 */
import { randomUUID } from 'node:crypto';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { registerSystemAction } from './system-actions';
import { enqueueAcceptanceGradingDispatch } from '../../acceptance-grading-sweep-dispatch';
import { Cache, getOrSetBounded } from '@papercusp/cache';
import { pinModuleState } from '@papercusp/module-singleton';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import type { AcceptanceBarPinSweepCursor, AcceptanceBarPinSweepResult } from '../../acceptance-bar-pin-sweep';
import type { ObservedPlanRow } from '../../acceptance-grading-sweep-run';

// Advance past permanently held pins so one bad batch cannot starve the rest.
let subjectPinCursor: AcceptanceBarPinSweepCursor | null = null;
let planCursor: ObservedPlanRow | null = null;
// Existing bounded-cache semantics retain a slow read for the next tick instead of
// starting another copy every minute. Only observations/reconcilers use this cache;
// durable dispatch admission always executes its explicit idempotent path.
const scanCache = pinModuleState('@papercusp/operator-core.gradingSweepObservations', () =>
  new Cache({ defaultSoftTtlMs: 60_000, defaultHardTtlMs: 60_000 }));

export function resetAcceptanceGradingSweepForTest(): void {
  scanCache.clearL1();
  planCursor = null;
  subjectPinCursor = null;
}

/** One minute detector cadence; slow reads retain their in-flight cache entry. */
export const ACCEPTANCE_GRADING_SWEEP_INTERVAL_SEC = 60;

registerSystemAction('acceptance-grading-sweep', async (ctx) => {
  const deadline = Date.now() + 55_000;
  const [
    { getOrgPg },
    { RUBRIC_TEMPLATE_NAME },
    { evaluatePlanAcceptanceGate },
    { ACCEPTANCE_GRADING_SWEEP_ACTOR, acceptanceGraderLabelPrefix, gradingLaunchProfile },
    { reconcilePendingGradingAudits },
    { listTasks },
    { upsertConditionWorkItem },
    {
      acceptanceGradingEscalationBody,
      acceptanceGradingStallConditionKey,
      runAcceptanceGradingSweep,
    },
    { observeAcceptanceGrader },
  ] = await Promise.all([
    import('@papercusp/db-org'),
    import('../../agent-tools/plans/rubric-template'),
    import('../../plan-acceptance-gate'),
    import('../../acceptance-grader'),
    import('../../grading-integrity'),
    import('../../task-manager/store'),
    import('../../coord/condition-upsert'),
    import('../../acceptance-grading-sweep-run'),
    import('../../acceptance-grading-sweep-observe'),
  ]);

  const { sql } = getOrgPg();
  const gradingLaunch = gradingLaunchProfile({ gradingLaunch: ctx.payloadTemplate?.gradingLaunch });
  const sweepId = ctx.workflowId ?? randomUUID();
  const stages: Record<string, { durationMs: number; outcome: 'completed' | 'failed' }> = {};
  const boundedObservation = async <T>(workspaceId: string, key: string, work: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('grading sweep wall-time budget exhausted');
    const deadlineMs = Math.min(5_000, remaining);
    const result = await getOrSetBounded(scanCache, workspaceId, key, () => {
      const startedAt = Date.now();
      let settled = false;
      const pendingTimer = setTimeout(() => {
        if (!settled) {
          console.warn(`[acceptance-grading-sweep] observation-over-deadline key=${key} state=pending elapsedMs=${Date.now() - startedAt}`);
        }
      }, deadlineMs + 1);
      const build = Promise.resolve().then(work);
      void build.then(
        () => {
          settled = true;
          clearTimeout(pendingTimer);
          const elapsedMs = Date.now() - startedAt;
          if (elapsedMs > deadlineMs) {
            console.warn(`[acceptance-grading-sweep] observation-late-settled key=${key} outcome=completed elapsedMs=${elapsedMs}`);
          }
        },
        (error: unknown) => {
          settled = true;
          clearTimeout(pendingTimer);
          const elapsedMs = Date.now() - startedAt;
          if (elapsedMs > deadlineMs) {
            const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
            console.warn(`[acceptance-grading-sweep] observation-late-settled key=${key} outcome=failed elapsedMs=${elapsedMs} error=${message}`);
          }
        },
      );
      return build;
    }, {
      deadlineMs,
    });
    if (!result.ok) throw result.reason === 'error' ? result.error : new Error(`grading sweep ${key} observation remains in flight`);
    return result.value;
  };
  // EI-26619271533407778: a registry long-tick report cannot identify which
  // awaited repair owns the guard. Keep that identity visible while it runs,
  // and retain the settled measurements in the action's existing diagnostics.
  const observeStage = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    const prefix = `[acceptance-grading-sweep] sweep=${sweepId} stage=${stage}`;
    console.log(`${prefix} started`);
    const progress = managedSetInterval(`acceptance-grading-sweep-stage:${sweepId}:${stage}`, 60_000, () => {
      console.warn(`${prefix} still running elapsedMs=${Date.now() - startedAt}`);
    }, { category: 'watchdog', classification: 'timeout-reaper' });
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      const result = await work();
      outcome = 'completed';
      return result;
    } finally {
      progress.stop();
      const durationMs = Date.now() - startedAt;
      stages[stage] = { durationMs, outcome };
      console.log(`${prefix} ${outcome} elapsedMs=${durationMs}`);
    }
  };

  // WI-6554700010014766: a post-start neutral edit may strand a pin. Recover it
  // before grading, using the same clock rather than adding another routine.
  let subjectPins: AcceptanceBarPinSweepResult | undefined;
  let subjectPinError: string | undefined;
  try {
    const { runAcceptanceBarPinSweep } = await import('../../acceptance-bar-pin-sweep');
    subjectPins = await observeStage('subject-pins', () => boundedObservation(ctx.workspaceId,
      `subject-pins:${JSON.stringify(subjectPinCursor)}`, () => runAcceptanceBarPinSweep({ after: subjectPinCursor })));
    subjectPinCursor = subjectPins.nextCursor;
    if (subjectPins.errors.length > 0) {
      subjectPinError = `subject-pin reconciliation failed for ${subjectPins.errors.length} plan(s)`;
    }
  } catch (error) {
    subjectPinError = `subject-pin reconciliation failed: ${error instanceof Error ? error.message : error}`;
  }

  let auditError: string | undefined;
  try {
    const result = await observeStage('pending-audits', () => boundedObservation(ctx.workspaceId, 'pending-audits', () => reconcilePendingGradingAudits({
      ctx: {
        ...(gradingLaunch ? { gradingLaunch } : {}),
        workspaceId: ctx.workspaceId,
        principal: {
          kind: 'system',
          slug: ACCEPTANCE_GRADING_SWEEP_ACTOR,
          workspaceId: ctx.workspaceId,
        },
        ownerId: ACCEPTANCE_GRADING_SWEEP_ACTOR,
        ownerLabel: 'acceptance grading sweep',
        userId: null,
      } as never,
      harness: ctx.installSlug,
    })));
    const launched = result.receipts.filter((receipt) => receipt.state === 'launched').length;
    if (launched > 0) {
      console.log(`[acceptance-grading-sweep] reconciled ${launched} pending grading-integrity auditor(s)`);
    }
    // WI-6554700010013275: a stranded spec-test-adequacy card is re-certified on this build.
    for (const recert of result.recertifications ?? []) {
      console.log(`[acceptance-grading-sweep] stranded card ${recert.issueId} re-certification ${recert.state}: ${recert.reason}`);
    }
  } catch (error) {
    // A grading-integrity repair must not suppress the independent acceptance
    // grading sweep. The next cadence retries the bounded queue read.
    console.warn(
      '[acceptance-grading-sweep] pending grading-integrity reconciliation failed:',
      error instanceof Error ? error.message : error,
    );
    auditError = `pending grading-integrity reconciliation failed: ${error instanceof Error ? error.message : error}`;
  }

  const grading = await observeStage('plan-grading', () => runAcceptanceGradingSweep({
    now: () => Date.now(),

    /**
     * The prefilter. A plan is a CANDIDATE only once it is gradeable at all: not
     * terminal, not archived, not itself a rubric, and carrying BOTH an acceptance
     * rubric and a completion audit. `gradeable_since` is the later of those two
     * timestamps, because a grader has nothing to grade until both exist — and it is
     * read from rows that already have to exist rather than from any new column, so
     * this sweep needs no migration.
     *
     * Deliberately NOT workspace-scoped to the routine's ALS context: one sweep
     * serves every workspace's plans, so the workspace travels on the row and every
     * downstream call is built from it (the same per-row identity pattern as
     * consult-expiry-action.ts).
     */
    listCandidates: async (limit, after) => {
      // The predicate itself (including the workspace-work-scope-policy-2026-09-04
      // P-007 harness filter) moved to `lib/acceptance-awaiting-plans.ts` so the
      // delegation-count provider can ask the SAME question this sweep asks
      // (generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 P-005).
      // It is the one definition of "awaiting acceptance"; re-spelling it for the
      // count would have let a plan be awaiting acceptance for the brief and not
      // for the sweep, with no way to tell which was right.
      const { listPlansAwaitingAcceptance } = await import('../../acceptance-awaiting-plans');
      return (await listPlansAwaitingAcceptance({
        sql,
        rubricTemplateName: RUBRIC_TEMPLATE_NAME,
        limit,
        after,
      })) as never;
    },

    /** R7 — the ONE definition of stuck-ness. Never re-derived from scorecard rows. */
    evaluateGate: async (planSlug, row) => {
      // WI-6554700010018901 (D-006): judge "stuck" at the plan's pinned type revisions, the
      // revisions the ship door judges, so a newer registry revision cannot change the answer.
      const { withPinnedPlanTypes } = await import('../../plan-types/pins');
      const workspaceId = (row as unknown as { workspaceId?: string })?.workspaceId;
      if (!workspaceId || !row?.harnessSlug) throw new Error('grading gate requires scoped candidate identity');
      const verdict = await boundedObservation(workspaceId,
        `gate:${row.harnessSlug}:${planSlug}:${row.gradeableSinceMs}`, () =>
          withPinnedPlanTypes({ planSlug, harnessSlug: row.harnessSlug!, workspaceId }, () =>
            evaluatePlanAcceptanceGate(planSlug, { gradingRecruitment: true, harnessSlug: row.harnessSlug! })));
      return { satisfied: verdict.satisfied, code: verdict.code ?? null };
    },

    /**
     * Grader liveness from the task ledger, via the SHARED label algebra that
     * `scorecards:emit` already uses to reap a finished judge.
     *
     * This comment used to assert the two "cannot disagree about which task is the
     * grader". They did: the reaper read `detail.label` and this read a top-level
     * `label` that exists on neither the row nor the table, so the match was false on
     * every row and the probe reported "no grader" forever (EI-21555395534019608).
     * Sharing a PREFIX FUNCTION was never enough — they have to share the field it is
     * matched against, which is what the extracted module now makes explicit and
     * testable. The body deliberately does not live inline here: as a closure it was
     * unreachable from any test, which is the blind spot the defect survived in.
     */
    observeGrader: async (row) =>
      observeAcceptanceGrader(
        {
          rubricRef: row.rubricRef,
          workspaceId: (row as unknown as { workspaceId?: string }).workspaceId,
        },
        { listTasks, labelPrefix: acceptanceGraderLabelPrefix },
      ),

    /** An OPEN item holding this condition key means the stall already has an owner. */
    escalationExists: async (planSlug) => {
      const key = acceptanceGradingStallConditionKey(planSlug);
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
          FROM harness_shared.work_items
         WHERE payload #>> '{_conditionUpsert,conditionKey}' = ${key}
           AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as unknown as string[]}::text[]))`;
      return (rows[0]?.n ?? 0) > 0;
    },

    /**
     * Re-dispatch. `resolveAcceptanceGrader` is discovery-first and idempotency-keyed,
     * so calling it when a grader is already assigned is a no-op — which is what makes
     * a periodic sweep safe even if the liveness observation above is imperfect. The
     * decision core still checks liveness first; this is the second line, not the only one.
     */
    dispatchGrader: async (row) => {
      const workspaceId = (row as unknown as { workspaceId?: string }).workspaceId;
      if (!workspaceId) return { ok: false, error: 'acceptance grading candidate is missing workspace identity' };
      const input = {
        ...(gradingLaunch ? { gradingLaunch } : {}),
        workspaceId,
        harnessSlug: row.harnessSlug ?? '',
        planSlug: row.planSlug,
        gradeableSinceMs: row.gradeableSinceMs ?? NaN,
      };
      try {
        await enqueueAcceptanceGradingDispatch(input);
        return { ok: true, state: 'admitted' };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    /**
     * R3 — exactly one owner. `upsertConditionWorkItem` is backed by a unique index on
     * the condition key, so concurrency (two hosts, overlapping ticks) cannot produce a
     * second item; a loser adopts the incumbent and reports `created:false`.
     */
    mintEscalation: async (row, decision) => {
      const workspaceId = (row as unknown as { workspaceId?: string }).workspaceId;
      const res = await upsertConditionWorkItem(acceptanceGradingStallConditionKey(row.planSlug), {
        kind: 'task',
        title: `Plan '${row.planSlug}' is implementation-complete but has been UNGRADED for ${
          decision.stuckForMs === null ? 'an unknown period' : `${Math.round(decision.stuckForMs / 3_600_000)}h`
        } — it needs an independent grader`,
        summary: acceptanceGradingEscalationBody(row, decision),
        severity: 'major',
        createdBy: ACCEPTANCE_GRADING_SWEEP_ACTOR,
        ...(row.harnessSlug ? { harness: row.harnessSlug } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      } as never);
      return { id: String(res.id), created: res.created };
    },

    onEvent: (ev) => {
      if (ev.kind === 'observe-started') {
        console.log(`[acceptance-grading-sweep] sweep=${sweepId} plan=${ev.planSlug} operation=${ev.operation} started`);
      } else if (ev.kind === 'observe-settled') {
        console.log(`[acceptance-grading-sweep] sweep=${sweepId} plan=${ev.planSlug} operation=${ev.operation} ${ev.outcome} elapsedMs=${ev.durationMs}`);
      } else if (ev.kind === 'dispatched') {
        console.log(`[acceptance-grading-sweep] re-dispatched grader for ${ev.planSlug} (${ev.state ?? 'ok'})`);
      } else if (ev.kind === 'escalated') {
        console.log(
          `[acceptance-grading-sweep] ${ev.created ? 'MINTED' : 'adopted'} escalation ${ev.workItemId} for ${ev.planSlug}`,
        );
      } else {
        console.warn(`[acceptance-grading-sweep] ${ev.kind} for ${ev.planSlug}: ${'error' in ev ? ev.error : ''}`);
      }
    },
  }, { timeBudgetMs: Math.max(1, deadline - Date.now()), after: planCursor }));
  if (grading) planCursor = grading.nextCursor;

  // A failed sub-pass remains visible through routine health without suppressing
  // independent grading/audit recovery or making a partial scan look healthy.
  const softError = [subjectPinError, auditError, grading?.budgetExhausted ? 'grading scan wall-time budget exhausted' : null].filter(Boolean).join('; ');
  return {
    diagnostics: { subjectPins: subjectPins ?? { error: subjectPinError }, stages, grading },
    ...(softError ? { softError } : {}),
  };
});
