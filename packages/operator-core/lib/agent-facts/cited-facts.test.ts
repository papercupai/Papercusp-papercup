/**
 * EI-19465127338264010 — the prose fact-citation lens.
 *
 * Every assertion here is PURE (no PG). The DB-touching leg is `resolveCitedFacts`,
 * whose only interesting behaviour is that it FAILS OPEN; that is covered by
 * injecting a throwing `sql`, which needs no container.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  CITED_FACT_KEY_RE,
  MAX_CITED_FACT_KEYS,
  extractCitedFactKeys,
  selectCitedFacts,
  citedFactsWarning,
  resolveCitedFacts,
} from './cited-facts';

/** Shorthand for the row shape `selectCitedFacts` consumes. */
function row(
  over: Partial<{
    id: number;
    scope: string;
    scope_ref: string | null;
    key: string;
    body: string;
    retracted: boolean;
    superseded: boolean;
    expired: boolean;
    evicted: boolean;
  }> = {},
) {
  return {
    id: 1,
    scope: 'workspace',
    scope_ref: null,
    key: 'a-b-c',
    body: 'the body',
    retracted: false,
    superseded: false,
    expired: false,
    evicted: false,
    ...over,
  } as Parameters<typeof selectCitedFacts>[1][number];
}

describe('extractCitedFactKeys — precision', () => {
  it('matches a real slug citation in either punctuation form', () => {
    expect(extractCitedFactKeys(['per fact bg-host-restart-hold, we wait']).keys).toEqual([
      'bg-host-restart-hold',
    ]);
    expect(extractCitedFactKeys(['Map=fact: pot-backend-rename-map (D-007)']).keys).toEqual([
      'pot-backend-rename-map',
    ]);
  });

  it('does NOT fire on the English phrase "the fact that" and friends', () => {
    const prose = [
      'the fact that we cannot do this',
      'the fact before the change',
      'despite the fact rather than because of it',
      'the fact asserted by the owner',
    ];
    expect(extractCitedFactKeys(prose).keys).toEqual([]);
  });

  it('CALIBRATION: the naive pattern really would have fired on that same prose', () => {
    // Without this control the precision test above could pass because the
    // extractor is broken and matches NOTHING. Measured live before this landed:
    // the loose pattern's top "keys" were that(75) / before(23) / with(19).
    const loose = /\bfact[: ]+(\w+)/gi;
    const noise = 'the fact that we cannot, despite the fact rather than because of it'.matchAll(loose);
    expect([...noise].map((m) => m[1])).toEqual(['that', 'rather']);
    // ...and the tight pattern rejects exactly those.
    expect(extractCitedFactKeys(['the fact that we cannot, despite the fact rather than']).keys).toEqual([]);
  });

  it('requires >= 3 hyphen-separated segments', () => {
    expect(extractCitedFactKeys(['fact two-segments']).keys).toEqual([]);
    expect(extractCitedFactKeys(['fact three-segments-here']).keys).toEqual(['three-segments-here']);
  });

  it('does not match the tail of "artifact:" (the \\b guard)', () => {
    expect(extractCitedFactKeys(['artifact: foo-bar-baz was produced']).keys).toEqual([]);
    // ...but a real citation immediately after one still matches.
    expect(extractCitedFactKeys(['artifact: foo-bar-baz, per fact real-key-here']).keys).toEqual([
      'real-key-here',
    ]);
  });

  it('scans several texts, dedupes, and lowercases', () => {
    const out = extractCitedFactKeys(['see fact Alpha-Beta-Gamma', 'also fact alpha-beta-gamma', null, undefined]);
    expect(out.keys).toEqual(['alpha-beta-gamma']);
    expect(out.truncated).toBe(false);
  });

  it('caps the resolved set and says so', () => {
    const many = Array.from({ length: MAX_CITED_FACT_KEYS + 3 }, (_, i) => `fact key-number-${i}-x`).join(' ');
    const out = extractCitedFactKeys([many]);
    expect(out.keys).toHaveLength(MAX_CITED_FACT_KEYS);
    expect(out.truncated).toBe(true);
  });

  it('is not corrupted by the shared /g regex lastIndex across calls', () => {
    // The module exports one stateful literal; a missing lastIndex reset makes
    // the SECOND identical call return nothing, which would read as "no citations".
    const text = ['per fact bg-host-restart-hold'];
    expect(extractCitedFactKeys(text).keys).toEqual(['bg-host-restart-hold']);
    expect(extractCitedFactKeys(text).keys).toEqual(['bg-host-restart-hold']);
    expect(CITED_FACT_KEY_RE.flags).toContain('g');
  });
});

