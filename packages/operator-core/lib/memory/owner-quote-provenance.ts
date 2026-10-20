/**
 * Owner-quote provenance AT RECALL TIME (EI-26515229747561182).
 *
 * A memory can ASSERT that the owner said something ("Owner directive,
 * 2026-08-13, verbatim: …") but cannot PROVE it: the store keeps no link from a
 * memory to the turn it quotes, and nothing marks a quote whose source turn was
 * machine-generated. Measured 2026-10-20: memory 068c3d28 carried exactly such a
 * quote. EI-20639052308179310 had shown on 2026-08-16 that every match was a
 * `machine-surface` compaction summary with zero owner-typed turns, yet recall kept
 * delivering it with full apparent authority for two months, and an agent repeated
 * it to the owner as his own directive. A provenance finding filed elsewhere never
 * reached the memory, so the class lives at the READ: recall marks every claimed
 * owner quote as unverified, which is the turn-provenance rule the compaction
 * strategy already states (an owner directive must trace to an owner-typed turn).
 *
 * Same design as `recall-staleness.ts`, deliberately:
 *  - notable-only: a memory that quotes no one is returned untouched, by identity;
 *  - the banner rides the BODY, prepended, because orient's memory fold keeps only
 *    `{ id, memory, score }` and clips each hit to 200 chars, so a sibling field
 *    alone would be discarded before the most-called recall surface renders it;
 *  - pure, synchronous and total: no DB read, so it cannot slow or fail a recall.
 *
 * The detector is a claim detector, not a truth oracle. It flags text that
 * ATTRIBUTES words or instructions to the owner. A memory about owner tooling
 * ("the owner-only flag") or the owner-gated-wall concept is not a claim and stays
 * unflagged; tests pin both directions.
 */

/** Short on purpose: orient clips each folded hit to 200 chars, banner included. */
export const OWNER_QUOTE_BANNER = '⚠ UNVERIFIED OWNER QUOTE — check turn_origin before citing. ';

/**
 * Phrases that attribute speech or a directive to the owner. Each pattern needs an
 * attribution verb/noun right after "owner" (or a provenance tag), so a bare
 * mention of the owner does not match.
 */
const OWNER_ATTRIBUTION = [
  // "Owner directive", "owner's instruction", "the owner said/asked/wants/ruled"
  /\bowner(?:['’]s)?\s+(?:directive|instruction|mandate|order|ruling|decision|request|quote|said|says|wrote|asked|wants|told|ruled|stated|requires|required)\b/i,
  // provenance tag claiming the owner as source: [owner:<name> <date>]
  /\[owner:[^\]\n]{1,80}\]/i,
  // "… verbatim" within one clause of "owner"
  /\bowner\b[^.\n]{0,80}\bverbatim\b/i,
  /\bverbatim\b[^.\n]{0,40}\bowner\b/i,
];

/** Does this memory body attribute words or a directive to the owner? */
export function claimsOwnerQuote(text: string): boolean {
  return OWNER_ATTRIBUTION.some((re) => re.test(text));
}

/** The structured verdict on the wire, beside the banner (snake_case like its peers). */
export interface OwnerQuoteProvenanceWire {
  owner_quote: 'unverified';
}

type QuotableRow = { memory?: unknown } & Record<string, unknown>;

/**
 * Mark every recalled row whose body claims an owner quote. Apply it AFTER tier
 * shaping and after the staleness banner, so this warning is outermost and is never
 * clipped away. Rows that claim nothing come back untouched and by identity.
 */
export function applyOwnerQuoteProvenance<T extends QuotableRow>(
  rows: T[],
): Array<T & { provenance?: OwnerQuoteProvenanceWire }> {
  return rows.map((row) => {
    const body = row.memory;
    if (typeof body !== 'string' || body.startsWith(OWNER_QUOTE_BANNER) || !claimsOwnerQuote(body)) {
      return row;
    }
    return { ...row, memory: `${OWNER_QUOTE_BANNER}${body}`, provenance: { owner_quote: 'unverified' as const } };
  });
}
