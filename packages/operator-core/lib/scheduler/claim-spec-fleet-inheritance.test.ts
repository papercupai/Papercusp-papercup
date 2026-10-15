/**
 * Fleet-level claim-spec inheritance (fleet-scheduler-hardening-2026-07-03 P-002).
 *
 * Claim specs were keyed ONLY by bee ownerId, so a fleet relaunch (fresh ownerIds)
 * stranded the leader hand-authoring N per-bee specs before members pulled correctly —
 * and until then every member pulled under DEFAULT order. The fix stores a FLEET-level
 * spec under the `fleet:<slug>` sentinel bee_id (same table, no schema change) and
 * `getClaimSpec` resolves: bee spec → fleet spec (via the durable membership fact,
 * stamped at boot per WI-1893) → DEFAULT_CLAIM_SPEC.
 *
 * These tests pin the resolution order and the sentinel key at the store's IO seams
 * (sqlOverride + a mocked fleet-membership-store — no PG), plus the tool's
 * exactly-one-of-{cupId,fleet} arg contract.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ZodTypeAny } from 'zod';

const membershipMock = vi.fn(
  async (_ws: string, _owner: string) =>
    null as {
      fleetSlug: string | null;
      fleetRole: string | null;
    } | null,
);
vi.mock('../fleet-membership-store', () => ({
  latestFleetMembership: (ws: string, owner: string) => membershipMock(ws, owner),
  appendFleetMembershipEvent: vi.fn(async () => {}),
  appendFleetMembershipIfAbsent: vi.fn(async () => {}),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));

import { getClaimSpec, setClaimSpec, clearClaimSpec, fleetSpecBeeKey } from './claim-spec-store';
import { DEFAULT_CLAIM_SPEC, claimSpecSchema } from './claim-spec';
import setClaimSpecTool from '../agent-tools/scheduler/set_claim_spec';
import healthTool from '../endpoint-route/routes/misc/health';

/** A minimal spec that passes validateClaimSpec. */
const laneSpec = (specId: string) => ({
  specVersion: '1.0',
  specId,
  revision: 1,
  view: {},
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
});

/** Tagged-template sql stub: returns queued row-sets in call order, records queries. */
function makeSqlStub(queue: unknown[][]) {
  const calls: string[] = [];
  const sql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(`${strings.join('␟')} :: ${vals.map(String).join(',')}`);
    return queue.shift() ?? [];
  };
  return { sql: sql as never, calls };
}

