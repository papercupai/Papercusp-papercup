/**
 * GET /device/sessions — mobile-agent-sessions-2026-10-12 P-002.
 * Bars: R-1 (population), R-20 (row fields), R-21 (state), R-22 (paging),
 * R-23 (filters), ITEM-P-002-1 (workspace scoping), plus the phone cache's
 * content version on /device/rest-query `deviceSessions.list`.
 *
 * The roster fan-out (`readAdvRoster`) is the one seam stubbed: both the device
 * route and the desktop `advRoster.list` query read through it, so a test that
 * compares the two compares the real projections over one fixture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  readAdvRoster: vi.fn(),
  /** When set, readAdvRoster ignores the workspace scope (a leaky read). */
  leak: false,
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (definition: unknown) => definition,
}));
vi.mock('../../../sync-resolver/adv-roster-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sync-resolver/adv-roster-read')>()),
  readAdvRoster: (opts: unknown) => fixture.readAdvRoster(opts),
}));
// sync.ts's other queries are not under test; keep their PG-backed modules out.
vi.mock('../../../device-feeds', () => ({
  recentToasts: vi.fn(), recentAuditEntries: vi.fn(), currentlyRunning: vi.fn(),
}));
vi.mock('../../../device-store', () => ({ deviceAgentSessionsAllowed: vi.fn(async () => true) }));
vi.mock('../../../device-harnesses', () => ({ listHarnessesFor: vi.fn(), harnessStatusFor: vi.fn() }));
vi.mock('../../../operator-standing-candidates', () => ({ readCandidates: vi.fn(), refreshCandidates: vi.fn() }));

import routes, { resolveDeviceSessionOwner } from './sessions';
import syncRoutes from './sync';
import { resolveNamedQueryV2 } from '../../../sync-resolver/index';
import { SESSION_ROSTER_DEFAULT_ENDED_LIMIT } from '../../../owner-sessions/roster';

type Handler = (req: Request, ctx: { principal: { kind: string; slug: string; workspaceId: string } }) => Promise<Response>;
const list = (routes[0] as unknown as { handler: Handler }).handler;
const restQuery = (syncRoutes[0] as unknown as { handler: Handler }).handler;

const WS = 'paired-workspace';
const context = { principal: { kind: 'device', slug: 'phone-test', workspaceId: WS } };

type State = 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded' | null;

interface Entry {
  ownerId: string; label: string; displayName: string | null; role: string | null;
  harnessSlug: string | null; potSlug: string | null; fleetSlug: string | null;
  intent: string; objective: string | null; objectiveWorkItemRef: string | null;
  lastActiveAt: string | null; liveness: string; sessionState: State;
  machineLabel: string | null; thinking: boolean; workspaceId: string;
  pid: number | null; currentFiles: string[];
}

const entry = (ownerId: string, over: Partial<Entry> = {}): Entry => ({
  ownerId, label: `label-${ownerId}`, displayName: null, role: 'su',
  harnessSlug: 'papercusp', potSlug: null, fleetSlug: null,
  intent: `intent of ${ownerId}`, objective: null, objectiveWorkItemRef: null,
  lastActiveAt: '2026-10-13T10:00:00.000Z', liveness: 'live', sessionState: 'live',
  machineLabel: 'box', thinking: false, workspaceId: WS, pid: 4242, currentFiles: ['secret.ts'],
  ...over,
});

const ended = (id: number, over: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, coordOwnerId: `su-ended-${id}`, label: `ended ${id}`, role: 'su',
  harnessSlug: 'papercusp', lastActiveAt: `2026-10-12T0${id % 10}:00:00.000Z`,
  endedAt: null, startedAt: '2026-10-12T00:00:00.000Z', ...over,
});

interface Snapshot {
  active: Entry[]; starting: Entry[]; pending: Entry[];
  ended: Array<ReturnType<typeof ended>>; orphanedClaims: unknown[];
  degradedFields?: Array<{ field: string; kind: string; reason: string }>;
}

