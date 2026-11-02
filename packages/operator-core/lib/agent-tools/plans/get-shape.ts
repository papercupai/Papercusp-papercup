/**
 * get-shape.ts — payload-tier shapers for plans:get
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * plans:get is the #3 tool-result payload fleet-wide, and the 2026-07-01 fleet
 * incident measured one mode:'full' read at ~15k tokens on a 200k-window member.
 * Shapers project each bulk result: prose capped with a heading-narrowing
 * pointer, browse-read item text capped, decisions capped to the NEWEST few,
 * and (trimmed) the UI decoration maps dropped with an explicit omission marker.
 * Explicit item/heading reads are narrow detail reads, so their selected text
 * remains complete; genuinely oversized values fall through to the result door
 * rather than being silently clipped by this domain shaper.
 *
 * Shape contract (D-004): nothing is silently dropped — every cut carries a
 * count + a fetch-pointer, and a full-tier `tools:invoke` dispatch restores
 * today's body.
 *
 * EI-20038981829684213: "carries a count" used to mean a SIBLING field, which a
 * `projection.pick` of the value alone strips — taking the door's marker scan
 * with it. Every cut here now also announces itself IN BAND via ./shape-clip,
 * and a record-structured section body is cut at a record boundary and counted
 * in records rather than chars.
 */

import {
  clipSectionBody,
  clipWithMarker,
  payloadTierRecoveryHint,
  SHAPE_RECOVER_HINT,
} from "./shape-clip";

const CAPS = {
  trimmed: {
    prose: 6_000,
    sectionBody: 6_000,
    itemText: 200,
    decisions: 8,
    decisionBody: 240,
  },
  standard: {
    prose: 20_000,
    sectionBody: 20_000,
    itemText: 400,
    decisions: 20,
    decisionBody: 600,
  },
} as const;

type TierName = keyof typeof CAPS;

const clip = clipWithMarker;

