/**
 * DEK-rotation re-seal sweep for sealed organization documents (plan
 * papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b follow-up, WI-6554700010012443 U5;
 * decisions D-020 and D-021; schema: migration 1503).
 *
 * rotateDek (organization-keys.ts) makes a new DEK active at once. A document sealed under an older
 * version stays readable (its key is decrypt-only) and findable (a search tokenizes the query under
 * every live version), but it keeps the old ciphertext AND the old version's blind tokens until it is
 * re-sealed. The key service's generic sweep() only re-encrypts a blob, so it cannot do this alone:
 * a document's blind_terms are keyed by the active DEK's blind-index key and must be re-derived from
 * the plaintext. Re-sealing a document is therefore openDocument -> sealDocuments
 * (organization-content-sealing.ts), which re-encrypts the content and re-tokenizes its lexemes.
 *
 * Properties:
 *  - Bounded: at most `batchSize` rows per call, oldest id first.
 *  - Idempotent: only rows whose envelope DEK version differs from their organization's active version
 *    are selected, so a finished organization costs one indexed read.
 *  - Safe against concurrent writers: each write-back is a compare-and-swap on the sealed_content that
 *    was read. A row rewritten in between is left alone (it was sealed under the active key by its
 *    writer, or it is picked up again on the next call).
 *  - Fail-closed and isolated: an organization whose custody is revoked or shredded is never selected;
 *    an organization whose KEK is unreachable is reported in `unavailable` and does not stop the others.
 *  - Never re-seals under a stale key: if this process's key cache still names the previous active
 *    version (rotation done on another host within the cache TTL), the row is counted as `deferred` and
 *    left for a later call instead of being rewritten under the old version.
 *
 * Needs a role that can read every organization's customer_workspaces row (that table forces RLS): the
 * operator's admin pool. Under a hosted runtime role the join sees only that runtime's organization.
 * Title and text stay '' and updated_at is not touched, because the document's content does not change.
 */
import type { Sql } from 'postgres';
import { contentSealing, openDocument, sealDocuments, type ContentSealing, type ContentSealingDeps, type DocumentPlaintext } from './organization-content-sealing';
import { ENVELOPE_HEADER_BYTES, ENVELOPE_VERSION, OrganizationKeyUnavailableError, envelopeDekVersion } from './organization-keys';

export const DEFAULT_RESEAL_BATCH_SIZE = 200;
export const MAX_RESEAL_BATCH_SIZE = 5_000;

export interface ResealOptions extends ContentSealingDeps {
  /** Rows examined per call. Clamped to 1..MAX_RESEAL_BATCH_SIZE; default DEFAULT_RESEAL_BATCH_SIZE. */
  readonly batchSize?: number;
}

export interface StaleSealedDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly activeDekVersion: number;
  readonly sealedContent: Buffer;
}

export interface ResealFailure {
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly documentId?: string;
  readonly code: string;
}

export interface ResealResult {
  /** Stale rows selected this call. */
  readonly examined: number;
  /** Rows written back under the active DEK with re-derived blind terms. */
  readonly resealed: number;
  /** Rows whose sealed_content changed between read and write (compare-and-swap lost). */
  readonly raced: number;
  /** Rows skipped because this process's key cache had not yet seen the rotation. */
  readonly deferred: number;
  /** Workspaces whose key was unavailable, and documents that could not be opened. */
  readonly failures: readonly ResealFailure[];
  /** True when the batch was full, so more stale rows may remain. */
  readonly more: boolean;
}

function clampBatch(batchSize: number | undefined): number {
  if (batchSize === undefined || !Number.isFinite(batchSize)) return DEFAULT_RESEAL_BATCH_SIZE;
  return Math.min(MAX_RESEAL_BATCH_SIZE, Math.max(1, Math.floor(batchSize)));
}

/**
 * Sealed documents whose envelope DEK version (bytes 1..4, uint32 big-endian) is not their
 * organization's active version, for organizations whose custody is enabled. Rows that are not a
 * well-formed version-2 envelope are not selected: no key can re-seal them, and selecting them would let
 * a few bad rows fill every batch.
 */
