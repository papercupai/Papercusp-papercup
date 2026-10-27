/** Tests for fleet:capacity's pure report builder (queen-capacity-aware-dispatch-2026-06-22 P-003). */
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { buildCapacityReport } from './capacity';
import { DEFAULT_CAPACITY_DISPATCH_CONFIG as CAPACITY_CONFIG } from '../../fleet/capacity-dispatch';
import type { GatewayHeadroom } from '../../inference-gateway/observability';
import type { AccountStatusRow } from '../../deployment/account-pool-store';
import type { AccountSessionOverride } from '../../deployment/account-session-override';
import type { FleetMembership } from '../coordination/identity';

type MockRosterEntry = {
  agentId: string;
  model: string | null;
  alive: boolean;
  fleetRole: string;
  sessionState: 'live' | 'parked' | 'draining' | 'suspect' | 'ended' | 'recorded' | null;
};

type MockRosterResult = {
  entries: MockRosterEntry[];
  degradedLegs: string[];
};

const { mockAccountStatus, mockGetAccountOverride } = vi.hoisted(() => ({
  mockAccountStatus: vi.fn(),
  mockGetAccountOverride: vi.fn(
    async (): Promise<AccountSessionOverride> => ({ forcedAccounts: [], excludeAccounts: [] }),
  ),
}));
const {
  mockResolveAgentIdentity,
  mockResolvePresenceFleet,
  mockListFleetRosterDiagnosed,
  mockAdvSessionsByCoordOwner,
} = vi.hoisted(() => ({
  mockResolveAgentIdentity: vi.fn(() => ({ ownerId: 'caller', workspaceId: 'test-ws' })),
  mockResolvePresenceFleet: vi.fn<() => Promise<FleetMembership>>(async () => ({
    fleetSlug: null,
    fleetRole: null,
  })),
  mockListFleetRosterDiagnosed: vi.fn<() => Promise<MockRosterResult>>(async () => ({
    entries: [],
    degradedLegs: [],
  })),
  mockAdvSessionsByCoordOwner: vi.fn(async () => new Map()),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'test-ws' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: mockResolveAgentIdentity,
  deriveFleetMembership: () => ({ fleetSlug: null, fleetRole: null }),
}));
vi.mock('../coordination/presence-fleet', () => ({ resolvePresenceFleet: mockResolvePresenceFleet }));
vi.mock('../../fleet/fleet-roster', () => ({ listFleetRosterDiagnosed: mockListFleetRosterDiagnosed }));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  advSessionsByCoordOwner: mockAdvSessionsByCoordOwner,
}));
vi.mock('../../deployment/account-session-override', async (importOriginal) => {
  // Keep the REAL applyAccountOverride (a pure filter — worth exercising for real, not a
  // stand-in) and mock only getAccountOverride (the DB-backed read), default no-op so the
  // pre-existing readBeeProviderAvailability tests below are unaffected.
  const actual = await importOriginal<typeof import('../../deployment/account-session-override')>();
  return { ...actual, getAccountOverride: mockGetAccountOverride };
});
vi.mock('../../deployment/account-pool-store', async (importOriginal) => {
  // Same split as account-session-override above: keep the REAL poolVerdictByProvider (a pure
  // rows -> per-provider rollup) and mock only accountStatus (the DB-backed read). capacity.ts's
  // poolVerdictFor dynamically imports this module, so a whole-module stub left the export
  // undefined and every test reaching it died on "No 'poolVerdictByProvider' export is defined".
  // A `() => []` stand-in would be worse than the crash: poolVerdictFor returns null for an empty
  // rollup, and per its own contract a null pool reads as an UNMEASURED leg — so the tests that
  // assert a MEASURED pool snapshot would have gone quietly vacuous instead of failing.
  const actual = await importOriginal<typeof import('../../deployment/account-pool-store')>();
  return { ...actual, accountStatus: mockAccountStatus };
});
// Keep the end-to-end handler test hermetic (no live DB): the flag read is best-effort
// (handler already `.catch(() => false)`s a failure), so a fixed resolved value is fine.
vi.mock('@papercusp/flags', () => ({ FLAGS: { MUG_CAPACITY_DISPATCH: 'MUG_CAPACITY_DISPATCH' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));

const tieredHr = (over: Partial<GatewayHeadroom> = {}): GatewayHeadroom => ({
  reachable: true,
  utilization: 0.1,
  utilizationPct: 10,
  paused: false,
  rejected: false,
  inFlight: 2,
  queueDepth: 0,
  priorityTiers: {
    healthyAccounts: 8,
    tier1Reserve: 4,
    tiers: [
      { tier: 1, minShare: 24, inFlight: 1, queued: 0 },
      { tier: 2, minShare: 20, inFlight: 1, queued: 0 },
      { tier: 3, minShare: 20, inFlight: 6, queued: 3 }, // bee tier
      { tier: 4, minShare: 8, inFlight: 0, queued: 0 },
    ],
  },
  ...over,
});

test('unreachable gateway ⇒ fail-safe no-clamp report (place at the normal ceiling)', () => {
  const r = buildCapacityReport({ reachable: false }, { clampArmed: true, headroom: 20 });
  assert.equal(r.reachable, false);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 20, 'proposed headroom passes through unclamped');
  assert.equal(r.dispatchBudget, null);
  assert.match(r.advice, /fail-safe/);
});

test('abundant pool ⇒ dispatchBudget from the bee tier, factor 1, broad advice', () => {
  const r = buildCapacityReport(tieredHr(), { clampArmed: true });
  assert.equal(r.reachable, true);
  assert.equal(r.tierLayer, true);
  assert.equal(r.beeTier, 3, 'bee maps to tier 3 by default');
  assert.equal(r.dispatchBudget, 11, 'bee-tier spare = cap 20 − inFlight 6 − queued 3 = 11');
  assert.equal(r.healthyAccounts, 8);
  assert.equal(r.tier1Reserve, 4);
  assert.equal(r.factor, 1);
  assert.match(r.advice, /abundant/);
});

test('proposed headroom is clamped to spare capacity under load', () => {
  // queueDepth 12 of softCap 24 → factor 0.5 → 20 → ~10
  const r = buildCapacityReport(tieredHr({ queueDepth: 12 }), { clampArmed: true, headroom: 20 });
  assert.ok(r.factor > 0.49 && r.factor < 0.51, `factor ~0.5, got ${r.factor}`);
  assert.equal(r.recommendedHeadroom, 10);
  assert.equal(r.throttled, true);
});

test('GENUINELY saturated pool (paused + NO tiered spare capacity) ⇒ factor 0 + "place only tier-1" advice', () => {
  // The pool is paused AND has no healthy accounts / no bee-tier spare slots — a
  // real saturation, distinct from the bound-account-only false-saturation the
  // adjacent `rejected … broad placement` test guards (capacity-oracle-false-
  // saturation-2026-06-29). Here there IS no fresh capacity, so factor must floor to 0.
  const r = buildCapacityReport(
    tieredHr({
      paused: true,
      utilization: 1,
      priorityTiers: {
        healthyAccounts: 0, // no healthy account → pool truly has no fresh capacity
        tier1Reserve: 0,
        tiers: [
          { tier: 1, minShare: 24, inFlight: 24, queued: 0 },
          { tier: 2, minShare: 20, inFlight: 20, queued: 0 },
          { tier: 3, minShare: 20, inFlight: 20, queued: 0 }, // bee tier full → no spare
          { tier: 4, minShare: 8, inFlight: 8, queued: 0 },
        ],
      },
    }),
    { clampArmed: true, headroom: 20 },
  );
  assert.equal(r.factor, 0);
  assert.equal(r.paused, true);
  assert.match(r.advice, /SATURATED/);
});

test('rejected bound account with healthy tiered bee capacity ⇒ broad placement advice', () => {
  const r = buildCapacityReport(
    tieredHr({
      utilization: 1,
      utilizationPct: 100,
      rejected: true,
      queueDepth: 0,
      priorityTiers: {
        healthyAccounts: 2,
        tier1Reserve: 1,
        tiers: [
          { tier: 1, minShare: 24, inFlight: 0, queued: 0 },
          { tier: 2, minShare: 20, inFlight: 0, queued: 0 },
          { tier: 3, minShare: 19, inFlight: 0, queued: 0 },
          { tier: 4, minShare: 1, inFlight: 0, queued: 0 },
        ],
      },
    }),
    { clampArmed: true, headroom: 13 },
  );
  assert.equal(r.rejected, true);
  assert.equal(r.dispatchBudget, 19);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 13);
  assert.equal(r.throttled, false);
  assert.match(r.advice, /abundant/);
});