/** Tier-project one bulk result ({ ok:true, slug, … }). Errors pass through. */
function shapeResult(res: unknown, tier: TierName): unknown {
  if (!res || typeof res !== "object") return res;
  const r = res as Record<string, unknown>;
  if (r.ok !== true) return res;
  const c = CAPS[tier];
  const out: Record<string, unknown> = { ...r };

  // mode:'full' prose blob — the single biggest sink. Cap + point at the
  // heading-narrowed read (sectionIndex already lists every heading + size).
  if (typeof r.prose === "string" && r.prose.length > c.prose) {
    out.prose = clip(r.prose, c.prose);
    out.prose_truncated = true;
    out.prose_full_chars = r.prose.length;
    out.prose_hint =
      `read one section via plans:get { heading } (sectionIndex lists headings), or ${SHAPE_RECOVER_HINT}`;
  }

  // Heading-narrowed reads carry one section body. This is the read that serves
  // `heading:'Decisions'` — a RECORD LEDGER in a single string — so a browse
  // read is cut at a `### ` boundary and counted in records, never mid-record
  // at a char count (EI-20038981829684213: 30 decisions became a
  // plausible-looking D-001..D-004).
  //
  // EXCEPT when the caller explicitly narrowed to a heading. That payload has
  // already paid the identity-envelope reduction in narrowHeadingPayload and
  // carries exactly the section the caller asked for. Clipping it again makes
  // the narrow read unable to recover the very body it was selected to fetch;
  // if the selected section is too large for the transport, the result door
  // can spill the complete body with a durable cursor.
  const section = r.section as { body?: unknown } | null | undefined;
  const isNarrowedHeadingRead =
    typeof r.heading === "string" &&
    section !== null &&
    typeof section === "object" &&
    typeof section.body === "string";
  if (
    !isNarrowedHeadingRead &&
    section &&
    typeof section === "object" &&
    typeof section.body === "string" &&
    section.body.length > c.sectionBody
  ) {
    const cut = clipSectionBody(section.body, c.sectionBody);
    out.section = {
      ...section,
      body: cut.body,
      body_truncated: true,
      body_full_chars: cut.fullChars,
      ...(cut.recordsTotal != null
        ? { body_records_shown: cut.recordsShown, body_records_total: cut.recordsTotal }
        : {}),
      // EI-22128943077118798: a short sibling field naming every omitted record
      // survives the outer bounded-payload envelope's own re-truncation of this
      // (already shape-clipped) body even when that outer clip eats the in-band
      // recover marker above — see shape-clip.ts's ClippedSection.omittedHeadings.
      ...(cut.omittedHeadings ? { body_omitted_headings: cut.omittedHeadings } : {}),
    };
  }

  // Items: keep EVERY item (the plan's structure is the point of the read), but
  // cap each browse-read text and drop the full-mode rawLine duplicate.
  //
  // EXCEPT when `itemSelection` is present. `plans:get { items:[...] }` is the
  // explicit detail-read escape hatch for one or more item records; the
  // handler already removed every unrequested item and reports the selector
  // in-band. Clipping the selected text here silently defeats that contract
  // (EI-22296477863994941), while an exceptionally large selected value can
  // still be handled honestly by the outer result door.
  const isNarrowedItemRead = r.itemSelection != null;
  if (Array.isArray(r.items)) {
    out.items = r.items.map((it) => {
      if (!it || typeof it !== "object") return it;
      const { rawLine: _rawLine, ...rest } = it as Record<string, unknown>;
      const text = rest.text;
      if (!isNarrowedItemRead && typeof text === "string" && text.length > c.itemText) {
        return { ...rest, text: clip(text, c.itemText), text_truncated: true };
      }
      return rest;
    });
  }

  // Decisions: newest-N (the tail is the live context; older decisions are
  // history), each body capped harder than the sections-mode bound.
  //
  // EXCEPT when the caller narrowed the read to explicit decision ids
  // (EI-21573289806322713). `decisionSelection` is present iff this payload came
  // from `narrowDecisionPayload` (../plans/get.ts), and that selector exists —
  // in its own words — "specifically to recover a governing ruling whose
  // complete body did not fit in a plan read"; its arg is documented as
  // returning those ids "with complete bodies". Applying either cut here
  // truncates the very escape hatch that exists BECAUSE of truncation.
  //
  // Both cuts were actively harmful on that path, the slice worse than the clip:
  //  - `slice(-c.decisions)` keeps the NEWEST few, so an explicit selection
  //    silently loses requested ids from the HEAD;
  //  - and either way `decisionSelection.missing` still reads `[]` — the field
  //    that is "deliberately in-band so a missing id cannot be mistaken for a
  //    complete read". Measured: 5 explicit ids returned matched:5 / missing:[]
  //    with every body clipped, one at 186 of 4,782 chars (~4% of the ruling).
  //
  // Skipping the cuts does not reintroduce the overflow this shaper exists to
  // prevent: `narrowDecisionPayload` already strips the plan's prose, items and
  // decorations for exactly this reason, so a narrowed payload is the governing
  // text and identity/CAS fields, nothing else. If that still overflows, the
  // result-door spills it as a typed reference envelope carrying a recovery
  // pointer — honest, and strictly better than plausible-looking clipped text,
  // which is what the D-004 shape contract ("nothing is silently dropped") asks
  // for. A cut that cannot be detected is the one failure mode it forbids.
  const isNarrowedDecisionRead = r.decisionSelection != null;
  if (Array.isArray(r.decisions) && r.decisions.length > 0 && !isNarrowedDecisionRead) {
    const total = r.decisions.length;
    out.decisions = r.decisions.slice(-c.decisions).map((d) => {
      if (!d || typeof d !== "object") return d;
      const rec = d as Record<string, unknown>;
      const body = rec.body;
      if (typeof body === "string" && body.length > c.decisionBody) {
        return {
          ...rec,
          body: clip(body, c.decisionBody),
          body_truncated: true,
          body_full_chars: (rec.body_full_chars as number | undefined) ?? body.length,
        };
      }
      return rec;
    });
    if (total > c.decisions) {
      out.decisionsTruncated = {
        total,
        shown: c.decisions,
        more: `${SHAPE_RECOVER_HINT} (or mode:"full") for all decisions`,
      };
    }
  }

  const shipReadiness = shapeShipReadiness(r.shipReadiness);
  if (shipReadiness !== r.shipReadiness) out.shipReadiness = shipReadiness;

  // trimmed only: the UI decoration map (feature badges) is a per-item object
  // an agent placing work rarely needs — drop it LOUDLY.
  if (tier === "trimmed") {
    const omitted: string[] = [];
    for (const key of ["linkedFeatures"] as const) {
      const v = r[key];
      if (v && typeof v === "object" && Object.keys(v as object).length > 0) {
        delete out[key];
        omitted.push(key);
      }
    }
    if (omitted.length > 0) {
      out.trimmedOmitted = {
        fields: omitted,
        more: `${payloadTierRecoveryHint("plans:get", "standard")} (or ${SHAPE_RECOVER_HINT}) to include them`,
      };
    }
  }

  return out;
}

