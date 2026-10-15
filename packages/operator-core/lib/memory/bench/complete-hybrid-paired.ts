/**
 * Paired, source-grouped comparison of complete-hybrid-bench arms
 * (plan mdenseon-adoption-measurements-2026-10-01, P-004 / acceptance R-3).
 *
 * `complete-hybrid-bench` writes one report per model arm: aggregate route
 * summaries plus a per-query row carrying every route's ranked keys, reciprocal
 * rank, precision and negative admission. The aggregates answer "what did each
 * arm score"; they cannot answer "is the candidate's difference outside noise",
 * which is a PAIRED question over the same frozen queries. This module answers
 * it from the rows and nothing else.
 *
 * Two parts, deliberately separate:
 *
 *  - {@link assertComparableArms} refuses any arm set whose comparison would be
 *    meaningless or unsafe: different snapshot/gold/ages inputs, a synthetic
 *    embedder, two arms sharing one benchmark schema (embedding-space
 *    separation), a production schema, a scope-isolation leak, a missing
 *    positive control, or per-query identities that differ between arms.
 *  - {@link pairCompleteArms} reports, per route and class, the reciprocal-rank
 *    comparison from {@link compareSourceGroupedLegs} (source-target components
 *    as the resampling unit, the fixed adoption margin), plus recall@10 and
 *    precision over the SAME components, and hard-negative admission over the
 *    negatives' own source groups. Every interval is a paired bootstrap; every
 *    binary outcome also gets McNemar's exact test as a query-level diagnostic.
 *
 * Precision is undefined for an empty result list (the push routes return
 * nothing below their floors by design), so it is compared only over queries
 * where BOTH arms returned something; how many were excluded is reported, and
 * empty-vs-non-empty is compared separately rather than silently scored as 0.
 */
import { mcnemarExact, pairedBootstrapCI, type McNemarResult, type PairedComparison } from '@papercusp/bench-metrics';
import { ALL_ANSWERABLE, ANSWERABLE_CLASSES, compareSourceGroupedLegs, type PerQueryRow } from './paired-leg-report';
import { ROUTES, type Route, type RouteRow } from './complete-hybrid-bench';

/** One query of a complete-hybrid-bench report (`rows[]`), every route scored by `scoreRoute`. */
export interface CompleteArmRow {
  id: string;
  class: string;
  group: string;
  expected: string[];
  routes: Record<Route, RouteRow>;
}

export interface CompleteArmReport {
  runner: string;
  model: string;
  corpus: string;
  binding: { schema: string; syntheticEmbedder: boolean };
  inputs: { snapshotSha256: string; goldSha256: string; agesSha256?: string };
  guards: { scopeIsolation: { leakScope: string; decoys: number; positiveControlHits: number; leakedHits: number } };
  rows: CompleteArmRow[];
}

export interface SnapshotEntryRef { key: string; metadata?: Record<string, unknown> }

/** Schemas a benchmark arm may never write vectors into. */
export const PRODUCTION_SCHEMAS: ReadonlySet<string> = new Set(['public', 'harness_shared']);

const HARD_NEGATIVE = 'hard-negative';

/**
 * Refuse an arm set that cannot be compared honestly. Returns the isolation
 * facts it verified, so a report can cite them instead of asserting them.
 */
