/**
 * Ideation-origin classification of a work-item — the ONE definition behind the claim-spec
 * `item_class` field (plan scout-su-ideate-pipeline-gaps-2026-10-08 P-005, R-10/R-11;
 * EI-18697923246606437).
 *
 * WHY THIS EXISTS. Before it, no claim-spec field could tell a Scout/su-ideate product idea
 * from engineering work, so a keyword title glob (`*p2p*`, `*federation*`) pulled ideas that
 * merely MENTION a lane keyword into engineering lanes, and members released them unworked.
 *
 * WHAT COUNTS AS IDEATION (measured on the live papercusp workspace, 2026-10-08):
 *  - `payload.sourceRole === 'Scout'` — Scout-authored items (1,011 rows). It is NOT enough on
 *    its own: every one of the 301 su-ideate routed work-items carries no `sourceRole`.
 *  - `payload.ideaOrigin` present — stamped by {@link recordRoutedIdea} for an idea routed to a
 *    `wi:` ref from an ideation origin (and backfilled from `scout_routed_ideas` by migration).
 *  - NOT `payload.ideaLifecycle`: it rides on ~48.6k rows, i.e. nearly every item — it is the
 *    generic lifecycle, not an ideation marker.
 *  - NOT `agent-review` ledger rows: routed-ledger.ts documents those as queue plumbing (intake
 *    promotion), not an ideation pass.
 *
 * PARITY. The claim-spec is evaluated on two paths — SQL (get-next.ts FIELD_MAP) and JS
 * (claim-spec-match.ts) — and WI-38326 is the recorded cost of them disagreeing. So the
 * definition is payload-only (the JS subject sees only the item's own payload; a ledger EXISTS
 * would be invisible to it) and the class is never NULL: `'ideation' | 'work'`, so a negation
 * cannot fall into SQL's three-valued-logic hole. {@link ITEM_CLASS_SQL_TEXT} and
 * {@link itemClassOfPayload} must answer identically for every payload shape.
 */

/** Routed-ledger origins that are ideation producers (see RoutedIdeaOrigin in routed-ledger.ts). */
export const IDEATION_LEDGER_ORIGINS = ['scout', 'su-ideate', 'dream'] as const;
export type IdeationLedgerOrigin = (typeof IDEATION_LEDGER_ORIGINS)[number];

/** The payload key {@link recordRoutedIdea} stamps on an ideation-routed work-item. */
export const IDEA_ORIGIN_PAYLOAD_KEY = 'ideaOrigin' as const;
/** The `payload.sourceRole` value Scout writes on the items it authors. */
export const SCOUT_SOURCE_ROLE = 'Scout' as const;

export const ITEM_CLASSES = ['ideation', 'work'] as const;
export type ItemClass = (typeof ITEM_CLASSES)[number];

export function isIdeationLedgerOrigin(origin: string | null | undefined): origin is IdeationLedgerOrigin {
  return typeof origin === 'string' && (IDEATION_LEDGER_ORIGINS as readonly string[]).includes(origin);
}

/**
 * The SQL leg, as a CASE over the row's `payload` column. Mirrors {@link itemClassOfPayload}:
 * Postgres `->>` yields NULL for a missing key, for a JSON `null`, and on a non-object payload
 * (array/scalar), so those all fall through to 'work' — exactly the JS guards below.
 */
export const ITEM_CLASS_SQL_TEXT =
  `CASE WHEN payload->>'sourceRole' = '${SCOUT_SOURCE_ROLE}' ` +
  `OR payload->>'${IDEA_ORIGIN_PAYLOAD_KEY}' IS NOT NULL THEN 'ideation' ELSE 'work' END`;

/** The JS leg. Must agree with {@link ITEM_CLASS_SQL_TEXT} on every payload shape. */
export function itemClassOfPayload(payload: unknown): ItemClass {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'work';
  const p = payload as Record<string, unknown>;
  if (p.sourceRole === SCOUT_SOURCE_ROLE) return 'ideation';
  // `->>` on a present key returns its text for strings, numbers, booleans, objects and arrays
  // alike; only a missing key or a JSON null yields NULL.
  const stamp = p[IDEA_ORIGIN_PAYLOAD_KEY];
  return stamp !== undefined && stamp !== null ? 'ideation' : 'work';
}
