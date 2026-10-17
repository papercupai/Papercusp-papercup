/**
 * plans:certify-spec-clauses — evaluate spec-test adequacy and file a terminal card for
 * every PASSING clause, in one call.
 *
 * review-system-rework-reduction-2026-09-23 P-005 (absorbs P-006, D-005). This promotes the
 * hand-run recipe `evaluate-spec-test-adequacy-and-emit-terminal-scorecards-when-all-clauses-pass`
 * (4 runs) into a verb. The recipe read evidence, re-derived a `current[]` tuple by hand,
 * called the evaluator, then emitted each draft — and every hand step was a place for the
 * filed card to drift from what the evaluator measured.
 *
 * AUDITOR-REPRODUCIBLE BY CONSTRUCTION: this verb adds no grading logic of its own.
 *   1. It runs the REAL `plans:evaluate-spec-test-adequacy` handler, with no caller-supplied
 *      `current` — freshness comes only from the server's own measurement.
 *   2. It files each passing row's `scorecardDraft` UNEDITED (plus `terminal:true` and an
 *      explicit `acknowledgeExisting:true` retry when the caller requests one) through
 *      `emitScorecardForToolContext`, the exact body of the scorecards:emit handler, so the
 *      card crosses the same exact-replay gate an auditor's replay does. A card this verb
 *      files is therefore one the evaluator has just reproduced.
 * Pinned end to end by scorecards/emit.evaluator-round-trip.test.ts and
 * plans/certify-spec-clauses.test.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { harnessArg } from '../_harness-scope';
import evaluatorTool, { argsSchema as evaluatorArgsSchema } from './evaluate-spec-test-adequacy';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { emitScorecardForToolContext, scorecardEmitArgs, SCORECARD_EMIT_TIMEOUT_SEC } from '../scorecards/emit';
import { listScorecards } from '../../scorecards';
import { getBuildInfo } from '../../build-info';
import { GRADING_AUDIT_RESERVATION_TTL_MS } from '../../grading-integrity';
import { getWorkItem } from '../../work-items';
import { specTestAdequacyCompletionGate } from '../work_items/spec-test-adequacy-gate';
import type { SpecTestAdequacyMeasurementEvidence } from '../../harness/improvements/observation-types';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  classRef: z
    .enum(PLAN_CLASS_RUBRIC_REFS)
    .describe('Existing plan-class standard rubric referenced by the plan acceptance rubric.'),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  completionWorkItemId: z.string().trim().min(1).optional().describe(
    'Work item whose existing spec-test-adequacy completion gate should be checked before filing. Advisory only; does not change the certification evidence selection. A single workItemIds entry supplies the default target.',
  ),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(200).optional(),
  includeDraft: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional().describe(
    'Maximum evidence rows to load for the filtered plan/spec/work-item/evidence scope, not the number of selected clauses. The default is 1000. If loaded rows reach this ceiling, evaluation refuses with evidence_selection_hit_limit and no verdict because the cohort may be truncated; omit this argument or set it above the expected evidence rows (up to 1000), or narrow the selectors.',
  ),
  dryRun: z.boolean().optional().describe('Grade and report which clauses WOULD be filed, without filing any card.'),
  acknowledgeExisting: z.boolean().optional().describe('Explicitly acknowledge existing independent cards when filing another current-evidence card.'),
});

type EvaluatorRow = {
  specId?: unknown;
  specRevision?: unknown;
  verdict?: unknown;
  wouldBlock?: unknown;
  scorecardDraft?: unknown;
  measurementEvidence?: SpecTestAdequacyMeasurementEvidence;
};

type StrandedCard = { issueId: string; evaluatorBuild: { sha: string; version: string } };

type ClauseOutcome = {
  specId: string;
  specRevision: number | null;
  verdict: string;
  wouldBlock: string[];
  measurementEvidence?: SpecTestAdequacyMeasurementEvidence;
  card:
    | { status: 'filed' | 'unchanged'; issueId: string | null }
    | { status: 'would-file' }
    | { status: 'not-passing' }
    | { status: 'refused'; code: string | null; error: string };
  /** The build-stranded pending card this clause's new card superseded (or, under dryRun, would). */
  strandedSuperseded?: StrandedCard;
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * WI-6554700010008541: find a pending card whose grading audit this host can never dispatch.
 *
 * The grading-integrity sweep dispatches a pending card only on a host serving the card's
 * recorded evaluator build (grading-integrity.ts, evaluatorBuildDriftPendingCards). Emit
 * refuses every new same-rubric, same-subject card while that card is pending. Once the host
 * that minted the card moves to a newer build, nothing settles it, and the clause cannot be
 * certified again. Superseding the card with a freshly reproduced one is emit's own exit
 * (its grading_audit_required refusal names it).
 *
 * This returns a card only when superseding it cannot cut across live work:
 *   - it is the ONLY pending same-subject card (otherwise which card blocks is ambiguous);
 *   - it records an evaluator build that differs from this host's build;
 *   - it holds no unexpired dispatch reservation, so no auditor is working on it now.
 */
