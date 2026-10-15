/**
 * messages-outbox-pushdown.test.ts — EI-19323734935411369: `readOutbox` was the
 * last PRIMARY caller of the unbounded `coordLog.readLines('messages')`. It
 * loaded the ENTIRE messages surface (measured 2026-08-02: 76,209 rows / 63 MB
 * of JSONB bodies, per call, 349,842 calls) only to filter by `from` in JS —
 * even though every routine caller already passes `since_ts`.
 *
 * These pin the sender+since pushdown and, more importantly, the three traps it
 * could regress into:
 *   - the `id DESC` cap order (EI-19314819320465915 — `ASC` silently freezes the
 *     view on the OLDEST rows once a sender exceeds the cap),
 *   - an unparseable `since_ts` (NaN) reaching `new Date(...).toISOString()`,
 *   - the fast path and the fallback drifting apart in what they RETURN.
 *
 * The messages-get-by-id.test.ts recipe: only ./log is mocked, so both branches
 * are exercised with no DB.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/messages-outbox-pushdown.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const { sqlMock, readLinesMock, fastPathState } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  readLinesMock: vi.fn(async () => [] as unknown[]),
  fastPathState: { on: false },
}));

vi.mock('./log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => fastPathState.on,
}));

import type { CoordEnvelope } from '@papercusp/coordination/core';
import {
  readOutbox,
  readOutboxWindow,
  OUTBOX_FAST_PATH_ROW_CAP,
  INBOX_PAGE_ROWS,
} from './messages';

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: '2026-08-02T12:00:00.000Z',
    msg_id: 'm0',
    from: 'alice',
    to: ['bob'],
    kind: 'message',
    ...p,
  } as CoordEnvelope;
}

/**
 * `sql` is a tagged template AND is called again for the conditional
 * `AND ts >= …` fragment. JS evaluates substitutions before the outer tag, so
 * the fragment call lands FIRST. This routes only the SELECT call to `rows`,
 * and records the outer call's text + values for assertion.
 */
function primeSql(rows: { body: unknown }[]) {
  const seen: { text: string; values: unknown[] }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (!text.includes('SELECT body')) return { fragment: text, values }; // the AND ts >= … piece
    seen.push({ text, values });
    return Promise.resolve(rows);
  });
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  fastPathState.on = false;
  readLinesMock.mockResolvedValue([]);
});

describe('readOutbox — non-PG backend (fallback)', () => {
  it('filters by sender and sorts ascending by (ts, msg_id)', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'b1', from: 'bob', ts: '2026-08-02T12:00:00.000Z' }),
      env({ msg_id: 'a2', from: 'alice', ts: '2026-08-02T12:00:02.000Z' }),
      env({ msg_id: 'a1', from: 'alice', ts: '2026-08-02T12:00:01.000Z' }),
    ]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1', 'a2']);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('since_ts filters strictly later than the cutoff', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'old', ts: '2026-08-02T12:00:00.000Z' }),
      env({ msg_id: 'at', ts: '2026-08-02T12:00:01.000Z' }),
      env({ msg_id: 'new', ts: '2026-08-02T12:00:02.000Z' }),
    ]);
    const out = await readOutbox('alice', { since_ts: '2026-08-02T12:00:01.000Z' });
    expect(out.map((e) => e.msg_id)).toEqual(['new']);
  });
});

