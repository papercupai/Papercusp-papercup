/**
 * Organization envelope encryption and the customer-controlled key lifecycle
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b, WI-6554700010012353; decision D-020).
 *
 * Each organization has data-encryption keys (DEKs), wrapped by a customer-managed key-encryption key
 * (KEK) in the customer's KMS (kek-providers.ts). Only wrapped DEKs are stored
 * (harness_shared.organization_data_keys, migration 1501). Plaintext DEKs live in a short in-process
 * cache.
 *
 * Envelope blob, version 2: [0x02][uint32 BE DEK version][12-byte IV][16-byte tag][ciphertext].
 * AES-256-GCM. The AAD binds the organization, the DEK version and the sealed scope (content,
 * embedding, telemetry, backup), so a ciphertext cannot be moved to another organization or scope.
 *
 * Lifecycle (D-020 items 3-6):
 *  - KEK rotation re-wraps every DEK under the new KEK. No content is re-encrypted.
 *  - DEK rotation creates a new active version. Older versions become decrypt-only. New writes use
 *    the new version at once; `reencrypt` and `sweep` move old ciphertext lazily.
 *  - Revocation makes every read and write of the organization fail closed with
 *    `OrganizationKeyUnavailableError` and evicts this process's caches. Another process notices
 *    within `cacheTtlMs`, or at once on a cache miss, because the KMS refuses to unwrap.
 *  - Recovery requires the KMS to report the KEK enabled and a test unwrap of the active DEK to work.
 *  - Shredding (the KEK is lost) is irreversible: wrapped DEKs are removed and the database refuses
 *    any transition out of `shredded`.
 * Every lifecycle operation writes a receipt through writeOrganizationDataReceipt in the same
 * transaction as its state change.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { appendOrganizationAuditEvent } from '../auth/hosted/governance';
import {
  KEK_CONTEXT_ORGANIZATION_KEY,
  KekUnavailableError,
  type KekProvider,
  type KekProviderId,
  type KekState,
  type KekWrapContext,
} from './kek-providers';
import {
  authorizeDataOperation,
  holdConflicts,
  writeOrganizationDataReceipt,
  type KeyLifecycleRecord,
  type KeyOperation,
  type ReceiptActor,
} from './organization-data-receipts';

export const ENVELOPE_VERSION = 0x02;
export const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const ENVELOPE_HEADER_BYTES = 1 + 4 + IV_BYTES + TAG_BYTES;
export const DEFAULT_KEY_CACHE_TTL_MS = 60_000;

export const SEALED_SCOPES = ['content', 'embedding', 'telemetry', 'backup'] as const;
export type SealedScope = (typeof SEALED_SCOPES)[number];

export class OrganizationKeyShredRefusedError extends Error {
  readonly code = 'legal-hold-active';
  constructor(readonly organizationId: string, readonly holdIds: readonly string[], readonly auditEventId: string) {
    super(`organization-keys: active legal holds prevent shredding organization ${organizationId}`);
    this.name = 'OrganizationKeyShredRefusedError';
  }
}

export type OrganizationKeyUnavailableCode =
  | 'organization-key-unprovisioned'
  | 'organization-key-revoked'
  | 'organization-key-shredded'
  | 'dek-version-unknown'
  | 'kek-unavailable'
  | 'envelope-malformed'
  | 'envelope-auth-failed';

/** The typed fail-closed error every read and write of a revoked or shredded organization throws. */
export class OrganizationKeyUnavailableError extends Error {
  readonly code: OrganizationKeyUnavailableCode;
  readonly organizationId: string;
  readonly kekCode?: KekUnavailableError['code'];
  constructor(organizationId: string, code: OrganizationKeyUnavailableCode, detail: string, kekCode?: KekUnavailableError['code']) {
    super(`organization ${organizationId}: ${code}: ${detail}`);
    this.name = 'OrganizationKeyUnavailableError';
    this.code = code;
    this.organizationId = organizationId;
    this.kekCode = kekCode;
  }
}

export function envelopeAad(organizationId: string, dekVersion: number, scope: SealedScope): Buffer {
  return Buffer.from(`papercusp.org-envelope.v2\u0000${organizationId}\u0000${dekVersion}\u0000${scope}`, 'utf8');
}

