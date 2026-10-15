import { describe, expect, it } from 'vitest';
import {
  analyzeDependencyGraph,
  dependencyIdentityKey,
  type DependencyGraphEdgeInput,
  type DependencyGraphNodeInput,
  type DependencyIdentity,
} from './dependency-graph-analysis';

const id = (ref: string, kind = 'feature'): DependencyIdentity => ({ kind, ref });
const node = (
  ref: string,
  opts: Omit<DependencyGraphNodeInput, 'id'> = {},
  kind = 'feature',
): DependencyGraphNodeInput => ({ id: id(ref, kind), ...opts });
const edge = (blocked: string, blocker: string): DependencyGraphEdgeInput => ({
  blocked: id(blocked),
  blocker: id(blocker),
});

function verdicts(result: ReturnType<typeof analyzeDependencyGraph>): Record<string, string> {
  return Object.fromEntries(result.verdicts.map((row) => [row.node.ref, row.verdict]));
}

function strandedRefs(result: ReturnType<typeof analyzeDependencyGraph>): string[] {
  return result.strandedClosure.map((identity) => identity.ref);
}

describe('dependency graph analysis', () => {
  it('keys the canonical (kind, ref) tuple without delimiter collisions', () => {
    expect(dependencyIdentityKey({ kind: 'a:b', ref: 'c' })).not.toBe(dependencyIdentityKey({ kind: 'a', ref: 'b:c' }));
  });

  it('keeps an ordinary AND-dependency DAG reachable', () => {
    const result = analyzeDependencyGraph({
      nodes: [node('A'), node('B'), node('C')],
      edges: [edge('B', 'A'), edge('C', 'A'), edge('C', 'B')],
    });

    expect(result.stronglyConnectedComponents).toEqual([]);
    expect(result.endpointDefects).toEqual([]);
    expect(result.impossibleRoots).toEqual([]);
    expect(verdicts(result)).toEqual({ A: 'reachable', B: 'reachable', C: 'reachable' });
    expect(result.stranded).toEqual([]);
  });

  it('returns an SCC, an exact closed cycle path, and the reverse-reachable stranded closure', () => {
    const result = analyzeDependencyGraph({
      nodes: [node('A'), node('B'), node('C'), node('D', { terminal: true }), node('E')],
      edges: [edge('A', 'B'), edge('B', 'A'), edge('C', 'B'), edge('D', 'C'), edge('E', 'D')],
    });

    expect(result.stronglyConnectedComponents).toHaveLength(1);
    expect(result.stronglyConnectedComponents[0]!.members.map((member) => member.ref)).toEqual(['A', 'B']);
    const cycle = result.stronglyConnectedComponents[0]!.cyclePath.map((member) => member.ref);
    expect(cycle[0]).toBe(cycle.at(-1));
    expect(new Set(cycle.slice(0, -1))).toEqual(new Set(['A', 'B']));

    // The cycle strands C, but the already-terminal D cuts propagation and therefore
    // satisfies E. This is the settlement contract, not fully-transitive blocking.
    expect(verdicts(result)).toEqual({
      A: 'impossible',
      B: 'impossible',
      C: 'impossible',
      D: 'reachable',
      E: 'reachable',
    });
    expect(strandedRefs(result)).toEqual(['A', 'B', 'C']);
    const cPath = result.stranded.find((row) => row.node.ref === 'C')!.paths[0]!.path.map((part) => part.ref);
    expect(cPath[0]).toBe('C');
    expect(cPath.slice(1)).toContain('B');
  });

  it('reports a structural cycle through a terminal node without calling the settled graph impossible', () => {
    const result = analyzeDependencyGraph({
      nodes: [node('A'), node('DONE', { terminal: true })],
      edges: [edge('A', 'DONE'), edge('DONE', 'A')],
    });

    expect(result.stronglyConnectedComponents).toHaveLength(1);
    expect(result.stronglyConnectedComponents[0]!.members.map((member) => member.ref)).toEqual(['A', 'DONE']);
    expect(result.impossibleRoots).toEqual([]);
    expect(verdicts(result)).toEqual({ A: 'reachable', DONE: 'reachable' });
    expect(result.strandedClosure).toEqual([]);
  });

  it('propagates unknown separately and gives impossible precedence without coercing unknown', () => {
    const result = analyzeDependencyGraph({
      nodes: [
        node('UNKNOWN', { rootVerdict: 'unknown' }),
        node('U-DEPENDANT'),
        node('IMPOSSIBLE', { rootVerdict: 'impossible' }),
        node('BOTH'),
        node('TERMINAL-CUT', { terminal: true }),
        node('AFTER-CUT'),
      ],
      edges: [
        edge('U-DEPENDANT', 'UNKNOWN'),
        edge('BOTH', 'UNKNOWN'),
        edge('BOTH', 'IMPOSSIBLE'),
        edge('TERMINAL-CUT', 'IMPOSSIBLE'),
        edge('AFTER-CUT', 'TERMINAL-CUT'),
      ],
    });

    expect(verdicts(result)).toEqual({
      'AFTER-CUT': 'reachable',
      BOTH: 'impossible',
      IMPOSSIBLE: 'impossible',
      'TERMINAL-CUT': 'reachable',
      UNKNOWN: 'unknown',
      'U-DEPENDANT': 'unknown',
    });
    expect(strandedRefs(result)).toEqual(['BOTH', 'IMPOSSIBLE']);
    expect(result.impossibleRoots.map((root) => root.code)).toEqual(['condition-impossible']);
  });

  it('reports a missing blocker and carries its exact path through dependants', () => {
    const missing = id('MISSING');
    const result = analyzeDependencyGraph({
      nodes: [node('A'), node('B')],
      edges: [
        { blocked: id('A'), blocker: missing },
        edge('B', 'A'),
        // A missing BLOCKED endpoint is still a hard defect, but there is no
        // existing node to add to the stranded closure.
        { blocked: id('GHOST'), blocker: id('A') },
      ],
    });

    expect(result.endpointDefects.map((defect) => [defect.edgeIndex, defect.role, defect.code])).toEqual([
      [0, 'blocker', 'missing'],
      [2, 'blocked', 'missing'],
    ]);
    expect(strandedRefs(result)).toEqual(['A', 'B']);
    const b = result.stranded.find((row) => row.node.ref === 'B')!;
    const missingPath = b.paths.find((path) => path.rootId === 'endpoint:0:blocker:missing')!;
    expect(missingPath.path.map((part) => part.ref)).toEqual(['B', 'A', 'MISSING']);
  });

  it('reports a kind/ref alias as mismatched instead of silently normalizing it', () => {
    const issue = node('WI-1', { aliases: [{ kind: 'feature', ref: 'papercusp#WI-1' }] }, 'issue');
    const result = analyzeDependencyGraph({
      nodes: [issue, node('B')],
      edges: [{ blocked: id('B'), blocker: { kind: 'feature', ref: 'papercusp#WI-1' } }],
    });

    expect(result.endpointDefects).toMatchObject([
      {
        code: 'mismatched',
        role: 'blocker',
        declared: { kind: 'feature', ref: 'papercusp#WI-1' },
        resolvedAs: { kind: 'issue', ref: 'WI-1' },
      },
    ]);
    expect(verdicts(result)).toEqual({ B: 'impossible', 'WI-1': 'reachable' });
    expect(strandedRefs(result)).toEqual(['B']);
  });

  it('detects an alias-loop after canonical resolution', () => {
    const canonical = id('WI-1', 'issue');
    const alias = id('papercusp#WI-1', 'feature');
    const result = analyzeDependencyGraph({
      nodes: [{ id: canonical, aliases: [alias] }],
      edges: [{ blocked: alias, blocker: canonical }],
    });

    expect(result.endpointDefects.map((defect) => defect.code)).toEqual(['mismatched']);
    expect(result.stronglyConnectedComponents).toHaveLength(1);
    expect(result.stronglyConnectedComponents[0]!.cyclePath).toEqual([canonical, canonical]);
    expect(verdicts(result)).toEqual({ 'WI-1': 'impossible' });
  });

  it('distinguishes an ambiguous alias from a missing endpoint', () => {
    const alias = id('legacy#X');
    const result = analyzeDependencyGraph({
      nodes: [node('A', { aliases: [alias] }), node('B', { aliases: [alias] }), node('C')],
      edges: [{ blocked: id('C'), blocker: alias }],
    });

    expect(result.endpointDefects[0]).toMatchObject({
      code: 'ambiguous',
      role: 'blocker',
      candidates: [id('A'), id('B')],
    });
    expect(result.impossibleRoots[0]!.code).toBe('endpoint-ambiguous');
    expect(strandedRefs(result)).toEqual(['C']);
  });

  it('classifies stored blocked-without-resolver as a bad root, but respects a live resolver', () => {
    const result = analyzeDependencyGraph({
      nodes: [
        node('STALE', { storedBlocked: true }),
        node('REGISTERED', { storedBlocked: true, hasRegisteredResolver: true }),
        node('ACTIVE-BLOCKER'),
        node('WAITING', { storedBlocked: true }),
      ],
      edges: [edge('WAITING', 'ACTIVE-BLOCKER')],
    });

    expect(result.impossibleRoots.map((root) => [root.code, root.anchors[0]?.ref])).toEqual([
      ['blocked-without-resolver', 'STALE'],
    ]);
    expect(verdicts(result)).toEqual({
      'ACTIVE-BLOCKER': 'reachable',
      REGISTERED: 'reachable',
      STALE: 'impossible',
      WAITING: 'reachable',
    });
  });

  it('is deterministic across node and edge input order', () => {
    const nodes = [node('A'), node('B'), node('C', { rootVerdict: 'impossible' })];
    const edges = [edge('A', 'B'), edge('B', 'A'), edge('C', 'A')];
    const forward = analyzeDependencyGraph({ nodes, edges });
    const reverse = analyzeDependencyGraph({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });

    expect(reverse).toEqual(forward);
  });

  // WI-6554700010008326: the readiness-drift census analyzes every work_items row
  // (~335K) against ~2.7K edges on the bg-host main thread. Tarjan visited and sorted
  // every row twice and three passes each re-sorted the whole node set, blocking the
  // event loop for 4-6s per tick. Every comparison in a whole-node sort reads two node
  // identities, so the identity-read count measures how many whole-node passes ran
  // without depending on wall-clock time. Measured on this input: ~9.4 reads per
  // N*log2(N) before the fix and ~1.95 after it (one sort plus linear passes).
  it('keeps whole-node passes to one sort on a large sparse graph', () => {
    const N = 5_000;
    const ref = (i: number) => `F-${String(i).padStart(6, '0')}`;
    let identityReads = 0;
    let seed = 7;
    const order = Array.from({ length: N }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const nodes: DependencyGraphNodeInput[] = order.map((i) => {
      const identity = id(ref(i));
      return {
        get id() {
          identityReads += 1;
          return identity;
        },
        terminal: i % 3 === 0,
      };
    });
    const edges = [
      edge(ref(1), ref(2)),
      edge(ref(2), ref(4)),
      edge(ref(4), ref(1)),
      edge(ref(5), ref(1)),
      edge(ref(7), ref(8)),
    ];

    const result = analyzeDependencyGraph({ nodes, edges });

    expect(result.stronglyConnectedComponents.map((component) => component.members.map((m) => m.ref))).toEqual([
      [ref(1), ref(2), ref(4)],
    ]);
    expect(strandedRefs(result)).toEqual([ref(1), ref(2), ref(4), ref(5)]);
    expect(result.verdicts).toHaveLength(N);
    expect(identityReads / (N * Math.log2(N))).toBeLessThan(4);
  });
});
