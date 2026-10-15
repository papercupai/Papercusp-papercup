/**
 * Organization documents corpus — permission enforcement against real Postgres
 * (plan enterprise-data-sources-2026-10-01 P-014, rubric criterion R-8; schema:
 * migration 1316).
 *
 * The property under test: an organization document is returned to a principal
 * only when ALL of these hold at query time — a live `organization` vault grant,
 * the document's source permission list contains a provider identity, and that
 * identity is explicitly and live-mapped to the principal (D-002). Each case
 * below removes exactly one of them and expects the document to disappear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant, searchPersonalDocuments, upsertPersonalDocuments } from '../personal-vault/store';
import { personalVaultRefusal } from '../pg-read-query';
import { readSelectedSupportCase } from '../blueprint/support-workflow-case';
import { parseSupportToEngineeringResult } from '../blueprint/support-workflow-contract';
import {
  ORGANIZATION_CORPUS_SCOPE,
  mapProviderIdentity,
  replacePermissionListMembers,
  revokeProviderIdentityMapping,
  searchOrganizationDocuments,
  upsertOrganizationDocuments,
  upsertPermissionList,
} from './documents-corpus';

let org: OrgTestDb;
let alice: string;
let bob: string;
let noGrant: string;
const WS = 'org-corpus-permissions-test';
const AGENT_ROLE = 'meeting-prep';
const ctx = { workspaceId: WS, role: AGENT_ROLE };
const SLACK_ALICE = { provider: 'slack', providerUserId: 'T1:UALICE' };
const SLACK_BOB = { provider: 'slack', providerUserId: 'T1:UBOB' };

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

/** A Slack channel list with `members`, holding one document about the cobalt roadmap. */
async function seedChannel(members: Array<{ provider: string; providerUserId: string }>): Promise<string> {
  const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: 'T1:CROADMAP', title: '#roadmap' });
  await replacePermissionListMembers(org.adminSql, WS, list.id, members);
  await upsertOrganizationDocuments(org.adminSql, WS, list.id, [{
    source: 'slack', kind: 'message', dedupeKey: 'T1:CROADMAP:1700000000.000100',
    externalId: '1700000000.000100', occurredAt: '2026-09-30T12:00:00Z',
    title: '#roadmap', text: 'The cobalt roadmap ships the quarterly planning review.',
  }]);
  return list.id;
}

async function search(userId: string, role = AGENT_ROLE) {
  return searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role }, {
    workspaceId: WS, principalUserId: userId, agentOwnerId: 'org-corpus-test', query: 'cobalt roadmap',
  });
}

async function visibleTitles(userId: string): Promise<string[]> {
  const out = await search(userId);
  if (!out.allowed) throw new Error(`expected allowed search, got ${out.reason}`);
  return out.results.map((r) => r.title);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  alice = await makeUser('org-corpus-alice');
  bob = await makeUser('org-corpus-bob');
  noGrant = await makeUser('org-corpus-nogrant');
});

