/**
 * build-info — the git sha + version the RUNNING operator process was built from.
 *
 * WI-265 (deploy-skew footgun): the psu-launcher runs from the staging tree
 * (latest code) while :3070 serves the green-release checkout — a launcher change
 * that depends on a not-yet-promoted endpoint silently 404s, with NO visibility
 * into the skew. Exposing the server's sha on /api/health makes the skew
 * DIAGNOSABLE: a launcher (or any agent) compares its own tree's sha to the
 * server's and knows when it's ahead.
 *
 * Resolved ONCE and cached: generated bundles prefer the source SHA baked into
 * the artifact, because a runtime environment can outlive the bundle it was
 * meant to label. `PAPERCUSP_BUILD_SHA` remains the fallback when no baked SHA
 * exists; non-bundled development hosts then use a one-time `git rev-parse
 * --short HEAD`. Best-effort — any failure yields `sha: null`, so the
 * zero-dependency /api/health contract (must answer even half-init, never
 * throw) holds.
 *
 * WI-2644: the packaged desktop sidecar runs a bundled `serve.mjs` with no
 * `npm_package_version` in its env (that's only set when npm itself invokes a
 * script) — so `version` silently fell back to '0.0.0' on every real desktop
 * build, even though the shipped app has a real version (tauri.conf.json).
 * Mirrors the working PAPERCUSP_BUILD_SHA pattern: prefer an explicit
 * `PAPERCUSP_BUILD_VERSION` (set at build time from tauri.conf.json's version,
 * see papercusp-desktop/bin/release-local.sh — forwarded into the sidecar's
 * env by src-tauri/src/main.rs), else fall back to npm_package_version, else
 * '0.0.0'.
 *
 * EI-18751304112302229: build-desktop-sidecar.sh ALSO bakes the version
 * directly into the bundle via esbuild `--define`, for any build path that
 * doesn't go through main.rs's env-forward — but a `--define` is a SYNTACTIC
 * rewrite of the exact literal expression it names, and this file never
 * writes `process.env.npm_package_version` verbatim (it reads through the
 * `opts.env ?? process.env` injectable-seam alias below), so a define
 * targeting that expression can never match here. Read the baked identifier
 * directly instead — same idiom as `__PAPERCUSP_BUNDLED_SIDECAR__`
 * (util/cli-entry.ts): the identifier itself is the literal, so there is no
 * alias for esbuild to miss.
 *
 * EI-21647996938145436: the generated bg-host bundle is the code that actually
 * runs scheduled routines. Falling back to `git rev-parse` from that bundle is
 * not a loaded-code identity — it reads the current checkout even when the
 * bundle on disk is older. `bundle-host.sh` therefore bakes the source SHA into
 * a dedicated identifier. An identity-less bundled artifact stays UNKNOWN
 * rather than borrowing the checkout's current SHA.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Injected by esbuild `--define` in bundled host/desktop artifacts (see
// apps/operator/bin/bundle-host.sh and papercusp-desktop/bin/
// build-desktop-sidecar.sh). Absent (bare reference would throw ReferenceError)
// under tsx/dev/test/the non-bundled operator — read it via `typeof` so the
// reference never throws.
declare const __PAPERCUSP_SIDECAR_VERSION__: string | undefined;
declare const __PAPERCUSP_BUNDLED_SOURCE_SHA__: string | undefined;
declare const __PAPERCUSP_BUNDLED_SIDECAR__: boolean | undefined;

/**
 * Which rung of the resolution ladder produced `sha`. `git` is the ONE boot-time
 * `rev-parse` of a non-bundled host (cached for the process lifetime, so it still
 * names the loaded code); `unresolved` always pairs with `sha: null`.
 */
// dirty means the baked identity carries +dirty and cannot name an attributable commit.
export type BuildShaSource = 'baked' | 'env' | 'git' | 'dirty' | 'unresolved';

export interface BuildInfo {
  /** Short source SHA for the running artifact, or null if dirty/unresolved. */
  sha: string | null;
  /** package.json version (npm_package_version), or '0.0.0' if unset. */
  version: string;
}

/**
 * The full resolution, including WHERE the sha came from
 * (gate-repair-plane-on-current-build-2026-10-15 R-1). `BuildInfo` stays the plain
 * `{ sha, version }` value other records embed; the source is a property of the resolving
 * process, so it lives here and `getBuildInfo()` is a projection of the same cached resolution.
 */
export interface ResolvedBuild extends BuildInfo {
  shaSource: BuildShaSource;
}

type ResolveBuildOptions = Parameters<typeof resolveBuild>[0];

/** Pure resolver (injectable seams for tests). */
export function resolveBuildInfo(opts: ResolveBuildOptions = {}): BuildInfo {
  const { sha, version } = resolveBuild(opts);
  return { sha, version };
}

