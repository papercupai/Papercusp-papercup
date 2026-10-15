import { describe, expect, it } from 'vitest';
import {
  decodeSessionCursor,
  encodeSessionCursor,
  sessionCursorBoundsMatch,
  sessionCursorFingerprint,
  sessionCursorQueryFingerprint,
} from './cursor';

describe('sessions cursor contract', () => {
  it('round-trips a bounded offset and is stable across object key order', () => {
    const fingerprint = sessionCursorFingerprint({ owner: 'su-1', filters: { since: '2026-07-13', kind: 'codex' } });
    expect(fingerprint).toBe(
      sessionCursorFingerprint({ filters: { kind: 'codex', since: '2026-07-13' }, owner: 'su-1' }),
    );
    expect(sessionCursorFingerprint({ owner: 'su-1', workspace_id: 'workspace-a' })).not.toBe(
      sessionCursorFingerprint({ owner: 'su-2', workspace_id: 'workspace-a' }),
    );
    expect(sessionCursorFingerprint({ owner: 'su-1', workspace_id: 'workspace-a' })).not.toBe(
      sessionCursorFingerprint({ owner: 'su-1', workspace_id: 'workspace-b' }),
    );
    const bounds = { until: '2026-07-14T03:00:00.000Z' };
    const cursor = encodeSessionCursor('sessions:list', 25, fingerprint, bounds);
    expect(decodeSessionCursor(cursor, 'sessions:list', fingerprint)).toEqual({
      ok: true,
      offset: 25,
      bounds,
    });
  });

  it('fails closed across tools, changed filters, malformed values, and oversized offsets', () => {
    const fingerprint = sessionCursorFingerprint({ owner: 'su-1' });
    const cursor = encodeSessionCursor('sessions:list', 10, fingerprint);
    expect(decodeSessionCursor(cursor, 'sessions:search', fingerprint)).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor(cursor, 'sessions:list', sessionCursorFingerprint({ owner: 'su-2' }))).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor('not-json', 'sessions:list', fingerprint)).toEqual({
      ok: false,
      error: 'invalid_cursor',
      message: 'Cursor is malformed.',
    });
    expect(decodeSessionCursor(encodeSessionCursor('sessions:list', 501, fingerprint), 'sessions:list', fingerprint)).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor(
      encodeSessionCursor('sessions:list', 10, fingerprint, { until: 'not-a-date' }),
      'sessions:list',
      fingerprint,
    )).toMatchObject({ ok: false, error: 'invalid_cursor' });
  });

  it('rejects an owner:self cursor replayed by another caller or workspace', () => {
    const query = { owner: 'self', include_auto: true };
    const ownerAFingerprint = sessionCursorFingerprint(query, {
      workspaceId: 'workspace-a',
      selfOwnerId: 'su-a',
      selfSessionId: 'session-a',
    });
    const cursor = encodeSessionCursor('sessions:timeline', 1, ownerAFingerprint, {
      since: '2026-07-13T03:00:00.000Z',
      until: '2026-07-14T03:00:00.000Z',
    });

    expect(decodeSessionCursor(cursor, 'sessions:timeline', sessionCursorFingerprint(query, {
      workspaceId: 'workspace-a',
      selfOwnerId: 'su-crossidentity-probe',
      selfSessionId: 'session-probe',
    }))).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor(cursor, 'sessions:timeline', sessionCursorFingerprint(query, {
      workspaceId: 'workspace-b',
      selfOwnerId: 'su-a',
      selfSessionId: 'session-a',
    }))).toMatchObject({ ok: false, error: 'invalid_cursor' });
  });

  it('replays a timeline cursor with its carried bounds when bounds are omitted', () => {
    const authority = {
      workspaceId: 'workspace-a',
      selfOwnerId: 'su-a',
      selfSessionId: 'session-a',
    };
    const initial = {
      owner: 'self',
      kinds: ['tool'],
      include_auto: true,
      since: '2026-07-13T03:00:00.000Z',
      until: '2026-07-14T03:00:00.000Z',
    };
    const replay = {
      owner: 'self',
      kinds: ['tool'],
      include_auto: true,
    };
    const fingerprint = sessionCursorQueryFingerprint(initial, authority);
    const cursor = encodeSessionCursor('sessions:timeline', 1, fingerprint, {
      since: initial.since,
      until: initial.until,
    });

    expect(decodeSessionCursor(
      cursor,
      'sessions:timeline',
      sessionCursorQueryFingerprint(replay, authority),
    )).toEqual({
      ok: true,
      offset: 1,
      bounds: { since: initial.since, until: initial.until },
    });
    expect(sessionCursorBoundsMatch({}, { since: initial.since, until: initial.until })).toBe(true);
    expect(sessionCursorBoundsMatch(
      { until: '2026-07-14T04:00:00.000Z' },
      { since: initial.since, until: initial.until },
    )).toBe(false);
  });

  it('replays when timeline filters use equivalent omitted defaults and kind sets', () => {
    const authority = { workspaceId: 'workspace-a', selfOwnerId: 'su-a' };
    const initial = {
      owner: 'self',
      kinds: ['tool', 'turn'],
    };
    const replay = {
      owner: 'self',
      kinds: ['turn', 'tool', 'tool'],
      include_auto: false,
      group_repeated: false,
    };
    const fingerprint = sessionCursorQueryFingerprint(initial, authority);
    const cursor = encodeSessionCursor('sessions:timeline', 2, fingerprint, {
      since: '2026-07-13T03:00:00.000Z',
      until: '2026-07-14T03:00:00.000Z',
    });

    expect(decodeSessionCursor(
      cursor,
      'sessions:timeline',
      sessionCursorQueryFingerprint(replay, authority),
    )).toEqual({
      ok: true,
      offset: 2,
      bounds: {
        since: '2026-07-13T03:00:00.000Z',
        until: '2026-07-14T03:00:00.000Z',
      },
    });
    expect(sessionCursorQueryFingerprint({ ...replay, include_auto: true }, authority))
      .not.toBe(fingerprint);
    expect(sessionCursorQueryFingerprint({ ...replay, group_repeated: true }, authority))
      .not.toBe(fingerprint);
  });
});
