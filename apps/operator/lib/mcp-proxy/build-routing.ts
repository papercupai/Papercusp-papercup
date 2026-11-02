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
  normalizeMcpExecutionTarget,
  sameMcpExecutionTarget,
  type McpExecutionTarget,
} from "@papercusp/operator-core/lib/serving-build";
import { normalizeMcpName } from "@papercusp/tooldef";

export { MCP_BUILD_ARGUMENT, MCP_BUILD_META_KEY, normalizeMcpBuild, type McpBuild };

export interface WorkerRoutableTarget extends BuildRoutableTarget {
  processRole?: string;
  executionTarget?: McpExecutionTarget;
}

/** Reuse the build-selector boundary for the one mutating git-sync operation.
 * Credentials stay on the original HTTP request; principal objects are never relayed.
 */
export function applyMcpWorkerSelector(rawBody: Buffer):
  | { kind: 'none' }
  | { kind: 'refused'; reason: string }
  | { kind: 'worker'; target: McpExecutionTarget; body: Buffer } {
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { return { kind: 'none' }; }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let selected: McpExecutionTarget | null = null;
  let selectedCount = 0;
  for (const message of messages) {
    if (!isRecord(message) || message.method !== 'tools/call' || !isRecord(message.params)) continue;
    const params = message.params;
    if (!isRecord(params.arguments)) continue;
    const outerArgs = params.arguments;
    let name = params.name;
    let args = params.arguments;
    if (name === 'tools:invoke' && isRecord(args.args)) { name = args.name; args = args.args; }
    if (name !== 'git-sync:run' || args.dryRun === true || args.target === undefined) continue;
    const target = normalizeMcpExecutionTarget(args.target);
    const envelopes = [message, params, message._meta, params._meta, outerArgs, outerArgs._meta, args, args._meta];
    if (!target || envelopes.some(value => isRecord(value) && Object.hasOwn(value, 'authenticatedPrincipal')))
      return { kind: 'refused', reason: 'invalid-target-or-host-local-principal' };
    if (selected && !sameMcpExecutionTarget(selected, target)) return { kind: 'refused', reason: 'ambiguous-target' };
    const build = isRecord(params._meta) ? normalizeMcpBuild(params._meta[MCP_BUILD_META_KEY]) : null;
    if (build && build !== target.environment) return { kind: 'refused', reason: 'target-build-conflict' };
    selected = target;
    selectedCount++;
    // The existing build fence validates the exact worker's declared environment.
    params._meta = { ...(isRecord(params._meta) ? params._meta : {}), [MCP_BUILD_META_KEY]: target.environment };
  }
  if (!selected) return { kind: 'none' };
  if (messages.length !== 1 || selectedCount !== 1) return { kind: 'refused', reason: 'mixed-worker-batch' };
  return { kind: 'worker', target: selected, body: Buffer.from(JSON.stringify(parsed)) };
}

export function selectWorkerForTarget<T extends WorkerRoutableTarget>(candidates: readonly T[], target: McpExecutionTarget):
  { kind: 'selected'; worker: T } | { kind: 'refused'; reason: string } {
  const matches = candidates.filter(worker => worker.processRole === 'bg-host' && worker.executionTarget &&
    sameMcpExecutionTarget(worker.executionTarget, target));
  return matches.length === 1 ? { kind: 'selected', worker: matches[0]! }
    : { kind: 'refused', reason: matches.length ? 'ambiguous-worker' : 'target-unavailable' };
}

export type McpBuildRouting =
  /** No tools/call names a build: forward the original body with today's routing. */
  | { kind: "none" }
  /**
   * Every build-naming tools/call agrees on one build. `body` is the rewritten request.
   * `defaultedTools` lists the (normalized) tools that named no build and were routed by
   * the current-build default below; absent when every routed call named its build.
   */
  | { kind: "routed"; build: McpBuild; body: Buffer; rewritten: boolean; defaultedTools?: string[] }
  /** A batch (or one call's argument vs `_meta`) names two different builds. */
  | { kind: "conflict"; builds: McpBuild[] };

type JsonRecord = Record<string, unknown>;

/**
 * gate-repair-plane-on-current-build-2026-10-15 P-003 (D-004): tools whose call names NO
 * build is routed to the current build (staging) instead of the release build.
 *
 * The repair plane spans repair/eject operations through release:repair-queue and the final
 * downgrade rung through release:test-downgrade. The release operator (:3070) runs the last
 * GREEN main and may not have newly-added repair tools. Measured before this change: ~96% of
 * repair-queue calls executed on a 13-day-old release build (D-002). Routing the full plane
 * to staging makes every ingress through this proxy run current-build repair logic.
 *
 * The default never overrides a caller: an explicit `build` argument or `_meta` selector
 * wins (`build:'main'` is the deliberate opt-out). It applies only when the proxy HAS a
 * staging target; a proxy without one (the bg-host and staging proxies front a
 * current build already) keeps today's routing. A defaulted call that cannot reach staging
 * is answered `staging_unavailable`; it never silently runs on the release build.
 */
