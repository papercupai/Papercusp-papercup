/**
 * Client half of the two-tier voice session prompt (plan
 * voice-two-tier-elevenlabs-agent-2026-10-06, P-004). The prompt itself is
 * built and redacted on the server (voice-session-context.ts behind
 * GET /api/agent-mcp/operator-voice-session); this only fetches it.
 *
 * Never throws: any failure returns '' so the session starts with the agent's
 * synced prompt (no override) instead of failing to connect.
 */
export const OPERATOR_VOICE_SESSION_PATH = '/api/agent-mcp/operator-voice-session';

export async function fetchVoiceSessionPrompt(
  args: { conversationId?: string | null; userName?: string | null } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const params = new URLSearchParams();
    if (args.conversationId?.trim()) params.set('conversationId', args.conversationId.trim());
    if (args.userName?.trim()) params.set('userName', args.userName.trim());
    const qs = params.toString();
    const res = await fetchImpl(qs ? `${OPERATOR_VOICE_SESSION_PATH}?${qs}` : OPERATOR_VOICE_SESSION_PATH);
    if (!res.ok) return '';
    const body = (await res.json()) as { prompt?: unknown };
    return typeof body?.prompt === 'string' ? body.prompt : '';
  } catch {
    return '';
  }
}
