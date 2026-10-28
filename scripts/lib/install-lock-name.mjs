/**
 * The repo-keyed name of the install:safe mutex (scripts/npm-install-safe.mjs).
 *
 * Lives in its own side-effect-free module so RUNTIME code can derive the same
 * lock name without importing npm-install-safe.mjs: that script's CLI guard
 * (`import.meta.url === file://${process.argv[1]}`) is TRUE inside the esbuild
 * host bundle, where every module shares the bundle's import.meta.url, so
 * importing it from operator code would run an npm install on operator boot.
 * WI-10005137 (headless agent launches wait on this lock).
 */
import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isPathWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Root npm workspace directories declared by a package manifest. */
function workspaceRoots(root) {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return [];

  let patterns;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const workspaces = manifest.workspaces ?? [];
    patterns = Array.isArray(workspaces) ? workspaces : workspaces.packages ?? [];
  } catch {
    return [];
  }

  const included = patterns.filter((pattern) => typeof pattern === "string" && !pattern.startsWith("!"));
  const excluded = patterns.filter((pattern) => typeof pattern === "string" && pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const dirs = [];
  for (const pattern of included) {
    try {
      dirs.push(...globSync(pattern, { cwd: root, exclude: excluded }));
    } catch {
      // An invalid workspace glob cannot establish ownership of this path.
    }
  }
  return [...new Set(dirs)]
    .filter((dir) => existsSync(join(root, dir, "package.json")))
    .map((dir) => resolve(root, dir));
}

/**
 * Find the nearest enclosing npm workspace root that owns this path. A nested
 * workspace install and a root install both mutate the root's lockfile and
 * hoisted node_modules, so they must share one mutex even when `--repo-root`
 * names the nested integration directory.
 */
export function installLockRootForPath(repoRoot) {
  const target = realpathSync(resolve(repoRoot));
  let ancestor = dirname(target);
  while (ancestor !== dirname(ancestor)) {
    const owner = workspaceRoots(ancestor).find((workspaceRoot) =>
      isPathWithin(workspaceRoot, target) || isPathWithin(target, workspaceRoot),
    );
    if (owner) return realpathSync(ancestor);
    ancestor = dirname(ancestor);
  }
  return target;
}

/**
 * realpath so the `papercup` -> `papercusp` symlink and the canonical path
 * both resolve to the identical lock; a genuinely different checkout
 * (different real path) gets its own lock instead of blocking on this one.
 * Throws when `repoRoot` does not exist (realpath fails).
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function installLockNameForRoot(repoRoot) {
  const real = installLockRootForPath(repoRoot);
  const digest = createHash("sha1").update(real).digest("hex").slice(0, 12);
  return `npm-install-${digest}`;
}

/** Scoped reader ancestry; the old boolean marker proves no repository identity. */
function heldInstallMutexNames(env) {
  return String(env.PAPERCUSP_INSTALL_MUTEX_HELD ?? "")
    .split(",")
    .filter((name) => /^npm-install-[a-f0-9]{12}$/.test(name));
}

/** @param {string} lockName @param {NodeJS.ProcessEnv} [env] */
export function installMutexIsHeld(lockName, env = process.env) {
  return heldInstallMutexNames(env).includes(lockName);
}

/** Preserve ancestor leases when a child acquires a different repository lock. */
export function envWithInstallMutex(lockName, env = process.env) {
  return {
    ...env,
    PAPERCUSP_INSTALL_MUTEX_HELD: [...new Set([...heldInstallMutexNames(env), lockName])].join(","),
  };
}
