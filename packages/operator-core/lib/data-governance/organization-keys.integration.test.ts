/**
 * Organization key custody against real Postgres (plan papercusp-enterprise-readiness-roadmap-2026-10-09
 * P-016b, WI-6554700010012353, design #D-020).
 *
 * Acceptance under test:
 *  - an organization's data is sealed under its own DEK, and the envelope binds organization, DEK version
 *    and scope (content, embedding, telemetry, backup): a blob opened under another organization or scope fails;
 *  - DEK rotation moves new writes to the next version, old blobs still open, and the sweep re-seals only
 *    the stale ones;
 *  - KEK rotation re-wraps every live DEK, so the old KEK can be destroyed without losing data;
 *  - revocation fails closed with a typed error and evicts the cached DEK and custody row in this process;
 *    other processes are bounded by the cache TTL, which the receipt states as a limitation;
 *  - a KEK disabled in the KMS is detected, revokes custody, and recovery works only once the KMS re-enables it;
 *  - shredding is confirmed, irreversible, and the schema refuses to undo it;
 *  - every lifecycle event writes one receipt to papercusp_auth.organization_audit_events with
 *    metadata.keyLifecycle and no stores, and the writer refuses mixed key/data receipts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { placeLegalHold, releaseLegalHold } from '../data-sources/chat-retrieval-units';
import { createTestKekProvider, type TestKekProvider } from './kek-providers';
import {
  OrganizationKeyUnavailableError,
  OrganizationKeyShredRefusedError,
  SEALED_SCOPES,
  createOrganizationKeyService,
  envelopeDekVersion,
  type KeyOperationContext,
  type OrganizationKeyUnavailableCode,
} from './organization-keys';
import { holdConflicts, writeOrganizationDataReceipt, type KeyLifecycleRecord } from './organization-data-receipts';
import { organizationBackupRetentionDecision } from './organization-backup-sealing';

let org: OrgTestDb;
const WS = 'org-keys-test';
const actor = { kind: 'system' as const, id: 'org-keys-test' };
const ctx: KeyOperationContext = { actor, purpose: 'organization key lifecycle test', workspaceIds: [WS] };

function service(kms: TestKekProvider, opts: { cacheTtlMs?: number; now?: () => number } = {}) {
  return createOrganizationKeyService({ sql: org.adminSql, providers: { 'test-kms': kms }, ...opts });
}

/** A fresh organization with custody provisioned under `kekRef` in `kms`. */
async function provisioned(kms: TestKekProvider, kekRef = `kek-${randomUUID()}`) {
  kms.createKek(kekRef);
  const organizationId = randomUUID();
  const out = await service(kms).provision(organizationId, { kekProvider: 'test-kms', kekRef }, ctx);
  return { organizationId, kekRef, receiptId: out.receiptId };
}

async function keyError(p: Promise<unknown>, code: OrganizationKeyUnavailableCode): Promise<OrganizationKeyUnavailableError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OrganizationKeyUnavailableError);
  expect((err as OrganizationKeyUnavailableError).code).toBe(code);
  return err as OrganizationKeyUnavailableError;
}

async function receiptRow(id: string) {
  const [row] = await org.adminSql<Array<{ action: string; actor_kind: string; organization_id: string; metadata: Record<string, any> }>>`
    SELECT action, actor_kind, organization_id::text AS organization_id, metadata
      FROM papercusp_auth.organization_audit_events WHERE id = ${id}::uuid`;
  return row!;
}

async function receiptActions(organizationId: string): Promise<string[]> {
  const rows = await org.adminSql<{ action: string }[]>`
    SELECT action FROM papercusp_auth.organization_audit_events WHERE organization_id = ${organizationId}::uuid`;
  return rows.map((r) => r.action).sort();
}

const text = (s: string) => Buffer.from(s, 'utf8');

beforeAll(async () => {
  org = await createOrgTestDb();
});

afterAll(async () => {
  await org?.cleanup();
});

