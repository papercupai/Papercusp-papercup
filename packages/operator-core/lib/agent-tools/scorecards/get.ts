/** scorecards:get — evidence-first read of one scorecard for grading-integrity audits. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS } from '@papercusp/tooldef';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import { resolveAgentIdentity } from '../coordination/identity';
import { replayRetainedInstrument } from '../../rubric-instrument-registry';
import { replayRetainedProbe } from '../../continuity-probes';
import { COORD_ROLES } from '../coordination/roles';
import {
  classifyGradingAuditCurrentness,
  readScorecardEvidence,
  readScorecardRecipeHeader,
  scorecardTimeoutLeadIn,
  type ScorecardEvidenceRow,
  type ScorecardRecipeHeader,
} from '../../scorecards';
import { getRubricWithoutSeeding } from '../../rubrics';
import { GRADING_INTEGRITY_RUBRIC_REF } from '../../grading-integrity';
import { getBuildInfo, type BuildInfo } from '../../build-info';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { PgReadQueryTimeoutError } from '../../pg-read-query';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import {
  createStageAttempt,
  logIfStageStalls,
  traceStageAwait,
  withStageAttempt,
} from '../../sync/hyperbee/stage-stall-log';
import {
  namedQueryStageTimings,
  traceNamedQueryStage,
  withNamedQueryDiagnosticContext,
} from '../db-diagnostic-correlation-wiring';
import {
  OBSERVATION_ATTRIBUTIONS,
  OBSERVATION_UNKNOWN_REASONS,
} from '../../harness/improvements/observation-types';

const SCORECARD_GET_DIAGNOSTIC_STAGE = {
  evidenceRead: 'scorecards-get-evidence-read',
  gradingAuditRubricRead: 'scorecards-get-rubric-read',
} as const;
type ScorecardGetDiagnosticStage = (typeof SCORECARD_GET_DIAGNOSTIC_STAGE)[keyof typeof SCORECARD_GET_DIAGNOSTIC_STAGE];

export const scorecardGetArgs = z.object({
  issueId: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('the scorecard issue id (EI-/WI-) whose criterion evidence must be re-run; preferred over the id alias'),
  id: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Compatibility alias for issueId for generic id-based read callers; issueId wins when both are supplied.'),
  criterionKey: z.string().min(1).max(200).optional()
    .describe('Read one criterion from an oversized card index. Evidence remains exact; follow evidenceRead.next until complete.'),
  replay: z.literal('retained-measurement').optional()
    .describe('Replay one criterion original retained command inputs or scalar probe predicate. Requires criterionKey; no commands, SQL or current-state measurements run. Probe scope covers retained response evaluation, not reconstruction of SQL source rows. Missing or incompatible inputs stay unavailable.'),
  indexOffset: z.number().int().min(0).optional()
    .describe('Resume a paged criterion index at evidenceRead.next.args.indexOffset.'),
  evidenceOffset: z.number().int().min(0).optional()
    .describe('UTF-16 offset from evidenceRead.next for one criterion. Concatenate pages in order; never grade from an incomplete page.'),
  rerunRecipeOffset: z.number().int().min(0).optional()
    .describe('UTF-16 offset from rerunRecipeRead.read or next. Concatenate JSON chunks and parse only after rerunRecipeRead.complete.'),
}).refine(({ issueId, id }) => issueId !== undefined || id !== undefined, {
  message: 'issueId or id is required',
  path: ['issueId'],
}).refine(({ replay, criterionKey, evidenceOffset, indexOffset, rerunRecipeOffset }) => !replay ||
  (criterionKey !== undefined && evidenceOffset === undefined && indexOffset === undefined && rerunRecipeOffset === undefined), {
  message: 'retained-measurement replay requires criterionKey and cannot be combined with paging',
  path: ['replay'],
}).refine(({ criterionKey, indexOffset }) => criterionKey === undefined || indexOffset === undefined, {
  message: 'criterionKey and indexOffset cannot be combined',
  path: ['indexOffset'],
}).refine(({ rerunRecipeOffset, criterionKey, indexOffset, evidenceOffset }) =>
  rerunRecipeOffset === undefined ||
  (criterionKey === undefined && indexOffset === undefined && evidenceOffset === undefined), {
  message: 'rerunRecipeOffset cannot be combined with criterion or index paging',
  path: ['rerunRecipeOffset'],
});

// Bound the JSON-encoded result before both payload shaping and the later MCP
// result door. The latter is much smaller than the shared 30k payload ceiling;
// the result door must preserve paging truth when its own projection clips a page.

// The handler body is serialized again as an MCP content item. Reserve room for
// that wire envelope so tools:invoke's outer result door cannot force-project a
// complete evidence page down to its generic string limit while leaving
// evidenceRead.complete unchanged.
const RESULT_DOOR_SERIALIZATION_RESERVE_CHARS = 256;

function fitsInlineResult(result: unknown, budgetChars: number): boolean {
  const text = JSON.stringify(result);
  // tools:invoke wraps the JSON body in an MCP text block; quoted JSON recipe
  // chunks gain another escape layer there. Budget that actual envelope too.
  return Buffer.byteLength(text, 'utf8') <= budgetChars &&
    Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text }] }), 'utf8') <= budgetChars;
}

function inlineResultBudgetChars(ownerId?: string | null): number {
  const resultDoorChars =
    computeTurnDoors(0, getDoorConstantsSync(ownerId)).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  return Math.max(
    1,
    Math.min(
      Math.floor(PAYLOAD_TIER_HARD_CEILING_CHARS / 2),
      resultDoorChars - RESULT_DOOR_SERIALIZATION_RESERVE_CHARS,
    ),
  );
}

const evidenceReadCall = (issueId: string, criterionKey: string, evidenceOffset = 0) => ({
  tool: 'scorecards:get',
  args: { issueId, criterionKey, evidenceOffset },
});

const criterionIndexReadCall = (issueId: string, indexOffset: number) => ({
  tool: 'scorecards:get',
  args: { issueId, indexOffset },
});

const rerunRecipeReadCall = (issueId: string, rerunRecipeOffset = 0) => ({
  tool: 'scorecards:get' as const,
  args: { issueId, rerunRecipeOffset },
});

const rerunRecipeReadCallSchema = z.object({
  tool: z.literal('scorecards:get'),
  args: z.object({ issueId: z.string(), rerunRecipeOffset: z.number().int().nonnegative() }),
});

const evidenceReadCallSchema = z.object({
  tool: z.literal('scorecards:get'),
  args: z.object({
    issueId: z.string(),
    criterionKey: z.string().optional(),
    evidenceOffset: z.number().int().nonnegative().optional(),
    indexOffset: z.number().int().nonnegative().optional(),
  }).passthrough().refine(({ criterionKey, indexOffset }) =>
    (criterionKey !== undefined) !== (indexOffset !== undefined)),
}).passthrough();

const scorecardEvidenceCriterionSchema = z.object({
  key: z.string(),
  rating: z.string(),
  evidence: z.string(),
  evidenceRef: z.string().optional(),
  evidenceKind: z.string().optional(),
  positiveControlRef: z.string().optional(),
  absenceClaim: z.boolean().optional(),
  unknownReason: z.enum(OBSERVATION_UNKNOWN_REASONS).optional(),
  attribution: z.enum(OBSERVATION_ATTRIBUTIONS).optional(),
  nextEvidenceAction: z.string().optional(),
  suggestion: z.string().optional(),
  remediation: z.string().optional(),
  disregard: z.string().optional(),
}).passthrough();

const scorecardSubjectRubricCurrentnessSchema = z.object({
  state: z.enum(['current', 'stale', 'unknown']),
  reason: z.enum([
    'current',
    'meaning-unchanged',
    'subject-rubric-mismatch',
    'recorded-identity-missing',
    'live-identity-missing',
    'revision-mismatch',
    'meaning-revision-mismatch',
    'criteria-hash-mismatch',
  ]),
  recordedRevision: z.number().nullable(),
  currentRevision: z.number().nullable(),
  recordedCriteriaHash: z.string().nullable(),
  currentCriteriaHash: z.string().nullable(),
}).passthrough();

const scorecardRubricCurrentnessSchema = z.object({
  state: z.enum(['current', 'stale', 'unknown']),
  reason: z.enum([
    'current',
    'recorded-identity-missing',
    'live-identity-missing',
    'revision-mismatch',
    'meaning-revision-mismatch',
    'criteria-hash-mismatch',
  ]),
  recordedRevision: z.number().nullable(),
  currentRevision: z.number().nullable(),
  recordedCriteriaHash: z.string().nullable(),
  currentCriteriaHash: z.string().nullable(),
}).passthrough();

const scorecardEvaluatorBuildCurrentnessSchema = z.object({
  state: z.enum(['current', 'stale', 'unknown']),
  reason: z.string(),
  recordedSha: z.string().nullable(),
  recordedVersion: z.string().nullable(),
  liveSha: z.string().nullable(),
  liveVersion: z.string().nullable(),
}).passthrough();

export type ScorecardEvaluatorBuildCurrentness = z.infer<typeof scorecardEvaluatorBuildCurrentnessSchema>;

/**
 * Read the evaluator identity from either recipe location. New cards pin it in
 * both places; older cards may only retain the executable args pin. A missing
 * pin is omitted (legacy cards remain auditable), while an invalid or
 * unresolvable identity is explicit unknown so a judge cannot mistake it for a
 * current replay (EI-26082605254422690).
 * `liveBuild` identifies the process serving `scorecards:get`; it does not discover
 * a separately routed evaluator. Compare the read and replay on the same serving
 * route before treating this process-local result as evaluator-wide currentness.
 */
