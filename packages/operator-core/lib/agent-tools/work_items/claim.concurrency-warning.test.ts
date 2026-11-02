/**
 * work_items:claim — the AT-CAPACITY warning (EI-19313376980892266).
 *
 * WHY THIS EXISTS, so the assertions read as consequences rather than trivia.
 *
 * The work-item that produced this code asked for a GATE here: it listed `work_items:claim` as
 * the fourth divergent consumer of `maxConcurrentClaims` ("ZERO references … NO enforcement")
 * in a "one oracle" bug, alongside the scheduler's refusal, get_next's miss diagnosis, and
 * fleet:leader-brief's idle accounting. That prescription was WRONG and is retracted — this
 * file is the record of why, because the same wrong prescription has now been proposed twice
 * for this same door (P-013 wanted a dependency-blocking floor here and D-008 overturned it).
 *
 * The governing ruling is `work-item-dependency-edges-2026-08-02#D-008`: "EXEMPT the by-id
 * claim from the blocking floor and SIGNAL instead — READINESS floors gate self-select only;
 * SECURITY floors gate everywhere." A concurrency cap is a readiness floor (the claimer's
 * capacity, not its authorization), so the same ruling decides this case.
 * (Cite it qualified: D-008 is on THAT plan, not on the similarly-named
 * `dependency-subsystem-thorough-testing-2026-08-02`, which is where the census test's own
 * P-009 provenance points. Two dependency plans, same date, both with a P-009 and a P-013.)
 *
 * `claim-door-census.test.ts` encodes it executably — `claimWorkItem` → `by-id-ungated` — and
 * names this exact trap: "a census that demanded every door gate would encode the wrong
 * invariant and fail working code — which is worse than no census, because someone would then
 * 'fix' the code to satisfy it." A concurrency refusal here would have been that fix, and it
 * would have broken the two flows the by-id door exists for: a leader dispatching a named item
 * to a named member, and a drain leader taking a swath via { ids:[…] }.
 *
 * What was genuinely missing is what was missing in the terminal and blocked cases: not a
 * floor, a SIGNAL. So the invariant is TWO-HALVED and the halves must be asserted together —
 * the claim must keep SUCCEEDING *and* keep WARNING. Asserting either alone lets a future edit
 * satisfy the test while destroying the point: drop the warning and it silently regresses to
 * the original bug; add a floor and it "passes" while breaking dispatch and bulk claims.
 *
 * The third assertion, and the one specific to THIS warning: it must resolve the claimer's OWN
 * cap. Defaulting to 1 is the easy wiring and is wrong in the expensive direction — it would
 * warn a member legitimately running under a leader-authored `maxConcurrentClaims: 2` that it
 * is over a cap that does not exist, which is the false-POSITIVE mirror of the false-negative
 * (leader-brief marking at-capacity members `idle_with_claimable`) that produced this item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
const fleetAdmission = vi.hoisted(() => ({
  decision: { allowed: true, scoped: false } as any,
  notify: vi.fn(),
}));
const store = vi.hoisted(() => ({
  /** The claimer's effective cap, as `getClaimSpecRecord` would resolve it. */
  maxConcurrentClaims: 1 as number | null | undefined,
  /** The rows `getActiveClaimsForBee` would return — a PARKED item is in here too. */
  held: [] as { id: string }[],
  readThrows: false,
  specThrows: false,
}));