test('tier layer OFF (no priorityTiers) ⇒ dispatchBudget null, still reports saturation', () => {
  const r = buildCapacityReport({ reachable: true, utilization: 0.1, queueDepth: 0, inFlight: 1 }, { clampArmed: false });
  assert.equal(r.tierLayer, false);
  assert.equal(r.dispatchBudget, null);
  assert.equal(r.capByTier, null);
  assert.equal(r.factor, 1);
  assert.equal(r.clampArmed, false);
});

test('no headroom arg ⇒ recommendedHeadroom null (report only)', () => {
  const r = buildCapacityReport(tieredHr(), { clampArmed: true });
  assert.equal(r.recommendedHeadroom, null);
  assert.equal(r.throttled, null);
});

test('EI-19919108197415103: an active override fencing every account is reported as session-override exhaustion', () => {
  const activeSessionOverride = { forcedAccounts: [], excludeAccounts: ['acct-a', 'acct-b'] };
  const r = buildCapacityReport(tieredHr(), {
    clampArmed: true,
    headroom: 20,
    accountAvailability: {
      provider: 'claude',
      total: 2,
      available: 0,
      usable: 0,
      overrideExcludedCount: 2,
      sessionOverride: activeSessionOverride,
    },
  });

  assert.equal(r.poolExhausted, true);
  assert.equal(r.exhaustionReason, 'session-override');
  assert.equal(r.factor, 0);
  assert.equal(r.recommendedHeadroom, CAPACITY_CONFIG.minHeadroom);
  assert.equal(r.overrideExcludedAccounts, 2);
  assert.deepEqual(r.activeSessionOverride, activeSessionOverride);
  assert.match(r.advice, /revise or clear the override before spawning/);
});

