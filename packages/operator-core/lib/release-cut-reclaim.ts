/**
 * release-cut-reclaim — find and remove stale release-cut worktrees
 * (EI-23968726111761920). Surfaced as `release:cut { op:'reclaim' }`.
 *
 * Every desktop cut materialises a 45–72 GB exact-SHA worktree of the canonical repo, and
 * nothing ever removed one: six were born in three days (2026-09-26..29) and pushed the root
 * disk under git-sync's fetch reserve. This module answers "which of those trees may go?"
 * and, only for trees a caller names from that answer, removes them.
 *
 * DESIGN — derived, never a roster:
 *  - Population = `git worktree list --porcelain` of the canonical repo. No path glob:
 *    cut trees live under at least five parent dirs, one of them a typo'd workspace dir.
 *  - A tree is IDENTIFIED as a cut only by the record its creator wrote: a retention
 *    lease (`~/.papercusp/release-retention/lease-<tag>.tsv`, written by release-local.sh)
 *    naming a path inside it. Identified + unprotected ⇒ `reclaimable`. A registered tree
 *    with no such record is `named-only`: never swept, eligible only when a caller names it.
 *  - Protected set is COMPUTED (and every protection is fail-closed):
 *      · a live retention lease (expires_ns 0 = never expires) — the same rule as
 *        release_artifacts_retention_path_is_leased, realpath'd on both sides so an
 *        offloaded (moved + symlinked) tree stays covered;
 *      · the tree backing the latest PUBLISHED release (harness_shared.releases), by
 *        HEAD sha or by that release's lease tag, whether or not the lease expired;
 *      · any tree created after the latest RECORDED release (the next cut, e.g. 0.0.26,
 *        before it has a lease) or whose desktop version is newer than the latest
 *        published one;
 *      · a process holding the tree (cwd/root/exe/fd) — one /proc walk with a positive
 *        control, refusing to trust a scan run inside a nested PID namespace;
 *      · a HEAD moved within `minIdleHours` (checkout/commit — the git admin dir, which the
 *        tree-wide asset sync that touches every checkout never writes);
 *      · AUTHORED work: any status entry — superproject or ANY submodule, recursively —
 *        outside the measured machine-written set, a submodule commit the canonical
 *        checkout does not have, or a superproject HEAD no ref contains;
 *      · locked worktrees, and a tree that contains another registered worktree.
 *
 * Removal (confirm path) archives the tracked diffs first, re-checks holders, renames the
 * tree aside on its own filesystem, deletes the tree, then its worktree admin dir.
 * The existing retained diff archive records the exact removal identity before rename,
 * so discovery can report interrupted removals even after Git marks the old path prunable.
 * Each removal is appended to the shared deletion-audit.tsv the release scripts write.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { mapWithConcurrency } from './gym/concurrency';
import { defaultRetentionDir, isLeaseLive, parseRetentionLease, readRetentionLeases, RETENTION_SCHEMA, versionFromTag,
  withRetentionPinProtection,
  type RetentionLease } from '../../../scripts/lib/retention-pins.mjs';
export { defaultRetentionDir, isLeaseLive, parseRetentionLease, readRetentionLeases, RETENTION_SCHEMA, versionFromTag };
export type { RetentionLease, LeaseParse } from '../../../scripts/lib/retention-pins.mjs';
import { HELPER_FRAME_FN, type HelperSection, nextForkSlot, parseHelperFrames } from './git-batch';
import { retentionPolicyForWorkspaceRoot } from './storage/retention-policy';
import { DEFAULT_RECLAIM_RUN_BUDGET_MS, type RetentionCapReceipt } from './storage/disk-reclaim';
import { openWriterPidsMany, type OpenWriterScan } from './native-bg-task-ledger';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
import { CENSUS_DU_TIMEOUT_MS } from './storage/disk-consumer-census';
import { DetachedWalkAbandoned, readWalkState, runDetachedDuUsage, walkAttemptFiles, walkProcessAlive,
  type DetachedWalkOptions } from './storage/disk-census-detached-walk';

export { type HelperSection, nextForkSlot, parseHelperFrames } from './git-batch';

export const RECLAIM_DELETER = 'release:cut-reclaim';
export const DEFAULT_MIN_IDLE_HOURS = 24;
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * The authored-work read is the only git-heavy phase, and it runs inside one MCP call
 * (release:cut, ~55s request timeout). Serially it cost 54.4s of a 56.0s dry-run on
 * 2026-10-02 07:02Z: 24 trees, median 2.1s each, under load ~126/128 (EI-24849983022443070).
 * Trees are independent reads, so they run width-bounded. Within a tree the reads are
 * batched into `sh` helpers (see runGitHelper): each extra submodule helper costs one more
 * fork of the large host image, so the submodule pass defaults to a single helper and the
 * tree width supplies the parallelism.
 */
export const AUTHORED_TREE_CONCURRENCY = 4;
export const AUTHORED_SUBMODULE_CONCURRENCY = 1;

// ---------------------------------------------------------------- parsing (pure)

export interface ReclaimWorktree {
  path: string;
  head: string | null;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
}

/** `git worktree list --porcelain` → entries. The main worktree is always first. */
export function parseWorktreePorcelain(stdout: string): ReclaimWorktree[] {
  const out: ReclaimWorktree[] = [];
  for (const block of stdout.split(/\n\n+/)) {
    let worktreePath = '';
    let head: string | null = null;
    let detached = false;
    let prunable = false;
    let locked = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) worktreePath = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line === 'detached') detached = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      else if (line === 'locked' || line.startsWith('locked ')) locked = true;
    }
    if (worktreePath) out.push({ path: worktreePath, head, detached, prunable, locked });
  }
  return out;
}

/** expires_ns=0 is what every lease gets while PAPERCUSP_RELEASE_RETENTION_TTL_SEC is unset, so
 *  "never expires" would pin every cut ever made. Reclaim honours such a lease only for the latest
 *  published release or a NEWER (in-flight / unreleased) cut; an older one is ignored. Unknowable
 *  (no published record, or an unparsable version) fails closed = honoured. Chosen over a finite
 *  default TTL, which would change the lease writer and could expire an in-flight cut mid-build. */
export function neverExpiringLeaseHonored(lease: RetentionLease, published: ReleaseRecord | null): boolean {
  if (lease.expiresNs !== 0n) return true;
  if (!published || !lease.version) return true;
  const cmp = compareVersions(lease.version, published.version);
  return cmp === null || cmp >= 0;
}

/** Numeric x.y.z compare; a non-numeric version compares as null (callers fail closed). */
export function compareVersions(a: string, b: string): number | null {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** Either side inside the other — the lease guard's own prefix rule. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The executor's path rail, independent of the plan: never remove the canonical tree, `/`,
 * home, or anything that CONTAINS one of them. A tree nested INSIDE the canonical tree (e.g.
 * `.papercusp/worktrees/desktop-release-0.0.19`) is not refused here — the caller's `.git`-file
 * and admin-dir rails are what prove it is a registered linked worktree rather than part of
 * the canonical checkout. (WI-10006139: the rail used {@link pathsOverlap}, which also
 * matches descendants, so a tree the planner offered as named-only could never be removed.)
 */
export function reclaimPathRefusal(real: string, canonicalRoot: string, home: string): string | null {
  const containsOrIs = (outer: string, inner: string) => outer === '/' || inner === outer || inner.startsWith(`${outer}/`);
  if (containsOrIs(real, canonicalRoot)) return 'refusing the canonical tree or a path that contains it';
  if (containsOrIs(real, home)) return 'refusing home or a path that contains it';
  return null;
}

export interface StatusEntry {
  path: string;
  /** a gitlink entry — its content is judged inside the submodule itself */
  submodule: boolean;
}

/** `git status --porcelain=v2 -z` → entries, each path prefixed with `prefix/` (the
 *  submodule's display path) so rules below match superproject-relative paths. */
export function parsePorcelainV2(stdout: string, prefix = ''): StatusEntry[] {
  const fields = stdout.split('\0');
  const out: StatusEntry[] = [];
  const join = (p: string) => (prefix ? `${prefix}/${p}` : p);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? '';
    if (!f) continue;
    const kind = f[0];
    if (kind === '#') continue;
    if (kind === '?' || kind === '!') {
      if (kind === '?') out.push({ path: join(f.slice(2)), submodule: false });
      continue;
    }
    const parts = f.split(' ');
    const sub = parts[2] ?? '';
    const pathFieldIndex = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (pathFieldIndex < 0) continue;
    out.push({ path: join(parts.slice(pathFieldIndex).join(' ')), submodule: sub.startsWith('S') });
    if (kind === '2') i += 1; // the rename's original path is the next NUL field
  }
  return out;
}

