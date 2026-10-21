/**
 * Wire tooldef's server-vintage seam to Papercusp's own build info + process uptime
 * (EI-19953470656367880 — a long-lived server, chiefly a Tauri desktop's own spawned
 * operator, has no file-watch and serves whatever code it booted with; an
 * `Unrecognized key` rejection for a newly-added tool arg gave no hint that the
 * process itself predates the arg).
 *
 * `@papercusp/tooldef`'s `unknownArgHint` calls the host-registered resolver on every
 * `Unrecognized key` invalid_args failure; the default is unregistered (no hint
 * appended). The HOST owns the policy, so the resolver is registered HERE — imported
 * as a side effect at startup (see `agent-tools/index.ts`), the same shape as
 * `context-gauge-wiring.ts` / `delta-flag-wiring.ts`.
 *
 * Both fields reuse EXISTING, already-cached reads: `getBuildInfo().sha` is the same
 * short git sha /api/health already reports (resolved once, cached — see
 * build-info.ts), and `process.uptime()` is the process's own age. Neither does I/O
 * on the hot path.
 */

import { setServerVintageResolver, type ServerVintage } from '@papercusp/agent-mcp';
import { getBuildInfo } from '../build-info';

// staging-build-tool-routing-2026-10-21 R-3: the MCP route is a per-call `build: 'staging'`
// (the :9071 proxy sends it to :3170); ptool callers still pass the URL.
const STAGING_RECOVERY_ENDPOINT =
  "the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments " +
  "(or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; " +
  'with ptool, pass --url=http://127.0.0.1:3170 explicitly';

setServerVintageResolver((): ServerVintage => ({
  buildId: getBuildInfo().sha,
  bootedAgoMs: process.uptime() * 1000,
  freshCodeEndpoint: STAGING_RECOVERY_ENDPOINT,
}));
