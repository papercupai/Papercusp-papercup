import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setup: vi.fn(), dispose: vi.fn(), mkdtemp: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn(),
  direct: vi.fn(), canonical: vi.fn(), writeState: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ mkdtemp: mocks.mkdtemp, mkdir: mocks.mkdir, writeFile: mocks.writeFile, rm: mocks.rm }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: mocks.canonical }) }));
vi.mock('../agent-tools/plans/__tests__/_pg-tool-fixture', () => ({ setupPlanPgFixture: mocks.setup, seedPlan: vi.fn() }));
vi.mock('../agent-tools/plans/source', () => ({ deriveIndexFromContent: vi.fn() }));
vi.mock('../agent-tools/plans/plan-index-rows', () => ({ writePlanIndexRows: vi.fn() }));
vi.mock('../agent-tools/plans/spec-clauses-store', () => ({ setSpecClause: vi.fn(), listSpecClauses: vi.fn() }));
vi.mock('../plan-items/anchor-store', () => ({ writePlanItemAnchors: vi.fn() }));
vi.mock('./engineering-evidence', () => ({ readEngineeringEvidence: vi.fn() }));
vi.mock('./engineering-evidence-store', () => ({ engineeringEvidenceStore: vi.fn() }));
vi.mock('../operator-state-pg', () => ({ writeOperatorState: mocks.writeState }));
vi.mock('../agent-tools/gitnexus/query', () => ({ default: {} }));

import { setupEngineeringEvidenceFixture } from './_engineering-evidence-fixture';

describe('engineering evidence fixture failure ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.setup.mockResolvedValue({ admin: mocks.direct, workspaceId: 'private-workspace', dispose: mocks.dispose });
    mocks.mkdtemp.mockResolvedValue('/tmp/ee-owned');
    const options = { host: ['127.0.0.1'], port: [32771], database: 'private_org', password: 'must-not-escape' };
    Object.assign(mocks.direct, { options });
    Object.assign(mocks.canonical, { options });
    const identity = [{ database: 'private_org', address: '127.0.0.1', port: 5432 }];
    mocks.direct.mockResolvedValue(identity);
    mocks.canonical.mockResolvedValue(identity);
  });

  it('releases the private database if filesystem setup fails before returning dispose', async () => {
    const failure = new Error('mkdir denied');
    mocks.mkdir.mockRejectedValue(failure);
    await expect(setupEngineeringEvidenceFixture()).rejects.toBe(failure);
    expect(mocks.rm).toHaveBeenCalledWith('/tmp/ee-owned', { recursive: true, force: true });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('releases the root and database when the canonical registry write fails', async () => {
    const failure = new Error('registry write failed');
    mocks.writeState.mockRejectedValue(failure);
    await expect(setupEngineeringEvidenceFixture(true)).rejects.toBe(failure);
    expect(mocks.direct).toHaveBeenCalledOnce();
    expect(mocks.canonical).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledOnce();
  });

  it('rejects a divergent canonical database before registry writes and cleans the private fixture', async () => {
    mocks.canonical.mockResolvedValue([{ database: 'foreign_org', address: '127.0.0.1', port: 5432 }]);
    await expect(setupEngineeringEvidenceFixture(true)).rejects.toThrow('database route probe failed');
    expect(mocks.writeState).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('preserves a connection failure with sanitized route metadata and releases partial state', async () => {
    const failure = new Error('CONNECT_TIMEOUT');
    mocks.canonical.mockRejectedValue(failure);
    const error = await setupEngineeringEvidenceFixture(true).catch(value => value);
    expect(error.cause).toBe(failure);
    expect(error.message).toContain('private_org');
    expect(error.message).toContain('32771');
    expect(error.message).not.toContain('must-not-escape');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('still disposes the database if root removal fails, retaining both errors', async () => {
    const setupFailure = new Error('registry failed');
    const cleanupFailure = new Error('root removal failed');
    mocks.writeState.mockRejectedValue(setupFailure);
    mocks.rm.mockRejectedValue(cleanupFailure);
    const error = await setupEngineeringEvidenceFixture(true).catch(value => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([setupFailure, cleanupFailure]);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
