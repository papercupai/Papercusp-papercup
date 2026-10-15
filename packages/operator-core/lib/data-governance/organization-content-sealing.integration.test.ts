/**
 * Organization document sealing against real Postgres (WI-6554700010012443 U2, plan
 * papercusp-enterprise-readiness-roadmap-2026-10-09#D-020, migration 1503).
 *
 * Acceptance under test:
 *  - a pot or organization document written for an organization with key custody stores no plaintext:
 *    title/text are empty, sealed_content does not contain the text, and blind_terms are keyed tokens;
 *  - a workspace with no organization custody still stores plaintext (unchanged behaviour);
 *  - search finds sealed rows through the blind index, applies the exact websearch match after
 *    decryption (a negated term excludes the row), and returns the decrypted title and snippet;
 *  - after DEK rotation, rows sealed under the old version stay findable and new rows seal under the new one;
 *  - once the key is shredded, both writes and searches fail closed with OrganizationKeyUnavailableError.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { writeCorpusDocument } from '../data-sources/chat-retrieval-units';
import { searchPotDocuments, upsertOrganizationDocuments, upsertPermissionList } from '../data-sources/documents-corpus';
import { createTestKekProvider } from './kek-providers';
import { organizationKeyService, useOrganizationKekProviders } from './organization-key-registry';
import { OrganizationKeyUnavailableError, envelopeDekVersion, type KeyOperationContext } from './organization-keys';

let org: OrgTestDb;
const WS = `sealing-ws-${randomUUID()}`;
const PLAIN_WS = `sealing-plain-ws-${randomUUID()}`;
const POT = 'sealing-pot';
const organizationId = randomUUID();
const kekRef = `kek-${randomUUID()}`;
const ctx: KeyOperationContext = { actor: { kind: 'system', id: 'sealing-test' }, purpose: 'document sealing test', workspaceIds: [WS] };
const potRoute = { write: true as const, scope: 'pot' as const, source: 'slack', potSlug: POT };

/** Runs `fn` as a hosted runtime of the organization (app.organization_id set for the transaction). */
function asOrganization<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return org.adminSql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

async function writePot(sql: Sql, workspaceId: string, dedupeKey: string, title: string, text: string) {
  await writeCorpusDocument(sql, workspaceId, potRoute, randomUUID(), null, { source: 'slack', kind: 'chat-thread', dedupeKey, title, text });
}

async function stored(workspaceId: string, dedupeKey: string) {
  const [row] = await org.adminSql<Array<{ title: string; text: string; sealed_content: Buffer | null; blind_terms: string[] | null }>>`
    SELECT title, text, sealed_content, blind_terms FROM harness_shared.documents
     WHERE workspace_id = ${workspaceId} AND dedupe_key = ${dedupeKey}`;
  return row!;
}

function search(sql: Sql, query: string) {
  return searchPotDocuments(sql, { workspaceId: WS, potSlug: POT, principalUserId: randomUUID(), agentOwnerId: null, query });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const kms = createTestKekProvider();
  kms.createKek(kekRef);
  useOrganizationKekProviders({ 'test-kms': kms });
  await organizationKeyService(org.adminSql).provision(organizationId, { kekProvider: 'test-kms', kekRef }, ctx);
});

afterAll(async () => {
  useOrganizationKekProviders(null);
  await org?.cleanup();
});

describe('organization document sealing (P-016b follow-up U2)', () => {
  it('seals a pot document and stores no plaintext', async () => {
    await asOrganization((tx) => writePot(tx, WS, 'd1', 'Board meeting', 'Quarterly revenue forecast for cobalt'));
    const row = await stored(WS, 'd1');
    expect(row.title).toBe('');
    expect(row.text).toBe('');
    expect(envelopeDekVersion(row.sealed_content!)).toBe(1);
    expect(row.sealed_content!.includes(Buffer.from('cobalt'))).toBe(false);
    expect(row.blind_terms!.length).toBeGreaterThan(0);
    expect(row.blind_terms!.some((t) => ['cobalt', 'revenu', 'board'].includes(t))).toBe(false);
  });

  it('keeps plaintext for a workspace whose organization has no key custody', async () => {
    await writePot(org.adminSql, PLAIN_WS, 'p1', 'Plain', 'cobalt plaintext');
    const row = await stored(PLAIN_WS, 'p1');
    expect(row).toMatchObject({ title: 'Plain', text: 'cobalt plaintext', sealed_content: null, blind_terms: null });
  });

  it('seals an organization-scope document too', async () => {
    await asOrganization(async (tx) => {
      const list = await upsertPermissionList(tx, WS, { source: 'slack', sourceRef: 'C1' });
      await upsertOrganizationDocuments(tx, WS, list.id, [{ source: 'slack', kind: 'chat-thread', dedupeKey: 'o1', title: 'Org', text: 'cobalt org' }]);
    });
    const row = await stored(WS, 'o1');
    expect(row.text).toBe('');
    expect(row.sealed_content).not.toBeNull();
  });

  it('finds sealed rows by blind index and applies the exact match after decryption', async () => {
    const hit = await asOrganization((tx) => search(tx, 'cobalt revenue'));
    expect(hit.results.map((r) => r.title)).toEqual(['Board meeting']);
    expect(hit.results[0]!.snippet).toContain('cobalt');
    expect(hit.results[0]!.tsRank).toBeGreaterThan(0);
    expect((await asOrganization((tx) => search(tx, 'cobalt -forecast'))).results).toEqual([]);
    expect((await asOrganization((tx) => search(tx, 'zebra'))).results).toEqual([]);
  });

  it('keeps old rows findable after DEK rotation and seals new rows under the new version', async () => {
    await organizationKeyService(org.adminSql).rotateDek(organizationId, ctx);
    await asOrganization((tx) => writePot(tx, WS, 'd2', 'Cobalt roadmap', 'cobalt launch plan'));
    expect(envelopeDekVersion((await stored(WS, 'd2')).sealed_content!)).toBe(2);
    const hit = await asOrganization((tx) => search(tx, 'cobalt'));
    expect(hit.results.map((r) => r.title).sort()).toEqual(['Board meeting', 'Cobalt roadmap']);
  });

  it('fails closed on write and search once the key is shredded', async () => {
    await organizationKeyService(org.adminSql).shred(organizationId, { ...ctx, confirmOrganizationId: organizationId });
    const writeErr = await asOrganization((tx) => writePot(tx, WS, 'd3', 'x', 'cobalt')).then(() => null, (e: unknown) => e);
    expect(writeErr).toBeInstanceOf(OrganizationKeyUnavailableError);
    const searchErr = await asOrganization((tx) => search(tx, 'cobalt')).then(() => null, (e: unknown) => e);
    expect(searchErr).toBeInstanceOf(OrganizationKeyUnavailableError);
  });
});
