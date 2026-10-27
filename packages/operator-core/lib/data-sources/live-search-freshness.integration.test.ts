/** P001 actual provider-package reader; controlled provider values do not prove production currentness. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDER_SEARCH_LIVE_CAPABILITY, type ProviderAdapter, type ProviderDescriptor,
  type ProviderLiveSearchResult } from '@papercusp/plugin-sdk';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { createPersonalGrant } from '../personal-vault/store';
import { upsertPrivacyRule } from '../personal-vault/disclosure-ledger';
import { mapProviderIdentity, ORGANIZATION_CORPUS_SCOPE } from './documents-corpus';
import { liveDocumentId, providerLiveSearchAdapters, searchLiveSources } from './live-search-adapter';

const WS = 'p001-live-freshness-fixture';
const ROLE = 'meeting-prep';
const FIELDS = ['title', 'snippet', 'occurredAt', 'permalink', 'privacy'] as const;
const CASES = ['provider-fields', 'content-and-candidate-update', 'privacy-and-grant-transition', 'late-binding-transition'] as const;
const protocolBytes = readFileSync(new URL('../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-documents-freshness-protocol-20261025.json', import.meta.url));
const protocol = JSON.parse(protocolBytes.toString()) as {
  fields: Array<{ id: string; policy: SearchFieldFreshnessPolicy }>;
  sourcePins: Array<{ path: string; sha256: string }>;
};
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fingerprint = (v: unknown) => sha(JSON.stringify({ present: v !== undefined, value: v }));
const receipts: unknown[] = [];
const executed = new Set<string>();
const descriptor: ProviderDescriptor = { id: 'slack', contractVersion: 1, datatypes: ['chat-message'],
  capabilities: [PROVIDER_SEARCH_LIVE_CAPABILITY], egressHosts: ['p001-live.fixture.test'] };
let org: OrgTestDb;
let user: string;
let source: string;
let registry: ProviderRegistry;
let values: ProviderLiveSearchResult['hits'] = [];
let invokes: unknown[] = [];
let slow: { entered: () => void; pending: Promise<void> } | null = null;
let pins: Array<{ path: string; sha256: string }> = [];

function hit(version: number, externalId = 'cobalt-stable'): ProviderLiveSearchResult['hits'][number] {
  return { externalId, title: `Cobalt live version ${version}`, text: `Cobalt live body ${version}. ${'Retained sentence. '.repeat(60)}`,
    occurredAt: `2026-10-0${version}T12:00:00.000Z`, participants: ['alice@example.test'],
    permalink: `https://p001-live.fixture.test/record/${externalId}?v=${version}` };
}

const adapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
  invoke: async request => {
    const response = { hits: request.config?.slow ? [] : structuredClone(values) };
    invokes.push({ request: structuredClone(request), response: structuredClone(response), returnedAtMs: Date.now() });
    if (request.config?.slow && slow) { slow.entered(); await slow.pending; }
    return response;
  },
};

/** Independent local authority snapshot; these revisions say nothing about provider field revisions. */
async function authority() {
  const [row] = await org.adminSql`SELECT jsonb_build_object(
    'sources', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb)
      FROM harness_shared.data_sources d WHERE d.workspace_id = ${WS}),
    'mappings', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
      FROM harness_shared.provider_identity_mappings m WHERE m.workspace_id = ${WS}),
    'grants', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]'::jsonb)
      FROM harness_shared.personal_grants g WHERE g.workspace_id = ${WS}),
    'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
      FROM harness_shared.personal_privacy_rules r WHERE r.workspace_id = ${WS})
    ) AS state`;
  return { state: row!.state, epoch: fingerprint(row!.state), readAtMs: Date.now() };
}

async function search(agentOwnerId: string | null = 'su-p001-live-freshness-fixture') {
  const adapters = await providerLiveSearchAdapters(org.adminSql, { registry,
    fetchImpl: (async () => { throw new Error('controlled witness must not use network'); }) as typeof fetch });
  return searchLiveSources(org.adminSql, { workspaceId: WS, role: ROLE },
    { workspaceId: WS, principalUserId: user, agentOwnerId, query: 'cobalt', adapters });
}

