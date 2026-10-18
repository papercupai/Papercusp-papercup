/** plans:bind-spec-evidence — append exact work-item/spec-revision proof bindings. */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import type { AbortCompletionContext, AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../abort-completion-payload';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolveAgentIdentity } from '../coordination/identity';
import { bulkContent, runBulk } from '../_bulk';
import { resolvePlanScope } from './source';
import {
  ADHOC_WORK_ITEM_SPEC_SCOPE,
  bindSpecEvidence,
  evidenceMeasurementSchema,
  MEASUREMENT_PIN_DETAILS_KEY,
  measureAndPinEvidenceForScope,
  measureAndPinRepoFilesEvidenceAtCommitForScope,
  resolveMeasurementRoot,
  listSpecEvidence,
  retractSpecEvidence,
  SPEC_EVIDENCE_KINDS,
  supersedeSpecEvidenceAtRevision,
  type SupersessionKeepReason,
} from './spec-evidence-store';
import { isAcceptedMutationTarget, mutationTargetRequirement, supersedeEligibilityGaps } from './spec-test-adequacy';
import {
  listSpecClauses,
  SPEC_PROOF_OBLIGATION_ID_RE,
  SPEC_TARGET_ID_RE,
  type SpecClauseBarPin,
} from './spec-clauses-store';
import { getAcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import { getAcceptanceRubricsForPlan, getRubric } from '../../rubrics';
import { withWorkspace } from '@papercusp/db-org';
import {
  judgeDeclaredConfiguration,
  parseProductionConfiguration,
  readConfigurationSnapshot,
  type DeclaredConfigurationRefusalCode,
} from './declared-configuration';
import { listScorecards } from '../../scorecards';
import { assertCodeDependencyVersions, captureCodeDependencies, dependencyQueriesSchema } from './code-dependency-evidence';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { unvettedRubricBindAdvisory, VET_BEFORE_PROOF_ORDER } from './bind-vetting-advisory';
import {
  rebindAttestationAdvisory,
  retractionAttestationAdvisory,
  type AttestationAdvisory,
} from './adequacy-attestation-gap';
import {
  expandTestRunBinding,
  testRunBindingSchema,
  type TestRunBindingError,
  type TestRunBindingInput,
} from './bind-from-test-run';
import {
  defaultInstrumentProvenanceDeps,
  instrumentProvenanceRefusal,
  INSTRUMENT_EVIDENCE_KINDS,
  type InstrumentProvenanceDeps,
} from './instrument-provenance';

/** Test seam: substitute the git/registry deps of the P-010 instrument-provenance check. */
export const bindSpecEvidenceTestSeams: {
  instrumentDeps?: (harnessSlug: string) => InstrumentProvenanceDeps;
  /** P-011: substitute the clause/rubric/snapshot reads of the declared-configuration check. */
  declaredConfigurationDeps?: (harnessSlug: string) => DeclaredConfigurationBindDeps;
} = {};

const fingerprint = z.string().trim().min(1).max(256);
const proofCoverageIds = z
  .array(z.string().trim().min(1).max(200).regex(SPEC_PROOF_OBLIGATION_ID_RE))
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'proof coverage ids must be unique');
const coverageRungsSchema = z
  .object({
    l1: z.boolean().optional(),
    l2: z.boolean().optional(),
    l3: z.boolean().optional(),
    l4: z.boolean().optional(),
  })
  .strict();
const adequacyBindingDetailsSchema = z
  .object({
    fixtureCalibrated: z.boolean().optional(),
    fixtureFree: z.boolean().optional(),
    falsifiable: z.boolean().optional(),
    testLayer: z.string().optional(),
    testCases: z.array(z.string().trim().min(1).max(2000)).optional(),
    pathReachable: z.boolean().optional(),
    oracleIndependent: z.boolean().optional(),
    collected: z.boolean().optional(),
    skipped: z.boolean().optional(),
    executed: z.boolean().optional(),
    outcome: z.string().optional(),
    targeted: z
      .union([z.boolean(), z.string().trim().min(1).max(200).regex(SPEC_TARGET_ID_RE)])
      .optional(),
    coverageRungs: coverageRungsSchema.optional(),
    scenarioIds: proofCoverageIds.optional(),
    causalPairIds: proofCoverageIds.optional(),
    provisionalProofBase: z.boolean().optional(),
    disclosedGap: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();
// Keep the evaluator's adequacy vocabulary out of the free-form details
// namespace. `spec-test-adequacy` reads these keys only below
// `details.adequacy`; accepting them at the top level creates a successful,
// persisted binding whose metadata is silently inert.
const ADEQUACY_DETAIL_KEYS = new Set([
  'fixtureCalibrated',
  'fixtureFree',
  'falsifiable',
  'testCases',
  'pathReachable',
  'oracleIndependent',
  'collected',
  'skipped',
  'executed',
  'outcome',
  'targeted',
  'coverageRungs',
  'scenarioIds',
  'causalPairIds',
  'provisionalProofBase',
]);
const instrumentDeclarationSchema = z
  .object({
    path: z
      .string()
      .optional()
      .describe('Repository-relative path to the committed instrument that produced the evidence.'),
    testPath: z
      .string()
      .optional()
      .describe('Repository-relative path to a committed test that imports or exercises the instrument.'),
    none: z.literal(true).optional().describe('Set true only when the observation used no program or script.'),
    reason: z.string().optional().describe('Explain why no instrument was used when none is true.'),
  })
  .passthrough()
  .describe(
    'For operational/manual evidence, declare either { path, testPath } for the committed instrument and its committed test, or { none: true, reason } when no instrument was used.',
  );
const bindingDetailsSchema = z.preprocess((value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const details = value as Record<string, unknown>;
  if (typeof details.testLayer !== 'string') return value;
  const nested = details.adequacy;
  if (nested !== undefined && (nested === null || typeof nested !== 'object' || Array.isArray(nested))) return value;
  const adequacy = nested as Record<string, unknown> | undefined;
  if (adequacy?.testLayer !== undefined && adequacy.testLayer !== details.testLayer) return value;
  const { testLayer, ...rest } = details;
  return { ...rest, adequacy: { ...adequacy, testLayer } };
}, z
  .intersection(
    z.record(z.string(), z.unknown()),
    z
      .object({
        instrument: instrumentDeclarationSchema.optional(),
      })
      .passthrough(),
  )
  .superRefine((details, ctx) => {
    if (details.testLayer !== undefined) {
      if (typeof details.testLayer !== 'string') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['testLayer'], message: 'details.testLayer must be a string' });
      } else if (details.adequacy !== null && typeof details.adequacy === 'object' && !Array.isArray(details.adequacy)) {
        const nested = (details.adequacy as Record<string, unknown>).testLayer;
        if (nested !== undefined && nested !== details.testLayer) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['testLayer'], message: 'details.testLayer conflicts with details.adequacy.testLayer' });
        }
      }
    }
    for (const key of Object.keys(details).filter((candidate) => ADEQUACY_DETAIL_KEYS.has(candidate))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message:
          `adequacy metadata must be nested under details.adequacy.${key}; ` +
          `flat details.${key} is ignored by spec-test-adequacy`,
      });
    }
    if (details.adequacy === undefined) return;
    const parsed = adequacyBindingDetailsSchema.safeParse(details.adequacy);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adequacy', ...issue.path],
        message: issue.message,
      });
    }
  }));
