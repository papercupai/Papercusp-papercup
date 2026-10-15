/**
 * The dispatch-seat half of inherited governance policy
 * (papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, ENT-P-005-OUTCOME).
 *
 * `operatorKernelEnforcement` (projected-tool-deps.ts) calls `enforceInheritedPolicy` on every
 * boundary and phase, right after app-key scope and ahead of any installed resolver. That port
 * is the one seat shared by HTTP `/api/agent-tools/*`, MCP, IPC, reactions, indirect
 * `tools:invoke` dispatch and wrapped native/shell spawns — so a workspace action its
 * organization forbids is refused whichever door it arrives through.
 *
 * INSTALLATION: the PG-backed chain loader is installed by the host at bootstrap
 * (`installGovernancePolicyEnforcement`, called from apps/operator/bin/host-bootstrap.ts).
 * Until a host installs it the seat is inert (returns null) — exactly like the control-anchor
 * resolver — so a unit test that never booted a host never blocks on Postgres.
 *
 * FAIL CLOSED once installed: a malformed chain refuses; a failed read refuses with
 * `org_policy:unavailable` unless a previous successful read of that workspace exists, in which
 * case that last-known chain is used. This function never throws (the generic kernel wrapper
 * treats a throw as "unavailable, allow").
 *
 * SUBJECT MAPPING — what one dispatch "uses", per governed category:
 *  - tools   : the tool name, plus the inner `args.name` of a `tools:invoke` wrapper.
 *  - plugins : the `<plugin>` prefix of a namespaced plugin verb (`repomix.pack` → `repomix`).
 *  - models  : `model` / `modelId` / `modelAlias` arguments (string or string[]).
 *  - providers / regions (P-016a): `provider` / `region` arguments, plus the route of any
 *              model-provider host among the URL arguments and of any `<provider>/<model>` id
 *              (./processing-route.ts). Nothing is guessed from a bare model id.
 *  - egress  : the hostname of `url` / `urls` / `endpoint` / `baseUrl` / `href` / `uri`
 *              arguments (an unparseable value is judged verbatim, so it fails an allow list).
 *  - dataUse : declared `dataUse` / `dataUses` / `dataClass` arguments, plus `<ns>` for every
 *              `<ns>:read` capability the call declares (`secrets:read` → `secrets`). A
 *              `dataClass` / `dataClasses` value naming a customer data class
 *              (auth/hosted/customer-data-map.ts) is also judged as `class:<cls>` (P-016a DLP),
 *              the same label the injection legs carry, so one `class:pii` rule covers both.
 *  - actions : every declared capability (`plans:write`, `net:fetch`, …), `boundary:<b>` for any
 *              non-dispatch boundary, and `exec:<binary>` for a native/shell spawn.
 */
import type { KernelEnforcementRequest, KernelEnforcementResult } from '@papercusp/agent-mcp';
import { pinModuleState } from '@papercusp/module-singleton';
import { evaluateInheritedPolicy, type GovernedRequest } from './inherited-policy';
import { knownProcessingRouteOfHost, modelPrefixProviderHost, processingRouteOfHost } from './processing-route';
import { dataClassUseLabel, isCustomerDataClass } from '../auth/hosted/customer-data-map';
import { loadChainForWorkspace, type ChainLoad } from './store';

export const ORG_POLICY_CODE_PREFIX = 'org_policy:';

/** The administration tool can never be locked out by the policy it administers. */
export const GOVERNANCE_ADMIN_TOOLS: ReadonlySet<string> = new Set(['governance:policy']);

/**
 * The /admin/governance-policy pane's HTTP doors (endpoint-route/routes/governance-policy/policy.ts)
 * run the SAME operation as `governance:policy`, but they are route-only defineTools, so the
 * dispatch identity is their path, not that tool name. Match the path segment whatever prefix
 * the projection adds (`/api`, a method) so a deny-all org rule can never lock the pane out.
 */
const GOVERNANCE_ADMIN_ROUTE = /(?:^|[\s/])governance-policy\/(?:explain|simulate|set|add-exception)$/;

/** True for the governance administration surface — the tool and its admin-pane HTTP doors. */
export function isGovernanceAdminTool(toolName: string): boolean {
  return GOVERNANCE_ADMIN_TOOLS.has(toolName) || GOVERNANCE_ADMIN_ROUTE.test(toolName);
}

const CACHE_TTL_MS = 5_000;

type ChainLoader = (workspaceId: string) => Promise<ChainLoad>;

