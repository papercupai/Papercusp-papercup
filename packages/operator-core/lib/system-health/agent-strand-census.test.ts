import { describe, expect, it, vi } from 'vitest';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import {
  AGENT_STRAND_SAMPLE_SIZE,
  formatWedgedByClass,
  readAgentStrandCensus,
  summarizeAgentStrand,
} from './agent-strand-census';

// P-011(b), plan parked-agent-census-resumption-and-root-cause-2026-10-09: the census COUNTS the
// oracle's `wedged` verdict and silent-halt's `halted` list. It never re-derives either.

type V = Pick<LivenessVerdict, 'wedged'>;

function verdicts(entries: Array<[string, V['wedged']]>): Map<string, V> {
  return new Map(entries.map(([id, wedged]) => [id, wedged === undefined ? {} : { wedged }]));
}

describe('summarizeAgentStrand', () => {
  it('counts only verdicts that carry wedged, by class', () => {
    const s = summarizeAgentStrand(
      verdicts([
        ['a', 'quota-blocked'],
        ['b', 'quota-blocked'],
        ['c', 'unbound-successor'],
        ['d', undefined],
        ['e', 'pending-turn-stuck'],
        ['f', 'auth-blocked'],
      ]),
      [],
    );
    expect(s.checked).toBe(6);
    expect(s.wedged).toBe(5);
    expect(s.wedgedByClass).toEqual({
      'auth-blocked': 1,
      'quota-blocked': 2,
      'unbound-successor': 1,
      'pending-turn-stuck': 1,
    });
    expect(s.wedgedSample).toEqual(['a', 'b', 'c', 'e', 'f']);
    expect(s.wedgedUnreadable).toBe(false);
  });

  it('a roster with no wedged verdict counts zero, and says it was read', () => {
    const s = summarizeAgentStrand(verdicts([['a', undefined], ['b', undefined]]), []);
    expect(s.wedged).toBe(0);
    expect(s.checked).toBe(2);
    expect(s.wedgedUnreadable).toBe(false);
    expect(s.strandedUnreadable).toBe(false);
  });

  it('counts stranded owners once each and samples deterministically', () => {
    const halted = Array.from({ length: AGENT_STRAND_SAMPLE_SIZE + 3 }, (_, i) => `su-${String(i).padStart(2, '0')}`);
    const s = summarizeAgentStrand(new Map(), [...halted, halted[0]!]);
    expect(s.stranded).toBe(halted.length);
    expect(s.strandedSample).toHaveLength(AGENT_STRAND_SAMPLE_SIZE);
    expect(s.strandedSample[0]).toBe('su-00');
  });

  it('a failed read is UNREADABLE, never a confident zero', () => {
    const s = summarizeAgentStrand(null, null);
    expect(s.wedged).toBe(0);
    expect(s.stranded).toBe(0);
    expect(s.wedgedUnreadable).toBe(true);
    expect(s.strandedUnreadable).toBe(true);
  });
});

describe('formatWedgedByClass', () => {
  it('lists non-zero classes, largest first', () => {
    expect(
      formatWedgedByClass({ 'auth-blocked': 0, 'quota-blocked': 29, 'unbound-successor': 5, 'pending-turn-stuck': 7 }),
    ).toBe('quota-blocked 29, pending-turn-stuck 7, unbound-successor 5');
  });
});

describe('readAgentStrandCensus', () => {
  it('passes the roster to the oracle and folds both legs', async () => {
    let seen: string[] = [];
    const s = await readAgentStrandCensus('ws', {
      readSubjects: async () => [{ ownerId: 'a' }, { ownerId: 'b' }],
      resolveStates: async (subjects) => {
        seen = subjects.map((x) => x.ownerId);
        return new Map([
          ['a', { wedged: 'quota-blocked' } as LivenessVerdict],
          ['b', {} as LivenessVerdict],
        ]);
      },
      readHalted: async () => ['c'],
    });
    expect(seen).toEqual(['a', 'b']);
    expect(s.wedged).toBe(1);
    expect(s.stranded).toBe(1);
  });

  it('one failing leg is reported unreadable while the other still counts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await readAgentStrandCensus('ws', {
      readSubjects: async () => [{ ownerId: 'a' }],
      resolveStates: async () => {
        throw new Error('oracle down');
      },
      readHalted: async () => ['x', 'y'],
    });
    expect(s.wedgedUnreadable).toBe(true);
    expect(s.strandedUnreadable).toBe(false);
    expect(s.stranded).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wedged read failed: oracle down'));
    warn.mockRestore();
  });

  it('a failing stranded leg is reported unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await readAgentStrandCensus('ws', {
      readSubjects: async () => [],
      resolveStates: async () => new Map(),
      readHalted: async () => {
        throw new Error('sweep failed');
      },
    });
    expect(s.strandedUnreadable).toBe(true);
    expect(s.wedgedUnreadable).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stranded read failed: sweep failed'));
    warn.mockRestore();
  });
});
