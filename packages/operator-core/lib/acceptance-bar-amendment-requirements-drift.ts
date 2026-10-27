/**
 * EI-24816459669484550: does an acceptance-rubric amendment leave the subject plan's
 * `## Requirements` block disagreeing with the rubric?
 *
 * WHY. Once a plan's acceptance rubric is seeded, the rubric criterion is the canonical BAR
 * text (`acceptance-bar-seed.ts` header; the amendment refreshes execution projections "from the
 * canonical rubric, never from its old Requirements seed"). Nothing re-renders the plan's R-N
 * block after an amendment, so the plan and the rubric hold two hand-maintained copies of one
 * truth (R-N condition -> criterion `model`, R-N falsifier -> criterion `driftMarkers`) with no
 * reconciler. Measured twice on enterprise-data-sources-2026-10-01 (R-13): the plan's falsifier
 * was edited, the amendment patched `model` only, the rubric kept the superseded falsifier in
 * `driftMarkers`, and only an outside reviewer caught it.
 *
 * WHAT. A pure comparison of the amended criteria against the plan's parsed Requirements,
 * surfaced on the amendment preview (dry run) as an ADVISORY. It never refuses: the rubric is
 * canonical, so a plan block that lags is legitimate. The point is that the author sees the
 * divergence before applying, instead of an outside reviewer finding it after.
 *
 * `driftMarkers` is compared only for explicit three-section (```requirement JSON) R-N blocks.
 * A legacy prose R-N has no falsifier of its own: its seeded `driftMarkers` is a generated
 * sentence, so comparing it would report drift that does not exist.
 *
 * WI-10006829: the Verification section (`method`, `check`, `replication`) is compared too, and
 * so is any Acceptance metadata the plan block states explicitly. Comparing only model and
 * driftMarkers reported `inSync:true` after an amendment moved `check.files` to a different test,
 * so a reviewer who read the plan graded a stale file list (pui-chat-first-ux rev 10). The
 * Verification fields are compared whenever the block is explicit, because the seeder never
 * defaults them; requiredScope/requiredTestLayers/evidencePlane/evidenceRuntime only when the
 * block states them, because the seeder fills those from the Bar-to-work map otherwise.
 */
import { createHash } from 'node:crypto';
import type { ParsedRequirementBar } from './acceptance-bar-seed';

export type RequirementsDriftField =
  | 'intent'
  | 'model'
  | 'driftMarkers'
  | 'method'
  | 'check'
  | 'replication'
  | 'productionConfiguration'
  | 'requiredScope'
  | 'requiredTestLayers'
  | 'evidencePlane'
  | 'evidenceRuntime'
  | 'passRatings'
  | 'mandatory'
  | 'role'
  | 'coversBarKeys';

/** Compared whenever the plan block is explicit: the seeder never supplies a default for them. */
const VERIFICATION_FIELDS = ['method', 'check', 'replication', 'productionConfiguration'] as const;
/** Compared only when the plan block states them: otherwise the seeder derives them from the map. */
const STATED_ACCEPTANCE_FIELDS = [
  'requiredScope', 'requiredTestLayers', 'evidencePlane', 'evidenceRuntime',
  'passRatings', 'mandatory', 'role', 'coversBarKeys',
] as const;

export interface RequirementsDriftEntry {
  barKey: string;
  /** True when this amendment changes the BAR; false means the drift predates this amendment. */
  changedByAmendment: boolean;
  /** `missing-from-plan`: the rubric carries a BAR the plan's Requirements block does not. */
  kind: 'missing-from-plan' | 'text-differs';
  /** Which criterion fields disagree with the plan (empty for `missing-from-plan`). */
  fields: RequirementsDriftField[];
}

export interface RequirementsDrift {
  /** True when every surviving amended BAR agrees with the plan's Requirements block. */
  inSync: boolean;
  entries: RequirementsDriftEntry[];
  /** What to do about the drift; null when in sync. */
  action: string | null;
  /**
   * WI-10006835: BARs whose drift the APPLY resolves on its own. An amended BAR with an explicit
   * ```requirement block is re-rendered from the amended criterion in the same transaction as the
   * rubric revision (`rerenderAmendedRequirementBlocks`). Present only when out of sync.
   */
  rerenderedOnApply?: string[];
}

