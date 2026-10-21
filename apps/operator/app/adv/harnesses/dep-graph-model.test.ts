/**
 * dep-graph-model.test.ts — the pure core of the dependency graph pane.
 *
 * Plan: dependency-health-pane-2026-08-02 (P-005 / P-007 / P-013).
 *
 * These are the assertions that decide what a user actually sees, so they are written against
 * BEHAVIOUR (which nodes survive, what is reported hidden) rather than against internals.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDepSubgraph,
  computeDepths,
  isBlockerSatisfied,
  DEP_GRAPH_NODE_BUDGET,
  eventNodeId,
  type DepGraphItem,
  type DepGraphEdgeInput,
  type DepGraphWaitInput,
} from './dep-graph-model';

const item = (id: string, over: Partial<DepGraphItem> = {}): DepGraphItem => ({
  id,
  kind: 'feature',
  title: `title ${id}`,
  state: 'open',
  ...over,
});

const edge = (blockedId: string, blockerId: string | null, over: Partial<DepGraphEdgeInput> = {}): DepGraphEdgeInput => ({
  blockedId,
  blockerId,
  blockerRef: blockerId ?? 'MISSING',
  blockerStatus: null,
  ...over,
});

describe('isBlockerSatisfied — terminality is PER FAMILY', () => {
  // The two vocabularies genuinely differ, and collapsing them is a mistake already made once
  // in this subsystem (D-019): `closed` is terminal for an issue and NOT for a feature.
  it.each([
    ['feature', 'passed', true],
    ['feature', 'deprecated', true],
    ['feature', 'done', true],
    ['feature', 'dropped', true],
    ['feature', 'closed', false],
    ['feature', 'resolved', false],
    ['bug', 'resolved', true],
    ['bug', 'closed', true],
    ['bug', 'done', true],
    ['bug', 'dropped', true],
    ['bug', 'passed', false],
    ['bug', 'deprecated', false],
  ])('%s blocker at %s → satisfied=%s', (kind, status, expected) => {
    expect(isBlockerSatisfied(kind, status)).toBe(expected);
  });

  it('treats a missing status as NOT satisfied — absence is not terminality', () => {
    expect(isBlockerSatisfied('feature', null)).toBe(false);
  });
});

describe('computeDepths', () => {
  it('measures the LONGEST chain, not the shortest', () => {
    // C is reachable from A directly (1 hop) and via B (2 hops). Depth must be 2 — the point
    // is "how buried is this", and the shortest path would under-report exactly the deep
    // chains this pane exists to surface.
    const depths = computeDepths(['A', 'B', 'C'], [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'A', target: 'C' },
    ]);
    expect(depths.get('A')).toBe(0);
    expect(depths.get('B')).toBe(1);
    expect(depths.get('C')).toBe(2);
  });

  it('handles the seven-deep chain that motivated the pane (EI-9108)', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `N${i}`);
    const edges = ids.slice(1).map((id, i) => ({ source: ids[i]!, target: id }));
    expect(computeDepths(ids, edges).get('N7')).toBe(7);
  });

  // The writer enforces acyclicity, but this renders whatever is in the DB — including rows
  // predating that guard. A cycle must not hang the render path.
  it('TERMINATES on a cycle instead of looping forever', () => {
    const depths = computeDepths(['A', 'B', 'C'], [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'C', target: 'A' },
    ]);
    expect(depths.size).toBe(3);
  });

  it('does not blow the stack on a very deep chain', () => {
    // Iterative by design — a recursive implementation dies here, and a corpus of thousands
    // can legitimately contain a long chain.
    const ids = Array.from({ length: 5000 }, (_, i) => `N${i}`);
    const edges = ids.slice(1).map((id, i) => ({ source: ids[i]!, target: id }));
    expect(() => computeDepths(ids, edges)).not.toThrow();
    expect(computeDepths(ids, edges).get('N4999')).toBe(4999);
  });
});

describe('buildDepSubgraph — default scoping keeps the picture meaningful', () => {
  it('shows only nodes that PARTICIPATE IN AN EDGE, not the whole corpus', () => {
    // This is the property that makes the pane usable against ~1.8k items: an isolated work
    // item has no dependency story, and including them all is what makes it a hairball.
    const items = [item('A'), item('B'), ...Array.from({ length: 500 }, (_, i) => item(`ISO-${i}`))];
    const g = buildDepSubgraph({ items, edges: [edge('B', 'A')] });

    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
    expect(g.truncated).toBe(false);
  });

  it('draws edges blocker → blocked (the direction work flows)', () => {
    const g = buildDepSubgraph({ items: [item('A'), item('B')], edges: [edge('B', 'A')] });
    expect(g.edges).toEqual([expect.objectContaining({ source: 'A', target: 'B' })]);
  });

  it('marks an edge SATISFIED when its blocker is terminal, but still renders it', () => {
    const g = buildDepSubgraph({
      items: [item('A', { state: 'done' }), item('B')],
      edges: [edge('B', 'A', { blockerStatus: 'done' })],
    });
    // Hiding it would erase the lineage that explains why B became free.
    expect(g.edges[0]).toMatchObject({ satisfied: true });
  });
});

describe('buildDepSubgraph — selection scopes to the connected component', () => {
  it('renders only the selected node lineage when a selection exists', () => {
    const items = [item('A'), item('B'), item('C'), item('X'), item('Y')];
    const edges = [edge('B', 'A'), edge('C', 'B'), edge('Y', 'X')]; // two components
    const g = buildDepSubgraph({ items, edges, selectedId: 'B' });

    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('follows the component in BOTH directions — ancestors AND descendants', () => {
    // A one-directional walk would show what blocks you but not what you block, which is half
    // the lineage and the half that answers "what does finishing this unblock?".
    const g = buildDepSubgraph({
      items: [item('A'), item('B'), item('C')],
      edges: [edge('B', 'A'), edge('C', 'B')],
      selectedId: 'B',
    });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('falls back to the default scope when the selection is not in the graph', () => {
    const g = buildDepSubgraph({
      items: [item('A'), item('B')],
      edges: [edge('B', 'A')],
      selectedId: 'NOT-HERE',
    });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });
});

describe('buildDepSubgraph — the budget bounds the render and REPORTS what it hid', () => {
  it('never exceeds the budget', () => {
    // A wide fan-in: one blocked item with `budget * 2` distinct blockers.
    const n = DEP_GRAPH_NODE_BUDGET * 2;
    const items = [item('TARGET'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
    const edges = Array.from({ length: n }, (_, i) => edge('TARGET', `B-${i}`));
    const g = buildDepSubgraph({ items, edges });

    expect(g.nodes.length).toBeLessThanOrEqual(DEP_GRAPH_NODE_BUDGET);
  });

  it('REPORTS the elision instead of silently dropping nodes', () => {
    // "Absence rendered as zero" is the failure this guards: a clipped graph must be
    // distinguishable from a genuinely sparse one.
    const n = DEP_GRAPH_NODE_BUDGET * 2;
    const items = [item('TARGET'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
    const edges = Array.from({ length: n }, (_, i) => edge('TARGET', `B-${i}`));
    const g = buildDepSubgraph({ items, edges });

    expect(g.truncated).toBe(true);
    expect(g.hiddenCount).toBe(g.totalInScope - g.nodes.length);
    expect(g.hiddenCount).toBeGreaterThan(0);
    // totalInScope is the honest denominator — the pre-budget size, not the rendered size.
    expect(g.totalInScope).toBe(n + 1);
  });

  it('keeps the DEEPEST nodes when it has to choose — depth is the signal', () => {
    // A long chain plus many shallow leaves, with a budget too small for both. The chain is
    // what a flat list cannot show, so it is what must survive.
    const chain = Array.from({ length: 10 }, (_, i) => item(`C-${i}`));
    const leaves = Array.from({ length: 50 }, (_, i) => item(`L-${i}`));
    const chainEdges = chain.slice(1).map((c, i) => edge(c.id, chain[i]!.id));
    const leafEdges = leaves.map((l) => edge(l.id, 'C-0'));
    const g = buildDepSubgraph({
      items: [...chain, ...leaves],
      edges: [...chainEdges, ...leafEdges],
      budget: 12,
    });

    const kept = new Set(g.nodes.map((n) => n.id));
    expect(kept.has('C-9')).toBe(true); // the deepest node survives
    expect(g.truncated).toBe(true);
  });

  it('drops edges whose endpoints were budgeted out, leaving no half-edges', () => {
    const n = DEP_GRAPH_NODE_BUDGET * 2;
    const items = [item('TARGET'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
    const edges = Array.from({ length: n }, (_, i) => edge('TARGET', `B-${i}`));
    const g = buildDepSubgraph({ items, edges });

    const ids = new Set(g.nodes.map((x) => x.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe('buildDepSubgraph — a dangling blocker is rendered as a BREAK, not dropped', () => {
  it('materialises a placeholder node carrying the unresolved ref', () => {
    // INV-13. An inner join here would make exactly the broken edges invisible in the pane
    // built to show broken edges.
    const g = buildDepSubgraph({
      items: [item('A')],
      edges: [edge('A', null, { blockerRef: 'EI-gone' })],
    });

    const placeholder = g.nodes.find((n) => n.dangling);
    expect(placeholder).toBeDefined();
    expect(placeholder!.title).toBe('EI-gone');
    expect(g.edges[0]).toMatchObject({ dangling: true });
  });

  it('does not treat a dangling blocker as satisfied', () => {
    // "Unresolvable" and "finished" are opposite findings; conflating them would render a
    // broken edge as a completed one.
    const g = buildDepSubgraph({ items: [item('A')], edges: [edge('A', null)] });
    expect(g.edges[0]!.satisfied).toBe(false);
  });
});

/**
 * WI-36045 — the regression class that made the pane render 2 nodes out of a real 122.
 *
 * `items` is `workItems.byHarness`, a 500-row `updated_ts DESC` WINDOW over a ~48k corpus,
 * while the edge query is HARNESS-WIDE. The original model required BOTH endpoints to appear
 * in `items`, so on live papercusp data only 1 of 79 edges survived.
 *
 * ⚠ The tests that used to live here ASSERTED THAT BEHAVIOUR — they are why the suite was
 * green while the pane was broken. They were not wrong to test the filter semantics; they
 * conflated two different reasons an id can be missing from `items`:
 *
 *     absent because the WINDOW ends    -> an accident of recency. The edge must survive.
 *     absent because the USER FILTERED  -> a deliberate choice. The edge should go.
 *
 * `filterActive` is what separates them, so every assertion below states which case it is in.
 * A test that omits `filterActive` is testing the UNFILTERED (window) case on purpose.
 */
