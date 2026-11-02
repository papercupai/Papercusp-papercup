/**
 * Unit tests for the pure freshness layer (P-007, D-013).
 *
 * The two tests that matter most are the INVERSIONS — the cases the time
 * heuristics get wrong by construction, and the whole reason this axis exists:
 *  - an OLD note whose dependencies never moved is FRESH (today: flagged stale);
 *  - a NEW note whose dependency moved is STALE (today: reads fresh), including
 *    when a PEER moved it, which no author-activity heuristic can see.
 */

import { describe, expect, it } from 'vitest';
import {
  DECLARED_DEPS_VERSION,
  computeFreshness,
  parseDeclaredDeps,
  shouldMarkRecomputed,
  type DeclaredDeps,
} from './index';

function deps(stamps: Array<[string, string]>, recomputed = false): DeclaredDeps {
  return {
    v: DECLARED_DEPS_VERSION,
    stamps: stamps.map(([dep, token]) => ({ dep, token, at: 1_700_000_000_000 })),
    ...(recomputed ? { recomputed: true } : {}),
  };
}

const HOUR = 3_600_000;

describe('computeFreshness — verdicts', () => {
  it('reports undeclared when no dependencies were declared', () => {
    const r = computeFreshness({ deps: null, currentTokens: new Map() });
    expect(r.verdict).toBe('undeclared');
    expect(r.declared).toBe(0);
  });

  it('reports fresh when every declared token is unchanged', () => {
    const r = computeFreshness({
      deps: deps([
        ['file:a.ts', 'sha256:aaa'],
        ['work-item:WI-1', 'open@100'],
      ]),
      currentTokens: new Map([
        ['file:a.ts', 'sha256:aaa'],
        ['work-item:WI-1', 'open@100'],
      ]),
    });
    expect(r.verdict).toBe('fresh');
    expect(r.changed).toEqual([]);
  });

  it('reports stale dependencies against their recorded version stamps, not the latest note time', () => {
    const r = computeFreshness({
      deps: deps([
        ['file:a.ts', 'sha256:aaa'],
        ['file:b.ts', 'sha256:bbb'],
      ]),
      currentTokens: new Map([
        ['file:a.ts', 'sha256:aaa'],
        ['file:b.ts', 'sha256:CHANGED'],
      ]),
    });
    expect(r.verdict).toBe('stale');
    expect(r.changed).toEqual([{ dep: 'file:b.ts', was: 'sha256:bbb', now: 'sha256:CHANGED' }]);
    // The actionable payload no TTL can produce: the name of what moved. The
    // dependency stamp may predate a later checkpoint rewrite, so do not attribute
    // the movement to the latest note's write time.
    expect(r.reason).toContain('file:b.ts');
    expect(r.reason).toContain('1 of 2 declared dependencies no longer matches its recorded version stamp: file:b.ts');
    expect(r.reason).toContain("not the latest note's write time");
    expect(r.reason).not.toContain('since this note was written');
  });

  it('reports recomputed when nothing moved but the note was rebuilt after an invalidation', () => {
    const r = computeFreshness({
      deps: deps([['file:a.ts', 'sha256:aaa']], true),
      currentTokens: new Map([['file:a.ts', 'sha256:aaa']]),
    });
    expect(r.verdict).toBe('recomputed');
    expect(r.changed).toEqual([]);
    expect(r.reason).toContain('REWRITTEN');
  });

  it('prefers stale over recomputed when a dependency has moved again', () => {
    const r = computeFreshness({
      deps: deps([['file:a.ts', 'sha256:aaa']], true),
      currentTokens: new Map([['file:a.ts', 'sha256:moved-again']]),
    });
    expect(r.verdict).toBe('stale');
  });
});

describe('computeFreshness — the inversions the TTL heuristics get wrong', () => {
  it('an OLD note whose dependencies never moved is FRESH', () => {
    // Written 6h ago — far past STALE_CHECKPOINT_MS (45m), so every existing
    // heuristic distrusts it. Nothing it depends on has changed, so it is current
    // and the successor should read it instead of re-deriving.
    const old: DeclaredDeps = {
      v: DECLARED_DEPS_VERSION,
      stamps: [{ dep: 'file:a.ts', token: 'sha256:aaa', at: Date.now() - 6 * HOUR }],
    };
    const r = computeFreshness({ deps: old, currentTokens: new Map([['file:a.ts', 'sha256:aaa']]) });
    expect(r.verdict).toBe('fresh');
    expect(r.reason).toContain('age alone is not a reason to distrust it');
  });

  it('a SECONDS-OLD note whose dependency a PEER changed is STALE', () => {
    // The structural hole: computeCheckpointStaleness keys on the ASSIGNEE's
    // lastActiveAt, so a peer's edit is invisible to it no matter the threshold.
    const justNow: DeclaredDeps = {
      v: DECLARED_DEPS_VERSION,
      stamps: [{ dep: 'file:shared.ts', token: 'sha256:before', at: Date.now() - 5_000 }],
    };
    const r = computeFreshness({
      deps: justNow,
      currentTokens: new Map([['file:shared.ts', 'sha256:after-peer-edit']]),
    });
    expect(r.verdict).toBe('stale');
    expect(r.changed[0]?.dep).toBe('file:shared.ts');
  });
});

