import { papercuspHome } from '@papercusp/host-platform/home';
/**
 * Disk census — the du walk that survives an operator restart (WI-6554700010009855;
 * disk-headroom-standing-reclaim-2026-10-12 P-001, R-1).
 *
 * A census walks `/` in ~45-50 min and /mnt/data in ~25 min, while bg-host (which runs
 * the census workflow) restarted every ~33 min on average (2026-10-02 measurement; four
 * restarts on 2026-10-13 before 05:30Z). A du spawned as bg-host's child sits in
 * papercusp-bg-host.service's cgroup and feeds bg-host through a pipe, so every restart
 * killed it, and DBOS recovery walked again from zero: the 04:35Z run on 2026-10-13 was
 * killed 44 min into its `/` walk and wrote nothing.
 *
 * This walk instead:
 *   - launches through managedSpawn into its own `pc-<taskId>.scope` (outside bg-host's
 *     cgroup), detached, with stdin ignored;
 *   - writes du's stdout and stderr to FILES under a per-run, per-device directory, so no
 *     pipe ties it to the process that started it;
 *   - is bounded by coreutils `timeout` inside the scope (with systemd RuntimeMaxSec as a
 *     backstop), never by a timer in the operator, which would die with the operator;
 *   - records its exit status atomically (`exit.<attempt>`, via rename) when du ends.
 * A later operator calling with the same directory ADOPTS a live walk (pid plus kernel
 * start-time identity, so a recycled pid is never mistaken for it) or reads a finished
 * one, instead of starting over. Output files are per attempt, so a walk that outlived
 * its record can never interleave with its replacement.
 */
