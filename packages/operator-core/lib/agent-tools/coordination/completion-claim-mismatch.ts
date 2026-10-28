/**
 * Detect completion claims whose named artifacts are absent from the sender's
 * session-derived `basedOn` trace.
 *
 * This is deliberately an additive send-time stamp, not a refusal. The trace
 * already records what the sender read; this helper only compares that fact
 * with the explicit artifact names in a completion-shaped message. A reader
 * can then see the contradiction without having to rediscover it from the
 * sender's session.
 */

import type { BasedOnEntry, MessageSection } from './message-fields';

export const COMPLETION_CLAIM_MISMATCH_FIELD = 'completionClaimMismatch';

export interface CompletionClaimMismatchStamp {
  kind: 'unread-artifact';
  /** Artifact refs named by the sender, in first-seen order. */
  declaredRefs: string[];
  /** Declared refs with no equivalent entry in `basedOn`. */
  missingFromBasedOn: string[];
  note: 'claims completion on artifacts absent from the recent read trace';
}

export interface CompletionClaimInput {
  summary?: string;
  body?: string | readonly Pick<MessageSection, 'text' | 'premises'>[];
  planSlug?: string;
  goalRef?: string;
  basedOn?: readonly Pick<BasedOnEntry, 'ref'>[];
}

// Match the prose boundaries used by ref-hydrate's BODY_WORK_ITEM: ids inside
// hyphenated filenames/handles are identifier fragments, not artifact refs.
const WORK_ITEM_REF = /(?<![\w-])((?:WI|EI)-\d+)(?![\w-])/gi;
const PLAN_TOKEN = /\bplan:([a-z0-9][a-z0-9-]*)/gi;
const PLAN_LABEL = /\bplan(?:_slug)?\s*[:=]\s*[`'\"]?([a-z0-9][a-z0-9-]*)/gi;
const PLAN_QUOTED = /\bplan\b[^`'\"\n]{0,24}[`'\"]([a-z0-9][a-z0-9-]*)[`'\"]/gi;
const RUBRIC_REF = /\brubricRef\s*[:=]\s*[`'\"]?([a-z0-9][a-z0-9-]*)/gi;
const RUBRIC_QUOTED = /\brubric\b[^`'\"\n]{0,24}[`'\"]([a-z0-9][a-z0-9-]*)[`'\"]/gi;
const COMPLETION_WORD =
  /\b(?:completed?|finished|shipped|verified?|accepted?|graded?|passed|resolved|closed|delivered)\b/gi;
const IMPLICIT_PLAN_COMPLETION =
  /\b(?:(?:the|this|current|parent|derived)\s+)?plan\b\s+(?:(?:is|was|has(?:\s+been)?|were)\s+)?(?:completed?|finished|shipped|verified?|accepted?|graded?|passed|resolved|closed|delivered)\b|\b(?:completed?|finished|shipped|verified?|accepted?|graded?|passed|resolved|closed|delivered)\b\s+(?:(?:the|this|current|parent|derived)\s+)?plan\b/gi;
const NEGATION_TAIL = /\b(?:not|never|no|without|didn['’]t|doesn['’]t|isn['’]t|wasn['’]t|weren['’]t|cannot|can['’]t)\s*(?:(?:yet|been|be|actually|already)\s+)*$/i;
const FUTURE_MARKER =
  /\b(?:will|shall|would|could|should|may|might|can|going\s+to|planning\s+to|plan(?:s|ned|ning)?\s+to|intend(?:s|ed|ing)?\s+to|next|up\s+next|later|after\s+this|then\s+(?:i\s+)?(?:will|shall|read|reconcile|inspect|review|checkpoint|investigate|verify|check|examine|validate|run|fix|update|write|record))\b/i;
const PROSPECTIVE_INTENT = /\b(?:read-only|this\s+unit|this\s+pass|upcoming|follow-up|future|reconciliation|checkpointing)\b/i;

function slug(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[.,;:)\]}]+$/, '');
  return /^[a-z0-9][a-z0-9-]*-[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

function addRef(out: string[], seen: Set<string>, ref: string): void {
  if (seen.has(ref)) return;
  seen.add(ref);
  out.push(ref);
}

function collectMatches(
  text: string,
  re: RegExp,
  map: (match: RegExpExecArray) => string | null,
  out: string[],
  seen: Set<string>,
  skip?: (match: RegExpExecArray) => boolean,
): void {
  re.lastIndex = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (skip?.(match)) continue;
    const ref = map(match);
    if (ref) addRef(out, seen, ref);
  }
}