export function classifyEvaluatorBuildCurrentness(
  recipe: unknown,
  liveBuild: BuildInfo = getBuildInfo(),
): ScorecardEvaluatorBuildCurrentness | undefined {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return undefined;
  const source = recipe as { evaluatorBuild?: unknown; args?: unknown };
  const candidate = source.evaluatorBuild ??
    (source.args && typeof source.args === 'object' && !Array.isArray(source.args)
      ? (source.args as { evaluatorBuild?: unknown }).evaluatorBuild
      : undefined);
  if (candidate === undefined) return undefined;
  const recorded = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as { sha?: unknown; version?: unknown }
    : null;
  const recordedSha = typeof recorded?.sha === 'string' ? recorded.sha.trim() || null : recorded?.sha === null ? null : null;
  const recordedVersion = typeof recorded?.version === 'string' ? recorded.version.trim() || null : null;
  const liveSha = typeof liveBuild.sha === 'string' ? liveBuild.sha.trim() || null : null;
  const liveVersion = typeof liveBuild.version === 'string' ? liveBuild.version.trim() || null : null;
  if (!recorded || recordedVersion === null || (recorded?.sha !== null && typeof recorded?.sha !== 'string')) {
    return {
      state: 'unknown',
      reason: 'recorded-identity-invalid',
      recordedSha,
      recordedVersion,
      liveSha,
      liveVersion,
    };
  }
  if (liveSha === null || liveVersion === null) {
    return {
      state: 'unknown',
      reason: 'live-identity-missing',
      recordedSha,
      recordedVersion,
      liveSha,
      liveVersion,
    };
  }
  if (recordedSha === liveSha && recordedVersion === liveVersion) {
    return {
      state: 'current',
      reason: 'current',
      recordedSha,
      recordedVersion,
      liveSha,
      liveVersion,
    };
  }
  return {
    state: 'stale',
    reason: recordedSha !== liveSha && recordedVersion !== liveVersion
      ? 'sha-and-version-mismatch'
      : recordedSha !== liveSha
        ? 'sha-mismatch'
        : 'version-mismatch',
    recordedSha,
    recordedVersion,
    liveSha,
    liveVersion,
  };
}

