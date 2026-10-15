/**
 * Equivalence guard for WI-6554700010008460: the dependency-graph census analyses only
 * the work_items rows whose feature_id could resolve an edge endpoint
 * (`dependencyEndpointCandidateFeatureIds`), instead of every row. This pins that the
 * filtered analysis is IDENTICAL to the full one for everything the census reports
 * (cycles, endpoint defects, bad roots, stranded closure) and that every excluded row's
 * full-graph verdict is trivially `reachable`.
 *
 * A deliberately wrong candidate function (bare refs only, ignoring the `harness#id`
 * suffix) is kept permanently as a control: the property must DETECT it, otherwise the
 * generator is too weak to guard the real function.
 */
import { describe, expect, it } from 'vitest';
import { analyzeDependencyGraph, type DependencyGraphEdgeInput } from './dependency-graph-analysis';
import {
  type CensusWorkItemRow,
  censusNodeFromWorkItemRow,
  dependencyEndpointCandidateFeatureIds,
} from './dependency-graph-census-nodes';

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x1_0000_0000;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const HARNESSES = [
  { harness: 'h1', workspace: 'w1' },
  { harness: 'h2', workspace: 'w2' },
] as const;
const KINDS = ['bug', 'change', 'task', 'feature'] as const;
const STATUSES = ['open', 'wip', 'blocked', 'done', 'dropped', 'resolved', 'passed', null] as const;

function generate(seed: number): { rows: CensusWorkItemRow[]; edges: DependencyGraphEdgeInput[] } {
  const r = rng(seed);
  const rows: CensusWorkItemRow[] = [];
  const graphIds: Array<{ id: string; harness: string; kind: string }> = [];
  for (let i = 0; i < 40; i += 1) {
    const h = pick(r, HARNESSES);
    const kind = pick(r, KINDS);
    const id = `WI-${i}`;
    rows.push({ workspace_id: h.workspace, harness_slug: h.harness, feature_id: id, item_kind: kind, status: pick(r, STATUSES) });
    graphIds.push({ id, harness: h.harness, kind });
    // Same feature id in the other harness sometimes: exercises ambiguity.
    if (r() < 0.15) {
      const other = HARNESSES.find((x) => x.harness !== h.harness)!;
      rows.push({ workspace_id: other.workspace, harness_slug: other.harness, feature_id: id, item_kind: pick(r, KINDS), status: pick(r, STATUSES) });
    }
  }
  // The bulk of the table: rows no edge touches.
  for (let i = 0; i < 300; i += 1) {
    const h = pick(r, HARNESSES);
    rows.push({ workspace_id: h.workspace, harness_slug: h.harness, feature_id: `X-${i}`, item_kind: pick(r, KINDS), status: pick(r, STATUSES) });
  }
  const endpoint = () => {
    const g = pick(r, graphIds);
    const issue = g.kind !== 'feature';
    const roll = r();
    if (roll < 0.55) return issue ? { kind: 'issue', ref: g.id } : { kind: 'feature', ref: `${g.harness}#${g.id}` };
    if (roll < 0.7) return issue ? { kind: 'feature', ref: `${g.harness}#${g.id}` } : { kind: 'issue', ref: g.id };
    if (roll < 0.8) return { kind: pick(r, ['issue', 'feature']), ref: `${pick(r, HARNESSES).harness}#${g.id}` };
    if (roll < 0.9) return { kind: pick(r, ['issue', 'feature']), ref: `WI-${900 + Math.floor(r() * 5)}` };
    return { kind: 'plan_item', ref: g.id };
  };
  const edges: DependencyGraphEdgeInput[] = [];
  const edgeCount = 10 + Math.floor(r() * 30);
  for (let i = 0; i < edgeCount; i += 1) edges.push({ blocked: endpoint(), blocker: endpoint(), provenance: `e${i}` });
  return { rows, edges };
}

