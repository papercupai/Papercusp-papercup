/** Actual personal document dispatch against stored fields and changing grant/privacy authority. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { createPersonalGrant, setPersonalVaultEnabled, upsertPersonalDocuments } from '../../personal-vault/store';
import { upsertPrivacyRule } from '../../personal-vault/disclosure-ledger';
import './search';

const WS = 'p001-personal-dispatch-fixture';
const AGENT = 'su-p001-personal-dispatch-fixture';
const FIELDS = ['title', 'snippet', 'occurredAt'] as const;
const CASES = ['projected-fields', 'content-update', 'grant-transition', 'privacy-transition'] as const;
const protocolBytes = readFileSync(new URL('../../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-documents-freshness-protocol-20261025.json', import.meta.url));
const protocol = JSON.parse(protocolBytes.toString()) as {
  fields: Array<{ id: string; policy: SearchFieldFreshnessPolicy }>;
  sourcePins: Array<{ path: string; sha256: string }>;
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value: unknown) => sha(JSON.stringify({ present: value !== undefined, value }));
const receipts: unknown[] = [];
const executed = new Set<string>();
let org: OrgTestDb;
let user: string;
let foreignUser: string;
let pins: Array<{ path: string; sha256: string }> = [];
const projected = lookupByMcpName('documents:search');
if (!projected) throw new Error('documents:search must be registered');

function context(): UnifiedToolContext {
  return { log: () => {}, progress: () => {}, emit: () => {}, signal: new AbortController().signal,
    role: 'operator', runId: 'p001-personal-dispatch', workspaceId: WS, uiClientId: AGENT,
    isSuperuser: true, tx: org.adminSql, transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    principal: { kind: 'user', trust: 'verified', slug: user, workspaceId: WS, capabilities: new Set(['search:read']) } };
}

/** Uses the real import writer with synthetic provider values; no provider is contacted. */
async function seed(owner: string, version: number, source = 'mail') {
  return upsertPersonalDocuments(org.adminSql, WS, owner, [{ source, kind: 'email',
    externalId: 'cobalt-personal', dedupeKey: 'cobalt-personal-stable',
    title: `Cobalt personal version ${version}`, text: `Cobalt personal body ${version}. ${'Cobalt personal sentence. '.repeat(80)}`,
    occurredAt: `2026-10-0${version}T12:00:00Z`, participants: ['alice@example.test'] }]);
}

/** An independent SQL snapshot, outside the actual handler's transaction. */
async function canonical() {
  const [row] = await org.adminSql<Array<{
    id: string; title: string; snippet: string; occurredAt: string; sourceRevision: string;
    authority: { grants: unknown[]; settings: unknown[]; rules: Array<{ level: string }> };
  }>>`SELECT d.id::text, d.title, left(d.text, 600) AS snippet, d.occurred_at::text AS "occurredAt",
    d.xmin::text AS "sourceRevision", jsonb_build_object(
      'grants', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.id), '[]'::jsonb)
        FROM harness_shared.personal_grants g WHERE g.workspace_id = ${WS} AND g.user_id = ${user}::uuid),
      'settings', (SELECT coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
        FROM harness_shared.personal_vault_settings s WHERE s.workspace_id = ${WS} AND s.user_id = ${user}::uuid),
      'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
        FROM harness_shared.personal_privacy_rules r WHERE r.workspace_id = ${WS} AND r.user_id = ${user}::uuid)
    ) AS authority FROM harness_shared.documents d
    WHERE d.workspace_id = ${WS} AND d.user_id = ${user}::uuid AND d.source = 'mail'`;
  if (!row) {
    const rows = await org.adminSql`SELECT id::text, user_id::text, source, scope, scope_key FROM harness_shared.documents WHERE workspace_id = ${WS}`;
    throw new Error(`canonical personal fixture missing: ${JSON.stringify({ user, rows })}`);
  }
  expect(row.authority.rules.length).toBeLessThanOrEqual(1);
  if (row.authority.rules.length) expect(row.authority.rules[0]!.level).toBe('participants');
  return { ...row, privacy: row.authority.rules.length ? { level: 'participants', readerSet: ['alice@example.test'] } : null,
    authorityEpoch: fingerprint({ workspace: WS, principal: user, role: 'operator', authority: row.authority }), readAtMs: Date.now() };
}

