/**
 * Guarded local scratch checkout shared by capability:git and source verification.
 * Only Node builtins belong here: importing a CLI helper must not register tools
 * or pull the operator compiler graph. The capability supplies its sandbox runner.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

export const SCRATCH_GIT_BASE_TIMEOUT_MS = 60_000;
export const SCRATCH_GIT_MAX_TIMEOUT_MS = 600_000;
const SCRATCH_GIT_BYTES_PER_MS = 25_000;
const SCRATCH_GIT_ENTRY_MS = 1;

export type ScratchGitRunner = (argv: string[], cwd: string, signal: AbortSignal, timeoutMs?: number) =>
  Promise<{ code: number | null; output: string }>;

/**
 * Size the Git command deadline from the committed tree that will actually be
 * materialised. The old fixed 60-second wall killed large exact-ref checkouts
 * before source verification began. This remains bounded and preserves the
 * small-repository default while charging both bytes and tracked entries.
 */
export function estimateScratchGitTimeout({ bytes, entries, submodules = 0 }: {
  bytes: number; entries: number; submodules?: number;
}): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(entries) || entries < 0 ||
      !Number.isSafeInteger(submodules) || submodules < 0) {
    throw new Error('scratchClone tree measurement is invalid');
  }
  const measured = SCRATCH_GIT_BASE_TIMEOUT_MS + Math.ceil(bytes / SCRATCH_GIT_BYTES_PER_MS) +
    entries * SCRATCH_GIT_ENTRY_MS + submodules * SCRATCH_GIT_BASE_TIMEOUT_MS;
  return Math.min(SCRATCH_GIT_MAX_TIMEOUT_MS, Math.max(SCRATCH_GIT_BASE_TIMEOUT_MS, measured));
}

/** Reuse pc-heavy's cumulative suspension ledger, as the test router does. */
function admissionFrozenMs(): number | null {
  const dir = process.env.PC_HEAVY_ADMISSION_DIR;
  const id = process.env.PC_HEAVY_ADMISSION_ID;
  if (!dir || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const record = readFileSync(join(dir, `${id}.state`), 'utf8');
    const value = record.split('\n').find(line => line.startsWith('frozen_total_ms='))?.slice(16);
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const total = Number(value);
    return Number.isSafeInteger(total) ? total : null;
  } catch { return null; }
}

/** Standalone local-only runner: bounded, no shell, no inherited credentials. */
export function runLocalGit(argv: string[], cwd: string, signal: AbortSignal,
  requestedTimeoutMs = SCRATCH_GIT_BASE_TIMEOUT_MS):
Promise<{ code: number | null; output: string }> {
  const timeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= SCRATCH_GIT_BASE_TIMEOUT_MS
    ? Math.min(SCRATCH_GIT_MAX_TIMEOUT_MS, requestedTimeoutMs) : SCRATCH_GIT_BASE_TIMEOUT_MS;
  const started = performance.now();
  const frozenBefore = admissionFrozenMs();
  let frozenMs = 0;
  const elapsed = () => {
    const durationMs = Math.max(0, Math.round(performance.now() - started));
    const frozenAfter = frozenBefore === null ? null : admissionFrozenMs();
    // Missing/reset records are unknown. Keep only suspension actually observed
    // during this invocation; never extend a budget using earlier admission time.
    if (frozenAfter !== null && frozenBefore !== null && frozenAfter >= frozenBefore) {
      frozenMs = Math.max(frozenMs, Math.min(durationMs, frozenAfter - frozenBefore));
    }
    return { durationMs, frozenMs, activeDurationMs: Math.max(0, durationMs - frozenMs),
      freezeMeasurementAvailable: frozenBefore !== null && frozenAfter !== null && frozenAfter >= frozenBefore };
  };
  // Preserve an explicit phase receipt outside the disposable checkout without
  // opening the credential environment or sending trace output to the caller.
  const tracePath = process.env.GIT_TRACE2_EVENT;
  return new Promise(resolvePromise => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadlineExpired = false;
    const child = execFile('git', argv, {
      cwd, signal, timeout: frozenBefore === null ? timeoutMs : 0, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        ...(tracePath && isAbsolute(tracePath) ? { GIT_TRACE2_EVENT: tracePath } : {}) },
    }, (error, stdout, stderr) => {
      settled = true;
      clearTimeout(timer);
      const timing = elapsed();
      // execFile uses killed for both its deadline and its output limit. A
      // SIGTERM alone therefore cannot prove a timeout; preserve the measured
      // deadline alongside the actual termination instead of guessing a cause.
      const aborted = signal.aborted || error?.code === 'ABORT_ERR';
      const failure = !error ? null : {
        kind: aborted ? 'aborted'
          : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
            : typeof error.code === 'number' ? 'exit'
              : error.signal || error.killed ? 'terminated' : 'spawn-error',
        errorCode: error.code ?? null,
        signal: error.signal ?? null,
        killed: error.killed ?? false,
        aborted,
        ...timing,
        timeoutMs,
        deadlineReached: deadlineExpired || timing.activeDurationMs >= timeoutMs,
        wallDeadlineReached: timing.durationMs >= timeoutMs,
      };
      resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        output: stdout + stderr + (error ? '\n' + error.message
          + '\n[scratch-git-runner] ' + JSON.stringify(failure) : '') });
    });
    if (frozenBefore !== null && !settled) {
      const checkDeadline = () => {
        if (settled) return;
        const remainingMs = timeoutMs - elapsed().activeDurationMs;
        if (remainingMs > 0) timer = setTimeout(checkDeadline, remainingMs);
        else {
          deadlineExpired = true;
          child.kill('SIGTERM');
        }
      };
      timer = setTimeout(checkDeadline, timeoutMs);
    }
  });
}