/** Whitespace-insensitive, since the canonical writer trims and collapses BAR text. */
const comparable = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * Structural form for the non-text fields (`check` objects, set-valued arrays): object keys sorted,
 * arrays compared as sets, strings whitespace-collapsed. Absent and null both read as absent.
 */
const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return comparable(value);
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
const sameStructure = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const barNumber = (barKey: string): number => {
  const match = /^R-(\d+)$/.exec(barKey);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

/** Requirement text also represents Intent and METHOD/replication, which do not change BAR meaning. */
export function amendedRequirementBarKeys(
  priorCriteria: ReadonlyArray<Record<string, unknown>>,
  nextCriteria: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const priorByBar = new Map(priorCriteria.map((criterion) => [criterion.barKey, criterion]));
  const fields = ['intent', 'model', 'driftMarkers', ...VERIFICATION_FIELDS, ...STATED_ACCEPTANCE_FIELDS] as const;
  return nextCriteria.flatMap((criterion) => {
    const barKey = typeof criterion.barKey === 'string' ? criterion.barKey.trim() : '';
    const prior = priorByBar.get(barKey);
    return barKey && (!prior || fields.some((field) => !sameStructure(prior[field], criterion[field]))) ? [barKey] : [];
  }).sort((a, b) => barNumber(a) - barNumber(b) || a.localeCompare(b));
}

export function diffAmendedCriteriaAgainstRequirements(input: {
  requirementBars: readonly ParsedRequirementBar[];
  nextCriteria: ReadonlyArray<Record<string, unknown>>;
  changedBars: Iterable<string>;
  removedBars?: Iterable<string>;
}): RequirementsDrift {
  const planByBar = new Map(input.requirementBars.map((bar) => [bar.barKey, bar]));
  const changed = new Set(input.changedBars);
  const removed = new Set(input.removedBars ?? []);
  const entries: RequirementsDriftEntry[] = [];

  for (const criterion of input.nextCriteria) {
    const barKey = typeof criterion.barKey === 'string' ? criterion.barKey.trim() : '';
    // Non-BAR criteria (no barKey) are not projected from the Requirements block.
    if (!barKey || removed.has(barKey)) continue;
    const changedByAmendment = changed.has(barKey);
    const plan = planByBar.get(barKey);
    if (!plan) {
      entries.push({ barKey, changedByAmendment, kind: 'missing-from-plan', fields: [] });
      continue;
    }
    const fields: RequirementsDriftField[] = [];
    if (comparable(criterion.model) !== comparable(plan.model)) fields.push('model');
    if (plan.criterion) {
      const stated = plan.criterion as Record<string, unknown>;
      // Legacy criteria may omit Intent; only supplied canonical provenance
      // supersedes the plan's recorded request.
      if (isRecord(criterion.intent) && !sameStructure(criterion.intent, stated.intent)) fields.push('intent');
      if (comparable(criterion.driftMarkers) !== comparable(stated.driftMarkers)) fields.push('driftMarkers');
      for (const field of VERIFICATION_FIELDS) {
        if (!sameStructure(criterion[field], stated[field])) fields.push(field);
      }
      for (const field of STATED_ACCEPTANCE_FIELDS) {
        if (stated[field] !== undefined && !sameStructure(criterion[field], stated[field])) fields.push(field);
      }
    }
    if (fields.length) entries.push({ barKey, changedByAmendment, kind: 'text-differs', fields });
  }

  entries.sort((a, b) => barNumber(a.barKey) - barNumber(b.barKey) || a.barKey.localeCompare(b.barKey));
  if (!entries.length) return { inSync: true, entries, action: null };

  const named = entries
    .map((entry) => (entry.kind === 'missing-from-plan' ? `${entry.barKey} (missing from plan)` : `${entry.barKey} (${entry.fields.join(', ')})`))
    .join('; ');
  // WI-10006835: an amended BAR whose plan block is explicit is re-rendered by the apply itself.
  const rerenderedOnApply = entries
    .filter((entry) => entry.kind === 'text-differs' && entry.changedByAmendment && planByBar.get(entry.barKey)?.criterion)
    .map((entry) => entry.barKey);
  const manual = entries.filter((entry) => !rerenderedOnApply.includes(entry.barKey)).map((entry) => entry.barKey);
  return {
    inSync: false,
    entries,
    rerenderedOnApply,
    action:
      `The plan's ## Requirements block disagrees with the amended rubric on ${named}. The rubric is ` +
      'canonical after seeding. ' +
      (rerenderedOnApply.length
        ? `Applying this amendment re-renders the explicit requirement block of ${rerenderedOnApply.join(', ')} ` +
          'from the amended criterion. '
        : '') +
      (manual.length
        ? `Nothing re-renders ${manual.join(', ')} (a legacy prose record, a BAR this amendment does not ` +
          'change, or a BAR missing from the plan), so that drift persists unless you fix it: update the plan ' +
          'R-N block to match (plans:set-content), or make the amendment match the plan on every field named, ' +
          'before vetting. Reviewers who read the plan block grade the stale copy.'
        : 'No manual plan edit is needed.'),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * WI-10006835: rewrite the explicit ```requirement block of every BAR this amendment changes so the
 * plan copy a reviewer reads carries the amended criterion, not the pre-amendment text (observed:
 * pui-chat-first-ux rev 10, where a vetter graded the stale `check.files` from the plan block).
 *
 * This is the inverse of `diffAmendedCriteriaAgainstRequirements`: it writes exactly the fields that
 * function compares — supplied Intent, condition (model), falsifier (driftMarkers),
 * method/check/replication, and any STATED acceptance metadata — so a re-rendered block reads in
 * sync. Acceptance metadata the block does not state is left unstated, because the seeder derives
 * it from the Bar-to-work map. Legacy criteria that omit Intent preserve the plan's recorded
 * request. Legacy prose R-N records, unchanged BARs, and blocks that do not parse are left
 * byte-identical. Pure: callers write the result.
 */
export function rerenderAmendedRequirementBlocks(
  planContent: string,
  input: { nextCriteria: ReadonlyArray<Record<string, unknown>>; changedBars: Iterable<string> },
): { content: string; rerendered: string[] } {
  const changed = new Set(input.changedBars);
  const byBar = new Map<string, Record<string, unknown>>();
  for (const criterion of input.nextCriteria) {
    const barKey = typeof criterion.barKey === 'string' ? criterion.barKey.trim() : '';
    if (barKey && changed.has(barKey)) byBar.set(barKey, criterion);
  }
  const unchanged = { content: planContent, rerendered: [] as string[] };
  if (!byBar.size) return unchanged;

  const lines = planContent.split('\n');
  const start = lines.findIndex((line) => /^##\s+Requirements\s*$/i.test(line.trim()));
  if (start < 0) return unchanged;
  let end = lines.findIndex((line, index) => index > start && /^##\s+\S/.test(line));
  if (end < 0) end = lines.length;

  const rerendered: string[] = [];
  let barKey: string | null = null;
  for (let index = start + 1; index < end; index++) {
    // Same record header as parseRequirementBars (acceptance-bar-seed.ts).
    const header = /^\*\*(R-\d+)\s+[—–-]\s+.+?\.\*\*/.exec(lines[index]!);
    if (header) {
      barKey = header[1]!;
      continue;
    }
    if (barKey === null || lines[index]!.trim() !== '```requirement') continue;
    const criterion = byBar.get(barKey);
    const key = barKey;
    barKey = null;
    if (!criterion) continue;
    const close = lines.findIndex((line, at) => at > index && line.trim() === '```');
    if (close < 0 || close >= end) continue;
    let block: unknown;
    try {
      block = JSON.parse(lines.slice(index + 1, close).join('\n'));
    } catch {
      continue;
    }
    if (!isRecord(block)) continue;

    const acceptance: Record<string, unknown> = isRecord(block.acceptance) ? { ...block.acceptance } : {};
    const verification: Record<string, unknown> = isRecord(block.verification) ? { ...block.verification } : {};
    if (typeof criterion.model === 'string') acceptance.condition = criterion.model;
    if (typeof criterion.driftMarkers === 'string') acceptance.falsifier = criterion.driftMarkers;
    for (const field of STATED_ACCEPTANCE_FIELDS) {
      if (acceptance[field] === undefined) continue;
      if (criterion[field] === undefined || criterion[field] === null) delete acceptance[field];
      else acceptance[field] = criterion[field];
    }
    for (const field of VERIFICATION_FIELDS) {
      if (criterion[field] === undefined || criterion[field] === null) delete verification[field];
      else verification[field] = criterion[field];
    }
    const next = JSON.stringify({
      ...block,
      ...(isRecord(criterion.intent) ? { intent: criterion.intent } : {}),
      acceptance,
      verification,
    });
    if (next === lines.slice(index + 1, close).join('\n')) continue;
    lines.splice(index + 1, close - index - 1, next);
    end -= close - index - 2;
    rerendered.push(key);
  }
  // The map repeats the canonical evidence plane too. Leaving it behind makes
  // the amended explicit block conflict with its own discharge map at activation.
  // Only replace that cell: item edges and every other authored column survive.
  const design = lines.findIndex((line) => /^##\s+Design\s*$/i.test(line.trim()));
  let inMap = false;
  for (let index = design + 1; design >= 0 && index < lines.length; index++) {
    const line = lines[index]!;
    if (/^##\s+/.test(line)) break;
    if (/^###\s+Bar-to-work map for this plan\s*$/i.test(line.trim())) {
      inMap = true;
      continue;
    }
    if (/^###\s+/.test(line)) inMap = false;
    if (!inMap) continue;
    const row = /^(\s*\|\s*`?(R-\d+)`?\s*\|[^|]*\|)([^|]*)(\|.*)$/.exec(line);
    if (!row) continue;
    const plane = byBar.get(row[2]!)?.evidencePlane;
    if (!['tree', 'deployed', 'live'].includes(String(plane))) continue;
    if (row[3]!.replace(/`/g, '').trim() === plane) continue;
    lines[index] = `${row[1]} ${plane} ${row[4]}`;
    if (!rerendered.includes(row[2]!)) rerendered.push(row[2]!);
  }
  return rerendered.length ? { content: lines.join('\n'), rerendered } : unchanged;
}

/** Same record header as parseRequirementBars (acceptance-bar-seed.ts). */
const REQUIREMENT_HEADER = /^\*\*(R-\d+)\s+[—–-]\s+.+?\.\*\*/;
/** parseRequirementBars ends a record at ANY R-looking bold line, malformed or not. */
const REQUIREMENT_BOUNDARY = /^\*\*R-\d+\b/;

/** Line bounds [start, end) of a `## <heading>` section body, or null when absent. */
function sectionLines(lines: readonly string[], heading: RegExp): { start: number; end: number } | null {
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s+\S/.test(line));
  return { start: start + 1, end: end < 0 ? lines.length : end };
}

/** Line bounds [start, end) of the `### Bar-to-work map for this plan` table, or null. */
function barMapLines(lines: readonly string[]): { start: number; end: number } | null {
  const design = sectionLines(lines, /^##\s+Design\s*$/i);
  if (!design) return null;
  for (let index = design.start; index < design.end; index++) {
    if (!/^###\s+Bar-to-work map for this plan\s*$/i.test(lines[index]!.trim())) continue;
    let end = index + 1;
    while (end < design.end && !/^###\s+/.test(lines[end]!)) end++;
    return { start: index + 1, end };
  }
  return null;
}

/** Same row key rule as parseBarMappings: the first cell, backticks stripped. */
function mapRowBarKey(line: string): string | null {
  if (!line.trim().startsWith('|')) return null;
  const key = (line.split('|').slice(1, -1)[0] ?? '').replace(/`/g, '').trim();
  return /^R-\d+$/.test(key) ? key : null;
}

export type RetirementSourceProblemCode = 'retiring_bar_record_duplicate' | 'retiring_bar_map_row_duplicate';

export interface RetirementSourceProblem {
  code: RetirementSourceProblemCode;
  barKey: string;
  detail: string;
}

export type RetirementSource =
  | {
      ok: true;
      /** The proposed source: the original with every retired record and map row removed. */
      content: string;
      /** Retiring BARs whose Requirements record this derivation removed, in BAR order. */
      retired: string[];
      /** Retiring BARs whose Bar-to-work map row this derivation removed, in BAR order. */
      removedMapRows: string[];
    }
  | { ok: false; problems: RetirementSourceProblem[] };

/**
 * EI-24358433996857425 (acceptance-bar-atomic-retirement-2026-10-15 D-002): derive the proposed
 * plan source for an amendment that RETIRES BARs, before any source validation runs.
 *
 * Retiring a BAR means its Requirements record and its Bar-to-work map row stop existing. The
 * amendment used to validate the ORIGINAL source first, so a retiring BAR whose only mapped
 * work was dropped tripped `bar_mapping_dropped_only` before the removal could happen: the one
 * repair for that state was unreachable. Validating the proposed source instead keeps every
 * survivor check intact (a surviving dropped-only BAR is still refused) while letting the
 * retirement through.
 *
 * Only the retiring BARs' own spans change. A record spans its header line through the line
 * before the next R-looking bold line or the end of `## Requirements`, which is exactly what
 * parseRequirementBars treats as that record's body. Every other byte, including plan items
 * that mapped to the retired BAR, survives unchanged.
 *
 * A retiring BAR the source no longer carries is left alone: removing it from the plan first
 * and then amending the rubric is a supported order, and the proposed source still has to
 * pass the full parse afterwards, so a stale map row for an absent record stays refused there.
 * Duplicate records or rows for a retiring BAR are refused: deleting one of two copies would
 * be a guess about which copy the author meant.
 */
export function retireRequirementBarsFromSource(planContent: string, retiringBars: Iterable<string>): RetirementSource {
  const retiring = new Set([...retiringBars].map((barKey) => barKey.trim()).filter(Boolean));
  const unchanged = { ok: true as const, content: planContent, retired: [] as string[], removedMapRows: [] as string[] };
  if (!retiring.size) return unchanged;

  const lines = planContent.split('\n');
  const remove = new Set<number>();
  const problems: RetirementSourceProblem[] = [];
  const retired: string[] = [];
  const removedMapRows: string[] = [];

  const requirements = sectionLines(lines, /^##\s+Requirements\s*$/i);
  if (requirements) {
    const spans = new Map<string, Array<{ start: number; end: number }>>();
    for (let index = requirements.start; index < requirements.end; index++) {
      const header = REQUIREMENT_HEADER.exec(lines[index]!);
      if (!header || !retiring.has(header[1]!)) continue;
      let end = index + 1;
      while (end < requirements.end && !REQUIREMENT_BOUNDARY.test(lines[end]!)) end++;
      spans.set(header[1]!, [...(spans.get(header[1]!) ?? []), { start: index, end }]);
    }
    for (const [barKey, found] of spans) {
      if (found.length > 1) {
        problems.push({
          code: 'retiring_bar_record_duplicate',
          barKey,
          detail: `${barKey} has ${found.length} Requirements records; retire it only after removing the duplicate`,
        });
        continue;
      }
      for (let index = found[0]!.start; index < found[0]!.end; index++) remove.add(index);
      retired.push(barKey);
    }
  }

  const map = barMapLines(lines);
  if (map) {
    const rows = new Map<string, number[]>();
    for (let index = map.start; index < map.end; index++) {
      const barKey = mapRowBarKey(lines[index]!);
      if (barKey && retiring.has(barKey)) rows.set(barKey, [...(rows.get(barKey) ?? []), index]);
    }
    for (const [barKey, found] of rows) {
      if (found.length > 1) {
        problems.push({
          code: 'retiring_bar_map_row_duplicate',
          barKey,
          detail: `${barKey} has ${found.length} Bar-to-work map rows; retire it only after removing the duplicate`,
        });
        continue;
      }
      // A row whose record is absent was not written by this derivation's author; keep it so
      // the proposed-source parse refuses it exactly as it refused the original source.
      if (!retired.includes(barKey)) continue;
      remove.add(found[0]!);
      removedMapRows.push(barKey);
    }
  }

  const byBar = (a: string, b: string) => barNumber(a) - barNumber(b) || a.localeCompare(b);
  if (problems.length) {
    return { ok: false, problems: problems.sort((a, b) => byBar(a.barKey, b.barKey)) };
  }
  if (!remove.size) return unchanged;
  return {
    ok: true,
    content: lines.filter((_, index) => !remove.has(index)).join('\n'),
    retired: retired.sort(byBar),
    removedMapRows: removedMapRows.sort(byBar),
  };
}

/**
 * Fingerprint of the source a BAR amendment derives and reviews: the `## Requirements` body
 * plus the Bar-to-work map table, and nothing else. Decisions appended between preview and
 * apply (a leader's disposition, this amendment's own Decision) do not move it; any change to
 * a record or a map row does.
 */
export function acceptanceBarSourceFingerprint(planContent: string): string {
  const lines = planContent.split('\n');
  const requirements = sectionLines(lines, /^##\s+Requirements\s*$/i);
  const map = barMapLines(lines);
  const slice = (bounds: { start: number; end: number } | null) =>
    bounds ? lines.slice(bounds.start, bounds.end).join('\n') : '\u0000absent';
  return createHash('sha256')
    .update(`requirements\n${slice(requirements)}\n\u0000map\n${slice(map)}`)
    .digest('hex');
}

export type BarMappingPlane = 'tree' | 'deployed' | 'live';

/** One side of a Bar-to-work map row: the plan items a BAR discharges through, and its plane. */
export interface BarMappingSide {
  planItemIds: string[];
  evidencePlane: BarMappingPlane;
}

/**
 * One explicit prior-to-next move of a BAR's Bar-to-work map row. `prior` is the caller's claim
 * about the LOCKED source row; a row that differs refuses, so a delta reviewed against one map
 * cannot rewrite another.
 */
export interface BarMappingDeltaEntry {
  barKey: string;
  prior: BarMappingSide;
  next: BarMappingSide;
}

export type BarMappingDeltaProblemCode =
  | 'mapping_delta_invalid'
  | 'mapping_delta_duplicate'
  | 'mapping_delta_noop'
  | 'mapping_delta_row_missing'
  | 'mapping_delta_row_duplicate'
  | 'mapping_delta_prior_mismatch';

export interface BarMappingDeltaProblem {
  code: BarMappingDeltaProblemCode;
  barKey: string;
  detail: string;
}

export type BarMappingDeltaSource =
  | {
      ok: true;
      /** The source with every delta row rewritten to its `next` side; every other byte unchanged. */
      content: string;
      /** The normalized delta this derivation applied (sorted by BAR, ids sorted). */
      applied: BarMappingDeltaEntry[];
    }
  | { ok: false; problems: BarMappingDeltaProblem[] };

const PLAN_ITEM_ID = /^P-\d{3,}$/;
const MAPPING_PLANES: readonly BarMappingPlane[] = ['tree', 'deployed', 'live'];
const sortItemIds = (ids: readonly string[]) =>
  [...new Set(ids.map((id) => id.trim()))].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)) || a.localeCompare(b));

/**
 * Canonical form of a mapping delta: BAR order, de-duplicated and numerically sorted item ids.
 * Approval receipts, idempotency keys and request hashes compare THIS form, so a reviewer who
 * lists the same move in another order approves the same delta.
 */
export function normalizeBarMappingDelta(delta: readonly BarMappingDeltaEntry[]): BarMappingDeltaEntry[] {
  return delta
    .map((entry) => ({
      barKey: entry.barKey.trim(),
      prior: { planItemIds: sortItemIds(entry.prior.planItemIds), evidencePlane: entry.prior.evidencePlane },
      next: { planItemIds: sortItemIds(entry.next.planItemIds), evidencePlane: entry.next.evidencePlane },
    }))
    .sort((a, b) => barNumber(a.barKey) - barNumber(b.barKey) || a.barKey.localeCompare(b.barKey));
}

/** Stable hash of a normalized delta, for idempotency keys and request hashes. */
export function barMappingDeltaHash(delta: readonly BarMappingDeltaEntry[]): string {
  return createHash('sha256').update(JSON.stringify(normalizeBarMappingDelta(delta))).digest('hex');
}

const sameSide = (a: BarMappingSide, b: BarMappingSide) =>
  a.evidencePlane === b.evidencePlane && a.planItemIds.join(',') === b.planItemIds.join(',');

/**
 * EI-24358433996857425 Part B (acceptance-bar-atomic-retirement-2026-10-15 R-6/R-8/R-28): rewrite
 * the Bar-to-work map rows named by an explicit mapping delta, for a BAR whose meaning (hash) is
 * unchanged but whose discharge work moves.
 *
 * Each entry's `prior` must equal its locked row exactly (item-id SET and plane, the same reading
 * parseBarMappings gives the row); otherwise the delta was derived from another map and refuses.
 * Only the delta rows change: cells[1] (item ids) and cells[2] (plane) are rewritten, any further
 * cells are kept. Whether the `next` items exist and are live is left to the full parse that runs
 * on the result, exactly as for every other proposed source.
 */
export function applyBarMappingDelta(planContent: string, delta: readonly BarMappingDeltaEntry[]): BarMappingDeltaSource {
  const applied = normalizeBarMappingDelta(delta);
  if (!applied.length) return { ok: true, content: planContent, applied };
  const problems: BarMappingDeltaProblem[] = [];
  const seen = new Set<string>();
  for (const entry of applied) {
    const sides = [entry.prior, entry.next];
    if (
      !/^R-\d+$/.test(entry.barKey) ||
      sides.some((side) => !side.planItemIds.length || side.planItemIds.some((id) => !PLAN_ITEM_ID.test(id)) ||
        !MAPPING_PLANES.includes(side.evidencePlane))
    ) {
      problems.push({
        code: 'mapping_delta_invalid',
        barKey: entry.barKey,
        detail: `${entry.barKey} delta needs an R-N key and, on both sides, one or more P-NNN ids and a tree|deployed|live plane`,
      });
      continue;
    }
    if (seen.has(entry.barKey)) {
      problems.push({ code: 'mapping_delta_duplicate', barKey: entry.barKey, detail: `${entry.barKey} appears twice in the delta` });
      continue;
    }
    seen.add(entry.barKey);
    if (sameSide(entry.prior, entry.next)) {
      problems.push({ code: 'mapping_delta_noop', barKey: entry.barKey, detail: `${entry.barKey} delta does not move the mapping` });
    }
  }

  const lines = planContent.split('\n');
  const map = barMapLines(lines);
  const rows = new Map<string, number[]>();
  if (map) {
    for (let index = map.start; index < map.end; index++) {
      const barKey = mapRowBarKey(lines[index]!);
      if (barKey && seen.has(barKey)) rows.set(barKey, [...(rows.get(barKey) ?? []), index]);
    }
  }
  for (const entry of applied) {
    if (!seen.has(entry.barKey) || problems.some((problem) => problem.barKey === entry.barKey)) continue;
    const found = rows.get(entry.barKey) ?? [];
    if (found.length !== 1) {
      problems.push({
        code: found.length ? 'mapping_delta_row_duplicate' : 'mapping_delta_row_missing',
        barKey: entry.barKey,
        detail: found.length
          ? `${entry.barKey} has ${found.length} Bar-to-work map rows; remove the duplicate before moving it`
          : `${entry.barKey} has no Bar-to-work map row to move`,
      });
      continue;
    }
    const cells = lines[found[0]!]!.split('|').slice(1, -1).map((cell) => cell.trim());
    const plane = (cells[2] ?? '').replace(/`/g, '').trim().toLowerCase() || 'tree';
    const locked: BarMappingSide = {
      planItemIds: sortItemIds(cells[1]?.match(/P-\d{3,}/g) ?? []),
      evidencePlane: plane as BarMappingPlane,
    };
    if (!sameSide(locked, entry.prior)) {
      problems.push({
        code: 'mapping_delta_prior_mismatch',
        barKey: entry.barKey,
        detail: `${entry.barKey} delta prior is ${entry.prior.planItemIds.join(', ')} (${entry.prior.evidencePlane}), ` +
          `but the locked row is ${locked.planItemIds.join(', ') || '(none)'} (${plane}); re-derive the delta from the current map`,
      });
      continue;
    }
    const rewritten = [...cells];
    rewritten[1] = entry.next.planItemIds.join(', ');
    rewritten[2] = entry.next.evidencePlane;
    lines[found[0]!] = `| ${rewritten.join(' | ')} |`;
  }
  if (problems.length) {
    return {
      ok: false,
      problems: problems.sort((a, b) => barNumber(a.barKey) - barNumber(b.barKey) || a.code.localeCompare(b.code)),
    };
  }
  return { ok: true, content: lines.join('\n'), applied };
}
