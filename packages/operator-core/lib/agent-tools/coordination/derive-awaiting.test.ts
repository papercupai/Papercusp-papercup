/**
 * derive-awaiting.test.ts — coord-derived-fields-2026-08-31 P-004.
 *
 * The module is mostly two bounded SQL reads; what a unit test can and must pin
 * is the fail-soft contract (a decorative stamp must never fail a send) and the
 * guards that keep it from ever fabricating.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveAwaiting, AWAITING_DERIVED_PROVENANCE, AWAITING_MAX_ENTRIES } from './derive-awaiting';

// Opt-in seams: with h.sql / h.readEdges unset every call falls through to the real module, so
// the fail-soft tests above still exercise a genuinely unreachable database.
const h = vi.hoisted(() => ({
  sql: null as null | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>),
  readEdges: null as null | ((args: { ownerId: string; workspaceId: string; limit: number }) => Promise<unknown[]>),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...real,
    getOrgPg: (...args: Parameters<typeof real.getOrgPg>) =>
      h.sql ? ({ sql: h.sql } as unknown as ReturnType<typeof real.getOrgPg>) : real.getOrgPg(...args),
  };
});
vi.mock('../../work-items', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../work-items')>();
  return {
    ...real,
    readHeldUnresolvedDepBlockers: (args: { ownerId: string; workspaceId: string; limit: number }) =>
      h.readEdges ? h.readEdges(args) : real.readHeldUnresolvedDepBlockers(args),
  };
});
afterEach(() => {
  h.sql = null;
  h.readEdges = null;
});

describe('deriveAwaiting (fail-soft)', () => {
  it('returns [] for a missing ownerId or workspaceId — never guesses a scope', async () => {
    expect(await deriveAwaiting({ ownerId: '', workspaceId: 'ws' })).toEqual([]);
    expect(await deriveAwaiting({ ownerId: 'su-x', workspaceId: '' })).toEqual([]);
  });

  it('returns [] (never throws) when the database is unreachable', async () => {
    // In the unit environment getOrgPg either throws or cannot connect; either
    // path must degrade to "no field", not a failed send.
    await expect(
      deriveAwaiting({ ownerId: 'su-nonexistent', workspaceId: 'unit-test-no-db' }),
    ).resolves.toEqual([]);
  });
});

describe('deriveAwaiting — dependency-edge leg (WI-10005020, D-008 §4a)', () => {
  /** Leg 1 (event awaits) and leg 2 (held externalBlockers) answer from these fixtures in order. */
  /** A well-formed externalBlockers record — readExternalBlockers drops a malformed one. */
  function blockerRow(kind: string, ref: string, status: 'active' | 'cleared') {
    const at = '2026-10-01T18:00:00.000Z';
    return { kind, ref, status, summary: `${kind} ${ref}`, createdAt: at, createdBy: 'su-a', updatedAt: at };
  }

  function stubSql(eventAwaits: unknown[], heldBlockerRows: unknown[]) {
    const answers = [eventAwaits, heldBlockerRows];
    let call = 0;
    h.sql = async () => answers[call++] ?? [];
  }

  it('a held item whose work-item blocker was migrated to an edge still surfaces as awaiting', async () => {
    // After R-15 the external row is CLEARED (inactive) — leg 2 yields nothing for it.
    stubSql([], [
      { feature_id: 'WI-1', payload: { externalBlockers: [blockerRow('event', 'work-item:done:WI-2', 'cleared')] } },
    ]);
    const seen: unknown[] = [];
    h.readEdges = async (args) => {
      seen.push(args);
      return [{ featureId: 'WI-1', blockerRef: 'WI-2', blockerKind: 'issue', since: '2026-10-01T20:00:00.000Z' }];
    };
    const out = await deriveAwaiting({ ownerId: 'su-a', workspaceId: 'ws' });
    expect(out).toEqual([
      { kind: 'work-item-blocker', ref: 'work-item:WI-1', blocker: 'blocks:WI-2', since: '2026-10-01T20:00:00.000Z' },
    ]);
    expect(seen).toEqual([{ ownerId: 'su-a', workspaceId: 'ws', limit: AWAITING_MAX_ENTRIES }]);
  });

  it('keeps legs 1-2 and asks the edge leg only for the remaining budget', async () => {
    stubSql(
      [{ event_key: 'release:published:x', created_at: new Date('2026-10-01T19:00:00Z') }],
      [{ feature_id: 'WI-3', payload: { externalBlockers: [blockerRow('human', 'owner-signoff', 'active')] } }],
    );
    let asked = -1;
    h.readEdges = async (args) => {
      asked = args.limit;
      return [{ featureId: 'WI-4', blockerRef: 'papercusp#F-9', blockerKind: 'feature', since: null }];
    };
    const out = await deriveAwaiting({ ownerId: 'su-a', workspaceId: 'ws' });
    expect(out.map((e) => `${e.kind}|${e.ref}|${e.blocker ?? ''}`)).toEqual([
      'event-await|release:published:x|',
      'work-item-blocker|work-item:WI-3|human:owner-signoff',
      'work-item-blocker|work-item:WI-4|blocks:papercusp#F-9',
    ]);
    expect(asked).toBe(AWAITING_MAX_ENTRIES - 2);
    expect(out[2]).not.toHaveProperty('since'); // an unknown age is omitted, never fabricated
  });

  it('an edge-read failure costs only the edge leg, never legs 1-2', async () => {
    stubSql([{ event_key: 'release:published:x', created_at: new Date('2026-10-01T19:00:00Z') }], []);
    h.readEdges = async () => {
      throw new Error('edge read failed');
    };
    const out = await deriveAwaiting({ ownerId: 'su-a', workspaceId: 'ws' });
    expect(out).toEqual([{ kind: 'event-await', ref: 'release:published:x', since: '2026-10-01T19:00:00.000Z' }]);
  });

  it('does not call the edge leg once the cap is already full', async () => {
    stubSql(
      Array.from({ length: AWAITING_MAX_ENTRIES }, (_, i) => ({ event_key: `k:${i}`, created_at: new Date(0) })),
      [],
    );
    let called = false;
    h.readEdges = async () => {
      called = true;
      return [];
    };
    const out = await deriveAwaiting({ ownerId: 'su-a', workspaceId: 'ws' });
    expect(out).toHaveLength(AWAITING_MAX_ENTRIES);
    expect(called).toBe(false);
  });
});

describe('constants', () => {
  it('provenance token is stable — adoption queries filter on it', () => {
    expect(AWAITING_DERIVED_PROVENANCE).toBe('session-derived');
  });
  it('cap stays a pointer set, not a transcript', () => {
    expect(AWAITING_MAX_ENTRIES).toBeLessThanOrEqual(8);
  });
});