async function capture(caseId: string, privacy: unknown = null) {
  const requestStartedAtMs = Date.now();
  const before = await authority();
  const fixture = structuredClone(values);
  const response = await search();
  const responseAtMs = Date.now();
  const after = await authority();
  if (!response.allowed) throw new Error(`unexpected refusal: ${response.reason}`);
  expect(response.failed).toEqual([]);
  expect(response.unmapped).toEqual([]);
  expect(response.results.map(r => r.id)).toEqual(fixture.map(h => liveDocumentId(source, h.externalId)));
  const fields = response.results.flatMap((returned, i) => {
    const expected = { ...fixture[i]!, snippet: fixture[i]!.text.slice(0, 600), privacy };
    return FIELDS.map(fieldPath => {
      expect(returned[fieldPath], fieldPath).toEqual(expected[fieldPath]);
      const policy = protocol.fields.find(f => f.id === `papercusp/documents:search/live/${fieldPath}`)!.policy;
      // The SDK supplies values but no trusted provider revision/clock. Do not promote
      // our fixture counter, local response clock or local authority epoch into one.
      const input = { returned: { entityRef: returned.id, fieldPath, valueFingerprint: fingerprint(returned[fieldPath]) },
        indexed: null, canonical: null, requestStartedAtMs, responseAtMs };
      const oracle = assertSearchFieldFreshness(policy, input);
      expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
      return { fieldPath, fixtureValueFingerprint: fingerprint(expected[fieldPath]), input, oracle };
    });
  });
  const [corpus] = await org.adminSql`SELECT count(*)::int AS n FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  expect(corpus!.n).toBe(0);
  const receipt = { caseId, requestStartedAtMs, responseAtMs, authorityBefore: before, authorityAfter: after,
    controlledProviderValues: fixture, response, fields, corpusRows: corpus!.n, invokes: structuredClone(invokes) };
  receipts.push(receipt);
  return receipt;
}

async function grant() {
  await createPersonalGrant(org.adminSql, { workspaceId: WS, userId: user, principalType: 'agent-role',
    principalId: ROLE, scopes: [ORGANIZATION_CORPUS_SCOPE], grantedBy: 'fixture-owner' });
}

beforeAll(async () => {
  expect(sha(protocolBytes)).toBe('675e29f75f2fe8325af2dd79b20adc6f6ec87d8def5ec8dfa646df4e32b81f57');
  const paths = [...protocol.sourcePins.map(p => p.path), 'packages/operator-core/lib/integrations/provider-registry.ts',
    'packages/operator-core/lib/integrations/source-host-fetch.ts', 'packages/operator-core/lib/integrations/service-credentials.ts'];
  pins = [...new Set(paths)].map(path => ({ path, sha256: sha(readFileSync(new URL(`../../../../${path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_LIVE_FRESHNESS_WITNESS_FILE) {
    for (const p of protocol.sourcePins) expect(pins.find(x => x.path === p.path)!.sha256, p.path).toBe(p.sha256);
  }
  org = await createOrgTestDb();
  const [row] = await org.adminSql`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'p001-live-' + org.dbName}, 'Live fixture') RETURNING id::text`;
  user = row!.id;
  registry = createProviderRegistry();
  await registry.register({ descriptor, adapter, pluginName: 'p001-controlled-live-provider' });
});

beforeEach(async () => {
  slow = null;
  invokes = [];
  values = [hit(1)];
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await grant();
  await mapProviderIdentity(org.adminSql, WS, { provider: 'slack', providerUserId: 'T1:UALICE', userId: user, mappedBy: 'fixture-owner' });
  const [row] = await org.adminSql`INSERT INTO harness_shared.data_sources (workspace_id, kind, config, status, sync_mode, scope)
    VALUES (${WS}, 'slack', ${org.adminSql.json({ source: 'slack', installSlug: 'p001-controlled' })}, 'ready', 'federated', 'organization') RETURNING id::text`;
  source = row!.id;
});

