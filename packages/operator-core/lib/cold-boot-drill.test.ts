/** cold-boot-drill (P-020): the consumer-side carry-sufficiency grader — classify a
 *  cold successor's recovery lookups (builder gap vs orthogonal vs noise) and score
 *  per session class into a `sufficient` verdict that drives P-021/P-026. Pure
 *  grader + scorer; the chaos actuation + trace-extraction are deferred live legs. */
import { describe, it, expect } from 'vitest';
import {
  RECALL_NOISE_FLOOR,
  DEFAULT_SUFFICIENCY_PARAMS,
  classifyRecoveryLookup,
  extractRecoveryLookups,
  inferRecoveryCarryClass,
  gradeColdBootDrills,
  type RecoveryLookup,
  type DrillSample,
} from './cold-boot-drill';
import type { ReplayTurn } from './replay/types';

describe('classifyRecoveryLookup — pure', () => {
  it('mem0-search is orthogonal even when it targets a carry class (mem0 ⟂ compaction)', () => {
    expect(classifyRecoveryLookup({ kind: 'mem0-search', targetClass: 'facts' })).toBe('orthogonal');
  });

  it('a sub-noise-floor orient-recall-fold is noise (P-026: 0.023–0.033 = noise)', () => {
    expect(classifyRecoveryLookup({ kind: 'orient-recall-fold', targetClass: 'facts', similarity: 0.03 })).toBe('noise');
    // missing similarity defaults to 0 ⇒ below floor ⇒ noise
    expect(classifyRecoveryLookup({ kind: 'orient-recall-fold', targetClass: 'facts' })).toBe('noise');
  });

  it('an above-floor recall fold on a carry class is a builder gap; on a non-carry it is orthogonal', () => {
    expect(classifyRecoveryLookup({ kind: 'orient-recall-fold', targetClass: 'held-wi', similarity: 0.4 })).toBe('gap');
    expect(classifyRecoveryLookup({ kind: 'orient-recall-fold', targetClass: null, similarity: 0.4 })).toBe('orthogonal');
    expect(RECALL_NOISE_FLOOR).toBe(0.05);
  });

  it('a self-search for carry-class state the carry LACKED is a hard gap', () => {
    expect(classifyRecoveryLookup({ kind: 'self-search', targetClass: 'owner-directive' })).toBe('gap');
    expect(classifyRecoveryLookup({ kind: 'self-search', targetClass: 'owner-directive', recoveredInCarry: false })).toBe('gap');
  });

  it('a self-search for carry-class state the carry HAD is a surfacing gap', () => {
    expect(classifyRecoveryLookup({ kind: 'self-read', targetClass: 'loop-note', recoveredInCarry: true })).toBe('surfacing-gap');
  });

  it('a lookup with no carry-class target (genuine fresh work) is orthogonal', () => {
    expect(classifyRecoveryLookup({ kind: 'reread-state', targetClass: null })).toBe('orthogonal');
    expect(classifyRecoveryLookup({ kind: 'self-search' })).toBe('orthogonal');
    expect(classifyRecoveryLookup({ kind: 'other', targetClass: 'facts' })).toBe('gap'); // 'other' still honors carry-class
  });
});

describe('gradeColdBootDrills — per-class sufficiency', () => {
  const cleanDrills = (cls: string, n: number): DrillSample[] =>
    Array.from({ length: n }, () => ({ sessionClass: cls, lookups: [] as RecoveryLookup[] }));

  it('one clean class smoke is sufficient under the owner-shortened release gate', () => {
    const rep = gradeColdBootDrills(cleanDrills('claude-interactive', 1));
    const c = rep.perClass[0];
    expect(c).toMatchObject({ drills: 1, gaps: 0, surfacingGaps: 0, gapsPerDrill: 0, sufficient: true });
    expect(rep.sufficientClasses).toEqual(['claude-interactive']);
  });

  it('is NOT sufficient with no drill evidence', () => {
    const rep = gradeColdBootDrills([]);
    expect(rep.perClass).toEqual([]);
    expect(rep.sufficientClasses).toEqual([]);
  });

  it('a single hard gap over the drills breaks sufficiency (default max 0)', () => {
    const drills = [
      ...cleanDrills('c', 10),
      { sessionClass: 'c', lookups: [{ kind: 'self-search', targetClass: 'held-wi' } as RecoveryLookup] },
    ];
    const rep = gradeColdBootDrills(drills);
    const c = rep.perClass[0];
    expect(c.gaps).toBe(1);
    expect(c.gapsPerDrill).toBeCloseTo(1 / 11);
    expect(c.sufficient).toBe(false);
  });

  it('counts surfacing gaps by default, but not when countSurfacingGaps is false', () => {
    const drills: DrillSample[] = [
      ...cleanDrills('c', 10),
      { sessionClass: 'c', lookups: [{ kind: 'self-read', targetClass: 'loop-note', recoveredInCarry: true }] },
    ];
    const counted = gradeColdBootDrills(drills); // default true
    expect(counted.perClass[0].surfacingGaps).toBe(1);
    expect(counted.perClass[0].sufficient).toBe(false);

    const ignored = gradeColdBootDrills(drills, { maxGapsPerDrill: 0, minDrills: 10, countSurfacingGaps: false });
    expect(ignored.perClass[0].surfacingGaps).toBe(1);
    expect(ignored.perClass[0].gapsPerDrill).toBe(0); // surfacing not counted
    expect(ignored.perClass[0].sufficient).toBe(true);
  });

  it('noise and orthogonal lookups never count against sufficiency', () => {
    const drills: DrillSample[] = Array.from({ length: 10 }, () => ({
      sessionClass: 'c',
      lookups: [
        { kind: 'orient-recall-fold', targetClass: 'facts', similarity: 0.02 }, // noise
        { kind: 'mem0-search', targetClass: 'facts' }, // orthogonal
        { kind: 'self-search', targetClass: null }, // orthogonal
      ] as RecoveryLookup[],
    }));
    const rep = gradeColdBootDrills(drills);
    expect(rep.perClass[0]).toMatchObject({ gaps: 0, surfacingGaps: 0, sufficient: true });
  });

  it('a custom maxGapsPerDrill tolerates a small nonzero gap rate', () => {
    const drills = [
      ...cleanDrills('c', 19),
      { sessionClass: 'c', lookups: [{ kind: 'self-search', targetClass: 'facts' } as RecoveryLookup] },
    ];
    expect(gradeColdBootDrills(drills).perClass[0].sufficient).toBe(false); // 1/20=0.05 > 0
    expect(
      gradeColdBootDrills(drills, { maxGapsPerDrill: 0.05, minDrills: 10, countSurfacingGaps: true }).perClass[0].sufficient,
    ).toBe(true);
  });

  it('aggregates and sorts multiple classes independently', () => {
    const rep = gradeColdBootDrills(
      [
        ...cleanDrills('zeta', 10),
        ...cleanDrills('alpha', 3),
      ],
      { ...DEFAULT_SUFFICIENCY_PARAMS, minDrills: 10 },
    );
    expect(rep.perClass.map((c) => c.sessionClass)).toEqual(['alpha', 'zeta']);
    expect(rep.sufficientClasses).toEqual(['zeta']);
  });

  it('exposes the documented default sufficiency params', () => {
    expect(DEFAULT_SUFFICIENCY_PARAMS).toEqual({ maxGapsPerDrill: 0, minDrills: 1, countSurfacingGaps: true });
  });
});

