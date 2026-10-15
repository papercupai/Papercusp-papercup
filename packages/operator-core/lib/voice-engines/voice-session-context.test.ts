import { describe, expect, it, vi } from 'vitest';
import type { ConversationRow } from '../operator-conversations';
import {
  buildOperatorVoiceSessionContext,
  defaultVoiceSessionContextDeps,
  type VoiceSessionContextDeps,
} from './voice-session-context';
import { PAPERCUP_FRONT_PROMPT } from './elevenlabs-agent-sync';

const WS = 'ws-home';

function conversation(id: string, workspaceId = WS): ConversationRow {
  return { id, workspaceId } as ConversationRow;
}

function deps(overrides: Partial<VoiceSessionContextDeps> = {}): VoiceSessionContextDeps {
  return {
    workspaceId: () => WS,
    getConversationById: vi.fn(async (id: string, ws: string) => (id === 'c-mine' && ws === WS ? conversation('c-mine') : null)),
    getActiveConversation: vi.fn(async () => conversation('c-active')),
    listRecentTurns: vi.fn(async () => [
      { role: 'user', text: 'Book the dentist for Friday.' },
      { role: 'system', text: 'internal status update' },
      { role: 'assistant', text: 'Booked for Friday at 10.' },
    ]),
    redact: defaultVoiceSessionContextDeps.redact,
    basePrompt: PAPERCUP_FRONT_PROMPT,
    ...overrides,
  } as VoiceSessionContextDeps;
}

describe('buildOperatorVoiceSessionContext', () => {
  it('builds the front prompt plus the recent user and assistant turns of the active conversation', async () => {
    const d = deps();
    const result = await buildOperatorVoiceSessionContext({}, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.conversationId).toBe('c-active');
    expect(result.context.prompt.startsWith(PAPERCUP_FRONT_PROMPT.trim())).toBe(true);
    expect(result.context.prompt).toContain('User: Book the dentist for Friday.');
    expect(result.context.prompt).toContain('Papercup: Booked for Friday at 10.');
    expect(result.context.prompt).not.toContain('internal status update');
    expect(result.context.turnsConsidered).toBe(2);
    expect(d.getActiveConversation).toHaveBeenCalledWith(WS);
  });

  it('reads a requested conversation only inside the active workspace and 404s otherwise', async () => {
    const d = deps();
    const mine = await buildOperatorVoiceSessionContext({ conversationId: 'c-mine' }, d);
    expect(mine.ok && mine.context.conversationId).toBe('c-mine');

    const other = await buildOperatorVoiceSessionContext({ conversationId: 'c-other-workspace' }, d);
    expect(other).toEqual({ ok: false, status: 404, error: 'conversation not found in the active workspace' });
    expect(d.getConversationById).toHaveBeenLastCalledWith('c-other-workspace', WS);
    expect(d.listRecentTurns).toHaveBeenCalledTimes(1);
  });

  it('drops every turn when the conversation belongs to a different workspace than the session', async () => {
    const d = deps({ getActiveConversation: vi.fn(async () => conversation('c-foreign', 'ws-someone-else')) });
    const result = await buildOperatorVoiceSessionContext({}, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.prompt).toBe(PAPERCUP_FRONT_PROMPT.trim());
  });

  it('redacts secrets with the real redactor before the prompt leaves the operator', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    const d = deps({
      listRecentTurns: vi.fn(async () => [{ role: 'user' as const, text: `use my github token ${token} for the repo` }]),
    });
    const result = await buildOperatorVoiceSessionContext({}, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.prompt).not.toContain(token);
    expect(result.context.prompt).toContain('use my github token');
    expect(result.context.prompt).toContain('for the repo');
  });
});
