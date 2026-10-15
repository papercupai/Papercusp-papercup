/** Native acceptance uses the serving operator's corpus and configured accounts. */
import { z } from 'zod';
import type { AgentIdentity } from '../coordination/identity';
import { nativeConsultConstraintsSchema } from '../../consult/native-consult';
import { acceptFeedbackRequestProd } from '../../consult/get-feedback-prod';
import { readHeldWorkItems } from '../../carry-brief';

export const nativeConsultScenarioSchema = nativeConsultConstraintsSchema.extend({
  request_key: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(12000),
  tried: z.string().trim().min(1).max(12000),
  observed: z.string().trim().min(1).max(12000),
  decision_at_stake: z.string().trim().min(1).max(4000),
  subject_ref: z.string().trim().min(1).max(500).optional().describe(
    'Optional exact transcript corpus filter. It is matched against source-turn text before routing; use only a phrase or identifier expected to occur in eligible evidence, not a decision or experiment tag.',
  ),
}).strict();
export type NativeConsultScenario = z.infer<typeof nativeConsultScenarioSchema>;

export async function acceptNativeConsultScenario(input: {
  scenario: NativeConsultScenario; identity: AgentIdentity; harnessSlug: string;
  workspaceId: string; workItemId: string;
}, deps = { readHeldWorkItems, accept: acceptFeedbackRequestProd }) {
  // Native agent resources require a measured hold; unreadable claims refuse.
  const held = await deps.readHeldWorkItems(input.identity.ownerId, input.workspaceId, { limit: 200 });
  if (!held.some(item => item.id === input.workItemId)) {
    return { ok: false, mode: 'native-consult', error: 'work_item_not_held' };
  }
  const { scenario } = input;
  const constraints = { sourceBackend: scenario.sourceBackend, targetBackend: scenario.targetBackend, sourceState: scenario.sourceState,
    ...(scenario.requireSourcePlanClaims === undefined ? {} : { requireSourcePlanClaims: scenario.requireSourcePlanClaims }) };
  const accepted = await deps.accept({
    workspaceId: input.workspaceId, requesterId: input.identity.ownerId,
    requestKey: scenario.request_key, question: scenario.question,
    tried: scenario.tried, observed: scenario.observed, decisionAtStake: scenario.decision_at_stake,
    subjectRef: scenario.subject_ref, originTaskRef: input.workItemId, harnessSlug: input.harnessSlug,
    nativeConsult: constraints, archiveFloor: 2, latencyContract: 'proceed',
  }, input.identity, { harnessSlug: input.harnessSlug, allowDispatch: true });
  // Acceptance is not a native receipt or an answer; there are no pass counts.
  return { ok: !('error' in accepted), mode: 'native-consult', workItemId: input.workItemId,
    evidencePlane: 'serving-operator', constraints, accepted };
}