async function findBuildStrandedPendingCard(
  rubricRef: string,
  subject: { kind?: string | null; ref: string },
  now: number = Date.now(),
): Promise<StrandedCard | null> {
  const pending = ((await listScorecards({ rubricRef, subjectRef: subject.ref, limit: 100 })) ?? []).filter(
    (card) =>
      card.gradingAudit?.state === 'pending' &&
      card.subject?.ref === subject.ref &&
      (card.subject?.kind ?? null) === (subject.kind ?? null) &&
      card.supersededBy == null &&
      !card.retracted,
  );
  if (pending.length !== 1) return null;
  const card = pending[0]!;
  const recorded = card.rerunRecipe?.evaluatorBuild;
  // A card with no issue id cannot be named in `supersedes`, and one with no recorded build
  // sha cannot be proven to sit on a retired build, so neither is ours to replace.
  if (!recorded?.sha || !card.issueId) return null;
  const live = getBuildInfo();
  if (recorded.sha === live.sha && recorded.version === live.version) return null;
  const reservedAt = Date.parse(card.gradingAudit?.dispatchReservation?.reservedAt ?? '');
  if (Number.isFinite(reservedAt) && now - reservedAt < GRADING_AUDIT_RESERVATION_TTL_MS) return null;
  return { issueId: card.issueId, evaluatorBuild: { sha: recorded.sha, version: recorded.version } };
}

