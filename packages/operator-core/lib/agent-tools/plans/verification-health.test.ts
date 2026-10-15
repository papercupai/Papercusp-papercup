/**
 * plans:verification-health — verification-system-improvements-2026-10-10 P-002.
 *
 * The tool is the resolver behind the `verification.health` cell, so the properties worth
 * pinning are the ones that would make the cell silently read a DIFFERENT population:
 *   - an omitted harness reads the whole workspace, and the caller's own session harness is
 *     NOT inherited (the cell is callerRelativity: global — every reader must see one value);
 *   - the all-harness sentinel means the whole workspace, not a harness literally named "all";
 *   - an explicit harness narrows through the plan-scope seam, never a raw slug;
 *   - lane 2's two measures (D-018) are injected as-is, not re-derived.
 * The aggregation itself is covered by lib/verification-health.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  withWorkspace: vi.fn(),
  resolvePlanWriteScope: vi.fn(),
  activeWorkspaceId: vi.fn(),
  runVerificationHealth: vi.fn(),
  measureContractTriage: vi.fn(),
  measureStaleAcceptance: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: M.withWorkspace };
});
vi.mock('./_write-scope', () => ({ resolvePlanWriteScope: M.resolvePlanWriteScope }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: M.activeWorkspaceId }));
vi.mock('./contract-triage', () => ({ measureContractTriage: M.measureContractTriage }));
vi.mock('./acceptance-drain-disposition', () => ({ measureStaleAcceptance: M.measureStaleAcceptance }));
vi.mock('../../verification-health', () => ({ runVerificationHealth: M.runVerificationHealth }));

import tool, { VERIFICATION_HEALTH_MEASURES, resolveVerificationHealthScope } from './verification-health';

const TX = { tag: 'tx' };
const REPORT = { health: { contractCoverage: { overall: 0.5 } }, breaches: [] };

beforeEach(() => {
  vi.clearAllMocks();
  M.withWorkspace.mockImplementation(async (_ws: string, fn: (tx: unknown) => unknown) => fn(TX));
  M.runVerificationHealth.mockResolvedValue(REPORT);
  M.activeWorkspaceId.mockReturnValue('ws-active');
  M.resolvePlanWriteScope.mockResolvedValue({ workspaceId: 'ws-scoped', harnessSlug: 'papercusp' });
});

describe('resolveVerificationHealthScope — which population the cell reads', () => {
  it('omitted harness reads the whole workspace and does NOT inherit the session harness', async () => {
    const scope = await resolveVerificationHealthScope(undefined, { workspaceId: 'ws-ctx', harnessSlug: 'sidestage' });
    expect(scope).toEqual({ workspaceId: 'ws-ctx', harnessSlug: null });
    expect(M.resolvePlanWriteScope).not.toHaveBeenCalled();
  });

  it.each(['all', '*', ' ALL '])('the sentinel %j means the whole workspace', async (sentinel) => {
    const scope = await resolveVerificationHealthScope(sentinel, { workspaceId: 'ws-ctx' });
    expect(scope).toEqual({ workspaceId: 'ws-ctx', harnessSlug: null });
    expect(M.resolvePlanWriteScope).not.toHaveBeenCalled();
  });

  it('falls back to the active workspace when the context carries none', async () => {
    expect(await resolveVerificationHealthScope(undefined, {})).toEqual({ workspaceId: 'ws-active', harnessSlug: null });
    expect(await resolveVerificationHealthScope(undefined, null)).toEqual({ workspaceId: 'ws-active', harnessSlug: null });
  });

  it('an explicit harness narrows through the plan-scope seam, not as a raw slug', async () => {
    M.resolvePlanWriteScope.mockResolvedValue({ workspaceId: 'ws-scoped', harnessSlug: 'papercusp' });
    const scope = await resolveVerificationHealthScope('engineering', { workspaceId: 'ws-ctx' });
    expect(M.resolvePlanWriteScope).toHaveBeenCalledTimes(1);
    expect(scope).toEqual({ workspaceId: 'ws-scoped', harnessSlug: 'papercusp' });
  });
});

describe('plans:verification-health handler', () => {
  it('runs the report inside the resolved workspace with lane 2 measures injected, and returns it as JSON text', async () => {
    const out = (await tool.handler({} as never, { workspaceId: 'ws-ctx', harnessSlug: 'sidestage' } as never)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(M.withWorkspace).toHaveBeenCalledWith('ws-ctx', expect.any(Function));
    expect(M.runVerificationHealth).toHaveBeenCalledWith(
      TX,
      { workspaceId: 'ws-ctx', harnessSlug: null },
      VERIFICATION_HEALTH_MEASURES,
    );
    expect(out.content).toHaveLength(1);
    expect(out.content[0].type).toBe('text');
    expect(JSON.parse(out.content[0].text)).toEqual(REPORT);
  });

  it('a measurement failure inside the report propagates rather than being reported as a clean zero', async () => {
    M.runVerificationHealth.mockRejectedValue(new Error('pg down'));
    await expect(tool.handler({} as never, { workspaceId: 'ws-ctx' } as never)).rejects.toThrow('pg down');
  });

  it('is a read-only resolver (the cell dispatcher refuses write-capable tools)', () => {
    expect(tool.name).toBe('plans:verification-health');
    expect(tool.capability).toBe('intel:read');
  });
});

describe('VERIFICATION_HEALTH_MEASURES — lane 2 measures forwarded unchanged (D-018)', () => {
  it('forwards the transaction and args to measureContractTriage', async () => {
    M.measureContractTriage.mockResolvedValue({ triageGaps: 1 });
    const args = { workspaceId: 'ws', harnessSlug: null };
    await expect(VERIFICATION_HEALTH_MEASURES.measureContractTriage(TX as never, args as never)).resolves.toEqual({
      triageGaps: 1,
    });
    expect(M.measureContractTriage).toHaveBeenCalledWith(TX, args);
  });

  it('forwards the transaction and args to measureStaleAcceptance', async () => {
    M.measureStaleAcceptance.mockResolvedValue({ staleAcceptanceUndispositioned: 0 });
    const args = { workspaceId: 'ws', harnessSlug: 'papercusp' };
    await expect(VERIFICATION_HEALTH_MEASURES.measureStaleAcceptance(TX as never, args as never)).resolves.toEqual({
      staleAcceptanceUndispositioned: 0,
    });
    expect(M.measureStaleAcceptance).toHaveBeenCalledWith(TX, args);
  });
});