beforeEach(() => {
  membershipMock.mockReset();
  membershipMock.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('shared claim-spec reader compatibility (D-025)', () => {
  const candidate = () => ({ ...laneSpec('adoption-lane'), revisionAdoption: 'first' as const });
  const supportedHealth = { ok: true, sha: 'a'.repeat(40),
    claimSpec: { specVersion: '1.0', revisionAdoption: ['first'] } };

  it('refuses a newer writer against an older strict reader before touching the stored lane', async () => {
    // The older root schema accepts the incumbent and rejects exactly the additive field.
    const olderReader = claimSpecSchema.omit({ revisionAdoption: true });
    expect(olderReader.safeParse(laneSpec('incumbent')).success).toBe(true);
    expect(olderReader.safeParse(candidate()).success).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
      url.includes(':3070/') ? { ok: true, sha: 'b'.repeat(40) } : supportedHealth,
    )));
    const { sql, calls } = makeSqlStub([]);
    const result = await setClaimSpec({ cupId: 'fleet:f', workspaceId: 'ws1', spec: candidate() }, sql);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('release-operator');
    expect(calls).toEqual([]);
  });

  it.each([3170, 3271])('also qualifies the consuming reader on port %s', async (port) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
      url.includes(`:${port}/`) ? { ok: true, sha: 'b'.repeat(40) } : supportedHealth,
    )));
    const { sql, calls } = makeSqlStub([]);
    const result = await setClaimSpec({ cupId: 'fleet:f', spec: candidate() }, sql);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps unknown or failed capability reads distinct from support', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
    const { sql, calls } = makeSqlStub([]);
    const result = await setClaimSpec({ cupId: 'fleet:f', spec: candidate() }, sql);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(calls).toEqual([]);
  });

  it('preserves the opt-in after every reader attests it, and leaves rollback writes available', async () => {
    const fetch = vi.fn(async () => Response.json(supportedHealth));
    vi.stubGlobal('fetch', fetch);
    const qualified = makeSqlStub([[], [{ revision: 2 }]]);
    expect((await setClaimSpec({ cupId: 'fleet:f', spec: candidate() }, qualified.sql)).ok).toBe(true);
    expect(qualified.calls.join(' ')).toContain('"revisionAdoption":"first"');
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear();
    const rollback = makeSqlStub([[], [{ revision: 3 }]]);
    expect((await setClaimSpec({ cupId: 'fleet:f', spec: laneSpec('incumbent') }, rollback.sql)).ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('publishes the running reader capability through the existing health route', async () => {
    const response = (healthTool as unknown as { handler: () => Response }).handler();
    const body = await response.json();
    expect(body.claimSpec).toEqual({ specVersion: '1.0', revisionAdoption: ['first'] });
    expect(claimSpecSchema.safeParse(candidate()).success).toBe(true);
  });
});

describe('fleetSpecBeeKey', () => {
  it('is the fleet:<slug> sentinel', () => {
    expect(fleetSpecBeeKey('backlog-clearance')).toBe('fleet:backlog-clearance');
  });
});

describe('getClaimSpec fleet inheritance (P-002)', () => {
  it('a per-bee spec WINS — no membership lookup at all', async () => {
    const beeSpec = laneSpec('bee-own-lane');
    const { sql } = makeSqlStub([[{ spec: beeSpec }]]);
    const got = await getClaimSpec({ cupId: 'su-abc', workspaceId: 'ws1' }, sql);
    expect(got.specId).toBe('bee-own-lane');
    expect(membershipMock).not.toHaveBeenCalled();
  });

  it('no bee spec + fleet membership + fleet spec ⇒ inherits the fleet spec', async () => {
    membershipMock.mockResolvedValue({ fleetSlug: 'backlog-clearance', fleetRole: 'member' });
    const fleetSpec = laneSpec('bc-general');
    const { sql, calls } = makeSqlStub([[], [{ spec: fleetSpec }]]);
    const got = await getClaimSpec({ cupId: 'su-new-member', workspaceId: 'ws1' }, sql);
    expect(got.specId).toBe('bc-general');
    expect(membershipMock).toHaveBeenCalledWith('ws1', 'su-new-member');
    // The second query keyed the sentinel, same workspace partition.
    expect(calls[1]).toContain('fleet:backlog-clearance');
    expect(calls[1]).toContain('ws1');
  });

  it('no bee spec + NO membership ⇒ DEFAULT_CLAIM_SPEC', async () => {
    const { sql } = makeSqlStub([[]]);
    const got = await getClaimSpec({ cupId: 'su-loner', workspaceId: 'ws1' }, sql);
    expect(got).toBe(DEFAULT_CLAIM_SPEC);
  });

  it('no bee spec + membership but NO fleet spec row ⇒ DEFAULT_CLAIM_SPEC', async () => {
    membershipMock.mockResolvedValue({ fleetSlug: 'ops-team', fleetRole: 'member' });
    const { sql } = makeSqlStub([[], []]);
    const got = await getClaimSpec({ cupId: 'su-member', workspaceId: 'ws1' }, sql);
    expect(got).toBe(DEFAULT_CLAIM_SPEC);
  });

  it('a membership-store failure propagates instead of widening authority to DEFAULT', async () => {
    membershipMock.mockRejectedValue(new Error('pg down'));
    const { sql } = makeSqlStub([[]]);
    await expect(getClaimSpec({ cupId: 'su-member', workspaceId: 'ws1' }, sql)).rejects.toThrow('pg down');
  });
});

describe('clearClaimSpec (EI-12830 — drop a per-bee override so it falls back to fleet inheritance)', () => {
  it('DELETEs the (workspace, bee_id) row and reports cleared:true when a row existed', async () => {
    const { sql, calls } = makeSqlStub([[{ bee_id: 'su-m' }]]); // DELETE ... RETURNING → one row
    const res = await clearClaimSpec({ cupId: 'su-m', workspaceId: 'ws1' }, sql);
    expect(res).toEqual({ ok: true, errors: [], cleared: true });
    expect(calls[0]).toContain('DELETE FROM harness_shared.cup_claim_specs');
    expect(calls[0]).toContain('ws1');
    expect(calls[0]).toContain('su-m');
  });

  it('is idempotent — clearing an absent row reports cleared:false', async () => {
    const { sql } = makeSqlStub([[]]); // DELETE ... RETURNING → no rows
    expect(await clearClaimSpec({ cupId: 'su-absent', workspaceId: 'ws1' }, sql)).toEqual({
      ok: true,
      errors: [],
      cleared: false,
    });
  });

  it('guards an automatic clear by the exact specId@revision that was inspected', async () => {
    const { sql, calls } = makeSqlStub([[{ bee_id: 'su-m' }]]);
    const res = await clearClaimSpec(
      {
        cupId: 'su-m',
        workspaceId: 'ws1',
        expectedHead: { specId: 'plans-start-finished-plan', revision: 7 },
      },
      sql,
    );

    expect(res.cleared).toBe(true);
    expect(calls[0]).toContain("spec->>'specId'");
    expect(calls[0]).toContain('plans-start-finished-plan');
    expect(calls[0]).toContain('7');
  });

  it('reports cleared:false when the inspected head lost a concurrent re-steer race', async () => {
    const { sql, calls } = makeSqlStub([[]]);
    const res = await clearClaimSpec(
      {
        cupId: 'su-m',
        workspaceId: 'ws1',
        expectedHead: { specId: 'plans-start-finished-plan', revision: 7 },
      },
      sql,
    );

    expect(res).toEqual({ ok: true, errors: [], cleared: false });
    expect(calls[0]).toContain('plans-start-finished-plan');
  });

  it('REGRESSION: a stale per-bee override shadows the fleet; after clearing it the bee inherits the fleet spec again', async () => {
    // Before the clear: the per-bee spec ALWAYS wins — membership is not even consulted.
    const before = makeSqlStub([[{ spec: laneSpec('stale-per-bee') }]]);
    expect((await getClaimSpec({ cupId: 'su-m', workspaceId: 'ws1' }, before.sql)).specId).toBe('stale-per-bee');
    expect(membershipMock).not.toHaveBeenCalled();

    // Clear the per-bee row (the capability that did not exist before EI-12830).
    const cleared = makeSqlStub([[{ bee_id: 'su-m' }]]);
    expect((await clearClaimSpec({ cupId: 'su-m', workspaceId: 'ws1' }, cleared.sql)).cleared).toBe(true);

    // After: with the per-bee row gone, getClaimSpec falls through to the fleet's spec —
    // a later fleet-level re-steer is finally visible to this member.
    membershipMock.mockResolvedValue({ fleetSlug: 'drain-fleet', fleetRole: 'member' });
    const after = makeSqlStub([[], [{ spec: laneSpec('fleet-lane') }]]);
    const got = await getClaimSpec({ cupId: 'su-m', workspaceId: 'ws1' }, after.sql);
    expect(got.specId).toBe('fleet-lane');
    expect(after.calls[1]).toContain(fleetSpecBeeKey('drain-fleet'));
  });
});

describe('scheduler:set_claim_spec args — exactly one of cupId | fleet', () => {
  const args = (setClaimSpecTool as { args: ZodTypeAny }).args;
  const spec = laneSpec('lane');

  it('accepts cupId-only and fleet-only', () => {
    expect(args.safeParse({ cupId: 'su-abc', spec }).success).toBe(true);
    expect(args.safeParse({ fleet: 'backlog-clearance', spec }).success).toBe(true);
  });

  it('rejects neither and both', () => {
    expect(args.safeParse({ spec }).success).toBe(false);
    expect(args.safeParse({ cupId: 'su-abc', fleet: 'backlog-clearance', spec }).success).toBe(false);
  });

  it('EI-12830: accepts clear:true WITHOUT a spec (cupId or fleet); still requires a target', () => {
    expect(args.safeParse({ cupId: 'su-abc', clear: true }).success).toBe(true);
    expect(args.safeParse({ fleet: 'backlog-clearance', clear: true }).success).toBe(true);
    // clear still needs exactly one target — clear alone names none.
    expect(args.safeParse({ clear: true }).success).toBe(false);
  });

  it('EI-12830: still requires a spec when NOT clearing', () => {
    expect(args.safeParse({ cupId: 'su-abc' }).success).toBe(false);
  });
});
