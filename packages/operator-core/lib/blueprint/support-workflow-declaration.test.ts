import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import type { Sql } from 'postgres';
import { supportToEngineeringOperation } from './support-workflow-operation';

const ports = vi.hoisted(() => ({ current: vi.fn(), snapshot: vi.fn() }));
vi.mock('./project-to-pg', () => ({ readOrProjectBlueprintHash: ports.current,
  readBlueprintSpecificationSnapshot: ports.snapshot, readBlueprintReprojectionAttempt: () => null }));
import { readCurrentSupportWorkflow } from './operation-service';

const operation = supportToEngineeringOperation({ id: 'handoff', version: '1', role: 'worker',
  identity: { kind: 'identity', ref: 'support-worker', revision: '1', contentHash: 'b'.repeat(64) },
  accountableOwner: 'support-owner', reviewerPrincipals: ['reviewer'],
  allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 });
const specification = compileAgentSpecification({ source: { id: 'support', workItem: { kind: 'task' },
  roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } },
  dependencies: { tools: ['blueprint:read-private-input'] }, operations: [operation] } });
const revision = specification.specificationRevision;
const sql = {} as Sql;
const target = { workspaceId: 'workspace-a', harnessSlug: 'support', operationId: 'handoff' };
beforeEach(() => { vi.clearAllMocks(); ports.current.mockResolvedValue(revision); ports.snapshot.mockResolvedValue(specification); });

describe('current support workflow declaration', () => {
  it('projects the effective immutable operation with the server workspace and current revision', async () => {
    await expect(readCurrentSupportWorkflow(sql, target)).resolves.toEqual({ harnessSlug: 'support', operationId: 'handoff',
      approvedRevision: revision, accountableOwner: 'support-owner', reviewerPrincipals: ['reviewer'],
      allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 });
    expect(ports.current).toHaveBeenCalledWith(sql, 'workspace-a', 'support');
    expect(ports.snapshot).toHaveBeenCalledWith(sql, 'workspace-a', 'support', revision);
  });
  it('uses a new current pointer after promotion while retaining no private funding or worker policy', async () => {
    const promoted = compileAgentSpecification({ source: { ...specification.configuration,
      operations: [{ ...operation, version: '2' }] } });
    ports.current.mockResolvedValue(promoted.specificationRevision); ports.snapshot.mockResolvedValue(promoted);
    const declaration = await readCurrentSupportWorkflow(sql, target);
    expect(declaration?.approvedRevision).toBe(promoted.specificationRevision);
    expect(Object.keys(declaration!)).toEqual(['harnessSlug', 'operationId', 'approvedRevision', 'accountableOwner',
      'reviewerPrincipals', 'allowedSources', 'allowedActions', 'maximumCostMicros']);
  });
  it('does not manufacture an approval if the current pointer or snapshot is unavailable', async () => {
    ports.current.mockResolvedValue(null);
    await expect(readCurrentSupportWorkflow(sql, target)).resolves.toBeNull();
    expect(ports.snapshot).not.toHaveBeenCalled();
    ports.current.mockResolvedValue(revision); ports.snapshot.mockResolvedValue(null);
    await expect(readCurrentSupportWorkflow(sql, target)).resolves.toBeNull();
  });
  it('fails closed for an undeclared operation and propagates infrastructure errors', async () => {
    await expect(readCurrentSupportWorkflow(sql, { ...target, operationId: 'foreign' })).rejects.toThrow();
    ports.current.mockRejectedValue(new Error('database unavailable'));
    await expect(readCurrentSupportWorkflow(sql, target)).rejects.toThrow('database unavailable');
  });
});