/** Pure resolver returning the sha's source too (injectable seams for tests). */
export function resolveBuild(opts: {
  env?: NodeJS.ProcessEnv;
  gitSha?: () => string | null;
  /** Test seam for the esbuild-baked `__PAPERCUSP_SIDECAR_VERSION__` global. */
  bakedVersion?: string;
  /** Test seam for the esbuild-baked source SHA used by generated host bundles. */
  bakedSha?: string | null;
  /** Test seam for the bundled-artifact guard (the real value is an esbuild global). */
  bundled?: boolean;
} = {}): ResolvedBuild {
  const env = opts.env ?? process.env;
  const envVersion = env.PAPERCUSP_BUILD_VERSION?.trim();
  const bakedVersion =
    opts.bakedVersion ??
    (typeof __PAPERCUSP_SIDECAR_VERSION__ !== 'undefined' ? __PAPERCUSP_SIDECAR_VERSION__ : undefined);
  const version = envVersion || bakedVersion || env.npm_package_version || '0.0.0';
  const bakedSha =
    opts.bakedSha !== undefined
      ? opts.bakedSha?.trim() || null
      : (typeof __PAPERCUSP_BUNDLED_SOURCE_SHA__ !== 'undefined'
        ? __PAPERCUSP_BUNDLED_SOURCE_SHA__?.trim() || null
        : null);
  // A commit SHA cannot identify a bundle that included local working-tree bytes.
  if (bakedSha?.endsWith('+dirty')) return { sha: null, shaSource: 'dirty', version };
  if (bakedSha) return { sha: bakedSha, shaSource: 'baked', version };
  const envSha = env.PAPERCUSP_BUILD_SHA?.trim();
  if (envSha) return { sha: envSha, shaSource: 'env', version };
  const bundled =
    opts.bundled ??
    (typeof __PAPERCUSP_BUNDLED_SIDECAR__ !== 'undefined' && __PAPERCUSP_BUNDLED_SIDECAR__ === true);
  // A generated bundle with no baked SHA cannot prove what source it contains.
  // Do not report the checkout's current HEAD as if it were the loaded bytes.
  if (bundled) return { sha: null, shaSource: 'unresolved', version };
  const gitSha = opts.gitSha ?? defaultGitSha;
  let sha: string | null = null;
  try {
    sha = gitSha();
  } catch {
    sha = null;
  }
  return sha ? { sha, shaSource: 'git', version } : { sha: null, shaSource: 'unresolved', version };
}

/**
 * Per-attempt budget for the one-time `git rev-parse --short HEAD` fallback.
 *
 * WI-6554700010018173: this read happens ONCE per process (the boot-warm
 * invariant below, WI-2141731) and its result is cached for the process
 * lifetime, so a timeout is not a slow request — it is a permanent `sha: null`.
 * The failing test receipt did not capture why git returned no SHA, so a
 * host-load timeout is unverified. A retry after this resolution point could
 * read a later checkout and mislabel the loaded code; retry one transient
 * timeout now, then keep the process identity snapshot stable.
 */
export const GIT_SHA_ATTEMPT_TIMEOUT_MS = 10_000;
const GIT_SHA_ATTEMPTS = 2;

type GitExec = (args: string[], opts: { cwd: string; timeout: number }) => string;

function isTimeout(err: unknown): boolean {
  const e = err as { code?: unknown; signal?: unknown } | null;
  return e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM';
}

/** Resolve the short HEAD sha of `cwd`, retrying only a timed-out attempt. */
export function resolveGitShortSha(
  cwd: string,
  exec: GitExec = (args, opts) =>
    execFileSync('git', args, { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
): string | null {
  for (let attempt = 1; attempt <= GIT_SHA_ATTEMPTS; attempt++) {
    try {
      return exec(['rev-parse', '--short', 'HEAD'], { cwd, timeout: GIT_SHA_ATTEMPT_TIMEOUT_MS }).trim() || null;
    } catch (err) {
      // Not a git checkout, no git binary, etc. are definitive: retrying cannot help.
      if (!isTimeout(err)) return null;
    }
  }
  return null;
}

function defaultGitSha(): string | null {
  return resolveGitShortSha(fileURLToPath(new URL('../', import.meta.url)));
}

let cached: ResolvedBuild | null = null;
let cachedInfo: BuildInfo | null = null;

/** The running process's full build resolution (sha + its source), resolved once and cached. */
export function getResolvedBuild(): ResolvedBuild {
  if (!cached) cached = resolveBuild();
  return cached;
}

/** The running operator's build info, resolved once and cached (boot-cheap; the
 *  request path reads the cache, preserving the zero-dep /api/health contract). */
export function getBuildInfo(): BuildInfo {
  if (!cachedInfo) {
    const { sha, version } = getResolvedBuild();
    cachedInfo = { sha, version };
  }
  return cachedInfo;
}

/** Test-only — clear the cache. */
export function _resetBuildInfoForTest(): void {
  cached = null;
  cachedInfo = null;
}
