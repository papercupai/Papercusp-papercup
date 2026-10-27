/**
 * generation-preflight-guard — WI-10007380 / plan scout-su-ideate-pipeline-gaps-2026-10-08
 * P-003. BARs: R-4 (no paid generation under a deep throttle), R-5 (none after a
 * high dedup rate), R-6 (a skipped cycle records why). The runner-level wiring
 * (no runScoutTick call, gated tick recorded) is covered in run.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  assessGenerationPreflight,
  defaultSkipStreak,
  leadingDedupSkips,
  GENERATION_PREFLIGHT_GATE,
  type GenerationPreflightTick,
} from './generation-preflight-guard';

const saturatedRan = (n: number, generated = 10, deduped = 9): GenerationPreflightTick[] =>
  Array.from({ length: n }, () => ({ status: 'ran', ideasGenerated: generated, ideasDeduped: deduped, ideasRouted: 0 }));
const novelRan: GenerationPreflightTick = { status: 'ran', ideasGenerated: 10, ideasDeduped: 2, ideasRouted: 3 };
const skipTick = (reason: string): GenerationPreflightTick => ({
  status: 'gated',
  gate: GENERATION_PREFLIGHT_GATE,
  detail: { reason },
});

const pressure = (level: 'normal' | 'elevated' | 'deep') => ({
  level,
  pending: level === 'deep' ? 197 : 5,
  p95Ms: level === 'deep' ? 1_720_000_000 : 1_000,
  reasons: [`${level} queue`],
});

describe('assessGenerationPreflight — deep admission throttle (R-4, R-6)', () => {
  it('skips paid generation under a deep throttle and records the throttle evidence', () => {
    const v = assessGenerationPreflight({ admissionPressure: pressure('deep') });
    expect(v).toEqual({
      skip: true,
      reason: 'admission-throttle-deep',
      detail: {
        reason: 'admission-throttle-deep',
        pending: 197,
        p95Ms: 1_720_000_000,
        throttleReasons: ['deep queue'],
      },
    });
  });

  it('a deep throttle wins even when the dedup history is novel', () => {
    const v = assessGenerationPreflight({ admissionPressure: pressure('deep'), recentTicksNewestFirst: [novelRan] });
    expect(v.skip).toBe(true);
  });

  it('does not skip under an elevated or normal throttle (elevated only curbs ideators)', () => {
    for (const level of ['normal', 'elevated'] as const) {
      expect(assessGenerationPreflight({ admissionPressure: pressure(level) }).skip).toBe(false);
    }
  });

  it('fails open when no pressure reading is available', () => {
    expect(assessGenerationPreflight({ admissionPressure: null, recentTicksNewestFirst: null }).skip).toBe(false);
  });
});

describe('assessGenerationPreflight — dedup saturation (R-5, R-6)', () => {
  it('default skip streak is the dedup-burn trigger plus its full widening budget', () => {
    expect(defaultSkipStreak()).toBe(5);
    expect(defaultSkipStreak({ consecutiveCycles: 3, maxWideningSteps: 1 })).toBe(4);
  });

  it('runs while the saturated streak is still inside the widening budget', () => {
    const v = assessGenerationPreflight({ recentTicksNewestFirst: saturatedRan(4) });
    expect(v.skip).toBe(false);
  });

  it('skips once saturation outlasts the widening budget, recording streak, ratio and probe countdown', () => {
    const v = assessGenerationPreflight({ recentTicksNewestFirst: saturatedRan(5) });
    expect(v).toEqual({
      skip: true,
      reason: 'dedup-saturated',
      detail: { reason: 'dedup-saturated', consecutiveSaturated: 5, lastRatio: 0.9, skipStreak: 5, probeIn: 5 },
    });
  });

  it('a novel cycle breaks the streak, so generation resumes', () => {
    const v = assessGenerationPreflight({ recentTicksNewestFirst: [novelRan, ...saturatedRan(8)] });
    expect(v.skip).toBe(false);
  });

  it('runs a probe cycle after probeEvery consecutive dedup skips, so a skip is never permanent', () => {
    const ticks = [...Array.from({ length: 5 }, () => skipTick('dedup-saturated')), ...saturatedRan(6)];
    const v = assessGenerationPreflight({ recentTicksNewestFirst: ticks });
    expect(v).toMatchObject({ skip: false, probe: true });
  });

  it('counts down toward the probe as dedup skips accumulate', () => {
    const ticks = [...Array.from({ length: 3 }, () => skipTick('dedup-saturated')), ...saturatedRan(6)];
    const v = assessGenerationPreflight({ recentTicksNewestFirst: ticks });
    expect(v).toMatchObject({ skip: true, detail: { probeIn: 2 } });
  });
});

describe('leadingDedupSkips', () => {
  it('passes over non-running gates and stops at a ran tick', () => {
    const ticks = [
      skipTick('dedup-saturated'),
      skipTick('admission-throttle-deep'),
      skipTick('dedup-saturated'),
      { status: 'gated', gate: 'workspace-ceiling', detail: { reason: 'workspace-ceiling' } },
      { status: 'ran', ideasGenerated: 4, ideasDeduped: 1 },
      skipTick('dedup-saturated'),
    ] satisfies GenerationPreflightTick[];
    expect(leadingDedupSkips(ticks)).toBe(2);
  });
});
