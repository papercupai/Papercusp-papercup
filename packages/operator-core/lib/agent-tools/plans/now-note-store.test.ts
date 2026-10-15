/**
 * now-note-store.test.ts — derived-status-not-hand-written-2026-10-12 P-004
 * (D-007 / D-008). Unit coverage for the structured Now note: decode, the
 * note's own last-writer-wins, read-time resolution against a content `## Now`,
 * and the federated apply guard (an older or equal peer note never writes).
 */
import { describe, expect, it, vi } from 'vitest';
import type { PlanNowBlock } from '@papercusp/plan-parser';
import {
  applyFederatedNowNote,
  applyNowNoteToParsed,
  buildSetNowNote,
  isNewerNowNote,
  noteFromContentWrite,
  parseNowNote,
  renderNowNoteRaw,
  resolvePlanNow,
  writePlanNowNote,
  type NowNoteSql,
  type PlanNowNote,
} from './now-note-store';

const SCOPE = { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'plan-a' };

function note(overrides: Partial<PlanNowNote> = {}): PlanNowNote {
  return {
    state: 'P-001 done.',
    next: 'Continue with P-002.',
    author: 'su-a',
    writtenAt: '2026-10-12T10:00:00.000Z',
    eventId: 'msg-b',
    rationale: null,
    source: 'set-now',
    ...overrides,
  };
}

/** A recording tagged-template fake: each call's SQL text + values, answered in order. */
function fakeSql(answers: unknown[][]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return answers.shift() ?? [];
  });
  return { sql: sql as unknown as NowNoteSql, calls };
}

describe('parseNowNote', () => {
  it('decodes a stored object and a JSON string to the same note', () => {
    const n = note({ rationale: 'why' });
    expect(parseNowNote(n)).toEqual(n);
    expect(parseNowNote(JSON.stringify(n))).toEqual(n);
  });

  it('normalizes writtenAt to ISO and reads a missing rationale as null', () => {
    const { rationale: _drop, ...wire } = note({ writtenAt: '2026-10-12T10:00:00Z' });
    expect(parseNowNote(wire)).toEqual(note({ writtenAt: '2026-10-12T10:00:00.000Z', rationale: null }));
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['bad JSON', '{not json'],
    ['a missing state', { ...note(), state: undefined }],
    ['a non-string next', { ...note(), next: 3 }],
    ['an unparseable writtenAt', { ...note(), writtenAt: 'yesterday' }],
    ['a numeric author', { ...note(), author: 7 }],
    ['a foreign source', { ...note(), source: 'agent' }],
  ])('decodes %s to null', (_label, raw) => {
    expect(parseNowNote(raw)).toBeNull();
  });
});

describe('isNewerNowNote', () => {
  it('treats any note as newer than no note', () => {
    expect(isNewerNowNote(note(), null)).toBe(true);
  });

  it('orders by writtenAt first', () => {
    const older = note({ writtenAt: '2026-10-12T09:00:00.000Z', eventId: 'zzz' });
    const newer = note({ writtenAt: '2026-10-12T10:00:00.000Z', eventId: 'aaa' });
    expect(isNewerNowNote(newer, older)).toBe(true);
    expect(isNewerNowNote(older, newer)).toBe(false);
  });

  it('breaks a writtenAt tie by eventId, and an identical note is not newer', () => {
    const a = note({ eventId: 'msg-a' });
    const b = note({ eventId: 'msg-b' });
    expect(isNewerNowNote(b, a)).toBe(true);
    expect(isNewerNowNote(a, b)).toBe(false);
    expect(isNewerNowNote(b, note({ eventId: 'msg-b' }))).toBe(false);
  });
});

describe('resolvePlanNow / applyNowNoteToParsed', () => {
  const contentNow: PlanNowBlock = {
    state: 'Old state.',
    next: 'Old next.',
    raw: '**State:** Old state.\n\n**Next:** Old next.',
    lineNumber: 12,
  };

  it('reads the content ## Now when no note was ever written (migrate-on-read)', () => {
    expect(resolvePlanNow(null, contentNow)).toBe(contentNow);
    expect(resolvePlanNow(null, null)).toBeNull();
  });

  it('prefers the note and keeps the frozen section line number', () => {
    expect(resolvePlanNow(note(), contentNow)).toEqual({
      state: 'P-001 done.',
      next: 'Continue with P-002.',
      raw: renderNowNoteRaw(note()),
      lineNumber: 12,
    });
    expect(resolvePlanNow(note(), null)?.lineNumber).toBe(0);
  });

  it('returns a copy, never mutating a shared parsed plan', () => {
    const parsed = { now: contentNow, title: 'Plan' };
    const applied = applyNowNoteToParsed(parsed, note());
    expect(applied).not.toBe(parsed);
    expect(parsed.now).toBe(contentNow);
    expect(applied.now?.next).toBe('Continue with P-002.');
    expect(applied.title).toBe('Plan');
    expect(applyNowNoteToParsed(parsed, null)).toBe(parsed);
  });
});