export async function staleSealedDocuments(sql: Sql, limit: number): Promise<StaleSealedDocument[]> {
  const rows = await sql<{ id: string; workspace_id: string; organization_id: string; active_dek_version: number; sealed_content: Buffer }[]>`
    SELECT d.id, d.workspace_id, c.organization_id, c.active_dek_version, d.sealed_content
      FROM harness_shared.documents d
      JOIN harness_shared.customer_workspaces cw
        ON cw.id = d.workspace_id AND cw.kind = 'hosted' AND cw.state <> 'deleted'
      JOIN harness_shared.organization_key_custody c
        -- custody.organization_id is uuid; customer_workspaces.organization_id is text.
        ON c.organization_id::text = cw.organization_id AND c.state = 'enabled'
     WHERE d.sealed_content IS NOT NULL
       AND octet_length(d.sealed_content) > ${ENVELOPE_HEADER_BYTES}
       AND get_byte(d.sealed_content, 0) = ${ENVELOPE_VERSION}
       AND get_byte(d.sealed_content, 1)::bigint * 16777216 + get_byte(d.sealed_content, 2) * 65536
           + get_byte(d.sealed_content, 3) * 256 + get_byte(d.sealed_content, 4) <> c.active_dek_version
     ORDER BY d.id
     LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    organizationId: r.organization_id,
    activeDekVersion: Number(r.active_dek_version),
    sealedContent: r.sealed_content,
  }));
}

/**
 * Writes a re-sealed document only if its sealed_content is still `expected`. Returns false when another
 * writer changed the row first.
 */
export async function compareAndSwapSealedDocument(
  sql: Sql,
  id: string,
  expected: Buffer,
  next: { readonly sealedContent: Buffer; readonly blindTerms: readonly string[] },
): Promise<boolean> {
  const rows = await sql`
    UPDATE harness_shared.documents
       SET sealed_content = ${next.sealedContent}, blind_terms = ${next.blindTerms as string[]}::text[]
     WHERE id = ${id} AND sealed_content = ${expected}
    RETURNING id`;
  return rows.length === 1;
}

function failureCode(error: unknown): string {
  if (error instanceof OrganizationKeyUnavailableError) return error.code;
  throw error;
}

/** Re-seals one bounded batch of documents left under an older DEK version. */
export async function resealStaleOrganizationDocuments(sql: Sql, options: ResealOptions = {}): Promise<ResealResult> {
  const limit = clampBatch(options.batchSize);
  const stale = await staleSealedDocuments(sql, limit);
  const byWorkspace = new Map<string, StaleSealedDocument[]>();
  for (const row of stale) byWorkspace.set(row.workspaceId, [...(byWorkspace.get(row.workspaceId) ?? []), row]);

  let resealed = 0;
  let raced = 0;
  let deferred = 0;
  const failures: ResealFailure[] = [];

  for (const [workspaceId, rows] of byWorkspace) {
    const organizationId = rows[0]!.organizationId;
    let sealing: ContentSealing | null;
    try {
      sealing = await contentSealing(sql, workspaceId, options);
    } catch (error) {
      failures.push({ workspaceId, organizationId, code: failureCode(error) });
      continue;
    }
    // Custody disappeared or the workspace moved between the read and now: the next call re-reads.
    if (!sealing || sealing.organizationId !== organizationId) continue;

    const current: StaleSealedDocument[] = [];
    for (const row of rows) {
      if (sealing.keys.active.dekVersion !== row.activeDekVersion) deferred += 1;
      else current.push(row);
    }
    const opened: Array<{ row: StaleSealedDocument; doc: DocumentPlaintext }> = [];
    for (const row of current) {
      try {
        opened.push({ row, doc: await openDocument(sealing, row.sealedContent) });
      } catch (error) {
        failures.push({ workspaceId, organizationId, documentId: row.id, code: failureCode(error) });
      }
    }
    if (opened.length === 0) continue;

    let sealed;
    try {
      sealed = await sealDocuments(sql, sealing, opened.map((o) => o.doc));
    } catch (error) {
      failures.push({ workspaceId, organizationId, code: failureCode(error) });
      continue;
    }
    for (const [i, { row }] of opened.entries()) {
      const next = sealed[i]!;
      if (envelopeDekVersion(next.sealedContent) !== row.activeDekVersion) {
        deferred += 1;
        continue;
      }
      if (await compareAndSwapSealedDocument(sql, row.id, row.sealedContent, next)) resealed += 1;
      else raced += 1;
    }
  }

  return { examined: stale.length, resealed, raced, deferred, failures, more: stale.length === limit };
}
