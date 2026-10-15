import { describe, expect, it, vi } from 'vitest';
import { hostname } from 'node:os';
import {
  countStarts,
  evaluateReading,
  runRestartRateSweepOnce,
  RESTART_RATE_THRESHOLD_PER_HOUR,
  type RestartRateReading,
} from './service-restart-rate-watchdog';
import type { JournalReadResult } from '../journal-read';

const UNIT = 'papercusp-staging-api.service';

/** A journal read result with the healthy defaults; override what a case is about. */
function read(over: Partial<JournalReadResult> = {}): JournalReadResult {
  return {
    entries: [],
    matched: 0,
    collapsed: 0,
    truncated: false,
    // `resolved: null` = the absolute window was NOT resolved (P-022) — correct
    // for this fixture, which is never on readJournal's zero-row diagnosis path.
    window: { since: '-1h', until: null, resolved: null },
    units: [UNIT],
    journalAvailable: true,
    backend: 'systemd',
    journalError: null,
    unitsUnknown: [],
    windowOutsideJournal: null,
    command: 'journalctl ...',
    ...over,
  };
}

function reading(over: Partial<RestartRateReading> = {}): RestartRateReading {
  return { unit: UNIT, starts: 0, atLeast: false, unreadable: null, ...over };
}

function quietRail() {
  return { broadcast: async () => true, resolve: async () => true };
}

describe('countStarts (EI-18741922664751805)', () => {
  it('counts pre-dedup lines, NOT collapsed entries — the trap that would report 1 for a 40x storm', () => {
    // collapseConsecutive merges runs of identical (unit, message) lines, and
    // successive "Started <unit>" messages ARE identical. A 40-restart storm
    // therefore arrives as ONE entry with repeat:40.
    const result = read({
      matched: 40,
      collapsed: 39,
      entries: [
        {
          ts: '2026-07-26T16:00:00.000Z',
          unit: UNIT,
          level: 'info',
          message: `Started ${UNIT} - Papercusp operator STAGING host (:3170)`,
          repeat: 40,
          lastTs: '2026-07-26T16:59:00.000Z',
        },
      ],
    });
    expect(result.entries).toHaveLength(1); // what a naive implementation would count
    expect(countStarts(UNIT, result).starts).toBe(40);
  });

  it('reports an absent journal as unreadable, never as zero restarts', () => {
    const r = countStarts(UNIT, read({ journalAvailable: false }));
    expect(r.starts).toBeNull();
    expect(r.unreadable).toMatch(/no systemd journal/i);
  });

  it('reports a failed read as unreadable, never as zero restarts', () => {
    const r = countStarts(UNIT, read({ journalError: 'permission denied' }));
    expect(r.starts).toBeNull();
    expect(r.unreadable).toMatch(/permission denied/);
  });

  it('reports an unknown unit name as unreadable, never as a quiet healthy service', () => {
    const r = countStarts(UNIT, read({ unitsUnknown: [UNIT] }));
    expect(r.starts).toBeNull();
    expect(r.unreadable).toMatch(/does not know this unit/i);
  });

  it('marks a row-capped read as a FLOOR rather than an exact total', () => {
    const r = countStarts(UNIT, read({ matched: 201, truncated: true }));
    expect(r).toMatchObject({ starts: 201, atLeast: true, unreadable: null });
  });
});

describe('evaluateReading', () => {
  it('does not alarm at or below the threshold', () => {
    expect(evaluateReading(reading({ starts: RESTART_RATE_THRESHOLD_PER_HOUR }))).toBeNull();
    expect(evaluateReading(reading({ starts: RESTART_RATE_THRESHOLD_PER_HOUR - 1 }))).toBeNull();
  });

  it('alarms above the threshold', () => {
    const alert = evaluateReading(reading({ starts: RESTART_RATE_THRESHOLD_PER_HOUR + 1 }));
    expect(alert).toMatchObject({ unit: UNIT, starts: RESTART_RATE_THRESHOLD_PER_HOUR + 1 });
  });

  it('never alarms on an unreadable journal, however alarming it would look as 0', () => {
    expect(evaluateReading(reading({ starts: null, unreadable: 'no systemd' }))).toBeNull();
  });

  it('separates the measured pre-fix storm from the measured post-fix steady state', () => {
    // The numbers this threshold was derived from — see the module header.
    for (const preFix of [9, 10]) {
      expect(evaluateReading(reading({ starts: preFix }))).not.toBeNull();
    }
    for (const postFix of [1, 2, 4, 6]) {
      expect(evaluateReading(reading({ starts: postFix }))).toBeNull();
    }
  });
});

