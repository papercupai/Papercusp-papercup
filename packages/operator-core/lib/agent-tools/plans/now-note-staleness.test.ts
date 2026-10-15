import { describe, expect, it, vi } from 'vitest';
import {
  NOTE_STALENESS_READ_LIMIT,
  attachNoteStaleness,
  readNoteStaleness,
  summarizeNoteStaleness,
} from './now-note-staleness';

// derived-status-not-hand-written-2026-10-12 P-003: a Now note reports how far the
// plan has moved since it was written, counted from the plan-event log.

let seq = 0;
function ev(event: string, minute: number) {
  seq += 1;
  return { ts: `2026-10-12T10:${String(minute).padStart(2, '0')}:00.000Z`, msg_id: `m${seq}`, event };
}

describe('transitionsSinceNote — counted from the plan-event log', () => {
  it('counts the item and plan status changes recorded after the latest now_updated, and none from before it', () => {
    const events = [
      ev('item_status_changed', 1), // before the note — must not count
      ev('status_changed', 2), // before the note — must not count
      ev('now_updated', 3),
      ev('item_status_changed', 4),
      ev('item_status_changed', 5),
      ev('status_changed', 6),
    ];
    const s = summarizeNoteStaleness(events, { windowFull: false });
    expect(s.transitionsSinceNote).toBe(3);
    expect(s.itemStatusChanges).toBe(2);
    expect(s.planStatusChanges).toBe(1);
    expect(s.basis).toBe('events-after-note');
    expect(s.noteWrittenAt).toBe('2026-10-12T10:03:00.000Z');
    expect(s.truncatedByLimit).toBe(false);
    expect(s.text).toBe('3 status changes since this note was written');
  });

  it('measures from the LATEST note write when the note was rewritten', () => {
    const events = [
      ev('now_updated', 1),
      ev('item_status_changed', 2),
      ev('item_status_changed', 3),
      ev('now_updated', 4),
      ev('item_status_changed', 5),
    ];
    const s = summarizeNoteStaleness(events, { windowFull: false });
    expect(s.transitionsSinceNote).toBe(1);
    expect(s.noteWrittenAt).toBe('2026-10-12T10:04:00.000Z');
    expect(s.text).toBe('1 status change since this note was written');
  });

  it('does not miss an item status change recorded right after the note', () => {
    const events = [ev('now_updated', 7), ev('item_status_changed', 7)];
    const s = summarizeNoteStaleness(events, { windowFull: false });
    expect(s.transitionsSinceNote).toBe(1);
  });

  it('CONTROL: a note with nothing after it is 0, not unknown', () => {
    const s = summarizeNoteStaleness([ev('item_status_changed', 1), ev('now_updated', 2)], { windowFull: false });
    expect(s.transitionsSinceNote).toBe(0);
    expect(s.basis).toBe('events-after-note');
  });

  it('ignores events that are not status changes', () => {
    const events = [
      ev('now_updated', 1),
      ev('decision_added', 2),
      ev('item_added', 3),
      ev('plan_audited', 4),
      ev('now_updated_typo', 5),
    ];
    expect(summarizeNoteStaleness(events, { windowFull: false }).transitionsSinceNote).toBe(0);
  });

  it('a note never written through plans:set-now is unknown, not the whole history', () => {
    const events = [ev('created', 1), ev('item_status_changed', 2), ev('item_status_changed', 3)];
    const s = summarizeNoteStaleness(events, { windowFull: false });
    expect(s.transitionsSinceNote).toBeNull();
    expect(s.basis).toBe('note-not-in-event-log');
    expect(s.noteWrittenAt).toBeNull();
    expect(s.text).toBe('note age unknown: the note was not written through plans:set-now');
  });

  it('a full window with no note write reports a floor, never a total', () => {
    const events = [ev('item_status_changed', 1), ev('status_changed', 2), ev('decision_added', 3)];
    const s = summarizeNoteStaleness(events, { windowFull: true });
    expect(s.transitionsSinceNote).toBe(2);
    expect(s.basis).toBe('note-before-window');
    expect(s.truncatedByLimit).toBe(true);
    expect(s.text).toBe('at least 2 status changes since this note was written');
  });
});

