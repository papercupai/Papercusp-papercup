/**
 * Disk consumer census — the I/O half (disk-headroom-standing-reclaim-2026-10-12
 * P-001, R-1; WI-6554700010008933). The pure attribution + 24h growth join live in
 * ./usage.ts.
 *
 * One pass, per watched device (the disk-space alarm's `watchedPaths()`, grouped by
 * st_dev and resolved to the mount that shows the whole filesystem):
 *   1. statfs → size / used / avail.
 *   2. `du -x -0 -B1 --max-depth=6 <mount>` at low priority (best-effort I/O level 7,
 *      nice 19 — not the idle I/O class, which mq-deadline starves; see usage.ts), streamed into
 *      the consumer tree (every directory ≥ 1 GiB down to depth 6, plus the large
 *      files inside any directory whose own files reach 1 GiB).
 *      The walk runs as root through `sudo -n` when that works non-interactively
 *      (resolveCensusSudo, probed once per pass), so root-owned trees are measured
 *      rather than lost to "Permission denied"; otherwise it walks unprivileged and
 *      the run note says so.
 *   3. On an unprivileged walk, stores the operator user cannot read are sized through
 *      their own APIs instead of being lost: the Postgres cluster (pg_database_size +
 *      WAL) and Docker (Engine API /system/df). They are added only when du could not
 *      read their root, so nothing is counted twice.
 *   4. used − attributed = the device's `(unattributed)` row. At or above 10 GiB the
 *      read flags a coverage gap: a consumer that large could be missing (R-1 falsifier).
 *   5. One disk_census_runs row + its disk_census_consumers rows, in one transaction.
 * Then rows older than 30 days are pruned.
 *
 * Linux-only (GNU du flags, /proc/self/mountinfo); other platforms skip with a reason.
 */
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fsp, statfs as statfsCb } from 'node:fs';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { alarmWatchedPaths } from './disk-space-alarm';
import { getBuildInfo } from '../build-info';
import { anotherRoutinesTickInFlight, ROUTINE_TICK_OVERLAP_STATEMENT_TIMEOUT_MS } from '../dbos/routine-tick-overlap-guard';
import {
  attributeOwnFiles,
  CENSUS_COVERAGE_GAP_BYTES,
  CENSUS_FLOOR_BYTES,
  CENSUS_MAX_DEPTH,
  censusCommand,
  censusDepth,
  censusOwnFilesArgs,
  deviceMountRoot,
  devToMajorMinor,
  DuTreeAccumulator,
  joinCensusGrowth,
  parseMountInfo,
  parseOwnFilesRecord,
  sortCensusRows,
  type CensusConsumer,
  type CensusConsumerKind,
  type CensusGrowthRow,
  type DuTreeSummary,
} from './usage';

const statfs = promisify(statfsCb);

export const CENSUS_RETENTION_DAYS = 30;
/** Hard cap on one device's du walk. A killed walk still writes a run, marked incomplete. */
export const CENSUS_DU_TIMEOUT_MS = 90 * 60 * 1000;
/** A device whose latest run is older than this is reported stale (R-1 falsifier). */
export const CENSUS_STALE_MS = 24 * 60 * 60 * 1000;

/** The minimal postgres.js surface the census uses — injectable for tests. */
export interface CensusSql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  begin<T>(fn: (tx: CensusSql) => Promise<T>): Promise<T>;
}

/** Hourly schedules must not multiply a slow, restart-recoverable census pass.
 * Prefer the oldest queued/running pass. Reuse the scheduler's bounded probe;
 * a terminal or stale workflow cannot indefinitely suppress new measurements. */
export async function diskCensusPassInFlight(
  sql: CensusSql, workflowId: string, deviceCount: number, now = Date.now(),
): Promise<boolean> {
  const staleMs = Math.max(1, deviceCount) * CENSUS_DU_TIMEOUT_MS + 30 * 60_000;
  return anotherRoutinesTickInFlight(workflowId, {
    now: () => now,
    queryInFlight: (selfId, cutoff) => sql.begin(async tx => {
      await tx`SELECT set_config('statement_timeout', ${String(ROUTINE_TICK_OVERLAP_STATEMENT_TIMEOUT_MS)}, true)`;
      return tx<{ workflow_uuid: string }>`
        SELECT older.workflow_uuid FROM dbos.workflow_status older
        JOIN dbos.workflow_status current ON current.workflow_uuid = ${selfId}
        WHERE older.name = 'diskConsumerCensus'
          AND older.status IN ('PENDING', 'ENQUEUED')
          AND COALESCE(older.started_at_epoch_ms, older.created_at) > ${cutoff}
          AND (older.created_at, older.workflow_uuid) < (current.created_at, current.workflow_uuid)
        LIMIT 1`;
    }),
  }, staleMs);
}

export interface CensusDevice {
  /** Mount point that shows the whole filesystem. */
  device: string;
  majorMinor: string;
  sizeBytes: number;
  usedBytes: number;
  availBytes: number;
}

async function readMountInfo(): Promise<string> {
  try {
    return await fsp.readFile('/proc/self/mountinfo', 'utf8');
  } catch {
    return '';
  }
}

/** Walk up from `path` to the highest ancestor still on the same device. */
async function walkUpMountPoint(path: string, dev: number): Promise<string> {
  let cur = path;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    try {
      if ((await fsp.stat(parent)).dev !== dev) return cur;
    } catch {
      return cur;
    }
    cur = parent;
  }
}

/** The watched devices (one per st_dev) with their whole-filesystem mount root and statfs numbers. */
export async function resolveCensusDevices(paths: readonly string[] = alarmWatchedPaths()): Promise<CensusDevice[]> {
  const mounts = parseMountInfo(await readMountInfo());
  const out: CensusDevice[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    let dev: number;
    try {
      dev = (await fsp.stat(path)).dev;
    } catch {
      continue;
    }
    const majorMinor = devToMajorMinor(dev);
    if (seen.has(majorMinor)) continue;
    seen.add(majorMinor);
    const device = deviceMountRoot(mounts, majorMinor) ?? (await walkUpMountPoint(path, dev));
    try {
      out.push({ device, majorMinor, ...(await statCensusDevice(device)) });
    } catch {
      continue;
    }
  }
  return out;
}

export type CensusDeviceUsage = Pick<CensusDevice, 'sizeBytes' | 'usedBytes' | 'availBytes'>;

/** statfs numbers for one mount root (throws when the mount is unreadable). */
export async function statCensusDevice(mountRoot: string): Promise<CensusDeviceUsage> {
  const st = await statfs(mountRoot);
  const bsize = Number(st.bsize) || 0;
  return {
    sizeBytes: Number(st.blocks) * bsize,
    usedBytes: (Number(st.blocks) - Number(st.bfree)) * bsize,
    availBytes: Number(st.bavail) * bsize,
  };
}

/** Used bytes that moved by at least this much during a walk get a run note. */
export const CENSUS_USAGE_DRIFT_NOTE_BYTES = 1024 ** 3;

/**
 * The device numbers to reconcile a walk against. `du` reads the tree over minutes while
 * the filesystem keeps changing, so `used` is taken as the midpoint of the statfs samples
 * just before and just after the walk; size and avail come from the latest sample. With
 * no sample, the resolved numbers stand.
 */
export function reconcileWalkUsage(
  resolved: CensusDevice,
  before: CensusDeviceUsage | null,
  after: CensusDeviceUsage | null,
): { device: CensusDevice; note: string | null } {
  const latest = after ?? before;
  if (!latest) return { device: resolved, note: null };
  const usedBytes = before && after ? Math.round((before.usedBytes + after.usedBytes) / 2) : latest.usedBytes;
  const device = { ...resolved, sizeBytes: latest.sizeBytes, availBytes: latest.availBytes, usedBytes };
  const drift = before && after ? after.usedBytes - before.usedBytes : 0;
  const note =
    Math.abs(drift) >= CENSUS_USAGE_DRIFT_NOTE_BYTES
      ? `used moved ${drift > 0 ? '+' : '-'}${(Math.abs(drift) / 1024 ** 3).toFixed(1)} GiB during the walk; reconciled against the midpoint`
      : null;
  return { device, note };
}

/** Bound on the one `sudo -n true` probe per census pass. */
export const CENSUS_SUDO_PROBE_TIMEOUT_MS = 5_000;
const CENSUS_DU_STDERR_SAMPLE_LINES = 5;
const CENSUS_DU_STDERR_SAMPLE_LINE_CHARS = 400;