describe('runRestartRateSweepOnce', () => {
  it('reads the canonical operator units by default', async () => {
    const readStarts = vi.fn(async (unit: string) => reading({ unit, starts: 0 }));
    const result = await runRestartRateSweepOnce({
      flagEnabled: async () => true,
      readStarts,
      rail: quietRail(),
      escalate: vi.fn(async () => {}),
    });
    expect(readStarts.mock.calls.map(([unit]) => unit)).toEqual([
      'papercusp-dev-api.service',
      'papercusp-staging-api.service',
    ]);
    expect(result).toEqual({ alerts: [], unreadable: [], skipped: false });
  });

  it('skips entirely (no journal read) when the flag is OFF', async () => {
    const readStarts = vi.fn();
    const result = await runRestartRateSweepOnce({ flagEnabled: async () => false, readStarts, rail: quietRail() });
    expect(result).toEqual({ alerts: [], unreadable: [], skipped: true });
    expect(readStarts).not.toHaveBeenCalled();
  });

  it('escalates once per breaching unit and leaves healthy units alone', async () => {
    const escalate = vi.fn(async () => {});
    const result = await runRestartRateSweepOnce({
      flagEnabled: async () => true,
      units: ['a.service', 'b.service'],
      rail: quietRail(),
      threshold: 8,
      readStarts: async (unit) =>
        reading({ unit, starts: unit === 'a.service' ? 12 : 3 }),
      escalate,
    });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ unit: 'a.service', starts: 12 }));
    expect(result.alerts).toHaveLength(1);
  });

  it('keeps sweeping the remaining units when one unit is unreadable', async () => {
    const escalate = vi.fn(async () => {});
    const result = await runRestartRateSweepOnce({
      flagEnabled: async () => true,
      units: ['broken.service', 'b.service'],
      rail: quietRail(),
      threshold: 8,
      readStarts: async (unit) =>
        unit === 'broken.service'
          ? reading({ unit, starts: null, unreadable: 'systemd does not know this unit' })
          : reading({ unit, starts: 20 }),
      escalate,
    });
    expect(result.unreadable).toHaveLength(1);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ unit: 'b.service' }));
  });

  it('records a throwing journal read as unreadable instead of failing the sweep', async () => {
    const escalate = vi.fn(async () => {});
    const result = await runRestartRateSweepOnce({
      flagEnabled: async () => true,
      units: ['boom.service', 'b.service'],
      rail: quietRail(),
      threshold: 8,
      readStarts: async (unit) => {
        if (unit === 'boom.service') throw new Error('journalctl exploded');
        return reading({ unit, starts: 20 });
      },
      escalate,
    });
    expect(result.unreadable[0]).toMatchObject({ unit: 'boom.service' });
    expect(result.unreadable[0].unreadable).toMatch(/exploded/);
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ unit: 'b.service' }));
  });

  it('does not abort the sweep when escalating one unit fails', async () => {
    const escalate = vi.fn(async (a: { unit: string }) => {
      if (a.unit === 'a.service') throw new Error('escalation store down');
    });
    const result = await runRestartRateSweepOnce({
      flagEnabled: async () => true,
      units: ['a.service', 'b.service'],
      rail: quietRail(),
      threshold: 8,
      readStarts: async (unit) => reading({ unit, starts: 20 }),
      escalate,
    });
    expect(escalate).toHaveBeenCalledTimes(2);
    // 'a' failed to escalate so it is not reported as alerted; 'b' still is.
    expect(result.alerts).toEqual([expect.objectContaining({ unit: 'b.service' })]);
  });

  it('preserves a host/unit episode through unavailable, truncated and disabled reads, then resolves measured recovery', async () => {
    const open = new Set<string>();
    const broadcast = vi.fn(async (event: { conditionKey?: string }) => { open.add(event.conditionKey!); return true; });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    const key = `alarm:service-restart-rate:${encodeURIComponent(hostname())}:${UNIT}`;
    let current = reading({ starts: 20 });
    const deps = { units: [UNIT], flagEnabled: async () => true, rail: { broadcast, resolve },
      readStarts: async () => current, escalate: async () => { throw new Error('legacy failed'); } };
    await runRestartRateSweepOnce(deps);
    expect([...open]).toEqual([key]);
    for (const unknown of [reading({ starts: null, unreadable: 'journal unavailable' }),
      reading({ starts: null }), reading({ starts: 1, atLeast: true })]) {
      current = unknown; await runRestartRateSweepOnce(deps);
      expect([...open]).toEqual([key]);
    }
    await runRestartRateSweepOnce({ ...deps, readStarts: async () => { throw new Error('journal failed'); } });
    current = reading({ starts: 1 });
    await runRestartRateSweepOnce({ ...deps, flagEnabled: async () => false });
    expect(resolve).not.toHaveBeenCalled();
    await runRestartRateSweepOnce(deps);
    expect(open.size).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'service-restart-rate-watchdog recovered' });
  });
});