/**
 * The machine-written residue a FINISHED cut leaves behind (measured 2026-09-30 on
 * relcut-0024 and desktop-release-0.0.19): the version bump, lockfile churn, and the
 * tracked sidecar bundle. Anything else in a tree's status is treated as authored work.
 */
export function machineWrittenRule(relPath: string, releaseVersionPaths: readonly string[]): string | null {
  if (relPath.startsWith('papercusp-desktop/src-tauri/env-sidecars/')) return 'sidecar-build-output';
  if (releaseVersionPaths.some((p) => relPath === `papercusp-desktop/${p}`)) return 'release-version-bump';
  const base = path.posix.basename(relPath);
  if (base === 'package-lock.json' || base === 'Cargo.lock') return 'lockfile';
  if (/(^|\/)(coverage|__pycache__)(\/|$)/.test(relPath)) return 'build-cache';
  return null;
}

// ---------------------------------------------------------------- planning (pure)

export interface TreeProbe {
  realPath: string | null;
  /** the registered path is a symlink to the tree's real location (an offload) */
  offloaded: boolean;
  onRootFs: boolean | null;
  adminDir: string | null;
  createdAtMs: number | null;
  lastHeadMoveMs: number | null;
  desktopVersion: string | null;
}

export interface HolderScan {
  verified: boolean;
  reason?: string;
  /** keyed by registered worktree path */
  holders: Map<string, string[]>;
  diagnostics?: OpenWriterScan['diagnostics'];
}

export type AuthoredWork =
  | { ok: true; authored: string[]; machineWritten: number }
  | { ok: false; reason: string };

export interface ReleaseRecord {
  version: string;
  gitSha: string | null;
  cutAtMs: number;
  publishedAtMs: number | null;
}

export type ReclaimDisposition = 'reclaimable' | 'named-only' | 'protected';

export interface ReclaimVerdict {
  path: string;
  realPath: string | null;
  onRootFs: boolean | null;
  head: string | null;
  version: string | null;
  leaseTags: string[];
  /** never-expiring leases on an older-than-published tree, ignored as protection (reported, not hidden) */
  ignoredLeases: string[];
  createdAt: string | null;
  lastHeadMoveAt: string | null;
  disposition: ReclaimDisposition;
  reasons: string[];
}

export interface ReclaimPlan {
  canonicalRoot: string | null;
  latestPublished: string | null;
  failClosed: string[];
  skipped: { autoManaged: string[]; prunable: number };
  verdicts: ReclaimVerdict[];
  /** Diagnostic only: these paths never inherit permission to delete from a receipt. */
  interrupted?: InterruptedCutReclaim[];
}

interface CutReclaimReceipt {
  schema: 'papercusp-cut-reclaim/v1';
  canonicalRoot: string;
  path: string;
  realPath: string;
  trash: string;
  adminDir: string;
  device: string;
  inode: string;
}

export interface InterruptedCutReclaim extends CutReclaimReceipt {
  archive: string;
  state: 'trash-present' | 'identity-mismatch' | 'bookkeeping-pending';
}

const RECLAIM_RECEIPT_PREFIX = '# papercusp-cut-reclaim ';

