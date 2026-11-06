/** plans:set-specs — optimistic-CAS append of canonical plan spec revisions. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import type { AbortCompletionContext, AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolveAgentIdentity } from '../coordination/identity';
import { asRecord, completedResultPayload } from '../abort-completion-payload';
import { bulkContent, runBulk } from '../_bulk';
import { ADHOC_WORK_ITEM_SPEC_SCOPE } from './adhoc-spec-scope';
import {
  listSpecClauses,
  setSpecClause,
  specWriteSchema,
} from './spec-clauses-store';
import { verifyPlanAcceptanceRef } from './spec-clause-compiler';
import { getPlanRevisionSnapshot } from './revisions';

// RSR-P-008-A: the spec/items rule is reported alongside any shape defect.
const argsSchema = refineEvenWithShapeIssues(
  z.object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plan slug owning every supplied clause. Omit only for a single ad-hoc work-item clause; ' +
          'bulk `items` calls must name their plan so they cannot fall back to the harness-wide ad-hoc scope.',
      ),
    spec: specWriteSchema.optional().describe('Single-clause shorthand (n=1 of the bulk call).'),
    // P-007's dual-arity seam, spelled the way every sibling bulk verb spells it
    // (plans:add-item / add-decision / audit / get-item …): the heterogeneous
    // "many" half is `items: z.array(…)`. It was `specs:` for the first hour of
    // this tool's life, which is a fourth spelling of a contract that already had
    // three, and bulk-contract-sync's seam detector — the guard that keeps
    // "one call is n=1 of the bulk call" true across ~60 verbs — correctly did
    // not recognise it. Conforming is the fix; widening the detector per tool is
    // how a contract stops being one.
    items: z
      .array(specWriteSchema)
      .min(1)
      .max(200)
      .optional()
      .describe('Append several clause revisions at once — each a full spec write.'),
  }),
  (args, ctx) => {
    if (Boolean(args.spec) === Boolean(args.items)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'pass exactly one of `spec` or `items`' });
      return;
    }
    if (args.items && !args.slug) {
      ctx.addIssue({
        code: 'custom',
        path: ['slug'],
        message: 'bulk `items` requires `slug`; omit `slug` only for a single ad-hoc `spec`',
      });
    }
  },
);

const OK = new Set(['created', 'revised', 'unchanged']);

/**
 * Clause identities are independent, so a bulk write may use a small worker pool. Four
 * matches the other bounded plan reads/writes and keeps the per-item transactions finite;
 * clause amendment propagation sorts its row locks before any worker can overlap them.
 */
export const SET_SPECS_MAX_CONCURRENCY = 4;

/**
 * A late plans:set-specs return may have committed one or more independent clause revisions
 * before dispatch noticed its deadline. Name every successful revision from the returned
 * envelope so the caller can reconcile the attempt instead of replaying it blindly.
 */
export function setSpecsAbortCompletionReceipt(
  _args: unknown,
  result: ToolResult,
  context: AbortCompletionContext,
): AbortCompletionReceipt {
  if (context.toolName !== 'plans:set-specs' || !context.callId.trim()) {
    return {
      status: 'recovery-incomplete',
      reason: 'plans:set-specs receipt did not receive the dispatch attempt identity',
      failures: ['missing-attempt-identity'],
    };
  }

  const payload = completedResultPayload(result);
  const rows = Array.isArray(payload?.results) ? payload.results : null;
  if (!payload || !rows) {
    return {
      status: 'recovery-incomplete',
      reason: 'plans:set-specs result did not contain a parseable bulk completion payload',
      failures: ['missing-bulk-result'],
    };
  }

  const revisions = rows.flatMap((value) => {
    const row = asRecord(value);
    const specId = typeof row?.specId === 'string' ? row.specId.trim() : '';
    const revision = row?.revision;
    const status = typeof row?.status === 'string' ? row.status : '';
    return row?.ok === true && specId && Number.isSafeInteger(revision) && Number(revision) > 0 && OK.has(status)
      ? [{ specId, revision: Number(revision), status }]
      : [];
  });
  if (revisions.length > 0) {
    const ordered = [...revisions].sort((a, b) => a.specId.localeCompare(b.specId) || a.revision - b.revision);
    return {
      status: 'recorded',
      effectRef: `plans-set-specs:${context.callId}:revisions:${ordered.map((row) => `${row.specId}@${row.revision}`).join(',')}`,
      diagnostics: { revisions: ordered },
    };
  }

  const counts = asRecord(payload.counts);
  if (
    payload.ok === false &&
    counts &&
    counts.ok === 0 &&
    Number.isSafeInteger(counts.failed) &&
    Number(counts.failed) === rows.length
  ) {
    return {
      status: 'not-recorded',
      reason: 'plans:set-specs completed without a successful clause revision',
      diagnostics: { counts },
    };
  }

  return {
    status: 'recovery-incomplete',
    reason: 'plans:set-specs result did not prove a durable clause revision',
    failures: ['missing-landed-spec-revision'],
  };
}