import { createReadStream, promises as fsp, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { linuxProcStateFromStat, readProcessIdentity } from '../process-identity';
import { CENSUS_DU_TIMEOUT_MS, censusDuArgs, DuOutputParser, resolveCensusBin, type DuRun } from './disk-consumer-census';
import { CENSUS_FLOOR_BYTES, CENSUS_MAX_DEPTH, censusCommand, DuTreeAccumulator } from './usage';

/** How often a waiting step re-checks its walk. */
export const CENSUS_WALK_POLL_MS = 15_000;
/** How long past the walk's own deadline the waiter allows before it ends the walk itself. */
export const CENSUS_WALK_GRACE_MS = 5 * 60_000;
/** Launches per walk directory; a walk that ends without an exit status is relaunched. */
export const CENSUS_WALK_MAX_ATTEMPTS = 3;
/** Walk directories older than this are swept by pruneCensusWalks. */
export const CENSUS_WALK_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
/** coreutils `timeout` exit status when it ended the command. */
export const TIMEOUT_EXIT_STATUS = 124;

const WALK_SCRIPT =
  'out=$1; err=$2; ex=$3; shift 3; "$@" >"$out" 2>"$err"; rc=$?; printf "%s\\n" "$rc" >"$ex.part" && mv -f "$ex.part" "$ex" || exit 125; exit "$rc"';

/** The record a walk directory keeps of its current attempt. */
export interface DetachedWalkState {
  version: 1;
  root: string;
  attempt: number;
  /** Null between "about to launch" and "launched": a crash there reads as a vanished walk. */
  pid: number | null;
  /** `linux:<bootId>:<startTicks>` of `pid` at launch; null where /proc is unavailable. */
  identity: string | null;
  taskId: string | null;
  confined: boolean;
  confinementSkippedReason: string | null;
  launchedAt: number;
  deadlineAt: number;
  /** Times a caller other than the launcher picked this walk up (one per operator restart). */
  adoptions: number;
  /** Exact ordered population/identity and output contract for a multi-root usage walk. */
  requestKey?: string;
}

export interface WalkLaunch {
  pid: number;
  taskId: string | null;
  confined: boolean;
  confinementSkippedReason?: string | null;
}

export type WalkLauncher = (
  cmd: string,
  args: string[],
  meta: { root: string; dir: string; attempt: number; runtimeMaxSec: number;
    attribution?: { launchedBy: string; workItemId: string; title: string } },
) => Promise<WalkLaunch>;

/** Thrown when `signal` stops the wait; the walk itself keeps running. */
export class DetachedWalkAbandoned extends Error {
  constructor() {
    super('stopped waiting for the census walk; the walk keeps running');
    this.name = 'DetachedWalkAbandoned';
  }
}

export interface DetachedWalkOptions {
  /** The shared transport also serves other maintained read-only collectors. */
  attribution?: { launchedBy: string; workItemId: string; title: string };
  /** Directory owning this walk (one per run and device): state.json plus per-attempt out/err/exit. */
  dir: string;
  floorBytes?: number;
  maxDepth?: number;
  timeoutMs?: number;
  sudo?: string | null;
  pollMs?: number;
  graceMs?: number;
  maxAttempts?: number;
  /** Builds the walk command from du's arguments; tests substitute a slow or failing du. */
  command?: (duArgs: string[]) => [string, string[]];
  launch?: WalkLauncher;
  isAlive?: (state: DetachedWalkState) => boolean;
  /** Ends an overdue walk; defaults to SIGTERM to its process group, identity-checked. */
  kill?: (state: DetachedWalkState) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stops WAITING (rejects with DetachedWalkAbandoned) without touching the walk. */
  signal?: AbortSignal;
}

export function walkAttemptFiles(dir: string, attempt: number): { out: string; err: string; exit: string } {
  return { out: join(dir, `out.${attempt}`), err: join(dir, `err.${attempt}`), exit: join(dir, `exit.${attempt}`) };
}

function statePath(dir: string): string {
  return join(dir, 'state.json');
}

export async function readWalkState(dir: string): Promise<DetachedWalkState | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath(dir), 'utf8')) as DetachedWalkState;
    return parsed && parsed.version === 1 && Number.isInteger(parsed.attempt) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeWalkState(dir: string, state: DetachedWalkState): Promise<void> {
  const tmp = `${statePath(dir)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state));
  await fsp.rename(tmp, statePath(dir));
}

async function readExitStatus(path: string): Promise<number | null> {
  try {
    const n = Number.parseInt((await fsp.readFile(path, 'utf8')).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Alive = the pid exists, is not a zombie, and still carries the identity it was launched with. */
export function walkProcessAlive(state: DetachedWalkState): boolean {
  if (state.pid === null) return false;
  try {
    process.kill(state.pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    if (linuxProcStateFromStat(readFileSync(`/proc/${state.pid}/stat`, 'utf8')) === 'Z') return false;
  } catch {
    // No /proc (non-Linux) or the process just exited: the identity check below decides.
  }
  if (state.identity === null) return true;
  return readProcessIdentity(state.pid) === state.identity;
}

function killWalkGroup(state: DetachedWalkState): void {
  if (state.pid === null || !walkProcessAlive(state)) return;
  try {
    process.kill(-state.pid, 'SIGTERM');
  } catch {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The production launcher: managedSpawn into its own transient scope, detached, stdio
 * ignored (the walk script redirects du to files itself), RuntimeMaxSec as a backstop.
 */
export const managedWalkLauncher: WalkLauncher = async (cmd, args, meta) => {
  const { managedSpawn } = await import('../task-manager/managed-spawn');
  const r = await managedSpawn(
    cmd,
    args,
    {
      class: 'other',
      title: meta.attribution?.title ?? `disk census du ${meta.root} (attempt ${meta.attempt})`,
      argv: [cmd, ...args],
      launchedBy: meta.attribution?.launchedBy ?? 'system:disk-consumer-census',
      workItemId: meta.attribution?.workItemId ?? 'WI-6554700010009855',
      planSlug: 'disk-headroom-standing-reclaim-2026-10-12',
      runtimeMaxSec: meta.runtimeMaxSec,
      detail: { subsystem: 'storage', operation: 'disk-census-walk', root: meta.root, dir: meta.dir },
    },
    { spawnOptions: { detached: true, stdio: 'ignore' } },
  );
  // A launch failure surfaces as a missing pid below; never as an unhandled 'error' event.
  r.child.on('error', () => {});
  r.child.unref();
  if (r.child.pid == null) throw new Error(`census walk launch for ${meta.root} returned no pid`);
  return {
    pid: r.child.pid,
    taskId: r.taskId,
    confined: r.confined,
    confinementSkippedReason: r.confinementSkippedReason ?? null,
  };
};

/**
 * Walk `root` with du in a process that outlives its caller, or pick up the walk an
 * earlier caller started in `opts.dir`. Resolves with the same DuRun shape as runDuTree.
 */
export async function runDetachedDuWalk(root: string, opts: DetachedWalkOptions): Promise<DuRun> {
  const floorBytes = opts.floorBytes ?? CENSUS_FLOOR_BYTES;
  const maxDepth = opts.maxDepth ?? CENSUS_MAX_DEPTH;
  const privileged = Boolean(opts.sudo) || process.getuid?.() === 0;
  return runDetachedWalk(root, opts, censusDuArgs(root, maxDepth), async (state, exitCode, overdue, failure) => {
    const files = walkAttemptFiles(opts.dir, state.attempt);
    const parser = new DuOutputParser(new DuTreeAccumulator(root, { floorBytes, maxDepth }));
    await streamInto(files.out, (c) => parser.stdout(c));
    await streamInto(files.err, (c) => parser.stderr(c));
    const summary = parser.end();
    const error = failure ??
      (exitCode !== null && exitCode >= 125 && exitCode <= 127 ? `walk command could not run (exit ${exitCode})` : undefined);
    return {
      summary, deniedCount: parser.deniedCount, deniedSample: parser.deniedSample,
      ...(parser.stderrSample.length ? { stderrSample: parser.stderrSample } : {}),
      timedOut: overdue || exitCode === TIMEOUT_EXIT_STATUS, exitCode, privileged,
      walkNote: walkNote(state), ...(error ? { error } : {}),
    };
  });
}

/** Shared launch/adopt/timeout transport; each reader owns its output contract. */
export async function runDetachedWalk<T>(
  root: string, opts: DetachedWalkOptions, duArgs: string[],
  read: (state: DetachedWalkState, exitCode: number | null, overdue: boolean, failure?: string) => Promise<T>,
  requestKey?: string,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? CENSUS_DU_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? CENSUS_WALK_POLL_MS;
  const graceMs = opts.graceMs ?? CENSUS_WALK_GRACE_MS;
  const maxAttempts = opts.maxAttempts ?? CENSUS_WALK_MAX_ATTEMPTS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const isAlive = opts.isAlive ?? walkProcessAlive;
  const kill = opts.kill ?? killWalkGroup;
  const launch = opts.launch ?? managedWalkLauncher;
  const dir = opts.dir;
  await fsp.mkdir(dir, { recursive: true });

  let launchedHere = false;
  let adoptionCounted = false;
  for (;;) {
    if (opts.signal?.aborted) throw new DetachedWalkAbandoned();
    const state = await readWalkState(dir);
    if (state) {
      if (state.root !== root || state.requestKey !== requestKey) {
        throw new Error('census walk request changed; retire its previous attempt before replacing it');
      }
      const files = walkAttemptFiles(dir, state.attempt);
      const exitCode = await readExitStatus(files.exit);
      if (exitCode !== null) return read(state, exitCode, false);
      if (isAlive(state)) {
        if (!launchedHere && !adoptionCounted) {
          adoptionCounted = true;
          state.adoptions += 1;
          await writeWalkState(dir, state);
        }
        const waited = await waitForWalk(state, files.exit, { pollMs, graceMs, now, sleep, isAlive, signal: opts.signal });
        if (waited === 'exited') continue;
        if (waited === 'overdue') {
          kill(state);
          return read(state, null, true);
        }
      } else if ((await readExitStatus(files.exit)) !== null) {
        continue; // it wrote its status between the two reads
      }
      if (state.attempt >= maxAttempts) {
        return read(state, null, false, `walk ended without an exit status on all ${maxAttempts} attempt(s)`);
      }
    }
    const attempt = (state?.attempt ?? 0) + 1;
    await launchAttempt(root, attempt, state?.adoptions ?? 0);
    launchedHere = true;
  }

  async function launchAttempt(walkRoot: string, attempt: number, adoptions: number): Promise<void> {
    const files = walkAttemptFiles(dir, attempt);
    await Promise.all([files.out, files.err, files.exit, `${files.exit}.part`].map((p) => fsp.rm(p, { force: true })));
    const [cmd, args] = opts.command
      ? opts.command(duArgs)
      : censusCommand('du', duArgs, {
          ionice: await resolveCensusBin('ionice'),
          nice: await resolveCensusBin('nice'),
          sudo: opts.sudo ?? null,
        });
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const timeoutBin = await resolveCensusBin('timeout');
    const inner = timeoutBin ? [timeoutBin, '-s', 'TERM', `${timeoutSec}s`, cmd, ...args] : [cmd, ...args];
    const sh = (await resolveCensusBin('sh')) ?? '/bin/sh';
    const launchedAt = now();
    const pending: DetachedWalkState = {
      version: 1,
      root: walkRoot,
      attempt,
      pid: null,
      identity: null,
      taskId: null,
      confined: false,
      confinementSkippedReason: null,
      launchedAt,
      deadlineAt: launchedAt + timeoutMs,
      adoptions,
      ...(requestKey ? { requestKey } : {}),
    };
    // Recorded BEFORE the fork: a crash between here and the pid write reads as a vanished
    // attempt and the next caller moves to attempt+1, never re-using this attempt's files.
    await writeWalkState(dir, pending);
    const launched = await launch(sh, ['-c', WALK_SCRIPT, 'disk-census-walk', files.out, files.err, files.exit, ...inner], {
      root: walkRoot,
      dir,
      attempt,
      runtimeMaxSec: timeoutSec + Math.ceil(graceMs / 1000),
      attribution: opts.attribution,
    });
    await writeWalkState(dir, {
      ...pending,
      pid: launched.pid,
      identity: readProcessIdentity(launched.pid),
      taskId: launched.taskId,
      confined: launched.confined,
      confinementSkippedReason: launched.confinementSkippedReason ?? null,
    });
  }
}

export interface DetachedUsageRun {
  /** Null on ANY partial/failed measurement; never a lower bound posing as a cap total. */
  bytes: Map<string, number> | null;
  complete: boolean;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  walkNote?: string;
}

// This collector runs INSIDE the existing managed census scope. It keeps du's one
// cross-root inode table, but persists only root totals and a bounded progress row,
// rather than gigabytes of --all output. Neither stderr nor partial records renew
// its inactivity timer. The caller may leave; timeout(1) still bounds the worker.
const USAGE_COLLECTOR = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync, renameSync } = require('node:fs');
const { resolve } = require('node:path');
const roots = JSON.parse(process.argv[1]), progressPath = process.argv[2];
const totals = new Map();
let pending = '', stderr = '', failure = '', records = 0, stdoutBytes = 0;
let lastMetadataAt = null, lastMetadataPath = null, savedAt = 0;
const startedAt = Date.now();
const child = spawn(process.argv[3], process.argv.slice(4), { stdio: ['ignore', 'pipe', 'pipe'] });
function progress(finishedAt = null) {
  const at = Date.now();
  if (finishedAt === null && at - savedAt < 1000) return;
  savedAt = at;
  const row = { startedAt, finishedAt, heartbeatAt: at, metadataRecords: records, stdoutBytes,
    completedRoots: totals.size, totalRoots: roots.length, lastMetadataAt,
    lastMetadataPath, error: failure || null };
  writeFileSync(progressPath + '.part', JSON.stringify(row));
  renameSync(progressPath + '.part', progressPath);
}
function stop(reason) { failure ||= reason; child.kill('SIGKILL'); }
progress();
const heartbeat = setInterval(() => progress(), 1000);
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  if (failure) return;
  stdoutBytes += Buffer.byteLength(chunk);
  const rows = (pending + chunk).split('\0'); pending = rows.pop() || '';
  for (const row of rows) {
    const tab = row.indexOf('\t'), value = row.slice(0, tab), p = row.slice(tab + 1), n = Number(value);
    if (tab < 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(n) || resolve(p) !== p ||
        !roots.some(root => p === root || p.startsWith(root + '/')) || totals.has(p)) {
      stop('invalid usage walk output'); return;
    }
    records++; lastMetadataAt = Date.now(); lastMetadataPath = p.slice(-1024);
    if (roots.includes(p)) totals.set(p, n);
  }
  if (pending.length > 65536) { stop('oversized usage walk record'); return; }
  progress();
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
child.once('error', error => { failure ||= error.message; });
child.once('close', (code, signal) => {
  clearInterval(heartbeat);
  if (code !== 0 || signal || pending || totals.size !== roots.length) failure ||= 'incomplete usage walk';
  progress(Date.now());
  if (failure) { process.stderr.write(failure + '\n' + stderr); process.exitCode = 1; }
  else for (const [p, bytes] of totals) process.stdout.write(bytes + '\t' + p + '\0');
});
`;

/** Ordered, non-overlapping roots are one allocation population (pinned roots first).
 * Reusing a directory with another population refuses before launching any process.
 * Callers serialize directory ownership, bound waiting with signal, and retire a
 * consumed/obsolete attempt before requesting a new measurement. */
export async function runDetachedDuUsage(roots: readonly string[], opts: DetachedWalkOptions): Promise<DetachedUsageRun> {
  if (!roots.length || roots.some((p, i) => resolve(p) !== p || p === '/' ||
      roots.some((other, j) => i !== j && (p === other || p.startsWith(other + sep))))) {
    throw new Error('usage walk requires unique non-overlapping absolute roots');
  }
  const identities = async () => Promise.all(roots.map(async p => {
    const st = await fsp.lstat(p);
    if (!st.isDirectory()) throw new Error('usage walk root is not a directory');
    return [p, st.dev, st.ino];
  }));
  const population = JSON.stringify(await identities());
  const requestKey = createHash('sha256').update('root-usage-v1\0' + population).digest('hex');
  const progressPath = join(opts.dir, 'usage-progress.json');
  const duArgs = ['--all', '--one-file-system', '--block-size=1', '--null', '--', ...roots];
  const command = opts.command ?? ((args: string[]) => censusCommand('du', args, bins));
  const bins = {
    ionice: await resolveCensusBin('ionice'), nice: await resolveCensusBin('nice'), sudo: opts.sudo ?? null,
  };
  return runDetachedWalk(roots[0]!, { ...opts, command: args => {
    const [cmd, argv] = command(args);
    return [process.execPath, ['-e', USAGE_COLLECTOR, JSON.stringify(roots), progressPath, cmd, ...argv]];
  } }, duArgs, async (state, exitCode, overdue, failure) => {
    const files = walkAttemptFiles(opts.dir, state.attempt);
    let error = failure, pending = '', finishedAt: number | null = null;
    const bytes = new Map<string, number>();
    await streamInto(files.out, chunk => {
      if (error) return;
      const rows = (pending + chunk).split('\0'); pending = rows.pop() ?? '';
      for (const row of rows) {
        const tab = row.indexOf('\t'), value = row.slice(0, tab), p = row.slice(tab + 1), n = Number(value);
        if (tab < 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(n) || !roots.includes(p) || bytes.has(p)) {
          error = 'invalid usage walk root totals'; return;
        }
        bytes.set(p, n);
      }
      if (pending.length > 65536) error = 'oversized usage walk root record';
    });
    let stderr = '';
    await streamInto(files.err, chunk => { stderr = (stderr + chunk).slice(-4096); });
    try {
      const progress = JSON.parse(await fsp.readFile(progressPath, 'utf8'));
      if (Number.isSafeInteger(progress.startedAt) && progress.startedAt >= state.launchedAt &&
          Number.isSafeInteger(progress.finishedAt) && progress.finishedAt >= progress.startedAt &&
          progress.finishedAt <= (opts.now ?? Date.now)() && progress.error === null &&
          Number.isSafeInteger(progress.metadataRecords) && progress.metadataRecords >= roots.length &&
          progress.totalRoots === roots.length && progress.completedRoots === roots.length) finishedAt = progress.finishedAt;
    } catch { /* Missing terminal metadata cannot certify a complete measurement. */ }
    if (overdue || exitCode !== 0 || pending || bytes.size !== roots.length || finishedAt === null) {
      error ??= `incomplete usage walk (exit ${exitCode}): ${stderr}`;
    }
    try { if (JSON.stringify(await identities()) !== population) error ??= 'usage walk root identity changed'; }
    catch { error ??= 'usage walk root identity unavailable'; }
    return {
      bytes: error ? null : bytes, complete: !error, startedAt: state.launchedAt, finishedAt,
      exitCode, timedOut: overdue || exitCode === TIMEOUT_EXIT_STATUS,
      ...(error ? { error } : {}), walkNote: walkNote(state),
    };
  }, requestKey);
}

async function waitForWalk(
  state: DetachedWalkState,
  exitPath: string,
  o: {
    pollMs: number;
    graceMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    isAlive: (s: DetachedWalkState) => boolean;
    signal?: AbortSignal;
  },
): Promise<'exited' | 'gone' | 'overdue'> {
  for (;;) {
    if (o.signal?.aborted) throw new DetachedWalkAbandoned();
    if ((await readExitStatus(exitPath)) !== null) return 'exited';
    if (!o.isAlive(state)) return (await readExitStatus(exitPath)) !== null ? 'exited' : 'gone';
    if (o.now() > state.deadlineAt + o.graceMs) return 'overdue';
    await o.sleep(o.pollMs);
  }
}

async function streamInto(path: string, onChunk: (chunk: string) => void): Promise<void> {
  try {
    await fsp.access(path);
  } catch {
    return;
  }
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) onChunk(chunk as string);
}

