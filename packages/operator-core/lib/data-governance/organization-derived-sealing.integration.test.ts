/**
 * Sealed embeddings and telemetry records against the real organization key service and Postgres
 * (WI-6554700010012443 U4, plan papercusp-enterprise-readiness-roadmap-2026-10-09#D-020).
 *
 * Acceptance under test:
 *  - an embedding and a telemetry record sealed under the organization's key round-trip, and their
 *    bytes contain no plaintext;
 *  - another organization cannot open them, and a blob of one scope does not open as the other;
 *  - an organization without key custody gets no sealer (its derived data stays plaintext);
 *  - a blob sealed before a DEK rotation still opens, new blobs seal under the new version, and the
 *    key service's sweep re-seals old blobs;
 *  - revoking the key fails sealing and opening closed;
 *  - shredding the key makes every blob unreadable.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createTestKekProvider, type TestKekProvider } from './kek-providers';
import { derivedSealing, openEmbedding, openTelemetryPayload, sealEmbedding, sealTelemetryPayload } from './organization-derived-sealing';
import { organizationKeyService, useOrganizationKekProviders } from './organization-key-registry';
import { OrganizationKeyUnavailableError, envelopeDekVersion, type KeyOperationContext, type OrganizationKeyService } from './organization-keys';

let org: OrgTestDb;
let kms: TestKekProvider;
let svc: OrganizationKeyService;
const WS = `derived-sealing-ws-${randomUUID()}`;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const unprovisionedOrganizationId = randomUUID();
const ctx: KeyOperationContext = { actor: { kind: 'system', id: 'derived-sealing-test' }, purpose: 'derived sealing test', workspaceIds: [WS] };

const MODEL = 'embed-cobalt-model';
const VECTOR = [0.25, -0.5, 1.75, 3];
const RECORD = { kind: 'retrieval-trace', payload: { query: 'quarterly cobalt ledger', hits: 3 } };

async function keyError(p: Promise<unknown>, code: OrganizationKeyUnavailableError['code']) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OrganizationKeyUnavailableError);
  expect((err as OrganizationKeyUnavailableError).code).toBe(code);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  kms = createTestKekProvider();
  const kekRef = `kek-${randomUUID()}`;
  const otherKekRef = `kek-${randomUUID()}`;
  kms.createKek(kekRef);
  kms.createKek(otherKekRef);
  useOrganizationKekProviders({ 'test-kms': kms });
  svc = organizationKeyService(org.adminSql);
  await svc.provision(organizationId, { kekProvider: 'test-kms', kekRef }, ctx);
  await svc.provision(otherOrganizationId, { kekProvider: 'test-kms', kekRef: otherKekRef }, { ...ctx, workspaceIds: [`${WS}-other`] });
});

afterAll(async () => {
  useOrganizationKekProviders(null);
  await org?.cleanup();
});

describe('sealed embeddings and telemetry (P-016b follow-up U4)', () => {
  it('round-trips through the organization sealer and stores no plaintext', async () => {
    const sealing = (await derivedSealing(org.adminSql, organizationId))!;
    expect(sealing.organizationId).toBe(organizationId);

    const vec = await sealing.sealEmbedding({ model: MODEL, vector: VECTOR });
    expect(vec.includes(Buffer.from(MODEL))).toBe(false);
    const opened = await sealing.openEmbedding(vec, { model: MODEL, dimension: VECTOR.length });
    expect([...opened.vector]).toEqual(VECTOR);

    const tel = await sealing.sealTelemetry(RECORD);
    expect(tel.includes(Buffer.from('cobalt'))).toBe(false);
    expect(tel.includes(Buffer.from(RECORD.kind))).toBe(false);
    expect(await sealing.openTelemetry(tel, RECORD.kind)).toEqual(RECORD);
  });

  it('refuses another organization and the other scope', async () => {
    const vec = await sealEmbedding(svc, organizationId, { model: MODEL, vector: VECTOR });
    const tel = await sealTelemetryPayload(svc, organizationId, RECORD);
    await keyError(openEmbedding(svc, otherOrganizationId, vec), 'envelope-auth-failed');
    await keyError(openTelemetryPayload(svc, otherOrganizationId, tel), 'envelope-auth-failed');
    await keyError(openTelemetryPayload(svc, organizationId, vec), 'envelope-auth-failed');
    await keyError(openEmbedding(svc, organizationId, tel), 'envelope-auth-failed');
  });

  it('gives no sealer to an organization without key custody', async () => {
    expect(await derivedSealing(org.adminSql, unprovisionedOrganizationId)).toBeNull();
  });

  it('opens blobs sealed before a DEK rotation and sweeps them to the new version', async () => {
    const oldVec = await sealEmbedding(svc, organizationId, { model: MODEL, vector: VECTOR });
    const oldTel = await sealTelemetryPayload(svc, organizationId, RECORD);
    const before = envelopeDekVersion(oldVec)!;
    expect(envelopeDekVersion(oldTel)).toBe(before);

    await svc.rotateDek(organizationId, ctx);

    expect([...(await openEmbedding(svc, organizationId, oldVec)).vector]).toEqual(VECTOR);
    expect(await openTelemetryPayload(svc, organizationId, oldTel)).toEqual(RECORD);
    const newVec = await sealEmbedding(svc, organizationId, { model: MODEL, vector: VECTOR });
    expect(envelopeDekVersion(newVec)).toBe(before + 1);

    const written = new Map<string, Buffer>();
    const result = await svc.sweep(
      organizationId,
      'embedding',
      [{ id: 'old', blob: oldVec }, { id: 'new', blob: newVec }],
      async (id, blob) => { written.set(id, blob); },
    );
    expect(result).toEqual({ examined: 2, reencrypted: 1, alreadyCurrent: 1 });
    expect([...written.keys()]).toEqual(['old']);
    expect(envelopeDekVersion(written.get('old')!)).toBe(before + 1);
    expect([...(await openEmbedding(svc, organizationId, written.get('old')!, { model: MODEL })).vector]).toEqual(VECTOR);

    const telSweep = await svc.sweep(organizationId, 'telemetry', [{ id: 't', blob: oldTel }], async (_id, blob) => {
      expect(envelopeDekVersion(blob)).toBe(before + 1);
      expect(await openTelemetryPayload(svc, organizationId, blob, RECORD.kind)).toEqual(RECORD);
    });
    expect(telSweep.reencrypted).toBe(1);
  });

  it('fails sealing and opening closed once the key is revoked', async () => {
    const vec = await sealEmbedding(svc, organizationId, { model: MODEL, vector: VECTOR });
    const tel = await sealTelemetryPayload(svc, organizationId, RECORD);
    await svc.revoke(organizationId, ctx);
    const sealing = await derivedSealing(org.adminSql, organizationId);
    expect(sealing).not.toBeNull();
    await keyError(sealing!.sealEmbedding({ model: MODEL, vector: VECTOR }), 'organization-key-revoked');
    await keyError(sealing!.sealTelemetry(RECORD), 'organization-key-revoked');
    await keyError(openEmbedding(svc, organizationId, vec), 'organization-key-revoked');
    await keyError(openTelemetryPayload(svc, organizationId, tel), 'organization-key-revoked');
  });

  it('makes every blob unreadable once the key is shredded', async () => {
    const vec = await sealEmbedding(svc, otherOrganizationId, { model: MODEL, vector: VECTOR });
    const tel = await sealTelemetryPayload(svc, otherOrganizationId, RECORD);
    await svc.shred(otherOrganizationId, { ...ctx, workspaceIds: [`${WS}-other`], confirmOrganizationId: otherOrganizationId });
    await keyError(openEmbedding(svc, otherOrganizationId, vec), 'organization-key-shredded');
    await keyError(openTelemetryPayload(svc, otherOrganizationId, tel), 'organization-key-shredded');
    await keyError(sealEmbedding(svc, otherOrganizationId, { model: MODEL, vector: VECTOR }), 'organization-key-shredded');
  });
});
