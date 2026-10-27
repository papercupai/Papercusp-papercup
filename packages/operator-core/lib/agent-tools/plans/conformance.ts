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
import { createPhaseTracker, type AbortCompletionContext, type AbortCompletionReceipt, type PhaseTracker, type ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../abort-completion-payload';
import { harnessArg, harnessScopedCtx, isAllHarnessSentinel } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { readPlanBySlug } from './source';
import { addDecisionOne } from './add-decision';
import { resolveAgentIdentity } from '../coordination/identity';
import { parseTurnRefs, verifyTurnRefs, type TurnRefVerdict } from '../../turn-provenance/turn-ref';
import { activeWorkspaceId } from '../../workspace-registry';
import { buildConformanceReport, loadConformanceReportPlans } from '../../spec-conformance/conformance-report';
import type { SweepWatermarkWrite } from '../../spec-conformance/sweep-action';
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
  op: z.enum(['propose-deviation', 'approve-deviation', 'report', 'run']),
  slug: z.string().trim().min(1).optional().describe('Plan slug (run and deviation ops).'),
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

/** Keep a stalled run observable even before dispatch can write its invocation row. */
async function withConformanceRunDiagnostics<T>(
  ctx: UnifiedToolContext,
  work: (phases: PhaseTracker) => Promise<T>,
): Promise<T> {
  const phases = ctx.phases ?? createPhaseTracker({ historyCap: 32 });
  let slow = false;
  const report = (event: 'pending' | 'progress' | 'settled'): void => {
    try {
      console.info(`[spec-conformance-phase] ${JSON.stringify({
        event,
        traceId: ctx.requestOrigin?.mcpRequestTraceId ?? null,
        dispatchCallId: ctx.dispatchCallId ?? null,
        phases: phases.snapshot(),
      })}`);
    } catch { /* Diagnostics cannot change the run or authorize a retry. */ }
  };
  // One observation per slow run, then only real phase transitions; no polling.
  const timer = setTimeout(() => { slow = true; report('pending'); }, 5_000);
  timer.unref?.();
  const track: PhaseTracker['track'] = (phase, operation) => {
    const pending = phases.track(phase, operation);
    if (slow) report('progress');
    return pending;
  };
  try {
    return await work({ ...phases, track });
  } finally {
    clearTimeout(timer);
    if (slow) report('settled');
  }
}

/** Recover only this returned run's acknowledged watermark write; never make runs idempotent. */
export function conformanceRunAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
  context: AbortCompletionContext,
): AbortCompletionReceipt {
  const incomplete = (): AbortCompletionReceipt => ({
    status: 'recovery-incomplete',
    reason: 'conformance result did not prove this attempt and its persisted target watermark',
    failures: ['missing-or-mismatched-conformance-receipt'],
  });
  const input = asRecord(args);
  const payload = completedResultPayload(result);
  const receipt = asRecord(payload?.runReceipt);
  const run = Array.isArray(payload?.ran) && payload.ran.length === 1 ? asRecord(payload.ran[0]) : null;
  if (
    context.toolName !== 'plans:conformance' || !context.callId.trim() || result.isError ||
    input?.op !== 'run' || payload?.ok !== true || payload.op !== 'run' || !receipt ||
    receipt.attemptId !== context.callId ||
    typeof receipt.workspaceId !== 'string' || !receipt.workspaceId.trim() ||
    typeof receipt.harnessSlug !== 'string' || !receipt.harnessSlug.trim() ||
    ['*', 'all'].includes(receipt.harnessSlug) ||
    receipt.harnessSlug !== payload.harnessSlug ||
    (input.harness != null && input.harness !== receipt.harnessSlug) ||
    typeof receipt.planSlug !== 'string' || !receipt.planSlug.trim() ||
    receipt.planSlug !== input.slug || receipt.planSlug !== payload.planSlug ||
    typeof receipt.lastRunAt !== 'string' || !Number.isFinite(Date.parse(receipt.lastRunAt)) ||
    run?.ok !== true || run.key !== `${receipt.harnessSlug}/${receipt.planSlug}`
  ) return incomplete();
  return {
    status: 'recorded',
    effectRef: `spec-conformance:${context.callId}:${encodeURIComponent(receipt.workspaceId)}:${encodeURIComponent(receipt.harnessSlug)}:${encodeURIComponent(receipt.planSlug)}:${receipt.lastRunAt}`,
    diagnostics: { ...receipt, summary: run.summary },
  };
}

