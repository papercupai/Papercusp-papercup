/**
 * Catch a stranded acceptance-BAR subject-revision pin up to the plan's current
 * revision (EI-22752422043395332, WI-6554700010010492).
 *
 * Lives in its own module on purpose: `acceptance-bar-amendment.ts` is the measured
 * SOURCE of live proof clauses on unshipped plans, and any edit to its bytes stales
 * every one of them. This file only COMPOSES that module's exported synchronizer.
 */
import { withWorkspace } from '@papercusp/db-org';
import { synchronizeAcceptanceBarSubjectRevision } from './acceptance-bar-amendment';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { hashPlanContent } from './agent-tools/plans/content-hash';

/** Which stored body supplied the "old" side of the catch-up. */
export type StaleAcceptanceBarSubjectPinWitness = 'pinned_revision' | 'activation_audit';

export type StaleAcceptanceBarSubjectPinResult =
  | { reconciled: true; fromRevision: number; toRevision: number; witness: StaleAcceptanceBarSubjectPinWitness }
  | {
      reconciled: false;
      reason:
        | 'plan_absent'
        | 'not_bar_subject'
        | 'rubric_pin_absent'
        | 'pin_current'
        | 'no_witness'
        | 'not_neutral';
    };

/** `synchronizeAcceptanceBarSubjectRevision` only runs on the write that changes the
 * body, and only when the OLD body is at hand. A neutral write that landed while the
 * serving build predated the synchronizer (a `← WI-… released` item-note reflection,
 * a decision-only `plans:add-decision` served by a stale `:3070`) leaves the rubric pin
 * behind with nothing to re-trigger it, and every door then refuses
 * `bar_snapshot_rubric_revision_mismatch` forever.
 *
 * This supplies the missing old body and defers to the synchronizer, so every safety
 * rule stays in ONE place: source fingerprints must be identical (a Requirements /
 * Bar-to-work-map change stays stale and must go through `rubrics:amend`), the rubric
 * must still be at the pinned revision, and its barSetHash must still match.
 *
 * Witnesses, in order (WI-6554700010010492):
 *  1. `plan_revisions` at `seq = barContract.subjectPlanRevision` — the exact body the
 *     pin names. This is the only witness that survives a `rubrics:amend` of the
 *     Requirements: after one, the activation snapshot can never be source-equal to
 *     the current body, so a later neutral write would otherwise strand the pin for good.
 *  2. The plan's latest ACTIVATION audit snapshot (the witness `plans:audit` uses for
 *     its own catch-up), for plans whose revision history lacks the pinned row.
 * A witness is trusted only when its bytes still hash to its recorded hash. No usable
 * witness, or a semantic change against every witness, is a refusal to repair, never a
 * guess. Takes the subject's advisory lock itself.
 */
export async function reconcileStaleAcceptanceBarSubjectPin(args: {
  workspaceId: string; harnessSlug: string; planSlug: string; ttlSec?: number;
}): Promise<StaleAcceptanceBarSubjectPinResult> {
  const budgetMs = (args.ttlSec ?? 5) * 1000;
  try {
    return await withWorkspace(args.workspaceId, async (tx) => {
      await acquirePlanAdvisoryLock(
        tx,
        planAdvisoryLockKey(args.workspaceId, args.harnessSlug, args.planSlug),
        budgetMs,
      );
      const [subject] = await tx<Array<{
        version: number | string; content: string; acceptance_bar_rubric_slug: string | null;
      }>>`
        SELECT version, content, acceptance_bar_rubric_slug
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
           AND plan_slug = ${args.planSlug}`;
      if (!subject) return { reconciled: false as const, reason: 'plan_absent' as const };
      if (!subject.acceptance_bar_rubric_slug) {
        return { reconciled: false as const, reason: 'not_bar_subject' as const };
      }
      // The pin, plus the revision row it names. Compared as text so a malformed pin can
      // never raise a cast error inside the join; it simply finds no row.
      const [pinned] = await tx<Array<{
        subject_version: string | null; content_snapshot: string | null; content_hash: string | null;
      }>>`
        SELECT rubric.template_data->'barContract'->>'subjectPlanRevision' AS subject_version,
               r.content_snapshot, r.content_hash
          FROM harness_shared.harness_plans rubric
          LEFT JOIN harness_shared.plan_revisions r
            ON r.workspace_id = ${args.workspaceId} AND r.harness_slug = ${args.harnessSlug}
           AND r.plan_slug = ${args.planSlug}
           AND r.seq::text = rubric.template_data->'barContract'->>'subjectPlanRevision'
         WHERE rubric.workspace_id = ${args.workspaceId} AND rubric.harness_slug = ${args.harnessSlug}
           AND rubric.plan_slug = ${subject.acceptance_bar_rubric_slug}`;
      const pin = Number(pinned?.subject_version);
      const version = Number(subject.version);
      if (pinned?.subject_version == null || !Number.isSafeInteger(pin)) {
        return { reconciled: false as const, reason: 'rubric_pin_absent' as const };
      }
      if (pin === version) return { reconciled: false as const, reason: 'pin_current' as const };

      const tried = new Set<string>();
      let sawWitness = false;
      const attempt = async (
        body: string | null | undefined,
        hash: string | null | undefined,
        witness: StaleAcceptanceBarSubjectPinWitness,
      ): Promise<StaleAcceptanceBarSubjectPinResult | null> => {
        // The snapshot must be the bytes that were recorded; a corrupted or rewritten
        // revision row is not a witness.
        if (body == null || !hash || hashPlanContent(body) !== hash) return null;
        sawWitness = true;
        if (tried.has(hash)) return null;
        tried.add(hash);
        const moved = await synchronizeAcceptanceBarSubjectRevision(tx, {
          workspaceId: args.workspaceId, harnessSlug: args.harnessSlug, planSlug: args.planSlug,
          previousBody: body, nextBody: subject.content,
          previousVersion: pin, nextVersion: version,
        });
        return moved ? { reconciled: true as const, fromRevision: pin, toRevision: version, witness } : null;
      };

      const fromPinned = await attempt(pinned.content_snapshot, pinned.content_hash, 'pinned_revision');
      if (fromPinned) return fromPinned;

      const [activation] = await tx<Array<{ content_snapshot: string; content_hash: string }>>`
        SELECT r.content_snapshot, r.content_hash
          FROM (
            SELECT audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash
              FROM harness_shared.plan_audits
             WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
               AND plan_slug = ${args.planSlug} AND audit_kind = 'activation'
             ORDER BY audit_seq DESC LIMIT 1
          ) a
          JOIN harness_shared.plan_revisions r
            ON r.id = a.audited_plan_revision_id AND r.seq = a.audited_plan_revision_seq
           AND r.content_hash = a.audited_plan_content_hash
           AND r.workspace_id = ${args.workspaceId} AND r.harness_slug = ${args.harnessSlug}
           AND r.plan_slug = ${args.planSlug}`;
      const fromActivation = await attempt(activation?.content_snapshot, activation?.content_hash, 'activation_audit');
      if (fromActivation) return fromActivation;

      return sawWitness
        ? { reconciled: false as const, reason: 'not_neutral' as const }
        : { reconciled: false as const, reason: 'no_witness' as const };
    });
  } catch (error) {
    // A busy lock must never turn a refusal into a crash at a start door: the caller
    // re-reads the lifecycle and refuses exactly as before.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '55P03' || (error as Error | null)?.message === 'acceptance_bar_subject_revision_rubric_busy') {
      return { reconciled: false, reason: 'not_neutral' };
    }
    throw error;
  }
}
