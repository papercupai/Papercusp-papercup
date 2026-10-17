import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Keep this fixture synchronized with the persisted recipe via recipes:revise.
const script = readFileSync(
  new URL('./fixtures/locate-retained-mcp-proxy-ledgers.recipe.txt', import.meta.url),
  'utf8',
);

const ENTRIES = [
  {
    name: 'archive-mcp-proxy-failures-current.jsonl',
    type: 'file',
    bytes: 2_912_662,
    mtimeUtc: '2026-10-01T13:32:55.776Z',
    symlinkTarget: null,
    symlinkResolvesTo: null,
    statUnreadable: null,
  },
  {
    name: 'mcp-proxy-failures.jsonl',
    type: 'file',
    bytes: 6_780_503,
    mtimeUtc: '2026-10-16T14:50:42.463Z',
    symlinkTarget: null,
    symlinkResolvesTo: null,
    statUnreadable: null,
  },
];

describe('locate-retained-mcp-proxy-ledgers saved recipe', () => {
  it('reads the current capability:list field names and preserves UTC timestamps', async () => {
    const list = vi.fn(async () => ({
      ok: true,
      path: '/home/builduser/.papercusp',
      entries: ENTRIES,
      matched: ENTRIES.length,
      total: ENTRIES.length,
      truncated: false,
      hiddenExcluded: 0,
      symlinkedDirs: 0,
    }));
    const context = vm.createContext({ tools: { capability: { list } } });
    const result = (await vm.runInContext(`(async () => {\n${script}\n})()`, context)) as {
      total: number;
      truncated: boolean;
      entries: Array<Record<string, unknown>>;
    };

    expect(result).toEqual({
      total: 2,
      truncated: false,
      entries: ENTRIES,
    });
    expect(list).toHaveBeenCalledWith({
      path: '/home/builduser/.papercusp',
      all: true,
      limit: 1000,
      sort: 'name',
      contains: 'mcp-proxy-failures',
    });
    expect(result.entries[0]).not.toHaveProperty('mtime');
    expect(result.entries[0]).not.toHaveProperty('size');
    expect(result.entries[0]?.mtimeUtc).toMatch(/Z$/);
    expect(result.entries[0]?.bytes).toBe(2_912_662);
  });
});
