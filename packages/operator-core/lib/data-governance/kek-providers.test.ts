/**
 * KEK providers (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b, WI-6554700010012353; D-020).
 * AWS KMS against a fake KMSClient.send, Cloud KMS against a fake fetch, and the in-process test KMS.
 */
import { DecryptCommand, DescribeKeyCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';
import {
  KekUnavailableError,
  awsKmsKekProvider,
  canonicalWrapContext,
  createTestKekProvider,
  gcpKmsKekProvider,
  type KekProvider,
} from './kek-providers';

const CTX = { organization: 'org-1', dekVersion: '3', purpose: 'papercusp-organization-dek' };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(KekUnavailableError);
    return (err as KekUnavailableError).code;
  }
  throw new Error('expected a KekUnavailableError');
}

describe('canonicalWrapContext', () => {
  it('is independent of key order and distinguishes values', () => {
    expect(canonicalWrapContext({ a: '1', b: '2' }).equals(canonicalWrapContext({ b: '2', a: '1' }))).toBe(true);
    expect(canonicalWrapContext({ a: '1' }).equals(canonicalWrapContext({ a: '2' }))).toBe(false);
  });
});

describe('test-kms', () => {
  it('round-trips a DEK and binds it to the wrap context', async () => {
    const kms = createTestKekProvider();
    kms.createKek('k1');
    const dek = Buffer.alloc(32, 7);
    const wrapped = await kms.wrapDataKey('k1', dek, CTX);
    expect(wrapped.includes(dek)).toBe(false);
    expect((await kms.unwrapDataKey('k1', wrapped, CTX)).equals(dek)).toBe(true);
    expect(await codeOf(kms.unwrapDataKey('k1', wrapped, { ...CTX, organization: 'org-2' }))).toBe('kek-access-denied');
    expect(kms.calls).toEqual({ wrap: 1, unwrap: 2 });
  });

  it('refuses a disabled key, recovers when re-enabled, and loses everything when destroyed', async () => {
    const kms = createTestKekProvider();
    kms.createKek('k1');
    const wrapped = await kms.wrapDataKey('k1', Buffer.alloc(32, 1), CTX);
    kms.disableKek('k1');
    expect(await kms.describeKek('k1')).toEqual({ state: 'disabled' });
    expect(await codeOf(kms.unwrapDataKey('k1', wrapped, CTX))).toBe('kek-disabled');
    kms.enableKek('k1');
    expect(await kms.describeKek('k1')).toEqual({ state: 'enabled' });
    await kms.unwrapDataKey('k1', wrapped, CTX);
    kms.destroyKek('k1');
    expect(await kms.describeKek('k1')).toEqual({ state: 'missing' });
    expect(await codeOf(kms.unwrapDataKey('k1', wrapped, CTX))).toBe('kek-missing');
    kms.createKek('k1');
    expect(await codeOf(kms.unwrapDataKey('k1', wrapped, CTX))).toBe('kek-access-denied');
  });
});

function awsError(name: string): Error {
  const err = new Error(`${name} from KMS`);
  err.name = name;
  return err;
}

describe('aws-kms', () => {
  it('maps DescribeKey states', async () => {
    const states: Record<string, string> = { a: 'Enabled', b: 'Disabled', c: 'PendingDeletion', d: 'PendingImport' };
    const provider = awsKmsKekProvider({
      send: (async (cmd: DescribeKeyCommand) => {
        if (cmd.input.KeyId === 'gone') throw awsError('NotFoundException');
        return { KeyMetadata: { KeyState: states[cmd.input.KeyId!] } };
      }) as never,
    });
    expect((await provider.describeKek('a')).state).toBe('enabled');
    expect((await provider.describeKek('b')).state).toBe('disabled');
    expect((await provider.describeKek('c')).state).toBe('pending-deletion');
    expect((await provider.describeKek('d')).state).toBe('disabled');
    expect((await provider.describeKek('gone')).state).toBe('missing');
  });

  it('passes the wrap context as the encryption context on Encrypt and Decrypt', async () => {
    const seen: unknown[] = [];
    const provider = awsKmsKekProvider({
      send: (async (cmd: EncryptCommand | DecryptCommand) => {
        seen.push(cmd);
        if (cmd instanceof EncryptCommand) return { CiphertextBlob: new Uint8Array([9, 9]) };
        return { Plaintext: new Uint8Array([1, 2, 3]) };
      }) as never,
    });
    expect([...(await provider.wrapDataKey('arn:k', Buffer.from([1, 2, 3]), CTX))]).toEqual([9, 9]);
    expect([...(await provider.unwrapDataKey('arn:k', Buffer.from([9, 9]), CTX))]).toEqual([1, 2, 3]);
    expect(seen[0]).toBeInstanceOf(EncryptCommand);
    expect((seen[0] as EncryptCommand).input).toMatchObject({ KeyId: 'arn:k', EncryptionContext: CTX });
    expect(seen[1]).toBeInstanceOf(DecryptCommand);
    expect((seen[1] as DecryptCommand).input).toMatchObject({ KeyId: 'arn:k', EncryptionContext: CTX });
  });

  it('turns KMS refusals into typed KekUnavailableError codes', async () => {
    const cases: [string, string][] = [
      ['DisabledException', 'kek-disabled'],
      ['KMSInvalidStateException', 'kek-pending-deletion'],
      ['NotFoundException', 'kek-missing'],
      ['AccessDeniedException', 'kek-access-denied'],
      ['InvalidCiphertextException', 'kek-access-denied'],
      ['ThrottlingException', 'kek-unreachable'],
    ];
    for (const [name, code] of cases) {
      const provider: KekProvider = awsKmsKekProvider({ send: (async () => { throw awsError(name); }) as never });
      expect(await codeOf(provider.unwrapDataKey('arn:k', Buffer.from([1]), CTX))).toBe(code);
      expect(await codeOf(provider.wrapDataKey('arn:k', Buffer.from([1]), CTX))).toBe(code);
    }
  });
});

