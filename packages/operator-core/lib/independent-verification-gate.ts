/**
 * Independent verification of live/deployed evidence: the ship-gate door.
 * verification-system-improvements-2026-10-10 P-008 (D-005; refusal code per D-015 point 4).
 *
 * A mandatory outcome bar (every BAR-derived clause is mandatory, see
 * `bar_snapshot_mandatory_invalid`) whose evidence plane is `live` or `deployed`
 * proves something about a RUNNING system. The implementer who binds that proof is
 * the one party with every reason to read the receipts generously. D-005 asks a
 * second party OUTSIDE the implementers' spawn/rebind lineage to re-resolve the same
 * deployed identity and record an `independent-verification` binding that CITES the
 * implementer binding with the same source and environment fingerprints. The store
 * (`spec-evidence-store.ts`) refuses a mismatched citation at write time; this door
 * refuses shipment with `independent_verification_missing` while any in-scope clause
 * lacks a qualifying row.
 *
 * Scope (recorded as a plan Decision so later readers re-check it, not this comment):
 *  - the clause's CURRENT revision is BAR-derived (`source_bar_key IS NOT NULL`),
 *    lifecycle `active` or `accepted`, and `evidence_plane` IN ('live','deployed');
 *  - the revision was created at or after INDEPENDENT_VERIFICATION_REQUIRED_AFTER.
 *    Earlier revisions were authored before the door existed. A plan that re-revises
 *    its BAR later takes on the rule with the new revision.
 *
 * A row qualifies when it is a non-retracted `independent-verification` binding at the
 * clause's current revision; it cites a non-retracted, non-IV binding on the same spec;
 * both bindings independently measure current through `listSpecEvidence`; their stored
 * fingerprints match; and its author is not lineage-related to any plan implementer or
 * to the author of the binding it cites.
 *
 * Fails CLOSED: an unreadable scope, binding set, currentness measurement, or lineage refuses with
 * `independent_verification_unavailable`, so a broken read never ships an unverified
 * live claim. It is a distinct code, like `spec_coverage_unavailable`, because a failed
 * MEASUREMENT is not author repair work and must not be ranked as one.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { areAcceptanceLineageRelated, resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { listSpecEvidence, type ListSpecEvidenceOptions } from './agent-tools/plans/spec-evidence-store';

/** Clause revisions created before this instant predate the door and are not in scope. */
export const INDEPENDENT_VERIFICATION_REQUIRED_AFTER = '2026-10-11T03:00:00.000Z';

export const INDEPENDENT_VERIFICATION_PLANES = ['live', 'deployed'] as const;

export type IndependentVerificationGapReason =
  /** No live independent-verification row cites a live implementer binding at this revision. */
  | 'no-independent-binding'
  /** A cited pair exists, but at least one side is stale or cannot be measured current. */
  | 'non-current-evidence'
  /** Rows exist, but every author is lineage-related to an implementer or to the cited binder. */
  | 'only-lineage-related';

export interface IndependentVerificationGap {
  specId: string;
  revision: number;
  evidencePlane: string;
  barKey: string;
  reason: IndependentVerificationGapReason;
  /** Independent-verification row ids that were considered and rejected for lineage. */
  rejectedBindingIds: number[];
  /** Binding ids in candidate pairs that were stale or could not be measured current. */
  nonCurrentBindingIds?: number[];
  /** Live implementer (non-IV) bindings at this revision that a verifier can cite. */
  citableBindingIds: number[];
}

export interface IndependentVerificationVerdict {
  satisfied: boolean;
  /** False when no clause is in scope; the door then has nothing to decide. */
  applicable: boolean;
  code?: 'independent_verification_missing' | 'independent_verification_unavailable';
  message?: string;
  inScope: number;
  gaps: IndependentVerificationGap[];
  /** Set when a read failed and the door refused rather than guess. */
  readFailure?: string;
}

interface ScopeRow {
  spec_id: string;
  revision: number;
  evidence_plane: string;
  source_bar_key: string;
}

interface CandidateRow {
  id: number | string;
  spec_id: string;
  verified_binding_id: number | string;
  created_by: string | null;
  verified_created_by: string | null;
}

interface EvidenceCurrentnessRow {
  id: number;
  currentness: {
    overall: 'current' | 'stale' | 'unknown';
    dimensions?: { source?: string; environment?: string };
  };
}

