import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { currentRequestWorkspaceId, runWithWorkspace } from '../workspace-als';
import type { WorkItem } from '../work-items';
import { getBlueprintOperationResult, getBlueprintOperationTerminalWorker, prepareDirectOperationCompletion,
  type BlueprintOperationHandle } from './operation-service';
import { supportToEngineeringOperation } from './support-workflow-operation';

const ports = vi.hoisted(() => ({ item: vi.fn(), snapshot: vi.fn(), source: vi.fn(), accepted: vi.fn() }));
// Persistence and worker ports stay synthetic; the operation service, output
// schema, selected-case ACL adapter and domain parser are exercised together.
vi.mock('../work-items', () => ({ getWorkItem: ports.item }));
vi.mock('./project-to-pg', () => ({ readBlueprintSpecificationSnapshot: ports.snapshot }));
vi.mock('./operation-admission', () => ({ readAcceptedBlueprintDirectWorkItem: ports.accepted }));
vi.mock('./operation-worker-binding', () => ({ readActiveOperationModelPolicy: vi.fn() }));
vi.mock('../work-items-events', () => ({ isSettledWorkItem: (item: WorkItem) => item.state === 'done' }));
vi.mock('../cupboard/rubric-store', () => ({ seedContentHash: vi.fn() }));
vi.mock('../data-sources/documents-corpus', () => ({ searchOrganizationDocuments: ports.source }));

const workspaceId = 'support-result-workspace', harnessSlug = 'support-result';
const userId = '12345678-1234-4234-8234-123456789012', callerId = `${userId}/employee`;
const reviewerId = '42345678-1234-4234-8234-123456789012';
const document = { id: '22345678-1234-4234-8234-123456789012', source: 'slack', externalId: 'T1:CASE:1' };
const operation = supportToEngineeringOperation({ id: 'handoff', version: '1', role: 'support-worker',
  identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
  accountableOwner: 'support-owner', reviewerPrincipals: [reviewerId],
  allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 });
const specification = compileAgentSpecification({ source: {
  id: harnessSlug, workItem: { kind: 'task' }, roles: [{ id: 'support-worker' }],
  dependencies: { tools: ['blueprint:read-private-input'] },
  spine: { edges: { DONE: { to: 'done' } } }, operations: [operation],
} });
const revision = specification.specificationRevision;
const selection = { supportCaseId: 'case-cobalt', approvedRevision: revision,
  documentIds: [document.id], query: 'case-cobalt', requestedAction: 'prepare-handoff' };
const pin = { kind: 'blueprint-operation', harnessSlug, operationId: 'handoff', operationVersion: '1',
  specificationRevision: revision, input: selection, callerId, requestKey: 'case-cobalt' };
const handle: BlueprintOperationHandle = { workspaceId, harnessSlug, operationId: 'handoff',
  receiptId: 12, specificationRevision: revision, target: { kind: 'work-item', id: 'WI-12' } };
const output = { supportCaseId: 'case-cobalt', summary: 'Cited support handoff',
  reproduction: ['Open the synthetic case'], checklist: ['Confirm the failure'],
  suggestedRole: 'engineering', citations: [document] };
const item = (value: unknown = output) => ({ id: 'WI-12', harness: harnessSlug, kind: 'task', family: 'task',
  state: 'done', assignee: null, completionAuthority: 'committed', terminalOwner: 'worker',
  terminalCompletionRef: 'completion:12', updatedAt: '2026-10-15T10:00:00Z',
  payload: { blueprintOperation: pin, blueprintResult: { operationId: 'handoff', specificationRevision: revision,
    output: value, evidenceRef: 'evidence:12' } },
} as unknown as WorkItem);
const sql = vi.fn(async (strings: TemplateStringsArray) => {
  const query = strings.join('?');
  if (query.includes('blueprint_operation_invocations')) return [{ id: 12, caller_id: callerId,
    operation_id: 'handoff', specification_revision: revision, target_kind: 'work-item',
    target_ref: 'WI-12', target_harness_slug: harnessSlug }];
  if (query.includes('cancel_requested')) return [{ cancel_requested: false, wait_body: null }];
  return [];
}) as unknown as Sql;
beforeEach(() => {
  vi.clearAllMocks(); ports.item.mockResolvedValue(item()); ports.snapshot.mockResolvedValue(specification);
  ports.accepted.mockResolvedValue({ pin, operation, specification });
  ports.source.mockResolvedValue({ allowed: true, results: [document], withheld: 0, disclosed: 1 });
});

