import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * gc-verify-instances — reap abandoned `scripts/verify-tauri-headless.sh` instances.
 *
 * WHY (owner ask 2026-08-01: "how do we fix this from recurring — a cleanup sweep that
 * would detect this?"). Measured on the dev box that day:
 *
 *     288 /tmp/verify-tauri-headless.* work dirs   →   300 GB
 *     /tmp 80% full (5.8T of 7.3T)
 *     one --boot-only instance running since Jul 19 (8 days), holding Xvfb :93,
 *     a webview and an operator sidecar
 *
 * Each work dir carries a frozen `spa` bundle snapshot (~1GB), so DISK is the dominant
 * cost — not the display/port starvation the first report assumed.
 *
 * ⚠ AND THE LEAK WAS UNIVERSAL, not a `--boot-only` problem. The obvious story — "the
 * `-- <cmd>` form tears itself down, `--boot-only` returns without teardown, so only
 * the latter leaks" — is what the first report said and it is WRONG. Measured: the
 * youngest leaked dir was 100h old, meaning even clean runs left theirs behind. The
 * reason is that `teardown()` only ever killed PROCESSES; the single `rm -rf` in the
 * whole script was for the isolated-PG datadir. Displays were already reclaimed
 * opportunistically (EI-18738872670541790), which is why the process side looked
 * handled while disk quietly grew. So the ROOT fix is in the script — teardown now
 * drops `$WORK/spa` (WI-6684) — and this sweep exists for what a trap can never cover:
 *
 *   - the accumulated backlog (288 dirs at first run),
 *   - runs SIGKILLed before the trap fires,
 *   - `--boot-only` callers that die/compact/forget and never run the printed stop.sh,
 *   - the kilobyte log husks that deliberately survive teardown for post-mortems.
 *
 * ── DESIGN: INVOKE THE EXISTING TEARDOWN, NEVER REIMPLEMENT IT ───────────────────
 *
 * Current work dirs contain a generated `stop.sh` with identity-checked helpers.
 * Its teardown preserves four separately hard-won fixes:
 *
 *   EI-11559              do NOT force-kill the port-lock keeper — it must survive to
 *                         self-terminate once the display is gone AND the port drains,
 *                         or a display-reusing next run collides with a straggler.
 *   EI-18745117818375852  reap escaped restart-supervisor sidecars BY PORT, matching
 *                         /proc/<pid>/environ, not by the tracked pid (the WI-3042
 *                         supervisor spawns replacements outside the process group).
 *   EI-18816386093046558  SIGKILL leaves /tmp/.X11-unix/X<N> unlinked.
 *   (ordering)            openbox before Xvfb, group-kill before single-kill.
 *
 * A reaper that rolled its own kill logic would silently lose all four and re-earn them
 * one incident at a time. Only validated current helpers may execute. Older native
 * scripts are metadata for quiescent cleanup; pre-helper pattern scripts are refused.
 *
 * ── SAFETY IS THE DELIVERABLE ────────────────────────────────────────────────────
 *
 * This sweep kills processes on a box shared by the owner's real desktop and a live
 * agent fleet, unattended, on a timer. A near-miss on 2026-07-27 (su-709bb0d6) ran
 * `pkill -f "papercusp-desktop" -u $USER --older-than 0` while cleaning up its OWN
 * instance — `--older-than 0` means "older than 0 seconds", i.e. EVERY match, which
 * included the owner's desktop window and every peer's test instance. That is the
 * failure mode this file must not have. Hence:
 *
 *   - NEVER pattern-kill. This module issues no kill of its own; it execs only a
 *     specific work dir's validated identity-checked stop.sh.
 *   - REFUSE a stop.sh whose display is :0/:1/:2 (:0 is the owner's real desktop) —
 *     a defensive parse, since a well-formed stop.sh always targets its own high
 *     display, but a malformed or hand-edited one must not be trusted.
 *   - Before the TTL, only touch a dir whose operator-issued task id is terminal,
 *     marker owner is gone, and teardown grace has elapsed. Otherwise the 6h TTL
 *     protects long interactive --boot-only sessions.
 *   - BOUND every run, and support dryRun that names what it WOULD reap (a bare count
 *     hides destruction — see the gen-gallery.py lesson).
 *
 * ── SCAN A ROOT SET, NOT JUST /tmp (WI-10002867, WI-6554700010019500) ───────────
 *
 * The verifier writes TWO kinds of `verify-tauri-headless.*` dir, and they need not
 * share a filesystem:
 *
 *   - `$WORK`                 — `${TMPDIR:-/tmp}`; carries stop.sh.
 *   - `$OPERATOR_SOURCE_WORK` — the operator source + hardlinked dependency snapshot.
 *     Hardlinks cannot cross devices, so when /tmp is on another device than the repo
 *     (true on the dev box: /tmp is its own 7.3T disk, the repo is on the 1.9T root)
 *     `select_verifier_snapshot_root` puts it under `<repo>/.papercusp/tmp`. It holds a
 *     `.papercusp-run` owner marker but NO stop.sh; the WORK dir's stop.sh removes it.
 *   - Copy-mode source snapshots — when the repository is on the root filesystem,
 *     `select_verifier_snapshot_root` places them under `/mnt/data/tmp`, which is a
 *     separate data filesystem and therefore needs its own discovery root.
 *
 * This sweep used to scan only /tmp, so whenever a snapshot outlived its WORK dir (run
 * SIGKILLed before stop.sh existed, WORK removed by another cleaner) nothing ever
 * looked at it again. Measured 2026-09-23: three such snapshots, 20GB, dated Sep 7-9,
 * sat in `papercusp/.papercusp/tmp` while the root FS went to 100%. Hence
 * {@link defaultVerifyScanRoots} and the live-owner refusal below.
 */
import { execFile } from 'node:child_process';
import { lstat, opendir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { scanRetentionHolders } from '../../storage/disk-reclaim';
import { withRetentionPinProtection } from '../../../../../scripts/lib/retention-pins.mjs';

// Lazily promisified (NOT `const execFileAsync = promisify(execFile)` at module
// scope): this module is reachable via a transitive import chain from test files
// that narrowly mock `node:child_process` for their own subprocess assertions —
// under such a mock the `execFile` import binding resolves to `undefined`, and
// eagerly calling `promisify(undefined)` at module-eval time throws for every such
// suite, even ones that never call the stop-script path (lint:no-eager-execfile-
// promisify / EI-10161; same pattern as watchdog.ts's `execFileP`). Deferring the
// promisify to first actual call means a transitive importer that never exercises
// this function never pays the cost.
type ExecFileAsync = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileAsync: ExecFileAsync | null = null;
function execFileAsync(file: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedExecFileAsync) cachedExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;
  return cachedExecFileAsync(file, args, opts);
}

/** Where the verify harness puts its per-run work dirs. */
export const VERIFY_WORK_DIR_PREFIX = 'verify-tauri-headless.';

/**
 * How old a work dir must be before it is even considered. A real `-- <cmd>` run is
 * bounded by the bridge timeout (180s) plus its assertions — minutes, not hours. The
 * generous default exists for `--boot-only`, which is a human/agent-driven interactive
 * session that may legitimately stay up while someone works against it.
 */
export const VERIFY_INSTANCE_TTL_HOURS_DEFAULT = 6;

/** Let a terminal task's own teardown settle before reclaiming its scratch. */
export const VERIFY_TERMINAL_TASK_GRACE_MS = 3 * 60_000;

/** Never reap more than this in one pass — a runaway sweep should be slow, not total. */
export const VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT = 50;

/**
 * Displays this sweep will never tear down, whatever a stop.sh claims.
 * `:0` is the owner's real desktop; `:1`/`:2` are the conventional next seats.
 */
export const PROTECTED_DISPLAYS = new Set([':0', ':1', ':2']);

/** Where discovery looks for checkouts, each of which may own a `.papercusp/tmp`. */
export interface VerifyScanRootEnv {
  /** Always-scanned bases (default: /tmp, os.tmpdir(), and the verifier data-temp root). */
  baseDirs?: string[];
  /**
   * The verifier's copy-mode source snapshots are placed here when the repository is on the
   * root filesystem. The production path is the shell verifier's fixed `/mnt/data/tmp` root;
   * this override keeps root discovery deterministic in tests and alternate host fixtures.
   */
  dataTempDir?: string;
  /** Parent of the sibling checkouts (default $PAPERCUSP_WORKSPACE_ROOT or ~/papercupai-workspace). */
  workspaceRoot?: string;
  /** Parent of the pot hives, some of which a workspace entry symlinks into (default ~/.papercusp/hives). */
  hivesRoot?: string;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The root SET this sweep scans: the base temp dirs, the verifier data-temp root, plus every checkout's
 * `.papercusp/tmp` (where the verifier's cross-device source snapshot lands — see the
 * header). Deduplicated by realpath, because /tmp is usually os.tmpdir() and several
 * workspace entries are symlinks into the hives. Missing dirs are simply absent.
 */
export async function defaultVerifyScanRoots(env: VerifyScanRootEnv = {}): Promise<string[]> {
  const workspaceRoot =
    env.workspaceRoot ??
    (process.env.PAPERCUSP_WORKSPACE_ROOT?.trim() || join(homedir(), 'papercupai-workspace'));
  const hivesRoot = env.hivesRoot ?? papercuspPath('hives');
  const dataTempDir = env.dataTempDir ?? '/mnt/data/tmp';
  const candidates = [...(env.baseDirs ?? ['/tmp', tmpdir(), dataTempDir])];
  if (env.baseDirs !== undefined && env.dataTempDir !== undefined) candidates.push(dataTempDir);
  for (const parent of [workspaceRoot, hivesRoot]) {
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      continue;
    }
    for (const name of names) candidates.push(join(parent, name, '.papercusp', 'tmp'));
  }
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!(await isDir(candidate))) continue;
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(real);
  }
  return roots;
}