describe('buildDepSubgraph — window vs filter: WHY an endpoint is missing decides the outcome', () => {
  // An edge that carries its endpoints, as the resolver now returns them.
  const hydratableEdge = (
    blockedId: string,
    blockerId: string,
    over: Partial<DepGraphEdgeInput> = {},
  ): DepGraphEdgeInput => ({
    ...edge(blockedId, blockerId),
    blockedTitle: `title ${blockedId}`,
    blockedStatus: 'open',
    blockedKind: 'feature',
    blockerTitle: `title ${blockerId}`,
    blockerKind: 'feature',
    ...over,
  });

  describe('NO filter active — `items` is just the list window, so nothing may be dropped', () => {
    it('HYDRATES a blocker outside the window instead of discarding its edge', () => {
      const g = buildDepSubgraph({
        items: [item('A')],
        edges: [hydratableEdge('A', 'OUT-OF-WINDOW')],
      });
      expect(g.edges).toHaveLength(1);
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'OUT-OF-WINDOW']);
      expect(g.nodes.find((n) => n.id === 'OUT-OF-WINDOW')?.title).toBe('title OUT-OF-WINDOW');
    });

    it('HYDRATES a BLOCKED side outside the window too — the failure was symmetric', () => {
      const g = buildDepSubgraph({
        items: [item('A')],
        edges: [hydratableEdge('OUT-OF-WINDOW', 'A')],
      });
      expect(g.edges).toHaveLength(1);
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'OUT-OF-WINDOW']);
    });

    it('draws a graph whose endpoints are ALL outside the window — the live papercusp shape', () => {
      // The actual measured case: 79 edges, and the 500-row window contained BOTH endpoints of
      // exactly one. Before the fix this produced 2 nodes; the corpus is entirely reachable now.
      const edges = Array.from({ length: 40 }, (_, i) => hydratableEdge(`B${i}`, `K${i}`));
      const g = buildDepSubgraph({ items: [], edges });
      expect(g.edges).toHaveLength(40);
      expect(g.nodes).toHaveLength(80);
      expect(g.filteredEdgeCount).toBe(0);
    });

    it('marks a hydrated node `hydrated`, and NEVER `dangling`', () => {
      // Conflating the two would report a healthy out-of-window row as a broken reference,
      // which is precisely the signal integrity mode exists to carry.
      const g = buildDepSubgraph({
        items: [item('A')],
        edges: [hydratableEdge('A', 'OUT-OF-WINDOW')],
      });
      const n = g.nodes.find((x) => x.id === 'OUT-OF-WINDOW');
      expect(n?.hydrated).toBe(true);
      expect(n?.dangling ?? false).toBe(false);
      expect(g.hydratedNodeCount).toBe(1);
    });

    it('prefers the `items` row over the edge-carried fields when BOTH exist', () => {
      // The list row is richer, and it is the corpus of record. The edge fields are a floor.
      const g = buildDepSubgraph({
        items: [item('A'), item('B', { title: 'the real row', planSlug: 'p' })],
        edges: [hydratableEdge('A', 'B', { blockerTitle: 'edge-carried fallback' })],
      });
      const b = g.nodes.find((n) => n.id === 'B');
      expect(b?.title).toBe('the real row');
      expect(b?.planSlug).toBe('p');
      expect(b?.hydrated ?? false).toBe(false);
      expect(g.hydratedNodeCount).toBe(0);
    });

    it('resolves terminality with the HYDRATED kind, so issue vocabulary still applies', () => {
      // `closed` is terminal for an issue and NOT for a feature (D-019). Reading kind only from
      // `items` silently defaulted every out-of-window blocker to the FEATURE list, mis-drawing
      // issue edges as live.
      const g = buildDepSubgraph({
        items: [item('A')],
        edges: [
          hydratableEdge('A', 'OUT-OF-WINDOW', { blockerKind: 'bug', blockerStatus: 'closed' }),
        ],
      });
      expect(g.edges[0]?.satisfied).toBe(true);
    });

    it('falls back to the id as a label when an old payload carries no endpoint fields', () => {
      // Forward-compat: a cached pre-fix payload must degrade to an identifiable node, not
      // vanish (which would be the original bug) and not render as a blank box.
      const g = buildDepSubgraph({ items: [item('A')], edges: [edge('A', 'OUT-OF-WINDOW')] });
      expect(g.edges).toHaveLength(1);
      expect(g.nodes.find((n) => n.id === 'OUT-OF-WINDOW')?.title).toBe('OUT-OF-WINDOW');
    });
  });

  describe('filter ACTIVE — `items` is the user\'s choice, so it genuinely scopes', () => {
    it('omits an edge with NEITHER endpoint in the filtered set, and COUNTS it', () => {
      const g = buildDepSubgraph({
        items: [item('A')],
        edges: [hydratableEdge('X', 'Y')],
        filterActive: true,
      });
      expect(g.edges).toEqual([]);
      expect(g.nodes).toEqual([]);
      // The counter is the point: a filter may narrow the graph, but never silently.
      expect(g.filteredEdgeCount).toBe(1);
    });

    it('KEEPS an edge when either endpoint survived the filter — a dependency view must show blockers', () => {
      // Filtering to "my plan's items" and being shown none of what blocks them would defeat
      // the pane. The blocker is hydrated as context; the edge stays.
      const g = buildDepSubgraph({
        items: [item('A')],
        edges: [hydratableEdge('A', 'OUT-OF-SCOPE')],
        filterActive: true,
      });
      expect(g.edges).toHaveLength(1);
      expect(g.nodes.find((n) => n.id === 'OUT-OF-SCOPE')?.hydrated).toBe(true);
      expect(g.filteredEdgeCount).toBe(0);
    });

    it('reports ZERO hidden edges when the filter excluded nothing', () => {
      const g = buildDepSubgraph({
        items: [item('A'), item('B')],
        edges: [hydratableEdge('A', 'B')],
        filterActive: true,
      });
      expect(g.filteredEdgeCount).toBe(0);
    });
  });

  /**
   * `filteredIds` — WI-36045's defect class, reached through the PLAN FILTER instead.
   * (This plan's D-001/D-002.)
   *
   * WI-36045 widened the graph's node corpus beyond the list's 500-row window by making
   * every edge carry its endpoints. The filter path never learned that: it tested the
   * drop rule against `items`, i.e. the window. So the pane drew from one corpus and
   * filtered by a smaller one, and the gap between them was not marginal.
   *
   * MEASURED LIVE on `papercusp`, 2026-08-09 (isolated shell, slug pinned, filter driven
   * through the `wif` URL param):
   *   • 129 nodes / 84 edges unfiltered, spanning 12 plans — but only 14 nodes and 5
   *     plans inside the window, so 9 of 12 plans were not even OFFERED as filter values.
   *   • filtering to `agent-context-firewall-and-output-spill-2026-08-02` (11 nodes,
   *     8 edges genuinely present) rendered `0 nodes · 0 edges`, `84 edges hidden by
   *     filters`, and the empty state "No work items match the active filters".
   *   • exactly ONE plan filtered correctly: the most recently touched one, wholly inside
   *     the window. That is the shape that let this survive testing — you check the plan
   *     you just worked on, and it works.
   */
  describe('filteredIds — the filter must judge the GRAPH\'s corpus, not the list\'s window', () => {
    /** The live shape: a plan whose items are ALL outside the list's window. */
    const outOfWindowPlanEdges = [
      hydratableEdge('P1', 'P2', {
        blockedPlanSlug: 'my-plan',
        blockerPlanSlug: 'my-plan',
      }),
      hydratableEdge('P3', 'OTHER', { blockedPlanSlug: 'my-plan' }),
    ];

    it('draws the plan\'s subgraph when NONE of its items are in the list window', () => {
      const g = buildDepSubgraph({
        // `items` is the window narrowed by the filter — EMPTY, because not one of this
        // plan's rows was recent enough to be in the 500-row page.
        items: [],
        edges: outOfWindowPlanEdges,
        filterActive: true,
        // …but the caller filtered over the WHOLE corpus and states what survived.
        filteredIds: new Set(['P1', 'P2', 'P3']),
      });
      expect(g.edges).toHaveLength(2);
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['OTHER', 'P1', 'P2', 'P3']);
      expect(g.filteredEdgeCount).toBe(0);
      // Every node here came from an edge payload, and the pane says so on screen. The
      // fix must not buy correctness by disabling that disclosure.
      expect(g.hydratedNodeCount).toBe(4);
    });

    it('still DROPS an edge that genuinely fell outside the filter, and counts it', () => {
      // The complement, and the reason this is not just "keep everything": `filteredIds`
      // must scope as hard as `byId` did — only over the right corpus.
      const g = buildDepSubgraph({
        items: [],
        edges: [...outOfWindowPlanEdges, hydratableEdge('UNRELATED-A', 'UNRELATED-B')],
        filterActive: true,
        filteredIds: new Set(['P1', 'P2', 'P3']),
      });
      expect(g.edges).toHaveLength(2);
      expect(g.filteredEdgeCount).toBe(1);
      expect(g.nodes.map((n) => n.id)).not.toContain('UNRELATED-A');
    });

    it('keeps an edge with ONE endpoint in the filtered set — "this plan and what gates it"', () => {
      const g = buildDepSubgraph({
        items: [],
        edges: [hydratableEdge('P3', 'BLOCKER-ELSEWHERE')],
        filterActive: true,
        filteredIds: new Set(['P3']),
      });
      expect(g.edges).toHaveLength(1);
      expect(g.nodes.map((n) => n.id).sort()).toEqual(['BLOCKER-ELSEWHERE', 'P3']);
    });

    it('returns an EMPTY graph — never throws — when the filter matches nothing', () => {
      // The unmatched-value case, reached live by a hand-typed or agent-written
      // `?wif=plan:<slug-that-does-not-exist>`. nuqs params are a first-class input
      // surface here (`ui:dispatch` writes the URL), so "nobody would type that" is not
      // a defence — an agent will.
      //
      // The REQUIRED behaviour is an empty graph, because that is what lets the panel
      // render its "No work items match the active filters" branch. A throw here would
      // surface as a pane that silently fails to mount, which is indistinguishable from
      // "this plan has no dependencies" — the exact absence-rendered-as-zero confusion
      // this model exists to prevent.
      const g = buildDepSubgraph({
        items: [],
        edges: outOfWindowPlanEdges,
        filterActive: true,
        filteredIds: new Set<string>(),
      });
      expect(g.nodes).toEqual([]);
      expect(g.edges).toEqual([]);
      // Every edge is ACCOUNTED FOR rather than merely gone: the count is what the pane
      // renders as "N edges hidden by filters", so an empty graph still explains itself.
      expect(g.filteredEdgeCount).toBe(2);
    });

    it('falls back to `items` membership when the caller supplies no filteredIds', () => {
      // The documented fallback: pre-fix behaviour, so an un-migrated caller type-checks
      // AND behaves predictably. It is not safe — it is merely unchanged.
      const g = buildDepSubgraph({
        items: [],
        edges: outOfWindowPlanEdges,
        filterActive: true,
      });
      expect(g.edges).toEqual([]);
      expect(g.filteredEdgeCount).toBe(2);
    });

    it('ignores filteredIds when no filter is active — the window is not a filter', () => {
      // `filteredIds` must never become a second, silent scoping axis: with no filter
      // active every edge is drawn regardless of what the set happens to contain.
      const g = buildDepSubgraph({
        items: [],
        edges: outOfWindowPlanEdges,
        filterActive: false,
        filteredIds: new Set(['P1']),
      });
      expect(g.edges).toHaveLength(2);
      expect(g.filteredEdgeCount).toBe(0);
    });

    /**
     * FALSIFIABILITY CONTROL (CLAUDE.md § "Proving a guard is falsifiable", tier 1 —
     * a deliberately-wrong reimplementation kept permanently in the test file, so no
     * production file is ever mutated to prove the guard bites).
     *
     * The tests above pass. That alone is not evidence they would have CAUGHT the
     * defect, because the pre-fix code also passed every test it had. This states the
     * OLD predicate explicitly and asserts the two rules disagree on the live-measured
     * shape — and pairs it with a calibration assertion, without which "they differ"
     * could be satisfied by both being broken.
     */
    it('CONTROL: the old `items`-membership predicate empties this exact graph', () => {
      const oldPredicateDropped = outOfWindowPlanEdges.filter(
        // Verbatim shape of the pre-D-002 rule: endpoints tested against `items`, which
        // for this fixture is empty.
        (e) => ![].some((i) => i === e.blockedId) && ![].some((i) => i === e.blockerId),
      );
      expect(oldPredicateDropped).toHaveLength(2); // old rule: drops BOTH → empty pane

      // CALIBRATION — the real subject, same input, must draw them. If this ever fails,
      // the control above is passing for the wrong reason and proves nothing.
      const g = buildDepSubgraph({
        items: [],
        edges: outOfWindowPlanEdges,
        filterActive: true,
        filteredIds: new Set(['P1', 'P2', 'P3']),
      });
      expect(g.edges).toHaveLength(2);
    });
  });

  /**
   * PERMANENT FALSIFIABILITY CONTROL (CLAUDE.md § "Proving a guard is falsifiable", tier 1).
   *
   * The tests above are the ones that were MISSING when the pane shipped broken, so "they pass
   * now" is not by itself evidence they would have caught it. This control pins that claim in
   * the suite instead of in a one-off probe: it states the OLD predicate explicitly and asserts
   * the two implementations DISAGREE on the live-measured shape.
   *
   * Measured out-of-tree first (scripts/mutation-probe.sh, copy-out, 2026-08-08): reverting the
   * real model to the old predicate yields `0 edges, 0 nodes` for this fixture. This control
   * reproduces that verdict permanently, so a future refactor that quietly reinstates
   * endpoint-must-be-in-`items` fails here rather than in the owner's window.
   *
   * ⚠ It is a REIMPLEMENTATION, so it can only ever prove the two rules differ — the CALIBRATION
   * assertion below (that the real subject draws the edge) is what makes that meaningful. Both
   * halves are required; a control alone would also "pass" if the property itself were broken.
   */
  it('DISAGREES with the old endpoint-must-be-in-items rule (the shipped bug), by construction', () => {
    const items = [item('A')];
    const edges = [hydratableEdge('A', 'OUT-OF-WINDOW')];

    // The old rule, verbatim in effect: an edge survived only if BOTH endpoints were in `items`.
    const byId = new Set(items.map((i) => i.id));
    const oldRuleEdges = edges.filter(
      (e) => byId.has(e.blockedId) && e.blockerId !== null && byId.has(e.blockerId),
    );

    // CONTROL: the old rule drops it — this is the 2-node defect, in one line.
    expect(oldRuleEdges).toHaveLength(0);
    // CALIBRATION: the real subject keeps it. If this ever matches the control, the fix is gone.
    expect(buildDepSubgraph({ items, edges }).edges).toHaveLength(1);
  });

  it('keeps a DANGLING blocker, and does not confuse it with either other case', () => {
    // Three reasons an id is absent from `items`, three different outcomes. A dangling ref is
    // a DEFECT (INV-13) and survives regardless of filter state; the resolver distinguishes it
    // by `blockerId: null` and the model must not re-conflate them.
    const broken = buildDepSubgraph({
      items: [item('A')],
      edges: [edge('A', null, { blockerRef: 'EI-gone' })],
    });
    const brokenFiltered = buildDepSubgraph({
      items: [item('A')],
      edges: [edge('A', null, { blockerRef: 'EI-gone' })],
      filterActive: true,
    });

    expect(broken.edges).toHaveLength(1);
    expect(broken.nodes.find((n) => n.dangling)?.title).toBe('EI-gone');
    // Still a finding under an active filter: its BLOCKED side passed the filter.
    expect(brokenFiltered.edges).toHaveLength(1);
  });

  // dependency-health-pane-2026-08-02 P-008 — the integrity view as a FILTER MODE.
  describe('integrity mode (P-008)', () => {
    it('keeps ONLY dangling and satisfied edges, dropping healthy ones', () => {
      const items = [item('A'), item('B'), item('C'), item('D')];
      const g = buildDepSubgraph({
        items,
        edges: [
          edge('B', 'A'), // healthy: live blocker, unresolved work — gates something
          edge('C', null, { blockerRef: 'EI-gone' }), // dangling
          // Satisfied is read from the EDGE's blockerStatus against the BLOCKER's family
          // vocabulary (isBlockerSatisfied) — NOT from the blocker item's own `state`.
          // D is kind 'feature', so 'passed' is its terminal form, not 'done' (D-019).
          edge('C', 'D', { blockerStatus: 'passed' }),
        ],
        healthOnly: true,
      });
      expect(g.edges).toHaveLength(2);
      expect(g.edges.every((e) => e.dangling || e.satisfied)).toBe(true);
      // The healthy edge's exclusive endpoint drops out with it.
      expect(g.nodes.map((n) => n.id)).not.toContain('B');
    });

    it('is OFF by default — the pane is a graph view first, a diagnostic second', () => {
      const g = buildDepSubgraph({ items: [item('A'), item('B')], edges: [edge('B', 'A')] });
      expect(g.edges).toHaveLength(1);
    });

    it('narrows what the BUDGET measures, so the mode can rescue an over-budget graph', () => {
      // The ordering matters: filter-then-budget means asking the narrower question makes a
      // too-large corpus drawable. Budget-then-filter would elide findings to make room for
      // healthy nodes — backwards for a health view, and silently so.
      const n = DEP_GRAPH_NODE_BUDGET + 40;
      const items = [item('HUB'), ...Array.from({ length: n }, (_, i) => item(`B-${i}`))];
      const edges = Array.from({ length: n }, (_, i) => edge('HUB', `B-${i}`));
      // One genuinely broken edge hiding in a corpus far past the budget.
      edges.push(edge('HUB', null, { blockerRef: 'EI-gone' }));

      const all = buildDepSubgraph({ items, edges });
      const healthy = buildDepSubgraph({ items, edges, healthOnly: true });

      expect(all.truncated).toBe(true);
      expect(healthy.truncated).toBe(false);
      expect(healthy.edges).toHaveLength(1);
      expect(healthy.edges[0]?.dangling).toBe(true);
    });

    it('reports a clean graph as EMPTY rather than inventing a finding', () => {
      const g = buildDepSubgraph({
        items: [item('A'), item('B')],
        edges: [edge('B', 'A')],
        healthOnly: true,
      });
      expect(g.edges).toEqual([]);
      expect(g.nodes).toEqual([]);
    });
  });

  describe('integrity mode (P-014)', () => {
    it('surfaces a cycle with the shared hard-block contract', () => {
      const g = buildDepSubgraph({ items: [item('A'), item('B'), item('C')], edges: [edge('B', 'A'), edge('C', 'B'), edge('A', 'C')], healthOnly: true });
      expect(g.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'cycle', classification: 'hard-block', confidence: 'deterministic' })]));
      expect(g.edges).toHaveLength(3);
    });

    it('reports phase inversion, promotion drift, and transitive redundancy as advisories only', () => {
      const g = buildDepSubgraph({
        items: [item('A'), item('B'), item('C')],
        edges: [edge('B', 'A'), edge('C', 'B'), edge('C', 'A', { blockedPlanSlug: 'p', blockerPlanSlug: 'p', blockedPlanItemId: 'P-003', blockerPlanItemId: 'P-001', blockedPlanBlockedBy: ['P-002'], blockedPhase: 'Phase 1', blockerPhase: 'Phase 3' })],
      });
      expect(g.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['phase-inversion', 'promoted-graph-extra-edge', 'transitive-redundancy']));
      expect(g.findings.filter((f) => f.code !== 'cycle').every((f) => f.classification === 'advisory')).toBe(true);
    });

    it('keeps a healthy diamond silent', () => {
      const g = buildDepSubgraph({ items: ['A', 'B', 'C', 'D'].map((id) => item(id)), edges: [edge('B', 'A'), edge('C', 'A'), edge('D', 'B'), edge('D', 'C')] });
      expect(g.findings).toEqual([]);
    });

    it('keeps an intentional serial chain silent', () => {
      const g = buildDepSubgraph({ items: ['A', 'B', 'C'].map((id) => item(id)), edges: [edge('B', 'A'), edge('C', 'B')] });
      expect(g.findings).toEqual([]);
    });
  });

  // dependency-health-pane-2026-08-02 P-012 (D-003 req 2: "all the plan and work items").
  //
  // Plan items are NOT a second node kind here — a plan item IS a work_items row
  // (plans:start mints one per item; the owner's 2026-07-27 identity decision reused the
  // work-item id rather than giving plan items their own id space). So the graph already
  // contains them, and P-012 reduces to carrying their PROVENANCE through to the renderer.
  // These pin that the carry actually happens, since a dropped field would look identical
  // to "this harness has no plan-derived items" — silent, and wrong in the quiet direction.
  describe('plan provenance (P-012)', () => {
    it('carries planSlug through onto the built nodes', () => {
      const g = buildDepSubgraph({
        items: [item('A', { planSlug: 'my-plan' }), item('B')],
        edges: [edge('B', 'A')],
      });
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      expect(byId.get('A')?.planSlug).toBe('my-plan');
      // Absent provenance must stay falsy, never become the string "null"/"undefined" —
      // the renderer branches on truthiness to decide whether to draw the marker.
      expect(byId.get('B')?.planSlug ?? null).toBeNull();
    });

    it('does not invent provenance for a DANGLING placeholder node', () => {
      // A dangling node is synthesised from an unresolved ref, so it has no row and
      // therefore no plan. Marking it as plan-derived would assert provenance the system
      // does not have — the exact over-claim the dangling class exists to avoid.
      const g = buildDepSubgraph({
        items: [item('A', { planSlug: 'my-plan' })],
        edges: [edge('A', null, { blockerRef: 'EI-gone' })],
      });
      const ghost = g.nodes.find((n) => n.dangling);
      expect(ghost).toBeDefined();
      expect(ghost?.planSlug ?? null).toBeNull();
    });
  });
});

