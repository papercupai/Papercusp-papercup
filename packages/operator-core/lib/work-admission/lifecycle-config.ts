/**
 * Which lifecycle reactions an admission rule runs (linear-asana-task-sync-2026-10-05 P-003).
 *
 * Stored as `admission_rules.lifecycle` (migration 1387). An empty object means the defaults: every
 * reaction on, and completion moves the source to `done` (owner answer #1417, plan D-006). A work
 * item admitted by a person, not a rule, also gets the defaults. lifecycle.ts runs the reactions.
 *
 * Kept free of other work-admission imports so admission-rules.ts can validate a rule's lifecycle
 * without an import cycle through lifecycle.ts.
 */

import { isTicketStatusCategory, type TicketStatusCategory } from '../data-sources/ticket-vocabulary';

/**
 * How the fixes for a rule's admitted work reach the subject repository
 * (slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-013, D-015):
 *   - `direct`: whatever the target pot's git-sync does (today's behaviour);
 *   - `pr`: ONLY through the target pot's working copy (hiveGit.integration = review, with a
 *     fork) and its standing PR. A `pr` rule is refused when saved, and refuses every admission,
 *     while its target harness is not in that state (pr-delivery.ts), so PR-required work can
 *     never be dispatched into a pot that pushes straight to the main repository.
 * Kept on the lifecycle object (no new column) because it governs how admitted work travels to
 * completion, which is what the lifecycle already describes.
 */
export const ADMISSION_DELIVERIES = ['direct', 'pr'] as const;
export type AdmissionDelivery = (typeof ADMISSION_DELIVERIES)[number];

export interface AdmissionLifecycle {
  /** On claim: move the source to `in-progress` and comment who picked it up. */
  claim: boolean;
  /** On needs-human / blocked: comment the question the item is waiting on. */
  hold: boolean;
  /** On completion: comment the completion summary and move the source to `completeCategory`. */
  complete: boolean;
  /** The workflow category a completed item's source moves to. */
  completeCategory: TicketStatusCategory;
  /** On an outside close or cancel: drop an unclaimed item, hold a claimed one for its holder. */
  externalClose: boolean;
  /** On an outside reopen of a finished item that the rule still matches: reopen the item. */
  reopen: boolean;
  /** How the admitted work's fixes reach the subject repository ({@link AdmissionDelivery}). */
  delivery: AdmissionDelivery;
  /**
   * Recruit the agents that move this rule's admitted work forward (repair-recruiter.ts,
   * WI-6554700010018302): an independent reviewer for a pending agent-review round, then an
   * implementer for a reviewed bug nobody has claimed. OFF by default — it launches agents on its
   * own, which is a fleet-autonomy escalation, so a pot opts in per rule. With it off, the same
   * pass only raises a condition work-item when admitted work has been stranded for hours.
   */
  recruit: boolean;
}

export const DEFAULT_ADMISSION_LIFECYCLE: Readonly<AdmissionLifecycle> = Object.freeze({
  claim: true,
  hold: true,
  complete: true,
  completeCategory: 'done',
  externalClose: true,
  reopen: true,
  delivery: 'direct',
  recruit: false,
});

const SWITCHES = ['claim', 'hold', 'complete', 'externalClose', 'reopen', 'recruit'] as const;

/**
 * Validates a lifecycle setting supplied by a caller and returns it with defaults filled in.
 * Unknown keys and wrong types are refused (`admission_rule_invalid:`), so a misspelt switch
 * cannot silently leave a reaction on.
 */
export function parseAdmissionLifecycle(raw: unknown): AdmissionLifecycle {
  if (raw === undefined || raw === null) return { ...DEFAULT_ADMISSION_LIFECYCLE };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('admission_rule_invalid: lifecycle must be an object');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set<string>([...SWITCHES, 'completeCategory', 'delivery']);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `admission_rule_invalid: unknown lifecycle key(s) ${unknown.join(', ')}; allowed: ${[...known].join(', ')}`,
    );
  }
  const out: AdmissionLifecycle = { ...DEFAULT_ADMISSION_LIFECYCLE };
  for (const key of SWITCHES) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new Error(`admission_rule_invalid: lifecycle.${key} must be a boolean`);
    out[key] = input[key] as boolean;
  }
  if (input.completeCategory !== undefined) {
    if (typeof input.completeCategory !== 'string' || !isTicketStatusCategory(input.completeCategory)) {
      throw new Error('admission_rule_invalid: lifecycle.completeCategory must be a ticket status category');
    }
    out.completeCategory = input.completeCategory;
  }
  if (input.delivery !== undefined) {
    if (typeof input.delivery !== 'string' || !(ADMISSION_DELIVERIES as readonly string[]).includes(input.delivery)) {
      throw new Error(`admission_rule_invalid: lifecycle.delivery must be one of ${ADMISSION_DELIVERIES.join(', ')}`);
    }
    out.delivery = input.delivery as AdmissionDelivery;
  }
  return out;
}

/**
 * The lifecycle a stored rule runs. Stored values were validated on write, so this only fills
 * defaults; a malformed stored value (hand-edited row) falls back to the defaults rather than
 * stopping the sync that reads it.
 *
 * Except `delivery`, which fails CLOSED: a stored object whose `delivery` is anything other
 * than absent or exactly 'direct' resolves to 'pr', even when the rest of the object is
 * malformed, so a damaged row can never quietly turn PR-required work into direct pushes.
 */
export function resolveAdmissionLifecycle(stored: unknown): AdmissionLifecycle {
  try {
    return parseAdmissionLifecycle(stored);
  } catch {
    return { ...DEFAULT_ADMISSION_LIFECYCLE, delivery: storedDeliveryFailClosed(stored) };
  }
}

function storedDeliveryFailClosed(stored: unknown): AdmissionDelivery {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return 'direct';
  const delivery = (stored as Record<string, unknown>).delivery;
  return delivery === undefined || delivery === 'direct' ? 'direct' : 'pr';
}
