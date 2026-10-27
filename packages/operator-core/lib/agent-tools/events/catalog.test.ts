/**
 * catalog.test.ts — events:catalog tool envelope (EI-9000, fleet-reliability-
 * verification-2026-07-10 P-005): `live_awaiters` is attached per family from
 * countActiveAwaitsByPrefixes, best-effort (a DB hiccup must not break catalog
 * discovery), and is skippable via `liveAwaiters: false`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));

const countMock = vi.fn();
const listAnnouncementsMock = vi.fn();
const listFiredAnnouncementsMock = vi.fn();
const prefixCountMock = vi.fn();
const presenceFleetMock = vi.fn();
vi.mock('../../events/await/store', () => ({
  countActiveAwaitsByKeyShapes: (...args: unknown[]) => countMock(...args),
  countActiveAwaitsByPrefixes: (...args: unknown[]) => prefixCountMock(...args),
  listActiveAnnouncements: (...args: unknown[]) => listAnnouncementsMock(...args),
  listFiredAnnouncements: (...args: unknown[]) => listFiredAnnouncementsMock(...args),
}));

// EI-21907772459508454: announcementVisibleTo is deliberately NOT mocked — these tests
// exercise the real scope predicate; only its INPUTS (presence) are controlled.
const presenceMock = vi.fn();
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test-reader', workspaceId: 'ws-test' }),
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));
vi.mock('../coordination/presence', () => ({
  getPresence: (...args: unknown[]) => presenceMock(...args),
}));
vi.mock('../coordination/presence-fleet', () => ({
  resolvePresenceFleet: (...args: unknown[]) => presenceFleetMock(...args),
}));

// EI-21840718595021627: resolveAnnouncementOwnership (imported by catalog.ts from
// status.ts) resolves role/fleet-leadership successors + liveness through these two
// primitives — mock them the same way status.test.ts does for the identical function.
vi.mock('../coordination/audience-host', () => ({
  hostAudienceResolvers: { listFleetLeader: vi.fn(async () => []) },
}));
vi.mock('../coordination/role-slot-live-resolve', () => ({
  resolveLiveRoleHolders: vi.fn(async () => []),
}));
vi.mock('../coordination/liveness-oracle', () => ({
  resolveSessionStates: vi.fn(async () => new Map()),
}));

const ann = (over: Record<string, unknown> = {}) => ({
  eventKey: 'plan:some-plan:p002-green',
  logicalGateKey: null,
  note: 'green gate',
  scopeKind: 'plan',
  scopeRef: 'some-plan',
  subscriberId: 'su-leader',
  firedAt: null,
  firedReason: null,
  expiresTs: null,
  ...over,
});

import catalog, { fieldsMatchQuery } from './catalog';
import { familyKeyPrefix, EVENT_CATALOG } from '../../events/await/catalog';
import { HARD_CAP, promptWeight } from '../tool-guidance-budget';
import { resolveLiveRoleHolders } from '../coordination/role-slot-live-resolve';
import { resolveSessionStates, type LivenessVerdict } from '../coordination/liveness-oracle';
import { mockResolvedOnceTyped } from '../../testing/typed-mock';

const verdict = (ownerId: string, sessionState: LivenessVerdict['sessionState']): LivenessVerdict => ({
  ownerId,
  sessionState,
  wakeable: sessionState !== 'ended',
  liveTurn: false,
  confirmLiveness: false,
  heartbeatFresh: sessionState !== 'ended',
});

const call = async (args: Record<string, unknown> = {}) => {
  const res = (await catalog.handler(args as never, {} as never)) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0].text);
};

beforeEach(() => {
  vi.clearAllMocks();
  countMock.mockResolvedValue(new Map());
  listAnnouncementsMock.mockResolvedValue([]);
  listFiredAnnouncementsMock.mockResolvedValue([]);
  presenceMock.mockResolvedValue({ fleetSlug: null, currentPlanSlug: null });
  presenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
});

// EI-21907772459508454 — an announced gate that EXISTS but is out of the reader's scope
// used to be indistinguishable from one that was never declared. A fleet member followed
// the playbook ("verify the key against the catalog"), read the silence as "my leader
// never declared it", and escalated wrongly. These pin the distinction.
describe('events:catalog — announced gates: withheld must not read as absent', () => {
  it('reports a scope-hidden gate in announced_visibility instead of silently dropping it', async () => {
    listAnnouncementsMock.mockResolvedValue([ann()]);
    presenceMock.mockResolvedValue({ fleetSlug: null, currentPlanSlug: null });

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    // The gate is correctly WITHHELD (the reader is not on that plan)...
    expect(out.announced).toBeUndefined();
    // ...but the omission is now SAYABLE, which is the whole fix.
    expect(out.announced_visibility).toMatchObject({
      total_active: 1,
      returned: 0,
      hidden_by_scope: 1,
      reader_scope: { fleet: null, plan: null, harness: null },
      reader_resolved: true,
    });
    expect(out.announced_visibility.note).toMatch(/NOT proof they were never declared/i);
    expect(out.announced_visibility.note).toMatch(/events:await/i);
  });

  it('SHOWS the same gate once presence puts the reader on that plan (the other direction)', async () => {
    listAnnouncementsMock.mockResolvedValue([ann()]);
    presenceMock.mockResolvedValue({ fleetSlug: null, currentPlanSlug: 'some-plan' });

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced).toHaveLength(1);
    expect(out.announced[0]).toMatchObject({ event: 'plan:some-plan:p002-green', scope: 'plan:some-plan' });
    expect(out.announced_visibility).toMatchObject({ hidden_by_scope: 0, returned: 1 });
    expect(out.announced_visibility.note).toBeUndefined();
  });

  it('uses canonical live fleet membership when exposing fleet-scoped announcements', async () => {
    listAnnouncementsMock.mockResolvedValue([
      ann({ eventKey: 'fleet:live-fleet:p002-green', scopeKind: 'fleet', scopeRef: 'live-fleet' }),
    ]);
    // getPresence intentionally omits fleet membership; it is read through
    // resolvePresenceFleet from the append-only membership projection.
    presenceMock.mockResolvedValue({ fleetSlug: null, currentPlanSlug: null });
    presenceFleetMock.mockResolvedValue({ fleetSlug: 'live-fleet', fleetRole: 'member' });

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(presenceFleetMock).toHaveBeenCalledWith('su-test-reader', { fleetSlug: null, fleetRole: null });
    expect(out.announced).toHaveLength(1);
    expect(out.announced_visibility).toMatchObject({
      reader_scope: { fleet: 'live-fleet' },
      hidden_by_scope: 0,
      returned: 1,
    });
  });

  it('flags an UNRESOLVED reader rather than passing global-only off as the whole truth', async () => {
    listAnnouncementsMock.mockResolvedValue([ann(), ann({ scopeKind: null, eventKey: 'global-gate' })]);
    presenceMock.mockRejectedValue(new Error('presence unavailable'));

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced_visibility.reader_resolved).toBe(false);
    expect(out.announced_visibility.note).toMatch(/READER SCOPE UNRESOLVED/i);
    expect(out.announced_visibility.note).toMatch(/UNMEASURED, not absent/i);
    // the global gate still comes through
    expect(out.announced).toHaveLength(1);
  });

  it('emits announced_visibility even when NOTHING is announced (empty != withheld)', async () => {
    listAnnouncementsMock.mockResolvedValue([]);
    const out = await call({ announced: true, installed: false, liveAwaiters: false });
    expect(out.announced).toBeUndefined();
    expect(out.announced_visibility).toMatchObject({ total_active: 0, hidden_by_scope: 0 });
    expect(out.announced_visibility.note).toMatch(/No announced gates are active/i);
  });

  it('counts rows cut by the fixed 25-row cap, which the `limit` arg does not govern', async () => {
    listAnnouncementsMock.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ann({ scopeKind: null, eventKey: `global-gate-${i}` })),
    );
    const out = await call({ announced: true, installed: false, liveAwaiters: false, limit: 200 });
    expect(out.announced).toHaveLength(25);
    expect(out.announced_visibility).toMatchObject({ total_active: 30, returned: 25, hidden_by_cap: 5 });
    expect(out.announced_visibility.note).toMatch(/cut by the fixed 25-row announced cap/i);
  });

  it('says the section was UNREADABLE rather than reporting no gates when the store throws', async () => {
    listAnnouncementsMock.mockRejectedValue(new Error('db down'));
    const out = await call({ announced: true, installed: false, liveAwaiters: false });
    expect(out.announced).toBeUndefined();
    expect(out.announced_visibility).toBeUndefined();
    expect(out.announced_unavailable).toMatch(/NOT evidence that no gate was declared/i);
  });

  it('discovers a fired runtime gate from its historical declaration and fire latch', async () => {
    const event = 'fleet:fleet-a:owner-resume';
    listFiredAnnouncementsMock.mockResolvedValue([
      {
        announcement: ann({
          eventKey: event,
          scopeKind: 'fleet',
          scopeRef: 'fleet-a',
          firedAt: null,
          firedReason: null,
        }),
        fireLatch: {
          eventKey: event,
          lastFiredAt: '2026-09-08T22:03:34.810Z',
          firstFiredAt: '2026-09-08T22:03:34.810Z',
          fireCount: 1,
        },
      },
    ]);
    presenceMock.mockResolvedValue({ fleetSlug: 'fleet-a', currentPlanSlug: null });
    presenceFleetMock.mockResolvedValue({ fleetSlug: 'fleet-a', fleetRole: 'member' });

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced).toEqual([
      expect.objectContaining({
        event,
        fired: true,
        fired_at: '2026-09-08T22:03:34.810Z',
        historical: true,
      }),
    ]);
    expect(out.announced_visibility).toMatchObject({
      total_active: 0,
      total_fired_history: 1,
      total_discoverable: 1,
      returned: 1,
      hidden_by_scope: 0,
    });
    expect(listFiredAnnouncementsMock).toHaveBeenCalledWith({ limit: 100 });
  });

  it('keeps fired history scope-filtered and does not expose arbitrary fire-latch keys', async () => {
    const event = 'fleet:fleet-a:owner-resume';
    listFiredAnnouncementsMock.mockResolvedValue([
      {
        announcement: ann({ eventKey: event, scopeKind: 'fleet', scopeRef: 'fleet-a' }),
        fireLatch: {
          eventKey: event,
          lastFiredAt: '2026-09-08T22:03:34.810Z',
          firstFiredAt: '2026-09-08T22:03:34.810Z',
          fireCount: 1,
        },
      },
    ]);
    presenceMock.mockResolvedValue({ fleetSlug: 'fleet-b', currentPlanSlug: null });
    presenceFleetMock.mockResolvedValue({ fleetSlug: 'fleet-b', fleetRole: 'member' });

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced).toBeUndefined();
    expect(out.announced_visibility).toMatchObject({ total_fired_history: 1, hidden_by_scope: 1 });
  });

  it('does not let an earlier fire latch mark a newer active declaration as fired', async () => {
    const event = 'fleet:fleet-a:owner-resume';
    listAnnouncementsMock.mockResolvedValue([ann({ eventKey: event, scopeKind: 'fleet', scopeRef: 'fleet-a' })]);
    listFiredAnnouncementsMock.mockResolvedValue([
      {
        announcement: ann({ eventKey: event, scopeKind: 'fleet', scopeRef: 'fleet-a' }),
        fireLatch: {
          eventKey: event,
          lastFiredAt: '2026-09-08T22:03:34.810Z',
          firstFiredAt: '2026-09-08T22:03:34.810Z',
          fireCount: 1,
        },
      },
    ]);
    presenceMock.mockResolvedValue({ fleetSlug: 'fleet-a', currentPlanSlug: null });
    presenceFleetMock.mockResolvedValue({ fleetSlug: 'fleet-a', fleetRole: 'member' });

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced).toEqual([
      expect.objectContaining({ event, fired: false, fired_at: null }),
    ]);
    expect(out.announced[0]).not.toHaveProperty('historical');
  });
});

describe('events:catalog — live_awaiters', () => {
  it('stays within the prompt-weight hard cap', () => {
    expect(promptWeight(catalog as unknown as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(HARD_CAP);
  });

  it('documents context-derived visibility instead of caller-supplied scope/pot filters', () => {
    expect(catalog.description).toMatch(/Do not pass `scope`, `pot`, or `harness` as JSON filters/i);
    expect(catalog.guidance?.notWhen ?? '').toMatch(/Do not pass `scope`, `pot`, or `harness` as JSON filters/i);
    expect(catalog.args.out.shape).not.toHaveProperty('scope');
    expect(catalog.args.out.shape).not.toHaveProperty('pot');
    expect(catalog.args.out.shape).not.toHaveProperty('harness');
  });

  it('advertises and applies q/limit family filters', async () => {
    expect(catalog.args.safeParse({ q: 'deploy-failed', limit: 1 }).success).toBe(true);

    const out = await call({ q: 'deploy-failed', limit: 1, announced: false, installed: false, liveAwaiters: false });
    expect(out.count).toBe(1);
    expect(out.total).toBe(EVENT_CATALOG.length);
    expect(out.families).toEqual([
      expect.objectContaining({ family: 'deploy-failed' }),
    ]);
  });

  it('finds the scorecard grading-audit family through a free-text query', async () => {
    const out = await call({ q: 'scorecard', announced: false, installed: false, liveAwaiters: false });

    expect(out.families.map((family: { family: string }) => family.family)).toContain('scorecard-grading-audit');
    expect(out.query_miss).toBeUndefined();
  });

  it('accepts pattern as a compatibility alias for q', async () => {
    expect(catalog.args.safeParse({ pattern: 'deploy' }).success).toBe(true);
    const canonical = await call({ q: 'deploy', announced: false, installed: false, liveAwaiters: false });
    // WI-6554700010029664: the alias folds in the schema's preprocess, so dispatch-parse it first.
    const alias = await call(catalog.args.parse({ pattern: 'deploy', announced: false, installed: false, liveAwaiters: false }) as never);
    expect(alias.families).toEqual(canonical.families);
  });

  it('accepts query as a compatibility alias for q', async () => {
    expect(catalog.args.safeParse({ query: 'deploy' }).success).toBe(true);
    const canonical = await call({ q: 'deploy', announced: false, installed: false, liveAwaiters: false });
    const alias = await call(catalog.args.parse({ query: 'deploy', announced: false, installed: false, liveAwaiters: false }) as never);
    expect(alias.families).toEqual(canonical.families);
  });

  // WI-10005981: q used to be ONE contiguous substring, so "resource released" missed
  // the `resource-released` family and two agents filed "no release event exists".
  describe('multi-word q (WI-10005981)', () => {
    const off = { announced: false, installed: false, liveAwaiters: false } as const;
    // CONTROL: the pre-fix predicate, kept so this block proves it discriminates.
    const oldSubstringOnly = (values: readonly unknown[], q: string) =>
      values.some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
    const releasedRow = EVENT_CATALOG.find((e) => e.family === 'resource-released');
    const releasedFields = [releasedRow?.family, releasedRow?.keyTemplate, releasedRow?.describe, releasedRow?.emitter];

    it('finds the family when every word appears, even split across fields', async () => {
      for (const q of ['resource released', 'Resource  Released', 'resource lock released']) {
        const out = await call({ q, ...off });
        expect(out.families.map((f: { family: string }) => f.family)).toContain('resource-released');
        expect(out.query_miss).toBeUndefined();
      }
    });

    it('still requires EVERY word, and labels a zero result as a search miss, not absence', async () => {
      const out = await call({ q: 'resource released zzz-no-such-word', ...off });
      expect(out.count).toBe(0);
      expect(out.query_miss).toMatch(/NOT proof the event does not exist/);
    });

    it('fieldsMatchQuery: verbatim, all-words and missing-word cases; the old predicate fails the multi-word case', () => {
      expect(releasedRow).toBeDefined();
      expect(fieldsMatchQuery(releasedFields, 'resource-released')).toBe(true);
      expect(fieldsMatchQuery(releasedFields, 'resource released')).toBe(true);
      expect(fieldsMatchQuery(releasedFields, 'resource granted')).toBe(false);
      expect(fieldsMatchQuery([null, 42, undefined], 'resource')).toBe(false);
      // Calibration: the control agrees on a verbatim query, then misses the multi-word one.
      expect(oldSubstringOnly(releasedFields, 'resource-released')).toBe(true);
      expect(oldSubstringOnly(releasedFields, 'resource released')).toBe(false);
    });
  });

  it('matches a concrete key against its templated family row', async () => {
    const out = await call({
      q: 'release:deployed:549f75596e666c7ea60731b055e550d484924511',
      announced: false,
      installed: false,
      liveAwaiters: false,
    });
    expect(out.families).toEqual([
      expect.objectContaining({
        family: 'deploy',
        key: 'release:deployed:<sha>',
      }),
    ]);
  });

  it('attaches live_awaiters per row by default, keyed by FAMILY', async () => {
    countMock.mockImplementation(async (shapes: Array<{ family: string }>) => {
      const m = new Map(shapes.map((s) => [s.family, 0]));
      m.set('deploy', 3);
      return m;
    });
    const out = await call({ family: 'deploy' });
    expect(out.families).toHaveLength(1);
    expect(out.families[0]).toMatchObject({ family: 'deploy', live_awaiters: 3 });
    expect(countMock).toHaveBeenCalledTimes(1);
  });

  /**
   * WI-1611805. The old join matched `familyKeyPrefix(e) || '%'`, which is not even
   * `:`-bounded: a placeholder-FIRST template's derived prefix is its bare namespace,
   * so the count swept in every sibling family under it (measured live 2026-08-31 on
   * the since-removed `plan-event`: 5 reported over a true 4). The tool must hand the
   * store the family's SHAPE — the arity-bounded LIKE pattern — so the count and the
   * orphan guard can never disagree about which awaits belong to a family.
   *
   * WI-1632193 removed `plan-event`, so this asserts on `external-trigger`, the
   * remaining placeholder-first family — the shape that actually exercises the bug.
   */
  it('WI-1611805 — passes the arity-bounded SHAPE, not a bare `prefix%`', async () => {
    countMock.mockImplementation(async (shapes: Array<{ family: string }>) => new Map(shapes.map((s) => [s.family, 0])));
    await call({ family: 'external-trigger' });
    expect(countMock).toHaveBeenCalledWith([
      // `ext:%:%` requires two `:`-separated tail segments, so a sibling family under
      // the same namespace cannot match it, and neither can the bare `ext%`-era
      // over-count. `exact` keeps the bare-prefix await counted, as familyAdmitsKey does.
      { family: 'external-trigger', exact: 'ext', like: 'ext:%:%' },
    ]);
    // The unbounded prefix reader must not be reached from this path at all.
    expect(prefixCountMock).not.toHaveBeenCalled();
  });

  it('zero-fills a family with no live registrations', async () => {
    countMock.mockResolvedValue(new Map()); // nothing registered — countActiveAwaitsByPrefixes zero-fills internally, but a stub map is fine too since the tool falls back to 0
    const out = await call({ family: 'deploy-failed' });
    expect(out.families[0].live_awaiters).toBe(0);
  });

  it('liveAwaiters:false skips the DB read entirely', async () => {
    const out = await call({ family: 'deploy', liveAwaiters: false });
    expect(countMock).not.toHaveBeenCalled();
    expect(out.families[0].live_awaiters).toBeUndefined();
  });

  it('a DB failure is swallowed — catalog discovery still returns rows, just without counts', async () => {
    countMock.mockRejectedValue(new Error('pg down'));
    const out = await call({ family: 'deploy' });
    expect(out.ok).toBe(true);
    expect(out.families).toHaveLength(1);
    expect(out.families[0].live_awaiters).toBeUndefined();
  });

  it('surfaces the consult reply park key family', async () => {
    const out = await call({ family: 'consult-reply', announced: false, installed: false });
    expect(out.families).toEqual([
      expect.objectContaining({
        family: 'consult-reply',
        key: 'consult:reply:<conversationId>',
        awaitable_now: true,
      }),
    ]);
  });

  it('surfaces the scorecard grading-audit park key family', async () => {
    const out = await call({
      family: 'scorecard-grading-audit',
      announced: false,
      installed: false,
      liveAwaiters: false,
    });

    expect(out.families).toEqual([
      expect.objectContaining({
        family: 'scorecard-grading-audit',
        key: 'scorecard:grading-audit:<id>',
        awaitable_now: true,
        emitter: expect.stringContaining('scorecard-emitted-events'),
      }),
    ]);
  });

  it('unfiltered call requests counts for every rendered family in one round trip', async () => {
    const out = await call({});
    expect(out.count).toBe(EVENT_CATALOG.length);
    expect(countMock).toHaveBeenCalledTimes(1);
    const requestedPrefixes = countMock.mock.calls[0][0] as string[];
    expect(requestedPrefixes.length).toBe(EVENT_CATALOG.length);
  });
});