export interface IndependentVerificationDeps {
  sql?: ReturnType<typeof getOrgPg>['sql'];
  resolveImplementers?: (planSlug: string, workspaceId: string) => Promise<string[]>;
  lineageRelated?: (a: string, b: string, workspaceId: string) => Promise<boolean>;
  /** Injectable seam for the canonical, server-measured evidence currentness read. */
  listEvidence?: (options: ListSpecEvidenceOptions) => Promise<EvidenceCurrentnessRow[]>;
}

export async function evaluateIndependentVerificationGate(
  input: { planSlug: string; harnessSlug: string; workspaceId?: string },
  deps: IndependentVerificationDeps = {},
): Promise<IndependentVerificationVerdict> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const sql = deps.sql ?? getOrgPg().sql;
  const resolveImplementers =
    deps.resolveImplementers ?? ((plan, ws) => resolvePlanImplementerIdentities(plan, { workspaceId: ws }));
  const lineageRelated =
    deps.lineageRelated ?? ((a, b, ws) => areAcceptanceLineageRelated(a, b, { workspaceId: ws }));
  const listEvidence = deps.listEvidence ?? listSpecEvidence;

  const refuseUnreadable = (what: string, error: unknown): IndependentVerificationVerdict => {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      satisfied: false,
      applicable: true,
      code: 'independent_verification_unavailable',
      inScope: 0,
      gaps: [],
      readFailure: `${what}: ${detail}`,
      message:
        `plan '${input.planSlug}' cannot be marked shipped: the independent-verification check could not ` +
        `read ${what} (${detail}). The gate refuses rather than ship a live or deployed claim nobody ` +
        'independent has re-observed; repair the read and retry.',
    };
  };

  let scope: ScopeRow[];
  try {
    scope = await sql<ScopeRow[]>`
      SELECT r.spec_id, r.revision, r.evidence_plane, r.source_bar_key
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id = c.workspace_id
         AND r.harness_slug = c.harness_slug
         AND r.plan_slug = c.plan_slug
         AND r.spec_id = c.spec_id
         AND r.revision = c.current_revision
       WHERE c.workspace_id = ${workspaceId}
         AND c.harness_slug = ${input.harnessSlug}
         AND c.plan_slug = ${input.planSlug}
         AND r.source_bar_key IS NOT NULL
         AND r.evidence_plane IN ('live', 'deployed')
         AND r.lifecycle_status IN ('active', 'accepted')
         AND r.created_at >= ${INDEPENDENT_VERIFICATION_REQUIRED_AFTER}::timestamptz
       ORDER BY r.spec_id`;
  } catch (error) {
    return refuseUnreadable('the in-scope live/deployed BAR clauses', error);
  }
  if (scope.length === 0) return { satisfied: true, applicable: false, inScope: 0, gaps: [] };

  let candidates: CandidateRow[];
  try {
    const specIds = scope.map((row) => row.spec_id);
    const revisions = scope.map((row) => row.revision);
    candidates = await sql<CandidateRow[]>`
      WITH in_scope AS (
        SELECT * FROM unnest(${specIds}::text[], ${revisions}::int[]) AS s(spec_id, revision)
      )
      SELECT iv.id, iv.spec_id, src.id AS verified_binding_id,
             iv.created_by, src.created_by AS verified_created_by
        FROM harness_shared.spec_evidence_bindings iv
        JOIN in_scope s
          ON s.spec_id = iv.spec_id
         AND s.revision = iv.spec_revision
        JOIN harness_shared.spec_evidence_bindings src
          ON src.id = iv.verifies_binding_id
       WHERE iv.workspace_id = ${workspaceId}
         AND iv.harness_slug = ${input.harnessSlug}
         AND iv.plan_slug = ${input.planSlug}
         AND iv.evidence_kind = 'independent-verification'
         AND iv.retracted_at IS NULL
         AND src.workspace_id = iv.workspace_id
         AND src.harness_slug = iv.harness_slug
         AND src.plan_slug = iv.plan_slug
         AND src.spec_id = iv.spec_id
         AND src.evidence_kind <> 'independent-verification'
         AND src.retracted_at IS NULL
         AND src.source_fingerprint = iv.source_fingerprint
         AND src.environment_fingerprint IS NOT DISTINCT FROM iv.environment_fingerprint
       ORDER BY iv.id`;
  } catch (error) {
    return refuseUnreadable('the independent-verification bindings', error);
  }

  // Matching fingerprints only proves the verifier copied the same snapshot. Measure
  // both immutable rows against current source/runtime state before accepting the pair.
  const evidenceBindingIds = [...new Set(candidates.flatMap((row) => [
    Number(row.id), Number(row.verified_binding_id),
  ]))];
  const currentnessByBindingId = new Map<number, EvidenceCurrentnessRow['currentness']['overall']>();
  if (evidenceBindingIds.length > 0) {
    let measuredEvidence: EvidenceCurrentnessRow[];
    try {
      measuredEvidence = await listEvidence({
        harnessSlug: input.harnessSlug,
        workspaceId,
        planSlugs: [input.planSlug],
        bindingIds: evidenceBindingIds,
        limit: evidenceBindingIds.length,
      });
    } catch (error) {
      return refuseUnreadable('currentness of the independent-verification evidence pairs', error);
    }
    for (const row of measuredEvidence) currentnessByBindingId.set(Number(row.id), row.currentness.overall);
    if (currentnessByBindingId.size !== evidenceBindingIds.length ||
        evidenceBindingIds.some((id) => !currentnessByBindingId.has(id))) {
      return refuseUnreadable(
        'currentness of the independent-verification evidence pairs',
        new Error(`measured ${currentnessByBindingId.size} of ${evidenceBindingIds.length} requested bindings`),
      );
    }
  }

  // What a recruited verifier would cite (WI-6554700010008529): the refusal names the
  // gap, and the verifier brief needs the exact implementer rows to re-observe.
  let citable: Array<{ id: number | string; spec_id: string }>;
  try {
    citable = await sql<Array<{ id: number | string; spec_id: string }>>`
      WITH in_scope AS (
        SELECT * FROM unnest(${scope.map((row) => row.spec_id)}::text[], ${scope.map((row) => row.revision)}::int[])
          AS s(spec_id, revision)
      )
      SELECT b.id, b.spec_id
        FROM harness_shared.spec_evidence_bindings b
        JOIN in_scope s
          ON s.spec_id = b.spec_id
         AND s.revision = b.spec_revision
       WHERE b.workspace_id = ${workspaceId}
         AND b.harness_slug = ${input.harnessSlug}
         AND b.plan_slug = ${input.planSlug}
         AND b.evidence_kind <> 'independent-verification'
         AND b.retracted_at IS NULL
       ORDER BY b.id`;
  } catch (error) {
    return refuseUnreadable('the implementer bindings a verifier would cite', error);
  }

  let implementers: string[];
  try {
    implementers = await resolveImplementers(input.planSlug, workspaceId);
  } catch (error) {
    return refuseUnreadable('the plan implementer lineage', error);
  }

  const independenceCache = new Map<string, boolean>();
  const isIndependent = async (author: string | null, citedAuthor: string | null): Promise<boolean> => {
    const who = author?.trim() ?? '';
    if (!who) return false;
    const excluded = [...implementers, ...(citedAuthor?.trim() ? [citedAuthor.trim()] : [])];
    const key = `${who}\u0000${excluded.join('\u0001')}`;
    const cached = independenceCache.get(key);
    if (cached !== undefined) return cached;
    let related = false;
    for (const other of excluded) {
      if (other === who || (await lineageRelated(other, who, workspaceId))) {
        related = true;
        break;
      }
    }
    independenceCache.set(key, !related);
    return !related;
  };

  const gaps: IndependentVerificationGap[] = [];
  try {
    for (const clause of scope) {
      const rows = candidates.filter((row) => row.spec_id === clause.spec_id);
      const rejected: number[] = [];
      const nonCurrent = new Set<number>();
      let satisfied = false;
      for (const row of rows) {
        const pairIds = [Number(row.id), Number(row.verified_binding_id)];
        const nonCurrentPairIds = pairIds.filter((id) => currentnessByBindingId.get(id) !== 'current');
        if (nonCurrentPairIds.length > 0) {
          for (const id of nonCurrentPairIds) nonCurrent.add(id);
          continue;
        }
        if (await isIndependent(row.created_by, row.verified_created_by)) {
          satisfied = true;
          break;
        }
        rejected.push(Number(row.id));
      }
      if (!satisfied) {
        gaps.push({
          specId: clause.spec_id,
          revision: clause.revision,
          evidencePlane: clause.evidence_plane,
          barKey: clause.source_bar_key,
          reason: rows.length === 0
            ? 'no-independent-binding'
            : nonCurrent.size > 0
              ? 'non-current-evidence'
              : 'only-lineage-related',
          rejectedBindingIds: rejected,
          ...(nonCurrent.size > 0 ? { nonCurrentBindingIds: [...nonCurrent] } : {}),
          citableBindingIds: citable.filter((row) => row.spec_id === clause.spec_id).map((row) => Number(row.id)),
        });
      }
    }
  } catch (error) {
    return refuseUnreadable('the verifier lineage', error);
  }

  if (gaps.length === 0) return { satisfied: true, applicable: true, inScope: scope.length, gaps };

  const lines = gaps.map((gap) =>
    `${gap.specId}@${gap.revision} (${gap.barKey}, ${gap.evidencePlane}): ` +
    (gap.reason === 'no-independent-binding'
      ? 'no independent-verification binding cites a live implementer binding at this revision'
      : gap.reason === 'non-current-evidence'
        ? `binding(s) ${(gap.nonCurrentBindingIds ?? []).join(', ')} are stale or could not be measured current`
        : `binding(s) ${gap.rejectedBindingIds.join(', ')} were recorded inside the implementer lineage`),
  );
  return {
    satisfied: false,
    applicable: true,
    code: 'independent_verification_missing',
    inScope: scope.length,
    gaps,
    message:
      `plan '${input.planSlug}' cannot be marked shipped: ${gaps.length} live/deployed mandatory outcome bar(s) ` +
      `lack independent verification — ${lines.slice(0, 5).join('; ')}${lines.length > 5 ? ` (+${lines.length - 5} more)` : ''}. ` +
      'An agent outside the implementers\' spawn/rebind lineage must re-resolve the deployed identity, re-read ' +
      "the receipts, and record plans:bind-independent-verification { evidenceKind:'independent-verification', " +
      'verifiesBindingId:<the implementer binding id>, sourceFingerprint and environmentFingerprint equal to ' +
      "that binding's }. Not waivable by force: it is an independence check, like independent grading.",
  };
}