vi.mock('../coordination/identity', () => ({
  SUPERUSER_FALLBACK_CLIENT_ID: 'su-loopback',
  isEphemeralMcpCallIdentity: (id: string) => /^mcp-call-\d+$/.test(id),
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));
// Placement validates the roster before the capacity decision. These fixtures
// name one concrete member; they must not depend on the live workspace roster.
vi.mock('../coordination/recipient-resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../coordination/recipient-resolve')>();
  return { ...actual, resolveExplicitAgentOwnerId: vi.fn<typeof actual.resolveExplicitAgentOwnerId>(async (raw, caller) => {
    const ownerId = raw === 'self' ? caller : raw;
    return ownerId === caller || ownerId === 'member-7'
      ? { ok: true, ownerId }
      : { ok: false, code: 'assignee_unknown', message: 'Agent is absent from the fixture roster.' };
  }) };
});
// PARTIAL mock (importOriginal) — never a hand-listed factory. See the long note in
// claim.test.ts: a forgotten export resolves to `undefined`, claim.ts throws on it, and every
// test in the file fails with an assertion naming neither the export nor the mock.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claimWorkItem: vi.fn(),
  classifyClaimFailure: vi.fn(),
  getWorkItem: vi.fn(),
  readUnresolvedDepBlockers: vi.fn(),
}));
vi.mock('./claim-hold-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordClaimHoldBypassAudit: vi.fn(async () => {}),
  notifyClaimHoldBypass: vi.fn(async () => {}),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  admitWorkItemForFleetTarget: vi.fn(async () => fleetAdmission.decision),
  notifyFleetScopeRefusal: fleetAdmission.notify,
  fleetScopeLeaderRemedy: vi.fn(() => 'remedy: scheduler:set_claim_spec { … }'),
}));
vi.mock('../../memory/claim-port', () => ({ buildClaimRecallBlock: vi.fn(async () => null) }));

/**
 * Only the two READS are faked. `readClaimConcurrency` still decides through the REAL
 * `evaluateClaimConcurrency`, which is the entire point of the item: if a future edit
 * re-derives the `activeClaims >= max` comparison anywhere in the claim path instead of
 * sharing the oracle, these tests keep passing but the divergence is back — so the decision
 * has to come from the real function here, not from a hand-written `blocked: true`.
 */
const readClaimConcurrencySpy = vi.fn();
const getClaimSpecRecordSpy = vi.fn();
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../scheduler/claim-spec-store')>();
  return {
    ...orig,
    getClaimSpecRecord: (...a: unknown[]) => {
      getClaimSpecRecordSpy(...a);
      if (store.specThrows) throw new Error('spec store down');
      return Promise.resolve({
        source: 'cup',
        spec: { limits: { maxConcurrentClaims: store.maxConcurrentClaims } },
        revision: 1,
        updatedBy: null,
        updatedAt: '2026-08-03T00:00:00Z',
        harnessSlug: null,
      } as never);
    },
    readClaimConcurrency: (args: { maxConcurrentClaims?: number | null }, ...rest: unknown[]) => {
      readClaimConcurrencySpy(args, ...rest);
      if (store.readThrows) return Promise.reject(new Error('pg down'));
      return Promise.resolve(
        orig.evaluateClaimConcurrency({
          activeClaims: store.held,
          maxConcurrentClaims: args.maxConcurrentClaims,
        }),
      );
    },
  };
});

const getClaimTimeCheckpointHint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: (...a: unknown[]) => getClaimTimeCheckpointHint(...a),
}));

import { claimWorkItem, getWorkItem, readUnresolvedDepBlockers } from '../../work-items';
import { evaluateClaimConcurrency } from '../../scheduler/claim-spec-store';
const claimM = vi.mocked(claimWorkItem);
const getWorkItemM = vi.mocked(getWorkItem);
const blockersM = vi.mocked(readUnresolvedDepBlockers);
const mod = await import('./claim');
const tool = mod.default;
const { concurrencyClaimWarning } = mod;
const setClaimSpecTool = (await import('../scheduler/set_claim_spec')).default;

type Out = { data: any };
const body = async (args: unknown) => ((await tool.handler(args as never, {} as never)) as Out).data;

/** Build a verdict the way production does — through the shared oracle, never by hand. */
const verdict = (held: string[], max?: number | null) =>
  evaluateClaimConcurrency({ activeClaims: held.map((id) => ({ id })), maxConcurrentClaims: max });

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  fleetAdmission.decision = { allowed: true, scoped: false };
  store.maxConcurrentClaims = 1;
  store.held = [];
  store.readThrows = false;
  store.specThrows = false;
  claimM.mockImplementation(async (id: string) => ({ id, harness: 'papercup', assignee: 'me' }) as never);
  getWorkItemM.mockResolvedValue(null);
  getClaimTimeCheckpointHint.mockResolvedValue(null);
  blockersM.mockResolvedValue([]);
});

