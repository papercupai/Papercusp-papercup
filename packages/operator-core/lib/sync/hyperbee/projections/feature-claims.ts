/**
 * Hyperbee → PG projection for `harness_shared.feature_claims`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031
 * + papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-036.
 *
 * `feature_claims` is APPEND-ONLY per the v5 spec: each claim
 * identity is `(harness_slug, feature_id, original claimer_pubkey, seq)`.
 * New wire keys are `<feature_id>/<claimer_pubkey>/<seq>`; validated legacy
 * `<feature_id>/<seq>` aliases reach the same immutable original. During the
 * schema expansion phase an incompatible legacy PK collision stays retriable.
 *
 * On `del` ops: refuse — the table is append-only. We log + drop.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import { isValidOpHlc } from '../hlc-stamp';

export interface FeatureClaimRow {
  harness_slug: string;
  feature_id: string;
  seq: number;
  claimer_pubkey: string;
  claimer_github_user_id: number;
  claimed_at: number;
  outcome: string | null;
  schema_version: number;
}

export interface ClaimReplayEvent {
  readonly sourceLogKeyHex: string;
  readonly row: Readonly<FeatureClaimRow>;
  readonly hbKey: string;
  readonly hlc: string;
  readonly ts: number;
  readonly snapshot: Readonly<{ logIndex: number; rowIndex: number }>;
}

/** The canonical op must remain owed until the legacy key has been contracted. */
export class ClaimProjectionSchemaNotReadyError extends Error {
  readonly code = 'P532_SCHEMA_NOT_READY';
  constructor() {
    super('Claim event remains unprojected: schema cannot store this original author and sequence');
    this.name = 'ClaimProjectionSchemaNotReadyError';
  }
}

export interface FeatureClaimsProjectionOpts {
  verifyClaimReplay?: (event: Readonly<ClaimReplayEvent>) => boolean | Promise<boolean>;
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  potHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004: the content-before-membership defer buffer. When the membership guard would
   *  DROP a cross-member op ONLY because the author's hive_members row hasn't federated yet, the
   *  op is buffered here (keyed on the author device) + re-applied when that member joins — not
   *  lost. Undefined ⇒ today's drop (no buffer wired). Threaded via RegisterAllOpts. */
  pendingMemberContent?: PendingMembershipContent;
}

/**
 * Hyperbee table tag for feature-claim ops. Single source of truth shared
 * by the projection AND the orchestrator's `claimFeature` writer
 * (feature-claim.ts) so the appended op routes to this projection.
 */
export const CLAIMS_TABLE_TAG = 'claims' as const;

function composeKey(row: FeatureClaimRow): string {
  return `${row.feature_id}/${row.claimer_pubkey}/${row.seq}`;
}

function isFeatureClaimRow(input: unknown): input is FeatureClaimRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' && r.harness_slug.length > 0 &&
    typeof r.feature_id === 'string' && r.feature_id.length > 0 &&
    typeof r.seq === 'number' && Number.isSafeInteger(r.seq) && r.seq >= 0 &&
    typeof r.claimer_pubkey === 'string' && /^[0-9a-f]{64}$/.test(r.claimer_pubkey) &&
    typeof r.claimer_github_user_id === 'number' &&
    Number.isSafeInteger(r.claimer_github_user_id) && r.claimer_github_user_id > 0 &&
    typeof r.claimed_at === 'number' && Number.isSafeInteger(r.claimed_at) && r.claimed_at >= 0 &&
    (r.outcome == null || typeof r.outcome === 'string') &&
    typeof r.schema_version === 'number'
  );
}

function decodeValue(raw: unknown): FeatureClaimRow | null {
  return isFeatureClaimRow(raw) ? raw : null;
}

async function writeToPg(
  opts: FeatureClaimsProjectionOpts,
  row: FeatureClaimRow,
  provenance: ProvenanceContext,
): Promise<void | false> {
  const hbKey = provenance.hbKey;
  if (hbKey !== composeKey(row) && hbKey !== `${row.feature_id}/${row.seq}`) return false;
  const source = provenance.sourceLogKeyHex ?? provenance.authorPubkey;
  if (source !== row.claimer_pubkey) {
    const snapshot = provenance.snapshotReplay;
    if (!source || !snapshot || !opts.verifyClaimReplay || !isValidOpHlc(provenance.fedHlc)
      || !Number.isFinite(provenance.ts)) return false;
    try {
      const allowed = await opts.verifyClaimReplay(Object.freeze({
        sourceLogKeyHex: source, row: Object.freeze({ ...row }), hbKey,
        hlc: provenance.fedHlc, ts: provenance.ts!, snapshot,
      }));
      if (allowed !== true) return false;
    } catch { return false; }
  }
  // WI-259 P-002 membership guard (see member-content-guard.ts): own-slug applies; a cross-member
  // op applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. resolveAuthorDevice
  // maps the immutable sourceLogKeyHex (provenance.authorPubkey for a remote op) → the admit-verified device.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    // WI-259 P-004: a cross-member op the guard drops ONLY because the author's hive_members row
    // hasn't federated to this peer yet (decision 'defer', author device known) is BUFFERED + re-
    // applied when that member joins (the onMemberApplied drain), instead of lost to the advancing
    // merge cursor. A genuine non-member's op also defers, but the buffer's TTL evicts it (D-007).
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: CLAIMS_TABLE_TAG,
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: async () => { await writeToPg(opts, row, provenance); },
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: CLAIMS_TABLE_TAG,
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: async () => { await writeToPg(opts, row, provenance); },
        },
        Date.now(),
      );
    }
    return false;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const inserted = await sql`
    INSERT INTO harness_shared.feature_claims
      (workspace_id, harness_slug, feature_id, seq,
       claimer_pubkey, claimer_github_user_id, claimed_at,
       outcome, schema_version)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.feature_id}, ${row.seq},
       ${row.claimer_pubkey}, ${row.claimer_github_user_id}, to_timestamp(${row.claimed_at} / 1000.0),
       ${row.outcome ?? null}, ${row.schema_version})
    -- Compatible with both the legacy and author-qualified PK during expansion.
    -- The contract migration is required before distinct-author equal-seq rows persist.
    ON CONFLICT DO NOTHING
    RETURNING claimer_pubkey
  `;
  if (inserted.length > 0) return;
  const existing = await sql`
    SELECT claimer_github_user_id, outcome, schema_version,
      (extract(epoch FROM claimed_at) * 1000)::bigint AS claimed_at_ms
    FROM harness_shared.feature_claims
    WHERE workspace_id=${opts.workspaceId} AND harness_slug=${row.harness_slug}
      AND feature_id=${row.feature_id} AND claimer_pubkey=${row.claimer_pubkey} AND seq=${row.seq}
  `;
  const original = existing[0];
  if (!original) throw new ClaimProjectionSchemaNotReadyError();
  // A reused identity with a modified immutable payload is not an exact replay.
  if (Number(original.claimer_github_user_id) !== row.claimer_github_user_id
    || Number(original.claimed_at_ms) !== row.claimed_at
    || original.outcome !== (row.outcome ?? null)
    || Number(original.schema_version) !== row.schema_version) return false;
}

async function deleteFromPg(opts: FeatureClaimsProjectionOpts, _key: string): Promise<void> {
  // Append-only: never delete from PG.
  void opts;
  void _key;
}

export function buildFeatureClaimsProjection(opts: FeatureClaimsProjectionOpts): TableProjection<FeatureClaimRow> {
  return {
    tableTag: CLAIMS_TABLE_TAG,
    mergeRule: 'append-only',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isFeatureClaimRow,
};