/** Extend the retained archive, rather than creating a second reclamation ledger. */
function recordCutReclaim(archive: string, receipt: CutReclaimReceipt): void {
  const fd = fs.openSync(archive, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('reclaim archive is not a regular file');
    fs.writeFileSync(fd, `\n${RECLAIM_RECEIPT_PREFIX}${JSON.stringify(receipt)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(path.dirname(archive), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}

/** Bounded archive-tail reads; no glob of disposable directories or automatic removal. */
function readInterruptedCutReclaims(archiveDir: string, canonicalRoot: string): {
  interrupted: InterruptedCutReclaim[];
  errors: string[];
} {
  const interrupted: InterruptedCutReclaim[] = [];
  const errors: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${archiveDir}:${errText(e)}`);
    return { interrupted, errors };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.patch')) continue;
    const archive = path.join(archiveDir, entry.name);
    try {
      const fd = fs.openSync(archive, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let tail: string;
      try {
        const size = fs.fstatSync(fd).size;
        const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
        const read = fs.readSync(fd, bytes, 0, bytes.length, size - bytes.length);
        tail = bytes.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      // Last receipt line wins; reverse().find() because operator-core's lib predates es2023 findLast.
      const line = tail.split('\n').reverse().find((value) => value.startsWith(RECLAIM_RECEIPT_PREFIX));
      if (!line) continue; // older archives remain valid diff archives
      const r = JSON.parse(line.slice(RECLAIM_RECEIPT_PREFIX.length)) as CutReclaimReceipt;
      if (r.schema !== 'papercusp-cut-reclaim/v1' || r.canonicalRoot !== canonicalRoot) continue;
      if (![r.path, r.realPath, r.trash, r.adminDir].every((p) => typeof p === 'string' && path.isAbsolute(p)) ||
          path.dirname(r.trash) !== path.dirname(r.realPath) ||
          !path.basename(r.trash).startsWith(`.reclaim-trash-${path.basename(r.realPath)}-`) ||
          !/^\d+$/.test(r.device) || !/^\d+$/.test(r.inode)) {
        throw new Error('invalid reclaim receipt identity');
      }
      let trashStat: fs.Stats | null = null;
      try { trashStat = fs.lstatSync(r.trash); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (trashStat) {
        const same = trashStat.isDirectory() && !trashStat.isSymbolicLink() &&
          String(trashStat.dev) === r.device && String(trashStat.ino) === r.inode;
        interrupted.push({ ...r, archive, state: same ? 'trash-present' : 'identity-mismatch' });
      } else if (!fs.existsSync(r.realPath) && fs.existsSync(r.adminDir)) {
        interrupted.push({ ...r, archive, state: 'bookkeeping-pending' });
      }
    } catch (e) {
      errors.push(`${archive}:${errText(e)}`);
    }
  }
  return { interrupted, errors };
}

export interface ReclaimPlanInput {
  nowMs: number;
  minIdleHours: number;
  worktrees: ReclaimWorktree[];
  isAutoManaged: (worktreePath: string) => boolean;
  leases: RetentionLease[];
  leaseErrors: string[];
  releases: ReleaseRecord[] | { error: string };
  probes: Map<string, TreeProbe>;
  holders: HolderScan;
  /** only trees that survive every cheap check need this (it runs git in each tree) */
  authored: Map<string, AuthoredWork>;
}

export const AUTHORED_UNCHECKED = 'authored-work-unchecked';

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function latestPublishedRelease(releases: ReleaseRecord[]): ReleaseRecord | null {
  let best: ReleaseRecord | null = null;
  for (const r of releases) {
    if (r.publishedAtMs === null) continue;
    if (!best || (compareVersions(r.version, best.version) ?? 0) > 0) best = r;
  }
  return best;
}

export function planCutReclaim(input: ReclaimPlanInput): ReclaimPlan {
  const [main, ...linked] = input.worktrees;
  const failClosed: string[] = input.leaseErrors.map((e) => `malformed-lease:${e}`);
  const releases = Array.isArray(input.releases) ? input.releases : null;
  if (!releases) failClosed.push(`release-records-unavailable:${(input.releases as { error: string }).error}`);
  const published = releases ? latestPublishedRelease(releases) : null;
  if (releases && !published) failClosed.push('no-published-release');
  const latestCutAtMs = releases && releases.length ? Math.max(...releases.map((r) => r.cutAtMs)) : null;
  if (!input.holders.verified) failClosed.push(`holder-scan-unverified:${input.holders.reason ?? 'unknown'}`);

  const autoManaged: string[] = [];
  let prunable = 0;
  const verdicts: ReclaimVerdict[] = [];
  const registered = input.worktrees.filter((w) => !w.prunable).map((w) => w.path);

  for (const wt of linked) {
    if (wt.prunable) {
      prunable++;
      continue;
    }
    if (input.isAutoManaged(wt.path)) {
      autoManaged.push(wt.path);
      continue;
    }
    const probe = input.probes.get(wt.path) ?? null;
    const reasons: string[] = [...failClosed];
    const sides = [wt.path, ...(probe?.realPath && probe.realPath !== wt.path ? [probe.realPath] : [])];
    const covering = input.leases.filter((l) =>
      l.paths.some((leased) => sides.some((side) => pathsOverlap(path.resolve(leased), side))),
    );
    const leaseTags = covering.map((l) => l.tag);

    if (!probe || !probe.realPath) reasons.push('path-unreadable');
    if (wt.locked) reasons.push('locked');
    for (const other of registered) {
      if (other !== wt.path && other.startsWith(`${wt.path}/`)) reasons.push(`contains-worktree:${other}`);
    }
    const ignoredLeases: string[] = [];
    for (const l of covering) {
      if (!isLeaseLive(l, input.nowMs)) continue;
      if (!neverExpiringLeaseHonored(l, published)) ignoredLeases.push(`${l.tag}:never-expires,older-than-${published?.version}`);
      else reasons.push(`lease:${l.tag}`);
    }
    if (published) {
      const backsHead = !!published.gitSha && !!wt.head && wt.head.startsWith(published.gitSha.slice(0, 12));
      const backsLease = covering.some((l) => l.version === published.version);
      if (backsHead || backsLease) reasons.push(`latest-published:${published.version}`);
      const v = probe?.desktopVersion ?? null;
      if (v) {
        const cmp = compareVersions(v, published.version);
        if (cmp === null || cmp > 0) reasons.push(`unreleased-version:${v}`);
      }
    }
    const created = probe?.createdAtMs ?? null;
    if (created === null) reasons.push('unknown-age');
    else if (latestCutAtMs !== null && created > latestCutAtMs) reasons.push('newer-than-latest-release');
    const moved = probe?.lastHeadMoveMs ?? null;
    if (moved !== null && input.nowMs - moved < input.minIdleHours * 3_600_000) {
      reasons.push(`recent-checkout:${Math.floor((input.nowMs - moved) / 3_600_000)}h`);
    }
    for (const h of input.holders.holders.get(wt.path) ?? []) reasons.push(`in-use:${h}`);

    if (reasons.length === 0) {
      const work = input.authored.get(wt.path);
      if (!work) reasons.push(AUTHORED_UNCHECKED);
      else if (!work.ok) reasons.push(`authored-work-unverified:${work.reason}`);
      else if (work.authored.length) reasons.push(`authored:${work.authored.slice(0, 5).join(',')}${work.authored.length > 5 ? `,+${work.authored.length - 5}` : ''}`);
    }

    verdicts.push({
      path: wt.path,
      realPath: probe?.realPath ?? null,
      onRootFs: probe?.onRootFs ?? null,
      head: wt.head,
      version: probe?.desktopVersion ?? null,
      leaseTags,
      ignoredLeases,
      createdAt: iso(created),
      lastHeadMoveAt: iso(moved),
      disposition: reasons.length ? 'protected' : leaseTags.length ? 'reclaimable' : 'named-only',
      reasons,
    });
  }
  return {
    canonicalRoot: main?.path ?? null,
    latestPublished: published?.version ?? null,
    failClosed,
    skipped: { autoManaged, prunable },
    verdicts,
  };
}

/** Validate the caller's named targets against a FRESH plan: all-or-nothing. */
export function resolveReclaimTargets(
  plan: ReclaimPlan,
  targets: readonly string[],
): { ok: true; verdicts: ReclaimVerdict[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const chosen = new Map<string, ReclaimVerdict>();
  for (const raw of targets) {
    const t = path.resolve(raw);
    const v = plan.verdicts.find((x) => x.path === t || x.realPath === t);
    if (!v) problems.push(`${raw}: not a registered, unmanaged cut worktree in this plan`);
    else if (v.disposition === 'protected') problems.push(`${raw}: protected (${v.reasons.join('; ')})`);
    else chosen.set(v.path, v);
  }
  if (!targets.length) problems.push('no targets named');
  return problems.length ? { ok: false, problems } : { ok: true, verdicts: [...chosen.values()] };
}

// ---------------------------------------------------------------- host probes (effectful)

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/**
 * Every git call in this module runs inside the operator host (release:cut), so it must
 * never spawn synchronously: a sync spawn freezes the host's main event loop for the child's
 * whole lifetime. On 2026-10-02 05:30Z the per-tree + per-submodule inspectAuthoredWork pass
 * held :3170's loop for 24s and the event-loop sentinel SIGKILLed the host (WI-10005315,
 * owner directive #1155). Guarded by release-cut-reclaim.test.ts ("never blocks the event loop").
 */
async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return String(stdout);
}

/**
 * Batched git reads (EI-24849983022443070). A child_process spawn costs the operator host
 * time SYNCHRONOUSLY on its main thread, and the cost grows with the host's RSS: libuv
 * forks, copying the parent's page tables. Measured 2026-10-02 07:41Z: 9.45 ms per spawn at
 * 245MB RSS, 162 ms at 1.97GB; :3170 runs at ~1.74GB. One reclaim plan used to spawn git
 * ~1,900 times directly (24 trees x (4 + 2 per submodule x 38)). Width-bounding could not
 * hide that, because the fork itself is synchronous, so the dry-run outran release:cut's
 * 60s budget (83.5s on :3170 after width-bounding, 183s before).
 *
 * So each pass over a tree runs in ONE small `sh`: the shell forks the gits from its own
 * ~2MB image, and the host forks once per helper. Each command's output is followed by a
 * frame `\0<nonce> <tag> <exit>\0`. The nonce is 128 random bits, so no path or ref name
 * can forge a frame, and the NUL-delimited porcelain -z bodies pass through unmodified.
 * On a timeout execFile destroys the pipes before killing the shell, so a git still
 * writing dies of SIGPIPE.
 */
// HELPER_FRAME_FN / parseHelperFrames / nextForkSlot live in ./git-batch (shared fork gate).

/** args: nonce tree canonicalRoot. Tags: status, head, contains, submodules. */
export const AUTHORED_HEAD_SCRIPT = [
  'n=$1; t=$2; c=$3',
  HELPER_FRAME_FN,
  'git -C "$t" status --porcelain=v2 -z --ignore-submodules=none; f status $?',
  'h=$(git -C "$t" rev-parse HEAD); r=$?; printf %s "$h"; f head $r',
  '[ "$r" -eq 0 ] || exit 0',
  "git -C \"$c\" for-each-ref --count=1 \"--contains=$h\" --format='%(refname)'; f contains $?",
  'git -C "$t" submodule status --recursive; f submodules $?',
].join('\n');

/** args: nonce tree canonicalRoot, then (sha, rel) pairs. Tags: status:<i>, present:<i>. */
export const AUTHORED_SUBMODULES_SCRIPT = [
  'n=$1; t=$2; c=$3; shift 3; i=0',
  HELPER_FRAME_FN,
  'while [ $# -ge 2 ]; do',
  '  git -C "$t/$2" status --porcelain=v2 -z --ignore-submodules=all; f "status:$i" $?',
  '  git -C "$c/$2" cat-file -e "$1^{commit}" 2>/dev/null; f "present:$i" $?',
  '  i=$((i+1)); shift 2',
  'done',
].join('\n');

export interface HelperResult {
  /** the section's output; throws if the section is missing or its command failed */
  take(tag: string): string;
  /** the section's exit status; throws only if the section is missing */
  exitOf(tag: string): number;
}

export function helperResult(sections: HelperSection[], stderr = ''): HelperResult {
  const byTag = new Map(sections.map((s) => [s.tag, s]));
  const get = (tag: string) => {
    const s = byTag.get(tag);
    if (!s) throw new Error(`git helper output has no '${tag}' section (helper died early)`);
    return s;
  };
  return {
    take(tag) {
      const s = get(tag);
      if (s.exit !== 0) {
        const why = stderr.split('\n').find((l) => l.trim()) ?? '';
        throw new Error(`git ${tag} failed (exit ${s.exit})${why ? `: ${why}` : ''}`);
      }
      return s.out;
    },
    exitOf: (tag) => get(tag).exit,
  };
}

async function runGitHelper(script: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<HelperResult> {
  await nextForkSlot();
  const nonce = randomBytes(16).toString('hex');
  const { stdout, stderr } = await execFileAsync('sh', ['-c', script, 'release-cut-reclaim', nonce, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return helperResult(parseHelperFrames(String(stdout), nonce), String(stderr));
}

/** Split into at most `parts` contiguous, near-equal chunks, preserving order. */
export function contiguousChunks<T>(items: readonly T[], parts: number): T[][] {
  const size = Math.ceil(items.length / Math.max(1, Math.floor(parts)));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errText = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] ?? e.message : String(e)).slice(0, 160);

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function mtimeOrNull(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Timestamp (ms) of the NEWEST entry in a reflog file, or null when the file is missing,
 * empty, or its last line is not a reflog entry. A reflog line is
 * `<old> <new> <name> <email> <epoch-seconds> <tz>\t<message>`; only the tail is read,
 * since a long-lived reflog can be large.
 */
export function lastReflogEntryMs(logPath: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim() !== '');
    const last = lines[lines.length - 1];
    const m = last ? /\s(\d{9,})\s[+-]\d{4}(?:\t|$)/.exec(last.split('\t')[0] ?? '') : null;
    return m?.[1] ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** `.git` FILE of a linked worktree → its admin dir (`<common>/worktrees/<name>`). */
export function worktreeAdminDir(worktreePath: string): string | null {
  try {
    const text = fs.readFileSync(path.join(worktreePath, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    return m?.[1] ? path.resolve(worktreePath, m[1].trim()) : null;
  } catch {
    return null;
  }
}

export function probeTree(worktreePath: string, rootDev: number | null): TreeProbe {
  const realPath = realpathOrNull(worktreePath);
  let offloaded = false;
  try {
    offloaded = fs.lstatSync(worktreePath).isSymbolicLink();
  } catch {
    offloaded = false;
  }
  let onRootFs: boolean | null = null;
  try {
    if (realPath && rootDev !== null) onRootFs = fs.statSync(realPath).dev === rootDev;
  } catch {
    onRootFs = null;
  }
  const adminDir = worktreeAdminDir(worktreePath);
  let createdAtMs: number | null = null;
  if (adminDir) {
    try {
      const b = fs.statSync(adminDir).birthtimeMs;
      createdAtMs = b > 0 ? b : null;
    } catch {
      createdAtMs = null;
    }
  }
  // The reflog FILE's mtime is not a checkout signal: `git gc` / `reflog expire` rewrite
  // every worktree's logs/HEAD in one pass (measured 2026-09-30 06:46:59Z — all 31 trees
  // got the same mtime and every one read as `recent-checkout`). Use the timestamp of
  // the newest reflog ENTRY instead, plus HEAD's own mtime (gc never rewrites HEAD).
  const moves = adminDir
    ? [mtimeOrNull(path.join(adminDir, 'HEAD')), lastReflogEntryMs(path.join(adminDir, 'logs', 'HEAD'))].filter(
        (x): x is number => x !== null,
      )
    : [];
  let desktopVersion: string | null = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, 'papercusp-desktop', 'package.json'), 'utf8'));
    desktopVersion = typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    desktopVersion = null;
  }
  return {
    realPath,
    offloaded,
    onRootFs,
    adminDir,
    createdAtMs,
    lastHeadMoveMs: moves.length ? Math.max(...moves) : null,
    desktopVersion,
  };
}

export interface HolderTarget {
  key: string;
  prefixes: string[];
}

/**
 * ONE /proc walk: cwd, root, exe and every fd of every visible process, matched against
 * each target's prefixes (registered path and realpath). Positive controls, both required:
 * the walk must find THIS process holding its own cwd, and this process must sit in the
 * root PID namespace (a nested namespace sees only its own processes — a confident false
 * idle, the trap measured on this box, memory 41104d77).
 */
export async function scanProcHolders(targets: HolderTarget[], procRoot = '/proc', deps: {
  scan?: typeof import('./storage/disk-reclaim').scanRetentionHolders;
} = {}): Promise<HolderScan> {
  // A full host walk ran for 604s in a standing pass, versus 5.2s in an isolated
  // child. Reuse the enrolled privileged worker and its existing deadline,
  // original-caller control and fail-closed reads. The operator never walks FDs.
  const holders = new Map<string, string[]>();
  try {
    const status = await fs.promises.readFile(path.join(procRoot, 'self', 'status'), 'utf8');
    const nspid = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
    if (nspid.length !== 1) return { verified: false, reason: `nested-pid-namespace-or-missing(${nspid.join('/')})`, holders };
  } catch (e) {
    return { verified: false, reason: `self-status-unreadable:${errText(e)}`, holders };
  }
  const control = process.cwd();
  const prefixes = [...new Set(targets.flatMap((target) => target.prefixes))];
  let scan: OpenWriterScan;
  try {
    scan = procRoot === '/proc'
      ? await (deps.scan ?? (await import('./storage/disk-reclaim')).scanRetentionHolders)(prefixes, {
        isolate: true, includeProcessLinks: true,
      })
      : await openWriterPidsMany([...prefixes, control], {
        procRoot, descendants: true, includeProcessLinks: true, failClosed: true, deadlineMs: 30_000,
      });
  } catch (e) { return { verified: false, reason: `holder-worker:${errText(e)}`, holders }; }
  for (const target of targets) {
    const pids = [...new Set(target.prefixes.flatMap((prefix) => scan.byPath.get(prefix) ?? []))]
      .sort((a, b) => Number(a) - Number(b));
    if (pids.length) holders.set(target.key, pids.slice(0, 3).map((pid) => `pid ${pid} reference`));
  }
  const diagnostics = scan.diagnostics;
  if (!scan.complete) return { verified: false,
    reason: `holder-scan-incomplete:${diagnostics?.reason ?? JSON.stringify(diagnostics ?? {})}`, holders, diagnostics };
  if (!scan.byPath.get(control)?.includes(String(process.pid))) {
    return { verified: false, reason: 'positive-control-failed(own cwd not seen)', holders, diagnostics };
  }
  return { verified: true, holders, diagnostics };
}

/**
 * Authored work inside a tree, recursively through its submodules. Fails CLOSED: any git
 * error returns ok:false, which the planner turns into a protection.
 */
export async function inspectAuthoredWork(
  tree: string,
  canonicalRoot: string,
  releaseVersionPaths: readonly string[],
  opts: { submoduleConcurrency?: number } = {},
): Promise<AuthoredWork> {
  try {
    const authored: string[] = [];
    let machineWritten = 0;
    const judge = (entries: StatusEntry[]) => {
      for (const e of entries) {
        if (e.submodule) continue;
        if (machineWrittenRule(e.path, releaseVersionPaths)) machineWritten++;
        else authored.push(e.path);
      }
    };
    // Pass 1, one helper: the tree's own status, its HEAD, whether a canonical ref contains
    // that HEAD, and the submodule list (parsed here, so the shell never parses anything).
    const top = await runGitHelper(AUTHORED_HEAD_SCRIPT, [tree, canonicalRoot]);
    judge(parsePorcelainV2(top.take('status')));
    const head = top.take('head').trim();
    const containing = top.take('contains').trim();
    if (!containing) authored.push(`HEAD ${head.slice(0, 10)} (no ref contains it)`);
    const subs: Array<{ sha: string; rel: string }> = [];
    for (const line of top.take('submodules').split('\n')) {
      const m = /^([ +\-U])([0-9a-f]{40}) (.+?)(?: \(.*\))?$/.exec(line);
      if (!m || m[1] === '-') continue;
      const [, , sha, rel] = m as unknown as [string, string, string, string];
      subs.push({ sha, rel });
    }
    // Pass 2: every submodule's status plus whether its commit exists in the canonical
    // checkout, in contiguous chunks with one helper each (default one chunk). Results are
    // judged in submodule order so the outcome is deterministic. A failure is RETURNED, not
    // thrown, so no sibling helper is left running after this call has decided ok:false.
    const chunks = contiguousChunks(subs, opts.submoduleConcurrency ?? AUTHORED_SUBMODULE_CONCURRENCY);
    const reads = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const r = await runGitHelper(AUTHORED_SUBMODULES_SCRIPT, [
            tree,
            canonicalRoot,
            ...chunk.flatMap(({ sha, rel }) => [sha, rel]),
          ]);
          const rows = chunk.map(({ sha, rel }, i) => ({
            sha,
            rel,
            status: r.take(`status:${i}`),
            present: r.exitOf(`present:${i}`) === 0,
          }));
          return { rows, error: null as unknown };
        } catch (e) {
          return { rows: [], error: e };
        }
      }),
    );
    for (const { rows, error } of reads) {
      if (error !== null) throw error;
      for (const r of rows) {
        judge(parsePorcelainV2(r.status, r.rel));
        if (!r.present) authored.push(`${r.rel}@${r.sha.slice(0, 10)} (commit absent from canonical checkout)`);
      }
    }
    return { ok: true, authored, machineWritten };
  } catch (e) {
    return { ok: false, reason: errText(e) };
  }
}

