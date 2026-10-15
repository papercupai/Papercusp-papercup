import { describe, expect, it } from 'vitest';
import {
  chatModelFailureFields,
  classifyChatModelFailure,
  projectChatFailureTranscriptTurn,
  safeChatFailureTranscriptFields,
} from './chat-model-failure';

// The exact frame text measured on hosted workspace avi-test (r56, 2026-09-27T16:01Z,
// .papercusp/scratch/r56-chat-probe-2.log) — the failure the viewer could not see (WI-10003494).
const AVI_CODEX_CAP =
  'operator brain produced no output (agent backend failure: codex, model gpt-5.6-luna:low: codex exited 1: ' +
  'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try ' +
  'again at Oct 3rd, 2026 5:30 PM.)';

const NOW = Date.parse('2026-09-27T16:01:00Z');

describe('classifyChatModelFailure — a failed chat turn gets an actionable code (WI-10003494)', () => {
  it('a capped Codex account is model_usage_limited with the provider-named reset instant', () => {
    const failure = classifyChatModelFailure(AVI_CODEX_CAP, NOW);
    expect(failure?.code).toBe('model_usage_limited');
    expect(typeof failure?.resetAt).toBe('number');
    const reset = new Date(failure!.resetAt!);
    // Local-time wording ("5:30 PM") — assert the calendar day and clock, not a UTC instant.
    expect([reset.getFullYear(), reset.getMonth(), reset.getDate()]).toEqual([2026, 9, 3]);
    expect([reset.getHours(), reset.getMinutes()]).toEqual([17, 30]);
  });

  it('text from ANOTHER host keeps its code but drops a wall-clock reset — its zone is unknown here', () => {
    // avi-test runs Etc/UTC; the portal parsing this same text runs America/New_York, so
    // "5:30 PM" converted here would be the wrong instant (measured, WI-10003494).
    expect(classifyChatModelFailure(AVI_CODEX_CAP, NOW, { wallClockZone: 'unknown' })).toEqual({
      code: 'model_usage_limited',
    });
    // Calibration: the same text on its own host does carry the instant, so the option
    // (not the text) is what removed it.
    expect(classifyChatModelFailure(AVI_CODEX_CAP, NOW, { wallClockZone: 'local' })?.resetAt).toBeTypeOf('number');
  });

  it('a cap with only a bare clock time carries NO resetAt — an inferred day is not promised to a viewer', () => {
    const failure = classifyChatModelFailure('claude exited 1: You hit your session limit · resets 7am', NOW);
    expect(failure).toEqual({ code: 'model_usage_limited' });
  });

  it('a revoked Claude credential (401) is model_auth_required', () => {
    const failure = classifyChatModelFailure(
      'claude-code exited 1: API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
      NOW,
    );
    expect(failure).toEqual({ code: 'model_auth_required' });
  });

  it('a transient rate limit is model_rate_limited and keeps the backend’s wait', () => {
    expect(classifyChatModelFailure('codex exited 1: 429 Too Many Requests — retry after 30s', NOW)).toEqual({
      code: 'model_rate_limited',
      retryAfterMs: 30_000,
    });
  });

  it('a failure with no actionable model-account cause gets no code (the generic sentence stays honest)', () => {
    expect(classifyChatModelFailure('failed to persist assistant turn: relation "agent_chats" does not exist', NOW)).toBeNull();
    expect(classifyChatModelFailure('codex exited 1: panic: index out of range', NOW)).toBeNull();
    expect(classifyChatModelFailure('', NOW)).toBeNull();
    expect(classifyChatModelFailure(null, NOW)).toBeNull();
  });

  it('chatModelFailureFields spreads cleanly onto an error frame, and to nothing when not actionable', () => {
    expect({ message: 'x', ...chatModelFailureFields('codex exited 1: panic', NOW) }).toEqual({ message: 'x' });
    expect(chatModelFailureFields(AVI_CODEX_CAP, NOW).code).toBe('model_usage_limited');
  });

  it('persists a safe failure sentence plus actionable fields instead of backend prose', () => {
    const turn = safeChatFailureTranscriptFields(AVI_CODEX_CAP, NOW);
    expect(turn).toMatchObject({
      content: 'That turn did not complete. Try asking again.',
      error: true,
      code: 'model_usage_limited',
    });
    expect(turn.content).not.toContain('codex exited');
    expect(turn.content).not.toContain('You’ve hit your usage limit');
    expect(turn.resetAt).toBeTypeOf('number');
  });

  it('redacts legacy persisted backend prose on read while retaining safe classification', () => {
    const turn = projectChatFailureTranscriptTurn({
      role: 'assistant',
      content: AVI_CODEX_CAP,
      ts: '2026-09-27T16:01:00.000Z',
      error: true,
    }, NOW);

    expect(turn).toMatchObject({
      role: 'assistant',
      content: 'That turn did not complete. Try asking again.',
      error: true,
      code: 'model_usage_limited',
    });
    expect(turn.content).not.toContain('codex exited');
    expect(turn.content).not.toContain('usage limit');
    // A legacy wall-clock reset has no reliable timezone at read time.
    expect(turn).not.toHaveProperty('resetAt');
  });

  it('leaves ordinary assistant turns untouched', () => {
    const turn = { role: 'assistant', content: 'normal reply', error: false };
    expect(projectChatFailureTranscriptTurn(turn, NOW)).toBe(turn);
  });
});
