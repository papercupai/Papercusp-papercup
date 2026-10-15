import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown as import('postgres').Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql, db: {} }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'integration-test-workspace' }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./db-encryption', () => ({
  ENCRYPTED_TABLES: new Set(['operator_integration_credentials']),
  getDbEncryptionKey: () => 'synthetic-integration-encryption-key',
}));

import { readIntegrationCredentials, writeIntegrationCredentials, storeElevenLabsCreatedCredential,
  provisionElevenLabsIntegrationCredential, readElevenLabsCredentialPair, readMaskedIntegrationView,
  readAdmittedElevenLabsIntegrationCredential } from './integration-credentials';
import { PAPERCUP_FRONT_AGENT, buildAgentConfig } from './voice-engines/elevenlabs-agent-sync';

const NEVER_EMIT_MARKER = 'never-emit-me';

let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('integrationcreds');
  h.sql = db.sql;
  await db.sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE harness_shared.operator_integration_credentials (
      workspace_id TEXT PRIMARY KEY, payload JSONB, payload_ct BYTEA, updated_at BIGINT
    );
  `);
}, 60_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`DELETE FROM harness_shared.operator_integration_credentials`; });

describe('encrypted integration credential updates', () => {
  it('requires fresh restrictions and immutable profile and refuses rotation during admission', async () => {
    await storeElevenLabsCreatedCredential({ name: 'TUTORIAL_KEY', serviceAccountUserId: 'service-account',
      createResponse: { 'xi-api-key': NEVER_EMIT_MARKER, key_id: 'created-key' } });
    const definition = { ...PAPERCUP_FRONT_AGENT, tools: [], allowSessionOverrides: false };
    const profile = { ...buildAgentConfig(definition, []), agent_id: 'tutorial',
      platform_settings: { ...(buildAgentConfig(definition, []).platform_settings as object),
        auth: { enable_auth: true, allowlist: [], shareable_token: null } } };
    const metadata = { 'api-keys': [{ key_id: 'created-key', service_account_user_id: 'service-account',
      is_disabled: false, disable_reason: null, permissions: ['convai_read'], character_limit: 1000, character_count: 0 }] };
    const fetchImpl = vi.fn<typeof fetch>();
    const options = { integrationName: 'TUTORIAL_KEY', metadataApiKey: 'synthetic-metadata-key',
      allowedPermissions: ['convai_read'], maximumCredits: 1000, definition, toolIds: [], agentId: 'tutorial',
      fetch: fetchImpl, signal: new AbortController().signal };
    fetchImpl.mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(Response.json(profile));
    expect(await readAdmittedElevenLabsIntegrationCredential(options)).toEqual({ apiKey: NEVER_EMIT_MARKER,
      keyId: 'created-key', agentId: 'tutorial', maximumSeconds: definition.maxDurationSeconds });
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({ 'xi-api-key': 'synthetic-metadata-key' });
    expect(fetchImpl.mock.calls[1][1]?.headers).toEqual({ 'xi-api-key': NEVER_EMIT_MARKER });
    fetchImpl.mockClear();
    fetchImpl.mockResolvedValueOnce(Response.json({ 'api-keys': [] }));
    expect(await readAdmittedElevenLabsIntegrationCredential(options)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(Response.json({ ...profile, agent_id: 'other' }));
    expect(await readAdmittedElevenLabsIntegrationCredential(options)).toBeNull();
    fetchImpl.mockResolvedValueOnce(Response.json(metadata)).mockImplementationOnce(async () => {
      await writeIntegrationCredentials({ TUTORIAL_KEY: 'rotated-key' });
      return Response.json(profile);
    });
    expect(await readAdmittedElevenLabsIntegrationCredential(options)).toBeNull();
    fetchImpl.mockClear();
    expect(await readAdmittedElevenLabsIntegrationCredential(options)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('persists only authenticated and freshly admitted provisioning into the encrypted pair', async () => {
    const metadata = { key_id: 'created-key', service_account_user_id: 'service-account',
      is_disabled: false, disable_reason: null, permissions: ['convai_read'], character_limit: 1000, character_count: 0 };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'xi-api-key': 'synthetic-created-key', key_id: 'created-key' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'api-keys': [metadata] })));
    const options = { integrationName: 'TUTORIAL_KEY', name: 'Tutorial', serviceAccountUserId: 'service-account',
      metadataApiKey: 'synthetic-metadata-key', allowedPermissions: ['convai_read'], maximumCredits: 1000,
      fetch: fetchImpl, signal: new AbortController().signal };
    expect(await provisionElevenLabsIntegrationCredential(options)).toEqual({ keyId: 'created-key' });
    expect((await readElevenLabsCredentialPair('TUTORIAL_KEY'))?.apiKey).toBe('synthetic-created-key');
    const rows = await db.sql`SELECT payload, encode(payload_ct, 'escape') AS ciphertext FROM harness_shared.operator_integration_credentials`;
    expect(rows[0].payload).toEqual({});
    expect(rows[0].ciphertext).not.toContain('synthetic-created-key');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error',
      headers: { 'xi-api-key': 'synthetic-metadata-key' } });
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ 'xi-api-key': 'rejected-key', key_id: 'created-key' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'api-keys': [{ ...metadata, is_disabled: true }] })));
    expect(await provisionElevenLabsIntegrationCredential(options)).toBeNull();
    expect((await readElevenLabsCredentialPair('TUTORIAL_KEY'))?.apiKey).toBe('synthetic-created-key');
    fetchImpl.mockClear();
    expect(await provisionElevenLabsIntegrationCredential({ ...options, integrationName: '__invalid' })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('binds a trusted creation pair, hides receipt metadata and refuses secret rotation', async () => {
    expect(await storeElevenLabsCreatedCredential({ name: 'TUTORIAL_KEY', serviceAccountUserId: 'service-account',
      createResponse: { 'xi-api-key': NEVER_EMIT_MARKER, key_id: 'created-key' } })).toBe(true);
    const pair = await readElevenLabsCredentialPair('TUTORIAL_KEY');
    expect(pair?.apiKey).toBe(NEVER_EMIT_MARKER);
    expect(pair?.receipt.keyId).toBe('created-key');
    expect(pair?.receipt.secretRef).toBe('integration:TUTORIAL_KEY');
    expect(await readMaskedIntegrationView()).toEqual({ TUTORIAL_KEY: 'syn...-key' });
    await expect(writeIntegrationCredentials({ '__papercusp_trusted_elevenlabs_receipt:TUTORIAL_KEY': '{}' }))
      .rejects.toThrow('server provisioning');
    await writeIntegrationCredentials({ TUTORIAL_KEY: 'rotated-tutorial-key' });
    expect(await readElevenLabsCredentialPair('TUTORIAL_KEY')).toBeNull();
    await writeIntegrationCredentials({ TUTORIAL_KEY: null });
    expect(await readElevenLabsCredentialPair('TUTORIAL_KEY')).toBeNull();
  });

  it('does not store list metadata or invalid creation responses', async () => {
    for (const createResponse of [{ key_id: 'listed', hashed_xi_api_key: 'opaque' }, {}, null]) {
      expect(await storeElevenLabsCreatedCredential({ name: 'TUTORIAL_KEY', serviceAccountUserId: 'service-account',
        createResponse })).toBe(false);
    }
    expect(await readIntegrationCredentials()).toEqual({});
    expect(await readElevenLabsCredentialPair('TUTORIAL_KEY')).toBeNull();
  });
  it.each([false, true])('preserves concurrent independent saves with existing row=%s', async (existing) => {
    if (existing) await writeIntegrationCredentials({ EXISTING: 'preserved' });
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      writeIntegrationCredentials({ [`PROVIDER_${index}`]: `synthetic-value-${index}` })));
    const values = await readIntegrationCredentials();
    for (let index = 0; index < 8; index++) {
      expect(values[`PROVIDER_${index}`]).toBe(`synthetic-value-${index}`);
    }
    if (existing) expect(values.EXISTING).toBe('preserved');
  });

  it('stores a secret and receipt together under encryption and clears them together', async () => {
    const secret = NEVER_EMIT_MARKER;
    const receipt = JSON.stringify({ keyId: 'synthetic-key', secretRef: 'integration:TUTORIAL_KEY' });
    await writeIntegrationCredentials({ TUTORIAL_KEY: secret, TUTORIAL_RECEIPT: receipt });
    const rows = await db.sql`
      SELECT payload, encode(payload_ct, 'escape') AS ciphertext,
        pgp_sym_decrypt(payload_ct, 'synthetic-integration-encryption-key')::jsonb AS decrypted
      FROM harness_shared.operator_integration_credentials
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({});
    expect(rows[0].ciphertext).not.toContain(secret);
    expect(rows[0].ciphertext).not.toContain(receipt);
    expect(rows[0].decrypted).toEqual({ TUTORIAL_KEY: secret, TUTORIAL_RECEIPT: receipt });
    await writeIntegrationCredentials({ TUTORIAL_KEY: null, TUTORIAL_RECEIPT: '' });
    expect(await readIntegrationCredentials()).toEqual({});
  });
});
