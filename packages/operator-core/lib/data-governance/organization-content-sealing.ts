/**
 * Sealing of organization- and pot-scope documents under the organization's customer-managed key
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b follow-up, WI-6554700010012443 U2;
 * decision D-020; schema: migration 1503).
 *
 * A workspace whose organization provisioned key custody (migration 1501) stores each organization
 * or pot document as:
 *   - title = '' and text = '' (so text_tsv and documents_bm25 index nothing for the row);
 *   - sealed_content: an envelope-v2 blob (organization-keys.ts, sealed scope 'content') of
 *     JSON {v: 1, title, text};
 *   - blind_terms: the keyed tokens (organization-keys.ts blindToken, under the ACTIVE DEK version's
 *     blind-index key) of the row's stemmed lexemes. The lexemes come from the same
 *     to_tsvector('english', title || ' ' || text) expression text_tsv uses.
 *
 * A search tokenizes the positive lexemes of its websearch query under EVERY live DEK version, selects
 * candidates by token overlap, decrypts them, and then applies the exact websearch match and
 * ts_rank_cd to the plaintext (rankSealedDocuments). Rows sealed under an older DEK version stay
 * findable until the sweep re-seals them.
 *
 * Custody in any state means seal: a revoked or shredded organization makes every read and write
 * throw OrganizationKeyUnavailableError instead of falling back to plaintext.
 *
 * Limitations (recorded in the plan decision): a database reader learns which sealed rows of one
 * organization share a stemmed term and how often terms occur, not the terms; the database server
 * process sees the plaintext transiently while it computes lexemes and ranks (parameter logging,
 * such as log_parameter_max_length, must stay off for these statements); a hosted write made under a
 * role that can see neither the workspace's customer_workspaces row nor app.organization_id stays
 * plaintext.
 */
import type { Sql } from 'postgres';
import { organizationKeyCustodyState, organizationKeyService, type OrganizationKeyCustodyState } from './organization-key-registry';
import { blindToken, OrganizationKeyUnavailableError, type BlindIndexKey, type OrganizationKeyService } from './organization-keys';
import { materializedTextLexicalLeg } from '../search/lexical/rank';

export const SEALED_DOCUMENT_FORMAT = 1;

type SealingKeyService = Pick<OrganizationKeyService, 'encrypt' | 'decrypt' | 'blindIndexKeys'>;

export interface ContentSealingDeps {
  readonly keyService?: (sql: Sql) => SealingKeyService;
  readonly custodyState?: (sql: Sql, organizationId: string) => Promise<OrganizationKeyCustodyState | null>;
}

/** What a writer or a reader needs to seal, open and search one organization's documents. */
export interface ContentSealing {
  readonly organizationId: string;
  readonly keys: { readonly active: BlindIndexKey; readonly all: readonly BlindIndexKey[] };
  readonly service: SealingKeyService;
}

export interface SealedDocument {
  readonly sealedContent: Buffer;
  readonly blindTerms: string[];
}

export interface DocumentPlaintext {
  readonly title: string;
  readonly text: string;
}

/**
 * The organization that owns a workspace's documents, or null when none is known. A document's
 * workspace_id is the hosted workspace (customer_workspaces.id). A hosted runtime may see only its own
 * customer_workspaces row (forced RLS), so the session's app.organization_id is consulted too. Two
 * different answers throw: a document must never be sealed under the wrong organization's key.
 */
export async function workspaceOrganization(sql: Sql, workspaceId: string): Promise<string | null> {
  const rows = await sql<{ organization_id: string }[]>`
    SELECT DISTINCT organization_id FROM (
      SELECT organization_id FROM harness_shared.customer_workspaces
       WHERE id = ${workspaceId} AND state <> 'deleted' AND kind = 'hosted'
      UNION ALL
      SELECT NULLIF(current_setting('app.organization_id', true), '')
    ) s
     WHERE organization_id IS NOT NULL`;
  if (rows.length > 1) {
    throw new Error(`organization-content-sealing: workspace ${workspaceId} resolves to more than one organization`);
  }
  return rows[0]?.organization_id ?? null;
}

/**
 * The sealing context for a workspace, or null when its documents are stored in plaintext (no
 * organization, or no key custody). Throws OrganizationKeyUnavailableError when custody exists but
 * the key is revoked, shredded or unreachable.
 */
export async function contentSealing(sql: Sql, workspaceId: string, deps: ContentSealingDeps = {}): Promise<ContentSealing | null> {
  const organizationId = await workspaceOrganization(sql, workspaceId);
  if (!organizationId) return null;
  const state = await (deps.custodyState ?? organizationKeyCustodyState)(sql, organizationId);
  if (state === null) return null;
  const service = (deps.keyService ?? organizationKeyService)(sql);
  return { organizationId, keys: await service.blindIndexKeys(organizationId), service };
}

