/**
 * Backfill `harness_plans.verification_profile` for plans that predate the plans:new stamp
 * (plan-verification-profiles-2026-10-17 P-002, requirement R-6; decisions D-001 and D-005).
 *
 * The rule (R-6), read from each plan's completion-audit HISTORY — the effective per-item
 * entry across every pass, newest first (`foldEffectiveItemAudits`, D-006 of the audit plan):
 *   - any live audited item with a verdict other than `not-code`   -> coding  (basis code-audit)
 *   - every live audited item is `not-code`                         -> general (basis all-not-code-audit)
 *   - no live audited item                                          -> the harness default (D-005):
 *       a code-producing harness blueprint -> coding, another registered harness -> general,
 *       an unknown or unresolvable harness -> coding (fail safe).
 * `dropped` audit entries are not live and never decide the class.
 *
 * Writes `verification_profile_source = 'backfill'` and fills NULL rows only, so a declared or
 * plans:new stamp is never overwritten and a second run updates nothing. The write touches only
 * the two profile columns: migration 1537 masks them from the federation row clock, so the
 * backfill leaves fed_ts / fed_hlc / origin as they were, and `updated_at` only moves on a
 * meaningful change (set_harness_plans_updated_at), so plan freshness is unchanged too.
 *
 * R-6's acceptance is that every shipped plan keeps its ship verdict. `diffShipVerdicts` is the
 * comparator the live before/after census uses; the census itself evaluates the real gate.
 */
import type postgres from 'postgres';
import type { VerificationProfile } from '@papercusp/plan-parser';
import { isNonCodeAuditVerdict } from '../../plan-verification-profile';
import { foldEffectiveItemAudits, type AuditItemEntry } from '../../plan-audits';
import { resolveNewPlanVerificationProfile, type HarnessIsCoding } from './plan-verification-profile-stamp';

export type AuditHistoryClass = 'code' | 'all-not-code' | 'none';

/** Classify a plan from its effective audit entries. `dropped` entries are not live. */
export function classifyAuditHistory(
  entries: ReadonlyArray<{ verdict?: unknown }> | null | undefined,
): AuditHistoryClass {
  if (!Array.isArray(entries)) return 'none';
  const live = entries.filter(
    (entry) => entry && typeof entry === 'object' && typeof entry.verdict === 'string' && entry.verdict !== 'dropped',
  );
  if (live.length === 0) return 'none';
  return live.every((entry) => isNonCodeAuditVerdict(entry.verdict as string)) ? 'all-not-code' : 'code';
}

export type BackfillBasis =
  | 'code-audit'
  | 'all-not-code-audit'
  | 'harness-default:coding-harness'
  | 'harness-default:non-coding-harness'
  | 'harness-default:harness-unresolved'
  | 'harness-default:no-harness';

export interface BackfillDecision {
  profile: VerificationProfile;
  basis: BackfillBasis;
}

/** The R-6 decision for one plan. */
export async function decideBackfillProfile(input: {
  auditEntries: ReadonlyArray<{ verdict?: unknown }> | null | undefined;
  harnessSlug: string | null;
  workspaceId: string;
  isCoding?: HarnessIsCoding;
}): Promise<BackfillDecision> {
  const cls = classifyAuditHistory(input.auditEntries);
  if (cls === 'code') return { profile: 'coding', basis: 'code-audit' };
  if (cls === 'all-not-code') return { profile: 'general', basis: 'all-not-code-audit' };
  const fallback = await resolveNewPlanVerificationProfile({
    harnessSlug: input.harnessSlug,
    workspaceId: input.workspaceId,
    isCoding: input.isCoding,
  });
  return { profile: fallback.profile, basis: `harness-default:${fallback.basis}` as BackfillBasis };
}

export interface BackfillOptions {
  /** Write the decisions. False (the default) reports what would be written. */
  execute?: boolean;
  workspaceId?: string;
  harnessSlug?: string;
  /** Test seam for the harness-default leg; production resolves the harness blueprint. */
  isCoding?: HarnessIsCoding;
}

export interface BackfillRow {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  status: string | null;
  profile: VerificationProfile;
  basis: BackfillBasis;
}