/** Serve `snapshot` the way the real read does: scoped to the workspace plus '*'. */
function serve(snapshot: Snapshot): void {
  fixture.readAdvRoster.mockImplementation(async (opts: { workspaceId: string | null }) => {
    const keep = (ws: string) => fixture.leak || opts.workspaceId === null || ws === opts.workspaceId || ws === '*';
    return {
      ...snapshot,
      active: snapshot.active.filter((e) => keep(e.workspaceId)),
      starting: snapshot.starting.filter((e) => keep(e.workspaceId)),
      pending: snapshot.pending.filter((e) => keep(e.workspaceId)),
      ended: snapshot.ended.filter((e) => keep(e.workspaceId)),
    };
  });
}

const base = (): Snapshot => ({
  active: [
    entry('su-live', { fleetSlug: 'fleet-a', potSlug: 'pot-1', objectiveWorkItemRef: 'WI-1', objective: 'Ship P-002' }),
    entry('su-parked', { sessionState: 'parked', liveness: 'live', lastActiveAt: '2026-10-11T08:00:00.000Z', potSlug: 'pot-2' }),
    entry('su-unknown', { sessionState: null, fleetSlug: 'fleet-a', label: '', intent: '' }),
    entry('su-global', { workspaceId: '*', role: 'engineer', fleetSlug: 'fleet-b' }),
    entry('su-foreign', { workspaceId: 'other-workspace' }),
  ],
  starting: [entry('starting:adv:7', { sessionState: null, lastActiveAt: null })],
  pending: [entry('pending:adv:8', { sessionState: null, lastActiveAt: null })],
  ended: [ended(1), ended(2, { workspaceId: 'other-workspace' })],
  orphanedClaims: [],
});

async function getJson(query = '') {
  const response = await list(new Request(`http://localhost/api/device/sessions${query}`), context);
  return { status: response.status, body: await response.json() };
}

/** The desktop roster for the device's workspace, as advRoster.list returns it. */
async function desktopRoster(): Promise<Snapshot> {
  const [snapshot] = (await resolveNamedQueryV2('advRoster.list', { workspaceId: WS })) as Snapshot[];
  return snapshot!;
}

function desktopKeys(snapshot: Snapshot): string[] {
  return [
    ...snapshot.active.map((e) => `active:${e.ownerId}`),
    ...snapshot.starting.map((e) => `starting:${e.ownerId}`),
    ...snapshot.pending.map((e) => `pending:${e.ownerId}`),
    ...snapshot.ended.map((e) => `ended:${e.id}`),
  ].sort();
}

beforeEach(() => {
  fixture.readAdvRoster.mockReset();
  fixture.leak = false;
  serve(base());
});