const scorecardEvidenceSchema = z.object({
  issueId: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  rubricRef: z.string(),
  rubricRevision: z.number().optional(),
  rubricMeaningRevision: z.number().optional(),
  criteriaHash: z.string().optional(),
  rerunRecipe: z.record(z.string(), z.unknown()).optional(),
  rubricCurrentness: scorecardRubricCurrentnessSchema,
  evidenceFingerprint: z.string().optional(),
  sourceHive: z.string().optional(),
  subject: z.object({
    kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric', 'scorecard']).optional(),
    ref: z.string(),
    windowStart: z.string().optional(),
    windowEnd: z.string().optional(),
  }).passthrough().optional(),
  criteria: z.array(scorecardEvidenceCriterionSchema),
  rollup: z.object({
    verdict: z.enum(['exemplary', 'pass', 'partial', 'fail', 'severe', 'unassessable']),
    criticalKeys: z.array(z.string()),
    criticalFailures: z.array(z.string()),
    criticalUnknowns: z.array(z.string()),
    coverage: z.object({
      rated: z.number(),
      required: z.number(),
      sufficient: z.boolean(),
    }).passthrough(),
  }).passthrough().optional(),
  nKeys: z.number().int().nonnegative(),
  missingKeys: z.array(z.string()),
  extraKeys: z.array(z.string()),
  rubricResolved: z.boolean(),
  synthesized: z.boolean(),
  gradingAudit: z.object({
    state: z.enum(['pending', 'awaiting-reemit', 'passed', 'failed', 'cancelled']),
    metaRubricRef: z.string(),
    stampedAt: z.string(),
    rubricRevision: z.number().optional(),
    criteriaHash: z.string().optional(),
    dispatchReservation: z.object({
      key: z.string(),
      reservedAt: z.string(),
    }).passthrough().optional(),
    reemitRequired: z.object({
      code: z.literal('grading_audit_evaluator_changed'),
      at: z.string(),
      reason: z.string(),
    }).passthrough().optional(),
    replayRefusal: z.object({
      code: z.literal('grading_audit_replay_consistent'),
      at: z.string(),
      basisFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      reservation: z.object({
        key: z.string(),
        reservedAt: z.string(),
      }).passthrough(),
      responderOwnerId: z.string(),
    }).passthrough().optional(),
    auditIssueId: z.string().optional(),
    auditor: z.string().optional(),
    auditedAt: z.string().optional(),
  }).passthrough().optional(),
  gradingAuditCurrentness: z.object({
    state: z.enum(['current', 'stale', 'unknown']),
    reason: z.string(),
    recordedRevision: z.number().nullable(),
    currentRevision: z.number().nullable(),
    recordedCriteriaHash: z.string().nullable(),
    currentCriteriaHash: z.string().nullable(),
  }).passthrough().optional(),
  evaluatorBuildCurrentness: scorecardEvaluatorBuildCurrentnessSchema.optional(),
  provisional: z.object({
    violatableKeys: z.array(z.string()),
    stampedAt: z.string(),
  }).passthrough().optional(),
  retracted: z.object({
    at: z.string(),
    by: z.string(),
    reason: z.string(),
  }).passthrough().optional(),
  subjectRubricCurrentness: scorecardSubjectRubricCurrentnessSchema.optional(),
  supersededBy: z.string().optional(),
  auditTarget: z.object({
    current: z.boolean().nullable(),
    superseded: z.boolean(),
    supersededBy: z.string().nullable(),
    retracted: z.boolean(),
    subjectRubricCurrentness: scorecardSubjectRubricCurrentnessSchema.nullable(),
  }).passthrough(),
}).passthrough();