const acctRow = (id: string, over: Partial<AccountStatusRow> = {}): AccountStatusRow => ({
  id,
  provider: 'claude',
  credentialRef: `token:~/.papercusp/${id}`,
  boundTo: [],
  available: true,
  usageWalled: false,
  sustainedlyLimited: false,
  edgeThrottleKnown: true,
  edgeThrottled: false,
  edgeThrottleCooledIps: 0,
  edgeThrottleBare429Streak: 0,
  rate: { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 },
  liveBuckets: [],
  readingStatus: 'fresh',
  // WI-41147: the burn governor verdict is required on AccountStatusRow. A neutral 'none'
  // (no history in these fixtures) keeps every existing assertion untouched; override via
  // `over` to exercise throttle/shed rows.
  burn: {
    burnRatePerHr: null,
    headroomFraction: null,
    projectedExhaustionAt: null,
    exhaustsBeforeReset: false,
    action: 'none',
    // P-001: `disposition` states what the action rests on. A fixture asserting no action
    // asserts no wall either — 'no-verdict' is the only coherent value here.
    utilization7d: null,
    disposition: 'no-verdict',
    reason: 'test fixture — no burn history',
  },
  ...over,
});

test('EI-19944752041493781: sustainedlyLimitedCount is scoped to the USABLE set — an unavailable ' +
  '(usage-walled) sustainedlyLimited account must NOT count against a DIFFERENT, actually-usable account', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // Reproduces the exact measured incident: 4 claude accounts — one usage-walled AND
  // sustainedlyLimited (unavailable, so NOT usable), two edge-throttled (available but not
  // usable), and one genuinely healthy + usable account that is NOT sustainedlyLimited at all.
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw', { available: false, usageWalled: true, sustainedlyLimited: true, edgeThrottled: true }),
    acctRow('aviynw3', { edgeThrottled: true }),
    acctRow('aviynw10', { edgeThrottled: true }),
    acctRow('avi_storewolf.com', { edgeThrottled: false, sustainedlyLimited: false }),
  ]);
  const acct = await readBeeProviderAvailability();
  assert.ok(acct, 'expected an availability read');
  assert.equal(acct!.usable, 1, 'only avi_storewolf.com is available AND not edge-throttled');
  assert.equal(
    acct!.sustainedlyLimitedCount,
    0,
    'the walled aviynw account (not usable) must not be counted — the one usable account is fine',
  );
});

test('EI-19944752041493781: sustainedlyLimitedCount DOES count a sustainedlyLimited account that IS usable', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('a', { sustainedlyLimited: true }), // available, not edge-throttled ⇒ usable AND sustainedlyLimited
    acctRow('b', { sustainedlyLimited: false }),
  ]);
  const acct = await readBeeProviderAvailability();
  assert.ok(acct);
  assert.equal(acct!.usable, 2);
  assert.equal(acct!.sustainedlyLimitedCount, 1, 'exactly the one usable, sustainedlyLimited account counts');
});

test('EI-19932168784507536: an account excluded by the owner session override is NOT counted ' +
  'available/usable, even though raw pool-health says it is healthy', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // Reproduces the measured incident: two pool-healthy accounts, one of which is outside the
  // session-override allow-list (the same override spawn-env.ts's resolveSpawnGatewayEnv
  // enforces at admission) — that one must be excluded from available/usable, or the capacity
  // read stays a false-green for a route that spawn admission will actually refuse.
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw3', {}), // healthy, and allowed
    acctRow('excluded-acct', {}), // healthy, but session-override-excluded
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: ['excluded-acct'] });

  const acct = await readBeeProviderAvailability();
  assert.ok(acct, 'expected an availability read');
  assert.equal(acct!.available, 1, 'the override-excluded account must not count as available');
  assert.equal(acct!.usable, 1, 'the override-excluded account must not count as usable');
  assert.equal(acct!.overrideExcludedCount, 1, 'the report must name how many accounts the override excluded');
});

