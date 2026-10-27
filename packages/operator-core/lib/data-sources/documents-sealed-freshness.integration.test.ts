/** P001 bounded sealed-reader witness; stored tuple identity is not provider currentness. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSearchFieldFreshness, type SearchFieldFreshnessPolicy } from '@papercusp/search-core';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { writeCorpusDocument } from './chat-retrieval-units';
import { searchPotDocuments } from './documents-corpus';
import { createTestKekProvider } from '../data-governance/kek-providers';
import { organizationKeyService, useOrganizationKekProviders } from '../data-governance/organization-key-registry';
import { envelopeDekVersion, OrganizationKeyUnavailableError, type KeyOperationContext } from '../data-governance/organization-keys';
import { contentSealing, openDocument } from '../data-governance/organization-content-sealing';

const WS = 'p001-sealed-freshness-fixture';
const POT = 'p001-sealed-eligible';
const FIELDS = ['title', 'snippet', 'occurredAt', 'privacy'] as const;
const CASES = ['stored-fields', 'content-update', 'candidate-change', 'key-transition'] as const;
const protocolBytes = readFileSync(new URL('../../../../docs/evidence/shared-search-restart-papercusp-2026-10-22-documents-freshness-protocol-20261025.json', import.meta.url));
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
let organizationId: string;
let keyContext: KeyOperationContext;
let pins: Array<{ path: string; sha256: string }> = [];

function asOrganization<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return org.adminSql.begin(async tx => {
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

async function seed(version: number, key = 'stable', potSlug = POT, text?: string) {
  await asOrganization(tx => writeCorpusDocument(tx, WS,
    { write: true, scope: 'pot', source: 'slack', potSlug }, randomUUID(), null,
    { source: 'slack', kind: 'chat-thread', dedupeKey: key, title: `Cobalt sealed version ${version}`,
      text: text ?? `Cobalt sealed body ${version}. ${'Cobalt retained sentence. '.repeat(40)}`,
      occurredAt: `2026-10-0${version}T12:00:00Z` }));
}

/** Separate canonical transaction and opening; no search output enters this read. */
async function canonical() {
  return asOrganization(async tx => {
    const sealing = await contentSealing(tx, WS);
    if (!sealing) throw new Error('sealed fixture requires organization custody');
    const stored = await tx<Array<{ id: string; title: string; text: string; occurredAt: string | null;
      sourceRevision: string; blob: Buffer; blindTerms: string[] }>>`
      SELECT id::text, title, text, occurred_at::text AS "occurredAt", xmin::text AS "sourceRevision",
        sealed_content AS blob, blind_terms AS "blindTerms"
      FROM harness_shared.documents WHERE workspace_id = ${WS} AND pot_slug = ${POT} ORDER BY id`;
    const rows = [];
    for (const row of stored) {
      expect(row.title).toBe('');
      expect(row.text).toBe('');
      expect(row.blindTerms.length).toBeGreaterThan(0);
      const opened = await openDocument(sealing, row.blob);
      rows.push({ id: row.id, title: opened.title, snippet: opened.text.slice(0, 600),
        occurredAt: row.occurredAt, privacy: null, sourceRevision: row.sourceRevision,
        envelopeVersion: envelopeDekVersion(row.blob), blobSha256: sha(row.blob), blindTerms: row.blindTerms });
    }
    return { rows, authorityEpoch: fingerprint({ workspace: WS, potSlug: POT, principal: user, organizationId,
      activeDekVersion: sealing.keys.active.dekVersion }), readAtMs: Date.now() };
  });
}

