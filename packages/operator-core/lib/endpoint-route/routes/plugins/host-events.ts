/**
 * GET /api/plugins/host/events — SSE event stream for iframe plugin surfaces.
 * Ported from app/api/plugins/host/events/route.ts. `auth: 'public'`.
 *
 * Each connection subscribes to the plugin-event fan-out for one event `name` in one
 * `install` (events/plugin-event-fanout.ts, WI-39801). A plugin event fired in that
 * install, or with no install scope, arrives as an SSE `message` whose data is the
 * event payload as JSON — the shape PluginIframe.tsx forwards to the iframe.
 * Only plugin-fired events travel this stream, never internal system events.
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { subscribePluginEvents } from '../../../events/plugin-event-fanout';

export default defineTool({
  method: 'GET',
  path: '/plugins/host/events',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const pluginName = url.searchParams.get('plugin');
    const installSlug = url.searchParams.get('install');
    const name = url.searchParams.get('name');
    if (!pluginName || !installSlug || !name) {
      return new Response('plugin, install, name query params required', { status: 400 });
    }

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 30_000,
      initialHeartbeat: true,
      setup: (sink) => {
        const unsubscribe = subscribePluginEvents({ name, installSlug }, (payload) => {
          if (sink.closed) return;
          sink.eventRaw('message', JSON.stringify(payload));
        });
        sink.onClose(unsubscribe);
      },
    });
  },
});
