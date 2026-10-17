/**
 * hook.test.ts — pre-snapshot DB-dump orchestration (the pure dispatch logic).
 *
 * runPreSnapshotHook is fundamentally a side-effect orchestrator (spawns
 * pg_dump|gzip, writes a dump file, logs). The genuinely PURE, branch-y
 * logic worth pinning is the admin-URL → spawn-args derivation: it parses the
 * host's embedded-pg admin URL and feeds host/port/user/password into the
 * pg_dump argv + PGPASSWORD env. This test mocks the entire I/O boundary
 * (child_process, node:fs, node:fs/promises, ./config) so NO process is
 * spawned and NO disk is touched — it asserts the connection params are
 * derived correctly, incl. the port fallback, the postgres user default, and
 * URL-decoding of the password. The empty-dump SKIP branch is also pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
} from './application-names';

const h = vi.hoisted(() => ({
  guardBin: '/test/kopia-backup-guard.sh',
  adminUrl: { url: 'postgres://postgres:postgres@127.0.0.1:5432/db', source: 'env' },
  spawnCalls: [] as Array<{
    cmd: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
    stdio?: unknown;
  }>,
  // Size returned by the mocked stat() of the temp dump — >=10KiB ⇒ success path.
  dumpSize: 16_384,
  closeCodes: { pg_dump: 0, gzip: 0 } as Record<string, number>,
  stdinWrites: [] as string[],
  writeStreamPaths: [] as string[],
  renameCalls: [] as Array<{ from: string; to: string }>,
  unlinkCalls: [] as string[],
  logLines: [] as string[],
  // When true, the gzip child's stdin emits an EPIPE 'error' before close —
  // the mid-dump broken-pipe crash regression (gz dies while pg_dump streams).
  gzipStdinError: false,
  availableBlocks: 100_000_000,
  // Size of the PREVIOUS dump already on disk, which is what the free-space
  // reserve is now sized from. null ⇒ no previous artifact (fresh workspace),
  // so stat() rejects ENOENT exactly as the real fs would.
  previousDumpSize: null as number | null,
  readdirNames: [] as string[],
  hostCoverageCovered: false,
  hostCoverageInProgress: false,
  hostCoverageReason: 'no host-dump receipt',
  statfsCalls: 0,
  holdGuardOpen: false,
  pendingGuard: null as EventEmitter | null,
  pendingGuardReady: null as EventEmitter | null,
}));

// Fake child: EventEmitter-backed stdout/stderr/stdin (so the real code's
// `dump.stdout.pipe(gz.stdin)` wiring, the stderr 'data' reads, AND the pipe-
// socket 'error' handlers all attach to real emitters), plus kill + the child
// EventEmitter for 'error'/'close'/'exit'. We drive 'close' (and, for the
// regression case, a stdin 'error') to settle the dumpPg promise.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const mkStream = () => {
    const s = new EventEmitter() as EventEmitter & Record<string, unknown>;
    s.pipe = vi.fn();
    return s;
  };
  child.stdout = mkStream();
  child.stderr = mkStream();
  const guardReady = mkStream();
  child.stdio = [null, child.stdout, child.stderr, guardReady];
  const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
  stdin.write = vi.fn((chunk: string) => { h.stdinWrites.push(String(chunk)); });
  child.stdin = stdin;
  child.kill = vi.fn();
  return child as unknown as import('node:child_process').ChildProcess & EventEmitter;
}

vi.mock('node:child_process', () => ({
  // gzipArgs() probes `gzip --help` once via spawnSync; return rsyncable-capable.
  spawnSync: vi.fn(() => ({ stdout: '  --rsyncable\n', stderr: '' })),
  spawn: vi.fn((
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: unknown },
  ) => {
    const child = fakeChild();
    h.spawnCalls.push({ cmd, args, env: opts?.env, detached: opts?.detached, stdio: opts?.stdio });
    // Settle on next tick: each child closes with the configured code. For the
    // broken-pipe regression, the gzip stdin socket errors first (mid-stream).
    queueMicrotask(() => {
      if (cmd === h.guardBin) {
        const ready = child.stdio[3] as EventEmitter;
        if (h.holdGuardOpen) {
          h.pendingGuard = child;
          h.pendingGuardReady = ready;
          return;
        }
        ready.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
      }
      if (cmd === 'gzip' && h.gzipStdinError) {
        const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write', errno: -32 });
        (child.stdin as unknown as EventEmitter).emit('error', err);
      }
      // The guard process is the mocked boundary around pg_dump. Preserve the
      // existing outcome controls so the assertions still exercise pg_dump's
      // success/failure branches after adding the real cross-process wrapper.
      const closeCodeKey = cmd === h.guardBin ? 'pg_dump' : cmd;
      child.emit('close', h.closeCodes[closeCodeKey] ?? 0);
    });
    return child;
  }),
}));

vi.mock('node:fs', () => ({
  // out stream: never errors, supports end()/destroyed.
  createWriteStream: vi.fn((path: string) => {
    h.writeStreamPaths.push(String(path));
    return { on: vi.fn(), end: vi.fn(), destroyed: false };
  }),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  readdir: vi.fn(async () => h.readdirNames.map((name) => ({ name, isFile: () => true }))),
  // Path-aware: the in-flight `.tmp` (dumpPg's post-dump size check) and the
  // PREVIOUS dump (the reserve-sizing probe) are different files with
  // different sizes, and the reserve test only means something if they can
  // differ here too.
  stat: vi.fn(async (p: string) => {
    if (String(p).endsWith('.tmp')) return { size: h.dumpSize };
    if (h.previousDumpSize === null) {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    }
    return { size: h.previousDumpSize };
  }),
  statfs: vi.fn(async () => {
    h.statfsCalls += 1;
    return { bsize: 4096, bavail: h.availableBlocks, blocks: 200_000_000 };
  }),
  appendFile: vi.fn(async (_p: string, line: string) => {
    h.logLines.push(line);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    h.renameCalls.push({ from, to });
  }),
  unlink: vi.fn(async (path: string) => { h.unlinkCalls.push(path); }),
}));

vi.mock('./host-dump-coverage', () => ({
  hostDumpStatusPath: vi.fn(() => '/host/STATUS.json'),
  readHostDumpStatus: vi.fn(async () => (h.hostCoverageCovered ? { ok: true } : null)),
  readHostDumpInProgress: vi.fn(async () => h.hostCoverageInProgress
    ? { pid: 4242, processStartTicks: '100', startedAtEpoch: 1_788_100_000, phase: 'guard-queued', source: 'guard' }
    : null),
  probeSystemIdentifier: vi.fn(async () => (h.hostCoverageCovered ? 'cluster-1' : null)),
  evaluateHostDumpCoverage: vi.fn(() => ({
    covered: h.hostCoverageCovered && !h.hostCoverageInProgress,
    inProgress: h.hostCoverageInProgress,
    reason: h.hostCoverageInProgress ? 'host backup is in progress (phase guard-queued, pid 4242)' : h.hostCoverageReason,
  })),
}));

vi.mock('./config', () => ({
  backupHost: () => ({ getHarnessAdminUrl: () => h.adminUrl }),
}));

import {
  allocateDumpTempPath,
  createGuardLogForwarder,
  dumpWatchdogPolicy,
  HOT_SNAPSHOT_EXCLUDED_TABLE_DATA,
  requiredFreeBytes,
  resolveKopiaBackupGuard,
  runPreSnapshotHook,
  SAFETY_DUMP_CEILING_MS,
  SAFETY_DUMP_STALL_TIMEOUT_MS,
  summarizeDumpFailure,
  terminateSpawnTree,
  WORKSPACE_BACKUP_GUARD_LABEL,
} from './hook';

describe('summarizeDumpFailure', () => {
  // EI-25211496463956189: on 2026-10-06 every timed-out dump was recorded as the
  // guard's first stderr line ("result=waiting reason=lock"), hiding the timeout.
  it('records the timeout, not the guard lines that precede it', () => {
    const stderr = [
      'KOPIA_BACKUP_GUARD timestamp=2026-10-06T09:57:11-04:00 label=workspace-db-dump result=waiting reason=lock',
      'KOPIA_BACKUP_GUARD timestamp=2026-10-06T09:57:34-04:00 label=workspace-db-dump result=started mode=wait',
      'pg dump timed out after 900000ms',
      '',
    ].join('\n');
    expect(summarizeDumpFailure(stderr)).toBe('pg dump timed out after 900000ms');
  });

  it('keeps the end of a long error, where the cause is', () => {
    const summary = summarizeDumpFailure(`${'x'.repeat(500)}\npg_dump: error: connection lost`);
    expect(summary).toHaveLength(200);
    expect(summary.endsWith('pg_dump: error: connection lost')).toBe(true);
  });

  it('falls back to a generic message when only guard lines were written', () => {
    expect(summarizeDumpFailure('KOPIA_BACKUP_GUARD timestamp=x label=y result=waiting reason=lock\n')).toBe(
      'dump pipeline failed',
    );
  });
});

const ctx = { workspaceId: 'ws-1', workspaceRoot: '/work/ws-1' };
const originalGuardBin = process.env.KOPIA_BACKUP_GUARD_BIN;
const originalGuardActive = process.env.KOPIA_BACKUP_GUARD_ACTIVE;

beforeEach(() => {
  process.env.KOPIA_BACKUP_GUARD_BIN = h.guardBin;
  delete process.env.KOPIA_BACKUP_GUARD_ACTIVE;
  h.adminUrl = { url: 'postgres://postgres:postgres@127.0.0.1:5432/db', source: 'env' };
  h.spawnCalls = [];
  h.dumpSize = 16_384;
  h.closeCodes = { pg_dump: 0, gzip: 0 };
  h.stdinWrites = [];
  h.writeStreamPaths = [];
  h.renameCalls = [];
  h.unlinkCalls = [];
  h.logLines = [];
  h.gzipStdinError = false;
  h.availableBlocks = 100_000_000;
  h.previousDumpSize = null;
  h.readdirNames = [];
  h.hostCoverageCovered = false;
  h.hostCoverageInProgress = false;
  h.hostCoverageReason = 'no host-dump receipt';
  h.statfsCalls = 0;
  h.holdGuardOpen = false;
  h.pendingGuard = null;
  h.pendingGuardReady = null;
});
afterEach(() => vi.clearAllMocks());

afterEach(() => {
  if (originalGuardBin === undefined) delete process.env.KOPIA_BACKUP_GUARD_BIN;
  else process.env.KOPIA_BACKUP_GUARD_BIN = originalGuardBin;
  if (originalGuardActive === undefined) delete process.env.KOPIA_BACKUP_GUARD_ACTIVE;
  else process.env.KOPIA_BACKUP_GUARD_ACTIVE = originalGuardActive;
});

const pgDumpCall = () => h.spawnCalls.find((c) => c.cmd === 'pg_dump' || c.args.includes('pg_dump'));

describe('cross-process dump transaction isolation', () => {
  it('allocates a distinct Kopia-ignored temp path for every dump attempt', () => {
    const out = '/work/ws-1/db-dumps/pg-embedded.sql.gz';
    const first = allocateDumpTempPath(out);
    const second = allocateDumpTempPath(out);

    expect(first).not.toBe(second);
    expect(first).toMatch(/pg-embedded\.sql\.gz\.\d+-\d+\.tmp$/);
    expect(second).toMatch(/pg-embedded\.sql\.gz\.\d+-\d+\.tmp$/);
    expect(first).not.toBe(`${out}.tmp`);
    expect(second).not.toBe(`${out}.tmp`);
  });

  it('never reuses the transaction pathname across sequential hook runs', async () => {
    await runPreSnapshotHook(ctx);
    await runPreSnapshotHook(ctx);

    expect(h.writeStreamPaths).toHaveLength(2);
    expect(new Set(h.writeStreamPaths).size).toBe(2);
    expect(h.writeStreamPaths.every((path) => path.endsWith('.tmp'))).toBe(true);
  });

  it('reaps only transaction files whose encoded writer PID is dead', async () => {
    const live = `pg-embedded.sql.gz.${process.pid}-4.tmp`;
    const dead = 'pg-embedded.sql.gz.2147483646-7.tmp';
    h.readdirNames = [live, dead, 'unrelated.tmp'];

    await runPreSnapshotHook(ctx);

    expect(h.unlinkCalls).toContain(`/work/ws-1/db-dumps/${dead}`);
    expect(h.unlinkCalls).not.toContain(`/work/ws-1/db-dumps/${live}`);
    expect(h.unlinkCalls).not.toContain('/work/ws-1/db-dumps/unrelated.tmp');
    expect(h.logLines.join('')).toMatch(/reaped 1 dead-writer transaction/);
  });

  it('reaps a dead-writer transaction before a low-space admission refusal', async () => {
    const dead = 'pg-embedded.sql.gz.2147483646-8.tmp';
    h.readdirNames = [dead];
    h.previousDumpSize = 1_780_687_612;
    h.availableBlocks = Math.floor(2_000_000_000 / 4096);

    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: false });

    expect(h.unlinkCalls).toContain(`/work/ws-1/db-dumps/${dead}`);
    expect(pgDumpCall()).toBeUndefined();
  });
});

describe('runPreSnapshotHook admin-URL → spawn args', () => {
  it('returns degraded without starting a duplicate dump while the host writer is active', async () => {
    // A prior completion receipt cannot outrank a live writer marker.
    h.hostCoverageCovered = true;
    h.hostCoverageInProgress = true;

    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({
      ok: false,
      error: 'host backup is in progress (phase guard-queued, pid 4242)',
      deferred: 'host-backup-in-progress',
    });

    expect(pgDumpCall()).toBeUndefined();
    expect(h.statfsCalls).toBe(0);
    expect(h.logLines.join('')).toContain('hook done (degraded: host-backup-in-progress)');
  });

  it('runs pg_dump through the shared wait-mode backup guard', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const pgDumpIndex = c.args.indexOf('pg_dump');

    expect(c.cmd).toBe(h.guardBin);
    // No trigger reason = a safety dump: due-now priority, no --deadline-at-arrival.
    expect(c.args.slice(0, pgDumpIndex)).toEqual([
      '--mode', 'wait',
      '--label', WORKSPACE_BACKUP_GUARD_LABEL,
      '--',
    ]);
    expect(pgDumpIndex).toBeGreaterThan(-1);
    expect(c.detached).toBe(process.platform !== 'win32');
    expect(c.env?.KOPIA_BACKUP_GUARD_LOG_STDERR).toBe('1');
    expect(c.env?.KOPIA_BACKUP_GUARD_READY_FD).toBe('3');
    expect(c.env?.KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC).toBe('900');
    expect(h.spawnCalls.find((call) => call.cmd === h.guardBin)?.stdio).toEqual([
      'ignore', 'pipe', 'pipe', 'pipe',
    ]);
  });

  // EI-25211496463956189 vs WI-10004871: only a ROUTINE interval dump yields to an
  // overdue Kopia sweep that is still making progress. A pre_destructive dump fails
  // closed (a deferred dump would time out at its 900s lock wait and block its
  // migration) and a pre-deploy dump is the deploy's rollback point, so both keep
  // the guard's due-now priority.
  it.each([
    ['interval', true],
    ['pre_destructive', false],
    ['pre-deploy', false],
    ['manual', false],
  ] as const)('trigger reason %s → --deadline-at-arrival %s', async (triggerReason, expected) => {
    await runPreSnapshotHook({ ...ctx, triggerReason });
    const c = pgDumpCall()!;
    const guardArgs = c.args.slice(0, c.args.indexOf('pg_dump'));

    expect(c.cmd).toBe(h.guardBin);
    expect(guardArgs.includes('--deadline-at-arrival')).toBe(expected);
    expect(guardArgs.slice(0, 4)).toEqual(['--mode', 'wait', '--label', WORKSPACE_BACKUP_GUARD_LABEL]);
    expect(guardArgs[guardArgs.length - 1]).toBe('--');
  });

  it('starts the 900s pg_dump watchdog only after the guard reports lock readiness', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    h.holdGuardOpen = true;
    try {
      // The fixed 900s budget belongs to the routine interval dump only.
      const pending = runPreSnapshotHook({ ...ctx, triggerReason: 'interval' });
      for (let i = 0; i < 100 && !h.pendingGuard; i += 1) await Promise.resolve();
      expect(h.pendingGuard).not.toBeNull();

      const delays = () => timeoutSpy.mock.calls.map(([, delay]) => Number(delay));
      expect(delays()).toContain(905_000); // separate guard-readiness backstop
      expect(delays()).not.toContain(900_000); // pg_dump has not acquired the lock

      h.pendingGuardReady!.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
      expect(delays()).toContain(900_000);
      h.pendingGuard!.emit('close', 0);
      h.pendingGuard = null;
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      h.pendingGuard?.emit('close', 1);
      h.pendingGuard = null;
      h.holdGuardOpen = false;
      timeoutSpy.mockRestore();
    }
  });

  // WI-10004871: the guard's waiting/started/finished lines for this producer
  // were captured into the failure-only stderr buffer and never reached the
  // journal, so a sweep preempted by a deploy/migration dump had no attributable
  // waiter. They must now be re-emitted on the host's stderr as they arrive.
  it('re-emits the wait-mode guard decision lines on the host stderr while the dump waits', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    h.holdGuardOpen = true;
    try {
      const pending = runPreSnapshotHook(ctx);
      for (let i = 0; i < 100 && !h.pendingGuard; i += 1) await Promise.resolve();
      expect(h.pendingGuard).not.toBeNull();
      const guardStderr = (h.pendingGuard as unknown as { stderr: EventEmitter }).stderr;

      const waiting = 'KOPIA_BACKUP_GUARD timestamp=2026-10-01T12:00:00-04:00 '
        + `label=${WORKSPACE_BACKUP_GUARD_LABEL} result=waiting reason=lock-held`;
      // Split mid-line: the forwarder must reassemble before matching.
      guardStderr.emit('data', Buffer.from(waiting.slice(0, 25)));
      guardStderr.emit('data', Buffer.from(`${waiting.slice(25)}\npg_dump: warning: not a guard line\n`));
      const forwarded = () => writeSpy.mock.calls.map(([chunk]) => String(chunk));
      expect(forwarded()).toEqual([`${waiting}\n`]);

      h.pendingGuardReady!.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
      h.pendingGuard!.emit('close', 0);
      h.pendingGuard = null;
      await expect(pending).resolves.toMatchObject({ ok: true });
    } finally {
      h.pendingGuard?.emit('close', 1);
      h.pendingGuard = null;
      h.holdGuardOpen = false;
      writeSpy.mockRestore();
    }
  });

  it('forwards only complete guard lines and drops an unterminated runaway buffer', () => {
    const lines: string[] = [];
    const forward = createGuardLogForwarder((line) => lines.push(line));

    forward('KOPIA_BACKUP_GUARD a=1\nnoise\nKOPIA_BACKUP_GUARD_READY\nKOPIA_BACKUP_GUARD b=');
    expect(lines).toEqual(['KOPIA_BACKUP_GUARD a=1']);
    forward('2\n');
    expect(lines).toEqual(['KOPIA_BACKUP_GUARD a=1', 'KOPIA_BACKUP_GUARD b=2']);

    forward(`KOPIA_BACKUP_GUARD ${'x'.repeat(9_000)}`);
    forward('\nKOPIA_BACKUP_GUARD c=3\n');
    expect(lines).toEqual(['KOPIA_BACKUP_GUARD a=1', 'KOPIA_BACKUP_GUARD b=2', 'KOPIA_BACKUP_GUARD c=3']);
  });

  it('targets the isolated dump process group, not only the guard shell', () => {
    const directKill = vi.fn(() => true);
    const child = { pid: 4242, kill: directKill } as unknown as Pick<
      import('node:child_process').ChildProcess,
      'pid' | 'kill'
    >;
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);

    try {
      terminateSpawnTree(child, true);
      expect(processKill).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(directKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it.each(['linux', 'darwin', 'win32'])('uses the %s guard default and respects an explicit override', async (platform) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    try {
      delete process.env.KOPIA_BACKUP_GUARD_BIN;
      const expected = platform === 'linux'
        ? join(homedir(), '.config', 'kopia', 'kopia-backup-guard.sh')
        : null;
      expect(resolveKopiaBackupGuard()).toBe(expected);
      await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: true });
      expect(pgDumpCall()!.cmd).toBe(expected ?? 'pg_dump');

      // A caller-selected guard is honored on every platform, never silently
      // bypassed just because it is not the systemd host's default path.
      h.spawnCalls = [];
      process.env.KOPIA_BACKUP_GUARD_BIN = h.guardBin;
      expect(resolveKopiaBackupGuard()).toBe(h.guardBin);
      await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: true });
      expect(pgDumpCall()!.cmd).toBe(h.guardBin);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('does not re-enter the wait-mode guard when already running inside it', async () => {
    process.env.KOPIA_BACKUP_GUARD_ACTIVE = '1';
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.cmd).toBe('pg_dump');
  });

  it('derives host/port/user from the admin URL into the pg_dump argv', async () => {
    h.adminUrl = { url: 'postgres://alice:pw@db.local:6789/x', source: 'file' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c).toBeDefined();
    expect(c.args).toEqual(expect.arrayContaining(['-h', 'db.local', '-p', '6789', '-U', 'alice', '-w', '-d', 'x', '--no-owner', '--no-privileges', '-n', 'harness_shared']));
    expect(c.args).toContain('--exclude-table-data=harness_shared.route_invocations');
    expect(c.args).toContain('--exclude-table-data=harness_shared.tool_invocations');
    expect(c.args).toContain('--exclude-table-data=harness_shared.benchmark_run_result');
    expect(c.args).toContain('--exclude-table-data=harness_shared.session_turn_chunks');
    expect(c.args).toContain('--exclude-table-data=harness_shared.session_turn_parts');
    expect(c.args).toContain('--exclude-table-data=harness_shared.gateway_payload_blobs');
    expect(c.args).toContain('--exclude-table-data=harness_shared.memory_recall_stats');
    expect(c.args).toContain('--exclude-table-data=harness_shared.memory_recall_query_text');
    expect(c.args).not.toContain('-t');
  });

  it('falls back to port 5432 when the URL omits a port', async () => {
    h.adminUrl = { url: 'postgres://postgres:pw@host/db', source: 'env' };
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.args).toContain('5432');
  });

  it('falls back to the "postgres" user when the URL omits one', async () => {
    h.adminUrl = { url: 'postgres://:pw@host:5432/db', source: 'env' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const uIdx = c.args.indexOf('-U');
    expect(c.args[uIdx + 1]).toBe('postgres');
  });

  it('URL-decodes the password into PGPASSWORD (no plaintext special chars in argv)', async () => {
    // "p@ss/word" encoded → p%40ss%2Fword
    h.adminUrl = { url: 'postgres://u:p%40ss%2Fword@host:5432/db', source: 'env' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c.env?.PGPASSWORD).toBe('p@ss/word');
    // Password is never placed on the argv.
    expect(c.args.join(' ')).not.toContain('p@ss');
  });

  it('URL-decodes the database name and dumps only that database', async () => {
    h.adminUrl = { url: 'postgres://u:pw@host:5432/paper%2Fcusp', source: 'env' };
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const dIdx = c.args.indexOf('-d');
    expect(dIdx).toBeGreaterThan(-1);
    expect(c.args[dIdx + 1]).toBe('paper/cusp');
    expect(c.cmd).toBe(h.guardBin);
  });

  it('sets a connect timeout in the spawn env', async () => {
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.env?.PGCONNECT_TIMEOUT).toBe('5');
  });

  it('tags the workspace dump backend so migration preflight can avoid its relation locks', async () => {
    await runPreSnapshotHook(ctx);
    expect(pgDumpCall()!.env?.PGAPPNAME).toBe(WORKSPACE_BACKUP_APPLICATION_NAME);
    expect(WORKSPACE_BACKUP_APPLICATION_NAME).not.toBe(HOST_BACKUP_APPLICATION_NAME);
  });

  it('bounds PostgreSQL lock acquisition and statement lifetime below the client watchdog', async () => {
    await runPreSnapshotHook({ ...ctx, triggerReason: 'interval' });
    const c = pgDumpCall()!;
    expect(c.args).toContain('--lock-wait-timeout=30s');
    expect(c.env?.PGOPTIONS).toContain('-c statement_timeout=600000');
    expect(c.env?.PGOPTIONS).toContain('-c lock_timeout=30000');
  });

  // EI-25164396022471391: a safety dump's single COPY of an ~11 GB table takes
  // longer than 10 minutes, so its statement bound follows the safety ceiling
  // and stays ahead of it.
  it.each(['pre_destructive', 'pre-deploy', undefined] as const)(
    'a %s safety dump bounds each statement by the safety ceiling, not 10 minutes',
    async (triggerReason) => {
      await runPreSnapshotHook({ ...ctx, triggerReason });
      const opts = pgDumpCall()!.env?.PGOPTIONS ?? '';
      const statementTimeout = Number(/-c statement_timeout=(\d+)/.exec(opts)?.[1]);
      expect(statementTimeout).toBe(dumpWatchdogPolicy(false).statementTimeoutMs);
      expect(statementTimeout).toBeGreaterThan(600_000);
      expect(statementTimeout).toBeLessThan(SAFETY_DUMP_CEILING_MS);
      expect(opts).toContain('-c lock_timeout=30000');
    },
  );

  // A killed client must not leave its backend holding locks while blocked
  // (EI-21363741549000811). The server-side liveness poll covers both kinds of dump.
  it.each(['interval', 'pre_destructive'] as const)(
    'a %s dump asks PostgreSQL to poll for a dead client',
    async (triggerReason) => {
      await runPreSnapshotHook({ ...ctx, triggerReason });
      expect(pgDumpCall()!.env?.PGOPTIONS).toContain('-c client_connection_check_interval=10000');
    },
  );

  it('includes the vector extension required by harness_shared vector columns', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    expect(c.args).toContain('-e');
    expect(c.args).toContain('vector');
  });

  it('also dumps pg_trgm and pgcrypto — EI-13868: a restore drill found these missing, ' +
    'breaking a trigram GIN index (CREATE INDEX validates the operator class at DDL ' +
    'time) and leaving pgcrypto-dependent functions non-functional post-restore', async () => {
    await runPreSnapshotHook(ctx);
    const c = pgDumpCall()!;
    const eIndexes = c.args.reduce<number[]>((acc, a, i) => {
      if (a === '-e') acc.push(i);
      return acc;
    }, []);
    const eValues = eIndexes.map((i) => c.args[i + 1]);
    expect(eValues).toEqual(expect.arrayContaining(['vector', 'pg_trgm', 'pgcrypto']));
  });

  it('does not prefix a schema preamble because pg_dump -n emits schema DDL', async () => {
    await runPreSnapshotHook(ctx);
    expect(h.stdinWrites.join('')).not.toContain('CREATE SCHEMA IF NOT EXISTS harness_shared;');
  });
});

describe('runPreSnapshotHook outcome logging', () => {
  it('skips before free-space admission when host backup proves the database is covered', async () => {
    h.hostCoverageCovered = true;
    h.hostCoverageReason = 'host PG is covered by db-backup.sh';
    h.availableBlocks = 1;
    h.previousDumpSize = 2_567_922_002;

    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({
      ok: true,
      skipped: h.hostCoverageReason,
    });

    expect(h.statfsCalls).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/hook done \(skipped: host-covered\)/);
  });

  it('does not spawn a dump when the workspace filesystem is below its emergency reserve', async () => {
    h.availableBlocks = 1;
    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/insufficient free space/),
    });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/SKIP: insufficient free space/);
  });

  it('renames the temp dump into place and logs ok on a non-trivial dump', async () => {
    h.dumpSize = 16_384;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(1);
    expect(h.renameCalls[0].to).toContain('pg-embedded.sql.gz');
    expect(h.unlinkCalls).not.toContain('/work/ws-1/db-dumps/pg-embedded.sql.gz');
    expect(h.logLines.join('')).toMatch(/ok \(16384 bytes\)/);
  });

  it('does NOT rename when pg_dump fails even if gzip closes cleanly', async () => {
    h.dumpSize = 16_384;
    h.closeCodes = { pg_dump: 1, gzip: 0 };
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/FAIL: .*pg_dump exited 1/s);
  });

  it('SKIPs (no rename) and logs empty-dump when the dump is too small to be restorable', async () => {
    h.dumpSize = 215;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(/SKIP \(empty dump\)/);
  });

  it('logs the admin-URL provenance source', async () => {
    h.adminUrl = { url: 'postgres://postgres:pw@host:5432/db', source: 'PAPERCUSP_PG_PORT' };
    await runPreSnapshotHook(ctx);
    expect(h.logLines.join('')).toMatch(/URL source: PAPERCUSP_PG_PORT/);
  });
});

/**
 * The free-space guard is sized to the DUMP, never to the DISK
 * (EI-20109034777197353).
 *
 * The original rule asked for 10% of total capacity, capped at 100GiB. On this
 * 2TB box that saturated at the cap, so writing a 1.7GB dump demanded 100GiB
 * free — unsatisfiable in normal operation. The guard meant to protect the
 * backup silently DISABLED it, hourly, for 26 hours, while the snapshot ledger
 * kept committing status='ok'.
 *
 * The numbers below are the real measured ones from that incident, so a
 * reserve that drifts back toward a capacity-derived constant fails here.
 */
