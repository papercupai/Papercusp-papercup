/** plans:get-spec-evidence — exact proof bindings with explicit currentness. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { createCommittedTreeDiagnostics } from './committed-tree-reader';
import {
  listSpecEvidence,
  SPEC_EVIDENCE_KINDS,
  evidenceCurrentInputSchema,
  type ListSpecEvidenceDiagnostics,
} from './spec-evidence-store';
import { fullBodyRef, isFullDetail, reviewReadDetailArg } from '../_review-read-detail';
import { hasMatchingDeclaredCaseTitle } from '../../testing-case-filter';

type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

/** The binding's declared `details.adequacy.testCases` (the list the adequacy evaluator matches). */
function declaredAdequacyCases(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const adequacy = (details as Record<string, unknown>).adequacy;
  if (!adequacy || typeof adequacy !== 'object' || Array.isArray(adequacy)) return [];
  const raw = (adequacy as Record<string, unknown>).testCases;
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

/**
 * WI-6554700010009931: the store row carries EVERY passed case title of the bound run
 * (405 titles, ~44KB per row measured on :3170), because spec-test-adequacy matches
 * declared cases against the full list in-process. An agent reading detail:'full' needs
 * only the titles its binding declares. Keep those, report the total and how many were
 * omitted, and point at the per-case ledger for the rest. The store row is not trimmed.
 * LLM-layer rows are left alone: their cases are corroborated by scenario, not by title.
 */
function fullEvidenceRow(row: EvidenceRow) {
  const execution = row.testRunExecution;
  const titles = execution?.passedCaseTitles;
  if (!execution || titles === undefined || execution.testLayer === 'llm') return row;
  const declared = declaredAdequacyCases(row.details);
  const kept = titles.filter((title) => declared.some((caseTitle) => hasMatchingDeclaredCaseTitle(caseTitle, [title])));
  if (kept.length === titles.length) return row;
  return {
    ...row,
    testRunExecution: {
      ...execution,
      passedCaseTitles: kept,
      passedCaseTitleCount: titles.length,
      passedCaseTitlesOmitted: titles.length - kept.length,
      passedCaseTitlesRef: { tool: 'testing:runs', args: { testRunIds: [row.testRunId], cases: true } },
    },
  };
}

/**
 * P-007 (RSR-P-007-A): the default per-binding currentness table. Identity plus the
 * overall verdict and its reasons — what an auditor scans; fingerprints, per-dimension
 * detail, binding details and the server-measurement body stay in detail:'full'.
 */
function summaryEvidenceRow(row: EvidenceRow) {
  return {
    id: row.id,
    workItemId: row.workItemId,
    specId: row.specId,
    specRevision: row.specRevision,
    evidenceKind: row.evidenceKind,
    evidenceRef: row.evidenceRef,
    testRunId: row.testRunId ?? null,
    currentness: {
      overall: row.currentness.overall,
      staleReasons: row.currentness.staleReasons,
      unknownReasons: row.currentness.unknownReasons,
    },
    ...(row.withdrawal ? { withdrawal: row.withdrawal } : {}),
  };
}

/** One row per clause revision: how many bindings, and how many are current/stale/unknown. */
function byClause(evidence: EvidenceRow[]) {
  const clauses = new Map<string, { specId: string; specRevision: number; bindings: number; current: number; stale: number; unknown: number }>();
  for (const row of evidence) {
    const key = `${row.specId}@${row.specRevision}`;
    const entry = clauses.get(key) ?? { specId: row.specId, specRevision: row.specRevision, bindings: 0, current: 0, stale: 0, unknown: 0 };
    entry.bindings += 1;
    entry[row.currentness.overall] += 1;
    clauses.set(key, entry);
  }
  return [...clauses.values()];
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  sourceValIds: z
    .array(z.string().regex(/^VAL-[A-Za-z0-9._-]+$/))
    .min(1)
    .max(500)
    .optional(),
  evidenceKinds: z.array(z.enum(SPEC_EVIDENCE_KINDS)).min(1).max(SPEC_EVIDENCE_KINDS.length).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  /** Exact immutable row ids for audit reads, including bindings later withdrawn. */
  bindingIds: z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .max(500)
    .optional()
    .describe(
      'Exact immutable binding row ids for audit reads, including withdrawn rows. Required as a non-empty selector when includeRetracted:true; workItemIds/specIds selectors are not sufficient for withdrawn-row audits.',
    ),
  /** Audit-only: must be paired with exact binding ids; never use for gate evaluation. */
  includeRetracted: z
    .boolean()
    .optional()
    .describe(
      'Audit-only: include withdrawn evidence. Requires bindingIds with at least one exact row id; never use for gate or evaluator reads.',
    ),
  current: z
    .union([z.array(evidenceCurrentInputSchema).max(500), z.boolean()])
    .optional()
    .describe(
      'Current fingerprints keyed by planSlug/specId/specRevision/specFingerprint/evidenceKind/evidenceRef when clause identity is supplied; legacy evidenceKind+evidenceRef tuples remain a fallback. Boolean true/false both omit caller fingerprints and use independent server measurement. Missing applicable values return unknown, never current.',
    ),
  currentness: z
    .array(z.enum(['current', 'stale', 'unknown']))
    .min(1)
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(1000).optional().describe('Maximum evidence rows returned; bounded.truncatedByLimit reports whether additional rows exist.'),
  detail: reviewReadDetailArg,
}).refine((args) => args.includeRetracted !== true || (args.bindingIds !== undefined && args.bindingIds.length > 0), {
  message: 'includeRetracted requires a non-empty exact bindingIds selector for audit reads',
  path: ['bindingIds'],
});

