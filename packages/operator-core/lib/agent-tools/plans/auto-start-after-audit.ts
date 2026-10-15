/**
 * Auto-activation at the end of an activation audit (WI-10008137).
 *
 * Owner decision [owner 2026-10-10, directives #1607 / #1613 / #1614]: a draft
 * plan activates at the END of its `plans:audit { phase:'activation' }`, whether or
 * not any item has started. Before this, an audited plan stayed `draft` until someone
 * remembered to call `plans:start`, and work routinely began anyway; measured
 * 2026-10-10: 72 of 140 draft plans had wip/done items.
 *
 * Activation runs the REAL `plans:start`, never a bare frontmatter flip. `plans:start`
 * enforces more than the conversation audit: the start gate, dependency validity, the
 * spec-quality chain for first-class spec adopters, and the plan-start checkpoint
 * consult. A bare `draft → ready` write would satisfy only the audit gate and skip
 * the rest. If `plans:start` refuses, the plan stays draft and the refusal is returned
 * to the auditor verbatim, so the response names what is still missing.
 */
import { parsePlan } from './parser';

/** Calls `plans:start` for one slug; returns the tool's raw `{ data }` result. */
export type PlanStartInvoker = (args: { slug: string; harness?: string }) => Promise<unknown>;

export type AutoStartOutcome =
  | {
      attempted: false;
      /** Why no start was attempted: the plan was not draft, or its content was unreadable. */
      reason: 'not-draft' | 'no-content';
      status: string | null;
    }
  | {
      attempted: true;
      started: true;
      /** False when plans:start found the plan already started (idempotent no-op). */
      transitioned: boolean;
      autoApproved: boolean;
    }
  | {
      attempted: true;
      started: false;
      /** plans:start's own refusal, e.g. consult_available / spec_quality_not_current. */
      refusal: { error: string; message?: string };
    };

interface StartItemResult {
  ok?: boolean;
  error?: unknown;
  message?: unknown;
  hint?: unknown;
  transitioned?: unknown;
  autoApproved?: unknown;
}

function firstStartResult(raw: unknown): StartItemResult | null {
  const data = (raw as { data?: unknown } | null | undefined)?.data;
  const results = (data as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  return first && typeof first === 'object' ? (first as StartItemResult) : null;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Activate a draft plan right after its activation audit was recorded.
 *
 * Never throws: the audit is already durable when this runs, so a failed start is
 * reported as a refusal on an otherwise successful audit response.
 */
export async function autoStartAfterActivationAudit(input: {
  slug: string;
  harness?: string;
  /** The plan body as read by the audit (its frontmatter carries the lifecycle status). */
  planContent: string | null | undefined;
  start: PlanStartInvoker;
}): Promise<AutoStartOutcome> {
  if (!input.planContent) return { attempted: false, reason: 'no-content', status: null };
  const status = parsePlan(input.planContent, { filePath: `${input.slug}.md` }).frontmatter.status ?? null;
  if (status !== 'draft') return { attempted: false, reason: 'not-draft', status };

  let raw: unknown;
  try {
    raw = await input.start({ slug: input.slug, ...(input.harness ? { harness: input.harness } : {}) });
  } catch (error) {
    return {
      attempted: true,
      started: false,
      refusal: {
        error: 'auto_start_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const result = firstStartResult(raw);
  if (!result) {
    return {
      attempted: true,
      started: false,
      refusal: { error: 'auto_start_unreadable', message: 'plans:start returned no per-plan result.' },
    };
  }
  if (result.ok !== true) {
    const message = asText(result.message) ?? asText(result.hint);
    return {
      attempted: true,
      started: false,
      refusal: {
        error: asText(result.error) ?? 'plans_start_refused',
        ...(message ? { message } : {}),
      },
    };
  }
  return {
    attempted: true,
    started: true,
    transitioned: result.transitioned === true,
    autoApproved: result.autoApproved === true,
  };
}
