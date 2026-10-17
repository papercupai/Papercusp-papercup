/**
 * Resolve the harness-admin Postgres URL the operator should connect to.
 *
 * Resolution order (delegated to @papercusp/embedded-pg-discovery):
 *   1. Explicit env (HARNESS_ADMIN_DATABASE_URL > DATABASE_URL > PAPERCUSP_PG_URL)
 *      — operator inside the desktop sidecar always hits this path because
 *      Tauri main injects HARNESS_ADMIN_DATABASE_URL with the embedded port.
 *   2. The canonical operator env-file pin, shared with getOrgPg, unless an
 *      explicit or isolated-process configuration selects another target.
 *   3. Discovery file at ~/.papercusp/embedded-pg.json — written by the
 *      desktop's Rust main when embedded-pg comes up. Lets a `npm run dev`
 *      operator share state with a running desktop.
 *   4. Fallback: native PG on PAPERCUSP_PG_PORT (when set) or :5432 with the
 *      standard harness_admin creds. Preserves zero-config dev for users who
 *      don't run the desktop while keeping isolated workers on their own PG.
 *
 * This module is the Papercusp-specific *configuration* of the generic
 * @papercusp/embedded-pg-discovery resolver (P-003 of
 * papercusp-systems-abstraction-2026-05-29) plus the in-process cache.
 */
import { resolvePgUrl } from '@papercusp/embedded-pg-discovery';
import { readOperatorDbEnvLocal } from '@papercusp/db-org/operator-db-env';
import { join } from 'node:path';

const NATIVE_FALLBACK = 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

/**
 * Match the connection layer's isolated-process fallback. A worker launched
 * before its discovery file is written still has PAPERCUSP_PG_PORT, and must
 * not fall through to the shared native :5432 instance.
 */
function nativeFallbackUrl(): string {
  const port = Number(process.env.PAPERCUSP_PG_PORT);
  if (Number.isInteger(port) && port > 0 && port <= 65_535) {
    return `postgresql://harness_admin:harness_admin_pwd@localhost:${port}/papercusp`;
  }
  return NATIVE_FALLBACK;
}

/**
 * EI-13917: the generic resolver (by design, domain-free) resolves a
 * RELATIVE `discoveryFile.path` under `os.homedir()` — but honors an
 * ABSOLUTE path as-is. `PAPERCUSP_HOME` is the Papercusp-specific isolation
 * escape hatch (packages/operator-core/lib/papercusp-root.ts) — when a
 * caller has scoped its own PAPERCUSP_HOME (an isolated gate/smoke-test
 * instance, a per-workspace fleet session), its discovery file must live
 * under THAT dir, never the box-wide `~/.papercusp/`. Mirrors the matching
 * fix in connection.ts / serve.ts / host-platform's desktop.ts.
 */
function discoveryFilePath(): string {
  return process.env.PAPERCUSP_HOME
    ? join(process.env.PAPERCUSP_HOME, 'embedded-pg.json')
    : '.papercusp/embedded-pg.json';
}

let cached: { url: string; source: string } | null = null;

export function getHarnessAdminUrl(): string {
  return getHarnessAdminUrlWithSource().url;
}

export function getHarnessAdminUrlWithSource(): { url: string; source: string } {
  // ONLY the `env` source is pinned. HARNESS_ADMIN_DATABASE_URL is injected once
  // by Tauri main and is stable for the process lifetime, so caching it is safe.
  // The DISCOVERY and FALLBACK sources are re-resolved on every call because the
  // embedded-pg.json PORT CHANGES across launches (the desktop's Rust main picks a
  // new free PG port each boot) — a caller that resolves EARLY (e.g. sync-sse's
  // invalidation bus, before serve rewrites the discovery file this boot) would
  // otherwise pin a PREVIOUS launch's stale port and wedge every later LISTEN/query
  // onto a dead port for the whole process lifetime. This was the Windows bug where
  // sync-sse / dbos / ui-intents-bus ECONNREFUSED'd a stale port thousands of times
  // and NEVER recovered even though embedded PG was up on the fresh port (the WSL
  // distro persists the prior-boot embedded-pg.json across launches, so the stale
  // read is guaranteed there; 2026-07-02). Also covers WI-1544 (a module-scope
  // caller resolving at IMPORT time, before HARNESS_ADMIN_DATABASE_URL is injected,
  // must not pin the native :5432 fallback). Re-reading a small JSON file per call
  // is cheap and mirrors connection.ts adminUrl()'s "discovery can change — re-read
  // every call" contract.
  if (cached && cached.source === 'env') return cached;

  // EI-26126932331699256: dedicated pools used this generic discovery chain
  // while getOrgPg already honored the operator's .env.local. A healthy foreign
  // desktop cluster then accepted writes despite the primary pool's correct
  // target banner. Reuse the canonical resolver's file parsing/precedence;
  // preserve every explicit pin and the existing isolated home/PG behavior.
  const explicitOrIsolated = ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL',
    'PAPERCUSP_PG_PORT', 'PAPERCUSP_HOME'].some(key => Boolean(process.env[key]))
    || process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1';
  if (!explicitOrIsolated) {
    const operatorEnv = readOperatorDbEnvLocal();
    const url = operatorEnv.HARNESS_ADMIN_DATABASE_URL || operatorEnv.DATABASE_URL;
    if (url) return { url, source: 'operator-env-file' };
  }

  const { url, source } = resolvePgUrl({
    envVars: ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'],
    // Isolated test/gate workers set this lever so a stale box-wide discovery
    // file cannot reroute them away from their own embedded Postgres.
    discoveryFile:
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1' ? undefined : { path: discoveryFilePath() },
    fallbackUrl: nativeFallbackUrl(),
  });

  // Preserve the historical source label for the native fallback so any
  // diagnostics/log assertions keyed on 'native-fallback' keep working.
  cached = { url, source: source === 'fallback' ? 'native-fallback' : source };
  return cached;
}

/** Test-only — clears the in-process cache between tests. */
export function _resetHarnessAdminUrlCacheForTests(): void {
  cached = null;
}
