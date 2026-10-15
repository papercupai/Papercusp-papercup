/**
 * GET /api/agent-mcp/operator-voice-session — session-start prompt for the
 * two-tier ElevenLabs voice agent (plan voice-two-tier-elevenlabs-agent-2026-10-06,
 * P-004). Returns `{ prompt, conversationId, turnsConsidered }`; the client sends
 * `prompt` as the session's prompt override.
 *
 * Built server-side so the recent conversation is read only inside the active
 * workspace and redacted before it reaches the voice provider. Its own route
 * rather than a field on operator-voice-prefs: prefs are stored settings, this
 * is computed per session from conversation content, so it carries the
 * converse route's `loopback` auth instead of the prefs route's `public`.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { buildOperatorVoiceSessionContext } from '../../../voice-engines/voice-session-context';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-voice-session',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const result = await buildOperatorVoiceSessionContext({
      conversationId: url.searchParams.get('conversationId'),
      userName: url.searchParams.get('userName'),
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.context);
  },
});

export default [get];