describe('buildSetNowNote', () => {
  it('trims text, stamps the clock and keeps the rationale', () => {
    const at = new Date('2026-10-12T11:00:00.000Z');
    expect(buildSetNowNote({
      state: '  S  ', next: ' N ', author: 'su-a', eventId: 'msg-1', rationale: '  because ', writtenAt: at,
    })).toEqual({
      state: 'S', next: 'N', author: 'su-a', writtenAt: at.toISOString(), eventId: 'msg-1',
      rationale: 'because', source: 'set-now',
    });
  });

  it('stores a blank rationale as null', () => {
    expect(buildSetNowNote({ state: 'S', next: 'N', author: null, eventId: null, rationale: '   ' }).rationale)
      .toBeNull();
  });
});

describe('noteFromContentWrite (SPEC-P-004 migration on a content write)', () => {
  const at = new Date('2026-10-12T12:00:00.000Z');
  const section = (state: string, next: string): PlanNowBlock => ({ state, next, raw: 'raw', lineNumber: 9 });

  it('migrates a section into a note with the same (trimmed) text when no note exists', () => {
    expect(noteFromContentWrite({
      existing: null, priorSection: section('S', 'N'), nextSection: section(' S ', ' N '), author: 'su-w', writtenAt: at,
    })).toEqual({
      state: 'S', next: 'N', author: 'su-w', writtenAt: at.toISOString(), eventId: null, rationale: null,
      source: 'content',
    });
  });

  it('migrates the section of a NEW plan (no prior content)', () => {
    expect(noteFromContentWrite({
      existing: null, priorSection: null, nextSection: section('S', ''), author: null, writtenAt: at,
    })).toMatchObject({ state: 'S', next: '', source: 'content' });
  });

  it('stores nothing for a missing section or one with neither State nor Next', () => {
    expect(noteFromContentWrite({ existing: null, priorSection: null, nextSection: null, author: null })).toBeNull();
    expect(noteFromContentWrite({
      existing: null, priorSection: null, nextSection: section('  ', ''), author: null,
    })).toBeNull();
  });

  it('keeps an existing note when the section comes back unchanged', () => {
    expect(noteFromContentWrite({
      existing: note(), priorSection: section('Old', 'Old next'), nextSection: section('Old ', 'Old next'),
      author: 'su-w',
    })).toBeNull();
  });

  it('adopts a deliberate edit of the section over an existing note', () => {
    expect(noteFromContentWrite({
      existing: note(), priorSection: section('Old', 'Old next'), nextSection: section('Edited', 'Old next'),
      author: 'su-w', writtenAt: at,
    })).toMatchObject({ state: 'Edited', next: 'Old next', author: 'su-w', source: 'content' });
  });

  it('does not rewrite a note the edited section already equals', () => {
    expect(noteFromContentWrite({
      existing: note(), priorSection: section('Old', 'Old next'), nextSection: section(note().state, note().next),
      author: 'su-w',
    })).toBeNull();
  });
});

describe('parseNowNote accepts a content-sourced note', () => {
  it('round-trips source content', () => {
    expect(parseNowNote(note({ source: 'content', eventId: null }))?.source).toBe('content');
  });
});

describe('writePlanNowNote', () => {
  it('writes the note and its state/next projection without touching content, hash or version', async () => {
    const { sql, calls } = fakeSql([[{ plan_slug: 'plan-a' }]]);
    expect(await writePlanNowNote(sql, SCOPE, note())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('now_note');
    expect(calls[0].text).not.toMatch(/\bcontent\b|content_hash|\bversion\b/);
    expect(calls[0].values).toContain('P-001 done.');
    expect(calls[0].values).toContain('Continue with P-002.');
  });

  it('reports a missing plan row', async () => {
    const { sql } = fakeSql([[]]);
    expect(await writePlanNowNote(sql, SCOPE, note())).toBe(false);
  });
});

describe('applyFederatedNowNote', () => {
  const clock = { origin: 'peer-1', fedTs: 1_700_000_000_000, fedHlc: 'hlc-1' };

  it('applies a newer peer note', async () => {
    const { sql, calls } = fakeSql([[{ now_note: note({ writtenAt: '2026-10-12T09:00:00.000Z' }) }], []]);
    expect(await applyFederatedNowNote(sql, SCOPE, note(), clock)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('UPDATE harness_shared.harness_plans');
    expect(calls[1].values).toContain('peer-1');
  });

  it('applies to a row that has no note yet', async () => {
    const { sql, calls } = fakeSql([[{ now_note: null }], []]);
    expect(await applyFederatedNowNote(sql, SCOPE, JSON.stringify(note()), clock)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('ignores an older peer note: no UPDATE is issued', async () => {
    const { sql, calls } = fakeSql([[{ now_note: note({ writtenAt: '2026-10-12T11:00:00.000Z' }) }]]);
    expect(await applyFederatedNowNote(sql, SCOPE, note(), clock)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('ignores an echo of the stored note: no UPDATE is issued', async () => {
    const { sql, calls } = fakeSql([[{ now_note: note() }]]);
    expect(await applyFederatedNowNote(sql, SCOPE, note(), clock)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('ignores a malformed peer note without touching the database', async () => {
    const { sql, calls } = fakeSql([]);
    expect(await applyFederatedNowNote(sql, SCOPE, { state: 'x' }, clock)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does nothing when the plan row does not exist', async () => {
    const { sql, calls } = fakeSql([[]]);
    expect(await applyFederatedNowNote(sql, SCOPE, note(), clock)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