function textOf(input: CompletionClaimInput): string {
  const body = Array.isArray(input.body)
    ? input.body
        .map((section) => section.text)
        .join('\n')
    : (input.body ?? '');
  return [input.summary ?? '', body].filter(Boolean).join('\n');
}

function hasPositiveCompletionClaim(text: string): boolean {
  COMPLETION_WORD.lastIndex = 0;
  for (let match = COMPLETION_WORD.exec(text); match; match = COMPLETION_WORD.exec(text)) {
    // A completion verb can itself be a plan/rubric slug component
    // (`plan:shipped-feature`, `verified-change`). Treat those identifier
    // fragments as artifact names, not as a second positive claim that can
    // defeat negation on the surrounding sentence.
    const beforeChar = text[match.index - 1];
    const afterChar = text[match.index + match[0].length];
    if (beforeChar === '-' || afterChar === '-') continue;
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!NEGATION_TAIL.test(before) && !FUTURE_MARKER.test(text.slice(0, match.index))) return true;
  }
  return false;
}

function hasImplicitPlanCompletionClaim(text: string): boolean {
  IMPLICIT_PLAN_COMPLETION.lastIndex = 0;
  for (let match = IMPLICIT_PLAN_COMPLETION.exec(text); match; match = IMPLICIT_PLAN_COMPLETION.exec(text)) {
    const planIndex = match[0].toLowerCase().indexOf('plan');
    const planEnd = match.index + planIndex + 'plan'.length;
    // An explicit `plan:<slug>` is collected by the named-ref matchers. It must
    // not cause the routing-envelope planSlug to be inferred as a second target.
    if (text[planEnd] === ':') continue;

    COMPLETION_WORD.lastIndex = 0;
    const completion = COMPLETION_WORD.exec(match[0]);
    if (!completion) continue;
    const completionIndex = match.index + completion.index;
    const beforeChar = text[completionIndex - 1];
    const afterChar = text[completionIndex + completion[0].length];
    if (beforeChar === '-' || afterChar === '-') continue;
    const before = text.slice(Math.max(0, completionIndex - 24), completionIndex);
    if (NEGATION_TAIL.test(before) || FUTURE_MARKER.test(text.slice(0, completionIndex))) continue;
    return true;
  }
  return false;
}

