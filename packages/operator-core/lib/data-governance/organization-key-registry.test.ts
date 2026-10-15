import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  awsKmsKekPolicyStatements,
  awsKmsKekRegion,
  createTestKekProvider,
  KEK_CONTEXT_ORGANIZATION_KEY,
  KekUnavailableError,
  regionalAwsKmsKekProvider,
} from './kek-providers';
import {
  CLOUD_KMS_SCOPE,
  createOrganizationKekProviders,
  organizationGcpKmsTokenSource,
  organizationKeyService,
  useOrganizationKekProviders,
} from './organization-key-registry';
import { dekWrapContext } from './organization-keys';
import { organizationDelegationEmail } from '../workspace-host/hosted-gcp-auth';

const ARN_EU = 'arn:aws:kms:eu-west-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const ARN_US = 'arn:aws:kms:us-east-1:123456789012:alias/customer-kek';
const GCP_REF = 'projects/p/locations/europe-west1/keyRings/r/cryptoKeys/k';
const ENV = { PAPERCUSP_HOSTED_GCP_ORGANIZATION_IDENTITY_PROJECT: 'papercusp-identity' };

describe('regionalAwsKmsKekProvider', () => {
  it('sends each call to the KMS of the region in the KEK ARN, one client per region', async () => {
    const regions: string[] = [];
    const provider = regionalAwsKmsKekProvider((region) => {
      regions.push(region);
      return { send: vi.fn(async () => ({ KeyMetadata: { KeyState: 'Enabled' } })) } as never;
    });
    expect((await provider.describeKek(ARN_EU)).state).toBe('enabled');
    expect((await provider.describeKek(ARN_EU)).state).toBe('enabled');
    expect((await provider.describeKek(ARN_US)).state).toBe('enabled');
    expect(regions).toEqual(['eu-west-1', 'us-east-1']);
  });

  it('refuses a bare key id or alias, which would resolve in the Papercusp account', () => {
    expect(() => awsKmsKekRegion('1234abcd-12ab-34cd-56ef-1234567890ab')).toThrow(/key or alias ARN/);
    expect(() => awsKmsKekRegion('alias/customer-kek')).toThrow(/key or alias ARN/);
    expect(awsKmsKekRegion(ARN_US)).toBe('us-east-1');
  });

  it('binds the customer key-policy grant to the same context key the DEK wrap uses', () => {
    const [envelope, keyState] = awsKmsKekPolicyStatements({ organizationId: 'org-a', papercuspPrincipalArn: 'arn:aws:iam::999999999999:role/papercusp' });
    expect(Object.keys(dekWrapContext('org-a', 1))).toContain(KEK_CONTEXT_ORGANIZATION_KEY);
    expect(envelope.Condition.StringEquals).toEqual({ [`kms:EncryptionContext:${KEK_CONTEXT_ORGANIZATION_KEY}`]: 'org-a' });
    expect(envelope.Action).toEqual(['kms:Encrypt', 'kms:Decrypt']);
    expect(keyState.Action).toEqual(['kms:DescribeKey']);
  });
});

function mintFetch(status = 200, expireTime = '2026-10-14T11:00:00Z') {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('generateAccessToken')) {
      return new Response(JSON.stringify(status === 200 ? { accessToken: `org-token-${target.length}`, expireTime } : { error: {} }), { status });
    }
    return new Response(JSON.stringify({ primary: { state: 'ENABLED' }, seenAuth: (init?.headers as Record<string, string>)?.authorization }), { status: 200 });
  });
}

describe('organizationGcpKmsTokenSource', () => {
  const gcpSource = { principal: async () => 'serviceAccount:source@p.iam.gserviceaccount.com', accessToken: async () => 'source-token' };

  it('mints a Cloud KMS token for the asking organization delegation account, and caches it', async () => {
    const fetchImpl = mintFetch();
    const tokens = organizationGcpKmsTokenSource({ env: ENV, fetch: fetchImpl as never, gcpSource, now: () => Date.parse('2026-10-14T10:00:00Z') });
    const token = await tokens({ [KEK_CONTEXT_ORGANIZATION_KEY]: 'org-a' });
    expect(await tokens({ [KEK_CONTEXT_ORGANIZATION_KEY]: 'org-a' })).toBe(token);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain(encodeURIComponent(organizationDelegationEmail('org-a', 'papercusp-identity')));
    expect(JSON.parse(String(init?.body))).toEqual({ delegates: [], scope: [CLOUD_KMS_SCOPE], lifetime: '3600s' });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer source-token');
  });

  it('refuses a request that names no organization, and maps a refused mint to access-denied', async () => {
    const tokens = organizationGcpKmsTokenSource({ env: ENV, fetch: mintFetch(403) as never, gcpSource });
    await expect(tokens({})).rejects.toMatchObject({ code: 'kek-access-denied' });
    await expect(tokens({ [KEK_CONTEXT_ORGANIZATION_KEY]: 'org-a' })).rejects.toBeInstanceOf(KekUnavailableError);
    await expect(tokens({ [KEK_CONTEXT_ORGANIZATION_KEY]: 'org-a' })).rejects.toMatchObject({ code: 'kek-access-denied' });
  });

  it('refuses when the identity project is not configured', async () => {
    const tokens = organizationGcpKmsTokenSource({ env: {}, fetch: mintFetch() as never, gcpSource });
    await expect(tokens({ [KEK_CONTEXT_ORGANIZATION_KEY]: 'org-a' })).rejects.toMatchObject({ code: 'kek-access-denied' });
  });

  it('the production gcp-kms provider describes a KEK with the organization token', async () => {
    const fetchImpl = mintFetch();
    const providers = createOrganizationKekProviders({ env: ENV, fetch: fetchImpl as never, gcpSource });
    const state = await providers['gcp-kms']!.describeKek(GCP_REF, { [KEK_CONTEXT_ORGANIZATION_KEY]: 'org-a' });
    expect(state.state).toBe('enabled');
    await expect(providers['gcp-kms']!.describeKek(GCP_REF)).rejects.toMatchObject({ code: 'kek-access-denied' });
    expect(providers['test-kms']).toBeUndefined();
  });
});

describe('organizationKeyService', () => {
  it('returns one service per database handle until the providers are replaced', () => {
    const sql = (() => undefined) as unknown as Sql;
    useOrganizationKekProviders({ 'test-kms': createTestKekProvider() });
    const first = organizationKeyService(sql);
    expect(organizationKeyService(sql)).toBe(first);
    useOrganizationKekProviders({ 'test-kms': createTestKekProvider() });
    expect(organizationKeyService(sql)).not.toBe(first);
    useOrganizationKekProviders(null);
  });
});
