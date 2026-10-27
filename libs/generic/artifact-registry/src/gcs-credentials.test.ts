import { beforeAll, describe, expect, it } from 'vitest';
import { configuredGcsObjectStore, gcsServiceAccountToken, type GcsServiceAccount } from './gcs-credentials.js';

let credentials: GcsServiceAccount;
let publicKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  credentials = { client_email: 'storage-reader@test-project.iam.gserviceaccount.com',
    private_key: `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n${btoa(String.fromCharCode(...bytes))}\n${['-----END', 'PRIVATE KEY-----'].join(' ')}` };
});

describe('private GCS service-account token provider', () => {
  it('signs the bounded Google storage grant and coalesces concurrent refreshes', async () => {
    let calls = 0;
    const provider = gcsServiceAccountToken(credentials, { now: () => 1_000_000, fetchImpl: (async (url, init) => {
      calls++;
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = init!.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, claims, signature] = body.get('assertion')!.split('.');
      const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      expect(JSON.parse(new TextDecoder().decode(decode(header!)))).toMatchObject({ alg: 'RS256' });
      expect(JSON.parse(new TextDecoder().decode(decode(claims!)))).toEqual({
        iss: credentials.client_email, aud: 'https://oauth2.googleapis.com/token',
        scope: 'https://www.googleapis.com/auth/devstorage.read_write', iat: 1000, exp: 4600,
      });
      expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode(signature!), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
      return Response.json({ access_token: 'first-token', expires_in: 3600 });
    }) as typeof fetch });
    expect(await Promise.all([provider(), provider(), provider()])).toEqual(['first-token', 'first-token', 'first-token']);
    expect(await provider()).toBe('first-token'); expect(calls).toBe(1);
  });

  it('refreshes before expiry without returning an expired credential', async () => {
    let now = 1_000_000; let calls = 0;
    const provider = gcsServiceAccountToken(credentials, { now: () => now, fetchImpl: (async () => {
      return Response.json({ access_token: `token-${++calls}`, expires_in: 3600 });
    }) as typeof fetch });
    expect(await provider()).toBe('token-1'); now += 3540_000;
    expect(await provider()).toBe('token-2'); expect(calls).toBe(2);
  });

  it('propagates denial without caching it or exposing provider error bodies', async () => {
    let calls = 0;
    const provider = gcsServiceAccountToken(credentials, { fetchImpl: (async () => {
      calls++; return new Response('private credential diagnostic', { status: 403 });
    }) as typeof fetch });
    await expect(provider()).rejects.toThrow('HTTP 403');
    await expect(provider()).rejects.not.toThrow('private credential diagnostic'); expect(calls).toBe(2);
  });

  it('rejects malformed token responses and unconfigured credentials', async () => {
    const provider = gcsServiceAccountToken(credentials, { fetchImpl: (async () => Response.json({ expires_in: 3600 })) as typeof fetch });
    await expect(provider()).rejects.toThrow('invalid GCS OAuth token response');
    expect(() => gcsServiceAccountToken({ client_email: 'someone@example.com', private_key: '' })).toThrow('invalid GCS service-account');
    expect(() => gcsServiceAccountToken({ ...credentials, private_key: 'not a PKCS8 document' })).toThrow('invalid GCS service-account');
  });

  it('caches the configured port for one Worker environment', () => {
    const bindings = { GCS_BUCKET: 'test-bucket', GCS_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials) };
    expect(configuredGcsObjectStore(bindings)).toBe(configuredGcsObjectStore(bindings));
  });

  it('fails closed instead of using a legacy storage binding', () => {
    const bindings = { GCS_BUCKET: undefined, ARTIFACTS: { head: () => 'legacy bytes' } };
    expect(() => configuredGcsObjectStore(bindings)).toThrow('GCS storage is not configured');
  });

  it('sanitizes malformed injected-secret errors', () => {
    const bindings = { GCS_BUCKET: 'test-bucket', GCS_SERVICE_ACCOUNT_JSON: '{private_key: sensitive-fragment' };
    expect(() => configuredGcsObjectStore(bindings)).toThrow('invalid GCS service-account configuration');
    expect(() => configuredGcsObjectStore(bindings)).not.toThrow('sensitive-fragment');
  });
});
