/**
 * WI-2141488 — refuse a BARE work-item id as an external-blocker `ref`.
 *
 * `work_items:set_blocker` records conditions that are NOT work-items (event /
 * gate / runtime / human). Its clearing contract says so explicitly:
 * `external-blockers.ts` — clearing "never touches internal work-item dependency
 * edges".
 *
 * Every automatic clear of an event or gate row is keyed on a FIRED EVENT KEY equal to
 * the row's `ref`, and only when that key passes `fireCertifiesCondition`
 * (external-condition-reachability.ts): emit-time settlement when a proving key fires,
 * announced-gate settlement, the blocker re-check sweep, and its recovery pass for a
 * missed fire (event-wait-settlement-2026-10-20 P-001..P-005). Runtime and human rows
 * are never cleared by an event; they clear by their typed next action or re-check.
 *
 * A bare id such as `WI-40086` therefore matches nothing that will ever fire — it
 * is INERT TEXT: no event key, nothing to await, nothing to clear. The blocked
 * row waits forever. This was not hypothetical — 22 papercusp rows sat blocked on
 * already-terminal items, 18 of them on WI-40086 alone, several parked for weeks.
 *
 * This guard owns ONLY the bare-id shape. Whether a non-id event/gate ref can be proved
 * by a fire at all is decided separately, at the same write, by `admitWaitRef`
 * (wait-ref-admission.ts, P-006), which refuses broad, uncatalogued, free-text and
 * already-fired refs.
 *
 * SCOPE, and why it is narrower than it could be — both bounds are set by the
 * measured population, not by taste:
 *
 *  1. WHOLE-COMPONENT MATCH ONLY. A work-item id used as a QUALIFIER on a real
 *     external condition is legitimate and common, and every one of these is
 *     accepted: `WI-212675 / gate-red-streak:papercusp`,
 *     `gate.greenCheckpoint / WI-212675`, `EI-19458231972377007-owner-provenance`,
 *     `owner-capability:EI-8574:external-service-action`. Only a component that
 *     is EXACTLY an id — carrying no other information — is refused HERE. (Since
 *     P-006 most of those free-text gate refs are still refused at the same write,
 *     by `admitWaitRef`, because no fire can prove them; the qualifier form itself
 *     is not this guard's concern.)
 *
 *  2. EVENT KEYS ARE NOT REFUSED. `work-item:done:<id>` is a real, registered
 *     completion key. A ref made ONLY of such keys and bare ids is not written as an
 *     external row at all: set_blocker converts it to a `blocks` edge
 *     (`pureWorkItemDependencyReferents` below, WI-10005020), which also settles a
 *     DROPPED referent — the case where `work-item:done` never fires
 *     (EI-21564741982937381 → EI-21568004123678857). A done key mixed with other
 *     components stays a row and is validated by `admitWaitRef`.
 *
 * Splitting: `;` and `,` separate list components; `/` does NOT, because the
 * live data uses `/` to qualify (`WI-212675 / gate-red-streak:papercusp`).
 * Splitting on `/` would refuse exactly the legitimate refs bound 1 protects.
 */

export interface WorkItemRefBlockerProblem {
  itemId: string;
  code: 'work_item_ref_as_external_blocker';
  /** The components that are bare work-item ids, in the order they appeared. */
  offendingRefs: string[];
  detail: string;
}

/** A component that is EXACTLY a work-item id and nothing else. */
const BARE_WORK_ITEM_ID_RE = /^(?:WI|EI|F)-\d+$/i;

/** `;` and `,` list-separate a ref. `/` qualifies and must never split. */
const REF_COMPONENT_SEPARATOR_RE = /[;,]/;

export function refComponents(ref: string): string[] {
  return ref
    .split(REF_COMPONENT_SEPARATOR_RE)
    .map((component) => component.trim())
    .filter(Boolean);
}

export function bareWorkItemRefs(ref: string): string[] {
  return refComponents(ref).filter((component) => BARE_WORK_ITEM_ID_RE.test(component));
}

/** `work-item:done:<id>` — the completion await key of exactly one work-item. */
const WORK_ITEM_DONE_KEY_RE = /^work-item:done:((?:WI|EI|F)-\d+)$/i;

/**
 * WI-10005020 (P-002 / R-14) — the work-items a blocker ref depends on, when the ref
 * names NOTHING ELSE. Every component must be a bare id or a `work-item:done:<id>` key;
 * any other component (a gate, an owner ask, a qualified condition) makes the ref an
 * external condition and this returns null.
 *
 * A dependency on another work-item has exactly one canonical representation — a
 * `work_item_deps` `blocks` edge — because only the edge is read by the claim floors,
 * `plans:items` blockedBy and the dependency traversal, and only the edge treats a
 * DROPPED referent as settled. An `externalBlockers` row naming the same dependency is
 * invisible to all of them, and a `work-item:done` key whose referent is dropped never
 * fires, so the row waits forever (EI-21564741982937381).
 */
export function pureWorkItemDependencyReferents(ref: string): string[] | null {
  const components = refComponents(ref);
  if (!components.length) return null;
  const referents: string[] = [];
  for (const component of components) {
    if (BARE_WORK_ITEM_ID_RE.test(component)) {
      referents.push(component.toUpperCase());
      continue;
    }
    const done = WORK_ITEM_DONE_KEY_RE.exec(component);
    if (!done?.[1]) return null;
    referents.push(done[1].toUpperCase());
  }
  return [...new Set(referents)];
}

/**
 * Returns a problem when `ref` names one or more work-items and nothing else,
 * or null when the ref is a legitimate external condition.
 *
 * Callers must apply this to SET requests only. Clearing an already-written bad
 * blocker has to keep working, or the rows this guard exists to prevent would
 * become permanently unclearable — the exact failure being fixed.
 */
export function workItemRefBlockerProblem(input: {
  itemId: string;
  ref: string;
}): WorkItemRefBlockerProblem | null {
  const offendingRefs = bareWorkItemRefs(input.ref);
  if (!offendingRefs.length) return null;

  const named = offendingRefs.map((ref) => `'${ref}'`).join(', ');
  const plural = offendingRefs.length > 1;
  return {
    itemId: input.itemId,
    code: 'work_item_ref_as_external_blocker',
    offendingRefs,
    detail:
      `work_item '${input.itemId}' blocker ref ${named} ${plural ? 'are' : 'is'} a bare work-item id. ` +
      'External blockers are for conditions that are NOT work-items, and clearing one never consults ' +
      'work-item state — so nothing would ever clear this and the row would wait forever. ' +
      'If another work-item must finish first, record the dependency with ' +
      `work_items:link { id:${offendingRefs.length === 1 ? ` '${offendingRefs[0]}'` : ' <blocker>'}, rel:'blocks', target_id: '${input.itemId}' }, ` +
      'which tracks terminality and resolves itself. If the real blocker is an external condition that ' +
      "merely RELATES to that item (a gate, an owner decision), name the condition in the ref and keep the " +
      `id as a qualifier — e.g. 'gate-red-streak:papercusp / ${offendingRefs[0]}' — which this guard accepts. ` +
      'A live await key such as ' +
      `'work-item:done:${offendingRefs[0]}' is also accepted.`,
  };
}
