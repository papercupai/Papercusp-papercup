import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ reserve: vi.fn(), run: vi.fn() }));
vi.mock('./workspace-host/hosted-agent-admission-client', () => ({ reserveHostedAgentSlot: mocks.reserve }));
vi.mock('@papercusp/papercusp-shared/agent', async (original) => ({
  ...await original<object>(), runAgentChat: mocks.run,
}));
import { runAgentChat, type RunAgentChatOptions } from './agent-chat-stream';

describe('hosted chat CLI admission at actual spawn', () => {
  beforeEach(() => {
    vi.stubEnv('PAPERCUSP_FAKE_LLM', '');
    vi.clearAllMocks();
    mocks.reserve.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());
  const collect = async (options: Partial<RunAgentChatOptions> = {}) => {
    const events = [];
    for await (const event of runAgentChat({ promptText: 'test', ...options })) events.push(event);
    return events;
  };

  it('keeps the charge until process exit even after the reply stream ends', async () => {
    const order: string[] = [];
    const release = vi.fn(async () => {});
    mocks.reserve.mockImplementation(async () => { order.push('reserve'); return {
      start: async () => { order.push('start'); }, finish: release };
    });
    mocks.run.mockImplementation(async function* (options: RunAgentChatOptions) {
      await options.spawnProcess!('cli', [], {}); yield { type: 'delta', text: 'reply' };
    });
    const child = new EventEmitter() as ChildProcess;
    await collect({ spawnProcess: async () => { order.push('spawn'); return child; } });
    expect(order).toEqual(['reserve', 'start', 'spawn']);
    expect(release).not.toHaveBeenCalled();
    child.emit('exit', 0, null); child.emit('error', new Error('late notification'));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it('refuses the child when quota is unavailable and settles a failed spawn', async () => {
    mocks.run.mockImplementation(async function* (options: RunAgentChatOptions) {
      await options.spawnProcess!('cli', [], {});
    });
    const spawn = vi.fn(async () => { throw new Error('spawn failed'); });
    mocks.reserve.mockRejectedValueOnce(new Error('quota refused'));
    await expect(collect({ spawnProcess: spawn })).rejects.toThrow('quota refused');
    expect(spawn).not.toHaveBeenCalled();
    const release = vi.fn(async () => {});
    mocks.reserve.mockResolvedValueOnce({ start: vi.fn(async () => {}), finish: release });
    await expect(collect({ spawnProcess: spawn })).rejects.toThrow('spawn failed');
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not charge stateless HTTP turns that never spawn a CLI', async () => {
    mocks.run.mockImplementation(async function* () { yield { type: 'delta', text: 'HTTP response' }; });
    expect(await collect()).toEqual([{ type: 'delta', text: 'HTTP response' }]);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
