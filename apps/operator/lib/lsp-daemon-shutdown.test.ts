import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createLspDaemonShutdown } from './lsp-daemon-shutdown.mts';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

const resources = vi.hoisted(() => ({ clients: vi.fn(), database: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/code-intelligence/lsp-adapter', () => ({ shutdownAllLspClients: resources.clients }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { end: resources.database } }) }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('LSP daemon resource shutdown', () => {
  it.each(['hono-host.ts', 'serve.ts', 'lsp-daemon.ts'])('loads %s shutdown named import in a real source ESM process', (entry) => {
    const entryUrl = new URL(`../bin/${entry}`, import.meta.url);
    const source = ts.createSourceFile(entry, readFileSync(entryUrl, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = source.statements.filter(ts.isImportDeclaration).filter(node =>
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(binding =>
        (binding.propertyName ?? binding.name).text === 'createLspDaemonShutdown'));
    expect(imports).toHaveLength(1);
    const moduleUrl = new URL((imports[0]!.moduleSpecifier as ts.StringLiteral).text, entryUrl);
    // Use the entrypoint's exact static named import, without namespace/default
    // normalization. Vitest's transform and branch-only tests hid this failure.
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { createLspDaemonShutdown } from ${JSON.stringify(moduleUrl.href)};
      const order = [];
      await new Promise(resolve => createLspDaemonShutdown({
        closeClients: async () => { order.push('clients'); },
        closeDatabase: async () => { order.push('database'); },
        exit: code => { if (code !== 0) throw new Error('unexpected exit'); resolve(); },
      })(async () => { order.push('rpc'); }));
      console.log(JSON.stringify(order));
    `], {
      // This child verifies the source loader seam, not Vitest's transformation.
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, signal: result.signal }, result.stderr).toEqual({ status: 0, signal: null });
    expect(JSON.parse(result.stdout.trim())).toEqual(['rpc', 'clients', 'database']);
  });

  it.each(['hono-host.ts', 'serve.ts'])('wires %s sidecar boot into the bounded resource drain', async (entry) => {
    // Execute the real divert branch without booting the rest of the host. The
    // RPC transport is the boundary; the supplied resource drain remains real.
    const path = new URL(`../bin/${entry}`, import.meta.url);
    const source = ts.createSourceFile(entry, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const branches: ts.Statement[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIfStatement(node)) {
        const condition = node.expression.getText(source).replace(/\s/g, '').replace(/"/g, "'");
        if (condition === "sidecarMode==='lsp'" || condition === "process.env.PAPERCUSP_LSP_DAEMON_MODE==='1'") {
          branches.push(node.thenStatement);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(branches).toHaveLength(1);
    const compiled = ts.transpileModule(`(async () => ${branches[0]!.getText(source)})()`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    vi.useFakeTimers();
    const order: string[] = [];
    const closeRpc = vi.fn(async () => { order.push('rpc'); });
    const exit = vi.fn(() => { order.push('exit'); });
    let shutdown: ReturnType<typeof createLspDaemonShutdown> | undefined;
    const runServer = vi.fn((_query?: unknown, _apply?: unknown, drain?: typeof shutdown) => { shutdown = drain; });
    await runInNewContext(compiled.outputText, {
      createLspDaemonShutdown: () => createLspDaemonShutdown({
        closeClients: async () => { order.push('clients'); },
        closeDatabase: async () => { order.push('database'); },
        exit,
      }),
      require: (name: string) => {
        expect(name).toBe('@papercusp/operator-core/lib/code-intelligence/lsp-daemon-server');
        return { runLspDaemonServer: runServer };
      },
      console,
      process: { exit: vi.fn() },
    });
    await vi.waitFor(() => expect(runServer).toHaveBeenCalledTimes(1));
    expect(shutdown).toBeTypeOf('function');
    shutdown!(closeRpc);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(order).toEqual(['rpc', 'clients', 'database', 'exit']);
    expect(closeRpc).toHaveBeenCalledTimes(1);
  });

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
    const modulePath = fileURLToPath(new URL('./lsp-daemon-shutdown.mts', import.meta.url));
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
        // The bundled host can install another listener. It must not keep the
        // daemon alive after the RPC listener hands off its one-shot drain.
        process.on('SIGTERM', () => {});
        process.once('SIGTERM', () => shutdown(async () => {}));
        remaining.listen(0, '127.0.0.1', () => process.stdout.write('READY\\n'));
      `;
      const child = spawn(process.execPath, ['--require', 'tsx/cjs', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // This fixture loads current TS through tsx. The inherited committed-
        // source loader rejects its CommonJS transform before the test boots.
        env: { ...process.env, NODE_OPTIONS: '' },
      });
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
