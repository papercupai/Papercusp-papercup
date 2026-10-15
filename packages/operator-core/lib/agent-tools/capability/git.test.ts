/**
 * Unit tests for capability:git's runGit spawn (P-010; EI-1617 env-scrub fix).
 *
 * runGit spawns the real `git` binary directly (no shell), so an env-leak
 * regression test can't just `printf "$SECRET"`. Git's `!`-prefixed custom
 * aliases DO run through a shell, though (`git -c alias.x='!cmd' x`), which
 * gives an honest end-to-end probe of the CHILD PROCESS's actual env without
 * mocking anything — the exact vector a bee's `capability:git` would have had.
 */
import { ChildProcess, execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityBwrapWorks } from './exec-sandbox';
import capabilityGit, { createScratchClone, emptyPathspecNote, runGit, runGitReadOnlyEvidence } from './git';
import { createScratchClone as createLocalScratchClone, estimateScratchGitTimeout, runLocalGit,
  SCRATCH_GIT_BASE_TIMEOUT_MS, SCRATCH_GIT_MAX_TIMEOUT_MS } from '../../scratch-git-clone';

const spawnCalls = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnCalls(...args);
      return actual.spawn(...args);
    },
  };
});

const STATE = mkdtempSync(join(tmpdir(), 'cap-git-'));
const never = new AbortController().signal;
const cleanup: string[] = [];

afterAll(() => rmSync(STATE, { recursive: true, force: true }));

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Scratch Clone Test']);
  git(root, ['config', 'user.email', 'scratch-clone@example.invalid']);
  writeFileSync(join(root, 'tracked.txt'), `${prefix}\n`);
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '--quiet', '-m', 'initial']);
  return root;
}

describe('runGit', () => {
  it('runs a plain git subcommand', async () => {
    const r = await runGit(['--version'], STATE, STATE, never);
    expect(r.code).toBe(0);
    expect(r.output).toContain('git version');
  });
});