/**
 * The sudo binary to run the census du through, or null to walk as the current user.
 * Null when already root (nothing to elevate), when sudo is not installed, or when it
 * cannot run non-interactively (no NOPASSWD rule, or a NoNewPrivileges sandbox) — the
 * census then still runs and its `unreadable path(s)` note + coverage gap say what it missed.
 */
export async function resolveCensusSudo(
  probe: (bin: string) => Promise<boolean> = probeSudo,
): Promise<string | null> {
  if (process.getuid?.() === 0) return null;
  const bin = await resolveBin('sudo');
  if (!bin) return null;
  return (await probe(bin)) ? bin : null;
}

function probeSudo(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-n', 'true'], { timeout: CENSUS_SUDO_PROBE_TIMEOUT_MS }, (err) => resolve(!err));
  });
}

async function resolveBin(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Absolute path of an executable on PATH, or null. */
export const resolveCensusBin = resolveBin;

export interface DuRun {
  summary: DuTreeSummary;
  deniedCount: number;
  deniedSample: string[];
  /** Bounded first-line diagnostics, retained in the census row when the walk is incomplete. */
  stderrSample?: string[];
  timedOut: boolean;
  exitCode: number | null;
  error?: string;
  /** The walk ran as root (via sudo, or the process is root): every store root was readable to du. */
  privileged?: boolean;
  /** How the walk ran when that matters to the reader (detached, adopted after a restart, relaunched). */
  walkNote?: string;
}

/**
 * Incremental parser for one du walk: NUL-separated `<bytes>\t<path>` records on stdout
 * into the consumer tree, `Permission denied` lines on stderr into a count + sample.
 * Shared by the piped walk (runDuTree) and the detached walk that reads its files back.
 */
export class DuOutputParser {
  deniedCount = 0;
  readonly deniedSample: string[] = [];
  readonly stderrSample: string[] = [];
  private pending = '';
  private errPending = '';

  constructor(private readonly acc: DuTreeAccumulator) {}

  stdout(chunk: string): void {
    this.pending += chunk;
    const parts = this.pending.split('\0');
    this.pending = parts.pop() ?? '';
    for (const record of parts) this.acc.addRecord(record);
  }

  stderr(chunk: string): void {
    this.errPending += chunk;
    const lines = this.errPending.split('\n');
    this.errPending = lines.pop() ?? '';
    for (const line of lines) this.deniedLine(line);
  }

  /** Flush the unterminated tails; call once, after both streams ended. */
  end(): DuTreeSummary {
    if (this.pending) this.acc.addRecord(this.pending);
    this.pending = '';
    if (this.errPending) this.deniedLine(this.errPending);
    this.errPending = '';
    return this.acc.result();
  }

  private deniedLine(line: string): void {
    const normalized = line.replace(/\s+/g, ' ').trim();
    if (normalized && this.stderrSample.length < CENSUS_DU_STDERR_SAMPLE_LINES) {
      this.stderrSample.push(normalized.slice(0, CENSUS_DU_STDERR_SAMPLE_LINE_CHARS));
    }
    if (!/Permission denied/.test(line)) return;
    this.deniedCount += 1;
    const m = /'([^']+)'/.exec(line);
    if (m && this.deniedSample.length < 10) this.deniedSample.push(m[1]!);
  }
}

/** du arguments for one census walk: one filesystem, NUL-separated, byte units, `maxDepth` levels. */
export function censusDuArgs(root: string, maxDepth: number = CENSUS_MAX_DEPTH): string[] {
  return ['-x', '-0', '-B1', `--max-depth=${maxDepth}`, root];
}

/** Run du over one mount at low priority and stream it into a consumer tree. */
export async function runDuTree(
  root: string,
  opts: { floorBytes?: number; maxDepth?: number; timeoutMs?: number; sudo?: string | null } = {},
): Promise<DuRun> {
  const floorBytes = opts.floorBytes ?? CENSUS_FLOOR_BYTES;
  const maxDepth = opts.maxDepth ?? CENSUS_MAX_DEPTH;
  const acc = new DuTreeAccumulator(root, { floorBytes, maxDepth });
  const duArgs = censusDuArgs(root, maxDepth);
  const privileged = Boolean(opts.sudo) || process.getuid?.() === 0;
  // Best-effort I/O at the lowest level, not the idle class: see CENSUS_IONICE_ARGS.
  // sudo relays the timeout's SIGTERM to du, so the 90 min cap still ends the walk.
  const [cmd, args] = censusCommand('du', duArgs, {
    ionice: await resolveBin('ionice'),
    nice: await resolveBin('nice'),
    sudo: opts.sudo ?? null,
  });
  return new Promise<DuRun>((resolve) => {
    const parser = new DuOutputParser(acc);
    let timedOut = false;
    let error: string | undefined;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? CENSUS_DU_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => parser.stdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => parser.stderr(chunk));
    child.on('error', (err) => {
      error = err.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const summary = parser.end();
      resolve({
        summary,
        deniedCount: parser.deniedCount,
        deniedSample: parser.deniedSample,
        ...(parser.stderrSample.length ? { stderrSample: parser.stderrSample } : {}),
        timedOut,
        exitCode: code,
        privileged,
        ...(error ? { error } : {}),
      });
    });
  });
}

/** Bound on listing one directory's own files; a 427,868-entry directory lists in ~15 s. */
export const CENSUS_OWN_FILES_TIMEOUT_MS = 10 * 60 * 1000;

/** Spawns one census subprocess with stdin ignored and stdout/stderr piped. */
export type CensusSpawn = (cmd: string, args: string[]) => ChildProcessByStdio<null, Readable, Readable>;

const defaultCensusSpawn: CensusSpawn = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

/** Only multiply linked regular files need per-inode storage. Ordinary files
 * remain streaming totals even in very large trees. Paths support partial build effects. */
export interface RetentionHardlink { dev: number; ino: number; bytes: number; paths: string[]; }
export class RetentionAllocationCounter {
  bytes = 0;
  private shared = new Map<string, RetentionHardlink>();
  add(path: string, stat: { dev: number; ino: number; blocks: number; nlink: number }, regular: boolean): void {
    const bytes = stat.blocks * 512;
    if (regular && stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      const prior = this.shared.get(key);
      if (prior) {
        if (prior.bytes !== bytes) throw new Error('hardlink allocation changed during census');
        prior.paths.push(path); return;
      }
      this.shared.set(key, { dev: stat.dev, ino: stat.ino, bytes, paths: [path] });
    }
    this.bytes += bytes;
  }
  metadata(): { hardlinks?: RetentionHardlink[] } {
    return this.shared.size ? { hardlinks: [...this.shared.values()]
      .sort((a, b) => a.dev - b.dev || a.ino - b.ino).map(value => ({ ...value, paths: [...value.paths].sort() })) } : {};
  }
}

export interface RetentionCensusTiming {
  elapsedMs: number;
  lastProgressAfterMs: number | null;
  lastChildPath: string | null;
  timeoutMs: number | null;
  progressTimeoutMs: number | null;
  /** An unmarked native kill is deliberately not attributed to a deadline. */
  timeoutKind: 'absolute' | 'progress' | 'native-signal' | null;
}
export interface RetentionTreeCensus {
  entries: Array<{ path: string; newestWriteMs: number; bytes: number; dev: number; ino: number;
    hardlinks?: RetentionHardlink[];
    buildDirs?: Array<{ path: string; dev: number; ino: number }> }>;
  retained: Array<{ path: string; reason: string; entry?: RetentionTreeCensus['entries'][number] }>;
  inspectedNodes: number;
  retainedRecentTrees: number;
  /** Descendant allocation covered by an exact pin predicate; absent if unrequested or incomplete. */
  pinnedBytes?: number;
  timing?: RetentionCensusTiming;
  error?: string;
}

/** Match lstat's seconds * 1000 + nanoseconds / 1e6 without rounding epoch seconds first. */
function findTimestampMs(value: string): number | undefined {
  const match = /^(-?\d+)(?:\.(\d{1,9})0*)?$/.exec(value);
  if (!match) return undefined;
  let seconds = Number(match[1]);
  let nanoseconds = Number((match[2] ?? '').padEnd(9, '0'));
  if (!Number.isSafeInteger(seconds)) return undefined;
  if (value.startsWith('-') && nanoseconds !== 0) {
    seconds -= 1;
    nanoseconds = 1e9 - nanoseconds;
  }
  return seconds * 1000 + nanoseconds / 1e6;
}