export default defineTool({
  name: 'plans:conformance',
  description:
    "Spec-conformance writes on a plan. op:'run' { slug, harness? } runs exactly one plan now through the maintained conformance runner, records its result and watermark, and returns its outcome. op:'propose-deviation' { slug, requirement, reason } records a proposed deviation from a requirement as a Decision; op:'approve-deviation' { slug, requirement, proposal, ownerTurnRef? } approves it. An owner-sourced requirement needs ownerTurnRef verified as an owner turn. Approved deviations suppress the requirement's drift alarm. op:'report' { statuses?, harness? } is the read-only conformance census across plans.",
  guidance: {
    when: 'A plan requirement cannot or should no longer be met. Propose the deviation, then approve it with the right authority, instead of leaving the requirement red or editing it away.',
    notWhen: 'Changing what a requirement says (edit the plan). An ordinary ruling (plans:add-decision).',
    chaining: "propose-deviation → (owner-sourced: coord:ask-owner, cite the answer's [turn:…]) → approve-deviation.",
  },
  capability: 'plans:write',
  requirePrincipal: false,
  abortCompletionReceipt: conformanceRunAbortCompletionReceipt,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    if (args.op === 'run') {
      if (!args.slug) return text({ ok: false, error: 'invalid_args', message: "op:'run' requires slug" }, true);
      const sctx = harnessScopedCtx(args.harness, ctx);
      if (isAllHarnessSentinel(sctx.harnessSlug)) {
        return text({ ok: false, error: 'invalid_args', message: "op:'run' requires one concrete harness" }, true);
      }
      return withConformanceRunDiagnostics(ctx, async (phases) => {
        const { track } = phases;
        const opts = await track('sourceOptions', () => ctxToPlanSourceOpts(sctx));
        const read = await track('readPlan', () => readPlanBySlug(args.slug!, opts));
        if (!read) return text({ ok: false, error: 'plan_not_found', slug: args.slug }, true);
        const target = { harnessSlug: read.row.harnessSlug, planSlug: args.slug! };
        const { productionSweepDeps, runSpecConformanceSweep } = await track('loadSweep', () => import('../../spec-conformance/sweep-action'));
        const deps = productionSweepDeps({ workspaceId: opts.workspaceId ?? activeWorkspaceId(), phases });
        const persisted: { row: SweepWatermarkWrite | null } = { row: null };
        const outcome = await track('sweep', () => runSpecConformanceSweep({ target }, {
          ...deps,
          listPlans: () => track('listPlans', async () => [{ ...target, content: read.row.content }]),
          readWatermarks: () => track('readWatermarks', () => deps.readWatermarks()),
          lastTransitions: (plans) => track('lastTransitions', () => deps.lastTransitions(plans)),
          footprintWindow: (plan, sinceSha) => track('footprintWindow', () => deps.footprintWindow(plan, sinceSha)),
          reconcileFootprint: (plan, sinceSha, window) => track('reconcileFootprint', () => deps.reconcileFootprint(plan, sinceSha, window)),
          runConformance: (plan) => track('runConformance', () => deps.runConformance(plan)),
          writeWatermark: (row) => track('writeWatermark', async () => {
            await deps.writeWatermark(row);
            persisted.row = row;
          }),
        }));
        const ok = outcome.ran.length === 1 && outcome.ran[0].ok;
        return text({
          ok, op: 'run', ...target, ...outcome,
          ...(persisted.row && ctx.dispatchCallId ? {
            runReceipt: {
              attemptId: ctx.dispatchCallId,
              workspaceId: opts.workspaceId ?? activeWorkspaceId(),
              harnessSlug: persisted.row.harnessSlug,
              planSlug: persisted.row.planSlug,
              lastRunAt: persisted.row.lastRunAt,
            },
          } : {}),
        }, !ok);
      });
    }
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