afterAll(async () => {
  for (const id of [alice, bob, noGrant].filter(Boolean)) {
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${id}`.catch(() => {});
  }
  await org?.cleanup();
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await grantOrganization(alice);
  await grantOrganization(bob);
});

describe('organization corpus permissions (R-8)', () => {
  it('reads a support selection only for its verified current principal and current provider ACL', async () => {
    const listId = await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    const found = await search(alice);
    if (!found.allowed) throw new Error('expected corpus permission');
    const id = found.results[0]!.id;
    const workflow = { harnessSlug: 'support', operationId: 'support-to-engineering', approvedRevision: 'a'.repeat(64),
      accountableOwner: 'pilot-owner', reviewerPrincipals: ['reviewer'], allowedSources: ['slack'],
      allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 };
    const input = { supportCaseId: 'case-1', approvedRevision: workflow.approvedRevision, documentIds: [id],
      query: 'cobalt roadmap', requestedAction: 'prepare-handoff' };
    const current = { ...ctx, principal: { kind: 'user', trust: 'verified', slug: alice, workspaceId: WS } };
    const selected = await readSelectedSupportCase(org.adminSql, current, workflow, input);
    expect(selected).toMatchObject({
      allowed: true, results: [{ id }],
    });
    if (!selected.allowed) throw new Error('expected selected case permission');
    const citation = { id, source: selected.results[0]!.source, externalId: selected.results[0]!.externalId };
    const output = { supportCaseId: input.supportCaseId, summary: 'Cobalt planning needs an engineering handoff',
      reproduction: ['Read the selected support case'], checklist: [], suggestedRole: 'engineer', citations: [citation] };
    expect(parseSupportToEngineeringResult(output, input, selected.results).citations).toEqual([citation]);
    expect(() => parseSupportToEngineeringResult({ ...output,
      citations: [{ ...citation, externalId: 'forged-other-case' }] }, input, selected.results)).toThrow(/evidence/);
    await expect(readSelectedSupportCase(org.adminSql,
      { ...current, principal: { ...current.principal, workspaceId: 'other-workspace' } }, workflow, input))
      .rejects.toThrow(/current workspace/);
    await expect(readSelectedSupportCase(org.adminSql,
      { ...current, principal: { ...current.principal, trust: 'unverified' } }, workflow, input))
      .rejects.toThrow(/verified user/);
    await expect(readSelectedSupportCase(org.adminSql,
      { ...current, principal: { ...current.principal, slug: bob } }, workflow, input))
      .rejects.toThrow(/unavailable/);
    await org.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now()
      WHERE workspace_id = ${WS} AND user_id = ${alice}::uuid`;
    expect(await readSelectedSupportCase(org.adminSql, current, workflow, input))
      .toMatchObject({ allowed: false, reason: 'no_live_grant' });
    await grantOrganization(alice);
    await replacePermissionListMembers(org.adminSql, WS, listId, []);
    await expect(readSelectedSupportCase(org.adminSql, current, workflow, input)).rejects.toThrow(/revoked/);
    const revoked = await searchOrganizationDocuments(org.adminSql, ctx, {
      workspaceId: WS, principalUserId: alice, agentOwnerId: alice, query: input.query, documentIds: input.documentIds,
    });
    if (!revoked.allowed) throw new Error('expected live organization grant');
    expect(() => parseSupportToEngineeringResult(output, input, revoked.results)).toThrow(/evidence/);
  });

  it('narrows a selected support case without widening live source permissions', async () => {
    const listId = await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    const before = await search(alice);
    expect(before.allowed).toBe(true);
    if (!before.allowed) return;
    const selectedId = before.results[0]!.id;
    await upsertOrganizationDocuments(org.adminSql, WS, listId, [{
      source: 'slack', kind: 'message', dedupeKey: 'other-support-case',
      title: 'Other case', text: 'A second cobalt roadmap case must not enter the selected handoff.',
    }]);
    const selected = (principalUserId = alice, documentIds: string[] = [selectedId]) =>
      searchOrganizationDocuments(org.adminSql, ctx, {
        workspaceId: WS, principalUserId, agentOwnerId: 'org-corpus-test', query: 'cobalt roadmap', documentIds,
      });
    const result = await selected();
    expect(result.allowed && result.results.map((r) => r.id)).toEqual([selectedId]);
    const empty = await selected(alice, []);
    expect(empty.allowed && empty.results).toEqual([]);
    const denied = await selected(bob);
    expect(denied.allowed && denied.results).toEqual([]);
    expect(await selected(noGrant)).toEqual({ allowed: false, reason: 'no_live_grant' });

    await replacePermissionListMembers(org.adminSql, WS, listId, []);
    const revoked = await selected();
    expect(revoked.allowed && revoked.results).toEqual([]);
    expect(JSON.stringify(revoked)).not.toContain('quarterly planning review');
  });

  it('refuses malformed or unbounded document selections', async () => {
    for (const documentIds of [['not-an-id'], Array(51).fill('00000000-0000-4000-8000-000000000000')]) {
      await expect(searchOrganizationDocuments(org.adminSql, ctx, {
        workspaceId: WS, principalUserId: alice, agentOwnerId: 'org-corpus-test',
        query: 'cobalt roadmap', documentIds,
      })).rejects.toThrow(/at most 50 canonical UUIDs/);
    }
  });

  it('returns the document to a granted principal whose mapped identity is on the list', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    const out = await search(alice);
    expect(out.allowed).toBe(true);
    if (!out.allowed) return;
    expect(out.results.map((r) => r.title)).toEqual(['#roadmap']);
    expect(out.results[0]).toMatchObject({ source: 'slack', kind: 'message', externalId: '1700000000.000100' });
    expect(out.withheld).toBe(0);
  });

  it('returns nothing to a granted principal with no mapped provider identity', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await visibleTitles(bob)).toEqual([]);
  });

  it('a mapped identity that is not on the list grants nothing', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_BOB, userId: bob, mappedBy: 'owner' });
    expect(await visibleTitles(bob)).toEqual([]);
  });

  it('a membership refresh moves access on the next read, with no cache to invalidate', async () => {
    const listId = await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_BOB, userId: bob, mappedBy: 'owner' });
    expect(await visibleTitles(alice)).toEqual(['#roadmap']);
    expect(await visibleTitles(bob)).toEqual([]);

    const delta = await replacePermissionListMembers(org.adminSql, WS, listId, [SLACK_BOB]);
    expect(delta).toEqual({ added: 1, removed: 1 });
    expect(await visibleTitles(alice)).toEqual([]);
    expect(await visibleTitles(bob)).toEqual(['#roadmap']);
  });

  it('revoking a mapping removes access; the identity can then be mapped to someone else', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await visibleTitles(alice)).toEqual(['#roadmap']);

    await expect(
      mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: bob, mappedBy: 'owner' }),
    ).rejects.toThrow('provider_identity_already_mapped');

    const revoked = await revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' });
    expect(revoked).toEqual({ revoked: 1 });
    expect(await visibleTitles(alice)).toEqual([]);

    const remapped = await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: bob, mappedBy: 'owner' });
    expect(remapped.created).toBe(true);
    expect(await visibleTitles(bob)).toEqual(['#roadmap']);
  });

  it('refuses without a live organization grant, even when the ACL would allow it', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: noGrant, mappedBy: 'owner' });
    expect(await search(noGrant)).toEqual({ allowed: false, reason: 'no_live_grant' });
  });

  it('hard-denies a coding role regardless of grant and ACL', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await search(alice, 'worker')).toEqual({ allowed: false, reason: 'coding_agent_denied' });
  });

  it('personal search never returns organization rows, and organization search never returns personal rows', async () => {
    await seedChannel([SLACK_ALICE]);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    await upsertPersonalDocuments(org.adminSql, WS, alice, [{
      source: 'gmail', kind: 'message', externalId: 'p1', participants: [],
      title: 'Personal cobalt roadmap', text: 'My own cobalt roadmap notes.', dedupeKey: 'p1',
    }]);
    const personal = await searchPersonalDocuments(org.adminSql, WS, alice, { query: 'cobalt roadmap' });
    expect(personal.map((r) => r.title)).toEqual(['Personal cobalt roadmap']);
    expect(await visibleTitles(alice)).toEqual(['#roadmap']);
  });

  it('the schema refuses an organization row that names an owner or omits its list', async () => {
    const listId = await seedChannel([]);
    await expect(org.adminSql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, scope, permission_list_id, source, kind, dedupe_key)
      VALUES (${WS}, ${alice}, 'organization', ${listId}::uuid, 'slack', 'message', 'owned')`,
    ).rejects.toThrow(/documents_scope_chk/);
    await expect(org.adminSql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, scope, permission_list_id, source, kind, dedupe_key)
      VALUES (${WS}, NULL, 'organization', NULL, 'slack', 'message', 'listless')`,
    ).rejects.toThrow(/documents_scope_chk/);
  });

  it('ad-hoc SQL against the access-control tables is refused', () => {
    for (const table of ['document_permission_lists', 'document_permission_members', 'provider_identity_mappings']) {
      expect(personalVaultRefusal(`SELECT * FROM harness_shared.${table}`)).toMatch(/organization documents corpus/);
    }
  });
});

