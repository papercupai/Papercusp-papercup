/** P001: real stored-organization reader + separate canonical/authority reads.
 * This fixture proves stored-value and access behavior, not provider currentness.
 * Missing adapter revision metadata stays unknown under the frozen field policy.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createPersonalGrant } from '../personal-vault/store';
import { upsertPrivacyRule } from '../personal-vault/disclosure-ledger';
import {
  mapProviderIdentity, replacePermissionListMembers, searchOrganizationDocuments,
  upsertOrganizationDocuments, upsertPermissionList,
} from './documents-corpus';

const WS = 'p001-documents-freshness-fixture';
const ROLE = 'meeting-prep';
const IDENTITY = { provider: 'slack', providerUserId: 'T1:UFRESHNESS' };
const FIELDS = ['title', 'snippet', 'occurredAt', 'privacy'] as const;
const CASES = ['stored-values', 'mixed-version-field', 'privacy-rule-change', 'epoch-replay'] as const;
const protocolUrl = new URL('../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-documents-freshness-protocol-20261025.json', import.meta.url);
const protocolBytes = readFileSync(protocolUrl);
const protocol = JSON.parse(protocolBytes.toString()) as {
  fields: Array<{ id: string; policy: SearchFieldFreshnessPolicy }>;
  sourcePins: Array<{ path: string; sha256: string }>;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// The fixture's values are JSON primitives or fixed-shape privacy objects.
const fingerprint = (value: unknown) => sha(JSON.stringify({ present: value !== undefined, value }));
const receipts: unknown[] = [];
const executed = new Set<string>();
let sourcePins: Array<{ path: string; sha256: string; protocolSha256: string }> = [];
let org: OrgTestDb;
let user: string;
let list: string;

async function seed(version: number) {
  await upsertOrganizationDocuments(org.adminSql, WS, list, [{
    source: 'slack', kind: 'message', dedupeKey: 'freshness-stable-entity', externalId: 'freshness-message',
    title: `Cobalt freshness version ${version}`,
    text: `Cobalt freshness body version ${version}. ${'Retained qualifying sentence. '.repeat(40)}`,
    occurredAt: `2026-10-0${version}T12:00:00Z`, participants: ['alice@example.test'],
  }]);
}

/** Independent SQL snapshot. xmin identifies the STORED tuple, not a provider revision. */
async function canonical() {
  const [row] = await org.adminSql<{
    id: string; title: string; snippet: string; occurredAt: string; sourceRevision: string;
    participants: string[]; privacyRules: Array<{ level: string }>; authority: unknown;
  }[]>`
    SELECT d.id::text, d.title, left(d.text, 600) AS snippet, d.occurred_at::text AS "occurredAt",
           d.xmin::text AS "sourceRevision", d.participants,
           (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
              FROM harness_shared.personal_privacy_rules r
             WHERE r.workspace_id = ${WS} AND r.user_id = ${user}::uuid) AS "privacyRules",
           jsonb_build_object(
             'workspace', ${WS}::text, 'principal', ${user}::text, 'role', ${ROLE}::text,
             'grants', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]'::jsonb)
                         FROM harness_shared.personal_grants g WHERE g.workspace_id = ${WS} AND g.user_id = ${user}::uuid),
             'mappings', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
                           FROM harness_shared.provider_identity_mappings m WHERE m.workspace_id = ${WS} AND m.user_id = ${user}::uuid),
             'members', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.provider, m.provider_user_id), '[]'::jsonb)
                          FROM harness_shared.document_permission_members m WHERE m.workspace_id = ${WS} AND m.list_id = ${list}::uuid),
             'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
                        FROM harness_shared.personal_privacy_rules r WHERE r.workspace_id = ${WS} AND r.user_id = ${user}::uuid),
             'vault', (SELECT coalesce(jsonb_agg(to_jsonb(v)), '[]'::jsonb)
                        FROM harness_shared.personal_vault_settings v WHERE v.workspace_id = ${WS} AND v.user_id = ${user}::uuid)
           ) AS authority
      FROM harness_shared.documents d WHERE d.workspace_id = ${WS} AND d.scope = 'organization'`;
  if (!row) throw new Error('freshness fixture canonical document missing');
  // The predeclared fixture has either no rule or exactly one source/participants rule.
  expect(row.privacyRules.length).toBeLessThanOrEqual(1);
  if (row.privacyRules.length) expect(row.privacyRules[0]!.level).toBe('participants');
  return { ...row, privacy: row.privacyRules.length ? { level: 'participants', readerSet: row.participants } : null,
    authorityEpoch: fingerprint(row.authority), readAtMs: Date.now() };
}

