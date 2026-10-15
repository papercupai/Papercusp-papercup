// @vitest-environment jsdom
//
// MapView (brainstorm mindmap) — the legacy-format migration + repair logic is
// the load-bearing part (it un-corrupts brainstorms written by the old
// side-effect-in-updater bug and lifts mind-elixir / reaflow shapes into the
// native React Flow shape). Those pure functions are exported and tested here;
// the ReactFlow canvas render itself is e2e territory.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
let syncResult: { data: unknown[] | undefined; loading: boolean; error: Error | null };
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => syncResult }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: () => null,
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
import {
  MapView,
  normalize,
  meToTree,
  repairTree,
  isReactFlowTree,
  isReaflowTree,
  kindAccent,
  seedTree,
} from './MapView';

beforeEach(() => { syncResult = { data: [{ phase: 'staging', mindmap: null }], loading: false, error: null }; vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('MapView save responses', () => {
  it('waits for the initial Sync response before saving a hydrated map', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    syncResult = { data: [], loading: true, error: null };
    const view = render(<MapView slug="h" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText(/loading mindmap/i)).toBeTruthy();
    const tree = { nodes: [{ id: 'root', position: { x: 10, y: 20 }, data: { text: 'saved private map', kind: 'idea' } }], edges: [] };
    syncResult = { data: [{ phase: 'staging', mindmap: tree }], loading: false, error: null };
    view.rerender(<MapView slug="h" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.tree.nodes[0].data.text).toBe('saved private map');
  });

  it('does not replace unavailable data with a writable seed after a failed read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}')));
    syncResult = { data: [], loading: false, error: new Error('private read denied') };
    render(<MapView slug="h" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([403, 500])('reports a resolved HTTP %i save rejection', async status => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private save denied', { status })));
    render(<MapView slug="h" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetch).toHaveBeenCalledWith('/api/harness/h/brainstorm-mindmap', expect.objectContaining({ method: 'PUT' }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('private save denied'));
  });

  it('accepts a successful mindmap save without a failure alert', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    render(<MapView slug="h" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('isReactFlowTree', () => {
  it('accepts a native tree whose nodes carry numeric positions', () => {
    expect(
      isReactFlowTree({
        nodes: [{ id: 'n1', position: { x: 0, y: 0 } }],
        edges: [],
      }),
    ).toBe(true);
  });
  it('rejects nodes missing a numeric position', () => {
    expect(isReactFlowTree({ nodes: [{ id: 'n1' }], edges: [] })).toBe(false);
  });
  it('rejects non-objects and shapes without node/edge arrays', () => {
    expect(isReactFlowTree(null)).toBe(false);
    expect(isReactFlowTree({ nodes: 'x', edges: [] })).toBe(false);
  });
});

describe('isReaflowTree', () => {
  it('accepts a flat reaflow shape (nodes with string ids, optional text)', () => {
    expect(
      isReaflowTree({
        nodes: [{ id: 'n1', text: 'hi' }, { id: 'n2' }],
        edges: [{ from: 'n1', to: 'n2' }],
      }),
    ).toBe(true);
  });
  it('rejects when a node has a non-string text', () => {
    expect(isReaflowTree({ nodes: [{ id: 'n1', text: 5 }], edges: [] })).toBe(false);
  });
});

describe('meToTree', () => {
  it('flattens a mind-elixir nested tree into nodes + parent→child edges', () => {
    const legacy = {
      nodeData: {
        id: 'root',
        topic: 'Root',
        children: [
          { id: 'c1', topic: 'Child 1' },
          { id: 'c2', topic: 'Child 2', children: [{ id: 'g1', topic: 'Grandchild' }] },
        ],
      },
    };
    const { nodes, edges } = meToTree(legacy);
    expect(nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2', 'g1', 'root']);
    expect(nodes.find((n) => n.id === 'root')!.text).toBe('Root');
    // Edges connect parent → child.
    expect(edges).toContainEqual({ id: 'root__c1', source: 'root', target: 'c1' });
    expect(edges).toContainEqual({ id: 'c2__g1', source: 'c2', target: 'g1' });
  });

  it('returns empty arrays for a malformed root', () => {
    expect(meToTree({} as never)).toEqual({ nodes: [], edges: [] });
  });
});

describe('repairTree', () => {
  it('drops edges pointing at non-existent nodes', () => {
    const repaired = repairTree({
      nodes: [
        { id: 'a', type: 'mind', position: { x: 0, y: 0 }, data: { text: '', kind: 'idea' } },
        { id: 'b', type: 'mind', position: { x: 0, y: 0 }, data: { text: '', kind: 'idea' } },
      ],
      edges: [
        { id: 'a__b', source: 'a', target: 'b' },
        { id: 'a__ghost', source: 'a', target: 'ghost' }, // orphan
      ],
    });
    expect(repaired.edges.map((e) => e.id)).toEqual(['a__b']);
    // Nodes are preserved.
    expect(repaired.nodes).toHaveLength(2);
  });
});

describe('kindAccent', () => {
  it('maps each node kind to a distinct accent color', () => {
    const colors = new Set([
      kindAccent('idea'),
      kindAccent('question'),
      kindAccent('decision'),
      kindAccent('blocker'),
    ]);
    expect(colors.size).toBe(4);
  });
});

describe('seedTree', () => {
  it('returns a single positioned root node with no edges', () => {
    const seed = seedTree();
    expect(seed.nodes).toHaveLength(1);
    expect(seed.edges).toHaveLength(0);
    expect(seed.nodes[0].id).toBe('root');
    expect(typeof seed.nodes[0].position.x).toBe('number');
  });
});

describe('normalize', () => {
  it('seeds a fresh tree from null/undefined input', () => {
    expect(normalize(null).nodes).toHaveLength(1);
    expect(normalize(undefined).nodes[0].id).toBe('root');
  });

  it('passes through a native React Flow tree (typed + repaired)', () => {
    const out = normalize({
      nodes: [
        { id: 'n1', position: { x: 5, y: 10 }, data: { text: 'hello' } },
      ],
      edges: [{ id: 'e_orphan', source: 'n1', target: 'missing' }],
    });
    // Position preserved, type stamped, default kind filled in.
    const n1 = out.nodes.find((n) => n.id === 'n1')!;
    expect(n1.position).toEqual({ x: 5, y: 10 });
    expect(n1.type).toBe('mind');
    expect((n1.data as { kind: string }).kind).toBe('idea');
    expect((n1.data as { text: string }).text).toBe('hello');
    // The orphan edge is repaired away.
    expect(out.edges).toHaveLength(0);
  });

  it('lifts a reaflow flat shape and dagre-arranges (positions become finite)', () => {
    const out = normalize({
      nodes: [{ id: 'n1', text: 'A' }, { id: 'n2', text: 'B' }],
      edges: [{ from: 'n1', to: 'n2' }],
    });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    // dagre assigns real coordinates (not all left at 0,0).
    expect(out.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
    expect(out.edges).toHaveLength(1);
  });

  it('lifts a mind-elixir nested shape via meToTree', () => {
    const out = normalize({ nodeData: { id: 'root', topic: 'R', children: [{ id: 'c1', topic: 'C' }] } });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['c1', 'root']);
    expect(out.edges).toHaveLength(1);
  });

  it('seeds when a mind-elixir shape has no usable nodes', () => {
    expect(normalize({ nodeData: {} }).nodes[0].id).toBe('root');
  });
});