async function capture(caseId: string, refusal?: string) {
  const requestStartedAtMs = Date.now();
  const before = await canonical();
  const result = await dispatchProjectedTool(projected!, 'documents:search',
    { query: 'cobalt personal', legs: ['personal'], personalScopes: ['mail'], limit: 10 }, context(), {});
  const responseAtMs = Date.now();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  const response = result.result?.structuredContent as {
    legs: { personal: { allowed: boolean; refusal?: string; results?: number; grantedScopes?: string[] } };
    results: Array<Record<string, unknown>>; restrictedResults?: number;
  };
  const after = await canonical();
  expect(response.legs.personal.allowed).toBe(!refusal);
  if (refusal) {
    expect(response.legs.personal.refusal).toBe(refusal);
    expect(response.results).toEqual([]);
    expect(response.restrictedResults).toBeUndefined();
  } else {
    expect(response.legs.personal.grantedScopes).toEqual(['personal:mail']);
    expect(response.legs.personal.results).toBe(1);
    expect(response.results.map(r => r.id)).toEqual([after.id]);
    expect(response.results[0]!.privacy).toEqual(after.privacy);
  }
  const fields = response.results.flatMap(returned => FIELDS.map(fieldPath => {
    expect(returned.scope).toBe('personal');
    expect(returned.scopeKey).toBe('personal:mail');
    expect(returned.vectorRank).toBeNull();
    const policy = protocol.fields.find(f => f.id === `papercusp/documents:search/personal/${fieldPath}`)!.policy;
    const input = { returned: { entityRef: String(returned.id), fieldPath, valueFingerprint: fingerprint(returned[fieldPath]) },
      indexed: null, canonical: { entityRef: after.id, fieldPath, valueFingerprint: fingerprint(after[fieldPath]),
        sourceRevision: after.sourceRevision, authority: policy.authority, authorityEpoch: after.authorityEpoch, readAtMs: after.readAtMs },
      requestStartedAtMs, responseAtMs };
    expect(input.returned.valueFingerprint).toBe(input.canonical.valueFingerprint);
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
    expect(oracle.reasons).toContain('index witness unavailable');
    return { fieldPath, input, oracle };
  }));
  const receipt = { caseId, requestStartedAtMs, responseAtMs, canonicalBefore: before, canonicalAfter: after, response, fields };
  receipts.push(receipt);
  return receipt;
}

