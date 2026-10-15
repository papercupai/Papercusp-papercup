import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  buildCommand: vi.fn(),
}));

vi.mock('../console-launcher', () => ({
  buildConsoleEnvelope: async () => ({ env: {}, cwd: '/fixture', greetingCmd: '' }),
}));
vi.mock('../console-spawn', () => ({ spawnHeadless: h.spawn }));
vi.mock('../mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3170' }));
vi.mock('../papercusp-root', () => ({ papercuspPathForWorkspace: () => '/fixture' }));
vi.mock('../agent-launch-core', () => ({
  buildAgentLaunchCommand: h.buildCommand,
  injectLaunchedByArg: (command: string) => ({ command }),
}));

import { launchAgentOperationWorker } from './operation-agent-placement';

const placement = {
  receiptId: 1, workspaceId: 'fixture', harnessSlug: 'app', operationId: 'draft',
  specificationRevision: 'a'.repeat(64), workItemId: 'WI-fixture', role: 'draft-worker',
  ownerId: 'su-fixture', attempt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.buildCommand.mockReturnValue('psu fixture');
  h.spawn.mockResolvedValue({ status: 'ok' });
});

describe('accepted operation placement uses its pinned model policy (WI-10007071)', () => {
  it('launches a pinned Codex model on Codex, not the historical Claude default', async () => {
    const candidate = { ...placement, modelPolicy: {
      mode: 'exact' as const, models: ['gpt-6.1'], effort: 'high', onUnavailable: 'fail' as const,
    } };
    await expect(launchAgentOperationWorker(candidate)).resolves.toEqual({ ok: true });
    expect(h.buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex', model: 'gpt-6.1:high', account: 'auto',
      role: placement.role, feature: placement.workItemId,
    }));
    expect(h.spawn).toHaveBeenCalledOnce();
    expect(h.spawn.mock.calls[0]?.[0]?.envelope.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
  });

  it('preserves the historical backend default when no model policy was accepted', async () => {
    await launchAgentOperationWorker(placement);
    expect(h.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }));
    expect(h.buildCommand.mock.calls[0]?.[0]).not.toHaveProperty('model');
  });

  it('launches the first pinned Anthropic preference without substituting another model', async () => {
    await launchAgentOperationWorker({ ...placement, modelPolicy: {
      mode: 'preferred', models: ['claude-sonnet-5', 'gpt-6.1'], effort: 'high', onUnavailable: 'wait',
    } });
    expect(h.buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude', model: 'claude-sonnet-5:high',
    }));
  });

  it('refuses an unsupported pinned provider before spawning rather than falling back to Claude', async () => {
    const candidate = { ...placement, modelPolicy: {
      mode: 'exact' as const, models: ['other-provider/unknown'], onUnavailable: 'fail' as const,
    } };
    await expect(launchAgentOperationWorker(candidate)).rejects.toThrow();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.buildCommand).not.toHaveBeenCalled();
  });
});
