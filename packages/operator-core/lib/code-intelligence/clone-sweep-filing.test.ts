import { beforeEach, describe, expect, it, vi } from 'vitest';

// R-2 (code-cleanup-campaigns-2026-10-26): the sweep files a capped number of
// area-grouped items, each naming member symbols, coverage and co-change. The
// condition store is replaced by an in-memory double keyed exactly like the real
// one (condition key -> item id), so idempotence is observable without Postgres.
const store = vi.hoisted(() => ({ items: new Map<string, { id: string; title: string; summary: string; payload: any }>(), seq: 0 }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws' }));
vi.mock('../coord/condition-upsert', () => ({
  withConditionReplayLock: async (_ws: string, _key: string, fn: () => Promise<unknown>) => fn(),
  adoptConditionIncumbent: async (key: string, update: { title: string; summary: string }) => {
    const row = store.items.get(key);
    if (!row) return null;
    Object.assign(row, update);
    return row.id;
  },
  upsertConditionWorkItem: async (key: string, input: { kind: string; title: string; summary: string; payload: any }) => {
    const id = `WI-${++store.seq}`;
    // R-3 (code-cleanup-campaigns-2026-10-26): the sweep files every finding as kind 'cleanup'.
    if (input.kind !== 'cleanup') throw new Error(`clone sweep filed kind ${input.kind}, expected cleanup`);
    store.items.set(key, { id, title: input.title, summary: input.summary, payload: input.payload });
    return { id, created: true };
  },
}));

const { buildCloneIndex } = await import('./clone-index');
const { cloneFamilyArea, fileCloneSweep, rankCloneSweep } = await import('./clone-sweep');
type MemberCoverage = import('./clone-sweep').MemberCoverage;

const body = (n: number) => `const total = input.reduce((sum, value) => sum + value * ${n}, 0); if (total > ${n}) { return total * 2; } `
  + `const list = input.map(v => v + total).filter(v => v % 2 === 0); return list.length ? list[0] + ${n} : total - 1;`;
/** One family per `variant`: identical normalized bodies in two files of the same area. */
const named = (fn: string, n: number) => `export function ${fn}(input: number[]) { ${body(n)} }`;
const anonymous = (outer: string, n: number) => `export function ${outer}(xs: number[][]) { return xs.map(function (input: number[]) { ${body(n)} }); }`;
const scope = { workspaceId: 'ws', harness: 'papercusp', fireId: 'fire-1' };
const empty = { acceptances: [], genericEvidence: [] };

/** `areas` areas, each holding two families (a named pair and an anonymous-callback pair).
 * Distinct operator shapes make each family's normalized fingerprint distinct. */
function fixture(areas: number) {
  const sources: { path: string; source: string }[] = [];
  for (let a = 0; a < areas; a++) {
    const ops = ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '**'];
    const shape = (n: number) => body(n).replace('sum + value', `sum ${ops[a % ops.length]} value`)
      .replace('total * 2', `total * ${'2 * '.repeat(Math.floor(a / ops.length))}2`);
    const dir = `packages/pkg${a}/lib/area`;
    sources.push({ path: `${dir}/one.ts`, source: `${named(`alpha${a}`, a).replace(body(a), shape(a))}\n${anonymous(`outerOne${a}`, a).replace(body(a), shape(a).replace('return total * ', 'return total + 7 * '))}` },
      { path: `${dir}/two.ts`, source: `${named(`beta${a}`, a).replace(body(a), shape(a))}\n${anonymous(`outerTwo${a}`, a).replace(body(a), shape(a).replace('return total * ', 'return total + 7 * '))}` });
  }
  return buildCloneIndex(sources);
}

describe('clone sweep filing (R-2)', () => {
  beforeEach(() => { store.items.clear(); store.seq = 0; });

  it('files at most the cap, one item per area grouping every family in it, and defers the rest', async () => {
    const ranked = rankCloneSweep(fixture(5), empty);
    // Each area holds the named pair, the anonymous-callback pair and the enclosing pair.
    const perArea = ranked.length / 5;
    expect(Number.isInteger(perArea) && perArea >= 2).toBe(true);
    const out = await fileCloneSweep(ranked, scope, { cap: 3 });
    expect(out.created).toBe(3);
    expect(store.items.size).toBe(3);
    expect(out.filedAreas).toBe(3);
    expect(out.deferredAreas).toBe(2);
    for (const item of store.items.values()) expect(item.payload.cloneArea.families).toHaveLength(perArea);
    expect(out.rows.filter((r: { disposition: string }) => r.disposition === 'deferred')).toHaveLength(2 * perArea);
    // Families sharing an area share one item.
    const byArea = new Map<string, Set<string>>();
    for (const r of out.rows) {
      if (r.itemId && r.area) byArea.set(r.area, (byArea.get(r.area) ?? new Set<string>()).add(r.itemId));
    }
    expect(byArea.size).toBe(3);
    for (const ids of byArea.values()) expect(ids.size).toBe(1);
  });

  it('names every member by its enclosing symbol and carries coverage and co-change for each', async () => {
    const coverage = vi.fn(async (members: readonly { id: string }[]) => new Map<string, MemberCoverage>(members.map((fn, n) =>
      [fn.id, n === 0 ? { status: 'covered', tests: 2 } : { status: 'uncovered' }])));
    const coChange = vi.fn(async () => ({ status: 'measured' as const, score: 0.5, shared: 2, union: 4 }));
    await fileCloneSweep(rankCloneSweep(fixture(1), empty), scope, { signals: { coverage, coChange } });
    const [item] = store.items.values();
    expect(item.summary).not.toContain('<anon>');
    expect(item.summary).toMatch(/outerOne0 › map\(…\) callback/);
    expect(item.summary).toContain('covered by 2 test files');
    expect(item.summary).toContain('no test executes it');
    expect(item.summary).toContain('co-change 0.50');
    for (const family of item.payload.cloneArea.families) {
      expect(family.coChange).toEqual({ status: 'measured', score: 0.5, shared: 2, union: 4 });
      for (const member of family.members) {
        expect(member.symbol).not.toBe('<anon>');
        expect(['covered', 'uncovered']).toContain(member.coverage.status);
      }
    }
  });

  it('states unmeasured coverage and co-change as unknown with a reason instead of omitting them', async () => {
    await fileCloneSweep(rankCloneSweep(fixture(1), empty), scope);
    const [item] = store.items.values();
    for (const family of item.payload.cloneArea.families) {
      expect(family.coChange.status).toBe('unknown');
      expect(family.coChange.reason).toBeTruthy();
      for (const member of family.members) expect(member.coverage).toMatchObject({ status: 'unknown' });
    }
  });

  it('is idempotent: a second run over an unchanged tree creates nothing; an accept-listed family is in no item', async () => {
    const index = fixture(2);
    const first = await fileCloneSweep(rankCloneSweep(index, empty), scope);
    expect(first.created).toBe(2);
    const again = await fileCloneSweep(rankCloneSweep(index, empty), { ...scope, fireId: 'fire-2' });
    expect(again.created).toBe(0);
    expect(store.items.size).toBe(2);
    const target = rankCloneSweep(index, empty)[0];
    store.items.clear();
    const accepted = rankCloneSweep(index, { genericEvidence: [], acceptances: [{ familyId: target.family.id,
      membersDigest: target.membersDigest, reason: 'intentional copy', expiresAt: '2099-01-01T00:00:00Z' }] });
    const out = await fileCloneSweep(accepted, scope);
    expect(out.accepted).toBe(1);
    for (const item of store.items.values()) {
      expect(item.payload.cloneArea.families.map((f: { id: string }) => f.id)).not.toContain(target.family.id);
    }
  });

  it('derives the area from the shared directory, or the package set when members share no package', () => {
    expect(cloneFamilyArea([{ path: 'packages/a/lib/x/one.ts' }, { path: 'packages/a/lib/x/two.ts' }])).toBe('packages/a/lib/x');
    expect(cloneFamilyArea([{ path: 'packages/a/lib/x/y/z/one.ts' }, { path: 'packages/a/lib/x/y/z/two.ts' }])).toBe('packages/a/lib/x');
    expect(cloneFamilyArea([{ path: 'packages/b/src/one.ts' }, { path: 'packages/a/lib/two.ts' }])).toBe('packages/a + packages/b');
    expect(cloneFamilyArea([{ path: 'scripts/one.ts' }, { path: 'scripts/two.ts' }])).toBe('scripts');
  });

  it('refuses a non-positive cap before filing anything', async () => {
    await expect(fileCloneSweep(rankCloneSweep(fixture(1), empty), scope, { cap: 0 })).rejects.toThrow('cap');
    expect(store.items.size).toBe(0);
  });
});
