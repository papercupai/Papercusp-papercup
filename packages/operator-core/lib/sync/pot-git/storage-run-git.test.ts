import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * `defaultRunGit` routes git through the spawner sidecar so the big operator
 * process never pays fork()'s page-table-copy cost (~40ms per GB of its own
 * RSS, ~165ms per git call on the 4.2GB bg-host — EI-18808838427010743).
 *
 * The property that actually matters is NOT "it uses the sidecar" — it is that
 * routing is INVISIBLE to callers: same exit code, same stdout, same stderr,
 * and a sidecar fault degrades PERFORMANCE, never CORRECTNESS. pot-git's ref
 * reads decide what gets integrated and published to peers, so a git result
 * that silently changes shape here is a correctness bug in the sync protocol,
 * not a perf bug.
 */

// Mocked so the fallback can be driven deterministically without a real sidecar.
vi.mock('../../fleet/git-via-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../fleet/git-via-sidecar')>();
  return {
    ...actual,
    gitSidecarEnabled: (...a: unknown[]) => sidecarEnabledMock(...(a as [])),
    runGitViaSpawnerSidecar: (...a: unknown[]) => sidecarRunMock(...(a as [])),
    runGitStdinViaSpawnerSidecar: (...a: unknown[]) => stdinSidecarRunMock(...(a as [])),
  };
});

let sidecarEnabledMock: (...a: unknown[]) => boolean = () => false;
let sidecarRunMock: (...a: unknown[]) => Promise<{ code: number; stdout: string; stderr: string }> =
  () => Promise.reject(new Error('not configured'));
let stdinSidecarRunMock: (...a: unknown[]) => Promise<{ code: number; stdout: Buffer; stderr: string }> =
  () => Promise.reject(new Error('not configured'));