/**
 * P-007b (plan papercusp-enterprise-readiness-roadmap-2026-10-09, bar R-4 data clause, A-8):
 * a permitted AND a denied journey for source revocation and restricted-content canaries on the
 * organization-corpus retrieval path. Every denied case first proves the canary IS retrievable
 * by a permitted principal, so "the canary is absent" can never pass vacuously, and asserts on
 * the whole serialized result so the canary cannot leak through any field (title, text, snippet).
 * The revocation cases measure revocation-to-deny time against the A-8 contract bound.
 */
const ACCESS_CLOSURE_BOUND_MS = 60_000;

describe('P-007b revocation and restricted-content canary journeys (organization corpus)', () => {
  const canary = () => `CANARY-P007B-${Math.random().toString(36).slice(2, 10)}`;

  async function seedRestricted(members: Array<{ provider: string; providerUserId: string }>, token: string) {
    const list = await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: 'T1:CRESTRICTED', title: '#restricted' });
    await replacePermissionListMembers(org.adminSql, WS, list.id, members);
    await upsertOrganizationDocuments(org.adminSql, WS, list.id, [{
      source: 'slack', kind: 'message', dedupeKey: `T1:CRESTRICTED:${token}`,
      externalId: '1700000000.000900', occurredAt: '2026-09-30T13:00:00Z',
      title: '#restricted', text: `Restricted cobalt roadmap figures ${token}.`,
    }]);
    return list.id;
  }

  /** The whole serialized search result, for both the default and the canary-token query. */
  async function serializedResults(userId: string, token: string): Promise<string> {
    const outs = [];
    for (const query of ['cobalt roadmap', token]) {
      const out = await searchOrganizationDocuments(org.adminSql, ctx, {
        workspaceId: WS, principalUserId: userId, agentOwnerId: 'org-corpus-test', query,
      });
      expect(out.allowed).toBe(true);
      outs.push(out);
    }
    return JSON.stringify(outs);
  }

  /** Runs `revoke`, then the next read; returns the elapsed ms and that read's serialized result. */
  async function timeRevocationToNextRead(userId: string, token: string, revoke: () => Promise<unknown>) {
    const started = performance.now();
    await revoke();
    const after = await serializedResults(userId, token);
    const elapsedMs = performance.now() - started;
    return { elapsedMs, after };
  }

  it('permitted: a mapped member retrieves the restricted canary document', async () => {
    const token = canary();
    await seedRestricted([SLACK_ALICE], token);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await serializedResults(alice, token)).toContain(token);
  });

  it('denied: the restricted canary never reaches a granted, mapped non-member', async () => {
    const token = canary();
    await seedRestricted([SLACK_ALICE], token);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_BOB, userId: bob, mappedBy: 'owner' });
    expect(await serializedResults(alice, token)).toContain(token);
    expect(await serializedResults(bob, token)).not.toContain(token);
  });

  it('denied: revoking the provider identity mapping closes access on the next read, inside the 60s bound', async () => {
    const token = canary();
    await seedRestricted([SLACK_ALICE], token);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await serializedResults(alice, token)).toContain(token);

    const { elapsedMs, after } = await timeRevocationToNextRead(alice, token, () =>
      revokeProviderIdentityMapping(org.adminSql, WS, { ...SLACK_ALICE, revokedBy: 'owner' }));
    expect(after).not.toContain(token);
    expect(elapsedMs).toBeLessThan(ACCESS_CLOSURE_BOUND_MS);
    console.info(`P007B_ACCESS_CLOSURE path=organization-corpus revocation=provider-identity-mapping elapsedMs=${elapsedMs.toFixed(1)} boundMs=${ACCESS_CLOSURE_BOUND_MS}`);
  });

  it('denied: removing the member from the source permission list closes access on the next read, inside the 60s bound', async () => {
    const token = canary();
    const listId = await seedRestricted([SLACK_ALICE], token);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await serializedResults(alice, token)).toContain(token);

    const { elapsedMs, after } = await timeRevocationToNextRead(alice, token, () =>
      replacePermissionListMembers(org.adminSql, WS, listId, []));
    expect(after).not.toContain(token);
    expect(elapsedMs).toBeLessThan(ACCESS_CLOSURE_BOUND_MS);
    console.info(`P007B_ACCESS_CLOSURE path=organization-corpus revocation=permission-list-member elapsedMs=${elapsedMs.toFixed(1)} boundMs=${ACCESS_CLOSURE_BOUND_MS}`);
  });

  it('denied: withdrawing the organization grant refuses the next read entirely', async () => {
    const token = canary();
    await seedRestricted([SLACK_ALICE], token);
    await mapProviderIdentity(org.adminSql, WS, { ...SLACK_ALICE, userId: alice, mappedBy: 'owner' });
    expect(await serializedResults(alice, token)).toContain(token);

    await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS} AND user_id = ${alice}`;
    const out = await searchOrganizationDocuments(org.adminSql, ctx, {
      workspaceId: WS, principalUserId: alice, agentOwnerId: 'org-corpus-test', query: token,
    });
    expect(out).toEqual({ allowed: false, reason: 'no_live_grant' });
  });
});
