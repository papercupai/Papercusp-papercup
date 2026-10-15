import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecProcessDeps } from './sidecar-exec-process';
import type { GovernedExecution } from '../resource-governor/execution';

/**
 * ACCEPTANCE for WI-6404 — the `git cat-file --batch` stdin seam routed through
 * the spawner sidecar by an FD HANDOFF rather than the JSON line.
 *
 * ## What is actually at risk here
 *
 * `defaultRunGit` was moved onto the sidecar long ago; `defaultRunGitStdin` was
 * not, because {@link RunGit} is `(args, cwd)` and cannot feed stdin, so the
 * stdin seam is a SEPARATE type that the earlier conversion simply did not
 * touch. Nothing FAILS when a seam is left behind — it just keeps forking git
 * from the ~4GB bg-host at ~165ms of blocked event loop per call.
 *
 * The reason it could not just be routed the easy way: the RPC is
 * line-delimited JSON, and this seam carries multi-MB blob CONTENTS whose exact
 * BYTE OFFSETS are load-bearing. `--batch` frames are
 * `<oid> SP <type> SP <size> LF <contents> LF`, walked by the declared size, so
 * one shifted byte desynchronises every frame after it. Base64-over-JSON would
 * have preserved the bytes but put a multi-MB `JSON.parse` on the main thread
 * at both ends — trading a fork stall for a parse stall, which defeats the
 * entire purpose.
 *
 * So these tests assert the property the design exists to guarantee: bytes out
 * of the sidecar are IDENTICAL to bytes out of a local spawn, for content that
 * would break under any string round-trip. A test using ASCII fixtures would
 * pass against a broken implementation — that is precisely the failure mode
 * here, so every fixture below is deliberately non-ASCII or outright binary.
 */

// Mock ONLY the two things that are genuinely out of process: launching the
// sidecar child, and the Unix-socket hop. `execProcess` underneath is the REAL
// server-side implementation running REAL git, so the whole byte path
// (tmpfile → fd → git → fd → readback → size cross-check) is exercised.
let rpcOverride: ((params: unknown) => Promise<unknown>) | null = null;

function testExecution(): GovernedExecution {
  return {
    receiptId: 'test-receipt',
    context: {
      contractVersion: 1,
      requestId: 'test-request',
      rootRequestId: 'test-request',
      parentRequestId: null,
      idempotencyKey: 'test-sidecar-process',
      admissionClass: 'process',
      priority: 0,
      demand: { cpuWeight: 1 },
      depth: 0,
      createdAtMs: 1,
      decisionGeneration: 1,
    },
    lease: { leaseId: 'test-lease', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
  };
}

// lazyReceiptMs:0 — these tests pin admit-BEFORE-spawn; the lazy path has its own suite
// (sidecar-exec-lazy-receipt.test.ts).
const executionDeps: ExecProcessDeps = { beginExecution: async () => testExecution(), lazyReceiptMs: 0 };

vi.mock('./spawner-sidecar-spawn', () => ({
  spawnSpawnerSidecar: async () => {},
}));

vi.mock('./spawner-ipc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spawner-ipc-client')>()),
  getSpawnerIpcClient: () => ({
    call: async (_method: string, params: unknown) => {
      if (rpcOverride) return rpcOverride(params);
      const { execProcess } = await import('./sidecar-exec-process');
      return execProcess(params as Parameters<typeof execProcess>[0], executionDeps);
    },
  }),
}));

/** A blob whose UTF-8 byte length differs from its JS string length, plus
 *  characters outside the BMP — the exact shape that shifts every subsequent
 *  frame offset if anything decodes the stream to a string. */
const UNICODE_CONTENT = 'héllo wörld — 日本語テキスト 🎉🔥 ✓ Ω≈ç√\nsecond line ünïcödé\n';

/** Raw bytes 0x00–0xFF, which are not valid UTF-8 at all: any decode/encode
 *  round-trip mangles them into replacement characters. */
const BINARY_CONTENT = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

let repo: string;
let unicodeOid: string;
let binaryOid: string;
let asciiOid: string;

