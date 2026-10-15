/**
 * WI-10005932 (plan agent-capacity-and-cost-gcp-2026-09-30, P-532d): the READY
 * deadline for an embed sidecar this Server spawns.
 *
 * The deadline was a hard-coded 10 s. On a 4-vCPU capacity VM with three
 * packaged Servers cold-booting at once, the re-exec'd bundle needed about
 * 10 s to print READY, so the parent killed a healthy child four times in a
 * row and each respawn paid the same startup again. Pinned here with a FAKE
 * child process (no real spawn, no model load) and fake timers:
 *  1. a child still starting past the old 10 s deadline is NOT killed;
 *  2. a child that never reaches READY is still killed at the (configurable)
 *     deadline, so a wedged start stays bounded;
 *  3. the deadline helper takes only a positive integer override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeChild = import('node:events').EventEmitter & {
  stdout: import('node:events').EventEmitter;
  stderr: import('node:events').EventEmitter;
  killed: boolean;
};

const fake = vi.hoisted(() => ({ children: [] as FakeChild[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = Object.assign(new Emitter(), {
        stdout: new Emitter(),
        stderr: new Emitter(),
        killed: false,
        kill(this: { killed: boolean }) {
          this.killed = true;
          return true;
        },
      });
      fake.children.push(child);
      return child;
    }),
  };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EMBED_SIDECAR_READY_LINE } from './embed-sidecar-server';
import {
  _resetEmbedSidecarSpawnStateForTests,
  EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS,
  EMBED_SIDECAR_ENABLE_ENV,
  EMBED_SIDECAR_STARTUP_TIMEOUT_ENV,
  embedSidecarStartupTimeoutMs,
  spawnEmbedSidecar,
} from './embed-sidecar-spawn';

function say(child: FakeChild, line: string): void {
  child.stdout.emit('data', Buffer.from(`${line}\n`));
}

describe('embedSidecarStartupTimeoutMs (WI-10005932)', () => {
  it('defaults well above a contended cold start', () => {
    expect(embedSidecarStartupTimeoutMs({})).toBe(EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS);
    expect(EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('takes a positive integer override and ignores anything else', () => {
    expect(embedSidecarStartupTimeoutMs({ [EMBED_SIDECAR_STARTUP_TIMEOUT_ENV]: '90000' })).toBe(90_000);
    for (const bad of ['', '  ', '0', '-5', '1.5', 'abc']) {
      expect(embedSidecarStartupTimeoutMs({ [EMBED_SIDECAR_STARTUP_TIMEOUT_ENV]: bad })).toBe(
        EMBED_SIDECAR_DEFAULT_STARTUP_TIMEOUT_MS,
      );
    }
  });
});

describe('spawnEmbedSidecar READY deadline (WI-10005932)', () => {
  const saved = {
    enable: process.env[EMBED_SIDECAR_ENABLE_ENV],
    port: process.env.PAPERCUSP_EMBED_SIDECAR_PORT,
    home: process.env.PAPERCUSP_HOME,
    startup: process.env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV],
  };
  let home: string;

  beforeEach(() => {
    fake.children.length = 0;
    _resetEmbedSidecarSpawnStateForTests();
    process.env[EMBED_SIDECAR_ENABLE_ENV] = '1';
    delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
    delete process.env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV];
    home = mkdtempSync(path.join(tmpdir(), 'wi10005932-startup-'));
    process.env.PAPERCUSP_HOME = home;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetEmbedSidecarSpawnStateForTests();
    for (const [k, v] of [
      [EMBED_SIDECAR_ENABLE_ENV, saved.enable],
      ['PAPERCUSP_EMBED_SIDECAR_PORT', saved.port],
      ['PAPERCUSP_HOME', saved.home],
      [EMBED_SIDECAR_STARTUP_TIMEOUT_ENV, saved.startup],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does not kill a child that is still starting past the old 10 s deadline', async () => {
    let outcome: string | null = null;
    const started = spawnEmbedSidecar().then(
      () => {
        outcome = 'resolved';
      },
      (e: unknown) => {
        outcome = `rejected: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
    expect(fake.children).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.children[0].killed).toBe(false);
    expect(outcome).toBeNull();

    say(fake.children[0], `${EMBED_SIDECAR_READY_LINE} port=41301`);
    await started;
    expect(outcome).toBe('resolved');
    expect(fake.children[0].killed).toBe(false);
  });

  it('preserves informational database stderr across chunks without promoting it to a warning', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = spawnEmbedSidecar();
    const child = fake.children[0];
    child.stderr.emit('data', Buffer.from('[db] target source=env end'));
    expect(console.log).not.toHaveBeenCalledWith('[embed-sidecar-err]', expect.anything());
    child.stderr.emit('data', Buffer.from('point=localhost:32769\n'));
    expect(console.log).toHaveBeenCalledWith('[embed-sidecar-err]', '[db] target source=env endpoint=localhost:32769');
    expect(warning).not.toHaveBeenCalled();
    say(child, `${EMBED_SIDECAR_READY_LINE} port=41301`);
    await started;
  });

  it('keeps actual warnings, mixed stderr and an unterminated final diagnostic visible', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = spawnEmbedSidecar();
    const child = fake.children[0];
    child.stderr.emit('data', Buffer.from('[db] target source=env endpoint=localhost:32769\nmodel warmup failed\n[db] target source=env endpoint=localhost:32769 WARNING\nlast failure'));
    child.stderr.emit('end');
    expect(warning.mock.calls).toEqual([
      ['[embed-sidecar-err]', 'model warmup failed'],
      ['[embed-sidecar-err]', '[db] target source=env endpoint=localhost:32769 WARNING'],
      ['[embed-sidecar-err]', 'last failure'],
    ]);
    expect(console.log).toHaveBeenCalledWith('[embed-sidecar-err]', '[db] target source=env endpoint=localhost:32769');
    say(child, `${EMBED_SIDECAR_READY_LINE} port=41301`);
    await started;
  });

  it('preserves validated node-loaded startup telemetry across chunks and at stderr end', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = spawnEmbedSidecar();
    const child = fake.children[0];
    const identity = { sha256: 'a'.repeat(64), bytes: 31, switches: ['--import', '-r'] };
    const record = `TEST_FILE_STARTUP_TRACE ${JSON.stringify({ pid: 123, event: 'node-loaded', nodeOptions: identity, execArgv: identity })}`;
    child.stderr.emit('data', Buffer.from(record.slice(0, 80)));
    expect(console.log).not.toHaveBeenCalledWith('[embed-sidecar-err]', expect.anything());
    child.stderr.emit('data', Buffer.from(`${record.slice(80)}\n${record}`));
    expect(console.log).toHaveBeenCalledWith('[embed-sidecar-err]', record);
    child.stderr.emit('end');
    expect(vi.mocked(console.log).mock.calls.filter(([tag]) => tag === '[embed-sidecar-err]')).toHaveLength(2);
    expect(warning).not.toHaveBeenCalled();
    say(child, `${EMBED_SIDECAR_READY_LINE} port=41301`);
    await started;
  });

  it('keeps malformed, extended and warning-bearing startup diagnostics as warnings', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = spawnEmbedSidecar();
    const child = fake.children[0];
    const identity = { sha256: 'a'.repeat(64), bytes: 31, switches: ['--import'] };
    const row = { pid: 123, event: 'node-loaded', nodeOptions: identity, execArgv: identity };
    const trace = (value: unknown) => `TEST_FILE_STARTUP_TRACE ${JSON.stringify(value)}`;
    const diagnostics = [
      'TEST_FILE_STARTUP_TRACE {',
      trace(null),
      trace([]),
      trace({ ...row, event: 'worker-exit' }),
      trace({ ...row, error: 'model warmup failed' }),
      trace({ ...row, pid: 0 }),
      trace({ ...row, nodeOptions: { ...identity, sha256: 'invalid' } }),
      trace({ ...row, execArgv: { ...identity, bytes: -1 } }),
      trace({ ...row, nodeOptions: { ...identity, switches: ['--warning'] } }),
      trace({ ...row, execArgv: { ...identity, warning: 'model warmup failed' } }),
      `${trace(row)} WARNING`,
      'model warmup failed',
    ];
    child.stderr.emit('data', Buffer.from(`${trace(row)}\n${diagnostics.join('\n')}`));
    child.stderr.emit('end');
    expect(console.log).toHaveBeenCalledWith('[embed-sidecar-err]', trace(row));
    expect(warning.mock.calls).toEqual(diagnostics.map(line => ['[embed-sidecar-err]', line]));
    say(child, `${EMBED_SIDECAR_READY_LINE} port=41301`);
    await started;
  });

  it('still kills and rejects a child that never reaches READY by the deadline', async () => {
    process.env[EMBED_SIDECAR_STARTUP_TIMEOUT_ENV] = '20000';
    const outcome = spawnEmbedSidecar().then(
      () => 'resolved',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );

    await vi.advanceTimersByTimeAsync(19_000);
    expect(fake.children[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(fake.children[0].killed).toBe(true);
    await expect(outcome).resolves.toBe('Embed sidecar startup timeout (20000 ms)');
  });
});