describe('free-space reserve is sized to the dump, not the disk (EI-20109034777197353)', () => {
  const GIB = 1024n * 1024n * 1024n;
  /** The real dump: ~1.7GB (pg-embedded.sql.gz, 2026-08-09). */
  const REAL_DUMP_BYTES = 1_780_687_612;
  /** Free space at the last skipping tick: ~35GB. */
  const REAL_FREE_BYTES = 35_319_316_480;
  /** What the old rule demanded to write that 1.7GB file. */
  const OLD_RESERVE_BYTES = 107_374_182_400n;
  const blocksFor = (bytes: number) => Math.floor(bytes / 4096);

  it('asks for single-digit GiB to write the real 1.7GB dump — not the 100GiB the old rule demanded', () => {
    const reserve = requiredFreeBytes(BigInt(REAL_DUMP_BYTES));
    expect(reserve).toBeLessThan(10n * GIB);
    expect(reserve).toBeLessThan(OLD_RESERVE_BYTES);
    // Still strictly more than the dump itself: the new .tmp and the previous
    // dump coexist until the closing rename.
    expect(reserve).toBeGreaterThan(BigInt(REAL_DUMP_BYTES) * 2n);
  });

  it('falls back to a fixed floor when no previous dump exists to measure', () => {
    expect(requiredFreeBytes(null)).toBe(3n * GIB);
    expect(requiredFreeBytes(0n)).toBe(3n * GIB);
  });

  it('scales with the dump — a reserve that ignores its input is the original bug', () => {
    const small = requiredFreeBytes(1n * GIB);
    const large = requiredFreeBytes(50n * GIB);
    expect(large).toBeGreaterThan(small);
    // A capacity-derived constant would be equal for both.
    expect(large).not.toBe(small);
  });

  it('THE INCIDENT: 1.7GB dump with 35GB free now PROCEEDS (it skipped hourly for 26h)', async () => {
    h.previousDumpSize = REAL_DUMP_BYTES;
    h.availableBlocks = blocksFor(REAL_FREE_BYTES);
    const result = await runPreSnapshotHook(ctx);
    expect(result.ok).toBe(true);
    expect(pgDumpCall()).toBeDefined();
    expect(h.logLines.join('')).not.toMatch(/insufficient free space/);
  });

  it('still refuses when space is GENUINELY short, naming the dump it sized for', async () => {
    h.previousDumpSize = REAL_DUMP_BYTES;
    h.availableBlocks = blocksFor(2_000_000_000); // 2GB free vs a ~6.4GB need
    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: false });
    expect(h.spawnCalls.filter((c) => c.cmd === 'pg_dump')).toHaveLength(0);
    expect(h.logLines.join('')).toMatch(
      new RegExp(`insufficient free space.*needed for a dump of ${REAL_DUMP_BYTES} bytes`),
    );
  });

  it('reclaims a stale .tmp even on the SKIP path — the orphan outlived 26h of skips', async () => {
    h.previousDumpSize = REAL_DUMP_BYTES;
    h.availableBlocks = blocksFor(2_000_000_000);
    await runPreSnapshotHook(ctx);
    // dumpPg never ran (see the assertion above), so this unlink can ONLY have
    // come from the pre-check — which is the point: under the old ordering the
    // orphaned .tmp was re-captured by every snapshot forever.
    expect(h.unlinkCalls.some((p) => p.endsWith('pg-embedded.sql.gz.tmp'))).toBe(true);
  });
});