export function assertComparableArms(reports: readonly CompleteArmReport[]) {
  if (reports.length < 2) throw new Error('complete-hybrid paired comparison needs at least two arms');
  const [first] = reports;
  const models = reports.map((r) => r.model);
  if (new Set(models).size !== models.length) throw new Error(`duplicate arm model: ${models.join(', ')}`);
  const schemas = reports.map((r) => r.binding.schema);
  if (new Set(schemas).size !== schemas.length) throw new Error(`arms share a benchmark schema (embedding spaces not separated): ${schemas.join(', ')}`);
  const reference = new Map(first!.rows.map((row) => [row.id, row]));
  if (reference.size !== first!.rows.length) throw new Error(`${first!.model} has duplicate query ids`);
  for (const report of reports) {
    if (report.runner !== 'complete-hybrid-bench') throw new Error(`${report.model}: not a complete-hybrid-bench report (${report.runner})`);
    if (report.corpus !== first!.corpus) throw new Error(`${report.model}: corpus ${report.corpus} differs from ${first!.corpus}`);
    if (PRODUCTION_SCHEMAS.has(report.binding.schema)) throw new Error(`${report.model}: wrote into production schema ${report.binding.schema}`);
    if (report.binding.syntheticEmbedder !== false) throw new Error(`${report.model}: synthetic embedder, not a real model arm`);
    for (const key of ['snapshotSha256', 'goldSha256', 'agesSha256'] as const) {
      if ((report.inputs[key] ?? null) !== (first!.inputs[key] ?? null)) throw new Error(`${report.model}: ${key} differs from ${first!.model}`);
    }
    const iso = report.guards.scopeIsolation;
    if (!(iso.decoys > 0) || !(iso.positiveControlHits > 0)) throw new Error(`${report.model}: scope-isolation guard has no decoys or no positive-control hits`);
    if (iso.leakedHits !== 0) throw new Error(`${report.model}: scope-isolation leak (${iso.leakedHits} hits)`);
    if (report.rows.length !== reference.size) throw new Error(`${report.model}: ${report.rows.length} rows vs ${reference.size}`);
    for (const row of report.rows) {
      const ref = reference.get(row.id);
      if (!ref || ref.class !== row.class || ref.group !== row.group || JSON.stringify(ref.expected) !== JSON.stringify(row.expected)) {
        throw new Error(`${report.model}: query identity mismatch at ${row.id}`);
      }
      for (const route of ROUTES) {
        const outcome = row.routes[route];
        if (!outcome) throw new Error(`${report.model}: ${row.id} missing route ${route}`);
        if (outcome.leakedKeys.length) throw new Error(`${report.model}: ${row.id} ${route} leaked ${outcome.leakedKeys.join(', ')}`);
      }
    }
  }
  return {
    corpus: first!.corpus,
    queries: reference.size,
    inputs: { ...first!.inputs },
    arms: reports.map((r) => ({ model: r.model, schema: r.binding.schema, scopeIsolation: { ...r.guards.scopeIsolation } })),
  };
}

export interface GroupedPairedOutcome {
  /** Source groups contributing at least one included query. */
  sourceGroups: number;
  /** Queries included in the comparison. */
  queries: number;
  /** Queries excluded by the inclusion rule (e.g. an empty result in either arm). */
  excludedQueries: number;
  comparison: PairedComparison | null;
}

function groupedPaired(
  groups: readonly { source: string; queryIds: readonly string[] }[],
  valueA: (id: string) => number, valueB: (id: string) => number,
  include: (id: string) => boolean, seed: number, iterations: number,
): GroupedPairedOutcome {
  const a: number[] = [];
  const b: number[] = [];
  let queries = 0;
  let excluded = 0;
  for (const g of groups) {
    const ids = g.queryIds.filter((id) => { const keep = include(id); if (!keep) excluded++; return keep; });
    if (!ids.length) continue;
    queries += ids.length;
    a.push(ids.reduce((s, id) => s + valueA(id), 0) / ids.length);
    b.push(ids.reduce((s, id) => s + valueB(id), 0) / ids.length);
  }
  return { sourceGroups: a.length, queries, excludedQueries: excluded, comparison: a.length ? pairedBootstrapCI(a, b, { seed, iterations }) : null };
}

function firstRelevantRank(expected: readonly string[], ranked: readonly string[]): number {
  const i = ranked.findIndex((k) => expected.includes(k));
  return i < 0 ? 0 : i + 1;
}

