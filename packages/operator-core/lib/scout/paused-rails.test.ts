/**
 * Plan scout-su-ideate-pipeline-gaps-2026-10-08 P-002 (BARs R-2 / R-3): paused-rail
 * liveness and the 'unresolvable' outcome it drives.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChangeFeedEntry } from '../curation/change-feed';
import { CREATIVE_LENSES } from './types';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  tallyRoutedOutcomes,
  type RoutedIdeaProvenance,
} from './outcome-feedback';
import { pausedRailsFrom, readPausedRails } from './paused-rails';

vi.mock('../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const lens = CREATIVE_LENSES[0];
const idea = (over: Partial<RoutedIdeaProvenance> = {}): RoutedIdeaProvenance => ({
  ideaId: 'i1',
  lens,
  rail: 'gym',
  routedRef: 'gym:SP-mekkv1x2-001',
  ...over,
});
const accepted = (ref: string): ChangeFeedEntry =>
  ({ ref, kind: 'proposal', title: `Accepted ${ref}`, detail: 'Status: accepted', at: '2026-10-01T00:00:00Z' }) as unknown as ChangeFeedEntry;
const GYM_PAUSED = { pausedRails: new Set(['gym'] as const) };

describe('pausedRailsFrom — the gym rail is live only when an enabled autoloop has an active gym-cycle routine', () => {
  it('enabled autoloop + active gym-cycle routine on the same harness → nothing paused', () => {
    const paused = pausedRailsFrom({
      autoloops: [{ harnessSlug: 'papercusp', enabled: true }],
      gymCycleRoutines: [{ installSlug: 'papercusp', active: true }],
    });
    expect([...paused]).toEqual([]);
  });

  it("the owner's 2026-10-08 pause shape (routine inactive, autoloop flag still on) → gym paused", () => {
    const paused = pausedRailsFrom({
      autoloops: [{ harnessSlug: 'papercusp', enabled: true }],
      gymCycleRoutines: [{ installSlug: 'papercusp', active: false }],
    });
    expect(paused.has('gym')).toBe(true);
  });

  it('disabled autoloop → gym paused even with an active routine', () => {
    expect(
      pausedRailsFrom({
        autoloops: [{ harnessSlug: 'papercusp', enabled: false }],
        gymCycleRoutines: [{ installSlug: 'papercusp', active: true }],
      }).has('gym'),
    ).toBe(true);
  });

  it('enabled autoloop and active routine on DIFFERENT harnesses → gym paused (no harness has both)', () => {
    expect(
      pausedRailsFrom({
        autoloops: [{ harnessSlug: 'a', enabled: true }],
        gymCycleRoutines: [{ installSlug: 'b', active: true }],
      }).has('gym'),
    ).toBe(true);
  });

  it('no gym-cycle routine at all → gym paused', () => {
    expect(pausedRailsFrom({ autoloops: [{ harnessSlug: 'p', enabled: true }], gymCycleRoutines: [] }).has('gym')).toBe(true);
  });

  it('readPausedRails fails OPEN (nothing paused) when the read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingSql = (() => {
      throw new Error('db down');
    }) as unknown as Parameters<typeof readPausedRails>[0];
    const paused = await readPausedRails(throwingSql, 'ws');
    expect([...paused]).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("classifyIdeaOutcome — a routed idea on a paused rail carries outcome 'unresolvable' (R-2)", () => {
  it('no terminal record + gym paused → unresolvable', () => {
    expect(classifyIdeaOutcome(idea(), new Map(), GYM_PAUSED)).toBe('unresolvable');
  });

  it('CONTROL: no terminal record + gym live → pending (the pause is what makes it unresolvable)', () => {
    expect(classifyIdeaOutcome(idea(), new Map())).toBe('pending');
    expect(classifyIdeaOutcome(idea(), new Map(), { pausedRails: new Set() })).toBe('pending');
  });

  it('a verdict reached before the pause still decides the idea', () => {
    const feed = new Map([[idea().routedRef, accepted(idea().routedRef)]]);
    expect(classifyIdeaOutcome(idea(), feed, GYM_PAUSED)).toBe('won');
  });

  it('the pause is rail-scoped: an improvement-rail idea with no record stays pending', () => {
    expect(classifyIdeaOutcome(idea({ rail: 'improvement', routedRef: 'wi:EI-1' }), new Map(), GYM_PAUSED)).toBe('pending');
  });
});

describe('unresolvable ideas leave every win-rate denominator (R-3)', () => {
  it('computeLensOutcomes: an ungraded paused-rail idea counts in `unresolvable`, not routed/pending', () => {
    const report = computeLensOutcomes([idea({ ideaId: 'g1' }), idea({ ideaId: 'g2', rail: 'improvement', routedRef: 'wi:EI-9' })], [], {
      ...GYM_PAUSED,
    });
    const stat = report.byLens[lens];
    expect(stat.unresolvable).toBe(1);
    expect(stat.routed).toBe(1);
    expect(stat.pending).toBe(1);
    expect(stat.won + stat.lost + stat.pending).toBe(stat.routed);
  });

  it('computeLensOutcomes: a GRADED paused-rail idea still counts — the grade decides it', () => {
    const report = computeLensOutcomes([idea({ humanGrade: 5 })], [], { ...GYM_PAUSED });
    const stat = report.byLens[lens];
    expect(stat.unresolvable).toBe(0);
    expect(stat.routed).toBe(1);
    expect(stat.winRate).toBe(1);
  });

  it('tallyRoutedOutcomes: cached unresolvable and paused-rail pending rows are outside the denominator', () => {
    const ideas = [
      idea({ ideaId: 'w', rail: 'improvement', routedRef: 'wi:1', outcome: 'won' }),
      idea({ ideaId: 'l', rail: 'improvement', routedRef: 'wi:2', outcome: 'lost' }),
      idea({ ideaId: 'p', rail: 'improvement', routedRef: 'wi:3', outcome: 'pending' }),
      idea({ ideaId: 'u', routedRef: 'gym:SP-001', outcome: 'unresolvable' }),
      idea({ ideaId: 'gp', outcome: 'pending' }),
      idea({ ideaId: 'gn' }),
    ];
    const t = tallyRoutedOutcomes(ideas, GYM_PAUSED);
    expect(t).toEqual({ routed: 3, won: 1, lost: 1, pending: 1, unresolvable: 3, decided: 2, winRate: 0.5 });
    // CONTROL: with the gym live, only the cached-unresolvable row is excluded.
    const live = tallyRoutedOutcomes(ideas);
    expect(live.unresolvable).toBe(1);
    expect(live.pending).toBe(3);
    expect(live.routed).toBe(5);
  });
});
