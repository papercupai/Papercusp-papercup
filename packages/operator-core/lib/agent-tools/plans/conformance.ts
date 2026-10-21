/**
 * plans:conformance — the spec-conformance verbs that write plan authority.
 *
 * R-17 (spec-driven-tooling-integration-2026-10-05 P-028): a requirement that cannot
 * or should no longer be met is DEVIATED from, never silently ignored. `propose-deviation`
 * records the proposal; `approve-deviation` records the approval. Both are ordinary plan
 * Decisions carrying a reserved ```deviation fence (plans:add-decision and
 * plans:set-decision-body refuse it), so the conformance run, the closure guard and the
 * retro-fit report read one machine record. The transaction itself — authority from the
 * requirement's provenance, owner-turn verification, idempotence refusals — is the pure
 * core in ../../spec-conformance/deviation.ts; this file only supplies production deps.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { readPlanBySlug } from './source';
import { addDecisionOne } from './add-decision';
import { resolveAgentIdentity } from '../coordination/identity';
import { parseTurnRefs, verifyTurnRefs, type TurnRefVerdict } from '../../turn-provenance/turn-ref';
import { activeWorkspaceId } from '../../workspace-registry';
import { buildConformanceReport, loadConformanceReportPlans } from '../../spec-conformance/conformance-report';
import {
  approveDeviation,
  OWNER_TURN_VERDICT_SET,
  proposeDeviation,
  type AppendDecisionResult,
  type DeviationDeps,
  type OwnerTurnVerification,
} from '../../spec-conformance/deviation';

const PLAN_ITEM_REF = /^P-\d{3,}$/;

/**
 * Fold one turn-ref verdict into the deviation core's verification shape. Verified only
 * when the turn was FOUND, classified as the owner speaking, and any quote attached to the
 * ref actually appears in that turn (a resolvable ref with a spliced quote is EI-12890).
 */
export function ownerTurnVerificationFrom(verdict: TurnRefVerdict | undefined): OwnerTurnVerification {
  if (!verdict) return { verified: false, verdict: null, detail: 'the ref did not resolve to a recorded turn' };
  if (!verdict.found) {
    return {
      verified: false,
      verdict: null,
      detail: verdict.checked
        ? 'the cited session was searched and has no user turn at that timestamp'
        : 'the cited session could not be located, so the turn could not be checked',
    };
  }
  const verdictName = verdict.verdict ?? null;
  if (!verdictName || !OWNER_TURN_VERDICT_SET.has(verdictName)) {
    return { verified: false, verdict: verdictName, detail: `the turn is classified ${verdictName ?? 'unknown'}, not the owner speaking` };
  }
  if (verdict.quoteMatch === false) {
    return { verified: false, verdict: verdictName, detail: 'the quote attached to the ref does not appear in that turn' };
  }
  return { verified: true, verdict: verdictName, detail: `owner turn: ${(verdict.snippet ?? '').slice(0, 120)}` };
}

/** Exactly one `[turn:<session-prefix>@<iso-ts>]` anchor, verified across sessions. */
export async function verifyOwnerTurnRef(
  ownerId: string,
  ref: string,
  verify: typeof verifyTurnRefs = verifyTurnRefs,
): Promise<OwnerTurnVerification> {
  const refs = parseTurnRefs(ref);
  if (refs.length !== 1) {
    return {
      verified: false,
      verdict: null,
      detail:
        refs.length === 0
          ? 'ownerTurnRef must be a [turn:<session-prefix>@<iso-timestamp>] anchor'
          : 'ownerTurnRef must cite exactly one owner turn',
    };
  }
  const [verdict] = await verify(ownerId, refs, { scope: 'cross-session' });
  return ownerTurnVerificationFrom(verdict);
}

/** Map an addDecisionOne bulk result onto the core's append contract. */
export function appendResultFrom(result: Record<string, unknown>): AppendDecisionResult {
  if (result.ok === true && typeof result.decisionId === 'string' && typeof result.ref === 'string') {
    return { ok: true, decisionId: result.decisionId, ref: result.ref };
  }
  return {
    ok: false,
    error: typeof result.error === 'string' ? result.error : 'decision_write_failed',
    ...(typeof result.message === 'string' ? { message: result.message } : {}),
  };
}