function collectExplicitPremises(input: CompletionClaimInput, out: string[], seen: Set<string>): void {
  if (!Array.isArray(input.body)) return;
  for (const section of input.body) {
    if (!section.text.split(/[.!?;\n]+/).some(hasPositiveCompletionClaim)) continue;
    for (const premise of section.premises ?? []) {
      const workItem = /^(?:work-item:)?((?:WI|EI)-\d+)(?:#.*)?$/i.exec(premise.trim());
      if (workItem) {
        addRef(out, seen, `work-item:${workItem[1]!.toUpperCase()}`);
        continue;
      }
      const plan = /^plan:([a-z0-9][a-z0-9-]*)(?:#.*)?$/i.exec(premise.trim());
      if (plan) {
        addRef(out, seen, `plan:${plan[1]!.toLowerCase()}`);
        continue;
      }
      const planDecision = /^([a-z0-9][a-z0-9-]+)#(?:P|D)-\d+$/i.exec(premise.trim());
      if (planDecision) addRef(out, seen, `plan:${planDecision[1]!.toLowerCase()}`);
    }
  }
}

function isFutureIntentReference(text: string, index: number): boolean {
  let clauseStart = index;
  while (clauseStart > 0 && !/[.!?;\n]/.test(text[clauseStart - 1]!)) clauseStart -= 1;

  const beforeReference = text.slice(clauseStart, index);
  if (FUTURE_MARKER.test(beforeReference)) return true;

  // A present-tense hand-off such as "I am limiting this unit to fresh
  // read-only reconciliation of WI-…" is prospective even without a modal
  // verb. Keep an explicit completion verb as the stronger, past-tense signal
  // so "completed read-only reconciliation of WI-…" remains a claim.
  return PROSPECTIVE_INTENT.test(beforeReference) && !hasPositiveCompletionClaim(beforeReference);
}

function comparisonRef(ref: string): string {
  const trimmed = ref.trim().toLowerCase();
  // Rubrics are stored as rubric-template plans. `rubrics:get` therefore
  // contributes plan:<slug> to basedOn while the message keeps rubric:<slug>
  // as the more useful human-facing declaration.
  return trimmed.startsWith('rubric:') ? `plan:${trimmed.slice('rubric:'.length)}` : trimmed;
}

function comparisonWorkItemGoalRef(goalRef: string | undefined): string | null {
  const match = /^(?:work-item:)?((?:WI|EI)-\d+)$/i.exec(goalRef?.trim() ?? '');
  return match ? `work-item:${match[1]!.toLowerCase()}` : null;
}

/**
 * Return the additive mismatch stamp, or undefined when the message is not a
 * positive completion claim or every named artifact is represented in basedOn.
 */
export function completionClaimRefs(input: CompletionClaimInput): string[] {
  // A verified wake or a completed task elsewhere in a report does not make
  // pending owner requests into completion claims. Preserve statement boundaries.
  const statements = textOf(input).split(/[.!?;\n]+/).filter(hasPositiveCompletionClaim);
  if (!statements.length) return [];
  const declaredRefs: string[] = [];
  const seen = new Set<string>();
  for (const text of statements) {
    const skipFutureIntent = (match: RegExpExecArray): boolean => isFutureIntentReference(text, match.index);
    collectMatches(text, WORK_ITEM_REF, (match) => `work-item:${match[1]!.toUpperCase()}`, declaredRefs, seen, skipFutureIntent);
    collectMatches(text, PLAN_TOKEN, (match) => `plan:${match[1]!.toLowerCase()}`, declaredRefs, seen, skipFutureIntent);
    collectMatches(
      text,
      PLAN_LABEL,
      (match) => {
        const value = slug(match[1]!);
        return value ? `plan:${value}` : null;
      },
      declaredRefs,
      seen,
      skipFutureIntent,
    );
    collectMatches(
      text,
      PLAN_QUOTED,
      (match) => {
        const value = slug(match[1]!);
        return value ? `plan:${value}` : null;
      },
      declaredRefs,
      seen,
      skipFutureIntent,
    );
    collectMatches(
      text,
      RUBRIC_REF,
      (match) => {
        const value = slug(match[1]!);
        return value ? `rubric:${value}` : null;
      },
      declaredRefs,
      seen,
      skipFutureIntent,
    );
    collectMatches(
      text,
      RUBRIC_QUOTED,
      (match) => {
        const value = slug(match[1]!);
        return value ? `rubric:${value}` : null;
      },
      declaredRefs,
      seen,
      skipFutureIntent,
    );
  }
  collectExplicitPremises(input, declaredRefs, seen);
  // planSlug is routing context, not a completion artifact by itself. Infer it
  // only when an affirmative clause actually says the plan was completed; an
  // unrelated verified artifact elsewhere in the message is not enough.
  if (input.planSlug && statements.some(hasImplicitPlanCompletionClaim)) {
    const plan = slug(input.planSlug);
    if (plan) addRef(declaredRefs, seen, `plan:${plan}`);
  }
  return declaredRefs;
}

export function completionClaimMismatch(input: CompletionClaimInput): CompletionClaimMismatchStamp | undefined {
  const declaredRefs = completionClaimRefs(input);
  if (!declaredRefs.length) return undefined;
  const readRefs = new Set((input.basedOn ?? []).map((entry) => comparisonRef(entry.ref)));
  const goalRef = comparisonWorkItemGoalRef(input.goalRef);
  // A human-facing completion summary may abbreviate the current work-item ID.
  // Use that prefix only when the exact structured goal is itself in the
  // derived read trace; an unrelated longer ID in basedOn is not a match.
  const goalWasRead = goalRef !== null && readRefs.has(goalRef);
  const missingFromBasedOn = declaredRefs.filter((ref) => {
    const normalized = comparisonRef(ref);
    if (readRefs.has(normalized)) return false;
    if (!goalWasRead || !normalized.startsWith('work-item:')) return true;
    return !goalRef.startsWith(normalized) || goalRef.length === normalized.length;
  });
  if (!missingFromBasedOn.length) return undefined;

  return {
    kind: 'unread-artifact',
    declaredRefs,
    missingFromBasedOn,
    note: 'claims completion on artifacts absent from the recent read trace',
  };
}