// event-wait-settlement-2026-10-20 P-009 (D-003, owner directive #2038): event waits on items
// appear in the graph as EVENT nodes. The rows mirror `workItems.depWaits`
// (resolveDependencyGraphWaits).
describe('buildDepSubgraph — event waits (P-009)', () => {
  const sessionWait = (itemId: string, eventKey: string, over: Partial<DepGraphWaitInput> = {}): DepGraphWaitInput => ({
    itemId,
    waitKind: 'session-await',
    eventKey,
    bound: true,
    subscriberId: 'su-holder',
    subscriberIsHolder: true,
    certification: 'proving',
    subscriberState: 'live',
    stale: false,
    staleReason: null,
    ...over,
  });
  const blockerWait = (itemId: string, eventKey: string, over: Partial<DepGraphWaitInput> = {}): DepGraphWaitInput => ({
    itemId,
    waitKind: 'item-blocker',
    eventKey,
    blockerKind: 'event',
    certification: 'proving',
    ...over,
  });
  const waitEdgesInto = (g: ReturnType<typeof buildDepSubgraph>, itemId: string) =>
    g.edges.filter((e) => e.wait && e.target === itemId);

  it('AUTO-BAR-R-15-P-009: draws the holder-bound session await on an item as an event node with a session-awaits-event edge', () => {
    const g = buildDepSubgraph({
      items: [item('WI-1')],
      edges: [],
      waits: [sessionWait('WI-1', 'work-item:done:WI-2')],
    });

    const node = g.nodes.find((n) => n.id === eventNodeId('work-item:done:WI-2'));
    expect(node).toMatchObject({ kind: 'event', state: 'waiting', event: { key: 'work-item:done:WI-2', stale: false, waitCount: 1 } });
    expect(waitEdgesInto(g, 'WI-1')).toEqual([
      expect.objectContaining({
        source: eventNodeId('work-item:done:WI-2'),
        target: 'WI-1',
        wait: expect.objectContaining({ kind: 'session-awaits-event', subscriberId: 'su-holder', subscriberIsHolder: true, bound: true }),
      }),
    ]);
    expect(g.waitCount).toBe(1);
    // An item whose only dependency story is a wait is still in the picture.
    expect(g.nodes.map((n) => n.id)).toContain('WI-1');
  });

  it('AUTO-BAR-R-16-P-009: marks a session wait stale when its subscriber session has ended, and the event node stale only when every wait on it is', () => {
    const g = buildDepSubgraph({
      items: [item('WI-1'), item('WI-3')],
      edges: [],
      waits: [
        sessionWait('WI-1', 'claim:released:WI-1', { subscriberId: 'su-dead', subscriberIsHolder: false, subscriberState: 'ended', stale: true, staleReason: 'subscriber-ended' }),
        sessionWait('WI-3', 'release:green:papercusp', { subscriberId: 'su-dead', subscriberState: 'ended', stale: true, staleReason: 'subscriber-ended' }),
        sessionWait('WI-3', 'release:green:papercusp', { subscriberId: 'su-live', subscriberState: 'live' }),
      ],
    });

    const dead = waitEdgesInto(g, 'WI-1');
    expect(dead).toHaveLength(1);
    expect(dead[0]!.wait).toMatchObject({ stale: true, staleReason: 'subscriber-ended', subscriberState: 'ended' });
    expect(g.nodes.find((n) => n.id === eventNodeId('claim:released:WI-1'))).toMatchObject({ state: 'stale', event: { stale: true } });
    // A key a LIVE agent still waits on is not dead, even though a dead agent waits on it too.
    expect(g.nodes.find((n) => n.id === eventNodeId('release:green:papercusp'))).toMatchObject({ state: 'waiting', event: { stale: false, waitCount: 2 } });
    expect(g.staleWaitCount).toBe(2);
    // Health mode keeps only the stale waits.
    const health = buildDepSubgraph({ items: [item('WI-1'), item('WI-3')], edges: [], waits: [
      sessionWait('WI-1', 'claim:released:WI-1', { stale: true, staleReason: 'subscriber-ended' }),
      sessionWait('WI-3', 'release:green:papercusp'),
    ], healthOnly: true });
    expect(health.edges.map((e) => e.target)).toEqual(['WI-1']);
  });

  it('AUTO-BAR-R-17-P-009: draws an item\'s own active event and gate blockers as event nodes with item-waits-on-event edges', () => {
    const g = buildDepSubgraph({
      items: [item('WI-1')],
      edges: [],
      waits: [
        blockerWait('WI-1', 'release:deployed:abc123def'),
        blockerWait('WI-1', 'fleet:alpha:schema-ready', { blockerKind: 'gate', certification: 'proving' }),
      ],
    });

    const edges = waitEdgesInto(g, 'WI-1');
    expect(edges.map((e) => e.source).sort()).toEqual([
      eventNodeId('fleet:alpha:schema-ready'),
      eventNodeId('release:deployed:abc123def'),
    ]);
    for (const e of edges) expect(e.wait).toMatchObject({ kind: 'item-waits-on-event', subscriberId: null });
    expect(edges.find((e) => e.source === eventNodeId('fleet:alpha:schema-ready'))?.wait?.blockerKind).toBe('gate');
    expect(g.nodes.filter((n) => n.kind === 'event')).toHaveLength(2);
  });

  it('SPEC-P-009: keeps waits out of depth and integrity findings, hydrates an out-of-window item, and honours filters', () => {
    const g = buildDepSubgraph({
      items: [item('A'), item('B')],
      edges: [edge('A', 'B')],
      waits: [
        sessionWait('A', 'work-item:done:B'),
        // An item outside the list's window: drawn from the wait row's fields, not dropped.
        blockerWait('OUT', 'release:deployed:abc', { itemTitle: 'outside the window', itemKind: 'bug', itemStatus: 'blocked' }),
      ],
    });
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    // Depth is the `blocks` chain only: the event node above A does not deepen it.
    expect(byId.get('A')?.depth).toBe(1);
    expect(byId.get('B')?.depth).toBe(0);
    expect(byId.get(eventNodeId('work-item:done:B'))?.depth).toBe(0);
    // OUT's only incoming edge is a wait. A has a `blocks` edge too, so it cannot tell a
    // depth pass that counts waits from one that does not; OUT can (it would read 1).
    expect(byId.get('OUT')?.depth).toBe(0);
    expect(byId.get('OUT')).toMatchObject({ title: 'outside the window', kind: 'bug', state: 'blocked', hydrated: true });
    expect(g.findings.flatMap((f) => f.nodes)).not.toContain(eventNodeId('work-item:done:B'));

    // A filter that drops the item drops its waits — counted, never silent.
    const filtered = buildDepSubgraph({
      items: [item('A'), item('B')],
      edges: [edge('A', 'B')],
      waits: [sessionWait('A', 'k:1'), blockerWait('OUT', 'k:2')],
      filterActive: true,
      filteredIds: new Set(['A', 'B']),
    });
    expect(filtered.nodes.map((n) => n.id)).not.toContain('OUT');
    expect(filtered.filteredEdgeCount).toBe(1);
    // A truncated resolver leg is reported.
    expect(buildDepSubgraph({ items: [], edges: [], waits: [blockerWait('X', 'k', { legTruncated: true })] }).waitsTruncated).toBe(true);
    // Selecting the event node scopes to the items waiting on it.
    const sel = buildDepSubgraph({ items: [item('A'), item('B'), item('C')], edges: [edge('A', 'B')], waits: [sessionWait('C', 'k:9')], selectedId: eventNodeId('k:9') });
    expect(sel.nodes.map((n) => n.id).sort()).toEqual(['C', eventNodeId('k:9')].sort());
  });
});