describe('R-1 — roster population', () => {
  it('returns exactly the sessions the desktop roster shows for the device workspace', async () => {
    const { status, body } = await getJson();
    expect(status).toBe(200);
    const desktop = await desktopRoster();
    const deviceKeys = body.sessions.map((s: { key: string }) => s.key).sort();
    expect(deviceKeys).toEqual(desktopKeys(desktop));
    expect(body.total).toBe(deviceKeys.length);
    expect(body.nextCursor).toBeNull();
  });

  it('matches the desktop population across the complete unfiltered cursor walk of one snapshot', async () => {
    const snapshot = base();
    snapshot.active.push(...Array.from({ length: 17 }, (_, i) => entry(`su-extra-${i}`, {
      lastActiveAt: i % 3 === 0 ? null : '2026-10-13T10:00:00.000Z',
    })));
    snapshot.ended.push(ended(3), ended(4));
    serve(snapshot);
    const expected = desktopKeys(await desktopRoster());
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { status, body } = await getJson(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(status).toBe(200);
      expect(body.total).toBe(expected.length);
      seen.push(...body.sessions.map((row: { key: string }) => row.key));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(expected.length + 1);
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(expected);
  });

  it('reads the roster once, through the same call the desktop query makes', async () => {
    await getJson();
    await desktopRoster();
    expect(fixture.readAdvRoster.mock.calls).toEqual([
      [{ workspaceId: WS, endedLimit: SESSION_ROSTER_DEFAULT_ENDED_LIMIT }],
      [{ workspaceId: WS, endedLimit: SESSION_ROSTER_DEFAULT_ENDED_LIMIT }],
    ]);
  });

  it('surfaces a failed primary roster read instead of answering an empty fleet', async () => {
    fixture.readAdvRoster.mockRejectedValue(new Error('roster active lapsed'));
    await expect(list(new Request('http://localhost/api/device/sessions'), context)).rejects.toThrow('roster active lapsed');
  });

  it('passes the degraded legs through so the phone can say the roster is partial', async () => {
    serve({ ...base(), degradedFields: [{ field: 'ended', kind: 'timeout', reason: 'roster ended lapsed' }] });
    const { body } = await getJson();
    expect(body.degradedFields).toEqual([{ field: 'ended', kind: 'timeout', reason: 'roster ended lapsed' }]);
  });
});

describe('ITEM-P-002-1 — workspace scoping', () => {
  it("keeps workspace-agnostic '*' sessions and drops another workspace's, even if the read leaks them", async () => {
    fixture.leak = true;
    const { body } = await getJson();
    const owners = body.sessions.map((s: { ownerId: string }) => s.ownerId);
    expect(owners).toContain('su-global');
    expect(owners).not.toContain('su-foreign');
    expect(owners).not.toContain('su-ended-2');
    expect(fixture.readAdvRoster).toHaveBeenCalledWith({ workspaceId: WS, endedLimit: SESSION_ROSTER_DEFAULT_ENDED_LIMIT });
  });
});

describe('R-19 — a per-session route refuses an owner outside the device workspace', () => {
  it.each([
    ['another workspace', 'su-foreign'],
    ["another workspace's ended session", 'su-ended-2'],
    ['an owner the roster does not know', 'su-nobody'],
    ['an empty owner', ''],
  ])('refuses %s with a 404 that does not confirm the owner exists', async (_case, owner) => {
    fixture.leak = true; // even a read that leaks foreign rows must not let them through
    const result = await resolveDeviceSessionOwner(WS, owner);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(404);
    expect(await result.response.json()).toEqual({ error: 'session_not_in_workspace' });
  });

  it.each([
    ['a session in the device workspace', 'su-live', 'active'],
    ["a workspace-agnostic '*' session", 'su-global', 'active'],
    ['an ended session in the device workspace', 'su-ended-1', 'ended'],
  ])('resolves %s', async (_case, owner, section) => {
    const result = await resolveDeviceSessionOwner(WS, owner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.ownerId).toBe(owner);
    expect(result.row.section).toBe(section);
  });
});

describe('R-20 — row fields', () => {
  it('carries owner, label, role, harness, pot, fleet, intent, held work item and last activity equal to the desktop values', async () => {
    const { body } = await getJson();
    const desktop = await desktopRoster();
    const desktopEntries = [...desktop.active, ...desktop.starting, ...desktop.pending];
    let compared = 0;
    for (const row of body.sessions) {
      if (row.section === 'ended') continue;
      const source = desktopEntries.find((e) => e.ownerId === row.ownerId)!;
      expect(source, row.key).toBeDefined();
      expect({
        ownerId: row.ownerId, label: row.label, role: row.role, harness: row.harness, pot: row.pot,
        fleet: row.fleet, intent: row.intent, heldWorkItem: row.heldWorkItem, lastActiveAt: row.lastActiveAt,
      }, row.key).toEqual({
        ownerId: source.ownerId, label: source.label, role: source.role, harness: source.harnessSlug,
        pot: source.potSlug, fleet: source.fleetSlug, intent: source.intent,
        heldWorkItem: source.objectiveWorkItemRef, lastActiveAt: source.lastActiveAt,
      });
      compared += 1;
    }
    expect(compared).toBe(desktopEntries.length);
    for (const row of body.sessions.filter((r: { section: string }) => r.section === 'ended')) {
      const source = desktop.ended.find((e) => `ended:${e.id}` === row.key)!;
      expect(source, row.key).toBeDefined();
      // Ended launch rows retain identity/activity but have no live assignment.
      // Assert presence as well as null values: JSON cannot omit these fields.
      for (const field of ['ownerId', 'label', 'role', 'harness', 'pot', 'fleet', 'intent', 'heldWorkItem', 'lastActiveAt']) {
        expect(row, row.key).toHaveProperty(field);
      }
      expect({
        ownerId: row.ownerId, label: row.label, role: row.role, harness: row.harness,
        pot: row.pot, fleet: row.fleet, intent: row.intent, heldWorkItem: row.heldWorkItem,
        lastActiveAt: row.lastActiveAt,
      }, row.key).toEqual({
        ownerId: source.coordOwnerId, label: source.label, role: source.role, harness: source.harnessSlug,
        pot: null, fleet: null, intent: null, heldWorkItem: null,
        lastActiveAt: source.lastActiveAt ?? source.endedAt ?? source.startedAt ?? null,
      });
    }
  });

  it.each([
    ['ended time', { lastActiveAt: null, endedAt: '2026-10-12T09:00:00.000Z' }, '2026-10-12T09:00:00.000Z'],
    ['start time', { lastActiveAt: null, endedAt: null }, '2026-10-12T00:00:00.000Z'],
    ['unknown time', { lastActiveAt: null, endedAt: null, startedAt: null }, null],
  ])('retains the full archival field contract with %s', async (_case, overrides, lastActiveAt) => {
    serve({ ...base(), ended: [ended(1, overrides)] });
    const { body } = await getJson();
    const row = body.sessions.find((s: { key: string }) => s.key === 'ended:1');
    expect(row).toMatchObject({
      ownerId: 'su-ended-1', label: 'ended 1', role: 'su', harness: 'papercusp',
      pot: null, fleet: null, intent: null, heldWorkItem: null, lastActiveAt,
    });
  });

  it('keeps an empty label or intent as the desktop has it, and drops launch internals', async () => {
    const { body } = await getJson();
    const unknown = body.sessions.find((s: { ownerId: string }) => s.ownerId === 'su-unknown');
    expect(unknown.label).toBe('');
    expect(unknown.intent).toBe('');
    expect(unknown).not.toHaveProperty('pid');
    expect(unknown).not.toHaveProperty('currentFiles');
  });
});

describe('R-5 — roster payload minimisation', () => {
  it('redacts seeded secrets in active and ended rows while preserving safe roster text', async () => {
    const secret = 'sk-proj-' + 'r8'.repeat(18);
    const snapshot = base();
    snapshot.active = [entry('su-redacted', { label: `api_key=${secret}`, intent: `token=${secret} safe-intent` })];
    snapshot.ended = [ended(3, { label: `token=${secret} safe-ended` })];
    serve(snapshot);
    const { status, body } = await getJson();
    expect(status).toBe(200);
    expect(body.sessions).toHaveLength(4);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.sessions.find((row: { ownerId: string }) => row.ownerId === 'su-redacted').intent).toContain('safe-intent');
    expect(body.sessions.find((row: { key: string }) => row.key === 'ended:3').label).toContain('safe-ended');
    expect(JSON.stringify(body)).toContain('[redacted]');
  });

  it('redacts seeded secrets in degraded roster metadata on the route and cached query', async () => {
    const secret = 'sk-proj-' + 'm2'.repeat(18);
    serve({ ...base(), degradedFields: [{ field: 'ended', kind: 'timeout', reason: `token=${secret} roster read failed` }] });
    const { body } = await getJson();
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.degradedFields[0]).toMatchObject({ field: 'ended', kind: 'timeout' });
    expect(body.degradedFields[0].reason).toContain('roster read failed');
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.degradedFields[0].reason).toContain('[redacted]');
    const cached = await restQuery(new Request('http://localhost/api/device/rest-query?name=deviceSessions.list'), context).then(response => response.json());
    expect(cached.rows.length).toBeGreaterThan(0);
    expect(cached.degradedFields[0]).toMatchObject({ field: 'ended', kind: 'timeout' });
    expect(JSON.stringify(cached)).not.toContain(secret);
    expect(cached.degradedFields[0].reason).toContain('[redacted]');
  });
});