// EI-21840718595021627: a role/fleet-leadership-bound announced gate whose declarer
// ended, with nobody live holding the binding, will never fire — surface that UP FRONT
// in the catalog (the "what can I wait on" tool) instead of only reactively via
// events:status after an agent has already armed an await and parked on it.
describe('events:catalog — announced gates: stale role/fleet-leadership owners are surfaced', () => {
  it('marks a role-bound gate stale_owner:true when its ended declarer has no live successor', async () => {
    listAnnouncementsMock.mockResolvedValue([
      ann({
        id: 501,
        subscriberId: 'su-ended',
        scopeKind: 'global',
        scopeRef: null,
        boundTo: { kind: 'role', ref: 'desktop-sidecar' },
      }),
    ]);
    vi.mocked(resolveLiveRoleHolders).mockResolvedValueOnce([]);
    mockResolvedOnceTyped(
      vi.mocked(resolveSessionStates),
      new Map([['su-ended', verdict('su-ended', 'ended')]]),
    );

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced[0]).toMatchObject({
      announced_by: 'su-ended',
      stale_owner: true,
    });
    // A gate that is not stranded must not carry the field at all — the absence itself
    // is the "this is fine" signal, so a caller can `if (stale_owner)` without a
    // separate existence check.
    expect(out.announced[0]).not.toHaveProperty('live_successor_ids');
  });

  it('names the live successor instead of marking stale when one holds the binding', async () => {
    listAnnouncementsMock.mockResolvedValue([
      ann({
        id: 502,
        subscriberId: 'su-ended',
        scopeKind: 'global',
        scopeRef: null,
        boundTo: { kind: 'role', ref: 'desktop-sidecar' },
      }),
    ]);
    vi.mocked(resolveLiveRoleHolders).mockResolvedValueOnce(['su-successor']);
    mockResolvedOnceTyped(
      vi.mocked(resolveSessionStates),
      new Map([
        ['su-ended', verdict('su-ended', 'ended')],
        ['su-successor', verdict('su-successor', 'parked')],
      ]),
    );

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.announced[0]).toMatchObject({ live_successor_ids: ['su-successor'] });
    expect(out.announced[0]).not.toHaveProperty('stale_owner');
  });

  it('an ownership-resolution failure is swallowed — the announced row still renders, just without the fields', async () => {
    listAnnouncementsMock.mockResolvedValue([
      ann({
        id: 503,
        subscriberId: 'su-ended',
        scopeKind: 'global',
        scopeRef: null,
        boundTo: { kind: 'role', ref: 'desktop-sidecar' },
      }),
    ]);
    vi.mocked(resolveLiveRoleHolders).mockRejectedValueOnce(new Error('role-slot lookup down'));
    vi.mocked(resolveSessionStates).mockRejectedValueOnce(new Error('liveness oracle down'));

    const out = await call({ announced: true, installed: false, liveAwaiters: false });

    expect(out.ok).toBe(true);
    expect(out.announced).toHaveLength(1);
    expect(out.announced[0]).not.toHaveProperty('stale_owner');
    expect(out.announced[0]).not.toHaveProperty('live_successor_ids');
  });
});