export interface ReleaseRecordSource {
  (): Promise<ReleaseRecord[]>;
}

export interface GatherOptions {
  isAutoManaged: (worktreePath: string) => boolean;
  releaseVersionPaths: readonly string[];
  loadReleases: ReleaseRecordSource;
  /** any path inside the repo; the MAIN worktree is derived from its worktree list */
  repoPath: string;
  /** Inspect only named registered trees; retain the full registry for containment guards. */
  targets?: readonly string[];
  retentionDir?: string;
  minIdleHours?: number;
  nowMs?: number;
  /** trees whose authored-work read runs at once (default AUTHORED_TREE_CONCURRENCY) */
  authoredConcurrency?: number;
  /** test seams (sync or async; the defaults are async so the host's event loop keeps running) */
  listWorktrees?: (repoPath: string) => ReclaimWorktree[] | Promise<ReclaimWorktree[]>;
  probe?: (worktreePath: string) => TreeProbe;
  scanHolders?: (targets: HolderTarget[]) => HolderScan | Promise<HolderScan>;
  authoredWork?: (tree: string, canonicalRoot: string) => AuthoredWork | Promise<AuthoredWork>;
  readLeases?: (dir: string) => { leases: RetentionLease[]; errors: string[] };
  /** Optional, path-free phase diagnostics for the live release:cut handler. */
  onPhase?: (event: ReclaimPhaseTiming) => void;
}