const CAUSAL_PAIR_EVIDENCE_KINDS = new Set([
  'test',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'operational',
]);
export const bindingSchema = z
  .object({
    workItemId: z.string().trim().min(1).max(200),
    specId: z.string().trim().min(1).max(200).optional(),
    sourceValId: z
      .string()
      .regex(/^VAL-[A-Za-z0-9._-]+$/)
      .optional(),
    specRevision: z.number().int().positive().optional(),
    evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
    evidenceRef: z.string().trim().min(1).max(2000),
    sourceFingerprint: fingerprint
      .optional()
      .describe('Caller-declared fingerprint for opaque evidence. Pass this OR measurement, never both.'),
    testFingerprint: fingerprint.nullable().optional(),
    fixtureFingerprint: fingerprint.nullable().optional(),
    rubricFingerprint: fingerprint.nullable().optional(),
    environmentFingerprint: fingerprint.nullable().optional().describe(
      "Fingerprint the runtime/environment observed by live or deployed evidence. For details.evidencePlane 'live' or 'deployed', omitting this leaves environment currentness unknown unless details.currentMeasurement is a validated ledger-only measurement with no runtimeUnits.",
    ),
    coverageEvidenceRef: z.number().int().positive().nullable().optional(),
    testRunId: z.number().int().positive().nullable().optional(),
    measurement: evidenceMeasurementSchema
      .optional()
      .describe(
        "Server-measured basis, discriminated on `kind`: 'repo-files' hashes bounded source/test files; 'work-items' hashes a bounded work-item id set, which is how a NON-CODE outcome reaches source=current. Stores the recipe, so later reads recompute it and a reopened row goes stale.",
      ),
    details: bindingDetailsSchema.optional().describe(
      "For a clause declaring requiredEvidence, set details.evidencePlane to a matching plane (for example { evidencePlane: 'live' }); details.adequacy.evidencePlane is accepted as a fallback. A matching live/deployed label alone is not enough for currentness: provide environmentFingerprint above.",
    ),
    observedAt: z.string().datetime({ offset: true }).optional(),
    verifiesBindingId: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe(
        "Required for evidenceKind 'independent-verification' and refused for every other kind: the id of the implementer's live binding on the same spec that this observation independently reproduces. Its source and environment fingerprints must match yours.",
      ),
  })
  .refine((b) => (b.evidenceKind === 'independent-verification') === (b.verifiesBindingId != null), {
    message: "verifiesBindingId is required for evidenceKind 'independent-verification' and refused for every other kind",
    path: ['verifiesBindingId'],
  })
  .refine((b) => Boolean(b.specId) !== Boolean(b.sourceValId), {
    message: 'pass exactly one of specId or sourceValId (legacy coversVALs resolve through sourceValId)',
  })
  .refine((b) => Boolean(b.sourceFingerprint) !== Boolean(b.measurement), {
    message: 'pass exactly one of sourceFingerprint or measurement',
  })
  .refine((b) => !b.measurement || b.testFingerprint === undefined, {
    message: 'testFingerprint is server-computed when measurement is supplied',
  })
  .superRefine((binding, ctx) => {
    const testRunDetails = binding.details?.testRun;
    if (testRunDetails !== undefined) {
      const path = ['details', 'testRun'] as const;
      if (testRunDetails === null || typeof testRunDetails !== 'object' || Array.isArray(testRunDetails)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path],
          message: 'details.testRun must be the identity object derived from the same canonical testRunId',
        });
      } else {
        const run = testRunDetails as Record<string, unknown>;
        if (!Number.isSafeInteger(run.id) || run.id !== binding.testRunId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'id'],
            message: 'details.testRun.id must equal the binding testRunId',
          });
        }
        const filePath = typeof run.filePath === 'string' ? run.filePath.trim() : '';
        if (!filePath) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'filePath'],
            message: 'details.testRun.filePath must identify the recorded test file',
          });
        } else {
          const normalizePath = (value: string) => value.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
          const evidenceRef = normalizePath(binding.evidenceRef);
          const declaredPath = normalizePath(filePath);
          if (binding.evidenceKind === 'test') {
            const referencePath = evidenceRef.replace(/^test-run:/, '');
            if (referencePath !== declaredPath) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['evidenceRef'],
                message: 'test evidenceRef must identify the same file as details.testRun.filePath',
              });
            }
          } else {
            const referenceRunId = /^test-run\s+(\d+)\b/.exec(binding.evidenceRef);
            if (!referenceRunId || Number(referenceRunId[1]) !== binding.testRunId || !evidenceRef.includes(declaredPath)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['evidenceRef'],
                message: 'run-derived evidenceRef must identify the same testRunId and file as details.testRun',
              });
            }
          }
        }
      }
    }
    if (binding.measurement) {
      const adequacy = binding.details?.adequacy;
      const fixtureCalibrationExpected =
        binding.evidenceKind === 'fixture' ||
        (adequacy !== null && typeof adequacy === 'object' && !Array.isArray(adequacy) &&
          (adequacy as Record<string, unknown>).fixtureCalibrated === true);
      if (
        fixtureCalibrationExpected &&
        (binding.measurement.kind !== 'repo-files' ||
          (binding.measurement.fixturePaths === undefined && binding.measurement.fixtureGlobs === undefined))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['measurement', 'fixturePaths'],
          message:
            'fixture evidence or adequacy.fixtureCalibrated=true requires repo-files measurement.fixturePaths or fixtureGlobs so calibration inputs stay fresh',
        });
      }
      for (const field of ['fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'] as const) {
        if (binding[field] == null) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message:
            `repo-files measurement cannot independently refresh ${field}; omit it or pass null ` +
            '(record non-repository facts in details.observations without making them a freshness dimension)',
        });
      }
    }
    const adequacy = adequacyBindingDetailsSchema.safeParse(binding.details?.adequacy);
    if (
      adequacy.success &&
      adequacy.data.causalPairIds !== undefined &&
      !CAUSAL_PAIR_EVIDENCE_KINDS.has(binding.evidenceKind)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['details', 'adequacy', 'causalPairIds'],
        message:
          'causalPairIds require executable test/check/coverage/operational proof or mutation/counterexample proof',
      });
    }
  });

/**
 * Withdraw one already-bound piece of evidence (decision D-011).
 *
 * Lives on THIS verb rather than a new one deliberately: retraction is the inverse of
 * binding over the same rows, the same scope resolution and the same bulk envelope, so
 * forking `plans:retract-spec-evidence` would duplicate all of it to express one flag.
 */