describe('concurrencyClaimWarning (pure)', () => {
  it('returns null when the caller was not at its cap', () => {
    expect(concurrencyClaimWarning(null, 'WI-1', 'me')).toBeNull();
    expect(concurrencyClaimWarning(undefined, 'WI-1', 'me')).toBeNull();
    // Holding NOTHING under a cap of 1 — the ordinary claim, which must stay silent.
    expect(concurrencyClaimWarning(verdict([], 1), 'WI-1', 'me')).toBeNull();
    // Holding 1 under a leader-authored cap of 2 — the false-positive this warning must not fire.
    expect(concurrencyClaimWarning(verdict(['WI-9'], 2), 'WI-1', 'me')).toBeNull();
  });

  it('reports the counts, names the held lanes, and says the claim SUCCEEDED on purpose', () => {
    const w = concurrencyClaimWarning(verdict(['WI-9', 'EI-8'], 1), 'WI-NEW', 'me');
    expect(w).toBeTruthy();
    // The held ids are the actionable part: an agent told only "you are at cap" cannot act.
    expect(w).toContain('WI-9');
    expect(w).toContain('EI-8');
    expect(w).toContain('2/1');
    // Without this, the warning reads as a failure and an agent "retries" a claim it already holds.
    expect(w).toMatch(/claim SUCCEEDED/i);
    // The load-bearing consequence: the queue will now refuse this caller.
    expect(w).toMatch(/scheduler:get_next/);
    // And the remedy has to include the legitimate one — raising the cap deliberately — or the
    // only advice on offer is "release work", which is wrong for a lane that genuinely runs 2-up.
    expect(w).toMatch(/scheduler:set_claim_spec/);
    expect(w).toContain("scheduler:get_claim_spec { cupId: 'me' }");
    expect(w).toContain(
      "scheduler:set_claim_spec { cupId: 'me', spec: { ...current.spec, " +
        'limits: { ...current.spec.limits, maxConcurrentClaims: N } } }',
    );
    expect(w).toContain('exactly one target selector (cupId or fleet)');
    expect(w).not.toContain('scheduler:set_claim_spec { limits:');
    // The non-obvious cause of the original divergence, stated where it is needed.
    expect(w).toMatch(/PARKED/i);
  });

  it('subtracts the item just claimed, so a re-claim never reports itself as another lane', () => {
    // The verdict is read PRE-claim so this should not arise; asserting it means a later move of
    // the read to post-claim cannot silently start double-counting the subject item.
    const w = concurrencyClaimWarning(verdict(['WI-SELF'], 1), 'WI-SELF', 'me')!;
    expect(w).not.toContain('holding: WI-SELF');
  });

  it('caps the named list but still reports the true totals', () => {
    const many = Array.from({ length: 12 }, (_, i) => `WI-${i + 1}`);
    const w = concurrencyClaimWarning(verdict(many, 1), 'WI-NEW', 'me')!;
    expect(w).toContain('12/1');
    expect(w).toContain('+4 more');
    expect(w).not.toContain('WI-9,');
  });

  it('prescribes a cap update accepted by scheduler:set_claim_spec', () => {
    const warning = concurrencyClaimWarning(verdict(['WI-HELD'], 1), 'WI-OVER', 'member-7', 'member-7')!;
    expect(warning).toContain("scheduler:get_claim_spec { cupId: 'member-7' }");
    expect(warning).toContain(
      "scheduler:set_claim_spec { cupId: 'member-7', spec: { ...current.spec, " +
        'limits: { ...current.spec.limits, maxConcurrentClaims: N } } }',
    );

    const current = {
      spec: {
        specVersion: '1.0',
        specId: 'member-lane',
        revision: 1,
        view: { filter: { field: 'kind', op: '=', value: 'bug' } },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
        limits: { maxConcurrentClaims: 1 },
      },
    };
    const advisedCall = {
      cupId: 'member-7',
      spec: {
        ...current.spec,
        limits: { ...current.spec.limits, maxConcurrentClaims: 2 },
      },
    };

    expect(setClaimSpecTool.args.safeParse(advisedCall).success).toBe(true);
    expect(setClaimSpecTool.args.safeParse({ cupId: 'member-7', limits: { maxConcurrentClaims: 2 } }).success).toBe(false);
    expect(setClaimSpecTool.args.safeParse({ cupId: 'member-7', spec: { limits: { maxConcurrentClaims: 2 } } }).success).toBe(false);
  });
});