describe('extractRecoveryLookups — successor first-window trace', () => {
  const turn = (index: number, toolName: string, input: unknown): ReplayTurn => ({
    index,
    role: 'tool_use',
    toolName,
    text: JSON.stringify(input),
  });
  const carry = [
    '## Identity',
    'ownerId: su-1',
    '## Plan state (your claimed / in-flight items)',
    'WI-4852 — cold-boot drills',
    '## Verbatim tail (most recent turns; tool outputs are pointers)',
    'continue P-020',
  ].join('\n');

  it('recognizes carry classes from recovery intent', () => {
    expect(inferRecoveryCarryClass('recover WI-4852 checkpoint')).toBe('held-wi');
    expect(inferRecoveryCarryClass('what was the owner directive?')).toBe('owner-directive');
    expect(inferRecoveryCarryClass('read the prior transcript tail')).toBe('recent-tail');
    expect(inferRecoveryCarryClass('ordinary source code')).toBeNull();
  });

  it('classifies explicit self-history and state rereads, including surfacing vs hard gaps', () => {
    const out = extractRecoveryLookups([
      turn(0, 'mcp__papercusp-su__sessions_search', { session: 'self', query: 'recent transcript tail' }),
      turn(1, 'work_items:get', { id: 'WI-4852' }),
      turn(2, 'plans:get', { slug: 'missing-plan-slug' }),
      turn(3, 'functions.exec', { cmd: 'sed -n 1,40p source.ts' }), // normal work: ignored
    ], carry);
    expect(out).toEqual([
      { kind: 'self-search', targetClass: 'recent-tail', recoveredInCarry: true },
      {
        kind: 'reread-state',
        targetClass: 'held-wi',
        recoveredInCarry: true,
        targetRefs: ['WI-4852'],
        targetPath: 'results[].workItem.state',
      },
      { kind: 'reread-state', targetClass: 'plan-state', recoveredInCarry: false },
    ]);
    expect(out.map(classifyRecoveryLookup)).toEqual(['surfacing-gap', 'surfacing-gap', 'gap']);
  });

  it('keeps mem0 orthogonal, ignores other-session reads, and stops at its own grade call', () => {
    const out = extractRecoveryLookups([
      turn(0, 'sessions:read', { session: 'someone-else' }),
      turn(1, 'memory:search', { query: 'facts from last month' }),
      turn(2, 'session:carry-drill', { op: 'grade', drillId: 'd1' }),
      turn(3, 'sessions:search', { session: 'self', query: 'tail' }),
    ], carry);
    expect(out).toEqual([{ kind: 'mem0-search', targetClass: 'facts' }]);
    expect(classifyRecoveryLookup(out[0])).toBe('orthogonal');
  });

  it('extracts orient recall scores and applies the P-026 noise floor', () => {
    const turns: ReplayTurn[] = [
      turn(0, 'coord:orient', { afterCompaction: true }),
      { index: 1, role: 'tool_result', text: '{"recall":[{"text":"held WI checkpoint","similarity":0.03},{"text":"plan state","score":0.22}]}' },
    ];
    const out = extractRecoveryLookups(turns, carry);
    expect(out).toHaveLength(2);
    expect(out.map(classifyRecoveryLookup)).toEqual(['noise', 'gap']);
  });
});
