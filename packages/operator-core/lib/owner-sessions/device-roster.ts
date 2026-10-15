/**
 * The phone's session list — the desktop Sessions roster, projected for a paired
 * device (mobile-agent-sessions-2026-10-12 P-002; R-1, R-20..R-23, ITEM-P-002-1).
 *
 * ## One roster, not two
 *
 * Every row here comes from ONE `readSessionRoster` snapshot — the same read the
 * desktop `advRoster.list` resolver returns. This module only PROJECTS that
 * snapshot (drop launch internals, keep the fields a phone renders), FILTERS it,
 * and PAGES it. It never re-reads presence, re-derives liveness or re-scopes a
 * workspace on its own, because any of those would be a second roster that can
 * disagree with the desktop (R-1).
 *
 * ## State is the oracle's verdict, never heartbeat freshness (R-21)
 *
 * `state` is `RosterEntry.sessionState`, which `mergeRosterWithAssignments`
 * stamps from the shared liveness oracle (`resolveSessionStates`). It is NOT
 * `RosterEntry.liveness`: that one is heartbeat freshness, and a parked agent
 * keeps beating, so it reads `live` for a session that has not taken a turn in
 * days (WI-6636). A null verdict (oracle degraded for that owner) stays null —
 * "unknown" — and is never upgraded to a guess.
 *
 * ## Workspace scoping (ITEM-P-002-1)
 *
 * The roster is read for the device's workspace. As a second line, a row whose
 * workspace is neither the device's nor the workspace-agnostic `'*'` is dropped.
 * `'*'` rows are unscoped SU/engineer shells, which the roster defines as part
 * of EVERY workspace (`GLOBAL_WORKSPACE` in adv-roster.ts), so the desktop
 * shows them too.
 *
 * ## Paging (R-22)
 *
 * Keyset, not offset: the cursor is the sort tuple of the last row served, and
 * the next page is every row strictly after it. Over a fixed population that
 * visits every row exactly once. When the population changes between pages, a
 * row is never repeated, and only rows inserted before the cursor are missed
 * until the next refresh — an offset cursor would instead repeat or skip rows
 * whenever anything ahead of it moved.
 */
import { createHash } from 'node:crypto';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import type { RosterSnapshot } from '../sync-resolver/adv-roster-read';

/** Which roster section a row came from, in display order. */
export type DeviceSessionSection = 'active' | 'starting' | 'pending' | 'ended';

const SECTION_RANK: Record<DeviceSessionSection, number> = {
  active: 0,
  starting: 1,
  pending: 2,
  ended: 3,
};

/** One session as the phone receives it (R-20). */
export interface DeviceSessionRow {
  /** Unique within one response: `<section>:<owner id or launch row id>`. */
  key: string;
  section: DeviceSessionSection;
  /** The coord owner id; null only for an ended launch row that never registered one. */
  ownerId: string | null;
  label: string | null;
  /** The human-given name, when the owner set one (the card headline). */
  displayName: string | null;
  role: string | null;
  harness: string | null;
  pot: string | null;
  fleet: string | null;
  intent: string | null;
  /** What the session is working on: its in-flight work-item title or its intent. */
  objective: string | null;
  /** The work item the session holds (the objective's source), when there is one. */
  heldWorkItem: string | null;
  lastActiveAt: string | null;
  /** The shared presence oracle's verdict (R-21); null = unknown. */
  state: SessionState | null;
  machineLabel: string | null;
  thinking: boolean;
}

/** The filters a phone may combine (R-23). Every supplied filter must match. */
export interface DeviceSessionFilters {
  /** Allowed states. `unknown` selects rows whose state is null. */
  states?: ReadonlyArray<SessionState | 'unknown'>;
  fleet?: string;
  pot?: string;
  /** Case-insensitive substring over identity and work fields. */
  q?: string;
}

export const DEVICE_SESSION_STATES: ReadonlyArray<SessionState | 'unknown'> = [
  'live',
  'parked',
  'draining',
  'suspect',
  'ended',
  'recorded',
  'unknown',
];

export const DEVICE_SESSIONS_DEFAULT_LIMIT = 50;
export const DEVICE_SESSIONS_MAX_LIMIT = 200;
const CURSOR_MAX_CHARS = 1024;

type ActiveEntry = RosterSnapshot['active'][number];
type EndedEntry = RosterSnapshot['ended'][number];
type SortTuple = [number, string, string];

function fromRosterEntry(entry: ActiveEntry, section: DeviceSessionSection): DeviceSessionRow {
  return {
    key: `${section}:${entry.ownerId}`,
    section,
    // Values pass through unchanged (R-20: each must equal what the desktop
    // roster shows), so an empty label or intent stays '' rather than null.
    ownerId: entry.ownerId,
    label: entry.label ?? null,
    displayName: entry.displayName ?? null,
    role: entry.role ?? null,
    harness: entry.harnessSlug ?? null,
    pot: entry.potSlug ?? null,
    fleet: entry.fleetSlug ?? null,
    intent: entry.intent ?? null,
    objective: entry.objective ?? null,
    heldWorkItem: entry.objectiveWorkItemRef ?? null,
    lastActiveAt: entry.lastActiveAt ?? null,
    state: entry.sessionState ?? null,
    machineLabel: entry.machineLabel ?? null,
    thinking: entry.thinking === true,
  };
}

