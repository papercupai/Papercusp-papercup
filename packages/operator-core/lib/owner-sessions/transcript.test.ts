/**
 * mobile-agent-sessions-2026-10-12 P-001: owner-history pages are read through
 * one function for the desktop stream (`/adv/session/thinking?historyPage=1`)
 * and the device transcript route, so a cursor issued by either pages the
 * same way on both. These pin that function's refusal and paging contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));

import { encodeOwnerHistoryCursor, readOwnerHistoryPage } from './transcript';

const CURSOR = { at: '2026-10-12T21:00:00.123456Z', sourceKind: 'claude', sessionId: 's-1', turnIdx: 4 };

beforeEach(() => {
  db.sql.mockReset();
});

describe('readOwnerHistoryPage', () => {
  it('refuses a malformed cursor with 400 and never queries', async () => {
    await expect(readOwnerHistoryPage('su-a', { cursorRaw: 'not-a-cursor' })).resolves.toEqual({
      ok: false, status: 400, error: 'invalid historyCursor',
    });
    expect(db.sql).not.toHaveBeenCalled();
  });

  it('refuses an over-long cursor rather than truncating it into a valid one', async () => {
    const page = await readOwnerHistoryPage('su-a', { cursorRaw: encodeOwnerHistoryCursor(CURSOR) + 'x'.repeat(900) });
    expect(page).toEqual({ ok: false, status: 400, error: 'invalid historyCursor' });
  });

  it('answers 503 when the history store cannot be read', async () => {
    db.sql.mockRejectedValueOnce(new Error('pool closed'));
    await expect(readOwnerHistoryPage('su-a')).resolves.toEqual({
      ok: false, status: 503, error: 'owner history unavailable',
    });
  });

  it('pages from a valid cursor and hands back the next cursor', async () => {
    db.sql.mockResolvedValueOnce([
      { event_at: '2026-10-12T20:00:00Z', source_kind: 'claude', session_id: 's-0', turn_idx: 1, speaker: 'user', text: 'look-behind' },
      { event_at: '2026-10-12T20:30:00Z', source_kind: 'claude', session_id: 's-0', turn_idx: 2, speaker: 'user', text: 'ask' },
      { event_at: '2026-10-12T20:31:00Z', source_kind: 'claude', session_id: 's-0', turn_idx: 3, speaker: 'assistant', text: 'answer' },
    ]);
    const page = await readOwnerHistoryPage('su-a', { cursorRaw: encodeOwnerHistoryCursor(CURSOR), cap: 2 });
    expect(page).toMatchObject({
      ok: true,
      hasMore: true,
      entries: [{ kind: 'prompt', text: 'ask' }, { kind: 'text', text: 'answer' }],
    });
    expect(page.ok && page.cursor).toBe(encodeOwnerHistoryCursor({
      at: '2026-10-12T20:30:00Z', sourceKind: 'claude', sessionId: 's-0', turnIdx: 2,
    }));
    // The cursor's full ordering tuple reaches the query, as text (microseconds kept).
    expect(db.sql.mock.calls[0].slice(1)).toEqual(expect.arrayContaining([
      CURSOR.at, CURSOR.sourceKind, CURSOR.sessionId, CURSOR.turnIdx,
    ]));
  });

  it('returns an empty final page for an owner with no history', async () => {
    db.sql.mockResolvedValueOnce([]);
    await expect(readOwnerHistoryPage('su-none')).resolves.toEqual({
      ok: true, entries: [], hasMore: false, cursor: null,
    });
  });
});
