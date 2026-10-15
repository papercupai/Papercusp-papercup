/** Bounded owner history and live follow over the same reader as the desktop. */
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { resolveDeviceSessionOwner, parseDeviceSessionsLimit } from './sessions';
import { readOwnerHistoryPage } from '../../../owner-sessions/transcript';
import { projectDeviceTimelineEntry, readOwnerSessionTimeline } from '../../../owner-sessions/timeline';
import { requireDeviceAgentSessions, subscribeDeviceSessionRevocation } from '../../../owner-sessions/device-authority';
import { readSessionRosterSnapshot } from '../../../owner-sessions/roster';

/** Native handles are resolved on the server; a phone cannot select a foreign file. */
export async function deviceSessionTimelineQuery(workspaceId: string, owner: string): Promise<URLSearchParams> {
  const snapshot = await readSessionRosterSnapshot({ workspaceId });
  const entry = [...snapshot.active, ...snapshot.starting, ...snapshot.pending].find(row => row.ownerId === owner);
  const query = new URLSearchParams({ owner, historyOwner: owner });
  if (!entry) { query.set('ended', '1'); return query; }
  const native = entry.nativeSession;
  if (native?.backend === 'codex') {
    if (entry.advSessionId != null) query.set('codexSessionKey', String(entry.advSessionId));
    else if (native.rolloutId) query.set('codexRolloutId', native.rolloutId);
  } else if (native?.backend === 'omp' || entry.ompThreadId) {
    const thread = native?.backend === 'omp' ? native.ompThreadId : entry.ompThreadId;
    if (thread) query.set('ompThreadId', thread);
    if (entry.advSessionId != null) query.set('ompSessionKey', String(entry.advSessionId));
  } else {
    const sessionId = native?.backend === 'claude' ? native.sessionId : entry.sessionId;
    if (sessionId) query.set('sessionId', sessionId);
  }
  return query;
}

const sessionTranscript = defineTool({
  method: 'GET',
  path: '/device/sessions/:owner/transcript',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const denied = await requireDeviceAgentSessions(principal);
    if (denied) return denied;
    const target = await resolveDeviceSessionOwner(principal.workspaceId, ctx.params.owner);
    if (!target.ok) return target.response;
    const url = new URL(req.url);
    const limit = parseDeviceSessionsLimit(url.searchParams.get('limit'));
    if (!limit.ok) return Response.json({ error: 'invalid_limit' }, { status: 400 });
    const cap = limit.limit ?? 50;
    const cursorRaw = url.searchParams.get('cursor');
    if (url.searchParams.get('stream') === '1') {
      if (cursorRaw) return Response.json({ error: 'cursor_on_stream' }, { status: 400 });
      const query = await deviceSessionTimelineQuery(principal.workspaceId, ctx.params.owner);
      return readOwnerSessionTimeline(new Request(`http://localhost/adv/session/thinking?${query}`, { signal: req.signal }), {
        projectEntry: projectDeviceTimelineEntry,
        historyCap: cap,
        authorize: async () => await requireDeviceAgentSessions(principal) === null,
        onOpen: close => subscribeDeviceSessionRevocation(principal.slug, principal.workspaceId, close),
      });
    }
    const page = await readOwnerHistoryPage(ctx.params.owner, { cursorRaw, cap });
    if (!page.ok) return Response.json({ error: page.error }, { status: page.status });
    const revoked = await requireDeviceAgentSessions(principal);
    if (revoked) return revoked;
    return Response.json({
      entries: page.entries.flatMap(entry => { const projected = projectDeviceTimelineEntry(entry); return projected ? [projected] : []; }),
      hasMore: page.hasMore,
      cursor: page.cursor,
    });
  },
});

export default [sessionTranscript];
