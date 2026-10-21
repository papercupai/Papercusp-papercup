/**
 * The acceptance BAR recovery path for an ORPHANED started contract
 * (WI-6554700010018395).
 *
 * An orphan is an acceptance rubric whose subject plan still pins it (rubric slug,
 * adopted epoch, seeding stamp, BAR-set hash, rubric revision R), while the rubric's
 * live template_data has lost its server-owned `barContract`. A whole-document
 * `rubrics:propose` served by a build that predated the in-lock boundary guard
 * produced exactly this on 2026-10-18 (:3070 d740fc3802). The tip guard
 * (`guardAcceptanceBarTemplateDataWrite`) then refuses every generic write to the
 * orphan, which is correct but left no door to repair it.
 *
 * This module is the PURE half of the door: it decides whether a restore is
 * admissible and which immutable revision snapshot is the witness. The write itself
 * is the ordinary started-contract amendment transaction in rubrics.ts, run with the
 * witness substituted as the stored rubric. Every safety rule of that transaction
 * (approval for meaning changes, subject re-pin, clause re-projection with proof
 * carry, invalidation accounting) therefore stays in one place.
 *
 * The witness is never inferred. It must be the single enriched snapshot that names
 * the pinned revision exactly, and its contract must agree with the subject pin on
 * epoch, cohort, subject plan and BAR-set hash. Anything else refuses.
 */

export interface AcceptanceBarSubjectPin {
  rubricSlug: string | null;
  rubricRevision: number | null;
  barSetHash: string | null;
  epoch: number | null;
  cohort: string | null;
  seededAt: string | null;
  seededBy: string | null;
}

export interface AcceptanceBarRestoreCandidate {
  /** plan_revisions.seq of the snapshot row (diagnostic only). */
  seq: number;
  /** The rubric revision the enriched envelope claims, when it carries one. */
  rubricRevision?: number;
  templateData: unknown;
}

export type AcceptanceBarRestoreRefusalCode =
  | 'acceptance_bar_restore_not_acceptance'
  | 'acceptance_bar_restore_not_orphaned'
  | 'acceptance_bar_restore_subject_not_adopted'
  | 'acceptance_bar_restore_subject_pins_other_rubric'
  | 'acceptance_bar_restore_pin_not_behind'
  | 'acceptance_bar_restore_witness_missing'
  | 'acceptance_bar_restore_witness_ambiguous'
  | 'acceptance_bar_restore_witness_mismatch';

export type AcceptanceBarRestoreSelection =
  | {
      ok: true;
      pinnedRevision: number;
      witnessSeq: number;
      barSetHash: string;
      templateData: Record<string, unknown>;
    }
  | { ok: false; code: AcceptanceBarRestoreRefusalCode; detail: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function refuse(code: AcceptanceBarRestoreRefusalCode, detail: string): AcceptanceBarRestoreSelection {
  return { ok: false, code, detail };
}

/** Pick the witness revision that restores an orphaned started BAR contract, or refuse. */
export function selectOrphanedAcceptanceBarWitness(input: {
  rubricSlug: string;
  currentRevision: number;
  storedTemplateData: unknown;
  pin: AcceptanceBarSubjectPin;
  candidates: readonly AcceptanceBarRestoreCandidate[];
}): AcceptanceBarRestoreSelection {
  const stored = record(input.storedTemplateData);
  if (!stored || stored.kind !== 'acceptance') {
    return refuse('acceptance_bar_restore_not_acceptance', `rubric '${input.rubricSlug}' is not an acceptance rubric`);
  }
  if (record(stored.barContract)) {
    return refuse(
      'acceptance_bar_restore_not_orphaned',
      `rubric '${input.rubricSlug}' still carries its barContract; amend it without restoreOrphanedBarContract`,
    );
  }
  const { pin } = input;
  if (!pin.epoch || pin.epoch <= 0 || !pin.seededAt || !pin.seededBy || !pin.barSetHash || pin.rubricRevision == null) {
    return refuse(
      'acceptance_bar_restore_subject_not_adopted',
      `subject plan '${String(stored.subjectPlan)}' never seeded a BAR contract (epoch/seed stamp/set hash/rubric revision missing); ` +
        'there is no adopted contract to restore — seed it through plans:audit phase:\'activation\'',
    );
  }
  if (pin.rubricSlug !== input.rubricSlug) {
    return refuse(
      'acceptance_bar_restore_subject_pins_other_rubric',
      `subject plan pins '${pin.rubricSlug ?? '(none)'}', not '${input.rubricSlug}'`,
    );
  }
  if (!(input.currentRevision > pin.rubricRevision)) {
    return refuse(
      'acceptance_bar_restore_pin_not_behind',
      `rubric '${input.rubricSlug}' is at revision ${input.currentRevision}, not after the pinned revision ${pin.rubricRevision}; ` +
        'no later write can have orphaned the pinned contract',
    );
  }
  const exact = input.candidates.filter((candidate) => candidate.rubricRevision === pin.rubricRevision);
  if (exact.length === 0) {
    return refuse(
      'acceptance_bar_restore_witness_missing',
      `no immutable snapshot names rubric revision ${pin.rubricRevision}; a contract is never reconstructed from inference`,
    );
  }
  if (exact.length > 1) {
    return refuse(
      'acceptance_bar_restore_witness_ambiguous',
      `${exact.length} snapshots (seq ${exact.map((c) => c.seq).join(', ')}) claim rubric revision ${pin.rubricRevision}`,
    );
  }
  const witness = exact[0]!;
  const data = record(witness.templateData);
  const contract = record(data?.barContract);
  const mismatches: string[] = [];
  if (!data || data.kind !== 'acceptance') mismatches.push('kind');
  if (!contract) mismatches.push('barContract absent');
  if (data && data.subjectPlan !== stored.subjectPlan) mismatches.push('subjectPlan');
  if (data && data.barSetHash !== pin.barSetHash) mismatches.push('barSetHash');
  if (contract && contract.adoptionEpoch !== pin.epoch) mismatches.push('adoptionEpoch');
  if (contract && pin.cohort != null && contract.cohort !== pin.cohort) mismatches.push('cohort');
  if (mismatches.length > 0 || !data) {
    return refuse(
      'acceptance_bar_restore_witness_mismatch',
      `snapshot seq ${witness.seq} for rubric revision ${pin.rubricRevision} disagrees with the subject pin on: ${mismatches.join(', ')}`,
    );
  }
  return {
    ok: true,
    pinnedRevision: pin.rubricRevision,
    witnessSeq: witness.seq,
    barSetHash: pin.barSetHash,
    templateData: data,
  };
}