const state = pinModuleState('@papercusp/operator-core.governance-policy.enforce', () => ({
  loader: null as ChainLoader | null,
  cache: new Map<string, { at: number; load: ChainLoad }>(),
}));

/** Drop cached chains — called after every policy write so the next dispatch reads the new version. */
export function invalidateGovernancePolicyCache(workspaceId?: string): void {
  if (workspaceId) state.cache.delete(workspaceId);
  else state.cache.clear();
}

/** Install (or with `null`, remove) the chain loader the seat consults. */
export function setGovernancePolicyChainLoader(loader: ChainLoader | null): void {
  state.loader = loader;
  state.cache.clear();
}

/** Host bootstrap: enforce against the Postgres-backed policy store. Idempotent. */
export function installGovernancePolicyEnforcement(): void {
  setGovernancePolicyChainLoader((workspaceId) => loadChainForWorkspace(workspaceId));
}

export function isGovernancePolicyEnforcementInstalled(): boolean {
  return state.loader !== null;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim());
  return [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const MODEL_KEYS = ['model', 'modelId', 'modelAlias'] as const;
const PROVIDER_KEYS = ['provider', 'providers', 'modelProvider'] as const;
const REGION_KEYS = ['region', 'regions', 'processingRegion'] as const;
const URL_KEYS = ['url', 'urls', 'endpoint', 'baseUrl', 'href', 'uri'] as const;
const DATA_USE_KEYS = ['dataUse', 'dataUses', 'dataClass'] as const;
/** Arguments naming a customer data class; each known class is also judged as `class:<cls>`. */
const DATA_CLASS_KEYS = ['dataClass', 'dataClasses'] as const;
const PLUGIN_VERB = /^([a-z0-9][a-z0-9-]*)\.[a-z0-9_-]+$/i;

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase() || raw;
  } catch {
    return raw;
  }
}

/** Map one kernel request onto the governed categories. Pure, exported for tests. */
export function governedRequestOf(request: Pick<KernelEnforcementRequest, 'toolName' | 'capabilities' | 'args' | 'boundary' | 'operation'>): GovernedRequest {
  const args = record(request.args);
  const tools = [request.toolName];
  const bags: Array<Record<string, unknown>> = args ? [args] : [];
  if (request.toolName === 'tools:invoke' && args) {
    tools.push(...strings(args.name));
    const inner = record(args.args);
    if (inner) bags.push(inner);
  }
  const pick = (keys: readonly string[]) => bags.flatMap((bag) => keys.flatMap((k) => strings(bag[k])));
  const plugins = tools.flatMap((t) => {
    const m = PLUGIN_VERB.exec(t);
    return m && !t.includes(':') ? [m[1]] : [];
  });
  const capabilities = strings([...request.capabilities]);
  const dataUse = [
    ...pick(DATA_USE_KEYS),
    ...pick(DATA_CLASS_KEYS)
      .map((c) => c.toLowerCase())
      .filter(isCustomerDataClass)
      .map(dataClassUseLabel),
    ...capabilities.filter((c) => c.endsWith(':read')).map((c) => c.slice(0, -':read'.length)),
  ];
  const actions = [...capabilities];
  if (request.boundary && request.boundary !== 'dispatch') actions.push(`boundary:${request.boundary}`);
  if (request.boundary === 'native' || request.boundary === 'shell') {
    // wrapKernelSpawn sets `operation` to the whole command line ("<bin> <args…>"), so the
    // executable is `args.bin` when the adapter passed it, else the operation's first token.
    const bin = typeof args?.bin === 'string' && args.bin.trim() ? args.bin.trim() : (request.operation ?? '').trim().split(/\s+/)[0] ?? '';
    const base = bin.split('/').pop()?.trim();
    if (base) actions.push(`exec:${base}`);
  }
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const models = pick(MODEL_KEYS);
  const egress = pick(URL_KEYS).map(hostOf);
  // A route is judged only where the arguments NAME it: a model-provider host, or a
  // `<provider>/<model>` id. A bare model id or an ordinary web host names no route, so the
  // dispatch seat never guesses one (the session's own route is judged at launch/injection).
  const routes = [
    ...egress.map((host) => knownProcessingRouteOfHost(host)),
    ...models.map((m) => {
      const host = modelPrefixProviderHost(m);
      return host ? processingRouteOfHost(host) : null;
    }),
  ].filter((r): r is NonNullable<typeof r> => r !== null);
  return {
    tools: uniq(tools),
    plugins: uniq(plugins),
    models: uniq(models),
    providers: uniq([...pick(PROVIDER_KEYS).map((p) => p.toLowerCase()), ...routes.map((r) => r.provider)]),
    regions: uniq([...pick(REGION_KEYS).map((r) => r.toLowerCase()), ...routes.map((r) => r.region)]),
    egress: uniq(egress),
    dataUse: uniq(dataUse),
    actions: uniq(actions),
  };
}

