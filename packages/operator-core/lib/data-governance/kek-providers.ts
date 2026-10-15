/**
 * Customer-managed key-encryption key (KEK) providers for organization envelope encryption
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b, WI-6554700010012353; decision D-020).
 *
 * The KEK lives in the CUSTOMER's KMS. Papercusp never holds it: it asks the KMS to wrap and
 * unwrap the organization's data-encryption keys (DEKs). One seam, three providers:
 *  - `aws-kms`: AWS KMS Encrypt/Decrypt/DescribeKey with an encryption context. It takes the
 *    `KMSClient` the workspace host already builds (workspace-host/aws-sdk-client.ts).
 *  - `gcp-kms`: Cloud KMS v1 REST encrypt/decrypt/get with additional authenticated data. It takes
 *    an access-token source, such as the one workspace-host/hosted-gcp-auth.ts resolves. Cloud KMS
 *    has no generate-data-key call, so the DEK is generated locally and wrapped.
 *  - `test-kms`: in-process AES-256-GCM, for tests and local development. Its keys can be
 *    disabled, re-enabled and destroyed, so the revocation and recovery journeys run without a cloud.
 *
 * Every provider binds the wrapped DEK to its context (organization, DEK version) so a wrapped DEK
 * cannot be replayed for another organization. KMS refusals become a typed `KekUnavailableError`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptCommand, DescribeKeyCommand, EncryptCommand, type KMSClient } from '@aws-sdk/client-kms';

export const KEK_PROVIDER_IDS = ['aws-kms', 'gcp-kms', 'test-kms'] as const;
export type KekProviderId = (typeof KEK_PROVIDER_IDS)[number];

/**
 * What the KMS reports about a KEK. `pending-deletion` is still recoverable at the KMS
 * (AWS deletion window, GCP DESTROY_SCHEDULED). `missing` means the KMS does not know the key:
 * a destroyed key and a wrong reference look the same, so `missing` never shreds by itself.
 */
export type KekState = 'enabled' | 'disabled' | 'pending-deletion' | 'missing';

export type KekUnavailableCode = 'kek-disabled' | 'kek-pending-deletion' | 'kek-missing' | 'kek-access-denied' | 'kek-unreachable';

export class KekUnavailableError extends Error {
  readonly code: KekUnavailableCode;
  readonly providerId: KekProviderId;
  constructor(providerId: KekProviderId, code: KekUnavailableCode, detail: string) {
    super(`${providerId}: ${code}: ${detail}`);
    this.name = 'KekUnavailableError';
    this.code = code;
    this.providerId = providerId;
  }
}

/** Wrap context. Values are bound into the wrap (AWS encryption context, GCP AAD, test AAD). */
export type KekWrapContext = Readonly<Record<string, string>>;

/** The wrap-context key naming the organization. Customer key policies condition on it (AWS). */
export const KEK_CONTEXT_ORGANIZATION_KEY = 'organization';

export interface KekProvider {
  readonly providerId: KekProviderId;
  /**
   * `context` names the organization asking (`organization` key), so a provider that acts through a
   * per-organization identity (gcp-kms, D-397) can mint that identity's token for a describe as well.
   */
  describeKek(kekRef: string, context?: KekWrapContext): Promise<{ readonly state: KekState }>;
  wrapDataKey(kekRef: string, dek: Buffer, context: KekWrapContext): Promise<Buffer>;
  unwrapDataKey(kekRef: string, wrappedDek: Buffer, context: KekWrapContext): Promise<Buffer>;
}

/** Stable serialization of a wrap context, used as AAD where the KMS takes bytes. */
export function canonicalWrapContext(context: KekWrapContext): Buffer {
  const keys = Object.keys(context).sort();
  return Buffer.from(JSON.stringify(keys.map((k) => [k, context[k]])), 'utf8');
}

// ── AWS KMS ─────────────────────────────────────────────────────────────────────────────────────

function awsErrorName(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? '';
}

