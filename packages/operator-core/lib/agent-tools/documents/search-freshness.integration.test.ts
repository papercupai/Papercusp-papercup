/** P001: actual documents:search dispatch, organization handler and result projection.
 * Stored values/access are observable; absent candidate/provider revisions stay unknown.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { createPersonalGrant } from '../../personal-vault/store';
import { upsertPrivacyRule } from '../../personal-vault/disclosure-ledger';
import { mapProviderIdentity, replacePermissionListMembers, upsertOrganizationDocuments,
  upsertPermissionList } from '../../data-sources/documents-corpus';
import './search';

const WS = 'p001-documents-dispatch-fixture';
const AGENT = 'su-p001-documents-dispatch-fixture';
const IDENTITY = { provider: 'slack', providerUserId: 'T1:UDISPATCH' };
const FIELDS = ['title', 'snippet', 'occurredAt', 'privacy'] as const;
const CASES = ['projected-fields', 'content-update', 'privacy-and-acl', 'dispatch-refusals'] as const;
const protocolBytes = readFileSync(new URL('../../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-documents-freshness-protocol-20261025.json', import.meta.url));
const protocol = JSON.parse(protocolBytes.toString()) as {
  fields: Array<{ id: string; policy: SearchFieldFreshnessPolicy }>;
  sourcePins: Array<{ path: string; sha256: string }>;
};
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fingerprint = (value: unknown) => sha(JSON.stringify({ present: value !== undefined, value }));
const receipts: unknown[] = [];
const executed = new Set<string>();
let pins: Array<{ path: string; sha256: string }> = [];
let org: OrgTestDb;
let user: string;
let list: string;
const projected = lookupByMcpName('documents:search');
if (!projected) throw new Error('documents:search must be registered');

function context(): UnifiedToolContext {
  return {
    log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
    role: 'operator', runId: 'p001-documents-dispatch', workspaceId: WS, uiClientId: AGENT,
    isSuperuser: true, tx: org.adminSql,
    principal: { kind: 'user', trust: 'verified', slug: user, workspaceId: WS,
      capabilities: new Set(['search:read']) },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
  };
}

async function seed(version: number) {
  await upsertOrganizationDocuments(org.adminSql, WS, list, [{ source: 'slack', kind: 'message',
    dedupeKey: 'dispatch-stable-entity', externalId: 'dispatch-message',
    title: `Cobalt dispatch version ${version}`, text: `Cobalt dispatch body ${version}. ${'Source sentence. '.repeat(80)}`,
    occurredAt: `2026-10-0${version}T12:00:00Z`, participants: ['alice@example.test'] }]);
}

/** Independent SQL authority/current value snapshot, outside the handler transaction. */
async function canonical() {
  const [row] = await org.adminSql<{
    id: string; title: string; snippet: string; occurredAt: string; sourceRevision: string;
    authority: { members: unknown[]; rules: Array<{ level: string }>; grants: unknown[] };
  }[]>`SELECT d.id::text, d.title, left(d.text, 600) AS snippet, d.occurred_at::text AS "occurredAt",
       d.xmin::text AS "sourceRevision", jsonb_build_object(
         'members', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.provider, m.provider_user_id), '[]'::jsonb)
           FROM harness_shared.document_permission_members m WHERE m.workspace_id = ${WS} AND m.list_id = ${list}::uuid),
         'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
           FROM harness_shared.personal_privacy_rules r WHERE r.workspace_id = ${WS} AND r.user_id = ${user}::uuid),
         'grants', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]'::jsonb)
           FROM harness_shared.personal_grants g WHERE g.workspace_id = ${WS} AND g.user_id = ${user}::uuid)
       ) AS authority FROM harness_shared.documents d WHERE d.workspace_id = ${WS} AND d.scope = 'organization'`;
  if (!row) throw new Error('fixture canonical document missing');
  expect(row.authority.rules.length).toBeLessThanOrEqual(1);
  if (row.authority.rules.length) expect(row.authority.rules[0]!.level).toBe('participants');
  return { ...row, privacy: row.authority.rules.length ? { level: 'participants', readerSet: ['alice@example.test'] } : null,
    authorityEpoch: fingerprint({ workspace: WS, principal: user, role: 'operator', authority: row.authority }),
    readAtMs: Date.now() };
}

async function capture(caseId: string) {
  const requestStartedAtMs = Date.now();
  const before = await canonical();
  const result = await dispatchProjectedTool(projected!, 'documents:search',
    { query: 'cobalt dispatch', legs: ['organization'], limit: 10 }, context(), {});
  const responseAtMs = Date.now();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  const response = result.result?.structuredContent as {
    legs: { organization: { allowed: boolean; results: number } };
    results: Array<Record<string, unknown>>; restrictedResults?: number;
  };
  expect(response.legs.organization.allowed).toBe(true);
  expect(response.legs.organization.results).toBe(response.results.length);
  const after = await canonical();
  const fields = response.results.flatMap(returned => FIELDS.map(fieldPath => {
    expect(returned.scope).toBe('organization');
    const policy = protocol.fields.find(f => f.id === `papercusp/documents:search/organization/${fieldPath}`)!.policy;
    const input = { returned: { entityRef: String(returned.id), fieldPath, valueFingerprint: fingerprint(returned[fieldPath]) },
      indexed: null, canonical: { entityRef: after.id, fieldPath, valueFingerprint: fingerprint(after[fieldPath]),
        sourceRevision: after.sourceRevision, authority: policy.authority, authorityEpoch: after.authorityEpoch,
        readAtMs: after.readAtMs }, requestStartedAtMs, responseAtMs };
    expect(input.returned.valueFingerprint).toBe(input.canonical.valueFingerprint);
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
    expect(oracle.reasons).toContain('index witness unavailable');
    return { fieldPath, input, oracle };
  }));
  const receipt = { caseId, actualPath: 'dispatchProjectedTool → documents:search → searchOrganizationDocuments → structuredContent',
    requestStartedAtMs, responseAtMs, canonicalBefore: before, canonicalAfter: after, response, fields };
  receipts.push(receipt);
  return receipt;
}