test('EI-19932168784507536: an account OUTSIDE the session-override ALLOW-LIST (forcedAccounts) is ' +
  'excluded too — the verbatim branch the measured incident actually hit', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // The two sibling tests here pin only the excludeAccounts (deny-list) leg. The MEASURED incident
  // was the OTHER leg: admission refused with "account 'aviynw3' is outside the session override
  // allow-list" — i.e. a non-empty `forcedAccounts` that simply did not list the account. Those are
  // two separate filters in applyAccountOverride (allow-list first, then deny-list), so covering
  // only the deny-list leaves a regression that drops the allow-list filter passing every test
  // while reproducing this item's exact incident. Both rows are pool-HEALTHY on purpose: the whole
  // defect is that raw pool-health says "usable" about a route admission will refuse outright.
  // CALIBRATION FIRST: the exact same two rows, with BOTH allow-listed, must count as 2. Without
  // this the assertions below are not falsifiable — a `1` could come from any unrelated filter (or
  // from the fixture only ever having one healthy row), and the test would keep passing against an
  // implementation that had stopped consulting the allow-list at all.
  mockAccountStatus.mockResolvedValueOnce([acctRow('aviynw3', {}), acctRow('sanctioned-acct', {})]);
  mockGetAccountOverride.mockResolvedValueOnce({
    forcedAccounts: ['aviynw3', 'sanctioned-acct'],
    excludeAccounts: [],
  });
  const calibration = await readBeeProviderAvailability();
  assert.equal(calibration!.available, 2, 'calibration: both rows are healthy AND allow-listed, so both must count');
  assert.equal(calibration!.overrideExcludedCount, 0, 'calibration: nothing is excluded when both are allow-listed');

  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw3', {}), // healthy, but NOT in the allow-list below
    acctRow('sanctioned-acct', {}), // healthy, and the only allow-listed account
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: ['sanctioned-acct'], excludeAccounts: [] });

  const acct = await readBeeProviderAvailability();
  assert.ok(acct, 'expected an availability read');
  assert.equal(acct!.available, 1, 'an account outside the allow-list must not count as available');
  assert.equal(acct!.usable, 1, 'an account outside the allow-list must not count as usable');
  assert.equal(acct!.overrideExcludedCount, 1, 'the allow-list exclusion must be reported, not silently dropped');
});

test('EI-19932168784507536: the full fleet:capacity report surfaces overrideExcludedAccounts ' +
  'end-to-end (capacity and admission must agree about the same pool)', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());
  mockAccountStatus.mockResolvedValueOnce([acctRow('aviynw3', {}), acctRow('excluded-acct', {})]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: ['excluded-acct'] });

  const res = (await capacityMod.default.handler({} as never, { role: 'su' } as never)) as {
    content: { text: string }[];
  };
  const body = JSON.parse(res.content[0]!.text);
  assert.equal(body.ok, true);
  assert.equal(body.availableAccounts, 1, 'admission-excluded account must not inflate availableAccounts');
  assert.equal(body.usableAccounts, 1, 'admission-excluded account must not inflate usableAccounts');
  assert.equal(
    body.overrideExcludedAccounts,
    1,
    'the report must name the excluded account so a caller can tell "no capacity" from "fenced off"',
  );
  headroomSpy.mockRestore();
});

test('EI-19995356951235246: availability projects only allowed active reset terms', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  const now = Date.now();
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('allowed', {
      usageWalled: true,
      usageResetAt: now + 90_000,
      edgeThrottled: true,
      edgeThrottleResetAt: now + 60_000,
      rate: { pausedUntil: now + 30_000, penaltyCount: 2, lastPenaltyAt: now, windowStartedAt: now - 1_000 },
    }),
    acctRow('expired', {
      usageWalled: true,
      usageResetAt: now - 1,
      edgeThrottled: true,
      edgeThrottleResetAt: now - 1,
      rate: { pausedUntil: now - 1, penaltyCount: 2, lastPenaltyAt: now - 2, windowStartedAt: now - 1_000 },
    }),
    acctRow('excluded', {
      usageWalled: true,
      usageResetAt: now + 120_000,
      edgeThrottled: true,
      edgeThrottleResetAt: now + 120_000,
      rate: { pausedUntil: now + 120_000, penaltyCount: 2, lastPenaltyAt: now, windowStartedAt: now - 1_000 },
    }),
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: ['excluded'] });

  const acct = await readBeeProviderAvailability();
  assert.ok(acct);
  assert.deepEqual(acct!.accountBindingTerms, [
    {
      id: 'allowed',
      usageResetAt: now + 90_000,
      edgeThrottleResetAt: now + 60_000,
      ratePausedUntil: now + 30_000,
    },
  ]);
});

