/**
 * Generic secret REFERENCE resolver for EgressProvider backends (B-PROV) — mirrors the
 * `credentialRef` convention (`accounts:register`, `inference-gateway/credential-store.ts`'s
 * `parseCredentialRef`): callers pass a REFERENCE (`env:NAME` | `file:<path>` | an absolute/`~` path |
 * a pinned regional Secret Manager resource reference, never the literal secret,
 * so provider config is safe to log/persist/federate. Resolution happens
 * only at the point of use (e.g. building a REST auth header), never eagerly.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';

const GCP_SECRET_PREFIX = 'gcp-secret:';
// Secret Manager canonicalizes project IDs to numbers in its response. Requiring the
// canonical number keeps the returned-name check exact without trusting an alias.
const GCP_SECRET_RESOURCE = /^projects\/([1-9][0-9]*)\/(?:locations\/([a-z]+(?:-[a-z0-9]+)+)\/)?secrets\/([A-Za-z0-9_-]{1,255})\/versions\/([1-9][0-9]*|latest)$/;

/** A resource name, never a URL: callers cannot redirect the credential to another host. */
export function parseGcpSecretReference(reference: string): { resource: string; endpoint: string; version: string } | null {
  const ref = reference.trim();
  if (!ref.startsWith(GCP_SECRET_PREFIX)) return null;
  const resource = ref.slice(GCP_SECRET_PREFIX.length);
  const match = GCP_SECRET_RESOURCE.exec(resource);
  if (!match) throw new Error('gcp_secret_ref_malformed');
  const location = match[2];
  return {
    resource,
    endpoint: location ? `https://secretmanager.${location}.rep.googleapis.com` : 'https://secretmanager.googleapis.com',
    version: match[4]!,
  };
}

export function assertPinnedGcpSecretReference(reference: string): void {
  const parsed = parseGcpSecretReference(reference);
  if (!parsed || parsed.version === 'latest') throw new Error('gcp_secret_ref_requires_pinned_secret_manager');
}

export interface SecretRefDependencies {
  readonly fetch?: typeof fetch;
  readonly accessToken?: () => Promise<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

async function gcpAccessToken(env: Readonly<Record<string, string | undefined>>): Promise<string> {
  const { Compute, GoogleAuth } = await import('google-auth-library');
  // Production must use the attached VM identity, never a dev-box ADC login or key file.
  const token = env.PAPERCUSP_DEPLOYMENT_ENVIRONMENT === 'production'
    ? (await new Compute({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getAccessToken()).token
    : await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getAccessToken();
  if (!token) throw new Error('gcp_secret_ref_identity_unavailable');
  return token;
}

function crc32c(data: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

async function readGcpSecret(reference: string, dependencies: SecretRefDependencies): Promise<string> {
  const parsed = parseGcpSecretReference(reference)!;
  try {
    const token = await (dependencies.accessToken ?? (() => gcpAccessToken(dependencies.env ?? process.env)))();
    if (!token) throw new Error('identity_unavailable');
    const response = await (dependencies.fetch ?? fetch)(`${parsed.endpoint}/v1/${parsed.resource}:access`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('access_denied');
    const body = await response.json() as { name?: unknown; payload?: { data?: unknown; dataCrc32c?: unknown } };
    if (body.name !== parsed.resource && (parsed.version !== 'latest' ||
        typeof body.name !== 'string' || !body.name.startsWith(parsed.resource.slice(0, -'latest'.length)) ||
        !/^[1-9][0-9]*$/.test(body.name.slice(parsed.resource.length - 'latest'.length)))) {
      throw new Error('resource_mismatch');
    }
    const encoded = body.payload?.data;
    if (typeof encoded !== 'string' || encoded.length > 87_384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('payload_invalid');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 65_536) throw new Error('payload_invalid');
    if (body.payload?.dataCrc32c !== crc32c(bytes)) throw new Error('checksum_mismatch');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if (!value) throw new Error('empty_value');
    return value;
  } catch {
    // Provider errors and bodies can contain credentials. Expose only a fixed code.
    throw new Error('gcp_secret_ref_resolution_failed');
  }
}

/** Injectable network/identity seam; the default is the host's existing Google auth library. */
export function createSecretRefResolver(dependencies: SecretRefDependencies = {}): (ref: string) => Promise<string> {
  return (ref) => resolveSecretReference(ref, dependencies);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

/**
 * Resolve a secret reference to its value. `env:NAME` reads `process.env[NAME]`; `file:<path>` |
 * an absolute path | a `~`-path reads the (trimmed) file contents. Throws a descriptive error if the
 * reference is malformed or unresolvable — callers should let this surface, not swallow it (a silent
 * empty-string credential produces a confusing downstream 401, not a clear "you forgot to set it").
 */
async function resolveSecretReference(ref: string, dependencies: SecretRefDependencies): Promise<string> {
  const trimmedRef = ref.trim();
  if (trimmedRef.startsWith(GCP_SECRET_PREFIX)) return readGcpSecret(trimmedRef, dependencies);
  if (trimmedRef.startsWith('env:')) {
    const name = trimmedRef.slice(4).trim();
    if (!name) throw new Error(`egress: malformed secret ref '${ref}' (expected env:NAME)`);
    const value = process.env[name];
    if (!value) throw new Error(`egress: env var '${name}' is not set (referenced by 'env:${name}')`);
    return value;
  }
  const path = trimmedRef.startsWith('file:')
    ? expandHome(trimmedRef.slice(5))
    : trimmedRef.startsWith('/') || trimmedRef.startsWith('~')
      ? expandHome(trimmedRef)
      : null;
  if (!path) {
    throw new Error(`egress: unsupported secret ref '${ref}' (expected env:NAME | file:<path> | an absolute/~ path)`);
  }
  const raw = await fs.readFile(path, 'utf8');
  const value = raw.trim();
  if (!value) throw new Error(`egress: secret file '${path}' is empty`);
  return value;
}

/** Includes regional/global Secret Manager references alongside the existing env/file kinds. */
export const resolveSecretRef = createSecretRefResolver();