describe('work_items:claim — an at-cap by-id claim SUCCEEDS and WARNS (by-id-ungated)', () => {
  it('claims past the cap successfully AND attaches the warning + the verdict', async () => {
    store.held = [{ id: 'WI-HELD' }];
    const b = await body({ id: 'WI-OVER' });
    // HALF ONE — the claim is NOT refused. A floor here would break leader dispatch and { ids:[…] }.
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-OVER' });
    expect(b.results[0].error).toBeUndefined();
    // HALF TWO — and it does not look like the queue agreed the caller had capacity.
    expect(b.results[0].concurrencyWarning).toMatch(/CONCURRENCY CAP/i);
    expect(b.results[0].concurrency).toEqual({
      activeClaims: 1,
      maxConcurrentClaims: 1,
      heldIds: ['WI-HELD'],
    });
  });

  it('attaches the warning on the CHECKPOINT response shape too, not just the bare one', async () => {
    // claimOne has TWO response-construction sites (with / without an EI-529 checkpoint hint).
    // Every claim-time guard has to be spread onto both, and adding one to a single site is a
    // silent half-fix that no test asserting only the common path would catch.
    getClaimTimeCheckpointHint.mockResolvedValue({ checkpoint: 'did: X', checkpointAgeMs: 1_000 });
    store.held = [{ id: 'WI-HELD' }];
    const b = await body({ id: 'WI-BOTH' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-BOTH', checkpoint: 'did: X' });
    expect(b.results[0].concurrencyWarning).toContain('WI-HELD');
  });

  it('omits the fields entirely on a claim made with capacity to spare', async () => {
    store.held = [];
    const b = await body({ id: 'WI-FIRST' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-FIRST' });
    expect(b.results[0].concurrencyWarning).toBeUndefined();
    expect(b.results[0].concurrency).toBeUndefined();
  });

  it('honours a leader-authored cap > 1 instead of assuming 1', async () => {
    // THE false-positive guard. Under `maxConcurrentClaims: 2` a member holding one item is
    // legitimately free, and warning it here would be the mirror of the bug this item fixed.
    store.maxConcurrentClaims = 2;
    store.held = [{ id: 'WI-HELD' }];
    const b = await body({ id: 'WI-SECOND' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-SECOND' });
    expect(b.results[0].concurrencyWarning).toBeUndefined();
    // And the resolved cap must actually reach the reader — not be silently defaulted en route.
    expect(readClaimConcurrencySpy).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentClaims: 2 }),
    );
  });

  it('degrades to a normal successful claim when the concurrency read throws', async () => {
    // Fail-soft on purpose: this is a signal, not a floor, so a PG blip must cost the WARNING
    // and never the claim. An advisory that fires spuriously during an outage is worse than
    // silence, and unlike WI-6737's checkpoint case this warning asserts nothing when absent.
    store.readThrows = true;
    const b = await body({ id: 'WI-PGDOWN' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-PGDOWN' });
    expect(b.results[0].error).toBeUndefined();
    expect(b.results[0].concurrencyWarning).toBeUndefined();
  });

  it('degrades the same way when the SPEC read throws, rather than defaulting the cap to 1', async () => {
    // The subtle half of fail-soft: falling back to "cap = 1" on an unreadable spec would
    // fabricate a verdict for a lane whose real cap is unknown, and warn a member that is fine.
    store.specThrows = true;
    store.held = [{ id: 'WI-HELD' }];
    const b = await body({ id: 'WI-SPECDOWN' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-SPECDOWN' });
    expect(b.results[0].concurrencyWarning).toBeUndefined();
  });

  it('re-evaluates PER ITEM across a batch, so a swath warns from the item that crosses the cap', async () => {
    // runBulk is sequential (a `for` loop awaiting each op), so the Nth item's PRE-claim read
    // genuinely sees the N-1 already taken. This is the drain-leader shape — `{ ids:[…] }` under
    // a cap of 1 — and it is exactly the accumulation the old silence hid.
    claimM.mockImplementation(async (id: string) => {
      store.held = [...store.held, { id }];
      return { id, harness: 'papercup', assignee: 'me' } as never;
    });
    const b = await body({ ids: ['WI-A', 'WI-B', 'WI-C'] });
    expect(b.counts).toMatchObject({ ok: 3, failed: 0 });
    // First one is within capacity — silent.
    expect(b.results[0].concurrencyWarning).toBeUndefined();
    // Second and third crossed it — each says so, naming what was already held.
    expect(b.results[1].concurrencyWarning).toContain('WI-A');
    expect(b.results[2].concurrencyWarning).toContain('WI-B');
    // …and none of them was refused. The whole point of by-id-ungated.
    expect(b.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it('resolves the verdict BEFORE the claim writes the column it counts', async () => {
    // The race this pins, found by the batch test below rather than by reading the code: the
    // verdict is `getActiveClaimsForBee` over `taken_by`, and the claim WRITES `taken_by`. If
    // the read is merely STARTED before the claim and awaited afterwards, a claim that commits
    // first makes the read return the row it just wrote — so an ordinary first claim reports
    // itself as "1/1, already at cap". A false positive on EVERY claim, which would have made
    // the warning worthless and trained agents to ignore it.
    const order: string[] = [];
    readClaimConcurrencySpy.mockImplementation(() => order.push('read'));
    claimM.mockImplementation(async (id: string) => {
      order.push('claim');
      return { id, harness: 'papercup', assignee: 'me' } as never;
    });
    await body({ id: 'WI-ORDER' });
    expect(order).toEqual(['read', 'claim']);
  });

  it('reads the concurrency of the ASSIGNEE, not of the dispatching leader', async () => {
    // A leader assigning work to a member must be told about the MEMBER's capacity; reading its
    // own would make the warning meaningless on precisely the dispatch path that can create the
    // over-cap state in the first place.
    store.held = [{ id: 'WI-HELD' }];
    const b = await body({ id: 'WI-DISPATCH', assignee: 'member-7' });
    expect(b.results[0]).toMatchObject({ ok: true });
    expect(readClaimConcurrencySpy).toHaveBeenCalledWith(
      expect.objectContaining({ cupId: 'member-7' }),
    );
    expect(getClaimSpecRecordSpy).toHaveBeenCalledWith(expect.objectContaining({ cupId: 'member-7' }));
  });

  it('addresses an over-cap dispatch warning to the named assignee, not the dispatching leader', async () => {
    store.held = [{ id: 'WI-HELD' }];
    const b = await body({ id: 'WI-DISPATCH-WARNING', assignee: 'member-7' });
    const result = b.results[0];

    expect(result.concurrencyWarning).toMatch(/member-7 WAS ALREADY AT THEIR CONCURRENCY CAP/i);
    expect(result.concurrencyWarning).toContain('scheduler:get_next WILL now refuse to serve member-7');
    expect(result.concurrencyWarning).toContain("scheduler:get_claim_spec { cupId: 'member-7' }");
    expect(result.concurrencyWarning).toContain(
      "scheduler:set_claim_spec { cupId: 'member-7', spec: { ...current.spec, " +
        'limits: { ...current.spec.limits, maxConcurrentClaims: N } } }',
    );
    expect(result.concurrencyWarning).not.toMatch(/\bYOU WERE ALREADY AT YOUR CONCURRENCY CAP\b/i);
    expect(result.concurrency).toMatchObject({
      activeClaims: 1,
      maxConcurrentClaims: 1,
      heldIds: ['WI-HELD'],
      subject: 'member-7',
    });
  });
});
