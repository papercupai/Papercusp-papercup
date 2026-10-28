import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), begin: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
    String(path).endsWith('drizzle.config.ts') || String(path).endsWith('.bin/drizzle-kit') || fs.existsSync(path) };
});
vi.mock('node:net', () => ({
  createServer: () => {
    const server = new EventEmitter();
    return Object.assign(server, {
      listen: () => { queueMicrotask(() => server.emit('listening')); },
      close: (done: () => void) => done(),
    });
  },
}));
vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (definition: unknown) => definition }));
vi.mock('../../embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://fixture' }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-fixture' }));
vi.mock('../../resource-governor/execution', async (importOriginal) => ({
  settleGovernedExecutionInBackground: (await importOriginal<typeof import('../../resource-governor/execution')>()).settleGovernedExecutionInBackground,
  beginGovernedExecution: (...args: unknown[]) => mocks.begin(...args),
  governedExecutionRuntime: () => ({ governor: {}, driver: {} }),
}));

import routes from '../routes/dev/drizzle-studio';

describe('Drizzle child admission settlement', () => {
  let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
  let finish: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.spawn.mockReset();
    mocks.begin.mockReset();
    Object.assign(Reflect.get(globalThis, '__drizzleStudioState'), {
      proc: null, lastExitStderr: '', lastExitCode: null,
    });
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: 42,
    });
    finish = vi.fn(async () => true);
    cancel = vi.fn(async () => true);
    mocks.spawn.mockReturnValue(child);
    mocks.begin.mockResolvedValue({ context: { receiptId: 'studio-receipt' }, finish, cancel });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  async function start() {
    const post = routes.find(route => route.method === 'POST')!;
    const response = post.handler(
      new Request('http://localhost/dev/drizzle-studio', { method: 'POST' }), undefined as never,
    );
    await vi.advanceTimersByTimeAsync(800);
    expect((await response).status).toBe(200);
  }

  it('recovers release after child exit without losing the stopped status', async () => {
    await start();
    finish.mockRejectedValueOnce(new Error('release unavailable'));
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledOnce();
    const get = routes.find(route => route.method === 'GET')!;
    expect(await (await get.handler(
      new Request('http://localhost/dev/drizzle-studio'), undefined as never,
    )).json()).toMatchObject({ running: false, lastExitCode: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries the original cancellation when error is followed by exit', async () => {
    await start();
    cancel.mockRejectedValueOnce(new Error('cancel unavailable'));
    child.emit('error', new Error('spawn failed'));
    child.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel.mock.calls).toEqual([
      ['drizzle studio child error: spawn failed'], ['drizzle studio child error: spawn failed'],
    ]);
    expect(finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
