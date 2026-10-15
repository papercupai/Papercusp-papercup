/**
 * P-005 (observation-and-recall-surface-honesty-2026-08-16, D-001) — the
 * coord-fold census.
 *
 * What these cases are actually defending, beyond "the function returns fields":
 *
 *  · the RATIO is only computable if quiet folds are censused too, so the
 *    end-to-end cases assert a record on BOTH branches;
 *  · `reason` LABELS a decision made elsewhere. A drift guard asserts the label
 *    agrees with the `changed` the fold actually acted on, because a labeller
 *    that silently disagrees with the gate mislabels an entire measurement
 *    window rather than failing;
 *  · the instrument must never break the path it measures — an observer that
 *    throws is swallowed, and the fold still returns its bundle.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COORD_FOLD_CENSUS_KEY,
  COORD_FOLD_CENSUS_VERSION,
  censusCoordFold,
  coordFoldObserverFor,
  coordFoldReason,
  type CoordFoldObservation,
} from './coord-fold-census';

function observation(over: Partial<CoordFoldObservation> = {}): CoordFoldObservation {
  return {
    changed: true,
    complete: true,
    forceResync: false,
    reqGen: 'host-a:41',
    gen: 'host-a:42',
    foldMs: 120,
    gateMs: 20,
    hydrateMs: 100,
    inboxAdvanced: false,
    inboxTotal: 0,
    glanceHydrated: true,
    glanceOnly: false,
    ...over,
  };
}

describe('coordFoldReason', () => {
  it('labels a matching generation quiet — the O(1) path the optimization claims', () => {
    expect(coordFoldReason({ changed: false, forceResync: false, reqGen: 'host-a:42', gen: 'host-a:42' })).toBe(
      'quiet',
    );
  });

  it('labels a genuine mismatch, which is the population EI-20582609088583997 is about', () => {
    expect(coordFoldReason({ changed: true, forceResync: false, reqGen: 'host-a:41', gen: 'host-a:42' })).toBe(
      'generation-mismatch',
    );
  });

  it('labels a globally advanced but owner-irrelevant fold directly', () => {
    expect(coordFoldReason({ changed: false, forceResync: false, reqGen: 'host-a:41', gen: 'host-a:42' })).toBe(
      'owner-irrelevant',
    );
  });

  it("force-resync wins over everything, matching the fold's own || ordering", () => {
    expect(coordFoldReason({ changed: true, forceResync: true, reqGen: 'host-a:42', gen: 'host-a:42' })).toBe(
      'force-resync',
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])(
    'separates a first call (%s client generation) from a real mismatch — it is legitimately expensive, not gate evidence',
    (_label, reqGen) => {
      expect(coordFoldReason({ changed: true, forceResync: false, reqGen, gen: 'host-a:42' })).toBe(
        'no-client-generation',
      );
    },
  );
});

describe('censusCoordFold', () => {
  it('stamps the version so a window spanning a shape change is detectable', () => {
    expect(censusCoordFold(observation())).toMatchObject({
      v: COORD_FOLD_CENSUS_VERSION,
      changed: true,
      reason: 'generation-mismatch',
      complete: true,
      foldMs: 120,
      gateMs: 20,
      hydrateMs: 100,
      reqGen: 'host-a:41',
      gen: 'host-a:42',
      inboxAdvanced: false,
      inboxTotal: 0,
    });
  });

  it('reports the `changed` it was GIVEN rather than re-deriving one it might disagree with', () => {
    // A deliberately inconsistent input: the labeller would say 'quiet', but the
    // fold acted on changed=true. The census must report the fold's decision —
    // an instrument that overrode it would report its own disagreement as data.
    const census = censusCoordFold(observation({ changed: true, reqGen: 'host-a:42', gen: 'host-a:42' }));
    expect(census.changed).toBe(true);
    expect(census.reason).toBe('quiet');
  });

  it('normalises an empty client generation to null so `reqGen IS NULL` is a clean SQL predicate', () => {
    expect(censusCoordFold(observation({ reqGen: '' })).reqGen).toBeNull();
    expect(censusCoordFold(observation({ reqGen: undefined })).reqGen).toBeNull();
  });

  it('coerces nonsense timings to 0 rather than writing NaN into jsonb, which would poison avg()', () => {
    const census = censusCoordFold(
      observation({ foldMs: Number.NaN, gateMs: -5, hydrateMs: Number.POSITIVE_INFINITY }),
    );
    expect(census).toMatchObject({ foldMs: 0, gateMs: 0, hydrateMs: 0 });
  });

  it('keeps an unreadable inbox total as null, distinct from a real 0', () => {
    expect(censusCoordFold(observation({ inboxTotal: null })).inboxTotal).toBeNull();
    expect(censusCoordFold(observation({ inboxTotal: 0 })).inboxTotal).toBe(0);
  });

  it('records actual glance hydration independently from the inbox gate', () => {
    expect(censusCoordFold(observation({ changed: true, glanceHydrated: false })).glanceHydrated).toBe(false);
    expect(censusCoordFold(observation({ changed: false, glanceOnly: true, glanceHydrated: true })).glanceHydrated).toBe(true);
  });
});

describe('coordFoldObserverFor', () => {
  it('publishes under the documented key, which is what the read query greps for', () => {
    const metadata = vi.fn();
    const observe = coordFoldObserverFor({ metadata });
    observe?.(censusCoordFold(observation()));
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0]?.[0]).toHaveProperty(COORD_FOLD_CENSUS_KEY);
    expect(metadata.mock.calls[0]?.[0]?.[COORD_FOLD_CENSUS_KEY]).toMatchObject({
      v: COORD_FOLD_CENSUS_VERSION,
      reason: 'generation-mismatch',
    });
  });

  it.each([
    ['a ctx with no metadata channel', {}],
    ['a non-function metadata field', { metadata: 'nope' }],
    ['null', null],
    ['undefined', undefined],
  ])('returns undefined for %s, so a non-tool caller wires nothing instead of throwing', (_l, ctx) => {
    expect(coordFoldObserverFor(ctx)).toBeUndefined();
  });

  it("swallows a throwing sink — this rides the fleet's synchronous hook path", () => {
    const observe = coordFoldObserverFor({
      metadata: () => {
        throw new Error('metadata channel exploded');
      },
    });
    expect(() => observe?.(censusCoordFold(observation()))).not.toThrow();
  });
});