export interface ScratchCloneResult {
  path: string;
  source: string;
  requestedRef: string;
  sha: string;
  submodules: number;
  borrowedRepositories: number;
}

export interface ScratchCloneOptions {
  source: string;
  ref?: string;
  destination?: string;
  includeSubmodules?: boolean;
  signal?: AbortSignal;
  runGit?: ScratchGitRunner;
}

interface ScratchCloneContext {
  signal: AbortSignal;
  submodules: number;
  timeoutMs: number;
  runGit: ScratchGitRunner;
}

interface ScratchSubmodule {
  path: string;
}

const MAX_SCRATCH_SUBMODULES = 256;
const MAX_SCRATCH_SUBMODULE_DEPTH = 8;

function strictlyWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseScratchGitmodules(text: string): ScratchSubmodule[] {
  const out: ScratchSubmodule[] = [];
  let current: ScratchSubmodule | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[submodule\s+"[^"]+"\]$/.test(line)) {
      current = { path: '' };
      out.push(current);
      continue;
    }
    if (!current || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^path\s*=\s*(.*)$/.exec(line);
    if (match) current.path = match[1].trim();
  }
  return out.filter((entry) => entry.path.length > 0);
}

function scratchError(label: string, output: string): Error {
  const detail = output.trim();
  return new Error(`${label}${detail ? `: ${detail}` : ''}`);
}

async function gitStep(
  argv: string[],
  cwd: string,
  ctx: ScratchCloneContext,
  label: string,
): Promise<string> {
  const result = await ctx.runGit(argv, cwd, ctx.signal, ctx.timeoutMs);
  if (result.code !== 0) throw scratchError(label, result.output);
  return result.output.trim();
}

async function localRepositoryRoot(path: string, ctx: ScratchCloneContext, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute local path.`);
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`${label} is not an existing local directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = await gitStep(['rev-parse', '--show-toplevel'], canonical, ctx, `${label} is not a Git working tree`);
  const canonicalRoot = await realpath(root);
  if (!isAbsolute(canonicalRoot)) throw new Error(`${label} resolved to a non-absolute Git root.`);
  return canonicalRoot;
}