// Run beside find, inside sudo, so the progress observer can kill and reap its
// own child. The outer native timeout also bounds the whole process group if
// the observer itself stops responding. Reuse find's existing metadata stream;
// partial records and noise do not renew the inactivity deadline. Supervised walks
// compact ordinary nested files inside this existing supervisor: Node needs
// their allocation and newest timestamps, not one IPC record per inode. Keep
// hardlinks, build tags and protection boundaries as original metadata records.
const RETENTION_CENSUS_PROGRESS_WORKER = `
import os, re, selectors, subprocess, sys, time
idle = float(sys.argv[1]) / 1000
prefix = os.fsencode(sys.argv[2]) + b'/'
compact = sys.argv[3] == 'compact'
child = subprocess.Popen(sys.argv[4:], stdout=subprocess.PIPE)
pending = b''
fields = []
deadline = time.monotonic() + idle

def nanos(value):
    seconds, _, fraction = value.partition(b'.')
    tail = int((fraction + b'000000000')[:9])
    return int(seconds) * 1000000000 + (-tail if value.startswith(b'-') else tail)

try:
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                child.kill()
                child.wait()
                print('papercusp-retention-census: progress timeout', file=sys.stderr, flush=True)
                sys.exit(137)
            chunk = os.read(child.stdout.fileno(), 65536)
            if not chunk:
                if compact and (fields or pending):
                    sys.stdout.buffer.write(b'\\0'.join(fields) + (b'\\0' if fields else b'') + pending)
                    sys.stdout.buffer.flush()
                sys.exit(child.wait())
            if not compact:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            records = (pending + chunk).split(b'\\0')
            pending = records.pop()
            output = bytearray()
            totals = {}
            for value in records:
                fields.append(value)
                if len(fields) == 9:
                    kind, dev, ino, mtime, ctime, blocks, owner, nlink, path = fields
                    valid = kind in [b'a', b'f', b'd', b'l', b'b', b'c', b's', b'p'] and path.startswith(prefix) and all(v.isdigit() for v in [dev, ino, blocks, owner, nlink]) and (kind != b'a' or int(nlink) > 0) and all(re.fullmatch(rb'-?\\d+(?:\\.\\d{1,9}0*)?', v) for v in [mtime, ctime])
                    if valid:
                        deadline = time.monotonic() + idle
                    child_path = prefix + path[len(prefix):].split(b'/')[0]
                    if compact and valid and kind == b'f' and nlink == b'1' and path != child_path and not path.endswith(b'/CACHEDIR.TAG'):
                        key = (child_path, dev, owner)
                        total = totals.get(key)
                        if total is None:
                            total = [b'a', dev, ino, mtime, ctime, int(blocks), owner, 0, child_path]
                            totals[key] = total
                        else:
                            if nanos(mtime) > nanos(total[3]): total[3] = mtime
                            if nanos(ctime) > nanos(total[4]): total[4] = ctime
                            total[5] += int(blocks)
                        total[7] += 1
                    elif compact:
                        output.extend(b'\\0'.join(fields) + b'\\0')
                    fields = []
            if compact:
                for total in totals.values():
                    total[5] = str(total[5]).encode()
                    total[7] = str(total[7]).encode()
                    output.extend(b'\\0'.join(total) + b'\\0')
                sys.stdout.buffer.write(output)
                sys.stdout.buffer.flush()
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
`;

// Uncapped expiry needs an eligibility proof, not a complete allocation count
// for a protected tree. One worker owns the root and all directory descriptors;
// a conclusive boundary ends only that direct child's walk. Capped accounting
// continues to use find below and never takes this early-exit path.
const RETENTION_CENSUS_EXPIRY_WORKER = `
import json, os, stat, sys
config = json.loads(sys.argv[1])
root = config['root']
excluded = set(config['excluded'])
cutoff = float(config['retainAfterMs'])
uid = config['uid']
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
totals = {}
candidate_path = None

def identity(value):
    return value.st_dev, value.st_ino

def timestamp(ns):
    seconds, nanos = divmod(abs(ns), 1000000000)
    return ('-' if ns < 0 else '') + str(seconds) + '.' + str(nanos).zfill(9)

def flush():
    for (dev, owner), total in totals.items():
        ino, mtime, ctime, blocks, count = total
        fields = ['a', str(dev), str(ino), timestamp(mtime), timestamp(ctime), str(blocks), str(owner), str(count), candidate_path]
        sys.stdout.buffer.write(b'\\0'.join(os.fsencode(field) for field in fields) + b'\\0')
    totals.clear()
    sys.stdout.buffer.flush()

def emit(path, value):
    mode = value.st_mode
    kind = 'd' if stat.S_ISDIR(mode) else 'f' if stat.S_ISREG(mode) else 'l' if stat.S_ISLNK(mode) else 'p' if stat.S_ISFIFO(mode) else 's' if stat.S_ISSOCK(mode) else 'b' if stat.S_ISBLK(mode) else 'c' if stat.S_ISCHR(mode) else '?'
    symlink_child = kind == 'l' and path != candidate_path
    boundary = path in excluded or (kind not in ['f', 'd'] and not symlink_child) or value.st_dev != config['dev'] or (uid is not None and value.st_uid != uid) or max(value.st_mtime_ns, value.st_ctime_ns) / 1000000 >= cutoff
    # Aggregate before crossing the worker pipe, rather than formatting and
    # reparsing nine fields for every ordinary file in the supervisor. Keep
    # identities, hardlinks, build tags and eligibility boundaries verbatim.
    if not boundary and kind == 'f' and value.st_nlink == 1 and path != candidate_path and not path.endswith('/CACHEDIR.TAG'):
        key = (value.st_dev, value.st_uid)
        total = totals.get(key)
        if total is None:
            total = [value.st_ino, value.st_mtime_ns, value.st_ctime_ns, 0, 0]
            totals[key] = total
        total[1] = max(total[1], value.st_mtime_ns)
        total[2] = max(total[2], value.st_ctime_ns)
        total[3] += value.st_blocks
        total[4] += 1
        # Bounded batches keep real metadata progress observable even inside
        # a single large child, without accumulating its file inventory.
        if total[4] >= 1024:
            flush()
    else:
        fields = [kind, str(value.st_dev), str(value.st_ino), timestamp(value.st_mtime_ns), timestamp(value.st_ctime_ns), str(value.st_blocks), str(value.st_uid), str(value.st_nlink), path]
        sys.stdout.buffer.write(b'\\0'.join(os.fsencode(field) for field in fields) + b'\\0')
    return boundary

def descend(parent, name, expected):
    fd = os.open(name, flags, dir_fd=parent)
    try:
        if identity(os.fstat(fd)) != identity(expected):
            raise RuntimeError('retention directory changed before descent')
        return fd, os.scandir(fd)
    except BaseException:
        os.close(fd)
        raise

def candidate(parent, name, path):
    global candidate_path
    candidate_path = path
    stack = []
    try:
        try:
            value = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return
        if emit(path, value) or not stat.S_ISDIR(value.st_mode):
            return
        try:
            fd, entries = descend(parent, name, value)
        except FileNotFoundError:
            return
        stack.append((fd, entries, path))
        while stack:
            fd, entries, directory = stack[-1]
            item = next(entries, None)
            if item is None:
                entries.close()
                os.close(fd)
                stack.pop()
                continue
            child_path = os.path.join(directory, item.name)
            try:
                value = os.stat(item.name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if emit(child_path, value):
                break
            if stat.S_ISDIR(value.st_mode):
                try:
                    child_fd, child_entries = descend(fd, item.name, value)
                except FileNotFoundError:
                    continue
                stack.append((child_fd, child_entries, child_path))
    finally:
        for fd, entries, _ in reversed(stack):
            entries.close()
            os.close(fd)
        flush()

try:
    root_fd = os.open(root, flags)
    try:
        expected = (config['dev'], config['ino'])
        if identity(os.fstat(root_fd)) != expected:
            raise RuntimeError('retention root changed before census')
        if config['paths'] is not None:
            for path in config['paths']:
                candidate(root_fd, os.path.basename(path), path)
        else:
            with os.scandir(root_fd) as entries:
                for item in entries:
                    candidate(root_fd, item.name, os.path.join(root, item.name))
        if identity(os.stat(root, follow_symlinks=False)) != expected:
            raise RuntimeError('retention root changed during census')
    finally:
        os.close(root_fd)
    sys.stdout.buffer.flush()
except Exception as error:
    print('papercusp-retention-census: ' + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
`;

