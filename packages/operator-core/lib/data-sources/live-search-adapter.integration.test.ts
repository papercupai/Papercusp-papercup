/**
 * Live (federated) search against real Postgres (plan
 * enterprise-data-sources-2026-10-01 P-018, owner ruling D-006, acceptance BAR
 * R-12; schema: migrations 1316 + 1317 + 1321).
 *
 * The properties under test:
 *   - a `sync_mode = 'federated'` data source answers a query through its adapter
 *     at read time, and the hit reaches the agent through the SAME injection path
 *     as stored documents (buildGrantedSourcesContextBlock), fenced as untrusted data;
 *   - nothing is written to the documents corpus, while the disclosure ledger
 *     still records the hit under its deterministic live document id;
 *   - the adapter queries as the principal's mapped provider identity, and no
 *     mapping, no vault grant or no subscription means no provider call;
 *   - a throwing or slow provider is silence, never an error for the turn.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_SEARCH_LIVE_CAPABILITY,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvokeRequest,
} from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { upsertPrivacyRule } from '../personal-vault/disclosure-ledger';
import { createPersonalGrant } from '../personal-vault/store';
import {
  ORGANIZATION_CORPUS_SCOPE,
  mapProviderIdentity,
  revokeProviderIdentityMapping,
  searchOrganizationDocuments,
  searchPotDocuments,
} from './documents-corpus';
import {
  UNTRUSTED_FENCE_TAG,
  buildGrantedSourcesContextBlock,
  resolveInjectionSubjects,
  resolveSubscribedSources,
  subscribeSource,
  type GrantedSourcesDeps,
} from './granted-sources-injection';
import {
  liveDocumentId,
  PRINCIPAL_CREDENTIAL_MISSING,
  providerLiveSearchAdapters,
  searchLiveSources,
  type LiveSearchAdapter,
  type LiveSearchHit,
  type LiveSearchInput,
} from './live-search-adapter';

let org: OrgTestDb;
let alice: string;
let bob: string;
let dataSourceId: string;
const WS = 'live-search-adapter-test';
const AGENT_ROLE = 'meeting-prep';
const AGENT = `live-search-agent-${process.pid}`;
const POT = 'sales-pot';
const SLACK_ALICE = { provider: 'slack', providerUserId: 'T1:UALICE' };
const HIT: LiveSearchHit = {
  externalId: 'T1:CROADMAP:1727780000.000100',
  title: '#roadmap',
  text: 'The cobalt roadmap review moved to Thursday.',
  occurredAt: '2026-10-01T10:00:00.000Z',
  participants: ['UALICE'],
  permalink: 'https://acme.slack.com/archives/CROADMAP/p1727780000000100',
  score: 1,
};

type AdapterMode = 'hit' | 'throw' | 'slow';
let mode: AdapterMode = 'hit';
let calls: LiveSearchInput[] = [];
const fakeSlack: LiveSearchAdapter = {
  kind: 'slack',
  async search(input) {
    calls.push(input);
    if (mode === 'throw') throw new Error('slack_unavailable');
    if (mode === 'slow') {
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
    return [HIT];
  },
};
const ADAPTERS: ReadonlyMap<string, LiveSearchAdapter> = new Map([['slack', fakeSlack]]);

async function makeUser(label: string): Promise<string> {
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${label}) RETURNING id`;
  return user!.id;
}

async function grantOrganization(userId: string): Promise<void> {
  await createPersonalGrant(org.adminSql, {
    workspaceId: WS, userId, principalType: 'agent-role', principalId: AGENT_ROLE,
    scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'owner',
  });
}

async function corpusRows(): Promise<number> {
  const [row] = await org.adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  return row!.n;
}

function deps(timeoutMs?: number): GrantedSourcesDeps {
  return {
    sql: org.adminSql,
    resolveContext: async () => ({ workspaceId: WS, role: AGENT_ROLE }),
    resolveSubjects: resolveInjectionSubjects,
    subscribedSources: resolveSubscribedSources,
    collectPersonal: async () => null,
    searchOrganization: (db, ctx, params) => searchOrganizationDocuments(db, ctx, params),
    searchPot: (db, params) => searchPotDocuments(db, params),
    searchLive: (db, ctx, params) =>
      searchLiveSources(db, ctx, { ...params, adapters: ADAPTERS, ...(timeoutMs ? { timeoutMs } : {}) }),
  };
}

function build(userId: string, timeoutMs?: number) {
  return buildGrantedSourcesContextBlock(
    { ownerId: AGENT, userId, workspaceId: WS, query: 'cobalt roadmap' }, deps(timeoutMs),
  );
}

function searchDirect(userId: string) {
  return searchLiveSources(org.adminSql, { workspaceId: WS, role: AGENT_ROLE }, {
    workspaceId: WS, principalUserId: userId, agentOwnerId: AGENT, query: 'cobalt roadmap', adapters: ADAPTERS,
  });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  alice = await makeUser('live-search-alice');
  bob = await makeUser('live-search-bob');
});

afterAll(async () => {
  if (!org) return;
  await org.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${AGENT}`.catch(() => {});
  await org.adminSql`DELETE FROM harness_shared.data_source_subscriptions WHERE workspace_id = ${WS}`.catch(() => {});
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`.catch(() => {});
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`.catch(() => {});
  for (const id of [alice, bob].filter(Boolean)) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${id}`.catch(() => {});
  }
  await org.cleanup();
});

beforeEach(async () => {
  mode = 'hit';
  calls = [];
  await org.adminSql`DELETE FROM harness_shared.data_source_subscriptions WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.coord_presence WHERE owner_id = ${AGENT}`;
  await grantOrganization(alice);
  await grantOrganization(bob);
  await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
  const [ds] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, config, status, sync_mode, scope)
    VALUES (${WS}, 'slack', ${org.adminSql.json({ installSlug: 'acme' })}, 'ready', 'federated', 'organization')
    RETURNING id::text AS id`;
  dataSourceId = ds!.id;
  await org.adminSql`
    INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, pot_slug, current_plan_slug)
    VALUES (${AGENT}, ${WS}, ${POT}, NULL)`;
  await subscribeSource(org.adminSql, WS, { subjectKind: 'pot', subjectRef: POT, source: 'slack', createdBy: 'owner' });
});

describe('live (federated) search through the injection path (R-12)', () => {
  it('injects a fenced live hit, queried as the mapped identity, and writes no corpus row', async () => {
    // discloseDocuments ledgers only documents a privacy rule restricts, for live
    // hits exactly as for stored ones; this rule makes the slack hit restricted.
    await upsertPrivacyRule(org.adminSql, {
      workspaceId: WS, userId: alice, matchKind: 'source', matchValue: 'slack',
      level: 'participants', actor: 'owner', authorityRef: null,
    });
    const before = await corpusRows();
    const block = (await build(alice))!;
    expect(block).toContain(`<${UNTRUSTED_FENCE_TAG} scope="live" source="slack" ref="${dataSourceId}"`);
    expect(block).toContain(`link="${HIT.permalink}"`);
    expect(block).toContain('The cobalt roadmap review moved to Thursday.');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ principalUserId: alice, providerUserId: 'T1:UALICE', query: 'cobalt roadmap' });
    expect(calls[0]!.record).toMatchObject({ id: dataSourceId, kind: 'slack', config: { installSlug: 'acme' } });
    expect(await corpusRows()).toBe(before);
    expect(before).toBe(0);
    const [ledger] = await org.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.personal_disclosures
       WHERE document_id = ${liveDocumentId(dataSourceId, HIT.externalId)}::uuid`;
    expect(ledger!.n).toBeGreaterThan(0);
  });

  it('skips a principal with no provider identity mapping, without calling the provider', async () => {
    expect(await build(bob)).toBeNull();
    const outcome = await searchDirect(bob);
    expect(outcome).toMatchObject({ allowed: true, results: [], unmapped: ['slack'] });
    expect(calls).toHaveLength(0);
  });

  it('refuses without the organization vault grant', async () => {
    await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS} AND user_id = ${alice}`;
    expect(await build(alice)).toBeNull();
    expect((await searchDirect(alice)).allowed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('calls no provider when the pot subscribes to no source', async () => {
    await org.adminSql`DELETE FROM harness_shared.data_source_subscriptions WHERE workspace_id = ${WS}`;
    expect(await build(alice)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not query a disabled live source', async () => {
    await org.adminSql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE id = ${dataSourceId}::uuid`;
    expect(await build(alice)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is silence when the provider throws', async () => {
    mode = 'throw';
    expect(await build(alice)).toBeNull();
    expect(await searchDirect(alice)).toMatchObject({
      allowed: true, results: [], failed: [{ dataSourceId, source: 'slack', reason: 'slack_unavailable' }],
    });
  });

  it('is silence when the provider exceeds its timeout', async () => {
    mode = 'slow';
    expect(await build(alice, 50)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});

describe('authority changes during an in-flight provider read', () => {
  function blockedAdapter() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const adapter: LiveSearchAdapter = {
      kind: 'slack',
      async search(input) {
        calls.push(input);
        enter();
        await pending;
        return [HIT];
      },
    };
    return { entered, release, adapter };
  }

  async function restrictHits() {
    await upsertPrivacyRule(org.adminSql, {
      workspaceId: WS, userId: alice, matchKind: 'source', matchValue: 'slack',
      level: 'participants', actor: 'owner', authorityRef: null,
    });
  }

  async function disclosedIds() {
    const rows = await org.adminSql<{ document_id: string }[]>`
      SELECT DISTINCT document_id::text AS document_id
        FROM harness_shared.personal_disclosures
       WHERE workspace_id = ${WS}`;
    return rows.map((row) => row.document_id).sort();
  }

  function search(adapters: ReadonlyMap<string, LiveSearchAdapter>) {
    return searchLiveSources(org.adminSql, { workspaceId: WS, role: AGENT_ROLE }, {
      workspaceId: WS, principalUserId: alice, agentOwnerId: AGENT,
      query: 'cobalt roadmap', adapters, timeoutMs: 10_000,
    });
  }

  it.each([
    'identity-revoked', 'identity-remapped', 'source-disabled',
    'source-deleted', 'source-reconfigured',
  ])('withholds and does not disclose a hit after %s', async (scenario) => {
    await restrictHits();
    const barrier = blockedAdapter();
    const outcomePromise = search(new Map([['slack', barrier.adapter]]));
    try {
      await barrier.entered;
      if (scenario === 'identity-revoked') {
        await revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' });
      } else if (scenario === 'identity-remapped') {
        await revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' });
        await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: bob, mappedBy: 'owner' });
      } else if (scenario === 'source-disabled') {
        await org.adminSql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE id = ${dataSourceId}::uuid`;
      } else if (scenario === 'source-deleted') {
        await org.adminSql`DELETE FROM harness_shared.data_sources WHERE id = ${dataSourceId}::uuid`;
      } else {
        await org.adminSql`UPDATE harness_shared.data_sources
          SET config = ${org.adminSql.json({ installSlug: 'different-install' })}
          WHERE id = ${dataSourceId}::uuid`;
      }
    } finally {
      barrier.release();
    }
    expect(await outcomePromise).toMatchObject({
      allowed: true, results: [], disclosed: 0,
      failed: [{ dataSourceId, source: 'slack', reason: 'live_search_binding_changed' }],
    });
    expect(await disclosedIds()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('refuses and does not disclose when the organization grant is revoked during the read', async () => {
    await restrictHits();
    const barrier = blockedAdapter();
    const outcomePromise = search(new Map([['slack', barrier.adapter]]));
    try {
      await barrier.entered;
      await org.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
        WHERE workspace_id = ${WS} AND user_id = ${alice}::uuid`;
    } finally {
      barrier.release();
    }
    expect(await outcomePromise).toMatchObject({ allowed: false, reason: 'no_live_grant' });
    expect(await disclosedIds()).toEqual([]);
  });

  it('returns and discloses a valid hit after a delayed provider read', async () => {
    await restrictHits();
    const barrier = blockedAdapter();
    const outcomePromise = search(new Map([['slack', barrier.adapter]]));
    await barrier.entered;
    barrier.release();
    expect(await outcomePromise).toMatchObject({ allowed: true, failed: [], results: [{ snippet: HIT.text }] });
    expect(await disclosedIds()).toEqual([liveDocumentId(dataSourceId, HIT.externalId)]);
  });

  it('rechecks an early result after another provider finishes, preserving the unrelated valid source', async () => {
    await restrictHits();
    const [other] = await org.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, config, status, sync_mode, scope)
      VALUES (${WS}, 'slack', ${org.adminSql.json({ installSlug: 'other' })}, 'ready', 'federated', 'organization')
      RETURNING id::text AS id`;
    const barrier = blockedAdapter();
    let early!: () => void;
    const earlyReturned = new Promise<void>((resolve) => { early = resolve; });
    const adapter: LiveSearchAdapter = {
      kind: 'slack',
      async search(input) {
        if (input.record.id === other!.id) return barrier.adapter.search(input);
        calls.push(input);
        early();
        return [HIT];
      },
    };
    const outcomePromise = search(new Map([['slack', adapter]]));
    try {
      await Promise.all([earlyReturned, barrier.entered]);
      await org.adminSql`UPDATE harness_shared.data_sources SET status = 'disabled' WHERE id = ${dataSourceId}::uuid`;
    } finally {
      barrier.release();
    }
    const outcome = await outcomePromise;
    expect(outcome).toMatchObject({
      allowed: true, results: [{ dataSourceId: other!.id, snippet: HIT.text }],
      failed: [{ dataSourceId, source: 'slack', reason: 'live_search_binding_changed' }],
    });
    if (!outcome.allowed) throw new Error('expected an allowed outcome');
    expect(outcome.results).toHaveLength(1);
    expect(await disclosedIds()).toEqual([liveDocumentId(other!.id, HIT.externalId)]);
  });
});

/**
 * cupboard-distributable-integrations-2026-10-10 D-026 ruling 5: adapters come from provider
 * packages declaring `search.live`, and the call's host.fetch acts for the person searching.
 */