/** The stemmed lexemes of each text, from the same configuration text_tsv uses. One query. */
export async function documentLexemes(sql: Sql, texts: readonly string[]): Promise<string[][]> {
  if (texts.length === 0) return [];
  const rows = await sql<{ ord: string | number; lexemes: string[] }[]>`
    SELECT u.ord, coalesce(tsvector_to_array(to_tsvector('english', u.t)), '{}'::text[]) AS lexemes
      FROM unnest(${texts as string[]}::text[]) WITH ORDINALITY AS u(t, ord)
     ORDER BY u.ord`;
  const out: string[][] = texts.map(() => []);
  for (const row of rows) out[Number(row.ord) - 1] = row.lexemes;
  return out;
}

export function documentSearchText(doc: DocumentPlaintext): string {
  return `${doc.title} ${doc.text}`;
}

/** Seals documents under the active DEK and tokenizes their lexemes under its blind-index key. */
export async function sealDocuments(sql: Sql, sealing: ContentSealing, docs: readonly DocumentPlaintext[]): Promise<SealedDocument[]> {
  const lexemes = await documentLexemes(sql, docs.map(documentSearchText));
  const out: SealedDocument[] = [];
  for (const [i, doc] of docs.entries()) {
    const payload = Buffer.from(JSON.stringify({ v: SEALED_DOCUMENT_FORMAT, title: doc.title, text: doc.text }), 'utf8');
    out.push({
      sealedContent: await sealing.service.encrypt(sealing.organizationId, 'content', payload),
      blindTerms: [...new Set(lexemes[i]!.map((term) => blindToken(sealing.keys.active.key, term)))].sort(),
    });
  }
  return out;
}

/** Opens a sealed document. Throws OrganizationKeyUnavailableError on a revoked key or a bad blob. */
export async function openDocument(sealing: Pick<ContentSealing, 'organizationId' | 'service'>, blob: Buffer): Promise<DocumentPlaintext> {
  const plaintext = await sealing.service.decrypt(sealing.organizationId, 'content', blob);
  let parsed: { v?: unknown; title?: unknown; text?: unknown };
  try {
    parsed = JSON.parse(plaintext.toString('utf8')) as typeof parsed;
  } catch {
    throw new OrganizationKeyUnavailableError(sealing.organizationId, 'envelope-malformed', 'sealed document is not JSON');
  }
  if (parsed.v !== SEALED_DOCUMENT_FORMAT || typeof parsed.title !== 'string' || typeof parsed.text !== 'string') {
    throw new OrganizationKeyUnavailableError(sealing.organizationId, 'envelope-malformed', 'sealed document has an unknown format');
  }
  return { title: parsed.title, text: parsed.text };
}

/**
 * The lexemes a websearch query requires or offers, read from PostgreSQL's own parse of it. A lexeme
 * directly negated (`-term`) is left out; one inside a negated phrase stays, which only widens the
 * candidate set (the exact match after decryption removes the extra rows).
 */
export function positiveQueryLexemes(tsquery: string): string[] {
  const out = new Set<string>();
  const re = /(!\s*)?'((?:[^']|'')*)'/g;
  for (let m = re.exec(tsquery); m; m = re.exec(tsquery)) {
    if (m[1]) continue;
    const lexeme = m[2]!.replace(/''/g, "'");
    if (lexeme) out.add(lexeme);
  }
  return [...out];
}

/** The candidate tokens of a query: its positive lexemes under every live DEK version's key. */
export async function queryBlindTerms(sql: Sql, sealing: Pick<ContentSealing, 'keys'>, query: string): Promise<string[]> {
  const rows = await sql<{ q: string }[]>`SELECT websearch_to_tsquery('english', ${query})::text AS q`;
  const lexemes = positiveQueryLexemes(rows[0]?.q ?? '');
  const tokens = new Set<string>();
  for (const { key } of sealing.keys.all) for (const lexeme of lexemes) tokens.add(blindToken(key, lexeme));
  return [...tokens].sort();
}

/**
 * The exact websearch match and ts_rank_cd of decrypted candidates, computed the way the plaintext
 * leg computes them on text_tsv. Returns only the matching ids. One query.
 */
export async function rankSealedDocuments(
  sql: Sql,
  query: string,
  docs: readonly (DocumentPlaintext & { id: string })[],
): Promise<Map<string, number>> {
  if (docs.length === 0) return new Map();
  const leg = materializedTextLexicalLeg(sql, sql`u.title || ' ' || u.text`, query);
  const rows = await sql<{ id: string; rank: number | string }[]>`
    SELECT u.id, ${leg.score} AS rank
      FROM unnest(${docs.map((d) => d.id)}::text[], ${docs.map((d) => d.title)}::text[], ${docs.map((d) => d.text)}::text[])
             AS u(id, title, text)
     WHERE ${leg.match}`;
  return new Map(rows.map((r) => [r.id, Number(r.rank)]));
}

/** How many candidates a sealed search decrypts for `limit` results. */
export function sealedCandidateLimit(limit: number): number {
  return Math.min(500, Math.max(1, limit) * 20);
}
