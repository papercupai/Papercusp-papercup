/**
 * POST /api/code-cleanup/reset-throttle { campaignId, runnerItemId, harness, workspaceId? }
 * (code-cleanup-campaigns-2026-10-26 P-008 R-9 and P-009; D-013, D-016).
 *
 * The owner's door to reset a cleanup campaign whose regression throttle tripped. Like the
 * governance-policy pane routes it is a loopback admin write stamped `admin:<principal slug>`, and
 * there is deliberately NO MCP tool for it: an agent is a service identity, and
 * resetRegressionThrottle refuses every principal that is not `admin:*`/`user:*`.
 *
 * The state lives on the campaign's runner work-item (D-016), which records who reset it and
 * when. A refusal answers ok:false with its code (not-owner 403, not-throttled 409); a runner item
 * that is missing or runs another campaign answers 404/409 from the store's error.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resetCampaignThrottle, serializeThrottleState, workItemThrottleStore } from '../../../code-cleanup/campaign-native';
import { DEFAULT_CAMPAIGN_REVIEW } from '../../../code-cleanup/campaign-plan';
import { governancePolicyActor } from '../governance-policy/policy';

export const resetThrottleSchema = z.object({
  campaignId: z.string().trim().min(1),
  runnerItemId: z.string().trim().min(1),
  harness: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
}).strict();

const REFUSAL_STATUS = { 'not-owner': 403, 'not-throttled': 409 } as const;

const resetThrottle = defineTool({
  method: 'POST',
  path: '/code-cleanup/reset-throttle',
  auth: 'loopback',
  input: resetThrottleSchema,
  async handler(_req, ctx) {
    const { campaignId, runnerItemId, harness } = ctx.input;
    const store = workItemThrottleStore({
      workspaceId: ctx.input.workspaceId ?? activeWorkspaceId(), harness, runnerItemId, defaultReview: DEFAULT_CAMPAIGN_REVIEW,
    });
    try {
      const out = await resetCampaignThrottle({ store, campaignId, principal: governancePolicyActor(ctx), now: new Date() });
      if (!out.ok) return Response.json({ op: 'reset-throttle', ...out }, { status: REFUSAL_STATUS[out.code] });
      return Response.json({ ok: true, op: 'reset-throttle', campaignId, runnerItemId, state: serializeThrottleState(out.state) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const status = /not found/.test(error) ? 404 : /runs campaign/.test(error) ? 409 : 500;
      return Response.json({ ok: false, op: 'reset-throttle', code: status === 500 ? 'unavailable' : 'invalid', error }, { status });
    }
  },
});

export default [resetThrottle];