const GCP_REF = 'projects/p/locations/europe-west1/keyRings/r/cryptoKeys/k';

function gcp(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = gcpKmsKekProvider({
    accessToken: async () => 'tok-1',
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as never,
  });
  return { provider, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('gcp-kms', () => {
  it('maps primary version states, and a 404 to missing', async () => {
    for (const [state, expected] of [['ENABLED', 'enabled'], ['DISABLED', 'disabled'], ['DESTROY_SCHEDULED', 'pending-deletion'], ['DESTROYED', 'missing']]) {
      const { provider } = gcp(() => json(200, { primary: { state } }));
      expect((await provider.describeKek(GCP_REF)).state).toBe(expected);
    }
    const { provider } = gcp(() => json(404, { error: { status: 'NOT_FOUND', message: 'no key' } }));
    expect((await provider.describeKek(GCP_REF)).state).toBe('missing');
  });

  it('sends the bearer token and the wrap context as additional authenticated data', async () => {
    const dek = Buffer.from('0123456789abcdef0123456789abcdef');
    const { provider, calls } = gcp((url) =>
      url.endsWith(':encrypt') ? json(200, { ciphertext: Buffer.from('wrapped').toString('base64') }) : json(200, { plaintext: dek.toString('base64') }));
    const wrapped = await provider.wrapDataKey(GCP_REF, dek, CTX);
    expect(wrapped.toString()).toBe('wrapped');
    expect((await provider.unwrapDataKey(GCP_REF, wrapped, CTX)).equals(dek)).toBe(true);
    expect(calls[0]!.url).toBe(`https://cloudkms.googleapis.com/v1/${GCP_REF}:encrypt`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(Buffer.from(body.plaintext, 'base64').equals(dek)).toBe(true);
    expect(body.additionalAuthenticatedData).toBe(canonicalWrapContext(CTX).toString('base64'));
    expect(JSON.parse(String(calls[1]!.init.body)).additionalAuthenticatedData).toBe(body.additionalAuthenticatedData);
  });

  it('turns Cloud KMS errors into typed codes and refuses a malformed key reference', async () => {
    const cases: [Response | Error, string][] = [
      [json(400, { error: { status: 'FAILED_PRECONDITION', message: 'CryptoKeyVersion is not enabled' } }), 'kek-disabled'],
      [json(400, { error: { status: 'FAILED_PRECONDITION', message: 'version is scheduled for destruction' } }), 'kek-pending-deletion'],
      [json(403, { error: { status: 'PERMISSION_DENIED', message: 'denied' } }), 'kek-access-denied'],
      [json(400, { error: { status: 'INVALID_ARGUMENT', message: 'Decryption failed' } }), 'kek-access-denied'],
      [json(404, { error: { status: 'NOT_FOUND', message: 'gone' } }), 'kek-missing'],
      [json(503, { error: { status: 'UNAVAILABLE', message: 'try later' } }), 'kek-unreachable'],
      [new TypeError('fetch failed'), 'kek-unreachable'],
    ];
    for (const [outcome, code] of cases) {
      const { provider } = gcp(() => { if (outcome instanceof Error) throw outcome; return outcome; });
      expect(await codeOf(provider.unwrapDataKey(GCP_REF, Buffer.from([1]), CTX))).toBe(code);
    }
    const { provider, calls } = gcp(() => json(200, {}));
    await expect(provider.wrapDataKey('arn:aws:kms:not-gcp', Buffer.from([1]), CTX)).rejects.toThrow(/cryptoKeys/);
    expect(calls).toHaveLength(0);
  });
});