const retractionSchema = z.object({
  bindingId: z
    .number()
    .int()
    .positive()
    .describe(
      'The exact binding row id, from plans:get-spec-evidence — never a (workItemId, evidenceRef) pair, which routinely matches several history rows.',
    ),
  reason: z
    .string()
    .trim()
    .min(12)
    .max(2000)
    .describe(
      'Why this proof is withdrawn (e.g. the bound run was never executed). Stored on the row: an unexplained retraction is indistinguishable from the evidence-shedding D-011 forbids.',
    ),
});

/**
 * P-044: an item is EITHER a hand-built binding OR `{ fromTestRun }`, which derives the rest
 * from the recorded run (bind-from-test-run.ts). The run form is tried first because it is
 * strict and keyed on `fromTestRun`, so a hand-built binding never half-matches it.
 */
// The same item contract appears in both the single-binding shorthand and the bulk array.
// Give it an id so Zod publishes it once in $defs and both inputs reference that definition.
const bindingOrTestRunSchema = z
  .union([testRunBindingSchema, bindingSchema])
  .meta({ id: 'PlansBindSpecEvidenceBindingV1' });

function isTestRunBinding(item: object): item is TestRunBindingInput {
  return typeof (item as { fromTestRun?: unknown }).fromTestRun === 'number';
}

type ResolvedBinding =
  | {
      ok: true;
      binding: z.infer<typeof bindingSchema>;
      derived?: Record<string, unknown>;
      /** Original small request item for a concise target correction. */
      correctionInput?: TestRunBindingInput;
      /** A clean commit-stamped run: measure its binding at the commit that ran (D-001 (b)). */
      asCommitted?: { commitSha: string; repoPrefix: string | null };
    }
  | { ok: false; error: TestRunBindingError | 'derived_binding_invalid'; testRunId: number; message: string };

const argsSchema = refineEvenWithShapeIssues(
  z.object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plan owning the referenced spec revisions. Omit for an ad-hoc work-item with no plan — its clauses use the harness-wide ad-hoc spec scope.',
      ),
    binding: bindingOrTestRunSchema.optional().describe('Single-binding shorthand (n=1 of items).'),
    items: z.array(bindingOrTestRunSchema).min(1).max(500).optional(),
    dependencies: dependencyQueriesSchema.optional().describe(
      'Bounded native compiler dependency queries. Expand repo-files sourcePaths before hashing; retain graph provenance and refuse unmeasured or truncated answers. This never revalidates a prior passing proof.',
    ),
    retract: z
      .array(retractionSchema)
      .min(1)
      .max(100)
      .optional()
      .describe('Withdraw already-bound evidence instead of appending it. Mutually exclusive with binding/items.'),
    supersedeAtRevision: z
      .boolean()
      .optional()
      .describe(
        'After binding, retract the OTHER live rows it replaces at the same clause revision: same evidenceKind AND same subject (test file, else evidenceRef), claiming no adequacy.targeted or causalPairIds the new row lacks. Stamped "superseded by binding N". Other-subject siblings stay live and are listed in supersession[].kept with a reason; retract those explicitly. Only a successful ledger-backed executable binding may supersede; a weaker one supersedes nothing (reported in supersession).',
      ),
  }),
  // RSR-P-008-A: both combination rules are reported alongside any shape defect.
  (args, ctx) => {
    if ([args.binding, args.items, args.retract].filter(Boolean).length !== 1) {
      ctx.addIssue({ code: 'custom', path: [], message: 'pass exactly one of binding, items or retract' });
    }
    if (args.supersedeAtRevision && args.retract) {
      ctx.addIssue({ code: 'custom', path: [], message: 'supersedeAtRevision applies to binding/items, not retract' });
    }
    if (args.dependencies && args.retract) {
      ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'dependencies apply to binding/items, not retract' });
    }
    if (args.dependencies && (args.items ?? (args.binding ? [args.binding] : [])).some(binding =>
      !isTestRunBinding(binding) && binding.measurement?.kind !== 'repo-files')) {
      ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'dependencies require a repo-files measurement or a recorded test run' });
    }
  },
);

type SupersessionOutcome =
  | {
      bindingId: number;
      status: 'superseded';
      clause: string;
      evidenceKind: string;
      retracted: Array<{ bindingId: number; workItemId: string; evidenceRef: string }>;
      /** Same-kind live siblings left standing: they prove a different subject/target/seam. */
      kept: Array<{ bindingId: number; workItemId: string; evidenceRef: string; reason: SupersessionKeepReason }>;
    }
  | { bindingId: number; status: 'refused'; clause: string; reason: string };

/**
 * P-019 (review-system-rework-reduction-2026-09-23): `supersedeAtRevision:true`. The adequacy
 * evaluator grades EVERY live binding at a clause revision, so fresh sufficient proof could not
 * rescue a clause while an older weak/stale/failing row stood beside it (R-11: 13 rows retracted
 * by hand before a targeted mutation proof could pass). Each successfully bound row that is
 * itself sufficient retracts its same-kind siblings; rows bound in this call are never retracted
 * by each other. Runs after the binds commit, so a failure leaves old rows live, never lost.
 */
async function supersedeSiblings(input: {
  bindings: ReadonlyArray<z.infer<typeof bindingSchema> | undefined>;
  results: ReadonlyArray<unknown>;
  harnessSlug: string | undefined;
  actorId: string;
}): Promise<SupersessionOutcome[]> {
  const bound = input.results.map((result) => {
    const row = result as { ok?: unknown; id?: unknown; planSlug?: unknown; specId?: unknown; specRevision?: unknown };
    return row.ok === true &&
      typeof row.id === 'number' &&
      typeof row.planSlug === 'string' &&
      typeof row.specId === 'string' &&
      typeof row.specRevision === 'number'
      ? { id: row.id, planSlug: row.planSlug, specId: row.specId, specRevision: row.specRevision }
      : null;
  });
  const keepBindingIds = bound.flatMap((row) => (row ? [row.id] : []));
  const persistedEvidence = keepBindingIds.length > 0
    ? await listSpecEvidence({
        harnessSlug: input.harnessSlug,
        planSlugs: [...new Set(bound.flatMap((row) => (row ? [row.planSlug] : [])))],
        bindingIds: keepBindingIds,
      })
    : [];
  const persistedById = new Map(persistedEvidence.map((evidence) => [Number(evidence.id), evidence] as const));
  const outcomes: SupersessionOutcome[] = [];
  for (const [index, row] of bound.entries()) {
    const declared = input.bindings[index];
    if (!row || !declared) continue;
    const clause = `${row.specId}@${row.specRevision}`;
    const persisted = persistedById.get(row.id);
    const gaps = persisted
      ? supersedeEligibilityGaps(persisted)
      : ['canonical evidence row unavailable from the scoped evidence read'];
    if (gaps.length > 0) {
      outcomes.push({
        bindingId: row.id,
        status: 'refused',
        clause,
        reason: `binding ${row.id} is bound but is not sufficient proof on its own, so it supersedes nothing: ${gaps.join(', ')}`,
      });
      continue;
    }
    const { retracted, kept } = await supersedeSpecEvidenceAtRevision({
      harnessSlug: input.harnessSlug,
      planSlug: row.planSlug,
      specId: row.specId,
      specRevision: row.specRevision,
      evidenceKind: declared.evidenceKind,
      supersedingBindingId: row.id,
      keepBindingIds,
      actorId: input.actorId,
    });
    outcomes.push({
      bindingId: row.id,
      status: 'superseded',
      clause,
      evidenceKind: declared.evidenceKind,
      retracted: retracted.map((r) => ({
        bindingId: Number(r.id),
        workItemId: r.work_item_id,
        evidenceRef: r.evidence_ref,
      })),
      kept: kept.map((r) => ({
        bindingId: r.id,
        workItemId: r.work_item_id,
        evidenceRef: r.evidence_ref,
        reason: r.keep_reason,
      })),
    });
  }
  return outcomes;
}

