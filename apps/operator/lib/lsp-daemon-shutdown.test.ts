import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLspDaemonShutdown } from './lsp-daemon-shutdown';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

const resources = vi.hoisted(() => ({ clients: vi.fn(), database: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/code-intelligence/lsp-adapter', () => ({ shutdownAllLspClients: resources.clients }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { end: resources.database } }) }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('LSP daemon resource shutdown', () => {
  it('uses the production adapter and database cleanup when no resource callbacks are supplied', async () => {
    vi.useFakeTimers();
    resources.clients.mockResolvedValue(1);
    resources.database.mockResolvedValue(undefined);
    const exit = vi.fn();
    createLspDaemonShutdown({ exit })(async () => {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(resources.clients).toHaveBeenCalledTimes(1);
    expect(resources.database).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    expect(resources.clients.mock.invocationCallOrder[0]).toBeLessThan(resources.database.mock.invocationCallOrder[0]);
  });

  it('still closes the database and reports a synchronous client cleanup failure', async () => {
    vi.useFakeTimers();
    const error = new Error('client cleanup failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeDatabase = vi.fn(async () => {});
    const exit = vi.fn();
    createLspDaemonShutdown({ closeClients: () => { throw error; }, closeDatabase, exit })(async () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[lsp-daemon] resource shutdown failed:', error);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('closes RPC and adapter children before the database, and exits once', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let finishClients!: () => void;
    const clientsClosed = new Promise<void>(resolve => { finishClients = resolve; });
    const exit = vi.fn(() => { order.push('exit'); });
    const shutdown = createLspDaemonShutdown({
      closeClients: async () => { order.push('clients'); await clientsClosed; },
      closeDatabase: async () => { order.push('database'); },
      exit,
    });
    const closeRpc = vi.fn(async () => { order.push('rpc'); });
    shutdown(closeRpc);
    shutdown(closeRpc);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['rpc', 'clients']);
    finishClients();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['rpc', 'clients', 'database', 'exit']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closeRpc).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('keeps a deadline when adapter shutdown never settles', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const closeDatabase = vi.fn(async () => {});
    const onForceExit = vi.fn();
    createLspDaemonShutdown({
      closeClients: () => new Promise(() => {}), closeDatabase, exit, onForceExit,
    })(async () => {});
    await vi.advanceTimersByTimeAsync(7_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(onForceExit).toHaveBeenCalledTimes(1);
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('exits a real signalled process despite a remaining socket or hung cleanup', async () => {
    // The ref'd socket models the daemon's other live handles: merely closing
    // its RPC listener must not be mistaken for process termination.
    const modulePath = fileURLToPath(new URL('./lsp-daemon-shutdown.ts', import.meta.url));
    for (const hang of [false, true]) {
      const script = `
        const { createServer } = require('node:net');
        const { createLspDaemonShutdown } = require(${JSON.stringify(modulePath)});
        const remaining = createServer();
        const shutdown = createLspDaemonShutdown({
          deadlineMs: 100,
          closeClients: async () => { ${hang ? 'await new Promise(() => {});' : ''} },
          closeDatabase: async () => {},
          onForceExit: () => process.stdout.write('DEADLINE\\n'),
        });
        process.once('SIGTERM', () => shutdown(async () => {}));
        remaining.listen(0, '127.0.0.1', () => process.stdout.write('READY\\n'));
      `;
      const child = spawn(process.execPath, ['--require', 'tsx/cjs', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      const output = createTextCollector(child.stdout);
      const errors = createTextCollector(child.stderr);
      const terminal = once(child, 'exit');
      try {
        await vi.waitFor(() => expect(output.peek(), errors.peek()).toContain('READY'), { timeout: 10_000 });
        child.kill('SIGTERM');
        const [code, signal] = await terminal;
        const outputText = output.text();
        expect({ code, signal }, errors.text()).toEqual({ code: 0, signal: null });
        expect(outputText.includes('DEADLINE')).toBe(hang);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await terminal;
      }
    }
  }, 25_000);
});