describe('live search through provider packages (D-026)', () => {
  const LIVE_HOST = 'live.fixture.test';
  const liveDescriptor: ProviderDescriptor = {
    id: 'slack',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: [PROVIDER_SEARCH_LIVE_CAPABILITY],
    egressHosts: [LIVE_HOST],
    setup: { credentials: [{ key: 'user_token', label: 'Your search token', perPrincipal: true, hosts: [LIVE_HOST] }] },
  };
  const quietDescriptor: ProviderDescriptor = {
    id: 'quiet-fixture',
    contractVersion: 1,
    datatypes: ['chat-message'],
    capabilities: ['chat.read'],
    egressHosts: ['quiet.fixture.test'],
  };
  let behaviour: 'hits' | 'fetch' | 'malformed' = 'hits';
  let invokes: ProviderInvokeRequest[] = [];
  const liveAdapter: ProviderAdapter = {
    describe: () => liveDescriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async (request, host) => {
      invokes.push(request);
      if (behaviour === 'fetch') await host.fetch({ source: request.source, request: { url: `https://${LIVE_HOST}/search` } });
      if (behaviour === 'malformed') return { hits: [{ externalId: '' }] };
      const { score: _score, ...first } = HIT;
      return { hits: [first, { ...first, externalId: 'T1:CROADMAP:1727780000.000200', text: 'Second hit.' }] };
    },
  };
  const quietAdapter: ProviderAdapter = {
    describe: () => quietDescriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async () => ({ hits: [] }),
  };
  const noNetwork = (async () => {
    throw new Error('live-search test: the request must be refused before any network call');
  }) as unknown as typeof fetch;
  let registry: ProviderRegistry;

  beforeAll(async () => {
    registry = createProviderRegistry();
    await registry.register({ descriptor: liveDescriptor, adapter: liveAdapter, pluginName: 'live-fixture-plugin' });
    await registry.register({ descriptor: quietDescriptor, adapter: quietAdapter, pluginName: 'quiet-fixture-plugin' });
  });

  beforeEach(() => {
    behaviour = 'hits';
    invokes = [];
  });

  async function searchViaPackages(userId: string) {
    const adapters = await providerLiveSearchAdapters(org.adminSql, { registry, fetchImpl: noNetwork });
    return searchLiveSources(org.adminSql, { workspaceId: WS, role: AGENT_ROLE }, {
      workspaceId: WS, principalUserId: userId, agentOwnerId: AGENT, query: 'cobalt roadmap', adapters,
    });
  }

  it('builds an adapter only for a provider declaring search.live', async () => {
    const adapters = await providerLiveSearchAdapters(org.adminSql, { registry, fetchImpl: noNetwork });
    expect([...adapters.keys()]).toEqual(['slack']);
  });

  it("invokes the provider's search.live with the query, limit and source config, ranking its hits in order", async () => {
    const outcome = await searchViaPackages(alice);
    expect(outcome).toMatchObject({ allowed: true, failed: [], unmapped: [] });
    if (!outcome.allowed) throw new Error('expected an allowed outcome');
    expect(outcome.results.map((r) => [r.externalId, r.score])).toEqual([
      [HIT.externalId, 1],
      ['T1:CROADMAP:1727780000.000200', 0.5],
    ]);
    expect(invokes).toEqual([
      { source: dataSourceId, capability: PROVIDER_SEARCH_LIVE_CAPABILITY, args: { query: 'cobalt roadmap', limit: 10 }, config: { installSlug: 'acme' } },
    ]);
    expect(await corpusRows()).toBe(0);
  });

  it('reports principal_credential_missing when the person searching has not stored their own credential', async () => {
    behaviour = 'fetch';
    expect(await searchViaPackages(alice)).toMatchObject({
      allowed: true, results: [], failed: [{ dataSourceId, source: 'slack', reason: PRINCIPAL_CREDENTIAL_MISSING }],
    });
    expect(invokes).toHaveLength(1);
  });

  it('fails the source soft when the provider returns a malformed result', async () => {
    behaviour = 'malformed';
    const outcome = await searchViaPackages(alice);
    expect(outcome).toMatchObject({ allowed: true, results: [] });
    if (!outcome.allowed) throw new Error('expected an allowed outcome');
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.reason).toMatch(/^live_search_invalid_result: /);
  });

  it('does not invoke the provider for a person with no mapped identity', async () => {
    expect(await searchViaPackages(bob)).toMatchObject({ allowed: true, results: [], unmapped: ['slack'] });
    expect(invokes).toEqual([]);
  });
});