export function dekWrapContext(organizationId: string, dekVersion: number): KekWrapContext {
  return { purpose: 'papercusp-organization-dek', [KEK_CONTEXT_ORGANIZATION_KEY]: organizationId, dekVersion: String(dekVersion) };
}

/** The DEK version a blob was sealed under, or null when it is not a version-2 envelope. */
export function envelopeDekVersion(blob: Buffer): number | null {
  if (!Buffer.isBuffer(blob) || blob.length <= ENVELOPE_HEADER_BYTES || blob.readUInt8(0) !== ENVELOPE_VERSION) return null;
  return blob.readUInt32BE(1);
}

export function sealWithDek(dek: Buffer, organizationId: string, dekVersion: number, scope: SealedScope, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(envelopeAad(organizationId, dekVersion, scope));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(5);
  header.writeUInt8(ENVELOPE_VERSION, 0);
  header.writeUInt32BE(dekVersion, 1);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

// ── Blind index ──────────────────────────────────────────────────────────────────────────────────
// Sealed documents stay searchable through keyed tokens of their stemmed lexemes (migration 1503,
// organization-content-sealing.ts). Each DEK version has its own blind-index key, derived with HKDF
// so the DEK itself never keys an HMAC. Revoking or shredding the organization key makes the tokens
// unrecomputable together with the content.

export const BLIND_INDEX_SALT = 'papercusp-blind-index-v1';
/** 22 base64url characters carry 132 bits of the HMAC-SHA256 output. */
export const BLIND_TOKEN_CHARS = 22;

export interface BlindIndexKey {
  readonly dekVersion: number;
  readonly key: Buffer;
}

export function deriveBlindIndexKey(dek: Buffer, organizationId: string, dekVersion: number): Buffer {
  return Buffer.from(hkdfSync('sha256', dek, BLIND_INDEX_SALT, `${organizationId}:${dekVersion}`, 32));
}

/** The keyed token of one stemmed lexeme. Deterministic per key, so equal terms give equal tokens. */
export function blindToken(key: Buffer, term: string): string {
  return createHmac('sha256', key).update(term, 'utf8').digest('base64url').slice(0, BLIND_TOKEN_CHARS);
}

function openWithDek(dek: Buffer, organizationId: string, scope: SealedScope, blob: Buffer): Buffer {
  const dekVersion = blob.readUInt32BE(1);
  const iv = blob.subarray(5, 5 + IV_BYTES);
  const tag = blob.subarray(5 + IV_BYTES, ENVELOPE_HEADER_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(envelopeAad(organizationId, dekVersion, scope));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(ENVELOPE_HEADER_BYTES)), decipher.final()]);
  } catch {
    throw new OrganizationKeyUnavailableError(organizationId, 'envelope-auth-failed', `ciphertext does not authenticate for scope ${scope}`);
  }
}

// ── Service ──────────────────────────────────────────────────────────────────────────────────────

type CustodyState = 'enabled' | 'revoked' | 'shredded';
interface CustodyRow {
  organization_id: string;
  kek_provider: KekProviderId;
  kek_ref: string;
  kek_generation: number;
  state: CustodyState;
  active_dek_version: number;
}
interface DekRow {
  dek_version: number;
  kek_provider: KekProviderId;
  kek_ref: string;
  wrapped_dek: Buffer | null;
  state: 'active' | 'decrypt-only' | 'shredded';
}

/** Who asked, why, and which workspaces the organization owns (recorded in the receipt scope). */
export interface KeyOperationContext {
  readonly actor: ReceiptActor;
  readonly purpose: string;
  readonly workspaceIds: readonly string[];
}

/**
 * The in-process key cache: plaintext DEKs, custody rows and the organization's live DEK versions.
 * One cache can back many services. The process registry gives every database handle (including
 * each transaction handle) its own service but shares ONE cache, so a search inside a transaction
 * does not unwrap the DEK through the KMS again, and a revocation in one service evicts all of them.
 */
export interface OrganizationKeyCache {
  /** Zeroes and drops every cached plaintext DEK, custody row and version list. */
  clear(): void;
}

interface KeyCacheState extends OrganizationKeyCache {
  readonly deks: Map<string, { dek: Buffer; expiresAt: number }>;
  readonly custody: Map<string, { row: CustodyRow; expiresAt: number }>;
  readonly versions: Map<string, { versions: readonly number[]; expiresAt: number }>;
}

