/**
 * Compact write RECEIPTS for `work_items:*` writes (oversized-tool-results-reduction-2026-10-12
 * P-002).
 *
 * A write that echoes the whole work-item row back costs the caller several KB per call, almost
 * all of it content the caller either just sent (`summary`, the completion it passed) or never
 * acts on (`payload` internals: admission identity, freshness envelope, readiness, probation).
 * Measured 2026-10-12: a `work_items:complete` result was 21KB, 15.4KB of it the echoed row —
 * `payload` 6.5KB, `terminalCompletionEvidence` 4.2KB (the same record the response already
 * returns as top-level `completion`), `summary` 2.4KB, `externalBlockers` 1.2KB.
 *
 * A receipt keeps what a caller acts on next: identity, state and assignment. `assignee` and
 * `state` stay even when null, so "is it owned?" is answerable from the receipt alone. The
 * whole row is one `payloadTier:'full'` away, and `work_items:get` reads it later.
 *
 * ⚠ THE RECEIPT IS ALSO WHAT LIFECYCLE RULES SEE. The dispatcher hands `postInvoke` the same
 * settled result the caller receives (tooldef `dispatch-stack.ts`), and `events/engine.ts`
 * `normalizeEvent` parses that into `e.result.data`. A reaction rule that reads a field off
 * `result.data.workItem` therefore reads it off THIS receipt. That is why `payloadKeys` exists:
 * plan-item reflection reads `payload.plan_item` and the bet-signal rule reads
 * `payload.domainKind`, so a spec keeps exactly those payload keys. Adding a rule that reads
 * another field means adding that field to the spec; `receipt.test.ts` runs the registered
 * rules against the full row and the receipt and fails if their verdicts differ.
 */

export interface WorkItemReceiptSpec {
  /** Always present, `null` when the row has no value. */
  readonly always: readonly string[];
  /** Present only when the row carries a non-null value. */
  readonly ifSet: readonly string[];
  /** `payload` keys kept (as a projected `payload` object) because a lifecycle rule reads them. */
  readonly payloadKeys?: readonly string[];
}

export function toWorkItemReceipt(row: object, spec: WorkItemReceiptSpec): Record<string, unknown> {
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of spec.always) out[key] = src[key] ?? null;
  for (const key of spec.ifSet) {
    if (src[key] !== null && src[key] !== undefined) out[key] = src[key];
  }
  const payload = src.payload;
  if (spec.payloadKeys?.length && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const kept: Record<string, unknown> = {};
    for (const key of spec.payloadKeys) {
      const value = (payload as Record<string, unknown>)[key];
      if (value !== null && value !== undefined) kept[key] = value;
    }
    if (Object.keys(kept).length > 0) out.payload = kept;
  }
  return out;
}

/** `work_items:create`: a filing's identity + whether it is owned. Create rules read
 *  `id`/`title`/`severity`/`harness`/`family`/`assignee` (events/rules.ts, pot/wake-defaults.ts,
 *  coord-lifecycle/lifecycle-rules.ts) — all kept. */
export const CREATE_RECEIPT: WorkItemReceiptSpec = {
  always: ['id', 'state', 'assignee'],
  ifSet: [
    'kind', 'family', 'harness', 'title', 'severity', 'takenAt', 'goalId', 'parent',
    'sourcePlanSlug', 'sourcePlanItemIds', 'createdAt',
  ],
};

/** `work_items:complete`: the close's landed state and authority. Complete rules read `state`
 *  (plan-item reflection), `payload.plan_item` (plan-items/reflect-rules.ts) and
 *  `payload.domainKind` (decision-ledger/bet-signal-rule.ts); the result door keeps
 *  `terminalCompletionRef`. `payload.out` (a stored `outputPayload`) is read via
 *  `work_items:get`, as complete's own guidance says. */
export const COMPLETE_RECEIPT: WorkItemReceiptSpec = {
  always: ['id', 'state', 'assignee'],
  ifSet: [
    'kind', 'family', 'harness', 'title', 'severity', 'terminalOwner', 'terminalCompletionRef',
    'completionAuthority', 'closedAt', 'goalId', 'parent', 'sourcePlanSlug', 'sourcePlanItemIds',
  ],
  payloadKeys: ['plan_item', 'domainKind'],
};
