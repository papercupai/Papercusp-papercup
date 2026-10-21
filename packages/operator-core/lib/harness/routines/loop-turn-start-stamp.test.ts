import type { ActivityRecord } from '@papercusp/activity-bridge';
import { describe, expect, it, vi } from 'vitest';
import { LOOP_TURN_START_MARKER, SESSION_END_MARKER, SESSION_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { isLoopFirePrompt, loopTurnStartRecord, recordLoopTurnStart } from './loop-turn-start-stamp';

// EI-24791346664119438: the turn-start endpoint stamps a loop-fire turn start in real time so
// reconcile-loop-routines can tell a long-running loop turn from a wake that never became one.

const LOOP_PROMPT = '⟦turn-origin:loop-fire nonce:8ed10949adab325d⟧\n🔁 Loop wake (every 15m). continue';

describe('loop-turn-start-stamp', () => {
  it('recognises a prompt that opens with a loop-fire envelope, including a whole-paste wrap', () => {
    expect(isLoopFirePrompt(LOOP_PROMPT)).toBe(true);
    expect(isLoopFirePrompt(`  ${LOOP_PROMPT}`)).toBe(true);
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

  it('appends one row for a loop-fire prompt and none otherwise', async () => {
    const append = vi.fn(async (_record: ActivityRecord) => ({ id: '1' as string | null }));
    expect(await recordLoopTurnStart({ owner: 'su-1', prompt: LOOP_PROMPT, workspaceId: 'ws-1' }, { append })).toBe(true);
    expect(await recordLoopTurnStart({ owner: 'su-1', prompt: 'hi', workspaceId: 'ws-1' }, { append })).toBe(false);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toMatchObject({ summary: LOOP_TURN_START_MARKER, owner: 'su-1' });
  });

  it('never throws when the store fails (the hook request must not cost the turn)', async () => {
    const append = vi.fn(async () => {
      throw new Error('pg down');
    });
    await expect(
      recordLoopTurnStart({ owner: 'su-1', prompt: LOOP_PROMPT, workspaceId: 'ws-1' }, { append }),
    ).resolves.toBe(false);
  });
});
