/** The selected internal workflow uses the existing operation manifest,
 * private-input retention and business-review signal. This constructs a
 * declaration; publishing a revision and enforcing its budget are separate. */
import type { BlueprintOperation } from '@papercusp/orchestrator/blueprint';
import type { ApprovedSupportWorkflow } from './support-workflow-contract';
import { assertApprovedSupportWorkflow } from './support-workflow-contract';

export function supportWorkflowFromOperation(operation: {
  id: string;
  policy: { supportCase?: Pick<ApprovedSupportWorkflow, 'allowedSources' | 'allowedActions' | 'maximumCostMicros'> };
  acceptance: { businessReview?: Pick<ApprovedSupportWorkflow, 'accountableOwner' | 'reviewerPrincipals'> };
}, harnessSlug: string,
  approvedRevision: string): ApprovedSupportWorkflow | null {
  const policy = operation.policy.supportCase;
  if (!policy) return null;
  const review = operation.acceptance.businessReview;
  if (!review) throw new Error('support operation has no accountable business review policy');
  const workflow = { harnessSlug, operationId: operation.id, approvedRevision, ...review, ...policy };
  assertApprovedSupportWorkflow(workflow);
  return workflow;
}

export function supportToEngineeringOperation(input: {
  id: string; version: string; role: string;
  identity: NonNullable<BlueprintOperation['policy']['identity']>;
  model?: BlueprintOperation['policy']['model'];
  accountableOwner: string; reviewerPrincipals: string[];
  allowedSources: string[]; allowedActions: string[]; maximumCostMicros: number;
  funding?: NonNullable<BlueprintOperation['policy']['supportCase']>['funding'];
  native?: NonNullable<BlueprintOperation['policy']['supportCase']>['native'];
}): BlueprintOperation {
  const string = { type: 'string', minLength: 1 };
  const citation = { type: 'object', additionalProperties: false,
    required: ['id', 'source', 'externalId'], properties: {
      id: { ...string, format: 'uuid' }, source: string, externalId: { type: ['string', 'null'] },
    } };
  return {
    id: input.id, version: input.version,
    description: 'Prepare a cited support-to-engineering handoff for distinct business review',
    target: { kind: 'work-item', itemKind: 'task' },
    execution: { kind: 'agent', role: input.role },
    inputSchema: { type: 'object', additionalProperties: false,
      required: ['supportCaseId', 'approvedRevision', 'documentIds', 'query', 'requestedAction'],
      properties: {
        supportCaseId: { ...string, maxLength: 200 },
        approvedRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        documentIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true,
          items: { ...string, format: 'uuid' } },
        query: { ...string, maxLength: 500 },
        requestedAction: { type: 'string', enum: input.allowedActions },
      } },
    // Content comes from the server ACL adapter, never employee-supplied prose.
    privateInputSchema: { type: 'object', additionalProperties: false,
      required: ['supportCaseId', 'documents'], properties: {
        supportCaseId: string,
        documents: { type: 'array', minItems: 1, maxItems: 50, items: {
          ...citation, required: ['id', 'source', 'externalId', 'title', 'snippet'],
          properties: { ...citation.properties, title: { type: 'string' }, snippet: { type: 'string' } },
        } },
      } },
    acceptance: {
      resultSchema: { type: 'object', additionalProperties: false,
        required: ['supportCaseId', 'summary', 'reproduction', 'checklist', 'suggestedRole', 'citations'],
        properties: {
          supportCaseId: string, summary: { ...string, maxLength: 20_000 }, suggestedRole: { ...string, maxLength: 200 },
          reproduction: { type: 'array', maxItems: 50, items: { ...string, maxLength: 2000 } },
          checklist: { type: 'array', maxItems: 50, items: { ...string, maxLength: 2000 } },
          citations: { type: 'array', minItems: 1, maxItems: 50, items: citation },
        } },
      businessReview: { accountableOwner: input.accountableOwner, reviewerPrincipals: [...input.reviewerPrincipals] },
    },
    policy: { identity: input.identity, ...(input.model ? { model: input.model } : {}),
      requiredTools: ['blueprint:read-private-input'],
      supportCase: { allowedSources: [...input.allowedSources], allowedActions: [...input.allowedActions],
        maximumCostMicros: input.maximumCostMicros,
        ...(input.funding ? { funding: structuredClone(input.funding) } : {}),
        ...(input.native ? { native: structuredClone(input.native) } : {}) } },
    artifacts: [], waits: {},
    signals: { 'business-review': { payloadSchema: { type: 'object', additionalProperties: false,
      required: ['decision', 'reason', 'resultFingerprint'], properties: {
        decision: { type: 'string', enum: ['accept', 'reject', 'rework'] },
        reason: { ...string, maxLength: 2000 }, resultFingerprint: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      } } } },
  };
}
