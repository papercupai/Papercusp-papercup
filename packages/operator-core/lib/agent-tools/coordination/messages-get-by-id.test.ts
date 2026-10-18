/**
 * messages-get-by-id.test.ts — WI-3832 regression: getMessageById must find a
 * message by msg_id WITHOUT going through the handoffs/escalations-only
 * `coordLog.getEvent('messages', …)` call (a real TS2345 compile error, and a
 * genuine runtime gap on the in-memory/fs test backends — see the fix's
 * comment in messages.ts for the full story). Both the PG-fast-path branch and
 * the readLines fallback are covered directly (no DB required — coordSql/
 * coordHasPgFastPath/coordLog are mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { getMessageById, getMessagesByIds } from './messages';

beforeEach(() => {
  vi.clearAllMocks();
  fastPathState.on = false;
});

describe('getMessageById (WI-3832)', () => {
  it('returns null for an empty msgId without touching the store', async () => {
    expect(await getMessageById('')).toBeNull();
    expect(readLinesMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('non-PG backend (test/dev): finds the message by scanning readLines("messages")', async () => {
    readLinesMock.mockResolvedValueOnce([
      { msg_id: 'other', from: 'a', to: ['b'], kind: 'note', ts: '2026-07-10T00:00:00Z' },
      { msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: '2026-07-10T00:00:01Z', summary: 'hi' },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
    expect(found?.summary).toBe('hi');
    expect(readLinesMock).toHaveBeenCalledWith('messages');
  });

  it('non-PG backend: returns null when no message matches', async () => {
    readLinesMock.mockResolvedValueOnce([{ msg_id: 'other', from: 'a', to: ['b'], kind: 'note', ts: 't' }]);
    expect(await getMessageById('missing')).toBeNull();
  });

  it('PG fast path: queries coord_event_log directly and does not fall back to readLines', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: { msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: 't', summary: 'hi', harness_slug: 'body-hive' }, ts: 't', msg_id: 'orig', harness_slug: 'column-hive' },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
    expect(found?.harness_slug).toBe('column-hive');
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('PG fast path: the indexed row id wins over a stale legacy body id', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: { msg_id: 'legacy-stale-body-id', from: 'a', to: ['b'], kind: 'note', ts: 't' }, ts: 't', msg_id: 'orig', harness_slug: null },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('PG fast path: a null scope column makes a stale body scope local', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: { msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: 't', harness_slug: 'stale-body-hive' }, ts: 't', msg_id: 'orig', harness_slug: null },
    ]);
    const found = await getMessageById('orig');
    expect(found).not.toHaveProperty('harness_slug');
  });

  it('PG fast path: a JSON-string body is parsed', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: JSON.stringify({ msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: 't' }), ts: 't', msg_id: 'orig', harness_slug: null },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
  });

  it('PG fast path: no rows -> null, no fallback scan', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => []);
    expect(await getMessageById('nope')).toBeNull();
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('PG fast path: batch lookup finds selected ids without scanning a newest-first window', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: { msg_id: 'one', from: 'a', to: ['human'], kind: 'message' }, ts: 't', msg_id: 'one', harness_slug: null },
      { body: { msg_id: 'two', from: 'a', to: ['human'], kind: 'message' }, ts: 't', msg_id: 'two', harness_slug: null },
    ]);
    const found = await getMessagesByIds(['one', 'two', 'one']);
    expect([...found.keys()]).toEqual(['one', 'two']);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('PG fast path: a query error propagates and never scans readLines (host-memory-reduction-2026-09-27 D-011)', async () => {
    fastPathState.on = true;
    sqlMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(getMessageById('orig')).rejects.toThrow('boom');
    expect(readLinesMock).not.toHaveBeenCalled();
  });
});
