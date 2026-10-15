/**
 * Live (federated) search adapters (plan enterprise-data-sources-2026-10-01 P-018,
 * owner ruling D-006, acceptance BAR R-12).
 *
 * A data source can serve live queries instead of a sync. Such a source is a
 * `harness_shared.data_sources` row with `sync_mode = 'federated'`. Its adapter is
 * queried at read time and NOTHING is written to the documents corpus (a vendor's
 * search API may forbid storing its results). Adapters come from provider packages
 * that declare the `search.live` capability (cupboard-distributable-integrations-2026-10-10
 * D-026 ruling 5); the call runs as the person searching.
 *
 * A live read passes the same three checks as a stored organization read
 * (documents-corpus.ts):
 *   1. the vault grant: authorizePersonalAccess with the `organization` scope;
 *   2. the source ACL, enforced by the PROVIDER: the adapter queries as the
 *      principal's own provider identity, taken only from an explicit, live
 *      provider_identity_mappings row (D-002). No mapping means no read;
 *   3. the disclosure ledger: every hit passes discloseDocuments. A hit has no
 *      corpus row, so it is ledgered under liveDocumentId(), a deterministic uuid
 *      of (data source id, external id): re-reading the same hit is not a new
 *      disclosure, exactly as for a stored document.
 *
 * Each source runs under its own timeout and fails soft: a slow or broken
 * provider is silence for that source, never an error for the whole read.
 */
import { createHash } from 'node:crypto';
import type { JSONValue, Sql } from 'postgres';
import {
  PROVIDER_SEARCH_LIVE_CAPABILITY,
  providerLiveSearchResultIssue,
  type HostFetch,
  type ProviderLiveSearchResult,
} from '@papercusp/plugin-sdk';
import { DEFAULT_SOURCE_TOKEN_HARNESS } from '../external-triggers/source-store';
import { HostFetchError } from '../integrations/host-fetch';
import { readyProviderRegistry, type ProviderRegistry, type RegisteredProvider } from '../integrations/provider-registry';
import { resolveProviderServices } from '../integrations/service-credentials';
import { createSourceHostFetch } from '../integrations/source-host-fetch';
import { authorizePersonalAccess, type PersonalAuthorization } from '../personal-vault/authorization';
import { discloseDocuments } from '../personal-vault/disclosure-ledger';
import type { DocumentLabel } from '../personal-vault/disclosure-labels';
import { normalizePersonalSource } from '../personal-vault/store';
import type { PersonalToolContext } from '../personal-vault/types';
import { ORGANIZATION_CORPUS_SCOPE } from './documents-corpus';

export const LIVE_SEARCH_VIA = 'live:search';
export const LIVE_SEARCH_SYNC_MODE = 'federated';
export const LIVE_SEARCH_TIMEOUT_MS = 4_000;

/** The data-source fields an adapter needs. A subset of DataSourceRecord. */
export interface LiveSourceRecord {
  id: string;
  workspaceId: string;
  kind: string;
  credentialRef: string | null;
  config: Record<string, JSONValue>;
}

export interface LiveSearchInput {
  record: LiveSourceRecord;
  /** The local user the agent acts for. */
  principalUserId: string;
  /** The principal's mapped identity at this provider: the identity the adapter queries as. */
  providerUserId: string;
  query: string;
  limit: number;
  signal: AbortSignal;
}

export interface LiveSearchHit {
  externalId: string;
  title: string;
  text: string;
  occurredAt: string | null;
  participants: string[];
  /** Provider link to the original, shown as the citation. */
  permalink: string | null;
  /** Adapter-native relevance; comparable only within one adapter. */
  score: number;
}

export interface LiveSearchAdapter {
  /** data_sources.kind this adapter serves, e.g. `slack`. */
  kind: string;
  search(input: LiveSearchInput): Promise<LiveSearchHit[]>;
}

/** A source's failure reason when the person searching has not stored their own per-person credential. */
export const PRINCIPAL_CREDENTIAL_MISSING = 'principal_credential_missing';