function awsUnavailable(err: unknown): KekUnavailableError {
  const name = awsErrorName(err);
  const message = (err as Error | null)?.message ?? String(err);
  if (name === 'DisabledException') return new KekUnavailableError('aws-kms', 'kek-disabled', message);
  if (name === 'KMSInvalidStateException') return new KekUnavailableError('aws-kms', 'kek-pending-deletion', message);
  if (name === 'NotFoundException') return new KekUnavailableError('aws-kms', 'kek-missing', message);
  if (name === 'AccessDeniedException' || name === 'InvalidCiphertextException' || name === 'IncorrectKeyException') {
    return new KekUnavailableError('aws-kms', 'kek-access-denied', message);
  }
  return new KekUnavailableError('aws-kms', 'kek-unreachable', message);
}

export function awsKmsKekProvider(kms: Pick<KMSClient, 'send'>): KekProvider {
  return {
    providerId: 'aws-kms',
    async describeKek(kekRef) {
      try {
        const out = await kms.send(new DescribeKeyCommand({ KeyId: kekRef }));
        const state = out.KeyMetadata?.KeyState;
        if (state === 'Enabled') return { state: 'enabled' };
        if (state === 'PendingDeletion' || state === 'PendingReplicaDeletion') return { state: 'pending-deletion' };
        return { state: 'disabled' };
      } catch (err) {
        if (awsErrorName(err) === 'NotFoundException') return { state: 'missing' };
        throw awsUnavailable(err);
      }
    },
    async wrapDataKey(kekRef, dek, context) {
      try {
        const out = await kms.send(new EncryptCommand({ KeyId: kekRef, Plaintext: dek, EncryptionContext: { ...context } }));
        if (!out.CiphertextBlob?.length) throw new Error('KMS Encrypt returned no ciphertext');
        return Buffer.from(out.CiphertextBlob);
      } catch (err) {
        if (err instanceof KekUnavailableError) throw err;
        throw awsUnavailable(err);
      }
    },
    async unwrapDataKey(kekRef, wrappedDek, context) {
      try {
        const out = await kms.send(new DecryptCommand({ KeyId: kekRef, CiphertextBlob: wrappedDek, EncryptionContext: { ...context } }));
        if (!out.Plaintext?.length) throw new Error('KMS Decrypt returned no plaintext');
        return Buffer.from(out.Plaintext);
      } catch (err) {
        if (err instanceof KekUnavailableError) throw err;
        throw awsUnavailable(err);
      }
    },
  };
}

/**
 * A customer KEK is referenced by its full key ARN or alias ARN. A bare key id or alias would resolve
 * in Papercusp's own account, so it is refused: the KEK must live in the customer's account.
 */
const AWS_KMS_KEK_ARN = /^arn:(aws|aws-cn|aws-us-gov):kms:([a-z]{2}(?:-[a-z]+)+-\d+):(\d{12}):(?:key|alias)\/[A-Za-z0-9/_-]+$/;

export function awsKmsKekRegion(kekRef: string): string {
  const match = AWS_KMS_KEK_ARN.exec(kekRef);
  if (!match) throw new Error(`aws-kms: KEK reference must be a key or alias ARN in the customer account, got ${kekRef}`);
  return match[2];
}

/**
 * An `aws-kms` provider that sends each call to the KMS of the region named in the KEK's ARN.
 * One client per region is created on first use and reused.
 */
export function regionalAwsKmsKekProvider(createClient: (region: string) => Pick<KMSClient, 'send'>): KekProvider {
  const byRegion = new Map<string, KekProvider>();
  const forRef = (kekRef: string): KekProvider => {
    const region = awsKmsKekRegion(kekRef);
    let provider = byRegion.get(region);
    if (!provider) {
      provider = awsKmsKekProvider(createClient(region));
      byRegion.set(region, provider);
    }
    return provider;
  };
  return {
    providerId: 'aws-kms',
    describeKek: (kekRef, context) => forRef(kekRef).describeKek(kekRef, context),
    wrapDataKey: (kekRef, dek, context) => forRef(kekRef).wrapDataKey(kekRef, dek, context),
    unwrapDataKey: (kekRef, wrappedDek, context) => forRef(kekRef).unwrapDataKey(kekRef, wrappedDek, context),
  };
}

