// EI-18662389554660036 — a filesystem-local mutex for shared-tree-wide mutations
// that plain repo tooling (no MCP/Papercusp credentials, just `node`) needs to
// serialize across concurrent agent processes on the same host.
//
// This is the SAME proven algorithm as `withTestcontainerStartLock`
// (libs/test-config/src/testcontainer-start-lock.ts): an atomic `mkdir` as the
// lock primitive (POSIX mkdir either creates the dir or fails EEXIST — no
// separate compare-and-swap needed), an owner.json recording {pid, host,
// startedAt} for diagnostics, and owner-aware reclamation:
//   1. positive dead-owner confirmation (same host + ESRCH on `kill(pid, 0)`)
//      reclaims immediately instead of waiting out the stale window;
//   2. age-based staleness (`staleMs`) recovers only missing/malformed owner
//      records. A live or remote owner retains its lease however old it gets.
// Deliberately duplicated here rather than importing from `@papercusp/test-config`:
// that package is TS or vitest-testcontainer-shaped, but the caller (a bare
// `node scripts/npm-install-safe.mjs`, run from `preinstall`/CI/any agent's raw
// shell, no build step) must stay plain-JS-executable with zero devDependency on
// the test toolchain. If a THIRD consumer shows up, promote both to one shared
// `libs/generic/fs-mutex` package instead of a third copy.
import { randomUUID } from "node:crypto";
import { userInfo, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  lstat,
  mkdir,
  opendir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";

/** @typedef {{ opendir?: typeof opendir, symlink?: typeof symlink, readFile?: (path: string, encoding: 'utf8') => Promise<string>, writeFile?: typeof writeFile }} FsMutexIo */

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_RETRY_MS = 250;
const LEGACY_FS_MUTEX_LOCK_ROOT = "/tmp/pcv/fs-mutex-locks";
const LEGACY_ROOT_CENSUS_LIMIT = 10_000;

/**
 * Host-wide reader/writer boundary for package-manager cache access.
 *
 * Safe installs hold a READER lease: installs in independent checkouts can keep
 * running concurrently. The retention janitor takes the WRITER lease before a
 * native npm/bun/pnpm cache prune, which drains every safe install first and
 * prevents a cache clear from racing extraction in staging, release, or a
 * checkpoint checkout. Keep the key here, beside the primitive both callers
 * already share, so the two sides cannot silently drift onto different locks.
 */
export const PACKAGE_CACHE_MUTEX_NAME = "package-manager-cache";

/**
 * Default wait budget for both lease kinds. PAPERCUSP_FS_MUTEX_TIMEOUT_MS wins;
 * otherwise PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC (EI-24961470606265468), the one
 * knob an unattended desktop build sets so this wait (like the sidecar and vite
 * build locks) can queue behind a peer instead of failing after 180 s.
 */
export function resolveFsMutexTimeoutMs(env = process.env) {
  const explicit = Number(env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS);
  if (env.PAPERCUSP_FS_MUTEX_TIMEOUT_MS && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const unattendedSec = Number(env.PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC);
  if (env.PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC && Number.isFinite(unattendedSec) && unattendedSec > 0) {
    return unattendedSec * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Resolve one host-stable mutex root.
 *
 * `os.tmpdir()` is intentionally NOT used here. It follows each process's
 * TMPDIR, and Papercusp agents legitimately run with both TMPDIR unset and
 * TMPDIR=/tmp/pcv. That split one logical npm-install mutex across
 * /tmp/pcv/fs-mutex-locks and /tmp/pcv/pcv/fs-mutex-locks, allowing two root
 * reifiers to hollow shared packages concurrently (WI-40965 / D-031).
 *
 * Default the small control-plane markers to the account home instead of bulk
 * scratch. The old Linux/macOS path is aliased to this root only after a
 * read-only census proves that no active or unknown legacy lease remains.
 * PAPERCUSP_FS_MUTEX_LOCK_DIR remains the explicit test / operator override on
 * every platform.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: NodeJS.Platform, homeDir?: string, lockRootDir?: string }} [options]
 */
export function resolveFsMutexLockRoot(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? userInfo().homedir;
  const stableDefault = join(homeDir, ".papercusp", "fs-mutex-locks");
  // A process-local caller can opt into a different metadata filesystem (for
  // example XDG_RUNTIME_DIR's tmpfs for scratch quota). The operator-wide env
  // override remains authoritative so tests and operators can force every
  // mutex call onto one inspected root.
  return resolve(env.PAPERCUSP_FS_MUTEX_LOCK_DIR ?? options.lockRootDir ?? stableDefault);
}

function staleMsFromEnv(env) {
  const configured = Number(env.PAPERCUSP_FS_MUTEX_STALE_MS);
  return env.PAPERCUSP_FS_MUTEX_STALE_MS &&
    Number.isFinite(configured) &&
    configured > 0
    ? configured
    : DEFAULT_STALE_MS;
}

function emptyLegacyCensus() {
  const stateCounts = () => ({ active: 0, stale: 0, unknown: 0 });
  return {
    writer: stateCounts(),
    reader: stateCounts(),
    queue: stateCounts(),
    otherUnknown: 0,
    scanned: 0,
    complete: true,
  };
}

function totalLegacyCensus(census, state) {
  return census.writer[state] + census.reader[state] + census.queue[state] +
    (state === "unknown" ? census.otherUnknown : 0);
}

function legacyRootError(code, message, census, cause) {
  const error = new Error(message);
  error.code = code;
  if (census) error.census = census;
  if (cause) error.cause = cause;
  return error;
}

async function legacyLeaseState(markerDir, staleMs) {
  let markerStat;
  try {
    markerStat = await lstat(markerDir);
  } catch {
    return "unknown";
  }
  if (!markerStat.isDirectory()) return "unknown";

  let owner;
  try {
    owner = JSON.parse(await readFile(join(markerDir, "owner.json"), "utf8"));
  } catch {
    return Date.now() - markerStat.mtimeMs > staleMs ? "stale" : "unknown";
  }

  if (
    !owner ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.host !== "string" ||
    owner.host.length === 0
  ) {
    return Date.now() - markerStat.mtimeMs > staleMs ? "stale" : "unknown";
  }
  if (owner.host !== hostname()) return "unknown";

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error?.code === "ESRCH" ? "stale" : "unknown";
  }

  const current = processIdentity(owner.pid);
  if (
    current &&
    ((Number.isInteger(current.tgid) && current.tgid !== owner.pid) ||
      (owner.startTicks && current.startTicks && owner.startTicks !== current.startTicks) ||
      (owner.bootId && current.bootId && owner.bootId !== current.bootId))
  ) {
    return "stale";
  }
  return "active";
}

async function censusLegacyContainer(containerPath, type, suffix, census, staleMs, openDirectory) {
  let directory;
  try {
    directory = await openDirectory(containerPath);
  } catch {
    census.otherUnknown++;
    census.complete = false;
    return;
  }

  try {
    for await (const entry of directory) {
      if (census.scanned >= LEGACY_ROOT_CENSUS_LIMIT) {
        census.otherUnknown++;
        census.complete = false;
        return;
      }
      census.scanned++;
      if (!entry.isDirectory() || !entry.name.endsWith(suffix)) {
        census.otherUnknown++;
        continue;
      }
      census[type][await legacyLeaseState(join(containerPath, entry.name), staleMs)]++;
    }
  } catch {
    census.otherUnknown++;
    census.complete = false;
  }
}

/**
 * Inspect legacy leases without creating, removing, or migrating any marker.
 *
 * @param {string} legacyRoot
 * @param {number} [staleMs]
 * @param {FsMutexIo} [io]
 */
export async function censusLegacyFsMutexRoot(legacyRoot, staleMs = staleMsFromEnv(process.env), io = {}) {
  const openDirectory = io.opendir ?? opendir;
  const census = emptyLegacyCensus();
  let directory;
  try {
    directory = await openDirectory(legacyRoot);
  } catch {
    census.otherUnknown++;
    census.complete = false;
    return census;
  }

  try {
    for await (const entry of directory) {
      if (census.scanned >= LEGACY_ROOT_CENSUS_LIMIT) {
        census.otherUnknown++;
        census.complete = false;
        return census;
      }
      census.scanned++;
      const entryPath = join(legacyRoot, entry.name);
      if (entry.name.endsWith(".readers") && entry.isDirectory()) {
        await censusLegacyContainer(entryPath, "reader", ".lock", census, staleMs, openDirectory);
      } else if (entry.name.endsWith(".queue") && entry.isDirectory()) {
        await censusLegacyContainer(entryPath, "queue", ".ticket", census, staleMs, openDirectory);
      } else if (entry.name.endsWith(".lock")) {
        census.writer[await legacyLeaseState(entryPath, staleMs)]++;
      } else {
        census.otherUnknown++;
      }
    }
  } catch {
    census.otherUnknown++;
    census.complete = false;
  }
  return census;
}

async function legacyAliasPointsTo(legacyRoot, root) {
  try {
    const link = await readlink(legacyRoot);
    return resolve(dirname(legacyRoot), link) === resolve(root);
  } catch {
    return false;
  }
}

async function restoreLegacyRoot(quarantineRoot, legacyRoot) {
  if (!quarantineRoot) return;
  try {
    await lstat(legacyRoot);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
  await rename(quarantineRoot, legacyRoot).catch(() => {});
}

function measureFsMutexOperation(phaseTimingsMs, phase, operation) {
  if (!phaseTimingsMs) return operation();
  const startedAt = performance.now();
  const record = () => {
    phaseTimingsMs[phase] =
      (phaseTimingsMs[phase] ?? 0) + Math.max(0, performance.now() - startedAt);
  };
  try {
    return Promise.resolve(operation()).finally(record);
  } catch (error) {
    record();
    throw error;
  }
}

/**
 * Prepare the resolved mutex root and preserve the old lock identity across the
 * migration. A legacy root is moved aside only after a complete read-only
 * census finds zero active and zero unknown leases; its stale markers remain in
 * a sibling quarantine directory, and the old path becomes a symlink to the
 * account-home root. An explicit override is authoritative and bypasses this
 * migration.
 *
 * The optional legacyRoot and homeDir values are deterministic test seams; the
 * production callers use the platform defaults.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: NodeJS.Platform, homeDir?: string, lockRootDir?: string, legacyRoot?: string, phaseTimingsMs?: Record<string, number>, io?: FsMutexIo }} [options]
 */
async function ensureFsMutexLockRootUncached(env = process.env, options = {}) {
  const io = options.io ?? {};
  const measure = (phase, operation) => measureFsMutexOperation(
    options.phaseTimingsMs,
    `lock-root.${phase}`,
    operation,
  );
  const platform = options.platform ?? process.platform;
  const root = resolveFsMutexLockRoot(env, options);
  const hasOverride =
    env.PAPERCUSP_FS_MUTEX_LOCK_DIR !== undefined &&
    env.PAPERCUSP_FS_MUTEX_LOCK_DIR !== null;
  const hasPerCallRoot = options.lockRootDir !== undefined && options.lockRootDir !== null;
  const legacyRootValue =
    options.legacyRoot ?? (platform === "win32" ? null : LEGACY_FS_MUTEX_LOCK_ROOT);

  if (hasOverride || hasPerCallRoot || legacyRootValue === null) {
    await measure("mkdir", () => mkdir(root, { recursive: true }));
    return root;
  }

  const legacyRoot = resolve(legacyRootValue);
  if (legacyRoot === root) {
    await measure("mkdir", () => mkdir(root, { recursive: true }));
    return root;
  }

  let legacyStat = null;
  try {
    legacyStat = await measure("legacy-lstat", () => lstat(legacyRoot));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw legacyRootError(
        "ELEGACYFSLOCKBUSY",
        "Refusing fs-mutex root migration because the legacy root cannot be inspected: " + legacyRoot,
        emptyLegacyCensus(),
        error,
      );
    }
  }

  if (legacyStat?.isSymbolicLink()) {
    if (!(await measure("legacy-alias-check", () => legacyAliasPointsTo(legacyRoot, root)))) {
      throw legacyRootError(
        "ELEGACYFSLOCKBUSY",
        "Refusing fs-mutex root migration because the legacy path is an unexpected symlink: " + legacyRoot,
        { ...emptyLegacyCensus(), otherUnknown: 1 },
      );
    }
    await measure("mkdir", () => mkdir(root, { recursive: true }));
    return root;
  }

  let census = emptyLegacyCensus();
  if (legacyStat) {
    if (!legacyStat.isDirectory()) {
      census.otherUnknown++;
      throw legacyRootError(
        "ELEGACYFSLOCKBUSY",
        "Refusing fs-mutex root migration because the legacy path is not a directory: " + legacyRoot,
        census,
      );
    }
    census = await measure(
      "legacy-census",
      () => censusLegacyFsMutexRoot(legacyRoot, staleMsFromEnv(env), io),
    );
    const active = totalLegacyCensus(census, "active");
    const unknown = totalLegacyCensus(census, "unknown");
    if (!census.complete || unknown > 0) {
      throw legacyRootError(
        "ELEGACYFSLOCKBUSY",
        "Refusing fs-mutex root migration: legacy leases active=" + active +
          " unknown=" + unknown + " at " + legacyRoot,
        census,
      );
    }
    // Known live leases have an unambiguous lock identity. Keep new callers on
    // that same root until they drain; only uncertainty fails closed.
    if (active > 0) return legacyRoot;
  }

  await measure("mkdir", () => mkdir(root, { recursive: true }));
  let quarantineRoot = null;
  if (legacyStat) {
    quarantineRoot =
      legacyRoot + ".legacy-" + Date.now() + "-" + process.pid + "-" + randomUUID();
    try {
      await measure("legacy-quarantine-rename", () => rename(legacyRoot, quarantineRoot));
    } catch (error) {
      if (await measure("legacy-alias-check", () => legacyAliasPointsTo(legacyRoot, root))) return root;
      if (error?.code !== "ENOENT") {
        throw legacyRootError(
          "ELEGACYFSALIASFAILED",
          "Could not preserve the quiesced legacy mutex root: " + legacyRoot,
          census,
          error,
        );
      }
    }
  }

  try {
    await measure("legacy-parent-mkdir", () => mkdir(dirname(legacyRoot), { recursive: true }));
    await measure("legacy-symlink", () => (io.symlink ?? symlink)(root, legacyRoot, "dir"));
  } catch (error) {
    if (await measure("legacy-alias-check", () => legacyAliasPointsTo(legacyRoot, root))) return root;
    try {
      if ((await measure("legacy-final-lstat", () => lstat(legacyRoot))).isDirectory()) return legacyRoot;
    } catch {
      // Preserve the original failure when neither the alias nor root is usable.
    }
    await measure("legacy-restore", () => restoreLegacyRoot(quarantineRoot, legacyRoot));
    throw legacyRootError(
      "ELEGACYFSALIASFAILED",
      "Could not alias the legacy mutex path to the canonical root: " + legacyRoot,
      census,
      error,
    );
  }
  return root;
}

// Root migration is a process-start concern, but every scratch write used to
// repeat the legacy-root lstat/symlink validation. That check normally costs
// sub-milliseconds and therefore hid safely in the hot path; under filesystem
// pressure a single lstat can enter D-state for tens of seconds and consume the
// result-door's entire 30s spill wait. Cache only a successful canonical-root
// resolution so the migration still re-runs while a known legacy lease is
// active, or after a failed/ambiguous inspection. The cache key tracks every
// production input that can change the lock boundary (HOME, platform and the
// explicit override), while custom migration seams remain uncached for tests.
const canonicalFsMutexRootResolutions = new Map();

function canCacheFsMutexRoot(options) {
  return options?.platform === undefined &&
    options?.homeDir === undefined &&
    options?.legacyRoot === undefined &&
    options?.io === undefined;
}

function fsMutexRootCacheKey(env, options) {
  const effectiveEnv = env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const homeDir = options?.homeDir ?? userInfo().homedir;
  const override = effectiveEnv.PAPERCUSP_FS_MUTEX_LOCK_DIR ?? '';
  const lockRootDir = options?.lockRootDir ?? '';
  return JSON.stringify({ platform, homeDir, override, lockRootDir });
}

/**
 * Resolve the mutex root, reusing a completed canonical migration and sharing
 * one in-flight migration across concurrent callers. A call that remains on
 * the legacy root is deliberately not retained: once that lease drains, the
 * next caller must be allowed to complete the migration.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: NodeJS.Platform, homeDir?: string, lockRootDir?: string, legacyRoot?: string, phaseTimingsMs?: Record<string, number>, io?: FsMutexIo }} [options]
 */
export async function ensureFsMutexLockRoot(env = process.env, options = {}) {
  if (!canCacheFsMutexRoot(options)) {
    return ensureFsMutexLockRootUncached(env, options);
  }

  const key = fsMutexRootCacheKey(env, options);
  const existing = canonicalFsMutexRootResolutions.get(key);
  if (existing) return existing;

  const canonicalRoot = resolveFsMutexLockRoot(env, options);
  const resolution = ensureFsMutexLockRootUncached(env, options)
    .then(root => {
      if (root !== canonicalRoot) canonicalFsMutexRootResolutions.delete(key);
      return root;
    })
    .catch(error => {
      canonicalFsMutexRootResolutions.delete(key);
      throw error;
    });
  canonicalFsMutexRootResolutions.set(key, resolution);
  return resolution;
}

function lockRoot() {
  return resolveFsMutexLockRoot();
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readerRoot(lockRootDir, name) {
  return join(lockRootDir, `${safeName(name)}.readers`);
}

async function readOwner(lockDir, io = {}) {
  try {
    return await (io.readFile ?? readFile)(join(lockDir, "owner.json"), "utf8");
  } catch {
    return "(owner unknown)";
  }
}

async function lockAgeMs(lockDir) {
  return stat(lockDir)
    .then((s) => Date.now() - s.mtimeMs)
    .catch(() => 0);
}

// EI-21915677034576963 — a FIFO fairness queue for `withFsMutex`'s WRITE-mode
// acquisition. Without this, a waiter is just one more `mkdir()` racer on a fixed
// poll cycle, so a caller that re-acquires the SAME lock repeatedly across many
// short-lived sub-invocations (e.g. one shard of a broad affected-tests run after
// another, each its own `runBudgetedTasks` -> `withFsMutex` call) gets a fresh,
// immediate shot at the mkdir() every time it releases, with no fairness against a
// caller that has already been waiting — a bounded/narrow verification run can be
// starved for hours behind a "continuous sequence" of such re-acquisitions even
// though it registered first. Each caller now registers a ticket BEFORE racing for
// the lock, and only the OLDEST live ticket is allowed to attempt the mkdir on any
// given poll — a brand-new sub-invocation always registers a brand-new, strictly
// YOUNGER ticket, so it can never leapfrog someone who was already waiting.

function queueRoot(lockRootDir, name) {
  return join(lockRootDir, `${safeName(name)}.queue`);
}

/**
 * A FIFO-orderable, globally-unique ticket id: a zero-padded epoch-ms prefix (so
 * lexicographic directory-listing order matches chronological registration order)
 * plus pid+uuid to break same-millisecond ties and guarantee uniqueness across
 * concurrent callers on the same host.
 */
function ticketId(startedAtMs) {
  return `${String(startedAtMs).padStart(16, "0")}-${process.pid}-${randomUUID()}`;
}

// EI-21917992245424964: the owner record answered "IS the holder alive?" and nothing about
// "is the holder WORTH waiting for?". A blocked peer therefore saw {pid, host, startedAt,
// name} and had to choose between waiting indefinitely and interrupting possibly-critical
// work — so the safe default was always to wait. Measured 2026-08-30: a peer read "it is
// progressing, so I will not interrupt it" off a holder that had just entered a ~26-minute
// leg whose output nobody wanted; resolution needed an out-of-band coord message and the
// holder happening to be awake to answer it.
//
// `intent` is that missing half: a small, caller-supplied, self-describing record carried
// INSIDE the owner record, so the answer travels with the lock and is readable by anyone
// who is blocked, with no round-trip and no liveness on the holder's part.
//
// Bounded on purpose. This value is written into a file that every waiter reads and that a
// timeout embeds into an error message, so an unbounded caller value would be a way to make
// the lock's own diagnostics unreadable — or to break the JSON a waiter parses. Scalars
// only, key- and length-capped, and anything unrepresentable is DROPPED rather than
// coerced: a missing field reads as "not declared", which is honest, whereas a coerced
// "[object Object]" reads as data.
const INTENT_MAX_KEYS = 12;
const INTENT_MAX_STRING_CHARS = 200;

function sanitizeIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent))
    return null;
  const out = {};
  let kept = 0;
  for (const [key, value] of Object.entries(intent)) {
    if (kept >= INTENT_MAX_KEYS) break;
    if (typeof value === "string") {
      if (value.length === 0) continue;
      out[key] =
        value.length > INTENT_MAX_STRING_CHARS
          ? `${value.slice(0, INTENT_MAX_STRING_CHARS)}…`
          : value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else {
      continue;
    }
    kept += 1;
  }
  return kept > 0 ? out : null;
}