/** Max-age census through one read-only native worker per root.
 * Stream metadata, aggregate direct children, and prune proven recent/protected
 * subtrees. A time cap or unreadable node invalidates the entire candidate set.
 * The result is planning evidence only; callers must remeasure before deletion.
 */
export async function inspectRetentionTrees(root: string, opts: {
  retainAfterMs: number; excludedPaths?: readonly string[]; paths?: readonly string[]; timeoutMs?: number; progressTimeoutMs?: number; spawn?: CensusSpawn;
  /** Caps need recent trees too. Elevation is explicit and scoped by the caller
   * to a policy-authorized agent root; never silently fall back on denial. */
  includeRecent?: boolean; sudo?: string | null;
  /** Exact allocation only: requires the full uncompacted metadata stream. */
  coversPinnedPath?: (path: string) => boolean;
  /** Discover build candidates during the existing walk. Tags are validated
   * through directory descriptors by the effect, never followed here. */
  collectBuildDirs?: boolean;
  /** Execute the bounded census through sudo itself. A separate `sudo true`
   * probe cannot establish whether this operation will succeed, and must not
   * suppress the real command or discard its error. */
  requirePrivilege?: boolean;
}): Promise<RetentionTreeCensus> {
  root = resolve(root);
  const result: RetentionTreeCensus = { entries: [], retained: [], inspectedNodes: 0, retainedRecentTrees: 0 };
  if (opts.coversPinnedPath && (!opts.includeRecent || opts.sudo && opts.progressTimeoutMs !== undefined ||
      opts.excludedPaths?.length || opts.paths)) {
    return { ...result, error: 'exact pin allocation requires a complete uncompacted census' };
  }
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ...result, error: 'retention root is not a plain directory' };
  if (opts.paths?.some((path) => resolve(path) !== path || dirname(path) !== root)) return { ...result, error: 'retention target outside root' };
  if (opts.paths?.length === 0) return result;
  const literal = (path: string) => path.replace(/[\\*?[\]]/g, '\\$&');
  const excluded = (opts.excludedPaths ?? []).map((path) => resolve(path)).filter((path) => path.startsWith(root + '/'));
  const prune = excluded.flatMap((path, index) => [...(index ? ['-o'] : []), '-path', literal(path)]);
  const uid = process.getuid?.();
  const sudo = opts.sudo ?? (opts.requirePrivilege && uid !== 0 ? await resolveBin('sudo') : null);
  if (opts.requirePrivilege && !sudo && uid !== 0) {
    return { ...result, error: 'sudo executable unavailable for required privileged retention census' };
  }
  const privileged = Boolean(sudo) || uid === 0;
  const foreignOwner = uid === undefined || privileged ? [] : ['!', '-uid', String(uid)];
  const format = '%y\\0%D\\0%i\\0%T@\\0%C@\\0%b\\0%U\\0%n\\0%p\\0';
  const recent = opts.includeRecent ? ['-false'] : ['(', '-newermt', `@${opts.retainAfterMs / 1000}`, '-o', '-newerct', `@${opts.retainAfterMs / 1000}`, ')'];
  // A concurrent unlink after find read the containing directory is an absent
  // candidate, not unknown eligibility. GNU find still fails on other IO errors.
  const args = [...(opts.paths ?? [root]), '-ignore_readdir_race', '-xdev', '-mindepth', opts.paths ? '0' : '1', '(', ...prune, ...(prune.length ? ['-o'] : []),
    ...foreignOwner, ...(foreignOwner.length ? ['-o'] : []), ...recent,
    ')', '-printf', format, '-prune', '-o', '-printf', format];
  // sudo may exec with every UID set to root. The caller then cannot signal
  // it (EPERM), and killing a sudo monitor can leave find holding its pipes.
  // Put deadline enforcement INSIDE elevation. A progress-supervised walk has
  // a child process, so timeout owns a separate process group and kills the
  // whole group at its absolute ceiling. Direct find needs no process group.
  const timeout = sudo ? await resolveBin('timeout') : null;
  if (sudo && !timeout) return { ...result, error: 'timeout executable unavailable for privileged retention census' };
  const progressSupervised = Boolean(sudo) && opts.progressTimeoutMs !== undefined;
  const python = progressSupervised || !opts.includeRecent ? await resolveBin('python3') : null;
  if (progressSupervised && !python) return { ...result, error: 'python3 executable unavailable for privileged retention progress supervision' };
  if (!opts.includeRecent && !python) return { ...result, error: 'python3 executable unavailable for retention expiry census' };
  const [nativeCommand, nativeArgs] = censusCommand(opts.includeRecent ? 'find' : python!, opts.includeRecent ? args : [
    '-I', '-c', RETENTION_CENSUS_EXPIRY_WORKER, JSON.stringify({ root, excluded, retainAfterMs: String(opts.retainAfterMs),
      uid: privileged ? null : uid ?? null, dev: rootStat.dev, ino: rootStat.ino, paths: opts.paths ?? null }),
  ], { sudo: null, ionice: await resolveBin('ionice'), nice: await resolveBin('nice') });
  const command = sudo ?? nativeCommand;
  const argv = !sudo ? nativeArgs : progressSupervised
    ? ['-n', '--', timeout!, '--signal=KILL', '--verbose', `${Math.max(1, opts.timeoutMs ?? 15 * 60_000) / 1000}s`,
      python!, '-I', '-c', RETENTION_CENSUS_PROGRESS_WORKER, String(Math.max(1, opts.progressTimeoutMs!)), root,
      'compact', nativeCommand, ...nativeArgs]
    : ['-n', '--', timeout!, '--foreground', '--signal=KILL', '--verbose',
      `${Math.max(1, opts.timeoutMs ?? 60_000) / 1000}s`, nativeCommand, ...nativeArgs];
  return new Promise<RetentionTreeCensus>((done) => {
    const started = performance.now();
    let lastProgressAfterMs: number | null = null, lastChildPath: string | null = null;
    let timeoutKind: RetentionCensusTiming['timeoutKind'] = null;
    const groups = new Map<string, { entry: RetentionTreeCensus['entries'][number]; allocation: RetentionAllocationCounter; reason?: string; buildDirsBlocked?: boolean }>();
    const pinnedAllocation = new RetentionAllocationCounter();
    const ancestors = new Map<string, { path: string; dev: number; ino: number }>();
    let pending = '', fields: string[] = [], stderr = '', stderrOverflow = false, malformed = false, timedOut = false, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<CensusSpawn>;
    const armProgressDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; timeoutKind ??= 'progress'; child.kill('SIGKILL'); }, opts.progressTimeoutMs ?? 60_000);
    };
    const take = (row: string[]) => {
      const [type, dev, ino, mtime, ctime, blocks, owner, nlink, path] = row;
      const modifiedMs = findTimestampMs(mtime!), changedMs = findTimestampMs(ctime!);
      const aggregate = type === 'a' && (progressSupervised || !opts.includeRecent);
      if (!path?.startsWith(root + '/') || (!/^[fdlbcsp]$/.test(type!) && !aggregate) ||
          ![dev, ino, blocks, owner, nlink].every((v) => /^\d+$/.test(v!)) || modifiedMs === undefined || changedMs === undefined) {
        malformed = true; return;
      }
      if (aggregate && (!Number.isSafeInteger(Number(nlink)) || Number(nlink) < 1 || !Number.isSafeInteger(Number(blocks)))) {
        malformed = true; return;
      }
      result.inspectedNodes += aggregate ? Number(nlink) : 1;
      const child = join(root, path.slice(root.length + 1).split('/')[0]!);
      lastChildPath = child;
      const direct = path === child;
      let group = groups.get(child);
      if (!group) {
        if (!direct || aggregate) { malformed = true; return; }
        group = { entry: { path: child, newestWriteMs: Number.NEGATIVE_INFINITY, bytes: 0, dev: Number(dev), ino: Number(ino) }, allocation: new RetentionAllocationCounter() };
        groups.set(child, group);
      }
      const newest = Math.max(modifiedMs, changedMs);
      if (opts.collectBuildDirs && !aggregate) {
        // GNU find visits directories before their children. Keep only the
        // current ancestry, rather than retaining every directory in the tree.
        for (const ancestor of ancestors.keys()) if (!path.startsWith(ancestor + '/')) ancestors.delete(ancestor);
        if (type === 'd') ancestors.set(path, { path, dev: Number(dev), ino: Number(ino) });
        const candidate = type === 'd' && path.endsWith('/node_modules') ? ancestors.get(path)
          : type === 'f' && path.endsWith('/CACHEDIR.TAG') ? ancestors.get(dirname(path)) : undefined;
        if (candidate && candidate.path !== child && !group.buildDirsBlocked) {
          const builds = group.entry.buildDirs ??= [];
          if (!builds.some(value => value.path === candidate.path)) builds.push(candidate);
        }
      }
      group.entry.newestWriteMs = Math.max(group.entry.newestWriteMs, newest);
      try {
        const stat = { dev: Number(dev), ino: Number(ino), blocks: Number(blocks), nlink: Number(nlink) };
        group.allocation.add(path, stat, type === 'f');
        if (opts.coversPinnedPath) {
          if (aggregate) throw new Error('compacted pin allocation is unmeasured');
          if (opts.coversPinnedPath(path)) pinnedAllocation.add(path, stat, type === 'f');
        }
      }
      catch { malformed = true; }
      if (excluded.includes(path)) group.reason = 'protected policy root';
      else if (type === 'l' && direct) group.reason = 'symlink boundary';
      else if (type === 'l' && opts.collectBuildDirs) {
        group.buildDirsBlocked = true;
        group.entry.buildDirs = [];
      }
      else if (type !== 'f' && type !== 'd' && type !== 'l' && !aggregate) group.reason = 'special filesystem entry';
      else if (Number(dev) !== rootStat.dev) group.reason = 'filesystem boundary';
      else if (!privileged && uid !== undefined && Number(owner) !== uid) group.reason = 'foreign ownership boundary';
      else if (!opts.includeRecent && newest >= opts.retainAfterMs && !group.reason) group.reason = 'recent write';
    };
    const finish = (error?: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(absoluteTimer);
      for (const { entry, allocation, reason } of groups.values()) {
        entry.bytes = allocation.bytes;
        Object.assign(entry, allocation.metadata());
        if (reason === 'recent write') result.retainedRecentTrees++;
        else if (reason) result.retained.push({ path: entry.path, reason, ...(opts.includeRecent ? { entry } : {}) });
        else result.entries.push(entry);
      }
      if (error) { result.error = error; result.entries = []; }
      else if (opts.coversPinnedPath) {
        if (!Number.isSafeInteger(pinnedAllocation.bytes) || pinnedAllocation.bytes < 0) {
          result.error = 'invalid pin allocation'; result.entries = [];
        } else result.pinnedBytes = pinnedAllocation.bytes;
      }
      result.timing = { elapsedMs: performance.now() - started, lastProgressAfterMs, lastChildPath,
        timeoutMs: sudo ? Math.max(1, opts.timeoutMs ?? (progressSupervised ? 15 * 60_000 : 60_000)) : opts.timeoutMs ?? null,
        progressTimeoutMs: progressSupervised || !sudo && (opts.timeoutMs === undefined || opts.progressTimeoutMs !== undefined)
          ? opts.progressTimeoutMs ?? 60_000 : null,
        timeoutKind };
      done(result);
    };
    try { child = (opts.spawn ?? defaultCensusSpawn)(command, argv); }
    catch (error) { finish(`find failed: ${String(error)}`); return; }
    // Ordinary-owner scans can use metadata progress rather than an absolute
    // bound. Elevated scans are supervised by their native timeout above.
    if (!sudo) {
      if (opts.timeoutMs !== undefined) absoluteTimer = setTimeout(() => { timedOut = true; timeoutKind ??= 'absolute'; child.kill('SIGKILL'); }, opts.timeoutMs);
      if (opts.timeoutMs === undefined || opts.progressTimeoutMs !== undefined) armProgressDeadline();
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const before = result.inspectedNodes;
      const records = (pending + chunk).split('\0'); pending = records.pop() ?? '';
      for (const value of records) { fields.push(value); if (fields.length === 9) { take(fields); fields = []; } }
      if (!malformed && result.inspectedNodes > before) lastProgressAfterMs = performance.now() - started;
      // Noise, partial records and malformed data cannot keep a wedged scan alive.
      if (!sudo && (opts.timeoutMs === undefined || opts.progressTimeoutMs !== undefined) && !malformed && result.inspectedNodes > before) armProgressDeadline();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrOverflow ||= stderr.length + chunk.length > 4096;
      stderr = (stderr + chunk).slice(-4096);
    });
    child.once('error', (error) => finish(`find failed: ${String(error)}`));
    // A process-group SIGKILL also kills timeout itself, so Node reports a
    // signal with a null exit code rather than the direct-child status 137.
    child.once('close', async (code, signal) => {
      if (timedOut || (sudo && (code === 137 || (progressSupervised && signal === 'SIGKILL')))) {
        // Only explicit supervisor evidence identifies which deadline fired.
        // A locale-specific timeout message or an external kill stays unknown.
        timeoutKind ??= stderr.split('\n').includes('papercusp-retention-census: progress timeout') ? 'progress'
          : /^(?:[^\n]*\/)?timeout: sending signal KILL to command /m.test(stderr) ? 'absolute' : 'native-signal';
        finish('retention native census timed out'); return;
      }
      // GNU find's ignore_readdir_race covers a failed stat, but not a
      // directory removed after its metadata was emitted and before descent.
      // Accept only that same absent-object case, proven again after find exits.
      // Unknown diagnostics, truncated stderr, replacements and permission errors
      // still invalidate the complete candidate set. This remains planning
      // evidence: reclaim rechecks each candidate before any removal.
      const disappearedOnly = async () => {
        if (code !== 1 || signal || stderrOverflow || !stderr.trim()) return false;
        const currentRoot = await fsp.lstat(root);
        if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) return false;
        for (const line of stderr.trimEnd().split('\n')) {
          const match = /^(?:[^:]*\/)?find: (?:‘(.+)’|'(.+)'): No such file or directory$/.exec(line);
          const path = match?.[1] ?? match?.[2];
          if (!path || !path.startsWith(root + '/') || resolve(path) !== path) return false;
          try { await fsp.lstat(path); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
        }
        return true;
      };
      if (code !== 0 && !await disappearedOnly().catch(() => false)) {
        finish(`find exited ${code}: ${stderr.trim()}`); return;
      }
      finish(malformed || pending.length || fields.length ? 'incomplete retention metadata records' : undefined);
    });
  });
}