function fromEndedRow(row: EndedEntry): DeviceSessionRow {
  return {
    key: `ended:${row.id}`,
    section: 'ended',
    ownerId: row.coordOwnerId ?? null,
    label: row.label ?? null,
    displayName: null,
    role: row.role ?? null,
    harness: row.harnessSlug ?? null,
    pot: null,
    fleet: null,
    intent: null,
    objective: null,
    heldWorkItem: null,
    lastActiveAt: row.lastActiveAt ?? row.endedAt ?? row.startedAt ?? null,
    // An ended launch row is ended by construction; the desktop renders it in
    // the ended section with no live verdict to disagree with.
    state: 'ended',
    machineLabel: null,
    thinking: false,
  };
}

function inWorkspace(rowWorkspaceId: string | null | undefined, workspaceId: string): boolean {
  return rowWorkspaceId === workspaceId || rowWorkspaceId === '*';
}

/** Order: section, then most recently active first, then key (a total order). */
function sortTuple(row: DeviceSessionRow): SortTuple {
  return [SECTION_RANK[row.section], row.lastActiveAt ?? '', row.key];
}

function compareTuples(a: SortTuple, b: SortTuple): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  // Newer activity first; '' (no activity recorded) sorts last within a section.
  if (a[1] !== b[1]) return a[1] < b[1] ? 1 : -1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  return 0;
}

/**
 * Every session in the snapshot, projected and scoped to `workspaceId`, in the
 * roster's display order. Same population the desktop roster shows (R-1).
 */
export function deviceSessionRows(snapshot: RosterSnapshot, workspaceId: string): DeviceSessionRow[] {
  const rows: DeviceSessionRow[] = [];
  for (const entry of snapshot.active) {
    if (inWorkspace(entry.workspaceId, workspaceId)) rows.push(fromRosterEntry(entry, 'active'));
  }
  for (const entry of snapshot.starting) {
    if (inWorkspace(entry.workspaceId, workspaceId)) rows.push(fromRosterEntry(entry, 'starting'));
  }
  for (const entry of snapshot.pending) {
    if (inWorkspace(entry.workspaceId, workspaceId)) rows.push(fromRosterEntry(entry, 'pending'));
  }
  for (const row of snapshot.ended) {
    if (inWorkspace(row.workspaceId, workspaceId)) rows.push(fromEndedRow(row));
  }
  return rows.sort((a, b) => compareTuples(sortTuple(a), sortTuple(b)));
}

function matchesQuery(row: DeviceSessionRow, needle: string): boolean {
  const haystack = [
    row.ownerId, row.label, row.displayName, row.role, row.harness, row.pot,
    row.fleet, row.intent, row.objective, row.heldWorkItem,
  ];
  return haystack.some((value) => value !== null && value.toLowerCase().includes(needle));
}

/** Whether `row` satisfies EVERY supplied filter (R-23). */
export function matchesDeviceSessionFilters(row: DeviceSessionRow, filters: DeviceSessionFilters): boolean {
  if (filters.states && filters.states.length > 0) {
    const state = row.state ?? 'unknown';
    if (!filters.states.includes(state)) return false;
  }
  if (filters.fleet !== undefined && row.fleet !== filters.fleet) return false;
  if (filters.pot !== undefined && row.pot !== filters.pot) return false;
  if (filters.q !== undefined) {
    const needle = filters.q.trim().toLowerCase();
    if (needle && !matchesQuery(row, needle)) return false;
  }
  return true;
}

export function encodeDeviceSessionsCursor(row: DeviceSessionRow): string {
  return Buffer.from(JSON.stringify(sortTuple(row)), 'utf8').toString('base64url');
}

/** Fail-closed: anything that is not a well-formed sort tuple is rejected. */
export function decodeDeviceSessionsCursor(raw: string): SortTuple | null {
  if (!raw || raw.length > CURSOR_MAX_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 3 &&
      Number.isInteger(parsed[0]) && typeof parsed[1] === 'string' && typeof parsed[2] === 'string'
    ) {
      return [parsed[0] as number, parsed[1] as string, parsed[2] as string];
    }
  } catch {
    /* fall through to the rejection */
  }
  return null;
}

export interface DeviceSessionsPage {
  sessions: DeviceSessionRow[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  /** Rows matching the filters across all pages of this snapshot. */
  total: number;
}

/** One keyset page of the filtered rows (R-22). `cursor` must already be decoded. */
export function pageDeviceSessions(
  rows: readonly DeviceSessionRow[],
  opts: { filters?: DeviceSessionFilters; cursor?: SortTuple | null; limit?: number } = {},
): DeviceSessionsPage {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? DEVICE_SESSIONS_DEFAULT_LIMIT)),
    DEVICE_SESSIONS_MAX_LIMIT,
  );
  const filtered = rows.filter((row) => matchesDeviceSessionFilters(row, opts.filters ?? {}));
  const cursor = opts.cursor ?? null;
  const after = cursor ? filtered.filter((row) => compareTuples(sortTuple(row), cursor) > 0) : filtered;
  const sessions = after.slice(0, limit);
  const last = sessions[sessions.length - 1];
  return {
    sessions,
    nextCursor: after.length > limit && last ? encodeDeviceSessionsCursor(last) : null,
    total: filtered.length,
  };
}

/**
 * A content version for the phone's polling sync cache: it changes exactly when
 * a session appears, leaves, changes state or records activity, so the phone
 * refetches on a presence change and not on every poll.
 */
export function deviceSessionsVersion(rows: readonly DeviceSessionRow[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(
      `${row.key}\u0000${row.state ?? ''}\u0000${row.lastActiveAt ?? ''}\u0000${row.intent ?? ''}\u0000${row.heldWorkItem ?? ''}\n`,
    );
  }
  return hash.digest('hex').slice(0, 16);
}
