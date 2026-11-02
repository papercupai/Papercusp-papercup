import type { ActivityRecord } from '@papercusp/activity-bridge';
import { describe, expect, it, vi } from 'vitest';
import { LOOP_TURN_START_MARKER, SESSION_END_MARKER, SESSION_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { indexedLoopTurnStartRecord, isLoopFirePrompt, isLoopTurnStartCandidate, loopTurnStartRecord, readLoopFireIdentityForCurrentTurn, recordLoopTurnStart, type IndexedNativeLoopTurn } from './loop-turn-start-stamp';
import { LOOP_FIRE_PROVENANCE_TTL_MS, type LedgerRow } from '../../turn-provenance/turn-provenance';

// EI-24791346664119438: the turn-start endpoint stamps a loop-fire turn start in real time so
// reconcile-loop-routines can tell a long-running loop turn from a wake that never became one.

const LOOP_PROMPT = '⟦turn-origin:loop-fire nonce:8ed10949adab325d⟧\n🔁 Loop wake (every 15m). continue';
const SELF_COMPACTION_PROMPT = '⟦turn-origin:self-compaction nonce:0123456789abcdef⟧\nContinue the verified loop work.';

describe('indexed native producer validation', () => {
  const submitted = Date.parse('2026-10-23T14:48:15Z');
  const turn: IndexedNativeLoopTurn = {
    workspace_id: 'default', source_kind: 'codex', session_id: 'native-1', turn_idx: 27,
    ts: new Date(submitted).toISOString(), owner: 'su-native', speaker: 'user',
    text: LOOP_PROMPT, turn_origin: 'loop-fire',
  };
  const enrollment: LedgerRow = {
    sid: 'su-native', nonce: '8ed10949adab325d', origin: 'loop-fire',
    sha256: 'transit-mangled-payload-is-not-a-provenance-wall', ts: submitted - 1000,
    loopFire: { routineId: 'routine-10', wakeCount: 10 },
  };

  it.each(['claude', 'codex', 'omp'])('retains exact attribution for %s at the original submission time', source => {
    const result = indexedLoopTurnStartRecord({ ...turn, source_kind: source }, [enrollment]);
    expect(result).toMatchObject({
      workspaceId: 'default', owner: 'su-native', sessionId: 'native-1', agent: source,
      detail: {
        source: 'session-ingest', origin: 'loop-fire', nonce: enrollment.nonce,
        loopFire: { routineId: 'routine-10', wakeCount: 10 },
        indexedTurn: { workspaceId: 'default', sourceKind: source, sessionId: 'native-1', turnIdx: 27 },
      },
    });
    expect(result).not.toHaveProperty('created_at');
  });

  it.each([
    ['assistant', { speaker: 'assistant' }], ['foreign source', { source_kind: 'agent_chat' }],
    ['foreign owner', { owner: 'someone-else' }], ['missing owner', { owner: null }],
    ['non-loop origin', { turn_origin: 'wake-pump' }], ['missing time', { ts: null }],
    ['invalid time', { ts: 'invalid' }], ['invalid index', { turn_idx: -1 }],
    ['wrong nonce', { text: LOOP_PROMPT.replace(enrollment.nonce, 'aaaaaaaaaaaaaaaa') }],
  ] as const)('rejects %s', (_label, change) => {
    expect(indexedLoopTurnStartRecord({ ...turn, ...change }, [enrollment])).toBeNull();
  });

  it('keeps missing enrollment unknown', () => {
    expect(indexedLoopTurnStartRecord(turn, [])).toBeNull();
  });

  it('retains the loop fire identity when the client submits 615s after host acceptance', () => {
    const acceptedAt = submitted;
    const delayedTurn = { ...turn, ts: new Date(acceptedAt + 615_000).toISOString() };
    const delayedEnrollment = { ...enrollment, ts: acceptedAt, ttlMs: LOOP_FIRE_PROVENANCE_TTL_MS };

    // The global 10-minute TTL reproduces the reported failure: the bytes were
    // accepted by the host, but the later client turn cannot be attributed.
    expect(indexedLoopTurnStartRecord(delayedTurn, [{ ...delayedEnrollment, ttlMs: undefined }])).toBeNull();
    expect(indexedLoopTurnStartRecord(delayedTurn, [delayedEnrollment])).toMatchObject({
      detail: { loopFire: { routineId: 'routine-10', wakeCount: 10 } },
    });
  });

  it('indexes a self-compaction turn only when its provenance row carries typed loop lineage', () => {
    const continuationTurn = { ...turn, text: SELF_COMPACTION_PROMPT, turn_origin: 'self-compaction' };
    const continuationEnrollment = {
      ...enrollment,
      nonce: '0123456789abcdef',
      origin: 'self-compaction',
      loopFire: { routineId: 'routine-10', wakeCount: 10 },
    };

    expect(indexedLoopTurnStartRecord(continuationTurn, [continuationEnrollment])).toMatchObject({
      detail: {
        origin: 'self-compaction',
        nonce: continuationEnrollment.nonce,
        loopFire: { routineId: 'routine-10', wakeCount: 10 },
        indexedTurn: { sourceKind: 'codex', sessionId: 'native-1', turnIdx: 27 },
      },
    });
    expect(indexedLoopTurnStartRecord(continuationTurn, [{
      ...continuationEnrollment,
      loopFire: undefined,
    } as LedgerRow])).toBeNull();
  });

  it.each([
    ['foreign owner', { sid: 'someone-else' }], ['foreign origin', { origin: 'wake-pump' }],
    ['future enrollment', { ts: submitted + 1 }],
    ['expired at submission', { ts: submitted - 600_001, ttlMs: 600_000 }],
    ['missing fire', { loopFire: undefined }],
    ['malformed fire', { loopFire: { routineId: '', wakeCount: 10 } }],
    ['invalid wake number', { loopFire: { routineId: 'routine-10', wakeCount: 0 } }],
  ])('rejects %s', (_label, change) => {
    expect(indexedLoopTurnStartRecord(turn, [{ ...enrollment, ...change } as LedgerRow])).toBeNull();
  });
});

describe('loop-turn-start-stamp', () => {
  it('recognises a prompt that opens with a loop-fire envelope, including a whole-paste wrap', () => {
    expect(isLoopFirePrompt(LOOP_PROMPT)).toBe(true);
    expect(isLoopFirePrompt(`  ${LOOP_PROMPT}`)).toBe(true);
  });

  it('recognises self-compaction as a candidate while keeping direct loop-fire classification distinct', () => {
    expect(isLoopTurnStartCandidate(LOOP_PROMPT)).toBe(true);
    expect(isLoopFirePrompt(SELF_COMPACTION_PROMPT)).toBe(false);
    expect(isLoopTurnStartCandidate(SELF_COMPACTION_PROMPT)).toBe(true);
    expect(isLoopTurnStartCandidate('⟦turn-origin:wake-pump nonce:63e822d364133373⟧ wake')).toBe(false);
    expect(isLoopTurnStartCandidate(`quoted: ${SELF_COMPACTION_PROMPT}`)).toBe(false);
  });

  it('does not stamp other origins, owner text, or an envelope quoted mid-text', () => {
    expect(isLoopFirePrompt('⟦turn-origin:wake-pump nonce:63e822d364133373⟧ [await-event] x fired')).toBe(false);
    expect(isLoopFirePrompt('please continue where you left off')).toBe(false);
    expect(isLoopFirePrompt(`the last wake said: ${LOOP_PROMPT}`)).toBe(false);
    expect(isLoopFirePrompt('')).toBe(false);
  });

  it('builds a lifecycle row whose summary is exactly the marker, never a session phase', () => {
    const rec = loopTurnStartRecord({ owner: 'su-1', prompt: LOOP_PROMPT, workspaceId: 'ws-1', client: 'claude' });
    expect(rec).toMatchObject({
      owner: 'su-1',
      kind: 'lifecycle',
      summary: LOOP_TURN_START_MARKER,
      workspaceId: 'ws-1',
      agent: 'claude',
      detail: { origin: 'loop-fire', nonce: '8ed10949adab325d', source: 'turn-start' },
    });
    // Lifecycle readers compare against the session markers by exact match; the new marker
    // must never collide with them, or a loop turn start would read as a session phase.
    expect(LOOP_TURN_START_MARKER).not.toBe(SESSION_START_MARKER);
    expect(LOOP_TURN_START_MARKER).not.toBe(SESSION_END_MARKER);
    expect(loopTurnStartRecord({ owner: '  ', prompt: LOOP_PROMPT, workspaceId: 'ws-1' })).toBeNull();
    expect(loopTurnStartRecord({ owner: 'su-1', prompt: 'hello', workspaceId: 'ws-1' })).toBeNull();
  });

  it('keeps the typed routine fire identity in the existing activity detail', () => {
    expect(
      loopTurnStartRecord({
        owner: 'su-1',
        prompt: LOOP_PROMPT,
        workspaceId: 'ws-1',
        loopFire: { routineId: 'routine-10', wakeCount: 10 },
      }),
    ).toMatchObject({
      detail: {
        origin: 'loop-fire',
        nonce: '8ed10949adab325d',
        loopFire: { routineId: 'routine-10', wakeCount: 10 },
      },
    });
  });

  it('builds a self-compaction start marker only when an authenticated loop identity is present', () => {
    expect(loopTurnStartRecord({
      owner: 'su-1',
      prompt: SELF_COMPACTION_PROMPT,
      workspaceId: 'ws-1',
      loopFire: { routineId: 'routine-10', wakeCount: 10 },
    })).toMatchObject({
      detail: {
        origin: 'self-compaction',
        nonce: '0123456789abcdef',
        loopFire: { routineId: 'routine-10', wakeCount: 10 },
      },
    });
    expect(loopTurnStartRecord({ owner: 'su-1', prompt: SELF_COMPACTION_PROMPT, workspaceId: 'ws-1' })).toBeNull();
  });

  it('reads lineage only from the exact latest machine prompt and matching start marker', async () => {
    const currentTurn = {
      turn_idx: 27,
      text: SELF_COMPACTION_PROMPT,
      turn_origin: 'self-compaction',
      turn_origin_verdict: 'agent-injected',
    };
    const activity = {
      origin: 'self-compaction',
      nonce: '0123456789abcdef',
      source: 'session-ingest',
      loopFire: { routineId: 'routine-10', wakeCount: 10 },
      indexedTurn: { sourceKind: 'codex', sessionId: 'native-1', turnIdx: 27 },
    };
    const read = async (detail: Record<string, unknown> | null) => {
      const sql = async (strings: TemplateStringsArray) =>
        strings.join('').includes('FROM harness_shared.session_turns')
          ? [currentTurn]
          : detail ? [{ detail }] : [];
      return readLoopFireIdentityForCurrentTurn(
        { owner: 'su-native', sourceKind: 'codex', sessionId: 'native-1' },
        { sql: sql as never },
      );
    };

    await expect(read(activity)).resolves.toEqual({ routineId: 'routine-10', wakeCount: 10 });
    await expect(read({ ...activity, indexedTurn: { ...activity.indexedTurn, turnIdx: 26 } })).resolves.toBeNull();
    await expect(read(null)).resolves.toBeNull();
  });

  it('joins the marker to a per-request receipt without copying prompt content', () => {
    const record = loopTurnStartRecord({
      owner: 'su-1',
      prompt: LOOP_PROMPT,
      workspaceId: 'ws-1',
      turnStartRequestId: 'request-123',
    });
    expect(record?.detail).toMatchObject({ turnStartRequestId: 'request-123' });
    expect(JSON.stringify(record?.detail)).not.toContain('Loop wake');
    expect(loopTurnStartRecord({
      owner: 'su-1',
      prompt: LOOP_PROMPT,
      workspaceId: 'ws-1',
      turnStartRequestId: 'prompt content must not be copied',
    })?.detail).not.toHaveProperty('turnStartRequestId');
  });

  it('appends one row for a loop-fire prompt and none otherwise', async () => {
    const append = vi.fn(async (_record: ActivityRecord) => ({ id: '1' as string | null }));
    expect(await recordLoopTurnStart({ owner: 'su-1', prompt: LOOP_PROMPT, workspaceId: 'ws-1', loopFire: null }, { append })).toBe(true);
    expect(await recordLoopTurnStart({ owner: 'su-1', prompt: 'hi', workspaceId: 'ws-1' }, { append })).toBeNull();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({ summary: LOOP_TURN_START_MARKER, owner: 'su-1' });
  });

  it('never throws when the store fails (the hook request must not cost the turn)', async () => {
    const append = vi.fn(async () => {
      throw new Error('pg down');
    });
    await expect(
      recordLoopTurnStart({ owner: 'su-1', prompt: LOOP_PROMPT, workspaceId: 'ws-1', loopFire: null }, { append }),
    ).resolves.toBe(false);
  });
});
