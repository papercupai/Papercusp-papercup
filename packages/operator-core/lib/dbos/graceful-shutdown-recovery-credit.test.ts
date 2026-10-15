/**
 * WI-10004954 — unit half of the graceful-shutdown recovery credit.
 *
 * 1. PIN: the credit is only correct while the installed DBOS SDK charges an attempt on
 *    every dequeue, re-enqueues an executor's PENDING workflows on boot, and dead-letters
 *    at `claimedAttempts > maxRecoveryAttempts + 1`. If an SDK upgrade changes any of
 *    those, this fails so the credit is re-derived instead of silently over- or
 *    under-crediting.
 * 2. The signal half: the marker is on disk SYNCHRONOUSLY by the time the signal emit
 *    returns, ahead of every other listener. The first version credited over PG inside
 *    the handler and was killed mid-flight by the drain's self-SIGKILL (2026-10-01
 *    18:14:25Z); the "durable before emit returns" assertions are what fail for any
 *    design that defers the evidence to an await.
 * 3. The boot half: only a fresh marker of THIS executor from ANOTHER process credits,
 *    the marker is consumed before the credit, and every other case leaves the attempt
 *    counted.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRACEFUL_SHUTDOWN_MARKER_MAX_AGE_MS,
  GRACEFUL_SHUTDOWN_MARKER_SCHEMA,
  armGracefulShutdownMarker,
  consumeGracefulShutdownCredit,
  defaultGracefulShutdownMarkerDir,
  gracefulShutdownMarkerPath,
} from './graceful-shutdown-recovery-credit';

const require = createRequire(import.meta.url);

function sdkSource(file: string): string {
  // The SDK's `exports` map hides package.json; its main entry lives in dist/src.
  const srcDir = dirname(require.resolve('@dbos-inc/dbos-sdk'));
  return readFileSync(join(srcDir, file), 'utf8');
}

describe('DBOS SDK recovery-attempt semantics the credit depends on', () => {
  it('charges recovery_attempts on the dequeue claim flip', () => {
    const sysdb = sdkSource('system_database.js');
    expect(sysdb).toMatch(/recovery_attempts = recovery_attempts \+ 1/);
  });

  it('re-enqueues an executor\'s PENDING workflows on boot recovery', () => {
    expect(sdkSource('dbos-executor.js')).toContain('reenqueueWorkflowsForRecovery');
  });

  it('dead-letters once claimed attempts exceed maxRecoveryAttempts + 1', () => {
    expect(sdkSource('dbos-executor.js')).toContain('claimedAttempts > maxRecoveryAttempts + 1');
  });
});

type BeginFn = (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;

function fakeSql(result: () => Promise<{ workflow_uuid: string }[]>): { begin: BeginFn } {
  const tx = Object.assign(
    (() => result()) as unknown as (...args: unknown[]) => Promise<{ workflow_uuid: string }[]>,
    { unsafe: async () => [] },
  );
  return { begin: async (cb) => cb(tx) };
}

function fakeProc(): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  const em = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  em.pid = 4242;
  em.kill = vi.fn();
  return em;
}

const EXEC = 'bg-host-3270';
const NOW = 1_790_880_000_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbos-graceful-credit-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function markerFile(): string {
  return gracefulShutdownMarkerPath(dir, EXEC);
}

function arm(proc: ReturnType<typeof fakeProc>, extra: { log?: () => void; warn?: () => void; markerDir?: string } = {}) {
  return armGracefulShutdownMarker({
    executorId: EXEC,
    markerDir: extra.markerDir ?? dir,
    proc: proc as never,
    now: () => NOW,
    log: extra.log ?? vi.fn(),
    warn: extra.warn ?? vi.fn(),
  });
}

describe('armGracefulShutdownMarker (signal half)', () => {
  it('has the marker on disk by the time the SIGTERM emit returns, with no await', () => {
    const proc = fakeProc();
    proc.on('SIGTERM', () => {}); // the host's own drain handler
    arm(proc);

    proc.emit('SIGTERM');

    // Synchronously, before any microtask: a self-SIGKILL here must not lose the evidence.
    expect(existsSync(markerFile())).toBe(true);
    const marker = JSON.parse(readFileSync(markerFile(), 'utf8'));
    expect(marker).toEqual({
      schema: GRACEFUL_SHUTDOWN_MARKER_SCHEMA,
      executorId: EXEC,
      pid: 4242,
      signal: 'SIGTERM',
      at: NOW,
    });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('runs ahead of a drain handler that was registered first', () => {
    const proc = fakeProc();
    let markerSeenByDrain: boolean | null = null;
    proc.on('SIGTERM', () => {
      // The drain may SIGKILL the process from here; the marker must already exist.
      markerSeenByDrain = existsSync(markerFile());
    });
    arm(proc);

    proc.emit('SIGTERM');

    expect(markerSeenByDrain).toBe(true);
  });

  it('fires once across SIGTERM then SIGINT', () => {
    const proc = fakeProc();
    proc.on('SIGTERM', () => {});
    proc.on('SIGINT', () => {});
    const log = vi.fn();
    arm(proc, { log });

    proc.emit('SIGTERM');
    proc.emit('SIGINT');

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(markerFile(), 'utf8')).signal).toBe('SIGTERM');
  });

  it('re-raises the signal right after the write when it is the only listener', () => {
    const proc = fakeProc();
    arm(proc);

    proc.emit('SIGINT');

    expect(existsSync(markerFile())).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith(4242, 'SIGINT');
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });

  it('warns, and still re-raises, when the marker cannot be written', () => {
    const proc = fakeProc();
    const warn = vi.fn();
    // A FILE where the marker directory should be: mkdir fails.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    arm(proc, { warn, markerDir: join(blocked, 'run') });

    proc.emit('SIGTERM');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('counts as a recovery attempt'));
    expect(proc.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('disarm removes both listeners', () => {
    const proc = fakeProc();
    const disarm = arm(proc);
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);
    disarm();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });

  it('defaults the marker directory to $PAPERCUSP_HOME/run', () => {
    expect(defaultGracefulShutdownMarkerDir({ PAPERCUSP_HOME: '/x/.papercusp' })).toBe('/x/.papercusp/run');
  });
});

function writeMarker(over: Record<string, unknown> = {}): void {
  writeFileSync(
    markerFile(),
    JSON.stringify({
      schema: GRACEFUL_SHUTDOWN_MARKER_SCHEMA,
      executorId: EXEC,
      pid: 1111,
      signal: 'SIGTERM',
      at: NOW - 40_000,
      ...over,
    }),
  );
}

function consume(credit: () => Promise<{ workflow_uuid: string }[]>) {
  return consumeGracefulShutdownCredit({
    sql: fakeSql(credit) as never,
    executorId: EXEC,
    markerDir: dir,
    now: () => NOW,
    pid: 2222,
  });
}

describe('consumeGracefulShutdownCredit (boot half)', () => {
  it('credits the executor once for a fresh marker, and consumes the marker', async () => {
    writeMarker();
    const credit = vi.fn(async () => [{ workflow_uuid: 'wf-long' }]);

    const first = await consume(credit);
    const second = await consume(credit);

    expect(first).toMatchObject({ outcome: 'credited', ids: ['wf-long'] });
    expect(second).toEqual({ outcome: 'no-marker' });
    expect(credit).toHaveBeenCalledTimes(1);
    expect(existsSync(markerFile())).toBe(false);
  });

  it('a crash leaves no marker, so nothing is credited', async () => {
    const credit = vi.fn(async () => [{ workflow_uuid: 'wf-poison' }]);
    expect(await consume(credit)).toEqual({ outcome: 'no-marker' });
    expect(credit).not.toHaveBeenCalled();
  });

  it('ignores and consumes a stale marker', async () => {
    writeMarker({ at: NOW - GRACEFUL_SHUTDOWN_MARKER_MAX_AGE_MS - 1 });
    const credit = vi.fn(async () => []);
    expect(await consume(credit)).toMatchObject({ outcome: 'stale' });
    expect(credit).not.toHaveBeenCalled();
    expect(existsSync(markerFile())).toBe(false);
  });

  it.each([
    ['another executor', { executorId: 'desktop-dev-3070' }],
    ['this same process', { pid: 2222 }],
    ['an unknown schema', { schema: 'v0' }],
    ['no timestamp', { at: 'yesterday' }],
  ])('refuses a marker from %s', async (_label, over) => {
    writeMarker(over);
    const credit = vi.fn(async () => []);
    expect(await consume(credit)).toMatchObject({ outcome: 'invalid' });
    expect(credit).not.toHaveBeenCalled();
    expect(existsSync(markerFile())).toBe(false);
  });

  it('refuses and consumes an unparseable marker', async () => {
    writeFileSync(markerFile(), '{"schema":');
    const credit = vi.fn(async () => []);
    expect(await consume(credit)).toEqual({ outcome: 'invalid', reason: 'unparseable marker' });
    expect(credit).not.toHaveBeenCalled();
    expect(existsSync(markerFile())).toBe(false);
  });

  it('round-trips: a marker armed at SIGTERM is credited by the next process', async () => {
    const proc = fakeProc();
    proc.on('SIGTERM', () => {});
    arm(proc);
    proc.emit('SIGTERM');

    const credit = vi.fn(async () => [{ workflow_uuid: 'wf-long' }]);
    const result = await consumeGracefulShutdownCredit({
      sql: fakeSql(credit) as never,
      executorId: EXEC,
      markerDir: dir,
      now: () => NOW + 45_000,
      pid: 5555,
    });

    expect(result).toMatchObject({ outcome: 'credited', ids: ['wf-long'] });
  });
});