/** Field 22 (starttime) of /proc/<pid>/stat, parsed after the `comm` field's closing paren. */
async function processStartTicks(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether a dir's `.papercusp-run` marker (written by the verifier: `pid=` plus
 * `start_ticks=`) names a process that is still alive. The start-ticks comparison
 * means a recycled pid cannot keep an abandoned dir alive, the same rule as
 * `scripts/lib/cargo-result.mjs` `activeRunMarker`. No marker, or an unreadable one,
 * is not live.
 */
export async function runMarkerIsLive(dir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(dir, '.papercusp-run'), 'utf8');
  } catch {
    return false;
  }
  const values = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const pid = Number(values.get('pid'));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM = alive but not ours to signal; anything else (ESRCH) = gone.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const expected = values.get('start_ticks');
  if (!expected) return true;
  return (await processStartTicks(pid)) === expected;
}

/** An operator-issued task id from the run marker, if one was recorded. */
export async function runMarkerTaskId(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(dir, '.papercusp-run'), 'utf8');
    const taskId = raw.split('\n').find((line) => line.startsWith('task_id='))?.slice('task_id='.length);
    return taskId && /^[0-9a-z]{4,64}$/.test(taskId) ? taskId : null;
  } catch {
    return null;
  }
}

export interface GcVerifyInstancesOptions {
  /** Roots to scan (default {@link defaultVerifyScanRoots}). Injected by the tests. */
  roots?: string[];
  ttlHours?: number;
  maxPerRun?: number;
  /** Report what WOULD be reaped without killing or deleting anything. */
  dryRun?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Injectable teardown, so tests never exec a real stop.sh. */
  runStopScript?: (stopScriptPath: string) => Promise<void>;
  /** Confirm terminal ledger state before the ordinary age TTL; unavailable means false. */
  isTaskTerminal?: (taskId: string) => Promise<boolean>;
  /** Host-wide positive-controlled evidence; a partial scan never permits deletion. */
  scanHolders?: typeof scanRetentionHolders;
  /** Use the shared lease store and mutex, including during dry runs. */
  retentionDir?: string;
  /** Shared discovery/size census budget; exhaustion never authorizes removal. */
  maxCensusEntries?: number;
  budgetMs?: number;
  /** Wall clock for the work budget, independent of the eligibility clock. */
  clock?: () => number;
}

