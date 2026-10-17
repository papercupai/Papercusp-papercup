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
    'Immediately reconcile pending grading-integrity audits by dispatching independent auditors through the bounded, idempotency-keyed pending-audit dispatcher. ' +
    `Pass targetIds for a pending scorecard named by a refusal; omitting them dispatches ${SCORECARD_REPAIR_NO_TARGET_SELECTION}. ` +
    'Pass gradingLaunch to use the same pinned model profile as the acceptance-grading sweep. ' +
    'This is the callable repair path behind scorecards:emit and the acceptance-grading sweep.',
  guidance: {
    when: 'scorecards:emit or a completion gate says a scorecard must be re-opened through the pending-audit dispatcher, or a known pending grading-integrity backlog needs an immediate bounded retry instead of waiting for the periodic sweep.',
    notWhen: 'Do not use this to settle an audit yourself. It only dispatches an independent auditor; the auditor must re-read the target and emit exactly one grading-integrity card. Do not use it for ordinary same-rubric scorecard emission.',
    chaining:
      "scorecards:repair { targetIds:['EI-scorecard'] } → scorecards:get { issueId:'EI-scorecard' } → wait for the independent auditor → scorecards:list { subjectRef:'EI-scorecard' } to verify the gradingAudit settled.",
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
