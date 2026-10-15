/**
 * Hyperbee → PG projection for `harness_shared.pot_settings` — per-Hive settings
 * federated as first-class Hive state (shared-hive-federation-2026-06-08 P-005).
 *
 * Mirrors projections/harness-plans.ts (the closest analog: a workspace-owned key
 * riding the peer-log). The federated subset = the Hive home scope (`harness_slug`
 * = the Hive's home_slug), the `setting_key`, and the JSON-text `value`. NOT
 * federated (machine-local): created_at/updated_at. The standard provenance
 * columns (author_pubkey/origin/fed_ts) carry the echo-guard + LWW.
 *
 * The per-harness guard (`row.harness_slug !== opts.harnessSlug`) demuxes: the
 * Hive home harness's projection applies its Hive's settings ops; everyone else
 * drops them. No hard FK to hives (migration 186), so a setting can land before
 * the local hive identity row materializes on a peer (cross-machine join ordering).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX } from '../../../agent-tools/plans/governance-federation';
import type { PendingMembershipContent } from '../pending-membership-content';

/** Wire-shape of a hive_settings row in Hyperbee — the federated subset. Defensive
 *  on every field: a malformed remote op is dropped (decodeValue → null). */
export interface HiveSettingRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  setting_key: string;
  /** JSON-serialized value (text), or null. */
  value: string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isHiveSettingRow(input: unknown): input is HiveSettingRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.setting_key) || r.setting_key.length === 0) return false;
  if (!isStringOrNull(r.value)) return false;
  return true;
}

export interface HiveSettingsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** Receiver-stamped log key → admitted device, supplied by register-all/boot. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** Reuse boot's bounded membership-ordering buffer and its existing drain. */
  pendingMemberContent?: PendingMembershipContent;
}

function composeKey(row: HiveSettingRow): string {
  return row.setting_key;
}

function decodeValue(raw: unknown): HiveSettingRow | null {
  return isHiveSettingRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HiveSettingsProjectionOpts,
  row: HiveSettingRow,
  provenance: ProvenanceContext,
): Promise<void | false> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  if (row.setting_key.startsWith(PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX)) {
    const { isFederatedGovernanceEvent, planAdmissionGovernanceEventSettingKey,
      resolvePlanAdmissionGovernanceAuthority } = await import('../../../agent-tools/plans/plan-admission-governance-store');
    const { authenticateGovernanceEnvelope, authenticateGovernanceEvent } = await import('../../../agent-tools/plans/governance-authentication');
    let event: unknown;
    try { event = row.value === null ? null : JSON.parse(row.value); } catch { return false; }
    if (!isFederatedGovernanceEvent(event) || event.potId !== opts.harnessSlug ||
        planAdmissionGovernanceEventSettingKey(event) !== row.setting_key) return false;
    if (provenance.origin === 'remote') {
      const device = provenance.authorPubkey ? opts.resolveAuthorDevice?.(provenance.authorPubkey) : null;
      const deferred = { tableTag: 'hive-settings-by-key', rowKey: row.setting_key,
        fedHlc: provenance.fedHlc ?? null, fedTs: provenance.ts ?? null,
        reapply: async () => { await writeToPg(opts, row, provenance); } };
      if (!device) {
        if (provenance.authorPubkey) opts.pendingMemberContent?.deferUnresolvedSourceLog(
          { ...deferred, sourceLogKey: provenance.authorPubkey }, Date.now());
        return false;
      }
      const { listHiveMembers } = await import('../../../hive-membership-store');
      const { unsafeFederatedPotScope } = await import('../../../federated-pot-scope');
      // This is the projection's canonical WRITE binding, never a local joiner alias.
      const members = await listHiveMembers(opts.workspaceId,
        unsafeFederatedPotScope(opts.harnessSlug, 'register-all hiveScoped projection binding'), sql);
      if (members.some(member => member.revokedPubkeys.includes(device))) return false;
      if (!members.some(member => member.deviceAttestations.some(attestation => attestation.device_pubkey === device))) {
        opts.pendingMemberContent?.defer({ ...deferred, authorDevice: device }, Date.now());
        return false;
      }
    }
    const authority = await resolvePlanAdmissionGovernanceAuthority({ workspaceId: opts.workspaceId,
      potHomeSlug: opts.harnessSlug, potId: opts.harnessSlug }, sql);
    const nowMs = Date.now();
    if (!authority || !authenticateGovernanceEnvelope({ authority, event, nowMs }).ok) return false;
    if (event.body.kind === 'round-open' && !authenticateGovernanceEvent({ authority, event, nowMs }).ok) return false;
    // INSERT-only facts. Authenticated members can relay another signer's event;
    // the envelope authenticates the signer independently of the source device.
    // Round/ballot dependencies may arrive later; the consumer always reauthenticates.
    await sql`
      INSERT INTO harness_shared.pot_settings
        (workspace_id, harness_slug, setting_key, value, author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
      VALUES (${opts.workspaceId}, ${row.harness_slug}, ${row.setting_key}, ${row.value},
        ${provenance.authorPubkey ?? null}, ${provenance.origin}, ${provenance.ts ?? null},
        ${provenance.fedHlc ?? null}, ${nowMs}, ${nowMs})
      ON CONFLICT (workspace_id, harness_slug, setting_key) DO NOTHING
    `;
    return;
  }
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  // D-001: the op's HLC ordering key — the SAME causal key the merge fold uses.
  const fedHlc = provenance?.fedHlc ?? null;
  const now = Date.now();
  // workspace_id is the LOCAL projection's bound workspace. created_at is set on
  // first insert + preserved on update; only value/provenance/updated_at move.
  await sql`
    INSERT INTO harness_shared.pot_settings
      (workspace_id, harness_slug, setting_key, value, author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.setting_key}, ${row.value},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, setting_key) DO UPDATE SET
      value         = EXCLUDED.value,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_at    = ${now}
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.pot_settings.fed_hlc, harness_shared.pot_settings.fed_ts)
  `;
}

async function deleteFromPg(
  opts: HiveSettingsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void | false> {
  if (!key) return;
  if (key.startsWith(PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX)) return false;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.pot_settings
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND setting_key = ${key}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildHiveSettingsProjection(
  opts: HiveSettingsProjectionOpts,
): TableProjection<HiveSettingRow> {
  return {
    tableTag: 'hive-settings-by-key',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHiveSettingRow,
};