export const CURRENT_BUILD_DEFAULT_TOOLS: readonly string[] = [
  "release:repair-queue",
  "release:test-downgrade",
];

const CURRENT_BUILD_DEFAULT_LOOKUP: ReadonlySet<string> = new Set(
  CURRENT_BUILD_DEFAULT_TOOLS.map(normalizeMcpName),
);
const TOOLS_INVOKE_NAME = normalizeMcpName("tools:invoke");
const CODE_RUN_NAME = normalizeMcpName("code:run");

/**
 * A `code:run` script executes its nested tool calls IN-PROCESS on whichever host served the
 * `code:run` itself (measured 2026-10-27: a nested repair-queue call landed on the release
 * build), so the proxy is the last place that can route them. A script that names a
 * current-build-default verb in any spelling the code:run namespace accepts
 * (`tools.release.repairQueue`, `['repair-queue']`, `repair_queue`) routes the WHOLE script to
 * the current build. A mention inside a comment also routes it — harmless, it only moves one
 * script to staging (gate-repair-plane-on-current-build D-005).
 */
const CURRENT_BUILD_DEFAULT_SCRIPT_PATTERNS: ReadonlyArray<{ tool: string; pattern: RegExp }> =
  CURRENT_BUILD_DEFAULT_TOOLS.map((tool) => {
    const verb = tool.slice(tool.indexOf(":") + 1);
    const words = verb.split(/[-_]/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return { tool: normalizeMcpName(tool), pattern: new RegExp(words.join("[-_]?"), "i") };
  });

/** The current-build-default verb a `code:run` script names, or `null`. */
export function currentBuildDefaultToolInScript(script: unknown): string | null {
  if (typeof script !== "string") return null;
  return CURRENT_BUILD_DEFAULT_SCRIPT_PATTERNS.find((p) => p.pattern.test(script))?.tool ?? null;
}

/** Decode a call's `arguments` (an object, or a JSON string encoded once or twice). */
function decodeArguments(raw: unknown): JsonRecord | null {
  let decoded: unknown = raw;
  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth++) {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  return isRecord(decoded) ? decoded : null;
}

/**
 * The normalized tool a tools/call targets when that tool defaults to the current build,
 * unwrapping `tools:invoke { name }`, and the verb a `code:run` script names (directly or via
 * `tools:invoke { name:'code:run' }`). `null` for every other tool.
 */
export function currentBuildDefaultTool(params: JsonRecord): string | null {
  if (typeof params.name !== "string") return null;
  let target = normalizeMcpName(params.name);
  let args = decodeArguments(params.arguments);
  if (target === TOOLS_INVOKE_NAME) {
    if (!args || typeof args.name !== "string") return null;
    target = normalizeMcpName(args.name);
    args = decodeArguments(args.args);
  }
  if (target === CODE_RUN_NAME) return currentBuildDefaultToolInScript(args?.script);
  return CURRENT_BUILD_DEFAULT_LOOKUP.has(target) ? target : null;
}

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
export function applyMcpBuildSelector(
  rawBody: Buffer,
  opts: { defaultToCurrentBuild?: boolean } = {},
): McpBuildRouting {
  const defaultToCurrentBuild = opts.defaultToCurrentBuild === true;
  // Cheap pre-filter: explicit selector spellings contain "build". Default-tool patterns
  // are derived from the allowlist so a newly added verb cannot be skipped before parsing.
  if (rawBody.length === 0) return { kind: "none" };
  const bodyText = rawBody.toString("utf8");
  const hasCurrentBuildDefault =
    defaultToCurrentBuild && CURRENT_BUILD_DEFAULT_SCRIPT_PATTERNS.some(({ pattern }) => pattern.test(bodyText));
  if (!(bodyText.includes("build") || hasCurrentBuildDefault)) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { kind: "none" };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const builds = new Set<McpBuild>();
  const defaultedTools: string[] = [];
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
    let build = fromArgs.build ?? fromMeta;
    if (!build && defaultToCurrentBuild) {
      const defaulted = currentBuildDefaultTool(params);
      if (defaulted) {
        build = "staging";
        defaultedTools.push(defaulted);
      }
    }
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
    ...(defaultedTools.length > 0 ? { defaultedTools } : {}),
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
  /** Tools routed here by the current-build default rather than a caller selector. */
  defaultedTools?: string[];
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
    ...(args.defaultedTools?.length
      ? {
          defaultedBy: {
            tools: args.defaultedTools,
            decision: "gate-repair-plane-on-current-build-2026-10-15#D-004",
            override: `these tools run on the current build by default; pass build:'${other}' to run on ${other} explicitly`,
          },
        }
      : {}),
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
