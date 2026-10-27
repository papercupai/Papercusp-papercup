/**
 * WI-10003688 recurrence guard (integration tier): a REAL embedded postmaster that is
 * SIGKILLed comes back on its own, and stop() never hangs on a postmaster that is
 * already dead.
 *
 * Measured 2026-09-28 on the Mac rig VM: the postmaster died on ENOSPC and nothing
 * restarted it, so the operator ran against a dead database for over an hour. The
 * unit tier (embedded-pg-supervisor.test.ts) covers disk-full classification and the
 * never-give-up backoff; this tier proves the wiring inside startEmbeddedPostgresServer.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, Socket } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { startEmbeddedPostgresServer } from '@papercusp/embedded-postgres-server';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessIdentity } from './process-identity';
import { privateBundleRuntimeEnv, stopPrivateOperatorHost, type PrivateHostStopObservation } from '../test/private-http-workspace-preflight';

// A workspace-local install can give the server its own embedded-postgres copy.
// Inject failures into that exact constructor, not the root test dependency.
const serverRequire = createRequire(import.meta.resolve('@papercusp/embedded-postgres-server'));
const { default: EmbeddedPostgres } = await import(serverRequire.resolve('embedded-postgres'));

const cleanups: Array<() => Promise<unknown>> = [];

afterAll(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('free-port probe returned no TCP address'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function postmasterPid(dataDir: string): Promise<number> {
  const first = (await readFile(join(dataDir, 'postmaster.pid'), 'utf8')).split('\n')[0];
  const pid = Number(first);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad postmaster.pid first line: ${first}`);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

async function selectOne(port: number, password: string): Promise<boolean> {
  const sql = postgres({ host: '127.0.0.1', port, user: 'postgres', password, database: 'papercusp', max: 1, connect_timeout: 2 });
  try {
    const rows = await sql`SELECT 1 AS one`;
    return rows[0]?.one === 1;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function portAccepting(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function boot(prefix: string, extra: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  const logs: string[] = [];
  const handle = await startEmbeddedPostgresServer({
    dataDir,
    port,
    onLog: (m: string) => logs.push(m),
    ...extra,
  });
  cleanups.push(() => handle.stop());
  return { dataDir, port, logs, handle };
}

describe('embedded-PG postmaster supervision (WI-10003688)', () => {
  it.skipIf(process.platform !== 'linux')('reaps real PostgreSQL after a deadline-exited private host closes redirected output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'papercusp-pg-parent-exit-'));
    const port = await freePort();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import EmbeddedPostgres from ${JSON.stringify(serverRequire.resolve('embedded-postgres'))};
      import {spawn} from 'node:child_process';
      import {once} from 'node:events';
      const pg = new EmbeddedPostgres({databaseDir:${JSON.stringify(dataDir)},port:${port},
        persistent:true,user:'postgres',password:'private-fixture',
        initdbFlags:['--locale=C','--encoding=UTF8'],onLog:()=>{},onError:()=>{}});
      await pg.initialise(); await pg.start();
      // Reproduce a parent deadline while PG is still alive, independently of
      // the product's schema, MCP, or P536 artifact. Redirect both PG streams.
      const binary=pg.process.spawnfile,args=pg.process.spawnargs.slice(1);
      await pg.stop();
      const native=spawn(binary,args,{stdio:'ignore'});
      await once(native,'spawn');
      process.on('SIGTERM',()=>process.kill(process.pid,'SIGKILL'));
      process.stdout.write(JSON.stringify({pid:native.pid})+'\\n');
      setInterval(()=>{},1000);
    `], { env: privateBundleRuntimeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let pid: number | undefined, identity: string | null = null;
    let stderr = '';
    child.stderr!.setEncoding('utf8'); // boundary-safe decode (WI-6728)
    child.stderr!.on('data', chunk => { stderr += chunk; });
    try {
      const ready = await Promise.race([
        once(child.stdout!, 'data'),
        closed.then(() => { throw new Error('private PG fixture exited before readiness: ' + stderr); }),
      ]);
      pid = JSON.parse(String(ready[0])).pid;
      identity = readProcessIdentity(pid!);
      expect(identity).toBeTruthy();
      const sql = postgres({host:'127.0.0.1',port,user:'postgres',password:'private-fixture',
        database:'postgres',max:1,connect_timeout:2});
      try { await waitFor('native private postmaster readiness', async () => {
        try { return (await sql`SELECT 1 AS one`)[0]?.one === 1; }
        catch { return false; }
      }, 10_000); }
      finally { await sql.end({timeout:1}); }
      const observations: PrivateHostStopObservation[] = [];
      await stopPrivateOperatorHost(child, undefined, 5000, o => observations.push(o));
      // A reparented zombie is no longer executable even if PID 1 has not
      // reaped it yet; the maintained helper checks the exact kernel state.
      expect(observations.at(-1)?.postgres?.every(p => p.state === null || p.state === 'Z' || p.state === 'X')).toBe(true);
      expect(await portAccepting(port)).toBe(false);
      await expect(readFile(join(dataDir, 'postmaster.pid'), 'utf8')).rejects.toMatchObject({code:'ENOENT'});
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({phase:'postgres captured'}),
        expect.objectContaining({phase:'postgres stopped'}),
        expect.objectContaining({phase:'complete'}),
      ]));
      expect(observations.find(o => o.phase === 'postgres captured')?.postgres?.length).toBeGreaterThan(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (pid && identity && readProcessIdentity(pid) === identity) {
        try { process.kill(pid, 'SIGINT'); } catch { /* already stopped */ }
        await waitFor('original private postmaster cleanup', () => !isAlive(pid!) || !existsSync(join(dataDir,'postmaster.pid')), 10_000);
      }
      await closed;
      await rm(dataDir, {recursive:true,force:true});
    }
  }, 120_000);

  it('gracefully stops the postmaster when boot fails before returning a handle', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'papercusp-pg-startup-failure-'));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    const dataDir = join(workDir, 'pgdata');
    const port = await freePort();
    const migrationDir = join(workDir, 'migrations');
    await mkdir(migrationDir);
    await writeFile(join(migrationDir, '001-failure.sql'), 'SELECT 1 / 0;\n', 'utf8');
    const logs: string[] = [];

    await expect(
      startEmbeddedPostgresServer({
        dataDir,
        port,
        dbSqlDir: migrationDir,
        onLog: (message: string) => logs.push(message),
      }),
    ).rejects.toThrow(/Migration 001-failure\.sql FAILED: division by zero/);

    expect(logs.some((message) => message.includes('apply 001-failure.sql'))).toBe(true);
    await waitFor('failed startup postmaster to stop accepting connections', async () => !(await portAccepting(port)), 10_000);
    await expect(readFile(join(dataDir, 'postmaster.pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('propagates a low-level stop rejection and remains available for explicit cleanup', async () => {
    const { dataDir, port, handle } = await boot('papercusp-pg-stop-rejection-');
    const pid = await postmasterPid(dataDir);
    const cause = new Error('fixture_low_level_postgres_stop_failure');
    const stop = vi.spyOn(EmbeddedPostgres.prototype, 'stop').mockRejectedValueOnce(cause);
    try {
      await expect(handle.stop()).rejects.toBe(cause);
      expect(stop).toHaveBeenCalledOnce();
      expect(handle.health()).toMatchObject({ state: 'stopped' });
      expect(isAlive(pid)).toBe(true);
      expect(await selectOne(port, handle.password)).toBe(true);
    } finally {
      stop.mockRestore();
    }
    await handle.stop();
    await waitFor('the explicitly cleaned postmaster to stop', () => !isAlive(pid), 10_000);
  }, 120_000);

  it('restarts a SIGKILLed postmaster and serves queries again without an operator restart', async () => {
    const exits: Array<{ signal: string | null }> = [];
    let restarted = 0;
    const { dataDir, port, logs, handle } = await boot('papercusp-pg-supervise-', {
      restartBackoffMs: [250, 500, 1000],
      onPostgresExit: (e: { signal: string | null }) => exits.push(e),
      onPostgresRestarted: () => {
        restarted += 1;
      },
    });
    expect(await selectOne(port, handle.password)).toBe(true);
    expect(handle.health()).toMatchObject({ state: 'running', restarts: 0 });

    const before = await postmasterPid(dataDir);
    process.kill(before, 'SIGKILL');
    await waitFor('the killed postmaster to be gone', () => !isAlive(before), 10_000);

    await waitFor('a supervised restart', () => restarted >= 1, 60_000);
    expect(exits[0]).toMatchObject({ signal: 'SIGKILL' });
    await waitFor('the restarted postmaster to answer SELECT 1', () => selectOne(port, handle.password), 30_000);

    const after = await postmasterPid(dataDir);
    expect(after).not.toBe(before);
    expect(handle.health()).toMatchObject({ state: 'running' });
    expect(handle.health()!.restarts).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.includes('postgres exited unexpectedly'))).toBe(true);

    // A deliberate stop is not a death: nothing restarts it afterwards.
    await handle.stop();
    await waitFor('the postmaster to stop', () => !isAlive(after), 10_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await selectOne(port, handle.password)).toBe(false);
    expect(handle.health()).toMatchObject({ state: 'stopped' });
  }, 180_000);

  it('stop() returns promptly when the postmaster is already dead (unsupervised)', async () => {
    const { dataDir, handle } = await boot('papercusp-pg-deadstop-', { supervise: false });
    expect(handle.health()).toBeNull();
    const pid = await postmasterPid(dataDir);
    process.kill(pid, 'SIGKILL');
    await waitFor('the killed postmaster to be gone', () => !isAlive(pid), 10_000);
    // embedded-postgres' own stop() waits for an 'exit' event that has already fired,
    // so without the dead-child guard this await never settles.
    const outcome = await Promise.race([
      handle.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('hung'), 10_000)),
    ]);
    expect(outcome).toBe('stopped');
  }, 120_000);
});