export interface BackfillReport {
  executed: boolean;
  /** Plans with a NULL profile when the run started. */
  candidates: number;
  /** Rows the UPDATE changed (0 on a dry run; can trail `candidates` when a stamp raced it). */
  updated: number;
  byProfile: Record<VerificationProfile, number>;
  byBasis: Partial<Record<BackfillBasis, number>>;
  rows: BackfillRow[];
}

interface CandidateRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  status: string | null;
}

interface AuditPassRow {
  workspace_id: string;
  plan_slug: string;
  audit_seq: number;
  items: unknown;
}

const UPDATE_CHUNK = 500;

export async function backfillPlanVerificationProfiles(
  sql: postgres.Sql,
  opts: BackfillOptions = {},
): Promise<BackfillReport> {
  const workspaceFilter = opts.workspaceId ? sql`AND p.workspace_id = ${opts.workspaceId}` : sql``;
  const harnessFilter = opts.harnessSlug ? sql`AND p.harness_slug = ${opts.harnessSlug}` : sql``;
  const candidates = await sql<CandidateRow[]>`
    SELECT p.workspace_id, p.harness_slug, p.plan_slug, p.status
      FROM harness_shared.harness_plans p
     WHERE p.verification_profile IS NULL
       ${workspaceFilter}
       ${harnessFilter}
     ORDER BY p.workspace_id, p.harness_slug, p.plan_slug
  `;

  // Every completion pass for the candidate plans, newest first per plan. plan_audits is keyed by
  // (workspace_id, plan_slug, audit_seq), so the join ignores harness_slug, as the gate's reads do.
  const passes = candidates.length === 0 ? [] : await sql<AuditPassRow[]>`
    SELECT pa.workspace_id, pa.plan_slug, pa.audit_seq, pa.items
      FROM harness_shared.plan_audits pa
      JOIN harness_shared.harness_plans p
        ON p.workspace_id = pa.workspace_id AND p.plan_slug = pa.plan_slug
     WHERE pa.audit_kind = 'completion'
       AND p.verification_profile IS NULL
       ${workspaceFilter}
       ${harnessFilter}
     ORDER BY pa.workspace_id, pa.plan_slug, pa.audit_seq DESC
  `;
  const passesByPlan = new Map<string, Array<{ auditSeq: number; items: AuditItemEntry[] }>>();
  for (const pass of passes) {
    const key = `${pass.workspace_id}\u0000${pass.plan_slug}`;
    const list = passesByPlan.get(key) ?? [];
    list.push({ auditSeq: pass.audit_seq, items: Array.isArray(pass.items) ? (pass.items as AuditItemEntry[]) : [] });
    passesByPlan.set(key, list);
  }

  // One blueprint resolution per harness, however many plans it owns.
  const harnessCoding = new Map<string, Promise<boolean | null>>();
  const isCoding = opts.isCoding;
  const memoIsCoding: HarnessIsCoding = (slug, workspaceId) => {
    const key = `${workspaceId}\u0000${slug}`;
    let pending = harnessCoding.get(key);
    if (!pending) {
      pending = isCoding
        ? isCoding(slug, workspaceId)
        : import('../../harness/routines/hive-release-env').then(({ resolveHarnessIsCoding }) =>
            resolveHarnessIsCoding(slug, workspaceId),
          );
      harnessCoding.set(key, pending);
    }
    return pending;
  };

  const rows: BackfillRow[] = [];
  for (const candidate of candidates) {
    const planPasses = passesByPlan.get(`${candidate.workspace_id}\u0000${candidate.plan_slug}`) ?? [];
    const effective = foldEffectiveItemAudits(planPasses).map(({ entry }) => entry);
    const decision = await decideBackfillProfile({
      auditEntries: effective,
      harnessSlug: candidate.harness_slug,
      workspaceId: candidate.workspace_id,
      isCoding: memoIsCoding,
    });
    rows.push({
      workspaceId: candidate.workspace_id,
      harnessSlug: candidate.harness_slug,
      planSlug: candidate.plan_slug,
      status: candidate.status,
      ...decision,
    });
  }

  let updated = 0;
  if (opts.execute) {
    for (let start = 0; start < rows.length; start += UPDATE_CHUNK) {
      const chunk = rows.slice(start, start + UPDATE_CHUNK);
      const result = await sql`
        UPDATE harness_shared.harness_plans p
           SET verification_profile = v.profile,
               verification_profile_source = 'backfill'
          FROM unnest(
                 ${chunk.map((r) => r.workspaceId)}::text[],
                 ${chunk.map((r) => r.harnessSlug)}::text[],
                 ${chunk.map((r) => r.planSlug)}::text[],
                 ${chunk.map((r) => r.profile)}::text[]
               ) AS v(workspace_id, harness_slug, plan_slug, profile)
         WHERE p.workspace_id = v.workspace_id
           AND p.harness_slug = v.harness_slug
           AND p.plan_slug = v.plan_slug
           AND p.verification_profile IS NULL
      `;
      updated += result.count;
    }
  }

  const byProfile: Record<VerificationProfile, number> = { coding: 0, general: 0 };
  const byBasis: Partial<Record<BackfillBasis, number>> = {};
  for (const row of rows) {
    byProfile[row.profile] += 1;
    byBasis[row.basis] = (byBasis[row.basis] ?? 0) + 1;
  }
  return { executed: opts.execute === true, candidates: candidates.length, updated, byProfile, byBasis, rows };
}

