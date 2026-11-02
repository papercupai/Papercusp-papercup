#!/usr/bin/env node
/**
 * EI-18662389554660036 — a single agent's `npm install` on this shared tree
 * breaks EVERY other agent's test runs for minutes (node_modules/.bin/vitest
 * vanishes mid-rewrite), and two OVERLAPPING installs can corrupt a package
 * outright (half-written dist/ — not a version-resolution issue, does not
 * self-heal). There is no advisory lock on a shared-tree-wide mutation this
 * disruptive, even though the exact primitive (a named resource lock) already
 * guards `dev:restart` / `db:migrate` for the same reason.
 *
 * This wrapper serializes `npm install`/`npm ci`/etc invocations across
 * concurrent agent processes on the SAME host via `withFsMutex` (scripts/lib/
 * fs-mutex.mjs — the same mkdir-lock algorithm `withTestcontainerStartLock`
 * already uses for the analogous "many Vitest processes, one Docker handshake"
 * problem). The lock is keyed off the REPO ROOT's real (symlink-resolved) path,
 * so invoking it via the `papercup` symlink or the canonical `papercusp` path
 * both hit the SAME lock (they're one tree) — but a genuinely different
 * checkout (papercup-release, papercup-checkpoint, ...) gets its own lock and
 * is never blocked by this one.
 *
 * EI-18666853411437489 — the mutex stops CONCURRENT installs from corrupting npm's
 * reify bookkeeping, but it cannot detect corruption that ALREADY exists (from an
 * earlier bare `npm install`, or another checkout's run). That failure is silent:
 * npm prints "up to date", exits 0, and leaves a declared dependency un-extracted;
 * the first symptom is a confusing "cannot find module" / Rolldown "failed to
 * resolve" in some unrelated build or gate, often 10+ minutes later. So a successful
 * install is now VERIFIED before the lock is released — every directly-declared
 * dependency directory must resolve AND lockfile-selected critical runtime
 * entrypoints must really import (catching incomplete dist/native/transitive
 * contents) — with ONE bounded auto-repair before failing loudly. A nonzero repair
 * exit is itself fatal; a later spot probe may not erase an ENOTEMPTY failure.
 * Set PAPERCUSP_SKIP_DEP_VERIFY=1 to skip the verification.
 *
 * Managed hives reuse this same implementation with `--repo-root`; the lock
 * and npm cwd both follow that explicit target instead of this script's repo.
 * A `--prefix` install remains outside this wrapper because npm owns the target
 * selection in that shape and the global guard deliberately leaves it alone.
 *
 * Usage: npm run install:safe [-- <npm args>]   (defaults to plain `npm install`)
 *        node scripts/npm-install-safe.mjs ci
 *        node scripts/npm-install-safe.mjs install --legacy-peer-deps
 *        node scripts/npm-install-safe.mjs --offline-safe ci
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive -- install --no-save pkg
 *        node scripts/npm-install-safe.mjs --repo-root /path/to/hive --exec-under-lock -- command arg...
 *
 * `--offline-safe` is a wrapper-only mode for exact-candidate reconstruction. It
 * sets `ONNXRUNTIME_NODE_INSTALL=skip` in npm and bounded-repair children without
 * mutating the caller's environment or forwarding the wrapper flag to npm. An
 * explicit caller-provided `ONNXRUNTIME_NODE_INSTALL` value remains authoritative.
 *
 * `--exec-under-lock` is the reader-side half of the same contract. Long-lived
 * host services build an entrypoint from node_modules immediately before boot;
 * if systemd restarts one while an install is reifying the shared tree, the
 * build/runtime can observe a half-extracted native package and crash-loop.
 * Running that build command under the install mutex makes it wait for the
 * verified install boundary instead of repeatedly reading the transition.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  PACKAGE_CACHE_MUTEX_NAME,
  resolveFsMutexTimeoutMs,
  withFsMutexRead,
  withFsMutex,
} from "./lib/fs-mutex.mjs";
import { TEST_FILE_EXIT_NOT_MEASURED } from "./lib/test-file-exit-codes.mjs";
import { envWithInstallMutex, installLockNameForRoot, installMutexIsHeld } from "./lib/install-lock-name.mjs";
export { installMutexIsHeld } from "./lib/install-lock-name.mjs";
import {
  findIncompleteWorkspacePackagesWithRetry,
  findInvalidWorkspacePackageVersionsWithRetry,
  findUnextractedDepsWithRetry,
  findUnsatisfiedDeclaredDepRangesWithRetry,
  findUnusableRuntimeDepsWithRetry,
  packageNameFromSpecifier,
  formatIncompleteWorkspacePackages,
  formatInvalidWorkspacePackageVersions,
  formatMissing,
  formatRuntimeFailures,
  formatUnsatisfiedDeclaredDepRanges,
  resolveWorkspaceDirs,
} from "./check-declared-deps-extracted.mjs";
import { findBrokenBinLinks } from "./check-partial-install.mjs";
import { expandWorkspaces } from "./assert-workspace-links.mjs";
import { auditLockfile, enclosingWorkspaceOwner } from "../apps/operator/bin/release/dependency-lock-tree-audit.mjs";
import { EMBEDDED_EXTENSIONS, installEmbeddedExtensions, missingWarning } from "./install-embedded-pgvector.mjs";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const REPAIR_ARGS = ["install", "--legacy-peer-deps"];
const EXEC_UNDER_LOCK_FLAG = "--exec-under-lock";
const OFFLINE_SAFE_FLAG = "--offline-safe";
const CACHE_VERIFY_ARGS = ["cache", "verify"];
const DEPENDENCY_GENERATION_SCRIPT = join(
  DEFAULT_REPO_ROOT,
  "apps/operator/bin/release/dependency-generation.sh",
);

/**
 * Keep an explicit --cache override attached to the cache repair. Without it,
 * `npm run install:safe -- --cache <dir> ...` would verify the user's default
 * cache and then reify from a different cache, leaving the corrupt one
 * untouched. Environment/config-file cache selection is inherited by npm.
 */
export function cacheVerifyArgs(npmArgs = []) {
  const cacheArgs = [];
  for (let index = 0; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--cache" && typeof npmArgs[index + 1] === "string") {
      cacheArgs.push(arg, npmArgs[index + 1]);
      index += 1;
    } else if (typeof arg === "string" && arg.startsWith("--cache=")) {
      cacheArgs.push(arg);
    }
  }
  return [...CACHE_VERIFY_ARGS, ...cacheArgs];
}

/**
 * npm's repeatable workspace selectors (`--workspace X`, `--workspace=X`, `-w X`,
 * `-w=X`) in argv order. An empty list means an unscoped, whole-project command.
 */
export function workspaceSelectorsForNpmArgs(npmArgs = []) {
  const selectors = [];
  for (let index = 0; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--workspace" || arg === "-w") {
      if (typeof npmArgs[index + 1] === "string")
        selectors.push(npmArgs[++index]);
    } else if (typeof arg === "string" && arg.startsWith("--workspace=")) {
      selectors.push(arg.slice("--workspace=".length));
    } else if (typeof arg === "string" && arg.startsWith("-w=")) {
      selectors.push(arg.slice("-w=".length));
    }
  }
  return selectors;
}

/**
 * Resolve npm's repeatable workspace selectors to the canonical repo-relative
 * directories consumed by the dependency-integrity scanners. npm accepts both
 * package names and paths, while those scanners intentionally accept paths only.
 * No selector means a full install and therefore a full-tree verification.
 */
export function verificationScopeForNpmArgs({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  deps = {},
} = {}) {
  const selectors = workspaceSelectorsForNpmArgs(npmArgs);
  if (selectors.length === 0)
    return { workspaceDirs: undefined, repairWorkspaceArgs: [] };

  const readJson =
    deps.readJson ?? ((path) => JSON.parse(readFileSync(path, "utf8")));
  const workspaceDirs = resolveWorkspaceDirs(repoRoot, deps);
  const bySelector = new Map();
  for (const dir of workspaceDirs) {
    bySelector.set(dir, dir);
    bySelector.set(`./${dir}`, dir);
    const manifest = readJson(join(repoRoot, dir, "package.json"));
    if (typeof manifest?.name === "string") bySelector.set(manifest.name, dir);
  }
  const selectedDirs = selectors.map((selector) => {
    const dir = bySelector.get(selector);
    if (!dir)
      throw new Error(
        `npm workspace selector did not resolve after install: ${selector}`,
      );
    return dir;
  });
  const uniqueDirs = [...new Set(selectedDirs)];
  return {
    workspaceDirs: uniqueDirs,
    repairWorkspaceArgs: selectors.map((selector) => `--workspace=${selector}`),
  };
}

const LOCK_MANIFEST_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const LOCK_GUARDED_TEST_RUNNERS = new Set([
  "scripts/affected-tests.mjs",
  "scripts/test-files.mjs",
]);

function normalizedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Detect the measured npm failure class before either Arborist or a project test
 * runner consumes the dependency graph. Root-lock workspace entries mirror the
 * manifest dependency maps; stale copies can detach npm's ideal-tree link targets
 * and crash inside build-ideal-tree before npm can repair them.
 */
function findRootLockManifestMismatches(repoRoot = DEFAULT_REPO_ROOT) {
  const root = resolve(repoRoot);
  const shrinkwrapPath = join(root, "npm-shrinkwrap.json");
  const lockPath = existsSync(shrinkwrapPath)
    ? shrinkwrapPath
    : join(root, "package-lock.json");
  if (!existsSync(lockPath)) return [];

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return [{
      workspace: "<lockfile>",
      field: "JSON",
      differences: { packageLock: { manifest: "readable", lock: "unparseable" } },
    }];
  }
  const lockPackages = lock?.packages;
  // Legacy npm lockfile formats do not carry the per-workspace manifest mirror
  // this guard audits. Leave those trees to npm's own parser.
  if (!lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages))
    return [];

  const candidates = new Set(["", ...resolveWorkspaceDirs(root)]);
  for (const key of Object.keys(lockPackages)) {
    if (!key || key.includes("node_modules/") || lockPackages[key]?.link) continue;
    const absolute = resolve(root, key);
    if (!isStrictlyWithin(root, absolute)) continue;
    const rel = relative(root, absolute).split(sep).join("/");
    if (existsSync(join(absolute, "package.json"))) candidates.add(rel);
  }

  const mismatches = [];
  for (const workspace of [...candidates].sort()) {
    const manifestPath = workspace
      ? join(root, workspace, "package.json")
      : join(root, "package.json");
    if (!existsSync(manifestPath)) continue;

    const lockEntry = lockPackages[workspace];
    if (!lockEntry || typeof lockEntry !== "object") {
      mismatches.push({
        workspace,
        field: "packages entry",
        differences: { entry: { manifest: "present", lock: "missing" } },
      });
      continue;
    }
    if (lockEntry.link) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      mismatches.push({
        workspace,
        field: "package.json",
        differences: { manifest: { packageJson: "unparseable", lock: "not compared" } },
      });
      continue;
    }

    for (const field of LOCK_MANIFEST_DEPENDENCY_FIELDS) {
      const declared = normalizedRecord(manifest[field]);
      const locked = normalizedRecord(lockEntry[field]);
      const differences = {};
      for (const dependency of new Set([
        ...Object.keys(declared),
        ...Object.keys(locked),
      ])) {
        if (isDeepStrictEqual(declared[dependency], locked[dependency])) continue;
        differences[dependency] = {
          manifest: Object.hasOwn(declared, dependency) ? declared[dependency] : "<absent>",
          lock: Object.hasOwn(locked, dependency) ? locked[dependency] : "<absent>",
        };
      }
      if (Object.keys(differences).length > 0)
        mismatches.push({ workspace, field, differences });
    }
  }
  return mismatches;
}

