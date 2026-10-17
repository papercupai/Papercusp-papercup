import { describe, expect, it, vi } from 'vitest';
import {
  refreshLiveSessionsBeforeRead,
  refreshTargetSessionBeforeRead,
  SESSION_READ_REFRESH_TIMEOUT_MS,
  SESSION_TARGET_REFRESH_TIMEOUT_MS,
} from './_shared';
import type { SessionState } from '../coordination/presence-wakeability';

function sqlReturningLiveOwners(owners: string[]) {
  return vi.fn(async (..._args: unknown[]) => owners.map((owner) => ({ owner })));
}

type TestSessionState = SessionState | null;

function livenessResolver(states: Record<string, TestSessionState> = {}) {
  return vi.fn(async (subjects: readonly { ownerId: string }[]) => new Map<string, { sessionState: TestSessionState }>(
    subjects.map(({ ownerId }) => [ownerId, {
      sessionState: Object.prototype.hasOwnProperty.call(states, ownerId)
        ? states[ownerId] ?? null
        : 'live',
    }] as const),
  ));
}

describe('refreshLiveSessionsBeforeRead', () => {
  it('refreshes explicitly requested owners concurrently and preserves owner identity', async () => {
    const ingest = vi.fn(async () => undefined);
    const resolveStates = livenessResolver();
    const resolve = vi.fn(async (owner: string) => ({
      filePath: `/tmp/${owner}.jsonl`,
      sessionId: `session-${owner}`,
    }));
    const sql = sqlReturningLiveOwners(['su-a', 'su-b']);

    const result = await refreshLiveSessionsBeforeRead(sql as never, ['su-a', 'su-b', 'su-a'], {
      resolve,
      ingest,
      resolveStates,
    });

    expect(result).toEqual({ attempted: 2, refreshed: 2 });
    expect(resolveStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-a' }, { ownerId: 'su-b' }],
      { hydrateBatch: true },
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenCalledWith('/tmp/su-a.jsonl', { owner: 'su-a', sessionId: 'session-su-a' });
    expect(ingest).toHaveBeenCalledWith('/tmp/su-b.jsonl', { owner: 'su-b', sessionId: 'session-su-b' });
  });

  it('forwards per-leg timing events to the request-scoped observer', async () => {
    const timings: Array<[string, number, string]> = [];
    const resolveStates = vi.fn(async (
      subjects: readonly { ownerId: string }[],
      options: {
        hydrateBatch: true;
        onTiming?: (leg: string, durationMs: number, outcome: 'ok' | 'error') => void;
      },
    ) => {
      options.onTiming?.('fetchWakeability', 19, 'ok');
      return new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'live' as const }]));
    });

    const result = await refreshLiveSessionsBeforeRead(sqlReturningLiveOwners(['su-a']) as never, ['su-a'], {
      resolveStates,
      resolve: async () => ({ filePath: '/tmp/su-a.jsonl', sessionId: 'session-su-a' }),
      ingest: async () => undefined,
      onLivenessTiming: (leg, durationMs, outcome) => timings.push([leg, durationMs, outcome]),
    });

    expect(result).toEqual({ attempted: 1, refreshed: 1 });
    expect(resolveStates).toHaveBeenCalledWith(
      [{ ownerId: 'su-a' }],
      { hydrateBatch: true, onTiming: expect.any(Function) },
    );
    expect(timings).toEqual([['fetchWakeability', 19, 'ok']]);
  });

  it('fails soft per live session instead of failing the read surface', async () => {
    const resolveStates = livenessResolver();
    const result = await refreshLiveSessionsBeforeRead(sqlReturningLiveOwners(['su-missing', 'su-live']) as never, ['su-missing', 'su-live'], {
      resolve: async (owner) => owner === 'su-live'
        ? { filePath: '/tmp/live.jsonl', sessionId: 'live' }
        : null,
      ingest: async () => undefined,
      resolveStates,
    });

    expect(result).toEqual({
      attempted: 2,
      refreshed: 1,
      failureReasons: { transcript_unavailable: 1 },
    });
  });

  it('intersects historical owner filters with current file-backed sessions before resolving transcripts', async () => {
    const resolve = vi.fn(async (owner: string) => ({
      filePath: `/tmp/${owner}.jsonl`,
      sessionId: `session-${owner}`,
    }));
    const ingest = vi.fn(async () => undefined);
    const resolveStates = livenessResolver();
    const sql = sqlReturningLiveOwners(['su-current-codex', 'su-current-claude', 'su-current-omp']);
    const ownerFilter = [
      'su-current-codex',
      'su-current-claude',
      'su-current-omp',
      'su-ended-a',
      'su-ended-b',
    ];

    const result = await refreshLiveSessionsBeforeRead(
      sql as never,
      ownerFilter,
      { resolve, ingest, resolveStates },
    );

    const [query, passedOwners] = sql.mock.calls[0] ?? [];
    expect((query as TemplateStringsArray).join('')).toContain("agent IN ('claude', 'omp', 'codex')");
    expect(passedOwners).toEqual(ownerFilter);
    expect(result).toEqual({ attempted: 3, refreshed: 3 });
    expect(resolve.mock.calls.map(([owner]) => owner).sort()).toEqual([
      'su-current-claude',
      'su-current-codex',
      'su-current-omp',
    ]);
    expect(ingest).toHaveBeenCalledTimes(3);
  });

  it('filters candidates by canonical liveness before applying the 20-owner cap', async () => {
    const liveOwners = Array.from({ length: 22 }, (_, index) => `su-live-${index}`);
    const candidateOwners = ['su-ended-row', 'su-recorded', 'su-unknown', 'su-suspect', ...liveOwners];
    const resolveStates = livenessResolver({
      'su-ended-row': 'ended',
      'su-recorded': 'recorded',
      'su-unknown': null,
      'su-suspect': 'suspect',
      'su-live-1': 'parked',
      'su-live-2': 'draining',
    });
    const resolve = vi.fn(async (owner: string) => ({
      filePath: `/tmp/${owner}.jsonl`,
      sessionId: `session-${owner}`,
    }));
    const ingest = vi.fn(async () => undefined);
    const sql = sqlReturningLiveOwners(candidateOwners);

    const result = await refreshLiveSessionsBeforeRead(sql as never, candidateOwners, {
      resolve,
      ingest,
      resolveStates,
    });

    const [query, passedOwners] = sql.mock.calls[0] ?? [];
    expect((query as TemplateStringsArray).join('')).toContain('WHERE ended_at IS NULL');
    expect(passedOwners).toEqual(candidateOwners);
    expect(resolveStates).toHaveBeenCalledWith(
      candidateOwners.map((ownerId) => ({ ownerId })),
      { hydrateBatch: true },
    );
    expect(resolve.mock.calls.map(([owner]) => owner)).toEqual(liveOwners.slice(0, 20));
    expect(result).toEqual({ attempted: 20, refreshed: 20, unconfirmed: 3, skipped: 2 });
  });

  it('does not resolve transcripts when canonical liveness lookup times out', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const resolveStates = vi.fn(() => new Promise<never>(() => {}));
      const resolve = vi.fn();
      const pending = refreshLiveSessionsBeforeRead(
        sqlReturningLiveOwners(['su-slow']) as never,
        ['su-slow'],
        { resolveStates, resolve, ingest: vi.fn() },
      );

      await vi.advanceTimersByTimeAsync(SESSION_READ_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 0,
        refreshed: 0,
        unconfirmed: 1,
        failureReasons: { liveness_lookup_timeout: 1 },
      });
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('degrades a slow live resolve or ingest within the read budget', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ingest = vi.fn(() => new Promise<never>(() => {}));
      const resolveStates = livenessResolver();
      const pending = refreshLiveSessionsBeforeRead(sqlReturningLiveOwners(['su-slow']) as never, ['su-slow'], {
        resolve: async () => ({ filePath: '/tmp/slow.jsonl', sessionId: 'slow' }),
        ingest,
        resolveStates,
      });

      await vi.advanceTimersByTimeAsync(SESSION_READ_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 1,
        refreshed: 0,
        failureReasons: { ingest_timeout: 1 },
      });
      expect(ingest).toHaveBeenCalledWith('/tmp/slow.jsonl', { owner: 'su-slow', sessionId: 'slow' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions:live refresh'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('refreshes an active target session with its resolved owner and target id', async () => {
    const sql = vi.fn(async () => [{
      id: 42,
      agent: 'codex',
      owner: 'su-owner',
      session_id: 'target-session',
      omp_thread_id: null,
    }]) as never;
    const resolve = vi.fn(async (sourceKind: string, sessionId: string) => ({
      filePath: `/tmp/${sourceKind}/${sessionId}.jsonl`,
      sessionId,
    }));
    const ingest = vi.fn(async () => undefined);

    const result = await refreshTargetSessionBeforeRead(sql, undefined, 'target-session', { resolve, ingest });

    expect(result).toEqual({ attempted: 1, refreshed: 1 });
    expect(resolve).toHaveBeenCalledWith('codex', 'target-session', expect.objectContaining({ id: 42, owner: 'su-owner' }));
    expect(ingest).toHaveBeenCalledWith('/tmp/codex/target-session.jsonl', {
      owner: 'su-owner',
      sessionId: 'target-session',
    });
  });

  it('degrades a slow active-target ingest so the indexed read can continue', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sql = vi.fn(async () => [{
        id: 42,
        agent: 'codex',
        owner: 'su-owner',
        session_id: 'target-session',
        omp_thread_id: null,
      }]) as never;
      const ingest = vi.fn(() => new Promise<never>(() => {}));

      const pending = refreshTargetSessionBeforeRead(sql, 'codex', 'target-session', {
        resolve: async () => ({ filePath: '/tmp/codex/target-session.jsonl', sessionId: 'target-session' }),
        ingest,
      });

      await vi.advanceTimersByTimeAsync(SESSION_TARGET_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 1,
        refreshed: 0,
        failureReasons: { ingest_timeout: 1 },
      });
      expect(ingest).toHaveBeenCalledWith('/tmp/codex/target-session.jsonl', {
        owner: 'su-owner',
        sessionId: 'target-session',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions:read target refresh'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports only a bounded ingest-error subtype and never logs or returns the raw error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const rawMessage = '/private/session/path: permission denied';
      const ingestError = Object.assign(new Error(rawMessage), { code: 'EACCES' });
      const result = await refreshLiveSessionsBeforeRead(
        sqlReturningLiveOwners(['su-error']) as never,
        ['su-error'],
        {
          resolve: async () => ({ filePath: '/private/session/path', sessionId: 'private-session' }),
          ingest: async () => { throw ingestError; },
          resolveStates: livenessResolver(),
        },
      );

      expect(result).toEqual({
        attempted: 1,
        refreshed: 0,
        failureReasons: { ingest_error: 1 },
        failureSubtypes: { filesystem_access: 1 },
      });
      expect(JSON.stringify(result)).not.toContain(rawMessage);
      expect(JSON.stringify(result)).not.toContain('/private/session/path');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('transcript ingest failed (filesystem_access)'));
      expect(warn.mock.calls.flat().join(' ')).not.toContain(rawMessage);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('/private/session/path');
    } finally {
      warn.mockRestore();
    }
  });

  it('classifies standard database SQLSTATE families without exposing the raw code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ingestError = Object.assign(new Error('private database detail'), { code: '23505' });
      const result = await refreshLiveSessionsBeforeRead(
        sqlReturningLiveOwners(['su-error']) as never,
        ['su-error'],
        {
          resolve: async () => ({ filePath: '/private/session/path', sessionId: 'private-session' }),
          ingest: async () => { throw ingestError; },
          resolveStates: livenessResolver(),
        },
      );

      expect(result.failureReasons).toEqual({ ingest_error: 1 });
      expect(result.failureSubtypes).toEqual({ database_integrity: 1 });
      expect(JSON.stringify(result)).not.toContain('23505');
      expect(JSON.stringify(result)).not.toContain('private database detail');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('private database detail');
      expect(warn.mock.calls.flat().join(' ')).not.toContain('23505');
    } finally {
      warn.mockRestore();
    }
  });

  it('classifies a live transcript resolver error without exposing its raw message', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const resolveStates = livenessResolver();
      const result = await refreshLiveSessionsBeforeRead(sqlReturningLiveOwners(['su-error']) as never, ['su-error'], {
        resolve: async () => { throw new Error('/private/session/path: permission denied'); },
        ingest: async () => undefined,
        resolveStates,
      });

      expect(result).toEqual({ attempted: 1, refreshed: 0, failureReasons: { resolve_error: 1 } });
      expect(JSON.stringify(result)).not.toContain('/private/session/path');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessions:live resolve'));
    } finally {
      warn.mockRestore();
    }
  });

  it('reports a failed live-owner lookup even when no session rows were enumerated', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sql = vi.fn(() => new Promise<never>(() => {})) as never;
      const pending = refreshLiveSessionsBeforeRead(sql, null, {
        resolve: async () => null,
        ingest: async () => undefined,
      });

      await vi.advanceTimersByTimeAsync(SESSION_READ_REFRESH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        attempted: 0,
        refreshed: 0,
        failureReasons: { owner_lookup_timeout: 1 },
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('skips inactive targets so indexed and archive reads keep their existing behavior', async () => {
    const sql = vi.fn(async () => []) as never;
    const resolve = vi.fn();
    const ingest = vi.fn();

    const result = await refreshTargetSessionBeforeRead(sql, 'codex', 'historical-session', { resolve, ingest });

    expect(result).toEqual({ attempted: 0, refreshed: 0 });
    expect(resolve).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
});
