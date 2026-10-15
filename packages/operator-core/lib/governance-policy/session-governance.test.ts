/**
 * WI-6554700010011633 (papercusp-enterprise-readiness-roadmap-2026-10-09 P-007): inherited
 * governance policy governs the agent session's own model/provider at LAUNCH and the
 * granted-sources INJECTION legs — refusal journeys for a forbidden provider / data use, and
 * the permitted journeys beside them. Chains go through the real `evaluateInheritedPolicy`.
 */
import type { Sql } from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGrantedSourcesContextBlock, type GrantedSourcesDeps } from '../data-sources/granted-sources-injection';
import type { OrganizationSearchResult } from '../data-sources/documents-corpus';
import { setGovernancePolicyChainLoader } from './enforce';
import type { PolicyLayer } from './inherited-policy';
import {
  injectionGovernedRequest,
  judgeInjectionLegs,
  judgeLaunchGovernance,
  launchGovernedRequest,
  launchTargetFromRecord,
  MODEL_CONTEXT_DATA_USE,
  normalizeSessionModel,
  providerEgressOf,
  UNRESOLVED_PROVIDER_EGRESS,
} from './session-governance';
import type { ChainLoad, StoredPolicyLayer } from './store';
import { UNRESOLVED_REGION } from './processing-route';

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

afterEach(() => setGovernancePolicyChainLoader(null));

describe('launch mapping', () => {
  it('derives the turn-start session target from a recorded launch, and leaves an unknown one unknown', () => {
    expect(launchTargetFromRecord({ agent: 'codex', launchSpec: { model: ' gpt-5.5:high ' } })).toEqual({
      agent: 'codex',
      model: 'gpt-5.5:high',
    });
    // The row's agent column wins; the spec's agent is the fallback.
    expect(launchTargetFromRecord({ agent: null, launchSpec: { agent: 'omp', model: 'openai/gpt-5.6' } })).toEqual({
      agent: 'omp',
      model: 'openai/gpt-5.6',
    });
    expect(launchTargetFromRecord({ agent: 'claude', launchSpec: { model: '' } })).toEqual({ agent: 'claude', model: null });
    expect(launchTargetFromRecord({ agent: null, launchSpec: null })).toBeNull();
    expect(launchTargetFromRecord({ agent: '  ', launchSpec: ['codex'] })).toBeNull();
    expect(launchTargetFromRecord(null)).toBeNull();
  });

  it('maps each backend to the provider API host the session reaches', () => {
    expect(providerEgressOf({ agent: 'claude' })).toBe('api.anthropic.com');
    expect(providerEgressOf({})).toBe('api.anthropic.com');
    expect(providerEgressOf({ agent: 'codex', model: 'gpt-5.6-sol' })).toBe('api.openai.com');
    expect(providerEgressOf({ agent: 'omp', model: 'openai/gpt-5.6' })).toBe('api.openai.com');
    expect(providerEgressOf({ agent: 'omp', model: 'local-qwen' })).toBe(UNRESOLVED_PROVIDER_EGRESS);
  });

  it('judges the resolved model id without its effort suffix, and the provider under egress only', () => {
    expect(normalizeSessionModel(' claude-opus-4-1:high ')).toBe('claude-opus-4-1');
    expect(normalizeSessionModel('')).toBeNull();
    expect(launchGovernedRequest([{ agent: 'claude', model: 'claude-opus-4-1:high' }, { agent: 'claude' }])).toEqual({
      models: ['claude-opus-4-1'],
      providers: ['anthropic'],
      // api.anthropic.com is a global endpoint: it does not prove a region (P-016a).
      regions: [UNRESOLVED_REGION],
      egress: ['api.anthropic.com'],
    });
  });
});