function formatRootLockManifestMismatches(mismatches) {
  const lines = [
    `NPM_INSTALL_SAFE_WORKSPACE_LOCK_DRIFT: ${mismatches.length} root lockfile field(s) disagree with package manifests.`,
    "The guarded operation was not started; stale dependency metadata can crash npm Arborist before it repairs the lock.",
  ];
  for (const mismatch of mismatches.slice(0, 20)) {
    lines.push(
      `  - ${mismatch.workspace || "<root>"} ${mismatch.field}: ${JSON.stringify(mismatch.differences)}`,
    );
  }
  if (mismatches.length > 20)
    lines.push(`  - … ${mismatches.length - 20} more mismatch(es)`);
  lines.push(
    "FIX: reconcile the reported workspace dependency maps in package-lock.json with package.json, review the lockfile, then retry the install.",
  );
  return lines.join("\n");
}

function isGuardedTestRunner(commandArgs, repoRoot) {
  const targets = new Set(
    [...LOCK_GUARDED_TEST_RUNNERS].map((path) => resolve(repoRoot, path)),
  );
  return commandArgs.some(
    (arg) => typeof arg === "string" && targets.has(resolve(repoRoot, arg)),
  );
}

/**
 * Verify and repair npm's content-addressed cache before reification. npm's
 * cache verifier removes index entries whose content blobs disappeared, so a
 * stale cacache reference cannot make the install fail with an opaque ENOENT.
 * The caller runs this while holding the same repo-keyed install mutex as the
 * subsequent npm command.
 */