describe('readOutbox — PG fast path (sender pushdown)', () => {
  beforeEach(() => {
    fastPathState.on = true;
  });

  it('pushes sender + workspace + surface into SQL and never scans the whole surface', async () => {
    const seen = primeSql([{ body: env({ msg_id: 'a1' }) }]);
    const out = await readOutbox('alice');

    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
    expect(readLinesMock).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toContain("body->>'from'");
    expect(seen[0].values).toContain('alice');
  });

  it('caps rows with ORDER BY id DESC — never ASC, which would freeze the view on the OLDEST rows', async () => {
    const seen = primeSql([]);
    await readOutbox('alice');

    const sqlText = seen[0].text.replace(/\s+/g, ' ');
    expect(sqlText).toContain('ORDER BY id DESC');
    expect(sqlText).not.toContain('ORDER BY id ASC');
    expect(seen[0].values).toContain(OUTBOX_FAST_PATH_ROW_CAP);
  });

  it('a since_ts becomes a SKEW-PADDED ts lower bound (padded EARLIER, never later)', async () => {
    const seen = primeSql([]);
    const since = '2026-08-02T12:00:00.000Z';
    await readOutbox('alice', { since_ts: since });

    // The padded bound rides the fragment call, not the SELECT call.
    const fragment = sqlMock.mock.results
      .map((r) => r.value)
      .find((v) => v && typeof v === 'object' && 'fragment' in v) as
      | { fragment: string; values: unknown[] }
      | undefined;
    expect(fragment?.fragment).toContain('AND ts >=');
    const bound = String(fragment?.values[0]);
    expect(new Date(bound).getTime()).toBeLessThan(new Date(since).getTime());
  });

  it('omits the ts bound entirely when no since_ts is given (the sync-resolver call shape)', async () => {
    primeSql([]);
    await readOutbox('alice');
    const fragments = sqlMock.mock.results
      .map((r) => r.value)
      .filter((v) => v && typeof v === 'object' && 'fragment' in v) as { fragment: string }[];
    expect(fragments.every((f) => !f.fragment.includes('AND ts >='))).toBe(true);
  });

  it('an UNPARSEABLE since_ts does not throw (NaN must never reach toISOString) and drops the bound', async () => {
    primeSql([{ body: env({ msg_id: 'a1' }) }]);
    const out = await readOutbox('alice', { since_ts: 'not-a-timestamp' });
    // NaN degrades to "no lower bound" — the pre-existing behaviour, not a crash.
    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
    const fragments = sqlMock.mock.results
      .map((r) => r.value)
      .filter((v) => v && typeof v === 'object' && 'fragment' in v) as { fragment: string }[];
    expect(fragments.every((f) => !f.fragment.includes('AND ts >='))).toBe(true);
  });

  it('re-sorts ASCENDING even though SQL fetched DESC — the SQL order picks rows, not presentation', async () => {
    primeSql([
      { body: env({ msg_id: 'a3', ts: '2026-08-02T12:00:03.000Z' }) },
      { body: env({ msg_id: 'a2', ts: '2026-08-02T12:00:02.000Z' }) },
      { body: env({ msg_id: 'a1', ts: '2026-08-02T12:00:01.000Z' }) },
    ]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('a JSON-STRING body is parsed (PgCoordLog may hand back text)', async () => {
    primeSql([{ body: JSON.stringify(env({ msg_id: 'a1' })) }]);
    const out = await readOutbox('alice');
    expect(out[0].msg_id).toBe('a1');
  });

  it('re-applies the sender filter as the final authority, so a mismatched row can never leak', async () => {
    primeSql([{ body: env({ msg_id: 'a1' }) }, { body: env({ msg_id: 'b1', from: 'bob' }) }]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
  });

  it('re-applies since_ts as the final authority (the SQL bound is padded, so it over-fetches on purpose)', async () => {
    primeSql([
      { body: env({ msg_id: 'padded-in', ts: '2026-08-02T11:55:00.000Z' }) },
      { body: env({ msg_id: 'real', ts: '2026-08-02T12:00:05.000Z' }) },
    ]);
    const out = await readOutbox('alice', { since_ts: '2026-08-02T12:00:00.000Z' });
    expect(out.map((e) => e.msg_id)).toEqual(['real']);
  });

  it('warns — never silently truncates — when the row cap is hit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    primeSql(
      Array.from({ length: OUTBOX_FAST_PATH_ROW_CAP }, (_, i) => ({
        body: env({ msg_id: `m${i}`, ts: new Date(Date.UTC(2026, 7, 2, 12, 0, 0) + i).toISOString() }),
      })),
    );
    await readOutbox('alice');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fast-path row cap'));
    warn.mockRestore();
  });

  it('a query error propagates and never loads the whole surface (host-memory-reduction-2026-09-27 D-011)', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (!text.includes('SELECT body')) return { fragment: text, values: [] };
      throw new Error('connection terminated');
    });
    await expect(readOutbox('alice')).rejects.toThrow('connection terminated');
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('both paths return the SAME result for the same data (no drift between fast path and fallback)', async () => {
    const rows = [
      env({ msg_id: 'a2', ts: '2026-08-02T12:00:02.000Z' }),
      env({ msg_id: 'a1', ts: '2026-08-02T12:00:01.000Z' }),
      env({ msg_id: 'b1', from: 'bob', ts: '2026-08-02T12:00:03.000Z' }),
    ];
    primeSql(rows.map((body) => ({ body })));
    const viaPg = await readOutbox('alice');

    fastPathState.on = false;
    readLinesMock.mockResolvedValue(rows);
    const viaLines = await readOutbox('alice');

    expect(viaPg).toEqual(viaLines);
  });
});

/**
 * EI-19340198432470691 — the BOUNDED window half of readOutbox.
 *
 * The single-shot path above was covered; the window path was not, in either
 * form. It is the half that can fail SILENTLY: a stopping rule that never fires
 * restores the unbounded read this exists to remove, and a dropped `exhausted`
 * turns "48 messages" from a fact into a floor presented as a census.
 *
 * The keyset pager issues `SELECT id, body` (it needs the cursor column), which
 * is why it needs its own primer — `primeSql` routes on `SELECT body` and would
 * hand the pager the fragment stub instead of rows.
 */
function primeWindowSql(pages: { id: number; body: unknown }[][]) {
  const queries: unknown[][] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (!text.includes('SELECT id, body')) return { fragment: text, values };
    queries.push(values);
    return Promise.resolve(pages[queries.length - 1] ?? []);
  });
  return queries;
}