// EI-25164396022471391: measured 2026-10-14 (snapshot 78722), a pre_destructive
// dump was still streaming at 10-20 MB/s when the fixed 900s watchdog killed it,
// so every migration stayed gated. A safety dump is now killed when it stops
// making progress, with a ceiling as backstop. The interval dump keeps 900s.
describe('safety-dump watchdog: stall detection, not a fixed budget (EI-25164396022471391)', () => {
  type HeldGuard = EventEmitter & { kill: ReturnType<typeof vi.fn>; stdout: EventEmitter };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    h.holdGuardOpen = true;
  });
  afterEach(() => {
    h.pendingGuard?.emit('close', 1);
    h.pendingGuard = null;
    h.holdGuardOpen = false;
    vi.useRealTimers();
  });

  // Returns the pending hook inside an object: returning the bare promise from
  // an async helper would await the very dump the test is still driving.
  const startHeldDump = async (triggerReason: string) => {
    const pending = runPreSnapshotHook({ ...ctx, triggerReason });
    for (let i = 0; i < 100 && !h.pendingGuard; i += 1) await Promise.resolve();
    expect(h.pendingGuard).not.toBeNull();
    const guard = h.pendingGuard as unknown as HeldGuard;
    h.pendingGuardReady!.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
    return { pending, guard };
  };
  const exitGuard = (guard: HeldGuard, code: number | null) => {
    h.pendingGuard = null;
    guard.emit('close', code);
  };

  it('kills a safety dump that writes nothing for the stall window, and says so', async () => {
    const { pending, guard } = await startHeldDump('pre_destructive');

    await vi.advanceTimersByTimeAsync(SAFETY_DUMP_STALL_TIMEOUT_MS - 1_000);
    guard.stdout.emit('data', Buffer.alloc(1024)); // progress restarts the window
    await vi.advanceTimersByTimeAsync(SAFETY_DUMP_STALL_TIMEOUT_MS - 1_000);
    expect(guard.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(guard.kill).toHaveBeenCalledWith('SIGKILL');
    exitGuard(guard, null);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(
        `pg dump stalled: no output for ${SAFETY_DUMP_STALL_TIMEOUT_MS}ms (1024 bytes dumped)`,
      ),
    });
  });

  it('lets a safety dump that keeps streaming run 90 minutes, far past the 900s budget', async () => {
    const { pending, guard } = await startHeldDump('pre_destructive');

    for (let minute = 0; minute < 90; minute += 1) {
      guard.stdout.emit('data', Buffer.alloc(1_000));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(guard.kill).not.toHaveBeenCalled();

    exitGuard(guard, 0);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('still kills a progressing safety dump at the absolute ceiling', async () => {
    const { pending, guard } = await startHeldDump('pre-deploy');
    const minutes = SAFETY_DUMP_CEILING_MS / 60_000;

    for (let minute = 0; minute < minutes - 1; minute += 1) {
      guard.stdout.emit('data', Buffer.alloc(10));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(guard.kill).not.toHaveBeenCalled();
    guard.stdout.emit('data', Buffer.alloc(10));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(guard.kill).toHaveBeenCalledWith('SIGKILL');

    exitGuard(guard, null);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(`pg dump timed out after ${SAFETY_DUMP_CEILING_MS}ms`),
    });
  });

  it('keeps the routine interval dump on its fixed 900s budget with no stall check', async () => {
    const { pending, guard } = await startHeldDump('interval');

    await vi.advanceTimersByTimeAsync(SAFETY_DUMP_STALL_TIMEOUT_MS + 60_000);
    expect(guard.kill).not.toHaveBeenCalled(); // silent past the stall window

    await vi.advanceTimersByTimeAsync(900_000 - SAFETY_DUMP_STALL_TIMEOUT_MS - 60_000);
    expect(guard.kill).toHaveBeenCalledWith('SIGKILL');

    exitGuard(guard, null);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('pg dump timed out after 900000ms'),
    });
  });

  it('does not count time queued behind the guard lock as a stall', async () => {
    const pending = runPreSnapshotHook({ ...ctx, triggerReason: 'pre_destructive' });
    for (let i = 0; i < 100 && !h.pendingGuard; i += 1) await Promise.resolve();
    const guard = h.pendingGuard as unknown as HeldGuard;

    await vi.advanceTimersByTimeAsync(SAFETY_DUMP_STALL_TIMEOUT_MS + 60_000); // waiting, no READY yet
    h.pendingGuardReady!.emit('data', Buffer.from('KOPIA_BACKUP_GUARD_READY\n'));
    await vi.advanceTimersByTimeAsync(SAFETY_DUMP_STALL_TIMEOUT_MS - 1_000);
    expect(guard.kill).not.toHaveBeenCalled();

    exitGuard(guard, 0);
    await expect(pending).resolves.toMatchObject({ ok: true });
  });
});

