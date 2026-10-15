/**
 * Inherited governance policy for the two model-inference seats that are NOT a tool dispatch
 * (WI-6554700010011633, papercusp-enterprise-readiness-roadmap-2026-10-09 P-007, "Model
 * inference" row of the pilot processing map):
 *
 *  1. LAUNCH — an agent session's own model and provider are chosen when it is launched
 *     (capability:launch-agent, fleet:launch-on-plan), after alias resolution and saved-profile
 *     inheritance. The dispatch seat (./enforce.ts) only sees the raw `model` argument, so a
 *     defaulted, inherited or per-member model and the backend's provider escaped it.
 *  2. INJECTION — turn-start granted-sources context (data-sources/granted-sources-injection.ts)
 *     sends personal, pot, organization and live-search text into the session's model context.
 *
 * Both are judged by the SAME chain, loader, cache and fail-closed semantics as the dispatch
 * seat (`workspacePolicyJudge`). Category mapping:
 *
 *  - models : the resolved session model id, with any `:<effort>` suffix removed.
 *  - egress : the provider API host the session's inference reaches. A backend whose provider
 *             cannot be resolved here is judged as UNRESOLVED_PROVIDER_EGRESS, so an egress
 *             allow list refuses it rather than assuming it is permitted.
 *  - providers / regions (P-016a): the model provider and processing region that API host
 *             belongs to (./processing-route.ts). A global endpoint's region is unresolved, so
 *             a `regions` allow list refuses it until a region-pinned route exists.
 *  - dataUse: every injection leg carries MODEL_CONTEXT_DATA_USE plus its own label, so one
 *             rule (`dataUse.deny: ['model-context']`) stops all injected source text, and a
 *             narrower rule stops one leg. Each leg also carries a `class:<cls>` label for every
 *             data class its pilot processing-map path moves (P-016a DLP), so
 *             `dataUse.deny: ['class:pii']` withholds every leg that can carry personal data.
 *
 * The provider is mapped to `egress`, never to `models`: a `models` allow list of model ids
 * would otherwise refuse every launch because a provider token matches none of its patterns.
 */
import type { GovernedRequest } from './inherited-policy';
import { workspacePolicyJudge, type EnforceInheritedPolicyDeps } from './enforce';
import { MODEL_PROVIDER_EGRESS, modelPrefixProviderHost, processingRouteOfHost, type ProcessingRoute } from './processing-route';
import { dataClassUseLabel } from '../auth/hosted/customer-data-map';
import { pilotPathDataClasses } from '../data-governance/pilot-processing-map';

/** Provider API host per launch backend. `omp` routes per model, so it is resolved from the model. */
export const BACKEND_PROVIDER_EGRESS: Readonly<Record<string, string>> = {
  claude: 'api.anthropic.com',
  'claude-code': 'api.anthropic.com',
  codex: 'api.openai.com',
};

/** Provider API host for a `<provider>/<model>` id; defined beside the route resolver. */
export { MODEL_PROVIDER_EGRESS };

/** Judged when the provider of a launch cannot be resolved; an egress allow list refuses it. */
export const UNRESOLVED_PROVIDER_EGRESS = 'unresolved-provider';

export const DEFAULT_LAUNCH_BACKEND = 'claude';

const EFFORT_SUFFIX = /:(low|medium|high|xhigh|max)$/i;

export interface LaunchGovernanceTarget {
  /** Launch backend (`claude` | `codex` | `omp`). Omitted means the default backend. */
  agent?: string | null;
  /** The resolved model id, when the launch names or inherits one. */
  model?: string | null;
}

/** The session model id as a policy value: trimmed, effort suffix removed. */
export function normalizeSessionModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  return trimmed.replace(EFFORT_SUFFIX, '') || null;
}

/** Provider API host for one launch target. */
export function providerEgressOf(target: LaunchGovernanceTarget): string {
  const agent = target.agent?.trim() || DEFAULT_LAUNCH_BACKEND;
  const byBackend = BACKEND_PROVIDER_EGRESS[agent];
  if (byBackend) return byBackend;
  return modelPrefixProviderHost(normalizeSessionModel(target.model)) || UNRESOLVED_PROVIDER_EGRESS;
}

/**
 * The governance target of a RECORDED launch (an `adv_sessions` row): the backend from the
 * row's `agent` column (else the spec's `agent`), the model from the spec. Returns null when
 * neither is recorded, so an unknown session stays unknown instead of defaulting to a backend.
 * Pure, exported for tests.
 */
export function launchTargetFromRecord(
  record: { agent?: string | null; launchSpec?: unknown } | null | undefined,
): LaunchGovernanceTarget | null {
  if (!record) return null;
  const spec =
    record.launchSpec && typeof record.launchSpec === 'object' && !Array.isArray(record.launchSpec)
      ? (record.launchSpec as Record<string, unknown>)
      : {};
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const agent = text(record.agent) ?? text(spec.agent);
  const model = text(spec.model);
  if (!agent && !model) return null;
  return { agent, model };
}

