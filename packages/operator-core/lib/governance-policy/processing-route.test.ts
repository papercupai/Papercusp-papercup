/**
 * P-016a (WI-6554700010011918): provider and region restrictions on the model-processing route.
 *
 * processing-restriction-canary:model-inference
 *   The pilot processing map (data-governance/pilot-processing-map.ts) pins this marker: this
 *   file is the canary that a restricted provider or region is refused at EVERY seat of the
 *   `model-inference` path (launch, turn-start injection, tool dispatch), and that the dispatch
 *   refusal carries the code and policy revision the tool-invocation receipt records.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enforceInheritedPolicy, governedRequestOf, setGovernancePolicyChainLoader } from './enforce';
import type { PolicyLayer } from './inherited-policy';
import {
  knownProcessingRouteOfHost,
  modelPrefixProviderHost,
  processingRouteOfHost,
  UNRESOLVED_PROVIDER,
  UNRESOLVED_REGION,
} from './processing-route';
import { judgeInjectionLegs, judgeLaunchGovernance, launchGovernedRequest } from './session-governance';
import type { ChainLoad, StoredPolicyLayer } from './store';

const WS = 'ws-governed';

function layer(over: Partial<StoredPolicyLayer> & Pick<StoredPolicyLayer, 'layerId' | 'level'>): StoredPolicyLayer {
  return {
    version: 1, rules: {}, exceptions: [], scopeRef: over.layerId, parentLayerId: null,
    contentHash: 'h', updatedBy: 'test', updatedAt: '2026-10-14T00:00:00.000Z', ...over,
  };
}

function chain(orgRules: PolicyLayer['rules']): ChainLoad {
  return {
    status: 'ok',
    chain: [
      layer({ layerId: 'org-acme', level: 'organization', rules: orgRules }),
      layer({ layerId: 'ws-governed', level: 'workspace', version: 2, rules: {} }),
    ],
  } as ChainLoad;
}

const loadOf = (load: ChainLoad) => ({ loadChain: vi.fn(async () => load) });

const NONE_PERMITTED = { personal: false, pot: false, organization: false, live: false };
const ALL_PERMITTED = { personal: true, pot: true, organization: true, live: true };

afterEach(() => setGovernancePolicyChainLoader(null));

describe('processing route resolution', () => {
  it('names the provider of a global endpoint but never claims its region', () => {
    expect(processingRouteOfHost('api.anthropic.com')).toEqual({ provider: 'anthropic', region: UNRESOLVED_REGION });
    expect(processingRouteOfHost('API.OpenAI.com')).toEqual({ provider: 'openai', region: UNRESOLVED_REGION });
  });

  it('reads the region from a regional endpoint host', () => {
    expect(processingRouteOfHost('bedrock-runtime.eu-central-1.amazonaws.com')).toEqual({ provider: 'aws-bedrock', region: 'eu-central-1' });
    expect(processingRouteOfHost('bedrock-runtime-fips.us-gov-west-1.amazonaws.com')).toEqual({ provider: 'aws-bedrock', region: 'us-gov-west-1' });
    expect(processingRouteOfHost('europe-west4-aiplatform.googleapis.com')).toEqual({ provider: 'google-vertex', region: 'europe-west4' });
    expect(processingRouteOfHost('acme-prod.openai.azure.com')).toEqual({ provider: 'azure-openai', region: UNRESOLVED_REGION });
  });

  it('resolves an unknown model host to the unresolved sentinels, and an ordinary web host to no route', () => {
    expect(processingRouteOfHost('llm.internal.example')).toEqual({ provider: UNRESOLVED_PROVIDER, region: UNRESOLVED_REGION });
    expect(processingRouteOfHost('')).toEqual({ provider: UNRESOLVED_PROVIDER, region: UNRESOLVED_REGION });
    expect(knownProcessingRouteOfHost('github.com')).toBeNull();
    expect(knownProcessingRouteOfHost('.openai.azure.com')).toBeNull();
  });

  it('takes a provider only from a recognised <provider>/<model> prefix, never from a bare model family', () => {
    expect(modelPrefixProviderHost('openai/gpt-5.6')).toBe('api.openai.com');
    expect(modelPrefixProviderHost('Gemini/gemini-3-pro')).toBe('generativelanguage.googleapis.com');
    expect(modelPrefixProviderHost('claude-opus-4-1')).toBeNull();
    expect(modelPrefixProviderHost('mystery/model')).toBeNull();
  });
});

describe('canary — launch seat (judgeLaunchGovernance)', () => {
  it('maps each backend to its provider and an unresolved region', () => {
    expect(launchGovernedRequest([{ agent: 'codex' }, { agent: 'omp', model: 'mystery/m1' }])).toMatchObject({
      providers: ['openai', UNRESOLVED_PROVIDER],
      regions: [UNRESOLVED_REGION],
    });
  });

  it('refuses a launch on a provider the organization denies, naming the deciding layer', async () => {
    const refusal = await judgeLaunchGovernance(WS, [{ agent: 'claude', model: 'claude-opus-4-1' }], loadOf(chain({ providers: { deny: ['anthropic'] } })));
    expect(refusal).toMatch(/org_policy:denied/);
    expect(refusal).toMatch(/org-acme/);
    expect(refusal).toMatch(/NO terminals were opened/);
  });

  it('refuses a launch whose region cannot be proven inside a region allow list', async () => {
    const refusal = await judgeLaunchGovernance(WS, [{ agent: 'claude' }], loadOf(chain({ regions: { allow: ['eu-*'] } })));
    expect(refusal).toMatch(/org_policy:denied/);
    expect(refusal).toContain(UNRESOLVED_REGION);
  });

  it('permits a launch on a provider the allow list names (positive control)', async () => {
    expect(await judgeLaunchGovernance(WS, [{ agent: 'claude' }], loadOf(chain({ providers: { allow: ['anthropic'] } })))).toBeNull();
  });
});

describe('canary — turn-start injection seat (judgeInjectionLegs)', () => {
  it('refuses every leg for a session whose provider is denied, and permits them for an allowed one', async () => {
    expect(await judgeInjectionLegs(WS, { agent: 'codex' }, loadOf(chain({ providers: { deny: ['openai'] } })))).toEqual(NONE_PERMITTED);
    expect(await judgeInjectionLegs(WS, { agent: 'codex' }, loadOf(chain({ providers: { allow: ['openai'] } })))).toEqual(ALL_PERMITTED);
  });

  it('refuses every leg for a session whose region is outside the allow list', async () => {
    expect(await judgeInjectionLegs(WS, { agent: 'claude' }, loadOf(chain({ regions: { allow: ['eu-*'] } })))).toEqual(NONE_PERMITTED);
  });
});

describe('canary — tool-dispatch seat (enforceInheritedPolicy)', () => {
  const dispatch = (args: Record<string, unknown>) => ({
    toolName: 'llm:complete',
    capabilities: [],
    boundary: 'dispatch' as const,
    args,
    ctx: { workspaceId: WS },
  });

  it('judges the route named by a <provider>/<model> id, a model-provider URL, or explicit provider/region args', () => {
    expect(governedRequestOf(dispatch({ model: 'openai/gpt-5.6' }) as never)).toMatchObject({ providers: ['openai'], regions: [UNRESOLVED_REGION] });
    expect(governedRequestOf(dispatch({ endpoint: 'https://bedrock-runtime.eu-west-1.amazonaws.com/model/x' }) as never)).toMatchObject({
      providers: ['aws-bedrock'],
      regions: ['eu-west-1'],
    });
    expect(governedRequestOf(dispatch({ provider: 'Mistral', region: 'EU-West-3' }) as never)).toMatchObject({ providers: ['mistral'], regions: ['eu-west-3'] });
  });

  it('refuses a dispatch to a denied provider with the code and policy revision the receipt records', async () => {
    setGovernancePolicyChainLoader(async () => chain({ providers: { deny: ['openai'] } }));
    const verdict = await enforceInheritedPolicy(dispatch({ model: 'openai/gpt-5.6' }) as never);
    expect(verdict).toMatchObject({ decision: 'deny', code: 'org_policy:denied', policyRevision: 'org-acme@v1>ws-governed@v2' });
    expect(verdict?.reason).toMatch(/providers/);
  });

  it('refuses a regional route outside the region allow list and permits one inside it', async () => {
    setGovernancePolicyChainLoader(async () => chain({ regions: { allow: ['eu-*'] } }));
    const outside = await enforceInheritedPolicy(dispatch({ endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/x' }) as never);
    expect(outside).toMatchObject({ decision: 'deny', code: 'org_policy:denied' });
    setGovernancePolicyChainLoader(async () => chain({ regions: { allow: ['eu-*'] } }));
    expect(await enforceInheritedPolicy(dispatch({ endpoint: 'https://bedrock-runtime.eu-central-1.amazonaws.com/model/x' }) as never)).toBeNull();
  });

  it('leaves a dispatch that names no route unjudged by provider and region rules', async () => {
    setGovernancePolicyChainLoader(async () => chain({ providers: { allow: ['anthropic'] }, regions: { allow: ['eu-*'] } }));
    expect(await enforceInheritedPolicy(dispatch({ url: 'https://github.com/acme/repo', model: 'claude-x' }) as never)).toBeNull();
  });
});