describe('transitionsSinceNote — measured from the displayed note (blind review #14 G-2)', () => {
  const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00.000Z`;
  it('a replacement note counts only changes after ITS write time, not after the older now_updated', () => {
    const events = [ev('now_updated', 1), ev('item_status_changed', 2), ev('item_status_changed', 4)];
    const s = summarizeNoteStaleness(events, { windowFull: false, noteWrittenAt: at(3) });
    expect(s.transitionsSinceNote).toBe(1);
    expect(s.noteWrittenAt).toBe(at(3));
    expect(s.basis).toBe('events-after-note');
  });
  it('CONTROL: without the note write time the count falls back to the latest now_updated', () => {
    const events = [ev('now_updated', 1), ev('item_status_changed', 2), ev('item_status_changed', 4)];
    expect(summarizeNoteStaleness(events, { windowFull: false }).transitionsSinceNote).toBe(2);
  });
  it('a content-written note with no now_updated in the log has a known age, not unknown', () => {
    const s = summarizeNoteStaleness([ev('item_status_changed', 1), ev('status_changed', 5)], { windowFull: false, noteWrittenAt: at(3) });
    expect(s.transitionsSinceNote).toBe(1);
    expect(s.planStatusChanges).toBe(1);
    expect(s.basis).toBe('events-after-note');
  });
  it('a full window that starts after the note reports a floor, never a total', () => {
    const s = summarizeNoteStaleness([ev('item_status_changed', 5), ev('item_status_changed', 6)], { windowFull: true, noteWrittenAt: at(3) });
    expect(s.transitionsSinceNote).toBe(2);
    expect(s.truncatedByLimit).toBe(true);
    expect(s.basis).toBe('note-before-window');
  });
  it('attachNoteStaleness measures from now.note.writtenAt when plans:get exposes it', async () => {
    const read = vi.fn(async () => [ev('now_updated', 1), ev('item_status_changed', 2), ev('item_status_changed', 4)]);
    const results: Array<Record<string, unknown>> = [{ ok: true, slug: 'p', now: { state: 's', next: 'n', note: { writtenAt: at(3) } } }];
    await attachNoteStaleness(results, { read: read as never });
    expect((results[0]!.now as { staleness: { transitionsSinceNote: number } }).staleness.transitionsSinceNote).toBe(1);
  });
});

describe('readNoteStaleness / attachNoteStaleness', () => {
  it('reads one plan through the bounded single-plan reader and derives the count', async () => {
    const read = vi.fn(async () => [ev('now_updated', 1), ev('item_status_changed', 2)]);
    const s = await readNoteStaleness('plan-a', { read });
    expect(read).toHaveBeenCalledWith({ planSlugs: ['plan-a'], limit: NOTE_STALENESS_READ_LIMIT });
    expect(s.transitionsSinceNote).toBe(1);
  });

  it('marks a full read window as truncated', async () => {
    const full = Array.from({ length: NOTE_STALENESS_READ_LIMIT }, (_, i) => ev('item_status_changed', i % 60));
    const s = await readNoteStaleness('plan-a', { read: async () => full });
    expect(s.truncatedByLimit).toBe(true);
    expect(s.transitionsSinceNote).toBe(NOTE_STALENESS_READ_LIMIT);
  });

  it('a read that fails is unavailable, never zero', async () => {
    const s = await readNoteStaleness('plan-a', {
      read: async () => {
        throw new Error('pg down');
      },
    });
    expect(s.basis).toBe('unavailable');
    expect(s.transitionsSinceNote).toBeNull();
  });

  it('attaches now.staleness to results with a note, as a copy, and skips results without one', async () => {
    const sharedNow = { state: 'x', next: 'y' };
    const withNote: Record<string, unknown> = { slug: 'plan-a', now: sharedNow };
    const withoutNote: Record<string, unknown> = { slug: 'plan-b', now: null };
    const read = vi.fn(async () => [ev('now_updated', 1), ev('status_changed', 2)]);
    await attachNoteStaleness([withNote, withoutNote], { read });
    expect(read).toHaveBeenCalledTimes(1);
    expect((withNote.now as { staleness: { transitionsSinceNote: number } }).staleness.transitionsSinceNote).toBe(1);
    expect(sharedNow).toEqual({ state: 'x', next: 'y' });
    expect(withoutNote.now).toBeNull();
  });
});