export default defineTool({
  name: 'plans:certify-spec-clauses',
  description:
    "Evaluate spec-test adequacy and file a terminal spec-test-adequacy card for every PASSING clause in one call. Runs plans:evaluate-spec-test-adequacy on the server's own measurement, then files each passing draft through the scorecards:emit path, including its exact-replay gate. Clauses that do not pass are reported with their wouldBlock criteria and never filed. Select a cohort with workItemIds and specIds; evidenceRefs must be exact persisted evidence_ref values returned by plans:get-spec-evidence, not test-run table IDs such as test_runs:<id>. If you start from test-run IDs, use workItemIds + specIds or read the bound evidence refs first. The optional limit is an evidence-row ceiling, not a clause count; omit it for the 1000-row default or set it above the filtered evidence cohort. dryRun:true reports without filing. If an existing_independent_scorecards refusal calls for a new sample, re-run with acknowledgeExisting:true.",
  guidance: {
    when: 'Certifying spec-covered work before work_items:complete, instead of evaluating and then emitting each draft by hand.',
    notWhen:
      "Reading one clause's ratings without filing — plans:evaluate-spec-test-adequacy. Filing any other rubric — scorecards:emit.",
    chaining: 'plans:bind-spec-evidence → plans:certify-spec-clauses → work_items:complete.',
    returns:
      '{ ok, dryRun, counts, clauses, evaluatorBuild } — ok is true only when the evaluation succeeded and no passing clause was refused. counts = { clauses, passing, filed, unchanged, refused, notPassing }. Each clause row carries specId, specRevision, verdict, wouldBlock, the evaluator measurementEvidence (including unavailable binding reasons), and card.status (filed | unchanged | would-file | not-passing | refused, with code and error when refused). A row also carries strandedSuperseded { issueId, evaluatorBuild } when its card superseded a pending card whose audit no host can dispatch (recorded on a different evaluator build, no live reservation). When the evaluator itself refuses, ok is false and `evaluator` carries its reply (error, remedy) unchanged.',
    seeAlso: ['plans:evaluate-spec-test-adequacy', 'scorecards:emit'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // Both composed verbs manage their own connections; emit may run for minutes.
  skipWorkspaceTx: true,
  timeoutSec: SCORECARD_EMIT_TIMEOUT_SEC,
  agentRoles: [...COORD_ROLES, 'judge'],
  modality: ['text'],
  args: argsSchema,
  result: z
    .object({
      ok: z.boolean(),
      dryRun: z.boolean(),
      counts: z
        .object({
          clauses: z.number().int(),
          passing: z.number().int(),
          filed: z.number().int(),
          unchanged: z.number().int(),
          refused: z.number().int(),
          notPassing: z.number().int(),
        })
        .optional(),
      clauses: z.array(z.record(z.string(), z.unknown())).optional(),
      evaluator: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const dryRun = args.dryRun === true;
    // Parse through the evaluator's OWN schema so a selector it would reject is rejected
    // here too; no `current` is passed, so freshness is server-measured only.
    const evaluatorArgs = evaluatorArgsSchema.parse({
      ...(args.harness !== undefined ? { harness: args.harness } : {}),
      slug: args.slug,
      classRef: args.classRef,
      ...(args.workItemIds ? { workItemIds: args.workItemIds } : {}),
      ...(args.evidenceRefs ? { evidenceRefs: args.evidenceRefs } : {}),
      ...(args.specIds ? { specIds: args.specIds } : {}),
      ...(args.planItemIds ? { planItemIds: args.planItemIds } : {}),
      ...(args.includeDraft !== undefined ? { includeDraft: args.includeDraft } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      // The drafts this verb files exist only in the evaluator's full body (P-007).
      detail: 'full',
    });
    const evaluated = (await evaluatorTool.handler(evaluatorArgs, ctx)) as { data: Record<string, unknown> };
    const evaluation = evaluated.data;
    if (evaluation.ok !== true) {
      return { data: { ok: false, dryRun, evaluator: evaluation } };
    }

    // A plan-level PASS may combine proofs from several work items. Completion
    // consumes only its target's bindings and reconciled behavior contract, so
    // reuse that gate rather than deriving a second readiness verdict here.
    const completionWorkItemId = args.completionWorkItemId ??
      (args.workItemIds?.length === 1 ? args.workItemIds[0] : undefined);
    const completionReadiness = await (async () => {
      if (!completionWorkItemId) return {
        status: 'not-checked' as const,
        note: 'Certification can combine evidence from multiple work items. It does not establish that any work item can close. Supply completionWorkItemId to check the existing scoped completion gate.',
      };
      try {
        const workItem = await getWorkItem(completionWorkItemId, args.harness);
        if (!workItem) return {
          status: 'unavailable' as const,
          workItemId: completionWorkItemId,
          reason: 'The target work item could not be resolved.',
        };
        const gate = await specTestAdequacyCompletionGate({
          workItem,
          attestation: { classRef: args.classRef },
        });
        return {
          status: gate.ok ? 'ready' as const : 'not-ready' as const,
          workItemId: completionWorkItemId,
          scope: 'spec-test-adequacy' as const,
          checkedBeforeFiling: true,
          gate,
          note: 'This is the existing spec-test-adequacy gate before card filing, not the full work-item completion contract. Filing does not change this snapshot.',
        };
      } catch (error) {
        return {
          status: 'unavailable' as const,
          workItemId: completionWorkItemId,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    })();

    const rows = Array.isArray(evaluation.rows) ? (evaluation.rows as EvaluatorRow[]) : [];
    const clauses: ClauseOutcome[] = [];
    // Sequential on purpose: scorecards:emit serializes on a per-rubric mutex anyway, and
    // a refusal on one clause must be attributable to that clause alone.
    for (const row of rows) {
      const verdict = typeof row.verdict === 'string' ? row.verdict : 'unknown';
      const wouldBlock = stringList(row.wouldBlock);
      const base = {
        specId: typeof row.specId === 'string' ? row.specId : '(unknown)',
        specRevision: typeof row.specRevision === 'number' ? row.specRevision : null,
        verdict,
        wouldBlock,
        ...(row.measurementEvidence ? { measurementEvidence: row.measurementEvidence } : {}),
      };
      if (verdict !== 'pass' || wouldBlock.length > 0) {
        clauses.push({ ...base, card: { status: 'not-passing' } });
        continue;
      }
      const draft =
        row.scorecardDraft && typeof row.scorecardDraft === 'object' && !Array.isArray(row.scorecardDraft)
          ? (row.scorecardDraft as Record<string, unknown>)
          : null;
      const parsed = draft ? scorecardEmitArgs.safeParse({
        ...draft,
        terminal: true,
        ...(args.acknowledgeExisting === true ? { acknowledgeExisting: true } : {}),
      }) : null;
      if (!parsed?.success) {
        clauses.push({
          ...base,
          card: {
            status: 'refused',
            code: 'invalid_evaluator_draft',
            error: draft
              ? `the evaluator's scorecardDraft does not parse as scorecards:emit args: ${parsed?.error.issues
                  .slice(0, 3)
                  .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                  .join('; ')}`
              : 'the evaluator returned a passing row with no scorecardDraft',
          },
        });
        continue;
      }
      type EmitReply = {
        ok?: unknown;
        created?: unknown;
        issueId?: unknown;
        previousIssueId?: unknown;
        reason?: unknown;
        code?: unknown;
        error?: unknown;
      };
      let emitted = (await emitScorecardForToolContext(parsed.data, ctx, { previewOnly: dryRun })) as EmitReply;
      // A card stranded on a retired evaluator build blocks this clause forever (see
      // findBuildStrandedPendingCard). Supersede it once with the card just reproduced.
      // Identical evidence can return success before the pending-audit gate. It still
      // needs a current-build card when the old build cannot complete that audit.
      let strandedSuperseded: StrandedCard | undefined;
      const unchangedEvidence = emitted.ok === true && emitted.created === false && emitted.reason === 'unchanged-evidence';
      if ((emitted.code === 'grading_audit_required' || unchangedEvidence) && !parsed.data.supersedes && parsed.data.subject) {
        const stranded = await findBuildStrandedPendingCard(parsed.data.rubricRef, parsed.data.subject);
        if (stranded) {
          strandedSuperseded = stranded;
          emitted = (await emitScorecardForToolContext(
            { ...parsed.data, supersedes: stranded.issueId },
            ctx,
            { previewOnly: dryRun },
          )) as EmitReply;
        }
      }
      const strandedField = strandedSuperseded ? { strandedSuperseded } : {};
      if (emitted.ok === true) {
        const unchanged = emitted.created === false && emitted.reason === 'unchanged-evidence';
        const card = dryRun && !unchanged
          ? { status: 'would-file' as const }
          : {
              status: unchanged ? 'unchanged' as const : 'filed' as const,
              issueId: unchanged
                ? (typeof emitted.previousIssueId === 'string' ? emitted.previousIssueId : null)
                : (typeof emitted.issueId === 'string' ? emitted.issueId : null),
            };
        clauses.push({
          ...base,
          card,
          ...strandedField,
        });
      } else {
        clauses.push({
          ...base,
          card: {
            status: 'refused',
            code: typeof emitted.code === 'string' ? emitted.code : null,
            error: typeof emitted.error === 'string' ? emitted.error : 'scorecards:emit refused without an error message',
          },
          ...strandedField,
        });
      }
    }

    const count = (status: ClauseOutcome['card']['status']) =>
      clauses.filter((clause) => clause.card.status === status).length;
    const counts = {
      clauses: clauses.length,
      passing: clauses.length - count('not-passing'),
      filed: count('filed'),
      unchanged: count('unchanged'),
      refused: count('refused'),
      notPassing: count('not-passing'),
    };
    return {
      data: {
        ok: counts.refused === 0,
        dryRun,
        slug: evaluation.slug,
        evaluatorBuild: evaluation.evaluatorBuild,
        classRef: evaluation.classRef,
        governing: evaluation.governing,
        ...(typeof evaluation.governingNote === 'string' ? { governingNote: evaluation.governingNote } : {}),
        counts,
        clauses,
        completionReadiness,
      },
    };
  },
});
