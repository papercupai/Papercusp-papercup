/** Default daemon cleanup against its real DB pool and pinned adapter scope. */
import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
// eslint-disable-next-line import/no-relative-packages -- maintained owned org DB fixture
import { createOrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';
import { killScopeUnit } from '@papercusp/operator-core/lib/task-manager/control';

interface Resources { dbPid: number; taskId: string }

it.runIf(process.platform === 'linux')('drains default resources before exiting, leaving no DB, socket or adapter descendants', async () => {
  const db = await createOrgTestDb();
  const catalogDsn = new URL(db.adminDsn);
  catalogDsn.pathname = '/postgres';
  const catalog = postgres(catalogDsn.toString(), { max: 1, onnotice: () => {} });
  const root = mkdtempSync(join(tmpdir(), 'lsp-default-shutdown-'));
  const socketPath = join(root, 'daemon.sock');
  const file = join(root, 'index.ts');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['index.ts'] }));
  writeFileSync(file, 'export const answer = 42;\nconsole.log(answer);\n');
  const serverPath = fileURLToPath(new URL('../../../packages/operator-core/lib/code-intelligence/lsp-daemon-server.ts', import.meta.url));
  const adapterPath = fileURLToPath(new URL('../../../packages/operator-core/lib/code-intelligence/lsp-adapter.ts', import.meta.url));
  const shutdownPath = fileURLToPath(new URL('./lsp-daemon-shutdown.ts', import.meta.url));
  const script = `
    // tsx exposes the app's CommonJS package through default, whereas the
    // operator-core and DB packages export ESM names. Normalize at this seam.
    const load = async path => { const ns = await import(path); return ns.default ?? ns; };
    const { runLspDaemonServer } = await load(${JSON.stringify(serverPath)});
    const { createLspDaemonShutdown } = await load(${JSON.stringify(shutdownPath)});
    const { lspQuery, lspClientInventory } = await load(${JSON.stringify(adapterPath)});
    const { getOrgPg } = await load('@papercusp/db-org');
    for (const fn of [runLspDaemonServer, createLspDaemonShutdown, lspQuery, lspClientInventory, getOrgPg]) {
      if (typeof fn !== 'function') throw new Error('daemon fixture import preflight failed');
    }
    (async () => {
      const sql = getOrgPg().sql;
      const [db] = await sql.unsafe('SELECT pg_backend_pid() AS pid');
      // Observe the real close; neither production resource callback is replaced.
      const end = sql.end.bind(sql);
      sql.end = async (...args) => { await end(...args); process.stdout.write('DATABASE_DRAINED\\n'); };
      const server = runLspDaemonServer(undefined, undefined, createLspDaemonShutdown());
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      await lspQuery('definition', { file: ${JSON.stringify(file)}, rootPath: ${JSON.stringify(root)}, line1: 2, character: 13 });
      const [client] = lspClientInventory();
      if (!client) throw new Error('pinned adapter failed to register a client');
      process.stdout.write('RESOURCES ' + JSON.stringify({dbPid: db.pid, taskId: client.taskId}) + '\\n');
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: db.adminDsn, HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
      HARNESS_DATABASE_URL: db.appDsn, PAPERCUSP_LSP_DAEMON_SOCKET: socketPath },
  });
  const terminal = once(child, 'exit');
  const stdioClosed = once(child, 'close');
  const output = createTextCollector(child.stdout);
  const errors = createTextCollector(child.stderr, { maxChars: 12_000 });
  let socket: Socket | undefined;
  try {
    await Promise.race([vi.waitFor(() => {
      expect(child.exitCode, errors.peek()).toBeNull();
      expect(output.peek(), errors.peek()).toMatch(/^RESOURCES .+$/m);
    }, { timeout: 60_000 }), terminal.then(([code, signal]) => {
      throw new Error(`daemon exited before resource readiness (${code}/${signal}): ${errors.peek()}`);
    })]);
    const resources = JSON.parse(output.peek().match(/^RESOURCES (.+)$/m)![1]) as Resources;
    const [task] = await db.adminSql`SELECT scope_unit, cgroup_path, confined FROM harness_shared.task_ledger WHERE task_id = ${resources.taskId}`;
    expect(task).toMatchObject({ confined: true });
    expect(task.scope_unit).toMatch(/^pc-.+\.scope$/);
    expect(task.cgroup_path).toContain(task.scope_unit);
    const procsPath = join('/sys/fs/cgroup', task.cgroup_path, 'cgroup.procs');
    let pids: number[] = [];
    await vi.waitFor(() => {
      pids = readFileSync(procsPath, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      expect(pids.some(pid => {
        try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('tsserver.js'); }
        catch { return false; }
      })).toBe(true);
    }, { timeout: 10_000 });
    expect(pids.length).toBeGreaterThanOrEqual(2);
    expect(await catalog`SELECT pid FROM pg_stat_activity WHERE pid = ${resources.dbPid}`).toHaveLength(1);
    socket = connect(socketPath);
    await once(socket, 'connect');
    const socketClosed = once(socket, 'close');
    const started = Date.now();
    child.kill('SIGTERM');
    const [code, signal] = await terminal;
    await stdioClosed;
    await socketClosed;
    expect({ code, signal }, errors.text()).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(output.text()).toContain('DATABASE_DRAINED');
    expect(errors.peek()).not.toContain('shutdown deadline exceeded');
    expect(errors.peek()).not.toContain('resource shutdown failed');
    expect(existsSync(socketPath)).toBe(false);
    await vi.waitFor(() => {
      for (const pid of pids) expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(existsSync(procsPath) ? readFileSync(procsPath, 'utf8').trim() : '').toBe('');
    }, { timeout: 2_000 });
    expect(await catalog`SELECT pid FROM pg_stat_activity WHERE pid = ${resources.dbPid}`).toHaveLength(0);
  } finally {
    socket?.destroy();
    // Even a boot/assertion failure cleans only scopes registered in our DB.
    const tasks = await db.adminSql`SELECT scope_unit FROM harness_shared.task_ledger WHERE scope_unit IS NOT NULL`;
    for (const task of tasks) await killScopeUnit(task.scope_unit, { signal: 'SIGKILL' });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await terminal;
    await stdioClosed;
    await db.cleanup();
    try {
      expect(await catalog`SELECT datname FROM pg_database WHERE datname = ${db.dbName}`).toHaveLength(0);
    } finally {
      await catalog.end({ timeout: 1 });
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 120_000);