export function createOrganizationKeyCache(): OrganizationKeyCache {
  const state: KeyCacheState = {
    deks: new Map(),
    custody: new Map(),
    versions: new Map(),
    clear() {
      for (const entry of state.deks.values()) entry.dek.fill(0);
      state.deks.clear();
      state.custody.clear();
      state.versions.clear();
    },
  };
  return state;
}

export interface OrganizationKeyServiceOptions {
  readonly sql: Sql;
  readonly providers: Partial<Record<KekProviderId, KekProvider>>;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
  readonly writeReceipt?: typeof writeOrganizationDataReceipt;
  /** Default: a cache private to this service. */
  readonly cache?: OrganizationKeyCache;
}

export interface SweepResult {
  readonly examined: number;
  readonly reencrypted: number;
  readonly alreadyCurrent: number;
}

export function createOrganizationKeyService(options: OrganizationKeyServiceOptions) {
  const { sql } = options;
  const ttl = options.cacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const writeReceipt = options.writeReceipt ?? writeOrganizationDataReceipt;
  const cache = (options.cache ?? createOrganizationKeyCache()) as KeyCacheState;
  const dekCache = cache.deks;
  const custodyCache = cache.custody;
  const versionCache = cache.versions;

  function provider(id: KekProviderId): KekProvider {
    const p = options.providers[id];
    if (!p) throw new Error(`organization-keys: no KEK provider registered for ${id}`);
    return p;
  }

  /** Drops every cached DEK, custody row and version list of the organization in this process. */
  function evict(organizationId: string): void {
    custodyCache.delete(organizationId);
    versionCache.delete(organizationId);
    for (const key of [...dekCache.keys()]) {
      if (key.startsWith(`${organizationId}:`)) {
        dekCache.get(key)?.dek.fill(0);
        dekCache.delete(key);
      }
    }
  }

  async function readCustody(db: Sql, organizationId: string, forUpdate = false): Promise<CustodyRow | null> {
    const rows = forUpdate
      ? await db<CustodyRow[]>`SELECT * FROM harness_shared.organization_key_custody WHERE organization_id = ${organizationId} FOR UPDATE`
      : await db<CustodyRow[]>`SELECT * FROM harness_shared.organization_key_custody WHERE organization_id = ${organizationId}`;
    return rows[0] ?? null;
  }

  async function usableCustody(organizationId: string): Promise<CustodyRow> {
    const cached = custodyCache.get(organizationId);
    let row = cached && cached.expiresAt > now() ? cached.row : null;
    if (!row) {
      row = await readCustody(sql, organizationId);
      if (row) custodyCache.set(organizationId, { row, expiresAt: now() + ttl });
    }
    if (!row) throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-unprovisioned', 'no key custody is provisioned');
    if (row.state === 'revoked') throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-revoked', 'the KEK is revoked');
    if (row.state === 'shredded') throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-shredded', 'the keys are shredded');
    return row;
  }

  async function unwrap(organizationId: string, row: DekRow): Promise<Buffer> {
    if (row.state === 'shredded' || !row.wrapped_dek) {
      throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-shredded', `DEK version ${row.dek_version} is shredded`);
    }
    try {
      return await provider(row.kek_provider).unwrapDataKey(row.kek_ref, row.wrapped_dek, dekWrapContext(organizationId, row.dek_version));
    } catch (err) {
      if (err instanceof KekUnavailableError) {
        throw new OrganizationKeyUnavailableError(organizationId, 'kek-unavailable', err.message, err.code);
      }
      throw err;
    }
  }

  async function dekFor(organizationId: string, dekVersion: number): Promise<Buffer> {
    const key = `${organizationId}:${dekVersion}`;
    const cached = dekCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.dek;
    const rows = await sql<DekRow[]>`
      SELECT dek_version, kek_provider, kek_ref, wrapped_dek, state FROM harness_shared.organization_data_keys
       WHERE organization_id = ${organizationId} AND dek_version = ${dekVersion}`;
    if (!rows[0]) throw new OrganizationKeyUnavailableError(organizationId, 'dek-version-unknown', `no DEK version ${dekVersion}`);
    const dek = await unwrap(organizationId, rows[0]);
    dekCache.set(key, { dek, expiresAt: now() + ttl });
    return dek;
  }

  async function receipt(tx: Sql, operation: KeyOperation, organizationId: string, ctx: KeyOperationContext, keyLifecycle: KeyLifecycleRecord): Promise<string> {
    return writeReceipt({
      operation,
      scope: { organizationId, workspaceIds: ctx.workspaceIds },
      purpose: ctx.purpose,
      stores: [],
      keyLifecycle,
      limitations: [
        `Caches in other processes hold a plaintext DEK for at most ${ttl} ms after this operation; the KMS refuses unwraps of a disabled KEK at once.`,
      ],
      schemaVersion: null,
    }, ctx.actor, tx);
  }

  async function describe(organizationId: string, id: KekProviderId, kekRef: string): Promise<KekState> {
    return (await provider(id).describeKek(kekRef, { [KEK_CONTEXT_ORGANIZATION_KEY]: organizationId })).state;
  }

  async function encrypt(organizationId: string, scope: SealedScope, plaintext: Buffer): Promise<Buffer> {
    const custody = await usableCustody(organizationId);
    const dek = await dekFor(organizationId, custody.active_dek_version);
    return sealWithDek(dek, organizationId, custody.active_dek_version, scope, plaintext);
  }

  async function decrypt(organizationId: string, scope: SealedScope, blob: Buffer): Promise<Buffer> {
    const dekVersion = envelopeDekVersion(blob);
    if (dekVersion === null) throw new OrganizationKeyUnavailableError(organizationId, 'envelope-malformed', 'not a version-2 organization envelope');
    await usableCustody(organizationId);
    return openWithDek(await dekFor(organizationId, dekVersion), organizationId, scope, blob);
  }

  async function liveDekVersions(organizationId: string): Promise<readonly number[]> {
    const cached = versionCache.get(organizationId);
    if (cached && cached.expiresAt > now()) return cached.versions;
    const rows = await sql<{ dek_version: number }[]>`
      SELECT dek_version FROM harness_shared.organization_data_keys
       WHERE organization_id = ${organizationId} AND state <> 'shredded' ORDER BY dek_version`;
    const versions = rows.map((r) => Number(r.dek_version));
    versionCache.set(organizationId, { versions, expiresAt: now() + ttl });
    return versions;
  }

  /**
   * The blind-index keys of every live DEK version, and the active one. Writers tokenize under
   * `active`; a search tokenizes the query under `all`, because rows sealed under an older version keep
   * that version's tokens until the sweep re-seals them. Fails closed like encrypt and decrypt.
   */
  async function blindIndexKeys(organizationId: string): Promise<{ active: BlindIndexKey; all: readonly BlindIndexKey[] }> {
    const custody = await usableCustody(organizationId);
    const versions = new Set(await liveDekVersions(organizationId));
    versions.add(custody.active_dek_version);
    const all: BlindIndexKey[] = [];
    for (const dekVersion of [...versions].sort((a, b) => a - b)) {
      all.push({ dekVersion, key: deriveBlindIndexKey(await dekFor(organizationId, dekVersion), organizationId, dekVersion) });
    }
    const active = all.find((k) => k.dekVersion === custody.active_dek_version)!;
    return { active, all };
  }

  /** Re-seals a blob under the active DEK when it was sealed under an older one (lazy DEK rotation). */
  async function reencrypt(organizationId: string, scope: SealedScope, blob: Buffer): Promise<{ blob: Buffer; changed: boolean }> {
    const custody = await usableCustody(organizationId);
    if (envelopeDekVersion(blob) === custody.active_dek_version) return { blob, changed: false };
    return { blob: await encrypt(organizationId, scope, await decrypt(organizationId, scope, blob)), changed: true };
  }

  async function revoke(organizationId: string, ctx: KeyOperationContext, kmsState?: KekState) {
    const receiptId = await sql.begin(async (t) => {
      const tx = t as unknown as Sql;
      const custody = await readCustody(tx, organizationId, true);
      if (!custody) throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-unprovisioned', 'no key custody is provisioned');
      if (custody.state !== 'enabled') throw new Error(`organization-keys: custody is ${custody.state}, not enabled`);
      await tx`UPDATE harness_shared.organization_key_custody SET state = 'revoked' WHERE organization_id = ${organizationId}`;
      return receipt(tx, 'key-revocation', organizationId, ctx, {
        event: 'revoked', kekProvider: custody.kek_provider, kekRef: custody.kek_ref, kekGeneration: custody.kek_generation,
        activeDekVersion: custody.active_dek_version, dekVersions: [], custodyState: 'revoked', kmsState,
      });
    });
    evict(organizationId);
    return { receiptId };
  }

  return {
    evict,
    encrypt,
    decrypt,
    reencrypt,
    revoke,
    blindIndexKeys,

    async provision(organizationId: string, kek: { kekProvider: KekProviderId; kekRef: string }, ctx: KeyOperationContext) {
      const kmsState = await describe(organizationId, kek.kekProvider, kek.kekRef);
      if (kmsState !== 'enabled') throw new Error(`organization-keys: KEK ${kek.kekRef} is ${kmsState}, not enabled`);
      const dek = randomBytes(DEK_BYTES);
      const wrapped = await provider(kek.kekProvider).wrapDataKey(kek.kekRef, dek, dekWrapContext(organizationId, 1));
      dek.fill(0);
      const receiptId = await sql.begin(async (t) => {
        const tx = t as unknown as Sql;
        await tx`INSERT INTO harness_shared.organization_key_custody (organization_id, kek_provider, kek_ref)
                 VALUES (${organizationId}, ${kek.kekProvider}, ${kek.kekRef})`;
        await tx`INSERT INTO harness_shared.organization_data_keys
                   (organization_id, dek_version, kek_provider, kek_ref, kek_generation, wrapped_dek, state)
                 VALUES (${organizationId}, 1, ${kek.kekProvider}, ${kek.kekRef}, 1, ${wrapped}, 'active')`;
        return receipt(tx, 'key-provisioning', organizationId, ctx, {
          event: 'provisioned', kekProvider: kek.kekProvider, kekRef: kek.kekRef, kekGeneration: 1,
          activeDekVersion: 1, dekVersions: [1], custodyState: 'enabled', kmsState,
        });
      });
      return { receiptId, dekVersion: 1 };
    },

    /** The background sweep: re-seals every row a store yields, writing back only the changed ones. */
    async sweep(
      organizationId: string,
      scope: SealedScope,
      rows: AsyncIterable<{ id: string; blob: Buffer }> | Iterable<{ id: string; blob: Buffer }>,
      write: (id: string, blob: Buffer) => Promise<void>,
    ): Promise<SweepResult> {
      let examined = 0;
      let reencrypted = 0;
      for await (const row of rows) {
        examined += 1;
        const out = await reencrypt(organizationId, scope, row.blob);
        if (out.changed) {
          await write(row.id, out.blob);
          reencrypted += 1;
        }
      }
      return { examined, reencrypted, alreadyCurrent: examined - reencrypted };
    },

    async rotateDek(organizationId: string, ctx: KeyOperationContext) {
      const custody = await usableCustody(organizationId);
      const next = custody.active_dek_version + 1;
      const dek = randomBytes(DEK_BYTES);
      const wrapped = await provider(custody.kek_provider).wrapDataKey(custody.kek_ref, dek, dekWrapContext(organizationId, next));
      dek.fill(0);
      const receiptId = await sql.begin(async (t) => {
        const tx = t as unknown as Sql;
        const locked = await readCustody(tx, organizationId, true);
        if (!locked || locked.state !== 'enabled' || locked.active_dek_version !== custody.active_dek_version) {
          throw new Error('organization-keys: custody changed during DEK rotation; retry');
        }
        await tx`UPDATE harness_shared.organization_data_keys SET state = 'decrypt-only'
                  WHERE organization_id = ${organizationId} AND state = 'active'`;
        await tx`INSERT INTO harness_shared.organization_data_keys
                   (organization_id, dek_version, kek_provider, kek_ref, kek_generation, wrapped_dek, state)
                 VALUES (${organizationId}, ${next}, ${custody.kek_provider}, ${custody.kek_ref}, ${custody.kek_generation}, ${wrapped}, 'active')`;
        await tx`UPDATE harness_shared.organization_key_custody SET active_dek_version = ${next}
                  WHERE organization_id = ${organizationId}`;
        return receipt(tx, 'key-rotation', organizationId, ctx, {
          event: 'dek-rotated', kekProvider: custody.kek_provider, kekRef: custody.kek_ref, kekGeneration: custody.kek_generation,
          activeDekVersion: next, dekVersions: [next], custodyState: 'enabled',
        });
      });
      custodyCache.delete(organizationId);
      versionCache.delete(organizationId);
      return { receiptId, activeDekVersion: next };
    },

    async rotateKek(organizationId: string, kek: { kekProvider: KekProviderId; kekRef: string }, ctx: KeyOperationContext) {
      const custody = await usableCustody(organizationId);
      const kmsState = await describe(organizationId, kek.kekProvider, kek.kekRef);
      if (kmsState !== 'enabled') throw new Error(`organization-keys: new KEK ${kek.kekRef} is ${kmsState}, not enabled`);
      const rows = await sql<DekRow[]>`
        SELECT dek_version, kek_provider, kek_ref, wrapped_dek, state FROM harness_shared.organization_data_keys
         WHERE organization_id = ${organizationId} AND state <> 'shredded' ORDER BY dek_version`;
      const rewrapped: { version: number; wrapped: Buffer }[] = [];
      for (const row of rows) {
        const dek = await unwrap(organizationId, row);
        rewrapped.push({
          version: row.dek_version,
          wrapped: await provider(kek.kekProvider).wrapDataKey(kek.kekRef, dek, dekWrapContext(organizationId, row.dek_version)),
        });
        dek.fill(0);
      }
      const generation = custody.kek_generation + 1;
      const receiptId = await sql.begin(async (t) => {
        const tx = t as unknown as Sql;
        const locked = await readCustody(tx, organizationId, true);
        if (!locked || locked.state !== 'enabled' || locked.kek_generation !== custody.kek_generation) {
          throw new Error('organization-keys: custody changed during KEK rotation; retry');
        }
        for (const r of rewrapped) {
          await tx`UPDATE harness_shared.organization_data_keys
                      SET kek_provider = ${kek.kekProvider}, kek_ref = ${kek.kekRef}, kek_generation = ${generation},
                          wrapped_dek = ${r.wrapped}, rewrapped_at = now()
                    WHERE organization_id = ${organizationId} AND dek_version = ${r.version} AND state <> 'shredded'`;
        }
        await tx`UPDATE harness_shared.organization_key_custody
                    SET kek_provider = ${kek.kekProvider}, kek_ref = ${kek.kekRef}, kek_generation = ${generation}
                  WHERE organization_id = ${organizationId}`;
        return receipt(tx, 'key-rotation', organizationId, ctx, {
          event: 'kek-rotated', kekProvider: kek.kekProvider, kekRef: kek.kekRef, kekGeneration: generation,
          activeDekVersion: custody.active_dek_version, dekVersions: rewrapped.map((r) => r.version),
          custodyState: 'enabled', previousKekRef: custody.kek_ref, kmsState,
        });
      });
      evict(organizationId);
      return { receiptId, kekGeneration: generation, rewrappedDekVersions: rewrapped.map((r) => r.version) };
    },

    /** Asks the KMS about the KEK; a KEK the customer disabled there is recorded as a revocation here. */
    async reconcileKekState(organizationId: string, ctx: KeyOperationContext) {
      const custody = await readCustody(sql, organizationId);
      if (!custody || custody.state !== 'enabled') return { kmsState: null, revoked: false };
      const kmsState = await describe(organizationId, custody.kek_provider, custody.kek_ref);
      if (kmsState === 'enabled') return { kmsState, revoked: false };
      const { receiptId } = await revoke(organizationId, ctx, kmsState);
      return { kmsState, revoked: true, receiptId };
    },

    async recover(organizationId: string, ctx: KeyOperationContext) {
      const custody = await readCustody(sql, organizationId);
      if (!custody) throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-unprovisioned', 'no key custody is provisioned');
      if (custody.state !== 'revoked') throw new Error(`organization-keys: custody is ${custody.state}; only a revoked KEK can be recovered`);
      const kmsState = await describe(organizationId, custody.kek_provider, custody.kek_ref);
      if (kmsState !== 'enabled') throw new Error(`organization-keys: the KMS reports the KEK ${kmsState}; re-enable it there first`);
      const active = await sql<DekRow[]>`
        SELECT dek_version, kek_provider, kek_ref, wrapped_dek, state FROM harness_shared.organization_data_keys
         WHERE organization_id = ${organizationId} AND dek_version = ${custody.active_dek_version}`;
      if (!active[0]) throw new OrganizationKeyUnavailableError(organizationId, 'dek-version-unknown', 'active DEK row is missing');
      (await unwrap(organizationId, active[0])).fill(0);
      const receiptId = await sql.begin(async (t) => {
        const tx = t as unknown as Sql;
        const locked = await readCustody(tx, organizationId, true);
        if (!locked || locked.state !== 'revoked') throw new Error('organization-keys: custody changed during recovery; retry');
        await tx`UPDATE harness_shared.organization_key_custody SET state = 'enabled' WHERE organization_id = ${organizationId}`;
        return receipt(tx, 'key-recovery', organizationId, ctx, {
          event: 'recovered', kekProvider: custody.kek_provider, kekRef: custody.kek_ref, kekGeneration: custody.kek_generation,
          activeDekVersion: custody.active_dek_version, dekVersions: [custody.active_dek_version], custodyState: 'enabled', kmsState,
        });
      });
      evict(organizationId);
      return { receiptId };
    },

    /** Crypto-shred. IRREVERSIBLE: the wrapped DEKs are removed. `confirmOrganizationId` must repeat the id. */
    async shred(organizationId: string, ctx: KeyOperationContext & { confirmOrganizationId: string }) {
      if (ctx.confirmOrganizationId !== organizationId) throw new Error('organization-keys: shred requires confirmOrganizationId to equal the organization id');
      const auth = authorizeDataOperation('key-shred', organizationId, ctx.actor);
      const result = await sql.begin(async (t) => {
        const tx = t as unknown as Sql;
        // This rare irreversible operation serializes against even the low-level hold writers.
        // Lock the workspace mapping too: a caller cannot omit a workspace or race a remapping.
        // No KMS/network calls run while these locks are held.
        await tx`LOCK TABLE harness_shared.customer_workspaces, harness_shared.data_source_legal_holds IN SHARE MODE`;
        const custody = await readCustody(tx, organizationId, true);
        if (!custody) throw new OrganizationKeyUnavailableError(organizationId, 'organization-key-unprovisioned', 'no key custody is provisioned');
        if (custody.state === 'shredded') throw new Error('organization-keys: already shredded');
        // id is the data-plane slug; workspace_id is the hosting control workspace. Include deleted
        // workspaces too, because their held content can survive in a backup.
        const owned = await tx<{ id: string }[]>`
          SELECT id FROM harness_shared.customer_workspaces WHERE organization_id = ${organizationId}`;
        const workspaceIds = [...new Set([...owned.map((w) => w.id), ...ctx.workspaceIds])];
        const holds = await holdConflicts(tx, workspaceIds);
        if (holds.length) {
          const auditEventId = await appendOrganizationAuditEvent({
            organizationId, ...auth, action: 'organization.keys.shred_refused', purpose: ctx.purpose,
            targetType: 'organization_key', targetId: organizationId,
            metadata: {
              code: 'legal-hold-active', workspaceIds,
              holds: holds.map((h) => ({ holdId: h.holdId, workspaceId: h.workspaceId,
                dataSourceId: h.dataSourceId, channelId: h.channelId,
                retained: h.retained.map((r) => ({ store: r.store, rows: r.rows })) })),
            },
          }, tx);
          // Return the refusal so its audit commits. Throwing inside sql.begin would erase it.
          return { receiptId: null, refusal: { holdIds: holds.map((h) => h.holdId), auditEventId } };
        }
        const shredded = await tx<{ dek_version: number }[]>`
          UPDATE harness_shared.organization_data_keys SET state = 'shredded', wrapped_dek = NULL
           WHERE organization_id = ${organizationId} AND state <> 'shredded' RETURNING dek_version`;
        await tx`UPDATE harness_shared.organization_key_custody SET state = 'shredded' WHERE organization_id = ${organizationId}`;
        const receiptId = await receipt(tx, 'key-shred', organizationId, { ...ctx, workspaceIds }, {
          event: 'shredded', kekProvider: custody.kek_provider, kekRef: custody.kek_ref, kekGeneration: custody.kek_generation,
          activeDekVersion: custody.active_dek_version, dekVersions: shredded.map((r) => r.dek_version).sort((a, b) => a - b),
          custodyState: 'shredded',
        });
        return { receiptId, refusal: null };
      });
      if (result.refusal) throw new OrganizationKeyShredRefusedError(organizationId, result.refusal.holdIds, result.refusal.auditEventId);
      evict(organizationId);
      return { receiptId: result.receiptId! };
    },
  };
}

export type OrganizationKeyService = ReturnType<typeof createOrganizationKeyService>;
