import { describe, expect, it } from 'vitest';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { supportToEngineeringOperation, supportWorkflowFromOperation } from './support-workflow-operation';
import {
  assertApprovedSupportWorkflow,
  assertSupportCaseInput,
  parseSupportToEngineeringResult,
  parseSupportToEngineeringResultShape,
  type ApprovedSupportWorkflow,
} from './support-workflow-contract';

const workflow: ApprovedSupportWorkflow = {
  harnessSlug: 'papercusp', operationId: 'support-to-engineering', approvedRevision: 'a'.repeat(64),
  accountableOwner: 'employee-owner', reviewerPrincipals: ['reviewer-a', 'reviewer-b'],
  allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
};
const id = '00000000-0000-4000-8000-000000000001';
const selection = { supportCaseId: 'case-1', documentIds: [id] };
const evidence = [{ id, source: 'slack', externalId: 'T1:C1:123' }];
const output = {
  supportCaseId: 'case-1', summary: 'A bounded summary', reproduction: ['step'], checklist: ['check'],
  suggestedRole: 'engineer', citations: evidence,
};

describe('P-012b support workflow contract', () => {
  it('declares the selected workflow on the canonical operation manifest and pins its policy', () => {
    const operation = supportToEngineeringOperation({ id: workflow.operationId, version: '1', role: 'worker',
      identity: { kind: 'identity', ref: 'worker-domain', revision: '1', contentHash: 'b'.repeat(64) },
      ...workflow, reviewerPrincipals: [...workflow.reviewerPrincipals],
      allowedSources: [...workflow.allowedSources], allowedActions: [...workflow.allowedActions] });
    const source = { id: 'support-workflow', workItem: { kind: 'task' }, roles: [{ id: 'worker' }],
      spine: { edges: { DONE: { to: 'done' } } }, dependencies: { tools: ['blueprint:read-private-input'] },
      operations: [operation] };
    expect(BlueprintSchema.safeParse(source).success).toBe(true);
    const specification = compileAgentSpecification({ source });
    expect(supportWorkflowFromOperation(operation, workflow.harnessSlug, specification.specificationRevision))
      .toEqual({ ...workflow, approvedRevision: specification.specificationRevision });
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, output).ok).toBe(true);
    expect(checkAgainstJsonSchema(operation.inputSchema, { ...selection,
      approvedRevision: workflow.approvedRevision, query: 'cobalt roadmap', requestedAction: 'publish' }).ok).toBe(false);
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, { ...output, citations: [] }).ok).toBe(false);
  });
  it('requires an accountable owner, distinct reviewer and finite maximum', () => {
    expect(() => assertApprovedSupportWorkflow({ ...workflow, reviewerPrincipals: ['reviewer-a', 'reviewer-a'] })).toThrow(/distinct/);
    expect(() => assertApprovedSupportWorkflow({ ...workflow, maximumCostMicros: 0 })).toThrow(/malformed/);
  });

  it('pins the employee selection to the displayed approved revision and allowed action', () => {
    const input = assertSupportCaseInput(workflow, {
      supportCaseId: 'case-1', approvedRevision: workflow.approvedRevision,
      documentIds: [id], query: 'cobalt roadmap', requestedAction: 'prepare-handoff',
    });
    expect(input.documentIds).toEqual([id]);
    expect(() => assertSupportCaseInput(workflow, { ...input, approvedRevision: 'b'.repeat(64) })).toThrow(/outside/);
    expect(() => assertSupportCaseInput(workflow, { ...input, requestedAction: 'publish' })).toThrow(/outside/);
  });

  it('rejects malformed or widened evidence and parses only the selected case', () => {
    expect(() => assertSupportCaseInput(workflow, {
      supportCaseId: 'case-1', approvedRevision: workflow.approvedRevision,
      documentIds: ['not-a-uuid'], query: 'x', requestedAction: 'prepare-handoff',
    })).toThrow(/canonical/);
    const parsed = parseSupportToEngineeringResult(output, selection, evidence);
    expect(parsed.supportCaseId).toBe('case-1');
    expect(() => parseSupportToEngineeringResult({ supportCaseId: 'case-2' },
      selection, evidence)).toThrow(/contract/);
    expect(() => parseSupportToEngineeringResult(parsed,
      { supportCaseId: 'case-1', documentIds: [] }, evidence)).toThrow(/evidence/);
  });

  it.each([
    { source: 'github' },
    { externalId: 'another-case' },
    { externalId: null },
  ])('refuses a valid selected document id with forged citation metadata %j', (patch) => {
    expect(() => parseSupportToEngineeringResult({ ...output, citations: [{ ...evidence[0], ...patch }] },
      selection, evidence)).toThrow(/evidence/);
  });

  it('requires the complete unambiguous ACL-checked evidence population', () => {
    for (const documents of [[], [evidence[0], evidence[0]],
      [{ ...evidence[0], id: '00000000-0000-4000-8000-000000000002' }]]) {
      expect(() => parseSupportToEngineeringResult(output, selection, documents)).toThrow(/evidence/);
    }
    expect(() => parseSupportToEngineeringResult({ ...output, citations: [evidence[0], evidence[0]] },
      selection, evidence)).toThrow(/evidence/);
  });

  it('accepts canonical nullable external ids and copies evidence before exposing the result', () => {
    const documents = [{ ...evidence[0], externalId: null }];
    const parsed = parseSupportToEngineeringResult({ ...output, citations: documents }, selection, documents);
    documents[0].source = 'changed-after-parse';
    expect(parsed.citations).toEqual([{ id, source: 'slack', externalId: null }]);
    expect(Object.isFrozen(parsed.citations[0])).toBe(true);
  });

  it('checks display shape without treating worker citation metadata as canonical evidence', () => {
    const forged = { ...output, citations: [{ ...evidence[0], source: 'github' }] };
    expect(parseSupportToEngineeringResultShape(forged).citations[0].source).toBe('github');
    expect(() => parseSupportToEngineeringResult(forged, selection, evidence)).toThrow(/evidence/);
    expect(() => parseSupportToEngineeringResultShape({ ...output, reproduction: [null] })).toThrow(/evidence/);
    expect(() => parseSupportToEngineeringResultShape({ ...output, citations: [] })).toThrow(/contract/);
  });
});