// ---------------------------------------------------------------------------
// The ship-verdict census comparator (R-6 acceptance).
// ---------------------------------------------------------------------------

export interface ShipVerdictSnapshot {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  satisfied: boolean | null;
  code: string | null;
  /** Every independent blocker code (`collectAllBlockers`), sorted; compared as a set. */
  blockers?: string[];
  /** The gate's skip reason; a re-evaluating census must never see `already-shipped`. */
  skipped?: string | null;
  /** Set when the gate threw; the census reports it rather than guessing a verdict. */
  error?: string;
}

/**
 * The gate options a census uses: re-evaluate an already-shipped plan in full (no
 * `already-shipped` skip, no closure observation) and report every independent blocker.
 */
export const SHIP_VERDICT_CENSUS_GATE_OPTS = { reevaluateShipped: true, collectAllBlockers: true } as const;

/** Snapshot one gate verdict for the census. */
export function shipVerdictSnapshot(
  plan: Pick<ShipVerdictSnapshot, 'workspaceId' | 'harnessSlug' | 'planSlug'>,
  gate: { satisfied: boolean; code?: string | null; skipped?: string | null; blockers?: ReadonlyArray<{ code: string }> },
): ShipVerdictSnapshot {
  return {
    ...plan,
    satisfied: gate.satisfied,
    code: gate.code ?? null,
    blockers: [...new Set((gate.blockers ?? []).map((b) => b.code))].sort(),
    skipped: gate.skipped ?? null,
  };
}

export interface ShipVerdictDiff {
  compared: number;
  unchanged: number;
  changed: Array<{ key: string; before: ShipVerdictSnapshot; after: ShipVerdictSnapshot }>;
  onlyBefore: string[];
  onlyAfter: string[];
}

export function shipVerdictKey(s: Pick<ShipVerdictSnapshot, 'workspaceId' | 'harnessSlug' | 'planSlug'>): string {
  return `${s.workspaceId}/${s.harnessSlug}/${s.planSlug}`;
}

/**
 * A plan's verdict changed when it went satisfied <-> refused, changed its primary refusal code,
 * changed its blocker set, or threw on one side only.
 */
export function diffShipVerdicts(
  before: readonly ShipVerdictSnapshot[],
  after: readonly ShipVerdictSnapshot[],
): ShipVerdictDiff {
  const afterByKey = new Map(after.map((s) => [shipVerdictKey(s), s]));
  const beforeKeys = new Set<string>();
  const changed: ShipVerdictDiff['changed'] = [];
  let unchanged = 0;
  for (const b of before) {
    const key = shipVerdictKey(b);
    beforeKeys.add(key);
    const a = afterByKey.get(key);
    if (!a) continue;
    const same =
      a.satisfied === b.satisfied
      && a.code === b.code
      && (a.blockers ?? []).join(',') === (b.blockers ?? []).join(',')
      && Boolean(a.error) === Boolean(b.error);
    if (same) unchanged += 1;
    else changed.push({ key, before: b, after: a });
  }
  return {
    compared: unchanged + changed.length,
    unchanged,
    changed,
    onlyBefore: [...beforeKeys].filter((k) => !afterByKey.has(k)),
    onlyAfter: [...afterByKey.keys()].filter((k) => !beforeKeys.has(k)),
  };
}