beforeAll(async () => {
  expect(sha(protocolBytes)).toBe('675e29f75f2fe8325af2dd79b20adc6f6ec87d8def5ec8dfa646df4e32b81f57');
  const paths = [...protocol.sourcePins.map(p => p.path), 'libs/generic/tooldef/src/dispatch-projected.ts',
    'libs/generic/tooldef/src/dispatch-stack.ts', 'libs/generic/tooldef/src/define-tool.ts'];
  pins = paths.map(path => ({ path, sha256: sha(readFileSync(new URL(`../../../../../${path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_FRESHNESS_DISPATCH_WITNESS_FILE) {
    for (const pin of protocol.sourcePins) expect(pins.find(p => p.path === pin.path)!.sha256, pin.path).toBe(pin.sha256);
  }
  org = await createOrgTestDb();
  const [created] = await org.adminSql<{ id: string }[]>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'p001-dispatch-' + org.dbName}, 'P001 dispatch fixture') RETURNING id::text`;
  user = created!.id;
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.document_permission_lists WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.provider_identity_mappings WHERE workspace_id = ${WS}`;
  await createPersonalGrant(org.adminSql, { workspaceId: WS, userId: user, principalType: 'agent-role',
    principalId: 'operator', scopes: ['organization'], grantedBy: 'fixture-owner' });
  await mapProviderIdentity(org.adminSql, WS, { ...IDENTITY, userId: user, mappedBy: 'fixture-owner' });
  list = (await upsertPermissionList(org.adminSql, WS, { source: 'slack', sourceRef: 'T1:CDISPATCH' })).id;
  await replacePermissionListMembers(org.adminSql, WS, list, [IDENTITY]);
  await seed(1);
});

afterAll(async () => {
  const cleanup = await org?.cleanupWithResult();
  for (const pin of pins) expect(sha(readFileSync(new URL(`../../../../../${pin.path}`, import.meta.url))), pin.path).toBe(pin.sha256);
  if (process.env.PAPERCUSP_FRESHNESS_DISPATCH_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_FRESHNESS_DISPATCH_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, scope: 'isolated actual dispatch/organization/projection',
      protocolSha256: sha(protocolBytes), testSha256: sha(readFileSync(new URL(import.meta.url))), sourcePins: pins,
      database: org?.dbName, cleanup, declared: CASES, executed: [...executed],
      unexecuted: CASES.filter(c => !executed.has(c)), qualifiedFieldClaims: 0, receipts,
      limits: ['candidate/provider revision absent', 'lexical engine trace unmeasured',
        'personal/pot/live/sealed legs unmeasured', 'replayed payload is oracle-input mutation only',
        'transport host authorization, RLS and full runtime closure unmeasured'] }, null, 2));
});

describe('P001 actual documents:search field projection', () => {
  it('compares four projected organization fields against separate canonical reads', async () => {
    const found = await capture('projected-fields');
    expect(found.response.results).toHaveLength(1);
    expect(found.fields.map(f => f.fieldPath)).toEqual(FIELDS);
    executed.add('projected-fields');
  });
  it('observes an in-place update through dispatch and detects a retained old projected title', async () => {
    const before = await capture('content-update-before');
    await seed(2);
    const after = await capture('content-update-after');
    expect(after.canonicalAfter.id).toBe(before.canonicalAfter.id);
    expect(after.canonicalAfter.sourceRevision).not.toBe(before.canonicalAfter.sourceRevision);
    const title = after.fields.find(f => f.fieldPath === 'title')!;
    const input = { ...title.input, returned: before.fields.find(f => f.fieldPath === 'title')!.input.returned };
    const policy = protocol.fields.find(f => f.id === 'papercusp/documents:search/organization/title')!.policy;
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'stale', action: 'degrade' });
    expect(oracle.reasons).toContain('canonical: returned value differs');
    receipts.push({ caseId: 'retained-projected-title', input, oracle });
    executed.add('content-update');
  });
  it('projects changed privacy and removes revoked ACL results without a content revision change', async () => {
    const before = await capture('privacy-before');
    await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: 'slack',
      level: 'participants', actor: 'fixture-owner', authorityRef: null });
    const privateResult = await capture('privacy-after');
    expect(privateResult.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(privateResult.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    expect(privateResult.response.restrictedResults).toBe(1);
    await replacePermissionListMembers(org.adminSql, WS, list, []);
    const revoked = await capture('acl-revoked');
    expect(revoked.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(revoked.canonicalAfter.authorityEpoch).not.toBe(privateResult.canonicalAfter.authorityEpoch);
    expect(revoked.response.results).toEqual([]);
    expect(revoked.response.restrictedResults).toBeUndefined();
    executed.add('privacy-and-acl');
  });
  it('refuses malformed input and a disallowed dispatch role before returning documents', async () => {
    const args = { query: 'cobalt dispatch', legs: ['organization'] };
    const invalid = await dispatchProjectedTool(projected!, 'documents:search', { ...args, limit: 0 }, context(), {});
    const denied = await dispatchProjectedTool(projected!, 'documents:search', args, { ...context(), role: 'unapproved-role' }, {});
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe('invalid_input');
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('role_not_allowed');
    receipts.push({ caseId: 'dispatch-refusals', invalid: invalid.error, denied: denied.error });
    executed.add('dispatch-refusals');
  });
});
