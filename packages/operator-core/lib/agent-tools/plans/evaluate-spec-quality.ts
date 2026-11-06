/** plans:evaluate-spec-quality — exact current plan-spec quality scorecard draft. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts, resolveEffectiveHarnessSlug } from './_ctx-opts';
import { readPlanBySlug } from './source';
import { listSpecClauses } from './spec-clauses-store';
import { evaluatePlanSpecQuality, specQualityPlanItemIds } from './spec-quality';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { evaluatePlanStartReadiness } from './plan-input-validation';
import { resolvePersistedClassRef } from './plan-spec-quality-gate';
import { getAcceptanceRubricsForPlan } from '../../rubrics';
import { getPlanRevisionSnapshot } from './revisions';
import { parsePlan } from './parser';
import { withCurrentDiscovery } from '../../plan-audits';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { getBuildInfo } from '../../build-info';
import { SPEC_SET_HASH_VERSION } from './spec-clause-compiler';
import { specQualityEvaluatorBuildSchema, specQualityIdentityRefusal } from './spec-quality-identity';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  evaluatorBuild: specQualityEvaluatorBuildSchema.optional(),
  specSetHashVersion: z.number().int().positive().optional(),
  expectedSpecSetHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe(
    'Optional fail-closed replay guard. When supplied, the current clauses must hash to this exact value; a mismatch returns ok:false with a blocker and no scorecard draft.',
  ),
  classRef: z.enum(PLAN_CLASS_RUBRIC_REFS).optional().describe(
    'Optional assertion against the authoritative persisted acceptance-rubric class. Omit to derive it; a mismatch is refused, never used as an override.',
  ),
  replaySnapshot: z.object({
    planContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    clausesAsOf: z.string().datetime({ offset: true }),
  }).strict().optional().describe('Historical audit only: replay the saved plan body and latest immutable clause revisions at this cutoff. Requires classRef and expectedSpecSetHash; never substitutes for the live activation gate.'),
}).refine((args) => !args.replaySnapshot || Boolean(args.classRef && args.expectedSpecSetHash), {
  message: 'replaySnapshot requires classRef and expectedSpecSetHash', path: ['replaySnapshot'],
});

export default defineTool({
  name: 'plans:evaluate-spec-quality',
  description:
    "Preflight plan inputs, persisted acceptance class and first-class clauses together, then grade the exact spec set. Missing/invalid/unknown prerequisites return all discoverable blockers without a scorecard draft. A valid call derives class and exact fingerprint from the stores; read-only. For enforcement-eligible plans, the returned draft starts a four-step activation chain: evaluate → emit the terminal scorecard → settle its independent grading-integrity audit → plans:start.",
  guidance: {
    when:
      'Before plans:start or direct item promotion for a plan that has adopted first-class spec clauses. The terminal standard-rubric card emitted from this result remains audit-pending until a NON-AUTHOR reviewer emits its grading-integrity audit.',
    notWhen:
      'Authoring clauses — use plans:set-specs. Grading implementation proof — use plans:evaluate-spec-test-adequacy.',
    returns:
      "{ok, slug, harnessSlug, blockers, wouldBlock, verdict, scorecardDraft} — a prerequisite failure returns `ok:false` with the full `blockers` set and no draft; a graded call returns `ok:true` with the spec-quality result spread in. A valid result includes `scorecardDraft`, but that draft is not the final start prerequisite by itself. Complete this sequence: (1) repair every returned blocker and re-run this evaluator, (2) pass the exact draft to `scorecards:emit` with `terminal:true`, (3) let `scorecards:emit` automatically route the independent non-author `gradingAudit` reviewer, using `scorecards:repair` if routing stalls, then (4) confirm the audit is settled with `scorecards:list` and call `plans:start`. Never recruit the auditor yourself; the router enforces author and lineage separation.",
    chaining:
      "plans:evaluate-spec-quality { slug } → repair all prerequisite blockers → scorecards:emit the returned draft with terminal:true → await the automatically routed NON-AUTHOR grading-integrity audit (scorecards:repair re-dispatches a stalled one; never pick the auditor yourself) →scorecards:list { rubricRef:'spec-quality', subjectRef:'<scorecardId>' } and confirm gradingAudit is settled → plans:start { slug }. References derive from exact clause semantics and persisted policy; substantive changes require fresh evidence.",
    seeAlso: ['plans:get-specs', 'scorecards:emit', 'rubrics:get spec-quality'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  // EI-21111131926207175: this tool authors `guidance.returns`, so it owes a
  // registered output schema — prose must not be the only statement of the
  // response shape. Both handler branches are declared here: the
  // prerequisite-failure branch (`ok:false`, `error`, `readiness`, `blockers`,
  // `unknownChecks`, `wouldBlock`) and the graded branch (`ok:true` plus the
  // spread `PlanSpecQualityResult`). Deep payloads stay `unknown` on purpose —
  // their shape is owned by evaluatePlanSpecQuality / evaluatePlanStartReadiness,
  // and restating it here would be a second copy that drifts.
  result: z
    .object({
      ok: z.boolean(),
      slug: z.string(),
      harnessSlug: z.string(),
      error: z.string().optional(),
      readiness: z.unknown().optional(),
      blockers: z.array(z.unknown()).optional(),
      unknownChecks: z.array(z.string()).optional(),
      wouldBlock: z.array(z.string()).optional(),
      planSlug: z.string().optional(),
      classRef: z.string().optional(),
      expectedSpecSetHash: z.string().optional(),
      specSetHash: z.string().optional(),
      clauseCount: z.number().optional(),
      planItemCount: z.number().optional(),
      ratings: z.unknown().optional(),
      verdict: z.string().optional(),
      details: z.unknown().optional(),
      scorecardDraft: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const identity = { evaluatorBuild: getBuildInfo(), specSetHashVersion: SPEC_SET_HASH_VERSION };
    const mismatch = specQualityIdentityRefusal(args, identity.evaluatorBuild);
    if (mismatch) return { data: {
      ok: false, ...mismatch, slug: args.slug, harnessSlug, ...identity,
      blockers: [{ check: 'clauses', state: 'blocked', ...mismatch }], wouldBlock: [mismatch.code],
    } };
    const opts = await ctxToPlanSourceOpts(sctx);
    const cutoff = args.replaySnapshot?.clausesAsOf ?? new Date().toISOString();
    const snapshotFailure = (code: string, message: string) => ({ data: {
      ok: false, error: code, slug: args.slug, harnessSlug,
      blockers: [{ check: 'clauses', state: 'unknown', code, message }], wouldBlock: [code],
    } });
    if (Date.parse(cutoff) > Date.now()) return snapshotFailure('spec_snapshot_future', 'A future cutoff cannot identify a completed snapshot.');
    const finish = (clauses: Awaited<ReturnType<typeof listSpecClauses>>, planItems: ReturnType<typeof parsePlan>['items'],
      classRef: typeof PLAN_CLASS_RUBRIC_REFS[number], replaySnapshot: NonNullable<typeof args.replaySnapshot>) => {
      const evaluation = evaluatePlanSpecQuality({
        planSlug: args.slug, harnessSlug, planItems, planItemIds: specQualityPlanItemIds(planItems),
        clauses, classRef, expectedSpecSetHash: args.expectedSpecSetHash, replaySnapshot,
      });
      if (args.expectedSpecSetHash && args.expectedSpecSetHash !== evaluation.specSetHash) {
        return { data: {
          ok: false, error: 'spec_set_hash_mismatch', slug: args.slug, harnessSlug,
          expectedSpecSetHash: args.expectedSpecSetHash, specSetHash: evaluation.specSetHash,
          blockers: [{ check: 'clauses', state: 'blocked', code: 'spec_set_hash_mismatch',
            message: `Expected specSetHash ${args.expectedSpecSetHash}, but the selected clauses hash to ${evaluation.specSetHash}; refusing a different clause set.` }],
          wouldBlock: ['spec_set_hash_mismatch'],
        } };
      }
      return { data: { ok: true, slug: args.slug, harnessSlug, replaySnapshot, ...identity, ...evaluation } };
    };
    if (args.replaySnapshot) {
      try {
        const [snapshot, clauses] = await Promise.all([
          getPlanRevisionSnapshot(args.slug, args.replaySnapshot.planContentHash, { ...opts, exactBody: true }),
          listSpecClauses({ harnessSlug, planSlug: args.slug, asOf: cutoff }),
        ]);
        if (!snapshot || snapshot.contentSnapshotHash !== args.replaySnapshot.planContentHash) {
          return snapshotFailure('plan_snapshot_unavailable', 'The exact immutable plan body is missing or its bytes do not match the recorded hash. No live fallback.');
        }
        if (!clauses.length) return snapshotFailure('spec_snapshot_unavailable', 'No clause revisions exist at the recorded cutoff.');
        return finish(clauses, parsePlan(snapshot.contentSnapshot).items, args.classRef!, args.replaySnapshot);
      } catch (error) {
        return snapshotFailure('spec_snapshot_read_unavailable', error instanceof Error ? error.message : String(error));
      }
    }
    const admitted = await withCurrentDiscovery({ workspaceId: sctx.workspaceId ?? activeWorkspaceId(),
      harnessSlug, planSlug: args.slug, createdBy: resolveAgentIdentity(sctx).ownerId }, async () => {
    // Discover independent failures together, before evaluation or producing a
    // draft. Promise callbacks also capture synchronous IO failures in adapters.
    const [planRead, clauseRead, rubricRead] = await Promise.allSettled([
      Promise.resolve().then(() => readPlanBySlug(args.slug, opts)),
      Promise.resolve().then(() => listSpecClauses({ harnessSlug, planSlug: args.slug })),
      Promise.resolve().then(() => getAcceptanceRubricsForPlan(args.slug, { harnessSlug, strict: true })),
    ]);
    const blockers: Array<{
      check: 'plan' | 'inputs' | 'class' | 'clauses';
      state: 'blocked' | 'unknown';
      code: string;
      message: string;
    }> = [];
    const unknown = (check: 'plan' | 'class' | 'clauses', reason: unknown) => {
      blockers.push({
        check, state: 'unknown', code: `${check}_read_unavailable`,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    };
    if (planRead.status === 'rejected') unknown('plan', planRead.reason);
    if (clauseRead.status === 'rejected') unknown('clauses', clauseRead.reason);
    if (rubricRead.status === 'rejected') unknown('class', rubricRead.reason);

    const read = planRead.status === 'fulfilled' ? planRead.value : null;
    if (planRead.status === 'fulfilled' && !read) {
      blockers.push({ check: 'plan', state: 'blocked', code: 'plan_not_found', message: `No plan '${args.slug}'.` });
    }
    const readiness = read ? evaluatePlanStartReadiness(read.row, read.row.templateData) : null;
    if (readiness && !readiness.ready) {
      blockers.push({ check: 'inputs', state: 'blocked', code: readiness.code, message: readiness.hint });
    }
    const classResolution = rubricRead.status === 'fulfilled'
      ? resolvePersistedClassRef(args.slug, rubricRead.value) : null;
    if (classResolution && !classResolution.ok) {
      blockers.push({ check: 'class', state: 'blocked', code: classResolution.code, message: classResolution.message });
    } else if (classResolution?.ok && args.classRef && args.classRef !== classResolution.classRef) {
      blockers.push({
        check: 'class', state: 'blocked', code: 'spec_quality_class_mismatch',
        message: `Caller asserted ${args.classRef}, but the persisted class is ${classResolution.classRef}. Re-read the policy; an assertion cannot override it.`,
      });
    }
    if (clauseRead.status === 'fulfilled' && clauseRead.value.length === 0) {
      blockers.push({
        check: 'clauses', state: 'blocked', code: 'no_first_class_spec_clauses',
        message: 'No first-class clauses to grade. Legacy start remains report-only; author clauses before requesting a spec-quality draft.',
      });
    }
    if (blockers.length || !read || !classResolution?.ok || clauseRead.status !== 'fulfilled') {
      return { data: {
        ok: false, error: 'plan_prerequisites_not_ready', slug: args.slug, harnessSlug,
        readiness, blockers, unknownChecks: blockers.filter((b) => b.state === 'unknown').map((b) => b.check),
        wouldBlock: blockers.map((b) => b.code),
      } };
    }
    try {
      const snapshot = await getPlanRevisionSnapshot(args.slug, read.row.contentHash, {
        ...opts, workspaceId: read.row.workspaceId, exactBody: true,
      });
      if (!snapshot || snapshot.contentSnapshotHash !== read.row.contentHash) {
        return snapshotFailure('plan_snapshot_unavailable', 'The current plan body has no exact immutable revision snapshot; repair its revision spine before grading.');
      }
      // Deterministic cutoff preserves retry identity. Acceptance is separately
      // timestamped from revision creation, so include both times in the snapshot.
      // Timestamp normalization rounds to milliseconds; include the whole last
      // millisecond, then verify reconstruction rather than assuming no concurrent write.
      const latest = Math.max(...clauseRead.value.flatMap((clause) => [
        Date.parse(clause.createdAt),
        ...(clause.acceptedAt ? [Date.parse(clause.acceptedAt)] : []),
      ]));
      if (!Number.isFinite(latest) || latest + 1 > Date.now()) {
        return snapshotFailure('spec_snapshot_cutoff_unavailable', 'Clause revision and acceptance times do not identify a completed snapshot.');
      }
      const clausesAsOf = new Date(latest + 1).toISOString();
      const reconstructed = await listSpecClauses({ harnessSlug, planSlug: args.slug, asOf: clausesAsOf });
      const historical = finish(reconstructed, parsePlan(snapshot.contentSnapshot).items, classResolution.classRef,
        { planContentHash: snapshot.contentSnapshotHash, clausesAsOf });
      const live = evaluatePlanSpecQuality({ planSlug: args.slug, harnessSlug,
        planItemIds: specQualityPlanItemIds(parsePlan(snapshot.contentSnapshot).items),
        planItems: parsePlan(snapshot.contentSnapshot).items, clauses: clauseRead.value, classRef: classResolution.classRef });
      if (!('specSetHash' in historical.data) || historical.data.specSetHash !== live.specSetHash) {
        if (args.expectedSpecSetHash && args.expectedSpecSetHash !== live.specSetHash) return historical;
        return snapshotFailure('spec_snapshot_changed', 'Historical reconstruction differs from the observed clause set. Retry after concurrent writes settle.');
      }
      return historical;
    } catch (error) {
      return snapshotFailure('spec_snapshot_read_unavailable', error instanceof Error ? error.message : String(error));
    }
    });
    return admitted.ok ? admitted.result : { data: { ...admitted, slug: args.slug, harnessSlug } };
  },
});
