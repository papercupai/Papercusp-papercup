/**
 * Pins the plan-types agent-insights doc and the plan-completion guidance to the type registry
 * (plan-item-types-registry-cupboard-2026-10-20 P-009, R-23, SPEC-P-009). See ./plan-types-doc.test.ts.
 *
 * Two claims drift silently if nothing checks them:
 *  - the doc's list of seeded first-party item types, which must equal the registry seed
 *    (BUILTIN_CATALOG), and
 *  - the plan-completion guidance (the runbook and the project guide), which must keep the line
 *    saying deliverables resolve through the type registry and linking the doc.
 * The judges are pure so the test can feed them fixtures that MUST fail.
 */

export const PLAN_TYPES_DOC_LINK = '/internal/docs/agent-insights/plan-and-item-types';

/** The sentence in the doc that enumerates the seeded first-party types. */
const SEED_SENTENCE_MARKER = 'seeded first-party types';

export interface Judgement {
  ok: boolean;
  problems: string[];
}

/**
 * The item-type ids the doc says are seeded, in the order written, or null when the doc has no
 * seed sentence (or the sentence no longer separates item types from plan types).
 */
export function documentedBuiltinItemTypes(doc: string): string[] | null {
  const line = doc.split('\n').find((l) => l.includes(SEED_SENTENCE_MARKER));
  if (!line) return null;
  const m = line.match(/item types (.*?)\band plan types\b/);
  if (!m) return null;
  return [...m[1].matchAll(/`([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)`/g)].map((x) => x[1]);
}

/** The doc's seeded item types must be exactly the registry seed's item types. */
export function judgeBuiltinItemTypes(doc: string, seeded: readonly string[]): Judgement {
  const documented = documentedBuiltinItemTypes(doc);
  if (documented === null) {
    return { ok: false, problems: [`the doc has no "${SEED_SENTENCE_MARKER}" sentence listing item types`] };
  }
  const problems: string[] = [];
  const inDoc = new Set(documented);
  const inSeed = new Set(seeded);
  for (const id of seeded) if (!inDoc.has(id)) problems.push(`the doc omits built-in item type ${id}`);
  for (const id of documented) {
    if (!inSeed.has(id)) problems.push(`the doc lists ${id}, which the registry seed does not define`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Plan-completion guidance must keep its item-type line: one line that says deliverables resolve
 * through the type registry AND links the plan-types doc. A link elsewhere, or the sentence
 * without the link, does not count.
 */
export function judgeGuidanceItemTypeLine(label: string, text: string): Judgement {
  const lines = text.split('\n');
  const hasLink = lines.some((l) => l.includes(PLAN_TYPES_DOC_LINK));
  const hasLine = lines.some((l) => /\btype registry\b/.test(l) && l.includes(PLAN_TYPES_DOC_LINK));
  const problems: string[] = [];
  if (!hasLink) problems.push(`${label} does not link ${PLAN_TYPES_DOC_LINK}`);
  else if (!hasLine) problems.push(`${label} links the plan-types doc, but not from its type-registry line`);
  return { ok: problems.length === 0, problems };
}