export interface RoutePairing {
  /** Reciprocal rank by source-target component, with the fixed adoption-margin decision. */
  mrr: ReturnType<typeof compareSourceGroupedLegs>['byClass'];
  positives: Record<string, { recallAt10: GroupedPairedOutcome; precision: GroupedPairedOutcome; nonEmpty: McNemarResult }>;
  /** Hard negatives: admission rate (lower is better) by the negatives' own source groups. */
  negatives: { admission: GroupedPairedOutcome; rejected: McNemarResult };
}

/**
 * Pair a candidate arm against a baseline arm over every route. Call
 * {@link assertComparableArms} first; this function re-checks only what it
 * needs to index the rows.
 */
export function pairCompleteArms(
  baseline: CompleteArmReport, candidate: CompleteArmReport, entries: readonly SnapshotEntryRef[],
  opts: { seed?: number; iterations?: number } = {},
): { baseline: string; candidate: string; corpus: string; routes: Record<Route, RoutePairing> } {
  const seed = opts.seed ?? 10004538;
  const iterations = opts.iterations ?? 20000;
  const A = new Map(baseline.rows.map((r) => [r.id, r]));
  const B = new Map(candidate.rows.map((r) => [r.id, r]));
  if (A.size !== B.size || [...A.keys()].some((id) => !B.has(id))) throw new Error('arms do not cover the same queries');
  const queries = baseline.rows.map((r) => ({ id: r.id, class: r.class, group: r.group, expected: r.expected }));
  const negatives = baseline.rows.filter((r) => r.class === HARD_NEGATIVE);
  const routes = {} as Record<Route, RoutePairing>;
  for (const route of ROUTES) {
    const o = (m: Map<string, CompleteArmRow>, id: string) => m.get(id)!.routes[route];
    const perQuery = (rows: readonly CompleteArmRow[]): PerQueryRow[] => rows.map((r) => ({
      id: r.id, class: r.class, reciprocalRank: r.routes[route].reciprocalRank,
      firstRelevantRank: firstRelevantRank(r.expected, r.routes[route].rankedKeys), top1Score: 0,
    }));
    const mrr = compareSourceGroupedLegs(baseline.model, perQuery(baseline.rows), candidate.model, perQuery(candidate.rows), entries, queries);
    const positives: RoutePairing['positives'] = {};
    for (const cls of [...ANSWERABLE_CLASSES, ALL_ANSWERABLE]) {
      const groups = mrr.byClass[cls]!.groups;
      const ids = groups.flatMap((g) => g.queryIds);
      const hit = (m: Map<string, CompleteArmRow>) => (id: string) => (o(m, id).relevantHits > 0 ? 1 : 0);
      positives[cls] = {
        recallAt10: groupedPaired(groups, hit(A), hit(B), () => true, seed, iterations),
        precision: groupedPaired(groups, (id) => o(A, id).precision!, (id) => o(B, id).precision!,
          (id) => o(A, id).precision !== null && o(B, id).precision !== null, seed, iterations),
        nonEmpty: mcnemarExact(ids.map((id) => o(A, id).precision !== null), ids.map((id) => o(B, id).precision !== null)),
      };
    }
    const negGroups = [...negatives.reduce((m, r) => m.set(r.group, [...(m.get(r.group) ?? []), r.id]), new Map<string, string[]>())]
      .sort(([x], [y]) => x.localeCompare(y)).map(([source, queryIds]) => ({ source, queryIds }));
    const admitted = (m: Map<string, CompleteArmRow>) => (id: string) => {
      const v = o(m, id).admittedNegative;
      if (v === null) throw new Error(`hard negative ${id} has no admission outcome on ${route}`);
      return v ? 1 : 0;
    };
    routes[route] = {
      mrr: mrr.byClass,
      positives,
      negatives: {
        admission: groupedPaired(negGroups, admitted(A), admitted(B), () => true, seed, iterations),
        rejected: mcnemarExact(negatives.map((r) => !o(A, r.id).admittedNegative), negatives.map((r) => !o(B, r.id).admittedNegative)),
      },
    };
  }
  return { baseline: baseline.model, candidate: candidate.model, corpus: baseline.corpus, routes };
}
