/**
 * item-activity.test.ts — the pure progress-aware activity classifier
 * (agent-activity-liveness-truth-2026-06-21 P-001, D-001/D-004). This is the
 * recurrence-guard safety net for the incident the plan fixes: a dead/stalled
 * holder must NEVER classify as `progressing` ("actively worked"), and a fresh
 * claim must get a grace window before it can read as `stalled`.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyItemActivity,
  isActivelyWorked,
  isReclaimable,
  deriveItemWorkEvidence,
  formatItemWorkEvidence,
  type ItemActivity,
} from './item-activity';
import { STALE_MS } from './liveness';

const NOW = 1_800_000_000_000; // fixed clock (Date.now is unavailable in some harnesses anyway)
const clock = (over: { now?: number; staleMs?: number } = {}) => ({ now: over.now ?? NOW, staleMs: over.staleMs });
const ago = (ms: number) => NOW - ms;

describe('queue item work evidence', () => {
  const reserved = { takenBy: 'su-worker', takenAt: ago(60_000), lastProgressAt: null };

  it('keeps a reservation and registered wait independent of recent work and native attestation', () => {
    const noUpdate = deriveItemWorkEvidence(reserved, clock());
    const updated = deriveItemWorkEvidence({ ...reserved, lastProgressAt: ago(1_000) }, clock());
    const waiting = deriveItemWorkEvidence({ ...reserved, registeredWaitRefs: ['gate:ready', 'gate:ready'] }, clock());
    expect(noUpdate.reservation?.owner).toBe('su-worker');
    expect(noUpdate.recentItemWork.status).toBe('unknown');
    expect(updated.recentItemWork.status).toBe('recent');
    expect(updated.nativeAttestation.status).toBe('unknown');
    expect(waiting.waiting).toEqual({ status: 'registered', refs: ['gate:ready'] });
    expect(waiting.recentItemWork.status).toBe('unknown');
    for (const view of [noUpdate, updated, waiting]) {
      expect(formatItemWorkEvidence(view)).toContain('Work attestation unknown');
      expect(formatItemWorkEvidence(view)).not.toMatch(/active|idle|dead/i);
    }
  });

  it('does not infer work from a new claim, a previous holder update, or malformed/future timestamps', () => {
    for (const lastProgressAt of [undefined, 'invalid', NOW + 1, ago(120_000), 1e30]) {
      const result = deriveItemWorkEvidence({ ...reserved, lastProgressAt }, clock());
      expect(result.recentItemWork).toMatchObject({ status: 'unknown', at: null });
      expect(result.reservation?.owner).toBe('su-worker');
    }
    expect(deriveItemWorkEvidence({ ...reserved, takenBy: 'unassigned' }, clock()).reservation).toBeNull();
    expect(formatItemWorkEvidence()).toBe('Work evidence unknown');
  });

  it('retains older measured progress as history without declaring the worker idle', () => {
    const result = deriveItemWorkEvidence({ ...reserved, takenAt: ago(3 * STALE_MS),
      lastProgressAt: ago(2 * STALE_MS) }, clock());
    expect(result.recentItemWork).toMatchObject({ status: 'stale', at: new Date(ago(2 * STALE_MS)).toISOString() });
    expect(result.waiting.status).toBe('unknown');
    expect(formatItemWorkEvidence(result)).toContain('Older item update');
  });
});

describe('classifyItemActivity', () => {
  it('free — an unclaimed item (no holder), regardless of any stale progress data', () => {
    expect(classifyItemActivity({ takenBy: null, takenAt: null, lastProgressAt: null, holderAlive: null }, clock())).toBe('free');
    expect(classifyItemActivity({ takenBy: '', takenAt: ago(1000), lastProgressAt: ago(1000), holderAlive: true }, clock())).toBe('free');
    // Even with a confirmed-dead holder field, a falsy takenBy short-circuits to free.
    expect(classifyItemActivity({ takenBy: undefined, takenAt: ago(99 * STALE_MS), lastProgressAt: null, holderAlive: false }, clock())).toBe('free');
  });

  it('dead — claimed but holder confirmed not-alive → reclaimable, EVEN with very recent progress', () => {
    // The incident case: the bee died seconds after a fresh claim/progress, yet the
    // claim outlived it. A confirmed-dead holder is dead no matter how fresh it looks.
    expect(classifyItemActivity({ takenBy: 'bee-x', takenAt: NOW, lastProgressAt: NOW, holderAlive: false }, clock())).toBe('dead');
    expect(classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS * 5), lastProgressAt: null, holderAlive: false }, clock())).toBe('dead');
  });

  it('progressing — claimed, holder ALIVE, real item-scoped progress within the window (the ONLY "actively worked")', () => {
    const a = classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS * 3), lastProgressAt: ago(STALE_MS / 2), holderAlive: true }, clock());
    expect(a).toBe('progressing');
    expect(isActivelyWorked(a)).toBe(true);
  });

  it('alive — claimed, holder ALIVE, fresh claim but NO item-scoped progress recorded yet (grace window)', () => {
    // last_progress_at null → anchor on taken_at; within window + alive but no real
    // progress = `alive` (a heartbeating holder that hasn\'t advanced the work YET).
    const a = classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS / 2), lastProgressAt: null, holderAlive: true }, clock());
    expect(a).toBe('alive');
    expect(isActivelyWorked(a)).toBe(false); // NOT "actively worked" — no progress yet
  });

  it('reserved — claimed recently, holder liveness UNKNOWN (no presence record)', () => {
    expect(classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS / 2), lastProgressAt: null, holderAlive: null }, clock())).toBe('reserved');
    expect(classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS / 2), lastProgressAt: null, holderAlive: undefined }, clock())).toBe('reserved');
    // Progress within window but liveness unknown still reads `reserved` (we can\'t
    // confirm the holder, so we can\'t call it `progressing`).
    expect(classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS), lastProgressAt: ago(STALE_MS / 4), holderAlive: null }, clock())).toBe('reserved');
  });

  it('stalled — claimed but no progress past the window (holder alive OR unknown) → reclaimable', () => {
    // Alive but stuck/looping: a live, heartbeating holder is NOT proof the work advances.
    const aliveStuck = classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS * 3), lastProgressAt: ago(STALE_MS * 2), holderAlive: true }, clock());
    expect(aliveStuck).toBe('stalled');
    expect(isActivelyWorked(aliveStuck)).toBe(false);
    expect(isReclaimable(aliveStuck)).toBe(true);
    // Liveness unknown + stale anchor: a never-progressed claim older than the window.
    expect(classifyItemActivity({ takenBy: 'bee-x', takenAt: ago(STALE_MS * 2), lastProgressAt: null, holderAlive: null }, clock())).toBe('stalled');
  });

  it('the grace window anchors on taken_at when last_progress_at is null', () => {
    // Just inside the window (alive) vs just outside (stalled), with no progress yet.
    expect(classifyItemActivity({ takenBy: 'b', takenAt: ago(STALE_MS - 1), lastProgressAt: null, holderAlive: true }, clock())).toBe('alive');
    expect(classifyItemActivity({ takenBy: 'b', takenAt: ago(STALE_MS + 1), lastProgressAt: null, holderAlive: true }, clock())).toBe('stalled');
  });

  it('a claimed row with NEITHER taken_at NOR last_progress_at fails SAFE to stalled (reclaimable)', () => {
    // Shouldn\'t happen (taken_at is stamped on claim), but if both are missing the
    // age is Infinity → stalled, never spuriously "progressing".
    expect(classifyItemActivity({ takenBy: 'b', takenAt: null, lastProgressAt: null, holderAlive: true }, clock())).toBe('stalled');
  });

  it('respects a caller-supplied staleMs override (defaults to STALE_MS)', () => {
    const input = { takenBy: 'b', takenAt: ago(120_000), lastProgressAt: ago(120_000), holderAlive: true } as const;
    // 2-min-old progress: stalled under a 1-min window, progressing under a 5-min window.
    expect(classifyItemActivity(input, clock({ staleMs: 60_000 }))).toBe('stalled');
    expect(classifyItemActivity(input, clock({ staleMs: 300_000 }))).toBe('progressing');
  });

  it('accepts ISO-string and Date timestamps, not just epoch ms', () => {
    const iso = new Date(ago(STALE_MS / 2)).toISOString();
    expect(classifyItemActivity({ takenBy: 'b', takenAt: iso, lastProgressAt: iso, holderAlive: true }, clock())).toBe('progressing');
    const d = new Date(ago(STALE_MS / 2));
    expect(classifyItemActivity({ takenBy: 'b', takenAt: d, lastProgressAt: d, holderAlive: true }, clock())).toBe('progressing');
  });

  it('isActivelyWorked is true ONLY for `progressing`; isReclaimable ONLY for dead|stalled', () => {
    const all: ItemActivity[] = ['free', 'reserved', 'alive', 'progressing', 'stalled', 'dead'];
    expect(all.filter(isActivelyWorked)).toEqual(['progressing']);
    expect(all.filter(isReclaimable)).toEqual(['stalled', 'dead']);
  });
});