function deny(code: string, reason: string, policyRevision?: string): KernelEnforcementResult {
  const namespaced = code.startsWith(ORG_POLICY_CODE_PREFIX) ? code : `${ORG_POLICY_CODE_PREFIX}${code}`;
  return {
    decision: 'deny',
    availability: 'available',
    applied: true,
    code: namespaced,
    // The code rides in the reason too: MCP surfaces only the reason text.
    reason: `${namespaced} — ${reason}`,
    ...(policyRevision ? { policyRevision } : {}),
  };
}

async function chainFor(workspaceId: string, loader: ChainLoader, nowMs: number): Promise<ChainLoad | { status: 'unavailable'; reason: string }> {
  const cached = state.cache.get(workspaceId);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.load;
  try {
    const load = await loader(workspaceId);
    state.cache.set(workspaceId, { at: nowMs, load });
    return load;
  } catch (err) {
    // Last-known chain beats refusing an already-governed workspace on a transient blip;
    // a workspace never read successfully is refused.
    if (cached) return cached.load;
    return { status: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface EnforceInheritedPolicyDeps {
  loadChain?: ChainLoader;
  now?: () => Date;
}

/** Judges one subject against a workspace's loaded chain: `null` allows, a result refuses. */
export type WorkspacePolicyJudge = (subject: GovernedRequest) => KernelEnforcementResult | null;

/**
 * Load a workspace's inherited policy chain ONCE and return a judge for any number of
 * subjects. This is the dispatch seat's own loader, cache and fail-closed semantics, exported
 * so seats that are not a tool dispatch — the agent session's launch-time model/provider and
 * the turn-start granted-sources injection (WI-6554700010011633) — are judged identically.
 *
 * Returns `null` (nothing governs) when no loader is installed or the workspace has no chain.
 * An unreadable or malformed chain returns a judge that refuses EVERY subject. Never throws.
 */
export async function workspacePolicyJudge(
  workspaceId: string,
  deps: EnforceInheritedPolicyDeps = {},
): Promise<WorkspacePolicyJudge | null> {
  const loader = deps.loadChain ?? state.loader;
  if (!loader || !workspaceId) return null;
  try {
    const now = deps.now?.() ?? new Date();
    const load = deps.loadChain
      ? await deps.loadChain(workspaceId).catch((err: unknown) => ({ status: 'unavailable' as const, reason: err instanceof Error ? err.message : String(err) }))
      : await chainFor(workspaceId, loader, now.getTime());
    if (load.status === 'none') return null;
    if (load.status === 'unavailable') {
      const refusal = deny('unavailable', `the governing policy for workspace ${workspaceId} cannot be read (${load.reason}); no effect authorized`);
      return () => refusal;
    }
    if (load.status === 'malformed') {
      const refusal = deny('malformed', `the governing policy chain for workspace ${workspaceId} is malformed (${load.reason})`);
      return () => refusal;
    }
    const chain = load.chain;
    const revision = chain.map((l) => `${l.layerId}@v${l.version}`).join('>');
    return (subject) => {
      try {
        const verdict = evaluateInheritedPolicy(chain, subject, now);
        return verdict.allow ? null : deny(verdict.code, verdict.reason, revision);
      } catch (err) {
        return deny('unavailable', `policy check failed (${err instanceof Error ? err.message : String(err)}); no effect authorized`);
      }
    };
  } catch (err) {
    const refusal = deny('unavailable', `policy check failed (${err instanceof Error ? err.message : String(err)}); no effect authorized`);
    return () => refusal;
  }
}

export async function enforceInheritedPolicy(
  request: KernelEnforcementRequest,
  deps: EnforceInheritedPolicyDeps = {},
): Promise<KernelEnforcementResult | null> {
  if (!(deps.loadChain ?? state.loader)) return null;
  try {
    const workspaceId = request.ctx?.workspaceId;
    if (!workspaceId) return null;
    const subject = governedRequestOf(request);
    if (subject.tools?.some((t) => isGovernanceAdminTool(t))) return null;
    const judge = await workspacePolicyJudge(workspaceId, deps);
    return judge ? judge(subject) : null;
  } catch (err) {
    return deny('unavailable', `policy check failed (${err instanceof Error ? err.message : String(err)}); no effect authorized`);
  }
}
