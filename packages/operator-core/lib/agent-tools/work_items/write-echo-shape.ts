/**
 * work_items write-echo diet (context-trimming-tiers-2026-07-01 P-025).
 *
 * work_items:claim / work_items:complete answer through the bulk envelope
 * { ok, results:[…], counts } and each success row ECHOES the full WorkItem
 * (payload subtree, full summary, timestamps — claim measured up to 79KB/call,
 * complete avg 8.3KB). The caller just wrote/claimed the item: it needs the
 * outcome (ok / state / error / hint / reflect), not the row replayed.
 *
 * Trimmed/standard project the echoed `workItem` to a compact ref; trimmed
 * additionally drops the `completion`/`outputPayload` echoes (pure replays of
 * the caller's OWN input — inherently recoverable, flagged once at the
 * envelope by `echo_note`, D-004). Outcome fields (ok/id/error/holder/hint/
 * stateError/stateWarning/verificationWarning/authorityWarning/completionAuthority/
 * assigneeMismatchWarning/reflect/holderContext) always pass through verbatim — this
 * shaper only ever touches `workItem`, `completion` and `outputPayload`, so a new
 * outcome field needs no change here. (P-027's `holderContext` on a claim_conflict is
 * exactly such a field: it rides through untouched because the row is SPREAD, not
 * rebuilt from an allowlist — which is the property that keeps this claim true.)
 *
 * Standard DIGESTS the authored echoes (oversized-tool-results-reduction-2026-10-12
 * D-003). Measured 2026-10-13: the `completion` echo was 2.7-5.1KB of a 3.4-7.8KB
 * standard result, which pushed routine closes past the ~6,000-char result door into a
 * spill. The digest keeps what the caller cannot already know (the server-filled
 * `status`/`agent`/`workItem` defaults) plus the field list and size, so a dropped or
 * renamed field is still visible. The lifecycle `emits` rule reads the RAW handler
 * result before this serialize-time shaper runs, so the broadcast is unaffected.
 */

export const WRITE_ECHO_TIER_CAPS = {
  trimmed: { title: 90, authoredEchoes: "drop" },
  standard: { title: 140, authoredEchoes: "digest" },
} as const;

/** Summary clip inside a standard-tier completion digest. */
export const COMPLETION_DIGEST_SUMMARY_CAP = 160;

const ECHO_NOTES = {
  drop: 'completion/outputPayload echoes omitted at trimmed tier (they replay your own input) — payloadTier:"full" to see the recorded form',
  digest:
    'completion/outputPayload echoes digested at standard tier (they replay your own input; the digest keeps the server-filled status/agent/workItem, the field list and the size) — payloadTier:"full" to see the recorded form',
} as const;

type EchoTier = keyof typeof WRITE_ECHO_TIER_CAPS;

const clip = (s: unknown, n: number): string | null =>
  typeof s === "string" ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;

/** Compact a just-written work item to the fields a caller needs for follow-up. */
export function compactWorkItemRef(v: unknown, titleCap: number): unknown {
  if (!v || typeof v !== "object") return v ?? null;
  const w = v as Record<string, unknown>;
  return {
    id: w.id ?? null,
    kind: w.kind ?? null,
    harness: w.harness ?? null,
    state: w.state ?? w.status ?? null,
    title: clip(w.title, titleCap),
    assignee: w.assignee ?? w.taken_by ?? null,
  };
}

const jsonChars = (v: unknown): number => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Standard-tier digest of the echoed completion record (D-003). */
export function digestCompletionEcho(v: unknown): unknown {
  if (!isRecord(v)) return v;
  return {
    summary: clip(v.summary, COMPLETION_DIGEST_SUMMARY_CAP),
    status: v.status ?? null,
    workItem: v.workItem ?? null,
    agent: v.agent ?? null,
    fields: Object.keys(v),
    chars: jsonChars(v),
  };
}

/** Standard-tier digest of the echoed outputPayload: its shape, not its content. */
export function digestOutputPayloadEcho(v: unknown): unknown {
  return {
    fields: isRecord(v) ? Object.keys(v) : [],
    chars: jsonChars(v),
  };
}

export function shapeWorkItemWriteEcho(data: unknown, tier: EchoTier): unknown {
  const d = data as { ok?: unknown; results?: unknown[] } | null | undefined;
  if (!d || !Array.isArray(d.results)) return data;
  const c = WRITE_ECHO_TIER_CAPS[tier];

  let reducedAuthoredEcho = false;
  const results = d.results.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = { ...(row as Record<string, unknown>) };
    if (r.workItem !== undefined && r.workItem !== null) {
      r.workItem = compactWorkItemRef(r.workItem, c.title);
    }
    if (r.completion !== undefined) {
      if (c.authoredEchoes === "drop") delete r.completion;
      else r.completion = digestCompletionEcho(r.completion);
      reducedAuthoredEcho = true;
    }
    if (r.outputPayload !== undefined) {
      if (c.authoredEchoes === "drop") delete r.outputPayload;
      else r.outputPayload = digestOutputPayloadEcho(r.outputPayload);
      reducedAuthoredEcho = true;
    }
    return r;
  });

  return {
    ...(d as Record<string, unknown>),
    results,
    ...(reducedAuthoredEcho ? { echo_note: ECHO_NOTES[c.authoredEchoes] } : {}),
  };
}