export interface ReapedInstance {
  dir: string;
  ageHours: number;
  bytes: number;
  /** The display its stop.sh targets, when one could be parsed. */
  display: string | null;
  cleanup?: 'quiescent-legacy';
  /** Present when the dir was SKIPPED rather than reaped. */
  skipped?: string;
}

export interface GcVerifyInstancesResult {
  scanned: number;
  reaped: number;
  /** Bytes freed (or that would be freed under dryRun). */
  bytesFreed: number;
  /** Every dir acted on or deliberately skipped, with the reason. */
  instances: ReapedInstance[];
  skipped: number;
  dryRun: boolean;
  ttlHours: number;
  /** The roots actually scanned, so a run can be audited for what it could NOT see. */
  roots: string[];
  budgetExhausted: boolean;
}

/**
 * Parse the display a stop.sh targets, e.g. `pkill -9 -f "Xvfb :144 "` → `:144`.
 * Returns null when no display can be read, which is itself a refusal condition:
 * we do not tear down a teardown script we cannot understand.
 */
export function parseStopScriptDisplay(stopScript: string): string | null {
  const m = /Xvfb (:\d+)/.exec(stopScript);
  return m ? m[1] : null;
}

/**
 * Current verifiers delegate Xvfb teardown to a same-directory helper. Read its
 * signal target, not just stop.sh's human-facing footer: the display and run
 * provenance must agree with the caller and the helper's ownership checks.
 * Never source either script to discover metadata, or follow a helper symlink.
 */