/**
 * Reclaim an abandoned reader lease, writer lease or wait ticket using the same
 * owner-aware policy. Long callbacks and queued tickets legitimately get old;
 * only positive same-host dead-process evidence can reclaim a valid owner.
 * Age remains a recovery fallback for missing/malformed records (including a
 * crash between mkdir and owner publication). Remote owners and EPERM stay held.
 */
function processIdentity(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const tgid = Number(/^Tgid:\s*(\d+)$/m.exec(status)?.[1]);
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTicks = value.slice(value.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return { tgid, startTicks, bootId };
  } catch { return null; } // Non-Linux/access failures retain the kill(0) policy.
}

async function reclaimAbandonedLock(
  lockDir,
  staleMs,
  io = {},
  measureSubphase = (_name, operation) => operation(),
) {
  let owner;
  try {
    owner = await measureSubphase("abandoned-lock.owner-read", async () =>
      JSON.parse(await (io.readFile ?? readFile)(join(lockDir, "owner.json"), "utf8")),
    );
  } catch {
    // The age fallback below handles unreadable and unparseable records.
  }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.host !== "string" || owner.host.length === 0) {
    if (await measureSubphase("abandoned-lock.age-check", () => lockAgeMs(lockDir)) <= staleMs)
      return false;
    await measureSubphase("abandoned-lock.remove", () => rm(lockDir, { recursive: true, force: true }));
    return true;
  }
  if (owner.host !== hostname()) return false;
  try {
    await measureSubphase("abandoned-lock.process-probe", () => process.kill(owner.pid, 0));
    const current = await measureSubphase("abandoned-lock.process-identity", () => processIdentity(owner.pid));
    // process.pid always names a thread-group leader. A reused nonleader TID
    // cannot own even a legacy lease. New leases also survive leader-PID reuse
    // and reboot safely by recording their kernel identity at publication.
    if (current && ((Number.isInteger(current.tgid) && current.tgid !== owner.pid) ||
        (owner.startTicks && current.startTicks && owner.startTicks !== current.startTicks) ||
        (owner.bootId && current.bootId && owner.bootId !== current.bootId))) {
      await measureSubphase("abandoned-lock.remove", () => rm(lockDir, { recursive: true, force: true }));
      return true;
    }
    return false;
  } catch (error) {
    if (!error || error.code !== "ESRCH") return false;
    await measureSubphase("abandoned-lock.remove", () => rm(lockDir, { recursive: true, force: true }));
    return true;
  }
}

