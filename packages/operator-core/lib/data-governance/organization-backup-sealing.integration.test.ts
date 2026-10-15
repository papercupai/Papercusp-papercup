/**
 * Sealed organization backup artifacts against the real organization key service and Postgres
 * (WI-6554700010012443 U3, plan papercusp-enterprise-readiness-roadmap-2026-10-09#D-020).
 *
 * Acceptance under test:
 *  - an artifact sealed under the organization's key round-trips across several frames, and its bytes
 *    contain no plaintext;
 *  - another organization cannot open it, and a frame sealed for another scope does not authenticate;
 *  - the sealed export carries the export receipt and the exported rows, without secret-class columns;
 *  - an organization without key custody gets no export (and no data is read);
 *  - an artifact sealed before a DEK rotation still opens, and new artifacts seal under the new version;
 *  - revoking the key mid-stream stops the stream at the next frame (fail closed);
 *  - shredding the key makes every artifact unreadable and refuses further exports.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createTestKekProvider, type TestKekProvider } from './kek-providers';
import {
  collectBytes,
  exportOrganizationBackup,
  openBackupArtifact,
  readOrganizationBackup,
  sealBackupArtifact,
} from './organization-backup-sealing';
import { organizationKeyService, useOrganizationKekProviders } from './organization-key-registry';
import { OrganizationKeyUnavailableError, envelopeDekVersion, type KeyOperationContext, type OrganizationKeyService } from './organization-keys';

let org: OrgTestDb;
let kms: TestKekProvider;
let svc: OrganizationKeyService;
const WS = `backup-sealing-ws-${randomUUID()}`;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const ctx: KeyOperationContext = { actor: { kind: 'system', id: 'backup-sealing-test' }, purpose: 'backup sealing test', workspaceIds: [WS] };
const actor = { kind: 'system' as const, id: 'backup-sealing-test' };
const VAULT_REF = 'vault://backup-sealing/slack-bot';

const bytes = (s: string) => Buffer.from(s, 'utf8');

async function seal(orgId: string, plaintext: string, chunkBytes = 8): Promise<Buffer> {
  return collectBytes(sealBackupArtifact(svc, orgId, [bytes(plaintext)], { chunkBytes }));
}

async function open(orgId: string, artifact: Buffer): Promise<string> {
  return (await collectBytes(openBackupArtifact(svc, orgId, [artifact]))).toString('utf8');
}

/** The sealed envelope of each frame (length prefix stripped). */
function frameBlobs(artifact: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < artifact.length;) {
    const length = artifact.readUInt32BE(at);
    out.push(artifact.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return out;
}

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
  await org.adminSql`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, permission_mapping, credential_ref)
    VALUES (${WS}, 'slack', ${org.adminSql.json({ mode: 'source-acl' })}, ${VAULT_REF})`;
});

afterAll(async () => {
  useOrganizationKekProviders(null);
  await org?.cleanup();
});

describe('sealed organization backup artifacts (P-016b follow-up U3)', () => {
  it('round-trips a multi-frame artifact and stores no plaintext', async () => {
    const plaintext = 'quarterly cobalt ledger, forty-two lines of it';
    const artifact = await seal(organizationId, plaintext);
    const blobs = frameBlobs(artifact);
    expect(blobs.length).toBe(Math.ceil(Buffer.byteLength(plaintext) / 8));
    expect(blobs.every((b) => envelopeDekVersion(b) === 1)).toBe(true);
    expect(artifact.includes(bytes('cobalt'))).toBe(false);
    expect(await open(organizationId, artifact)).toBe(plaintext);
  });

  it('refuses an artifact of another organization and a frame sealed for another scope', async () => {
    const artifact = await seal(organizationId, 'not for the other organization');
    await keyError(open(otherOrganizationId, artifact), 'envelope-auth-failed');

    // A content-scope envelope framed as a backup artifact does not authenticate as 'backup'.
    const contentBlob = await svc.encrypt(organizationId, 'content', bytes('content scope'));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(contentBlob.length, 0);
    await keyError(open(organizationId, Buffer.concat([length, contentBlob])), 'envelope-auth-failed');
  });

  it('exports the organization as a sealed artifact that reads back with its receipt', async () => {
    const sealed = await exportOrganizationBackup(
      org.adminSql,
      { scope: { organizationId, workspaceIds: [WS] }, actor, purpose: 'sealed backup test' },
      { chunkBytes: 256 },
    );
    const artifact = await collectBytes(sealed.artifact);
    expect(frameBlobs(artifact).length).toBeGreaterThan(1);
    expect(artifact.includes(bytes(WS))).toBe(false);

    const opened = await readOrganizationBackup(svc, organizationId, [artifact]);
    expect(opened).toMatchObject({ organizationId, receiptId: sealed.receiptId });
    const sources = opened.stores.find((s) => s.store === 'harness_shared.data_sources')!;
    expect(sources.rows).toHaveLength(1);
    expect(sources.rows[0]).toMatchObject({ workspace_id: WS, kind: 'slack' });
    expect(sources.columns).not.toContain('credential_ref');
    expect(JSON.stringify(opened.stores)).not.toContain(VAULT_REF);
  });

  it('refuses a sealed export for an organization without key custody before reading any data', async () => {
    let read = false;
    const err = await exportOrganizationBackup(
      org.adminSql,
      { scope: { organizationId: randomUUID(), workspaceIds: [WS] }, actor, purpose: 'no custody' },
      { keyService: () => { read = true; return svc; } },
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrganizationKeyUnavailableError);
    expect((err as OrganizationKeyUnavailableError).code).toBe('organization-key-unprovisioned');
    expect(read).toBe(false);
  });

  it('opens an artifact sealed before a DEK rotation and seals new artifacts under the new version', async () => {
    const before = await seal(organizationId, 'sealed under version one');
    await svc.rotateDek(organizationId, ctx);
    expect(await open(organizationId, before)).toBe('sealed under version one');
    const after = await seal(organizationId, 'sealed under version two');
    expect(frameBlobs(after).every((b) => envelopeDekVersion(b) === 2)).toBe(true);
    expect(await open(organizationId, after)).toBe('sealed under version two');
  });

  it('stops a stream at the next frame once the key is revoked', async () => {
    const artifact = await seal(organizationId, 'first chunk, then a revocation');
    const stream = openBackupArtifact(svc, organizationId, [artifact]);
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect((first.value as Buffer).toString('utf8')).toBe('first ch');

    await svc.revoke(organizationId, ctx);
    await keyError(stream.next(), 'organization-key-revoked');
    await keyError(
      exportOrganizationBackup(org.adminSql, { scope: { organizationId, workspaceIds: [WS] }, actor, purpose: 'revoked' }),
      'organization-key-revoked',
    );

    await svc.recover(organizationId, ctx);
    expect(await open(organizationId, artifact)).toBe('first chunk, then a revocation');
  });

  it('makes every artifact unreadable once the key is shredded', async () => {
    const artifact = await seal(organizationId, 'crypto-shredded');
    await svc.shred(organizationId, { ...ctx, confirmOrganizationId: organizationId });
    await keyError(open(organizationId, artifact), 'organization-key-shredded');
    await keyError(
      exportOrganizationBackup(org.adminSql, { scope: { organizationId, workspaceIds: [WS] }, actor, purpose: 'shredded' }),
      'organization-key-shredded',
    );
  });
});