export interface OwnFilesListing {
  /** The directory's immediate regular files at or above the floor, ALLOCATED bytes (du's unit). */
  files: Array<{ path: string; bytes: number }>;
  /** Why the listing may be partial (find failed, exited non-zero, or timed out); absent when complete. */
  error?: string;
}

/**
 * The immediate regular files of `dir` at or above `floorBytes`, through ONE find
 * subprocess run like the du walk (sudo -n when resolved, best-effort I/O level 7,
 * nice 19). Never a per-entry stat on the event loop: that ran at ~106 entries/s on
 * bg-host and took ~67 min for one 427,868-file directory (WI-6554700010009487).
 * Never throws; a partial listing carries `error`.
 */
export async function listOwnFiles(
  dir: string,
  opts: { floorBytes: number; sudo?: string | null; timeoutMs?: number; spawn?: CensusSpawn },
): Promise<OwnFilesListing> {
  const [cmd, args] = censusCommand('find', censusOwnFilesArgs(dir), {
    ionice: await resolveBin('ionice'),
    nice: await resolveBin('nice'),
    sudo: opts.sudo ?? null,
  });
  const timeoutMs = opts.timeoutMs ?? CENSUS_OWN_FILES_TIMEOUT_MS;
  return new Promise<OwnFilesListing>((resolve) => {
    const files: OwnFilesListing['files'] = [];
    let pending = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const take = (record: string): void => {
      const file = parseOwnFilesRecord(record);
      if (file && file.bytes >= opts.floorBytes) files.push(file);
    };
    const settle = (error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(error ? { files, error } : { files });
    };
    let child: ReturnType<CensusSpawn>;
    try {
      child = (opts.spawn ?? defaultCensusSpawn)(cmd, args);
    } catch (err) {
      settle(`find failed: ${(err as Error)?.message ?? String(err)}`);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const parts = pending.split('\0');
      pending = parts.pop() ?? '';
      for (const record of parts) take(record);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    child.on('error', (err: Error) => settle(`find failed: ${err.message}`));
    child.on('close', (code: number | null) => {
      if (pending) take(pending);
      const firstErr = stderr.split('\n').find((l) => l.trim())?.trim();
      if (timedOut) settle(`find timed out after ${Math.round(timeoutMs / 1000)} s`);
      else if (code !== 0) settle(`find exited ${code}${firstErr ? `: ${firstErr}` : ''}`);
      else settle();
    });
  });
}

/** A store sized through its own API because the operator user cannot read its files. */
export interface ApiSizedStore {
  kind: Extract<CensusConsumerKind, 'postgres' | 'docker'>;
  /** Filesystem root of the store (decides which device it lives on). */
  rootDir: string;
  parts: Array<{ consumer: string; bytes: number }>;
}

/** Postgres cluster size: every connectable database plus WAL. Null when unmeasurable. */
export async function measurePostgres(sql: CensusSql): Promise<ApiSizedStore | null> {
  let rootDir: string | null = null;
  try {
    const rows = await sql<{ setting: string }>`SELECT setting FROM pg_settings WHERE name = 'data_directory'`;
    rootDir = rows[0]?.setting ?? null;
  } catch {
    rootDir = null;
  }
  if (!rootDir) return null; // without the data directory the device cannot be known
  const dbRows = await sql<{ bytes: string | number | null }>`
    SELECT coalesce(sum(pg_database_size(datname)), 0)::bigint AS bytes
      FROM pg_database
     WHERE datallowconn AND has_database_privilege(datname, 'CONNECT')`;
  const parts = [{ consumer: `postgres:${rootDir} databases`, bytes: Number(dbRows[0]?.bytes ?? 0) }];
  try {
    const wal = await sql<{ bytes: string | number | null }>`SELECT coalesce(sum(size), 0)::bigint AS bytes FROM pg_ls_waldir()`;
    parts.push({ consumer: `postgres:${rootDir} wal`, bytes: Number(wal[0]?.bytes ?? 0) });
  } catch {
    // pg_ls_waldir needs pg_monitor; the database sizes alone still attribute most of the cluster.
  }
  return { kind: 'postgres', rootDir, parts };
}

function dockerSocketPath(): string {
  const host = process.env.DOCKER_HOST ?? '';
  return host.startsWith('unix://') ? host.slice('unix://'.length) : '/var/run/docker.sock';
}

function dockerGet(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`docker ${path} HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`docker ${path} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

const sumOf = <T>(items: readonly T[] | null | undefined, f: (t: T) => number): number =>
  (items ?? []).reduce((a, t) => a + Math.max(0, Number(f(t)) || 0), 0);

/** Docker disk use from the Engine API (/system/df takes ~20s here). Null when docker is absent. */
export async function measureDocker(timeoutMs = 180_000): Promise<ApiSizedStore | null> {
  const socketPath = dockerSocketPath();
  try {
    await fsp.access(socketPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return null;
  }
  const info = (await dockerGet(socketPath, '/info', 10_000)) as { DockerRootDir?: string };
  const df = (await dockerGet(socketPath, '/system/df', timeoutMs)) as {
    LayersSize?: number;
    Containers?: Array<{ SizeRw?: number }>;
    Volumes?: Array<{ UsageData?: { Size?: number } }>;
    BuildCache?: Array<{ Size?: number }>;
  };
  return {
    kind: 'docker',
    rootDir: info.DockerRootDir ?? '/var/lib/docker',
    parts: [
      { consumer: 'docker:images', bytes: Math.max(0, Number(df.LayersSize) || 0) },
      { consumer: 'docker:containers', bytes: sumOf(df.Containers, (c) => c.SizeRw ?? 0) },
      { consumer: 'docker:volumes', bytes: sumOf(df.Volumes, (v) => v.UsageData?.Size ?? 0) },
      { consumer: 'docker:build-cache', bytes: sumOf(df.BuildCache, (b) => b.Size ?? 0) },
    ],
  };
}

/** Device of the nearest ancestor of `path` we may stat. */
async function deviceOf(path: string): Promise<string | null> {
  let cur = path;
  for (;;) {
    try {
      return devToMajorMinor((await fsp.stat(cur)).dev);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

async function readableByDu(dir: string): Promise<boolean> {
  try {
    await fsp.access(dir, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * API-sized rows that belong on `device`: only stores du could not read (no double count).
 * A privileged walk read every store root itself, so it takes none.
 */
export async function apiStoreConsumers(
  device: CensusDevice,
  stores: ReadonlyArray<ApiSizedStore | null>,
  duPrivileged = false,
): Promise<CensusConsumer[]> {
  if (duPrivileged) return [];
  const out: CensusConsumer[] = [];
  for (const store of stores) {
    if (!store) continue;
    if ((await deviceOf(store.rootDir)) !== device.majorMinor) continue;
    if (await readableByDu(store.rootDir)) continue;
    for (const p of store.parts) if (p.bytes > 0) out.push({ consumer: p.consumer, kind: store.kind, depth: 0, bytes: p.bytes });
  }
  return out;
}

export function unattributedKey(device: string): string {
  return `${device} (unattributed)`;
}

export interface CensusRunResult {
  runId: string;
  device: string;
  complete: boolean;
  consumers: number;
  usedBytes: number;
  attributedBytes: number;
  unattributedBytes: number;
  durationMs: number;
}

export interface CensusDeps {
  sql?: CensusSql;
  host?: string;
  devices?: CensusDevice[];
  runDu?: typeof runDuTree;
  measurePostgres?: (sql: CensusSql) => Promise<ApiSizedStore | null>;
  measureDocker?: () => Promise<ApiSizedStore | null>;
  /** sudo binary for a privileged walk, or null for unprivileged; probed once per pass. */
  resolveSudo?: () => Promise<string | null>;
  /** statfs sampler used around each walk; null keeps the resolved device numbers (synthetic devices in tests). */
  statDevice?: ((mountRoot: string) => Promise<CensusDeviceUsage>) | null;
  /** Lists a max-depth directory's own files; defaults to the single-find-subprocess lister. */
  listOwnFiles?: typeof listOwnFiles;
  floorBytes?: number;
  maxDepth?: number;
  now?: () => Date;
}

async function defaultSql(): Promise<CensusSql> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return getOrgPg().sql as unknown as CensusSql;
}

/** Build one device's consumer list from a du run plus the API-sized stores. */
export async function buildDeviceConsumers(
  device: CensusDevice,
  du: DuRun,
  stores: ReadonlyArray<ApiSizedStore | null>,
  floorBytes: number,
  opts: { sudo?: string | null; listOwnFiles?: typeof listOwnFiles } = {},
): Promise<{ consumers: CensusConsumer[]; attributedBytes: number; unattributedBytes: number; ownFilesNotes: string[] }> {
  const consumers: CensusConsumer[] = [...du.summary.consumers];
  const ownFilesNotes: string[] = [];
  const list = opts.listOwnFiles ?? listOwnFiles;
  for (const own of du.summary.ownFiles) {
    // Listed with the walk's privilege: a root-owned directory the walk measured must not list as empty.
    const listing = await list(own.dir, { floorBytes, sudo: opts.sudo ?? null });
    if (listing.error) ownFilesNotes.push(`own files of ${own.dir} may be incomplete (${listing.error})`);
    consumers.push(...attributeOwnFiles(own, listing.files, floorBytes));
  }
  const api = await apiStoreConsumers(device, stores, du.privileged === true);
  consumers.push(...api);
  // A killed walk never printed the mount total; the depth-1 directories it did finish are a lower bound.
  const duBytes =
    du.summary.rootBytes ??
    du.summary.consumers.filter((c) => censusDepth(device.device, c.consumer) === 1).reduce((a, c) => a + c.bytes, 0);
  const attributedBytes = duBytes + api.reduce((a, c) => a + c.bytes, 0);
  const unattributedBytes = Math.max(0, device.usedBytes - attributedBytes);
  if (unattributedBytes > 0) {
    consumers.push({ consumer: unattributedKey(device.device), kind: 'unattributed', depth: 0, bytes: unattributedBytes });
  }
  return { consumers, attributedBytes, unattributedBytes, ownFilesNotes };
}

/** The run note's phase timings, so a slow phase is visible on the row itself. */
export function censusPhaseNote(walkMs: number, attributionMs: number, ownFilesDirs: number): string {
  const s = (ms: number) => (ms / 1000).toFixed(1);
  return `phases: walk ${s(walkMs)} s, attribution ${s(attributionMs)} s (${ownFilesDirs} own-files dir(s))`;
}

/**
 * What one census pass resolves once before walking its devices. Plain JSON, so the
 * durable workflow records it as a step result and replays the SAME device list after a
 * restart instead of re-resolving it.
 */
export interface CensusPass {
  host: string;
  devices: CensusDevice[];
  stores: Array<ApiSizedStore | null>;
  /** sudo binary for a privileged walk, or null for unprivileged. */
  sudo: string | null;
}

export type CensusDeviceOutcome =
  | { run: CensusRunResult; failure?: undefined }
  | { run?: undefined; failure: { device: string; error: string } };

/** Resolve one pass: the devices, the API-sized stores, and the walk's privilege (probed once). */
export async function prepareCensusPass(deps: CensusDeps = {}): Promise<{ skipped: string } | CensusPass> {
  if (process.platform !== 'linux' && !deps.runDu) return { skipped: `unsupported platform ${process.platform}` };
  const sql = deps.sql ?? (await defaultSql());
  const devices = deps.devices ?? (await resolveCensusDevices());
  const stores = await Promise.all([
    (deps.measurePostgres ?? measurePostgres)(sql).catch(() => null),
    (deps.measureDocker ?? measureDocker)().catch(() => null),
  ]);
  const sudo = await (deps.resolveSudo ?? resolveCensusSudo)().catch(() => null);
  return { host: deps.host ?? hostname(), devices, stores, sudo };
}

/** One census pass over every watched device, then the 30-day prune. Never throws per device. */
export async function runDiskConsumerCensusOnce(
  deps: CensusDeps = {},
): Promise<{ skipped?: string; runs: CensusRunResult[]; failures: Array<{ device: string; error: string }>; pruned: number }> {
  const pass = await prepareCensusPass(deps);
  if ('skipped' in pass) return { skipped: pass.skipped, runs: [], failures: [], pruned: 0 };
  const runs: CensusRunResult[] = [];
  const failures: Array<{ device: string; error: string }> = [];
  for (const resolved of pass.devices) {
    const outcome = await censusOneDevice(pass, resolved, deps);
    if (outcome.run) runs.push(outcome.run);
    else failures.push(outcome.failure);
  }
  const pruned = await pruneCensusPass(deps);
  return { runs, failures, pruned };
}

/** The pass's closing 30-day prune of run rows; returns the runs removed. */
export async function pruneCensusPass(deps: CensusDeps = {}): Promise<number> {
  const sql = deps.sql ?? (await defaultSql());
  return pruneDiskCensus(sql, (deps.now ?? (() => new Date()))());
}

/**
 * Walk one device, attribute it, and write its run row in one transaction. Never throws:
 * a failure is returned. The durable census runs this as one step per device, so a
 * recovered workflow skips every device whose row is already written.
 */
export async function censusOneDevice(
  pass: CensusPass,
  resolved: CensusDevice,
  deps: CensusDeps = {},
): Promise<CensusDeviceOutcome> {
  const { host, stores, sudo } = pass;
  const now = deps.now ?? (() => new Date());
  const floorBytes = deps.floorBytes ?? CENSUS_FLOOR_BYTES;
  const maxDepth = deps.maxDepth ?? CENSUS_MAX_DEPTH;
  const statDevice = deps.statDevice === null ? null : (deps.statDevice ?? statCensusDevice);
  const startedAt = now();
  try {
    const sql = deps.sql ?? (await defaultSql());
    // Devices are resolved once per pass but walked one after another (a `/` walk takes
    // ~40 min), so the resolved used bytes are stale by the time a later device is walked.
    // Re-sample statfs around this walk and reconcile against the midpoint.
    const before = statDevice ? await statDevice(resolved.device).catch(() => null) : null;
    const walkStarted = Date.now();
    const du = await (deps.runDu ?? runDuTree)(resolved.device, { floorBytes, maxDepth, sudo });
    const walkMs = Date.now() - walkStarted;
    const after = statDevice ? await statDevice(resolved.device).catch(() => null) : null;
    const { device, note: usageNote } = reconcileWalkUsage(resolved, before, after);
    const attributionStarted = Date.now();
    const { consumers, attributedBytes, unattributedBytes, ownFilesNotes } = await buildDeviceConsumers(
      device,
      du,
      stores,
      floorBytes,
      { sudo, ...(deps.listOwnFiles ? { listOwnFiles: deps.listOwnFiles } : {}) },
    );
    const attributionMs = Date.now() - attributionStarted;
    const finishedAt = now();
    // A root summary can exist even when du emitted only partial output before failing.
    // Only a confirmed successful child exit can certify the walk as complete.
    const complete =
      du.exitCode === 0 &&
      !du.timedOut &&
      !du.error &&
      du.summary.rootBytes !== null &&
      du.deniedCount === 0 &&
      ownFilesNotes.length === 0;
    const stderrNote = du.exitCode !== 0 && du.stderrSample?.length
      ? 'du stderr: ' + du.stderrSample.join(' | ').slice(0, 1200)
      : null;
    const notes = [
      du.privileged ? 'du walked as root (sudo -n)' : 'du walked unprivileged (sudo -n unavailable)',
      censusPhaseNote(walkMs, attributionMs, du.summary.ownFiles.length),
      du.walkNote ?? null,
      ...ownFilesNotes,
      usageNote,
      stderrNote,
      du.timedOut ? 'du timed out; sizes are lower bounds' : null,
      !du.timedOut && du.exitCode !== 0
        ? `du exited ${du.exitCode === null ? 'without an exit status' : `with status ${du.exitCode}`}; sizes are lower bounds`
        : null,
      du.error ? `du failed: ${du.error}` : null,
      du.summary.rootBytes === null ? 'du returned no root record; sizes are lower bounds' : null,
      du.deniedCount > 0 ? `${du.deniedCount} unreadable path(s), e.g. ${du.deniedSample.slice(0, 5).join(', ')}` : null,
      // Shared extents (XFS/btrfs reflink clones) are counted once per FILE by du but
      // once on disk, so consumer sizes can sum past the device's used bytes.
      attributedBytes > device.usedBytes
        ? `attributed exceeds used by ${((attributedBytes - device.usedBytes) / 1024 ** 3).toFixed(1)} GiB: shared (reflinked) extents are counted per file`
        : null,
    ].filter(Boolean);
    const runId = randomUUID();
    await writeCensusRun(sql, {
      runId,
      host,
      device,
      startedAt,
      finishedAt,
      attributedBytes,
      complete,
      note: notes.length ? notes.join('; ') : null,
      consumers,
    });
    return {
      run: {
        runId,
        device: device.device,
        complete,
        consumers: consumers.length,
        usedBytes: device.usedBytes,
        attributedBytes,
        unattributedBytes,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    };
  } catch (err) {
    return { failure: { device: resolved.device, error: (err as Error)?.message ?? String(err) } };
  }
}

export async function writeCensusRun(
  sql: CensusSql,
  run: {
    runId: string;
    host: string;
    device: CensusDevice;
    startedAt: Date;
    finishedAt: Date;
    attributedBytes: number;
    complete: boolean;
    note: string | null;
    consumers: readonly CensusConsumer[];
    /** Loaded producer identity; null preserves explicitly identity-less/legacy fixtures. */
    producerBuildSha?: string | null;
  },
): Promise<void> {
  // One row per consumer key: du never repeats a path, but keep the PK safe regardless.
  const unique = [...new Map(run.consumers.map((c) => [c.consumer, c])).values()];
  // Extend the existing run metadata instead of introducing a parallel ledger or
  // attributing historical rows to whatever build happens to grade them later.
  const build = run.producerBuildSha === undefined ? getBuildInfo().sha : run.producerBuildSha;
  const note = build ? `census-producer:${encodeURIComponent(build)}; ${run.note ?? ''}` : run.note;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.disk_census_runs
        (run_id, host, device, started_at, finished_at, size_bytes, used_bytes, avail_bytes, attributed_bytes, complete, note)
      VALUES (${run.runId}, ${run.host}, ${run.device.device}, ${run.startedAt}, ${run.finishedAt},
              ${run.device.sizeBytes}, ${run.device.usedBytes}, ${run.device.availBytes},
              ${run.attributedBytes}, ${run.complete}, ${note})`;
    for (let i = 0; i < unique.length; i += 500) {
      const batch = unique.slice(i, i + 500);
      await tx`
        INSERT INTO harness_shared.disk_census_consumers (run_id, consumer, kind, depth, bytes)
        SELECT ${run.runId}::uuid, c.consumer, c.kind, c.depth, c.bytes
          FROM unnest(${batch.map((c) => c.consumer)}::text[], ${batch.map((c) => c.kind)}::text[],
                      ${batch.map((c) => c.depth)}::smallint[], ${batch.map((c) => c.bytes)}::bigint[])
            AS c(consumer, kind, depth, bytes)`;
    }
  });
}

export async function pruneDiskCensus(sql: CensusSql, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CENSUS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await sql<{ n: string | number }>`
    WITH gone AS (DELETE FROM harness_shared.disk_census_runs WHERE finished_at < ${cutoff} RETURNING 1)
    SELECT count(*)::int AS n FROM gone`;
  return Number(rows[0]?.n ?? 0);
}

export type CensusCoverageIssue =
  | 'walk-timeout' | 'walk-error' | 'root-record-missing' | 'unreadable-paths'
  | 'own-files-incomplete' | 'incomplete-run' | 'unattributed-bytes';

export type CensusBaselineStatus =
  | 'comparable' | 'latest-incomplete' | 'unavailable' | 'incomplete-candidates' | 'visibility-mismatch';

export interface CensusDeviceView {
  device: string;
  /** Saved identities, retained for native alarm evidence (never inferred from time). */
  host?: string;
  runId?: string;
  baselineRunId?: string | null;
  producerBuildSha?: string | null;
  baselineProducerBuildSha?: string | null;
  /** No census run has ever been written for this watched device on this host. */
  missing?: true;
  sampledAt?: string;
  /** Latest run older than 24h. */
  stale?: boolean;
  complete?: boolean;
  /** Recorded scan failures and byte-coverage gaps; never an inferred physical cause. */
  coverageIssues?: CensusCoverageIssue[];
  note?: string | null;
  sizeBytes?: number;
  usedBytes?: number;
  availBytes?: number;
  attributedBytes?: number;
  unattributedBytes?: number;
  /** unattributed ≥ 10 GiB: a consumer that large could be missing from the list. */
  coverageGap?: boolean;
  /** The run the 24h growth is measured against (18–30h before the latest); null when none. */
  baselineAt?: string | null;
  /** Why a qualified 18–30h baseline is available or growth remains unknown. */
  baselineStatus?: CensusBaselineStatus;
  /** Same visible filesystem, from the comparable baseline run (not a sum of directories). */
  baselineAvailBytes?: number | null;
  baselineSizeBytes?: number | null;
  consumers?: CensusGrowthRow[];
  consumersTotal?: number;
  truncatedByLimit?: boolean;
}

interface RunRow {
  run_id: string;
  device: string;
  finished_at: Date;
  size_bytes: string | number;
  used_bytes: string | number;
  avail_bytes: string | number;
  attributed_bytes: string | number;
  complete: boolean;
  note: string | null;
}

async function consumersOf(sql: CensusSql, runId: string): Promise<CensusConsumer[]> {
  const rows = await sql<{ consumer: string; kind: CensusConsumerKind; depth: number; bytes: string | number }>`
    SELECT consumer, kind, depth, bytes FROM harness_shared.disk_census_consumers WHERE run_id = ${runId}`;
  return rows.map((r) => ({ consumer: r.consumer, kind: r.kind, depth: Number(r.depth), bytes: Number(r.bytes) }));
}

/** Decode only failures explicitly recorded by the existing producer. */
function censusScanIssues(note: string | null): CensusCoverageIssue[] {
  if (!note) return [];
  const issues: CensusCoverageIssue[] = [];
  if (/du timed out/i.test(note)) issues.push('walk-timeout');
  if (/du failed:/i.test(note)) issues.push('walk-error');
  if (/du returned no root record/i.test(note)) issues.push('root-record-missing');
  if (/unreadable path\(s\)/i.test(note)) issues.push('unreadable-paths');
  if (/own files .* may be incomplete/i.test(note)) issues.push('own-files-incomplete');
  return issues;
}
function censusVisibility(note: string | null): 'root' | 'unprivileged' | 'legacy' {
  if (note?.includes('du walked as root')) return 'root';
  if (note?.includes('du walked unprivileged')) return 'unprivileged';
  return 'legacy';
}

function censusProducerBuild(note: string | null): string | null {
  const encoded = note?.match(/^census-producer:([^;]+); /)?.[1];
  try { return encoded ? decodeURIComponent(encoded) : null; } catch { return null; }
}

/** The census read: per device, each consumer's size and its growth over the last ~24h. */
export async function readDiskConsumerCensus(
  sql: CensusSql,
  opts: {
    host?: string;
    device?: string;
    orderBy?: 'bytes' | 'growth';
    limit?: number;
    /** Watched devices expected to have rows; one with none is reported `missing`. */
    expectedDevices?: readonly string[];
    /** Historical selection ceiling, separate from the staleness clock. */
    asOf?: Date;
    now?: Date;
  } = {},
): Promise<{ host: string; devices: CensusDeviceView[] }> {
  const host = opts.host ?? hostname();
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 500));
  const latest = await sql<RunRow>`
    SELECT DISTINCT ON (device) run_id, device, finished_at, size_bytes, used_bytes, avail_bytes, attributed_bytes, complete, note
      FROM harness_shared.disk_census_runs
     WHERE host = ${host} ${opts.device ? sql`AND device = ${opts.device}` : sql``}
       ${opts.asOf ? sql`AND finished_at <= ${opts.asOf}` : sql``}
     ORDER BY device, finished_at DESC, run_id`;
  const devices: CensusDeviceView[] = [];
  for (const run of latest) {
    const finishedAt = new Date(run.finished_at);
    const target = new Date(finishedAt.getTime() - 24 * 3600_000);
    const candidates = await sql<{ run_id: string; finished_at: Date; note: string | null; avail_bytes: string | number; size_bytes: string | number }>`
      SELECT run_id, finished_at, note, avail_bytes, size_bytes FROM harness_shared.disk_census_runs
       WHERE host = ${host} AND device = ${run.device} AND complete
         AND finished_at BETWEEN ${new Date(finishedAt.getTime() - 30 * 3600_000)} AND ${new Date(finishedAt.getTime() - 18 * 3600_000)}
       ORDER BY abs(extract(epoch FROM (finished_at - ${target}::timestamptz))), run_id
       LIMIT 100`;
    // Changed visibility is not changed consumption. Prefer a comparable clean
    // baseline; otherwise growth stays unknown instead of inventing a spike.
    const coverageIssues = censusScanIssues(run.note);
    const complete = run.complete && coverageIssues.length === 0;
    if (!run.complete && coverageIssues.length === 0) coverageIssues.push('incomplete-run');
    const readableCandidates = candidates.filter((candidate) => censusScanIssues(candidate.note).length === 0);
    const base = complete
      ? readableCandidates.find((candidate) => censusVisibility(candidate.note) === censusVisibility(run.note))
      : undefined;
    const baselineStatus: CensusBaselineStatus = !complete ? 'latest-incomplete'
      : base ? 'comparable'
      : candidates.length === 0 ? 'unavailable'
      : readableCandidates.length === 0 ? 'incomplete-candidates'
      : 'visibility-mismatch';
    const rows = joinCensusGrowth(await consumersOf(sql, run.run_id), base ? await consumersOf(sql, base.run_id) : null);
    const sorted = sortCensusRows(rows, opts.orderBy);
    const used = Number(run.used_bytes);
    const attributed = Number(run.attributed_bytes);
    const unattributed = Math.max(0, used - attributed);
    if (unattributed >= CENSUS_COVERAGE_GAP_BYTES) coverageIssues.push('unattributed-bytes');
    devices.push({
      device: run.device,
      host,
      runId: run.run_id,
      baselineRunId: base?.run_id ?? null,
      producerBuildSha: censusProducerBuild(run.note),
      baselineProducerBuildSha: censusProducerBuild(base?.note ?? null),
      sampledAt: finishedAt.toISOString(),
      stale: now.getTime() - finishedAt.getTime() > CENSUS_STALE_MS,
      complete,
      coverageIssues,
      note: run.note,
      sizeBytes: Number(run.size_bytes),
      usedBytes: used,
      availBytes: Number(run.avail_bytes),
      attributedBytes: attributed,
      unattributedBytes: unattributed,
      coverageGap: unattributed >= CENSUS_COVERAGE_GAP_BYTES,
      baselineAt: base ? new Date(base.finished_at).toISOString() : null,
      baselineStatus,
      baselineAvailBytes: base ? Number(base.avail_bytes) : null,
      baselineSizeBytes: base ? Number(base.size_bytes) : null,
      consumers: sorted.slice(0, limit),
      consumersTotal: sorted.length,
      truncatedByLimit: sorted.length > limit,
    });
  }
  for (const expected of opts.expectedDevices ?? []) {
    if (opts.device && expected !== opts.device) continue;
    if (!devices.some((d) => d.device === expected)) devices.push({ device: expected, missing: true });
  }
  return { host, devices };
}