async function stopScriptDisplay(dir: string, stopScript: string, metadataOnly = false): Promise<string | null> {
  // An inline Xvfb pattern proves neither process identity nor ownership of
  // saved PID/group targets. Never promote readable legacy text into signal
  // authority, including during dry runs or for zero-padded display numbers.
  if (!stopScript.includes('stop-xvfb.sh')) return null;

  const helperPath = join(dir, 'stop-xvfb.sh');
  if (!stopScript.split('\n').includes(`"${helperPath}" || true`)) return null;
  // Earlier native emitters protect Xvfb but still embed unverified saved PIDs
  // for Tauri's process group, openbox and PostgreSQL. Those numbers can belong
  // to a successor by the time GC runs. Helper metadata cannot authorize them.
  // Preserve these directories until teardown has process identity evidence.
  if (!metadataOnly && /\bkill\s+-(?:TERM|9)\s+(?:--\s+)?-?"?\d+"?(?=\s|;)/.test(stopScript)) return null;
  if (stopScript.includes('stop_verify_process')) {
    const reaperPath = join(dir, 'frozen-source-reaper.sh');
    if (!stopScript.split('\n').includes(`source "${reaperPath}" || exit 1`)) return null;
    try {
      if (!(await lstat(reaperPath)).isFile()) return null;
      const reaper = await readFile(reaperPath, 'utf8');
      if (!reaper.includes('frozen_source_process_identity_matches') ||
          !reaper.includes('[ -n "$expected_ticks" ] && [ "$ticks" = "$expected_ticks" ] || return 1') ||
          !reaper.includes('[ -n "$provenance" ] || return 1') ||
          !reaper.includes('PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$provenance') ||
          !reaper.includes('if ! frozen_source_process_identity_matches "$pid" "$ticks" "$provenance"; then') ||
          !reaper.includes('kill -TERM "$pid"')) return null;
    } catch {
      return null;
    }
  }
  let helper: string;
  try {
    if (!(await lstat(join(dir, 'stop.sh'))).isFile() || !(await lstat(helperPath)).isFile()) return null;
    helper = await readFile(helperPath, 'utf8');
  } catch {
    return null;
  }
  const displays = [...helper.matchAll(/^EXPECTED_DISPLAY=(:\d+)$/gm)];
  const provenances = [...helper.matchAll(/^EXPECTED_PROVENANCE=([a-zA-Z0-9:._-]+)$/gm)];
  const footers = [...stopScript.matchAll(/^echo "stopped \(display (:\d+), port \d+\)"$/gm)];
  if (displays.length !== 1 || provenances.length !== 1 || footers.length !== 1) return null;
  const display = displays[0][1];
  const provenance = provenances[0][1];
  if (display !== footers[0][1]) return null;
  if (!stopScript.includes(`grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=${provenance}" <<<"$_env_p" || continue`)) return null;
  if (!helper.includes('grep -qxF "PAPERCUSP_TAURI_LAUNCH_PROVENANCE=$EXPECTED_PROVENANCE" <<<"$env_p" &&') ||
      !helper.includes('grep -qxF "PAPERCUSP_VERIFY_XVFB_DISPLAY=$EXPECTED_DISPLAY" <<<"$env_p"') ||
      !helper.includes('xvfb_is_owned "$xvfb_pid" || exit 0\nkill -TERM "$xvfb_pid"') ||
      !helper.includes('if xvfb_is_owned "$xvfb_pid"; then\n  kill -KILL "$xvfb_pid"')) return null;
  // Canonicalize numeric seats so :01 cannot bypass the protected :1 guard.
  const seat = Number(display.slice(1));
  return Number.isSafeInteger(seat) ? `:${seat}` : null;
}

