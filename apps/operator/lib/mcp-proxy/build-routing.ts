/**
 * Per-call build routing for the :9071 MCP proxy
 * (plan staging-build-tool-routing-2026-10-21, R-1 / P-001).
 *
 * Every agent's tools are served by the green `main` operator (:3070). A tool that was
 * just added or changed exists only on the staging operator (:3170), so an agent needs a
 * way to send ONE call there without re-dialling its MCP client. A `tools/call` may name
 * its build:
 *
 *   - `arguments.build: 'main' | 'staging'` on any tool (`tools:invoke` and `tools:find`
 *     declare it; on any other tool the proxy removes it before the operator sees it), or
 *   - `params._meta["papercusp/build"]`.
 *
 * The proxy removes `build` from the forwarded arguments, stamps
 * `_meta["papercusp/build"]` so the operator can check it is the build that was asked for
 * (R-2 refuses `build_mismatch` otherwise), and forwards the call ONLY to that build's
 * targets. A call that names a build never falls back to the other build: a staging call
 * that cannot reach staging is answered `staging_unavailable`, never run on main.
 *
 * A call with no selector is untouched and keeps today's routing (main first, staging as
 * the refused-only dev fallback).
 *
 * Pure: no I/O, no proxy state. `proxy.ts` owns the retry loop and the responses.
 */

// The selector vocabulary is shared with the operator-side fence (R-2) so the proxy and
// the operator can never disagree about what a valid selector is.
import {
  MCP_BUILD_ARGUMENT,
  MCP_BUILD_META_KEY,
  normalizeMcpBuild,
  type McpBuild,
} from "@papercusp/operator-core/lib/serving-build";

export { MCP_BUILD_ARGUMENT, MCP_BUILD_META_KEY, normalizeMcpBuild, type McpBuild };

export type McpBuildRouting =
  /** No tools/call names a build: forward the original body with today's routing. */
  | { kind: "none" }
  /** Every build-naming tools/call agrees on one build. `body` is the rewritten request. */
  | { kind: "routed"; build: McpBuild; body: Buffer; rewritten: boolean }
  /** A batch (or one call's argument vs `_meta`) names two different builds. */
  | { kind: "conflict"; builds: McpBuild[] };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read and remove a `build` selector from one call's `arguments`. MCP clients normally send
 * an object; some serialize it to a JSON string (once or twice). The string form is decoded,
 * edited and re-encoded to the same depth so the operator sees the shape it was sent.
 */
function takeArgumentBuild(params: JsonRecord): { build: McpBuild | null; changed: boolean } {
  const raw = params.arguments;
  if (isRecord(raw)) {
    const build = normalizeMcpBuild(raw[MCP_BUILD_ARGUMENT]);
    if (!build) return { build: null, changed: false };
    delete raw[MCP_BUILD_ARGUMENT];
    return { build, changed: true };
  }
  if (typeof raw !== "string") return { build: null, changed: false };
  let decoded: unknown = raw;
  let depth = 0;
  while (depth < 2 && typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
      depth++;
    } catch {
      return { build: null, changed: false };
    }
  }
  if (!isRecord(decoded)) return { build: null, changed: false };
  const build = normalizeMcpBuild(decoded[MCP_BUILD_ARGUMENT]);
  if (!build) return { build: null, changed: false };
  delete decoded[MCP_BUILD_ARGUMENT];
  let encoded: unknown = decoded;
  for (let i = 0; i < depth; i++) encoded = JSON.stringify(encoded);
  params.arguments = encoded;
  return { build, changed: true };
}

/**
 * Find the build a request names, strip the argument and stamp `_meta`. Bodies that are not
 * JSON, carry no tools/call, or name no build return `{ kind: 'none' }` without being
 * re-serialized, so the common path forwards the client's exact bytes.
 */