describe('selectCitedFacts — resolution', () => {
  it('reports a key with no row at all as dangling, with no excerpt to offer', () => {
    const [c] = selectCitedFacts(['gone-for-good-key'], []);
    expect(c.condition).toBe('dangling');
    expect(c.ref).toBeNull();
    expect(c.excerpt).toBeUndefined();
  });

  it('maps each decay path to its own condition AND still returns the body', () => {
    const cases = [
      [{ retracted: true }, 'retracted'],
      [{ expired: true }, 'lapsed'],
      [{ superseded: true }, 'superseded'],
      [{}, 'live'],
    ] as const;
    for (const [over, condition] of cases) {
      const [c] = selectCitedFacts(['a-b-c'], [row({ ...over, body: 'the authority text' })]);
      expect(c.condition).toBe(condition);
      // THE POINT (correction B): a decayed fact is filtered out of every fold but
      // its body is still readable — so the lens hands it back rather than
      // reporting a dead end.
      expect(c.excerpt).toBe('the authority text');
      expect(c.ref).toContain('a-b-c');
    }
  });

  it('treats an expired current wall as active until it is retracted or superseded', () => {
    const [active] = selectCitedFacts(['wall:owner-action'], [row({
      key: 'wall:owner-action', expired: true, body: 'rotation still pending',
    })]);
    expect(active.condition).toBe('live');
    expect(active.excerpt).toBe('rotation still pending');

    const [retracted] = selectCitedFacts(['wall:owner-action'], [row({
      key: 'wall:owner-action', expired: true, retracted: true,
    })]);
    expect(retracted.condition).toBe('retracted');

    const [superseded] = selectCitedFacts(['wall:owner-action'], [row({
      key: 'wall:owner-action', expired: true, superseded: true,
    })]);
    expect(superseded.condition).toBe('superseded');
  });

  it('prefers a LIVE row in a broad scope over a decayed row in a specific one', () => {
    // This is the whole reason this module does not reuse resolveAssumptions,
    // which is specific-scope-first by design (D-079 R2).
    const [c] = selectCitedFacts(
      ['a-b-c'],
      [
        row({ id: 9, scope: 'work_item', scope_ref: 'WI-1', retracted: true, body: 'stale' }),
        row({ id: 2, scope: 'workspace', body: 'current' }),
      ],
    );
    expect(c.condition).toBe('live');
    expect(c.scope).toBe('workspace');
    expect(c.excerpt).toBe('current');
    expect(c.otherScopes).toBe(1);
  });

  it('falls back to the NEWEST row when every scope has decayed', () => {
    const [c] = selectCitedFacts(
      ['a-b-c'],
      [row({ id: 3, expired: true, body: 'newer' }), row({ id: 1, expired: true, body: 'older' })],
    );
    expect(c.condition).toBe('lapsed');
    expect(c.excerpt).toBe('newer');
  });

  it('does not leak another key’s rows into a key that has none', () => {
    const out = selectCitedFacts(['a-b-c', 'x-y-z'], [row({ key: 'a-b-c' })]);
    expect(out.map((c) => c.condition)).toEqual(['live', 'dangling']);
  });
});

describe('citedFactsWarning — warn-only, and never a false alarm', () => {
  it('is silent when every citation still resolves live', () => {
    expect(citedFactsWarning(selectCitedFacts(['a-b-c'], [row()]))).toBeUndefined();
  });

  it('is silent when the ledger could not be read (unresolved is NOT dangling)', async () => {
    const throwing = (() => {
      throw new Error('pg down');
    }) as unknown as Sql;
    const resolved = await resolveCitedFacts(['a-b-c', 'd-e-f'], { workspaceId: 'ws' }, throwing);
    expect(resolved.map((c) => c.condition)).toEqual(['unresolved', 'unresolved']);
    // A read failure says nothing about the item, so it must not decorate it.
    expect(citedFactsWarning(resolved)).toBeUndefined();
  });

  it('counts decayed and dangling separately and tells the reader what to do', () => {
    const cited = selectCitedFacts(
      ['a-b-c', 'd-e-f', 'g-h-i'],
      [row({ key: 'a-b-c', retracted: true }), row({ key: 'd-e-f' })],
    );
    const w = citedFactsWarning(cited);
    expect(w).toBeDefined();
    expect(w?.decayed).toBe(1);
    expect(w?.dangling).toBe(1);
    expect(w?.cited).toHaveLength(3);
    expect(w?.note).toMatch(/RECOVERAB|excerpt/i);
    expect(w?.note).toContain('plans:add-decision');
    // The specific escalation this item was filed to prevent.
    expect(w?.note).toMatch(/contested directive/i);
  });

  it('does NOT report a cap-eviction as a deliberate withdrawal', () => {
    // Eviction sets retracted_at too (store.ts), so without the `evicted` flag
    // these two are indistinguishable and the note would assert an intent nobody
    // had. Both rows are `retracted` by condition; only one was a judgement.
    const [withdrawn] = selectCitedFacts(['a-b-c'], [row({ retracted: true })]);
    const [dropped] = selectCitedFacts(['a-b-c'], [row({ retracted: true, evicted: true })]);
    expect(withdrawn.condition).toBe('retracted');
    expect(withdrawn.evicted).toBeUndefined();
    expect(dropped.condition).toBe('retracted');
    expect(dropped.evicted).toBe(true);

    expect(citedFactsWarning([withdrawn])?.note).toMatch(/deliberately withdrawn/);
    expect(citedFactsWarning([withdrawn])?.note).not.toMatch(/CAP-EVICTED/);
    expect(citedFactsWarning([dropped])?.note).toMatch(/CAP-EVICTED/);
    expect(citedFactsWarning([dropped])?.note).toMatch(/NOT withdrawn/);
    expect(citedFactsWarning([dropped])?.note).not.toMatch(/deliberately withdrawn/);
  });

  it('names supersession as "go read the newer one", not as staleness', () => {
    const cited = selectCitedFacts(['a-b-c'], [row({ superseded: true })]);
    expect(citedFactsWarning(cited)?.note).toMatch(/NEWER version of this key exists/);
  });

  it('propagates the extractor’s truncation flag', () => {
    const cited = selectCitedFacts(['a-b-c'], []);
    expect(citedFactsWarning(cited, { truncated: true })?.truncated).toBe(true);
    expect(citedFactsWarning(cited)?.truncated).toBeUndefined();
  });

  it('resolveCitedFacts short-circuits an empty key set without touching the ledger', async () => {
    const explode = (() => {
      throw new Error('should not be called');
    }) as unknown as Sql;
    await expect(resolveCitedFacts([], {}, explode)).resolves.toEqual([]);
  });
});