/**
 * The key-policy statement a customer adds to their KMS key. Papercusp calls AWS KMS as one principal
 * for every organization, so the grant is bound to the organization through the encryption context:
 * a request made for any other organization does not match the condition and KMS refuses it.
 * DescribeKey takes no encryption context, so it is granted separately and reveals only the key state.
 */
export function awsKmsKekPolicyStatements(input: { organizationId: string; papercuspPrincipalArn: string }) {
  return [
    {
      Sid: 'PapercuspOrganizationEnvelope',
      Effect: 'Allow',
      Principal: { AWS: input.papercuspPrincipalArn },
      Action: ['kms:Encrypt', 'kms:Decrypt'],
      Resource: '*',
      Condition: { StringEquals: { [`kms:EncryptionContext:${KEK_CONTEXT_ORGANIZATION_KEY}`]: input.organizationId } },
    },
    {
      Sid: 'PapercuspOrganizationKeyState',
      Effect: 'Allow',
      Principal: { AWS: input.papercuspPrincipalArn },
      Action: ['kms:DescribeKey'],
      Resource: '*',
    },
  ] as const;
}

// ── Google Cloud KMS ────────────────────────────────────────────────────────────────────────────

export const GCP_KMS_ENDPOINT = 'https://cloudkms.googleapis.com/v1';
const GCP_CRYPTO_KEY_REF = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

export interface GcpKmsKekProviderOptions {
  /**
   * OAuth access token with the cloudkms scope for the identity acting for `context.organization`
   * (organization-key-registry.ts mints it through that organization's own delegation account).
   */
  readonly accessToken: (context: KekWrapContext) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly endpoint?: string;
}

function gcpRef(kekRef: string): string {
  if (!GCP_CRYPTO_KEY_REF.test(kekRef)) {
    throw new Error(`gcp-kms: KEK reference must be projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>, got ${kekRef}`);
  }
  return kekRef;
}

async function gcpUnavailable(res: Response): Promise<KekUnavailableError> {
  let status = '';
  let message = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { status?: string; message?: string } };
    status = body.error?.status ?? '';
    message = body.error?.message ?? message;
  } catch { /* non-JSON error body */ }
  if (res.status === 404 || status === 'NOT_FOUND') return new KekUnavailableError('gcp-kms', 'kek-missing', message);
  if (res.status === 403 || res.status === 401 || status === 'PERMISSION_DENIED') {
    return new KekUnavailableError('gcp-kms', 'kek-access-denied', message);
  }
  if (status === 'FAILED_PRECONDITION') {
    // Cloud KMS reports a scheduled destruction as "current state is: DESTROY_SCHEDULED" or as "scheduled for destruction".
    return /destroy|destruction/i.test(message)
      ? new KekUnavailableError('gcp-kms', 'kek-pending-deletion', message)
      : new KekUnavailableError('gcp-kms', 'kek-disabled', message);
  }
  if (res.status === 400 && status === 'INVALID_ARGUMENT') return new KekUnavailableError('gcp-kms', 'kek-access-denied', message);
  return new KekUnavailableError('gcp-kms', 'kek-unreachable', message);
}