async function capture(caseId: string, query = 'cobalt sealed') {
  const requestStartedAtMs = Date.now();
  const before = await canonical();
  const response = await asOrganization(tx => searchPotDocuments(tx,
    { workspaceId: WS, potSlug: POT, principalUserId: user, agentOwnerId: null, query, limit: 10 }));
  const responseAtMs = Date.now();
  const after = await canonical();
  const fields = response.results.flatMap(returned => FIELDS.map(fieldPath => {
    const row = after.rows.find(r => r.id === returned.id);
    if (!row) throw new Error('returned entity absent from canonical sealed population');
    const policy = protocol.fields.find(f => f.id === `papercusp/documents:search/pot/${fieldPath}`)!.policy;
    const input = { returned: { entityRef: returned.id, fieldPath, valueFingerprint: fingerprint(returned[fieldPath]) },
      indexed: null, canonical: { entityRef: row.id, fieldPath, valueFingerprint: fingerprint(row[fieldPath]),
        sourceRevision: row.sourceRevision, authority: policy.authority, authorityEpoch: after.authorityEpoch,
        readAtMs: after.readAtMs }, requestStartedAtMs, responseAtMs };
    expect(input.returned.valueFingerprint).toBe(input.canonical.valueFingerprint);
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle).toMatchObject({ status: 'unknown', action: 'degrade' });
    expect(oracle.reasons).toContain('index witness unavailable');
    return { fieldPath, input, oracle };
  }));
  const receipt = { caseId, query, requestStartedAtMs, responseAtMs, canonicalBefore: before, canonicalAfter: after, response, fields };
  receipts.push(receipt);
  return receipt;
}

beforeAll(async () => {
  expect(sha(protocolBytes)).toBe('675e29f75f2fe8325af2dd79b20adc6f6ec87d8def5ec8dfa646df4e32b81f57');
  const paths = [...protocol.sourcePins.map(p => p.path),
    'packages/operator-core/lib/data-sources/chat-retrieval-units.ts',
    'packages/operator-core/lib/data-governance/organization-content-sealing.ts',
    'packages/operator-core/lib/data-governance/organization-key-registry.ts',
    'packages/operator-core/lib/data-governance/organization-keys.ts',
    'packages/operator-core/lib/data-governance/kek-providers.ts',
    'packages/operator-core/lib/search/lexical/rank.ts'];
  pins = paths.map(path => ({ path, sha256: sha(readFileSync(new URL(`../../../../${path}`, import.meta.url))) }));
  if (process.env.PAPERCUSP_SEALED_FRESHNESS_WITNESS_FILE) {
    for (const pin of protocol.sourcePins) expect(pins.find(p => p.path === pin.path)!.sha256, pin.path).toBe(pin.sha256);
  }
  org = await createOrgTestDb();
  const [row] = await org.adminSql<Array<{ id: string }>>`INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'p001-sealed-' + org.dbName}, 'Sealed fixture') RETURNING id::text`;
  user = row!.id;
});

beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  organizationId = randomUUID();
  const kekRef = `p001-sealed-${randomUUID()}`;
  const kms = createTestKekProvider();
  kms.createKek(kekRef);
  useOrganizationKekProviders({ 'test-kms': kms });
  keyContext = { actor: { kind: 'system', id: 'p001-sealed-fixture' }, purpose: 'isolated sealed witness', workspaceIds: [WS] };
  await organizationKeyService(org.adminSql).provision(organizationId, { kekProvider: 'test-kms', kekRef }, keyContext);
  await seed(1);
  await seed(2, 'foreign', 'p001-sealed-foreign');
});

afterAll(async () => {
  useOrganizationKekProviders(null);
  const cleanup = await org?.cleanupWithResult();
  for (const pin of pins) expect(sha(readFileSync(new URL(`../../../../${pin.path}`, import.meta.url))), pin.path).toBe(pin.sha256);
  if (process.env.PAPERCUSP_SEALED_FRESHNESS_WITNESS_FILE) writeFileSync(process.env.PAPERCUSP_SEALED_FRESHNESS_WITNESS_FILE,
    JSON.stringify({ schemaVersion: 1, scope: 'isolated actual sealed pot reader', protocolSha256: sha(protocolBytes),
      testSha256: sha(readFileSync(new URL(import.meta.url))), sourcePins: pins, database: org?.dbName, cleanup,
      declared: CASES, executed: [...executed], unexecuted: CASES.filter(c => !executed.has(c)),
      qualifiedFieldClaims: 0, receipts, limits: ['synthetic provider imports and test KMS',
        'candidate/provider revisions absent; native lexical tracing unmeasured',
        'admin client injected: host authentication, RLS and full authority/runtime closure unmeasured',
        'organization sealed leg and live provider unmeasured', 'oracle replay is not an enforcement bypass'] }, null, 2));
});

