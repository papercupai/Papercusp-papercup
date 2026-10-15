/**
 * session-reset-continuation.test.ts — the channel set that decides whether a
 * SessionEnd is a scheduled continuation or a death (WI-6756).
 *
 * WHY THIS FILE EXISTS AT ALL: WI-6862 widened `WakeChannel` with `-unconfirmed`
 * reset/recycle variants and very nearly reverted WI-6756 by omission. Nothing
 * caught it — `CONTEXT_RESET_WAKE_CHANNELS` is a list of STRINGS consumed by a
 * SQL `= ANY()` filter, so a channel missing from it is invisible to tsc, to
 * `lint:required-field-strands`, and to every existing test. The failure mode is
 * silent and one-directional: the guard stops matching, `activity/report.ts`
 * reads the reset's SessionEnd as a death, and force-releases every work-item
 * lease the owner holds.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  CONTEXT_RESET_WAKE_CHANNELS,
  RESET_CONTINUATION_WINDOW_MS,
  WAKE_RESUME_TURN_CHANNELS,
  isWakeResumeTurn,
} from './session-reset-continuation';
import { WAKE_TURN_CHANNELS } from './events/await/types';

/** A tagged-template stand-in for postgres.js: records each query's text + values. */
function fakeSql(rows: unknown[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tag = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return rows;
  });
  return { sql: tag as unknown as Sql, calls, tag };
}

// WI-10005679: a one-turn wake resume's SessionEnd must not retire the standing
// inbox-wake. The id arrives from a child's env, so only a ledger row for THIS
// owner on a one-turn resume channel may count.
describe('isWakeResumeTurn (WI-10005679)', () => {
  it('confirms a delivery to this owner on a one-turn resume channel', async () => {
    const f = fakeSql([{ one: 1 }]);
    await expect(isWakeResumeTurn('su-judge', 413379, { sql: f.sql })).resolves.toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].text).toContain('harness_shared.event_wake_deliveries');
    expect(f.calls[0].values).toEqual([413379, 'su-judge', [...WAKE_RESUME_TURN_CHANNELS]]);
  });

  it('a delivery the ledger does not hold for this owner is not a resume turn', async () => {
    const f = fakeSql([]);
    await expect(isWakeResumeTurn('su-judge', 413379, { sql: f.sql })).resolves.toBe(false);
  });

  it('never queries for a missing, non-positive or unsafe id, or a blank owner', async () => {
    const f = fakeSql([{ one: 1 }]);
    for (const id of [undefined, null, 0, -4, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(isWakeResumeTurn('su-judge', id, { sql: f.sql })).resolves.toBe(false);
    }
    await expect(isWakeResumeTurn('  ', 413379, { sql: f.sql })).resolves.toBe(false);
    expect(f.tag).not.toHaveBeenCalled();
  });

  it('propagates a PG failure so the caller can fall back to the cancel', async () => {
    const sql = vi.fn(async () => {
      throw new Error('pg down');
    }) as unknown as Sql;
    await expect(isWakeResumeTurn('su-judge', 1, { sql })).rejects.toThrow('pg down');
  });

  it('the channel set is exactly the executor\'s one-turn resumes: turn-burning, never a reset or inject', () => {
    const channels: readonly string[] = WAKE_RESUME_TURN_CHANNELS;
    expect([...channels].sort()).toEqual(['resume', 'resume-headless']);
    for (const c of channels) expect(WAKE_TURN_CHANNELS).toContain(c);
    // CONTROL: a warm inject or a context reset continues the live session; those
    // are handled (or deliberately not) by the continuation guards, not by this set.
    for (const other of ['psu-socket-inject', 'pty-inject', ...CONTEXT_RESET_WAKE_CHANNELS]) {
      expect(channels).not.toContain(other);
    }
  });
});

describe('CONTEXT_RESET_WAKE_CHANNELS (WI-6756 continuation guard)', () => {
  // The recurrence guard for the whole class, not just for WI-6862's two channels.
  // Any channel that drops the child's context is by definition a turn-burning
  // channel, so WAKE_TURN_CHANNELS is the enumeration to measure against: a future
  // reset/recycle variant that joins it and forgets THIS list reds here instead of
  // silently stranding the guard in production.
  it('covers EVERY reset/recycle-shaped wake channel — a new variant cannot silently strand the guard', () => {
    const resetShaped: string[] = WAKE_TURN_CHANNELS.filter((c) => /^psu-socket-(reset|recycle)/.test(c));
    expect(resetShaped.length).toBeGreaterThan(0); // the filter must not be silently matching nothing
    expect(resetShaped.sort()).toEqual([...CONTEXT_RESET_WAKE_CHANNELS].sort());
  });

  // Widened to `readonly string[]` on purpose: the const's element type is the
  // 4-literal union, so a `toContain('psu-socket-inject')` on the narrow type is a
  // COMPILE error — and the excluded-channel control below is exactly the assertion
  // worth making. Comparing as strings is also what the SQL `= ANY()` does.
  const channels: readonly string[] = CONTEXT_RESET_WAKE_CHANNELS;

  it('includes the WI-6862 -unconfirmed variants: a host that sends no ack still performed the reset', () => {
    // The common case, not an edge case — any host running pre-WI-5872 code never
    // acks, so its perfectly-good reset books the unconfirmed channel. Excluding
    // these is what reverts WI-6756 for the majority of cold wakes.
    expect(channels).toContain('psu-socket-reset-unconfirmed');
    expect(channels).toContain('psu-socket-recycle-unconfirmed');
  });

  // The control for the assertion above: the set must not have widened into
  // "any wake channel", which would make the first two tests pass vacuously and
  // would exempt a genuine death near a WARM inject from ever releasing.
  it('CONTROL: warm and non-turn channels are still EXCLUDED — a SessionEnd near a warm inject is a real death', () => {
    for (const warm of ['psu-socket-inject', 'pty-inject', 'resume', 'inbox', 'coalesced']) {
      expect(channels).not.toContain(warm);
    }
  });

  it('the window stays well under a common 60s loop interval (an unrelated death must not inherit it)', () => {
    expect(RESET_CONTINUATION_WINDOW_MS).toBeLessThan(60_000);
    expect(RESET_CONTINUATION_WINDOW_MS).toBeGreaterThan(1_000);
  });
});