describe('judgeLaunchGovernance', () => {
  it('refuses a launch on a provider the organization forbids, before any terminal', async () => {
    const deps = loadOf(chain({ egress: { deny: ['api.openai.com'] } }));
    const refusal = await judgeLaunchGovernance(WS, [{ agent: 'codex', model: 'gpt-5.6-sol' }], deps);
    expect(refusal).toMatch(/^Launch refused by inherited governance policy: org_policy:denied/);
    expect(refusal).toContain('NO terminals were opened');
  });

  it('refuses a launch whose resolved model is outside the organization allow list', async () => {
    const deps = loadOf(chain({ models: { allow: ['claude-*'] } }));
    expect(await judgeLaunchGovernance(WS, [{ agent: 'omp', model: 'openai/gpt-5.6' }], deps)).toMatch(/org_policy:denied/);
  });

  it('refuses a fleet wave when ONE member override is forbidden', async () => {
    const deps = loadOf(chain({ models: { deny: ['claude-haiku-*'] } }));
    const refusal = await judgeLaunchGovernance(WS, [
      { agent: 'claude', model: 'claude-opus-4-1' },
      { agent: 'claude', model: 'claude-haiku-4-5' },
    ], deps);
    expect(refusal).toMatch(/org_policy:denied/);
  });

  it('permits a launch on an allowed model and provider (the permitted journey)', async () => {
    const deps = loadOf(chain({ models: { allow: ['claude-*'] }, egress: { allow: ['api.anthropic.com'] } }));
    expect(await judgeLaunchGovernance(WS, [{ agent: 'claude', model: 'claude-opus-4-1:high' }], deps)).toBeNull();
    // A defaulted model is still governed by provider egress.
    expect(await judgeLaunchGovernance(WS, [{ agent: 'claude' }], deps)).toBeNull();
    expect(await judgeLaunchGovernance(WS, [{ agent: 'codex' }], deps)).toMatch(/org_policy:denied/);
  });

  it('refuses a backend whose provider cannot be resolved when an egress allow list exists', async () => {
    const deps = loadOf(chain({ egress: { allow: ['api.anthropic.com'] } }));
    expect(await judgeLaunchGovernance(WS, [{ agent: 'omp', model: 'local-qwen' }], deps)).toMatch(/org_policy:denied/);
  });

  it('fails closed when the chain cannot be read, and is inert where nothing governs', async () => {
    const unreadable = { loadChain: vi.fn(async () => { throw new Error('pg down'); }) };
    expect(await judgeLaunchGovernance(WS, [{ agent: 'claude' }], unreadable)).toMatch(/org_policy:unavailable/);
    expect(await judgeLaunchGovernance(WS, [{ agent: 'codex' }], loadOf({ status: 'none' }))).toBeNull();
    // No enforcement installed (unit tests, a host that never booted it): inert.
    setGovernancePolicyChainLoader(null);
    expect(await judgeLaunchGovernance(WS, [{ agent: 'codex' }])).toBeNull();
    expect(await judgeLaunchGovernance(null, [{ agent: 'codex' }], loadOf(chain({ egress: { deny: ['*'] } })))).toBeNull();
  });
});

describe('judgeInjectionLegs', () => {
  it('carries model-context plus the leg label on every leg', () => {
    // ...and the class: labels of the leg's processing-map path (search-and-retrieval, P-016a DLP).
    expect(injectionGovernedRequest('organization')).toEqual({
      dataUse: [MODEL_CONTEXT_DATA_USE, 'organization-documents', 'class:customer-content', 'class:pii'],
    });
    expect(injectionGovernedRequest('live', { agent: 'codex', model: 'gpt-5.6' })).toEqual({
      dataUse: [MODEL_CONTEXT_DATA_USE, 'federated-search', 'class:customer-content', 'class:pii'],
      models: ['gpt-5.6'],
      providers: ['openai'],
      regions: [UNRESOLVED_REGION],
      egress: ['api.openai.com'],
    });
  });

  it('refuses only the leg the organization forbids', async () => {
    const permits = await judgeInjectionLegs(WS, null, loadOf(chain({ dataUse: { deny: ['organization-documents'] } })));
    expect(permits).toEqual({ personal: true, pot: true, organization: false, live: true });
  });

  it('refuses every leg on a model-context deny, an unreadable chain, or a forbidden session provider', async () => {
    const none = { personal: false, pot: false, organization: false, live: false };
    expect(await judgeInjectionLegs(WS, null, loadOf(chain({ dataUse: { deny: [MODEL_CONTEXT_DATA_USE] } })))).toEqual(none);
    expect(await judgeInjectionLegs(WS, null, { loadChain: vi.fn(async () => { throw new Error('pg down'); }) })).toEqual(none);
    expect(await judgeInjectionLegs(WS, { agent: 'codex' }, loadOf(chain({ egress: { deny: ['api.openai.com'] } })))).toEqual(none);
  });

  it('permits every leg where nothing governs the workspace', async () => {
    expect(await judgeInjectionLegs(WS, null, loadOf({ status: 'none' }))).toEqual({ personal: true, pot: true, organization: true, live: true });
  });
});

