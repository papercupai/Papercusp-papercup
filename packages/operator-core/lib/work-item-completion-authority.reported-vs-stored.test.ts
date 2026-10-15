/**
 * EI-21574559473613348 — `reconcileStampedAuthority`: what work_items:complete REPORTS
 * must be what the database actually STORED.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
 * The completion content-identity floor is enforced in TWO places. In-process, by
 * `committedCloseDowngradedForUnprovenContentIdentity` (see
 * agent-tools/work_items/complete.content-identity-floor.test.ts). And in SQL, by
 * migration 972's BEFORE trigger `harness_shared.downgrade_unproven_committed_close()`,
 * which exists so a frozen release build serving older code cannot mint stronger
 * authority than current source permits.
 *
 * That second enforcement point is invisible to the caller. It rewrites 'committed' to
 * 'proposed' and RAISEs a WARNING, which reaches the Postgres log and nobody else. So a
 * close was told 'committed' by the tool and stored as 'proposed' in the same write, and
 * the agent truthfully relayed a false status to its owner. Measured when this was filed:
 * 291 rows in the `proposed` + declares-files + no-content-identity bucket, still
 * accruing, against 3,143 pre-trigger rows that stopped 2m45s before migration 972 was
 * applied (2026-08-26T11:49:09Z).
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────────
 * Falsifiability runs both directions. The DIVERGENCE cases fail any implementation that
 * reports the computed value (the bug). The AGREEMENT and FALLBACK cases fail a
 * degenerate implementation that always reports 'proposed' or always claims a downgrade.
 * The ATTRIBUTION cases are the sharp ones: they fail an implementation that treats every
 * 'proposed' outcome as a content-identity downgrade, which would hand a caller whose
 * evidence was merely insufficient a remedy naming fields they already sent — the
 * refusal-loop shape EI-18685043434033870 already cost us once.
 */
import { describe, expect, it } from 'vitest';

import { reconcileStampedAuthority } from './work-item-completion-authority';

/** The shape of a well-evidenced close whose declared files were not committed yet. */
const closeDeclaringFiles = {
  stamped: true as const,
  computed: 'committed' as const,
  authorityByEvidence: 'committed',
  declaredFilesCount: 2,
  inProcessContentIdentityMissing: false,
};

describe('reconcileStampedAuthority (EI-21574559473613348)', () => {
  describe('DIVERGENCE — the stored value wins', () => {
    it('reports the trigger-downgraded value, not the committed one this process computed', () => {
      // The exact shape of EI-21555184293160902: the deployed build computed 'committed'
      // and said so; the migration-972 trigger stored 'proposed'.
      const out = reconcileStampedAuthority({ ...closeDeclaringFiles, persisted: 'proposed' });

      expect(out.stampedAuthority).toBe('proposed');
      expect(out.divergedFromComputed).toBe(true);
      expect(out.contentIdentityDowngrade).toBe(true);
    });

    it('attributes a DB-side downgrade to content identity even when the in-process floor did not fire', () => {
      // This is the whole bug: in-process said nothing was wrong, so keying the remedy to
      // the in-process flag alone produced generic "supply evidence" advice instead.
      const out = reconcileStampedAuthority({
        ...closeDeclaringFiles,
        persisted: 'proposed',
        inProcessContentIdentityMissing: false,
      });

      expect(out.contentIdentityDowngrade).toBe(true);
    });
  });

  describe('AGREEMENT — an unaffected close is unchanged', () => {
    it('keeps committed when the row agrees, and claims no downgrade', () => {
      const out = reconcileStampedAuthority({ ...closeDeclaringFiles, persisted: 'committed' });

      expect(out.stampedAuthority).toBe('committed');
      expect(out.divergedFromComputed).toBe(false);
      expect(out.contentIdentityDowngrade).toBe(false);
    });

    it('still reports the in-process downgrade when that is what happened', () => {
      const out = reconcileStampedAuthority({
        ...closeDeclaringFiles,
        computed: 'proposed',
        persisted: 'proposed',
        inProcessContentIdentityMissing: true,
      });

      expect(out.stampedAuthority).toBe('proposed');
      expect(out.contentIdentityDowngrade).toBe(true);
      expect(out.divergedFromComputed).toBe(false);
    });
  });

  describe('FALLBACK — a writer that stamps no authority is untouched', () => {
    it('falls back to the computed value when the row carries none (legacy / system paths)', () => {
      const out = reconcileStampedAuthority({ ...closeDeclaringFiles, persisted: null });

      expect(out.stampedAuthority).toBe('committed');
      expect(out.divergedFromComputed).toBe(false);
    });

    it('reports nothing at all when this call stamped no close', () => {
      // No terminal state reached, or the state write was rejected. Reporting an authority
      // here would tell the caller their close was graded when no close happened.
      const out = reconcileStampedAuthority({
        ...closeDeclaringFiles,
        stamped: false,
        persisted: 'proposed',
      });

      expect(out.stampedAuthority).toBeNull();
      expect(out.contentIdentityDowngrade).toBe(false);
      expect(out.divergedFromComputed).toBe(false);
    });
  });

  describe('ATTRIBUTION — never blame content identity for ordinary weak evidence', () => {
    it('does not claim a content-identity downgrade when the evidence itself was insufficient', () => {
      // authorityByEvidence never reached 'committed', so the floor was never the reason.
      // Telling this caller to "re-run verification from a committed tree" would send them
      // after the wrong thing entirely.
      const out = reconcileStampedAuthority({
        ...closeDeclaringFiles,
        computed: 'proposed',
        persisted: 'proposed',
        authorityByEvidence: 'proposed',
      });

      expect(out.stampedAuthority).toBe('proposed');
      expect(out.contentIdentityDowngrade).toBe(false);
    });

    it('does not blame content identity when a later evidence finding lowered a committed base grade', () => {
      // A requirement-disposition finding can lower otherwise sufficient evidence from
      // `authorityByEvidence: committed` to the final `computed: proposed`. The matching
      // stored proposal is that finding's outcome, not a DB-side content-identity downgrade.
      const out = reconcileStampedAuthority({
        ...closeDeclaringFiles,
        computed: 'proposed',
        persisted: 'proposed',
        authorityByEvidence: 'committed',
        inProcessContentIdentityMissing: false,
      });

      expect(out.stampedAuthority).toBe('proposed');
      expect(out.divergedFromComputed).toBe(false);
      expect(out.contentIdentityDowngrade).toBe(false);
    });

    it('does not claim a content-identity downgrade when no files were declared', () => {
      // Both the TS guard and the SQL trigger skip a close with an empty filesChanged —
      // there is nothing whose content could be proven.
      const out = reconcileStampedAuthority({
        ...closeDeclaringFiles,
        persisted: 'proposed',
        declaredFilesCount: 0,
      });

      expect(out.contentIdentityDowngrade).toBe(false);
    });
  });
});
