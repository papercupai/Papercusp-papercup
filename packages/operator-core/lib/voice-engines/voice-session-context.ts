/**
 * Session-start context for the two-tier ElevenLabs voice agent
 * (plan voice-two-tier-elevenlabs-agent-2026-10-06, P-004).
 *
 * The front agent (PAPERCUP_FRONT_AGENT, synced by elevenlabs-agent-sync.ts)
 * accepts a per-session prompt override. This module builds that override on
 * the SERVER: the agent's own prompt plus the recent turns of the caller's
 * conversation, read only inside the active workspace and passed through the
 * secret redactor before anything leaves the operator for ElevenLabs. The
 * browser receives a finished prompt and never assembles context itself.
 */
import { buildVoiceSessionPrompt, type VoiceSessionTurn } from '@papercusp/chat-protocol';
import {
  getConversationById,
  getOrCreateActiveConversation,
  listTurnsRecent,
  type ConversationRow,
  type TurnRow,
} from '../operator-conversations';
import { redactSensitiveText } from '../sensitive-text';
import { activeWorkspaceId } from '../workspace-registry';
import { PAPERCUP_FRONT_PROMPT } from './elevenlabs-agent-sync';

/** Turns read from storage; the prompt builder then keeps the newest that fit. */
export const VOICE_SESSION_TURN_FETCH_LIMIT = 24;

export interface VoiceSessionContextDeps {
  workspaceId: () => string;
  getConversationById: (conversationId: string, workspaceId: string) => Promise<ConversationRow | null>;
  getActiveConversation: (workspaceId: string) => Promise<ConversationRow>;
  listRecentTurns: (conversationId: string, limit: number) => Promise<Array<Pick<TurnRow, 'role' | 'text'>>>;
  redact: (text: string) => string;
  basePrompt: string;
}

export const defaultVoiceSessionContextDeps: VoiceSessionContextDeps = {
  workspaceId: () => activeWorkspaceId(),
  getConversationById: (conversationId, workspaceId) => getConversationById(conversationId, workspaceId),
  getActiveConversation: (workspaceId) => getOrCreateActiveConversation(workspaceId),
  listRecentTurns: async (conversationId, limit) => (await listTurnsRecent({ conversationId, limit })).turns,
  redact: (text) => redactSensitiveText(text),
  basePrompt: PAPERCUP_FRONT_PROMPT,
};

export interface VoiceSessionContext {
  /** Full prompt to send as `overrides.agent.prompt.prompt`. */
  prompt: string;
  conversationId: string;
  /** User and assistant turns read for the prompt (before the size budget). */
  turnsConsidered: number;
}

export type VoiceSessionContextResult =
  | { ok: true; context: VoiceSessionContext }
  | { ok: false; status: 404; error: string };

export async function buildOperatorVoiceSessionContext(
  args: { conversationId?: string | null; userName?: string | null } = {},
  deps: VoiceSessionContextDeps = defaultVoiceSessionContextDeps,
): Promise<VoiceSessionContextResult> {
  const workspaceId = deps.workspaceId();
  const requested = args.conversationId?.trim();
  const conversation = requested
    ? await deps.getConversationById(requested, workspaceId)
    : await deps.getActiveConversation(workspaceId);
  if (!conversation) {
    return { ok: false, status: 404, error: 'conversation not found in the active workspace' };
  }

  const rows = await deps.listRecentTurns(conversation.id, VOICE_SESSION_TURN_FETCH_LIMIT);
  const turns: VoiceSessionTurn[] = rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      role: row.role as VoiceSessionTurn['role'],
      text: row.text ?? '',
      // The conversation's own workspace, compared against the session's by
      // the builder: a row from another workspace can never reach the prompt.
      scopeId: conversation.workspaceId,
    }));

  const prompt = buildVoiceSessionPrompt({
    basePrompt: deps.basePrompt,
    scopeId: workspaceId,
    turns,
    redact: deps.redact,
    userName: args.userName,
  });
  return { ok: true, context: { prompt, conversationId: conversation.id, turnsConsidered: turns.length } };
}