const scorecardRecipeHeaderSchema = scorecardEvidenceSchema.omit({
  criteria: true,
  nKeys: true,
  missingKeys: true,
  extraKeys: true,
  rubricResolved: true,
}).extend({
  // Header responses may emit criteria: [] to distinguish omitted evidence
  // from an absent field, while some header-only reads omit it. Keep the
  // declared array empty-only; full criterion data uses the other union arm.
  criteria: z.array(scorecardEvidenceCriterionSchema).length(0).optional(),
});

const scorecardEvidenceReadSchema = z.object({
  complete: z.boolean(),
  reason: z.string().optional(),
  instruction: z.string().optional(),
  criteria: z.array(z.object({
    key: z.string(),
    rating: z.string(),
    evidenceChars: z.number().int().nonnegative(),
    read: evidenceReadCallSchema,
  }).passthrough()).optional(),
  scope: z.enum(['selected-criterion', 'criterion-index']).optional(),
  offset: z.number().int().nonnegative().optional(),
  totalChars: z.number().int().nonnegative().optional(),
  totalCriteria: z.number().int().nonnegative().optional(),
  next: evidenceReadCallSchema.optional(),
}).passthrough();

const scorecardGetDiagnosticsSchema = z.object({
  schemaVersion: z.literal('scorecards-get-diagnostics-v1'),
  correlationId: z.string().uuid(),
  handlerState: z.enum(['running', 'completed', 'failed']),
  handlerElapsedMs: z.number().int().nonnegative(),
  omittedStages: z.number().int().nonnegative(),
  stages: z.array(z.object({
    // Stage strings come only from traceNamedQueryStage's source-owned names;
    // caller arguments and database error text are never copied into this field.
    stage: z.string().min(1).max(64),
    elapsedMs: z.number().int().nonnegative(),
    outcome: z.enum(['pending', 'fulfilled', 'rejected']),
  })),
});

