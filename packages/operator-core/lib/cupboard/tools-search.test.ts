/**
 * tools-search tests (tool-distribution-discovery-2026-06-08 P-005).
 *
 * The contract the Cupboard's capability search rests on:
 *   - tokenize / categoryOf split tool names the way the scorer + facets do;
 *   - scoring is field-weighted (name ≫ category/capability ≫ provider ≫
 *     description), so the right provider for a capability leads;
 *   - search is AND-across-tokens (every query token must hit some field);
 *   - an exact / substring name match outranks a description-only hit;
 *   - an empty query is the neutral name-sorted browse order.
 */
import { describe, it, expect } from 'vitest';
import type { ToolDiscoveryEntry } from './tools-discovery';
import { tokenize, categoryOf, contentTokens, scoreTool, searchTools, FIELD_WEIGHTS } from './tools-search';

function entry(over: Partial<ToolDiscoveryEntry> & { tool: string }): ToolDiscoveryEntry {
  return {
    status: 'available',
    category: categoryOf(over.tool),
    provider: { kind: 'builtin', name: 'builtin' },
    ...over,
  };
}

describe('tokenize', () => {
  it('lowercases and splits on every non-alphanumeric run', () => {
    expect(tokenize('coord:send')).toEqual(['coord', 'send']);
    expect(tokenize('repomix.pack')).toEqual(['repomix', 'pack']);
    expect(tokenize('Markdown — Render_2')).toEqual(['markdown', 'render', '2']);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('categoryOf', () => {
  it('takes the namespace prefix before the first : or .', () => {
    expect(categoryOf('coord:send')).toBe('coord');
    expect(categoryOf('repomix.pack')).toBe('repomix');
    expect(categoryOf('plans:get')).toBe('plans');
  });
  it('a separatorless name is its own category', () => {
    expect(categoryOf('slugify')).toBe('slugify');
  });
});

describe('contentTokens', () => {
  it('drops stopwords from a natural-language query', () => {
    expect(contentTokens('send a message to a peer')).toEqual(['send', 'message', 'peer']);
  });
  it('falls back to the raw tokens when the query is all stopwords', () => {
    expect(contentTokens('to the of')).toEqual(['to', 'the', 'of']);
  });
});

describe('argSchema field (searchable parameters)', () => {
  it('FIELD_WEIGHTS ranks argSchema lowest (below description)', () => {
    expect(FIELD_WEIGHTS.argSchema).toBe(1);
    expect(FIELD_WEIGHTS.argSchema).toBeLessThan(FIELD_WEIGHTS.description);
  });

  it('matches a query word that only appears in a parameter name/doc', () => {
    const e = entry({
      tool: 'flags:set',
      description: 'flip a flag',
      argSchema: 'key:string the flag key; enabled:boolean on or off',
    });
    // "enabled" is absent from the name + description; only the arg schema has it.
    expect(scoreTool(e, 'enabled')).toBeGreaterThan(0);
  });

  it('an argSchema-only hit ranks below a description hit for the same word', () => {
    const descHit = entry({ tool: 'b:two', description: 'the thing matters', argSchema: null });
    const argHit = entry({ tool: 'a:one', description: 'unrelated', argSchema: 'thing:string the thing' });
    expect(scoreTool(descHit, 'thing')).toBeGreaterThan(scoreTool(argHit, 'thing'));
  });
});

describe('scoreTool', () => {
  it('OR across content tokens — one hit is enough; a no-hit query scores 0', () => {
    const e = entry({ tool: 'coord:send', description: 'send a message to a peer' });
    expect(scoreTool(e, 'coord send')).toBeGreaterThan(0);
    // a natural-language query matches on its content words (stopwords dropped)
    expect(scoreTool(e, 'send a message to a peer')).toBeGreaterThan(0);
    // a single matching token is enough (OR, not AND) …
    expect(scoreTool(e, 'coord zzzz')).toBeGreaterThan(0);
    // … but a query whose every token misses still scores 0
    expect(scoreTool(e, 'zzzz yyyy')).toBe(0);
  });

  it('rewards broader coverage — an entry matching more query tokens ranks higher', () => {
    const query = 'send message peer';
    const both = entry({ tool: 'x:both', description: 'send a message to a peer' });
    const one = entry({ tool: 'y:one', description: 'send something else' });
    expect(scoreTool(both, query)).toBeGreaterThan(scoreTool(one, query));
  });

  it('weights a name hit above a description-only hit', () => {
    const named = entry({ tool: 'repomix.pack', description: 'unrelated' });
    const described = entry({ tool: 'other.tool', description: 'this can repomix a repo' });
    expect(scoreTool(named, 'repomix')).toBeGreaterThan(scoreTool(described, 'repomix'));
  });

  it('an exact full-name match earns the phrase boost', () => {
    const exact = entry({ tool: 'slugify' });
    const partial = entry({ tool: 'slugify.batch' });
    expect(scoreTool(exact, 'slugify')).toBeGreaterThan(scoreTool(partial, 'slugify'));
  });

  it('matches on the capability gate string', () => {
    const e = entry({ tool: 'x.y', capability: 'tasks:read', description: null });
    expect(scoreTool(e, 'tasks')).toBeGreaterThanOrEqual(FIELD_WEIGHTS.capability);
  });

  it('matches on the providing unit name', () => {
    const e = entry({
      tool: 'md.render',
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
      unit: { name: 'markdown-tools', kind: 'pack', source: 'cupboard', listingId: 'lst-1' },
    });
    expect(scoreTool(e, 'markdown')).toBeGreaterThan(0);
  });

  it('an empty / whitespace query scores 0', () => {
    expect(scoreTool(entry({ tool: 'coord:send' }), '')).toBe(0);
    expect(scoreTool(entry({ tool: 'coord:send' }), '   ')).toBe(0);
  });
});

describe('searchTools', () => {
  it('preserves recorded scores, phrase boosts, field weights and ties across short and transcript queries', () => {
    // Recorded from the original scorer before token indexing (EI-27694455222051367).
    const entries = [
      entry({ tool: 'a:lease', description: 'Writer resource migration.', capability: 'tasks:read',
        argSchema: 'revision:string',
        unit: { name: 'migration-kit', kind: 'pack', source: 'cupboard', description: 'Resource audit.' } }),
      entry({ tool: 'b:lease', description: 'Writer resource migration.' }),
      entry({ tool: 'z:writer', description: 'Lease audit' }),
    ];
    const cases: Array<[string, number[], string[]]> = [
      ['lease lease writer source', [22.6, 22.6, 14], ['a:lease', 'b:lease', 'z:writer']],
      ['lea', [18, 18, 5.2], ['a:lease', 'b:lease', 'z:writer']],
      ['source', [4.6, 4.6, 0], ['a:lease', 'b:lease']],
      ['mi', [5.8, 5.2, 0], ['a:lease', 'b:lease']],
      ['revision', [1, 0, 0], ['a:lease']],
      ['read', [4, 0, 0], ['a:lease']],
      ['a', [10, 0, 0], ['a:lease']],
      ['to the of', [0, 0, 0], []],
    ];
    for (const [query, scores, names] of cases) {
      expect(entries.map(e => scoreTool(e, query))).toEqual(scores);
      expect(searchTools(entries, query).map(e => e.tool)).toEqual(names);
    }
    const unmatched = Array.from({ length: 9 }, (_, i) => `qzz${i}`).join(' ');
    // Do not multiply duplicate-token counts: changing addition order can
    // change exact scores and tie ordering even when the formula is the same.
    const transcript = 'lease lease writer source '.repeat(120) + unmatched;
    expect(entries.map(e => scoreTool(e, transcript))).toEqual([2711.999999999994, 2711.999999999994, 1680]);
    expect(searchTools(entries, transcript, { limit: 2 }).map(e => e.tool)).toEqual(['a:lease', 'b:lease']);
    expect(entries.map(e => scoreTool(e, `lea ${unmatched}`))).toEqual([6, 6, 1.2]);
    expect(entries.map(e => scoreTool(e, `source ${unmatched}`))).toEqual([0.6, 0.6, 0]);
  });

  const catalog = [
    entry({ tool: 'coord:send', description: 'send a message to a peer' }),
    entry({ tool: 'coord:inbox', description: 'read your coordination inbox' }),
    entry({ tool: 'plans:get', description: 'fetch a plan' }),
    entry({
      tool: 'repomix.pack',
      provider: { kind: 'plugin', name: '@papercupai/repomix' },
      unit: { name: '@papercupai/repomix', kind: 'plugin', source: 'installed' },
      description: 'pack a repo into one document',
    }),
    entry({
      tool: 'md.render',
      status: 'installable',
      provider: { kind: 'pack', name: 'markdown-tools', listingId: 'lst-1' },
      unit: { name: 'markdown-tools', kind: 'pack', source: 'cupboard', description: 'Markdown helpers', listingId: 'lst-1' },
    }),
  ];

  it('ranks the namespace match as a group, best first', () => {
    const ranked = searchTools(catalog, 'coord');
    expect(ranked.map((e) => e.tool)).toEqual(['coord:inbox', 'coord:send']);
  });

  it('finds a tool by a capability phrase in its description', () => {
    const ranked = searchTools(catalog, 'pack repo');
    expect(ranked[0]?.tool).toBe('repomix.pack');
  });

  it('drops non-matches entirely', () => {
    expect(searchTools(catalog, 'nonexistentcapability')).toEqual([]);
  });

  it('an empty query returns every entry name-sorted (browse order)', () => {
    const all = searchTools(catalog, '');
    expect(all.map((e) => e.tool)).toEqual(['coord:inbox', 'coord:send', 'md.render', 'plans:get', 'repomix.pack']);
  });

  it('respects the limit', () => {
    expect(searchTools(catalog, 'coord', { limit: 1 })).toHaveLength(1);
  });
});