afterAll(async () => {
  const cleanup = await org?.cleanupWithResult();
  for (const p of pins) expect(sha(readFileSync(new URL(`../../../../${p.path}`, import.meta.url))), p.path).toBe(p.sha256);
  if (process.env.PAPERCUSP_LIVE_FRESHNESS_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_LIVE_FRESHNESS_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, scope: 'isolated actual provider-package live-search reader',
      protocolSha256: sha(protocolBytes), testSha256: sha(readFileSync(new URL(import.meta.url))), sourcePins: pins,
      database: org?.dbName, cleanup, declared: CASES, executed: [...executed], unexecuted: CASES.filter(c => !executed.has(c)),
      qualifiedFieldClaims: 0, receipts, limits: ['controlled provider responses; no production provider contacted',
        'provider field revisions/clocks absent; every freshness oracle remains unknown',
        'admin client injected; host authentication, RLS, documents:search dispatch and runtime closure unmeasured',
        'no ranking quality/cost/budget or production candidate population qualification',
        'authority transitions are real fixture mutations, not an enforcement-bypass witness'] }, null, 2));
});

describe('P001 actual provider-package live reader fields and authority', () => {
  it('preserves provider fields and rank without inventing provider currentness or storing content', async () => {
    const receipt = await capture('provider-fields');
    expect(receipt.response.results[0]!.score).toBe(1);
    expect(invokes).toHaveLength(1);
    executed.add('provider-fields');
  });

  it('observes changed fields and additions/removals through a fresh provider invocation', async () => {
    const before = await capture('update-before');
    values = [hit(2), hit(2, 'cobalt-added')];
    const updated = await capture('update-added');
    expect(updated.response.results[0]!.id).toBe(before.response.results[0]!.id);
    expect(updated.response.results[0]!.title).not.toBe(before.response.results[0]!.title);
    expect(updated.response.results.map(r => r.score)).toEqual([1, 0.5]);
    values = [hit(2, 'cobalt-added')];
    const removed = await capture('update-removed');
    expect(removed.response.results.map(r => r.id)).not.toContain(before.response.results[0]!.id);
    expect(invokes).toHaveLength(3);
    executed.add('content-and-candidate-update');
  });

  it('changes privacy authority and refuses a revoked grant before invoking the provider', async () => {
    const before = await capture('privacy-before');
    await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: 'slack',
      level: 'participants', actor: 'fixture-owner', authorityRef: null });
    const after = await capture('privacy-after', { level: 'participants', readerSet: ['alice@example.test'] });
    expect(after.authorityAfter.epoch).not.toBe(before.authorityAfter.epoch);
    const unowned = await search(null);
    expect(unowned).toMatchObject({ allowed: true, results: [], withheld: 1, disclosed: 0 });
    receipts.push({ caseId: 'restricted-no-agent', response: unowned });
    await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
    const invoked = invokes.length;
    const response = await search();
    expect(response.allowed).toBe(false);
    expect(invokes).toHaveLength(invoked);
    receipts.push({ caseId: 'grant-revoked', response, authority: await authority() });
    executed.add('privacy-and-grant-transition');
  });

  it('drops a fast source whose binding changes while a real package provider is pending', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    slow = { entered: enter, pending: new Promise<void>(resolve => { release = resolve; }) };
    await org.adminSql`INSERT INTO harness_shared.data_sources (workspace_id, kind, config, status, sync_mode, scope)
      VALUES (${WS}, 'slack', ${org.adminSql.json({ source: 'slow-slack', slow: true })}, 'ready', 'federated', 'organization')`;
    const before = await authority();
    const pending = search();
    await entered;
    try {
      await org.adminSql`UPDATE harness_shared.data_sources SET config = config || '{"changed":true}'::jsonb WHERE id = ${source}::uuid`;
    } finally { release(); }
    const response = await pending;
    expect(response).toMatchObject({ allowed: true, results: [],
      failed: [{ dataSourceId: source, source: 'slack', reason: 'live_search_binding_changed' }] });
    const [disclosed] = await org.adminSql`SELECT count(*)::int AS n FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
    expect(disclosed!.n).toBe(0);
    const after = await authority();
    expect(after.epoch).not.toBe(before.epoch);
    receipts.push({ caseId: 'late-binding-transition', authorityBefore: before, authorityAfter: after,
      response, disclosures: disclosed!.n, invokes: structuredClone(invokes) });
    executed.add('late-binding-transition');
  });
});
