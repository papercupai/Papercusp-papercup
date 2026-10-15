/**
 * Third-party INTEGRATION credentials — a generic PG-backed secret store
 * for API keys that don't belong in `operator_credentials` (the closed
 * 4-key platform allowlist: openai/anthropic/zeroentropy/github_pat, see
 * `setup:save_key`) or `operator_search_provider_credentials` (OMP web
 * search only).
 *
 * Storage policy (repo CLAUDE.md): a secret NEVER goes into a tree file.
 * When a user hands over a third-party provider key for a feature (e.g. a
 * WeatherAPI key for a weather widget — owner-ask-batch-2026-07-06 P-002),
 * it is written here instead — `harness_shared.operator_integration_credentials`
 * (migration 526), encrypted at rest via pgcrypto (see db-encryption.ts
 * ENCRYPTED_TABLES), single-row-per-workspace, NOT in the zero_harness
 * publication (never broadcast over WS).
 *
 * Shape mirrors search-provider-credentials.ts: opaque `Record<string,
 * string>` keyed by a caller-chosen name (e.g. `WEATHERAPI_API_KEY`) so
 * adding a new integration never needs a schema/migration change — only a
 * new key name.
 */
import { readOperatorState, updateOperatorState } from './operator-state-pg';
import { createHash } from 'node:crypto';
import { captureElevenLabsCredentialReceipt, provisionElevenLabsRestrictedCredential,
  readElevenLabsRestrictedCredential, readElevenLabsImmutableProfile,
  type ElevenLabsAgentDefinition, type ElevenLabsCredentialReceipt } from './voice-engines/elevenlabs-agent-sync';

export type IntegrationCredentials = Record<string, string>;

async function readAll(): Promise<IntegrationCredentials> {
  const raw = await readOperatorState<IntegrationCredentials>('operator_integration_credentials');
  return raw && typeof raw === 'object' ? raw : {};
}

/** Read all configured integration keys. Server-side only — full values. */
export async function readIntegrationCredentials(): Promise<IntegrationCredentials> {
  return readAll();
}

/** Read a single integration key's raw value (server-side only). */
export async function readIntegrationKey(name: string): Promise<string | undefined> {
  const all = await readAll();
  return all[name];
}

/**
 * Upsert one or more integration keys. Only names present in `partial` are
 * touched; pass an empty string or null to clear a key.
 */
export async function writeIntegrationCredentials(
  partial: Record<string, string | null>,
): Promise<IntegrationCredentials> {
  if (Object.keys(partial).some(name => name.startsWith(TRUSTED_RECEIPT_PREFIX))) {
    throw new Error('Trusted credential receipts require server provisioning');
  }
  return updateIntegrationCredentials(partial);
}

// Outside setup:save_integration_key's SCREAMING_SNAKE_CASE namespace. Receipt
// metadata is server-only, including its masked form.
const TRUSTED_RECEIPT_PREFIX = '__papercusp_trusted_elevenlabs_receipt:';

/** Server-only composition of authenticated provisioning and encrypted storage.
 * Host policy supplies every restriction; this is not a browser receipt route.
 * Failure may leave a remote key, so callers must reconcile before retrying. */
export async function provisionElevenLabsIntegrationCredential(options: Omit<
  Parameters<typeof provisionElevenLabsRestrictedCredential>[0], 'secretRef' | 'persist'
> & { integrationName: string }): Promise<{ keyId: string } | null> {
  const integrationName = options.integrationName;
  if (!/^[A-Z][A-Z0-9_]{2,254}$/.test(integrationName)) return null;
  return provisionElevenLabsRestrictedCredential({ ...options,
    secretRef: `integration:${integrationName}`,
    persist: async ({ apiKey, receipt }) => {
      const stored = await storeElevenLabsCreatedCredential({ name: integrationName,
        serviceAccountUserId: receipt.serviceAccountUserId,
        createResponse: { 'xi-api-key': apiKey, key_id: receipt.keyId } });
      if (!stored) throw new Error('Credential persistence refused');
    },
  });
}

/** Server-only persistence boundary. The provisioning host must authenticate
 * the create response itself; this function must never be exposed as a route
 * accepting browser-supplied receipts or provider list metadata. */