test('EI-20613616736215896: the CALLER threads egressPool into the shared-egress evidence, so ' +
  'distinct proxies disprove a down-proxy fault instead of manufacturing an owner escalation', async () => {
  const { readBeeProviderAvailability } = await import('./capacity');
  // The measured 2026-08-16 pool: every account is egressPool-routed and the singular `egress` is UNSET.
  // `egressPool` supersedes `egress`, so a caller reading only the singular collapses all of these onto
  // one synthetic identity, which deriveEdgeThrottleEvidence reads as the shared-IP signature — emitting
  // "the egress path itself is broken → an OWNER-GATED infra issue → escalate" for a pool with no fault.
  // This test lives at the CALLER because that is where the defect was: the pure function was always able
  // to tell these apart, it was simply never handed the pool.
  const throttled = { edgeThrottled: true, available: false, edgeThrottleBare429Streak: 9 };
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw', { ...throttled, egressPool: [{ proxyUrl: 'http://199.182.115.224:3128' }, {}] }),
    acctRow('avistorewolf.com', { ...throttled, egressPool: [{ proxyUrl: 'http://209.163.116.244:3128' }, {}] }),
    acctRow('aviynw10', { ...throttled, egressPool: [{ proxyUrl: 'http://216.213.24.64:3128' }, {}] }),
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: [] });
  const distinct = await readBeeProviderAvailability();
  assert.equal(
    distinct!.edgeThrottledSharedEgress,
    false,
    'three DISTINCT egress proxies are the opposite of a down-proxy signature — the owner-gated ' +
      'escalation branch must be unreachable for this pool',
  );

  // POSITIVE CONTROL — without it the assertion above could pass simply because the evidence was never
  // computed at all (undefined !== true reads the same as a correct verdict to a careless assertion).
  // A genuinely shared pool must still produce the shared-IP diagnosis through the same code path.
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('aviynw', { ...throttled, egressPool: [{ proxyUrl: 'http://199.182.115.224:3128' }, {}] }),
    acctRow('aviynw3', { ...throttled, egressPool: [{ proxyUrl: 'http://199.182.115.224:3128' }, {}] }),
  ]);
  mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: [] });
  const shared = await readBeeProviderAvailability();
  assert.equal(
    shared!.edgeThrottledSharedEgress,
    true,
    'control: two accounts on the SAME pool is a real shared-IP fault and must stay diagnosable',
  );
});

test('EI-20183190844096359: Codex capacity ignores stale Claude walls and reports the requested scope', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce({
    provider: 'codex',
    reachable: true,
    priorityTiers: {
      healthyAccounts: 1,
      tier1Reserve: 1,
      tiers: [{ tier: 3, minShare: 4, inFlight: 1, queued: 0 }],
    },
    healthyAccounts: 1,
    inFlight: 1,
    queueDepth: 0,
  });
  mockAccountStatus.mockResolvedValueOnce([
    // The stale Claude rows from the incident must not participate in a Codex read.
    acctRow('claude-walled', { available: false, usageWalled: true, readingStatus: 'stale' }),
    acctRow('chatgpt-sub-cli', { provider: 'codex', available: true, usageWalled: false, readingStatus: 'fresh' }),
  ]);

  const res = (await capacityMod.default.handler(
    { provider: 'codex', model: 'gpt-5.6-luna', headroom: 3 } as never,
    { role: 'su' } as never,
  )) as { content: { text: string }[] };
  const body = JSON.parse(res.content[0]!.text);

  assert.equal(body.ok, true);
  assert.equal(body.verdict, 'unknown');
  assert.deepEqual(body.scope, { provider: 'codex', model: 'gpt-5.6-luna', account: null });
  assert.ok(body.capacityUnknown.some((note: string) => note.includes('gpt-5.6-luna')));
  assert.equal(body.usableAccounts, 1);
  assert.equal(body.poolExhausted, false);
  assert.equal(body.healthyAccounts, 1);
  assert.equal(headroomSpy.mock.calls[0]?.[0]?.provider, 'codex');
  headroomSpy.mockRestore();
});

test('fleet:capacity account-only scope resolves a Codex account instead of defaulting to Claude', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce({
    provider: 'codex',
    reachable: true,
    priorityTiers: {
      healthyAccounts: 1,
      tier1Reserve: 1,
      tiers: [{ tier: 3, minShare: 4, inFlight: 0, queued: 0 }],
    },
  });
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('chatgpt-sub-cli', { provider: 'codex', available: true, readingStatus: 'fresh' }),
  ]);

  const res = (await capacityMod.default.handler({ account: 'chatgpt-sub-cli' } as never, { role: 'su' } as never)) as {
    content: { text: string }[];
  };
  const body = JSON.parse(res.content[0]!.text);
  assert.equal(body.verdict, 'measured');
  assert.equal(body.scope.provider, 'codex');
  assert.equal(body.usableAccounts, 1);
  assert.equal(headroomSpy.mock.calls[0]?.[0]?.provider, 'codex');
  headroomSpy.mockRestore();
});

test('WI-10006088: auto routing preserves the whole pool, blind readings, and account overrides', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValue(tieredHr());
  const bodies: Record<string, any>[] = [];
  try {
    for (const account of [undefined, 'auto']) {
      mockAccountStatus.mockResolvedValueOnce([
        acctRow('healthy', { provider: 'codex' }),
        acctRow('unmeasured', { provider: 'codex', available: false, readingStatus: 'stale' }),
      ]);
      mockGetAccountOverride.mockResolvedValueOnce({ forcedAccounts: [], excludeAccounts: ['healthy'] });
      const res = await capacityMod.default.handler({ provider: 'codex', account, headroom: 3 } as never, {} as never);
      const body = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
      assert.equal(body.verdict, 'blind');
      assert.equal(body.blind, true);
      assert.equal(body.accountPool.total, 2);
      assert.equal(body.usableAccounts, 0);
      assert.equal(body.overrideExcludedAccounts, 1);
      bodies.push(body);
    }
    assert.deepEqual(bodies[0]!.accountPool, bodies[1]!.accountPool);
    assert.equal(bodies[0]!.recommendedHeadroom, bodies[1]!.recommendedHeadroom);
  } finally {
    headroomSpy.mockRestore();
  }
});