async function capture(caseId: string) {
  const requestStartedAtMs = Date.now();
  const before = await canonical();
  const response = await searchOrganizationDocuments(org.adminSql, { workspaceId: WS, role: ROLE }, {
    workspaceId: WS, principalUserId: user, agentOwnerId: 'p001-freshness-fixture-agent', query: 'cobalt freshness',
  });
  const responseAtMs = Date.now();
  const after = await canonical();
  expect(response.allowed).toBe(true);
  if (!response.allowed) throw new Error('fixture unexpectedly refused');
  const fields = response.results.flatMap(returned => FIELDS.map(fieldPath => {
    const policy = protocol.fields.find(f => f.id === `papercusp/documents:search/organization/${fieldPath}`)!.policy;
    expect(policy.maxAgeMs).toBe(0);
    expect(policy.maxFutureSkewMs).toBe(0);
    const input = { returned: { entityRef: returned.id, fieldPath, valueFingerprint: fingerprint(returned[fieldPath]) },
      indexed: null, canonical: { entityRef: after.id, fieldPath, valueFingerprint: fingerprint(after[fieldPath]),
        sourceRevision: after.sourceRevision, authority: policy.authority, authorityEpoch: after.authorityEpoch,
        readAtMs: after.readAtMs }, requestStartedAtMs, responseAtMs };
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
    expect(oracle.reasons).toContain('index witness unavailable');
    expect(input.returned.valueFingerprint).toBe(input.canonical.valueFingerprint);
    return { fieldPath, input, oracle };
  }));
  const receipt = { caseId, actualReader: 'searchOrganizationDocuments', workspace: WS,
    request: { query: 'cobalt freshness', limit: 10, snippetChars: 600 }, requestStartedAtMs, responseAtMs,
    canonicalBefore: before, canonicalAfter: after, response, fields,
    missingEvidence: ['candidate source/index revision', 'provider revision/currentness', 'native lexical engine trace',
      'documents:search handler/projection invocation', 'sealed and alternative path populations'] };
  receipts.push(receipt);
  return receipt;
}

beforeAll(async () => {
  expect(sha(protocolBytes)).toBe('675e29f75f2fe8325af2dd79b20adc6f6ec87d8def5ec8dfa646df4e32b81f57');
  sourcePins = protocol.sourcePins.map(pin => ({ path: pin.path, protocolSha256: pin.sha256,
    sha256: sha(readFileSync(new URL(`../../../../${pin.path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_FRESHNESS_WITNESS_FILE) {
    for (const pin of sourcePins) expect(pin.sha256, pin.path).toBe(pin.protocolSha256);
  }
  org = await createOrgTestDb();
  const [created] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'p001-freshness-' + org.dbName}, 'P001 freshness fixture') RETURNING id::text`;
  user = created!.id;
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await createPersonalGrant(org.adminSql, { workspaceId: WS, userId: user, principalType: 'agent-role',
    principalId: ROLE, scopes: ['organization'], grantedBy: 'fixture-owner' });
  await mapProviderIdentity(org.adminSql, WS, { ...IDENTITY, userId: user, mappedBy: 'fixture-owner' });
  list = (await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: 'T1:CFRESHNESS' })).id;
  await replacePermissionListMembers(org.adminSql, WS, list, [IDENTITY]);
  await seed(1);
});

afterAll(async () => {
  const cleanup = await org?.cleanupWithResult();
  for (const pin of sourcePins) expect(sha(readFileSync(new URL(`../../../../${pin.path}`, import.meta.url))), pin.path)
    .toBe(pin.sha256);
  if (process.env.PAPERCUSP_FRESHNESS_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_FRESHNESS_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, scope: 'isolated stored organization reader only', protocolSha256: sha(protocolBytes),
      testSha256: sha(readFileSync(new URL(import.meta.url))), sourcePins, database: org?.dbName, cleanup,
      declared: CASES, executed: [...executed],
      unexecuted: CASES.filter(id => !executed.has(id)), qualifiedFieldClaims: 0, receipts }, null, 2));
});

describe('P001 actual stored organization field/authority capture', () => {
  it('compares all four returned fields to an independent canonical read without inventing a candidate revision', async () => {
    const receipt = await capture('stored-values');
    expect(receipt.response.results).toHaveLength(1);
    expect(receipt.fields.map(f => f.fieldPath)).toEqual(FIELDS);
    expect(receipt.canonicalBefore.authorityEpoch).toBe(receipt.canonicalAfter.authorityEpoch);
    executed.add('stored-values');
  });

  it('detects a retained old field after an in-place canonical update and observes the new value on the next native read', async () => {
    const old = await capture('mixed-version-field-before');
    await seed(2);
    const fresh = await capture('mixed-version-field-after');
    expect(fresh.canonicalAfter.id).toBe(old.canonicalAfter.id);
    expect(fresh.canonicalAfter.sourceRevision).not.toBe(old.canonicalAfter.sourceRevision);
    const title = fresh.fields.find(f => f.fieldPath === 'title')!;
    const replayed = { ...title.input, returned: old.fields.find(f => f.fieldPath === 'title')!.input.returned };
    const policy = protocol.fields.find(f => f.id === 'papercusp/documents:search/organization/title')!.policy;
    expect(assertSearchFieldFreshness(policy, replayed)).toMatchObject({ status: 'stale', action: 'degrade' });
    expect(assertSearchFieldFreshness(policy, replayed).reasons).toContain('canonical: returned value differs');
    receipts.push({ caseId: 'mixed-version-field-mutation', input: replayed, result: assertSearchFieldFreshness(policy, replayed) });
    executed.add('mixed-version-field');
  });

  it('changes privacy and authority epoch independently of the stored content revision', async () => {
    const before = await capture('privacy-rule-change-before');
    await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: 'slack',
      level: 'participants', actor: 'fixture-owner', authorityRef: null });
    const after = await capture('privacy-rule-change-after');
    expect(after.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(after.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    expect(after.response.results[0]!.privacy).toEqual({ level: 'participants', readerSet: ['alice@example.test'] });
    executed.add('privacy-rule-change');
  });

  it('removes the result after current ACL revocation while the content revision remains unchanged', async () => {
    const before = await capture('epoch-replay-before');
    await replacePermissionListMembers(org.adminSql, WS, list, []);
    const after = await capture('epoch-replay-after');
    expect(after.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(after.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    expect(after.response.results).toEqual([]);
    expect(after.response.withheld).toBe(0);
    executed.add('epoch-replay');
  });
});