/**
 * The ticket that has been waiting LONGEST for `name`'s write lock, after
 * reclaiming abandoned tickets at the head — or null when the queue directory
 * cannot be read. Ticket ids sort in FIFO order, so a stale ticket behind the
 * first live ticket cannot block admission yet; leave it for the scan when it
 * reaches the head. This keeps each poll from doing owner-file and process
 * liveness I/O for every waiter in a wide queue.
 *
 * Fail-open: no ordering information ⇒ the caller falls back to racing for the
 * lock directly, so a broken/unreadable queue can never deadlock acquisition.
 */
async function oldestTicketDir(ticketsDir, staleMs, io = {}) {
  let entries;
  try {
    entries = await readdir(ticketsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const ticketNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const ticketName of ticketNames) {
    const ticketDir = join(ticketsDir, ticketName);
    if (await reclaimAbandonedLock(ticketDir, staleMs, io)) continue;
    try {
      // Another waiter may have cleaned this candidate after our directory
      // snapshot. Skip that vanished entry and continue through the ordered
      // prefix instead of treating it as the live head.
      if (!(await lstat(ticketDir)).isDirectory()) continue;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return null;
    }
    return ticketDir;
  }
  return null;
}

async function writerLockIsHeld(lockDir, staleMs, io = {}) {
  try {
    await stat(lockDir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return !(await reclaimAbandonedLock(lockDir, staleMs, io));
}

async function listReaderLocks(readersDir) {
  try {
    const entries = await readdir(readersDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(readersDir, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForReaders(
  readersDir,
  {
    timeoutMs,
    staleMs,
    retryMs,
    startedAt,
    onWaiting,
    waitingNoticeIntervalMs = 0,
    io = {},
  },
) {
  let announcedWaiting = false;
  // WI-1490656: same re-announce cadence as the write-lock wait. Fixing only the write path
  // would leave the identical silent-wait hole here — a writer blocked behind long-lived
  // READERS goes just as quiet, and looks just as much like a wedge.
  let lastWaitingNoticeMs = 0;
  for (;;) {
    const readers = await listReaderLocks(readersDir);
    for (const reader of readers) await reclaimAbandonedLock(reader, staleMs, io);
    const activeReaders = await listReaderLocks(readersDir);
    if (activeReaders.length === 0) return;

    const elapsed = Date.now() - startedAt;
    const dueForNotice =
      !announcedWaiting ||
      (waitingNoticeIntervalMs > 0 &&
        elapsed - lastWaitingNoticeMs >= waitingNoticeIntervalMs);
    if (dueForNotice && onWaiting) {
      announcedWaiting = true;
      lastWaitingNoticeMs = elapsed;
      onWaiting({
        owner: await readOwner(activeReaders[0], io),
        elapsedMs: elapsed,
      });
    }
    if (elapsed > timeoutMs) {
      const currentOwner = await readOwner(activeReaders[0], io);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for fs-mutex readers (${readersDir}); holder: ${currentOwner}`,
      );
    }
    await sleep(retryMs);
  }
}

/**
 * Run `fn` while holding an exclusive, cross-process, filesystem-local mutex
 * named `name`. Blocks (retrying every `retryMs`) until acquired, a stale/dead
 * holder is reclaimed, or `timeoutMs` elapses (throws). Always releases in a
 * `finally`, even if `fn` throws.
 *
 * @template T
 * @param {string} name
 * The callback may check for live queued writers and voluntarily return early.
 * The check uses the same ticket reclamation as acquisition; it never releases
 * the lock itself. Reader-mode and explicitly disabled locks have no check.
 *
 * @param {(context?: { hasWaiters: () => Promise<boolean> }) => Promise<T>} fn
 * @param {{ mode?: 'read' | 'reader' | 'write', lockRootDir?: string, timeoutMs?: number, staleMs?: number, retryMs?: number, onWaiting?: (info: { owner: string, elapsedMs: number }) => void, waitingNoticeIntervalMs?: number, onAcquired?: (info: { waitedMs: number, admissionSubphaseTimingsMs?: Record<string, number> }) => void, intent?: Record<string, string | number | boolean>, io?: FsMutexIo }} [opts]
 * @returns {Promise<T>}
 */
export async function withFsMutex(name, fn, opts = {}) {
  if (opts.mode === "read" || opts.mode === "reader")
    return withFsMutexRead(name, fn, opts);
  if (process.env.PAPERCUSP_DISABLE_FS_MUTEX === "1") {
    return fn();
  }

  const io = opts.io ?? {};
  const writeFileIo = io.writeFile ?? writeFile;
  const admissionSubphaseTimingsMs = typeof opts.onAcquired === "function" ? {} : undefined;
  const measureAdmissionSubphase = admissionSubphaseTimingsMs
    ? async (name, operation) => {
      const phaseStartedAt = performance.now();
      try {
        return await operation();
      } finally {
        admissionSubphaseTimingsMs[name] =
          (admissionSubphaseTimingsMs[name] ?? 0) + Math.max(0, performance.now() - phaseStartedAt);
      }
    }
    : (_name, operation) => operation();
  // Root resolution is outside the mutex's timeout budget, but remains visible in
  // caller timing maps. The nested `lock-root.*` phases intentionally overlap
  // `lock-root.ensure`; they identify which root-resolution operation consumed time.
  /** @type {{ phaseTimingsMs?: Record<string, number>, lockRootDir?: string, io?: FsMutexIo }} */
  const rootOptions = {};
  if (opts.lockRootDir !== undefined) rootOptions.lockRootDir = opts.lockRootDir;
  if (admissionSubphaseTimingsMs) rootOptions.phaseTimingsMs = admissionSubphaseTimingsMs;
  if (opts.io) rootOptions.io = opts.io;
  const root = await measureAdmissionSubphase(
    "lock-root.ensure",
    () => ensureFsMutexLockRoot(undefined, Object.keys(rootOptions).length > 0 ? rootOptions : undefined),
  );
  const lockDir = join(root, `${safeName(name)}.lock`);
  const readersDir = readerRoot(root, name);
  const timeoutMs = opts.timeoutMs ?? resolveFsMutexTimeoutMs();
  const staleMs =
    opts.staleMs ?? intEnv("PAPERCUSP_FS_MUTEX_STALE_MS", DEFAULT_STALE_MS);
  const retryMs =
    opts.retryMs ?? intEnv("PAPERCUSP_FS_MUTEX_RETRY_MS", DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  // Nested under its own key rather than merged: a caller can then never shadow `pid` /
  // `host` / `startedAt`, which are the fields the reclaim path and every waiter trust.
  const intent = sanitizeIntent(opts.intent);
  const owner = {
    pid: process.pid,
    ...processIdentity(process.pid),
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
    ...(intent ? { intent } : {}),
  };

  // EI-21915677034576963: register a FIFO ticket BEFORE racing for the write lock, so a
  // caller that has been waiting longest is never overtaken by a newer one that simply
  // happens to poll at a luckier moment — including the SAME long-running caller
  // re-entering across its own successive sub-invocations (e.g. one shard after
  // another): each is a brand-new `withFsMutex` call, so it always registers a
  // brand-new, strictly YOUNGER ticket than anyone already waiting. Best-effort: if the
  // ticket bookkeeping itself fails for any reason, fall back to the pre-existing racing
  // behaviour for THIS caller rather than ever deadlocking on a broken queue.
  const ticketsDir = queueRoot(root, name);
  const myTicketDir = join(ticketsDir, `${ticketId(startedAt)}.ticket`);
  let ticketRegistered = false;
  let writerOwner;
  try {
    await measureAdmissionSubphase("queue-root-mkdir", () => mkdir(ticketsDir, { recursive: true }));
    await measureAdmissionSubphase("ticket-mkdir", () => mkdir(myTicketDir));
    await measureAdmissionSubphase("ticket-owner-write", () => writeFileIo(
      join(myTicketDir, "owner.json"),
      JSON.stringify(owner, null, 2) + "\n",
    ));
    ticketRegistered = true;
  } catch {
    ticketRegistered = false;
  }

  let announcedWaiting = false;
  let lastWaitingNoticeMs = 0;
  // WI-1490656 — EI-21921867787033533 wired a FIRST-wait notice, but it fires exactly
  // ONCE, at t≈0. A caller that then queues for hours produces no further output, so any
  // observer who attaches later (or reads a rotated capture) sees a process parked in
  // ep_poll with zero children and a frozen log — byte-for-byte indistinguishable from a
  // genuine wedge, and repeatedly misdiagnosed as one. Callers that pass
  // `waitingNoticeIntervalMs` get the notice RE-ANNOUNCED on that cadence, so the WAITING
  // state keeps emitting attributable forward-progress bytes for as long as it lasts.
  const waitingNoticeIntervalMs =
    Number(opts.waitingNoticeIntervalMs) > 0
      ? Number(opts.waitingNoticeIntervalMs)
      : 0;
  const announceWaiting = async (elapsedMs) => {
    if (!opts.onWaiting) return;
    const due =
      !announcedWaiting ||
      (waitingNoticeIntervalMs > 0 &&
        elapsedMs - lastWaitingNoticeMs >= waitingNoticeIntervalMs);
    if (!due) return;
    announcedWaiting = true;
    lastWaitingNoticeMs = elapsedMs;
    opts.onWaiting({ owner: await readOwner(lockDir, io), elapsedMs });
  };
  try {
    for (;;) {
      if (ticketRegistered) {
        const oldest = await measureAdmissionSubphase(
          "ticket-scan",
          () => oldestTicketDir(ticketsDir, staleMs, io),
        );
        if (oldest != null && oldest !== myTicketDir) {
          // Someone else registered first — don't even attempt the mkdir race this
          // cycle; let them go before us.
          const elapsed = Date.now() - startedAt;
          await measureAdmissionSubphase("waiting-notice", () => announceWaiting(elapsed));
          if (elapsed > timeoutMs) {
            const currentOwner = await readOwner(lockDir, io);
            throw new Error(
              `Timed out after ${timeoutMs}ms waiting for fs-mutex "${name}" (${lockDir}); holder: ${currentOwner}`,
            );
          }
          await measureAdmissionSubphase("backoff-sleep", () => sleep(retryMs));
          continue;
        }
      }
      try {
        await measureAdmissionSubphase("writer-lock-mkdir", () => mkdir(lockDir));
        // WI-1490656: `startedAt` is when this caller began TRYING, so it includes its own
        // queue wait and cannot answer "how long has the lock been HELD" — the one question a
        // triager staring at a stalled pipeline actually asks. Reading it as a hold duration
        // produced a wrong, confidently-reported measurement during this very investigation.
        // The mkdir above IS the grant, so stamp the grant instant here and make it
        // answerable instead of inviting the same misreading again.
        writerOwner = { ...owner, acquiredAt: new Date().toISOString(), phase: "draining-readers" };
        await measureAdmissionSubphase("writer-owner-write", () => writeFileIo(
          join(lockDir, "owner.json"),
          JSON.stringify(writerOwner, null, 2) + "\n",
        ));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;

        const elapsed = Date.now() - startedAt;
        await measureAdmissionSubphase("waiting-notice", () => announceWaiting(elapsed));
        if (await measureAdmissionSubphase(
          "abandoned-lock-reclaim",
          () => reclaimAbandonedLock(lockDir, staleMs, io, measureAdmissionSubphase),
        )) continue;
        if (elapsed > timeoutMs) {
          const currentOwner = await readOwner(lockDir, io);
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for fs-mutex "${name}" (${lockDir}); holder: ${currentOwner}`,
          );
        }
        await measureAdmissionSubphase("backoff-sleep", () => sleep(retryMs));
      }
    }
  } finally {
    if (ticketRegistered) {
      try {
        await measureAdmissionSubphase(
          "ticket-cleanup",
          () => rm(myTicketDir, { recursive: true, force: true }),
        );
      } catch {
        // best-effort — a missing/already-cleaned ticket is not an error
      }
    }
  }

  try {
    await measureAdmissionSubphase("reader-drain", () => waitForReaders(readersDir, {
      timeoutMs,
      staleMs,
      retryMs,
      startedAt,
      onWaiting: opts.onWaiting,
      waitingNoticeIntervalMs,
      io,
    }));
    // WI-1490656: report how long admission actually QUEUED. A caller that re-acquires
    // the same lock across many short sub-invocations (one affected-tests shard after
    // another) otherwise has no way to bound its TOTAL queue time — each call's
    // `timeoutMs` restarts from zero, so an N-shard run's real worst case is N × timeoutMs.
    // Fires inside the try so a throwing callback still releases the lock.
    if (opts.onAcquired) opts.onAcquired({
      waitedMs: Date.now() - startedAt,
      ...(admissionSubphaseTimingsMs
        ? { admissionSubphaseTimingsMs: { ...admissionSubphaseTimingsMs } }
        : {}),
    });
    // A reserved writer can spend its entire wait draining existing readers.
    // Publish the callback phase only after that drain, atomically so a peek
    // cannot mistake a partially rewritten owner record for an absent lock.
    const runningOwner = { ...writerOwner, phase: "running", runningAt: new Date().toISOString() };
    const nextOwnerPath = join(lockDir, "owner.next.json");
    await writeFileIo(nextOwnerPath, `${JSON.stringify(runningOwner, null, 2)}\n`);
    await rename(nextOwnerPath, join(lockDir, "owner.json"));
    return await fn({
      hasWaiters: async () => (await oldestTicketDir(ticketsDir, staleMs, io)) != null,
    });
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * Run `fn` while holding a shared reader marker for `name`. Readers do not
 * acquire the writer's exclusive mkdir lock, so independent dependency reads
 * can proceed together. A reader marker is installed before checking the
 * writer lock; a writer that wins the race therefore waits for that marker,
 * while a reader that observes an existing writer backs out and retries.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ mode?: 'read' | 'reader', lockRootDir?: string, timeoutMs?: number, staleMs?: number, retryMs?: number, onWaiting?: (info: { owner: string, elapsedMs: number }) => void, waitingNoticeIntervalMs?: number, onAcquired?: (info: { waitedMs: number }) => void, io?: FsMutexIo }} [opts]
 * @returns {Promise<T>}
 */
export async function withFsMutexRead(name, fn, opts = {}) {
  if (process.env.PAPERCUSP_DISABLE_FS_MUTEX === "1") return fn();

  const io = opts.io ?? {};
  const writeFileIo = io.writeFile ?? writeFile;
  const rootOptions = {};
  if (opts.lockRootDir !== undefined) rootOptions.lockRootDir = opts.lockRootDir;
  if (opts.io) rootOptions.io = opts.io;
  const root = await ensureFsMutexLockRoot(undefined, Object.keys(rootOptions).length > 0 ? rootOptions : undefined);
  const writerDir = join(root, `${safeName(name)}.lock`);
  const readersDir = readerRoot(root, name);
  const timeoutMs = opts.timeoutMs ?? resolveFsMutexTimeoutMs();
  const staleMs =
    opts.staleMs ?? intEnv("PAPERCUSP_FS_MUTEX_STALE_MS", DEFAULT_STALE_MS);
  const retryMs =
    opts.retryMs ?? intEnv("PAPERCUSP_FS_MUTEX_RETRY_MS", DEFAULT_RETRY_MS);
  const startedAt = Date.now();
  const readerDir = join(
    readersDir,
    `${process.pid}-${Date.now()}-${randomUUID()}.lock`,
  );
  const owner = {
    pid: process.pid,
    ...processIdentity(process.pid),
    host: hostname(),
    startedAt: new Date(startedAt).toISOString(),
    name,
    mode: "read",
  };

  await mkdir(readersDir, { recursive: true });

  let announcedWaiting = false;
  let lastWaitingNoticeMs = 0;
  // Shared readers need the same opt-in observations as writer waiters. Read
  // the owner again at each notice: consecutive installs can change the holder
  // during one admission wait (EI-25192113925430292).
  const waitingNoticeIntervalMs =
    Number(opts.waitingNoticeIntervalMs) > 0
      ? Number(opts.waitingNoticeIntervalMs)
      : 0;
  for (;;) {
    let markerCreated = false;
    let ready = false;
    try {
      // A reserved writer already prevents admission. Publishing markers on
      // every retry in that state makes its drain observe readers that will
      // never enter, and a stream of newcomers can keep that drain occupied.
      if (!(await writerLockIsHeld(writerDir, staleMs, io))) {
        await mkdir(readerDir);
        markerCreated = true;
        await writeFileIo(
          join(readerDir, "owner.json"),
          `${JSON.stringify(owner, null, 2)}\n`,
        );
        // Keep this second check: a writer can reserve after the preflight
        // but before publication. Its drain must see our marker until we
        // notice that reservation and remove it.
        ready = !(await writerLockIsHeld(writerDir, staleMs, io));
      }
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (markerCreated)
          await rm(readerDir, { recursive: true, force: true });
        throw error;
      }
    }

    if (ready) break;
    if (markerCreated) await rm(readerDir, { recursive: true, force: true });

    const elapsed = Date.now() - startedAt;
    if (
      opts.onWaiting &&
      (!announcedWaiting ||
        (waitingNoticeIntervalMs > 0 &&
          elapsed - lastWaitingNoticeMs >= waitingNoticeIntervalMs))
    ) {
      announcedWaiting = true;
      lastWaitingNoticeMs = elapsed;
      opts.onWaiting({ owner: await readOwner(writerDir, io), elapsedMs: elapsed });
    }
    if (elapsed > timeoutMs) {
      const currentOwner = await readOwner(writerDir, io);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for fs-mutex writer ("${name}"); holder: ${currentOwner}`,
      );
    }
    await sleep(retryMs);
  }

  try {
    // WI-10006385: same admission report as the writer's onAcquired, so a reader that
    // queued behind an install can say how long it waited. Inside the try so a throwing
    // callback still removes the reader marker.
    if (opts.onAcquired) opts.onAcquired({ waitedMs: Date.now() - startedAt });
    return await fn();
  } finally {
    await rm(readerDir, { recursive: true, force: true });
  }
}

/**
 * EI-19304880034803985 — a NON-blocking, synchronous peek at whether `name`'s
 * mutex is currently held, for a caller that wants to WARN a caller ("an
 * install may be about to make you hang") rather than wait/acquire it.
 *
 * Deliberately does not reclaim a stale/dead-owner lock (that mutates shared
 * state — a caller merely peeking must never race the real holder's own
 * cleanup) and deliberately does not throw on any read/parse failure — an
 * inconclusive peek reports `held:false` (never block a caller on a
 * diagnostic that fails open by design, mirroring `withFsMutex`'s own
 * fail-open error handling).
 *
 * @param {string} name
 * @param {{ lockRootDir?: string }} [options]
 * @returns {{ held: boolean, owner?: { pid?: number, host?: string, startedAt?: string, acquiredAt?: string, runningAt?: string, phase?: 'draining-readers' | 'running', name?: string, intent?: Record<string, string | number | boolean> }, lockDir: string }}
 */
export function peekFsMutexSync(name, options = {}) {
  const lockName = safeName(name) + ".lock";
  const defaultLockDir = join(resolveFsMutexLockRoot(process.env, options), lockName);
  const hasOverride =
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR !== undefined &&
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR !== null;
  const hasPerCallRoot = options.lockRootDir !== undefined && options.lockRootDir !== null;
  const roots =
    hasOverride || hasPerCallRoot || process.platform === "win32"
      ? [defaultLockDir]
      : [join(LEGACY_FS_MUTEX_LOCK_ROOT, lockName), defaultLockDir];
  const seen = new Set();
  for (const lockDir of roots) {
    if (seen.has(lockDir)) continue;
    seen.add(lockDir);
    try {
      const raw = readFileSync(join(lockDir, "owner.json"), "utf8");
      return { held: true, owner: JSON.parse(raw), lockDir };
    } catch {
      // A failed peek is intentionally non-blocking and fails open.
    }
  }
  return { held: false, lockDir: defaultLockDir };
}