export interface ProviderLiveSearchAdapterOptions {
  registry?: ProviderRegistry;
  fetchImpl?: typeof fetch;
}

/** The install whose token store holds a source's credentials: `config.installSlug`, else the default. */
function sourceTokenHarness(record: LiveSourceRecord): string {
  const value = record.config.installSlug;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SOURCE_TOKEN_HARNESS;
}

function providerLiveSearchAdapter(sql: Sql, provider: RegisteredProvider, opts: ProviderLiveSearchAdapterOptions): LiveSearchAdapter {
  const kind = normalizePersonalSource(provider.descriptor.id);
  return {
    kind,
    async search(input) {
      // host.fetch acts for the person searching, never for the source: a per-person setup
      // credential resolves from their own stored value, and a person with none is refused.
      const bound = createSourceHostFetch(sql, {
        providerId: provider.descriptor.id,
        workspaceId: input.record.workspaceId,
        harness: sourceTokenHarness(input.record),
        registry: opts.registry,
        fetchImpl: opts.fetchImpl,
        sourceIds: [input.record.id],
        principalUserId: input.principalUserId,
      });
      // The provider may run out of process, so the refusal is recognised here, where it is
      // raised, rather than from whatever error the provider reports back.
      let principalMissing = false;
      const fetch: HostFetch = async (request) => {
        try {
          return await bound(request);
        } catch (error) {
          if (error instanceof HostFetchError && error.code === 'principal-credential-missing') principalMissing = true;
          throw error;
        }
      };
      let result: unknown;
      try {
        const services = await resolveProviderServices(provider.descriptor.serviceCredentials);
        result = await provider.adapter.invoke(
          {
            source: input.record.id,
            capability: PROVIDER_SEARCH_LIVE_CAPABILITY,
            args: { query: input.query, limit: input.limit },
            config: input.record.config,
            ...(services ? { services } : {}),
          },
          { fetch },
        );
      } catch (error) {
        if (principalMissing) throw new Error(PRINCIPAL_CREDENTIAL_MISSING);
        throw error;
      }
      const issue = providerLiveSearchResultIssue(result);
      if (issue) throw new Error(`live_search_invalid_result: ${issue}`);
      // Hits arrive best first; rank is the only relevance the contract carries.
      return (result as ProviderLiveSearchResult).hits.map((hit, index) => ({
        externalId: hit.externalId,
        title: hit.title,
        text: hit.text,
        occurredAt: hit.occurredAt,
        participants: hit.participants,
        permalink: hit.permalink,
        score: 1 / (index + 1),
      }));
    },
  };
}

/**
 * One adapter for each registered provider that declares `search.live`
 * (cupboard-distributable-integrations-2026-10-10 D-026 ruling 5), keyed by data_sources.kind.
 * No provider is named here: a package that declares the capability is searchable live.
 */
export async function providerLiveSearchAdapters(
  sql: Sql,
  opts: ProviderLiveSearchAdapterOptions = {},
): Promise<ReadonlyMap<string, LiveSearchAdapter>> {
  const registry = opts.registry ?? (await readyProviderRegistry());
  const adapters = new Map<string, LiveSearchAdapter>();
  for (const provider of registry.list()) {
    if (!provider.descriptor.capabilities.includes(PROVIDER_SEARCH_LIVE_CAPABILITY)) continue;
    const adapter = providerLiveSearchAdapter(sql, provider, { ...opts, registry });
    adapters.set(adapter.kind, adapter);
  }
  return adapters;
}

export interface LiveSearchResult {
  id: string;
  /** The source key subscriptions and filters use (config.source, else kind). */
  source: string;
  dataSourceId: string;
  kind: string;
  externalId: string;
  occurredAt: string | null;
  participants: string[];
  title: string;
  snippet: string;
  metadata: Record<string, unknown>;
  permalink: string | null;
  score: number;
  privacy: DocumentLabel | null;
}

export interface LiveSourceFailure {
  dataSourceId: string;
  source: string;
  reason: string;
}

