/**
 * WI-6554700010018038 (plan bug-inflow-one-problem-one-row-2026-10-18, R-9 lever).
 *
 * Transient and rate-limit tool failures are volume-gated by the invocation watchdog
 * (`toolErrorSignalsFromRows` files one only past its count/rate/hours bar), so agent reports
 * of one must not reach the work lane on their own. A report of a volume-gated class is
 * COUNTED on its probation row: it is promoted neither at birth by the legacy direct-evidence
 * booleans (`improvements:capture`) nor by a second agent reporter (`capture-core`).
 *
 * Kept as its own module (not in capture-core.ts) so a test that auto-mocks capture-core
 * still exercises the real gate from capture.ts.
 */
import type { ToolErrorClass } from './tool-error-classifier';

export function isVolumeGatedToolErrorClass(klass: ToolErrorClass | undefined): boolean {
  return klass === 'transient' || klass === 'rate-limit';
}

/**
 * True for an incoming probation payload whose agent corroboration must count, not promote.
 * An explicitly promoted payload (structured directEvidence, or the watchdog's own filing) is
 * not gated: it already carries the evidence the gate asks for.
 */
export function isVolumeGatedToolFailureProbation(
  probation: { state?: 'probation' | 'promoted'; class?: ToolErrorClass } | null | undefined,
): boolean {
  return probation?.state === 'probation' && isVolumeGatedToolErrorClass(probation.class);
}