describe('R-21 — session state is the presence oracle verdict', () => {
  it('reports the oracle state per owner, not heartbeat liveness', async () => {
    const oracle = new Map<string, State>([
      ['su-a', 'live'], ['su-b', 'parked'], ['su-c', 'draining'], ['su-d', 'suspect'],
      ['su-e', 'ended'], ['su-f', 'recorded'], ['su-g', null],
    ]);
    // Every heartbeat is fresh: a projection that read `liveness` would say live for all.
    serve({
      ...base(),
      active: [...oracle].map(([id, state]) => entry(id, { sessionState: state, liveness: 'live' })),
      starting: [], pending: [], ended: [],
    });
    const { body } = await getJson();
    expect(body.sessions).toHaveLength(oracle.size);
    for (const row of body.sessions) expect(row.state, row.ownerId).toBe(oracle.get(row.ownerId));
  });
});

describe('R-22 — paging', () => {
  it('visits every session of a fixed population exactly once across more than three pages', async () => {
    // Ties on lastActiveAt make the key the tie-breaker; nulls sort last.
    const active = Array.from({ length: 25 }, (_, i) => entry(`su-${String(i).padStart(2, '0')}`, {
      lastActiveAt: i % 5 === 0 ? null : `2026-10-13T0${i % 3}:00:00.000Z`,
    }));
    serve({ ...base(), active, starting: [], pending: [], ended: [] });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { status, body } = await getJson(query);
      expect(status).toBe(200);
      expect(body.total).toBe(25);
      expect(body.sessions.length).toBeLessThanOrEqual(7);
      seen.push(...body.sessions.map((s: { ownerId: string }) => s.ownerId));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect([...seen].sort()).toEqual(active.map((e) => e.ownerId).sort());
  });

  it('rejects a malformed cursor or limit instead of restarting from the top', async () => {
    expect((await getJson('?cursor=not-a-cursor')).status).toBe(400);
    expect((await getJson('?cursor=not-a-cursor')).body).toEqual({ error: 'invalid_cursor' });
    expect((await getJson('?limit=0')).body).toEqual({ error: 'invalid_limit' });
    expect((await getJson('?limit=abc')).status).toBe(400);
  });
});

