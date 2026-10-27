/**
 * tool-delivery-policy.test.ts — the falsifiers for P-003's two spec clauses.
 * (deterministic-tool-definition-delivery-2026-09-21; AUTO-BAR-R-1-P-003, AUTO-BAR-R-2-P-003.)
 *
 * R-1 is falsified if the function reads ambient state, or if reordering any input
 * collection changes the output map. R-2 is falsified if any agent kind is served
 * by a separate branch rather than the same call with different input values.
 * Both are checked directly below rather than argued for in prose.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type AgentKind,
  type DeliveryCatalogTool,
  type DeliveryDemandRow,
  FLOOR_HEADROOM_MARGIN_BYTES,
  describeFloorHeadroom,
  explainToolDelivery,
  floorHeadroom,
  floorHeadroomOf,
  resolveToolDelivery,
  summarizeDelivery,
} from './tool-delivery-policy';

const HERE = dirname(fileURLToPath(import.meta.url));

const tool = (name: string, fullBytes: number, compactBytes: number): DeliveryCatalogTool => ({
  name,
  fullBytes,
  compactBytes,
});
const row = (name: string, callers: number, calls: number): DeliveryDemandRow => ({ name, callers, calls });

/** A resolution reduced to a comparable string — what "the same map" means here. */
const asText = (tiers: Map<string, string>) =>
  [...tiers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(',');

describe('resolveToolDelivery — R-1 purity and determinism', () => {
  it('reads nothing ambient: no clock, env, filesystem or database in the module', () => {
    const source = readFileSync(resolve(HERE, 'tool-delivery-policy.ts'), 'utf8');
    // POSITIVE CONTROL FIRST. A wrong path or an empty read would make every
    // absence assertion below pass vacuously — the instrument has to be shown to
    // be looking at the right file before its silence means anything.
    expect(source).toContain('export function explainToolDelivery');
    expect(source.length).toBeGreaterThan(2000);

    for (const forbidden of ['new Date(', 'Date.now', 'process.env', 'node:fs', 'node:process', 'require(']) {
      expect(source, `policy module reaches for ambient state: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is invariant under reordering of catalog, demand and floors', () => {
    const catalog = [tool('a:one', 300, 100), tool('b:two', 200, 80), tool('c:three', 150, 60), tool('d:four', 90, 30)];
    const demand = [row('a:one', 9, 90), row('b:two', 9, 40), row('c:three', 4, 400), row('d:four', 1, 1)];
    const floors = ['c:three', 'd:four'];
    const budgetBytes = 400;

    const forward = resolveToolDelivery({ agentKind: 'claude', catalog, demand, floors, budgetBytes });
    const reversed = resolveToolDelivery({
      agentKind: 'claude',
      catalog: [...catalog].reverse(),
      demand: [...demand].reverse(),
      floors: [...floors].reverse(),
      budgetBytes,
    });
    expect(asText(reversed)).toBe(asText(forward));

    // And the decision TRAIL is stable too, not merely the final tiers — a diff of
    // the generated artifact shows the order, so an unstable order is churn.
    const a = explainToolDelivery({ agentKind: 'claude', catalog, demand, floors, budgetBytes });
    const b = explainToolDelivery({
      agentKind: 'claude',
      catalog: [...catalog].reverse(),
      demand: [...demand].reverse(),
      floors: [...floors].reverse(),
      budgetBytes,
    });
    expect(b.decisions).toEqual(a.decisions);
  });

  it('breaks a density tie by calls, then by name', () => {
    // Identical density (10/100 both) — `calls` must decide, not array order.
    const catalog = [tool('z:zebra', 500, 100), tool('a:apple', 500, 100)];
    const demand = [row('z:zebra', 10, 900), row('a:apple', 10, 10)];
    const r = explainToolDelivery({ agentKind: 'claude', catalog, demand, floors: [], budgetBytes: 100 });
    expect(r.decisions.map((d) => d.name)).toEqual(['z:zebra']);

    // Identical density AND identical calls — now name decides, ascending.
    const tied = explainToolDelivery({
      agentKind: 'claude',
      catalog,
      demand: [row('z:zebra', 10, 10), row('a:apple', 10, 10)],
      floors: [],
      budgetBytes: 100,
    });
    expect(tied.decisions.map((d) => d.name)).toEqual(['a:apple']);
  });
});

describe('resolveToolDelivery — budget behaviour', () => {
  it('fills a budget that is exactly exhausted, and reports no overrun', () => {
    const catalog = [tool('a:one', 500, 40), tool('b:two', 500, 20)];
    const demand = [row('a:one', 10, 10), row('b:two', 5, 5)];
    const r = explainToolDelivery({ agentKind: 'claude', catalog, demand, floors: [], budgetBytes: 60 });
    expect(r.spentBytes).toBe(60);
    expect(r.budgetOverrun).toBe(0);
    expect(r.counts).toEqual({ full: 0, compact: 2, deferred: 0 });
  });

  it('skips a move that does not fit and keeps filling with cheaper ones', () => {
    // The heavyweight sorts first on density but cannot fit; a terminal loop would
    // strand the whole remaining budget behind it.
    const catalog = [tool('heavy:one', 9_000, 5_000), tool('light:two', 200, 50)];
    const demand = [row('heavy:one', 1_000, 1_000), row('light:two', 5, 5)];
    const r = explainToolDelivery({ agentKind: 'claude', catalog, demand, floors: [], budgetBytes: 100 });
    expect(r.tiers.get('heavy:one')).toBe('deferred');
    expect(r.tiers.get('light:two')).toBe('compact');
  });

  it('never admits a non-floor tool with zero measured demand, however large the budget', () => {
    const catalog = [tool('unused:tool', 100, 30)];
    const r = explainToolDelivery({
      agentKind: 'claude',
      catalog,
      demand: [row('unused:tool', 0, 0)],
      floors: [],
      budgetBytes: 1_000_000,
    });
    expect(r.tiers.get('unused:tool')).toBe('deferred');
    expect(r.spentBytes).toBe(0);
  });
});

describe('resolveToolDelivery — floors (D-004)', () => {
  it('keeps a floor that cannot afford FULL at COMPACT rather than dropping it', () => {
    const catalog = [tool('tools:find', 1_000, 50)];
    const r = explainToolDelivery({
      agentKind: 'claude',
      catalog,
      demand: [row('tools:find', 1_077, 57_073)],
      floors: ['tools:find'],
      budgetBytes: 100,
    });
    expect(r.tiers.get('tools:find')).toBe('compact');
    expect(r.budgetOverrun).toBe(0);
  });

  it.each(['claude', 'codex', 'omp'] as const)('seats a ZERO-DEMAND floor at COMPACT for %s — the mandate is its justification, not the measurement', (agentKind) => {
    const catalog = [tool('session:request-compaction', 400, 60)];
    const r = explainToolDelivery({
      agentKind,
      catalog,
      demand: [],
      floors: ['session:request-compaction'],
      budgetBytes: 10_000,
    });
    // Contrast with the zero-demand NON-floor above, which stays deferred.
    expect(r.tiers.get('session:request-compaction')).toBe('compact');
    expect(r.unmeasured).toEqual(['session:request-compaction']);
  });

  it.each(['claude', 'codex', 'omp'] as const)('admits every floor for %s even when the floors alone overrun the budget, and SAYS so', (agentKind) => {
    // A silently-dropped mandate is the one outcome D-004 forbids; an honest
    // overrun is recoverable because it is visible.
    const catalog = [tool('f:one', 900, 300), tool('f:two', 900, 300)];
    const r = explainToolDelivery({
      agentKind,
      catalog,
      demand: [],
      floors: ['f:one', 'f:two'],
      budgetBytes: 100,
    });
    expect(r.counts.deferred).toBe(0);
    expect(r.spentBytes).toBe(600);
    expect(r.budgetOverrun).toBe(500);
  });

  it('upgrades a floor to FULL only when the budget allows, competing on the same scale', () => {
    const catalog = [tool('floor:heavy', 5_000, 100), tool('other:cheap', 400, 100)];
    const demand = [row('floor:heavy', 1, 1), row('other:cheap', 50, 50)];
    // Budget seats the floor (100), then has 300 left: the cheap high-demand
    // newcomer (density 0.5) beats the floor's upgrade (1/4900) and wins the room.
    const r = explainToolDelivery({ agentKind: 'claude', catalog, demand, floors: ['floor:heavy'], budgetBytes: 400 });
    expect(r.tiers.get('floor:heavy')).toBe('compact');
    expect(r.tiers.get('other:cheap')).toBe('compact');
  });
});

describe('resolveToolDelivery — R-2, agentKind is a parameter and nothing more', () => {
  const catalog = [tool('a:one', 900, 300), tool('b:two', 500, 120), tool('c:three', 300, 60)];
  const demand = [row('a:one', 40, 400), row('b:two', 30, 30), row('c:three', 5, 5)];

  it('produces all three agent kinds from the identical exported function', () => {
    const kinds: AgentKind[] = ['claude', 'codex', 'omp'];
    const maps = kinds.map((agentKind) =>
      resolveToolDelivery({ agentKind, catalog, demand, floors: ['c:three'], budgetBytes: 600 }),
    );
    // Same budget + same floors ⇒ byte-identical maps. Any per-agent branch would
    // have to show up here as a divergence with no input to explain it.
    expect(asText(maps[1])).toBe(asText(maps[0]));
    expect(asText(maps[2])).toBe(asText(maps[0]));
  });

  it('swaps two agent kinds’ maps when only their budgets and floors are swapped', () => {
    const claude = { agentKind: 'claude' as const, floors: ['a:one'], budgetBytes: 1_200 };
    const omp = { agentKind: 'omp' as const, floors: ['c:three'], budgetBytes: 200 };

    const claudeMap = resolveToolDelivery({ catalog, demand, ...claude });
    const ompMap = resolveToolDelivery({ catalog, demand, ...omp });
    // The two configurations must genuinely differ, or the swap below proves nothing.
    expect(asText(ompMap)).not.toBe(asText(claudeMap));

    const claudeWithOmpInputs = resolveToolDelivery({
      agentKind: 'claude',
      catalog,
      demand,
      floors: omp.floors,
      budgetBytes: omp.budgetBytes,
    });
    const ompWithClaudeInputs = resolveToolDelivery({
      agentKind: 'omp',
      catalog,
      demand,
      floors: claude.floors,
      budgetBytes: claude.budgetBytes,
    });
    expect(asText(claudeWithOmpInputs)).toBe(asText(ompMap));
    expect(asText(ompWithClaudeInputs)).toBe(asText(claudeMap));
  });
});

describe('resolveToolDelivery — a catalog tool absent from the snapshot', () => {
  it('treats it as zero demand, names it in `unmeasured`, and does not admit it', () => {
    // A newly-added tool has no history. It must not be silently scored as if it
    // had been measured, and the caller must be able to see that it was not.
    const catalog = [tool('brand:new', 400, 80), tool('known:one', 400, 80)];
    const r = explainToolDelivery({
      agentKind: 'claude',
      catalog,
      demand: [row('known:one', 12, 12)],
      floors: [],
      budgetBytes: 10_000,
    });
    expect(r.unmeasured).toEqual(['brand:new']);
    expect(r.tiers.get('brand:new')).toBe('deferred');
    expect(r.tiers.get('known:one')).toBe('full');
  });

  it('ignores a snapshot row that has no catalog entry', () => {
    // The snapshot is 14 days of history and legitimately contains retired tools.
    // They must not appear in the delivery map at all.
    const r = explainToolDelivery({
      agentKind: 'claude',
      catalog: [tool('live:one', 400, 80)],
      demand: [row('live:one', 3, 3), row('retired:gone', 900, 9_000)],
      floors: [],
      budgetBytes: 10_000,
    });
    expect(r.tiers.has('retired:gone')).toBe(false);
    expect(r.tiers.size).toBe(1);
  });
});

describe('floorHeadroom — the edit-time floor-budget signal (WI-10004590)', () => {
  it('is budget minus the floors’ compact bytes, with an inclusive margin boundary', () => {
    const at = (budget: number) => floorHeadroom(budget, [600, 400]);
    expect(at(1100)).toMatchObject({ floorBytes: 1000, floorCount: 2, headroomBytes: 100, status: 'ok' });
    // Exactly the margin is OK; one byte under it is LOW; one byte past zero is an OVERRUN.
    expect(at(1000 + FLOOR_HEADROOM_MARGIN_BYTES).status).toBe('ok');
    expect(at(1000 + FLOOR_HEADROOM_MARGIN_BYTES - 1).status).toBe('low');
    expect(at(1000).status).toBe('low');
    expect(at(999)).toMatchObject({ headroomBytes: -1, status: 'overrun' });
  });

  it('agrees with explainToolDelivery: overrun ⇔ budgetOverrun > 0, at every budget', () => {
    const catalog = [tool('f:a', 900, 600), tool('f:b', 700, 400), tool('n:c', 500, 300)];
    const demand = [row('n:c', 5, 50), row('f:a', 3, 30)];
    for (const budget of [0, 999, 1000, 1001, 1063, 1064, 1299, 1300, 5000]) {
      const r = explainToolDelivery({ agentKind: 'claude', catalog, demand, floors: ['f:a', 'f:b'], budgetBytes: budget });
      const h = floorHeadroomOf(r);
      expect(h.status === 'overrun').toBe(r.budgetOverrun > 0);
      expect(h.headroomBytes).toBe(budget - 1000);
    }
  });

  it('prices the floors’ SEATS, never the filler spend that fills the leftover budget', () => {
    // Budget 5000 buys filler + upgrades, so spentBytes is far above 1000 — but the floors
    // themselves still seat 1000 B, which is what bounds a floor-tool edit.
    const r = explainToolDelivery({
      agentKind: 'claude',
      catalog: [tool('f:a', 900, 600), tool('f:b', 700, 400), tool('n:c', 500, 300)],
      demand: [row('n:c', 9, 90), row('f:a', 4, 40)],
      floors: ['f:a', 'f:b'],
      budgetBytes: 5000,
    });
    expect(r.spentBytes).toBeGreaterThan(1000);
    expect(floorHeadroomOf(r)).toMatchObject({ floorBytes: 1000, headroomBytes: 4000, status: 'ok' });
  });

  it('summarizeDelivery flags floors from the resolution, even when `floors` is a one-shot iterator', () => {
    const floors = (function* () {
      yield 'f:a';
    })();
    const s = summarizeDelivery({
      agentKind: 'claude',
      catalog: [tool('f:a', 900, 600), tool('n:c', 500, 300)],
      demand: [],
      floors,
      budgetBytes: 1000,
    });
    expect(s.tools.get('f:a')).toMatchObject({ isFloor: true, tier: 'compact', compactBytes: 600, fullBytes: 900 });
    expect(s.tools.get('n:c')).toMatchObject({ isFloor: false, tier: 'deferred' });
    expect(s.headroom.floorBytes).toBe(600);
  });

  it('names the lever in each state, so the three surfaces print one wording', () => {
    expect(describeFloorHeadroom(floorHeadroom(1100, [1000]))).toMatch(/^floor headroom: OK 100 B of 1100/);
    expect(describeFloorHeadroom(floorHeadroom(1010, [1000]))).toMatch(/LOW 10 B .*more than 10 B overruns/);
    expect(describeFloorHeadroom(floorHeadroom(900, [1000]))).toMatch(/OVERRUN by 100 B of 900/);
  });
});