describe('P001 actual sealed pot reader fields and candidate visibility', () => {
  it('opens stored fields independently and excludes foreign-pot and negated-term candidates', async () => {
    const hit = await capture('stored-fields');
    expect(hit.response.results.map(r => r.id)).toEqual(hit.canonicalAfter.rows.map(r => r.id));
    expect(hit.response.results[0]!.tsRank).toBeGreaterThan(0);
    expect((await capture('negative-query', 'cobalt -retained')).response.results).toEqual([]);
    executed.add('stored-fields');
  });
  it('observes an in-place sealed update and rejects the old title in the freshness oracle', async () => {
    const before = await capture('update-before');
    await seed(2);
    const after = await capture('update-after');
    expect(after.response.results[0]!.id).toBe(before.response.results[0]!.id);
    expect(after.canonicalAfter.rows[0]!.sourceRevision).not.toBe(before.canonicalAfter.rows[0]!.sourceRevision);
    const title = after.fields.find(f => f.fieldPath === 'title')!;
    const input = { ...title.input, returned: before.fields.find(f => f.fieldPath === 'title')!.input.returned };
    const policy = protocol.fields.find(f => f.id === 'papercusp/documents:search/pot/title')!.policy;
    const oracle = assertSearchFieldFreshness(policy, input);
    expect(oracle.status).toBe('stale');
    receipts.push({ caseId: 'oracle-replay-old-title', mutationScope: 'oracle-input only', input, oracle });
    executed.add('content-update');
  });
  it('returns a newly eligible sealed match and removes it after its content stops matching', async () => {
    const before = await capture('candidate-before');
    await seed(2, 'new-match');
    const added = await capture('candidate-added');
    expect(added.response.results.map(r => r.id).sort()).toEqual(added.canonicalAfter.rows.map(r => r.id).sort());
    expect(added.response.results).toHaveLength(before.response.results.length + 1);
    // Replace both sealed fields through the real writer so the query stops matching.
    await asOrganization(tx => writeCorpusDocument(tx, WS,
      { write: true, scope: 'pot', source: 'slack', potSlug: POT }, randomUUID(), null,
      { source: 'slack', kind: 'chat-thread', dedupeKey: 'new-match', title: 'Zebra', text: 'Unrelated content.' }));
    const removed = await capture('candidate-removed');
    expect(removed.response.results.map(r => r.id)).toEqual(before.response.results.map(r => r.id));
    executed.add('candidate-change');
  });
  it('reads both DEK versions after rotation and fails closed after fixture key destruction', async () => {
    const before = await capture('rotation-before');
    await organizationKeyService(org.adminSql).rotateDek(organizationId, keyContext);
    await seed(2, 'new-key-match');
    const after = await capture('rotation-after');
    expect(after.response.results).toHaveLength(2);
    expect(after.canonicalAfter.rows.map(r => r.envelopeVersion).sort()).toEqual([1, 2]);
    expect(after.canonicalAfter.authorityEpoch).not.toBe(before.canonicalAfter.authorityEpoch);
    await organizationKeyService(org.adminSql).shred(organizationId, { ...keyContext, confirmOrganizationId: organizationId });
    const error = await asOrganization(tx => searchPotDocuments(tx,
      { workspaceId: WS, potSlug: POT, principalUserId: user, agentOwnerId: null, query: 'cobalt sealed' }))
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OrganizationKeyUnavailableError);
    receipts.push({ caseId: 'key-destroyed', returnedProtectedResults: false, errorName: (error as Error).name });
    executed.add('key-transition');
  });
});