export default defineTool({
  name: 'plans:set-specs',
  description:
    'Create or append immutable first-class plan spec revisions under expectedRevision CAS. Preserves an optional source VAL alias, verifies plan/item ownership and supersession targets, and refreshes the legacy VAL projection without overwriting its test verdict. Behavior on a sourceBar-pinned acceptance projection is read-only; amend its canonical rubric criterion with rubrics:amend.',
  guidance: {
    when: 'Authoring or revising atomic observable behavior owned by a P-NNN plan item. Use expectedRevision:0 to create; otherwise pass the current revision returned by plans:get-specs.',
    notWhen:
      'Changing a plan-item outcome or dependency — plans:* item verbs. Recording test evidence — testing/coverage tools. Changing the behavior of a sourceBar-pinned AUTO-BAR projection — amend the canonical rubric with rubrics:amend.',
    chaining: 'plans:get-specs → plans:set-specs { expectedRevision } → plans:get-specs exact/history to verify. Author the requirement verification.check.files with exact maintained tests for automatic ledger reconciliation; specIds/revisions and explicit item/code anchors establish ownership, never symbol-name similarity. Bind the first exact test run with sourcePaths and fixturePaths so later autobind can retain its measured recipe.',
    seeAlso: ['plans:get-specs (current/exact/history read)', 'plans:get-item (owning outcome)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  abortCompletionReceipt: setSpecsAbortCompletionReceipt,
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const actorId = resolveAgentIdentity(ctx).ownerId;
    const specs = args.items ?? [args.spec!];
    // P-022 / D-018: report the scope the clause ACTUALLY landed in. An omitted `slug`
    // resolves to the ad-hoc scope inside the store, and echoing `slug: undefined` would
    // hide which scope now owns the clause.
    const reportedSlug = args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE;
    const currentClauses = args.slug
      ? await listSpecClauses({
          harnessSlug,
          planSlug: args.slug,
          specIds: specs.map((spec) => spec.specId),
        })
      : [];
    const currentById = new Map(currentClauses.map((clause) => [clause.specId, clause]));
    const env = await runBulk(
      specs,
      async (spec) => {
        const current = currentById.get(spec.specId);
        if (
          current &&
          current.currentRevision === spec.expectedRevision &&
          current.sourceBar &&
          current.behavior !== spec.behavior.trim() &&
          spec.lifecycleStatus !== 'superseded' &&
          spec.lifecycleStatus !== 'retired'
        ) {
          return {
            ok: false as const,
            slug: reportedSlug,
            error: 'projected_behavior_readonly',
            specId: spec.specId,
            reason:
              `${spec.specId} behavior is projected from rubric ${current.sourceBar.rubricSlug} BAR ${current.sourceBar.barKey}. ` +
              'Amend the canonical criterion.model/acceptance condition with rubrics:amend; plans:set-specs cannot persist edits to projected behavior.',
          };
        }
        const acceptanceRefCheck = await verifyPlanAcceptanceRef(
          spec.acceptanceRef,
          spec.planItemId,
          async (planSlug, revision) =>
            (await getPlanRevisionSnapshot(planSlug, revision, { harnessSlug })) !== null,
          harnessSlug,
        );
        if (!acceptanceRefCheck.ok) {
          return {
            ok: false as const,
            slug: reportedSlug,
            error: acceptanceRefCheck.code,
            specId: spec.specId,
            reason: acceptanceRefCheck.reason,
            repairHint:
              'Use an existing positive plan revision and make the #P-NNN suffix exactly match planItemId.',
          };
        }
        const result = await setSpecClause({
          ...spec,
          ...(args.slug ? { planSlug: args.slug } : {}),
          harnessSlug,
          actorId,
        });
        return OK.has(result.status)
          ? { ok: true as const, slug: reportedSlug, ...result }
          : { ok: false as const, slug: reportedSlug, error: result.status, ...result };
      },
      {
        keyOf: (spec) => ({ slug: reportedSlug, specId: spec.specId }),
        maxConcurrency: SET_SPECS_MAX_CONCURRENCY,
      },
    );
    return bulkContent(env);
  },
});