/** Reason groups kept per bar, and sample ids kept per reason, in a proof-history summary. */
const PROOF_REASONS_PER_BAR = 8;
const PROOF_SAMPLES_PER_REASON = 3;

interface ProofReasonGroup {
  reason: string;
  count: number;
  sampleSpecIds: string[];
  sampleIds: unknown[];
}

/**
 * Summarize one bar's `proof.history`: counts of the ACTIVE rows by currentness,
 * and each stale/unknown reason with its count plus a few spec ids and evidence
 * ids to start a repair from. The marker is in band (`TRUNCATED`) so a
 * `projection.pick` of the summary alone still says rows were cut.
 */
export function summarizeProofHistory(history: unknown[]): Record<string, unknown> {
  const active = history.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && (row as { activeAttempt?: unknown }).activeAttempt === true,
  );
  const byCurrentness: Record<string, number> = {};
  const groups = new Map<string, ProofReasonGroup>();
  for (const row of active) {
    const currentness = (row.currentness ?? null) as {
      overall?: unknown;
      staleReasons?: unknown;
      unknownReasons?: unknown;
    } | null;
    const overall = typeof currentness?.overall === "string" ? currentness.overall : "unrecorded";
    byCurrentness[overall] = (byCurrentness[overall] ?? 0) + 1;
    const reasons = [
      ...(Array.isArray(currentness?.staleReasons) ? currentness.staleReasons : []),
      ...(Array.isArray(currentness?.unknownReasons) ? currentness.unknownReasons : []),
    ];
    for (const raw of reasons) {
      const reason = typeof raw === "string" ? raw : JSON.stringify(raw);
      let group = groups.get(reason);
      if (!group) {
        group = { reason, count: 0, sampleSpecIds: [], sampleIds: [] };
        groups.set(reason, group);
      }
      group.count += 1;
      const specId = row.specId;
      if (
        typeof specId === "string" &&
        group.sampleSpecIds.length < PROOF_SAMPLES_PER_REASON &&
        !group.sampleSpecIds.includes(specId)
      ) {
        group.sampleSpecIds.push(specId);
      }
      if (group.sampleIds.length < PROOF_SAMPLES_PER_REASON) group.sampleIds.push(row.id);
    }
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return {
    rows: history.length,
    activeRows: active.length,
    byCurrentness,
    reasons: ranked.slice(0, PROOF_REASONS_PER_BAR),
    ...(ranked.length > PROOF_REASONS_PER_BAR ? { reasonsOmitted: ranked.length - PROOF_REASONS_PER_BAR } : {}),
    ...(history.length > 0
      ? {
          rowsTruncated: true,
          rowsCut: `[TRUNCATED ${history.length} proof rows summarized — recover: ${SHAPE_RECOVER_HINT}]`,
        }
      : {}),
  };
}

