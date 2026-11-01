/**
 * WI-10004674 / WI-10003465 — a read-only git exec lives ~4 ms but its durable
 * resource-governor receipt costs four awaited PG statements, so the sidecar's
 * 2-connection pool queued every git read behind bookkeeping (measured p50
 * 0.5-3.5 s per read vs 5 ms for bare git, ~59% of native-PG WAL).
 *
 * `execProcess` now spawns a QUALIFYING (read-only git) command first and mints
 * the receipt only if the command outlives `lazyReceiptMs`. These tests pin both
 * directions: the fast read never touches the governor, the slow read still gets
 * a full receipt, and every command that does NOT qualify is still admitted
 * BEFORE the child exists.
 *
 * Real child processes: a fake `git` on the child's PATH gives a deterministic
 * duration and lets the test read back the env the child was handed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This unit suite exercises receipt timing with real short-lived commands.
// Forkserver/task-ledger containment is covered by forkserver.integration.test.
vi.mock('./forkserver/forkserver-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./forkserver/forkserver-client')>()),
  spawnSidecarChild: async (req: import('./forkserver/forkserver-client').SidecarSpawnRequest) => {
    const { spawn } = await import('node:child_process');
    return spawn(req.command, req.args, { cwd: req.cwd, env: req.env, detached: req.detached,
      stdio: [req.stdin?.fd ?? 'ignore', req.stdout?.fd ?? 'pipe', 'pipe'] });
  },
}));

import type { AdmissionContext } from '../resource-governor/admission';
import type { GovernedExecution } from '../resource-governor/execution';
import { buildGitBatchInvocation, isReadOnlyGitBatchExec } from '../git-batch';
import {
  execProcess,
  gitSubcommandOf,
  qualifiesForLazyReceipt,
  qualifiesForLazyReceiptProcess,
  SIDECAR_LAZY_RECEIPT_DELAY_MS,
  sidecarReceiptMetadata,
  type ExecParams,
} from './sidecar-exec-process';

function context(id: string): AdmissionContext {
  return {
    contractVersion: 1,
    requestId: id,
    rootRequestId: id,
    parentRequestId: null,
    idempotencyKey: id,
    admissionClass: 'process',
    priority: 0,
    demand: { cpuWeight: 1 },
    depth: 0,
    createdAtMs: 1,
    decisionGeneration: 1,
  };
}

function receiptSpies(overrides: { finish?: () => Promise<boolean> } = {}) {
  const finish = vi.fn(overrides.finish ?? (async () => true));
  const cancel = vi.fn(async () => true);
  const execution: GovernedExecution = {
    receiptId: 'lazy-test',
    context: context('minted-receipt'),
    lease: { leaseId: 'l', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish,
    cancel,
  };
  return { finish, cancel, execution };
}

describe('gitSubcommandOf / qualifiesForLazyReceipt (pure)', () => {
  it.each([
    [['rev-parse', 'HEAD'], 'rev-parse'],
    [['-C', '/some/dir', 'log', '-1'], 'log'],
    [['-c', 'core.quotepath=off', 'ls-remote', 'origin'], 'ls-remote'],
    [['--no-pager', '--git-dir=/x/.git', 'cat-file', '--batch'], 'cat-file'],
    [['--git-dir', '/x/.git', '--work-tree', '/x', 'diff-tree'], 'diff-tree'],
    [['--weird-global', 'log'], null], // an option the parser does not know could swallow a token
    [[], null],
    [['-C'], null],
  ] as const)('gitSubcommandOf(%j) = %j', (args, expected) => {
    expect(gitSubcommandOf(args)).toBe(expected);
  });

  it.each([
    ['git', ['rev-parse', '--verify', 'HEAD'], true],
    ['/usr/bin/git', ['-C', '/r', 'cat-file', '--batch-check'], true],
    ['git', ['ls-remote', 'origin', 'refs/heads/main'], true],
    // writers / hook-capable commands stay eager: they deserve a receipt before the child exists
    ['git', ['commit', '-m', 'x'], false],
    ['git', ['push', 'origin', 'staging'], false],
    ['git', ['fetch', 'origin'], false],
    ['git', ['checkout', 'main'], false],
    ['git', ['merge', 'x'], false],
    ['git', ['status', '--porcelain'], false], // fsmonitor can run a hook
    ['git', ['definitely-an-alias'], false],
    ['node', ['rev-parse'], false],
    ['gitk', ['rev-parse'], false],
    ['git', [], false],
  ] as const)('qualifiesForLazyReceipt(%s %j) = %s', (command, args, expected) => {
    expect(qualifiesForLazyReceipt({ command, args: [...args] })).toBe(expected);
  });

  it('exposes a delay long enough that a ~4 ms read never mints but a network ls-remote does', () => {
    expect(SIDECAR_LAZY_RECEIPT_DELAY_MS).toBeGreaterThanOrEqual(250);
    expect(SIDECAR_LAZY_RECEIPT_DELAY_MS).toBeLessThanOrEqual(2_000);
  });
});

describe('verified dev-deploy Git batch classification', () => {
  const safeBatch = buildGitBatchInvocation([
    { repo: '/repo', args: ['log', '-1', '--format=%H%n%ct%n%s', 'main^{commit}'] },
    { repo: '/repo', args: ['rev-list', '--count', 'main..ready'] },
  ], 'dev-deploy-state');

  it('accepts only the generated read-only log/rev-list batch shape', () => {
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: safeBatch.args })).toBe(true);
    expect(qualifiesForLazyReceiptProcess({ command: 'sh', args: safeBatch.args })).toBe(true);
    expect(qualifiesForLazyReceiptProcess({ command: 'sh', args: ['-c', 'echo safe'] })).toBe(false);

    const altered = [...safeBatch.args];
    altered[1] += '; touch /tmp/sidecar-batch-must-not-run';
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: altered })).toBe(false);
  });

  it('records verified batches as read-only Git in receipt metadata', () => {
    expect(sidecarReceiptMetadata({ command: 'sh', args: safeBatch.args })).toEqual({
      processKind: 'sidecar-exec',
      command: 'sh',
      gitSubcommand: 'batch',
      readOnlyGit: true,
    });
  });
});

// The ledger carries no argv, so these two fields are the ONLY way to answer "which git execs still
// mint a receipt after the lazy fix" (WI-10004674 done-when (b)). Pin them against the classifier so
// the label can never disagree with the behaviour it describes.
describe('sidecarReceiptMetadata (receipt attribution)', () => {
  it.each([
    [['rev-parse', 'HEAD'], 'rev-parse', true],
    [['-C', '/r', 'ls-remote', 'origin'], 'ls-remote', true],
    [['status', '--porcelain'], 'status', false],
    [['commit', '-m', 'x'], 'commit', false],
    [['--weird-global', 'log'], 'unknown', false],
    [[], 'unknown', false],
  ] as const)('git %j -> gitSubcommand %s, readOnlyGit %s', (args, subcommand, readOnly) => {
    expect(sidecarReceiptMetadata({ command: 'git', args: [...args] })).toEqual({
      processKind: 'sidecar-exec',
      command: 'git',
      gitSubcommand: subcommand,
      readOnlyGit: readOnly,
    });
  });

  it('readOnlyGit always agrees with qualifiesForLazyReceipt', () => {
    for (const args of [['cat-file', '--batch'], ['fetch'], ['log', '-1'], ['status']]) {
      expect(sidecarReceiptMetadata({ command: 'git', args }).readOnlyGit).toBe(
        qualifiesForLazyReceipt({ command: 'git', args }),
      );
    }
  });

  it('a non-git command carries no git fields (shape unchanged for every other caller)', () => {
    expect(sidecarReceiptMetadata({ command: 'node', args: ['x.js'] })).toEqual({
      processKind: 'sidecar-exec',
      command: 'node',
    });
  });

  it('is deterministic, so a retry under one idempotency key keeps one request digest', () => {
    const a = sidecarReceiptMetadata({ command: 'git', args: ['log', '-1'] });
    const b = sidecarReceiptMetadata({ command: 'git', args: ['log', '-1'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('execProcess lazy receipt (real child processes)', () => {
  let bin: string;
  let marker: string;

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'lazy-receipt-'));
    marker = join(bin, 'child-started');
    // Fake `git`: records that the child started, optionally sleeps, then echoes
    // its argv and the admission context it was handed.
    await writeFile(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        `touch "${marker}"`,
        'sleep "${FAKE_GIT_SLEEP:-0}"',
        'echo "ctx=${PAPERCUSP_ADMISSION_CONTEXT-<unset>}"',
        'echo "args=$*"',
        'exit "${FAKE_GIT_EXIT:-0}"',
      ].join('\n'),
    );
    await chmod(join(bin, 'git'), 0o755);
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  const run = (
    args: string[],
    env: Record<string, string> = {},
    extra: Partial<ExecParams> = {},
  ): ExecParams => ({
    command: 'git',
    args,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
    timeoutMs: 20_000,
    ...extra,
  });

  it('distinguishes a sidecar deadline from an external child signal', async () => {
    const { execution } = receiptSpies();
    const timed = await execProcess({ command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 200,
    }, { beginExecution: async () => execution, killGraceMs: 100 });
    expect(timed.code).toBe(-1);
    expect(timed.error).toEqual({ code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true });

    const signalled = await execProcess({ command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGTERM")'], timeoutMs: 5000,
    }, { beginExecution: async () => execution });
    expect(signalled.code).toBe(-1);
    expect(signalled.error).toEqual({ code: null, signal: 'SIGTERM', killed: false });
  });

  it('a fast read-only git exec never touches the governor (no admit, no lease, no settle)', async () => {
    const { execution, finish, cancel } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const result = await execProcess(run(['rev-parse', 'HEAD']), { beginExecution: begin, lazyReceiptMs: 5_000 });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('args=rev-parse HEAD');
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a fast git check-ignore exec also avoids eager admission', async () => {
    const { execution, finish, cancel } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const result = await execProcess(
      run(['check-ignore', '-q', '--no-index', '--', '.papercusp/state']),
      { beginExecution: begin, lazyReceiptMs: 5_000 },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('args=check-ignore -q --no-index -- .papercusp/state');
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(['stdout', 'stderr'] as const)('caps %s at maxBuffer and terminates the child', async (stream) => {
    const { execution } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const write = stream === 'stdout' ? 'process.stdout.write("abcdef")' : 'process.stderr.write("abcdef")';
    const result = await execProcess({
      command: process.execPath,
      args: ['-e', write + '; setInterval(() => {}, 1000);'],
      timeoutMs: 5_000,
      maxBuffer: 3,
    }, { beginExecution: begin, killGraceMs: 250 });

    expect(begin).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(-1);
    expect(result.maxBufferExceeded, JSON.stringify(result)).toBe(stream);
    expect(Buffer.byteLength(stream === 'stdout' ? result.stdout : result.stderr)).toBe(3);
  });

  it('uses only the supplied environment when inheritEnv is false', async () => {
    const { execution } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const result = await execProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write(JSON.stringify({ path: process.env.PATH ?? null, marker: process.env.PC_EXECFILE_ENV ?? null }))"],
      env: { PC_EXECFILE_ENV: 'child-only' },
      inheritEnv: false,
      timeoutMs: 5_000,
    }, { beginExecution: begin });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: null, marker: 'child-only' });
  });

  it('a fast verified read-only dev-deploy batch also avoids eager admission', async () => {
    const { execution, finish, cancel } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const batch = buildGitBatchInvocation([
      { repo: '/repo', args: ['log', '-1', '--format=%H%n%ct%n%s', 'HEAD'] },
    ], 'dev-deploy-state');
    const result = await execProcess({
      command: 'sh',
      args: batch.args,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      timeoutMs: 20_000,
    }, { beginExecution: begin, lazyReceiptMs: 5_000 });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('args=-C /repo log -1 --format=%H%n%ct%n%s HEAD');
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a read that outlives the delay still gets exactly one receipt, minted late and settled on exit', async () => {
    const { execution, finish, cancel } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const result = await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.6' }), {
      beginExecution: begin,
      lazyReceiptMs: 100,
    });

    expect(result.code).toBe(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ cpuWeight: 1 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('returns on child close while late admission is pending, then settles the receipt in the background', async () => {
    const { execution, finish, cancel } = receiptSpies();
    let resolveBegin!: (execution: GovernedExecution) => void;
    let announceBegin!: () => void;
    let announceClose!: () => void;
    const beginStarted = new Promise<void>((resolve) => { announceBegin = resolve; });
    const childClosed = new Promise<void>((resolve) => { announceClose = resolve; });
    const stages: string[] = [];
    const begin = vi.fn(() => new Promise<GovernedExecution>((resolve) => {
      resolveBegin = resolve;
      announceBegin();
    }));
    const resultPromise = execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.5' }), {
      beginExecution: begin,
      lazyReceiptMs: 50,
      onStage: (stage) => {
        stages.push(stage);
        if (stage === 'child-close') announceClose();
      },
    });

    await beginStarted;
    await childClosed;
    const beforeAdmissionResolves = await Promise.race([
      resultPromise.then((result) => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => { setTimeout(() => resolve({ kind: 'timeout' }), 200); }),
    ]);
    const settlementWasPrematurelyReported = stages.includes('settlement-complete');
    resolveBegin(execution);

    const result = await resultPromise;
    expect(beforeAdmissionResolves.kind).toBe('result');
    expect(result.code).toBe(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(settlementWasPrematurelyReported).toBe(false);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ cpuWeight: 1 });
    expect(cancel).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stages).toContain('settlement-complete'));
  });

  it('the late receipt is minted AFTER the child started (the delay measures runtime, not setup)', async () => {
    const { execution } = receiptSpies();
    await rm(marker, { force: true });
    let childStartedAtBegin: boolean | null = null;
    const begin = vi.fn(async () => {
      childStartedAtBegin = existsSync(marker);
      return execution;
    });
    await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.5' }), { beginExecution: begin, lazyReceiptMs: 100 });
    expect(childStartedAtBegin).toBe(true);
  });

  it('a NON-qualifying command is still admitted BEFORE the child exists, whatever lazyReceiptMs says', async () => {
    const { execution, finish } = receiptSpies();
    await rm(marker, { force: true });
    let childStartedAtBegin: boolean | null = null;
    const begin = vi.fn(async () => {
      childStartedAtBegin = existsSync(marker);
      return execution;
    });
    const result = await execProcess(run(['commit', '-m', 'x']), { beginExecution: begin, lazyReceiptMs: 5_000 });

    expect(result.code).toBe(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(childStartedAtBegin).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    // the child inherits the receipt's own nested-lineage context
    expect(result.stdout).toContain(`ctx=${JSON.stringify(execution.context)}`);
  });

  it('lazyReceiptMs:0 restores eager admission even for a qualifying read', async () => {
    const { execution, finish } = receiptSpies();
    const begin = vi.fn(async () => execution);
    await execProcess(run(['rev-parse', 'HEAD']), { beginExecution: begin, lazyReceiptMs: 0 });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('a lazy read hands the child the caller-supplied PARENT lineage (it has no receipt of its own yet)', async () => {
    const parent = context('caller-parent');
    const begin = vi.fn(async () => receiptSpies().execution);
    const result = await execProcess(run(['rev-parse', 'HEAD'], {}, { admissionContext: parent }), {
      beginExecution: begin,
      lazyReceiptMs: 5_000,
    });
    expect(result.stdout).toContain(`ctx=${JSON.stringify(parent)}`);
    expect(begin).not.toHaveBeenCalled();
  });

  it('a late receipt that fails to mint never fails the read it was documenting', async () => {
    const begin = vi.fn(async () => {
      throw new Error('pg pool exhausted');
    });
    const result = await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.4' }), {
      beginExecution: begin,
      lazyReceiptMs: 100,
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('admission');
  });

  it('a late receipt whose settlement fails never turns a successful read into an error', async () => {
    const { execution, finish } = receiptSpies({
      finish: async () => {
        throw new Error('release UPDATE timed out');
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.4' }), {
        beginExecution: async () => execution,
        lazyReceiptMs: 100,
      });
      expect(finish).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('[governed-execution] settlement failed; lease retained, retry pending', expect.any(Object));
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('settlement failed');
    } finally {
      error.mockRestore();
    }
  });

  it('the exit code of a failing lazy read is preserved', async () => {
    const result = await execProcess(run(['rev-parse', 'nope'], { FAKE_GIT_EXIT: '128' }), {
      beginExecution: async () => receiptSpies().execution,
      lazyReceiptMs: 5_000,
    });
    expect(result.code).toBe(128);
  });

  it('EAGER settlement failures still surface exactly as before (the unchanged contract)', async () => {
    const { execution } = receiptSpies({
      finish: async () => {
        throw new Error('release UPDATE timed out');
      },
    });
    const result = await execProcess(run(['commit', '-m', 'x']), { beginExecution: async () => execution, lazyReceiptMs: 5_000 });
    expect(result.code).toBe(-1);
    expect(result.error).toEqual({ code: 'SIDECAR_SETTLEMENT_FAILED', signal: null, killed: false });
    expect(result.stderr).toContain('sidecar process admission settlement failed');
  });

  it('an already-aborted caller starts nothing and mints nothing', async () => {
    const begin = vi.fn(async () => receiptSpies().execution);
    await rm(marker, { force: true });
    const ac = new AbortController();
    ac.abort();
    const result = await execProcess(run(['rev-parse', 'HEAD']), { beginExecution: begin, lazyReceiptMs: 5_000, signal: ac.signal });
    expect(result.code).toBe(-1);
    expect(begin).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });
});
