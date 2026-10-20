/**
 * scorecards:list — read structured rubric scorecards back
 * (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * The READ side of the every-turn Overwatch scorecard. Until this tool, a
 * scorecard (a rubric-graded structured observation on
 * engineer_issues.payload.observation) was WRITE-ONLY — emission gaps + partial
 * scorecards were invisible except via raw PG. This is the linchpin the
 * monitoring layer builds on: P-010 (trend) aggregates over it, P-014
 * (emission-freshness + completeness) reads it, and the Overwatch's own
 * turn-over-turn self-comparison needs it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { listScorecardPage, scorecardTimeoutLeadIn } from '../../scorecards';
import type { ScorecardListCursor } from '../../scorecards';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

/**
 * Lean browse mode (WI-6554700010008923, oversized-tool-results-reduction-2026-10-12#P-010).
 * Measured 2026-10-12 (24h): agents' scorecards:list reads totalled ~1.1 GB, mostly browse reads
 * (rubricRef spec-test-adequacy, limit 200 ≈ 7.7 MB each) whose bulk was per-criterion evidence
 * prose nobody reads when scanning rows.
 *
 * EI-21437537919383948 forbids reshaping the ratings MAP (a 4-of-7 card must never look like a
 * complete 4-criterion card), so this keeps EVERY criterion key and the decision fields
 * (rating, unknownReason, remediation, disregard), and drops only the evidence-bearing ones.
 * `nKeys` / `missingKeys` are untouched, so completeness reads exactly as in full mode.
 */
const SCORES_ONLY_ENTRY_KEYS = ['rating', 'unknownReason', 'remediation', 'disregard'] as const;

/**
 * WI-6554700010009929: in 'scores' mode the rerun recipe was still ~70% of every row
 * (measured 2026-10-13 on :3170 8a867962e2: rerunRecipe 5.2-6.3KB of a 7.4-8.5KB row;
 * args 2.5-3.0KB, current 1.8-2.3KB, selection 0.6-0.7KB). A browse read keeps the recipe's
 * IDENTITY (which evaluator, build, class and derivation graded it) and reports the size of
 * every other field under `omittedChars`, so a missing or unexpected field is still visible.
 * The replay body comes back with detail:'full' or a subjectRef read. `generationFreshness`
 * is computed by the page reader before this runs, so it is unaffected.
 */
const RERUN_RECIPE_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'evaluator',
  'evaluatorBuild',
  'classRef',
  'derivation',
]);

export function toRerunRecipeDigest(recipe: unknown): unknown {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return recipe;
  const kept: Record<string, unknown> = {};
  const omittedChars: Record<string, number> = {};
  for (const [key, value] of Object.entries(recipe as Record<string, unknown>)) {
    if (RERUN_RECIPE_IDENTITY_KEYS.has(key)) kept[key] = value;
    else omittedChars[key] = JSON.stringify(value)?.length ?? 0;
  }
  return Object.keys(omittedChars).length > 0 ? { ...kept, omittedChars } : kept;
}

export function resolveScorecardListDetail(
  detail: 'full' | 'scores' | undefined,
  subjectRef: string | undefined,
): 'full' | 'scores' {
  // A subjectRef read drills into ONE subject's card, where the evidence is the point.
  return detail ?? (subjectRef ? 'full' : 'scores');
}

export function toScoresOnlyRow<T>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  const recipe = (row as { rerunRecipe?: unknown }).rerunRecipe;
  const withRecipe = (recipe === undefined ? row : { ...row, rerunRecipe: toRerunRecipeDigest(recipe) }) as T;
  const ratings = (row as { ratings?: unknown }).ratings;
  if (!ratings || typeof ratings !== 'object' || Array.isArray(ratings)) return withRecipe;
  const lean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(ratings as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') {
      lean[key] = entry;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const field of SCORES_ONLY_ENTRY_KEYS) {
      const value = (entry as Record<string, unknown>)[field];
      if (value !== undefined) kept[field] = value;
    }
    lean[key] = kept;
  }
  return { ...withRecipe, ratings: lean };
}

const scorecardListCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  issueId: z.string().min(1).max(160),
}).strict();

export default defineTool({
  name: 'scorecards:list',
  profile: 'engineer',
  description:
    'Read rubric scorecards (rubricRef + per-criterion ratings/evidence), newest-first. Filter by rubricRef, sourceHive, scalar subjectRef, and since. Unlike scorecards:emit\'s structured subject:{kind,ref}, subjectRef is observation.subject.ref (for example a WI-/EI- id). Spec-quality refs are composite `spec-set:<classRef>:<specSetHash>:<planKey>`, not a plan or pot slug; get the exact ref from a scorecard or evaluator. Synthesized floor cards are excluded; pass includeSynthesized:true to include them.',
  guidance: {
    when: 'Read emitted scorecards for trend/freshness and completeness. Filter by scalar `subjectRef` (stored observation.subject.ref), not emit\'s `subject:{kind,ref}`; spec-quality uses exact composite `spec-set:<classRef>:<specSetHash>:<planKey>` subject ref, not a plan slug.',
    notWhen:
      'Need a rubric definition — rubrics:get/list; cross-corpus ideation rollup — curation:state-of-pot; or filing a scorecard — scorecards:emit.',
    chaining:
      'scorecards:list { rubricRef, subjectRef: "EI-123", since } → while nextCursor is non-null, call scorecards:list again with the same filters and cursor: nextCursor → inspect missingKeys/ratings → drill row with work_items:get { id: issueId } or rubric criteria with rubrics:get { rubricRef }.',
    returns:
      'Rows include ratings, synthesized, nKeys, missingKeys; `ratings`, `gradedGeneration`, and `generationFreshness` are nested OBJECTS, not scalars (`generationFreshness` only appears with `gradedGeneration`), so flat/CSV projection fails. Its status is `fresh`, `stale`, `unknown`, or `not-applicable`; `not-applicable` means a complete matched replay recipe proves the selected evidence has no runtime-environment fingerprints. Missing/incomplete recipes and runtime-bound evidence still use the live bg-host generation comparison. `count` is page size; when `hasMore` is true, pass `nextCursor` back as `cursor` to continue the keyset page. `nextCursor` is null when exhausted.',
    seeAlso: [
      'scorecards:freshness (staleness / partial-emit summary)',
      'scorecards:evaluate (typed grading skeleton + evidence delta)',
      'scorecards:emit (validated scorecard write)',
      'rubrics:trend (criteria trend over time)',
      'rubrics:get (the rubric criterion definitions)',
    ],
  },
  // EI-21437537919383948: this is a correctness read, not a browseable list.
  // Each row carries the complete per-criterion ratings/evidence map; allowing
  // the ambient trimmed session tier to reshape that nested map can turn a
  // 4-of-7 scorecard into an apparently complete 4-criterion card. Keep the
  // result-door spill lossless (the explicit hard ceiling still applies), just
  // as scorecards:evaluate and rubrics:get do for their correctness payloads.
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    rubricRef: z
      .string()
      .optional()
      .describe('restrict to one rubric, e.g. "pot-coordination-health"; omit for all rubric-graded scorecards'),
    sourceHive: z.string().optional().describe('restrict to scorecards from one source-hive'),
    harness: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Optional caller scope hint accepted for compatibility; scorecard history is workspace-scoped and this hint does not filter the read.',
      ),
    subjectRef: z
      .string()
      .optional()
      .describe(
        'restrict to scorecards GRADING one subject (observation.subject.ref) — the per-RUN axis: an agent ownerId, session id, WI-/EI- id, or rubric-defined subject identity. Use for a per-run rubric (e.g. goal-mode-e2e) where sourceHive only says which pot. For spec-quality and other plan-spec rubrics, this is the exact composite `spec-set:<classRef>:<specSetHash>:<planKey>` ref, not the plan or pot slug; obtain it from an existing scorecard or evaluator output. Absent on pre-2026-08-10 scorecards, which recorded no subject.',
      ),
    since: z
      .string()
      .optional()
      .describe('ISO timestamp — only scorecards filed at/after this (the time-window); omit for all'),
    limit: z.number().int().positive().max(500).optional().describe('max rows, newest-first (default 100, max 500)'),
    includeSynthesized: z
      .boolean()
      .optional()
      .describe(
        'also return SYNTHESIZED floor scorecards (turn-end backstop + scheduled-pulse). Default false — agent-emission reads exclude floors; pass true to verify the data layer itself (e.g. is the pulse filing while overwatch is paused?)',
      ),
    includeSuperseded: z
      .boolean()
      .optional()
      .describe('Audit view: also include scorecards replaced by a later payload-native supersedes filing.'),
    includeRetracted: z
      .boolean()
      .optional()
      .describe('Audit view: also include deliberately retracted scorecards and their withdrawal metadata.'),
    provisional: z
      .boolean()
      .optional()
      .describe('true: only provisional (interim) cards. With subjectRef, the cards a terminal card must re-rate.'),
    cursor: scorecardListCursorSchema
      .optional()
      .describe('Keyset continuation returned as nextCursor by the previous page; keep the same filters when continuing.'),
    detail: z
      .enum(['full', 'scores'])
      .optional()
      .describe(
        "'scores' keeps every criterion key with its rating and drops evidence text; 'full' adds evidence. Default: 'full' with subjectRef, else 'scores'.",
      ),
  }),
  result: z
    .object({
      ok: z.boolean().optional(),
      count: z.number().int().nonnegative().optional(),
      hasMore: z.boolean().optional(),
      truncatedByLimit: z.boolean().optional(),
      nextCursor: scorecardListCursorSchema.nullable().optional(),
      scorecards: z.array(z.unknown()).optional(),
      error: z.string().optional(),
      retryable: z.boolean().optional(),
      pgCode: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      try {
        const page = await listScorecardPage({
          rubricRef: args.rubricRef,
          sourceHive: args.sourceHive,
          subjectRef: args.subjectRef,
          since: args.since,
          limit: args.limit,
          includeSynthesized: args.includeSynthesized,
          includeSuperseded: args.includeSuperseded,
          includeRetracted: args.includeRetracted,
          provisionalOnly: args.provisional,
          before: args.cursor as ScorecardListCursor | undefined,
          // WI-6124: links are opt-IN. This tool returns whole rows to an agent, so it is a
          // surfacing read — keep it true or agents silently see every scorecard as unlinked.
          includeLinks: true,
        });
        const lastRow = page.rows.at(-1);
        if (page.hasMore && !lastRow) {
          throw new Error('scorecards:list pagination invariant violated: hasMore requires a visible row for nextCursor');
        }
        const nextCursor = page.hasMore
          ? { createdAt: lastRow!.createdAt, issueId: lastRow!.issueId }
          : null;
        const detail = resolveScorecardListDetail(args.detail, args.subjectRef);
        return {
          data: {
            ok: true,
            count: page.rows.length,
            hasMore: page.hasMore,
            truncatedByLimit: page.hasMore,
            nextCursor,
            detail,
            ...(detail === 'scores'
              ? {
                  evidenceOmitted:
                    "evidence text and the rerunRecipe replay body omitted (rerunRecipe.omittedChars sizes it); pass detail:'full' (or subjectRef) to read them",
                }
              : {}),
            scorecards: detail === 'scores' ? page.rows.map(toScoresOnlyRow) : page.rows,
          },
        };
      } catch (error) {
        // EI-21592547181442895: an exhausted, transient read contention sequence is
        // actionable to callers and must not degrade into generic handler_error.
        if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) {
          return {
            data: {
              ok: false,
              error: 'timeout',
              retryable: true,
              ...(error instanceof OrgTxnTimeoutError ? { pgCode: error.pgCode } : {}),
              message:
                `${scorecardTimeoutLeadIn(error, 'scorecards:list read')}: ${error.message}. ` +
                'No scorecards were returned; retry shortly.',
            },
          };
        }
        throw error;
      }
    });
  },
});
