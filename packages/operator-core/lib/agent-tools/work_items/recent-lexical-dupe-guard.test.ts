/**
 * recent-lexical-dupe-guard.test — EI-9940's fast, embedding-independent complement
 * to the P-008 semantic guard: word-overlap over RECENTLY-created OPEN titles, always
 * advisory (never blocks), and fail-open on every error mode (mirrors
 * semantic-dupe-guard.test.ts's contract).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findRecentLexicalDupes,
  recentDupeConfig,
  titleTokens,
  jaccardSimilarity,
  type RecentLexicalDupeDeps,
  type RecentDupeCandidateRow,
} from './recent-lexical-dupe-guard';

const row = (id: string, title: string, harness = 'papercusp', hasEmbedding = true): RecentDupeCandidateRow => ({
  id,
  title,
  state: 'open',
  harness,
  hasEmbedding,
});

const depsWith = (rows: RecentDupeCandidateRow[], truncated = false): RecentLexicalDupeDeps => ({
  queryRecentOpenItems: async () => ({ rows, truncated }),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('titleTokens + jaccardSimilarity', () => {
  it('lowercases, strips punctuation, drops short (<3 char) + stopword tokens', () => {
    // "the" (stopword) and "wi"/"ts" (2-char, below the length floor) are all dropped.
    expect(titleTokens('Fix the WI-4241 boot.ts repair handler!')).toEqual(
      new Set(['fix', '4241', 'boot', 'repair', 'handler']),
    );
  });

  it('jaccard is symmetric and 0 for disjoint / empty sets', () => {
    const a = titleTokens('tower side capture forensics');
    const b = titleTokens('forensics capture on the tower side');
    expect(jaccardSimilarity(a, b)).toBeGreaterThan(0.5);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
    expect(jaccardSimilarity(new Set(), a)).toBe(0);
    expect(jaccardSimilarity(new Set(['x']), new Set())).toBe(0);
  });
});

describe('classification (advisory-only)', () => {
  it('the WI-4241/WI-4242 case: near-duplicate title created moments ago is caught', async () => {
    const r = await findRecentLexicalDupes(
      { title: 'unblock WI-4070: create a fallback fix for the boot repair handler' },
      depsWith([row('WI-4241', 'fix: boot repair handler fallback for WI-4070 unblock')]),
    );
    expect(r).not.toBeNull();
    expect(r!.candidates.map((c) => c.id)).toEqual(['WI-4241']);
    expect(r!.candidates[0].source).toBe('lexical-recent');
    expect(r!.candidates[0].similarity).toBeGreaterThan(0.5);
    expect(r!.coverage).toEqual({ scanned: 1, unembedded: 0, truncated: false, complete: true });
  });

  it('returns [] (not null) when nothing recent is close — "screened, no dupes"', async () => {
    const r = await findRecentLexicalDupes({ title: 'totally unrelated title' }, depsWith([row('WI-1', 'a completely different concern')]));
    expect(r?.candidates).toEqual([]);
    expect(r?.coverage.complete).toBe(true);
  });

  it('reports a fresh unembedded row even when it is not a lexical candidate', async () => {
    const r = await findRecentLexicalDupes(
      { title: 'unrelated new work' },
      depsWith([row('WI-FRESH', 'separate active concern', 'papercusp', false)]),
    );
    expect(r?.candidates).toEqual([]);
    expect(r?.coverage).toEqual({ scanned: 1, unembedded: 1, truncated: false, complete: false });
  });

  it('reports an incomplete census when the bounded query found a sentinel row', async () => {
    const r = await findRecentLexicalDupes(
      { title: 'unrelated new work' },
      depsWith([row('WI-1', 'separate active concern')], true),
    );
    expect(r?.coverage).toEqual({ scanned: 1, unembedded: 0, truncated: true, complete: false });
  });

  it('excludes the item itself (excludeId) even if it would otherwise self-match', async () => {
    const r = await findRecentLexicalDupes(
      { title: 'same exact title here', excludeId: 'WI-9' },
      depsWith([row('WI-9', 'same exact title here')]),
    );
    expect(r?.candidates).toEqual([]);
  });

  it('sorts by similarity desc and caps at top-3', async () => {
    const rows = [
      row('WI-1', 'alpha bravo charlie delta echo'),
      row('WI-2', 'alpha bravo charlie delta echo foxtrot'),
      row('WI-3', 'alpha bravo charlie'),
      row('WI-4', 'alpha bravo'),
      row('WI-5', 'alpha'),
    ];
    const r = await findRecentLexicalDupes({ title: 'alpha bravo charlie delta echo' }, depsWith(rows));
    expect(r).not.toBeNull();
    expect(r!.candidates.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < r!.candidates.length; i++) {
      expect(r!.candidates[i - 1].similarity).toBeGreaterThanOrEqual(r!.candidates[i].similarity);
    }
  });

  it('passes the resolved window through to the query', async () => {
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN', '3');
    const calls: Array<{ windowMin: number; harness?: string }> = [];
    const deps: RecentLexicalDupeDeps = {
      queryRecentOpenItems: async (windowMin, harness) => {
        calls.push({ windowMin, harness });
        return { rows: [], truncated: false };
      },
    };
    await findRecentLexicalDupes({ title: 't', harness: 'papercusp' }, deps);
    expect(calls).toEqual([{ windowMin: 3, harness: 'papercusp' }]);
  });
});

describe('threshold + window env overrides', () => {
  it('PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN / _THRESHOLD override the defaults when sane', () => {
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN', '20');
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE_THRESHOLD', '0.7');
    expect(recentDupeConfig()).toEqual({ windowMin: 20, threshold: 0.7 });
  });

  it('garbage / out-of-range overrides fall back to the defaults', () => {
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN', 'not-a-number');
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE_THRESHOLD', '1.7');
    expect(recentDupeConfig()).toEqual({ windowMin: 10, threshold: 0.5 });
  });

  it('a higher threshold suppresses a match that a lower one would have caught', async () => {
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE_THRESHOLD', '0.99');
    const r = await findRecentLexicalDupes(
      { title: 'alpha bravo charlie delta' },
      depsWith([row('WI-1', 'alpha bravo charlie echo')]),
    );
    expect(r?.candidates).toEqual([]);
  });
});

describe('fail-open — every failure mode returns null (create proceeds)', () => {
  it('query throw', async () => {
    const deps: RecentLexicalDupeDeps = {
      queryRecentOpenItems: async () => {
        throw new Error('db down');
      },
    };
    expect(await findRecentLexicalDupes({ title: 't' }, deps)).toBeNull();
  });

  it('budget expiry: a hung query forfeits the verdict instead of blocking the create', async () => {
    vi.useFakeTimers();
    try {
      const deps: RecentLexicalDupeDeps = {
        queryRecentOpenItems: () => new Promise(() => {}), // never settles
      };
      const p = findRecentLexicalDupes({ title: 't' }, deps);
      await vi.advanceTimersByTimeAsync(1600);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill switch PAPERCUSP_WI_RECENT_DUPE=off short-circuits before any query', async () => {
    vi.stubEnv('PAPERCUSP_WI_RECENT_DUPE', 'off');
    let touched = false;
    const deps: RecentLexicalDupeDeps = {
      queryRecentOpenItems: async () => {
        touched = true;
        return { rows: [], truncated: false };
      },
    };
    expect(await findRecentLexicalDupes({ title: 't' }, deps)).toBeNull();
    expect(touched).toBe(false);
  });

  it('inert under vitest WITHOUT injected deps (never hits real PG in unrelated tests)', async () => {
    expect(await findRecentLexicalDupes({ title: 't' })).toBeNull();
  });
});
