import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { resolveSearchFilters, searchFilterArgs } from './filters';

// The session:'self' and owner:'self' paths never use `sql` (only the fleet
// branch queries). Keep transcript discovery out of this filter-mapping unit
// test: its real DB/filesystem lookup can exceed the bounded timeout.
const noSql = null as unknown as Sql;
const FAKE_OWNER = 'su-wi5644-test-owner-no-real-dir';
const resolveSelfSession = vi.fn();
vi.mock('../../search/self-session', () => ({
  resolveSelfSession: (...args: unknown[]) => resolveSelfSession(...args),
}));

describe('resolveSearchFilters — session:self owner-scoping (WI-5644)', () => {
  it("owner-scopes session:'self' across the whole respawn chain and never pins a single native sessionId", async () => {
    resolveSelfSession.mockResolvedValue(null);
    const { filters } = await resolveSearchFilters(noSql, { session: 'self' }, FAKE_OWNER);
    // The fix: `session:'self'` recall must span EVERY transcript the coord
    // owner produced (a cold carry-respawn scatters history across many native
    // sessions under one owner), so it scopes by the owner column — never by a
    // single, possibly-stale native session id.
    expect(filters?.owners).toEqual([FAKE_OWNER]);
    expect(filters?.sessionId).toBeUndefined();
  });

  it('still pins filters.sessionId for an EXPLICIT (non-self) session id', async () => {
    const { filters } = await resolveSearchFilters(noSql, { session: 'abc-123' }, FAKE_OWNER);
    // Regression guard: only the 'self' sugar is owner-scoped; an explicit
    // session id must still narrow to that one session.
    expect(filters?.sessionId).toBe('abc-123');
    expect(filters?.owners).toBeUndefined();
  });

  it("resolves owner:'self' to the caller ownerId (unchanged)", async () => {
    const { filters } = await resolveSearchFilters(noSql, { owner: 'self' }, FAKE_OWNER);
    expect(filters?.owners).toEqual([FAKE_OWNER]);
  });

  it('returns no filters when nothing is set (the no-narrowing fast path)', async () => {
    const resolved = await resolveSearchFilters(noSql, {}, FAKE_OWNER);
    expect(resolved.filters).toBeUndefined();
  });

  it('maps owner-directive provenance filters into the shared search filter bag', async () => {
    const { filters } = await resolveSearchFilters(
      noSql,
      { turn_origin: 'owner-typed', owner_only: true },
      FAKE_OWNER,
    );
    expect(filters).toMatchObject({ turnOrigin: 'owner-typed', ownerOnly: true });
  });

  it('describes hook-correlated owner-typed rows instead of claiming a structural zero', () => {
    const description = (key: keyof typeof searchFilterArgs) =>
      (searchFilterArgs[key] as unknown as { description?: string }).description ?? '';
    const provenance = [description('turn_origin'), description('owner_only'), description('owner_candidates')].join('\n');

    expect(provenance).toMatch(/hook-authenticated prompt-origin stamp/i);
    expect(provenance).toMatch(/owner-typed/);
    expect(provenance).toMatch(/unenrolled-origin/);
    expect(provenance).toMatch(/not evidence/i);
    expect(provenance).not.toMatch(/structurally unreachable/i);
    expect(provenance).not.toMatch(/returns zero rows no matter what/i);
  });
});

/**
 * The `fleet:` branch — the ONE path here that queries `sql`, and (until
 * EI-19313376980892266) the only one with no coverage at all. It now resolves through
 * fleet-membership-store's `fleetEverMembers` so this surface and work_items:burn_down's
 * `deltaBy` share ONE membership oracle instead of each carrying its own copy of the
 * ledger query.
 */
describe('resolveSearchFilters — fleet: ever-members (D-002)', () => {
  /** A tagged-template stub standing in for `postgres`'s Sql. */
  function sqlReturning(rows: Array<{ owner_id: string }>): { sql: Sql; calls: number } {
    const state = { calls: 0 };
    const fn = (..._args: unknown[]) => {
      // postgres.js fragments are lazy: an interpolated fragment is built but not
      // executed. Count only the outer fragment that the production code awaits.
      return {
        then(resolve: (value: Array<{ owner_id: string }>) => void) {
          state.calls += 1;
          resolve(rows);
        },
      };
    };
    return { sql: fn as unknown as Sql, get calls() { return state.calls; } };
  }

  it('resolves a fleet to its EVER-members — including ones no longer live', async () => {
    // `su-dead` has no presence row anymore; the ledger still carries it, and a
    // postmortem/attribution read is exactly the case that needs it.
    const stub = sqlReturning([{ owner_id: 'su-alive' }, { owner_id: 'su-dead' }]);
    const { filters } = await resolveSearchFilters(
      stub.sql,
      { fleet: 'my-fleet' },
      FAKE_OWNER,
      { workspaceId: 'papercusp-workspace' },
    );
    expect(new Set(filters?.owners)).toEqual(new Set(['su-alive', 'su-dead']));
    expect(stub.calls).toBe(1);
  });

  it('keeps the impossible-filter sentinel when a fleet resolves to nobody', async () => {
    // Regression guard for the refactor: an unknown fleet must still narrow to NOTHING
    // rather than silently dropping the filter and returning the unfiltered corpus.
    const { filters } = await resolveSearchFilters(
      sqlReturning([]).sql,
      { fleet: 'no-such-fleet' },
      FAKE_OWNER,
    );
    expect(filters?.owners).toEqual(['__no_such_fleet__']);
  });

  it('does NOT add the sentinel when an explicit owner was also given', async () => {
    const { filters } = await resolveSearchFilters(
      sqlReturning([]).sql,
      { fleet: 'no-such-fleet', owner: 'su-explicit' },
      FAKE_OWNER,
    );
    expect(filters?.owners).toEqual(['su-explicit']);
  });
});
