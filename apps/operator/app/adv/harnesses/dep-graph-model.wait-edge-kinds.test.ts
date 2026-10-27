/**
 * dep-graph-model.wait-edge-kinds.test.ts — the falsifier for SPEC-P-009@1 of
 * event-wait-settlement-2026-10-20.
 *
 * Clause: "The dependency-graph model gives a session wait and an item's own blocker
 * different edge kinds." Its probe method: build ONE item carrying both wait kinds and
 * compare their edge kinds. The neighbouring AUTO-BAR-R-15/R-17 cases each check one
 * kind on its own item, and they still pass if the model assigns both waits the same
 * kind. This case puts both waits on the same item and compares them directly.
 * (Finding from the grading audit of EI-27092112689847752.)
 */
import { describe, expect, it } from 'vitest';
import { buildDepSubgraph, eventNodeId, type DepGraphItem, type DepGraphWaitInput } from './dep-graph-model';

const item = (id: string): DepGraphItem => ({ id, kind: 'feature', title: `title ${id}`, state: 'open' });

const sessionWait = (itemId: string, eventKey: string): DepGraphWaitInput => ({
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
});

const blockerWait = (itemId: string, eventKey: string): DepGraphWaitInput => ({
  itemId,
  waitKind: 'item-blocker',
  eventKey,
  blockerKind: 'event',
  certification: 'proving',
});

describe('SPEC-P-009 — a session wait and an item\'s own blocker get different edge kinds', () => {
  it('SPEC-P-009: one item with both wait kinds draws two wait edges whose edge kinds differ', () => {
    const g = buildDepSubgraph({
      items: [item('WI-1')],
      edges: [],
      waits: [
        sessionWait('WI-1', 'work-item:done:WI-2'),
        blockerWait('WI-1', 'release:deployed:abc123def'),
      ],
    });

    const waitEdges = g.edges.filter((e) => e.wait && e.target === 'WI-1');
    expect(waitEdges).toHaveLength(2);

    const sessionEdge = waitEdges.find((e) => e.source === eventNodeId('work-item:done:WI-2'));
    const blockerEdge = waitEdges.find((e) => e.source === eventNodeId('release:deployed:abc123def'));
    expect(sessionEdge?.wait?.kind).toBe('session-awaits-event');
    expect(blockerEdge?.wait?.kind).toBe('item-waits-on-event');
    // The clause itself: the two kinds differ on the same item.
    expect(sessionEdge?.wait?.kind).not.toBe(blockerEdge?.wait?.kind);
  });

  it('SPEC-P-009: the edge kind follows the wait kind even when both waits name the same event key', () => {
    const g = buildDepSubgraph({
      items: [item('WI-1')],
      edges: [],
      waits: [
        sessionWait('WI-1', 'release:deployed:abc123def'),
        blockerWait('WI-1', 'release:deployed:abc123def'),
      ],
    });

    const kinds = g.edges
      .filter((e) => e.wait && e.target === 'WI-1')
      .map((e) => e.wait?.kind)
      .sort();
    expect(kinds).toEqual(['item-waits-on-event', 'session-awaits-event']);
  });
});
