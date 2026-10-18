/**
 * tree.test.ts — the fleet:tree HANDLER projection + completion gate (getSubtree/
 * assertCanComplete/isPossiblyWedged mocked; getOrgPg returns a throwaway sql the
 * handler only passes through). Pins the node projection (camel→snake mapping) and —
 * the load-bearing part — the CONDITIONAL fields: model/tier/brief/last_output_at and
 * possibly_wedged appear ONLY when present, and the can_complete / open_children gate is
 * surfaced verbatim. A regression that always-emits an absent field or drops the wedged
 * flag is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/tree.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws-1' })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../fleet/spawn-tree', async (original) => ({
  ...(await original<typeof import('../../fleet/spawn-tree')>()),
  getSubtree: vi.fn(),
  // Keep every export available to transitive imports in the shared Vitest
  // worker while isolating the one read this handler test controls.
  recordSpawnAccountRoute: vi.fn(async () => {}),
  spawnAccountRouteFromLaunch: vi.fn(() => null),
}));
vi.mock('../../fleet/nursery', () => ({ assertCanComplete: vi.fn() }));
vi.mock('../../fleet/spawn-reclaim', () => ({ isPossiblyWedged: vi.fn(() => false) }));

import { getSubtree } from '../../fleet/spawn-tree';
import { assertCanComplete } from '../../fleet/nursery';
import { isPossiblyWedged } from '../../fleet/spawn-reclaim';
const subtreeM = vi.mocked(getSubtree);
const gateM = vi.mocked(assertCanComplete);
const wedgedM = vi.mocked(isPossiblyWedged);
const tool = (await import('./tree')).default;

type Out = { content: { text: string }[] };
const call = (spawn_id = 'S-1') => tool.handler({ spawn_id } as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

const baseNode = {
  spawnId: 'S-2', parentSpawnId: 'S-1', depth: 1, childRole: 'worker',
  status: 'running', sessionOwner: 'bee-2', featureId: 'F-3', itemId: 'P-001', restartStrategy: 'none',
};

beforeEach(() => {
  vi.clearAllMocks();
  wedgedM.mockReturnValue(false);
  gateM.mockResolvedValue({ canComplete: true, openChildren: [] } as never);
});

describe('fleet:tree handler', () => {
  it('documents the spawn-root contract and routes named-fleet reads to assignments', () => {
    expect(tool.description).toMatch(/spawn-scoped, not fleet-scoped/i);
    expect(tool.description).toContain('`fleet` is not an accepted argument');
    expect(tool.description).toContain('fleet:assignments { fleet }');
    expect(tool.guidance?.notWhen).toMatch(/requires a nursery `spawn_id` root/i);
    expect(tool.args.shape.spawn_id.description).toMatch(/not a fleet slug/i);
  });

  it('projects nodes (camel→snake) and surfaces the completion gate', async () => {
    subtreeM.mockResolvedValue([baseNode] as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, root: 'S-1', can_complete: true, open_children: [] });
    expect(b.nodes[0]).toMatchObject({
      spawn_id: 'S-2', parent: 'S-1', depth: 1, role: 'worker', status: 'running',
      owner: 'bee-2', feature: 'F-3', plan_item: 'P-001', restart_strategy: 'none',
    });
  });

  it('omits optional fields (model/tier/brief/last_output_at) when absent', async () => {
    subtreeM.mockResolvedValue([baseNode] as never);
    const n = body(await call()).nodes[0];
    for (const k of ['model', 'tier', 'brief', 'last_output_at', 'possibly_wedged']) {
      expect(n).not.toHaveProperty(k);
    }
  });

  it('includes optional fields when present', async () => {
    subtreeM.mockResolvedValue([{ ...baseNode, modelSpec: 'opus', modelTier: 'high', brief: 'do X', lastOutputAt: 't9' }] as never);
    const n = body(await call()).nodes[0];
    expect(n).toMatchObject({ model: 'opus', tier: 'high', brief: 'do X', last_output_at: 't9' });
  });

  it('flags possibly_wedged when the reclaim heuristic says so', async () => {
    subtreeM.mockResolvedValue([baseNode] as never);
    wedgedM.mockReturnValue(true);
    expect(body(await call()).nodes[0]).toMatchObject({ possibly_wedged: true });
  });

  it('surfaces a blocked completion gate (open children)', async () => {
    subtreeM.mockResolvedValue([] as never);
    gateM.mockResolvedValue({ canComplete: false, openChildren: ['S-9'] } as never);
    expect(body(await call())).toMatchObject({ can_complete: false, open_children: ['S-9'] });
  });
});
