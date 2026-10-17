/**
 * native-bg-task-ledger — read the launch ledger written by the PreToolUse bash
 * gate and answer ONE question: does this session have native background Bash
 * jobs that are STILL RUNNING right now? (WI-5936 / EI-16611.)
 *
 * WHY THIS EXISTS. Native `run_in_background` bookkeeping lives in the CLI child
 * process's own memory — nowhere papercusp persists. A carry-respawn
 * (session:request-compaction), a cold-loop fire, or `claude --resume` starts a
 * NEW process and SIGTERMs the job: the LOGICAL session continues while the job
 * is silently dead, and a carry-note saying "read task <id>'s output" is a dead
 * reference to the successor. That knowledge was already written down (the
 * compaction strategy, an insights doc) and it recurred anyway, because the
 * knowledge sits on the READ path while the mistake is made on the WRITE path.
 * The bash gate now warns at LAUNCH; this module is the other half — the
 * backstop at the moment of the cut, where the loss actually happens.
 *
 * WHAT MAKES THE LIVENESS CLAIM REAL, not a guess. The ledger records the output
 * FILE each background command redirects to, and a job that is still running
 * still holds that file OPEN for writing. So liveness is decided by scanning
 * /proc for a process holding an open fd on that path — an OS-level fact — not
 * by the record's age or by assuming a launch is still alive. This is the same
 * check the gate's own log-read-race advisory uses, and it is why this module
 * can honestly say "live" instead of merely "launched at some point".
 *
 * WHAT IT DELIBERATELY CANNOT SEE. Only backgrounded commands that REDIRECT to a
 * file are tracked (`>`, `>>`, `| tee`) — a bg command whose output goes nowhere
 * has no fd to watch, so it is invisible here. That is a deliberate floor, not a
 * total: an empty result means "no tracked live job", never "you have no live
 * jobs". Callers must not render it as an all-clear. It also cannot attribute a
 * job whose launch predates the `sid` stamp (see `unattributed`), which is
 * reported separately rather than silently dropped or silently blamed on the
 * caller.
 */
