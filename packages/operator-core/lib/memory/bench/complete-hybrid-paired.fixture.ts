/**
 * Deterministic two-arm fixture for complete-hybrid-paired (plan
 * mdenseon-adoption-measurements-2026-10-01, P-004: AUTO-BAR-R-3-P-004 and
 * MDENSE-scope-space-isolation). Rows are built through the bench's own
 * `scoreRoute`, so the fixture cannot drift from what the runner writes.
 *
 * Shape, chosen so every reported quantity has a hand-computable answer:
 *  - 3 answerable classes x 6 source targets, plus one extra query per class
 *    that shares source 0 (it must COLLAPSE into that source target);
 *  - 6 hard negatives over 3 negative sources (two each);
 *  - baseline ('gemma'): answer at rank 2 behind noise, admits every negative;
 *  - candidate ('mdenseon'): answer at rank 1, except one EMPTY result
 *    (lexical-gap-1), and rejects the even-numbered negatives.
 *
 * {@link ISOLATION_VIOLATIONS} is the scope/space-isolation and comparability
 * refusal table: each entry corrupts one arm the way a broken run would.
 */
import { ROUTES, scoreRoute, type Route, type RouteRow } from './complete-hybrid-bench';
import type { CompleteArmReport } from './complete-hybrid-paired';

export const FIXTURE_CLASSES = ['exact-identifier', 'lexical-gap', 'session-start-intent'] as const;

export interface FixtureQuery { id: string; class: string; group: string; expected: string[] }

export const FIXTURE_QUERIES: readonly FixtureQuery[] = [
  ...FIXTURE_CLASSES.flatMap((c) => [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `${c}-${i}`, class: c, group: `src-${c}-${i}`, expected: [`doc:${c}-${i}`] })),
    { id: `${c}-0b`, class: c, group: `src-${c}-0`, expected: [`doc:${c}-0`] },
  ]),
  ...Array.from({ length: 6 }, (_, i) => ({ id: `neg-${i}`, class: 'hard-negative', group: `neg-src-${i % 3}`, expected: [] })),
];

export const FIXTURE_ENTRIES = [
  ...FIXTURE_QUERIES.flatMap((q) => q.expected.map((key) => ({ key, metadata: { cluster: q.group } }))),
  { key: 'doc:noise', metadata: { cluster: 'noise' } },
];

export function fixtureArm(model: string, rank: (q: FixtureQuery) => string[]): CompleteArmReport {
  return {
    runner: 'complete-hybrid-bench', model, corpus: 'memory',
    binding: { schema: `bench_memory_${model}`, syntheticEmbedder: false },
    inputs: { snapshotSha256: 'snap', goldSha256: 'gold', agesSha256: 'ages' },
    guards: { scopeIsolation: { leakScope: 'bench-leak', decoys: 3, positiveControlHits: 2, leakedHits: 0 } },
    rows: FIXTURE_QUERIES.map((q) => ({
      ...q,
      expected: [...q.expected],
      routes: Object.fromEntries(ROUTES.map((r) => [r, scoreRoute(q.expected, rank(q))])) as Record<Route, RouteRow>,
    })),
  };
}

export const fixtureBaseline = () => fixtureArm('gemma', (q) => (q.expected.length ? ['doc:noise', ...q.expected] : ['doc:noise']));

export const fixtureCandidate = () => fixtureArm('mdenseon', (q) => {
  if (q.id === 'lexical-gap-1') return [];
  if (!q.expected.length) return Number(q.id.slice(4)) % 2 === 0 ? [] : ['doc:noise'];
  return [...q.expected];
});

export interface IsolationViolation {
  name: string;
  mutate: (baseline: CompleteArmReport, candidate: CompleteArmReport) => void;
  error: RegExp;
}

export const ISOLATION_VIOLATIONS: readonly IsolationViolation[] = [
  { name: 'a different gold set', mutate: (_, c) => { c.inputs.goldSha256 = 'other'; }, error: /goldSha256 differs/ },
  { name: 'a different ages freeze', mutate: (_, c) => { delete c.inputs.agesSha256; }, error: /agesSha256 differs/ },
  { name: 'two arms in one schema (shared vector space)', mutate: (b, c) => { c.binding.schema = b.binding.schema; }, error: /share a benchmark schema/ },
  { name: 'a production schema', mutate: (b) => { b.binding.schema = 'harness_shared'; }, error: /production schema/ },
  { name: 'a synthetic embedder', mutate: (_, c) => { c.binding.syntheticEmbedder = true; }, error: /synthetic embedder/ },
  { name: 'a scope leak', mutate: (_, c) => { c.guards.scopeIsolation.leakedHits = 1; }, error: /scope-isolation leak/ },
  { name: 'a guard with no positive control', mutate: (_, c) => { c.guards.scopeIsolation.positiveControlHits = 0; }, error: /no positive-control/ },
  { name: 'a query identity mismatch', mutate: (_, c) => { c.rows[0]!.group = 'elsewhere'; }, error: /query identity mismatch/ },
  { name: 'a leaked key on one route', mutate: (_, c) => { c.rows[0]!.routes.push = scoreRoute(c.rows[0]!.expected, ['leak:x']); }, error: /leaked leak:x/ },
  { name: 'a different corpus', mutate: (_, c) => { c.corpus = 'prose'; }, error: /corpus prose differs/ },
];