test('WI-10006088: auto-only routing inherits the fleet worker backend', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  mockListFleetRosterDiagnosed.mockResolvedValueOnce({
    entries: [{ agentId: 'worker', model: 'gpt-6-luna', alive: true, fleetRole: 'member', sessionState: 'live' }],
    degradedLegs: [],
  });
  mockAdvSessionsByCoordOwner.mockResolvedValueOnce(new Map());
  mockAccountStatus.mockResolvedValueOnce([acctRow('healthy', { provider: 'codex' })]);
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());
  try {
    const res = await capacityMod.default.handler({ fleet: 'codex-fleet', account: 'auto', headroom: 3 } as never, {} as never);
    const body = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
    assert.equal(body.verdict, 'measured');
    assert.equal(body.provider, 'codex');
    assert.equal(body.providerSource, 'fleet');
    assert.equal(body.scope.account, 'auto');
    assert.equal(body.accountPool.total, 1);
    assert.equal(headroomSpy.mock.calls[0]?.[0]?.provider, 'codex');
  } finally {
    headroomSpy.mockRestore();
  }
});

test('WI-10006088: a real account pin still narrows capacity with an explicit model', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('selected', { provider: 'codex' }),
    acctRow('other', { provider: 'codex', available: false, readingStatus: 'stale' }),
  ]);
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());
  try {
    const res = await capacityMod.default.handler({ model: 'gpt-6-luna', account: 'selected', headroom: 3 } as never, {} as never);
    const body = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
    assert.equal(body.verdict, 'unknown');
    assert.equal(body.recommendedHeadroom, null);
    assert.equal(body.accountPool.total, 1);
    assert.equal(body.accountPool.usable, 1);
    assert.equal(body.account, 'selected');
    assert.equal(mockAccountStatus.mock.calls.length > 0, true);
  } finally {
    headroomSpy.mockRestore();
  }
});

test('EI-25562829699329250: pinned canonical verdict excludes the other accounts in both directions', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValue(tieredHr());
  try {
    for (const pinnedWalled of [false, true]) {
      mockAccountStatus.mockResolvedValueOnce([
        acctRow('selected', { available: !pinnedWalled, usageWalled: pinnedWalled }),
        acctRow('other', { available: pinnedWalled, usageWalled: !pinnedWalled }),
      ]);
      const res = await capacityMod.default.handler({ provider: 'claude', account: 'selected' } as never, {} as never);
      const body = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
      assert.equal(body.accountPool.total, 1);
      assert.equal(body.capacityVerdict.atCapacity, pinnedWalled);
      assert.equal(body.capacityVerdict.binding, pinnedWalled ? 'usage-wall' : 'none');
      const signals = new Map(body.capacityVerdict.evidence.map((entry: { signal: string; value: number }) =>
        [entry.signal, entry.value]));
      assert.equal(signals.get('pool.serviceable'), pinnedWalled ? 0 : 1);
      assert.equal(signals.get('pool.walledFresh'), pinnedWalled ? 1 : 0);
      assert.deepEqual(body.capacityUnknown, []);
    }
  } finally {
    headroomSpy.mockRestore();
  }
});

test('EI-25562829699329250: representative-model health cannot establish requested Haiku readiness', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom');
  try {
    for (const representativeHealthyAccounts of [0, 8]) {
      mockAccountStatus.mockResolvedValueOnce([acctRow('selected')]);
      headroomSpy.mockResolvedValueOnce(tieredHr({
        healthyAccounts: representativeHealthyAccounts,
        priorityTiers: { ...tieredHr().priorityTiers!, healthyAccounts: representativeHealthyAccounts },
      }));
      const model = 'claude-haiku-4-5-20251001';
      const res = await capacityMod.default.handler({ provider: 'claude', model, account: 'selected' } as never, {} as never);
      const body = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
      assert.equal(body.verdict, 'unknown');
      assert.equal(body.scope.model, model);
      assert.equal(body.recommendedHeadroom, null);
      assert.ok(body.capacityVerdict.unknown.some((note: string) => note.includes(model) && /unmeasured/i.test(note)));
      assert.deepEqual(body.capacityUnknown, body.capacityVerdict.unknown);
    }
  } finally {
    headroomSpy.mockRestore();
  }
});

test('WI-10006088: unknown and wrong-provider pins do not skip pool checks when a model is supplied', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom');
  try {
    for (const account of ['missing', 'claude-account']) {
      mockAccountStatus.mockResolvedValueOnce([acctRow('claude-account')]);
      const res = await capacityMod.default.handler({ model: 'gpt-6-luna', account, headroom: 3 } as never, {} as never);
      const body = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
      assert.equal(body.verdict, 'unknown');
      assert.match(body.reason, /account/);
    }
    assert.equal(headroomSpy.mock.calls.length, 0);
  } finally {
    headroomSpy.mockRestore();
  }
});