/**
 * `shipReadiness` (opt-in) carries the acceptance BAR contract snapshot, and
 * each bar's `proof.history` re-lists EVERY evidence row ever bound to it, raw
 * `details` included. Measured 2026-10-13 (oversized-tool-results-reduction-
 * 2026-10-12 P-006; 24h, transport=mcp): 125 shipReadiness reads were 4% of
 * plans:get calls but 43% of its bytes (p50 228KB, p90 615KB), and
 * proof.history was ~93% of the snapshot in the largest spills. Replacing the
 * rows with summarizeProofHistory cut those snapshots 78-93%.
 *
 * The verdict (`satisfied`, `code`, `repairAction`, `message`) and every per-bar
 * count and state are untouched; the shaper runs after the handler, so nothing
 * the handler derived from the full rows changes. Full rows: payloadTier:'full'.
 *
 * Second cut, measured 2026-10-13 08:45Z (same plan item, :3170, 12h): after
 * the history summary a 7-bar default-tier body was still ~45KB, so it spilled
 * at the result door, whose notice says to pass payloadTier:'full'; every
 * shipReadiness read since 07:30Z was then an explicit full read (98-842KB, one
 * owner polling six times in 30 min). Per bar ~4KB of the remainder is contract
 * PROSE (requirement ~1.9KB, method, falsifier), and sourceRevisions (revision
 * pins for drift detection) was 13.7KB. Browse tiers keep a marked 160-char
 * head of each prose field plus its full length, and the pins as counts.
 */
const BAR_PROSE_KEYS = ["requirement", "method", "falsifier"] as const;
const BAR_PROSE_HEAD_CHARS = 160;
const SHIP_READINESS_FULL = "payloadTier:'full'";

function shapeShipReadiness(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const sr = value as Record<string, unknown>;
  const snap = sr.acceptanceBarContractSnapshot as Record<string, unknown> | null | undefined;
  if (!snap || typeof snap !== "object" || !Array.isArray(snap.bars)) return value;
  let changed = 0;
  let proseClipped = 0;
  const bars = snap.bars.map((bar) => {
    if (!bar || typeof bar !== "object") return bar;
    let out = bar as Record<string, unknown>;
    for (const key of BAR_PROSE_KEYS) {
      const text = out[key];
      if (typeof text === "string" && text.length > BAR_PROSE_HEAD_CHARS) {
        out = {
          ...out,
          [key]: clip(text, BAR_PROSE_HEAD_CHARS, SHIP_READINESS_FULL),
          [`${key}_full_chars`]: text.length,
        };
        proseClipped += 1;
      }
    }
    const proof = out.proof as Record<string, unknown> | null | undefined;
    if (proof && typeof proof === "object" && Array.isArray(proof.history) && proof.history.length > 0) {
      const { history, ...rest } = proof;
      out = { ...out, proof: { ...rest, historySummary: summarizeProofHistory(history as unknown[]) } };
      changed += 1;
    }
    return out;
  });
  const revisions = summarizeSourceRevisions(snap.sourceRevisions);
  if (revisions !== snap.sourceRevisions) changed += 1;
  if (changed === 0 && proseClipped === 0) return value;
  return {
    ...sr,
    acceptanceBarContractSnapshot: {
      ...snap,
      ...(revisions !== snap.sourceRevisions ? { sourceRevisions: revisions } : {}),
      bars,
      ...(proseClipped > 0
        ? {
            textTruncated: true,
            proseCut: `TRUNCATED ${proseClipped} bar prose field(s) (requirement/method/falsifier) to ${BAR_PROSE_HEAD_CHARS} chars; <key>_full_chars is the length — ${SHIP_READINESS_FULL} for the contract text`,
          }
        : {}),
    },
  };
}

/** The snapshot's revision PINS (clause and work-contract rows, scorecard ids) feed the
 *  handler's drift checks, which already ran; a readiness read needs their counts. */
function summarizeSourceRevisions(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const rev = value as Record<string, unknown>;
  const lists = ["clauses", "workContracts", "scorecardIds"].filter(
    (k) => Array.isArray(rev[k]) && (rev[k] as unknown[]).length > 0,
  );
  if (lists.length === 0) return value;
  const out: Record<string, unknown> = { ...rev };
  for (const k of lists) out[k] = { count: (rev[k] as unknown[]).length };
  out.rowsCut = `TRUNCATED ${lists.join(", ")} revision rows to counts — ${SHIP_READINESS_FULL} for the pins`;
  out.sourceRevisionsTruncated = true;
  return out;
}

/** Tier-project a plans:get bulk envelope ({ ok, results, counts }). */
export function shapePlansGet(data: unknown, tier: TierName): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.results)) return data;
  return {
    ...d,
    payloadTier: tier,
    results: d.results.map((res) => shapeResult(res, tier)),
  };
}