function compare(
  seed: number,
  candidates: (refs: string[]) => string[],
): { equal: boolean; detail: string } {
  const { rows, edges } = generate(seed);
  const full = analyzeDependencyGraph({ nodes: rows.map(censusNodeFromWorkItemRow), edges });
  const ids = new Set(candidates(edges.flatMap((e) => [e.blocked.ref, e.blocker.ref])));
  const kept = rows.filter((row) => ids.has(row.feature_id));
  const filtered = analyzeDependencyGraph({ nodes: kept.map(censusNodeFromWorkItemRow), edges });
  const reported = (a: typeof full) => ({
    scc: a.stronglyConnectedComponents,
    defects: a.endpointDefects,
    roots: a.impossibleRoots,
    stranded: a.stranded,
    closure: a.strandedClosure,
  });
  const fullReported = JSON.stringify(reported(full));
  const filteredReported = JSON.stringify(reported(filtered));
  if (fullReported !== filteredReported) return { equal: false, detail: `seed ${seed}: reported analysis differs` };
  const keptKeys = new Set(filtered.verdicts.map((v) => `${v.node.kind}:${v.node.ref}`));
  for (const v of full.verdicts) {
    const key = `${v.node.kind}:${v.node.ref}`;
    if (keptKeys.has(key)) continue;
    if (v.verdict !== 'reachable' || v.impossibleRootIds.length > 0 || v.unknownRootKeys.length > 0) {
      return { equal: false, detail: `seed ${seed}: excluded node ${key} has verdict ${v.verdict}` };
    }
  }
  const fullByKey = new Map(full.verdicts.map((v) => [`${v.node.kind}:${v.node.ref}`, JSON.stringify(v)]));
  for (const v of filtered.verdicts) {
    if (fullByKey.get(`${v.node.kind}:${v.node.ref}`) !== JSON.stringify(v)) {
      return { equal: false, detail: `seed ${seed}: verdict for ${v.node.kind}:${v.node.ref} differs` };
    }
  }
  return { equal: true, detail: '' };
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('dependencyEndpointCandidateFeatureIds', () => {
  it('includes the bare ref and the feature id after a harness qualifier', () => {
    expect(dependencyEndpointCandidateFeatureIds(['WI-1', 'h1#WI-2', 'h1#WI-1', ''])).toEqual(['WI-1', 'WI-2', 'h1#WI-1', 'h1#WI-2']);
  });

  it('keeps both suffixes when a ref carries more than one #', () => {
    expect(dependencyEndpointCandidateFeatureIds(['a#b#c'])).toEqual(['a#b#c', 'b#c', 'c']);
  });
});

describe('census candidate filtering is analysis-equivalent (WI-6554700010008460)', () => {
  it('filtered and full analyses report identically across random graphs with many edge-free rows', () => {
    const failures = SEEDS.map((seed) => compare(seed, dependencyEndpointCandidateFeatureIds)).filter((r) => !r.equal);
    expect(failures.map((f) => f.detail)).toEqual([]);
  });

  it('the generator produces the cases that matter (defects, cycles, stranded rows)', () => {
    let defects = 0;
    let cycles = 0;
    let stranded = 0;
    for (const seed of SEEDS) {
      const { rows, edges } = generate(seed);
      const a = analyzeDependencyGraph({ nodes: rows.map(censusNodeFromWorkItemRow), edges });
      defects += a.endpointDefects.length;
      cycles += a.stronglyConnectedComponents.length;
      stranded += a.stranded.length;
    }
    expect(defects).toBeGreaterThan(0);
    expect(cycles).toBeGreaterThan(0);
    expect(stranded).toBeGreaterThan(0);
  });

  it('CONTROL: a candidate function that ignores the harness#id suffix is detected', () => {
    const bareOnly = (refs: string[]) => [...new Set(refs)];
    const detected = SEEDS.some((seed) => !compare(seed, bareOnly).equal);
    expect(detected).toBe(true);
  });
});