/**
 * Requirement-contract refusals bind-spec-evidence returns itself (instrument
 * provenance has its own union in instrument-provenance.ts). Registered in
 * doc-claims/verification-system-map.ts, whose test demands a map entry and a
 * triggering test for every member.
 */
export type BindSpecEvidenceRefusalCode =
  | 'derived_binding_invalid'
  | 'mutation_target_rejected'
  // P-011: spelled out (not the imported DeclaredConfigurationRefusalCode) because the map
  // test resolves this union with noResolve, so an imported alias would not read as literals.
  | 'declared_configuration_fingerprint_missing'
  | 'declared_configuration_fingerprint_mismatch';

/**
 * A binding expanded from a test run must still satisfy the hand-written binding schema;
 * anything else is refused as `derived_binding_invalid`, naming the run it came from.
 */
export function parseDerivedBinding(
  binding: unknown,
  testRunId: number,
):
  | { ok: true; binding: z.infer<typeof bindingSchema> }
  | { ok: false; error: 'derived_binding_invalid'; testRunId: number; message: string } {
  const parsed = bindingSchema.safeParse(binding);
  if (parsed.success) return { ok: true, binding: parsed.data };
  return {
    ok: false,
    error: 'derived_binding_invalid' satisfies BindSpecEvidenceRefusalCode,
    testRunId,
    message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  };
}

export interface MutationTargetRefusal {
  clause: string;
  targeted: unknown;
  acceptedTargets: string[];
  reason: string;
  correctedCall: { tool: 'plans:bind-spec-evidence'; args: Record<string, unknown> };
}

/**
 * P-043 (review-system-rework-reduction-2026-09-23): judge falsifiability TARGETING at bind time
 * with the evaluator's own rule (`mutationTargetRequirement`), so a mutation/counterexample
 * binding the evaluator will reject is refused here instead of being accepted, proven, audited,
 * and only then refused at completion (the measured case: proof 11:54Z, audit 12:08Z, completion
 * refused 12:11Z, re-emitted and re-audited on unchanged evidence, closed 12:38Z). Every
 * mutation/counterexample binding feeds that criterion and falsifiability has no not-applicable
 * branch, so a mis-targeted one can never help it. The rule is moved earlier, never lowered.
 * Legacy `sourceValId` bindings and unknown specs fall through to the store, which owns those
 * refusals.
 */
/**
 * The commit a derived binding must be measured at: bind-from-test-run stamps
 * `details.testRun.asCommitted` on a clean run that executed in a disposable clone.
 * Undefined for every other binding, which keeps the live checkout measurement.
 */
export function asCommittedRunOf(details: unknown): AsCommittedRun | undefined {
  const asCommitted = (details as { testRun?: { asCommitted?: { commitSha?: unknown; repoPrefix?: unknown } } } | null)
    ?.testRun?.asCommitted;
  if (typeof asCommitted?.commitSha !== 'string') return undefined;
  return {
    commitSha: asCommitted.commitSha,
    repoPrefix: typeof asCommitted.repoPrefix === 'string' ? asCommitted.repoPrefix : null,
  };
}

export type AsCommittedRun = { commitSha: string; repoPrefix: string | null };

/**
 * D-001 (b): a clean commit-stamped run stores the closure bytes AT the commit that ran,
 * never the live working tree, so later shared-tree movement neither refuses the bind nor
 * launders freshness on a re-bind of the same run. Every other binding (no run commit, or a
 * non-repo-files measurement) is measured as before.
 */
export async function measureBindingForStore(
  workspaceId: string,
  harnessSlug: string,
  measurement: z.infer<typeof evidenceMeasurementSchema>,
  asCommitted: AsCommittedRun | undefined,
  deps: {
    atCommit?: typeof measureAndPinRepoFilesEvidenceAtCommitForScope;
    live?: typeof measureAndPinEvidenceForScope;
  } = {},
): Promise<Awaited<ReturnType<typeof measureAndPinEvidenceForScope>>> {
  if (asCommitted && measurement.kind === 'repo-files') {
    return (deps.atCommit ?? measureAndPinRepoFilesEvidenceAtCommitForScope)(workspaceId, harnessSlug, measurement, asCommitted);
  }
  return (deps.live ?? measureAndPinEvidenceForScope)(workspaceId, harnessSlug, measurement);
}

