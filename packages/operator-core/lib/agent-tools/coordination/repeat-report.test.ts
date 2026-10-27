/**
 * WI-6554700010029331 — the pure judgement of the `repeat_report_no_delta` rail.
 * Pins: a no-delta re-send to the same recipients is refused; every door that
 * must stay open (new ref, changed item, different recipients, outside the
 * window, threaded reply, unreadable state, idempotent retry) passes.
 */
import { describe, expect, it } from 'vitest';
import {
  describeRepeatReportRefusal,
  itemStateToken,
  judgeRepeatReport,
  readCitedItemStates,
  recipientSetKey,
  REPEAT_REPORT_WINDOW_MS,
  type ItemStateRow,
  type PriorSend,
} from './repeat-report';

const NOW = Date.parse('2026-10-26T18:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function row(ref: string, over: Partial<ItemStateRow> = {}): ItemStateRow {
  return {
    ref,
    status: 'blocked',
    holder: 'su-member-1',
    stateChangedAt: iso(NOW - 5 * HOUR),
    takenAt: iso(NOW - 5 * HOUR),
    lastReleasedAt: null,
    admittedAt: iso(NOW - 10 * HOUR),
    activeBlockers: 1,
    ...over,
  };
}

function prior(over: Partial<PriorSend> = {}): PriorSend {
  return {
    msgId: 'msg-prior-1',
    ts: iso(NOW - HOUR),
    to: ['su-leader'],
    text: 'Still blocked on WI-100 (admission pending).',
    citedItemStates: null,
    ...over,
  };
}

const states = (...rows: ItemStateRow[]) => new Map(rows.map((r) => [r.ref, r]));

describe('judgeRepeatReport', () => {
  it('refuses a re-send of an unchanged item to the same recipients (unstamped prior: timestamp fallback)', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'], priors: [prior()], current: states(row('WI-100')), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind !== 'refuse') return;
    expect(verdict.repeats).toEqual([
      { ref: 'WI-100', priorMsgId: 'msg-prior-1', priorTs: iso(NOW - HOUR), status: 'blocked', holder: 'su-member-1' },
    ]);
    expect(verdict.stamps).toEqual([{ ref: 'WI-100', token: itemStateToken(row('WI-100')) }]);
  });

  it('refuses when the stamped prior token equals the current token', () => {
    const current = row('WI-100');
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'],
      priors: [prior({ citedItemStates: [{ ref: 'WI-100', token: itemStateToken(current) }] })],
      current: states(current), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('refuse');
  });

  it('passes when the stamped token moved (holder changed), even with no newer timestamp', () => {
    const before = row('WI-100');
    const after = row('WI-100', { holder: 'su-member-2' });
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'],
      priors: [prior({ citedItemStates: [{ ref: 'WI-100', token: itemStateToken(before) }] })],
      current: states(after), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });

  it('passes when a blocker was added after a stamped prior', () => {
    const before = row('WI-100', { activeBlockers: 0 });
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'],
      priors: [prior({ citedItemStates: [{ ref: 'WI-100', token: itemStateToken(before) }] })],
      current: states(row('WI-100', { activeBlockers: 1 })), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });

  it('passes when the item changed state after an unstamped prior', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'], priors: [prior()],
      current: states(row('WI-100', { status: 'open', stateChangedAt: iso(NOW - 30 * 60_000) })), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });

  it('passes when ANY cited ref is new to these recipients', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100', 'EI-200'], to: ['su-leader'], priors: [prior()],
      current: states(row('WI-100'), row('EI-200')), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });

  it('passes for a different recipient set, and treats recipient order as irrelevant', () => {
    const other = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-other'], priors: [prior()], current: states(row('WI-100')), judge: true, nowMs: NOW,
    });
    expect(other.kind).toBe('pass');
    const reordered = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-b', 'su-a'], priors: [prior({ to: ['su-a', 'su-b'] })],
      current: states(row('WI-100')), judge: true, nowMs: NOW,
    });
    expect(reordered.kind).toBe('refuse');
    expect(recipientSetKey(['su-b', 'su-a', 'su-a'])).toBe(recipientSetKey(['su-a', 'su-b']));
  });

  it('passes when the prior send is outside the window', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'], priors: [prior({ ts: iso(NOW - REPEAT_REPORT_WINDOW_MS - 60_000) })],
      current: states(row('WI-100', { stateChangedAt: iso(NOW - 30 * HOUR), takenAt: iso(NOW - 30 * HOUR) })),
      judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });

  it('never judges a threaded reply, but still stamps it', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'], priors: [prior()], current: states(row('WI-100')), judge: false, nowMs: NOW,
    });
    expect(verdict).toEqual({ kind: 'pass', stamps: [{ ref: 'WI-100', token: itemStateToken(row('WI-100')) }] });
  });

  it('fails open: an unreadable item state passes unstamped; an unknown ref passes', () => {
    expect(judgeRepeatReport({ refs: ['WI-100'], to: ['su-leader'], priors: [prior()], current: null, judge: true, nowMs: NOW }))
      .toEqual({ kind: 'pass', stamps: [] });
    expect(judgeRepeatReport({ refs: ['WI-100'], to: ['su-leader'], priors: [prior()], current: new Map(), judge: true, nowMs: NOW }).kind)
      .toBe('pass');
  });

  it('an idempotent retry never counts its own earlier copy as the prior', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'], priors: [prior({ msgId: 'coord-send-abc' })],
      current: states(row('WI-100')), judge: true, ownMsgId: 'coord-send-abc', nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });

  it('a prior that does not cite the ref is not a prior for it', () => {
    const verdict = judgeRepeatReport({
      refs: ['WI-100'], to: ['su-leader'], priors: [prior({ text: 'Working on WI-1000 now.' })],
      current: states(row('WI-100')), judge: true, nowMs: NOW,
    });
    expect(verdict.kind).toBe('pass');
  });
});

describe('refusal text and stamp parsing', () => {
  it('names the prior message, the related_msg_id door and the set_blocker door', () => {
    const text = describeRepeatReportRefusal([
      { ref: 'WI-100', priorMsgId: 'msg-prior-1', priorTs: iso(NOW - HOUR), status: 'blocked', holder: null },
    ]);
    expect(text).toContain('Nothing was sent');
    expect(text).toContain("related_msg_id:'msg-prior-1'");
    expect(text).toContain('work_items:set_blocker');
    expect(text).toContain('WI-100');
  });

  it('reads a persisted stamp and ignores malformed entries', () => {
    expect(readCitedItemStates([{ ref: 'WI-1', token: 'a' }, { ref: 2 }, null, 'x'])).toEqual([{ ref: 'WI-1', token: 'a' }]);
    expect(readCitedItemStates(null)).toBeNull();
  });
});