test('EI-21664939388634125: Codex tier oracle measures spare capacity when utilization and account rows are absent', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce({
    provider: 'codex',
    reachable: true,
    // Codex has no Claude-style unified utilization window. The tier oracle is the authoritative
    // admission signal for this route.
    priorityTiers: {
      healthyAccounts: 6,
      tier1Reserve: 1,
      tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 0 }],
    },
    healthyAccounts: 6,
    inFlight: 0,
    queueDepth: 0,
  });
  // ChatGPT-subscription CLI accounts are surfaced by the gateway but may not be represented in the
  // operator account-pool rows used by the optional cross-check.
  mockAccountStatus.mockResolvedValueOnce([]);

  try {
    const res = (await capacityMod.default.handler(
      { provider: 'codex', headroom: 3 } as never,
      { role: 'su' } as never,
    )) as { content: { text: string }[] };
    const body = JSON.parse(res.content[0]!.text);

    assert.equal(body.verdict, 'measured');
    assert.equal(body.utilization, null);
    assert.equal(body.healthyAccounts, 6);
    assert.equal(body.dispatchBudget, 20);
    assert.equal(body.recommendedHeadroom, 3);
    assert.equal(body.accountPool, null);
  } finally {
    headroomSpy.mockRestore();
  }
});

test('EI-21664939388634125: incomplete or unusable Codex tier data remains unknown without account rows', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const readings = [
    // No tier layer: top-level health alone cannot establish bee-tier capacity.
    {
      provider: 'codex' as const,
      reachable: true,
      healthyAccounts: 6,
      inFlight: 0,
      queueDepth: 0,
    },
    // The tier layer is present, but the bee tier is absent, so its budget is unmeasured.
    {
      provider: 'codex' as const,
      reachable: true,
      priorityTiers: {
        healthyAccounts: 6,
        tier1Reserve: 1,
        tiers: [{ tier: 1, minShare: 20, inFlight: 0, queued: 0 }],
      },
      healthyAccounts: 6,
      inFlight: 0,
      queueDepth: 0,
    },
    // A spare queue slot with no healthy account is contradictory for fresh admission and must not
    // be promoted to a measured refill allowance.
    {
      provider: 'codex' as const,
      reachable: true,
      priorityTiers: {
        healthyAccounts: 0,
        tier1Reserve: 1,
        tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 0 }],
      },
      healthyAccounts: 0,
      inFlight: 0,
      queueDepth: 0,
    },
  ];
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom');
  mockAccountStatus.mockResolvedValue([]);

  try {
    for (const reading of readings) {
      headroomSpy.mockResolvedValueOnce(reading);
      const res = (await capacityMod.default.handler(
        { provider: 'codex', headroom: 3 } as never,
        { role: 'su' } as never,
      )) as { content: { text: string }[] };
      const body = JSON.parse(res.content[0]!.text);
      assert.equal(body.verdict, 'unknown');
    }
  } finally {
    headroomSpy.mockRestore();
  }
});

test('EI-21268415877542410: capacity reports one honest account-pool snapshot, not fake store divergence', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('healthy'),
    acctRow('edge-throttled', { edgeThrottled: true }),
    acctRow('usage-walled', { available: false, usageWalled: true }),
  ]);

  const res = (await capacityMod.default.handler({} as never, { role: 'su' } as never)) as {
    content: { text: string }[];
  };
  const body = JSON.parse(res.content[0]!.text);

  assert.equal(body.usableAccounts, 1);
  assert.equal(body.availableAccounts, 2);
  assert.deepEqual(body.accountPool, {
    provider: 'claude',
    total: 3,
    available: 2,
    usable: 1,
    edgeThrottledAccounts: 1,
    usageWalledAccounts: 1,
    sustainedlyLimitedAccounts: 0,
    overrideExcludedAccounts: 0,
    blindAccounts: 0,
  });
  assert.equal(body.divergence, undefined, 'usable and available are both account-pool fields, not stores to reconcile');
  headroomSpy.mockRestore();
});