describe('R-23 — filters', () => {
  type Row = { ownerId: string | null; state: string | null; fleet: string | null; pot: string | null; label: string | null; intent: string | null };
  const filters: Array<[string, (r: Row) => boolean]> = [
    ['state=live', (r) => r.state === 'live'],
    ['state=parked,unknown', (r) => r.state === 'parked' || r.state === null],
    ['fleet=fleet-a', (r) => r.fleet === 'fleet-a'],
    ['pot=pot-2', (r) => r.pot === 'pot-2'],
    ['q=SHIP', (r) => r.ownerId === 'su-live'],
    ['state=live&fleet=fleet-a', (r) => r.state === 'live' && r.fleet === 'fleet-a'],
    ['state=live&fleet=fleet-b&q=engineer', (r) => r.state === 'live' && r.fleet === 'fleet-b' && r.ownerId === 'su-global'],
    ['state=parked&pot=pot-1', () => false],
  ];

  it.each(filters)('%s returns every matching session and nothing else', async (query, predicate) => {
    const all: Row[] = (await getJson()).body.sessions;
    const { status, body } = await getJson(`?${query}`);
    expect(status).toBe(200);
    const expected = all.filter(predicate).map((r) => r.ownerId);
    expect(body.sessions.map((r: Row) => r.ownerId)).toEqual(expected);
    expect(body.total).toBe(expected.length);
  });

  it.each(filters)('%s returns the exact matching set across the complete filtered cursor walk', async (query, predicate) => {
    // Replicate the mixed fixture so matching filters cross page boundaries;
    // expected membership comes from the desktop fixture, not an unfiltered
    // device response that could share the same population defect.
    const snapshot = base();
    const active = snapshot.active.flatMap(row => Array.from({ length: 5 }, (_, i) => ({
      ...row, ownerId: i === 0 ? row.ownerId : `${row.ownerId}-${i}`,
    })));
    serve({ ...snapshot, active });
    const desktop = await desktopRoster();
    const rows: Row[] = [
      ...[...desktop.active, ...desktop.starting, ...desktop.pending].map(row => ({
        ownerId: row.ownerId, state: row.sessionState, fleet: row.fleetSlug,
        pot: row.potSlug, label: row.label, intent: row.intent,
      })),
      ...desktop.ended.map(row => ({ ownerId: row.coordOwnerId as string | null,
        state: 'ended', fleet: null, pot: null, label: row.label as string | null, intent: null })),
    ];
    const matches = (row: Row): boolean => {
      // The search fixtures target all copies of the same safe text/owner.
      if (query === 'q=SHIP') return row.ownerId?.startsWith('su-live') ?? false;
      if (query === 'state=live&fleet=fleet-b&q=engineer') {
        return row.state === 'live' && row.fleet === 'fleet-b' && (row.ownerId?.startsWith('su-global') ?? false);
      }
      return predicate(row);
    };
    const expected = rows.filter(matches).map(row => row.ownerId).sort();
    const seen: Array<string | null> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { status, body } = await getJson(`?${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(status).toBe(200);
      expect(body.total).toBe(expected.length);
      for (const row of body.sessions as Row[]) expect(matches(row)).toBe(true);
      seen.push(...body.sessions.map((row: Row) => row.ownerId));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(rows.length + 1);
    } while (cursor !== null);
    expect([...seen].sort()).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    if (expected.length > 2) expect(pages).toBeGreaterThan(1);
  });

  it('rejects an unknown state rather than widening the result', async () => {
    const { status, body } = await getJson('?state=live,sleeping');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_state:sleeping' });
  });
});

describe('sync invalidation — /device/rest-query deviceSessions.list', () => {
  const query = (args: Record<string, unknown> = {}) =>
    restQuery(new Request(`http://localhost/api/device/rest-query?name=deviceSessions.list&args=${encodeURIComponent(JSON.stringify(args))}`), context)
      .then((r) => r.json());

  it('serves the first page with a content version that moves only when a session changes', async () => {
    const first = await query();
    const again = await query();
    expect(first.rows.map((r: { key: string }) => r.key)).toEqual((await getJson()).body.sessions.map((r: { key: string }) => r.key));
    expect(first.version).toBe(again.version);

    const parkedLive = base();
    parkedLive.active[1] = { ...parkedLive.active[1]!, sessionState: 'live' };
    serve(parkedLive);
    const changed = await query();
    expect(changed.version).not.toBe(first.version);
  });

  it('applies the same filters as the route', async () => {
    const { rows } = await query({ state: ['parked'], limit: 5 });
    expect(rows.map((r: { ownerId: string }) => r.ownerId)).toEqual(['su-parked']);
    const bad = await query({ state: 'asleep' });
    expect(bad).toEqual({ error: 'invalid_state:asleep' });
  });
});