describe('standalone scratch Git failure diagnostics (EI-25802116941940647)', () => {
  function diagnostic(output: string): Record<string, unknown> {
    const line = output.split('\n').find(line => line.startsWith('[scratch-git-runner] '));
    expect(line).toBeDefined();
    return JSON.parse(line!.slice('[scratch-git-runner] '.length));
  }

  it('preserves an actual Git rejection and its exit code through scratchClone', async () => {
    const source = repository('cap-git-diagnostic-');
    const { createScratchClone: clone } = await import('../../scratch-git-clone');
    const error = await clone({ source, ref: 'missing-ref', signal: never }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('scratchClone.ref does not resolve');
    expect(diagnostic(error.message)).toMatchObject({
      kind: 'exit', errorCode: 128, killed: false, signal: null, aborted: false, timeoutMs: 60_000,
    });
    expect(error.message).toContain('fatal:');
  });

  it('distinguishes a real caller abort from a Git rejection or deadline', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runLocalGit(['--version'], STATE, controller.signal);
    expect(result.code).toBeNull();
    expect(diagnostic(result.output)).toMatchObject({
      kind: 'aborted', errorCode: 'ABORT_ERR', aborted: true, timeoutMs: 60_000,
    });
  });

  it.each([
    ['terminated', { code: null, killed: true, signal: 'SIGTERM' }],
    ['output-limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }],
    ['spawn-error', { code: 'ENOENT' }],
  ])('preserves %s metadata without interpreting every kill as timeout', async (kind, metadata) => {
    vi.stubEnv('PC_HEAVY_ADMISSION_DIR', '');
    vi.stubEnv('PC_HEAVY_ADMISSION_ID', '');
    const failure = Object.assign(new Error('fixture failure'), metadata);
    const mocked = vi.mocked(execFile);
    mocked.mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error, stdout: string, stderr: string) => void;
      callback(failure, 'partial stdout', 'partial stderr');
    }) as typeof execFile);
    try {
      const result = await runLocalGit(['checkout', '--detach', 'fixture'], STATE, never);
      expect(result.code).toBeNull();
      expect(result.output).toContain('partial stdoutpartial stderr\nfixture failure');
      const detail = diagnostic(result.output);
      expect(detail).toMatchObject({ kind, errorCode: metadata.code, killed: 'killed' in metadata,
        signal: 'signal' in metadata ? metadata.signal : null, aborted: false, timeoutMs: 60_000,
        deadlineReached: false });
      expect(detail.durationMs).toEqual(expect.any(Number));
      expect(detail.durationMs).toBeGreaterThanOrEqual(0);
      expect(mocked.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    } finally { mocked.mockClear(); vi.unstubAllEnvs(); }
  });

  it('keeps successful output free of failure diagnostics', async () => {
    const result = await runLocalGit(['--version'], STATE, never);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^git version/);
    expect(result.output).not.toContain('[scratch-git-runner]');
  });

  it('forwards a measured committed-tree deadline while retaining the bounded default', async () => {
    vi.stubEnv('PC_HEAVY_ADMISSION_DIR', '');
    vi.stubEnv('PC_HEAVY_ADMISSION_ID', '');
    const mocked = vi.mocked(execFile);
    mocked.mockImplementationOnce(((...args: unknown[]) => {
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(null, 'ok', '');
    }) as typeof execFile);
    try {
      const result = await runLocalGit(['--version'], STATE, never, 180_000);
      expect(result).toEqual({ code: 0, output: 'ok' });
      expect(mocked.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 180_000 });
      expect(estimateScratchGitTimeout({ bytes: 0, entries: 0 })).toBe(SCRATCH_GIT_BASE_TIMEOUT_MS);
      expect(estimateScratchGitTimeout({ bytes: 1_683_640_292, entries: 32_412 })).toBeGreaterThan(SCRATCH_GIT_BASE_TIMEOUT_MS);
      expect(estimateScratchGitTimeout({ bytes: Number.MAX_SAFE_INTEGER, entries: Number.MAX_SAFE_INTEGER }))
        .toBe(SCRATCH_GIT_MAX_TIMEOUT_MS);
    } finally { mocked.mockClear(); vi.unstubAllEnvs(); }
  });

  it.each([0, 70_000])('charges active Git time, excluding %i ms of admission suspension', async (freezeMs) => {
    const admissionId = 'scratch-deadline-fixture';
    const record = join(STATE, `${admissionId}.state`);
    writeFileSync(record, 'frozen_total_ms=500\n');
    vi.stubEnv('PC_HEAVY_ADMISSION_DIR', STATE);
    vi.stubEnv('PC_HEAVY_ADMISSION_ID', admissionId);
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let callback!: (error: Error | null, stdout: string, stderr: string) => void;
    const kill = vi.fn(() => {
      callback(Object.assign(new Error('deadline fixture'), { code: null, signal: 'SIGTERM', killed: true }), '', '');
      return true;
    });
    vi.mocked(execFile).mockImplementationOnce((...args) => {
      callback = args.at(-1) as typeof callback;
      const child = new ChildProcess();
      child.kill = kill;
      return child;
    });
    try {
      const result = runLocalGit(['checkout', '--detach', 'fixture'], STATE, never);
      expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 0 });
      writeFileSync(record, `frozen_total_ms=${500 + freezeMs}\n`);
      clock.mockReturnValue(60_000 + freezeMs);
      // Both cases have the same 60 seconds of active execution. The old
      // execFile wall timer would instead consume the suspended interval.
      vi.advanceTimersByTime(60_000);
      expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
      expect(diagnostic((await result).output)).toMatchObject({
        durationMs: 60_000 + freezeMs, frozenMs: freezeMs, activeDurationMs: 60_000,
        deadlineReached: true, wallDeadlineReached: true, freezeMeasurementAvailable: true,
      });
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it.each([0, 70_000])('distinguishes a stalled checkout from %i ms of measured suspension', async (freezeMs) => {
    const admissionId = 'scratch-thaw-fixture';
    const record = join(STATE, `${admissionId}.state`);
    writeFileSync(record, 'frozen_total_ms=0\n');
    vi.stubEnv('PC_HEAVY_ADMISSION_DIR', STATE);
    vi.stubEnv('PC_HEAVY_ADMISSION_ID', admissionId);
    vi.useFakeTimers();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    let callback!: (error: Error | null, stdout: string, stderr: string) => void;
    const kill = vi.fn(() => {
      callback(Object.assign(new Error('deadline fixture'), { code: null, signal: 'SIGTERM', killed: true }), '', '');
      return true;
    });
    vi.mocked(execFile).mockImplementationOnce((...args) => {
      callback = args.at(-1) as typeof callback;
      // Model execFile's native wall timer too: the old implementation kills
      // both controls after thaw; only the suspension-aware runner separates them.
      const options = args[2] as { timeout: number };
      if (options.timeout > 0) setTimeout(() => kill(), options.timeout);
      const child = new ChildProcess();
      child.kill = kill;
      return child;
    });
    try {
      const result = runLocalGit(['checkout', '--detach', 'fixture'], STATE, never);
      writeFileSync(record, `frozen_total_ms=${freezeMs}\n`);
      clock.mockReturnValue(100_000);
      vi.advanceTimersByTime(60_000);
      if (freezeMs === 0) {
        expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
        expect(diagnostic((await result).output)).toMatchObject({ activeDurationMs: 100_000, deadlineReached: true });
      } else {
        expect(kill).not.toHaveBeenCalled();
        clock.mockReturnValue(129_999);
        callback(null, 'checkout completed', '');
        expect(await result).toEqual({ code: 0, output: 'checkout completed' });
        vi.advanceTimersByTime(60_000);
        expect(kill).not.toHaveBeenCalled();
      }
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('retains the native bounded deadline when admission measurement is unavailable', async () => {
    vi.stubEnv('PC_HEAVY_ADMISSION_DIR', STATE);
    vi.stubEnv('PC_HEAVY_ADMISSION_ID', 'missing-admission-fixture');
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      (args.at(-1) as (error: Error, stdout: string, stderr: string) => void)(
        Object.assign(new Error('fixture terminated'), { code: null, signal: 'SIGTERM', killed: true }), '', '',
      );
    }) as typeof execFile);
    try {
      const result = await runLocalGit(['checkout', '--detach', 'fixture'], STATE, never);
      expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 60_000 });
      expect(diagnostic(result.output)).toMatchObject({ frozenMs: 0, freezeMeasurementAvailable: false });
    } finally { vi.unstubAllEnvs(); }
  });

  it('writes an explicit phase receipt while keeping the child credential environment scrubbed', async () => {
    const tracePath = join(STATE, 'phase-trace.jsonl');
    vi.stubEnv('GIT_TRACE2_EVENT', tracePath);
    vi.stubEnv('PAPERCUSP_TRACE_TEST_SECRET', 'private-sentinel');
    try {
      const result = await runLocalGit([
        '-c', 'alias.phase-probe=!test -z "$PAPERCUSP_TRACE_TEST_SECRET"', 'phase-probe',
      ], STATE, never);
      expect(result.code).toBe(0);
      expect(result.output).toBe('');
      const events = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.some(event => event.event === 'start' && event.argv.includes('phase-probe'))).toBe(true);
      expect(events.some(event => event.event === 'exit' && event.code === 0)).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('runGitReadOnlyEvidence', () => {
  it.skipIf(!capabilityBwrapWorks())('uses network-denied bwrap without the SRT mux', async () => {
    spawnCalls.mockClear();
    const result = await runGitReadOnlyEvidence(['--version'], STATE, STATE, never, true, true);
    const invocation = spawnCalls.mock.calls.at(-1);
    expect(result.code).toBe(0);
    expect(invocation?.[0]).toMatch(/bwrap/);
    expect(invocation?.[1]).toContain('--unshare-net');
  });
});

describe('scratchClone — guarded cheap local materialisation (WI-38848)', () => {
  it('keeps the existing argv form and exposes a mutually-exclusive scratch form', () => {
    const schema = (capabilityGit as unknown as { args: { safeParse(value: unknown): { success: boolean } } }).args;
    expect(schema.safeParse({ args: ['status', '--porcelain'] }).success).toBe(true);
    expect(schema.safeParse({ scratchClone: { ref: 'HEAD' } }).success).toBe(true);
    expect(schema.safeParse({ args: ['status'], scratchClone: {} }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('borrows the object store, pins a detached commit, strips origin, and skips untracked node_modules', async () => {
    const source = repository('cap-git-scratch-source-');
    mkdirSync(join(source, 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'large-untracked-model.bin'), 'never copy me');
    const sha = git(source, ['rev-parse', 'HEAD']);

    const result = await createScratchClone({ source, signal: never });
    cleanup.push(result.path);

    expect(result.sha).toBe(sha);
    expect(result.borrowedRepositories).toBe(1);
    expect(git(result.path, ['rev-parse', 'HEAD'])).toBe(sha);
    expect(git(result.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(result.path, ['remote'])).toBe('');
    expect(existsSync(join(result.path, 'node_modules'))).toBe(false);
    expect(readFileSync(join(result.path, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).not.toBe('');
  });

  it('sizes checkout from the selected committed tree and preserves all source bytes', async () => {
    const source = repository('cap-git-sized-scratch-source-');
    const measured: Array<{ argv: string[]; timeoutMs: number | undefined }> = [];
    const large = Buffer.alloc(2 * 1024 * 1024, 'x');
    writeFileSync(join(source, 'population.bin'), large);
    git(source, ['add', 'population.bin']);
    git(source, ['commit', '--quiet', '-m', 'committed population']);
    const sha = git(source, ['rev-parse', 'HEAD']);
    // The dirty donor cannot inflate or substitute the committed population.
    writeFileSync(join(source, 'population.bin'), 'different working bytes');
    const result = await createLocalScratchClone({ source, ref: sha, signal: never,
      runGit: (argv, cwd, signal, timeoutMs) => {
        measured.push({ argv, timeoutMs });
        return runLocalGit(argv, cwd, signal, timeoutMs);
      } });
    cleanup.push(result.path);
    expect(readFileSync(join(result.path, 'population.bin'))).toEqual(large);
    const checkout = measured.find(call => call.argv.includes('checkout'));
    expect(checkout?.timeoutMs).toBe(estimateScratchGitTimeout({
      bytes: large.length + Buffer.byteLength('cap-git-sized-scratch-source-\n'), entries: 2,
    }));
    expect(checkout?.timeoutMs).toBeGreaterThan(SCRATCH_GIT_BASE_TIMEOUT_MS);
    expect(git(result.path, ['rev-parse', 'HEAD'])).toBe(sha);
  });

  it('materialises local submodules at their exact pins with shared objects and no origins', async () => {
    const child = repository('cap-git-scratch-child-');
    const source = repository('cap-git-scratch-parent-');
    git(source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'modules/child']);
    git(source, ['commit', '--quiet', '-am', 'add child']);
    const childPin = git(source, ['rev-parse', 'HEAD:modules/child']);

    const result = await createScratchClone({ source, signal: never });
    cleanup.push(result.path);
    const clonedChild = join(result.path, 'modules', 'child');

    expect(result.submodules).toBe(1);
    expect(result.borrowedRepositories).toBe(2);
    expect(git(result.path, ['ls-files', '--recurse-submodules'])).toContain('modules/child/tracked.txt');
    expect(git(clonedChild, ['rev-parse', 'HEAD'])).toBe(childPin);
    expect(git(clonedChild, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(clonedChild, ['remote'])).toBe('');
    expect(readFileSync(join(clonedChild, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).not.toBe('');
  });

  it('fails closed and removes the destination it created when a local submodule is unavailable', async () => {
    const child = repository('cap-git-scratch-missing-child-');
    const source = repository('cap-git-scratch-missing-parent-');
    git(source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child, 'modules/child']);
    git(source, ['commit', '--quiet', '-am', 'add child']);
    rmSync(join(source, 'modules', 'child'), { recursive: true, force: true });
    const destination = join(tmpdir(), `cap-git-scratch-fail-${crypto.randomUUID()}`);

    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow(/local submodule modules\/child/);
    expect(existsSync(destination)).toBe(false);
  });

  it('materialises nested exact gitlinks without inventing .gitmodules mappings', async () => {
    const leaf = repository('cap-git-unlisted-leaf-');
    const child = repository('cap-git-unlisted-child-');
    const source = repository('cap-git-unlisted-parent-');
    const addUnlisted = (parent: string, donor: string, path: string): string => {
      git(parent, ['clone', '--quiet', '--shared', '--', donor, path]);
      const pin = git(join(parent, path), ['rev-parse', 'HEAD']);
      git(parent, ['update-index', '--add', '--cacheinfo', `160000,${pin},${path}`]);
      git(parent, ['commit', '--quiet', '-m', 'add unlisted gitlink']);
      return pin;
    };
    const leafPin = addUnlisted(child, leaf, 'leaf');
    const childPin = addUnlisted(source, child, 'unlisted');
    // A plain clone leaves nested gitlinks empty; provide the actual local donor
    // checkout that the guarded clone requires rather than bypassing its check.
    git(join(source, 'unlisted'), ['clone', '--quiet', '--shared', '--', leaf, 'leaf']);
    const result = await createScratchClone({ source, signal: never });
    cleanup.push(result.path);

    expect(result.submodules).toBe(2);
    expect(result.borrowedRepositories).toBe(3);
    expect(git(join(result.path, 'unlisted'), ['rev-parse', 'HEAD'])).toBe(childPin);
    expect(git(join(result.path, 'unlisted', 'leaf'), ['rev-parse', 'HEAD'])).toBe(leafPin);
    expect(readFileSync(join(result.path, 'unlisted', 'leaf', 'tracked.txt'), 'utf8'))
      .toBe(readFileSync(join(leaf, 'tracked.txt'), 'utf8'));
    for (const root of [result.path, join(result.path, 'unlisted'), join(result.path, 'unlisted', 'leaf')]) {
      expect(existsSync(join(root, '.gitmodules'))).toBe(false);
      expect(git(root, ['remote'])).toBe('');
      expect(readFileSync(join(root, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).not.toBe('');
    }
  });

  it('refuses an unavailable unlisted pin and cleans only its owned destination', async () => {
    const child = repository('cap-git-unlisted-missing-child-');
    const source = repository('cap-git-unlisted-missing-parent-');
    const pin = git(child, ['rev-parse', 'HEAD']);
    git(source, ['update-index', '--add', '--cacheinfo', `160000,${pin},missing`]);
    git(source, ['commit', '--quiet', '-m', 'unavailable unlisted gitlink']);
    const destination = join(tmpdir(), `cap-git-unlisted-fail-${crypto.randomUUID()}`);
    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow('local submodule missing');
    expect(existsSync(destination)).toBe(false);
    expect(git(source, ['rev-parse', 'HEAD:missing'])).toBe(pin);
  });

  it('clones under ignored source scratch when OS temp points elsewhere, preserving a clean donor', async () => {
    const source = repository('cap-git-donor-scratch-');
    writeFileSync(join(source, '.gitignore'), '/.papercusp/scratch/\n');
    git(source, ['add', '.gitignore']);
    git(source, ['commit', '--quiet', '-m', 'ignore owned scratch']);
    const scratch = join(source, '.papercusp', 'scratch');
    mkdirSync(scratch, { recursive: true });
    const otherTemp = mkdtempSync(join(tmpdir(), 'cap-git-other-temp-'));
    cleanup.push(otherTemp);
    vi.stubEnv('TMPDIR', otherTemp);
    try {
      const destination = join(scratch, 'owned');
      const result = await createScratchClone({ source, destination, signal: never });
      expect(result.path).toBe(destination);
      expect(statSync(destination).dev).toBe(statSync(source).dev);
      expect(git(destination, ['rev-parse', 'HEAD'])).toBe(git(source, ['rev-parse', 'HEAD']));
      expect(git(destination, ['remote'])).toBe('');
      expect(readFileSync(join(destination, '.git/objects/info/alternates'), 'utf8').trim()).not.toBe('');
      expect(git(source, ['status', '--porcelain'])).toBe('');
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses unignored source scratch and ordinary contained paths without creating them', async () => {
    const source = repository('cap-git-unignored-scratch-');
    const scratch = join(source, '.papercusp', 'scratch');
    mkdirSync(scratch, { recursive: true });
    const destination = join(scratch, 'refused');
    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow('must be Git-ignored');
    expect(existsSync(destination)).toBe(false);
    await expect(createScratchClone({ source, destination: join(source, 'ordinary'), signal: never }))
      .rejects.toThrow('must not contain one another');
    expect(existsSync(join(source, 'ordinary'))).toBe(false);
  });

  it('preserves existing source scratch and cleans only its fresh failed clone', async () => {
    const source = repository('cap-git-scratch-ownership-');
    const child = repository('cap-git-scratch-unavailable-');
    const pin = git(child, ['rev-parse', 'HEAD']);
    git(source, ['update-index', '--add', '--cacheinfo', `160000,${pin},missing`]);
    writeFileSync(join(source, '.gitignore'), '/.papercusp/scratch/\n');
    git(source, ['add', '.gitignore']);
    git(source, ['commit', '--quiet', '-m', 'missing child and ignored scratch']);
    const scratch = join(source, '.papercusp', 'scratch');
    mkdirSync(join(scratch, 'existing'), { recursive: true });
    const sentinel = join(scratch, 'existing', 'peer-work.txt');
    writeFileSync(sentinel, 'keep');
    await expect(createScratchClone({ source, destination: join(scratch, 'existing'), signal: never }))
      .rejects.toThrow('must not already exist');
    await expect(createScratchClone({ source, destination: join(scratch, 'failed'), signal: never }))
      .rejects.toThrow('local submodule missing');
    expect(existsSync(join(scratch, 'failed'))).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('never deletes or enters a caller-owned destination', async () => {
    const source = repository('cap-git-scratch-preserve-source-');
    const destination = mkdtempSync(join(tmpdir(), 'cap-git-scratch-preserve-dest-'));
    cleanup.push(destination);
    const sentinel = join(destination, 'peer-work.txt');
    writeFileSync(sentinel, 'keep');

    await expect(createScratchClone({ source, destination, signal: never })).rejects.toThrow(/must not already exist/);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
  });
});

/**
 * EI-20881501070735530 — `git … -- <pathspec>` that matches nothing prints nothing and
 * exits 0, which is byte-identical to a genuine "no commits touch this file". The cwd
 * bug that produced the original false absence is fixed, but the ambiguous SHAPE is
 * git's, not ours, so the tool names which reading it cannot distinguish.
 *
 * The teeth are in the negatives: a note on a legitimately-empty `git diff` would train
 * agents to ignore it, which is worse than not having it.
 */
describe('emptyPathspecNote — the empty-at-exit-0 pathspec ambiguity', () => {
  const CWD = '/tree';

  it('fires when an explicit -- pathspec produced nothing at exit 0', () => {
    const note = emptyPathspecNote(['log', '-3', '--', 'pkg/a.ts'], 0, '', CWD);
    expect(note).toContain('pathspec matched nothing');
    expect(note).toContain('pkg/a.ts');
    expect(note).toContain(CWD); // the cwd IS the disambiguator — never omit it
  });

  it('does NOT fire on a clean `git diff` — an empty result there is the true answer', () => {
    expect(emptyPathspecNote(['diff', '--stat'], 0, '', CWD)).toBe('');
  });

  it('does NOT fire when the command produced output', () => {
    expect(emptyPathspecNote(['log', '--', 'pkg/a.ts'], 0, 'abc123 subject\n', CWD)).toBe('');
  });

  it('does NOT fire on a non-zero exit — git already said what went wrong', () => {
    expect(emptyPathspecNote(['log', '--', 'pkg/a.ts'], 128, '', CWD)).toBe('');
  });

  it('does NOT fire on a bare `--` with no operands', () => {
    expect(emptyPathspecNote(['log', '--'], 0, '', CWD)).toBe('');
  });

  it('names the submodule case — the one where the path exists but can never match', () => {
    expect(emptyPathspecNote(['log', '--', 'libs/papercusp-shared/package.json'], 0, '', CWD))
      .toContain('SUBMODULE');
  });
});

describe('operator secrets are NOT inherited by the git subprocess (EI-1617)', () => {
  it('a fake operator secret in process.env never reaches a git shell-alias command', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://user:pw@host/db-should-not-leak';
    try {
      const r = await runGit(
        ['-c', 'alias.leak=!printf "[%s]" "${DATABASE_URL:-unset}"', 'leak'],
        STATE,
        STATE,
        never,
      );
      expect(r.code).toBe(0);
      expect(r.output).toBe('[unset]');
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('a plain allowlisted var (PATH) still reaches the git shell-alias command', async () => {
    const r = await runGit(
      ['-c', 'alias.leak=!test -n "$PATH" && printf has-path', 'leak'],
      STATE,
      STATE,
      never,
    );
    expect(r.code).toBe(0);
    expect(r.output).toBe('has-path');
  });
});
