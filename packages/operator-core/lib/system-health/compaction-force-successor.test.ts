import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_EXPECTED_SUCCESSOR_BINDING } from '../agent-launch-core';

const mocks = vi.hoisted(() => ({
  withWorkspace: vi.fn(async (_workspaceId: string, run: (tx: unknown) => Promise<unknown>) => run({ tx: true })),
  lookupByMcpName: vi.fn((_name: string) => ({ name: 'capability:launch-agent' })),
  dispatch: vi.fn(),
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
  });

  it('uses the exact source scope and internal expected binding, and requires positive first-turn proof', async () => {
    const brief = 'Continue after the forced compaction boundary.';
    const result = await dispatchCompactionForceSuccessor({ target, brief });

    expect(result.verified).toBe(true);
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
});