test('WI-6554700010029550: capacity names each codex account subscription tier, unread accounts as null', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());
  const observedAt = Date.parse('2026-10-26T17:00:00.000Z');
  const rate = { pausedUntil: 0, penaltyCount: 0, lastPenaltyAt: 0, windowStartedAt: 0 };
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('pro-acct', { provider: 'codex', rate: { ...rate, planType: 'pro', planObservedAt: observedAt } }),
    acctRow('plus-acct', {
      provider: 'codex',
      available: false,
      usageWalled: true,
      rate: { ...rate, planType: 'plus', planObservedAt: observedAt },
    }),
    acctRow('unread-acct', { provider: 'codex' }),
    // A different provider's row must not leak into the codex reading.
    acctRow('claude-acct', { rate: { ...rate, planType: 'max', planObservedAt: observedAt } }),
  ]);
  try {
    const res = (await capacityMod.default.handler({ provider: 'codex' } as never, { role: 'su' } as never)) as {
      content: { text: string }[];
    };
    const body = JSON.parse(res.content[0]!.text);
    assert.deepEqual(body.accountPool.plans, [
      { id: 'pro-acct', planType: 'pro', observedAt: '2026-10-26T17:00:00.000Z' },
      { id: 'plus-acct', planType: 'plus', observedAt: '2026-10-26T17:00:00.000Z' },
      { id: 'unread-acct', planType: null, observedAt: null },
    ]);
  } finally {
    headroomSpy.mockRestore();
  }
});

test('WI-41067: an implicit live fleet scope selects its worker provider instead of legacy Claude', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  mockResolvePresenceFleet.mockResolvedValueOnce({ fleetSlug: 'codex-fleet', fleetRole: 'leader' });
  mockListFleetRosterDiagnosed.mockResolvedValueOnce({
    entries: [
      { agentId: 'leader', model: null, alive: true, fleetRole: 'leader', sessionState: 'live' },
      { agentId: 'worker', model: null, alive: true, fleetRole: 'member', sessionState: 'live' },
    ],
    degradedLegs: [],
  });
  mockAdvSessionsByCoordOwner.mockResolvedValueOnce(new Map([['worker', { agent: 'codex' }]]));
  mockAccountStatus.mockResolvedValueOnce([
    acctRow('chatgpt-sub-cli', { provider: 'codex', readingStatus: 'fresh' }),
  ]);
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValueOnce(tieredHr());

  try {
    const res = (await capacityMod.default.handler({ headroom: 2 } as never, {} as never)) as {
      content: { text: string }[];
    };
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.provider, 'codex');
    assert.equal(body.providerSource, 'fleet');
    assert.equal(body.fleet, 'codex-fleet');
    assert.equal(body.scope.fleet, 'codex-fleet');
    assert.equal(headroomSpy.mock.calls[0]?.[0]?.provider, 'codex');
  } finally {
    headroomSpy.mockRestore();
  }
});

test('WI-41067: mixed live fleet providers return per-provider readings without a guessed aggregate', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  mockResolvePresenceFleet.mockResolvedValueOnce({ fleetSlug: 'mixed-fleet', fleetRole: 'leader' });
  mockListFleetRosterDiagnosed.mockResolvedValueOnce({
    entries: [
      { agentId: 'codex-worker', model: 'gpt-5.6-luna', alive: true, fleetRole: 'member', sessionState: 'live' },
      { agentId: 'claude-worker', model: 'claude-sonnet-4-5', alive: true, fleetRole: 'member', sessionState: 'live' },
    ],
    degradedLegs: [],
  });
  mockAdvSessionsByCoordOwner.mockResolvedValueOnce(new Map());
  mockAccountStatus.mockResolvedValue([
    acctRow('codex-account', { provider: 'codex', readingStatus: 'fresh' }),
    acctRow('claude-account', { provider: 'claude', readingStatus: 'fresh' }),
  ]);
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom').mockResolvedValue(tieredHr());

  try {
    const res = (await capacityMod.default.handler({ headroom: 2 } as never, {} as never)) as {
      content: { text: string }[];
    };
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.verdict, 'unknown');
    assert.equal(body.provider, null);
    assert.equal(body.providerSource, 'fleet');
    assert.deepEqual(body.providers, ['claude', 'codex']);
    assert.deepEqual(
      body.providerReadings.map((reading: { provider: string }) => reading.provider),
      ['claude', 'codex'],
    );
    assert.equal(headroomSpy.mock.calls.length, 2);
  } finally {
    headroomSpy.mockRestore();
    mockAccountStatus.mockReset();
  }
});

test('WI-41067: a fleet with no measured provider is unknown and never falls back to Claude', async () => {
  const capacityMod = await import('./capacity');
  const observability = await import('../../inference-gateway/observability');
  mockResolvePresenceFleet.mockResolvedValueOnce({ fleetSlug: 'unmeasured-fleet', fleetRole: 'leader' });
  mockListFleetRosterDiagnosed.mockResolvedValueOnce({ entries: [], degradedLegs: [] });
  mockAdvSessionsByCoordOwner.mockResolvedValueOnce(new Map());
  const headroomSpy = vi.spyOn(observability, 'fetchGatewayHeadroom');

  try {
    const res = (await capacityMod.default.handler({} as never, {} as never)) as {
      content: { text: string }[];
    };
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.verdict, 'unknown');
    assert.equal(body.provider, null);
    assert.equal(body.providerSource, 'fleet');
    assert.equal(body.fleet, 'unmeasured-fleet');
    assert.equal(headroomSpy.mock.calls.length, 0, 'do not read an arbitrary legacy provider');
  } finally {
    headroomSpy.mockRestore();
  }
});