describe('safety-dump budget fits the measured workload (EI-25164396022471391)', () => {
  it('the ceiling covers the slowest measured full dump (~83 min at 10 MB/s)', () => {
    const policy = dumpWatchdogPolicy(false);
    expect(policy.ceilingMs).toBeGreaterThan(83 * 60_000);
    expect(policy.statementTimeoutMs).toBeLessThan(policy.ceilingMs);
    expect(policy.stallTimeoutMs).toBe(SAFETY_DUMP_STALL_TIMEOUT_MS);
    expect(dumpWatchdogPolicy(true)).toEqual({
      stallTimeoutMs: null,
      ceilingMs: 900_000,
      statementTimeoutMs: 600_000,
    });
  });

  it('omits the rebuildable substring index and the two telemetry streams from the hot dump', () => {
    expect(HOT_SNAPSHOT_EXCLUDED_TABLE_DATA).toEqual(expect.arrayContaining([
      'harness_shared.session_turn_windows',
      'harness_shared.fallback_observations',
      'harness_shared.psu_pty_host_events',
    ]));
    // Restore-critical coordination state stays in the dump.
    expect(HOT_SNAPSHOT_EXCLUDED_TABLE_DATA).not.toContain('harness_shared.coord_thread_posts');
    expect(HOT_SNAPSHOT_EXCLUDED_TABLE_DATA).not.toContain('harness_shared.work_items');
  });
});

