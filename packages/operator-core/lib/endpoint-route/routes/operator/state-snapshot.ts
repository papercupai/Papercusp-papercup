/**
 * GET /api/operator/state-snapshot → text/event-stream
 *
 * SSE stream of state-channel snapshots for the active workspace
 * (chat:ask_choice card rendering).
 *
 * Ported from app/api/operator/state-snapshot/route.ts. `auth: 'public'` —
 * session-cookie check inline (preserves the 401 response shape).
 */
import { sseResponse } from '@papercusp/sse';
import { isDeepStrictEqual } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import {
  snapshotWorkspace,
  subscribeWorkspace,
  chooseSnapshotEmission,
  type VersionedSnapshot,
  type SnapshotDelta,
} from '@papercusp/agent-mcp';
import { getSessionUserOrLocalDefaultAuthority } from '../../session-or-local';
import { snapshotConverseCards } from '../../../agent-tools/operator/converse-card';
import { operatorChatWorkspaceChannel } from '../../../operator-chat-store';
import { hubListen } from '../../../pg-listen-hub';
import { defineTool } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

type StateSnapshotVocabulary = {
  /** A new connection has a new per-run baseline, including after restart. */
  reset: { workspaceId: string };
  /** Full per-run snapshot — the baseline on connect, and the fallback when a delta
   *  can't be computed (P-009 agent-tool-delta-protocol). */
  snapshot: VersionedSnapshot;
  /** Per-run data-carrying delta vs the last emitted snapshot — only to clients that
   *  opt in with `?delta=1` (backward-compatible: others always get full snapshots). */
  delta: SnapshotDelta;
}

export default defineTool({
  method: 'GET',
  path: '/operator/state-snapshot',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    // WI-5044: session user OR (loopback-only) the seeded default user — the
    // desktop webview has no session cookie, and a strict cookie check left
    // the whole live-card channel dead on the shipping product.
    const responder = await getSessionUserOrLocalDefaultAuthority(req);
    if (!responder) {
      return new Response('unauthorized', { status: 401 });
    }
    const workspaceId = responder.user.workspace_id;
    const load = () => snapshotConverseCards({ sql: getOrgPg().sql, workspaceId,
      authorizeAdditional: responder.authorize, live: snapshotWorkspace(workspaceId) });
    // Refuse before opening an SSE stream; storage failure must never silently
    // expose a stale local card or turn an expired session into local authority.
    try { await load(); } catch (error) {
      const unauthorized = error instanceof Error && error.message === 'unauthorized';
      return Response.json({ error: unauthorized ? 'unauthorized' : 'snapshot needs reconciliation' },
        { status: unauthorized ? 403 : 503 });
    }
    // P-009 opt-in: a delta-aware client requests `?delta=1`, but the flag (default
    // OFF) is the cutover kill-switch — read once per connection. OFF ⇒ full snapshots
    // exactly as before, regardless of the param. The client always advertises ?delta=1.
    const wantsDelta =
      new URL(req.url).searchParams.get('delta') === '1' &&
      (await getFlag(FLAGS.STATE_SNAPSHOT_DELTAS, 'system'));

    return sseResponse<StateSnapshotVocabulary>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        sink.event('reset', { workspaceId });
        // Last snapshot emitted per run — the base a delta is computed against.
        const lastByRun = new Map<string, VersionedSnapshot>();
        let version = 0;
        const emit = (vs: VersionedSnapshot): void => {
          if (sink.closed) return;
          const previous = lastByRun.get(vs.runId);
          if (previous && isDeepStrictEqual(previous.snapshot, vs.snapshot)) return;
          // Local worker versions cannot order recovered durable snapshots.
          // This connection owns one increasing sequence after its reset.
          vs = { ...vs, workspaceId, version: ++version };
          const out = chooseSnapshotEmission(previous, vs, wantsDelta);
          if (out.event === 'delta') sink.event('delta', out.data);
          else sink.event('snapshot', out.data);
          lastByRun.set(vs.runId, vs);
        };
        let active = false, dirty = false;
        let reading: Promise<void> | null = null;
        let expiry: ReturnType<typeof setTimeout> | undefined;
        const fail = () => { if (!sink.closed) { sink.event('reset', { workspaceId }); sink.close(); } };
        const refresh = (): Promise<void> => {
          dirty = true;
          if (reading) return reading;
          reading = (async () => {
            while (dirty && !sink.closed) {
              dirty = false;
              const result = await load();
              if (sink.closed) return;
              const present = new Set(result.snapshots.map(vs => vs.runId));
              for (const runId of [...lastByRun.keys()]) if (!present.has(runId)) {
                emit({ runId, version: 0, snapshot: { openCards: [] } });
                lastByRun.delete(runId);
              }
              for (const vs of result.snapshots) emit(vs);
              clearTimeout(expiry);
              if (result.nextExpiryAt !== null) expiry = setTimeout(nudge,
                Math.max(1, result.nextExpiryAt - Date.now()));
            }
          })().finally(() => { reading = null; });
          return reading;
        };
        const nudge = () => { dirty = true; if (active) void refresh().catch(fail); };
        // Subscribe first, then reread: a commit during registration is either
        // visible in the read or wakes it. The shared hub also rereads on relisten.
        const off = subscribeWorkspace(workspaceId, nudge);
        sink.onClose(off);
        sink.onClose(() => { active = false; clearTimeout(expiry); });
        const stop = await hubListen(operatorChatWorkspaceChannel(workspaceId), nudge, nudge);
        if (sink.closed) { stop(); return; }
        sink.onClose(stop);
        active = true;
        try { await refresh(); } catch { fail(); }
      },
    });
  },
});