/** What the run row should say about how its walk ran; undefined for an ordinary walk. */
export function walkNote(state: DetachedWalkState): string | undefined {
  const parts: string[] = [];
  if (!state.confined) {
    parts.push(`walk unconfined (${state.confinementSkippedReason ?? 'no transient scope'}): an operator restart kills it`);
  }
  if (state.adoptions > 0) parts.push(`walk survived ${state.adoptions} operator restart(s) and was adopted`);
  if (state.attempt > 1) parts.push(`walk relaunched ${state.attempt - 1} time(s) after it ended without a status`);
  return parts.length ? parts.join('; ') : undefined;
}

/** Root of every census walk directory: `$PAPERCUSP_HOME/disk-census-walks`. */
export function censusWalkRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(papercuspHome(env), 'disk-census-walks');
}

/** A filesystem-safe key for one census run (the DBOS workflow id). */
export function censusRunKey(workflowId: string): string {
  return workflowId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'census';
}

/** One walk directory per run and device. */
export function censusWalkDir(runKey: string, device: string, root: string = censusWalkRoot()): string {
  const slug = device === '/' ? 'root' : device.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
  return join(root, censusRunKey(runKey), slug);
}

/** A runDuTree-shaped walker whose walks survive operator restarts, keyed by `runKey`. */
export function detachedCensusWalker(
  runKey: string,
  root: string = censusWalkRoot(),
): (device: string, opts?: { floorBytes?: number; maxDepth?: number; timeoutMs?: number; sudo?: string | null }) => Promise<DuRun> {
  return (device, opts = {}) => runDetachedDuWalk(device, { ...opts, dir: censusWalkDir(runKey, device, root) });
}

/**
 * Remove `runKey`'s walk directories (its rows are written) and any run directory older
 * than `keepMs`. Never touches anything outside `root`. Returns the directories removed.
 */
export async function pruneCensusWalks(
  opts: { root?: string; runKey?: string; keepMs?: number; now?: number } = {},
): Promise<number> {
  const root = resolve(opts.root ?? censusWalkRoot());
  const cutoff = (opts.now ?? Date.now()) - (opts.keepMs ?? CENSUS_WALK_KEEP_MS);
  const own = opts.runKey ? censusRunKey(opts.runKey) : null;
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) continue;
    let stale = false;
    try {
      stale = (await fsp.stat(path)).mtimeMs < cutoff;
    } catch {
      continue;
    }
    if (name !== own && !stale) continue;
    await fsp.rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
