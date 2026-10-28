import { describe, expect, it } from 'vitest';
import type { JournalEntry, JournalReadResult } from '../journal-read';
import {
  buildDreamDecisionJournalRow,
  DREAM_DECISION_JOURNAL_FLUSH_MARGIN_MS,
  DREAM_DECISION_JOURNAL_LOOKBACK_MS,
  dreamDecisionJournalUnits,
  sliceDecisionJournal,
  type DreamDecisionJournalRow,
} from './dream-decision-journal';

const UNIT = 'papercusp-bg-host.service';
const ACTION = 'dream-action-decision:';
const GYM = 'GYM_ADMISSION_DECISION ';
const t = (minute: number) => new Date(Date.UTC(2026, 9, 28, 3, minute, 0)).toISOString();

function entry(minute: number, message: string, extra: Partial<JournalEntry> = {}): JournalEntry {
  return { ts: t(minute), unit: UNIT, level: 'info', message, repeat: 1, ...extra };
}

function scan(entries: JournalEntry[], extra: Partial<JournalReadResult> = {}): JournalReadResult {
  return {
    entries,
    matched: entries.reduce((count, e) => count + e.repeat, 0),
    collapsed: 0,
    truncated: false,
    window: { since: '@0', until: '@1', resolved: { sinceUtc: t(0), untilUtc: t(59), untilRequested: true, hostUtcOffsetMinutes: -240, invertedHint: null } },
    units: [UNIT],
    journalAvailable: true,
    backend: 'systemd',
    journalError: null,
    unitsUnknown: [],
    windowOutsideJournal: null,
    command: 'journalctl --user -u papercusp-bg-host.service',
    ...extra,
  };
}

function row(entries: JournalEntry[], extra: Partial<JournalReadResult> = {}): DreamDecisionJournalRow {
  return { unit: UNIT, coveredSince: t(0), coveredUntil: t(59), scan: scan(entries, extra) };
}

const request = (since: number, until: number, prefix = ACTION, limit = 20) =>
  ({ unit: UNIT, since: t(since), until: t(until), prefix, limit });

