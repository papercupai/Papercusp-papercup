/**
 * VAL-* inline assertion retirement (plan verification-system-improvements-2026-10-10,
 * P-003; decisions D-001 and D-008).
 *
 * Inline `[VAL-...]` assertion blocks under plan items were the old way to attach a
 * validation bar to a plan item. The requirement contract (spec clauses, acceptance
 * BARs and bound evidence) supersedes every capability they had, so they are
 * RETIRED rather than folded in:
 *
 *   - promotion refuses any plan item that still carries a VAL block
 *     (`val-block-retired`), instead of silently dropping it now that nothing
 *     stores it. A block too malformed to parse is still a header-shaped line, so
 *     the fail-closed property of the old gate survives;
 *   - every former writer of the legacy assertion store answers with
 *     `val-write-retired` instead of writing to a sink nothing reads;
 *   - every former reader route answers with `val-read-retired` (HTTP 410).
 *
 * The legacy rows are kept for audit (no DROP — D-008 step 5) and
 * `plan_spec_clauses.source_val_id` stays as the provenance join key for VALs that
 * were migrated into clauses (D-008 step 2).
 *
 * Refusal messages deliberately do NOT spell the legacy table's name: the P-003
 * source census pins that no non-test source file names it at all.
 */

/** Every refusal code this retirement can return. Single source for the union. */
export const VAL_RETIREMENT_REFUSAL_CODES = [
  'val-block-retired',
  'val-write-retired',
  'val-read-retired',
] as const;

export type ValRetirementRefusalCode = (typeof VAL_RETIREMENT_REFUSAL_CODES)[number];

/** The surface that replaces VAL-* assertions. */
export const VAL_RETIREMENT_SUCCESSOR = 'requirement-contract' as const;

/** The doc that explains the successor surface. */
export const VAL_RETIREMENT_DOC = '/internal/docs/spec/validation-assertion-format' as const;

export interface ValRetirementRefusal {
  ok: false;
  code: ValRetirementRefusalCode;
  /** HTTP status a route should answer with: 409 for a refused promotion, 410 otherwise. */
  httpStatus: 409 | 410;
  message: string;
  successor: typeof VAL_RETIREMENT_SUCCESSOR;
  doc: typeof VAL_RETIREMENT_DOC;
  /** What the caller should do instead. */
  repair: string;
}

const REPAIR: Record<ValRetirementRefusalCode, string> = {
  'val-block-retired':
    'Remove the inline [VAL-...] block and state the validation bar as a requirement-contract ' +
    'clause instead: plans:set-specs for the clause, then plans:bind-spec-evidence once it ' +
    'is met.',
  'val-write-retired':
    'Inline VAL-* assertions are no longer stored. Author the bar as a requirement-contract clause ' +
    '(plans:set-specs) and bind its evidence (plans:bind-spec-evidence).',
  'val-read-retired':
    'Inline VAL-* assertions are retired. Read the requirement contract instead: plans:get returns ' +
    'spec clauses and their bound evidence.',
};

const SUMMARY: Record<ValRetirementRefusalCode, string> = {
  'val-block-retired': 'inline VAL-* assertion blocks are retired',
  'val-write-retired': 'storing inline VAL-* assertions is retired',
  'val-read-retired': 'reading inline VAL-* assertions is retired',
};

/** Build the typed refusal for one retirement code. `detail` is appended to the message. */
export function valRetirementRefusal(
  code: ValRetirementRefusalCode,
  detail?: string,
): ValRetirementRefusal {
  return {
    ok: false,
    code,
    httpStatus: code === 'val-block-retired' ? 409 : 410,
    message: `${code}: ${SUMMARY[code]}${detail ? ` — ${detail}` : ''}. ${REPAIR[code]}`,
    successor: VAL_RETIREMENT_SUCCESSOR,
    doc: VAL_RETIREMENT_DOC,
    repair: REPAIR[code],
  };
}

/**
 * An indented list item whose text opens with `[VAL-` (optionally bold) — the header
 * line of an inline VAL block. Same shape as `VAL_BLOCK_HEADER_PG_PATTERN` in
 * `verification-health.ts`, which the health cell uses for the live census; the
 * retirement test pins that the two agree.
 */
export const VAL_BLOCK_HEADER_LINE_RE = /^[ \t]{1,8}-[ \t]+\*{0,2}\[VAL-([^\]\s]*)/;

/** A top-level plan item line: `- **P-007** ...`. */
const PLAN_ITEM_LINE_RE = /^-\s+\*\*(P-\d{3,})\*\*/;

export interface ValBlockOccurrence {
  /** The plan item the block sits under, or null when it precedes every item. */
  planItemId: string | null;
  /** `VAL-<id>` as written (may be malformed). */
  valId: string;
  /** 1-based line number in the raw plan. */
  line: number;
}

/**
 * Find every inline VAL block header in a raw plan body. When `itemIds` is given
 * and non-empty, only blocks under those plan items are returned. A prose mention
 * of `[VAL-` (not an indented list item) is NOT a block.
 */
export function findValBlocks(
  rawPlan: string,
  itemIds?: ReadonlySet<string>,
): ValBlockOccurrence[] {
  const out: ValBlockOccurrence[] = [];
  let currentItem: string | null = null;
  const lines = rawPlan.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = PLAN_ITEM_LINE_RE.exec(line);
    if (item) {
      currentItem = item[1];
      continue;
    }
    const header = VAL_BLOCK_HEADER_LINE_RE.exec(line);
    if (!header) continue;
    if (itemIds && itemIds.size > 0 && (currentItem === null || !itemIds.has(currentItem))) {
      continue;
    }
    out.push({ planItemId: currentItem, valId: `VAL-${header[1]}`, line: i + 1 });
  }
  return out;
}
