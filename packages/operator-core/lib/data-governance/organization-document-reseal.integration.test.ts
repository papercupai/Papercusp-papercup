/**
 * DEK-rotation re-seal sweep against real Postgres (WI-6554700010012443 U5, plan
 * papercusp-enterprise-readiness-roadmap-2026-10-09#D-020, migration 1503).
 *
 * Acceptance under test:
 *  - after rotateDek, the sweep moves stale documents onto the new DEK: envelope version advances,
 *    blind_terms are re-derived under the new blind-index key, title/text stay '' and search still
 *    finds and decrypts the row;
 *  - a second sweep selects nothing (idempotent);
 *  - batchSize bounds a call and `more` reports that rows remain;
 *  - the write-back is a compare-and-swap: a row changed after the read is not overwritten;
 *  - plaintext workspaces and revoked organizations are never selected or touched.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { placeLegalHold, writeCorpusDocument } from '../data-sources/chat-retrieval-units';
import { searchPotDocuments } from '../data-sources/documents-corpus';
import { createTestKekProvider } from './kek-providers';
import { contentSealing, openDocument, sealDocuments } from './organization-content-sealing';
import { organizationKeyService, useOrganizationKekProviders } from './organization-key-registry';
import { blindToken, envelopeDekVersion, type KeyOperationContext } from './organization-keys';
import { compareAndSwapSealedDocument, resealStaleOrganizationDocuments, staleSealedDocuments } from './organization-document-reseal';

let org: OrgTestDb;
const WS = `reseal-ws-${randomUUID()}`;
const REVOKED_WS = `reseal-revoked-ws-${randomUUID()}`;
const PLAIN_WS = `reseal-plain-ws-${randomUUID()}`;
const POT = 'reseal-pot';
// Bare uuids: organization_key_custody.organization_id is uuid (customer_workspaces holds it as text).
const organizationId = randomUUID();
const revokedOrganizationId = randomUUID();
const kekRef = `kek-${randomUUID()}`;
const ctx: KeyOperationContext = { actor: { kind: 'system', id: 'reseal-test' }, purpose: 'document re-seal test', workspaceIds: [WS] };
const potRoute = { write: true as const, scope: 'pot' as const, source: 'slack', potSlug: POT };

async function hostedWorkspace(id: string, orgId: string) {
  // A hosted workspace's generated hosted_host_id references workspace_hosts(workspace_id, id),
  // which in turn references workspace_host_connections — so seed that chain first.
  await org.adminSql`
    INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref)
    VALUES (${`local-${id}`}, 'reseal-conn', 'gcp', 'reseal test', 'test:credential')`;
  await org.adminSql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region, size, image,
       disk_gib, network, desired_state, observed_state)
    VALUES (${`local-${id}`}, 'reseal-host', 'reseal host', 'reseal-conn', 'gcp', 'test-project',
            'us-central1', 'e2-standard-4', 'image-v1', 64, 'default', 'running', 'running')`;
  await org.adminSql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state,
       created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id)
    VALUES (${`local-${id}`}, ${id}, ${orgId}, 'reseal-host', 'reseal test workspace', 'active',
            'hosted-user', 'user-reseal', 'organization', 'billing-reseal')`;
}

async function write(workspaceId: string, dedupeKey: string, title: string, text: string) {
  await writeCorpusDocument(org.adminSql, workspaceId, potRoute, randomUUID(), null, { source: 'slack', kind: 'chat-thread', dedupeKey, title, text });
}

async function stored(workspaceId: string, dedupeKey: string) {
  const [row] = await org.adminSql<Array<{ id: string; title: string; text: string; sealed_content: Buffer | null; blind_terms: string[] | null }>>`
    SELECT id, title, text, sealed_content, blind_terms FROM harness_shared.documents
     WHERE workspace_id = ${workspaceId} AND dedupe_key = ${dedupeKey}`;
  return row!;
}

/** Only this file's rows: other suites may share the database. */
async function staleIds(): Promise<string[]> {
  const ids = new Set([(await stored(WS, 'a')).id, (await stored(WS, 'b')).id, (await stored(REVOKED_WS, 'r')).id]);
  return (await staleSealedDocuments(org.adminSql, 5_000)).filter((r) => ids.has(r.id)).map((r) => r.id);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  const kms = createTestKekProvider();
  kms.createKek(kekRef);
  useOrganizationKekProviders({ 'test-kms': kms });
  const keys = organizationKeyService(org.adminSql);
  await keys.provision(organizationId, { kekProvider: 'test-kms', kekRef }, ctx);
  await keys.provision(revokedOrganizationId, { kekProvider: 'test-kms', kekRef }, { ...ctx, workspaceIds: [REVOKED_WS] });
  await hostedWorkspace(WS, organizationId);
  await hostedWorkspace(REVOKED_WS, revokedOrganizationId);
  await write(WS, 'a', 'Board meeting', 'Quarterly revenue forecast for cobalt');
  await write(WS, 'b', 'Supplier review', 'Nickel contract renewal terms');
  await write(REVOKED_WS, 'r', 'Revoked org note', 'Lithium allocation');
  await write(PLAIN_WS, 'p', 'Plain note', 'Unsealed copper memo');
  await keys.rotateDek(organizationId, ctx);
  await keys.rotateDek(revokedOrganizationId, { ...ctx, workspaceIds: [REVOKED_WS] });
  await keys.revoke(revokedOrganizationId, { ...ctx, workspaceIds: [REVOKED_WS] });
});

afterAll(async () => {
  useOrganizationKekProviders(null);
  await org?.cleanup();
});