/**
 * The model-processing route (provider + region) one launch target's inference reaches, derived
 * from its provider API host (./processing-route.ts). An unresolved backend yields the
 * unresolved sentinels, so a `providers` or `regions` allow list refuses it.
 */
export function launchProcessingRouteOf(target: LaunchGovernanceTarget): ProcessingRoute {
  return processingRouteOfHost(providerEgressOf(target));
}

/** Map launch targets onto governed categories. Pure, exported for tests. */
export function launchGovernedRequest(targets: readonly LaunchGovernanceTarget[]): GovernedRequest {
  const models = new Set<string>();
  const egress = new Set<string>();
  const providers = new Set<string>();
  const regions = new Set<string>();
  for (const target of targets) {
    const model = normalizeSessionModel(target.model);
    if (model) models.add(model);
    egress.add(providerEgressOf(target));
    const route = launchProcessingRouteOf(target);
    providers.add(route.provider);
    regions.add(route.region);
  }
  return { models: [...models], providers: [...providers], regions: [...regions], egress: [...egress] };
}

export interface SessionGovernanceDeps extends EnforceInheritedPolicyDeps {
  judge?: typeof workspacePolicyJudge;
}

/**
 * Refusal text when a workspace's inherited policy forbids any launch target's model or
 * provider, else `null`. Inert (null) where no policy enforcement is installed or no chain
 * governs the workspace; fail-closed when the chain cannot be read.
 */
export async function judgeLaunchGovernance(
  workspaceId: string | null | undefined,
  targets: readonly LaunchGovernanceTarget[],
  deps: SessionGovernanceDeps = {},
): Promise<string | null> {
  if (!workspaceId || targets.length === 0) return null;
  const judge = await (deps.judge ?? workspacePolicyJudge)(workspaceId, deps);
  if (!judge) return null;
  const refusal = judge(launchGovernedRequest(targets));
  if (!refusal) return null;
  return (
    `Launch refused by inherited governance policy: ${refusal.reason ?? refusal.code ?? 'org_policy:denied'}. ` +
    'NO terminals were opened. Choose a model and backend the organization permits (governance:policy explain shows the chain).'
  );
}

/** dataUse carried by EVERY injected leg, so one rule can stop all source text reaching the model. */
export const MODEL_CONTEXT_DATA_USE = 'model-context';

export type InjectionLeg = 'personal' | 'pot' | 'organization' | 'live';

/** Per-leg dataUse label, so a narrower rule can stop one kind of source text. */
export const INJECTION_LEG_DATA_USE: Readonly<Record<InjectionLeg, string>> = {
  personal: 'personal-vault',
  pot: 'pot-documents',
  organization: 'organization-documents',
  live: 'federated-search',
};

/**
 * The pilot processing-map path each injection leg's text travels (P-016a DLP). The personal
 * leg discloses vault content; the pot, organization and live legs are retrieval results.
 */
export const INJECTION_LEG_PROCESSING_PATH: Readonly<Record<InjectionLeg, string>> = {
  personal: 'personal-vault-disclosure',
  pot: 'search-and-retrieval',
  organization: 'search-and-retrieval',
  live: 'search-and-retrieval',
};

/** The data classes one injection leg carries, as `class:<cls>` dataUse labels (one vocabulary). */
export function injectionLegDataClassLabels(leg: InjectionLeg): string[] {
  return pilotPathDataClasses(INJECTION_LEG_PROCESSING_PATH[leg]).map(dataClassUseLabel);
}

/** The governed subject for one injection leg. `target` adds the session model/provider when known. */
export function injectionGovernedRequest(leg: InjectionLeg, target?: LaunchGovernanceTarget | null): GovernedRequest {
  const subject: GovernedRequest = {
    dataUse: [MODEL_CONTEXT_DATA_USE, INJECTION_LEG_DATA_USE[leg], ...injectionLegDataClassLabels(leg)],
  };
  if (!target) return subject;
  return { ...subject, ...launchGovernedRequest([target]) };
}

export type InjectionPermits = Readonly<Record<InjectionLeg, boolean>>;

const ALL_PERMITTED: InjectionPermits = { personal: true, pot: true, organization: true, live: true };
const NONE_PERMITTED: InjectionPermits = { personal: false, pot: false, organization: false, live: false };

/**
 * Which injection legs the workspace's inherited policy permits. One chain load judges all
 * four legs. A judge that throws or a chain that cannot be read permits NOTHING (fail closed:
 * silence is the injection path's refusal shape).
 */
export async function judgeInjectionLegs(
  workspaceId: string,
  target?: LaunchGovernanceTarget | null,
  deps: SessionGovernanceDeps = {},
): Promise<InjectionPermits> {
  try {
    const judge = await (deps.judge ?? workspacePolicyJudge)(workspaceId, deps);
    if (!judge) return ALL_PERMITTED;
    const legs = Object.keys(INJECTION_LEG_DATA_USE) as InjectionLeg[];
    return Object.fromEntries(legs.map((leg) => [leg, judge(injectionGovernedRequest(leg, target)) === null])) as unknown as InjectionPermits;
  } catch {
    return NONE_PERMITTED;
  }
}
