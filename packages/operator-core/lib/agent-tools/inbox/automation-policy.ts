/**
 * inbox:automation-policy — read/set the standing workspace automation ladder
 * (autonomous-inbox-resolution-2026-08-31 P-006).
 *
 * The policy is deliberately separate from the per-run automationPolicy receipt:
 * this tool changes what the NEXT run uses; a run's receipt never changes.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  BULK_AUTOMATION_LEVELS,
  BULK_CONFIDENCE_LEVELS,
  type StandingBulkAutomationPolicy,
} from '../../attention/bulk-dispositions';
import {
  readStandingBulkAutomationPolicy,
  resetStandingBulkAutomationPolicy,
  writeStandingBulkAutomationPolicy,
} from '../../attention/automation-policy';

// Canonical `{ data }` ToolResponse — the framework owns wire encoding
// (tool-data-shape-ratchet.test.ts); never hand-roll inline JSON here.
function json(value: unknown) {
  return { data: value };
}

export default defineTool({
  name: 'inbox:automation-policy',
  profile: 'engineer',
  description:
    'Read or set the standing workspace Inbox automation policy. riskLevels controls review or automatic application for low (delegable), medium (owner decisions), and high (protected) risk. Explicit high automatic is an owner grant. Confidence and live action checks remain independent. Legacy level L0/L1/L2 remains supported.',
  capability: 'operator:write',
  guidance: {
    when: 'Changing the workspace-wide authority ladder or confidence floor for future unattended Inbox runs.',
    notWhen: 'Inspecting what an existing run used — read its automationPolicy launch receipt instead.',
    chaining: 'Set one axis at a time when desired; omitted fields retain their current standing value.',
    seeAlso: ['inbox:bulk-run-manifest (read a run receipt)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({
      op: z.literal('set'),
      level: z.enum(BULK_AUTOMATION_LEVELS).optional(),
      minConfidence: z.enum(BULK_CONFIDENCE_LEVELS).optional(),
      riskLevels: z.object({
        low: z.enum(['review', 'automatic']),
        medium: z.enum(['review', 'automatic']),
        high: z.enum(['review', 'automatic']),
      }).optional(),
      dryRun: z.boolean().optional(),
    }),
    z.object({ op: z.literal('reset'), dryRun: z.boolean().optional() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') return json({ policy: await readStandingBulkAutomationPolicy(undefined, { strict: true }) });
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('inbox:automation-policy writes require operator, architect, or mug role');
    }
    const patch = args.op === 'reset'
      ? null
      : {
          ...(args.level !== undefined ? { level: args.level } : {}),
          ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
          ...(args.riskLevels !== undefined ? { riskLevels: args.riskLevels } : {}),
        };
    if (args.op === 'set' && patch && Object.keys(patch).length === 0) {
      throw new Error('set requires at least one of level / minConfidence / riskLevels');
    }
    const outcome = await runControlMutation<StandingBulkAutomationPolicy>(
      {
        action: 'inbox:automation-policy',
        subject: 'workspace-standing-policy',
        actor: `role:${ctx.role}`,
        capturePrev: () => readStandingBulkAutomationPolicy(undefined, { strict: true }),
        apply: () => args.op === 'reset'
          ? resetStandingBulkAutomationPolicy()
          : writeStandingBulkAutomationPolicy(patch!),
        revertTo: (prev) => writeStandingBulkAutomationPolicy(prev).then(() => {}),
        verify: async (next) => ({
          ok: next.level === (args.op === 'reset' ? 'L0' : (patch!.level ?? next.level)) &&
            next.minConfidence === (args.op === 'reset' ? 'high' : (patch!.minConfidence ?? next.minConfidence)) &&
            (!patch?.riskLevels || JSON.stringify(next.riskLevels) === JSON.stringify(patch.riskLevels)),
        }),
        describe: (prev) => ({ current: prev, proposed: args.op === 'reset' ? { level: 'L0', minConfidence: 'high' } : { ...prev, ...patch } }),
      },
      { dryRun: args.dryRun },
    );
    return json({
      ok: true,
      dryRun: outcome.dryRun,
      applied: outcome.applied,
      reverted: outcome.reverted,
      preview: outcome.preview,
      verify: outcome.verify,
      auditId: outcome.auditId,
      prev: outcome.prev,
      next: outcome.next,
    });
  },
});