export function verifyNpmCache({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  runNpm = spawnSync,
  env = process.env,
} = {}) {
  const result = runNpm("npm", cacheVerifyArgs(npmArgs), {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Default wait for EXCLUSIVE use of the shared package cache before verify is skipped. */
export const NPM_CACHE_VERIFY_WAIT_MS_DEFAULT = 30_000;

/**
 * Run `verify` (npm cache verify) while holding PACKAGE_CACHE_MUTEX_NAME EXCLUSIVELY.
 *
 * `npm cache verify` WRITES the user-level cache that every checkout shares: after its
 * garbage collection, cacache's `cleanTmp` step runs `rm -rf <cache>/tmp`, deleting every
 * download another npm process has staged there and not yet renamed into content-v2.
 * Until WI-10004430 it ran under the shared READ lease, beside other checkouts' reifies
 * (the repo-keyed install mutex cannot serialize different roots), so a verify in one
 * checkout could fail an install in another with
 * `ENOENT rename <cache>/tmp/… -> content-v2/…` — a workspace-host release cut, 2026-09-30.
 *
 * Verify is a repair step, not a precondition. The fs-mutex is writer-preferring, so
 * while this verifier waits, every other checkout's install queues behind it; past
 * `waitMs` it gives up and skips verify (loudly) rather than fail this install or stall
 * the others. Returns verify's exit status, or 0 when it was skipped.
 */
export async function verifyNpmCacheExclusive({
  verify,
  env = process.env,
  waitMs = Number(env.PAPERCUSP_NPM_CACHE_VERIFY_WAIT_MS) > 0
    ? Number(env.PAPERCUSP_NPM_CACHE_VERIFY_WAIT_MS)
    : NPM_CACHE_VERIFY_WAIT_MS_DEFAULT,
  acquire = withFsMutex,
  log = console.error,
} = {}) {
  let entered = false;
  try {
    return await acquire(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        entered = true;
        return verify();
      },
      {
        timeoutMs: waitMs,
        onWaiting: ({ owner, elapsedMs }) => {
          log(
            `NPM_INSTALL_SAFE cache verify waiting for exclusive use of the shared npm cache (${Math.round(elapsedMs / 1000)}s so far) — holder: ${String(owner).trim()}`,
          );
        },
      },
    );
  } catch (error) {
    // A throw from verify itself is real; only a failure to ACQUIRE the lock is skippable.
    if (entered) throw error;
    log(
      `NPM_INSTALL_SAFE_CACHE_VERIFY_SKIPPED: no exclusive use of the shared npm cache within ${waitMs}ms (${error instanceof Error ? error.message : String(error)}); installing without npm cache verify, because verifying now would delete another checkout's in-flight downloads.`,
    );
    return 0;
  }
}

function isStrictlyWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/**
 * Convert detector findings into the only paths install:safe may remove before
 * its bounded repair. Both the workspace and package segments are untrusted
 * manifest-derived strings, so validate the repo boundary and the narrower
 * <workspace>/node_modules boundary before returning a target.
 *
 * @param {{ repoRoot?: string, findings?: Array<{ workspace?: unknown, package?: unknown }> }} [options]
 * @returns {string[]}
 */
export function packageLocalRepairTargets({
  repoRoot = DEFAULT_REPO_ROOT,
  findings = [],
} = {}) {
  const root = resolve(repoRoot);
  const targets = findings.map((finding) => {
    if (
      typeof finding?.workspace !== "string" ||
      finding.workspace.length === 0 ||
      typeof finding?.package !== "string" ||
      finding.package.length === 0
    ) {
      throw new Error(
        "refusing package-local repair target without workspace and package names",
      );
    }
    const nodeModulesDir = resolve(root, finding.workspace, "node_modules");
    if (!isStrictlyWithin(root, nodeModulesDir)) {
      throw new Error(
        `refusing package-local repair outside repo root: ${finding.workspace}/node_modules`,
      );
    }
    const target = resolve(nodeModulesDir, finding.package);
    if (!isStrictlyWithin(nodeModulesDir, target)) {
      throw new Error(
        `refusing package-local repair outside workspace node_modules: ${finding.workspace}/node_modules/${finding.package}`,
      );
    }
    return target;
  });
  return [...new Set(targets)].sort();
}

function removePackageLocalRepairTargets({ repoRoot, findings, deps = {} }) {
  const removePath =
    deps.removePath ??
    ((target) => rmSync(target, { recursive: true, force: true }));
  const targets = packageLocalRepairTargets({ repoRoot, findings });
  for (const target of targets) removePath(target);
  return targets;
}

/** Re-extract only a locked package with measured missing content or a failed
 * native exercise. Keep lockfile intent intact. Generic import errors, workspace
 * links, external paths and symlinked parents are not evidence of a damaged
 * installed package.
 */
function runtimeContentRepairFindings({ repoRoot, failures }) {
  const repairableFailures = failures.filter((failure) =>
    (failure.code === 'ERR_MODULE_NOT_FOUND' && isAbsolute(failure.missingPath ?? '')) ||
    (failure.nativeExercise === 'sqlite-memory-query' && isAbsolute(failure.resolvedPath ?? '')));
  if (repairableFailures.length === 0) return [];
  const root = realpathSync(repoRoot);
  const lockPath = existsSync(join(root, 'npm-shrinkwrap.json'))
    ? join(root, 'npm-shrinkwrap.json') : join(root, 'package-lock.json');
  if (!existsSync(lockPath)) return [];
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const findings = [];
  for (const failure of repairableFailures) {
    const nativeFailure = failure.nativeExercise === 'sqlite-memory-query';
    const measuredPath = resolve(nativeFailure ? failure.resolvedPath : failure.missingPath);
    if (!isStrictlyWithin(root, measuredPath) || (!nativeFailure && existsSync(measuredPath))) continue;
    const parts = relative(root, measuredPath).split(sep);
    const index = parts.lastIndexOf('node_modules');
    if (index < 0 || !parts[index + 1]) continue;
    const packageName = nativeFailure
      ? packageNameFromSpecifier(failure.specifier)
      : parts[index + 1].startsWith('@') ? parts.slice(index + 1, index + 3).join('/') : parts[index + 1];
    const packageParts = packageName.split('/');
    if (parts.slice(index + 1, index + 1 + packageParts.length).join('/') !== packageName) continue;
    const packageLength = packageParts.length;
    if (parts.length <= index + 1 + packageLength) continue;
    const key = parts.slice(0, index + 1 + packageLength).join('/');
    const entry = lock.packages?.[key];
    if (!entry?.version || entry.link) continue;
    const target = join(root, key);
    // Validate physical identity before any repair deletion, including ancestors.
    if (!existsSync(target) || realpathSync(target) !== target) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')); } catch { continue; }
    if (manifest.name !== packageName || manifest.version !== entry.version) continue;
    findings.push({ workspace: parts.slice(0, index).join('/') || '.', package: packageName });
  }
  return findings;
}

/**
 * Remove a detector-confirmed stale package-local entry from package-lock.json
 * before npm reifies it again. The on-disk target alone is insufficient: npm
 * treats an orphaned lock entry as install intent even when the workspace's
 * current declaration is satisfied by a hoisted package.
 *
 * Only delete an exact entry whose locked version still matches the invalid
 * installed version, or whose link target matches a detector-confirmed dangling
 * symlink still on disk. Inspect links before removing them: npm can recreate an
 * obsolete workspace link from its lock entry even after its declaration changes.
 * A newer/different lock entry or healthy link must not be removed. The write is atomic so an
 * interrupted repair cannot leave the shared lockfile half-written.
 *
 * @param {{
 *   repoRoot?: string,
 *   findings?: Array<{ workspace?: unknown, package?: unknown, installed?: unknown, declared?: unknown }>,
 *   deps?: { readLock?: () => any, writeLock?: (lock: any) => void },
 * }} [options]
 * @returns {string[]} the package-lock.json `packages` keys that were removed.
 */
export function removePackageLocalRepairLockEntries({
  repoRoot = DEFAULT_REPO_ROOT,
  findings = [],
  deps = {},
} = {}) {
  if (findings.length === 0) return [];

  const root = resolve(repoRoot);
  const lockPath = join(root, "package-lock.json");
  const readLock =
    deps.readLock ?? (() => JSON.parse(readFileSync(lockPath, "utf8")));
  const writeLock =
    deps.writeLock ??
    ((lock) => {
      const tempPath = join(
        root,
        `.package-lock.json.papercusp-repair-${process.pid}`,
      );
      try {
        writeFileSync(tempPath, `${JSON.stringify(lock, null, 2)}\n`);
        renameSync(tempPath, lockPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });

  let lock;
  try {
    lock = readLock();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (
    !lock ||
    typeof lock !== "object" ||
    !lock.packages ||
    typeof lock.packages !== "object" ||
    Array.isArray(lock.packages)
  ) {
    throw new Error(
      "refusing package-local repair: package-lock.json has no packages object",
    );
  }

  const removed = [];
  for (const finding of findings) {
    const [target] = packageLocalRepairTargets({
      repoRoot: root,
      findings: [finding],
    });
    const key = relative(root, target).split(sep).join("/");
    const entry = lock.packages[key];
    const staleVersion =
      typeof finding.installed === "string" &&
      typeof entry?.version === "string" &&
      entry.version === finding.installed;
    let staleLink = false;
    if (entry?.link === true && typeof entry.resolved === "string") {
      try {
        staleLink = lstatSync(target).isSymbolicLink() &&
          !existsSync(target) &&
          resolve(root, entry.resolved) === resolve(dirname(target), readlinkSync(target));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!staleVersion && !staleLink) continue;
    delete lock.packages[key];
    removed.push(key);
  }

  if (removed.length > 0) writeLock(lock);
  return removed;
}

/**
 * npm's per-entry dependency-type flags in package-lock.json. They record HOW a
 * package is reachable (only through devDependencies, only through optional
 * edges, through either, as a peer) — never WHICH bytes are installed.
 */
const LOCKFILE_DEP_FLAG_KEYS = new Set(["dev", "optional", "devOptional", "peer"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withoutLockfileDepFlags(entry) {
  if (!isPlainObject(entry)) return entry;
  const rest = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!LOCKFILE_DEP_FLAG_KEYS.has(key)) rest[key] = value;
  }
  return rest;
}

/**
 * Compare two parsed lockfiles. Returns the `packages` keys whose ONLY
 * difference is npm's dependency-type flags (`[]` = semantically identical), or
 * `null` when ANYTHING else differs: a version, resolved URL or integrity, a
 * dependency edge, an added or removed package, or any top-level field.
 */
export function lockfileDepFlagOnlyChanges(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return null;
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of topKeys) {
    if (key !== "packages" && !isDeepStrictEqual(before[key], after[key]))
      return null;
  }
  const beforePackages = before.packages;
  const afterPackages = after.packages;
  if (!isPlainObject(beforePackages) || !isPlainObject(afterPackages))
    return null;
  const beforeKeys = Object.keys(beforePackages);
  if (beforeKeys.length !== Object.keys(afterPackages).length) return null;
  const changed = [];
  for (const key of beforeKeys) {
    if (!Object.hasOwn(afterPackages, key)) return null;
    const was = beforePackages[key];
    const now = afterPackages[key];
    if (isDeepStrictEqual(was, now)) continue;
    if (
      !isDeepStrictEqual(withoutLockfileDepFlags(was), withoutLockfileDepFlags(now))
    )
      return null;
    changed.push(key);
  }
  return changed;
}

/** The root package-lock.json text, or `undefined` when there is none. */
export function readLockfileText(repoRoot = DEFAULT_REPO_ROOT, deps = {}) {
  const lockPath = join(resolve(repoRoot), "package-lock.json");
  const readText = deps.readText ?? (() => readFileSync(lockPath, "utf8"));
  try {
    return readText();
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * WI-10003114: undo a workspace-scoped command's lockfile rewrite when it changed
 * nothing but npm's dependency-type flags.
 *
 * `npm install --workspace=A --workspace=B` recomputes dev/optional/devOptional
 * for the WHOLE lockfile, but it does so without seeing the whole workspace graph.
 * An unscoped install writes one set of flags and a scoped install writes another,
 * so the committed lockfile flips between them depending on which ran last.
 * Measured 2026-09-29: an unscoped shared-tree install flipped 196 entries
 * dev -> devOptional. The desktop sidecar build's scoped installs then flipped
 * them back inside the exact-SHA live-certification checkout. Every certification
 * of green main 93f1c720 went RED `certification-source-dirty-at-build-end`
 * (dirty file: package-lock.json only) even though every functional leg passed.
 *
 * Restoring those bytes cannot change what is installed: the rewrite touched no
 * version, URL, integrity or dependency edge (a formatting-only rewrite is
 * restored for the same reason). A substantive rewrite (a new dependency, a
 * version bump, a removed package) is left exactly as npm wrote it. Unscoped
 * installs are never touched: they are the writer that sees the whole graph.
 */
export function restoreScopedFlagOnlyLockfileRewrite({
  repoRoot = DEFAULT_REPO_ROOT,
  beforeText,
  deps = {},
} = {}) {
  if (typeof beforeText !== "string")
    return { restored: false, reason: "no-lockfile-before", entries: [] };
  const root = resolve(repoRoot);
  const lockPath = join(root, "package-lock.json");
  const afterText = readLockfileText(root, deps);
  if (afterText === undefined)
    return { restored: false, reason: "lockfile-removed", entries: [] };
  if (afterText === beforeText)
    return { restored: false, reason: "unchanged", entries: [] };
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return { restored: false, reason: "unparseable", entries: [] };
  }
  const changed = lockfileDepFlagOnlyChanges(before, after);
  if (changed === null)
    return { restored: false, reason: "substantive-change", entries: [] };
  const writeText =
    deps.writeText ??
    ((text) => {
      const tempPath = join(
        root,
        `.package-lock.json.papercusp-flag-restore-${process.pid}`,
      );
      try {
        writeFileSync(tempPath, text);
        renameSync(tempPath, lockPath);
      } finally {
        rmSync(tempPath, { force: true });
      }
    });
  writeText(beforeText);
  return {
    restored: true,
    reason: changed.length === 0 ? "formatting-only" : "dep-flags-only",
    entries: changed,
  };
}

/**
 * Verify (post-install, still holding the lock) that dependency directories and
 * critical runtime contents actually landed on disk; repair once if not.
 *
 * @param {{
 *   repoRoot?: string,
 *   npmArgs?: string[],
 *   runNpm?: (args: string[]) => number,
 *   probeSpecifiers?: unknown,
 *   env?: NodeJS.ProcessEnv,
 *   deps?: Record<string, any>,
 * }} [options] `probeSpecifiers` and `deps` are forwarded unchanged to the detectors in
 *   scripts/check-declared-deps-extracted.mjs, which define their shapes.
 * @returns {Promise<0|1>} 0 = healthy (possibly after repair), 1 = still broken.
 */
export async function verifyDepsExtracted({
  repoRoot = DEFAULT_REPO_ROOT,
  npmArgs = [],
  runNpm,
  probeSpecifiers,
  env = process.env,
  deps = {},
} = {}) {
  const runRepair =
    runNpm ??
    ((args, options = {}) =>
      runNpmWithHeartbeat({
        phase: "repair",
        args,
        ...options,
      }));

  const { workspaceDirs, repairWorkspaceArgs } = verificationScopeForNpmArgs({
    repoRoot,
    npmArgs,
    deps,
  });
  const allWorkspaceDirs = resolveWorkspaceDirs(repoRoot, deps);
  const auditNestedWorkspaceLockTrees = (rootLock) => allWorkspaceDirs.flatMap((workspace) => {
    // Reuse the publisher's ownership decision. npm reifies this member from
    // the enclosing lock, not its potentially obsolete standalone lock graph.
    if (enclosingWorkspaceOwner(workspace, [{ dir: "", lock: rootLock }]) !== null) return [];
    const workspacePath = resolve(repoRoot, workspace);
    let realWorkspacePath;
    try {
      realWorkspacePath = realpathSync(workspacePath);
      if (!isStrictlyWithin(realpathSync(repoRoot), realWorkspacePath)) return [];
    } catch {
      return [];
    }
    const shrinkwrapPath = join(realWorkspacePath, "npm-shrinkwrap.json");
    const lockPath = existsSync(shrinkwrapPath)
      ? shrinkwrapPath
      : join(realWorkspacePath, "package-lock.json");
    if (!existsSync(lockPath)) return [];
    // Match the publisher's input census: an ignored, untracked member lock
    // is install residue, not an independently pinned install. Reifying it
    // with ci can reject current manifests or reinstall obsolete dependencies.
    // Run from the member so a submodule answers for its own tracked files.
    if (existsSync(join(repoRoot, ".git")) && spawnSync("git", [
      "check-ignore", "-q", "--", lockPath,
    ], { cwd: realWorkspacePath, stdio: "ignore" }).status === 0) return [];
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const audit = auditLockfile({ lock, lockDir: workspace, treeRoot: repoRoot });
    if (!audit.installed || audit.defects.length === 0) return [];
    return [{ workspace, entries: audit.entries, defects: audit.defects }];
  });
  const inspect = async () => {
    // A scoped reify can leave another workspace's old, resolvable hoisting in
    // place after manifest-only resolution changed the root lock's topology.
    // Publication copies the whole tree, so resolving declared dependencies is
    // insufficient: use the publisher's exact-path detector before copying it.
    const lockPath = existsSync(join(repoRoot, "npm-shrinkwrap.json"))
      ? join(repoRoot, "npm-shrinkwrap.json")
      : join(repoRoot, "package-lock.json");
    const rootLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
    const lockTreeDefects = rootLock
      ? auditLockfile({
          lock: rootLock,
          lockDir: "",
          treeRoot: repoRoot,
        }).defects
      : [];
    const nestedLockTrees = auditNestedWorkspaceLockTrees(rootLock);
    const declared = await findUnextractedDepsWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const packageLocal = await findIncompleteWorkspacePackagesWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const packageVersions = await findInvalidWorkspacePackageVersionsWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    const unsatisfiedRanges = await findUnsatisfiedDeclaredDepRangesWithRetry({
      repoRoot,
      workspaceDirs,
      deps,
    });
    if (
      declared.missing.length > 0 ||
      packageLocal.incomplete.length > 0 ||
      packageVersions.invalid.length > 0 ||
      unsatisfiedRanges.invalid.length > 0
    )
      return {
        lockTreeDefects,
        nestedLockTrees,
        missing: declared.missing,
        incomplete: packageLocal.incomplete,
        invalidVersions: packageVersions.invalid,
        unsatisfiedRanges: unsatisfiedRanges.invalid,
        runtimeFailures: [],
        brokenBinLinks: findBrokenBinLinks(repoRoot, { workspaceDirs }),
      };
    const runtime = await findUnusableRuntimeDepsWithRetry({
      repoRoot,
      probeSpecifiers,
      deps,
    });
    return {
      lockTreeDefects,
      nestedLockTrees,
      missing: [],
      incomplete: [],
      invalidVersions: [],
      unsatisfiedRanges: [],
      runtimeFailures: runtime.failures,
      brokenBinLinks: findBrokenBinLinks(repoRoot, { workspaceDirs }),
    };
  };

  const report = ({
    lockTreeDefects,
    nestedLockTrees,
    missing,
    incomplete,
    invalidVersions,
    unsatisfiedRanges,
    runtimeFailures,
    brokenBinLinks,
  }) => {
    for (const defect of lockTreeDefects)
      console.error(`NPM_INSTALL_SAFE lock-tree ${defect.kind}: ${defect.path} (${defect.detail})`);
    for (const tree of nestedLockTrees)
      for (const defect of tree.defects)
        console.error(`NPM_INSTALL_SAFE nested-lock-tree ${defect.kind}: ${defect.path} (${defect.detail})`);
    if (missing.length > 0) console.error(formatMissing(missing));
    if (incomplete.length > 0)
      console.error(formatIncompleteWorkspacePackages(incomplete));
    if (invalidVersions.length > 0)
      console.error(formatInvalidWorkspacePackageVersions(invalidVersions));
    if (unsatisfiedRanges.length > 0)
      console.error(formatUnsatisfiedDeclaredDepRanges(unsatisfiedRanges));
    if (runtimeFailures.length > 0)
      console.error(formatRuntimeFailures(runtimeFailures));
    for (const finding of brokenBinLinks)
      console.error(`NPM_INSTALL_SAFE dangling executable link: ${finding.workspace}/node_modules/${finding.pkg}`);
  };

  const healthy = ({
    lockTreeDefects,
    nestedLockTrees,
    missing,
    incomplete,
    invalidVersions,
    unsatisfiedRanges,
    runtimeFailures,
    brokenBinLinks,
  }) =>
    lockTreeDefects.length === 0 &&
    nestedLockTrees.length === 0 &&
    missing.length === 0 &&
    incomplete.length === 0 &&
    invalidVersions.length === 0 &&
    unsatisfiedRanges.length === 0 &&
    runtimeFailures.length === 0 &&
    brokenBinLinks.length === 0;

  // Scoped npm reify/repair can replace native packages without running the
  // root postinstall. Imports still work, but a fresh database then fails its
  // first VECTOR column. Reuse the postinstall provisioner before accepting
  // either healthy dependency path, while the install writer is still held.
  const verifyNativeExtensions = () => {
    const extensions = installEmbeddedExtensions({ root: repoRoot, env });
    for (const missing of extensions.missingSource) console.error(missingWarning(missing));
    const required = new Set(EMBEDDED_EXTENSIONS.filter(extension => extension.required).map(extension => extension.name));
    const unavailable = extensions.trees.filter(tree => required.has(tree.extension) &&
      !["present", "installed", "updated"].includes(tree.status));
    if (unavailable.length > 0) {
      console.error("NPM_INSTALL_SAFE_FATAL: required embedded Postgres extensions are unavailable: " +
        unavailable.map(tree => `${tree.location} (${tree.extension}: ${tree.status})`).join(", "));
      return 1;
    }
    return 0;
  };

  const first = await inspect();
  if (healthy(first)) return verifyNativeExtensions();

  report(first);
  // A prefix reifies an independent package tree. Keep the full-root verdict,
  // but never turn its failure into a root install or root-lock mutation.
  // The caller must repair the explicitly selected tree before retrying.
  if (npmArgs.some((arg) => arg === "--prefix" || arg.startsWith("--prefix="))) {
    console.error(
      "NPM_INSTALL_SAFE_FATAL: explicit-prefix install failed full-root verification; refusing to broaden repair to the repository root.",
    );
    return 1;
  }
  const runtimeFindings = first.runtimeFailures.length > 0
    ? runtimeContentRepairFindings({ repoRoot, failures: first.runtimeFailures }) : [];
  // Validate every parent before modifying any detected link or its local owner.
  // unlink removes only the link; it cannot recursively delete its target.
  const binTargets = first.brokenBinLinks.map((finding) => {
    const [target] = packageLocalRepairTargets({
      repoRoot,
      findings: [{ workspace: finding.workspace === '<root>' ? '.' : finding.workspace, package: finding.pkg }],
    });
    if (!isStrictlyWithin(realpathSync(repoRoot), realpathSync(dirname(target))))
      throw new Error(`refusing executable-link repair outside repo root: ${target}`);
    return target;
  });
  const binPackageFindings = first.brokenBinLinks
    .filter((finding) => finding.package)
    .map((finding) => ({ workspace: finding.workspace === '<root>' ? '.' : finding.workspace, package: finding.package }));
  // A scoped package's parent can itself be a symlink. Validate the physical
  // parent before recursive removal, as well as the .bin parent before unlink.
  for (const target of packageLocalRepairTargets({ repoRoot, findings: binPackageFindings })) {
    if (!isStrictlyWithin(realpathSync(repoRoot), realpathSync(dirname(target))))
      throw new Error(`refusing executable-package repair outside repo root: ${target}`);
  }
  for (const target of binTargets) {
    if (lstatSync(target).isSymbolicLink() && !existsSync(target)) unlinkSync(target);
  }
  // Compare the locked link with the observed symlink before deleting the node.
  const removedLockEntries = removePackageLocalRepairLockEntries({
    repoRoot,
    findings: [...first.incomplete, ...first.invalidVersions],
    deps,
  });
  const removedTargets = removePackageLocalRepairTargets({
    repoRoot,
    findings: [...first.incomplete, ...first.invalidVersions, ...binPackageFindings, ...runtimeFindings],
    deps,
  });
  if (removedTargets.length > 0) {
    console.error(
      `NPM_INSTALL_SAFE removed ${removedTargets.length} invalid package-local node${removedTargets.length === 1 ? "" : "s"} before repair:\n${removedTargets
        .map((target) => `  - ${relative(repoRoot, target)}`)
        .join("\n")}`,
    );
  }
  if (removedLockEntries.length > 0) {
    console.error(
      `NPM_INSTALL_SAFE removed ${removedLockEntries.length} stale package-lock entr${removedLockEntries.length === 1 ? "y" : "ies"} before repair:\n${removedLockEntries
        .map((entry) => `  - ${entry}`)
        .join("\n")}`,
    );
  }
  // The root lock owns every workspace's installed paths. A repair scoped to
  // the originally selected workspace cannot repair drift elsewhere in it.
  // The repair must keep the install's dev-dependency selection: a bare
  // `npm install` under NODE_ENV=production prunes every devDependency, so a
  // repair that dropped it deleted the very toolchain it was repairing
  // (WI-6554700010029990).
  const needsRootRepair =
    first.lockTreeDefects.length > 0 ||
    first.missing.length > 0 ||
    first.incomplete.length > 0 ||
    first.invalidVersions.length > 0 ||
    first.unsatisfiedRanges.length > 0 ||
    first.runtimeFailures.length > 0 ||
    first.brokenBinLinks.length > 0;
  if (needsRootRepair) {
    const repairArgs = developmentInstallArgs(repoRoot, [
      ...REPAIR_ARGS,
      ...(first.lockTreeDefects.length > 0 || runtimeFindings.length > 0 ? [] : repairWorkspaceArgs),
      ...dependencySelectionArgs(npmArgs),
    ]);
    console.error(
      `NPM_INSTALL_SAFE repairing: npm ${repairArgs.join(" ")} (one bounded attempt, still holding the lock)`,
    );
    const repairStatus = await runRepair(
      repairArgs,
      {
        cwd: repoRoot,
        stdio: "inherit",
        env,
      },
    ) ?? 1;
    if (repairStatus !== 0) {
      console.error(
        `NPM_INSTALL_SAFE_FATAL: repair npm exited ${repairStatus}; dependency integrity is unverified.`,
      );
      return 1;
    }
  }

  // The enclosing npm workspace install owns hoisted dependencies, but a
  // workspace with its own lockfile can also be published as an isolated tree.
  // Reify that already-installed local tree explicitly after the root repair;
  // --workspaces=false keeps npm on the workspace's own lockfile.
  for (const tree of first.nestedLockTrees) {
    const workspaceRoot = resolve(repoRoot, tree.workspace);
    const realWorkspaceRoot = realpathSync(workspaceRoot);
    if (!isStrictlyWithin(realpathSync(repoRoot), realWorkspaceRoot)) {
      throw new Error(`refusing nested workspace lock repair outside repo root: ${workspaceRoot}`);
    }
    const repairArgs = developmentInstallArgs(realWorkspaceRoot, [
      "ci",
      "--legacy-peer-deps",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
      ...dependencySelectionArgs(npmArgs),
    ]);
    console.error(
      `NPM_INSTALL_SAFE repairing nested workspace lock tree: npm ${repairArgs.join(" ")} (workspace=${tree.workspace}, still holding the root lock)`,
    );
    const repairStatus = await runRepair(repairArgs, {
      cwd: realWorkspaceRoot,
      stdio: "inherit",
      env,
    }) ?? 1;
    if (repairStatus !== 0) {
      console.error(
        `NPM_INSTALL_SAFE_FATAL: nested workspace repair exited ${repairStatus} for ${tree.workspace}; dependency integrity is unverified.`,
      );
      return 1;
    }
  }

  const second = await inspect();
  if (healthy(second)) {
    if (verifyNativeExtensions() !== 0) return 1;
    console.log(
      "NPM_INSTALL_SAFE repaired: dependency directories, package-local manifests and versions, executable links, and critical runtime imports are healthy",
    );
    return 0;
  }
  report(second);
  console.error(
    'NPM_INSTALL_SAFE_FATAL: dependencies are STILL incomplete after a repair install — this is not a race. Do not treat a downstream "cannot find module" as a code bug until this is clear.',
  );
  return 1;
}

export function repoLockName(repoRoot = DEFAULT_REPO_ROOT) {
  // The derivation lives in scripts/lib/install-lock-name.mjs so runtime code
  // (headless agent launches, WI-10005137) can wait on the SAME lock without
  // importing this CLI module.
  return installLockNameForRoot(repoRoot);
}

/**
 * Hold a shared host-wide cache lease while a package manager may read/write
 * its global cache. Independent safe installs remain concurrent (reader +
 * reader); the scheduled package-cache janitor takes the matching writer lease
 * before native cleanup. This is deliberately separate from the repo-scoped
 * install writer, because staging/release/checkpoint have different realpaths
 * while sharing the same user-level caches.
 */
export function withPackageCacheReadLease(fn, opts = {}) {
  return withFsMutexRead(PACKAGE_CACHE_MUTEX_NAME, fn, opts);
}

const NPM_HEARTBEAT_INTERVAL_MS = 30_000;
const INSTALL_VALUE_FLAGS = new Set([
  "-w",
  "--workspace",
  "--prefix",
  "--cache",
  "--registry",
  "--tag",
  "--access",
  "--save-prefix",
  "--install-strategy",
  "--include",
  "--omit",
  "--platform",
  "--arch",
  "--cpu",
  "--os",
  "--libc",
  "--userconfig",
  "--globalconfig",
  "--loglevel",
  "--fetch-retries",
  "--fetch-retry-factor",
  "--fetch-retry-mintimeout",
  "--fetch-retry-maxtimeout",
  "--fetch-timeout",
  "--maxsockets",
  "--script-shell",
  "--lockfile-version",
  "--node-options",
  "--proxy",
  "--https-proxy",
  "--save-type",
  "--audit-level",
]);
const INSTALL_BOOLEAN_FLAGS = new Set([
  "--save",
  "--no-save",
  "--save-dev",
  "-D",
  "--save-optional",
  "-O",
  "--save-prod",
  "-P",
  "--save-peer",
  "--save-exact",
  "-E",
  "--save-bundle",
  "-B",
  "--package-lock",
  "--package-lock-only",
  "--ignore-scripts",
  "--foreground-scripts",
  "--audit",
  "--no-audit",
  "--fund",
  "--no-fund",
  "--dry-run",
  "--force",
  "-f",
  "--legacy-peer-deps",
  "--strict-peer-deps",
  "--prefer-dedupe",
  "--workspaces",
  "--no-workspaces",
  "--include-workspace-root",
  "--install-links",
  "--no-install-links",
  "--offline",
  "--prefer-offline",
  "--prefer-online",
  "--global",
  "-g",
  "--global-style",
  "--no-bin-links",
  "--bin-links",
  "--optional",
  "--no-optional",
  "--production",
  "--json",
  "--silent",
  "--quiet",
  "--verbose",
  "--timing",
]);

/** Read the npm process RSS on Linux; other platforms report an unknown value. */
export function readChildRssBytes(pid, platform = process.platform) {
  if (platform !== "linux" || !Number.isSafeInteger(pid)) return null;
  try {
    const status = readFileSync("/proc/" + pid + "/status", "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Capture the bounded identity tuple used to attribute a dependency-path
 * transition. The probe is observational: missing paths are represented as
 * not-observed instead of being treated as a publisher defect.
 */
export function writerAttributionSnapshot({
  repoRoot = DEFAULT_REPO_ROOT,
  nestedPath,
  invocationId = null,
  lockName = null,
  childPid = null,
  phase = null,
  ownerPid = process.pid,
  now = () => new Date().toISOString(),
} = {}) {
  const absolute = nestedPath && isAbsolute(nestedPath)
    ? nestedPath
    : nestedPath ? resolve(repoRoot, nestedPath) : null;
  const packageLock = join(repoRoot, "package-lock.json");
  let canonicalRepoRoot = null;
  try {
    canonicalRepoRoot = realpathSync(repoRoot);
  } catch {
    // A failed probe must not change the install result.
  }
  const stat = (path) => {
    if (!path) return { status: "not-observed", reason: "path-not-configured" };
    try {
      const value = lstatSync(path);
      return {
        status: "observed",
        type: value.isDirectory() ? "directory" : value.isFile() ? "file" : "other",
        dev: value.dev,
        ino: value.ino,
        size: value.size,
        mtimeMs: value.mtimeMs,
        ctimeMs: value.ctimeMs,
      };
    } catch (error) {
      return {
        status: "not-observed",
        reason: error?.code === "ENOENT" ? "absent" : "probe-failed",
      };
    }
  };
  const digest = (() => {
    try {
      return {
        status: "observed",
        sha256: createHash("sha256").update(readFileSync(packageLock)).digest("hex"),
      };
    } catch (error) {
      return {
        status: "not-observed",
        reason: error?.code === "ENOENT" ? "absent" : "probe-failed",
      };
    }
  })();
  return {
    observedAt: now(),
    invocationId,
    repoRoot: canonicalRepoRoot,
    repoRootStatus: canonicalRepoRoot ? "observed" : "not-observed",
    lockName,
    owner: {
      pid: ownerPid,
      processStartIdentity: processIdentityForAttribution(ownerPid) ?? {
        status: "not-observed",
        reason: "process-identity-unavailable",
      },
    },
    childPid,
    phase,
    nestedPath: absolute,
    nestedPathStat: stat(absolute),
    packageJsonStat: stat(absolute ? join(absolute, "package.json") : null),
    rootPackageLockSha256: digest,
  };
}

function processIdentityForAttribution(pid) {
  if (!Number.isSafeInteger(pid) || process.platform !== "linux") return null;
  try {
    const value = readFileSync("/proc/" + pid + "/stat", "utf8");
    const startTicks = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { startTicks, bootId };
  } catch {
    return null;
  }
}

/** A path transition is temporal evidence; a shared reader cannot identify its writer. */
export function writerAttributionRecord({ before, after, ...details }) {
  const first = before?.nestedPathStat;
  const last = after?.nestedPathStat;
  const pathTransition = first?.status === "observed" && last?.reason === "absent"
    ? "disappeared-during-phase"
    : first?.reason === "absent"
      ? "initially-absent"
      : first?.status === "observed" && last?.status === "observed"
        ? "present-after-phase"
        : "not-observed";
  const writerInference = pathTransition !== "disappeared-during-phase"
    ? "none"
    : details.lockMode === "writer"
      ? "candidate-writer-window"
      : "unattributed-shared-or-unlocked-window";
  return { ...details, before, after, pathTransition, writerInference };
}

/** Include wrapper repair and verification work that runs between npm children. */
export async function withWriterAttribution({
  repoRoot,
  nestedPath,
  invocationId,
  lockName,
  lockMode = "writer",
  phase,
  childPid = null,
  log = (line) => console.error(line),
}, action) {
  const base = { repoRoot, nestedPath, invocationId, lockName, phase,
    lockMode, ownerPid: process.pid,
    childPid: typeof childPid === "function" ? childPid(null) : childPid };
  const before = writerAttributionSnapshot(base);
  let status = null;
  let error = null;
  try {
    status = await action();
    return status;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    const finalChildPid = typeof childPid === "function" ? childPid(status) : childPid;
    const after = writerAttributionSnapshot({ ...base, childPid: finalChildPid });
    log("NPM_INSTALL_SAFE attribution=" + JSON.stringify(writerAttributionRecord({
      ...base,
      childPid: finalChildPid,
      exitCode: typeof status === "number" ? status : status?.status ?? null,
      error: error ? String(error?.code ?? error?.message ?? error) : null,
      before,
      after,
    })));
  }
}

/** Spawn npm asynchronously so long resolve/reify/repair phases stay observable. */
export function runNpmWithHeartbeat({
  phase,
  args,
  cwd = DEFAULT_REPO_ROOT,
  env = process.env,
  spawnCommand = spawn,
  heartbeatIntervalMs = NPM_HEARTBEAT_INTERVAL_MS,
  readRssBytes = readChildRssBytes,
  log = (line) => console.error(line),
  now = Date.now,
  attribution = null,
} = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const startedAt = now();
    const envAttribution = !attribution && env.PAPERCUSP_INSTALL_ATTRIBUTION_ID
      ? {
          invocationId: env.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
          repoRoot: env.PAPERCUSP_INSTALL_ATTRIBUTION_REPO ?? cwd,
          nestedPath: env.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
          lockName: env.PAPERCUSP_INSTALL_ATTRIBUTION_LOCK ?? null,
        }
      : null;
    const attributionBase = attribution || envAttribution
      ? {
          ...(attribution || envAttribution),
          phase,
          lockMode: phase === "resolve" ? "none" : "writer",
          ownerPid: process.pid,
        }
      : null;
    const attributionBefore = attributionBase
      ? writerAttributionSnapshot({ ...attributionBase, childPid: null })
      : null;
    const child = spawnCommand("npm", args, {
      cwd,
      stdio: "inherit",
      env,
    });
    let settled = false;
    let timer;
    const finish = () => {
      if (timer) clearInterval(timer);
    };
    const heartbeat = () => {
      let rssBytes = null;
      try {
        rssBytes = readRssBytes(child.pid);
      } catch {
        rssBytes = null;
      }
      const rssMb =
        rssBytes == null ? "unknown" : (rssBytes / (1024 * 1024)).toFixed(1);
      log(
        "NPM_INSTALL_SAFE phase=" + phase +
          " heartbeat elapsedMs=" + Math.max(0, now() - startedAt) +
          " childPid=" + (child.pid ?? "unknown") +
          " childRssMb=" + rssMb,
      );
    };
    log(
      "NPM_INSTALL_SAFE phase=" + phase +
        " started childPid=" + (child.pid ?? "unknown") +
        " args=npm " + args.join(" ") +
        " (cwd=" + cwd + ")",
    );
    const recordAttribution = ({ code, signal, error }) => {
      if (!attributionBase) return;
      const childPid = child.pid ?? null;
      const attributionAfter = writerAttributionSnapshot({
        ...attributionBase,
        childPid,
      });
      log("NPM_INSTALL_SAFE attribution=" + JSON.stringify(writerAttributionRecord({
        ...attributionBase,
        childPid,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(now()).toISOString(),
        exitCode: code ?? null,
        signal: signal ?? null,
        error: error ? String(error?.code ?? error?.message ?? error) : null,
        before: attributionBefore,
        after: attributionAfter,
      })));
    };
    if (heartbeatIntervalMs > 0) {
      timer = setInterval(heartbeat, heartbeatIntervalMs);
      timer.unref?.();
    }
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      recordAttribution({ error });
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      finish();
      log(
        "NPM_INSTALL_SAFE phase=" + phase +
          " finished elapsedMs=" + Math.max(0, now() - startedAt) +
          " exitCode=" + (code ?? "unknown") +
          " signal=" + (signal ?? "none"),
      );
      recordAttribution({ code, signal });
      resolveResult(code ?? 1);
    });
  });
}

function splitInstallPackageSpecs(npmArgs) {
  if (!Array.isArray(npmArgs) || npmArgs[0] !== "install") return null;
  const reifyArgs = [npmArgs[0]];
  const packageSpecs = [];
  for (let index = 1; index < npmArgs.length; index += 1) {
    const arg = npmArgs[index];
    if (arg === "--" || arg === "-") return null;
    if (!arg.startsWith("-")) {
      packageSpecs.push(arg);
      continue;
    }
    reifyArgs.push(arg);
    if (arg.includes("=")) continue;
    if (INSTALL_VALUE_FLAGS.has(arg)) {
      const value = npmArgs[index + 1];
      if (typeof value !== "string" || value.startsWith("-")) return null;
      reifyArgs.push(value);
      index += 1;
      continue;
    }
    if (
      !INSTALL_BOOLEAN_FLAGS.has(arg) &&
      typeof npmArgs[index + 1] === "string" &&
      !npmArgs[index + 1].startsWith("-")
    )
      return null;
  }
  return { reifyArgs, packageSpecs };
}

function npmBooleanArg(npmArgs, option) {
  let value;
  const negative = "--no-" + option.slice(2);
  for (const arg of npmArgs) {
    if (arg === option) value = true;
    else if (arg === negative) value = false;
    else if (arg.startsWith(option + "=")) {
      const rawValue = arg.slice(option.length + 1).toLowerCase();
      value = !["false", "0", "no"].includes(rawValue);
    }
  }
  return value;
}

function npmConfigValue(env, name) {
  return env["npm_config_" + name] ?? env["NPM_CONFIG_" + name.toUpperCase()];
}

function isFalseConfig(value) {
  return typeof value === "string" &&
    ["false", "0", "no"].includes(value.toLowerCase());
}

function isPackageLockOnlyInstall(npmArgs, env) {
  return npmBooleanArg(npmArgs, "--package-lock-only") === true ||
    ["true", "1", "yes"].includes(
      String(npmConfigValue(env, "package_lock_only") ?? "").toLowerCase(),
    );
}

function isLocalOrRemotePackageSpec(spec) {
  const unsupportedTarget =
    /^(?:file:|git(?:\+|:)|github:|gitlab:|bitbucket:|https?:|ssh:|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/]{1,2})/i;
  const separator = spec.startsWith("@")
    ? spec.indexOf("@", spec.indexOf("/") + 1)
    : spec.indexOf("@");
  const target = separator < 0 ? spec : spec.slice(separator + 1);
  const githubShortcut = /^[^/@\s]+\/[^/\s]+(?:#.*)?$/;
  return unsupportedTarget.test(target) || githubShortcut.test(target);
}

function manifestOnlyInstallPlan(npmArgs, env) {
  if (!Array.isArray(npmArgs) || npmArgs[0] !== "install")
    return { eligible: false };
  const split = splitInstallPackageSpecs(npmArgs);
  if (!split)
    return {
      eligible: false,
      reason: "npm options cannot be separated from package targets safely",
    };
  if (split.packageSpecs.some(isLocalOrRemotePackageSpec))
    return {
      eligible: false,
      reason: "a command-line package target is local or remote",
    };
  const redirectedOrNoSave =
    npmArgs.some((arg) =>
      ["--global", "-g", "--dry-run", "--no-package-lock", "--no-save"].includes(arg) ||
      arg === "--package-lock=false" ||
      arg === "--save=false" ||
      arg === "--prefix" ||
      arg.startsWith("--prefix="),
    ) ||
    isFalseConfig(npmConfigValue(env, "package_lock")) ||
    isFalseConfig(npmConfigValue(env, "save")) ||
    ["true", "1", "yes"].includes(
      String(npmConfigValue(env, "global") ?? "").toLowerCase(),
    ) ||
    Boolean(npmConfigValue(env, "prefix"));
  if (redirectedOrNoSave)
    return {
      eligible: false,
      reason: "the invocation disables or redirects manifest or lockfile writes",
    };
  const packageLockOnly = isPackageLockOnlyInstall(npmArgs, env);
  return {
    eligible: true,
    packageLockOnly,
    reifyArgs: split.reifyArgs,
    resolverArgs: [
      ...npmArgs,
      "--package-lock-only=true",
      "--ignore-scripts=true",
    ],
  };
}

function toRepoRelativePath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

function manifestOnlyResolutionLayout(repoRoot) {
  // Verification deliberately excludes foreign hives, but npm still expands
  // their root workspace globs. Omitting those manifests from the scratch tree
  // deletes their lock entries and can detach links when npm reroots actual
  // nodes during a scoped reify. Resolve the full npm population; unsupported
  // dependencies in any workspace must take the existing locked fallback.
  let rootManifest = {};
  try {
    rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    // npm also supports installs in an empty directory. An unreadable existing
    // manifest belongs to npm's normal diagnostic path, not scratch resolution.
    if (error?.code !== "ENOENT")
      return { supported: false, reason: "cannot parse package.json" };
  }
  const workspaceGlobs = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : rootManifest.workspaces?.packages ?? [];
  const workspaceDirs = expandWorkspaces(workspaceGlobs, repoRoot).sort();
  const workspaceManifestPaths = workspaceDirs.map((dir) => dir + "/package.json");
  const outputPaths = [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    ...workspaceManifestPaths,
  ];
  const inputPaths = new Set([...outputPaths, ".npmrc"]);
  const pending = ["package.json", ...workspaceManifestPaths];
  const inspected = new Set();
  while (pending.length > 0) {
    const manifestPath = pending.shift();
    if (inspected.has(manifestPath)) continue;
    inspected.add(manifestPath);
    const absolutePath = join(repoRoot, manifestPath);
    if (!existsSync(absolutePath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch {
      return { supported: false, reason: "cannot parse " + manifestPath };
    }
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const spec of Object.values(manifest?.[section] ?? {})) {
        if (typeof spec !== "string") continue;
        if (/^(?:git\+|github:|gitlab:|bitbucket:)/i.test(spec))
          return {
            supported: false,
            reason: "git dependency in " + manifestPath,
          };
        if (!spec.startsWith("file:")) continue;
        const targetPath = resolve(
          dirname(absolutePath),
          spec.slice("file:".length),
        );
        if (!isStrictlyWithin(repoRoot, targetPath))
          return {
            supported: false,
            reason: "file dependency leaves the repository in " + manifestPath,
          };
        // npm also accepts packed local dependencies. Copy their opaque bytes
        // into the resolver snapshot; an archive is not a package directory.
        if (/\.(?:tgz|tar\.gz)$/i.test(targetPath) && existsSync(targetPath) && lstatSync(targetPath).isFile()) {
          inputPaths.add(toRepoRelativePath(repoRoot, targetPath));
          continue;
        }
        const targetManifest = join(targetPath, "package.json");
        if (!existsSync(targetManifest))
          return {
            supported: false,
            reason: "file dependency has no package manifest in " + manifestPath,
          };
        const targetRelative = toRepoRelativePath(repoRoot, targetManifest);
        if (!inputPaths.has(targetRelative)) {
          inputPaths.add(targetRelative);
          pending.push(targetRelative);
        }
      }
    }
  }
  return {
    supported: true,
    inputPaths: [...inputPaths].sort(),
    outputPaths: [...new Set(outputPaths)].sort(),
  };
}

function fileBytesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function createManifestOnlyTree(repoRoot, inputPaths) {
  const scratchRoot = mkdtempSync(join(tmpdir(), "npm-install-safe-resolve-"));
  const snapshot = new Map();
  try {
    for (const path of inputPaths) {
      const absolutePath = join(repoRoot, path);
      const contents = existsSync(absolutePath) ? readFileSync(absolutePath) : null;
      snapshot.set(path, contents);
      if (contents === null) continue;
      const destination = join(scratchRoot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, contents);
    }
    return { scratchRoot, snapshot };
  } catch (error) {
    rmSync(scratchRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolvedManifestFiles(scratchRoot, outputPaths) {
  return new Map(
    outputPaths.map((path) => {
      const absolutePath = join(scratchRoot, path);
      return [
        path,
        existsSync(absolutePath) ? readFileSync(absolutePath) : null,
      ];
    }),
  );
}

/** Apply resolver output only while the source snapshot is current. */
export function applyResolvedManifestFiles({
  repoRoot,
  snapshot,
  files,
  outputPaths,
}) {
  for (const [path, expected] of snapshot) {
    const absolutePath = join(repoRoot, path);
    const actual = existsSync(absolutePath) ? readFileSync(absolutePath) : null;
    if (!fileBytesEqual(actual, expected))
      return { applied: false, reason: "source-changed", path };
  }
  for (const path of outputPaths) {
    const next = files.get(path);
    if (next === null && snapshot.get(path) !== null)
      return { applied: false, reason: "resolver-removed-source-file", path };
  }
  for (const path of outputPaths) {
    const next = files.get(path);
    const before = snapshot.get(path);
    if (next === null || fileBytesEqual(before, next)) continue;
    const absolutePath = join(repoRoot, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    const temporaryPath = join(
      dirname(absolutePath),
      "." + basename(absolutePath) + ".install-safe-" +
        process.pid + "-" + randomUUID(),
    );
    try {
      writeFileSync(temporaryPath, next);
      renameSync(temporaryPath, absolutePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return { applied: true };
}

// Call under an install reader so the admission decision observes one graph.
async function installedGraphNeedsRepair({ repoRoot, npmArgs }) {
  const { workspaceDirs } = verificationScopeForNpmArgs({ repoRoot, npmArgs });
  const ranges = await findUnsatisfiedDeclaredDepRangesWithRetry({ repoRoot, workspaceDirs });
  const declared = await findUnextractedDepsWithRetry({ repoRoot, workspaceDirs });
  const lockPath = join(repoRoot, existsSync(join(repoRoot, "npm-shrinkwrap.json"))
    ? "npm-shrinkwrap.json" : "package-lock.json");
  const lockTreeDefects = existsSync(lockPath) ? auditLockfile({
    lock: JSON.parse(readFileSync(lockPath, "utf8")), lockDir: "", treeRoot: repoRoot,
  }).defects : [];
  return ranges.invalid.length > 0 || declared.missing.length > 0 || lockTreeDefects.length > 0;
}

async function runManifestOnlyInstall({
  repoRoot,
  lockName,
  npmArgs,
  npmEnv,
  plan,
}) {
  const resolverLockName = lockName + "-resolver";
  return withFsMutex(
    resolverLockName,
    async () => {
      let input;
      // Set when the resolution was computed from manifests that changed before it could be
      // applied; main() then re-resolves against the current manifests (WI-10006714).
      let stale = null;
      const layout = await withFsMutexRead(lockName, async () => {
        const mismatches = findRootLockManifestMismatches(repoRoot);
        if (mismatches.length > 0) {
          console.error(formatRootLockManifestMismatches(mismatches));
          return { supported: false, preflightDrift: true };
        }
        const value = manifestOnlyResolutionLayout(repoRoot);
        if (!value.supported) return value;
        // A transitive security override can leave every direct range satisfied
        // while the installed runtime differs from the selected lock. Reuse the
        // publisher's exact-path audit, as post-reify verification already does;
        // that graph needs repair admission rather than an unbounded pre-drain.
        // A broken installed graph needs a writer reservation so sustained new
        // readers cannot starve its repair. Existing readers still drain under
        // the exclusive mutex; healthy installs retain the D-009 pre-drain.
        value.repairInstalledGraph = await installedGraphNeedsRepair({ repoRoot, npmArgs });
        input = createManifestOnlyTree(repoRoot, value.inputPaths);
        return value;
      });
      if (layout.preflightDrift)
        return { supported: true, status: 1 };
      if (!layout.supported)
        return { supported: false, reason: layout.reason };
      try {
        const cacheStatus = await verifyNpmCacheExclusive({
          verify: () => verifyNpmCache({ repoRoot, npmArgs, env: npmEnv }),
        });
        if (cacheStatus !== 0) {
          console.error(
            "NPM_INSTALL_SAFE_FATAL: npm cache verify exited " +
              cacheStatus + "; cache integrity is unverified.",
          );
          return { supported: true, status: cacheStatus };
        }
        // Do not hold the repo mutex here, including a shared reader: git-sync needs
        // the exclusive repo writer and would otherwise queue for the full npm resolve.
        const resolveStatus = await withPackageCacheReadLease(() =>
          runNpmWithHeartbeat({
            phase: "resolve",
            args: plan.resolverArgs,
            cwd: input.scratchRoot,
            env: npmEnv,
          }),
        );
        if (resolveStatus !== 0)
          return { supported: true, status: resolveStatus };
        const files = resolvedManifestFiles(input.scratchRoot, layout.outputPaths);
        const status = await withFsMutex(
          lockName,
          async () => withWriterAttribution({
            repoRoot,
            nestedPath: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
            invocationId: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
            lockName,
            phase: "reify-transaction",
          }, async () => {
            const applied = applyResolvedManifestFiles({
              repoRoot,
              snapshot: input.snapshot,
              files,
              outputPaths: layout.outputPaths,
            });
            if (!applied.applied) {
              if (applied.reason === "source-changed") {
                stale = { reason: applied.reason, path: applied.path ?? "unknown" };
                return 1;
              }
              console.error(
                "NPM_INSTALL_SAFE_RESOLUTION_STALE: " + applied.reason +
                  " at " + (applied.path ?? "unknown") +
                  "; no reify ran. Retry the install against the current manifests.",
              );
              return 1;
            }
            // The resolver can rewrite flags before reify starts. Preserve its
            // original snapshot here, while holding the writer, so the later
            // reify/repair snapshot cannot accept those rewritten flags as its
            // baseline. Substantive dependency changes remain authoritative.
            const before = input.snapshot.get("package-lock.json");
            if (
              before !== null &&
              workspaceSelectorsForNpmArgs(npmArgs).length > 0
            ) {
              const restore = restoreScopedFlagOnlyLockfileRewrite({
                repoRoot,
                beforeText: before.toString("utf8"),
              });
              if (restore.restored)
                console.log(
                  "NPM_INSTALL_SAFE kept the pre-install package-lock.json: " +
                    "this workspace-scoped command rewrote only npm dependency-type flags (" +
                    restore.reason + ", " + restore.entries.length +
                    " entries); a scoped install is not authoritative for them (WI-10003114)",
                );
            }
            if (plan.packageLockOnly) return 0;
            return withPackageCacheReadLease(async () => {
              console.log(
                "NPM_INSTALL_SAFE reifying resolved lockfile: npm " +
                  plan.reifyArgs.join(" ") + " (root=" + repoRoot +
                  ", lock=" + lockName + ")",
              );
              const lockfileBeforeScopedCommand =
                workspaceSelectorsForNpmArgs(npmArgs).length > 0
                  ? readLockfileText(repoRoot)
                  : undefined;
              const status = await runNpmWithHeartbeat({
                phase: "reify",
                args: plan.reifyArgs,
                cwd: repoRoot,
                env: npmEnv,
              });
              if (status !== 0) return status;
              const verdict =
                npmEnv.PAPERCUSP_SKIP_DEP_VERIFY === "1"
                  ? 0
                  : await verifyDepsExtracted({
                      repoRoot,
                      npmArgs,
                      env: npmEnv,
                    });
              if (lockfileBeforeScopedCommand !== undefined) {
                const restore = restoreScopedFlagOnlyLockfileRewrite({
                  repoRoot,
                  beforeText: lockfileBeforeScopedCommand,
                });
                if (restore.restored)
                  console.log(
                    "NPM_INSTALL_SAFE kept the pre-install package-lock.json: " +
                      "this workspace-scoped command rewrote only npm dependency-type flags (" +
                      restore.reason + ", " + restore.entries.length +
                      " entries); a scoped install is not authoritative for them (WI-10003114)",
                  );
              }
              return verdict;
            });
          }),
          {
            waitForReadersBeforeReserve: !layout.repairInstalledGraph,
            ...installLockWaitReporter({
              lock: "writer",
              describe: (owner, elapsedMs) =>
                "NPM_INSTALL_SAFE waiting to reify behind another agent's install (" +
                Math.round(elapsedMs / 1000) + "s so far) — holder: " + owner,
              log: (line) => console.log(line),
              budgetMs: resolveFsMutexTimeoutMs(),
            }),
            waitingNoticeIntervalMs: 30_000,
          },
        );
        return stale
          ? { supported: true, status, stale }
          : { supported: true, status };
      } finally {
        rmSync(input.scratchRoot, { recursive: true, force: true });
      }
    },
    {
      onWaiting: ({ owner, elapsedMs }) =>
        console.error(
          "NPM_INSTALL_SAFE waiting to serialize dependency resolution (" +
            Math.round(elapsedMs / 1000) + "s so far) — holder: " +
            String(owner).trim(),
        ),
      waitingNoticeIntervalMs: 30_000,
    },
  );
}

/**
 * npm treats config flags before a command as global flags. Preserve the
 * long-documented `npm run install:safe -- --legacy-peer-deps` form by making
 * the implicit install explicit before spawning npm.
 */
export function normalizeNpmArgs(argv) {
  if (argv.length === 0) return ["install"];
  return argv[0].startsWith("-") ? ["install", ...argv] : argv;
}

/**
 * Build the environment for npm children without changing the parent process.
 * The offline override is deliberately opt-in: ordinary installs retain an
 * explicit caller setting (including `ONNXRUNTIME_NODE_INSTALL=skip`).
 */
export function npmChildEnv({
  env = process.env,
  offlineSafe = false,
} = {}) {
  const hasExplicitInstallSetting =
    Object.prototype.hasOwnProperty.call(env, "ONNXRUNTIME_NODE_INSTALL") &&
    env.ONNXRUNTIME_NODE_INSTALL !== undefined;
  return {
    ...env,
    ...(offlineSafe && !hasExplicitInstallSetting
      ? { ONNXRUNTIME_NODE_INSTALL: "skip" }
      : {}),
  };
}

/** A development checkout must not lose its tools because NODE_ENV, npm config,
 * or .npmrc implicitly omits dev dependencies. An explicit production selection
 * on this invocation remains authoritative. Apply before resolve AND reify so
 * repairs inherit the same selection. Reader/cache commands never reach here.
 * @param {string} repoRoot @param {string[]} npmArgs
 */
export function developmentInstallArgs(repoRoot, npmArgs) {
  if (!["install", "i", "ci", "update", "up", "dedupe", "prune", "uninstall", "remove", "rm", "link", "unlink"].includes(npmArgs[0]))
    return npmArgs;
  const savesDev = npmBooleanArg(npmArgs, "--save-dev") === true || npmArgs.includes("-D");
  const manifestPath = join(repoRoot, "package.json");
  if (!savesDev && (!existsSync(manifestPath) ||
      !Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).devDependencies ?? {}).length)) return npmArgs;
  for (let index = 1; index < npmArgs.length; index++) {
    const [flag, inline] = npmArgs[index].split(/=(.*)/s);
    const value = inline ?? npmArgs[index + 1];
    if ((flag === "--omit" && value?.split(/[\s,]+/).includes("dev")) ||
        (flag === "--include" && value?.split(/[\s,]+/).includes("dev")) ||
        (flag === "--only" && ["prod", "production"].includes(value)) ||
        (flag === "--also" && ["dev", "development"].includes(value)) ||
        ["--production", "--no-production", "--dev"].includes(flag)) return npmArgs;
  }
  return [...npmArgs, "--include=dev"];
}

/** The dev-dependency selection flags of an npm command, verbatim and in order
 * (`--include=dev`, `--omit dev`, `--production`, ...), so a follow-up reify can
 * apply exactly the selection the original install used.
 * @param {string[]} npmArgs
 * @returns {string[]}
 */
export function dependencySelectionArgs(npmArgs) {
  const selected = [];
  for (let index = 1; index < npmArgs.length; index++) {
    const token = npmArgs[index];
    const [flag, inline] = token.split(/=(.*)/s);
    if (["--production", "--no-production", "--dev"].includes(flag)) {
      selected.push(token);
    } else if (["--omit", "--include", "--only", "--also"].includes(flag)) {
      if (inline !== undefined) selected.push(token);
      else if (index + 1 < npmArgs.length) selected.push(token, npmArgs[++index]);
    }
  }
  return selected;
}

/**
 * Publish the verified install as an immutable dependency generation under a
 * shared reader marker for the repo-keyed install mutex. The generation builder
 * carries its own before/after fingerprint guard and a short atomic-publish
 * lock; this reader boundary keeps a concurrent safe install from reifying
 * node_modules during the potentially long copy while still allowing other
 * dependency readers to proceed together.
 */
export async function publishDependencyGeneration({
  repoRoot = DEFAULT_REPO_ROOT,
  runPublisher = spawnSync,
  env = process.env,
  log = (line) => console.error(line),
} = {}) {
  if (env.PAPERCUSP_SKIP_DEP_GENERATION === "1") return 0;
  const lockName = repoLockName(repoRoot);
  let publisherResult = null;
  const result = await withFsMutexRead(
    lockName,
    () => withWriterAttribution({
      repoRoot,
      nestedPath: env.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
      invocationId: env.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
      lockName,
      lockMode: "reader",
      phase: "generation-publish",
      childPid: () => publisherResult?.pid ?? null,
      log,
    }, async () => {
      // A scoped install can skip the root postinstall, and a generation cache
      // hit only proves the copied trees match their donor. Validate the donor's
      // tracked patches before either a cache hit or a fresh publication can
      // advertise success. Keep this inside the same install-reader boundary.
      if (existsSync(join(repoRoot, "patches"))) {
        try {
          const { checkInstalledPatchPostimages } = await import("./check-installed-patch-postimages.mjs");
          const patches = checkInstalledPatchPostimages({ repoRoot });
          if (!patches.ok) throw new Error(patches.errors.join("\n"));
        } catch (error) {
          log("NPM_INSTALL_SAFE_FATAL: installed patch postimages are unverified; " +
            "refusing dependency generation publication. Repair through the root postinstall " +
            "under the install writer before retrying. " +
            (error instanceof Error ? error.message : String(error)));
          return { status: 1 };
        }
      }
      publisherResult = runPublisher(
        "bash",
        [DEPENDENCY_GENERATION_SCRIPT, "--integration", repoRoot],
        { cwd: repoRoot, stdio: "inherit", env },
      );
      return publisherResult;
    }),
    {
      onWaiting: ({ owner, elapsedMs }) => {
        console.error(
          `NPM_INSTALL_SAFE dependency generation waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
        );
      },
      waitingNoticeIntervalMs: 30_000,
    },
  );
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(
      `NPM_INSTALL_SAFE_FATAL: immutable dependency generation publish exited ${status}; the install is healthy but no checkpoint-safe generation was published.`,
    );
  }
  return status;
}

/**
 * Parse the wrapper-only target selector without stealing npm's own flags.
 * `--repo-root` is recognized only as the first wrapper argument and an
 * optional `--` cleanly separates it from the npm argv.
 */
export function parseCliArgs(
  argv = process.argv.slice(2),
  { cwd = process.cwd() } = {},
) {
  // EI-24937341882865098: a wrapper-level help request. Without this, normalizeNpmArgs turns
  // `--help` into `npm install --help`, which waits on the repo-keyed install mutex first and
  // reads as a silent multi-minute install. Only the FIRST argument is the wrapper's, so an
  // explicit `install --help` still reaches npm.
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };

  let repoRoot = DEFAULT_REPO_ROOT;
  let npmArgv = [...argv];
  let offlineSafe = false;

  if (npmArgv[0] === "--repo-root" || npmArgv[0]?.startsWith("--repo-root=")) {
    const inline = npmArgv[0].startsWith("--repo-root=")
      ? npmArgv[0].slice("--repo-root=".length)
      : null;
    const rawRoot = inline ?? npmArgv[1];
    if (!rawRoot) throw new Error("--repo-root requires a path");
    repoRoot = resolve(cwd, rawRoot);
    npmArgv = npmArgv.slice(inline === null ? 2 : 1);
  }
  if (npmArgv[0] === OFFLINE_SAFE_FLAG) {
    offlineSafe = true;
    npmArgv = npmArgv.slice(1);
  }
  if (npmArgv[0] === EXEC_UNDER_LOCK_FLAG || npmArgv[0] === "--exec-under-cache-lock") {
    const cacheRead = npmArgv[0] === "--exec-under-cache-lock";
    const commandArgs = npmArgv.slice(npmArgv[1] === "--" ? 2 : 1);
    if (commandArgs.length === 0)
      throw new Error(`${npmArgv[0]} requires a command`);
    return {
      repoRoot,
      commandArgs,
      ...(cacheRead ? { cacheRead: true } : {}),
      ...(offlineSafe ? { offlineSafe: true } : {}),
    };
  }

  if (npmArgv[0] === "--") npmArgv = npmArgv.slice(1);

  return {
    repoRoot,
    npmArgs: normalizeNpmArgs(npmArgv),
    ...(offlineSafe ? { offlineSafe: true } : {}),
  };
}

/**
 * WI-10006385: pair a lock's "waiting" notices with ONE closing line that says how long
 * the wait actually lasted and under what budget. Without it a build log shows
 * "waiting … (0s so far)" and then nothing, so nobody can tell a 1 s wait from a 50 min
 * one, or whether PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC raised the budget. Prints nothing
 * for an uncontested lock: the closing line only follows a printed notice.
 *
 * @param {{ lock: 'writer' | 'reader', describe: (owner: string, elapsedMs: number) => string, log: (line: string) => void, budgetMs: number }} opts
 * @returns {{ onWaiting: (info: { owner: string, elapsedMs: number }) => void, onAcquired: (info: { waitedMs: number }) => void }}
 */
export function installLockWaitReporter({ lock, describe, log, budgetMs }) {
  let noticed = false;
  return {
    onWaiting: ({ owner, elapsedMs }) => {
      noticed = true;
      const ownerText = String(owner).trim();
      // A writer first reserves admission, then drains protected readers.
      // Those holders are not competing installs: generation publication can
      // legitimately keep this phase occupied for much longer than reifying.
      let waitingForReaders = false;
      if (lock === "writer") {
        try {
          waitingForReaders = JSON.parse(ownerText)?.mode === "read";
        } catch {
          // Missing/unreadable owner diagnostics retain the caller's fallback.
        }
      }
      log(waitingForReaders
        ? `NPM_INSTALL_SAFE writer waiting for dependency readers (${Math.round(elapsedMs / 1000)}s so far) — holder: ${ownerText}`
        : describe(ownerText, elapsedMs));
    },
    onAcquired: ({ waitedMs }) => {
      if (!noticed) return;
      log(`NPM_INSTALL_SAFE_LOCK_ACQUIRED lock=${lock} waitedMs=${waitedMs} budgetMs=${budgetMs}`);
    },
  };
}

/** Retained source shadows import dependencies from their recorded donor chain. */
function installReaderLockNames(repoRoot) {
  const roots = new Set();
  let root = realpathSync(repoRoot);
  while (true) {
    if (roots.has(root)) throw new Error("Cyclic retained-source dependency donor provenance");
    roots.add(root);
    const markerPath = join(root, ".git", "lint-as-committed-owner.json");
    if (!existsSync(markerPath)) break;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof marker.sourceRepoRoot !== "string" || !isAbsolute(marker.sourceRepoRoot)) {
      throw new Error("Missing retained-source dependency donor provenance");
    }
    root = realpathSync(marker.sourceRepoRoot);
  }
  return [...new Set([...roots].map(root => repoLockName(root)))].sort();
}

/**
 * Run a dependency reader under the SAME repo-keyed mutex as install:safe.
 * The marker environment prevents a wrapped script from recursively wrapping
 * itself while keeping the contract explicit and testable at the child seam.
 *
 * @param {{
 *   repoRoot?: string,
 *   commandArgs?: string[],
 *   runCommand?: (command: string, args: string[], options: {
 *     cwd: string, stdio: 'inherit', env: NodeJS.ProcessEnv,
 *   }) => { status?: number | null, signal?: NodeJS.Signals | null, error?: Error },
 *   acquireReadMutex?: typeof withFsMutexRead,
 *   log?: (line: string) => void,
 *   env?: NodeJS.ProcessEnv,
 *   cacheRead?: boolean — guard the shared package cache instead of repo dependencies,
 * }} [options]
 */
export async function runCommandUnderInstallMutex({
  repoRoot = DEFAULT_REPO_ROOT,
  commandArgs,
  runCommand = spawnSync,
  acquireReadMutex = withFsMutexRead,
  log = console.error,
  env = process.env,
  cacheRead = false,
} = {}) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) {
    throw new Error(`${EXEC_UNDER_LOCK_FLAG} requires a command`);
  }
  const [command, ...args] = commandArgs;
  const lockNames = cacheRead ? [] : installReaderLockNames(repoRoot);
  const pendingLocks = lockNames.filter(name => !installMutexIsHeld(name, env));
  const mutexAlreadyHeld = pendingLocks.length === 0;
  const childEnv = lockNames.reduce((child, name) => envWithInstallMutex(name, child), env);
  let childStarted = false;

  const executeReader = async () => {
    if (!cacheRead && isGuardedTestRunner(commandArgs, repoRoot)) {
      const mismatches = findRootLockManifestMismatches(repoRoot);
      if (mismatches.length > 0) {
        log(formatRootLockManifestMismatches(mismatches));
        log("TEST_RUN_NOT_MEASURED reason=workspace-lock-manifest-drift");
        return TEST_FILE_EXIT_NOT_MEASURED;
      }
    }
    childStarted = true;
    // Reader diagnostics belong on stderr: callers such as ptool expose the
    // child command's stdout as a machine-readable JSON stream.
    console.error(
      `${cacheRead ? "NPM_INSTALL_SAFE guarding package-cache reader" : mutexAlreadyHeld ? "NPM_INSTALL_SAFE mutex already held; running nested reader directly" : "NPM_INSTALL_SAFE guarding reader"}: ${commandArgs.join(" ")} (root=${repoRoot}, lock=${cacheRead ? PACKAGE_CACHE_MUTEX_NAME : lockNames.join(",")})`,
    );
    const result = runCommand(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: childEnv,
    });
    if (result.error) throw result.error;
    if (result.signal) {
      // spawnSync reports a signal with status:null. Keep the shell status
      // and diagnostic so bundle callers can distinguish a killed compiler
      // from a normal compilation failure, including after candidate cleanup.
      const signalNumber = osConstants.signals[result.signal];
      const status = signalNumber ? 128 + signalNumber : 1;
      log(`NPM_INSTALL_SAFE reader terminated signal=${result.signal} exitCode=${status}`);
      return status;
    }
    return result.status ?? 1;
  };

  // A command launched by an install-safe reader inherits this marker. Its
  // nested reader for THIS repository is already inside the install boundary and must not install
  // another reader marker beneath the writer it is waiting on: that is a
  // self-deadlock when the outer command still owns the writer lock.
  // Package runners share the host cache even when their repository is isolated.
  // A repo reader marker is not proof that the cache lease is held.
  if (cacheRead) return withPackageCacheReadLease(executeReader);
  if (mutexAlreadyHeld) return executeReader();

  try {
    const acquireReader = (index) => index === pendingLocks.length
      ? executeReader()
      : acquireReadMutex(pendingLocks[index], () => acquireReader(index + 1), {
      // Reader diagnostics stay on stderr (see executeReader).
      ...installLockWaitReporter({
        lock: "reader",
        describe: (owner, elapsedMs) =>
          `NPM_INSTALL_SAFE reader waiting on an install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner}`,
        log,
        // The budget withFsMutexRead itself applies (it resolves from process.env).
        budgetMs: resolveFsMutexTimeoutMs(),
      }),
      waitingNoticeIntervalMs: 30_000,
    });
    return await acquireReader(0);
  } catch (error) {
    const testFileRouter = resolve(repoRoot, "scripts/test-files.mjs");
    const invokesTestFileRouter = commandArgs.some(
      (arg) => typeof arg === "string" && resolve(repoRoot, arg) === testFileRouter,
    );
    if (childStarted || !invokesTestFileRouter) throw error;

    const message = error instanceof Error ? error.message : String(error);
    log(`NPM_INSTALL_SAFE_ERROR ${message}`);
    log(
      `TEST_FILE_NOT_MEASURED reason=install-reader-lock-acquisition — test child never started (${message})`,
    );
    return TEST_FILE_EXIT_NOT_MEASURED;
  }
}

/** Printed for `--help` / `-h`; never takes the install mutex. */
export const USAGE = `Usage: npm run install:safe [-- <npm args>]   (defaults to plain \`npm install\`)
       node scripts/npm-install-safe.mjs [--repo-root <path>] [--offline-safe] [--] [<npm args>]
       node scripts/npm-install-safe.mjs [--repo-root <path>] --exec-under-lock [--] <command> [args...]
       node scripts/npm-install-safe.mjs [--repo-root <path>] --exec-under-cache-lock [--] <command> [args...]

Serializes npm installs in a shared checkout behind a repo-keyed mutex, then verifies every
declared dependency landed on disk. Arguments that start with "-" get an implicit \`install\`
prepended, so \`-- --legacy-peer-deps\` means \`npm install --legacy-peer-deps\`.
--help / -h is recognised only as the first argument; use \`install --help\` for npm's own help.
Installs in roots declaring devDependencies include dev tools by default, even under
NODE_ENV=production or inherited omit config. Use --omit=dev for an explicit production install.
`;

export const RESOLUTION_STALE_ATTEMPTS_DEFAULT = 3;

/**
 * How many times a manifest-only install resolves before giving up on manifests that keep
 * changing underneath it. PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS overrides it (a positive
 * integer; 1 restores the old single-attempt behaviour); anything else uses the default.
 */
export function resolutionStaleAttempts(env = process.env) {
  const raw = env.PAPERCUSP_INSTALL_SAFE_STALE_ATTEMPTS;
  if (raw === undefined || raw === "") return RESOLUTION_STALE_ATTEMPTS_DEFAULT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1
    ? value
    : RESOLUTION_STALE_ATTEMPTS_DEFAULT;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ("commandArgs" in parsed) return runCommandUnderInstallMutex(parsed);

  const { repoRoot } = parsed;
  const npmArgs = developmentInstallArgs(repoRoot, parsed.npmArgs);
  const lockName = repoLockName(repoRoot);
  const npmEnv = {
    ...npmChildEnv({
      env: process.env,
      offlineSafe: parsed.offlineSafe === true,
    }),
    PAPERCUSP_INSTALL_SAFE_ACTIVE: "1",
    PAPERCUSP_INSTALL_ATTRIBUTION_ID: randomUUID(),
    PAPERCUSP_INSTALL_ATTRIBUTION_REPO: repoRoot,
    PAPERCUSP_INSTALL_ATTRIBUTION_PATH: join(
      repoRoot,
      "apps/slack-asana-bug-drill/node_modules/@types/node/node_modules/undici-types",
    ),
    PAPERCUSP_INSTALL_ATTRIBUTION_LOCK: lockName,
  };
  const installPlan = manifestOnlyInstallPlan(npmArgs, npmEnv);
  const packageLockOnly = isPackageLockOnlyInstall(npmArgs, npmEnv);

  if (installPlan.eligible) {
    // The resolve runs outside the repo mutex, so a peer can change the manifests under it, and
    // the apply step then refuses the stale resolution. The remedy is always to re-resolve
    // against the current manifests, which needs no human, so do it here, bounded. Exiting
    // instead killed an unattended deb build after a 470 s lock wait (WI-10006714).
    const maxAttempts = resolutionStaleAttempts(process.env);
    let result;
    for (let attempt = 1; ; attempt += 1) {
      result = await runManifestOnlyInstall({
        repoRoot,
        lockName,
        npmArgs,
        npmEnv,
        plan: installPlan,
      });
      if (!result.supported || !result.stale) break;
      if (attempt >= maxAttempts) {
        console.error(
          "NPM_INSTALL_SAFE_RESOLUTION_STALE: source-changed at " + result.stale.path +
            " on all " + maxAttempts + " attempt(s); no reify ran. The manifests kept " +
            "changing while npm resolved; retry once they settle.",
        );
        break;
      }
      console.error(
        "NPM_INSTALL_SAFE_RESOLUTION_RETRY: source-changed at " + result.stale.path +
          " during attempt " + attempt + "/" + maxAttempts +
          "; no reify ran. Re-resolving against the current manifests.",
      );
    }
    if (result.supported) {
      if (result.status !== 0) return result.status;
      // Lock-only resolution applies manifests without reifying or repairing
      // node_modules. Publishing here would bind the new lock to the old
      // installed tree and can fail a healthy metadata operation on copy
      // headroom. Actual reify/repair paths still publish below.
      if (installPlan.packageLockOnly) return 0;
      return publishDependencyGeneration({ repoRoot, env: npmEnv });
    }
    console.error(
      "NPM_INSTALL_SAFE_RESOLUTION_FALLBACK: " + result.reason +
        "; running the original npm command under the repo writer.",
    );
  } else if (installPlan.reason) {
    console.error(
      "NPM_INSTALL_SAFE_RESOLUTION_FALLBACK: " + installPlan.reason +
        "; running the original npm command under the repo writer.",
    );
  }

  // Fallback commands need the same repair admission as manifest installs.
  // prune explicitly repairs extraneous packages, which declared/locked-path
  // probes cannot detect. Reserve first, then drain every existing reader.
  const repairInstalledGraph = !packageLockOnly && (npmArgs[0] === "prune" ||
    await withFsMutexRead(lockName, () => installedGraphNeedsRepair({ repoRoot, npmArgs })));

  // Lock order: repo writer → EXCLUSIVE cache (verify only, released) → shared cache
  // READ lease (reify). Verify must never overlap another checkout's reify — see
  // verifyNpmCacheExclusive (WI-10004430).
  const installStatus = await withFsMutex(
    lockName,
    async () => withWriterAttribution({
      repoRoot,
      nestedPath: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_PATH,
      invocationId: npmEnv.PAPERCUSP_INSTALL_ATTRIBUTION_ID,
      lockName,
      phase: "install-transaction",
    }, async () => {
      const mismatches = findRootLockManifestMismatches(repoRoot);
      if (mismatches.length > 0) {
        console.error(formatRootLockManifestMismatches(mismatches));
        return 1;
      }
      const cacheStatus = await verifyNpmCacheExclusive({
        verify: () => verifyNpmCache({ repoRoot, npmArgs, env: npmEnv }),
      });
      if (cacheStatus !== 0) {
        console.error(
          `NPM_INSTALL_SAFE_FATAL: npm cache verify exited ${cacheStatus}; cache integrity is unverified.`,
        );
        return cacheStatus;
      }
      return withPackageCacheReadLease(
        async () => {
          console.log(
            `NPM_INSTALL_SAFE running: npm ${npmArgs.join(" ")} (root=${repoRoot}, lock=${lockName})`,
          );
          // WI-10003114: a workspace-scoped command recomputes dependency-type flags from a
          // partial view of the graph; snapshot the lockfile so a flag-only rewrite can be undone.
          const lockfileBeforeScopedCommand =
            workspaceSelectorsForNpmArgs(npmArgs).length > 0
              ? readLockfileText(repoRoot)
              : undefined;
          // Tell the root `preinstall` guard that THIS install is the sanctioned one — it holds the
          // writer lock, so it cannot tear a green-checkpoint dependency copy. Without the marker the
          // guard cannot distinguish us from the bare `npm install` it exists to refuse.
          const status = await runNpmWithHeartbeat({
            phase: "install",
            args: npmArgs,
            cwd: repoRoot,
            env: npmEnv,
          });
          // A FAILED npm run reports its own error — never mask it with a dep verdict.
          if (status !== 0) return status;
          const verdict =
            packageLockOnly || process.env.PAPERCUSP_SKIP_DEP_VERIFY === "1"
              ? 0
              : await verifyDepsExtracted({ repoRoot, npmArgs, env: npmEnv });
          // After verification, because its bounded repair re-runs a scoped install.
          if (lockfileBeforeScopedCommand !== undefined) {
            const restore = restoreScopedFlagOnlyLockfileRewrite({
              repoRoot,
              beforeText: lockfileBeforeScopedCommand,
            });
            if (restore.restored)
              console.log(
                `NPM_INSTALL_SAFE kept the pre-install package-lock.json: this workspace-scoped command rewrote only npm dependency-type flags (${restore.reason}, ${restore.entries.length} entr${restore.entries.length === 1 ? "y" : "ies"}); a scoped install is not authoritative for them (WI-10003114)`,
              );
          }
          return verdict;
        },
        {
          onWaiting: ({ owner, elapsedMs }) => {
            console.log(
              `NPM_INSTALL_SAFE waiting on package-cache maintenance (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner.trim()}`,
            );
          },
        },
      );
    }),
    {
      // A queued install must not reserve every test/tool reader while a
      // protected generation snapshot is still being published (D-009).
      waitForReadersBeforeReserve: !repairInstalledGraph,
      // WI-10006385: re-announce every 30 s (was once) and close with the real wait.
      ...installLockWaitReporter({
        lock: "writer",
        describe: (owner, elapsedMs) =>
          `NPM_INSTALL_SAFE waiting on another agent's install (${Math.round(elapsedMs / 1000)}s so far) — holder: ${owner}`,
        log: (line) => console.log(line),
        budgetMs: resolveFsMutexTimeoutMs(),
      }),
      waitingNoticeIntervalMs: 30_000,
    },
  );
  if (installStatus !== 0) return installStatus;
  // A fallback can still be metadata-only (for example a local tarball).
  // Its new lock describes future installs, not the unchanged node_modules.
  if (packageLockOnly) return 0;
  return publishDependencyGeneration({ repoRoot, env: npmEnv });
}

function isInvokedDirectly(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isInvokedDirectly(process.argv[1], import.meta.url)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(
        `NPM_INSTALL_SAFE_ERROR ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