describe('organization document re-seal sweep (P-016b follow-up U5)', () => {
  it('writes sealed v1 rows and selects only the enabled organization after rotation', async () => {
    expect(envelopeDekVersion((await stored(WS, 'a')).sealed_content!)).toBe(1);
    expect((await stored(PLAIN_WS, 'p')).sealed_content).toBeNull();
    const ids = await staleIds();
    expect(ids.sort()).toEqual([(await stored(WS, 'a')).id, (await stored(WS, 'b')).id].sort());
  });

  it('refuses to overwrite a row that changed after it was read (compare-and-swap)', async () => {
    const row = await stored(WS, 'b');
    const ok = await compareAndSwapSealedDocument(org.adminSql, row.id, Buffer.from('not the stored blob'), {
      sealedContent: Buffer.from('replacement'),
      blindTerms: ['x'],
    });
    expect(ok).toBe(false);
    expect((await stored(WS, 'b')).sealed_content!.equals(row.sealed_content!)).toBe(true);
  });

  it('re-seals one bounded batch at a time, re-deriving blind terms under the new key', async () => {
    const before = await stored(WS, 'a');
    let total = 0;
    for (let i = 0; i < 20 && (await staleIds()).length > 0; i += 1) {
      const result = await resealStaleOrganizationDocuments(org.adminSql, { batchSize: 1 });
      expect(result.examined).toBeLessThanOrEqual(1);
      if (result.examined === 1) expect(result.more).toBe(true);
      total += result.resealed;
    }
    expect(total).toBeGreaterThanOrEqual(2);
    expect(await staleIds()).toEqual([]);

    const after = await stored(WS, 'a');
    expect(after.title).toBe('');
    expect(after.text).toBe('');
    expect(envelopeDekVersion(after.sealed_content!)).toBe(2);
    expect(after.sealed_content!.includes(Buffer.from('cobalt'))).toBe(false);
    expect(after.blind_terms).not.toEqual(before.blind_terms);
    const sealing = (await contentSealing(org.adminSql, WS))!;
    expect(sealing.keys.active.dekVersion).toBe(2);
    expect(after.blind_terms).toContain(blindToken(sealing.keys.active.key, 'cobalt'));

    const hits = await searchPotDocuments(org.adminSql, { workspaceId: WS, potSlug: POT, principalUserId: randomUUID(), agentOwnerId: null, query: 'cobalt' });
    expect(JSON.stringify(hits)).toContain('Board meeting');
  });

  it('is idempotent and leaves revoked and plaintext rows untouched', async () => {
    const revoked = await stored(REVOKED_WS, 'r');
    const plain = await stored(PLAIN_WS, 'p');
    await resealStaleOrganizationDocuments(org.adminSql, { batchSize: 5_000 });
    expect(await staleIds()).toEqual([]);
    expect((await stored(REVOKED_WS, 'r')).sealed_content!.equals(revoked.sealed_content!)).toBe(true);
    expect(envelopeDekVersion(revoked.sealed_content!)).toBe(1);
    expect((await stored(PLAIN_WS, 'p')).text).toBe(plain.text);
  });

  it('re-seals a held non-chat document without losing its readable content or hold', async () => {
    const [source] = await org.adminSql<{ id: string }[]>`INSERT INTO harness_shared.data_sources
      (workspace_id, kind, permission_mapping, credential_ref)
      VALUES (${WS}, 'github', ${org.adminSql.json({ mode: 'source-acl' })}, 'vault://held-reseal') RETURNING id`;
    const sealing = (await contentSealing(org.adminSql, WS))!;
    const [sealed] = await sealDocuments(org.adminSql, sealing, [{ title: 'Held board minutes', text: 'Cobalt decision preserved' }]);
    const id = randomUUID();
    await org.adminSql`INSERT INTO harness_shared.documents
      (id, workspace_id, scope, pot_slug, source, kind, dedupe_key, source_id, title, text, sealed_content, blind_terms)
      VALUES (${id}::uuid, ${WS}, 'pot', ${POT}, 'github', 'issue', ${id}, ${source!.id}::uuid, '', '',
              ${sealed!.sealedContent}, ${sealed!.blindTerms as string[]}::text[])`;
    const held = await placeLegalHold(org.adminSql, WS, { dataSourceId: source!.id, reason: 'preserve minutes', placedBy: 'reseal-test' });
    const beforeVersion = envelopeDekVersion(sealed!.sealedContent)!;
    await organizationKeyService(org.adminSql).rotateDek(organizationId, ctx);
    const result = await resealStaleOrganizationDocuments(org.adminSql, { batchSize: 5_000 });
    expect(result.failures).toEqual([]);
    const [after] = await org.adminSql`SELECT sealed_content, title, text FROM harness_shared.documents WHERE id = ${id}::uuid`;
    expect(envelopeDekVersion(after!.sealed_content)).toBe(beforeVersion + 1);
    expect(after).toMatchObject({ title: '', text: '' });
    const current = (await contentSealing(org.adminSql, WS))!;
    expect(await openDocument(current, after!.sealed_content)).toMatchObject({ title: 'Held board minutes', text: 'Cobalt decision preserved' });
    // Prove this exercises an enforced hold, rather than the chat-derived exemption.
    await expect(org.adminSql`DELETE FROM harness_shared.documents WHERE id = ${id}::uuid`).rejects.toMatchObject({ code: '23514' });
    const [hold] = await org.adminSql`SELECT released_at FROM harness_shared.data_source_legal_holds WHERE id = ${held.id}::uuid`;
    expect(hold!.released_at).toBeNull();
  });
});

export type { Sql };