describe('canonical support result domain gate', () => {
  it('adds only current viewer-authorized source metadata without changing the reviewed output fingerprint', async () => {
    const original = await getBlueprintOperationResult(sql, handle, `${reviewerId}/client`, { principalId: reviewerId });
    ports.source.mockImplementation(async (_sql: unknown, _ctx: unknown, params: { principalUserId: string }) => ({
      allowed: true, results: [{ ...document, metadata: { permalink: params.principalUserId === reviewerId
        ? 'https://support.example/cases/current' : 'https://support.example/cases/employee' } }], withheld: 0, disclosed: 1,
    }));
    const result = await getBlueprintOperationResult(sql, handle, `${reviewerId}/client`, { principalId: reviewerId });
    expect(result).toMatchObject({ state: 'ready', output: { citations: [{ ...document,
      sourceUrl: 'https://support.example/cases/current' }] } });
    if (original.state !== 'ready' || result.state !== 'ready') throw new Error('fixture');
    expect(result.businessReview?.resultFingerprint).toBe(original.businessReview?.resultFingerprint);
    expect((await prepareDirectOperationCompletion(sql, workspaceId, item(), output)).output).toEqual(output);
    expect((await getBlueprintOperationTerminalWorker(sql, handle, callerId)).output).toEqual(output);
    expect(output.citations[0]).not.toHaveProperty('sourceUrl');
  });

  it.each(['javascript:alert(1)', 'http://support.example/case', 'https://user:secret@support.example/case', '/case/12'])
    ('omits unsafe canonical source links: %s', async permalink => {
      ports.source.mockResolvedValue({ allowed: true, results: [{ ...document, metadata: { permalink } }], withheld: 0, disclosed: 1 });
      const result = await getBlueprintOperationResult(sql, handle, callerId);
      expect(result).toMatchObject({ state: 'ready', output });
      if (result.state !== 'ready') throw new Error('fixture');
      expect((result.output as typeof output).citations[0]).not.toHaveProperty('sourceUrl');
    });

  it('uses the accepted employee selection and current source read for completion and reviewer display', async () => {
    expect((await runWithWorkspace(workspaceId, () => prepareDirectOperationCompletion(sql, workspaceId, item(), output))).output)
      .toEqual(output);
    const result = await runWithWorkspace('unrelated-request', () =>
      getBlueprintOperationResult(sql, handle, `${reviewerId}/client`, { principalId: reviewerId }));
    expect(result).toMatchObject({ state: 'ready', output, businessReview: { state: 'pending' } });
    expect(ports.source).toHaveBeenLastCalledWith(sql, expect.objectContaining({ workspaceId, role: 'support-worker',
      principal: expect.objectContaining({ kind: 'user', trust: 'verified', slug: reviewerId, workspaceId }) }),
    expect.objectContaining({ documentIds: [document.id], principalUserId: reviewerId, workspaceId }));
    expect(ports.source).toHaveBeenCalledWith(sql, expect.anything(), expect.objectContaining({ principalUserId: userId }));
  });

  it.each([
    ['foreign case', { ...output, supportCaseId: 'case-foreign' }],
    ['foreign document', { ...output, citations: [{ ...document, id: '32345678-1234-4234-8234-123456789012' }] }],
    ['forged source', { ...output, citations: [{ ...document, source: 'email' }] }],
    ['forged external id', { ...output, citations: [{ ...document, externalId: 'OTHER:CASE' }] }],
    ['duplicate evidence', { ...output, citations: [document, document] }],
    ['empty handoff', { ...output, reproduction: [], checklist: [] }],
  ])('rejects a schema-valid %s at completion and canonical result read', async (_label, forged) => {
    await expect(runWithWorkspace(workspaceId, () => prepareDirectOperationCompletion(sql, workspaceId, item(), forged)))
      .rejects.toThrow(/support/);
    ports.item.mockResolvedValue(item(forged));
    expect(await getBlueprintOperationResult(sql, handle, callerId)).toMatchObject({ state: 'unavailable',
      status: { outcome: 'unverified' }, reason: expect.stringMatching(/support/) });
  });

  it.each(['revoked', 'missing-document'] as const)('refuses %s evidence after an otherwise successful close', async reason => {
    ports.source.mockResolvedValue(reason === 'revoked' ? { allowed: false, reason: 'no_live_grant' } :
      { allowed: true, results: [], withheld: 0, disclosed: 0 });
    expect(await getBlueprintOperationResult(sql, handle, `${reviewerId}/client`, { principalId: reviewerId }))
      .toMatchObject({ state: 'unavailable', status: { outcome: 'unverified' } });
  });

  it.each(['revoked', 'missing'])('does not treat reviewer allowlisting as corpus disclosure authority: %s', async reason => {
    ports.source.mockImplementation(async (_sql: unknown, _ctx: unknown, params: { principalUserId: string }) =>
      params.principalUserId === userId ? { allowed: true, results: [document], withheld: 0, disclosed: 1 } :
        reason === 'revoked' ? { allowed: false, reason: 'no_live_grant' } :
          { allowed: true, results: [], withheld: 0, disclosed: 0 });
    const result = await getBlueprintOperationResult(sql, handle, `${reviewerId}/client`, { principalId: reviewerId });
    expect(result).toMatchObject({ state: 'unavailable', status: { outcome: 'unverified' } });
    expect(result).not.toHaveProperty('output');
  });

  it('re-enters the accepted workspace for completion called from another request', async () => {
    ports.source.mockImplementation(async () => {
      expect(currentRequestWorkspaceId()).toBe(workspaceId);
      return { allowed: true, results: [document], withheld: 0, disclosed: 1 };
    });
    await runWithWorkspace('other-workspace', () => prepareDirectOperationCompletion(sql, workspaceId, item(), output));
    expect(ports.source).toHaveBeenCalledOnce();
  });
});
