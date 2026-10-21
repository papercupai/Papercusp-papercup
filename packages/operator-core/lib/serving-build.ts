/**
 * serving-build — which BUILD this operator serves (`main` or `staging`), and the
 * per-call build fence (plan staging-build-tool-routing-2026-10-21, R-2 / P-002).
 *
 * A tool call may name the build that should serve it: `arguments.build` (declared by
 * `tools:invoke` and `tools:find`) or `params._meta["papercusp/build"]` (stamped by the
 * :9071 MCP proxy, which routes the call to that build's operator — R-1). The proxy is
 * the router; this module is the check. A client that bypasses the proxy and sends a
 * `build:'staging'` call straight to :3070 must be refused (`build_mismatch`) instead of
 * silently running a staging-intended call on main.
 *
 * Build identity follows the same source `tool_invocations.serving_host` uses
 * (`hostIdentity` in serving-host-identity.ts: `PAPERCUSP_HONO_PORT ?? PORT`): the
 * operator listening on the staging port (:3170) serves `staging`; every other operator
 * serves `main` — on a packaged install that is the only operator there is. An operator
 * can declare its build explicitly with `PAPERCUSP_SERVING_BUILD=main|staging`.
 */
import { getServingHostIdentity } from './serving-host-identity';

export type McpBuild = 'main' | 'staging';

/** `_meta` key the proxy stamps on a build-routed call. */
export const MCP_BUILD_META_KEY = 'papercusp/build';
/** `_meta` key on a result naming the build that served it. */
export const MCP_SERVING_BUILD_META_KEY = 'papercusp/servingBuild';
/** The argument an agent passes on a tool call. */
export const MCP_BUILD_ARGUMENT = 'build';
/** The dev-box staging operator's port. */
export const STAGING_OPERATOR_PORT = 3170;
/** Tools whose own schema declares `build`; every other tool never sees the argument. */
export const BUILD_DECLARING_TOOLS: ReadonlySet<string> = new Set(['tools:invoke', 'tools:find']);

/** Accept `main` / `staging` (trimmed, any case). Anything else is not a selector. */
export function normalizeMcpBuild(value: unknown): McpBuild | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v === 'main' || v === 'staging' ? v : null;
}

/** Pure resolver (env injectable for tests). */
export function resolveServingBuild(env: NodeJS.ProcessEnv = process.env): McpBuild {
  const declared = normalizeMcpBuild(env.PAPERCUSP_SERVING_BUILD);
  if (declared) return declared;
  const port = Number(env.PAPERCUSP_HONO_PORT ?? env.PORT);
  return port === STAGING_OPERATOR_PORT ? 'staging' : 'main';
}

let cachedBuild: McpBuild | null = null;

/** This process's build, resolved once (a process constant, like serving-host identity). */
export function getServingBuild(): McpBuild {
  if (!cachedBuild) cachedBuild = resolveServingBuild();
  return cachedBuild;
}

/** Test-only — clear the cache. */
export function _resetServingBuildForTest(): void {
  cachedBuild = null;
}

/** `build_mismatch` refusal text, naming both builds and how to reach the right one. */
export function buildMismatchMessage(requested: McpBuild, serving: McpBuild): string {
  return (
    `build_mismatch: this call asks for build '${requested}', but this operator serves '${serving}'. ` +
    `It was not run. Send it through the Papercusp MCP proxy (:9071), which routes build:'${requested}' ` +
    `to the ${requested} operator${requested === 'staging' ? ` (:${STAGING_OPERATOR_PORT})` : ''}.`
  );
}

/** One line naming the build (and loaded code) that served a build-routed call. */
export function servedByBuildNote(serving: McpBuild): string {
  const id = getServingHostIdentity();
  return `⟦build⟧ served by build '${serving}' (${id.host}${id.buildSha ? `, sha ${id.buildSha}` : ''})`;
}

/** Throw `build_mismatch` when `requested` names a build this operator does not serve. */
export function assertServingBuild(
  requested: unknown,
  serving: McpBuild = getServingBuild(),
): McpBuild | null {
  if (requested === undefined || requested === null) return null;
  const build = normalizeMcpBuild(requested);
  if (!build) {
    throw new Error(`invalid_build: build must be 'main' or 'staging' (got ${JSON.stringify(requested)})`);
  }
  if (build !== serving) throw new Error(buildMismatchMessage(build, serving));
  return build;
}

type JsonRecord = Record<string, unknown>;
function isRecord(v: unknown): v is JsonRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The build a tools/call request names: `_meta` stamp first, else `arguments.build`. */
export function requestedBuildOf(req: unknown): { build: McpBuild | null; conflict: boolean } {
  const params = isRecord(req) && isRecord(req.params) ? req.params : null;
  if (!params) return { build: null, conflict: false };
  const fromMeta = isRecord(params._meta) ? normalizeMcpBuild(params._meta[MCP_BUILD_META_KEY]) : null;
  const fromArgs = isRecord(params.arguments) ? normalizeMcpBuild(params.arguments[MCP_BUILD_ARGUMENT]) : null;
  if (fromMeta && fromArgs && fromMeta !== fromArgs) return { build: null, conflict: true };
  return { build: fromMeta ?? fromArgs, conflict: false };
}

/**
 * The tools/call build fence. Before dispatch: a call naming a build this operator does
 * not serve is refused `build_mismatch` (the target never runs). A matching call on a
 * tool that does not declare `build` has the argument removed so the tool's own schema
 * never sees it. After dispatch: a build-routed result gets one text line naming the
 * build that served it, plus `_meta["papercusp/servingBuild"]`. Calls that name no build
 * pass through untouched.
 */
export function withMcpBuildFence<Req, Res>(
  handler: (req: Req, extra: unknown) => Promise<Res>,
  servingBuild: () => McpBuild = getServingBuild,
): (req: Req, extra: unknown) => Promise<Res> {
  return async (req, extra) => {
    const { build, conflict } = requestedBuildOf(req);
    if (conflict) {
      throw new Error(
        "build_selector_conflict: this call's build argument and _meta papercusp/build name different builds; it was not run",
      );
    }
    if (!build) return handler(req, extra);
    const serving = servingBuild();
    if (build !== serving) throw new Error(buildMismatchMessage(build, serving));
    const params = (req as { params: JsonRecord }).params;
    const name = typeof params.name === 'string' ? params.name : '';
    if (isRecord(params.arguments) && MCP_BUILD_ARGUMENT in params.arguments && !BUILD_DECLARING_TOOLS.has(name)) {
      const { [MCP_BUILD_ARGUMENT]: _stripped, ...rest } = params.arguments;
      params.arguments = rest;
    }
    const result = await handler(req, extra);
    return annotateServingBuild(result, serving);
  };
}

/** Append the served-by line and `_meta` stamp to an MCP tool result (content array only). */
export function annotateServingBuild<Res>(result: Res, serving: McpBuild): Res {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  const meta = isRecord(result._meta) ? result._meta : {};
  return {
    ...result,
    content: [...result.content, { type: 'text', text: servedByBuildNote(serving) }],
    _meta: { ...meta, [MCP_SERVING_BUILD_META_KEY]: serving },
  } as Res;
}