export default defineTool({
  name: 'plans:get-spec-evidence',
  description:
    'Read exact work-item/spec-revision evidence and compute per-dimension current|stale|unknown|not-applicable status. Spec currentness comes from the canonical revision pointer; source/test/fixture/rubric/environment values compare with explicit current fingerprints, and missing inputs remain unknown. The aggregate bounded field reports whether the requested row limit omitted evidence. Default detail:"summary" returns a per-binding currentness table, a byClause rollup and a fullBody ref; detail:"full" adds fingerprints, per-dimension status and binding details. For audit-only inspection of withdrawn evidence, includeRetracted:true must be paired with a non-empty exact bindingIds selector; workItemIds/specIds selectors alone are insufficient, and this selector is never for gate/evaluator reads.',
  guidance: {
    when: 'Auditing whether each current plan spec has fresh evidence, including legacy VAL aliases and historical bindings.',
    notWhen: 'Writing evidence — plans:bind-spec-evidence. Reading behavior without proof — plans:get-specs.',
    chaining: 'plans:bind-spec-evidence → plans:get-spec-evidence { current:[…] } → completion/acceptance gate. Historical withdrawn rows are audit-only: use bindingIds with includeRetracted:true and never feed them into gate evaluation.',
    seeAlso: ['plans:bind-spec-evidence (append proof)', 'plans:get-specs (canonical behavior)'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // This is a correctness read when detail:'full' is requested: the binding
  // details (including details.adequacy) are the evidence an auditor must
  // inspect. Preserve that body through both the ambient trimmed tier and the
  // model-facing result door, just as rubrics:get does for full rubric bodies.
  // The explicit limit remains the caller's bound on the evidence population.
  skipResultDoor: 'oversize-by-design',
  ignoreSessionPayloadTier: true,
  // EI-21841626363210048: the judge role's grading-integrity audit is mandated to
  // "execute each evidence probe exactly as written" for a spec-test-adequacy card —
  // this read-only tool IS that probe (named by spec-test-adequacy's own method text
  // and by its `freshness` method). Without it the auditor was structurally blocked
  // from the one re-run its own rubric prescribes and had to substitute weaker
  // corroboration with no signal in the emitted card.
  agentRoles: [...SU_ROLES, 'kettle', 'worker', 'cup', 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const { detail, current, ...listArgs } = args;
    const limit = args.limit ?? 200;
    const diagnostics: ListSpecEvidenceDiagnostics = {
      phaseMs: {},
      committedTree: createCommittedTreeDiagnostics({
        requestTraceId: ctx.requestOrigin?.mcpRequestTraceId,
        toolName: 'plans:get-spec-evidence',
      }),
      bindings: {
        selectedRows: 0,
        rowsWithRecipe: 0,
        measured: 0,
        unavailable: 0,
        skipped: 0,
        totalMeasurementMs: 0,
        maxMeasurementMs: 0,
      },
    };
    const evidenceWithLookahead = await listSpecEvidence({
      ...listArgs,
      current: typeof current === 'boolean' ? undefined : current,
      limit: limit + 1,
      planSlugs: [args.slug],
      harnessSlug,
      diagnostics,
    });
    ctx.metadata?.({
      plansGetSpecEvidenceStageTimings: {
        schemaVersion: 'plans-get-spec-evidence-stage-timings-v1',
        requestedLimit: limit,
        phaseMs: diagnostics.phaseMs,
        bindings: diagnostics.bindings,
        committedTree: diagnostics.committedTree,
      },
    });
    const truncatedByLimit = evidenceWithLookahead.length > limit;
    const evidence = truncatedByLimit ? evidenceWithLookahead.slice(0, limit) : evidenceWithLookahead;
    const counts = { current: 0, stale: 0, unknown: 0 };
    for (const row of evidence) counts[row.currentness.overall] += 1;
    return {
      data: {
        ok: true,
        slug: args.slug,
        harnessSlug,
        bounded: { limit, truncatedByLimit },
        ...(isFullDetail(detail)
          ? { detail: 'full' as const, evidence: evidence.map(fullEvidenceRow) }
          : {
              detail: 'summary' as const,
              evidence: evidence.map(summaryEvidenceRow),
              byClause: byClause(evidence),
              fullBody: fullBodyRef('plans:get-spec-evidence', args, [
                'evidence[].fingerprints',
                'evidence[].currentness.dimensions',
                'evidence[].details',
                'evidence[].serverMeasurement',
              ]),
            }),
        count: evidence.length,
        currentness: counts,
      },
    };
  },
});
