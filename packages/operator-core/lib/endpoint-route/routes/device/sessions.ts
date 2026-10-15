/**
 * Device session list — mobile-agent-sessions-2026-10-12 P-002 (R-1, R-20..R-23,
 * ITEM-P-002-1).
 *
 *   GET /device/sessions?state=&fleet=&pot=&q=&cursor=&limit=   device JWT
 *
 * The phone's Sessions tab. Every row comes from `readSessionRosterSnapshot`,
 * the same read the desktop `advRoster.list` sync query returns, scoped to the
 * device JWT's workspace; `device-roster.ts` only projects, filters and pages
 * it. There is no second roster here (R-1).
 *
 * Refetch on presence change: the phone's polling sync cache reads
 * `deviceSessions.list` through `/device/rest-query` (sync.ts), whose `version`
 * is `deviceSessionsVersion` over the workspace's rows. It changes exactly when
 * a session appears, leaves, changes state or records activity, so the cache
 * refetches then and not on every poll.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { requireDeviceAgentSessions } from '../../../owner-sessions/device-authority';
import { redactSensitiveText } from '../../../sensitive-text';
import { readSessionRosterSnapshot } from '../../../owner-sessions/roster';
import {
  DEVICE_SESSION_STATES,
  DEVICE_SESSIONS_MAX_LIMIT,
  decodeDeviceSessionsCursor,
  deviceSessionRows,
  deviceSessionsVersion,
  pageDeviceSessions,
  type DeviceSessionFilters,
  type DeviceSessionRow,
} from '../../../owner-sessions/device-roster';
import type { DegradedField } from '../../../sync-resolver/degraded-snapshot';

/** The workspace's session rows, in roster order, plus any degraded roster legs. */
export async function readDeviceSessionRows(
  workspaceId: string,
): Promise<{ rows: DeviceSessionRow[]; degradedFields?: DegradedField[] }> {
  const snapshot = await readSessionRosterSnapshot({ workspaceId });
  return {
    rows: deviceSessionRows(snapshot, workspaceId).map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? redactSensitiveText(value) : value]),
    ) as unknown as DeviceSessionRow),
    ...(snapshot.degradedFields ? {
      degradedFields: snapshot.degradedFields.map(field => ({
        ...field,
        reason: redactSensitiveText(field.reason),
      })),
    } : {}),
  };
}

/**
 * R-19: resolve the session a `/device/sessions/:owner/...` route targets, or
 * refuse it. Every per-session device route calls this before it reads or acts.
 *
 * Membership is checked against the same projected roster the list returns, so
 * a phone can only reach a session it could see in its list: an owner in
 * another workspace is refused, and so is one the roster does not know. The
 * refusal is a 404 rather than a 403 so it does not confirm that the owner
 * exists somewhere else. Limit: an ended session older than the roster's ended
 * window is not in the list either, so it is refused too.
 */
export async function resolveDeviceSessionOwner(
  workspaceId: string,
  ownerId: string,
): Promise<{ ok: true; row: DeviceSessionRow } | { ok: false; response: Response }> {
  const { rows } = await readDeviceSessionRows(workspaceId);
  // Rows are in section order, so a live entry wins over an ended one.
  const row = ownerId ? rows.find((r) => r.ownerId === ownerId) : undefined;
  if (!row) {
    return { ok: false, response: Response.json({ error: 'session_not_in_workspace' }, { status: 404 }) };
  }
  return { ok: true, row };
}

type FilterInput = {
  state?: unknown;
  fleet?: unknown;
  pot?: unknown;
  q?: unknown;
};

/**
 * Parse the phone's filters (R-23). `state` is a comma list or an array of
 * session states (`unknown` selects rows with no oracle verdict). An unknown
 * state is an error, never silently ignored: dropping it would widen the result.
 */
export function parseDeviceSessionFilters(
  input: FilterInput,
): { ok: true; filters: DeviceSessionFilters } | { ok: false; error: string } {
  const filters: DeviceSessionFilters = {};
  if (input.state !== undefined && input.state !== null && input.state !== '') {
    const raw = Array.isArray(input.state) ? input.state : String(input.state).split(',');
    const states: Array<(typeof DEVICE_SESSION_STATES)[number]> = [];
    for (const value of raw) {
      const state = String(value).trim();
      if (!state) continue;
      const known = DEVICE_SESSION_STATES.find((s) => s === state);
      if (!known) return { ok: false, error: `invalid_state:${state}` };
      states.push(known);
    }
    if (states.length > 0) filters.states = states;
  }
  for (const key of ['fleet', 'pot', 'q'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') filters[key] = value;
  }
  return { ok: true, filters };
}

/** Parse `limit`: absent means the default; anything but a positive integer is an error. */
export function parseDeviceSessionsLimit(raw: unknown): { ok: true; limit?: number } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false };
  return { ok: true, limit: Math.min(limit, DEVICE_SESSIONS_MAX_LIMIT) };
}

/** GET /device/sessions — one page of the workspace's sessions (R-1, R-20..R-23). */
const sessionsList = defineTool({
  method: 'GET',
  path: '/device/sessions',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const denied = await requireDeviceAgentSessions(principal);
    if (denied) return denied;
    const params = new URL(req.url).searchParams;

    const parsed = parseDeviceSessionFilters({
      state: params.get('state') ?? undefined,
      fleet: params.get('fleet') ?? undefined,
      pot: params.get('pot') ?? undefined,
      q: params.get('q') ?? undefined,
    });
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const limit = parseDeviceSessionsLimit(params.get('limit') ?? undefined);
    if (!limit.ok) return Response.json({ error: 'invalid_limit' }, { status: 400 });

    const rawCursor = params.get('cursor');
    const cursor = rawCursor ? decodeDeviceSessionsCursor(rawCursor) : null;
    if (rawCursor && !cursor) return Response.json({ error: 'invalid_cursor' }, { status: 400 });

    const { rows, degradedFields } = await readDeviceSessionRows(principal.workspaceId);
    const page = pageDeviceSessions(rows, { filters: parsed.filters, cursor, limit: limit.limit });
    return Response.json({
      sessions: page.sessions,
      nextCursor: page.nextCursor,
      total: page.total,
      version: deviceSessionsVersion(rows),
      ...(degradedFields ? { degradedFields } : {}),
    });
  },
});

export default [sessionsList];