const scorecardGetResultSchema = z.object({
  ok: z.boolean(),
  replay: z.object({
    issueId: z.string(), criterionKey: z.string(), rubricRef: z.string(),
    evidenceFingerprint: z.string().optional(), testRunId: z.number().int().positive(),
    mode: z.literal('historical'), status: z.enum(['reproduced', 'mismatch', 'unavailable']),
    value: z.union([z.number().finite(), z.string(), z.boolean(), z.null()]),
    recordedValue: z.union([z.number(), z.string(), z.boolean(), z.null()]),
    unit: z.string().nullable(), reason: z.string(),
    scope: z.literal('probe-predicate').optional(), verdict: z.enum(['pass', 'fail']).optional(),
    transactionAt: z.string().optional(),
    window: z.object({ startedAt: z.string(), finishedAt: z.string() }).optional(),
  }).optional(),
  diagnostics: scorecardGetDiagnosticsSchema.optional(),
  scorecard: z.union([scorecardEvidenceSchema, scorecardRecipeHeaderSchema]).optional(),
  evidenceRead: scorecardEvidenceReadSchema.optional(),
  rerunRecipeRead: z.object({
    complete: z.boolean(),
    encoding: z.literal('json'),
    totalChars: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative().optional(),
    chunk: z.string().optional(),
    read: rerunRecipeReadCallSchema.optional(),
    next: rerunRecipeReadCallSchema.optional(),
  }).optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
  pgCode: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

function boundedEvidenceRead(
  scorecard: ScorecardEvidenceRow,
  args: z.infer<typeof scorecardGetArgs>,
  issueId: string,
  inlineBudgetChars: number,
) {
  // A replay recipe can be larger than the whole result door. Repeating it on
  // every evidence page makes both index and criterion reads unrecoverable.
  // Keep the audit header and page the exact JSON through this same reader.
  const encodedRecipe = scorecard.rerunRecipe === undefined ? undefined : JSON.stringify(scorecard.rerunRecipe);
  const { rerunRecipe: _recipe, ...withoutRecipe } = scorecard;
  if (args.rerunRecipeOffset !== undefined) {
    if (encodedRecipe === undefined) return { ok: false as const, error: 'rerun_recipe_not_found' };
    const offset = args.rerunRecipeOffset;
    if (offset > encodedRecipe.length || (offset === encodedRecipe.length && offset !== 0)) {
      return { ok: false as const, error: 'invalid_rerun_recipe_offset' };
    }
    let count = Math.min(inlineBudgetChars, encodedRecipe.length - offset);
    const page = () => ({
      ok: true as const,
      scorecard: { ...withoutRecipe, criteria: [] },
      evidenceRead: { complete: false, reason: 'rerun-recipe-page' },
      rerunRecipeRead: {
        complete: offset + count === encodedRecipe.length,
        encoding: 'json' as const,
        offset,
        totalChars: encodedRecipe.length,
        chunk: encodedRecipe.slice(offset, offset + count),
        ...(offset + count < encodedRecipe.length ? { next: rerunRecipeReadCall(issueId, offset + count) } : {}),
      },
    });
    let result = page();
    while (!fitsInlineResult(result, inlineBudgetChars) && count > 1) {
      count = Math.max(1, Math.floor(count / 2));
      result = page();
    }
    // Metadata can itself exceed this owner's inline allowance even after the
    // recipe is removed. Preserve the complete page for the shared result door
    // to spill with a recovery cursor instead of discarding it as an error.
    return result;
  }
  const pageRecipe = encodedRecipe !== undefined && encodedRecipe.length > inlineBudgetChars / 3;
  const recipeRead = pageRecipe ? {
    rerunRecipeRead: {
      complete: false,
      encoding: 'json' as const,
      totalChars: encodedRecipe.length,
      read: rerunRecipeReadCall(issueId),
    },
  } : {};
  if (pageRecipe) scorecard = withoutRecipe;
  if (args.criterionKey === undefined) {
    if (args.evidenceOffset !== undefined) {
      return { ok: false as const, error: 'criterion_required_for_offset' };
    }
    const full = { ok: true as const, scorecard, evidenceRead: { complete: true }, ...recipeRead };
    if (args.indexOffset === undefined && fitsInlineResult(full, inlineBudgetChars)) return full;

    const indexOffset = args.indexOffset ?? 0;
    if (indexOffset > scorecard.criteria.length || (indexOffset === scorecard.criteria.length && indexOffset > 0)) {
      return { ok: false as const, error: 'invalid_criterion_index_offset' };
    }
    const metadata = { ...scorecard, criteria: [] };
    const page = (count: number) => {
      const endOffset = indexOffset + count;
      const completeIndex = endOffset === scorecard.criteria.length;
      return {
        ok: true as const,
        scorecard: metadata,
        ...recipeRead,
        evidenceRead: {
          complete: false,
          reason: args.indexOffset === undefined ? 'card-exceeds-inline-budget' : 'criterion-index-page',
          instruction: 'Evidence has NOT been read. For a criterion-index page, follow evidenceRead.next until the full index is assembled; then read every indexed criterion and concatenate its pages before grading.',
          criteria: scorecard.criteria.slice(indexOffset, endOffset).map(({ key, rating, evidence }) => ({
            key, rating, evidenceChars: evidence.length,
            read: evidenceReadCall(issueId, key),
          })),
          scope: 'criterion-index' as const,
          offset: indexOffset,
          totalCriteria: scorecard.criteria.length,
          ...(!completeIndex ? { next: criterionIndexReadCall(issueId, endOffset) } : {}),
        },
      };
    };
    let count = scorecard.criteria.length - indexOffset;
    let index = page(count);
    while (!fitsInlineResult(index, inlineBudgetChars) && count > 1) {
      count = Math.max(1, Math.floor(count / 2));
      index = page(count);
    }
    // The result door owns the final transport budget and can spill this whole
    // page. A local inline-budget refusal here would discard the only index or
    // criterion cursor for an otherwise readable scorecard.
    return index;
  }
  const criterion = scorecard.criteria.find(({ key }) => key === args.criterionKey);
  if (!criterion) return { ok: false as const, error: 'unknown_criterion' };
  const offset = args.evidenceOffset ?? 0;
  if (offset > criterion.evidence.length || (offset === criterion.evidence.length && offset !== 0)) {
    return { ok: false as const, error: 'invalid_evidence_offset' };
  }
  let count = Math.min(inlineBudgetChars, criterion.evidence.length - offset);
  const page = () => {
    const nextOffset = offset + count;
    const complete = nextOffset === criterion.evidence.length;
    return {
      ok: true as const,
      scorecard: { ...scorecard, criteria: [{ ...criterion, evidence: criterion.evidence.slice(offset, nextOffset) }] },
      ...(criterion.ratedFrom === 'ledger' && criterion.ledgerResult ? {
        retainedMeasurementReplay: { tool: 'scorecards:get', args: { issueId, criterionKey: criterion.key, replay: 'retained-measurement' } },
      } : {}),
      ...recipeRead,
      evidenceRead: {
        complete,
        scope: 'selected-criterion',
        offset,
        totalChars: criterion.evidence.length,
        instruction: 'Concatenate this criterion’s pages in offset order. Complete applies only to this criterion; audit every key from the card index.',
        ...(!complete ? { next: evidenceReadCall(issueId, criterion.key, nextOffset) } : {}),
      },
    };
  };
  let result = page();
  while (!fitsInlineResult(result, inlineBudgetChars) && count > 1) {
    count = Math.max(1, Math.floor(count / 2));
    result = page();
  }
  // Keep the complete page when non-evidence metadata is the part that cannot
  // fit inline; the shared result door can expose it through a recoverable ref.
  return result;
}

function boundedRerunRecipeHeaderRead(
  scorecard: ScorecardRecipeHeader & {
    gradingAuditCurrentness?: ReturnType<typeof classifyGradingAuditCurrentness>;
  },
  offset: number,
  issueId: string,
  inlineBudgetChars: number,
) {
  const encodedRecipe = scorecard.rerunRecipe === undefined ? undefined : JSON.stringify(scorecard.rerunRecipe);
  if (encodedRecipe === undefined) return { ok: false as const, error: 'rerun_recipe_not_found' };
  if (offset > encodedRecipe.length || (offset === encodedRecipe.length && offset !== 0)) {
    return { ok: false as const, error: 'invalid_rerun_recipe_offset' };
  }
  const { rerunRecipe: _recipe, ...header } = scorecard;
  let count = Math.min(inlineBudgetChars, encodedRecipe.length - offset);
  const page = () => ({
    ok: true as const,
    scorecard: header,
    evidenceRead: { complete: false, reason: 'rerun-recipe-page' },
    rerunRecipeRead: {
      complete: offset + count === encodedRecipe.length,
      encoding: 'json' as const,
      offset,
      totalChars: encodedRecipe.length,
      chunk: encodedRecipe.slice(offset, offset + count),
      ...(offset + count < encodedRecipe.length ? { next: rerunRecipeReadCall(issueId, offset + count) } : {}),
    },
  });
  let result = page();
  while (!fitsInlineResult(result, inlineBudgetChars) && count > 1) {
    count = Math.max(1, Math.floor(count / 2));
    result = page();
  }
  return result;
}

export default defineTool({
  name: 'scorecards:get',
  profile: 'engineer',
  description:
    'Read one rubric scorecard by issueId (id is a compatibility alias; issueId wins). Small cards return exact criterion evidence; oversized cards return an index via evidenceRead and recipes via rerunRecipeRead; follow their cursors, and never treat an incomplete page or index as missing evidence. Select with criterionKey; resume with indexOffset, evidenceOffset or rerunRecipeOffset. Add replay:retained-measurement with criterionKey for historical command-input or probe-predicate replay without live execution. History-only payload is omitted.',
  guidance: {
    when: 'Audit one existing scorecard and re-run the probes its criterion evidence names. Take issueId from scorecards:list or a grading-audit reservation.',
    notWhen:
      'Use scorecards:list for history or multiple rows, rubrics:get for rubric definitions, scorecards:emit to file a scorecard.',
    chaining:
      'For grading-integrity audits, call dev:pipeline_position for this path and use the same exact serving route for both scorecards:get and plans:evaluate-spec-test-adequacy: the process serving scorecards:get owns its currentness comparison; cross-route calls may report different currentness. ' +
      'For a spec-test-adequacy card call plans:evaluate-spec-test-adequacy with { slug: rerunRecipe.args.slug, scorecardId: issueId }; this replays its exact bindings as of scorecard.createdAt. Verify historicalAuditOnly.asOf matches scorecard.createdAt. Do not compare a direct replay of rerunRecipe.args with the historical card: freshness can change after evidence changes. Use rerunRecipe.args only when measuring the present state (current-state measurement). ' +
      'For a ledger measurement use scorecards:get { issueId, criterionKey, replay:"retained-measurement" } or the selected criterion retainedMeasurementReplay call. It recomputes retained command inputs or re-evaluates an original retained scalar probe response. scope:probe-predicate does not reconstruct SQL source rows or query calculations; unavailable SQL/counter snapshots remain unavailable, never current measurements. ' +
      'Read independent criteria in small Promise.all groups; follow each criterion pages sequentially. Concatenate complete pages before grading. If a call returns papercusp.output-envelope/v1, recover it through capability:read before reading scorecard.criteria. Recover all evidence pages before grading; emit the audit last.',
    returns:
    'Returns `{ ok, scorecard, evidenceRead, rerunRecipeRead? }`. The scorecard includes `evidenceFingerprint` when recorded, `evaluatorBuildCurrentness` when the recipe pins an evaluator build, and an inline `rerunRecipe` or a recoverable rerunRecipeRead cursor. Recipe pages retain card identity and gradingAudit; chunks encode exact JSON with UTF-16 offset/totalChars/next. Full evidence reads contain every exact criterion; an oversized read contains criteria:[] plus a complete or paged criterion index. Index pages preserve metadata and report offset/totalCriteria/next; criterion pages retain full-card identity and nKeys/missingKeys and report offset/totalChars/next. Recover recipe, index and evidence pages before grading.',
    seeAlso: ['scorecards:list', 'scorecards:emit', 'rubrics:get'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  // This handler performs its own bounded, read-only database transaction and
  // can wait on pool/lock contention. Do not retain the projected ambient
  // workspace transaction while that await is in flight: an idle outer
  // transaction can consume the 55s MCP deadline (and the 60s Postgres
  // idle-in-transaction timeout) even when the scorecard query itself is fast.
  // This is especially important through tools:invoke, whose nested dispatch
  // otherwise recreates the ambient transaction around this handler.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES, 'judge'],
  // This tool's projection is intentionally bounded at the source. It still
  // opts out of ambient tier shaping so a trimmed audit session cannot replace
  // evidence strings with depth-limit placeholders. The shared 30k ceiling
  // remains active as a final safety rail.
  ignoreSessionPayloadTier: true,
  args: scorecardGetArgs,
  result: scorecardGetResultSchema,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return withNamedQueryDiagnosticContext('scorecards:get', async (correlationId) => {
      const handlerStartedAt = performance.now();
      const diagnosticAttempt = createStageAttempt({ rowId: '', onEvent: () => {} });
      let handlerState: 'running' | 'completed' | 'failed' = 'running';
      let handlerCompleted = false;
      const makeDiagnostics = (state: typeof handlerState) => {
        const timing = namedQueryStageTimings();
        return {
          schemaVersion: 'scorecards-get-diagnostics-v1' as const,
          correlationId,
          handlerState: state,
          handlerElapsedMs: Math.max(0, Math.round(performance.now() - handlerStartedAt)),
          omittedStages: timing?.omittedStages ?? 0,
          stages: timing?.stages ?? [],
        };
      };
      const recordDiagnostics = (state: typeof handlerState) => {
        const diagnostics = makeDiagnostics(state);
        // Metadata is a replacement snapshot. Include the complete timing state
        // on every update so a client timeout can still identify the pending phase.
        try {
          ctx.metadata?.({ scorecardsGetDiagnostics: diagnostics });
        } catch {
          /* Observability must not change the scorecard read result. */
        }
        return diagnostics;
      };
      const respond = (data: Record<string, unknown>) => {
        handlerState = 'completed';
        handlerCompleted = true;
        return { data: { ...data, diagnostics: recordDiagnostics(handlerState) } };
      };
      const runDiagnosticStage = async <T>(stage: ScorecardGetDiagnosticStage, run: () => PromiseLike<T>): Promise<T> => {
        const pending = traceNamedQueryStage(stage, () => withStageAttempt(diagnosticAttempt, () =>
          logIfStageStalls(
            'scorecards:get',
            `${stage} correlation=${correlationId}`,
            traceStageAwait(stage, run),
          ),
        ));
        // The first snapshot records the pending stage before the server or
        // client timeout can obscure which await was in flight.
        recordDiagnostics('running');
        try {
          return await pending;
        } finally {
          recordDiagnostics('running');
        }
      };

      recordDiagnostics('running');
      try {
        return await runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
          try {
            const issueId = args.issueId ?? args.id;
            if (!issueId) {
              return respond({ ok: false, error: 'issueId or id is required' });
            }
            const recipePage = args.rerunRecipeOffset !== undefined;
            const result = await runDiagnosticStage(
              SCORECARD_GET_DIAGNOSTIC_STAGE.evidenceRead,
              () => recipePage ? readScorecardRecipeHeader(issueId) : readScorecardEvidence(issueId),
            );
            if (result.kind === 'not_found') {
              return respond({ ok: false, error: `scorecard '${issueId}' not found` });
            }
            if (result.kind === 'not_scorecard') {
              return respond({ ok: false, error: `'${issueId}' is not a scorecard` });
            }
            if (args.replay) {
              const criterion = (result.scorecard as ScorecardEvidenceRow).criteria.find(entry => entry.key === args.criterionKey);
              if (!criterion) return respond({ ok: false, error: 'criterion_not_found' });
              if (!criterion.ledgerResult || criterion.ratedFrom !== 'ledger') {
                return respond({ ok: false, error: 'retained_measurement_not_found' });
              }
              return respond({ ok: true, replay: {
                issueId, criterionKey: criterion.key, rubricRef: result.scorecard.rubricRef,
                evidenceFingerprint: result.scorecard.evidenceFingerprint,
                testRunId: criterion.ledgerResult.testRunId,
                ...(replayRetainedProbe(criterion.ledgerResult) ?? replayRetainedInstrument(criterion.ledgerResult)),
              } });
            }
            const gradingAuditRubric = result.scorecard.gradingAudit
              ? await runDiagnosticStage(
                  SCORECARD_GET_DIAGNOSTIC_STAGE.gradingAuditRubricRead,
                  () => getRubricWithoutSeeding(GRADING_INTEGRITY_RUBRIC_REF),
                ).catch(() => null)
              : null;
            const evaluatorBuildCurrentness = classifyEvaluatorBuildCurrentness(result.scorecard.rerunRecipe);
            const scorecard = {
              ...result.scorecard,
              ...(evaluatorBuildCurrentness ? { evaluatorBuildCurrentness } : {}),
              ...(result.scorecard.gradingAudit
                ? {
                    gradingAuditCurrentness: classifyGradingAuditCurrentness(
                      result.scorecard.gradingAudit,
                      gradingAuditRubric,
                    ),
                  }
                : {}),
            };
            if (recipePage) {
              return respond(boundedRerunRecipeHeaderRead(
                scorecard as ScorecardRecipeHeader & {
                  gradingAuditCurrentness?: ReturnType<typeof classifyGradingAuditCurrentness>;
                },
                args.rerunRecipeOffset!,
                issueId,
                inlineResultBudgetChars(identity.ownerId),
              ));
            }
            return respond(boundedEvidenceRead(
              scorecard as ScorecardEvidenceRow,
              args,
              issueId,
              inlineResultBudgetChars(identity.ownerId),
            ));
          } catch (error) {
            if (
              error instanceof OrgTxnTimeoutError ||
              error instanceof DbCallDeadlineError ||
              error instanceof PgReadQueryTimeoutError
            ) {
              return respond({
                ok: false,
                error: 'timeout',
                retryable: true,
                ...(error instanceof OrgTxnTimeoutError ? { pgCode: error.pgCode } : {}),
                message:
                  `${scorecardTimeoutLeadIn(error, 'scorecards:get read')}: ${error.message}. ` +
                  'No scorecard was returned; retry shortly.',
              });
            }
            throw error;
          }
        });
      } catch (error) {
        handlerState = 'failed';
        recordDiagnostics(handlerState);
        throw error;
      } finally {
        diagnosticAttempt.finish(handlerCompleted ? 'fulfilled' : 'rejected');
      }
    });
  },
});