interface CensusBudget {
  entriesLeft: number;
  deadline: number;
  clock: () => number;
  exhausted: boolean;
}

function checkBudget(budget: CensusBudget, consumeEntry = false): void {
  if (budget.exhausted || budget.clock() >= budget.deadline || (consumeEntry && budget.entriesLeft-- <= 0)) {
    budget.exhausted = true;
    throw new Error('census budget exhausted — preserving directory');
  }
}

/** Stream entries so a large directory cannot allocate an unbounded Dirent array. */
async function dirBytes(path: string, budget: CensusBudget): Promise<number> {
  let total = 0;
  checkBudget(budget);
  const entries = await opendir(path);
  for await (const e of entries) {
    checkBudget(budget, true);
    const child = `${path}/${e.name}`;
    try {
      if (e.isDirectory()) total += await dirBytes(child, budget);
      else if (e.isFile()) total += (await stat(child)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return total;
}

/** Generated teardown can remove a separate source snapshot as well as WORK.
 * Never execute a target that cannot be included in the same pin decision. */
function stopScriptRemovalPaths(script: string): string[] | null {
  const commands = [...script.matchAll(/\brm -rf\b/g)];
  const targets = [...script.matchAll(/\brm -rf(?: --)? "([^"\n]*)"/g)];
  if (commands.length !== targets.length) return null;
  const paths = targets.map((m) => m[1]).filter(Boolean);
  return paths.every((path) => isAbsolute(path) && !/[\x00\r\n$`\\]/.test(path)) ? paths : null;
}

async function defaultRunStopScript(stopScriptPath: string): Promise<void> {
  // 60s is generous: stop.sh sleeps ~1s between TERM and KILL and drains the port
  // lock. A hung teardown must not wedge the whole sweep.
  await execFileAsync('bash', [stopScriptPath], { timeout: 60_000 });
}

export async function gcVerifyInstances(
  opts: GcVerifyInstancesOptions = {},
): Promise<GcVerifyInstancesResult> {
  const roots = opts.roots ?? (await defaultVerifyScanRoots());
  const ttlHours =
    Number.isFinite(opts.ttlHours) && (opts.ttlHours as number) > 0
      ? (opts.ttlHours as number)
      : VERIFY_INSTANCE_TTL_HOURS_DEFAULT;
  const maxPerRun =
    Number.isFinite(opts.maxPerRun) && (opts.maxPerRun as number) > 0
      ? (opts.maxPerRun as number)
      : VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const clock = opts.clock ?? Date.now;
  const budget: CensusBudget = {
    clock,
    exhausted: false,
    deadline: clock() + (Number.isFinite(opts.budgetMs) && opts.budgetMs! > 0 ? opts.budgetMs! : 60_000),
    entriesLeft: Number.isSafeInteger(opts.maxCensusEntries) && opts.maxCensusEntries! > 0 ? opts.maxCensusEntries! : 1_000_000,
  };
  const runStopScript = opts.runStopScript ?? defaultRunStopScript;
  const quiescent = async (dir: string, provenance?: string): Promise<string | null> => {
    if (await runMarkerIsLive(dir)) return 'owner run still alive (.papercusp-run)';
    try {
      const before = await lstat(dir);
      if (!before.isDirectory()) return 'directory identity changed — preserving directory';
      const scan = opts.scanHolders ?? (await import('../../storage/disk-reclaim')).scanRetentionHolders;
      const holders = await scan([dir], {
        isolate: true, includeProcessLinks: true, includeMappedFiles: true,
        ...(provenance ? { environmentByPath: { [dir]: `PAPERCUSP_TAURI_LAUNCH_PROVENANCE=${provenance}` } } : {}),
      });
      if (!holders.complete) return 'holder scan incomplete — preserving directory';
      if (holders.byPath.get(dir)?.length) return 'live process holder — preserving directory';
      // Marker liveness can change while the host-wide census is running.
      if (await runMarkerIsLive(dir)) return 'owner run still alive (.papercusp-run)';
      const after = await lstat(dir);
      if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) {
        return 'directory identity changed — preserving directory';
      }
      return null;
    } catch { return 'holder scan failed — preserving directory'; }
  };

  const instances: ReapedInstance[] = [];
  let reaped = 0;
  let skipped = 0;
  let bytesFreed = 0;
  let scanned = 0;

  // Oldest first ACROSS every root, so a capped run always makes progress on the worst
  // offenders rather than nibbling whichever dirs readdir happened to return first.
  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const root of roots) {
    if (budget.exhausted) break;
    let entries: Awaited<ReturnType<typeof opendir>>;
    try {
      entries = await opendir(root);
    } catch {
      continue; // a missing root must never throw into the routine tick
    }
    for await (const e of entries) {
      try { checkBudget(budget, true); } catch { break; }
      if (!e.isDirectory() || !e.name.startsWith(VERIFY_WORK_DIR_PREFIX)) continue;
      const dir = join(root, e.name);
      try {
        const entry = await lstat(dir);
        if (entry.isDirectory()) candidates.push({ dir, mtimeMs: entry.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { dir, mtimeMs } of candidates) {
    scanned += 1;
    if (reaped >= maxPerRun) break;

    const ageHours = (now - mtimeMs) / 3_600_000;
    const record = (extra: Partial<ReapedInstance>): ReapedInstance => ({
      dir,
      ageHours: Math.round(ageHours * 10) / 10,
      bytes: 0,
      display: null,
      ...extra,
    });
    try { checkBudget(budget); } catch {
      skipped += 1;
      instances.push(record({ skipped: 'census budget exhausted — preserving directory' }));
      break;
    }

    // A deadline reap kills the verifier before its EXIT trap can remove the
    // large snapshot. Its managed task id is recorded in both scratch roots.
    // Permit early cleanup only after the ledger is terminal, the marker owner
    // is gone, and a short grace has allowed normal teardown to finish.
    let terminalTask = false;
    if (ageHours < ttlHours && ageHours * 3_600_000 >= VERIFY_TERMINAL_TASK_GRACE_MS && opts.isTaskTerminal) {
      const taskId = await runMarkerTaskId(dir);
      if (taskId && !(await runMarkerIsLive(dir))) {
        try {
          terminalTask = await opts.isTaskTerminal(taskId);
        } catch {
          // A ledger read failure cannot authorize deletion.
        }
      }
    }

    // ── REFUSAL 1: too young and no confirmed terminal managed task.
    if (ageHours < ttlHours && !terminalTask) {
      skipped += 1;
      instances.push(record({ skipped: `younger than ttl (${ttlHours}h)` }));
      continue;
    }

    const stopScriptPath = `${dir}/stop.sh`;
    let stopScript: string;
    try {
      stopScript = await readFile(stopScriptPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        skipped += 1;
        instances.push(record({ skipped: 'stop.sh unreadable — preserving directory' }));
        continue;
      }
      // No stop.sh: a partially-created dir (the harness died mid-boot), or an operator
      // source snapshot whose teardown lives in a WORK dir elsewhere. There is nothing
      // to tear down, so the dir alone is safe to remove — UNLESS its owner still runs.
      //
      // ── REFUSAL 4: a live owner. Only this branch checks, and deliberately so: a
      // snapshot of a still-running rig would otherwise be deleted out from under its
      // sidecar. A dir WITH stop.sh keeps the TTL-only rule, because a forgotten
      // --boot-only rig's marker names its port-lock keeper, which stays alive for as
      // long as the rig does — honouring it there would make those rigs immortal. When
      // that rig IS reaped, its stop.sh removes this snapshot too.
      if (await runMarkerIsLive(dir)) {
        skipped += 1;
        instances.push(record({ skipped: 'owner run still alive (.papercusp-run)' }));
        continue;
      }
      const row = await protectedCollect(dir, [], async () => {
        const bytes = await dirBytes(dir, budget);
        const refusal = await quiescent(dir);
        if (refusal) return record({ skipped: refusal });
        checkBudget(budget);
        if (!dryRun) await rm(dir, { recursive: true, force: true });
        return record({ bytes });
      }, record);
      instances.push(row);
      if (row.skipped) skipped += 1;
      else { reaped += 1; bytesFreed += row.bytes; }
      continue;
    }

    let display = await stopScriptDisplay(dir, stopScript);
    // A validated native legacy script is metadata only. Never execute its
    // saved numeric signals, even if those PIDs are currently absent or reused.
    const legacy = !display && stopScript.includes('stop-xvfb.sh') &&
      /\bkill\s+-(?:TERM|9)\s+(?:--\s+)?-?"?\d+"?(?=\s|;)/.test(stopScript) &&
      !stopScript.includes('frozen-source-reaper.sh') && !stopScript.includes('stop_verify_process');
    if (legacy) display = await stopScriptDisplay(dir, stopScript, true);

    // ── REFUSAL 2: unreadable teardown. We do not run a stop.sh we cannot parse.
    if (!display) {
      skipped += 1;
      instances.push(record({ skipped: 'stop.sh names no display — refusing to run it' }));
      continue;
    }

    // ── REFUSAL 3: a protected display. THE load-bearing guard. :0 is the owner's
    // real desktop; tearing it down logs them out. A well-formed stop.sh never
    // targets one, so hitting this means the script is malformed or hand-edited —
    // exactly when blind trust is most expensive.
    if (PROTECTED_DISPLAYS.has(display)) {
      skipped += 1;
      instances.push(record({ display, skipped: `protected display ${display} — refusing` }));
      continue;
    }

    const removalPaths = legacy ? [] : stopScriptRemovalPaths(stopScript);
    if (!removalPaths) {
      skipped += 1;
      instances.push(record({ display, skipped: 'unverifiable teardown removal target — preserving directory' }));
      continue;
    }
    const row = await protectedCollect(dir, removalPaths, async () => {
      const bytes = await dirBytes(dir, budget);
      if (legacy) {
        const helperPath = join(dir, 'stop-xvfb.sh');
        const helper = await readFile(helperPath, 'utf8').catch(() => '');
        const provenance = /^EXPECTED_PROVENANCE=([a-zA-Z0-9:._-]+)$/m.exec(helper)?.[1];
        const refusal = provenance ? await quiescent(dir, provenance) : 'missing legacy provenance';
        // Repeat metadata validation after the scan. Replaced or newly live runs
        // do not inherit the earlier directory's deletion authority.
        if (refusal || await readFile(stopScriptPath, 'utf8').catch(() => '') !== stopScript ||
            await readFile(helperPath, 'utf8').catch(() => '') !== helper ||
            await stopScriptDisplay(dir, stopScript, true) !== display) {
          return record({ display, skipped: refusal ?? 'legacy metadata changed — preserving directory' });
        }
        checkBudget(budget);
        if (!dryRun) {
          try { await rm(dir, { recursive: true, force: true }); }
          catch {
            return record({ display, skipped: 'rm failed for quiescent legacy directory' });
          }
        }
        return record({ display, bytes, cleanup: 'quiescent-legacy' });
      }
      if (await readFile(stopScriptPath, 'utf8').catch(() => '') !== stopScript ||
          await stopScriptDisplay(dir, stopScript) !== display) {
        return record({ display, skipped: 'teardown metadata changed — preserving directory' });
      }
      checkBudget(budget);
      if (!dryRun) {
        // Failed teardown is never deletion authority.
        try {
          await runStopScript(stopScriptPath);
        } catch {
          return record({ display, skipped: 'teardown failed — preserving directory' });
        }
        checkBudget(budget);
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          return record({ display, skipped: 'rm failed after teardown' });
        }
      }
      return record({ display, bytes });
    }, record);
    instances.push(row);
    if (row.skipped) skipped += 1;
    else { reaped += 1; bytesFreed += row.bytes; }
  }

  return { scanned, reaped, bytesFreed, instances, skipped, dryRun, ttlHours, roots, budgetExhausted: budget.exhausted };

  async function protectedCollect(dir: string, otherPaths: string[], collect: () => Promise<ReapedInstance>,
    record: (extra: Partial<ReapedInstance>) => ReapedInstance): Promise<ReapedInstance> {
    try {
      return await withRetentionPinProtection(async (isPinned) => {
        checkBudget(budget);
        if ([dir, ...otherPaths].some(isPinned)) return record({ skipped: 'live retention pin — preserving directory' });
        return collect();
      }, { dir: opts.retentionDir, nowMs: now });
    } catch (err) {
      return record({ skipped: `collection refused — preserving directory: ${(err as Error).message}` });
    }
  }
}
