/**
 * Model-processing ROUTE resolution for inherited governance policy
 * (papercusp-enterprise-readiness-roadmap-2026-10-09 P-016a, WI-6554700010011918).
 *
 * The `providers` and `regions` governed categories judge WHO processes organization content
 * and WHERE. Both are derived from the provider API host a request reaches. Nothing is
 * declared by hand, so a value can only come from the host the request actually contacts:
 *
 *  - provider : the model provider that host belongs to (`api.anthropic.com` → `anthropic`,
 *               `bedrock-runtime.eu-central-1.amazonaws.com` → `aws-bedrock`).
 *  - region   : the processing region ONLY when the host itself names it (a regional Bedrock or
 *               Vertex endpoint). A global endpoint (`api.anthropic.com`, `api.openai.com`) does
 *               not prove where it processes, so its region is UNRESOLVED_REGION.
 *
 * RESIDENCY MUST BE AN ALLOW LIST. An unresolved region matches no allow pattern, so
 * `regions.allow: ['eu-*']` refuses every route that cannot prove an EU region. A deny list
 * (`regions.deny: ['us-*']`) only catches routes whose region IS resolved; it cannot stop a
 * global endpoint. The same holds for UNRESOLVED_PROVIDER under a `providers` allow list.
 *
 * PURE: no I/O. Consumed by the launch and injection seats (./session-governance.ts) and the
 * dispatch seat (./enforce.ts).
 */

/** Judged when the provider of a model route cannot be resolved; a `providers` allow list refuses it. */
export const UNRESOLVED_PROVIDER = 'unresolved-provider';

/** Judged when a route's host does not name its processing region; a `regions` allow list refuses it. */
export const UNRESOLVED_REGION = 'unresolved-region';

export interface ProcessingRoute {
  provider: string;
  region: string;
}

/** Global (region-less) provider API hosts. */
const GLOBAL_PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'generativelanguage.googleapis.com': 'google',
  'openrouter.ai': 'openrouter',
  'aiplatform.googleapis.com': 'google-vertex',
};

/** Regional hosts: the region is a component of the host name. */
const REGIONAL_PROVIDER_HOSTS: ReadonlyArray<{ provider: string; pattern: RegExp }> = [
  // bedrock-runtime.eu-central-1.amazonaws.com, bedrock-runtime-fips.us-east-1.amazonaws.com
  { provider: 'aws-bedrock', pattern: /^bedrock-runtime(?:-fips)?\.([a-z]{2}(?:-gov)?-[a-z]+-\d)\.amazonaws\.com$/ },
  // europe-west4-aiplatform.googleapis.com
  { provider: 'google-vertex', pattern: /^([a-z]+-[a-z]+\d+)-aiplatform\.googleapis\.com$/ },
];

/** Hosts whose provider is known but whose region is not in the host name. */
const PROVIDER_HOST_SUFFIXES: ReadonlyArray<{ provider: string; suffix: string }> = [
  // <resource>.openai.azure.com: the resource's region is configured in Azure, not named here.
  { provider: 'azure-openai', suffix: '.openai.azure.com' },
];

/**
 * The processing route a model-provider host belongs to, or `null` when the host is not a
 * known model-provider host (an ordinary web egress, which the `egress` category governs).
 */
export function knownProcessingRouteOfHost(host: string | null | undefined): ProcessingRoute | null {
  const h = (host ?? '').trim().toLowerCase();
  if (!h) return null;
  const global = GLOBAL_PROVIDER_HOSTS[h];
  if (global) return { provider: global, region: UNRESOLVED_REGION };
  for (const { provider, pattern } of REGIONAL_PROVIDER_HOSTS) {
    const m = pattern.exec(h);
    if (m?.[1]) return { provider, region: m[1] };
  }
  for (const { provider, suffix } of PROVIDER_HOST_SUFFIXES) {
    if (h.endsWith(suffix) && h.length > suffix.length) return { provider, region: UNRESOLVED_REGION };
  }
  return null;
}

/**
 * The processing route of a host that IS a model route (a launch's or injection's provider
 * host). An unknown host resolves to the unresolved sentinels, so an allow list refuses it.
 */
export function processingRouteOfHost(host: string | null | undefined): ProcessingRoute {
  return knownProcessingRouteOfHost(host) ?? { provider: UNRESOLVED_PROVIDER, region: UNRESOLVED_REGION };
}

/** Provider API host for a `<provider>/<model>` id (the omp / gateway form). */
export const MODEL_PROVIDER_EGRESS: Readonly<Record<string, string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  google: 'generativelanguage.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  openrouter: 'openrouter.ai',
};

/**
 * The provider API host a `<provider>/<model>` id names, or `null` when the id has no
 * recognised provider prefix. A bare model id (`claude-opus-4-1`) names no provider: the same
 * model can be served by several routes, so it is never guessed from the model family.
 */
export function modelPrefixProviderHost(model: string | null | undefined): string | null {
  const trimmed = (model ?? '').trim();
  const prefix = trimmed.includes('/') ? trimmed.split('/')[0]?.toLowerCase() : undefined;
  return (prefix && MODEL_PROVIDER_EGRESS[prefix]) || null;
}
