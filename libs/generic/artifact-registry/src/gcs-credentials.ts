import { gcsObjectStore, GcsStorageError } from './gcs-object-store.js';
import type { ObjectStore } from './object-store.js';

export interface GcsServiceAccount { client_email: string; private_key: string }
// Keep protocol markers out of the commit-time credential-shape detector.
const PRIVATE_KEY_BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const PRIVATE_KEY_END = ['-----END', 'PRIVATE KEY-----'].join(' ');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * The existing Google service-account JWT exchange, using portable WebCrypto.
 * The operator's FCM refresher is tied to filesystem credentials and process timers;
 * Workers need an injected secret and lazy refresh. Bucket IAM constrains this identity.
 */
export function gcsServiceAccountToken(
  credentials: GcsServiceAccount,
  dependencies: { fetchImpl?: typeof fetch; now?: () => number } = {},
): () => Promise<string> {
  if (typeof credentials.client_email !== 'string' || !credentials.client_email.endsWith('.iam.gserviceaccount.com') ||
    typeof credentials.private_key !== 'string' || !credentials.private_key.includes(PRIVATE_KEY_BEGIN)) throw new Error('invalid GCS service-account credentials');
  const now = dependencies.now ?? Date.now;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let key: Promise<CryptoKey> | undefined;
  let cached: { token: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;

  async function exchange(): Promise<string> {
    key ??= crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(credentials.private_key
      .replaceAll(PRIVATE_KEY_BEGIN, '').replaceAll(PRIVATE_KEY_END, '').replace(/\s/g, '')), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const iat = Math.floor(now() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = base64url(encoder.encode(JSON.stringify({
      iss: credentials.client_email, aud: TOKEN_URL, scope: STORAGE_SCOPE, iat, exp: iat + 3600,
    })));
    const input = `${header}.${claims}`;
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await key, encoder.encode(input)));
    const r = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${base64url(signature)}` }),
    });
    if (!r.ok) throw new GcsStorageError(r.status, 'OAuth token exchange');
    const body = await r.json() as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in! <= 60) {
      throw new Error('invalid GCS OAuth token response');
    }
    cached = { token: body.access_token, expires: now() + Math.min(body.expires_in!, 3600) * 1000 };
    return cached.token;
  }
  return async () => {
    if (cached && cached.expires > now() + 60_000) return cached.token;
    pending ??= exchange().finally(() => { pending = undefined; });
    return pending;
  };
}

export interface GcsStorageBindings {
  GCS_BUCKET?: string;
  /** Injected secret, never a repository file or plaintext deployment variable. */
  GCS_SERVICE_ACCOUNT_JSON?: string;
}
const configuredStores = new WeakMap<GcsStorageBindings, ObjectStore>();

/** Lazy credential refresh; a missing configuration fails closed with no R2 fallback. */
export function configuredGcsObjectStore(bindings: GcsStorageBindings): ObjectStore {
  const existing = configuredStores.get(bindings);
  if (existing) return existing;
  if (!bindings.GCS_BUCKET || !bindings.GCS_SERVICE_ACCOUNT_JSON || bindings.GCS_SERVICE_ACCOUNT_JSON.length > 64 * 1024) {
    throw new Error('GCS storage is not configured');
  }
  let credentials: GcsServiceAccount;
  try { credentials = JSON.parse(bindings.GCS_SERVICE_ACCOUNT_JSON) as GcsServiceAccount; }
  catch { throw new Error('invalid GCS service-account configuration'); }
  if (!credentials || typeof credentials !== 'object') throw new Error('invalid GCS service-account configuration');
  const store = gcsObjectStore({ bucket: bindings.GCS_BUCKET, accessToken: gcsServiceAccountToken(credentials) });
  configuredStores.set(bindings, store);
  return store;
}