/**
 * A page of `n` envelopes from `alice`, newest-first like the SQL `id DESC`.
 *
 * The base instant is FIXED — never `Date.now()`. The delegation test below primes
 * each call form with its OWN `page(4)` and then asserts the two results are deeply
 * equal, so a per-call clock read made the fixtures differ by exactly 1ms whenever
 * the two calls straddled a millisecond boundary. That is load-sensitive, so it grew
 * likelier exactly when the gate was busiest, and the gate's fresh-process flake
 * absorption did not absorb it: it red-pinned the green-checkpoint on 2026-08-02 with
 * a diff whose entire content was `…645Z` vs `…644Z` (WI-7207).
 *
 * Nothing here depends on the timestamps being near NOW — paging is keyset-on-`id`,
 * and the assertions are on lengths, counts and the `exhausted` flag. Pinning also
 * matches what the rest of this file already does (`env()` defaults to this same
 * instant; the INBOX_PAGE_ROWS fixture uses `Date.UTC(2026, 7, 2, 12, 0, 0)`).
 */
const PAGE_BASE_MS = Date.UTC(2026, 7, 2, 12, 0, 0);
const page = (n: number, startId = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: startId + n - i,
    body: env({ msg_id: `m${startId + n - i}`, ts: new Date(PAGE_BASE_MS - i * 1000).toISOString() }),
  }));

describe('readOutboxWindow — bounded keyset-paged read (EI-19340198432470691)', () => {
  beforeEach(() => {
    fastPathState.on = true;
  });

  it('stops at the first page once the caller has enough, and reports NOT exhausted', async () => {
    const queries = primeWindowSql([page(INBOX_PAGE_ROWS), page(INBOX_PAGE_ROWS, 5000)]);
    const got = await readOutboxWindow('alice', {}, (entries) => entries.length >= 50);
    // One page only: a full page that satisfied the rule must not fetch another.
    expect(queries).toHaveLength(1);
    expect(got.entries.length).toBe(INBOX_PAGE_ROWS);
    expect(got.rowsScanned).toBe(INBOX_PAGE_ROWS);
    expect(got.pages).toBe(1);
    // The caller stopped us early, so older mail may exist — say so.
    expect(got.exhausted).toBe(false);
  });

  it('pages on when the rule is unsatisfied, and a SHORT page means exhausted', async () => {
    const queries = primeWindowSql([page(INBOX_PAGE_ROWS), page(3, 5000)]);
    const got = await readOutboxWindow('alice', {}, () => false);
    expect(queries).toHaveLength(2);
    expect(got.pages).toBe(2);
    expect(got.rowsScanned).toBe(INBOX_PAGE_ROWS + 3);
    // History ran out rather than the caller stopping us — the count is real.
    expect(got.exhausted).toBe(true);
  });

  it('a first page shorter than the page size is exhausted immediately', async () => {
    primeWindowSql([page(2)]);
    const got = await readOutboxWindow('alice', {}, () => false);
    expect(got.pages).toBe(1);
    expect(got.exhausted).toBe(true);
    expect(got.entries).toHaveLength(2);
  });

  it('applies the sender filter and returns ASCENDING despite paging id DESC', async () => {
    primeWindowSql([
      [
        { id: 3, body: env({ msg_id: 'a2', ts: '2026-08-02T12:00:02.000Z' }) },
        { id: 2, body: env({ msg_id: 'b1', from: 'bob', ts: '2026-08-02T12:00:03.000Z' }) },
        { id: 1, body: env({ msg_id: 'a1', ts: '2026-08-02T12:00:01.000Z' }) },
      ],
    ]);
    const got = await readOutboxWindow('alice', {}, () => false);
    expect(got.entries.map((e) => e.msg_id)).toEqual(['a1', 'a2']); // bob dropped, ascending
  });

  it('readOutbox(…, window) DELEGATES here — same entries, boundary discarded', async () => {
    primeWindowSql([page(4)]);
    const viaArrayForm = await readOutbox('alice', {}, { enough: () => false });
    primeWindowSql([page(4)]);
    const viaWindowForm = await readOutboxWindow('alice', {}, () => false);
    // One implementation, so the two shapes cannot drift in what they return.
    expect(viaArrayForm).toEqual(viaWindowForm.entries);
  });

  it('falls back to the authoritative full read on a non-PG seam, reporting exhausted', async () => {
    fastPathState.on = false;
    readLinesMock.mockResolvedValue([env({ msg_id: 'a1' }), env({ msg_id: 'b1', from: 'bob' })]);
    const got = await readOutboxWindow('alice', {}, () => false);
    expect(got.entries.map((e) => e.msg_id)).toEqual(['a1']);
    // That read IS the whole history, so the boundary claim is honest.
    expect(got.exhausted).toBe(true);
  });
});