export interface ReclaimPhaseTiming {
  phase: string;
  stage: 'start' | 'finish';
  elapsedMs?: number;
  outcome?: 'fulfilled' | 'rejected';
  diagnostics?: OpenWriterScan['diagnostics'];
}

function emitReclaimPhase(onPhase: GatherOptions['onPhase'], event: ReclaimPhaseTiming): void {
  try {
    onPhase?.(event);
  } catch {
    // Diagnostics must never change the read-only plan or its failure behavior.
  }
}

function measureReclaimPhaseSync<T>(
  onPhase: GatherOptions['onPhase'],
  phase: string,
  operation: () => T,
): T {
  if (!onPhase) return operation();
  emitReclaimPhase(onPhase, { phase, stage: 'start' });
  const startedAt = performance.now();
  try {
    const value = operation();
    emitReclaimPhase(onPhase, {
      phase,
      stage: 'finish',
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      outcome: 'fulfilled',
    });
    return value;
  } catch (error) {
    emitReclaimPhase(onPhase, {
      phase,
      stage: 'finish',
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      outcome: 'rejected',
    });
    throw error;
  }
}

async function measureReclaimPhaseAsync<T>(
  onPhase: GatherOptions['onPhase'],
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!onPhase) return operation();
  emitReclaimPhase(onPhase, { phase, stage: 'start' });
  const startedAt = performance.now();
  try {
    const value = await operation();
    emitReclaimPhase(onPhase, {
      phase,
      stage: 'finish',
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      outcome: 'fulfilled',
    });
    return value;
  } catch (error) {
    emitReclaimPhase(onPhase, {
      phase,
      stage: 'finish',
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
      outcome: 'rejected',
    });
    throw error;
  }
}

/** Two-phase: every cheap protection first, then the git-heavy authored-work read only
 *  for the trees still standing. */
export async function gatherCutReclaimPlan(opts: GatherOptions): Promise<ReclaimPlan> {
  const nowMs = opts.nowMs ?? Date.now();
  const worktrees = await measureReclaimPhaseAsync(opts.onPhase, 'worktree-enumeration', () =>
    Promise.resolve(
      (opts.listWorktrees ??
        (async (r: string) => parseWorktreePorcelain(await git(r, ['worktree', 'list', '--porcelain'], 10_000))))(
        opts.repoPath,
      ),
    ),
  );
  const selected = opts.targets?.length ? new Set(opts.targets.map((p) => path.resolve(p))) : null;
  const includes = (p: string) => selected === null || selected.has(path.resolve(p));
  const probes = new Map<string, TreeProbe>();
  measureReclaimPhaseSync(opts.onPhase, 'tree-probes', () => {
    let rootDev: number | null = null;
    try {
      rootDev = fs.statSync('/').dev;
    } catch {
      rootDev = null;
    }
    const probe = opts.probe ?? ((p: string) => probeTree(p, rootDev));
    for (const w of worktrees.slice(1)) if (!w.prunable && includes(w.path)) probes.set(w.path, probe(w.path));
  });
  const { leases, errors } = measureReclaimPhaseSync(opts.onPhase, 'retention-leases', () =>
    (opts.readLeases ?? readRetentionLeases)(opts.retentionDir ?? defaultRetentionDir()),
  );
  let releases: ReleaseRecord[] | { error: string };
  try {
    releases = await measureReclaimPhaseAsync(opts.onPhase, 'release-records', opts.loadReleases);
  } catch (e) {
    releases = { error: errText(e) };
  }
  const holderTargets: HolderTarget[] = [...probes.entries()].map(([key, p]) => ({
    key,
    prefixes: [key, ...(p.realPath && p.realPath !== key ? [p.realPath] : [])],
  }));
  const holders = await measureReclaimPhaseAsync(opts.onPhase, 'holder-scan', () =>
    Promise.resolve((opts.scanHolders ?? scanProcHolders)(holderTargets)),
  );
  if (holders.diagnostics) emitReclaimPhase(opts.onPhase, {
    phase: 'holder-scan-evidence', stage: 'finish', diagnostics: holders.diagnostics,
  });
  const base = {
    nowMs,
    minIdleHours: opts.minIdleHours ?? DEFAULT_MIN_IDLE_HOURS,
    worktrees,
    isAutoManaged: opts.isAutoManaged,
    leases,
    leaseErrors: errors,
    releases,
    probes,
    holders,
  };
  const cheap = measureReclaimPhaseSync(opts.onPhase, 'cheap-plan', () => planCutReclaim({ ...base, authored: new Map() }));
  const canonicalRoot = cheap.canonicalRoot;
  const authored = new Map<string, AuthoredWork>();
  if (canonicalRoot) {
    const inspect =
      opts.authoredWork ?? ((tree: string, canon: string) => inspectAuthoredWork(tree, canon, opts.releaseVersionPaths));
    const { pending, results } = await measureReclaimPhaseAsync(opts.onPhase, 'authored-work', async () => {
      const pending = cheap.verdicts
        .filter((v) => includes(v.path) && v.reasons.length === 1 && v.reasons[0] === AUTHORED_UNCHECKED)
        .map((v) => v.path);
      const results = await mapWithConcurrency(
        pending,
        opts.authoredConcurrency ?? AUTHORED_TREE_CONCURRENCY,
        async (tree) => inspect(tree, canonicalRoot),
      );
      return { pending, results };
    });
    pending.forEach((tree, i) => authored.set(tree, results[i] as AuthoredWork));
  }
  const result = measureReclaimPhaseSync(opts.onPhase, 'final-plan', () => planCutReclaim({ ...base, authored }));
  if (canonicalRoot) {
    const recovered = measureReclaimPhaseSync(opts.onPhase, 'interrupted-receipt-scan', () =>
      readInterruptedCutReclaims(path.join(opts.retentionDir ?? defaultRetentionDir(), 'reclaim-archive'), canonicalRoot),
    );
    result.interrupted = recovered.interrupted.filter((r) => includes(r.path) || includes(r.trash));
    result.failClosed.push(...recovered.errors.map((error) => `reclaim-receipt-unreadable:${error}`));
  }
  if (selected === null) return result;
  return measureReclaimPhaseSync(opts.onPhase, 'target-filter', () => {
    const verdicts = result.verdicts.filter((v) => includes(v.path));
    const found = new Set(verdicts.map((v) => path.resolve(v.path)));
    return {
      ...result,
      verdicts,
      failClosed: [...result.failClosed, ...[...selected].filter((p) => !found.has(p)).map((p) => `target-not-inspectable:${p}`)],
    };
  });
}

// ---------------------------------------------------------------- removal (effectful)

