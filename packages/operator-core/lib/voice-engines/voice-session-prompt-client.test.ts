import { describe, expect, it, vi } from 'vitest';
import { fetchVoiceSessionPrompt, OPERATOR_VOICE_SESSION_PATH } from './voice-session-prompt-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchVoiceSessionPrompt', () => {
  it('requests the server-built prompt for the conversation and user, and returns it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: 'BASE\n\nUser: hi', conversationId: 'c1' }));
    await expect(fetchVoiceSessionPrompt({ conversationId: 'c1', userName: 'Avi' }, fetchImpl as unknown as typeof fetch)).resolves.toBe(
      'BASE\n\nUser: hi',
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${OPERATOR_VOICE_SESSION_PATH}?conversationId=c1&userName=Avi`);
  });

  it('calls the bare path when no conversation or name is given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: 'BASE' }));
    await fetchVoiceSessionPrompt({}, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(OPERATOR_VOICE_SESSION_PATH);
  });

  it('returns an empty prompt (no override) on an error status, a bad body, or a network failure', async () => {
    const notFound = vi.fn(async () => jsonResponse({ error: 'conversation not found in the active workspace' }, 404));
    const badBody = vi.fn(async () => jsonResponse({ prompt: 42 }));
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    for (const f of [notFound, badBody, offline]) {
      await expect(fetchVoiceSessionPrompt({ conversationId: 'c1' }, f as unknown as typeof fetch)).resolves.toBe('');
    }
  });
});