function productionDeviationDeps(ctx: UnifiedToolContext, harness: string | undefined, ownerId: string): DeviationDeps {
  const sctx = harnessScopedCtx(harness, ctx);
  return {
    async readPlanContent(slug) {
      const read = await readPlanBySlug(slug, await ctxToPlanSourceOpts(sctx));
      return read ? read.row.content : null;
    },
    verifyOwnerTurn: (ref) => verifyOwnerTurnRef(ownerId, ref),
    async appendDecision(input) {
      const result = await addDecisionOne(
        {
          slug: input.slug,
          title: input.title,
          body: input.body,
          // Related: lines carry plan-item ids only; R-/D- refs live in the body + fence.
          refs: input.refs.filter((ref) => PLAN_ITEM_REF.test(ref)),
          ...(harness ? { harness } : {}),
          rationale: `plans:conformance ${input.title}`,
        },
        ctx,
        { allowDeviationFence: true },
      );
      return appendResultFrom(result as Record<string, unknown>);
    },
  };
}

const argsSchema = z.object({
  harness: harnessArg,
  op: z.enum(['propose-deviation', 'approve-deviation', 'report']),
  slug: z.string().min(1).optional().describe('Plan slug (deviation ops).'),
  requirement: z.string().regex(/^R-\d+$/, 'R-N form required').optional().describe('The requirement key under ## Requirements (deviation ops).'),
  statuses: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .optional()
    .describe("report: plan statuses to census (default ['active','ready'])."),
  reason: z.string().trim().min(1).max(2000).optional().describe('propose-deviation: why the requirement should not (or cannot) be met.'),
  proposal: z.string().regex(/^D-\d{3,}$/, 'D-NNN form required').optional().describe('approve-deviation: the proposal Decision being approved.'),
  ownerTurnRef: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe('approve-deviation on an owner-sourced requirement: the [turn:…] anchor of the owner turn approving it.'),
});

const text = (payload: Record<string, unknown>, isError = false) => ({
  data: payload,
  ...(isError ? { isError: true as const } : {}),
});

export default defineTool({
  name: 'plans:conformance',
  description:
    "Spec-conformance writes on a plan. op:'propose-deviation' { slug, requirement, reason } records a proposed deviation from a requirement as a Decision; op:'approve-deviation' { slug, requirement, proposal, ownerTurnRef? } approves it. An owner-sourced requirement needs ownerTurnRef verified as an owner turn. Approved deviations suppress the requirement's drift alarm. op:'report' { statuses?, harness? } is the read-only conformance census across plans.",
  guidance: {
    when: 'A plan requirement cannot or should no longer be met. Propose the deviation, then approve it with the right authority, instead of leaving the requirement red or editing it away.',
    notWhen: 'Changing what a requirement says (edit the plan). An ordinary ruling (plans:add-decision).',
    chaining: "propose-deviation → (owner-sourced: coord:ask-owner, cite the answer's [turn:…]) → approve-deviation.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    if (args.op === 'report') {
      // R-22 census: read-only, so it needs no plan slug and writes nothing. A harness
      // filter applies only when the caller passed one explicitly.
      const sctx = harnessScopedCtx(args.harness, ctx);
      const workspaceId = (sctx as { workspaceId?: string }).workspaceId ?? activeWorkspaceId();
      const plans = await loadConformanceReportPlans({
        workspaceId,
        ...(args.harness ? { harnessSlug: args.harness } : {}),
        ...(args.statuses ? { statuses: args.statuses } : {}),
      });
      const report = buildConformanceReport(plans, args.statuses ? { statuses: args.statuses } : {});
      return text({ ok: true, op: 'report', ...report } as unknown as Record<string, unknown>);
    }
    if (!args.slug || !args.requirement) {
      return text({ ok: false, error: 'invalid_args', message: `op:'${args.op}' requires slug and requirement` }, true);
    }
    const slug = args.slug;
    const requirement = args.requirement;
    let actor = 'system:plans-conformance';
    try {
      actor = resolveAgentIdentity(ctx).ownerId;
    } catch {
      /* unattributable caller: recorded under the system actor */
    }
    const deps = productionDeviationDeps(ctx, args.harness, actor);
    if (args.op === 'propose-deviation') {
      if (!args.reason) {
        return text({ ok: false, error: 'invalid_args', message: "op:'propose-deviation' requires reason" }, true);
      }
      const result = await proposeDeviation(
        { slug, requirement, reason: args.reason, actor },
        deps,
      );
      return text(result as unknown as Record<string, unknown>, !result.ok);
    }
    if (!args.proposal) {
      return text({ ok: false, error: 'invalid_args', message: "op:'approve-deviation' requires proposal (the D-NNN of the proposal)" }, true);
    }
    const result = await approveDeviation(
      {
        slug,
        requirement,
        proposal: args.proposal,
        actor,
        ...(args.ownerTurnRef ? { ownerTurnRef: args.ownerTurnRef } : {}),
      },
      deps,
    );
    return text(result as unknown as Record<string, unknown>, !result.ok);
  },
});
