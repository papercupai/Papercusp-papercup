/** P001: actual personal/social dispatch, stored-value and disclosure witnesses. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { createPersonalGrant, setPersonalVaultEnabled, upsertPersonalDocuments } from '../../personal-vault/store';
import { assertDisclosurePermits, upsertPrivacyRule } from '../../personal-vault/disclosure-ledger';
import { parseSocialPostRef } from '../../capability-verbs/social';
import { searchSocialPosts } from '../../capability-verbs/social-read';
import { installSocialPackages } from '../../capability-verbs/social-provider.fixture';
import { providerRegistry } from '../../integrations/provider-registry';

// Session identity and the unavailable vector leg are explicit fixture seams.
// Authorization, storage, registry, projection and disclosure use real code/SQL.
const session = vi.hoisted(() => ({ user: '' }));
vi.mock('../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: session.user }) }));
vi.mock('../../personal-vault/embedding', () => ({ PERSONAL_EMBEDDER_MODE: 'gemma',
  buildPersonalQueryEmbedder: async () => { throw new Error('declared lexical-only fixture'); } }));
import './search';
import '../social/search';

const WS = 'p001-personal-social-fixture';
const AGENT = 'su-p001-personal-social-fixture';
const POST = 'at://did:plc:p001/app.bsky.feed.post/cobalt';
const CASES = ['projected-fields', 'content-and-candidates', 'grant-transitions',
  'personal-disclosure', 'social-disclosure', 'social-unattributed-withholding'] as const;
const protocolBytes = readFileSync(new URL('../../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-personal-social-freshness-protocol-20261025.json', import.meta.url));
const protocol = JSON.parse(protocolBytes.toString()) as {
  fields: Array<{ id: string; surface: string; policy: SearchFieldFreshnessPolicy }>;
  sourcePins: Array<{ path: string; sha256: string }>;
};
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fingerprint = (v: unknown) => sha(JSON.stringify({ present: v !== undefined, value: v }));
const receipts: unknown[] = [];
const executed = new Set<string>();
let org: OrgTestDb;
let user: string;
let foreignUser: string;
let pins: Array<{ path: string; sha256: string }> = [];

function context(identity: string | null = AGENT): UnifiedToolContext {
  return { log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
    role: 'operator', runId: 'p001-personal-social', workspaceId: WS, uiClientId: identity,
    isSuperuser: true, tx: org.adminSql, transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    principal: { kind: 'user', trust: 'verified', slug: user, workspaceId: WS, capabilities: new Set(['search:read']) } };
}

async function seed(owner: string, source: string, version = 1, externalId = source === 'bluesky' ? POST : 'cobalt-mail') {
  return upsertPersonalDocuments(org.adminSql, WS, owner, [{ source,
    kind: source === 'bluesky' ? 'social-post' : 'email', externalId, dedupeKey: externalId,
    title: `Cobalt ${source} version ${version}`, text: `Cobalt ${source} body ${version}. ${'Cobalt sentence. '.repeat(80)}`,
    occurredAt: `2026-10-0${version}T12:00:00Z`, participants: ['alice@example.test'] }]);
}

async function canonical() {
  const docs = await org.adminSql<Array<Record<string, unknown> & { id: string; source: string; externalId: string }>>`
    SELECT id::text, source, external_id AS "externalId", title, left(text,600) AS snippet,
      occurred_at::text AS "occurredAt", xmin::text AS "sourceRevision"
    FROM harness_shared.documents WHERE workspace_id = ${WS} AND user_id = ${user}::uuid ORDER BY id`;
  const [authority] = await org.adminSql`SELECT jsonb_build_object(
    'grants',(SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id),'[]'::jsonb) FROM harness_shared.personal_grants g
      WHERE g.workspace_id = ${WS} AND g.user_id = ${user}::uuid),
    'rules',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM harness_shared.personal_privacy_rules r
      WHERE r.workspace_id = ${WS} AND r.user_id = ${user}::uuid),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) FROM harness_shared.personal_vault_settings s
      WHERE s.workspace_id = ${WS} AND s.user_id = ${user}::uuid)) AS state`;
  return { docs, authority: authority!.state, authorityEpoch: fingerprint(authority!.state), readAtMs: Date.now() };
}

async function call(surface: 'personal:search' | 'social:search', identity: string | null = AGENT) {
  const requestStartedAtMs = Date.now();
  const before = await canonical();
  const tool = lookupByMcpName(surface);
  if (!tool) throw new Error(`${surface} not registered`);
  const args = surface === 'personal:search' ? { query: 'cobalt', scopes: ['mail'], limit: 10 } : { query: 'cobalt', limit: 10 };
  const result = await dispatchProjectedTool(tool, surface, args, context(identity), {});
  const responseAtMs = Date.now();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  const response = result.result?.structuredContent as {
    allowed: boolean; refusal?: string; vectorLeg: string; results?: Array<Record<string, unknown>>;
    hits?: Array<Record<string, unknown>>; skipped?: unknown[]; scopesSearched?: string[];
    restrictedResults?: number; withheldRestricted?: number;
  };
  const after = await canonical();
  const rows = surface === 'personal:search' ? response.results ?? [] : response.hits ?? [];
  const fields = rows.flatMap(row => protocol.fields.filter(f => f.surface === surface).map(field => {
    const source = surface === 'personal:search' ? after.docs.find(d => d.id === row.id)
      : after.docs.find(d => d.source === 'bluesky' && d.externalId === parseSocialPostRef(String(row.postId)).externalId);
    expect(source, 'returned row resolves to independent owner corpus').toBeDefined();
    const expected = field.policy.fieldPath === 'postId' ? `bluesky:${source!.externalId}`
      : field.policy.fieldPath === 'replyable' ? { allowed: true } : source![field.policy.fieldPath];
    expect(row[field.policy.fieldPath]).toEqual(expected);
    const input = { returned: { entityRef: source!.id, fieldPath: field.policy.fieldPath,
      valueFingerprint: fingerprint(row[field.policy.fieldPath]) }, indexed: null,
      canonical: { entityRef: source!.id, fieldPath: field.policy.fieldPath, valueFingerprint: fingerprint(expected),
        sourceRevision: String(source!.sourceRevision), authority: field.policy.authority,
        authorityEpoch: after.authorityEpoch, readAtMs: after.readAtMs }, requestStartedAtMs, responseAtMs };
    const oracle = assertSearchFieldFreshness(field.policy, input);
    expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
    return { id: field.id, input, oracle };
  }));
  const receipt = { surface, identity, before, after, requestStartedAtMs, responseAtMs, response, fields };
  receipts.push(receipt);
  return receipt;
}

beforeAll(async () => {
  pins = protocol.sourcePins.map(pin => ({ path: pin.path,
    sha256: sha(readFileSync(new URL(`../../../../../${pin.path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_PERSONAL_SOCIAL_WITNESS_FILE) expect(pins).toEqual(protocol.sourcePins);
  providerRegistry().clear();
  await installSocialPackages([{ platform: 'bluesky' }], providerRegistry());
  org = await createOrgTestDb();
  const users = await org.adminSql<Array<{ id: string }>>`INSERT INTO harness_shared.users (username,display_name)
    VALUES (${'p001-social-' + org.dbName},'Fixture'),(${'p001-social-foreign-' + org.dbName},'Foreign fixture') RETURNING id::text`;
  user = users[0]!.id;
  foreignUser = users[1]!.id;
  session.user = user;
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await setPersonalVaultEnabled(org.adminSql, WS, user, true, 'fixture-owner');
  await setPersonalVaultEnabled(org.adminSql, WS, foreignUser, true, 'fixture-owner');
  await createPersonalGrant(org.adminSql, { workspaceId: WS, userId: user, principalType: 'agent-role',
    principalId: 'operator', scopes: ['mail','bluesky'], grantedBy: 'fixture-owner' });
  await seed(user, 'mail');
  await seed(user, 'bluesky');
  await seed(user, 'gcal');
  await seed(foreignUser, 'mail', 2);
  await seed(foreignUser, 'bluesky', 2);
});

afterAll(async () => {
  const cleanup = await org?.cleanupWithResult();
  for (const pin of pins) expect(sha(readFileSync(new URL(`../../../../../${pin.path}`, import.meta.url))), pin.path).toBe(pin.sha256);
  if (process.env.PAPERCUSP_PERSONAL_SOCIAL_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_PERSONAL_SOCIAL_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, protocolSha256: sha(protocolBytes), testSha256: sha(readFileSync(new URL(import.meta.url))),
      declared: CASES, executed: [...executed], unexecuted: CASES.filter(c => !executed.has(c)), sourcePins: pins,
      cleanup, receipts, qualifiedFieldClaims: 0,
      limits: ['controlled imported provider content', 'session-user and unavailable embedding fixture seams',
        'admin SQL injected; host authentication/RLS/full runtime unmeasured', 'candidate/provider revisions absent; field currentness unknown'] }, null, 2));
});

describe('P001 personal:search and social:search dispatch witnesses', () => {
  it('compares all eight fields and excludes foreign users, mail from social, and ungranted sources', async () => {
    for (const surface of ['personal:search','social:search'] as const) {
      const r = await call(surface);
      expect(r.response.allowed).toBe(true);
      expect(r.response.vectorLeg).toBe('unavailable');
      expect(r.fields).toHaveLength(surface === 'personal:search' ? 3 : 5);
    }
    executed.add('projected-fields');
  });
  it('observes in-place updates and candidate insertion/removal through both entrypoints', async () => {
    for (const [surface,source] of [['personal:search','mail'],['social:search','bluesky']] as const) {
      const before = await call(surface);
      await seed(user, source, 2);
      const after = await call(surface);
      expect(after.fields.find(f => f.input.returned.fieldPath === 'title')!.input.returned.valueFingerprint)
        .not.toBe(before.fields.find(f => f.input.returned.fieldPath === 'title')!.input.returned.valueFingerprint);
      await seed(user, source, 2, 'cobalt-new-candidate');
      const added = await call(surface);
      expect(added.fields.length).toBe(after.fields.length * 2);
      await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS} AND user_id = ${user}::uuid
        AND source = ${source} AND external_id = 'cobalt-new-candidate'`;
      expect((await call(surface)).fields.length).toBe(after.fields.length);
    }
    executed.add('content-and-candidates');
  });
  it('refuses both entrypoints after grant revocation', async () => {
    await org.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now() WHERE workspace_id = ${WS}`;
    for (const surface of ['personal:search','social:search'] as const) {
      const r = await call(surface);
      expect(r.response).toMatchObject({ allowed: false, refusal: 'no_live_grant' });
      expect(r.fields).toEqual([]);
    }
    executed.add('grant-transitions');
  });
  for (const [surface,source,caseId] of [['personal:search','mail','personal-disclosure'],
    ['social:search','bluesky','social-disclosure']] as const) {
    it(`${surface} labels and ledgers restricted results, constraining subsequent egress`, async () => {
      await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: source,
        level: 'participants', actor: 'fixture-owner', authorityRef: null });
      const r = await call(surface);
      const rows = r.response.results ?? r.response.hits ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.privacy).toEqual({ level: 'participants', readerSet: ['alice@example.test'] });
      expect(r.response.restrictedResults).toBe(1);
      const ledger = await org.adminSql`SELECT agent_owner_id,delivered_via FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`;
      expect(ledger).toEqual([{ agent_owner_id: AGENT, delivered_via: surface }]);
      await expect(assertDisclosurePermits(org.adminSql, { workspaceId: WS, userId: user, agentOwnerId: AGENT,
        recipients: ['outsider@example.test'], sink: 'fixture-egress-check' })).rejects.toMatchObject({ code: 'disclosure_reader_set_violation' });
      executed.add(caseId);
    });
  }
  it('withholds restricted social hits from an unattributed caller', async () => {
    await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: 'bluesky',
      level: 'participants', actor: 'fixture-owner', authorityRef: null });
    // A projected call with no uiClientId can still resolve the host's session
    // identity. Exercise the actual reader with an explicit absent identity.
    const response = await searchSocialPosts(org.adminSql, { workspaceId: WS, userId: user,
      agentOwnerId: null, query: 'cobalt', grantedScopes: ['personal:bluesky'] }, { registry: providerRegistry() });
    expect(response.hits).toEqual([]);
    expect(response.withheldRestricted).toBe(1);
    expect(await org.adminSql`SELECT id FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`).toEqual([]);
    receipts.push({ surface: 'social:search/reader', identity: null, control: 'explicit-null-identity', response });
    executed.add('social-unattributed-withholding');
  });
});