export async function mutationTargetingRefusal(
  binding: z.infer<typeof bindingSchema>,
  scope: { planSlug: string; harnessSlug: string | undefined; slugArg?: string; harnessArg?: string },
  loadClauses: typeof listSpecClauses = listSpecClauses,
  correctionInput?: TestRunBindingInput,
): Promise<MutationTargetRefusal | null> {
  if ((binding.evidenceKind !== 'mutation' && binding.evidenceKind !== 'counterexample') || !binding.specId) return null;
  const [clause] = await loadClauses({
    harnessSlug: scope.harnessSlug,
    planSlug: scope.planSlug,
    specIds: [binding.specId],
    ...(binding.specRevision !== undefined ? { revision: binding.specRevision } : {}),
    limit: 1,
  });
  if (!clause) return null;
  const adequacy =
    binding.details?.adequacy && typeof binding.details.adequacy === 'object' && !Array.isArray(binding.details.adequacy)
      ? (binding.details.adequacy as Record<string, unknown>)
      : {};
  if (isAcceptedMutationTarget(clause, adequacy.targeted)) return null;
  const { acceptedTargets, requirement } = mutationTargetRequirement(clause);
  const label = `${clause.specId}@${clause.revision}`;
  const given =
    adequacy.targeted === undefined ? 'no adequacy.targeted' : `adequacy.targeted = ${JSON.stringify(adequacy.targeted)}`;
  const correctedCall = correctionInput
    ? (() => {
        const priorAdequacy = correctionInput.details?.adequacy;
        const correctionAdequacy =
          priorAdequacy && typeof priorAdequacy === 'object' && !Array.isArray(priorAdequacy)
            ? (priorAdequacy as Record<string, unknown>)
            : {};
        return {
          tool: 'plans:bind-spec-evidence' as const,
          args: {
            ...(scope.harnessArg ? { harness: scope.harnessArg } : {}),
            ...(scope.slugArg ? { slug: scope.slugArg } : {}),
            items: [{
              ...correctionInput,
              details: {
                ...(correctionInput.details ?? {}),
                adequacy: { ...correctionAdequacy, targeted: acceptedTargets[0] },
              },
            }],
          },
        };
      })()
    : {
        tool: 'plans:bind-spec-evidence' as const,
        args: {
          ...(scope.harnessArg ? { harness: scope.harnessArg } : {}),
          ...(scope.slugArg ? { slug: scope.slugArg } : {}),
          binding: {
            ...binding,
            details: { ...(binding.details ?? {}), adequacy: { ...adequacy, targeted: acceptedTargets[0] } },
          },
        },
      };
  return {
    clause: label,
    targeted: adequacy.targeted ?? null,
    acceptedTargets,
    reason:
      `${label}: this ${binding.evidenceKind} binding carries ${given}, which plans:evaluate-spec-test-adequacy ` +
      `would reject for falsifiability — it requires ${requirement}; a boolean or sibling-case target never ` +
      `qualifies. Accepted: ${acceptedTargets.join(', ')}.`,
    correctedCall,
  };
}

/** What a matched binding records in `details.declaredConfiguration` (P-011). */
export interface DeclaredConfigurationStamp {
  required: true;
  testRunId: number;
  declaredFingerprint: string;
  fingerprint: string;
}

export interface DeclaredConfigurationBindRefusal {
  error: DeclaredConfigurationRefusalCode;
  clause: string;
  testRunId: number | null;
  declaredFingerprint: string;
  fingerprint: string | null;
  differing: string[];
  message: string;
}

export type DeclaredConfigurationBindCheck =
  | { kind: 'undeclared' }
  | { kind: 'refused'; refusal: DeclaredConfigurationBindRefusal }
  | { kind: 'matched'; stamp: DeclaredConfigurationStamp };

export interface DeclaredConfigurationBindDeps {
  loadClauses: typeof listSpecClauses;
  /** The pinned BAR criterion the clause was projected from, or null when it cannot be read. */
  loadCriterion: (pin: SpecClauseBarPin) => Promise<{ productionConfiguration?: unknown } | null>;
  /** The run's raw `test_runs.configuration_snapshot`, or null when the run is not in scope. */
  readSnapshot: (testRunId: number) => Promise<unknown>;
}

export function defaultDeclaredConfigurationDeps(workspaceId: () => Promise<string>): DeclaredConfigurationBindDeps {
  return {
    loadClauses: listSpecClauses,
    async loadCriterion(pin) {
      const rubric = await getRubric(pin.rubricSlug, pin.rubricRevision);
      return rubric?.criteria.find((criterion) => (criterion.barKey?.trim() || criterion.key) === pin.barKey) ?? null;
    },
    async readSnapshot(testRunId) {
      const scope = await workspaceId();
      return withWorkspace(scope, async (tx) => {
        const rows = await tx<{ configuration_snapshot: unknown }[]>`
          SELECT configuration_snapshot FROM harness_shared.test_runs
           WHERE id = ${testRunId} AND workspace_id = ${scope}`;
        return rows[0]?.configuration_snapshot ?? null;
      });
    },
  };
}

/**
 * P-011 (verification-system-improvements-2026-10-10, AUTO-BAR-R-11): a bar that declares
 * `verification.productionConfiguration` accepts only evidence from a recorded run whose
 * configuration snapshot matches that declaration. Evidence naming no run, or a run with no
 * snapshot, has no declared-configuration fingerprint and is refused as missing; a run whose
 * snapshot projects onto different values is refused as a mismatch. A matched binding is
 * stamped so currentness can tell a configuration-checked proof from one that predates the
 * declaration. Clauses with no source BAR, and BARs that declare nothing, are untouched.
 */
export async function declaredConfigurationBindCheck(
  binding: z.infer<typeof bindingSchema>,
  scope: { planSlug: string; harnessSlug: string | undefined },
  deps: DeclaredConfigurationBindDeps,
): Promise<DeclaredConfigurationBindCheck> {
  if (!binding.specId) return { kind: 'undeclared' };
  const [clause] = await deps.loadClauses({
    harnessSlug: scope.harnessSlug,
    planSlug: scope.planSlug,
    specIds: [binding.specId],
    ...(binding.specRevision !== undefined ? { revision: binding.specRevision } : {}),
    limit: 1,
  });
  if (!clause?.sourceBar) return { kind: 'undeclared' };
  const criterion = await deps.loadCriterion(clause.sourceBar);
  const declared = parseProductionConfiguration(criterion?.productionConfiguration);
  if (!declared) return { kind: 'undeclared' };
  const label = `${clause.specId}@${clause.revision}`;
  const testRunId = binding.testRunId ?? null;
  const snapshot = testRunId === null ? null : readConfigurationSnapshot(await deps.readSnapshot(testRunId));
  const verdict = judgeDeclaredConfiguration(declared, snapshot);
  if (verdict.ok) {
    return {
      kind: 'matched',
      stamp: { required: true, testRunId: testRunId!, declaredFingerprint: verdict.declaredFingerprint, fingerprint: verdict.fingerprint },
    };
  }
  const noRun = testRunId === null ? ' This binding names no testRunId: bind it with { fromTestRun: <id> }.' : '';
  return {
    kind: 'refused',
    refusal: {
      error: verdict.code,
      clause: label,
      testRunId,
      declaredFingerprint: verdict.declaredFingerprint,
      fingerprint: verdict.fingerprint,
      differing: verdict.differing,
      message: `${label}: ${verdict.message}${noRun}`,
    },
  };
}

const OK = new Set(['created', 'unchanged']);

/** Preserve write outcomes even when a later advisory or parent deadline fails. */
export function bindingStageDiagnostics(
  publish: (metadata: Record<string, unknown>) => void,
  now: () => number = Date.now,
) {
  const startedAt = now();
  const phaseMs: Record<string, number> = {};
  const active: Record<string, number> = {};
  const storedBindingIds = new Set<number>();
  const snapshot = () => ({
    schemaVersion: 'plans-bind-spec-evidence-stage-timings-v1',
    totalMs: Math.max(0, now() - startedAt),
    phaseMs: { ...phaseMs },
    active: { ...active },
    storedBindingIds: [...storedBindingIds],
  });
  const emit = () => {
    // Diagnostics must never turn a committed binding into a failed response.
    try { publish({ plansBindSpecEvidenceStageTimings: snapshot() }); } catch { /* diagnostic only */ }
  };
  return {
    snapshot,
    emit,
    stored(result: { status: string; id?: number }) {
      if (OK.has(result.status) && typeof result.id === 'number') storedBindingIds.add(result.id);
      emit();
    },
    async phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const start = now();
      active[name] = (active[name] ?? 0) + 1;
      emit();
      try { return await operation(); }
      finally {
        phaseMs[name] = (phaseMs[name] ?? 0) + Math.max(0, now() - start);
        if (--active[name] === 0) delete active[name];
        emit();
      }
    },
  };
}