const {
  defaultRunGit,
  defaultRunGitStdin,
  localSpawnRefusalFor,
  potGitLocalSpawnAdmission,
  POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB,
  runGitLocal,
  runGitStdinLocal,
} = await import('./storage');

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'potgit-rungit-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'seed');
});

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe('pot-git defaultRunGit', () => {
  it('with the sidecar OFF, returns real git output via the local spawn', async () => {
    sidecarEnabledMock = () => false;
    const r = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a NON-ZERO exit for a bad ref instead of throwing', async () => {
    // readNamespaceRef depends on this: "ref absent" is a code!==0, not a throw.
    sidecarEnabledMock = () => false;
    const r = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/nope/nothing^{object}'], repo);
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('FALLS BACK to the local spawn when the sidecar fails, with an identical result', async () => {
    // The safety property: a sidecar fault must not break git. If this ever
    // regresses, a sidecar outage would silently make every pot-git ref read
    // look like "ref absent" — which the integrator reads as "this member has
    // published nothing", i.e. silent data loss rather than a loud failure.
    const local = await runGitLocal(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);

    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.reject(new Error('ECONNREFUSED /run/nope.sock'));

    // The fallback is expected to announce itself exactly once per distinct
    // reason — loudly enough to diagnose, not once per git call (this is the
    // hot ref-read path; per-call logging would itself become a cost).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const viaFallback = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
      expect(viaFallback.code).toBe(local.code);
      expect(viaFallback.stdout).toBe(local.stdout);

      const again = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
      expect(again.stdout).toBe(local.stdout);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses the local fallback at the high-RSS fork-tax ceiling instead of spawning', async () => {
    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.reject(new Error('ECONNREFUSED /run/nope.sock'));
    const rss = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });
    try {
      const r = await defaultRunGit(['rev-parse', '--verify', '-q', 'HEAD^{object}'], repo);
      expect(r.code).toBe(-1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/refusing local git spawn/);
      expect(r.stderr).toContain(`limit ${POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB}MB`);
    } finally {
      rss.mockRestore();
    }
  });

  it('uses the sidecar result verbatim when the sidecar answers', async () => {
    sidecarEnabledMock = () => true;
    sidecarRunMock = () => Promise.resolve({ code: 0, stdout: 'from-sidecar\n', stderr: '' });
    const r = await defaultRunGit(['rev-parse', 'HEAD'], repo);
    expect(r.stdout).toBe('from-sidecar\n');
  });

  it('reports local child output as progress activity', async () => {
    sidecarEnabledMock = () => false;
    const onProgress = vi.fn();

    const r = await runGitLocal(['--version'], repo, { onProgress });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('git version');
    expect(onProgress).toHaveBeenCalled();
  });

  it('forwards the progress callback to the sidecar transport', async () => {
    sidecarEnabledMock = () => true;
    const onProgress = vi.fn();
    sidecarRunMock = (...a: unknown[]) => {
      const opts = a[4] as { onProgress?: () => void } | undefined;
      opts?.onProgress?.();
      return Promise.resolve({ code: 0, stdout: 'from-sidecar\n', stderr: '' });
    };

    const r = await defaultRunGit(['rev-parse', 'HEAD'], repo, { onProgress });

    expect(r.code).toBe(0);
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it('passes the C locale through to the sidecar so output stays parse-stable', async () => {
    // Every caller parses git's human-readable output; a host LANG leaking
    // through would change that text and break the parsing at the root.
    sidecarEnabledMock = () => true;
    let seenEnv: Record<string, string> | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenEnv = a[3] as Record<string, string>;
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    await defaultRunGit(['status'], repo);
    expect(seenEnv?.LC_ALL).toBe('C');
    expect(seenEnv?.LANG).toBe('C');
  });

  it('forwards the caller timeout override to the sidecar (network ops need a generous one)', async () => {
    sidecarEnabledMock = () => true;
    let seenTimeout: number | undefined;
    sidecarRunMock = (...a: unknown[]) => {
      seenTimeout = a[2] as number;
      return Promise.resolve({ code: 0, stdout: (a[0] as string[])[0] === 'rev-parse' ? join(repo, '.git/objects') : '', stderr: '' });
    };
    await defaultRunGit(['fetch'], repo, { timeoutMs: 240_000 });
    expect(seenTimeout).toBe(240_000);
  });

  it.skipIf(process.platform === 'win32')('cancels local Git and waits for its helper to exit', async () => {
    const controller = new AbortController();
    const receipt = join(repo, 'helper.pid');
    const result = runGitLocal(['-c', `alias.wait=!echo $$ > '${receipt}'; exec sleep 30`, 'wait'], repo,
      { timeoutMs: 30_000, signal: controller.signal });
    let pid = 0;
    try {
      // vi.waitFor defaults to a 1s budget. Spawning git, which then runs the alias
      // shell that writes the receipt, exceeded that under gate load (ENOENT at
      // 33144c00, WI-10008204), so give the spawn the room its own 30s timeout implies.
      await vi.waitFor(
        async () => { pid = Number(await readFile(receipt, 'utf8')); expect(pid).toBeGreaterThan(0); },
        { timeout: 15_000, interval: 50 },
      );
      controller.abort();
      expect((await result).code).toBe(-1);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await result;
    }
  }, 30_000);
});

describe('pot-git local stdin runner environment forwarding', () => {
  it('forwards a private GIT_INDEX_FILE to the Git child', async () => {
    const privateIndex = join(repo, '.git', 'private-index');
    const result = await runGitStdinLocal(['rev-parse', '--git-path', 'index'], repo, '', {
      env: { GIT_INDEX_FILE: privateIndex },
    });
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8').trim()).toContain('private-index');
  });
});

describe('pot-git local-spawn RSS admission (EI-20282995952031769)', () => {
  it('blocks the observed multi-GB parent band at and above the default ceiling', () => {
    const atLimit = potGitLocalSpawnAdmission(POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB * 1024 * 1024);
    const aboveLimit = potGitLocalSpawnAdmission((POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB + 1) * 1024 * 1024);
    expect(atLimit).toMatchObject({ allowed: false, limitMb: POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB });
    expect(aboveLimit.allowed).toBe(false);
  });

  it('keeps the local path available below the ceiling and honors a positive override', () => {
    expect(potGitLocalSpawnAdmission((POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB - 1) * 1024 * 1024).allowed).toBe(true);
    expect(
      potGitLocalSpawnAdmission(5000 * 1024 * 1024, {
        PAPERCUSP_POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB: '6000',
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ allowed: true, rssMb: 5000, limitMb: 6000 });
  });

  it('returns a loud transient failure for the stdin fallback too', async () => {
    // The refusal applies only where the sidecar is the configured path, so the
    // direct local call is the FALLBACK here (WI-10004179).
    sidecarEnabledMock = () => true;
    const rss = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });
    try {
      const r = await runGitStdinLocal(['cat-file', '--batch-check'], repo, 'HEAD\n');
      expect(r.code).toBe(-1);
      expect(r.stdout).toEqual(Buffer.alloc(0));
      expect(r.stderr).toMatch(/refusing local git spawn/);
    } finally {
      rss.mockRestore();
    }
  });

  it('routes the stdin sidecar failure through the guarded local fallback', async () => {
    sidecarEnabledMock = () => true;
    stdinSidecarRunMock = () => Promise.reject(new Error('ECONNREFUSED /run/nope.sock'));
    const rss = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });
    try {
      const r = await defaultRunGitStdin(['cat-file', '--batch-check'], repo, 'HEAD\n');
      expect(r.code).toBe(-1);
      expect(r.stdout).toEqual(Buffer.alloc(0));
      expect(r.stderr).toMatch(/refusing local git spawn/);
    } finally {
      rss.mockRestore();
    }
  });

  // WI-10004179: a packaged desktop owner configures NO spawner sidecar, so
  // local spawn is its ONLY git path. Refusing there was a permanent pot-git
  // outage above the ceiling (measured: a same-box owner at 4643MB could not
  // `init --bare` its pot store), not the transient fallback refusal above.
  it('admits local git above the ceiling when no sidecar is configured, warning once', async () => {
    sidecarEnabledMock = () => false;
    const expected = await runGitLocal(['rev-parse', 'HEAD'], repo);
    expect(expected.code).toBe(0);
    const rss = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: (POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB + 600) * 1024 * 1024,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const viaDefault = await defaultRunGit(['rev-parse', 'HEAD'], repo);
      expect(viaDefault).toMatchObject({ code: 0, stdout: expected.stdout });

      const viaStdin = await defaultRunGitStdin(['cat-file', '--batch-check'], repo, 'HEAD\n');
      expect(viaStdin.code).toBe(0);
      expect(viaStdin.stdout.toString()).toMatch(/ commit \d+\n$/);

      const warnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no spawner sidecar configured'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`above ${POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB}MB`);
    } finally {
      warn.mockRestore();
      rss.mockRestore();
    }
  });

  it('decides refusal from sidecar configuration, not from RSS alone', () => {
    const above = potGitLocalSpawnAdmission((POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB + 1) * 1024 * 1024);
    const below = potGitLocalSpawnAdmission((POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB - 1) * 1024 * 1024);
    expect(localSpawnRefusalFor(above, true)).toMatch(/refusing local git spawn/);
    expect(localSpawnRefusalFor(below, true)).toBeNull();
    expect(localSpawnRefusalFor(below, false)).toBeNull();
  });
});
