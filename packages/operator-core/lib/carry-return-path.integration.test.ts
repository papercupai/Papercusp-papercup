/** P-009: checkpoint -> change sources -> actual wake/recovery delivery seams.
 * Storage and read-only tool transport are fixtures; probing, reference stamping,
 * diffing, and prompt composition run through production code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCarryNote, type CheckEntry } from './carry-note';
import { carriedProbeBlockForDelivery, carriedProbeSources } from './carry-probe-eval';
import { carryRefChangesForRecovery, carryRefChangesForWake } from './carry-ref-delivery';
import { stampCarryRefs, type CarryRefResolver } from './carry-ref-stamps';
import { continuityProbeRevision } from './continuity-probes';
import { rehydrateLoopWakeText } from './events/await/wake-executor';
import type { DeliveryWork } from './events/await/types';
import { buildAutomaticCompactionRecovery } from './agent-tools/coordination/compaction-recovery';
import { renderAutomaticCompactionRecovery } from './carry-doc';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  listAllProjectedTools: () => [{
    expose: { mcp: { name: 'scenario:read' } }, effect: 'read', capabilities: [],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
  projectedToolRegistryRevision: () => 'return-path-scenario-v1',
}));
// Unrelated recovery discovery is outside this scenario. Neither production
// delivery seam nor its probe/ref evaluation modules are mocked.
vi.mock('./search/self-session', () => ({ resolveSelfSession: vi.fn(async () => null) }));
vi.mock('./harness/routines/loop', () => ({ getLoopStatus: vi.fn(async () => null) }));
vi.mock('./agent-tools/coordination/control-anchor', () => ({
  buildAndPersistControlAnchor: vi.fn(async () => { throw new Error('no control fixture'); }),
  controlStateHash: vi.fn(() => 'scenario-control'),
}));
vi.mock('./memory/session-epoch-ledger', () => ({ currentSessionEpoch: vi.fn(async () => 1) }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));

const OWNER = 'su-return-path';
const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';
const FIRE_TEXT = 'scenario-fire-time-text';

async function scenario() {
  const current = new Map([
    ['work-item:WI-1234', 'open@1'],
    ['fact:guard-rail:scenario', 'live:7@1'],
    ['decision:scenario-plan#D-001', 'sha256:unchanged'],
  ]);
  const resolve = vi.fn<CarryRefResolver>(async deps => new Map(deps.map(dep => [dep, current.get(dep) ?? null])));
  let state = 'green';
  const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: JSON.stringify({ state }) }] }));
  const checks: CheckEntry[] = [{
    id: 'scenario-probe', claim: 'scenario status is green', recheck: 'read scenario status',
    probe: { kind: 'tool', tool: 'scenario:read', args: {},
      schemaRevision: continuityProbeRevision('scenario:read')!,
      expect: { path: '$.state', op: 'eq', value: 'green' } },
  }];
  const note = renderCarryNote({
    did: 'Await WI-1234, fact:guard-rail:scenario and scenario-plan#D-001.', checks,
  });
  const stamps = await stampCarryRefs({ text: note, workspaceId: WORKSPACE, harness: HARNESS, resolve, now: 1 });
  expect(stamps.map(s => s.dep)).toEqual([...current.keys()]);
  const readLoopRefStamps = async () => ({ note, stamps });
  const loopSources = carriedProbeSources({ loop: { ownerId: OWNER, checks } });
  const blocks = { probes: [] as Array<string | null>, references: [] as Array<string | null> };
  const recordBlock = async (kind: keyof typeof blocks, render: () => Promise<string | null>) => {
    const block = await render();
    blocks[kind].push(block);
    return block;
  };
  const probes = (readAtIso: string) => recordBlock('probes', () =>
    carriedProbeBlockForDelivery(loopSources, { dispatchTool, readAtIso }));
  const delivery: DeliveryWork = {
    id: 1, workspaceId: WORKSPACE, awaitId: 1, subscriberId: OWNER,
    eventKey: 'scenario:loop', payload: { harness: HARNESS, wakeCount: 2 },
    summary: 'return-path scenario', status: 'delivering', channel: null,
    attempts: 1, lastError: null, nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), deliveredAt: null, urgent: false,
    minSleepSec: null, coalescedCount: 1, source: null, wakeHandle: null, note: null,
    turnProof: null, turnStartedAt: null, pickupDeadlineAt: null,
  };
  return {
    change() {
      current.set('work-item:WI-1234', 'done@2');
      current.set('fact:guard-rail:scenario', 'retracted:7');
      state = 'red';
    },
    blocks,
    dispatchTool,
    async wake() {
      return rehydrateLoopWakeText(delivery, FIRE_TEXT, {
        getLoopCarryNoteWithMetaFn: async () => ({ note, updatedAtMs: Date.now() - 1000 }),
        getLoopStatusFn: async () => null,
        carriedProbeBlockFn: input => probes(input.readAtIso),
        carryRefBlockFn: input => recordBlock('references', () =>
          carryRefChangesForWake({ ...input, readLoopRefStamps, resolve })),
      });
    },
    async recovery() {
      const result = await buildAutomaticCompactionRecovery(OWNER, WORKSPACE, {
        sessionHarness: HARNESS, heldItems: [],
        carriedProbesFn: async () => probes(new Date().toISOString()),
        carriedRefChangesFn: async () => recordBlock('references', () => carryRefChangesForRecovery({
          ownerId: OWNER, workspaceId: WORKSPACE, sessionHarness: HARNESS, heldItems: [],
          readAtIso: new Date().toISOString(),
          getLoopStatus: async () => ({ active: true, harnessSlug: HARNESS }),
          readLoopRefStamps, resolve,
        })),
      });
      return renderAutomaticCompactionRecovery(result);
    },
  };
}

function changeLines(text: string) {
  return text.split('\n').filter(line => /^\s*[✗↻] (?:CHANGED|GONE) —/.test(line));
}

beforeEach(() => {
  // Any HTTP model/gateway request is recorded and fails this fixture rather
  // than silently exercising a real account. Assert zero calls on both paths.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden in deterministic return path'));
});
afterEach(() => vi.restoreAllMocks());

describe('P-009 deterministic return-path scenario', () => {
  for (const path of ['wake', 'recovery'] as const) {
    it(`${path} renders exactly the moved item, retracted fact and changed probe with stable ids`, async () => {
      const s = await scenario();
      // Negative control uses the SAME stored checkpoint and real entry point.
      expect(changeLines(await s[path]())).toEqual([]);
      // Silence covers the complete rendered blocks, including text that lacks
      // the CHANGED/GONE prefix recognized by changeLines.
      expect(s.blocks).toEqual({ probes: [null], references: [null] });
      s.change();
      const text = await s[path]();
      const lines = changeLines(text);
      expect(lines).toHaveLength(3);
      expect(lines).toEqual(expect.arrayContaining([
        expect.stringContaining('[loop #scenario-probe]: observed "red"'),
        expect.stringContaining('work-item:WI-1234 [loop note]: open → done'),
        expect.stringContaining('fact:guard-rail:scenario [loop note]: now retracted'),
      ]));
      expect(lines.join('\n')).not.toContain('scenario-plan#D-001');
      expect(s.dispatchTool).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      if (path === 'wake') {
        expect(text.indexOf('LIVE RE-CHECK')).toBeLessThan(text.indexOf(lines[0]!));
        expect(text.indexOf(lines[2]!)).toBeLessThan(text.indexOf(FIRE_TEXT));
      }
    });
  }
});