describe('organization key custody (P-016b)', () => {
  it('refuses and audits shred for an omitted owned workspace, retaining backup keys until hold release', async () => {
    const kms = createTestKekProvider();
    const { organizationId } = await provisioned(kms);
    const workspaceId = `held-key-${randomUUID()}`;
    const controlWorkspaceId = `control-${workspaceId}`;
    await org.adminSql`INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref)
      VALUES (${controlWorkspaceId}, 'conn', 'gcp', 'key hold test', 'test:credential')`;
    await org.adminSql`INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
      VALUES (${controlWorkspaceId}, 'host', 'key hold test', 'conn', 'gcp', 'test-project', 'us-central1', 'e2-standard-4', 'image-v1', 64, 'default', 'running', 'running')`;
    await org.adminSql`INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state,
       created_by_principal_kind, created_by_principal_id, billing_owner_kind, billing_owner_id)
      VALUES (${controlWorkspaceId}, ${workspaceId}, ${organizationId}, 'host', 'key hold test', 'active',
              'hosted-user', 'key-test', 'organization', 'key-test')`;
    const [source] = await org.adminSql<{ id: string }[]>`INSERT INTO harness_shared.data_sources
      (workspace_id, kind, permission_mapping, credential_ref)
      VALUES (${workspaceId}, 'github', ${org.adminSql.json({ mode: 'source-acl' })}, 'vault://key-hold') RETURNING id`;
    const held = await placeLegalHold(org.adminSql, workspaceId, {
      dataSourceId: source!.id, reason: 'preserve historical backup', placedBy: actor.id,
    });
    const svc = service(kms);
    const backup = await svc.encrypt(organizationId, 'backup', text('only historical copy'));
    // Neither the hosted control id nor an empty caller scope may hide the customer's held slug.
    for (const workspaceIds of [[controlWorkspaceId], []]) {
      const error = await svc.shred(organizationId, { ...ctx, workspaceIds, confirmOrganizationId: organizationId }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OrganizationKeyShredRefusedError);
      expect(error).toMatchObject({ code: 'legal-hold-active', holdIds: [held.id] });
      expect(await receiptRow((error as OrganizationKeyShredRefusedError).auditEventId)).toMatchObject({
        action: 'organization.keys.shred_refused', actor_kind: 'system', organization_id: organizationId,
        metadata: { code: 'legal-hold-active', holds: [{ holdId: held.id, workspaceId, dataSourceId: source!.id }] },
      });
    }
    const [custody] = await org.adminSql`SELECT state FROM harness_shared.organization_key_custody WHERE organization_id = ${organizationId}::uuid`;
    expect(custody!.state).toBe('enabled');
    const deks = await org.adminSql`SELECT state, wrapped_dek FROM harness_shared.organization_data_keys WHERE organization_id = ${organizationId}::uuid`;
    expect(deks.every((d) => d.state !== 'shredded' && d.wrapped_dek !== null)).toBe(true);
    expect((await service(kms).decrypt(organizationId, 'backup', backup)).toString()).toBe('only historical copy');
    const scope = { workspaceIds: [workspaceId] };
    expect(organizationBackupRetentionDecision(scope, await holdConflicts(org.adminSql, scope.workspaceIds)).prunable).toBe(false);
    await releaseLegalHold(org.adminSql, workspaceId, { id: held.id, releasedBy: actor.id });
    expect(organizationBackupRetentionDecision(scope, await holdConflicts(org.adminSql, scope.workspaceIds)).prunable).toBe(true);
    await svc.shred(organizationId, { ...ctx, workspaceIds: [], confirmOrganizationId: organizationId });
    await keyError(service(kms).decrypt(organizationId, 'backup', backup), 'organization-key-shredded');
  });

  it('provisions custody, seals every scope, and writes a provisioning receipt', async () => {
    const kms = createTestKekProvider();
    const { organizationId, kekRef, receiptId } = await provisioned(kms);
    const svc = service(kms);
    for (const scope of SEALED_SCOPES) {
      const blob = await svc.encrypt(organizationId, scope, text(`${scope} payload`));
      expect(envelopeDekVersion(blob)).toBe(1);
      expect(blob.includes(text(`${scope} payload`))).toBe(false);
      expect((await svc.decrypt(organizationId, scope, blob)).toString('utf8')).toBe(`${scope} payload`);
    }

    const [custody] = await org.adminSql<Array<{ state: string; kek_ref: string; kek_generation: number; active_dek_version: number }>>`
      SELECT state, kek_ref, kek_generation, active_dek_version FROM harness_shared.organization_key_custody
       WHERE organization_id = ${organizationId}::uuid`;
    expect(custody).toMatchObject({ state: 'enabled', kek_ref: kekRef, kek_generation: 1, active_dek_version: 1 });

    const receipt = await receiptRow(receiptId);
    expect(receipt.action).toBe('organization.keys.provisioning');
    expect(receipt.actor_kind).toBe('system');
    expect(receipt.organization_id).toBe(organizationId);
    expect(receipt.metadata.populationSize).toBe(0);
    expect(receipt.metadata.stores).toEqual([]);
    expect(receipt.metadata.keyLifecycle).toMatchObject({
      event: 'provisioned', kekProvider: 'test-kms', kekRef, kekGeneration: 1,
      activeDekVersion: 1, dekVersions: [1], custodyState: 'enabled', kmsState: 'enabled',
    });
  });

  it('refuses an unprovisioned organization', async () => {
    const svc = service(createTestKekProvider());
    await keyError(svc.encrypt(randomUUID(), 'content', text('x')), 'organization-key-unprovisioned');
  });

  it('binds the envelope to its organization and scope', async () => {
    const kms = createTestKekProvider();
    const a = await provisioned(kms);
    const b = await provisioned(kms);
    const svc = service(kms);
    const blob = await svc.encrypt(a.organizationId, 'content', text('organization A content'));

    await keyError(svc.decrypt(b.organizationId, 'content', blob), 'envelope-auth-failed');
    await keyError(svc.decrypt(a.organizationId, 'embedding', blob), 'envelope-auth-failed');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0x01;
    await keyError(svc.decrypt(a.organizationId, 'content', tampered), 'envelope-auth-failed');
    await keyError(svc.decrypt(a.organizationId, 'content', text('not an envelope')), 'envelope-malformed');
    expect((await svc.decrypt(a.organizationId, 'content', blob)).toString('utf8')).toBe('organization A content');
  });

  it('rotates the DEK: new writes use the next version, old blobs open, the sweep re-seals only stale rows', async () => {
    const kms = createTestKekProvider();
    const { organizationId, kekRef } = await provisioned(kms);
    const svc = service(kms);
    const v1 = await svc.encrypt(organizationId, 'telemetry', text('written under v1'));

    const rotated = await svc.rotateDek(organizationId, ctx);
    expect(rotated.activeDekVersion).toBe(2);
    const v2 = await svc.encrypt(organizationId, 'telemetry', text('written under v2'));
    expect(envelopeDekVersion(v2)).toBe(2);
    expect((await svc.decrypt(organizationId, 'telemetry', v1)).toString('utf8')).toBe('written under v1');

    const deks = await org.adminSql<Array<{ dek_version: number; state: string }>>`
      SELECT dek_version, state FROM harness_shared.organization_data_keys
       WHERE organization_id = ${organizationId}::uuid ORDER BY dek_version`;
    expect(deks).toEqual([{ dek_version: 1, state: 'decrypt-only' }, { dek_version: 2, state: 'active' }]);

    const written = new Map<string, Buffer>();
    const sweep = await svc.sweep(organizationId, 'telemetry', [{ id: 'r1', blob: v1 }, { id: 'r2', blob: v2 }], async (id, blob) => {
      written.set(id, blob);
    });
    expect(sweep).toEqual({ examined: 2, reencrypted: 1, alreadyCurrent: 1 });
    expect([...written.keys()]).toEqual(['r1']);
    expect(envelopeDekVersion(written.get('r1')!)).toBe(2);
    expect((await svc.decrypt(organizationId, 'telemetry', written.get('r1')!)).toString('utf8')).toBe('written under v1');

    expect((await receiptRow(rotated.receiptId)).metadata.keyLifecycle).toMatchObject({
      event: 'dek-rotated', kekRef, activeDekVersion: 2, dekVersions: [2], custodyState: 'enabled',
    });
  });

  it('rotates the KEK: every live DEK is re-wrapped, so the old KEK can be destroyed', async () => {
    const kms = createTestKekProvider();
    const { organizationId, kekRef: k1 } = await provisioned(kms);
    const svc = service(kms);
    const v1 = await svc.encrypt(organizationId, 'backup', text('backup under DEK v1'));
    await svc.rotateDek(organizationId, ctx);
    const v2 = await svc.encrypt(organizationId, 'backup', text('backup under DEK v2'));

    const k2 = `kek-${randomUUID()}`;
    kms.createKek(k2);
    const rotated = await svc.rotateKek(organizationId, { kekProvider: 'test-kms', kekRef: k2 }, ctx);
    expect(rotated.kekGeneration).toBe(2);
    expect(rotated.rewrappedDekVersions).toEqual([1, 2]);
    kms.destroyKek(k1);

    const rows = await org.adminSql<Array<{ kek_ref: string; kek_generation: number }>>`
      SELECT kek_ref, kek_generation FROM harness_shared.organization_data_keys
       WHERE organization_id = ${organizationId}::uuid ORDER BY dek_version`;
    expect(rows).toEqual([{ kek_ref: k2, kek_generation: 2 }, { kek_ref: k2, kek_generation: 2 }]);

    // A cold service has no cached DEK, so these reads unwrap under k2 only.
    const cold = service(kms);
    expect((await cold.decrypt(organizationId, 'backup', v1)).toString('utf8')).toBe('backup under DEK v1');
    expect((await cold.decrypt(organizationId, 'backup', v2)).toString('utf8')).toBe('backup under DEK v2');

    expect((await receiptRow(rotated.receiptId)).metadata.keyLifecycle).toMatchObject({
      event: 'kek-rotated', kekRef: k2, previousKekRef: k1, kekGeneration: 2, dekVersions: [1, 2], kmsState: 'enabled',
    });
  });

  it('revocation fails closed and evicts the cached DEK in this process', async () => {
    const kms = createTestKekProvider();
    const { organizationId, kekRef } = await provisioned(kms);
    const svc = service(kms);
    const blob = await svc.encrypt(organizationId, 'content', text('revocable'));
    expect((await svc.decrypt(organizationId, 'content', blob)).toString('utf8')).toBe('revocable');

    const { receiptId } = await svc.revoke(organizationId, ctx);
    await keyError(svc.encrypt(organizationId, 'content', text('x')), 'organization-key-revoked');
    await keyError(svc.decrypt(organizationId, 'content', blob), 'organization-key-revoked');
    expect((await receiptRow(receiptId)).metadata.keyLifecycle).toMatchObject({
      event: 'revoked', kekRef, custodyState: 'revoked', dekVersions: [],
    });

    // Eviction proof on a second organization. Nothing reads its custody between the revoke and the
    // flip, because a refused read caches the revoked row (that fails closed for up to the TTL).
    const second = await provisioned(kms);
    const sealed = await svc.encrypt(second.organizationId, 'content', text('cached DEK'));
    expect((await svc.decrypt(second.organizationId, 'content', sealed)).toString('utf8')).toBe('cached DEK');
    const warm = kms.calls.unwrap;
    expect((await svc.decrypt(second.organizationId, 'content', sealed)).toString('utf8')).toBe('cached DEK');
    expect(kms.calls.unwrap).toBe(warm);
    await svc.revoke(second.organizationId, ctx);
    // Re-enable custody behind the service's back: if the DEK were still cached, the read would not unwrap.
    await org.adminSql`UPDATE harness_shared.organization_key_custody SET state = 'enabled' WHERE organization_id = ${second.organizationId}::uuid`;
    expect((await svc.decrypt(second.organizationId, 'content', sealed)).toString('utf8')).toBe('cached DEK');
    expect(kms.calls.unwrap).toBe(warm + 1);
  });

  it('another process stops serving a revoked organization once its cache TTL passes', async () => {
    const kms = createTestKekProvider();
    const { organizationId } = await provisioned(kms);
    let clock = 1_000_000;
    const other = service(kms, { cacheTtlMs: 1_000, now: () => clock });
    const blob = await other.encrypt(organizationId, 'content', text('cached elsewhere'));

    await service(kms).revoke(organizationId, ctx);
    // Within the TTL the other process still serves from its cache: the limitation the receipt states.
    expect((await other.decrypt(organizationId, 'content', blob)).toString('utf8')).toBe('cached elsewhere');
    clock += 1_001;
    await keyError(other.decrypt(organizationId, 'content', blob), 'organization-key-revoked');
  });

  it('detects a KEK disabled in the KMS, revokes custody, and recovers only after the KMS re-enables it', async () => {
    const kms = createTestKekProvider();
    const { organizationId, kekRef } = await provisioned(kms);
    const writer = service(kms);
    const blob = await writer.encrypt(organizationId, 'embedding', text('vector bytes'));

    expect(await writer.reconcileKekState(organizationId, ctx)).toEqual({ kmsState: 'enabled', revoked: false });

    kms.disableKek(kekRef);
    // Before reconciliation a cold reader already fails closed on the KMS refusal.
    const unreconciled = await keyError(service(kms).decrypt(organizationId, 'embedding', blob), 'kek-unavailable');
    expect(unreconciled.kekCode).toBe('kek-disabled');

    const reconciled = await writer.reconcileKekState(organizationId, ctx);
    expect(reconciled).toMatchObject({ kmsState: 'disabled', revoked: true });
    expect((await receiptRow((reconciled as { receiptId: string }).receiptId)).metadata.keyLifecycle).toMatchObject({
      event: 'revoked', custodyState: 'revoked', kmsState: 'disabled',
    });
    await keyError(writer.decrypt(organizationId, 'embedding', blob), 'organization-key-revoked');

    await expect(writer.recover(organizationId, ctx)).rejects.toThrow(/re-enable it there first/);
    kms.enableKek(kekRef);
    const recovered = await writer.recover(organizationId, ctx);
    expect((await writer.decrypt(organizationId, 'embedding', blob)).toString('utf8')).toBe('vector bytes');
    expect((await receiptRow(recovered.receiptId)).metadata.keyLifecycle).toMatchObject({
      event: 'recovered', custodyState: 'enabled', kmsState: 'enabled',
    });
    await expect(writer.recover(organizationId, ctx)).rejects.toThrow(/only a revoked KEK can be recovered/);
  });

  it('shreds only on confirmation, irreversibly, and the schema refuses to undo it', async () => {
    const kms = createTestKekProvider();
    const { organizationId } = await provisioned(kms);
    const svc = service(kms);
    const blob = await svc.encrypt(organizationId, 'content', text('to be shredded'));
    await svc.rotateDek(organizationId, ctx);

    await expect(svc.shred(organizationId, { ...ctx, confirmOrganizationId: randomUUID() })).rejects.toThrow(/confirmOrganizationId/);
    expect((await svc.decrypt(organizationId, 'content', blob)).toString('utf8')).toBe('to be shredded');

    const { receiptId } = await svc.shred(organizationId, { ...ctx, confirmOrganizationId: organizationId });
    await keyError(svc.decrypt(organizationId, 'content', blob), 'organization-key-shredded');
    await keyError(service(kms).decrypt(organizationId, 'content', blob), 'organization-key-shredded');

    const deks = await org.adminSql<Array<{ state: string; wrapped_dek: Buffer | null }>>`
      SELECT state, wrapped_dek FROM harness_shared.organization_data_keys WHERE organization_id = ${organizationId}::uuid`;
    expect(deks).toHaveLength(2);
    expect(deks.every((d) => d.state === 'shredded' && d.wrapped_dek === null)).toBe(true);
    expect((await receiptRow(receiptId)).metadata.keyLifecycle).toMatchObject({ event: 'shredded', custodyState: 'shredded' });

    await expect(org.adminSql`
      UPDATE harness_shared.organization_key_custody SET state = 'enabled' WHERE organization_id = ${organizationId}::uuid`)
      .rejects.toMatchObject({ code: '55000' });
    await expect(org.adminSql`
      UPDATE harness_shared.organization_data_keys SET state = 'decrypt-only', wrapped_dek = '\\x01'::bytea
       WHERE organization_id = ${organizationId}::uuid`)
      .rejects.toMatchObject({ code: '55000' });
    await expect(org.adminSql`
      DELETE FROM harness_shared.organization_key_custody WHERE organization_id = ${organizationId}::uuid`)
      .rejects.toMatchObject({ code: '55000' });
    await expect(svc.shred(organizationId, { ...ctx, confirmOrganizationId: organizationId })).rejects.toThrow(/already shredded/);
  });

  it('writes one receipt per lifecycle event for the organization', async () => {
    const kms = createTestKekProvider();
    const { organizationId } = await provisioned(kms);
    const svc = service(kms);
    await svc.rotateDek(organizationId, ctx);
    await svc.revoke(organizationId, ctx);
    await svc.recover(organizationId, ctx);
    await svc.shred(organizationId, { ...ctx, confirmOrganizationId: organizationId });
    expect(await receiptActions(organizationId)).toEqual([
      'organization.keys.provisioning',
      'organization.keys.recovery',
      'organization.keys.revocation',
      'organization.keys.rotation',
      'organization.keys.shred',
    ]);
  });

  it('the receipt writer refuses mixed key and data receipts and writes nothing', async () => {
    const organizationId = randomUUID();
    const base = { scope: { organizationId, workspaceIds: [WS] }, purpose: 'writer refusal test', limitations: [], schemaVersion: null };
    const lifecycle: KeyLifecycleRecord = {
      event: 'dek-rotated', kekProvider: 'test-kms', kekRef: 'kek-x', kekGeneration: 1,
      activeDekVersion: 2, dekVersions: [2], custodyState: 'enabled',
    };
    await expect(writeOrganizationDataReceipt({ ...base, operation: 'key-rotation', stores: [] }, actor, org.adminSql))
      .rejects.toThrow(/requires keyLifecycle/);
    await expect(writeOrganizationDataReceipt(
      { ...base, operation: 'key-rotation', stores: [{ store: 'harness_shared.documents' } as never], keyLifecycle: lifecycle },
      actor, org.adminSql,
    )).rejects.toThrow(/must not list stores/);
    await expect(writeOrganizationDataReceipt({ ...base, operation: 'export', stores: [], keyLifecycle: lifecycle }, actor, org.adminSql))
      .rejects.toThrow(/must not carry keyLifecycle/);
    expect(await receiptActions(organizationId)).toEqual([]);
  });
});