/**
 * The attestation advisories are a READ after the write has committed; a failure to compute
 * one must never turn a successful bind/retract into an error. It degrades to a visible
 * "could not check" advisory instead of silence, so an absent warning still means "checked".
 */
async function attestationAdvisorySafely(
  compute: () => Promise<AttestationAdvisory | null>,
): Promise<AttestationAdvisory | { code: 'adequacy_attestation_unchecked'; message: string } | null> {
  try {
    return await compute();
  } catch (error) {
    return {
      code: 'adequacy_attestation_unchecked',
      message: `Could not check whether this call dropped design attestations (EI-24903278232142036): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * A late return from this writer may already have committed several evidence rows
 * (or retracted rows) before dispatch notices its deadline. Identify those durable
 * row IDs so the caller can reconcile the completed batch instead of retrying it
 * blindly. Missing IDs fail closed because a bulk failure can occur after an
 * earlier row in the same handler has committed.
 */
function bindSpecEvidenceAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
  context: AbortCompletionContext,
): AbortCompletionReceipt {
  if (context.toolName !== 'plans:bind-spec-evidence' || !context.callId.trim()) {
    return {
      status: 'recovery-incomplete',
      reason: 'plans:bind-spec-evidence receipt did not receive the dispatch attempt identity',
      failures: ['missing-attempt-identity'],
    };
  }
  const payload = completedResultPayload(result);
  const rows = Array.isArray(payload?.results) ? payload.results : null;
  if (!payload || !rows) {
    return {
      status: 'recovery-incomplete',
      reason: 'plans:bind-spec-evidence result did not contain a parseable bulk completion payload',
      failures: ['missing-bulk-result'],
    };
  }

  const requested = asRecord(args);
  const retractionRequested = Array.isArray(requested?.retract);
  const retractedIds = retractionRequested
    ? rows.flatMap((value) => {
        const row = asRecord(value);
        const id = row?.bindingId;
        return row?.ok === true &&
          (row.status === 'retracted' || row.status === 'already_retracted') &&
          typeof id === 'number' &&
          Number.isSafeInteger(id) &&
          id > 0
          ? [id]
          : [];
      })
    : Array.isArray(payload.supersession)
      ? payload.supersession.flatMap((value) => {
          const outcome = asRecord(value);
          if (outcome?.status !== 'superseded' || !Array.isArray(outcome.retracted)) return [];
          return outcome.retracted.flatMap((entry) => {
            const row = asRecord(entry);
            const id = row?.bindingId;
            return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? [id] : [];
          });
        })
      : [];
  const bindingIds = retractionRequested
    ? []
    : rows.flatMap((value) => {
        const row = asRecord(value);
        const id = row?.id;
        return row?.ok === true &&
          typeof id === 'number' &&
          Number.isSafeInteger(id) &&
          id > 0
          ? [id]
          : [];
      });
  const uniqueBindingIds = [...new Set(bindingIds)].sort((a, b) => a - b);
  const uniqueRetractedIds = [...new Set(retractedIds)].sort((a, b) => a - b);
  if (uniqueBindingIds.length === 0 && uniqueRetractedIds.length === 0) {
    return {
      status: 'recovery-incomplete',
      reason: 'plans:bind-spec-evidence result did not prove a durable binding or retraction ID',
      failures: ['missing-landed-evidence-id'],
    };
  }

  return {
    status: 'recorded',
    effectRef:
      'plans-spec-evidence:' + context.callId +
      (uniqueBindingIds.length > 0 ? ':bindings:' + uniqueBindingIds.join(',') : '') +
      (uniqueRetractedIds.length > 0 ? ':retracted:' + uniqueRetractedIds.join(',') : ''),
    diagnostics: {
      bindingIds: uniqueBindingIds,
      retractedIds: uniqueRetractedIds,
    },
  };
}

export default defineTool({
  name: 'plans:bind-spec-evidence',
  description:
    'For { fromTestRun }, omit canonicalTestPath for local/Playwright rows (the recorded path is used); provide it only for a cargo test\'s defining .rs file or a mutation-probe copy-out run whose temporary mirror is unavailable. Before the first bind, supply fixturePaths or fixtureGlobs when calibration is needed, including the test file for inline fixtures; fixtures are not derived. A missing recipe leaves calibration unknown, and adding it to an already-bound run is refused. details.adequacy.fixtureCalibrated=true requires these paths; fixtureFree=true is not independent proof of fixture absence. Bind tests, fixtures, coverage-census rows, mutations/counterexamples, checks, manual proof, or operational evidence to an exact immutable spec revision and work item. Repository-backed evidence may pass measurement so the server hashes and later re-measures bounded source/test file sets; opaque evidence passes sourceFingerprint and remains caller-attested. Legacy coversVALs are accepted as sourceValId aliases. Exact replays are idempotent; changed fingerprints append history. The retract op withdraws a bound row by id with a required reason — stamped, never deleted, and excluded from default reads.',
  guidance: {
    when: `Recording execution proof for one or more plan specs before work-item completion or plan acceptance. AUTO-BAR proof: vet first (${VET_BEFORE_PROOF_ORDER}).`,
    notWhen: 'Authoring behavior — plans:set-specs. Running a test — testing:run.',
    chaining: 'plans:get-specs → plans:bind-spec-evidence → plans:get-spec-evidence with current fingerprints.',
    seeAlso: ['plans:get-spec-evidence (inspect proof/currentness)', 'plans:get-specs (resolve exact revisions)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  abortCompletionReceipt: bindSpecEvidenceAbortCompletionReceipt,
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const timing = bindingStageDiagnostics((metadata) => ctx.metadata?.(metadata));
    try {
      const sctx = harnessScopedCtx(args.harness, ctx);
      const harnessSlug = resolveEffectiveHarnessSlug(sctx);
      const actorId = resolveAgentIdentity(ctx).ownerId;
      const retract = args.retract;
      if (retract) {
        const retractions = await timing.phase('retract', () =>
          runBulk(
            retract,
            async (item) => {
              const result = await retractSpecEvidence({
                harnessSlug,
                bindingId: item.bindingId,
                reason: item.reason,
                actorId,
              });
              // already_retracted is a SUCCESS: the repair is idempotent, so replaying it
              // must not read as a failure. Only a binding that does not exist in this
              // scope is an error — that means the caller targeted the wrong row.
              return result.status === 'not_found'
                ? { ok: false as const, error: 'not_found' as const, ...result }
                : { ok: true as const, ...result };
            },
            { keyOf: (item) => ({ bindingId: item.bindingId }) },
          ),
        );
        // EI-24903278232142036: name any design attestation this retraction removed from its
        // clause's LAST live carrier — the silent pass→unknown flip a freshness repair causes.
        const lost = await timing.phase('retractionAdvisory', () =>
          attestationAdvisorySafely(() =>
            retractionAttestationAdvisory(
              harnessSlug,
              retractions.results.flatMap((result) =>
                result.ok && result.status === 'retracted' && result.binding
                  ? [
                      {
                        id: Number(result.binding.id),
                        planSlug: result.binding.plan_slug,
                        specId: result.binding.spec_id,
                        specRevision: Number(result.binding.spec_revision),
                      },
                    ]
                  : [],
              ),
            ),
          ),
        );
        return bulkContent({ ...retractions, ...(lost ? { advisories: [lost] } : {}) });
      }
      return bulkContent(
        await bindSpecEvidenceItems(
          {
            harnessSlug,
            actorId,
            workspaceId: resolveAgentIdentity(ctx).workspaceId ?? undefined,
            items: args.items ?? [args.binding!],
            ...(args.slug ? { slug: args.slug } : {}),
            ...(args.harness ? { harnessArg: args.harness } : {}),
            ...(args.dependencies ? { dependencies: args.dependencies } : {}),
            ...(args.supersedeAtRevision ? { supersedeAtRevision: true } : {}),
          },
          timing,
        ),
      );
    } finally {
      timing.emit();
    }
  },
});

type BindSpecEvidenceArgs = z.infer<typeof argsSchema>;

export interface BindSpecEvidenceItemsInput {
  harnessSlug: string;
  /** Who the binding is attributed to — an agent owner id, or a `system:` actor for a sweep. */
  actorId: string;
  /** The caller's concrete workspace, used only for the vet-before-proof advisory. */
  workspaceId?: string;
  items: NonNullable<BindSpecEvidenceArgs['items']>;
  slug?: string;
  /** The caller's literal `harness` argument, echoed into targeting refusals. */
  harnessArg?: string;
  dependencies?: BindSpecEvidenceArgs['dependencies'];
  supersedeAtRevision?: boolean;
}

/**
 * The binding pipeline behind `plans:bind-spec-evidence` (everything except `retract`), callable
 * without a tool context so a server-side sweep binds through EXACTLY the checks an agent call
 * runs: run expansion, mutation targeting, declared configuration, instrument provenance,
 * measurement and the supersession of replaced rows (agent-paperwork-and-restart-tax-reduction-
 * 2026-10-15 P-002 — the evidence autobind sweep is its first non-tool caller).
 */
export async function bindSpecEvidenceItems(
  input: BindSpecEvidenceItemsInput,
  timing: ReturnType<typeof bindingStageDiagnostics> = bindingStageDiagnostics(() => {}),
) {
      const { harnessSlug, actorId } = input;
      const args = {
        slug: input.slug,
        harness: input.harnessArg,
        dependencies: input.dependencies,
        supersedeAtRevision: input.supersedeAtRevision,
      };
      const requested = input.items;
      // P-044: expand every `{ fromTestRun }` item into an ordinary binding FIRST, then re-validate
      // it through bindingSchema, so a derived binding meets exactly the contract a hand-built one
      // does (including the P-043 targeting check below). A failed expansion stays index-aligned
      // and is reported in the bulk envelope like any other refused item.
      const runScope = requested.some(isTestRunBinding)
        ? await timing.phase('resolveRunScope', () => resolvePlanScope({ harnessSlug }))
        : null;
      const resolved: ResolvedBinding[] = await timing.phase('expandTestRuns', () =>
        Promise.all(
          requested.map(async (item): Promise<ResolvedBinding> => {
            if (!isTestRunBinding(item)) return { ok: true, binding: item };
            const expansion = await expandTestRunBinding(item, runScope!);
            if (!expansion.ok) return expansion;
            const parsed = parseDerivedBinding(expansion.binding, item.fromTestRun);
            if (!parsed.ok) return parsed;
            const asCommitted = asCommittedRunOf(expansion.binding.details);
            return {
              ok: true,
              binding: parsed.binding,
              correctionInput: item,
              ...(asCommitted ? { asCommitted } : {}),
              derived: {
                testRunId: expansion.binding.testRunId,
                evidenceKind: expansion.binding.evidenceKind,
                evidenceRef: expansion.binding.evidenceRef,
                measurement: expansion.binding.measurement,
                harnessAttribution: expansion.attribution,
              },
            };
          }),
        ),
      );
      const bindings = resolved.map((entry) => (entry.ok ? entry.binding : undefined));
      const measurementScope = bindings.some((binding) => binding?.measurement)
        ? await timing.phase('resolveMeasurementScope', () => resolvePlanScope({ harnessSlug }))
        : null;
      // P-022 / D-018: report the scope the binding ACTUALLY landed in, not the argument the
      // caller passed. An omitted `slug` resolves to the ad-hoc scope inside the store, and a
      // result echoing `slug: undefined` would hide which scope now owns the evidence.
      const reportedSlug = args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE;
      let instrumentDepsMemo: InstrumentProvenanceDeps | undefined;
      const instrumentDeps = () =>
        (instrumentDepsMemo ??=
          bindSpecEvidenceTestSeams.instrumentDeps?.(harnessSlug) ??
          defaultInstrumentProvenanceDeps(
            async () => (measurementScope ?? (await resolvePlanScope({ harnessSlug }))).workspaceId,
            harnessSlug,
          ));
      let declaredConfigurationDepsMemo: DeclaredConfigurationBindDeps | undefined;
      const declaredConfigurationDeps = () =>
        (declaredConfigurationDepsMemo ??=
          bindSpecEvidenceTestSeams.declaredConfigurationDeps?.(harnessSlug) ??
          defaultDeclaredConfigurationDeps(
            async () => (measurementScope ?? (await resolvePlanScope({ harnessSlug }))).workspaceId,
          ));
      const env = await timing.phase('bindRows', () =>
        runBulk(
          resolved,
          async (entry) => {
            if (!entry.ok) {
              const { error, testRunId, message } = entry;
              return { ok: false as const, slug: reportedSlug, error, fromTestRun: testRunId, message };
            }
            let { binding: requested } = entry;
            const derived = entry.derived ? { derivedFromTestRun: entry.derived } : {};
            let dependencies: Awaited<ReturnType<typeof captureCodeDependencies>> | undefined;
            if (args.dependencies) {
              if (requested.measurement?.kind !== 'repo-files') {
                return { ok: false as const, slug: reportedSlug, error: 'derived_binding_invalid' satisfies BindSpecEvidenceRefusalCode,
                  message: 'Compiler dependencies require a repo-files measurement from the recorded test run.', ...derived };
              }
              const dependencyMeasurement = requested.measurement;
              dependencies = await timing.phase('captureCodeDependencies', async () => {
                const root = await resolveMeasurementRoot(measurementScope!.workspaceId, harnessSlug, dependencyMeasurement);
                return captureCodeDependencies(root, dependencyMeasurement, args.dependencies!);
              });
              requested = { ...requested, measurement: dependencies.measurement,
                details: { ...(requested.details ?? {}), codeDependencies: dependencies.evidence } };
            }
            const targetingRefusal = await timing.phase('mutationTargeting', () =>
              mutationTargetingRefusal(requested, {
                planSlug: args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE,
                harnessSlug,
                ...(args.slug ? { slugArg: args.slug } : {}),
                ...(args.harness ? { harnessArg: args.harness } : {}),
              }, undefined, entry.correctionInput),
            );
            if (targetingRefusal) {
              return {
                ok: false as const,
                slug: reportedSlug,
                error: 'mutation_target_rejected' as const satisfies BindSpecEvidenceRefusalCode,
                ...derived,
                ...targetingRefusal,
              };
            }
            // P-011: a BAR that declares its production configuration accepts only a run whose
            // recorded snapshot matches it. A match is stamped into details for currentness.
            const configuration = await timing.phase('declaredConfiguration', () =>
              declaredConfigurationBindCheck(
                requested,
                { planSlug: args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE, harnessSlug },
                declaredConfigurationDeps(),
              ),
            );
            if (configuration.kind === 'refused') {
              return { ok: false as const, slug: reportedSlug, ...derived, ...configuration.refusal };
            }
            const binding =
              configuration.kind === 'matched'
                ? { ...requested, details: { ...(requested.details ?? {}), declaredConfiguration: configuration.stamp } }
                : requested;
            // P-010 (verification-system-improvements-2026-10-10): measurement-kind evidence must
            // name a committed, tested instrument or declare it used none. BIND TIME ONLY — the
            // store and every re-measure path never call this, so pre-rule rows are not re-judged.
            const provenance = INSTRUMENT_EVIDENCE_KINDS.has(binding.evidenceKind)
              ? await timing.phase('instrumentProvenance', () =>
                  instrumentProvenanceRefusal(binding, entry.asCommitted, instrumentDeps()),
                )
              : null;
            if (provenance) {
              return { ok: false as const, slug: reportedSlug, ...derived, ...provenance };
            }
            const { measurement, ...declared } = binding;
            const measured = !measurement
              ? null
              : await timing.phase('measureAndPin', () =>
                  measureBindingForStore(measurementScope!.workspaceId, harnessSlug, measurement, entry.asCommitted),
                );
            if (dependencies) assertCodeDependencyVersions(dependencies.evidence.sources, measured?.pin);
            const result = await timing.phase('storeBinding', () =>
              bindSpecEvidence({
                ...declared,
                sourceFingerprint: measured?.sourceFingerprint ?? binding.sourceFingerprint!,
                ...(measured ? { testFingerprint: measured.testFingerprint } : {}),
                ...(measured?.fixtureFingerprint !== undefined
                  ? { fixtureFingerprint: measured.fixtureFingerprint }
                  : {}),
                ...(measured?.environmentFingerprint !== undefined
                  ? { environmentFingerprint: measured.environmentFingerprint }
                  : {}),
                ...(measurement
                  ? {
                      details: {
                        ...(binding.details ?? {}),
                        currentMeasurement: measurement,
                        // P-018: the commit this proof was measured against, so a later stale
                        // verdict names the moved paths. Excluded from the binding fingerprint.
                        ...(measured?.pin ? { [MEASUREMENT_PIN_DETAILS_KEY]: measured.pin } : {}),
                      },
                    }
                  : {}),
                ...(args.slug ? { planSlug: args.slug } : {}),
                harnessSlug,
                actorId,
              }),
            );
            timing.stored(result);
            return OK.has(result.status)
              ? { ok: true as const, slug: reportedSlug, ...derived, ...result }
              : { ok: false as const, slug: reportedSlug, error: result.status, ...derived, ...result };
          },
          {
            keyOf: (entry) =>
              entry.ok
                ? { slug: reportedSlug, workItemId: entry.binding.workItemId, evidenceRef: entry.binding.evidenceRef }
                : { slug: reportedSlug, fromTestRun: entry.testRunId },
          },
        ),
      );
      // P-004 (review-system-rework-reduction-2026-09-23): vet before proof. Advisory only —
      // the bindings above are already written; this names the cheaper order when BAR proof
      // lands on a rubric revision nobody has vetted yet. Computed only for bindings that
      // actually succeeded, so a refused binding never triggers it.
      const boundSpecIds = env.results.flatMap((result, index) => (result.ok ? [bindings[index]?.specId] : []));
      const workspaceId = input.workspaceId;
      const advisory = await timing.phase('vettingAdvisory', () =>
        runWithWorkspaceIfConcrete(workspaceId, () =>
          unvettedRubricBindAdvisory(
            { planSlug: args.slug, harnessSlug, specIds: boundSpecIds },
            {
              getAcceptanceRubricsForPlan: (planSlug, options) => getAcceptanceRubricsForPlan(planSlug, options),
              readVettingStatus: (rubric) => getAcceptanceRubricVettingStatus(rubric, { listScorecards }),
            },
          ),
        ),
      );
      // EI-24903278232142036: computed BEFORE supersession, while the siblings that still carry
      // the attestations are live — supersession would retract them and hide the gap.
      const gap = await timing.phase('attestationAdvisory', () =>
        attestationAdvisorySafely(() =>
          rebindAttestationAdvisory(
            harnessSlug,
            env.results.flatMap((result, index) => {
              const binding = bindings[index];
              if (!result.ok || !binding || typeof (result as { id?: unknown }).id !== 'number') return [];
              const stored = result as unknown as {
                id: number;
                planSlug: string;
                specId: string;
                specRevision: number;
              };
              return [
                {
                  id: stored.id,
                  planSlug: stored.planSlug,
                  specId: stored.specId,
                  specRevision: stored.specRevision,
                  evidenceKind: binding.evidenceKind,
                  evidenceRef: binding.evidenceRef,
                  adequacy: (binding.details as { adequacy?: unknown } | undefined)?.adequacy,
                },
              ];
            }),
          ),
        ),
      );
      const supersession = args.supersedeAtRevision
        ? await timing.phase('supersedeSiblings', () =>
            supersedeSiblings({ bindings, results: env.results, harnessSlug, actorId }),
          )
        : undefined;
      const advisories = [advisory, gap].filter(Boolean);
      return {
        ...env,
        ...(advisories.length > 0 ? { advisories } : {}),
        ...(supersession ? { supersession } : {}),
      };
}
