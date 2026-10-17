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
import type { ParsedRequirementBar } from './acceptance-bar-seed';

export type RequirementsDriftField =
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

/** Requirement text also represents METHOD/replication, which do not change BAR meaning. */
export function amendedRequirementBarKeys(
  priorCriteria: ReadonlyArray<Record<string, unknown>>,
  nextCriteria: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const priorByBar = new Map(priorCriteria.map((criterion) => [criterion.barKey, criterion]));
  const fields = ['model', 'driftMarkers', ...VERIFICATION_FIELDS, ...STATED_ACCEPTANCE_FIELDS] as const;
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
 * function compares — condition (model), falsifier (driftMarkers), method/check/replication, and any
 * STATED acceptance metadata — so a re-rendered block reads in sync. Acceptance metadata the block
 * does not state is left unstated, because the seeder derives it from the Bar-to-work map. Intent is
 * the plan's own record of the request and is never rewritten. Legacy prose R-N records, unchanged
 * BARs, and blocks that do not parse are left byte-identical. Pure: callers write the result.
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
    const next = JSON.stringify({ ...block, acceptance, verification });
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