export async function storeElevenLabsCreatedCredential(options: {
  name: string; serviceAccountUserId: string; createResponse: unknown;
}): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_]{2,254}$/.test(options.name)) return false;
  const captured = captureElevenLabsCredentialReceipt({ secretRef: `integration:${options.name}`,
    serviceAccountUserId: options.serviceAccountUserId, createResponse: options.createResponse });
  if (!captured) return false;
  await updateIntegrationCredentials({ [options.name]: captured.apiKey,
    [TRUSTED_RECEIPT_PREFIX + options.name]: JSON.stringify(captured.receipt) });
  return true;
}

/** Resolve both halves from ONE encrypted snapshot. This proves local binding,
 * not current provider permissions; callers still need fresh remote admission. */
export async function readElevenLabsCredentialPair(name: string): Promise<{
  apiKey: string; receipt: ElevenLabsCredentialReceipt;
} | null> {
  if (!/^[A-Z][A-Z0-9_]{2,254}$/.test(name)) return null;
  const all = await readAll();
  const apiKey = all[name];
  const raw = all[TRUSTED_RECEIPT_PREFIX + name];
  if (typeof apiKey !== 'string' || !apiKey || typeof raw !== 'string') return null;
  try {
    const receipt = JSON.parse(raw);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
    const captured = captureElevenLabsCredentialReceipt({ secretRef: `integration:${name}`,
      serviceAccountUserId: receipt.serviceAccountUserId,
      createResponse: { 'xi-api-key': apiKey, key_id: receipt.keyId } });
    if (!captured || receipt.secretRef !== captured.receipt.secretRef
      || receipt.secretSha256 !== createHash('sha256').update(apiKey).digest('hex')) return null;
    return captured;
  } catch { return null; }
}

/** Server-only admission, immediately before issuance. Policy comes from the
 * host, never a request body. No cached attestation or generic voice-key fallback.
 * The returned secret must stay in the server's token provider. */
export async function readAdmittedElevenLabsIntegrationCredential(options: {
  integrationName: string; metadataApiKey: string; allowedPermissions: readonly string[];
  maximumCredits: number; definition: ElevenLabsAgentDefinition; toolIds: string[];
  agentId: string; fetch: typeof fetch; signal: AbortSignal;
}): Promise<{ apiKey: string; keyId: string; agentId: string; maximumSeconds: number } | null> {
  const policy = { ...options, allowedPermissions: [...options.allowedPermissions],
    definition: structuredClone(options.definition), toolIds: [...options.toolIds] };
  if (policy.signal.aborted) return null;
  try {
    const pair = await readElevenLabsCredentialPair(policy.integrationName);
    if (!pair || policy.signal.aborted) return null;
    const restriction = await readElevenLabsRestrictedCredential({ ...policy, ...pair,
      secretRef: `integration:${policy.integrationName}` });
    if (!restriction || policy.signal.aborted) return null;
    const profile = await readElevenLabsImmutableProfile(policy.definition, policy.toolIds,
      { apiKey: pair.apiKey, agentId: policy.agentId, fetch: policy.fetch, signal: policy.signal });
    if (!profile || policy.signal.aborted) return null;
    // A save/rotation during remote admission invalidates this result.
    const current = await readElevenLabsCredentialPair(policy.integrationName);
    if (!current || current.apiKey !== pair.apiKey
      || JSON.stringify(current.receipt) !== JSON.stringify(pair.receipt) || policy.signal.aborted) return null;
    return { apiKey: pair.apiKey, keyId: restriction.keyId, ...profile };
  } catch { return null; }
}

async function updateIntegrationCredentials(partial: Record<string, string | null>): Promise<IntegrationCredentials> {
  // Snapshot before awaiting the store; callers cannot mutate a pending save.
  const entries = Object.entries(partial);
  return updateOperatorState<IntegrationCredentials>('operator_integration_credentials', {}, (current) => {
    const next = { ...current };
    for (const [k, v] of entries) {
      if (v === null || v === '') {
        delete next[k];
      } else if (typeof v === 'string') {
        next[k] = v.trim();
      }
    }
    return next;
  });
}

/** Mask a key for client display / logs: 'sk-...AbCd'. Null when too short. */
export function maskIntegrationKey(value: string | undefined | null): string | null {
  if (!value || value.length < 8) return null;
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

/** Masked view of every configured integration key — safe to log/return to a client. */
export async function readMaskedIntegrationView(): Promise<Record<string, string | null>> {
  const all = await readAll();
  const out: Record<string, string | null> = {};
  for (const k of Object.keys(all)) {
    if (!k.startsWith(TRUSTED_RECEIPT_PREFIX)) out[k] = maskIntegrationKey(all[k]);
  }
  return out;
}