describe('computeFreshness — warn-only discipline', () => {
  it('an unresolvable dependency does NOT make the note stale', () => {
    const r = computeFreshness({
      deps: deps([
        ['file:a.ts', 'sha256:aaa'],
        ['file:gone.ts', 'sha256:bbb'],
      ]),
      currentTokens: new Map([
        ['file:a.ts', 'sha256:aaa'],
        ['file:gone.ts', null],
      ]),
    });
    expect(r.verdict).toBe('fresh');
    expect(r.unresolvable).toEqual(['file:gone.ts']);
    expect(r.reason).toContain('could not be');
  });

  it('a dependency missing from the resolved map is unresolvable, not changed', () => {
    const r = computeFreshness({
      deps: deps([['work-item:WI-9', 'open@1']]),
      currentTokens: new Map(),
    });
    expect(r.verdict).toBe('fresh');
    expect(r.unresolvable).toEqual(['work-item:WI-9']);
  });

  it('still reports stale when a resolvable dependency moved alongside an unresolvable one', () => {
    const r = computeFreshness({
      deps: deps([
        ['file:a.ts', 'sha256:aaa'],
        ['file:gone.ts', 'sha256:bbb'],
      ]),
      currentTokens: new Map([
        ['file:a.ts', 'sha256:MOVED'],
        ['file:gone.ts', null],
      ]),
    });
    expect(r.verdict).toBe('stale');
    expect(r.unresolvable).toEqual(['file:gone.ts']);
  });
});

describe('parseDeclaredDeps — malformed metadata never means stale', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['an empty object', {}],
    ['a future version', { v: 99, stamps: [{ dep: 'file:a', token: 'x', at: 1 }] }],
    ['stamps not an array', { v: 1, stamps: 'no' }],
    ['empty stamps', { v: 1, stamps: [] }],
  ])('returns null for %s', (_label, raw) => {
    expect(parseDeclaredDeps(raw)).toBeNull();
  });

  it('drops individually malformed stamps but keeps the valid ones', () => {
    const parsed = parseDeclaredDeps({
      v: 1,
      stamps: [
        { dep: 'file:a.ts', token: 'sha256:aaa', at: 5 },
        { dep: '', token: 'x', at: 1 },
        { token: 'no-dep', at: 1 },
        { dep: 'file:b.ts', token: 'sha256:bbb' },
      ],
    });
    expect(parsed?.stamps).toEqual([
      { dep: 'file:a.ts', token: 'sha256:aaa', at: 5 },
      { dep: 'file:b.ts', token: 'sha256:bbb', at: 0 },
    ]);
  });

  it('preserves the recomputed flag only when explicitly true', () => {
    const base = { v: 1, stamps: [{ dep: 'file:a', token: 'x', at: 1 }] };
    expect(parseDeclaredDeps({ ...base, recomputed: true })?.recomputed).toBe(true);
    expect(parseDeclaredDeps({ ...base, recomputed: 'yes' })?.recomputed).toBeUndefined();
    expect(parseDeclaredDeps(base)?.recomputed).toBeUndefined();
  });

  it('a malformed payload yields undeclared, never stale', () => {
    const r = computeFreshness({ deps: parseDeclaredDeps({ v: 99 }), currentTokens: new Map() });
    expect(r.verdict).toBe('undeclared');
  });
});

describe('shouldMarkRecomputed', () => {
  it('marks recomputed only when the replaced note was stale', () => {
    expect(shouldMarkRecomputed('stale')).toBe(true);
    expect(shouldMarkRecomputed('fresh')).toBe(false);
    expect(shouldMarkRecomputed('recomputed')).toBe(false);
    expect(shouldMarkRecomputed('undeclared')).toBe(false);
    expect(shouldMarkRecomputed(null)).toBe(false);
    expect(shouldMarkRecomputed(undefined)).toBe(false);
  });
});