async function createOwnedScratchDestination(source: string, ctx: ScratchCloneContext, requested?: string):
Promise<{ path: string; inSourceScratch: boolean }> {
  const tempRoot = await realpath(tmpdir());
  const linux = platform() === 'linux';
  const rootDevice = linux ? (await stat('/')).dev : undefined;
  if (!requested) {
    let parent = tempRoot;
    if (linux) {
      // A missing/unmounted data volume must not silently send a repository
      // materialisation back to root. Check before creating even the parent.
      const data = await realpath('/mnt/data');
      const device = (await stat(data)).dev;
      if (device === rootDevice) throw new Error('scratchClone requires a separate /mnt/data filesystem.');
      parent = join(data, 'tmp');
      await mkdir(parent, { recursive: true });
      parent = await realpath(parent);
      if ((await stat(parent)).dev !== device) {
        throw new Error('scratchClone data scratch resolves outside the /mnt/data filesystem.');
      }
    }
    return { path: await mkdtemp(join(parent, 'papercusp-git-scratch-')), inSourceScratch: false };
  }
  if (!isAbsolute(requested)) throw new Error('scratchClone.destination must be absolute.');

  const parent = await realpath(dirname(requested));
  if (linux && (await stat(parent)).dev === rootDevice) {
    throw new Error('scratchClone refuses repository materialisation on the root filesystem; choose /mnt/data/tmp.');
  }
  const destination = resolve(parent, basename(requested));
  // Hardlink dependency snapshots need a checkout on the donor's filesystem.
  // Admit only the repository's canonical, ignored scratch subtree, never an
  // arbitrary contained source path or a scratch symlink to another location.
  const scratchRoot = join(source, '.papercusp', 'scratch');
  const canonicalScratch = await realpath(scratchRoot).catch(() => undefined);
  const inSourceScratch = canonicalScratch === scratchRoot && strictlyWithin(scratchRoot, destination);
  const dataTemp = linux ? await realpath('/mnt/data/tmp').catch(() => undefined) : undefined;
  if (!strictlyWithin(tempRoot, destination) && !(dataTemp && strictlyWithin(dataTemp, destination)) && !inSourceScratch) {
    throw new Error(`scratchClone.destination must be below the OS temp directory (${tempRoot}) or the source repository's ignored .papercusp/scratch directory.`);
  }
  if (inSourceScratch) {
    const ignored = await ctx.runGit(['check-ignore', '--quiet', '--', relative(source, destination)], source, ctx.signal);
    if (ignored.code !== 0) throw new Error('scratchClone source scratch destination must be Git-ignored.');
    if ((await stat(parent)).dev !== (await stat(source)).dev) {
      throw new Error('scratchClone source scratch destination must share the source filesystem.');
    }
  }
  if ((strictlyWithin(source, destination) && !inSourceScratch)
    || strictlyWithin(destination, source) || source === destination) {
    throw new Error('scratchClone source and destination must not contain one another outside ignored source scratch.');
  }
  try {
    // Atomic ownership boundary: cleanup is allowed only after THIS mkdir succeeds.
    // An existing path (including a symlink) is never entered, modified, or removed.
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    throw new Error(`scratchClone.destination must not already exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: destination, inSourceScratch };
}

async function verifyBorrowedObjects(destination: string): Promise<void> {
  const alternates = await readFile(join(destination, '.git', 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
  if (!alternates.trim()) {
    throw new Error(`git clone did not create an object-store alternate for ${destination}; refusing a clone that may have copied its pack.`);
  }
}

async function materialiseLocalSubmodules(
  sourceRoot: string,
  destinationRoot: string,
  parentSha: string,
  ctx: ScratchCloneContext,
  depth: number,
): Promise<void> {
  const gitmodules = await readFile(join(destinationRoot, '.gitmodules'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const declared = new Set(parseScratchGitmodules(gitmodules).map(entry => entry.path));
  // Gitlinks are commit objects whether or not .gitmodules names them. The
  // source exporter already exports this exact tree population.
  const tree = await gitStep(['ls-tree', '-r', '-z', parentSha], sourceRoot, ctx,
    'cannot enumerate exact local submodule pins');
  const entries = tree.split('\0').flatMap(row => {
    const tab = row.indexOf('\t');
    if (tab < 0) return [];
    const [mode, type, pin] = row.slice(0, tab).split(' ');
    return mode === '160000' && type === 'commit' ? [{ path: row.slice(tab + 1), pin }] : [];
  });
  for (const path of declared) {
    if (!entries.some(entry => entry.path === path)) {
      throw new Error('cannot resolve submodule pin for declared path ' + path);
    }
  }
  if (entries.length === 0) return;
  if (depth >= MAX_SCRATCH_SUBMODULE_DEPTH) {
    throw new Error(`scratchClone submodule nesting exceeds the safe depth limit (${MAX_SCRATCH_SUBMODULE_DEPTH}).`);
  }
  if (ctx.submodules + entries.length > MAX_SCRATCH_SUBMODULES) {
    throw new Error(`scratchClone submodule count exceeds the safe limit (${MAX_SCRATCH_SUBMODULES}).`);
  }

  // Preflight the whole level before cloning any child. A partial submodule tree
  // can make a test/lint produce a confident false answer, so there is no network
  // fallback and no "best effort" branch here.
  const ready: Array<{ source: string; destination: string; pin: string; path: string }> = [];
  for (const entry of entries) {
    if (isAbsolute(entry.path) || entry.path.split(/[\\/]+/).includes('..')) {
      throw new Error(`scratchClone refuses unsafe submodule path: ${entry.path}`);
    }
    const sourceCandidate = resolve(sourceRoot, entry.path);
    const destination = resolve(destinationRoot, entry.path);
    if (!strictlyWithin(sourceRoot, sourceCandidate) || !strictlyWithin(destinationRoot, destination)) {
      throw new Error(`scratchClone submodule path escapes its repository: ${entry.path}`);
    }
    const source = await localRepositoryRoot(sourceCandidate, ctx, `local submodule ${entry.path}`);
    if (source !== await realpath(sourceCandidate)) {
      throw new Error(`local submodule ${entry.path} is not checked out at its declared path.`);
    }
    const pin = entry.pin;
    await gitStep(
      ['rev-parse', '--verify', '--end-of-options', `${pin}^{commit}`],
      source,
      ctx,
      `local submodule ${entry.path} does not contain pinned commit ${pin}`,
    );
    ready.push({ source, destination, pin, path: entry.path });
  }

  ctx.submodules += ready.length;
  for (const child of ready) {
    // Checkout materialises a gitlink as an empty directory. It is inside the
    // root directory this tool atomically created, so replacing it is safe.
    await rm(child.destination, { recursive: true, force: true });
    await gitStep(
      ['clone', '--local', '--shared', '--no-checkout', '--quiet', '--', child.source, child.destination],
      destinationRoot,
      ctx,
      `failed to clone local submodule ${child.path}`,
    );
    await verifyBorrowedObjects(child.destination);
    await gitStep(
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', child.pin],
      child.destination,
      ctx,
      `failed to check out local submodule ${child.path} at ${child.pin}`,
    );
    await gitStep(['remote', 'remove', 'origin'], child.destination, ctx, `failed to remove origin from submodule ${child.path}`);
    await materialiseLocalSubmodules(child.source, child.destination, child.pin, ctx, depth + 1);
  }
  // Local clones contain each gitlink's bytes, but Git only recurses into an
  // active submodule. Register the existing local checkouts without fetching.
  const mapped = ready.filter(child => declared.has(child.path));
  if (mapped.length) await gitStep(['submodule', 'init', '--', ...mapped.map(child => child.path)],
    destinationRoot, ctx, 'failed to initialize local submodule index semantics');
}

/**
 * Create a disposable, exact-ref local clone without copying the source pack.
 *
 * This is the guarded counterpart to ad-hoc agent shell clones (WI-38848). It
 * deliberately reuses the real-Git recipe proven by lint-as-committed:
 * `clone --local --shared --no-checkout` followed by detached checkout. Every
 * destination is atomically created by this function, so the failure cleanup
 * can never delete a caller/peer-owned directory.
 */
export async function createScratchClone(options: ScratchCloneOptions): Promise<ScratchCloneResult> {
  const ctx: ScratchCloneContext = {
    signal: options.signal ?? new AbortController().signal,
    submodules: 0,
    timeoutMs: SCRATCH_GIT_BASE_TIMEOUT_MS,
    runGit: options.runGit ?? runLocalGit,
  };
  const source = await localRepositoryRoot(options.source, ctx, 'scratchClone.source');
  const requestedRef = options.ref ?? 'HEAD';
  const sha = await gitStep(
    ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`],
    source,
    ctx,
    `scratchClone.ref does not resolve to a commit (${requestedRef})`,
  );
  const tree = await gitStep(
    ['ls-tree', '-rl', '--full-tree', '--', sha],
    source,
    ctx,
    `scratchClone committed tree could not be measured (${sha})`,
  );
  let entries = 0;
  let bytes = 0;
  let submodules = 0;
  for (const line of tree.split('\n')) {
    if (!line) continue;
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t/.exec(line);
    if (!match) throw new Error('scratchClone committed tree measurement is malformed');
    entries += 1;
    if (match[2] === 'commit') submodules += 1;
    else {
      const size = Number(match[4]);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('scratchClone committed tree size is invalid');
      bytes += size;
    }
  }
  ctx.timeoutMs = estimateScratchGitTimeout({ bytes, entries, submodules });

  const owned = await createOwnedScratchDestination(source, ctx, options.destination);
  const destination = owned.path;
  if ((strictlyWithin(source, destination) && !owned.inSourceScratch) || strictlyWithin(destination, source) || source === destination) {
    await rm(destination, { recursive: true, force: true });
    throw new Error('scratchClone source and destination must not contain one another.');
  }

  let complete = false;
  try {
    await gitStep(
      ['clone', '--local', '--shared', '--no-checkout', '--quiet', '--', source, destination],
      dirname(destination),
      ctx,
      'scratchClone failed to borrow the source repository',
    );
    await verifyBorrowedObjects(destination);
    await gitStep(
      ['-c', 'advice.detachedHead=false', 'checkout', '--detach', '--quiet', sha],
      destination,
      ctx,
      `scratchClone failed to check out ${sha}`,
    );
    await gitStep(['remote', 'remove', 'origin'], destination, ctx, 'scratchClone failed to remove origin');
    if (options.includeSubmodules !== false) {
      await materialiseLocalSubmodules(source, destination, sha, ctx, 0);
    }
    complete = true;
    return {
      path: destination,
      source,
      requestedRef,
      sha,
      submodules: ctx.submodules,
      borrowedRepositories: 1 + ctx.submodules,
    };
  } finally {
    if (!complete) await rm(destination, { recursive: true, force: true });
  }
}