export type LiveSearchOutcome =
  | {
      allowed: true;
      results: LiveSearchResult[];
      withheld: number;
      disclosed: number;
      /** Sources skipped because the principal has no live identity at that provider. */
      unmapped: string[];
      failed: LiveSourceFailure[];
    }
  | { allowed: false; reason: NonNullable<PersonalAuthorization['reason']> };

/** The key a live source is subscribed and filtered by: `config.source`, else its kind. */
export function liveSourceKey(record: Pick<LiveSourceRecord, 'kind' | 'config'>): string {
  const configured = record.config?.source;
  return normalizePersonalSource(typeof configured === 'string' && configured.trim() ? configured : record.kind);
}

/** Deterministic uuid for a live hit, so the disclosure ledger can key it without a corpus row. */
export function liveDocumentId(dataSourceId: string, externalId: string): string {
  const hex = createHash('sha256').update(`live:${dataSourceId}:${externalId}`).digest('hex');
  // RFC 4122 layout, version nibble 5, variant 10xx.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * data_sources statuses a live source is NOT queried in. Every other status is
 * queryable: a federated source has no sync to move it out of `error`, and a
 * broken provider already fails soft per source.
 */
export const LIVE_SEARCH_EXCLUDED_STATUSES = ['unconfigured', 'disabled'] as const;

/** Configured, enabled organization data sources that serve live search. */
export async function listLiveSources(sql: Sql, workspaceId: string): Promise<LiveSourceRecord[]> {
  const rows = await sql<Array<{
    id: string; workspace_id: string; kind: string; credential_ref: string | null; config: Record<string, JSONValue> | null;
  }>>`
    SELECT id::text, workspace_id, kind, credential_ref, config
      FROM harness_shared.data_sources
     WHERE workspace_id = ${workspaceId}
       AND sync_mode = ${LIVE_SEARCH_SYNC_MODE}
       AND scope = 'organization'
       AND status <> ALL(${[...LIVE_SEARCH_EXCLUDED_STATUSES]}::text[])
     ORDER BY created_at, id`;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    credentialRef: r.credential_ref,
    config: r.config ?? {},
  }));
}

async function liveProviderIdentity(
  sql: Sql,
  workspaceId: string,
  provider: string,
  principalUserId: string,
): Promise<string | null> {
  const rows = await sql<Array<{ provider_user_id: string }>>`
    SELECT provider_user_id FROM harness_shared.provider_identity_mappings
     WHERE workspace_id = ${workspaceId} AND provider = ${normalizePersonalSource(provider)}
       AND user_id = ${principalUserId}::uuid AND revoked_at IS NULL
     ORDER BY provider_user_id
     LIMIT 1`;
  return rows[0]?.provider_user_id ?? null;
}

