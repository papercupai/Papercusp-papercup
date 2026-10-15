import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSystemAction } from '../harness/routines/system-actions';

const mocks = vi.hoisted(() => ({
  runCensus: vi.fn(),
  loadHarnessRegistry: vi.fn(),
  resolveHarnessContentPath: vi.fn(),
  notifySyncInvalidate: vi.fn(),
}));

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
vi.mock('@papercusp/testing-shell/census', () => ({ runCensus: mocks.runCensus }));
vi.mock('./pg-store', () => ({ createPgCensusStore: () => ({}) }));
vi.mock('./provider-registry', () => ({ censusProviders: () => [] }));
vi.mock('./scope', () => ({
  resolveCensusScope: () => ({ workspaceId: 'workspace', harnessSlug: 'target-pot' }),
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: mocks.notifySyncInvalidate }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: mocks.loadHarnessRegistry,
  resolveHarnessContentPath: mocks.resolveHarnessContentPath,
}));

import '../harness/routines/coverage-census-action';

const ctx = { installSlug: '@singleton', workspaceId: 'workspace', triggerConfig: {}, payloadTemplate: null };

describe('coverage census action repository root', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadHarnessRegistry.mockResolvedValue({ projects: [] });
    mocks.resolveHarnessContentPath.mockReturnValue('/target-pot');
    mocks.runCensus.mockResolvedValue({
      failedProviders: [], unimplementedProviders: [], ranProviders: [],
      diff: { retirableKinds: [] }, applied: { upserted: 1, retired: 0 },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('runs the scoped harness census from its registered content root when bg-host cwd is nested', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/target-pot/apps/operator');
    const registry = { projects: [{ slug: 'target-pot', path: '/target-pot' }] };
    mocks.loadHarnessRegistry.mockResolvedValue(registry);

    await getSystemAction('coverage-census')!(ctx);

    expect(mocks.resolveHarnessContentPath).toHaveBeenCalledWith(registry, 'target-pot');
    expect(mocks.runCensus).toHaveBeenCalledWith(expect.objectContaining({
      repoRoot: '/target-pot', scope: { workspaceId: 'workspace', harnessSlug: 'target-pot' },
    }));
    expect(mocks.notifySyncInvalidate).toHaveBeenCalledWith('testing.coverage');
  });

  it('rejects an unknown content root before a census can overwrite source attribution', async () => {
    mocks.resolveHarnessContentPath.mockReturnValue(undefined);

    await expect(getSystemAction('coverage-census')!(ctx))
      .rejects.toThrow('no registered content root for target-pot');

    expect(mocks.runCensus).not.toHaveBeenCalled();
    expect(mocks.notifySyncInvalidate).not.toHaveBeenCalled();
  });
});