/**
 * The verifier half of a grader brief (WI-6554700010008529).
 *
 * `independent_verification_missing` recruits through the same router as grading: the
 * recruited grader is outside the implementers' lineage by construction, which is
 * exactly the independence D-005 asks of a verifier. Re-observation comes FIRST because
 * a fresh judge's task ends when its scorecard is written.
 */
export function renderIndependentVerificationBrief(
  planSlug: string,
  harnessSlug: string,
  gaps: readonly IndependentVerificationGap[],
): string {
  if (gaps.length === 0) return '';
  const scope = `slug:${JSON.stringify(planSlug)}, harness:${JSON.stringify(harnessSlug)}`;
  const lines = gaps.map((gap) => {
    const citable = gap.citableBindingIds.length > 0
      ? `implementer binding(s) ${gap.citableBindingIds.join(', ')}`
      : 'no live implementer binding to cite; rate the criterion on what you can observe and say so';
    const currentnessNote = gap.reason === 'non-current-evidence'
      ? `; binding(s) ${(gap.nonCurrentBindingIds ?? []).join(', ')} are stale or could not be measured current`
      : '';
    return `- ${gap.specId}@${gap.revision} (${gap.barKey}, ${gap.evidencePlane}): ${citable}${currentnessNote}`;
  });
  return [
    `INDEPENDENT VERIFICATION — do this BEFORE scorecards:emit. ${gaps.length} live/deployed outcome bar(s) of ` +
      `plan '${planSlug}' carry implementer evidence that nobody outside the implementers' lineage has re-observed, ` +
      `and the ship gate refuses independent_verification_missing until each has an independent-verification ` +
      `binding (verification-system-improvements-2026-10-10 D-005). You were recruited outside that lineage. For ` +
      `each clause: (1) read the cited binding with plans:get-spec-evidence { ${scope} } — its evidenceRef, ` +
      `workItemId, details.note/observedVia/instrument and details.currentMeasurement; (2) re-observe the same ` +
      `thing yourself through the read the binding names (for a database census, re-run its read-only ` +
      `dev:pg_query) and compare with the receipt; (3) if it matches, record plans:bind-independent-verification ` +
      `{ ${scope}, binding:{ workItemId, specId, specRevision, evidenceKind:'independent-verification', ` +
      `verifiesBindingId:<the cited id>, evidenceRef:<the same evidenceRef>, measurement:<its ` +
      `details.currentMeasurement, unchanged>, details:{ note:<what you re-observed, when, and through which ` +
      `runtime> } } }. The store re-measures source and environment and refuses a mismatch: report a refusal ` +
      `in your card rather than working around it. If your observation contradicts the receipt, do not bind; ` +
      `rate the affected criterion fail with what you saw.`,
    ...lines,
  ].join('\n');
}