beforeAll(async () => {
  expect(sha(protocolBytes)).toBe('675e29f75f2fe8325af2dd79b20adc6f6ec87d8def5ec8dfa646df4e32b81f57');
  const paths = [...protocol.sourcePins.map(p => p.path), 'libs/generic/tooldef/src/dispatch-projected.ts',
    'libs/generic/tooldef/src/dispatch-stack.ts', 'libs/generic/tooldef/src/define-tool.ts',
    'libs/papercusp/libs/db/sql/1414-vault-mail-partition.sql'];
  pins = paths.map(path => ({ path, sha256: sha(readFileSync(new URL(`../../../../../${path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_PERSONAL_FRESHNESS_WITNESS_FILE) {
    for (const pin of protocol.sourcePins) expect(pins.find(p => p.path === pin.path)!.sha256, pin.path).toBe(pin.sha256);
  }
  org = await createOrgTestDb();
  const users = await org.adminSql<Array<{ id: string }>>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'p001-personal-' + org.dbName}, 'Personal fixture'), (${'p001-foreign-' + org.dbName}, 'Foreign fixture') RETURNING id::text`;
  user = users[0]!.id;
  foreignUser = users[1]!.id;
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_privacy_rules WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.personal_grants WHERE workspace_id = ${WS}`;
  await setPersonalVaultEnabled(org.adminSql, WS, user, true, 'fixture-owner');
  await setPersonalVaultEnabled(org.adminSql, WS, foreignUser, true, 'fixture-owner');
  await createPersonalGrant(org.adminSql, { workspaceId: WS, userId: user, principalType: 'agent-role',
    principalId: 'operator', scopes: ['mail'], grantedBy: 'fixture-owner' });
  const seeded = await seed(user, 1);
  expect(seeded.ids).toHaveLength(1);
  await seed(user, 2, 'gcal');
  await seed(foreignUser, 2);
  const current = await canonical();
  expect(current.title).toBe('Cobalt personal version 1');
  expect(current.authority.grants).toHaveLength(1);
});

afterAll(async () => {
  const cleanup = await org?.cleanupWithResult();
  for (const pin of pins) expect(sha(readFileSync(new URL(`../../../../../${pin.path}`, import.meta.url))), pin.path).toBe(pin.sha256);
  if (process.env.PAPERCUSP_PERSONAL_FRESHNESS_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_PERSONAL_FRESHNESS_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, scope: 'isolated actual personal dispatch and stored reader', protocolSha256: sha(protocolBytes),
      testSha256: sha(readFileSync(new URL(import.meta.url))), sourcePins: pins, database: org?.dbName, cleanup,
      declared: CASES, executed: [...executed], unexecuted: CASES.filter(c => !executed.has(c)), qualifiedFieldClaims: 0,
      receipts, limits: ['fixture provider imports', 'candidate/provider revisions absent', 'native lexical tracing unmeasured',
        'admin client injected: host authentication, RLS and full authority/runtime closure unmeasured',
        'sealed and other document legs unmeasured', 'oracle-input replay is not an enforcement bypass'] }, null, 2));
});

describe('P001 actual documents:search personal field projection', () => {
  it('compares stored fields and excludes competing foreign users and ungranted sources', async () => {
    await capture('projected-fields');
    executed.add('projected-fields');
  });
  it('observes an in-place personal update and detects a retained old title in the oracle', async () => {
    const before = await capture('content-update-before');
    await seed(user, 2);
    const after = await capture('content-update-after');
    expect(after.canonicalAfter.id).toBe(before.canonicalAfter.id);
    expect(after.canonicalAfter.sourceRevision).not.toBe(before.canonicalAfter.sourceRevision);
    const title = after.fields.find(f => f.fieldPath === 'title')!;
    const input = { ...title.input, returned: before.fields.find(f => f.fieldPath === 'title')!.input.returned };
    const policy = protocol.fields.find(f => f.id === 'papercusp/documents:search/personal/title')!.policy;
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle.status).toBe('stale');
    receipts.push({ caseId: 'oracle-replay-old-title', mutationScope: 'oracle-input only', input, oracle });
    executed.add('content-update');
  });
  it('refuses revoked or mismatched grants and a disabled vault without changing content revision', async () => {
    const before = await capture('grant-before');
    await org.adminSql`UPDATE harness_shared.personal_grants SET revoked_at = now() WHERE workspace_id = ${WS} AND user_id = ${user}::uuid`;
    const revoked = await capture('grant-revoked', 'no_live_grant');
    expect(revoked.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(revoked.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    await createPersonalGrant(org.adminSql, { workspaceId: WS, userId: user, principalType: 'agent-role',
      principalId: 'operator', scopes: ['gcal'], grantedBy: 'fixture-owner' });
    const narrowed = await capture('grant-other-scope', 'scope_not_granted');
    expect(narrowed.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    await setPersonalVaultEnabled(org.adminSql, WS, user, false, 'fixture-owner');
    const disabled = await capture('vault-disabled', 'vault_disabled');
    expect(disabled.canonicalAfter.authorityEpoch).not.toBe(narrowed.canonicalAfter.authorityEpoch);
    expect(disabled.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    executed.add('grant-transition');
  });
  it('projects changed privacy without changing the stored personal document revision', async () => {
    const before = await capture('privacy-before');
    await upsertPrivacyRule(org.adminSql, { workspaceId: WS, userId: user, matchKind: 'source', matchValue: 'mail',
      level: 'participants', actor: 'fixture-owner', authorityRef: null });
    const after = await capture('privacy-after');
    expect(after.canonicalAfter.sourceRevision).toBe(before.canonicalAfter.sourceRevision);
    expect(after.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    expect(after.response.restrictedResults).toBe(1);
    executed.add('privacy-transition');
  });
});