describe('sliceDecisionJournal (WI-6554700010030749)', () => {
  it('serves only the requested window and prefix, with exact counts', () => {
    const rows = [row([
      entry(5, `${ACTION} before`), entry(10, `${ACTION} a`), entry(11, `${GYM}g1`),
      entry(12, `${ACTION} b`, { repeat: 3, lastTs: t(13) }), entry(30, `${ACTION} after`),
    ])];

    const action = sliceDecisionJournal(rows, request(10, 20));
    expect(action.journalError).toBeNull();
    expect(action.entries.map((e) => e.message)).toEqual([`${ACTION} a`, `${ACTION} b`]);
    expect(action.matched).toBe(4);
    expect(action.collapsed).toBe(2);
    expect(action.truncated).toBe(false);
    expect(action.window.resolved?.sinceUtc).toBe(t(10));
    expect(action.window.resolved?.untilUtc).toBe(t(20));
    expect(action.precomputed).toMatchObject({ unit: UNIT, coveredSince: t(0), coveredUntil: t(59) });

    const gym = sliceDecisionJournal(rows, request(10, 20, GYM, 1000));
    expect(gym.entries.map((e) => e.message)).toEqual([`${GYM}g1`]);
    expect(gym.matched).toBe(1);
  });

  it('keeps the newest lines and reports truncation past the per-source cap', () => {
    const rows = [row([entry(10, `${ACTION} 1`), entry(11, `${ACTION} 2`), entry(12, `${ACTION} 3`)])];
    const slice = sliceDecisionJournal(rows, request(0, 59, ACTION, 2));
    expect(slice.entries.map((e) => e.message)).toEqual([`${ACTION} 2`, `${ACTION} 3`]);
    expect(slice.matched).toBe(3);
    expect(slice.truncated).toBe(true);
  });

  it('an empty window inside coverage is a real zero, not an error', () => {
    const slice = sliceDecisionJournal([row([entry(40, `${ACTION} later`)])], request(10, 20));
    expect(slice.journalError).toBeNull();
    expect(slice.entries).toEqual([]);
    expect(slice.matched).toBe(0);
  });

  it.each([
    ['a unit the producer never scanned', [row([])], { ...request(10, 20), unit: 'other.service' }, /^journal-unit-not-precomputed:other\.service$/],
    ['no snapshot at all (cold miss)', [], request(10, 20), /^journal-unit-not-precomputed:/],
    ['a window ending after the last scan', [row([])], request(10, 60), /^journal-snapshot-does-not-cover-window:/],
    ['a window starting before coverage', [{ ...row([]), coveredSince: t(15) }], request(10, 20), /^journal-snapshot-does-not-cover-window:/],
    ['a failed scan', [row([], { journalError: 'timeout', matched: null })], request(10, 20), /^timeout$/],
    ['an inverted window', [row([])], request(20, 10), /^invalid-journal-window$/],
    ['a collapsed run straddling the window start', [row([entry(8, `${ACTION} x`, { repeat: 2, lastTs: t(11) })])], request(10, 20), /^collapsed-journal-run-straddles-window$/],
    ['a collapsed run straddling the window end', [row([entry(19, `${ACTION} x`, { repeat: 2, lastTs: t(21) })])], request(10, 20), /^collapsed-journal-run-straddles-window$/],
  ])('%s is UNKNOWN (journal error, matched null), never an empty log', (_label, rows, req, error) => {
    const slice = sliceDecisionJournal(rows as DreamDecisionJournalRow[], req);
    expect(slice.journalError).toMatch(error);
    expect(slice.matched).toBeNull();
    expect(slice.entries).toEqual([]);
  });

  it('a clipped in-window message makes both sources unknown, since it may hide the other prefix', () => {
    const rows = [row([entry(10, `${GYM}g`, { clipped: true }), entry(11, `${ACTION} a`)])];
    expect(sliceDecisionJournal(rows, request(10, 20)).journalError).toBe('shared-journal-message-clipped');
    expect(sliceDecisionJournal(rows, request(10, 20, GYM)).journalError).toBe('shared-journal-message-clipped');
    // Outside the window the clipped line does not taint the answer.
    expect(sliceDecisionJournal(rows, request(11, 20)).journalError).toBeNull();
  });
});

describe('buildDreamDecisionJournalRow', () => {
  const startedAt = Date.parse(t(59));

  it('covers the full lookback when the scan was not truncated', () => {
    const built = buildDreamDecisionJournalRow(UNIT, scan([entry(30, `${ACTION} a`)]), startedAt);
    expect(built.coveredSince).toBe(new Date(startedAt - DREAM_DECISION_JOURNAL_LOOKBACK_MS).toISOString());
    expect(built.coveredUntil).toBe(new Date(startedAt - DREAM_DECISION_JOURNAL_FLUSH_MARGIN_MS).toISOString());
  });

  it('starts coverage after the oldest retained line when the scan hit its cap', () => {
    const built = buildDreamDecisionJournalRow(UNIT, scan([entry(30, `${ACTION} a`), entry(31, `${ACTION} b`)], { truncated: true }), startedAt);
    expect(Date.parse(built.coveredSince)).toBe(Date.parse(t(30)) + 1);
    // So a window reaching back past the dropped lines is not served.
    expect(sliceDecisionJournal([built], request(29, 40)).journalError).toMatch(/^journal-snapshot-does-not-cover-window:/);
    expect(sliceDecisionJournal([built], { ...request(31, 40) }).entries.map((e) => e.message)).toEqual([`${ACTION} b`]);
  });

  it('scans the background-host unit by default and honours the override', () => {
    expect(dreamDecisionJournalUnits({})).toEqual(['papercusp-bg-host.service']);
    expect(dreamDecisionJournalUnits({ PAPERCUSP_BACKGROUND_SYSTEMD_UNIT: 'x.service' })).toEqual(['x.service']);
  });
});
