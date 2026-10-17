import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_EXPECTED_SUCCESSOR_BINDING } from '../agent-launch-core';

const mocks = vi.hoisted(() => ({
  withWorkspace: vi.fn(async (_workspaceId: string, run: (tx: unknown) => Promise<unknown>) => run({ tx: true })),
  lookupByMcpName: vi.fn((_name: string) => ({ name: 'capability:launch-agent' })),
  dispatch: vi.fn(),
  markAdvSessionEnded: vi.fn(async (..._args: unknown[]) => true),
  probeProcessLiveness: vi.fn((_record: unknown) => false),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: (...args: Parameters<typeof mocks.withWorkspace>) => mocks.withWorkspace(...args),
}));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  lookupByMcpName: (name: string) => mocks.lookupByMcpName(name),
}));
vi.mock('@papercusp/tooldef-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/tooldef-mcp')>()),
  dispatchProjectedToolToMcp: (...args: unknown[]) => mocks.dispatch(...args),
}));
vi.mock('../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adv-sessions')>()),
  markAdvSessionEnded: (...args: unknown[]) => mocks.markAdvSessionEnded(...args),
}));
vi.mock('../agent-tools/coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/presence')>()),
  probeProcessLiveness: (record: { host?: string | null; pid?: number | null }) => mocks.probeProcessLiveness(record),
}));
vi.mock('../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));

const { dispatchCompactionForceSuccessor } = await import('./compaction-force-successor');

const target = {
  sessionId: 'source-session',
  ompThreadId: null,
  resumeId: 'source-session',
  ownerId: 'su-force-source',
  workspaceId: 'source-workspace',
  harnessSlug: 'source-harness',
  agent: 'claude',
  role: null,
  feature: null,
  cwd: '/source',
  model: null,
  modelSource: null,
  account: null,
  headless: true,
  pid: 4242,
  display: 'terminal',
  endedAt: null,
  endedBy: null,
  live: false,
  advSessionId: 55,
  binding: {
    coordOwnerId: 'su-force-source',
    sessionId: 'source-session',
    startedAt: '2026-10-15 08:00:00.123456+00',
  },
} as const;

function verifiedLaunchResult(ownerId: string) {
  return {
    structuredContent: {
      data: {
        launch: {
          mode: 'successor',
          resumedOwnerId: ownerId,
          agentStarted: true,
          freshVerdict: {
            agentStarted: true,
            sessions: [{ ownerId, sessionId: 'successor-session' }],
          },
        },
      },
    },
  };
}

describe('hostless compaction successor dispatch', () => {
  beforeEach(() => {
    mocks.withWorkspace.mockClear();
    mocks.lookupByMcpName.mockClear();
    mocks.dispatch.mockReset();
    mocks.lookupByMcpName.mockReturnValue({ name: 'capability:launch-agent' });
    mocks.dispatch.mockResolvedValue(verifiedLaunchResult(target.ownerId));
    mocks.markAdvSessionEnded.mockReset().mockResolvedValue(true);
    mocks.probeProcessLiveness.mockReset().mockReturnValue(false);
  });

  it('uses the exact source scope and internal expected binding, and requires positive first-turn proof', async () => {
    const brief = 'Continue after the forced compaction boundary.';
    const result = await dispatchCompactionForceSuccessor({ target, brief });

    expect(result.verified).toBe(true);
    expect(mocks.probeProcessLiveness).toHaveBeenCalledWith({ host: expect.any(String), pid: 4242 });
    expect(mocks.markAdvSessionEnded).toHaveBeenCalledWith(target.advSessionId, null, 'reconciler', {
      expectedBinding: target.binding,
      throwOnError: true,
    });
    expect(mocks.lookupByMcpName).toHaveBeenCalledWith('capability:launch-agent');
    expect(mocks.withWorkspace).toHaveBeenCalledWith('source-workspace', expect.any(Function));
    const [tool, toolName, args, context] = mocks.dispatch.mock.calls[0] as [
      unknown, string, Record<string, unknown>, Record<PropertyKey, unknown>,
    ];
    expect(tool).toEqual({ name: 'capability:launch-agent' });
    expect(toolName).toBe('capability:launch-agent');
    expect(args).toMatchObject({
      successor: { agentId: target.ownerId },
      brief,
      harness: 'source-harness',
      headless: true,
      idempotencyKey: expect.stringMatching(/^compaction-force-[a-f0-9]{40}$/),
    });
    expect(context).toMatchObject({
      workspaceId: 'source-workspace',
      harnessSlug: 'source-harness',
      principal: { slug: 'system:compaction-compliance-watchdog', workspaceId: 'source-workspace' },
    });
    expect(context[INTERNAL_EXPECTED_SUCCESSOR_BINDING]).toMatchObject({
      ownerId: target.ownerId,
      advSessionId: target.advSessionId,
      workspaceId: 'source-workspace',
      harnessSlug: 'source-harness',
      binding: target.binding,
      requirePositiveTerminalEvidence: true,
    });
  });

  it('probes a local headless source when display metadata is absent', async () => {
    const headless = { ...target, display: null };

    const result = await dispatchCompactionForceSuccessor({ target: headless, brief: 'continue' });

    expect(result.verified).toBe(true);
    expect(mocks.probeProcessLiveness).toHaveBeenCalledWith({ host: expect.any(String), pid: 4242 });
    expect(mocks.markAdvSessionEnded).toHaveBeenCalledWith(headless.advSessionId, null, 'reconciler', {
      expectedBinding: headless.binding,
      throwOnError: true,
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps non-local display provenance fenced even when headless is set', async () => {
    const remote = { ...target, display: 'remote' };

    await expect(dispatchCompactionForceSuccessor({ target: remote, brief: 'continue' })).resolves.toEqual({
      verified: false,
      detail: 'the source has no live PTY host but its local terminal process death is unproven; identity-preserving replacement is refused',
    });
    expect(mocks.probeProcessLiveness).not.toHaveBeenCalled();
    expect(mocks.markAdvSessionEnded).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('does not treat an opened but unconfirmed successor as applied', async () => {
    mocks.dispatch.mockResolvedValue({
      structuredContent: {
        data: {
          launch: {
            mode: 'successor',
            resumedOwnerId: target.ownerId,
            agentStarted: null,
            freshVerdict: { agentStarted: null, sessions: [] },
          },
        },
      },
      content: [{ type: 'text', text: 'launch verification did not run' }],
    });

    await expect(dispatchCompactionForceSuccessor({ target, brief: 'continue' })).resolves.toEqual({
      verified: false,
      detail: 'launch verification did not run',
    });
  });

  it('refuses a hostless source whose recorded process is still live', async () => {
    mocks.probeProcessLiveness.mockReturnValue(true);

    await expect(dispatchCompactionForceSuccessor({ target, brief: 'continue' })).resolves.toEqual({
      verified: false,
      detail: 'the source process is still live; identity-preserving replacement is refused',
    });
    expect(mocks.markAdvSessionEnded).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a hostless source when its recorded pid or local provenance is unavailable', async () => {
    const unknown = { ...target, pid: null };

    await expect(dispatchCompactionForceSuccessor({ target: unknown, brief: 'continue' })).resolves.toEqual({
      verified: false,
      detail: 'the source has no live PTY host but its local terminal process death is unproven; identity-preserving replacement is refused',
    });
    expect(mocks.markAdvSessionEnded).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('continues when the exact hostless source was already marked ended by the reconciler', async () => {
    const ended = { ...target, endedAt: '2026-10-16T13:35:06.037Z', endedBy: 'reconciler' as const };
    mocks.markAdvSessionEnded.mockResolvedValueOnce(false);

    await expect(dispatchCompactionForceSuccessor({ target: ended, brief: 'continue' })).resolves.toEqual({
      verified: true,
      detail: 'The successor launch and first turn were positively verified.',
    });
    expect(mocks.markAdvSessionEnded).not.toHaveBeenCalled();
    expect(mocks.probeProcessLiveness).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});