export function applyMcpBuildSelector(rawBody: Buffer): McpBuildRouting {
  // Cheap pre-filter: both selector spellings contain the literal "build".
  if (rawBody.length === 0 || !rawBody.includes("build")) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { kind: "none" };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const builds = new Set<McpBuild>();
  let rewritten = false;
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/call") continue;
    const params = message.params;
    if (!isRecord(params)) continue;
    const fromArgs = takeArgumentBuild(params);
    const meta = isRecord(params._meta) ? params._meta : null;
    const fromMeta = normalizeMcpBuild(meta?.[MCP_BUILD_META_KEY]);
    if (fromArgs.build && fromMeta && fromArgs.build !== fromMeta) {
      return { kind: "conflict", builds: [fromArgs.build, fromMeta] };
    }
    const build = fromArgs.build ?? fromMeta;
    if (!build) continue;
    builds.add(build);
    if (fromArgs.changed) rewritten = true;
    const stampedMeta = meta ?? {};
    if (stampedMeta[MCP_BUILD_META_KEY] !== build) {
      stampedMeta[MCP_BUILD_META_KEY] = build;
      rewritten = true;
    }
    params._meta = stampedMeta;
  }
  if (builds.size === 0) return { kind: "none" };
  if (builds.size > 1) return { kind: "conflict", builds: [...builds].sort() };
  const [build] = [...builds] as [McpBuild];
  return {
    kind: "routed",
    build,
    body: rewritten ? Buffer.from(JSON.stringify(parsed), "utf8") : rawBody,
    rewritten,
  };
}

export interface BuildRoutableTarget {
  port: number;
  source?: string;
}

/**
 * A target serves staging when it is the proxy's dev fallback candidate or listens on the
 * staging port. Everything else serves main.
 */
export function isStagingTarget(target: BuildRoutableTarget, stagingPort: number): boolean {
  return target.source === "static-fallback" || target.port === stagingPort;
}

/**
 * Narrow the proxy's ordered candidates to the requested build. `null` (no selector)
 * returns the list unchanged. An empty result means this proxy has no target for that
 * build; the caller answers `<build>_unavailable` instead of using another build.
 */
export function selectTargetsForBuild<T extends BuildRoutableTarget>(
  candidates: readonly T[],
  build: McpBuild | null,
  stagingPort: number,
): T[] {
  if (!build) return [...candidates];
  const wantStaging = build === "staging";
  return candidates.filter((t) => isStagingTarget(t, stagingPort) === wantStaging);
}

/** The error code for a build-routed call that could not reach its build. */
export function buildUnavailableError(build: McpBuild): `${McpBuild}_unavailable` {
  return `${build}_unavailable`;
}

/** Response body for a build-routed call that could not be delivered to its build. */
export function buildUnavailableBody(args: {
  build: McpBuild;
  traceId: string;
  reason: "no-target" | "refused";
  attempts: number;
  windowMs: number;
  detail?: string;
}): JsonRecord {
  const { build, reason } = args;
  const other = build === "staging" ? "main" : "staging";
  return {
    traceId: args.traceId,
    error: buildUnavailableError(build),
    build,
    forwardingResult: "not_applied",
    reason,
    attempts: args.attempts,
    windowMs: args.windowMs,
    ...(args.detail ? { detail: args.detail } : {}),
    note:
      reason === "no-target"
        ? `this MCP proxy has no ${build} operator configured, so a call that names build:'${build}' cannot be served; it was not sent to ${other}`
        : `the ${build} operator refused connections for the whole retry window (it restarts often); the call was not sent to ${other} and did not run — retry shortly`,
  };
}

/** Response body for a request whose calls name two different builds. */
export function buildConflictBody(traceId: string, builds: McpBuild[]): JsonRecord {
  return {
    traceId,
    error: "build_selector_conflict",
    builds,
    forwardingResult: "not_applied",
    note:
      "one request named more than one build (a batch mixing builds, or a call whose build argument and _meta papercusp/build disagree); send each build's calls as separate requests",
  };
}