describe('buildGrantedSourcesContextBlock under inherited policy', () => {
  const LEG = { ownerId: 'su-agent', userId: 'user-1', workspaceId: WS, query: 'cobalt roadmap' };
  const ORG_CANARY = 'CANARY-ORG-7f3a';

  function orgResult(): OrganizationSearchResult {
    return {
      id: 'doc-1', source: 'slack', kind: 'message', externalId: 'C1/1', occurredAt: null, participants: [],
      title: 'Org doc', snippet: `cobalt roadmap ${ORG_CANARY}`, metadata: {}, permissionListId: 'list-1',
      score: 0.5, tsRank: 0.5, privacy: null,
    };
  }

  function deps(orgRules: PolicyLayer['rules'] | null): GrantedSourcesDeps {
    const load: ChainLoad = orgRules ? chain(orgRules) : { status: 'none' };
    return {
      sql: {} as Sql,
      resolveContext: vi.fn(async () => ({}) as never),
      resolveSubjects: vi.fn(async () => ({ potSlug: 'papercusp', planSlug: 'plan-a' })),
      subscribedSources: vi.fn(async () => ['slack']),
      collectPersonal: vi.fn(async () => null),
      searchOrganization: vi.fn(async () => ({ allowed: true as const, results: [orgResult()], withheld: 0, disclosed: 0 })),
      searchPot: vi.fn(async () => ({ results: [], withheld: 0, disclosed: 0 }) as never),
      searchLive: vi.fn(async () => ({ allowed: true as const, results: [], withheld: 0, disclosed: 0, unmapped: [], failed: [] })),
      judgeLegs: (workspaceId, session) => judgeInjectionLegs(workspaceId, session, loadOf(load)),
    };
  }

  it('injects organization text where policy permits it (positive control)', async () => {
    const block = await buildGrantedSourcesContextBlock(LEG, deps({ dataUse: { allow: ['*'] } }));
    expect(block).toContain(ORG_CANARY);
  });

  it('never reads organization documents when the organization forbids that data use', async () => {
    const d = deps({ dataUse: { deny: ['organization-documents'] } });
    const block = await buildGrantedSourcesContextBlock(LEG, d);
    expect(block ?? '').not.toContain(ORG_CANARY);
    expect(d.searchOrganization).not.toHaveBeenCalled();
  });

  it('never reads organization documents for a session whose provider is forbidden', async () => {
    const d = deps({ egress: { deny: ['api.openai.com'] } });
    const block = await buildGrantedSourcesContextBlock({ ...LEG, session: { agent: 'codex', model: 'gpt-5.6-sol' } }, d);
    expect(block ?? '').not.toContain(ORG_CANARY);
    expect(d.searchOrganization).not.toHaveBeenCalled();
    // The same policy permits a session on an allowed provider.
    const allowed = await buildGrantedSourcesContextBlock({ ...LEG, session: { agent: 'claude' } }, deps({ egress: { deny: ['api.openai.com'] } }));
    expect(allowed).toContain(ORG_CANARY);
  });
});