function git(args: string[], input?: Buffer | string): string {
  return execFileSync('git', args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'wi6404-handoff-'));
  execFileSync('git', ['init', '-q', repo]);
  unicodeOid = git(['hash-object', '-w', '--stdin'], Buffer.from(UNICODE_CONTENT, 'utf8'));
  binaryOid = git(['hash-object', '-w', '--stdin'], BINARY_CONTENT);
  asciiOid = git(['hash-object', '-w', '--stdin'], Buffer.from('plain ascii\n', 'utf8'));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Walk `cat-file --batch` output by BYTE offset, exactly as the real callers
 *  (readScannableBlobs / readTextBlobs) do. */
function parseBatchFrames(buf: Buffer): { oid: string; content: Buffer }[] {
  const out: { oid: string; content: Buffer }[] = [];
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) break;
    const [oid, type, sizeS] = buf.toString('utf8', off, nl).trim().split(/\s+/);
    off = nl + 1;
    if (!oid || type !== 'blob') continue;
    const size = Number(sizeS ?? 0);
    if (!Number.isFinite(size) || off + size > buf.length) break;
    out.push({ oid, content: buf.subarray(off, off + size) });
    off += size + 1; // skip the trailing LF
  }
  return out;
}

describe('WI-6404 — cat-file --batch through the sidecar fd handoff', () => {
  it('the fixtures really would break a string round-trip (guards the test itself)', () => {
    // If this ever stops holding, every assertion below becomes vacuous: an
    // implementation that decoded to a string would pass on pure-ASCII input.
    expect(Buffer.byteLength(UNICODE_CONTENT, 'utf8')).toBeGreaterThan(UNICODE_CONTENT.length);
    expect(Buffer.from(BINARY_CONTENT.toString('utf8'), 'utf8')).not.toEqual(BINARY_CONTENT);
  });

  it('returns byte-IDENTICAL output to a local spawn for non-ASCII and binary blobs', async () => {
    const { runGitStdinLocal, defaultRunGitStdin } = await import('../sync/pot-git/storage');
    const args = ['cat-file', '--batch', '--buffer'];
    const oids = [unicodeOid, binaryOid, asciiOid].join('\n') + '\n';

    const local = await runGitStdinLocal(args, repo, oids);
    process.env.PAPERCUSP_POT_GIT_SPAWN_SIDECAR = '1';
    delete process.env.PAPERCUSP_SPAWNER_SIDECAR_MODE;
    let viaSidecar;
    try {
      viaSidecar = await defaultRunGitStdin(args, repo, oids);
    } finally {
      delete process.env.PAPERCUSP_POT_GIT_SPAWN_SIDECAR;
    }

    expect(viaSidecar.code).toBe(0);
    expect(local.code).toBe(0);
    // Buffer.equals is the whole point — a length match alone would not catch
    // a replacement-character substitution, which preserves neither bytes nor,
    // for multi-byte input, length.
    expect(viaSidecar.stdout.equals(local.stdout)).toBe(true);
  });

  it('preserves exact byte offsets, so the frame walk recovers every blob intact', async () => {
    const { defaultRunGitStdin } = await import('../sync/pot-git/storage');
    process.env.PAPERCUSP_POT_GIT_SPAWN_SIDECAR = '1';
    let res;
    try {
      res = await defaultRunGitStdin(
        ['cat-file', '--batch', '--buffer'],
        repo,
        [unicodeOid, binaryOid, asciiOid].join('\n') + '\n',
      );
    } finally {
      delete process.env.PAPERCUSP_POT_GIT_SPAWN_SIDECAR;
    }

    const frames = parseBatchFrames(res.stdout);
    // Three frames recovered at all is itself the offset assertion: a desynced
    // stream loses the frames AFTER the first non-ASCII one.
    expect(frames.map((f) => f.oid)).toEqual([unicodeOid, binaryOid, asciiOid]);
    expect(frames[0].content.toString('utf8')).toBe(UNICODE_CONTENT);
    expect(frames[1].content.equals(BINARY_CONTENT)).toBe(true);
    expect(frames[2].content.toString('utf8')).toBe('plain ascii\n');
  });

  it('leaves no handoff file behind — the payload briefly holds repo blob contents', async () => {
    const { runGitStdinViaSpawnerSidecar } = await import('./git-via-sidecar');
    const dir = existsSync('/dev/shm')
      ? join('/dev/shm', `papercusp-git-stdin-${process.pid}`)
      : join(tmpdir(), `papercusp-git-stdin-${process.pid}`);

    await runGitStdinViaSpawnerSidecar(
      ['cat-file', '--batch', '--buffer'],
      repo,
      unicodeOid + '\n',
      60_000,
      process.env,
    );
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it('REJECTS a short read rather than returning a truncated stream', async () => {
    const { runGitStdinViaSpawnerSidecar } = await import('./git-via-sidecar');
    // A truncated `--batch` stream is the corruption this design exists to rule
    // out; it must fail loudly onto the local fallback, never be handed back as
    // a plausible-looking short buffer.
    rpcOverride = async (params) => {
      const { execProcess } = await import('./sidecar-exec-process');
      const real = await execProcess(params as Parameters<typeof execProcess>[0], executionDeps);
      return { ...real, stdoutBytes: (real.stdoutBytes ?? 0) + 1 };
    };
    try {
      await expect(
        runGitStdinViaSpawnerSidecar(['cat-file', '--batch', '--buffer'], repo, unicodeOid + '\n', 60_000, process.env),
      ).rejects.toThrow(/size mismatch/);
    } finally {
      rpcOverride = null;
    }
  });

  it('preserves typed process failure metadata through the fd handoff', async () => {
    const { runGitStdinViaSpawnerSidecar } = await import('./git-via-sidecar');
    const error = { code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true };
    rpcOverride = async () => ({ code: -1, stdout: '', stderr: 'sidecar deadline', stdoutBytes: 0, error });
    try {
      expect(await runGitStdinViaSpawnerSidecar(
        ['cat-file', '--batch'], repo, unicodeOid + '\n', 60_000, process.env,
      )).toEqual({ code: -1, stdout: Buffer.alloc(0), stderr: 'sidecar deadline', error });
    } finally {
      rpcOverride = null;
    }
  });

  it('falls back to the LOCAL spawn — with the same bytes — when the sidecar fails', async () => {
    const { defaultRunGitStdin, runGitStdinLocal } = await import('../sync/pot-git/storage');
    const args = ['cat-file', '--batch', '--buffer'];
    const oids = [unicodeOid, binaryOid].join('\n') + '\n';
    const expected = await runGitStdinLocal(args, repo, oids);

    rpcOverride = async () => {
      throw new Error('sidecar unreachable (simulated)');
    };
    // The fallback is EXPECTED to warn once, so assert on it rather than let it
    // trip fail-on-console: a silent fallback would hide a permanently-degraded
    // sidecar, which is the whole reason this path logs at all.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PAPERCUSP_POT_GIT_SPAWN_SIDECAR = '1';
    let res;
    let warnings: string[];
    try {
      res = await defaultRunGitStdin(args, repo, oids);
    } finally {
      rpcOverride = null;
      delete process.env.PAPERCUSP_POT_GIT_SPAWN_SIDECAR;
      // Snapshot the calls BEFORE restoring — mockRestore() clears the history.
      warnings = warn.mock.calls.map((c) => String(c[0]));
      warn.mockRestore();
    }
    // A sidecar fault must degrade PERFORMANCE, never correctness.
    expect(res.code).toBe(0);
    expect(res.stdout.equals(expected.stdout)).toBe(true);
    expect(warnings.join('\n')).toContain('sidecar unreachable (simulated)');
  });

  it('the stdin leg carries non-ASCII intact too (fd handoff, not a JSON string)', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const { writeFile, readFile, mkdtemp } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'wi6404-stdin-'));
    const inPath = join(dir, 'in');
    const outPath = join(dir, 'out');
    // `cat` echoes stdin byte-for-byte, isolating the INPUT leg of the handoff.
    await writeFile(inPath, BINARY_CONTENT);
    await writeFile(outPath, '');
    const res = await execProcess({ command: 'cat', stdinPath: inPath, stdoutPath: outPath }, executionDeps);
    expect(res.code).toBe(0);
    expect(res.stdoutBytes).toBe(BINARY_CONTENT.length);
    expect((await readFile(outPath)).equals(BINARY_CONTENT)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a bad handoff path comes back as a non-zero RESULT, not a thrown RPC error', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    // Callers' contract is degrade-to-local; a throw here would escape as an
    // RPC error and could surface as a git failure instead of a fallback.
    const res = await execProcess({
      command: 'git',
      args: ['cat-file', '--batch'],
      stdinPath: '/nonexistent/wi6404/in',
      stdoutPath: '/nonexistent/wi6404/out',
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toMatch(/could not open a handoff file/);
  });

  // The idle clock is armed at spawn (sidecar-exec-process.ts armIdleTimer), so a
  // child's `node` boot counts against the FIRST idle window. Under the gate's
  // parallel stateful lane a boot of 300ms+ is ordinary, which is how a 300ms
  // window reddened repair head aa948759 (WI-10004029). The windows below keep
  // the property each test names (writes span several idle windows; a stop is
  // detected; the hard deadline wins) while leaving >1s of boot headroom.
  const IDLE_MS = 1_500;

  it('recognizes binary stdout-file progress across idle deadlines without piping its bytes', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const { readFile } = await import('node:fs/promises');
    const dir = mkdtempSync(join(tmpdir(), 'fd-progress-'));
    const outPath = join(dir, 'out');
    const chunk = Buffer.from([0, 255, 128, 195, 169, 10]);
    const writes = 12;
    const intervalMs = 300;
    // 12 x 300ms spans 2.4 idle windows, so only observed file growth keeps it alive.
    expect(writes * intervalMs).toBeGreaterThan(2 * IDLE_MS);
    const onOutputActivity = vi.fn();
    try {
      const result = await execProcess({
        command: process.execPath,
        args: ['-e', `const b=Buffer.from('${chunk.toString('base64')}','base64'); let n=0; const t=setInterval(()=>{require('node:fs').writeSync(1,b); if(++n===${writes}) clearInterval(t);},${intervalMs});`],
        stdoutPath: outPath,
        idleTimeoutMs: IDLE_MS,
        timeoutMs: 20_000,
      }, { ...executionDeps, onOutputActivity });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stdoutBytes).toBe(chunk.length * writes);
      expect(await readFile(outPath)).toEqual(Buffer.concat(Array.from({ length: writes }, () => chunk)));
      expect(onOutputActivity).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out a stdout-file child once its writes stop', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const dir = mkdtempSync(join(tmpdir(), 'fd-silent-'));
    try {
      const result = await execProcess({
        command: process.execPath,
        args: ['-e', "require('node:fs').writeSync(1, 'once'); setInterval(()=>{},1000);"],
        stdoutPath: join(dir, 'out'),
        idleTimeoutMs: IDLE_MS,
        timeoutMs: 20_000,
      }, executionDeps);
      expect(result.code).toBe(-1);
      expect(result.stdoutBytes).toBe(4);
      expect(result.stderr).toContain(`made no output progress for ${IDLE_MS}ms`);
      expect(result.stderr).not.toContain('timed out after 20000ms');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains the hard deadline while stdout-file writes continue', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const dir = mkdtempSync(join(tmpdir(), 'fd-hard-deadline-'));
    try {
      const result = await execProcess({
        command: process.execPath,
        args: ['-e', "setInterval(()=>require('node:fs').writeSync(1,'progress'),40);"],
        stdoutPath: join(dir, 'out'),
        idleTimeoutMs: IDLE_MS,
        timeoutMs: 2 * IDLE_MS,
      }, executionDeps);
      expect(result.code).toBe(-1);
      expect(result.stdoutBytes).toBeGreaterThan(0);
      expect(result.stderr).toContain(`timed out after ${2 * IDLE_MS}ms`);
      expect(result.stderr).not.toContain('no output progress');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['stderr-progress', 'abort', 'hard-deadline'] as const)('invalidates a pending stdout-file probe after %s', async (mode) => {
    const { execProcess } = await import('./sidecar-exec-process');
    const { open, writeFile } = await import('node:fs/promises');
    const dir = mkdtempSync(join(tmpdir(), 'fd-probe-race-'));
    const notifyPath = join(dir, 'notify');
    const finishPath = join(dir, 'finish');
    // Pause one REAL fstat result after the kernel returns it. File contents
    // stay real; this only controls callback delivery relative to pipe/abort.
    const seed = await open(join(dir, 'seed'), 'w');
    const prototype = Object.getPrototypeOf(seed) as typeof seed;
    const originalStat = prototype.stat;
    await seed.close();
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    let releaseProbe!: () => void;
    const pending = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const statSpy = vi.spyOn(prototype, 'stat').mockImplementationOnce(async function (this: typeof seed) {
      const snapshot = await originalStat.call(this);
      probeStarted();
      await pending;
      return snapshot;
    });
    const controller = new AbortController();
    let pipeProgress!: () => void;
    const progress = new Promise<void>((resolve) => { pipeProgress = resolve; });
    const onOutputActivity = vi.fn(() => pipeProgress());
    const result = execProcess({
      command: process.execPath,
      args: ['-e', `const fs=require('node:fs'); let sent=false; setInterval(()=>{if(!sent&&fs.existsSync(${JSON.stringify(notifyPath)})){sent=true;process.stderr.write('progress');} if(fs.existsSync(${JSON.stringify(finishPath)}))process.exit(0);},10);`],
      stdoutPath: join(dir, 'out'),
      // idle-window-ok: the idle tick is the TRIGGER that starts the paused stdout-file probe; the pending probe suspends idle judgement, so boot time cannot idle-kill this child.
      idleTimeoutMs: 300,
      timeoutMs: 1800,
    }, { ...executionDeps, signal: controller.signal, onOutputActivity });
    try {
      await started;
      if (mode === 'stderr-progress') {
        await writeFile(notifyPath, 'notify');
        await progress;
        releaseProbe();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await writeFile(finishPath, 'finish');
        expect((await result).code).toBe(0);
      } else {
        if (mode === 'abort') controller.abort();
        // The hard deadline or abort must settle independently of the stale
        // fstat callback; releasing it later cannot resume progress or timers.
        const returned = await result;
        expect(returned.code).toBe(-1);
        expect(returned.stderr).toContain(mode === 'abort' ? 'aborted by caller' : 'timed out after 1800ms');
        releaseProbe();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(onOutputActivity).not.toHaveBeenCalled();
      }
    } finally {
      releaseProbe();
      controller.abort();
      await result;
      statSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without handoff paths, process:exec still pipes stdout as a string (existing callers untouched)', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const res = await execProcess(
      { command: 'git', args: ['rev-parse', '--is-bare-repository'], cwd: repo },
      executionDeps,
    );
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('false');
  });

  it('propagates the governed child context and exact-releases on close', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const finish = vi.fn(async () => true);
    const cancel = vi.fn(async (_reason: string) => true);
    const beginExecution = vi.fn(async (params: Parameters<NonNullable<ExecProcessDeps['beginExecution']>>[0]) => ({
      ...(await executionDeps.beginExecution!(params)),
      finish,
      cancel,
    }));
    const res = await execProcess(
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.PAPERCUSP_ADMISSION_CONTEXT || "")'],
      },
      { beginExecution },
    );

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ requestId: 'test-request', admissionClass: 'process' });
    expect(beginExecution).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith({ cpuWeight: 1 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels the durable receipt when the child cannot spawn', async () => {
    const { execProcess } = await import('./sidecar-exec-process');
    const finish = vi.fn(async () => true);
    const cancel = vi.fn(async (_reason: string) => true);
    const res = await execProcess(
      { command: '/definitely-not-a-real-wi42343-binary' },
      {
        beginExecution: async (params) => ({
          ...(await executionDeps.beginExecution!(params)),
          finish,
          cancel,
        }),
      },
    );

    expect(res.code).toBe(-1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(String(cancel.mock.calls[0]?.[0])).toContain('spawn error');
  });
});