describe('runPreSnapshotHook broken-pipe resilience (deploy-crash regression 2026-07-10)', () => {
  // The pg_dump→gzip pipe (`dump.stdout.pipe(gz.stdin)`) is a socket. When gzip
  // dies mid-stream (SIGKILL from the 60s timeout, OOM under load, a crash),
  // gz.stdin becomes a broken pipe and pg_dump's next write throws `write
  // EPIPE`, surfaced as an 'error' EVENT on the gz.stdin Socket — NOT a promise
  // rejection. Without a listener that escaped the resolve-only finalize() +
  // the caller's `.catch()` and crashed the whole DETACHED deploy process at the
  // pre-deploy snapshot step, blocking every green-pin ship. The hook must
  // instead degrade: abandon the dump, resolve, let the snapshot proceed.
  it('does NOT crash (resolves) when the gzip stdin pipe emits EPIPE mid-dump', async () => {
    h.gzipStdinError = true;
    await expect(runPreSnapshotHook(ctx)).resolves.toMatchObject({ ok: false });
  });

  it('degrades to no-rename and logs the pipe failure on a stdin EPIPE', async () => {
    h.gzipStdinError = true;
    await runPreSnapshotHook(ctx);
    expect(h.renameCalls).toHaveLength(0);
    expect(h.unlinkCalls.filter((p) => p.endsWith('.tmp')).length).toBeGreaterThanOrEqual(2);
    expect(h.logLines.join('')).toMatch(/gzip stdin pipe failed: write EPIPE/);
  });
});