import { readFile, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Matches the gate's `_BG_TRACK_FILE`. Both sides resolve `~` for the same user. */
export function defaultLedgerPath(): string {
  return join(homedir(), '.papercusp', 'tracking', 'bg-output-tracking.json');
}

/** The gate prunes at 2h regardless of liveness; mirror it so the two agree. */
export const NATIVE_BG_TRACK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface NativeBgTaskRecord {
  /** Absolute path the background command redirects its output to. */
  path: string;
  startedAtMs: number;
  /** Owning session (PAPERCUSP_SID / ownerId). Absent on pre-WI-5936 records. */
  sid?: string;
}

export interface LiveNativeBgTask extends NativeBgTaskRecord {
  ageSec: number;
  /** Pids holding the output file open — the evidence for the liveness claim. */
  pids: string[];
}

export interface NativeBgTaskReport {
  /** Tracked jobs owned by this session that a process is STILL writing to. */
  live: LiveNativeBgTask[];
  /**
   * Live tracked jobs carrying NO `sid` (written before the stamp existed, or by
   * a client that does not set one). They may or may not belong to the caller,
   * so they are neither claimed nor dropped — surface them as unattributed.
   */
  unattributed: LiveNativeBgTask[];
  /**
   * True when the ledger could not be READ (unparseable), or when the /proc
   * liveness scan ran out of its deadline before visiting every process. An
   * empty or short report then means "not fully measured", which is NOT the
   * same fact as "nothing live" — never render the two the same way.
   */
  degraded: boolean;
}

/** Tolerant parse: one bad record must not discard the rest of the ledger. */
export function parseNativeBgLedger(raw: string): NativeBgTaskRecord[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: NativeBgTaskRecord[] = [];
  for (const [path, value] of Object.entries(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const rec = value as Record<string, unknown>;
    // Written by python `time.time()` — SECONDS, not ms. Reading it as ms would
    // date every record to 1970 and make every age check silently pass.
    const startedAtSec = typeof rec.started_at === 'number' ? rec.started_at : NaN;
    if (!Number.isFinite(startedAtSec)) continue;
    out.push({
      path,
      startedAtMs: startedAtSec * 1000,
      ...(typeof rec.sid === 'string' && rec.sid ? { sid: rec.sid } : {}),
    });
  }
  return out;
}

/**
 * The records whose liveness this caller needs to know: younger than the
 * gate's prune age, and either this session's or carrying no owner stamp.
 * Records belonging to a DIFFERENT session are none of this caller's
 * business — its cut cannot kill them. Shared by the selector and by the
 * /proc scan, so the scan only ever looks for paths the selector will ask about.
 */
export function candidateNativeBgRecords(input: {
  records: NativeBgTaskRecord[];
  sid: string;
  nowMs: number;
}): NativeBgTaskRecord[] {
  return input.records.filter(
    (rec) =>
      input.nowMs - rec.startedAtMs < NATIVE_BG_TRACK_MAX_AGE_MS &&
      (!rec.sid || rec.sid === input.sid),
  );
}

/**
 * Pure core: split tracked records into this session's live jobs and live jobs
 * with no owner stamp. `hasOpenWriter` is injected so the OS scan can be
 * substituted in tests — the liveness rule is what needs proving, not /proc.
 * It stays SYNCHRONOUS on purpose: the async /proc walk happens once, up front,
 * in `readLiveNativeBgTasks`, and this selector only looks its answers up.
 */
export function selectLiveNativeBgTasks(input: {
  records: NativeBgTaskRecord[];
  sid: string;
  nowMs: number;
  hasOpenWriter: (path: string) => string[];
}): { live: LiveNativeBgTask[]; unattributed: LiveNativeBgTask[] } {
  const live: LiveNativeBgTask[] = [];
  const unattributed: LiveNativeBgTask[] = [];
  for (const rec of candidateNativeBgRecords(input)) {
    const pids = input.hasOpenWriter(rec.path);
    if (pids.length === 0) continue; // finished or already killed — nothing to lose
    const task: LiveNativeBgTask = {
      ...rec,
      ageSec: Math.max(0, Math.round((input.nowMs - rec.startedAtMs) / 1000)),
      pids,
    };
    (rec.sid ? live : unattributed).push(task);
  }
  const byAge = (a: LiveNativeBgTask, b: LiveNativeBgTask) => b.ageSec - a.ageSec;
  return { live: live.sort(byAge), unattributed: unattributed.sort(byAge) };
}

/** Wall-clock budget for one /proc liveness scan before it reports `degraded`. */
export const NATIVE_BG_SCAN_DEADLINE_MS = 5_000;

export interface OpenWriterScan {
  /** Path -> pids holding it open (numerically sorted). Absent = no holder seen. */
  byPath: Map<string, string[]>;
  /** False on deadline exhaustion or (in failClosed mode) unreadable evidence. */
  complete: boolean;
  /** Bounded evidence for an incomplete scan; never turns partial evidence into an all-clear. */
  diagnostics?: {
    reason?: string; elapsedMs?: number; processesTotal?: number; processesScanned?: number;
    descriptorsScanned?: number; deadlineExceeded?: boolean; readFailures?: number;
    failureSamples?: Array<{ operation: string; path: string; code: string }>;
    taskId?: string | null; exitCode?: number | null; signal?: string | null;
    stderr?: string; outputTruncated?: boolean;
  };
}

/**
 * Pids holding each of `paths` open. Mirrors the gate's `_bg_open_writer_pids`:
 * walk /proc/<pid>/fd and compare each symlink target.
 *
 * ONE pass serves every path, and every read is async (WI-10005283). The old
 * per-path synchronous walk cost ~600ms on this host (≈8.8k pids, ≈65k fds) and
 * ran once per ledger record on the operator main thread inside
 * session:request-compaction, which is a multi-second event-loop stall. Never
 * reintroduce a sync walk here: /proc is unbounded in size.
 *
 * Every layer fails soft — a process that exits mid-walk (or one this user
 * cannot read) is skipped, never thrown, so a partial scan degrades toward "not
 * live" rather than an error. A missing proc root (non-Linux) is an empty,
 * complete answer: there is no such mechanism to measure there.
 */
export async function openWriterPidsMany(
  paths: readonly string[],
  opts: {
    procRoot?: string; concurrency?: number; deadlineMs?: number;
    /** Match descendants of each path, for directory retention. */
    descendants?: boolean;
    /** A process using a tree as its working directory also owns it. */
    includeCwd?: boolean;
    /** Release worktrees also remain owned through a process root or executable. */
    includeProcessLinks?: boolean;
    /** Destructive callers must refuse missing/unreadable process evidence. */
    failClosed?: boolean;
    /** Isolated native workers may use direct proc reads; host callers stay async. */
    procIo?: {
      readdir: (path: string) => string[] | Promise<string[]>;
      readlink: (path: string) => string | Promise<string>;
    };
  } = {},
): Promise<OpenWriterScan> {
  const started = Date.now();
  const byPath = new Map<string, string[]>();
  const wanted = new Set(paths);
  if (wanted.size === 0) return { byPath, complete: true };
  const procRoot = opts.procRoot ?? '/proc';
  const readProcDirectory = opts.procIo?.readdir ?? readdir;
  const readProcLink = opts.procIo?.readlink ?? readlink;
  let entries: string[];
  try {
    const pending = readProcDirectory(procRoot);
    entries = Array.isArray(pending) ? pending : await pending;
  } catch (err) {
    return { byPath, complete: !opts.failClosed, ...(opts.failClosed ? { diagnostics: {
      reason: 'proc root unreadable', elapsedMs: Date.now() - started, readFailures: 1,
      failureSamples: [{ operation: 'proc-root', path: procRoot, code: (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' }],
    } } : {}) };
  }
  const pids = entries.filter((e) => /^\d+$/.test(e));
  const deadline = opts.deadlineMs === undefined ? Infinity : Date.now() + opts.deadlineMs;
  let complete = true;
  let next = 0;
  let processesScanned = 0, descriptorsScanned = 0, readFailures = 0, deadlineExceeded = false;
  const failureSamples: NonNullable<OpenWriterScan['diagnostics']>['failureSamples'] = [];
  const expired = (): boolean => {
    if (Date.now() <= deadline) return false;
    complete = false; deadlineExceeded = true; return true;
  };
  const readFailed = (err: unknown, operation: string, path: string): void => {
    // ENOENT is an exited process/closed fd (or a kernel thread without cwd).
    // Permission and IO failures do not prove absence of a holder.
    if (opts.failClosed && (err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      complete = false; readFailures++;
      if (failureSamples.length < 8) failureSamples.push({ operation, path, code: (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN' });
    }
  };
  const worker = async (): Promise<void> => {
    while (next < pids.length) {
      if (expired()) return;
      const pid = pids[next++];
      const pidDir = join(procRoot, pid);
      const fdDir = `${pidDir}/fd`;
      const seen = new Set<string>();
      const record = (rawTarget: string): void => {
        const target = rawTarget.replace(/ \(deleted\)$/, '');
        const recordPath = (path: string): void => {
          if (seen.has(path)) return;
          seen.add(path);
          const holders = byPath.get(path);
          if (holders) holders.push(pid);
          else byPath.set(path, [pid]);
        };
        if (wanted.has(target)) recordPath(target);
        if (opts.descendants) {
          // A descriptor can only belong to its own ancestors. Walking those
          // components makes the work depend on target depth rather than the
          // number of retention candidates times every descriptor on the host.
          for (let end = target.lastIndexOf('/'); end > 0; end = target.lastIndexOf('/', end - 1)) {
            const parent = target.slice(0, end);
            if (wanted.has(parent)) recordPath(parent);
          }
        }
      };
      for (const link of opts.includeProcessLinks ? ['cwd', 'root', 'exe'] : opts.includeCwd ? ['cwd'] : []) {
        const linkPath = `${pidDir}/${link}`;
        try {
          const pending = readProcLink(linkPath);
          record(typeof pending === 'string' ? pending : await pending);
        } catch (err) { readFailed(err, link, linkPath); }
      }
      let fds: string[];
      try {
        const pending = readProcDirectory(fdDir);
        fds = Array.isArray(pending) ? pending : await pending;
      } catch (err) {
        readFailed(err, 'fd-directory', fdDir);
        processesScanned++;
        continue;
      }
      for (const fd of fds) {
        if (expired()) return;
        descriptorsScanned++;
        let target: string;
        const fdPath = `${fdDir}/${fd}`;
        try {
          // Direct reads run only in the isolated native worker. Avoid one
          // promise continuation and path normalization per descriptor there;
          // both backends still share matching, deadlines and failure handling.
          const pending = readProcLink(fdPath);
          target = typeof pending === 'string' ? pending : await pending;
        } catch (err) {
          readFailed(err, 'fd', fdPath);
          continue; // fd closed under us — skip
        }
        record(target);
      }
      processesScanned++;
    }
  };
  const width = Math.min(Math.max(1, opts.concurrency ?? 32), pids.length);
  await Promise.all(Array.from({ length: width }, worker));
  for (const holders of byPath.values()) holders.sort((a, b) => Number(a) - Number(b));
  return { byPath, complete, ...(!complete || opts.includeProcessLinks ? { diagnostics: {
    elapsedMs: Date.now() - started, processesTotal: pids.length, processesScanned, descriptorsScanned,
    deadlineExceeded, readFailures, failureSamples,
  } } : {}) };
}

/**
 * Read the ledger and report this session's still-live native background jobs.
 * Never throws: an unreadable ledger reports `degraded: true` with empty lists,
 * so a read failure can never masquerade as a clean all-clear. Async end to end
 * so the caller (an operator request handler) never blocks its event loop.
 */
export async function readLiveNativeBgTasks(input: {
  sid: string;
  nowMs?: number;
  ledgerPath?: string;
  /** Test seam; when given, no /proc scan runs. */
  hasOpenWriter?: (path: string) => string[];
  procRoot?: string;
  scanDeadlineMs?: number;
}): Promise<NativeBgTaskReport> {
  const nowMs = input.nowMs ?? Date.now();
  let raw: string;
  try {
    raw = await readFile(input.ledgerPath ?? defaultLedgerPath(), 'utf8');
  } catch {
    // Missing ledger is the overwhelmingly common case (no bg job ever launched)
    // and is a genuine "nothing tracked", not a failure to measure.
    return { live: [], unattributed: [], degraded: false };
  }
  const records = parseNativeBgLedger(raw);
  if (records.length === 0 && raw.trim() && raw.trim() !== '{}') {
    return { live: [], unattributed: [], degraded: true };
  }
  let hasOpenWriter = input.hasOpenWriter;
  let scanComplete = true;
  if (!hasOpenWriter) {
    const candidates = candidateNativeBgRecords({ records, sid: input.sid, nowMs });
    const scan = await openWriterPidsMany(
      candidates.map((r) => r.path),
      { procRoot: input.procRoot, deadlineMs: input.scanDeadlineMs ?? NATIVE_BG_SCAN_DEADLINE_MS },
    );
    scanComplete = scan.complete;
    hasOpenWriter = (p) => scan.byPath.get(p) ?? [];
  }
  const { live, unattributed } = selectLiveNativeBgTasks({
    records,
    sid: input.sid,
    nowMs,
    hasOpenWriter,
  });
  return { live, unattributed, degraded: !scanComplete };
}

/**
 * The agent-facing line for a compaction boundary. Returns '' when there is
 * nothing live — the caller appends it unconditionally.
 */
export function renderNativeBgTaskWarning(report: NativeBgTaskReport): string {
  const all = [...report.live, ...report.unattributed];
  if (all.length === 0) return '';
  const items = all
    .slice(0, 5)
    .map(
      (t) =>
        `\`${t.path}\` (running ${t.ageSec}s, pid ${t.pids[0]})${
          t.sid ? '' : ' [unattributed — may belong to another session]'
        }`,
    )
    .join('; ');
  return (
    ` ⚠ native-bg-tasks: ${all.length} native background Bash job(s) launched in this session are STILL RUNNING` +
    ` and will be SIGTERMed by this cut (EI-16611) — the successor inherits a dead reference, not a result: ${items}.` +
    ' Either wait for them, or re-launch under `capability:bash { run_in_background: true }` (operator-owned,' +
    ' reattachable — checkpoint the `bash_id`) before you stop. Only file-redirecting jobs are tracked, so this' +
    ' is a FLOOR, not a total.'
  );
}
