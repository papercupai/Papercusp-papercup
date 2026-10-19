/** scorecards:repair — immediately reconcile pending grading-integrity audits. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  GRADING_AUDIT_BACKLOG_SCAN_LIMIT,
  GRADING_AUDIT_DISPATCH_LIMIT,
  reconcilePendingGradingAudits,
  type DispatchPendingGradingAuditsInput,
} from '../../grading-integrity';
import { readIdentity } from '../locks/identity';
import { resourceLockDomain } from '../locks/coordination-domain';
import { guardResource } from '../locks/resource-lock-guard';

/**
 * A repair sweep can dispatch up to fifty independent auditors. Its bounded
 * worker pool keeps the fan-out safe, but the complete sweep can still exceed
 * the flat MCP transport deadline; give the dispatcher a durable-tool budget
 * like scorecards:emit instead of returning an unknown mutation outcome.
 */
export const SCORECARD_REPAIR_TIMEOUT_SEC = 15 * 60;

/**
 * scorecards:repair reads and dispatches through the staging runtime for up to
 * SCORECARD_REPAIR_TIMEOUT_SEC. Hold the host-global shared lease for the full
 * bounded call so dev:restart must drain this work before replacing :3170.
 */
export const SCORECARD_REPAIR_RESOURCE = 'staging-server';
export const SCORECARD_REPAIR_LOCK_TTL_SEC = SCORECARD_REPAIR_TIMEOUT_SEC + 60;

/**
 * What an omitted `targetIds` actually selects (WI-10005150). The dispatcher
 * reads only the NEWEST `GRADING_AUDIT_BACKLOG_SCAN_LIMIT` scorecards and takes
 * the oldest pending ones from THAT window, so a pending card older than the
 * window is never reached by a no-target sweep. This used to read "the oldest
 * bounded backlog", which promised the opposite. Derived from the dispatcher's
 * own constants so the text cannot drift from the selection it describes.
 */
export const SCORECARD_REPAIR_NO_TARGET_SELECTION =
  `up to ${GRADING_AUDIT_DISPATCH_LIMIT} of the oldest pending cards among only the NEWEST ` +
  `${GRADING_AUDIT_BACKLOG_SCAN_LIMIT} scorecards; an older pending card is reachable only via targetIds`;

export const scorecardRepairArgs = z
  .object({
    targetIds: z
      .array(z.string().trim().min(1).max(120))
      .max(50)
      .optional()
      .describe(
        `Optional scorecard issue ids to repair immediately. Omit to dispatch ${SCORECARD_REPAIR_NO_TARGET_SELECTION}.`,
      ),
    harness: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('Harness that owns the pending scorecards; pass it when this operator session is not harness-scoped.'),
    gradingLaunch: z
      .object({
        agent: z.literal('codex'),
        model: z.literal('gpt-6.1-sol'),
        effort: z.literal('xhigh'),
        account: z.literal('auto'),
      })
      .strict()
      .optional()
      .describe('Optional existing grading launch profile: pin independent auditors to codex/gpt-6.1-sol/xhigh through account auto, as in the acceptance-grading sweep.'),
  })
  .strict();

export default defineTool({
  name: 'scorecards:repair',
  profile: 'engineer',
  description:
    'Dispatch pending grading-integrity audits to independent auditors through the bounded idempotent dispatcher. ' +
    `Pass targetIds for a refusal; omitting them dispatches ${SCORECARD_REPAIR_NO_TARGET_SELECTION}. ` +
    'For a generation-bound scorecard, use the operator-api runtime that serves its graded build; on local staging, use the current-build :3170 route selected by dev:pipeline_position. The same-or-descendant guard is fail-closed before reservation. ' +
    'Pass gradingLaunch for the acceptance-sweep profile. This is the repair path behind scorecards:emit.',
  guidance: {
    when: 'Use when scorecards:emit or a completion gate requires reopening an audit, or a pending backlog needs an immediate bounded retry. For a generation-bound target, use dev:pipeline_position to select the operator-api runtime serving the graded build; older or unproven runtimes are refused before reservation.',
    notWhen: 'Dispatch only: do not settle an audit yourself or use this for ordinary same-rubric scorecard emission. The independent auditor re-reads the target and emits one grading-integrity card.',
    chaining:
      "scorecards:repair { targetIds:['EI-scorecard'] } → scorecards:get → await the auditor → scorecards:list to verify gradingAudit settled.",
    seeAlso: ['scorecards:get', 'scorecards:list', 'scorecards:emit'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  // The handler launches independent auditors and never uses the ambient
  // workspace transaction. Do not hold that transaction across the sweep, and
  // keep the tool deadline above the ~55s MCP transport cap.
  skipWorkspaceTx: true,
  timeoutSec: SCORECARD_REPAIR_TIMEOUT_SEC,
  args: scorecardRepairArgs,
  async handler(args, ctx) {
    const coordIdentity = resolveAgentIdentity(ctx);
    const { ownerId, ownerLabel } = readIdentity(ctx);
    const outcome = await guardResource(
      {
        coordinationDomain: resourceLockDomain(SCORECARD_REPAIR_RESOURCE),
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: SCORECARD_REPAIR_RESOURCE,
        mode: 'shared',
        ttlSec: SCORECARD_REPAIR_LOCK_TTL_SEC,
        reason: 'scorecards:repair reads and dispatches through the staging runtime',
      },
      async () => {
        const input: DispatchPendingGradingAuditsInput = {
          ctx: (args.gradingLaunch ? { ...ctx, gradingLaunch: args.gradingLaunch } : ctx) as DispatchPendingGradingAuditsInput['ctx'],
          // This callable surface promises dispatch-only repair. The periodic
          // sweep keeps stranded-card re-certification enabled by default.
          recertifyStranded: false,
          ...(args.targetIds ? { targetIds: args.targetIds } : {}),
          ...(args.harness ? { harness: args.harness } : {}),
        };
        return reconcilePendingGradingAudits(input);
      },
    );
    if (!outcome.acquired) {
      return {
        data: {
          ok: false,
          reason: `resource_${outcome.reason}`,
          resource: SCORECARD_REPAIR_RESOURCE,
          holders: outcome.holders.map((holder) => ({
            owner: holder.owner,
            owner_label: holder.owner_label,
            mode: holder.mode,
            status: holder.status,
            ...(holder.coordination_domain ? { coordination_domain: holder.coordination_domain } : {}),
          })),
        },
      };
    }
    return { data: { ok: true, ...outcome.result } };
  },
});
