/**
 * scout-su-ideate-pipeline-gaps-2026-10-08 P-008 / R-17 — weekly owner grading sample.
 * Pure selection + rendering, and the sweep's debounce → select → claim → send flow
 * through injected seams (no PG, no coord).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RoutedIdeaProvenance } from './outcome-feedback';
import {
  formatWeeklyGradingSample,
  isoWeekKey,
  selectWeeklyGradingSample,
  weeklyGradingSampleSize,
  weeklyGradingSampleSweep,
  type WeeklyGradingSampleDeps,
} from './weekly-grading-sample';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function idea(id: string, over: Partial<RoutedIdeaProvenance> = {}): RoutedIdeaProvenance {
  return {
    ideaId: id,
    lens: 'reframing',
    rail: 'work-item',
    routedRef: `wi:${id}`,
    title: `idea ${id}`,
    routedAt: new Date(NOW - 3 * DAY).toISOString(),
    origin: 'scout',
    outcome: 'pending',
    ...over,
  } as RoutedIdeaProvenance;
}

describe('isoWeekKey', () => {
  it('matches ISO-8601 week numbering, including the year boundary', () => {
    expect(isoWeekKey(Date.parse('2026-10-08T12:00:00Z'))).toBe('2026-W41');
    // 2027-01-01 is a Friday → it belongs to 2026's last ISO week.
    expect(isoWeekKey(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    // 2024-12-30 is a Monday → week 1 of ISO year 2025.
    expect(isoWeekKey(Date.parse('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });
});

describe('weeklyGradingSampleSize', () => {
  it('defaults to 5, clamps, and lets <= 0 disable', () => {
    expect(weeklyGradingSampleSize({})).toBe(5);
    expect(weeklyGradingSampleSize({ PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE: '0' })).toBe(0);
    expect(weeklyGradingSampleSize({ PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE: '-3' })).toBe(0);
    expect(weeklyGradingSampleSize({ PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE: '999' })).toBe(25);
    expect(weeklyGradingSampleSize({ PAPERCUSP_SCOUT_WEEKLY_GRADING_SAMPLE_SIZE: 'nope' })).toBe(5);
  });
});

describe('selectWeeklyGradingSample', () => {
  it('excludes non-ideation origins, owner-graded ideas, stale and future rows, and duplicates', () => {
    const rows = [
      idea('keep-scout'),
      idea('keep-legacy-null-origin', { origin: undefined }),
      idea('keep-su-ideate', { origin: 'su-ideate' }),
      idea('drop-agent-review', { origin: 'agent-review' }),
      idea('drop-shadow', { origin: 'shadow-variant' }),
      idea('drop-owner-graded', { humanGrade: 4, gradedBy: 'owner' }),
      idea('keep-agent-graded', { humanGrade: 2, gradedBy: 'auto-grader' }),
      idea('drop-stale', { routedAt: new Date(NOW - 40 * DAY).toISOString() }),
      idea('drop-future', { routedAt: new Date(NOW + DAY).toISOString() }),
      idea('drop-no-date', { routedAt: undefined }),
      idea('keep-scout'),
    ];
    const ids = selectWeeklyGradingSample(rows, { nowMs: NOW, size: 25 }).map((r) => r.ideaId).sort();
    expect(ids).toEqual(['keep-agent-graded', 'keep-legacy-null-origin', 'keep-scout', 'keep-su-ideate']);
  });

  it('stratifies across won / lost / unresolved instead of following the dominant bucket', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => idea(`pending-${i}`, { outcome: 'pending' })),
      idea('won-1', { outcome: 'won' }),
      idea('won-2', { outcome: 'won' }),
      idea('lost-1', { outcome: 'lost' }),
    ];
    const sample = selectWeeklyGradingSample(rows, { nowMs: NOW, size: 5 });
    expect(sample).toHaveLength(5);
    const outcomes = sample.map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'won')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'lost')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'pending')).toHaveLength(2);
    // Falsifier: a naive newest-first slice of this ledger would be all pending.
    expect(rows.slice(0, 5).every((r) => r.outcome === 'pending')).toBe(true);
  });

  it('is deterministic within a week and rotates across weeks', () => {
    const rows = Array.from({ length: 30 }, (_, i) => idea(`p-${i}`, { routedAt: new Date(NOW - DAY).toISOString() }));
    const a = selectWeeklyGradingSample(rows, { nowMs: NOW, size: 5 }).map((r) => r.ideaId);
    const b = selectWeeklyGradingSample([...rows].reverse(), { nowMs: NOW + 60_000, size: 5 }).map((r) => r.ideaId);
    expect(b).toEqual(a);
    const nextWeek = selectWeeklyGradingSample(rows, { nowMs: NOW + 7 * DAY, size: 5, lookbackDays: 28 }).map(
      (r) => r.ideaId,
    );
    expect(nextWeek).not.toEqual(a);
  });

  it('returns nothing for a non-positive size', () => {
    expect(selectWeeklyGradingSample([idea('x')], { nowMs: NOW, size: 0 })).toEqual([]);
  });
});

describe('formatWeeklyGradingSample', () => {
  it('is self-contained: every idea id, its context, and the grading call are in the body', () => {
    const sample = [idea('a1', { outcome: 'won', humanGrade: 3, gradedBy: 'auto-grader' }), idea('b2')];
    const { summary, body } = formatWeeklyGradingSample(sample, '2026-W41');
    expect(summary).toContain('2026-W41');
    expect(summary).toContain('2 routed ideas');
    expect(body).toContain('ideaId a1');
    expect(body).toContain('ideaId b2');
    expect(body).toContain('current grade 3/5 by auto-grader');
    expect(body).toContain('ungraded');
    expect(body).toContain('blender:grade-idea');
  });
});

function deps(over: Partial<WeeklyGradingSampleDeps> = {}) {
  const sent: Array<{ summary: string; body: string }> = [];
  const d: WeeklyGradingSampleDeps = {
    readIdeas: vi.fn(async () => [idea('w', { outcome: 'won' }), idea('l', { outcome: 'lost' }), idea('p')]),
    firedWithinWindow: vi.fn(async () => false),
    claimFire: vi.fn(async () => true),
    send: vi.fn(async (_ws, m) => {
      sent.push(m);
    }),
    ...over,
  };
  return { d, sent };
}

describe('weeklyGradingSampleSweep', () => {
  it('sends one sample to the owner and claims the weekly slot first', async () => {
    const { d, sent } = deps();
    const res = await weeklyGradingSampleSweep({ now: NOW, workspaceId: 'ws', size: 5, deps: d });
    expect(res.outcome).toBe('sent');
    expect(res.sampled).toBe(3);
    expect(res.weekKey).toBe('2026-W41');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('ideaId w');
    const claimOrder = (d.claimFire as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const sendOrder = (d.send as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(sendOrder);
    // The claim reason carries the week key so the shared ledger's byte-identical backoff
    // never stretches the weekly cadence.
    expect((d.claimFire as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toContain('2026-W41');
  });

  it('does not read or send when a sample already went out this window', async () => {
    const { d, sent } = deps({ firedWithinWindow: vi.fn(async () => true) });
    const res = await weeklyGradingSampleSweep({ now: NOW, workspaceId: 'ws', size: 5, deps: d });
    expect(res.outcome).toBe('debounced');
    expect(d.readIdeas).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('does not send when the claim races or backs off', async () => {
    const { d, sent } = deps({ claimFire: vi.fn(async () => false) });
    const res = await weeklyGradingSampleSweep({ now: NOW, workspaceId: 'ws', size: 5, deps: d });
    expect(res.outcome).toBe('debounced');
    expect(sent).toHaveLength(0);
  });

  it('reports empty without claiming the slot, so a later tick can still deliver this week', async () => {
    const { d, sent } = deps({ readIdeas: vi.fn(async () => [idea('agent', { origin: 'agent-review' })]) });
    const res = await weeklyGradingSampleSweep({ now: NOW, workspaceId: 'ws', size: 5, deps: d });
    expect(res.outcome).toBe('empty');
    expect(d.claimFire).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('is disabled by a non-positive size without touching any seam', async () => {
    const { d } = deps();
    const res = await weeklyGradingSampleSweep({ now: NOW, workspaceId: 'ws', size: 0, deps: d });
    expect(res.outcome).toBe('disabled');
    expect(d.firedWithinWindow).not.toHaveBeenCalled();
  });

  it('fails soft: a send error is returned, never thrown into the routines tick', async () => {
    const { d } = deps({
      send: vi.fn(async () => {
        throw new Error('coord down');
      }),
    });
    const res = await weeklyGradingSampleSweep({ now: NOW, workspaceId: 'ws', size: 5, deps: d });
    expect(res.outcome).toBe('error');
    expect(res.reason).toContain('coord down');
  });
});