export interface ReclaimExecDeps {
  /** Standing reclaim's single durable census slot; direct callers may measure inline. */
  usageWalk?: Omit<DetachedWalkOptions, 'signal'>;
  /** Re-read published/authored/lease/holder protection after adopting a measurement. */
  refreshPlan?: () => Promise<ReclaimPlan>;
  /** Set by a caller that already holds papercusp-disk-retention (the scheduled adapter). */
  retentionMutexHeld?: boolean;
  /** Stop admitting removals at this shared run deadline; finish an admitted rename/removal. */
  notAfterMs?: number;
  /** Re-read under the retention mutex immediately before destructive work. */
  pinProtection?: (path: string) => boolean;
  nowMs?: () => number;
  scanHolders?: (targets: HolderTarget[]) => HolderScan | Promise<HolderScan>;
  archive?: (tree: string, outFile: string) => void | Promise<void>;
  recordRemoval?: (archive: string, receipt: CutReclaimReceipt) => void;
  gitCommonDir?: (canonicalRoot: string) => string | Promise<string>;
  rename?: (from: string, to: string) => void;
  unlink?: (p: string) => void;
  rmrf?: (p: string) => Promise<void>;
  appendAudit?: (line: string) => void;
  archiveDir?: string;
  auditFile?: string;
}

export interface ReclaimExecResult {
  path: string;
  removed: boolean;
  archive?: string;
  reason?: string;
  ms: number;
}

/** Run git and STREAM its stdout into `out` (left open), with no size ceiling. The buffered
 *  {@link git} helper caps stdout at GIT_MAX_BUFFER, which a staged sidecar's binary diff
 *  (158 MB, WI-10006139) exceeds — so archive output never goes through it. Async, so the
 *  host event loop keeps running (WI-10005315). */
function gitStreamInto(cwd: string, args: string[], out: fs.WriteStream, timeout = GIT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.stdout.pipe(out, { end: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} in ${cwd} exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

/** Tracked diffs of the superproject and every initialized submodule, so a removal is
 *  recoverable at the patch level. Streamed to disk, so a diff of any size archives.
 *  Throws on any failure (and removes the partial archive) — the caller refuses removal. */
export async function archiveTreeDiffs(tree: string, outFile: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const head = (await git(tree, ['rev-parse', 'HEAD'])).trim();
  const submodules: Array<{ rel: string; sha: string }> = [];
  for (const line of (await git(tree, ['submodule', 'status', '--recursive'])).split('\n')) {
    const m = /^([ +\-U])([0-9a-f]{40}) (.+?)(?: \(.*\))?$/.exec(line);
    if (!m || m[1] === '-') continue;
    submodules.push({ rel: m[3] as string, sha: m[2] as string });
  }
  const out = fs.createWriteStream(outFile);
  let streamError: Error | null = null;
  out.on('error', (e) => {
    streamError = e;
  });
  const check = () => {
    if (streamError) throw streamError;
  };
  try {
    out.write(`# reclaim archive of ${tree} at ${new Date().toISOString()}\n## HEAD ${head}\n`);
    await gitStreamInto(tree, ['diff', '--binary', 'HEAD'], out);
    check();
    for (const { rel, sha } of submodules) {
      out.write(`\n## submodule ${rel} ${sha}\n`);
      await gitStreamInto(path.join(tree, rel), ['diff', '--binary', 'HEAD'], out);
      check();
    }
    await new Promise<void>((resolve, reject) => {
      if (streamError) return reject(streamError);
      out.once('error', reject);
      out.end(() => resolve());
    });
  } catch (e) {
    out.destroy();
    await fs.promises.rm(outFile, { force: true });
    throw e;
  }
}

async function executeCutReclaimUnlocked(
  plan: ReclaimPlan,
  targets: readonly string[],
  deps: ReclaimExecDeps = {},
): Promise<{ ok: false; refused: true; problems: string[] } | { ok: true; results: ReclaimExecResult[] }> {
  const resolved = resolveReclaimTargets(plan, targets);
  if (!resolved.ok) return { ok: false, refused: true, problems: resolved.problems };
  const canonicalRoot = plan.canonicalRoot;
  if (!canonicalRoot) return { ok: false, refused: true, problems: ['canonical worktree unknown'] };
  const now = deps.nowMs ?? Date.now;
  const commonDir = path.resolve(
    canonicalRoot,
    await (deps.gitCommonDir ?? (async (r: string) => (await git(r, ['rev-parse', '--git-common-dir'], 10_000)).trim()))(
      canonicalRoot,
    ),
  );
  const archiveDir = deps.archiveDir ?? path.join(defaultRetentionDir(), 'reclaim-archive');
  const auditFile = deps.auditFile ?? path.join(defaultRetentionDir(), 'deletion-audit.tsv');
  const results: ReclaimExecResult[] = [];
  const isPinned = deps.pinProtection ?? (() => false);
  const deadlineExhausted = () => deps.notAfterMs !== undefined &&
    (!Number.isFinite(deps.notAfterMs) || now() >= deps.notAfterMs);
  const deadlineReason = 'release-cut execution run deadline exhausted; resume with a fresh plan';
  for (const v of resolved.verdicts) {
    const started = now();
    const done = (r: Omit<ReclaimExecResult, 'path' | 'ms'>) => results.push({ path: v.path, ms: now() - started, ...r });
    if (deadlineExhausted()) {
      done({ removed: false, reason: deadlineReason });
      continue;
    }
    const real = v.realPath ?? v.path;
    if (isPinned(v.path) || (real !== v.path && isPinned(real))) {
      done({ removed: false, reason: 'active retention pin' });
      continue;
    }
    const offloaded = real !== v.path;
    // realpath can differ because a PARENT is symlinked. Only a symlink at
    // the worktree itself needs unlinking after the real directory is moved.
    let leafSymlink = false;
    // Safety rails independent of the plan: a linked worktree only (a `.git` FILE), whose
    // admin dir sits under this repo's worktrees/, never the canonical tree or an ancestor.
    let adminDir: string | null = null;
    try {
      leafSymlink = fs.lstatSync(v.path).isSymbolicLink();
      if (!fs.lstatSync(path.join(real, '.git')).isFile()) throw new Error('.git is not a file');
      adminDir = worktreeAdminDir(real);
    } catch (e) {
      done({ removed: false, reason: `not a linked worktree: ${errText(e)}` });
      continue;
    }
    if (!adminDir || !adminDir.startsWith(`${path.join(commonDir, 'worktrees')}/`)) {
      done({ removed: false, reason: `admin dir ${adminDir ?? '?'} is not under ${commonDir}/worktrees` });
      continue;
    }
    const pathRefusal =
      reclaimPathRefusal(real, canonicalRoot, os.homedir()) ??
      (offloaded ? reclaimPathRefusal(v.path, canonicalRoot, os.homedir()) : null);
    if (pathRefusal) {
      done({ removed: false, reason: pathRefusal });
      continue;
    }
    const fresh = await (deps.scanHolders ?? scanProcHolders)([
      { key: v.path, prefixes: offloaded ? [v.path, real] : [v.path] },
    ]);
    if (!fresh.verified || (fresh.holders.get(v.path) ?? []).length) {
      done({
        removed: false,
        reason: fresh.verified ? `in use: ${(fresh.holders.get(v.path) ?? []).join(', ')}` : `holder scan unverified: ${fresh.reason}`,
      });
      continue;
    }
    if (deadlineExhausted()) {
      done({ removed: false, reason: deadlineReason });
      continue;
    }
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const archive = path.join(archiveDir, `${stamp}-${path.basename(v.path)}.patch`);
    try {
      await (deps.archive ?? archiveTreeDiffs)(real, archive);
    } catch (e) {
      done({ removed: false, reason: `archive failed: ${errText(e)}` });
      continue;
    }
    if (deadlineExhausted()) {
      done({ removed: false, archive, reason: deadlineReason });
      continue;
    }
    // From the durable removal receipt through physical deletion and Git bookkeeping,
    // finish this one admitted operation even if it crosses the deadline. The next
    // target must return to a fresh plan and its current pin/holder checks.
    const trash = path.join(path.dirname(real), `.reclaim-trash-${path.basename(real)}-${stamp}`);
    try {
      const stat = fs.lstatSync(real);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('worktree identity changed');
      (deps.recordRemoval ?? recordCutReclaim)(archive, {
        schema: 'papercusp-cut-reclaim/v1', canonicalRoot, path: v.path, realPath: real,
        trash, adminDir, device: String(stat.dev), inode: String(stat.ino),
      });
    } catch (e) {
      done({ removed: false, archive, reason: `removal receipt failed: ${errText(e)}` });
      continue;
    }
    try {
      (deps.rename ?? fs.renameSync)(real, trash);
    } catch (e) {
      done({ removed: false, archive, reason: `rename aside failed: ${errText(e)}` });
      continue;
    }
    const rmrf = deps.rmrf ?? ((p: string) => fs.promises.rm(p, { recursive: true, force: true }));
    try {
      await rmrf(trash);
      // Keep Git's identity until the physical allocation is gone. A failed tree
      // deletion stays associated with its retained archive and admin metadata.
      if (leafSymlink) (deps.unlink ?? fs.unlinkSync)(v.path);
      await rmrf(adminDir);
    } catch (e) {
      done({ removed: false, archive, reason: `partial removal (tree moved to ${trash}): ${errText(e)}` });
      continue;
    }
    try {
      const line = [
        new Date(now()).toISOString(),
        `pid=${process.pid}`,
        `deleter=${RECLAIM_DELETER}`,
        'decision=allow',
        `path=${v.path}${offloaded ? ` (real ${real})` : ''}`,
        'lease=none',
        `reason=${v.disposition} worktree reclaimed; archive ${archive}`,
      ].join('\t');
      (deps.appendAudit ?? ((l: string) => fs.appendFileSync(auditFile, `${l}\n`)))(line);
    } catch {
      // the tool-level audit_log row still records the removal
    }
    done({ removed: true, archive });
  }
  return { ok: true, results };
}

/** Direct release:cut callers must serialize the final pin read and deletion with storage:pin.
 * The scheduled disk-reclaim adapter already owns this mutex and opts out to avoid a nested
 * lock deadlock. The re-read closes the plan/read-to-delete race when a pin lands after planning. */
export async function executeCutReclaim(
  plan: ReclaimPlan,
  targets: readonly string[],
  deps: ReclaimExecDeps = {},
): Promise<{ ok: false; refused: true; problems: string[] } | { ok: true; results: ReclaimExecResult[] }> {
  if (deps.retentionMutexHeld) return executeCutReclaimUnlocked(plan, targets, deps);
  return withRetentionPinProtection((isPinned) =>
    executeCutReclaimUnlocked(plan, targets, { ...deps, retentionMutexHeld: true, pinProtection: isPinned }),
  );
}

// Reuse the retention census's validated-record progress contract. --all exposes
// progress even inside one large flat directory; only root rows contribute bytes.
// Keep one du process so its inode table deduplicates hardlinks across roots.
type CutUsageProgress = {
  elapsedMs: number; metadataRecords: number; stdoutBytes: number; pendingBytes: number;
  completedRoots: number; totalRoots: number; lastMetadataPath: string | null;
  lastMetadataAgeMs: number | null;
};
function measureCutUsage(roots: readonly string[], notAfterMs: number): Promise<Map<string, number>> {
  return new Promise((resolve, reject) => {
    const bytes = new Map<string, number>();
    let pending = '', stderr = '', failure: string | undefined, settled = false;
    const startedAt = performance.now();
    let metadataRecords = 0, stdoutBytes = 0, lastMetadataAt: number | null = null;
    let lastMetadataPath: string | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout>;
    if (!Number.isFinite(notAfterMs) || notAfterMs <= Date.now()) {
      reject(new Error('release-cut usage run deadline exhausted')); return;
    }
    const child = spawn('du', ['--all', '--one-file-system', '--block-size=1', '--null', '--', ...roots], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error); else resolve(bytes);
    };
    deadlineTimer = setTimeout(() => stop('release-cut usage run deadline exhausted'), notAfterMs - Date.now());
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      stdoutBytes += Buffer.byteLength(chunk);
      const rows = (pending + chunk).split('\0'); pending = rows.pop() ?? '';
      for (const row of rows) {
        const tab = row.indexOf('\t'), value = row.slice(0, tab), p = row.slice(tab + 1), n = Number(value);
        if (tab < 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(n) ||
            path.resolve(p) !== p || !roots.some((root) => p === root || p.startsWith(`${root}/`)) || bytes.has(p)) {
          stop('invalid release-cut usage output'); return;
        }
        metadataRecords++;
        lastMetadataAt = performance.now();
        lastMetadataPath = p.slice(-1024);
        if (roots.includes(p)) bytes.set(p, n);
      }
      // Bound an unterminated row, not the streamed population. Partial records
      // and stderr noise cannot advance the last-metadata timestamp.
      if (pending.length > 64 * 1024) { stop('oversized release-cut usage record'); return; }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (!failure && (code !== 0 || signal)) failure = 'release-cut usage command failed';
      if (!failure && (pending || bytes.size !== roots.length)) failure = 'incomplete release-cut usage output';
      if (!failure && !Number.isSafeInteger([...bytes.values()].reduce((sum, n) => sum + n, 0))) {
        failure = 'release-cut usage exceeds safe integer bytes';
      }
      const now = performance.now();
      const usageProgress: CutUsageProgress = {
        elapsedMs: Math.floor(now - startedAt), metadataRecords, stdoutBytes,
        pendingBytes: Buffer.byteLength(pending), completedRoots: bytes.size, totalRoots: roots.length,
        lastMetadataPath, lastMetadataAgeMs: lastMetadataAt === null ? null : Math.floor(now - lastMetadataAt),
      };
      finish(failure ? Object.assign(new Error(failure), { code, signal, killed: child.killed, stderr, usageProgress }) : undefined);
    });
  });
}