/**
 * Plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-007b (WI-6554700010011594,
 * bar R-4 data clause). A live source enforces content ACLs at the provider, so the
 * platform's obligation is to query only AS the person's mapped identity and to stop
 * querying the moment that mapping is revoked. The fake provider below returns the
 * canary only to the Slack identity that may read it, as a real provider would.
 */
describe('P-007b restricted-content canary and revocation journeys (live search)', () => {
  const ACCESS_CLOSURE_BOUND_MS = 60_000;
  const SLACK_BOB = { provider: 'slack', providerUserId: 'T1:UBOB' };
  const READER = SLACK_ALICE.providerUserId;
  let canaryToken = '';
  let aclCalls: LiveSearchInput[] = [];
  const aclEnforcingSlack: LiveSearchAdapter = {
    kind: 'slack',
    async search(input) {
      aclCalls.push(input);
      if (input.providerUserId !== READER) return [];
      return [{ ...HIT, externalId: `T1:CPRIVATE:${canaryToken}`, title: '#private', text: `restricted ${canaryToken}` }];
    },
  };
  const aclAdapters: ReadonlyMap<string, LiveSearchAdapter> = new Map([['slack', aclEnforcingSlack]]);

  function canaryDeps(): GrantedSourcesDeps {
    return {
      ...deps(),
      searchLive: (db, ctx, params) => searchLiveSources(db, ctx, { ...params, adapters: aclAdapters }),
    };
  }

  async function injected(userId: string): Promise<string> {
    const block = await buildGrantedSourcesContextBlock(
      { ownerId: AGENT, userId, workspaceId: WS, query: 'restricted' }, canaryDeps(),
    );
    return block ?? '';
  }

  async function direct(userId: string): Promise<string> {
    const outcome = await searchLiveSources(org.adminSql, { workspaceId: WS, role: AGENT_ROLE }, {
      workspaceId: WS, principalUserId: userId, agentOwnerId: AGENT, query: 'restricted', adapters: aclAdapters,
    });
    return JSON.stringify(outcome);
  }

  beforeEach(() => {
    canaryToken = `P007B-LIVE-CANARY-${Math.random().toString(36).slice(2, 10)}`;
    aclCalls = [];
  });

  it('permitted: the mapped reader receives the canary, fenced, through both live search and injection', async () => {
    expect(await direct(alice)).toContain(canaryToken);
    const block = await injected(alice);
    expect(block).toContain(`<${UNTRUSTED_FENCE_TAG} scope="live" source="slack"`);
    expect(block).toContain(canaryToken);
    expect(aclCalls.every((call) => call.providerUserId === READER)).toBe(true);
  });

  it('denied: a granted person mapped to another provider identity is queried as that identity and never receives the canary', async () => {
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_BOB, userId: bob, mappedBy: 'owner' });
    expect(await direct(bob)).not.toContain(canaryToken);
    expect(await injected(bob)).not.toContain(canaryToken);
    expect(aclCalls.length).toBeGreaterThan(0);
    expect(aclCalls.every((call) => call.principalUserId === bob && call.providerUserId === SLACK_BOB.providerUserId)).toBe(true);
  });

  it('denied: revoking the provider identity mapping stops the next read before any provider call, inside the 60s bound', async () => {
    expect(await injected(alice)).toContain(canaryToken);
    aclCalls = [];

    const started = performance.now();
    await revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' });
    const after = await injected(alice);
    const elapsedMs = performance.now() - started;

    expect(after).not.toContain(canaryToken);
    expect(await direct(alice)).not.toContain(canaryToken);
    expect(aclCalls).toHaveLength(0);
    expect(elapsedMs).toBeLessThan(ACCESS_CLOSURE_BOUND_MS);
    console.info(`P007B_ACCESS_CLOSURE path=live-search revocation=provider-identity-mapping elapsedMs=${elapsedMs.toFixed(1)} boundMs=${ACCESS_CLOSURE_BOUND_MS}`);
  });
});
