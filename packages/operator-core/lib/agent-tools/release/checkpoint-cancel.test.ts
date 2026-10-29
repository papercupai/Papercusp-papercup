/**
 * release:checkpoint-cancel — exact attempt/unit cancellation for a detached
 * green-checkpoint runner. The barrel import is intentional: a direct import
 * would make the registration guard pass even if the production wiring were
 * removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAgentIdentity: vi.fn(),
  resolveCheckpointRouting: vi.fn(),
  activeWorkspaceId: vi.fn(),
  operatorHomeHarnessSlug: vi.fn(),
  integrationRoot: vi.fn(),
  checkpointUnitForRoot: vi.fn(),
  terminateActiveCheckpointUnit: vi.fn(),
  cancelStoredQualification: vi.fn(),
}));

vi.mock('../coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/identity')>()),
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: mocks.activeWorkspaceId,
}));
vi.mock('../../harness/operator-home-harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: mocks.operatorHomeHarnessSlug,
}));
vi.mock('../../harness/routines/hive-release-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/routines/hive-release-env')>()),
  resolveCheckpointRouting: mocks.resolveCheckpointRouting,
}));
vi.mock('../../release-deploy-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-deploy-launch')>()),
  integrationRoot: mocks.integrationRoot,
}));
vi.mock('../../release-checkpoint-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release-checkpoint-launch')>()),
  checkpointUnitForRoot: mocks.checkpointUnitForRoot,
  terminateActiveCheckpointUnit: mocks.terminateActiveCheckpointUnit,
}));
vi.mock('../../release/checkpoint-qualification-transaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/checkpoint-qualification-transaction')>()),
  cancelStoredQualification: mocks.cancelStoredQualification,
}));

import { lookupByMcpName } from '@papercusp/tooldef';
import '../index';

const UNIT = 'papercup-green-checkpoint-manual-expected.service';
const SCHEDULED_SCOPE = 'papercusp-checkpoint-8bf9f42e-e478-425b-80d8-2dd14e915511.scope';
const ATTEMPT = 'attempt-1';
const CTX = {
  role: 'su',
  isSuperuser: true,
  log: vi.fn(),
  signal: new AbortController().signal,
} as never;

// Accepts EITHER shape (the 07-26 parseTextPayload pattern): this tool now returns the
// canonical { data } envelope, but the reader stays shape-agnostic so it does not have to
// be re-edited by the next migration in either direction.
const body = (result: unknown) => {
  const r = result as { data?: unknown; content?: Array<{ text: string }> };
  return (r.data !== undefined ? r.data : JSON.parse(r.content![0]!.text)) as Record<string, unknown>;
};

async function loadTool() {
  return (await import('./checkpoint-cancel')).default;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-test', workspaceId: 'ws-identity' });
  mocks.activeWorkspaceId.mockReturnValue('ws-1');
  mocks.operatorHomeHarnessSlug.mockReturnValue('papercusp');
  mocks.integrationRoot.mockReturnValue('/tooling-root');
  mocks.checkpointUnitForRoot.mockReturnValue('papercup-green-checkpoint-manual-expected');
  mocks.resolveCheckpointRouting.mockResolvedValue({
    root: '/routing-root',
    extraEnv: { PAPERCUSP_INTEGRATION_ROOT: '/subject-root' },
    clearEnv: [],
  });
  mocks.terminateActiveCheckpointUnit.mockReturnValue({ stopped: true });
  mocks.cancelStoredQualification.mockImplementation(async (
    _target: unknown,
    _input: unknown,
    stop: () => Promise<{ stopped: boolean }> | { stopped: boolean },
  ) => {
    const stopped = await stop();
    return stopped.stopped
      ? {
          status: 'updated',
          transaction: {
            outcome: { kind: 'code-inconclusive', reason: 'unsafe candidate' },
          },
        }
      : {
          status: 'stop-failed',
          transaction: {},
          error: 'stop did not complete',
        };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('release:checkpoint-cancel registration', () => {
  it('is reachable through the agent-tools barrel', () => {
    const registered = lookupByMcpName('release:checkpoint-cancel');
    expect(registered, 'release:checkpoint-cancel missing from the agent-tools barrel').toBeTruthy();
    expect(registered).toMatchObject({
      capabilities: ['operator:write'],
      agentRoles: expect.arrayContaining(['worker', 'operator', 'release-fixer', 'release-manager']),
      expose: { mcp: { name: 'release:checkpoint-cancel' } },
    });
  });
});

describe('release:checkpoint-cancel handler', () => {
  it('requires the exact attempt and canonical unit in its published schema', async () => {
    const tool = await loadTool();
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: UNIT }).success).toBe(true);
    expect(tool.args.safeParse({ attemptId: ATTEMPT }).success).toBe(false);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: 'other-unit.service' }).success).toBe(false);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: UNIT, reason: 'unsafe candidate' }).success).toBe(true);
    // WI-6554700010042670: a scheduled run's recorded scope is accepted; other scopes are not.
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: SCHEDULED_SCOPE }).success).toBe(true);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: 'pc-0mvsabc.scope' }).success).toBe(false);
    expect(tool.args.safeParse({ attemptId: ATTEMPT, unit: 'papercusp-checkpoint-8bf9f42e.service' }).success).toBe(false);
  });

  it('cancels a scheduled run by its exact recorded scope, without the manual canonical-name check', async () => {
    const tool = await loadTool();
    const result = body(await tool.handler({ attemptId: ATTEMPT, unit: SCHEDULED_SCOPE } as never, CTX));

    expect(result).toMatchObject({ ok: true, cancelled: true, attempt_id: ATTEMPT, unit: SCHEDULED_SCOPE });
    expect(mocks.cancelStoredQualification).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      expect.objectContaining({ attemptId: ATTEMPT, unit: SCHEDULED_SCOPE }),
      expect.any(Function),
    );
    expect(mocks.terminateActiveCheckpointUnit).toHaveBeenCalledWith(SCHEDULED_SCOPE);
  });

  it('fails closed when caller identity cannot be resolved', async () => {
    const tool = await loadTool();
    mocks.resolveAgentIdentity.mockImplementationOnce(() => {
      throw new Error('missing identity');
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: UNIT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'authentication_required',
    });
    expect(mocks.resolveCheckpointRouting).not.toHaveBeenCalled();
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
  });

  it('rejects a unit that is syntactically valid but not the canonical routed target', async () => {
    const tool = await loadTool();
    const requested = 'papercup-green-checkpoint-manual-other.service';

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: requested } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'unit_mismatch',
      attempt_id: ATTEMPT,
      unit: requested,
    });
    expect(mocks.cancelStoredQualification).not.toHaveBeenCalled();
  });

  it('passes the exact target to the store, signals the exact unit, and preserves the queue', async () => {
    const tool = await loadTool();
    const result = body(await tool.handler({
      attemptId: ATTEMPT,
      unit: UNIT,
      reason: 'candidate omitted qualification blobs',
    } as never, CTX));

    expect(result).toMatchObject({
      ok: true,
      cancelled: true,
      attempt_id: ATTEMPT,
      unit: UNIT,
      outcome: { kind: 'code-inconclusive', reason: 'unsafe candidate' },
      repair_queue: 'preserved',
    });
    expect(mocks.resolveCheckpointRouting).toHaveBeenCalledWith(
      { installSlug: 'papercusp', workspaceId: 'ws-1' },
      '/tooling-root',
    );
    expect(mocks.cancelStoredQualification).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      {
        attemptId: ATTEMPT,
        unit: UNIT,
        reason: 'candidate omitted qualification blobs',
        evidenceRefs: ['tool:release:checkpoint-cancel'],
      },
      expect.any(Function),
    );
    expect(mocks.terminateActiveCheckpointUnit).toHaveBeenCalledWith('papercup-green-checkpoint-manual-expected');
  });

  it('maps an exact attempt/unit CAS conflict without signalling a unit', async () => {
    const tool = await loadTool();
    mocks.cancelStoredQualification.mockResolvedValueOnce({
      status: 'conflict',
      transaction: {},
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: UNIT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'exact_attempt_unit_mismatch',
    });
    expect(mocks.terminateActiveCheckpointUnit).not.toHaveBeenCalled();
  });

  it('leaves the logical row unchanged when the protected stop fails', async () => {
    const tool = await loadTool();
    mocks.cancelStoredQualification.mockResolvedValueOnce({
      status: 'stop-failed',
      transaction: { outcome: { kind: 'pending' } },
      error: 'systemd kill exited 4',
    });

    expect(body(await tool.handler({ attemptId: ATTEMPT, unit: UNIT } as never, CTX))).toMatchObject({
      ok: false,
      cancelled: false,
      refused: true,
      reason: 'stop_failed',
      error: 'systemd kill exited 4',
    });
  });
});