/** One slot per canonical repository, independent of population changes. A live obsolete
 * population must finish before replacement, otherwise each scheduled call forks more du.
 * The existing census lifetime also bounds the age of an unconsumed terminal receipt. */
async function measureDetachedCutUsage(roots: readonly string[], notAfterMs: number, opts: Omit<DetachedWalkOptions, 'signal'>) {
  const remaining = () => notAfterMs - Date.now();
  if (!Number.isFinite(notAfterMs) || remaining() <= 0) throw new Error('release-cut usage run deadline exhausted');
  return withFsMutex(`release-cut-usage:${path.resolve(opts.dir)}`, async () => {
    const state = await readWalkState(opts.dir);
    const terminal = !!state && !walkProcessAlive(state) && fs.existsSync(walkAttemptFiles(opts.dir, state.attempt).exit);
    const consumed = path.join(opts.dir, 'consumed');
    if (fs.existsSync(consumed)) {
      if (!terminal) throw new Error('release-cut usage previous measurement is still retiring');
      await fs.promises.rm(opts.dir, { recursive: true, force: true });
    } else if (!state && fs.existsSync(opts.dir) && (await fs.promises.readdir(opts.dir)).length) {
      throw new Error('release-cut usage slot has unreadable state');
    }
    const controller = new AbortController();
    const waitMs = Math.min(10_000, remaining());
    if (waitMs <= 0) throw new Error('release-cut usage run deadline exhausted');
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const run = () => runDetachedDuUsage(roots, { ...opts, pollMs: Math.min(opts.pollMs ?? 250, 250), signal: controller.signal });
      let result;
      try { result = await run(); }
      catch (e) {
        // A different root order or inode cannot adopt the old allocation table.
        // Retire only a terminal, dead worker; a live mismatch remains unknown.
        if (!terminal || !(e instanceof Error) || !e.message.includes('census walk request changed')) throw e;
        await fs.promises.rm(opts.dir, { recursive: true, force: true });
        result = await run();
      }
      if (!result.complete || !result.bytes || result.finishedAt === null) {
        const ended = await readWalkState(opts.dir);
        if (ended && fs.existsSync(walkAttemptFiles(opts.dir, ended.attempt).exit)) {
          await fs.promises.writeFile(consumed, 'failed\n');
        }
        throw new Error(result.error ?? 'incomplete release-cut usage measurement');
      }
      // Mark consumed BEFORE effects. A crash or a subsequent removal can never
      // turn the old before-reclaim allocation into a fresh after-reclaim total.
      await fs.promises.writeFile(consumed, 'consumed\n');
      if (Date.now() - result.finishedAt > CENSUS_DU_TIMEOUT_MS ||
          !Number.isSafeInteger([...result.bytes.values()].reduce((sum, n) => sum + n, 0))) {
        throw new Error('stale or unsafe release-cut usage measurement');
      }
      return result.bytes;
    } catch (e) {
      if (e instanceof DetachedWalkAbandoned) throw new Error('release-cut usage pending; managed census continues for adoption');
      throw e;
    } finally { clearTimeout(timer); }
  }, { timeoutMs: Math.max(1, Math.min(1000, remaining())), retryMs: 25 });
}