/** Revalidate the exact local binding that authorized a completed provider read. */
async function liveSearchBindingCurrent(
  sql: Sql,
  record: LiveSourceRecord,
  principalUserId: string,
  providerUserId: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM harness_shared.data_sources d
     WHERE d.workspace_id = ${record.workspaceId} AND d.id = ${record.id}::uuid
       AND d.kind = ${record.kind} AND d.scope = 'organization'
       AND d.sync_mode = ${LIVE_SEARCH_SYNC_MODE}
       AND d.status <> ALL(${[...LIVE_SEARCH_EXCLUDED_STATUSES]}::text[])
       AND d.credential_ref IS NOT DISTINCT FROM ${record.credentialRef}::text
       AND COALESCE(d.config, '{}'::jsonb) = ${sql.json(record.config)}::jsonb
       AND EXISTS (
         SELECT 1 FROM harness_shared.provider_identity_mappings p
          WHERE p.workspace_id = d.workspace_id
            AND p.provider = ${normalizePersonalSource(record.kind)}
            AND p.provider_user_id = ${providerUserId}
            AND p.user_id = ${principalUserId}::uuid AND p.revoked_at IS NULL)`;
  return rows.length > 0;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('live_search_timeout'));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Query the workspace's live sources as `principalUserId`. Run it inside the
 * transaction that returns the results, like searchOrganizationDocuments: the
 * disclosure rows must commit with the read. Writes no corpus row.
 */
export async function searchLiveSources(
  sql: Sql,
  ctx: PersonalToolContext,
  params: {
    workspaceId: string;
    principalUserId: string;
    agentOwnerId: string | null;
    query: string;
    /** Source keys to query; omitted or empty means every live source. */
    sources?: string[];
    limit?: number;
    snippetChars?: number;
    timeoutMs?: number;
    adapters?: ReadonlyMap<string, LiveSearchAdapter>;
  },
): Promise<LiveSearchOutcome> {
  const auth = await authorizePersonalAccess(
    sql, ctx, params.workspaceId, params.principalUserId, [ORGANIZATION_CORPUS_SCOPE],
  );
  if (!auth.allowed) return { allowed: false, reason: auth.reason ?? 'no_live_grant' };

  const limit = Math.max(1, Math.min(20, params.limit ?? 10));
  const snippetChars = Math.max(80, Math.min(1200, params.snippetChars ?? 600));
  const wanted = new Set((params.sources ?? []).map(normalizePersonalSource));
  const records = (await listLiveSources(sql, params.workspaceId))
    .filter((r) => !wanted.size || wanted.has(liveSourceKey(r)));
  const adapters = params.adapters ?? (records.length ? await providerLiveSearchAdapters(sql) : new Map<string, LiveSearchAdapter>());

  const unmapped: string[] = [];
  const failed: LiveSourceFailure[] = [];
  const perSource = await Promise.all(records.map(async (record) => {
    const source = liveSourceKey(record);
    const adapter = adapters.get(normalizePersonalSource(record.kind));
    if (!adapter) {
      failed.push({ dataSourceId: record.id, source, reason: 'no_live_search_adapter' });
      return null;
    }
    const providerUserId = await liveProviderIdentity(sql, params.workspaceId, record.kind, params.principalUserId);
    if (!providerUserId) {
      unmapped.push(source);
      return null;
    }
    try {
      const hits = await withTimeout(params.timeoutMs ?? LIVE_SEARCH_TIMEOUT_MS, (signal) => adapter.search({
        record, principalUserId: params.principalUserId, providerUserId, query: params.query, limit, signal,
      }));
      return { record, providerUserId, hits: hits.slice(0, limit).map((hit) => ({
        id: liveDocumentId(record.id, hit.externalId),
        source,
        dataSourceId: record.id,
        kind: 'live-hit',
        externalId: hit.externalId,
        occurredAt: hit.occurredAt,
        participants: hit.participants,
        title: hit.title,
        snippet: hit.text.slice(0, snippetChars),
        metadata: { live: true, permalink: hit.permalink },
        permalink: hit.permalink,
        score: hit.score,
      })) };
    } catch (error) {
      failed.push({ dataSourceId: record.id, source, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }));

  // Check after ALL providers settle: a fast source can be revoked while a
  // slower source is still pending. A subscription and a stale response never
  // preserve a revoked local binding or authorize a different source config.
  const currentHits = await Promise.all(perSource.map(async (result) => {
    if (!result) return [];
    if (!(await liveSearchBindingCurrent(sql, result.record, params.principalUserId, result.providerUserId))) {
      failed.push({ dataSourceId: result.record.id, source: liveSourceKey(result.record), reason: 'live_search_binding_changed' });
      return [];
    }
    return result.hits;
  }));
  const currentAuth = await authorizePersonalAccess(
    sql, ctx, params.workspaceId, params.principalUserId, [ORGANIZATION_CORPUS_SCOPE],
  );
  if (!currentAuth.allowed) return { allowed: false, reason: currentAuth.reason ?? 'no_live_grant' };

  const hits = currentHits.flat().sort((a, b) => b.score - a.score).slice(0, limit);
  const disclosed = await discloseDocuments(sql, {
    workspaceId: params.workspaceId,
    userId: params.principalUserId,
    agentOwnerId: params.agentOwnerId,
    documents: hits,
    via: LIVE_SEARCH_VIA,
  });
  return {
    allowed: true,
    results: disclosed.documents,
    withheld: disclosed.withheld,
    disclosed: disclosed.disclosed,
    unmapped,
    failed,
  };
}