export function gcpKmsKekProvider(options: GcpKmsKekProviderOptions): KekProvider {
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = (options.endpoint ?? GCP_KMS_ENDPOINT).replace(/\/+$/, '');

  async function call(path: string, context: KekWrapContext, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<Response> {
    let token: string;
    try {
      token = await options.accessToken(context);
    } catch (err) {
      if (err instanceof KekUnavailableError) throw err;
      throw new KekUnavailableError('gcp-kms', 'kek-access-denied', `no access token: ${(err as Error).message}`);
    }
    try {
      return await fetchImpl(`${endpoint}/${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (err) {
      throw new KekUnavailableError('gcp-kms', 'kek-unreachable', (err as Error).message);
    }
  }

  return {
    providerId: 'gcp-kms',
    async describeKek(kekRef, context = {}) {
      const res = await call(gcpRef(kekRef), context, { method: 'GET' });
      if (res.status === 404) return { state: 'missing' };
      if (!res.ok) throw await gcpUnavailable(res);
      const key = (await res.json()) as { primary?: { state?: string } };
      const state = key.primary?.state;
      if (state === 'ENABLED') return { state: 'enabled' };
      if (state === 'DESTROY_SCHEDULED') return { state: 'pending-deletion' };
      if (state === 'DESTROYED' || state === undefined) return { state: 'missing' };
      return { state: 'disabled' };
    },
    async wrapDataKey(kekRef, dek, context) {
      const res = await call(`${gcpRef(kekRef)}:encrypt`, context, {
        method: 'POST',
        body: { plaintext: dek.toString('base64'), additionalAuthenticatedData: canonicalWrapContext(context).toString('base64') },
      });
      if (!res.ok) throw await gcpUnavailable(res);
      const out = (await res.json()) as { ciphertext?: string };
      if (!out.ciphertext) throw new KekUnavailableError('gcp-kms', 'kek-unreachable', 'encrypt returned no ciphertext');
      return Buffer.from(out.ciphertext, 'base64');
    },
    async unwrapDataKey(kekRef, wrappedDek, context) {
      const res = await call(`${gcpRef(kekRef)}:decrypt`, context, {
        method: 'POST',
        body: { ciphertext: wrappedDek.toString('base64'), additionalAuthenticatedData: canonicalWrapContext(context).toString('base64') },
      });
      if (!res.ok) throw await gcpUnavailable(res);
      const out = (await res.json()) as { plaintext?: string };
      if (!out.plaintext) throw new KekUnavailableError('gcp-kms', 'kek-unreachable', 'decrypt returned no plaintext');
      return Buffer.from(out.plaintext, 'base64');
    },
  };
}

// ── In-process test KMS ─────────────────────────────────────────────────────────────────────────

export interface TestKekProvider extends KekProvider {
  createKek(kekRef: string): void;
  disableKek(kekRef: string): void;
  enableKek(kekRef: string): void;
  /** Destroys the key material. Wrapped DEKs under it can never be unwrapped again. */
  destroyKek(kekRef: string): void;
  /** Count of wrap and unwrap calls, so tests can prove a cache served a read. */
  readonly calls: { wrap: number; unwrap: number };
}

export function createTestKekProvider(): TestKekProvider {
  const keys = new Map<string, { material: Buffer; enabled: boolean }>();
  const calls = { wrap: 0, unwrap: 0 };

  function usable(kekRef: string): Buffer {
    const key = keys.get(kekRef);
    if (!key) throw new KekUnavailableError('test-kms', 'kek-missing', `no key ${kekRef}`);
    if (!key.enabled) throw new KekUnavailableError('test-kms', 'kek-disabled', `key ${kekRef} is disabled`);
    return key.material;
  }

  return {
    providerId: 'test-kms',
    calls,
    createKek(kekRef) {
      if (keys.has(kekRef)) throw new Error(`test-kms: key ${kekRef} exists`);
      keys.set(kekRef, { material: randomBytes(32), enabled: true });
    },
    disableKek(kekRef) {
      const key = keys.get(kekRef);
      if (key) key.enabled = false;
    },
    enableKek(kekRef) {
      const key = keys.get(kekRef);
      if (key) key.enabled = true;
    },
    destroyKek(kekRef) {
      keys.delete(kekRef);
    },
    async describeKek(kekRef) {
      const key = keys.get(kekRef);
      if (!key) return { state: 'missing' };
      return { state: key.enabled ? 'enabled' : 'disabled' };
    },
    async wrapDataKey(kekRef, dek, context) {
      calls.wrap += 1;
      const material = usable(kekRef);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', material, iv);
      cipher.setAAD(canonicalWrapContext(context));
      const body = Buffer.concat([cipher.update(dek), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async unwrapDataKey(kekRef, wrappedDek, context) {
      calls.unwrap += 1;
      const material = usable(kekRef);
      try {
        const decipher = createDecipheriv('aes-256-gcm', material, wrappedDek.subarray(0, 12));
        decipher.setAAD(canonicalWrapContext(context));
        decipher.setAuthTag(wrappedDek.subarray(12, 28));
        return Buffer.concat([decipher.update(wrappedDek.subarray(28)), decipher.final()]);
      } catch {
        throw new KekUnavailableError('test-kms', 'kek-access-denied', 'wrapped DEK does not authenticate under this key and context');
      }
    },
  };
}