/** The scheduled adapter holds the pin mutex across discovery and this owner call.
 * A cap never overrides the existing published/authored/lease/holder guards. All
 * expired eligible cuts are still collected, even when usage is already below cap. */
export async function reclaimCutWorktrees(
  plan: ReclaimPlan,
  options: { dryRun?: boolean; maxBytes?: number; notAfterMs?: number } = {},
  deps: ReclaimExecDeps = {},
) {
  const notAfterMs = options.notAfterMs ?? Date.now() + DEFAULT_RECLAIM_RUN_BUDGET_MS;
  const maxBytes = options.maxBytes ?? retentionPolicyForWorkspaceRoot().find((c) => c.id === 'release-cut-worktrees')!.maxBytes!;
  const targets = plan.verdicts.filter((v) => v.disposition === 'reclaimable')
    .sort((a, b) => {
      const activity = (v: ReclaimVerdict) => Math.max(Date.parse(v.createdAt ?? '') || 0, Date.parse(v.lastHeadMoveAt ?? '') || 0);
      return activity(a) - activity(b) || a.path.localeCompare(b.path);
    }).map((v) => v.path);
  const pinnedPaths = plan.verdicts.filter((v) => v.reasons.some((r) => r.startsWith('lease:agent-pin-'))).map((v) => v.path);
  const cap: Omit<RetentionCapReceipt, 'beforeBytes' | 'afterBytes' | 'overByBytes' | 'pinnedBytes' | 'pinnedOverageBytes'> & {
    beforeBytes: number | null; afterBytes: number | null; overByBytes: number | null;
    pinnedBytes: number | null; pinnedOverageBytes: number | null; retainedPaths: string[];
  } = {
    root: plan.canonicalRoot ?? '', classId: 'release-cut-worktrees', maxBytes,
    beforeBytes: null, afterBytes: null, overByBytes: null, pinnedBytes: null,
    pinnedOverageBytes: null, pinnedPaths, retainedPaths: [],
  };
  const errors = [...plan.failClosed];
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) errors.push('invalid release-cut byte cap');
  if (plan.verdicts.some((v) => !v.realPath)) errors.push('release-cut population has unreadable paths');
  if (errors.length) return { ok: false, dryRun: !!options.dryRun, targets, errors, cap };
  const population = () => {
    const interrupted = readInterruptedCutReclaims(deps.archiveDir ?? path.join(defaultRetentionDir(), 'reclaim-archive'), plan.canonicalRoot!);
    if (interrupted.errors.length) throw new Error(interrupted.errors.join('; '));
    return [...new Set([
      ...plan.verdicts.map((v) => v.realPath!),
      ...(plan.interrupted ?? []).map((v) => v.trash),
      ...interrupted.interrupted.map((v) => v.trash),
    ])];
  };
  // GNU du supplies allocated bytes without following descendant symlinks or
  // opening FIFOs. The standing caller adopts one managed multi-root census;
  // direct callers retain the inline progress/deadline contract.
  const measure = async () => {
    const existing: string[] = [];
    for (const p of population()) {
      try { await fs.promises.lstat(p); existing.push(p); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    const roots = existing.filter((p) => !existing.some((other) => other !== p && p.startsWith(`${other}/`)));
    // du deduplicates hardlinks across arguments. Charge pinned roots first so
    // their still-allocated blocks cannot disappear into an evictable sibling's
    // count. The total still counts each shared allocation only once.
    const pinned = (p: string) => plan.verdicts.some((v) => pinnedPaths.includes(v.path) && pathsOverlap(p, v.realPath!));
    roots.sort((a, b) => Number(pinned(b)) - Number(pinned(a)) || a.localeCompare(b));
    if (!roots.length) return new Map<string, number>();
    return deps.usageWalk ? measureDetachedCutUsage(roots, notAfterMs, deps.usageWalk) : measureCutUsage(roots, notAfterMs);
  };
  // Error.message starts with du's complete argument list. Retain the actual
  // failure before that list consumes the bounded receipt's diagnostic budget.
  const usageFailure = (error: unknown): string => {
    const detail = error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown; usageProgress?: CutUsageProgress } | null;
    return JSON.stringify({ code: detail?.code ?? null, signal: detail?.signal ?? null,
      killed: detail?.killed === true,
      stderr: String(detail?.stderr ?? '').slice(-1024), usageProgress: detail?.usageProgress, message: errText(error) });
  };
  try {
    const before = await measure();
    if (deps.refreshPlan) {
      const fresh = await deps.refreshPlan();
      const guards = (p: ReclaimPlan) => JSON.stringify([p.canonicalRoot, p.failClosed, p.latestPublished,
        (p.interrupted ?? []).map(v => v.trash).sort(),
        p.verdicts.map(v => [v.path, v.realPath, v.head, v.disposition, v.reasons]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
      if (fresh.failClosed.length || guards(fresh) !== guards(plan)) {
        throw new Error('release-cut protection or population changed; resume with a fresh plan');
      }
    }
    cap.beforeBytes = [...before.values()].reduce((sum, n) => sum + n, 0);
    cap.pinnedBytes = [...before].filter(([p]) => plan.verdicts.some((v) => pinnedPaths.includes(v.path) && pathsOverlap(p, v.realPath!)))
      .reduce((sum, [, n]) => sum + n, 0);
    cap.pinnedOverageBytes = Math.max(0, cap.pinnedBytes - maxBytes);
    if (options.dryRun || (deps.usageWalk && targets.length === 0)) {
      cap.afterBytes = cap.beforeBytes;
      cap.overByBytes = Math.max(0, cap.afterBytes - maxBytes);
      cap.retainedPaths = [...before.keys()];
      return { ok: true, dryRun: !!options.dryRun, targets, errors, cap };
    }
  } catch (e) {
    errors.push(`release-cut usage before reclaim: ${usageFailure(e)}`);
    return { ok: false, dryRun: !!options.dryRun, targets, errors, cap };
  }
  let execution: Awaited<ReturnType<typeof executeCutReclaim>> = { ok: true, results: [] };
  try { if (targets.length) execution = await executeCutReclaim(plan, targets, { ...deps, notAfterMs }); }
  catch (e) { errors.push(`release-cut execution: ${errText(e)}`); }
  try {
    const after = await measure();
    cap.afterBytes = [...after.values()].reduce((sum, n) => sum + n, 0);
    cap.overByBytes = Math.max(0, cap.afterBytes - maxBytes);
    cap.retainedPaths = [...after.keys()];
  } catch (e) { errors.push(`release-cut usage after reclaim: ${usageFailure(e)}`); }
  return { ok: errors.length === 0 && execution.ok && execution.results.every((r) => r.removed), dryRun: false, targets, errors, cap, execution };
}

/** Compact, tool-result-sized rendering (a full verdict list overruns the result cap). */
export function renderReclaimPlan(plan: ReclaimPlan) {
  const pick = (d: ReclaimDisposition) => plan.verdicts.filter((v) => v.disposition === d);
  const row = (v: ReclaimVerdict) => ({
    path: v.path,
    ...(v.realPath && v.realPath !== v.path ? { real: v.realPath } : {}),
    rootFs: v.onRootFs,
    version: v.version,
    ...(v.leaseTags.length ? { leases: v.leaseTags } : {}),
    ...(v.ignoredLeases.length ? { leasesIgnored: v.ignoredLeases } : {}),
  });
  return {
    latestPublished: plan.latestPublished,
    failClosed: plan.failClosed,
    counts: {
      reclaimable: pick('reclaimable').length,
      namedOnly: pick('named-only').length,
      protected: pick('protected').length,
      autoManagedSkipped: plan.skipped.autoManaged.length,
      prunableSkipped: plan.skipped.prunable,
    },
    reclaimable: pick('reclaimable').map(row),
    namedOnly: pick('named-only').map(row),
    protected: pick('protected').map((v) => ({ path: v.path, reasons: v.reasons })),
    ...(plan.interrupted ? { interrupted: plan.interrupted } : {}),
  };
}
