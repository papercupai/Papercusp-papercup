/** Tests for the Queen capacity-aware dispatch (gateway-priority-tiers-2026-06-22 Phase 4, MUG_CAPACITY_DISPATCH). */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeCapacityHeadroom,
  capacityFactor,
  resolveCapacityConfig,
  queenCapacityHeadroom,
  DEFAULT_CAPACITY_DISPATCH_CONFIG as CFG,
  buildFleetSizingAdvisory,
  buildCapacityReport,
  deriveEdgeThrottleEvidence,
  deriveCapacityBindingCause,
  egressIdentityOf,
  DEFAULT_SHARED_EGRESS_IDENTITY,
} from './capacity-dispatch';
import { planBatchPlacement } from './batch-placement';
import type { PlacementTask } from './placement-affinity';
import type { GatewayHeadroom } from '../inference-gateway/observability';

test('WI-10007425: a cup minimum share does not cap spare provider admission', () => {
  const headroom: GatewayHeadroom = {
    reachable: true,
    provider: 'codex',
    admissionWindow: 800,
    inFlight: 53,
    queueDepth: 0,
    healthyAccounts: 6,
    priorityTiers: {
      healthyAccounts: 6,
      tier1Reserve: 1,
      tiers: [{ tier: 3, minShare: 1, inFlight: 0, queued: 0 }],
    },
  };
  const report = buildCapacityReport(headroom, { clampArmed: true, headroom: 16 });
  assert.equal(report.dispatchBudget, 747);
  assert.equal(report.recommendedHeadroom, 16);
  // The live admission window is also measured when the optional tier layer is off.
  const withoutTiers = buildCapacityReport({ ...headroom, priorityTiers: undefined }, { clampArmed: true });
  assert.equal(withoutTiers.dispatchBudget, 747);
  assert.equal(withoutTiers.healthyAccounts, 6);
});

test('WI-10007425: live admission occupancy and genuine account exhaustion still bind', () => {
  const headroom: GatewayHeadroom = {
    reachable: true,
    admissionWindow: 8,
    inFlight: 5,
    queueDepth: 2,
    healthyAccounts: 6,
    priorityTiers: {
      healthyAccounts: 6,
      tier1Reserve: 1,
      tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 0 }],
    },
  };
  assert.equal(buildCapacityReport(headroom, { clampArmed: true }).dispatchBudget, 1);
  assert.equal(buildCapacityReport({ ...headroom, queueDepth: 3 }, { clampArmed: true }).dispatchBudget, 0);
  assert.equal(buildCapacityReport({ ...headroom, admissionWindow: 0 }, { clampArmed: true }).dispatchBudget, 0);
  const exhausted = buildCapacityReport(headroom, {
    clampArmed: true,
    accountAvailability: { provider: 'codex', available: 0, usable: 0, total: 6 },
  });
  assert.equal(exhausted.poolExhausted, true);
  assert.equal(exhausted.factor, 0);
});

test('WI-10007425: malformed live admission remains unknown rather than using a tier reservation', () => {
  for (const reading of [
    { admissionWindow: Number.NaN, inFlight: 0, queueDepth: 0 },
    { admissionWindow: -1, inFlight: 0, queueDepth: 0 },
    { admissionWindow: 8, inFlight: undefined, queueDepth: 0 },
  ]) {
    const report = buildCapacityReport({
      reachable: true,
      ...reading,
      priorityTiers: { healthyAccounts: 6, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 1, inFlight: 0, queued: 0 }] },
    }, { clampArmed: true });
    assert.equal(report.dispatchBudget, null);
  }
});

test('capacity-aware dispatch SCENARIO — FEW placed when the pool is saturated, MANY when idle (P-005)', () => {
  // The end-to-end Queen behavior: the SAME importance-ranked frontier dispatches broadly when the pool is
  // idle and is throttled to the floor (top-ranked first, tail deferred) when it is saturated. Composes the
  // real capacity clamp with the real batch placement planner — deterministic, no LLM.
  const frontier: PlacementTask[] = Array.from({ length: 12 }, (_, i) => ({ id: `wi-${i}`, harness: 'h', title: `t${i}` }));
  const rawHeadroom = 12; // the raw spawn ceiling before the capacity clamp

  // ABUNDANT pool → no clamp → place the WHOLE frontier.
  const abundant = computeCapacityHeadroom(rawHeadroom, { reachable: true, utilization: 0.1, queueDepth: 0 });
  assert.equal(abundant.headroom, 12);
  const planHi = planBatchPlacement({ tasks: frontier, bees: [], headroom: abundant.headroom });
  assert.equal(planHi.spawnCount, 12);
  assert.equal(planHi.unplacedCount, 0);

  // SATURATED pool (paused) → clamp to the floor → place only a FEW; defer the rest to the next wake.
  const scarce = computeCapacityHeadroom(rawHeadroom, { reachable: true, utilization: 1, paused: true, queueDepth: 40 });
  assert.equal(scarce.headroom, CFG.minHeadroom); // floor 2
  const planLo = planBatchPlacement({ tasks: frontier, bees: [], headroom: scarce.headroom });
  assert.equal(planLo.spawnCount, CFG.minHeadroom);
  assert.equal(planLo.unplacedCount, frontier.length - CFG.minHeadroom); // 10 deferred to the next wake
  // The frontier is importance-ordered, so the TOP-ranked flow and the LOWEST-priority tail is deferred.
  assert.equal(planLo.decisions[0].disposition, 'spawn', 'highest-priority task placed even under saturation');
  assert.equal(planLo.decisions[frontier.length - 1].disposition, 'unplaced', 'lowest-priority task deferred under saturation');
});

test('capacityFactor — headroom-independent; matches computeCapacityHeadroom.factor', () => {
  // unreachable ⇒ 1 (fail-safe)
  assert.equal(capacityFactor({ reachable: false }), 1);
  // idle ⇒ 1
  assert.equal(capacityFactor({ reachable: true, utilization: 0.1, queueDepth: 0 }), 1);
  // paused/rejected ⇒ 0 (no fresh capacity)
  assert.equal(capacityFactor({ reachable: true, paused: true }), 0);
  assert.equal(capacityFactor({ reachable: true, rejected: true }), 0);
  // identical to the factor computeCapacityHeadroom derives, for any raw headroom
  const sig = { reachable: true, utilization: 0.925, queueDepth: 6 };
  assert.equal(capacityFactor(sig), computeCapacityHeadroom(5, sig).factor);
  assert.equal(capacityFactor(sig), computeCapacityHeadroom(999, sig).factor);
});

test('fail-safe — gateway unreachable ⇒ NO clamp (never strand the fleet on a missing signal)', () => {
  const d = computeCapacityHeadroom(20, { reachable: false });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
  assert.equal(d.factor, 1);
});

test('idle pool — low utilization + empty queue ⇒ no clamp', () => {
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0.1, queueDepth: 0 });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
});

test('high budget utilization throttles the fresh-spawn headroom (linear from utilizationHigh→cap)', () => {
  // util 0.925 = halfway between utilizationHigh (0.85) and cap (1.0) → budgetLeg ~0.5 → 20*0.5 ≈ 10
  // (floor of a float-just-under-0.5 → 9 or 10; the clamp is a soft throttle, exactness doesn't matter).
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0.925, queueDepth: 0 });
  assert.equal(d.throttled, true);
  assert.ok(d.factor > 0.49 && d.factor < 0.51, `~half budget factor, got ${d.factor}`);
  assert.ok(Math.abs(d.headroom - 10) <= 1, `~half headroom, got ${d.headroom}`);
});

test('deep queue throttles (backlog ⇒ the pool cannot drain — do not add more bee load)', () => {
  // queueDepth 12 of queueSoftCap 24 → queueLeg 0.5 → 20*0.5 = 10
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0, queueDepth: 12 });
  assert.equal(d.throttled, true);
  assert.equal(d.headroom, 10);
});

test('factor = min(budgetLeg, queueLeg) — the more-constraining leg wins', () => {
  // util 0.925 → budgetLeg ~0.5; queue 6/24 → queueLeg 0.75 → min ~0.5 → ~10
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 0.925, queueDepth: 6 });
  assert.ok(d.factor > 0.49 && d.factor < 0.51, `min leg is the ~0.5 budget leg, got ${d.factor}`);
  assert.ok(Math.abs(d.headroom - 10) <= 1, `~half headroom, got ${d.headroom}`);
});

test('paused pool ⇒ throttle to the floor (still let high-priority work flow)', () => {
  const d = computeCapacityHeadroom(20, { reachable: true, utilization: 1, paused: true, queueDepth: 50 });
  assert.equal(d.factor, 0);
  assert.equal(d.headroom, CFG.minHeadroom); // floor 2
  assert.equal(d.throttled, true);
});

test('rejected (hard budget reject) ⇒ throttle to the floor', () => {
  const d = computeCapacityHeadroom(20, { reachable: true, rejected: true });
  assert.equal(d.headroom, CFG.minHeadroom);
});

test('tiered spare bee capacity overrides a rejected bound account window', () => {
  // The live failure: /stats.unified was for one exhausted bound account
  // (rejected=true, util=100%, reset in days) while priorityTiers still reported
  // healthy accounts and many spare bee-tier slots. Queen dispatch must trust the
  // pool-level tier oracle, not throttle the whole hive to the floor.
  const d = computeCapacityHeadroom(13, {
    reachable: true,
    utilization: 1,
    rejected: true,
    queueDepth: 0,
    healthyAccounts: 2,
    dispatchBudget: 19,
  });
  assert.equal(d.factor, 1);
  assert.equal(d.headroom, 13);
  assert.equal(d.throttled, false);
});

test('tiered spare bee capacity overrides a PAUSED+rejected (weekly-capped) bound account', () => {
  // capacity-oracle-false-saturation-2026-06-29: a weekly-capped account reports BOTH paused:true
  // AND rejected:true on /stats. The original escape hatch required paused!==true, so this re-armed
  // the false-saturation gate (util 100%, resetIn ~16.5h) and stalled the WHOLE autonomous loop —
  // 0 Queen/bee spawns — even though the tier oracle reported 6 healthy accounts + 20 spare bee slots.
  const signal = {
    reachable: true,
    utilization: 1,
    paused: true,
    rejected: true,
    queueDepth: 0,
    healthyAccounts: 6,
    dispatchBudget: 20,
  };
  assert.ok(capacityFactor(signal) > 0, 'pool with healthy accounts + spare slots is NOT saturated');
  const d = computeCapacityHeadroom(13, signal);
  assert.equal(d.factor, 1);
  assert.equal(d.headroom, 13);
  assert.equal(d.throttled, false);
});

test('a GENUINELY all-paused pool (no healthy accounts) still throttles to the floor', () => {
  // No-regression: the escape hatch fires ONLY when the tier oracle shows real spare capacity.
  // With 0 healthy accounts / 0 dispatchBudget a paused+rejected pool is genuinely saturated.
  const d = computeCapacityHeadroom(13, {
    reachable: true, paused: true, rejected: true, healthyAccounts: 0, dispatchBudget: 0,
  });
  assert.equal(d.headroom, CFG.minHeadroom, 'genuinely saturated → floor');
  assert.equal(capacityFactor({ reachable: true, paused: true, healthyAccounts: 0, dispatchBudget: 0 }), 0);
});

test('fresh gateway restart avoids treating startup zero-capacity snapshot as sustained exhaustion', () => {
  const signal = {
    reachable: true,
    paused: true,
    rejected: true,
    utilization: 1,
    queueDepth: 0,
    healthyAccounts: 0,
    dispatchBudget: 0,
    processUptimeMs: 5_000,
  };
  assert.equal(capacityFactor(signal), 1);
  const d = computeCapacityHeadroom(13, signal);
  assert.equal(d.factor, 1);
  assert.equal(d.headroom, 13);
  assert.equal(d.throttled, false);
  assert.match(d.reason, /capacity-recovering/);
});

test('expired gateway restart grace still treats no-capacity paused pool as saturated', () => {
  const signal = {
    reachable: true,
    paused: true,
    rejected: true,
    utilization: 1,
    healthyAccounts: 0,
    dispatchBudget: 0,
    processUptimeMs: 45_000,
  };
  assert.equal(capacityFactor(signal), 0);
  const d = computeCapacityHeadroom(13, signal);
  assert.equal(d.headroom, CFG.minHeadroom);
  assert.equal(d.throttled, true);
});

test('capacity report labels fresh gateway zero-capacity snapshot as recovering advice', () => {
  const r = buildCapacityReport(
    {
      reachable: true,
      paused: true,
      rejected: true,
      utilization: 1,
      utilizationPct: 100,
      queueDepth: 0,
      processUptimeMs: 4_000,
      priorityTiers: {
        healthyAccounts: 0,
        tier1Reserve: 0,
        tiers: [{ tier: 3, minShare: 20, inFlight: 20, queued: 0 }],
      },
    },
    { clampArmed: true, headroom: 13 },
  );
  assert.equal(r.restartRecovering, true);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 13);
  assert.equal(r.throttled, false);
  assert.match(r.advice, /startup capacity snapshot is recovering/);
});

test('EI-22510899908612251 — healthy-pool advice names the launch clamp when dispatchBudget is the tighter limit', () => {
  // The live contradiction: pool health is abundant (factor 1), but the same
  // fleet:capacity payload reports only one guaranteed bee-tier slot. The launch
  // path uses dispatchBudget as its hard concurrent-new-member cap, so the advice
  // must make that limit legible without requiring a second capacity read.
  const r = buildCapacityReport(
    {
      reachable: true,
      utilization: 0.77,
      utilizationPct: 77,
      paused: false,
      rejected: false,
      queueDepth: 0,
      inFlight: 2,
      priorityTiers: {
        healthyAccounts: 3,
        tier1Reserve: 384,
        tiers: [{ tier: 3, minShare: 3, inFlight: 2, queued: 0 }],
      },
    },
    { clampArmed: true },
  );

  assert.equal(r.factor, 1);
  assert.equal(r.dispatchBudget, 1);
  assert.match(r.advice, /abundant/);
  assert.match(r.advice, /launch clamp caps new members at 1 per wave/);
  assert.match(r.advice, /dispatchBudget=1/);
  assert.notEqual(r.advice, 'abundant → place broadly up to your ceiling');
});

test('EI-12282 — gateway reports spare bee slots but the REAL account pool is exhausted ⇒ poolExhausted, factor 0, loud hold', () => {
  // The live false-green: /stats.priorityTiers said healthyAccounts>0 with ~13 spare bee-tier slots
  // (dispatchBudget 13), so the old report read "tightening (factor 0.92) → trim low-priority; ~13 bee
  // slots free" — place broadly. But accounts:status showed 6/7 claude accounts usage-walled and the 7th
  // edge-throttled, so a caller spawning against that signal watched its cups die on their first call.
  // Cross-checking dispatchBudget against real per-account availability must flip the read to a loud HOLD.
  const hr = {
    reachable: true,
    utilization: 0.97,
    utilizationPct: 97,
    paused: true,
    queueDepth: 2,
    inFlight: 1,
    priorityTiers: {
      healthyAccounts: 7, // gateway's split-brain-stale count (disagrees with the store)
      tier1Reserve: 2,
      tiers: [{ tier: 3, minShare: 16, inFlight: 1, queued: 2 }], // dispatchBudget = 16-1-2 = 13
    },
  };
  const accountAvailability = { provider: 'claude', total: 7, available: 1, usable: 0 };

  // Without the cross-check the report is the false-green (regression baseline).
  const green = buildCapacityReport(hr, { clampArmed: true, headroom: 13 });
  assert.equal(green.dispatchBudget, 13);
  assert.equal(green.poolExhausted, false);
  assert.ok(green.factor > 0.5, `false-green factor ~0.92, got ${green.factor}`);
  assert.doesNotMatch(green.advice, /EXHAUSTED/);

  // WITH the cross-check the false-green is corrected to a loud, honest HOLD.
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 13, accountAvailability });
  assert.equal(r.poolExhausted, true, 'zero usable accounts + spare gateway slots ⇒ exhausted');
  assert.equal(r.factor, 0, 'no real capacity → factor forced to 0');
  assert.equal(r.usableAccounts, 0);
  assert.equal(r.availableAccounts, 1);
  assert.equal(r.dispatchBudget, 13, 'the raw gateway figure is still surfaced (for diagnosis)');
  assert.equal(r.recommendedHeadroom, CFG.minHeadroom, 'clamped to the floor, not the queue-slot count');
  assert.equal(r.throttled, true);
  assert.match(r.advice, /EXHAUSTED/);
  assert.match(r.advice, /0\/7 claude accounts are usable/);
  // No edge/usage-wall breakdown supplied on this fixture ⇒ unchanged generic phrasing, no dominant-cause clause.
  assert.doesNotMatch(r.advice, /DOMINANT CAUSE/);
});

test('EI-18664933641195210 — poolExhausted names EGRESS-THROTTLE as the dominant cause (owner-infra, not quota)', () => {
  // The real incident this regression pins: every account looked "walled/rate-paused/edge-throttled" in the
  // generic phrasing, which reads as ordinary quota exhaustion — but the actual cause was three DOWN forward
  // proxies forcing every account onto one already-throttled shared IP. The breakdown must say so loudly.
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 2, usable: 0, edgeThrottledCount: 5, usageWalledCount: 1 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true);
  assert.match(r.advice, /EXHAUSTED/);
  assert.match(r.advice, /DOMINANT CAUSE/);
  assert.match(r.advice, /5\/5 edge-throttled/);
  assert.match(r.advice, /OWNER-GATED/, 'egress-throttle dominant ⇒ points at owner-provisioned infra, not a quota wait');
});

test('EI-18664933641195210 — poolExhausted names USAGE-WALL as the dominant cause (just wait, no infra escalation)', () => {
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 0, usable: 0, edgeThrottledCount: 0, usageWalledCount: 5 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true);
  assert.match(r.advice, /dominant cause: 5\/5 usage-walled/);
  assert.doesNotMatch(r.advice, /OWNER-GATED/, 'usage-wall dominant ⇒ no infra escalation language');
});

test('EI-18683773458136367 — poolExhausted does NOT claim a down/shared egress proxy or instruct escalation when the throttled accounts sit on DISTINCT egress IPs', () => {
  // The real incident this regression pins: `accounts:status` showed edge-throttled accounts on THREE
  // DISTINCT proxy IPs with divergent per-account 429 streaks — the opposite of the shared-IP failure
  // signature the old static advice asserted. That advice manufactured a false owner-gated escalation
  // for a condition that (per this fixture) is proven NOT to be a shared/down egress proxy.
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 4, available: 1, usable: 0,
    edgeThrottledCount: 3, usageWalledCount: 0,
    edgeThrottledSharedEgress: false, // proven distinct — computed from real per-account egress identities
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true);
  assert.match(r.advice, /EXHAUSTED/);
  assert.match(r.advice, /3\/4 edge-throttled/);
  assert.match(r.advice, /DISTINCT egress IPs/);
  assert.doesNotMatch(r.advice, /DOMINANT CAUSE/, 'the confident causal claim only fires with shared-egress evidence');
  assert.doesNotMatch(r.advice, /OWNER-GATED/, 'must not manufacture an owner escalation without shared-IP evidence');
  assert.doesNotMatch(r.advice, /escalate/i, 'must not instruct escalation without shared-IP evidence');
});

test('EI-18683773458136367 — DISTINCT-egress edge-throttle ALSO re-arming ⇒ names the backoff-loop, still no escalation', () => {
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 4, available: 1, usable: 0,
    edgeThrottledCount: 3, usageWalledCount: 0,
    edgeThrottledSharedEgress: false,
    edgeThrottledRearming: true, // deadline advancing + penalty climbing since the previous read
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.match(r.advice, /RE-ARMING/);
  assert.match(r.advice, /retry\/backoff loop/);
  assert.doesNotMatch(r.advice, /OWNER-GATED/);
  assert.match(r.advice, /do not escalate/i, 'must explicitly say NOT to escalate, not merely omit the word');
});

test('WI-36943 — poolExhausted does NOT escalate an egress fault when traffic is actually flowing and an account holds real budget (rate-governor saturation, not a dead proxy)', () => {
  // The real incident this regression pins: fleet:capacity asserted "DOMINANT CAUSE: 3/3 edge-throttled
  // → egress path broken → escalate (OWNER-GATED)" while accounts:status measured only 1/3 edge-throttled
  // (aviynw) and 2/3 (aviynw3, aviynw10) neither edge-throttled nor usage-walled, with inFlight climbing
  // 1→3 in the same window — real traffic was passing, and the accounts were being re-paused by the LOCAL
  // rate governor (self-clearing), not blocked by a down/shared egress proxy.
  const hr = {
    reachable: true, utilization: 0.9, utilizationPct: 90, paused: false, rejected: false, queueDepth: 1, inFlight: 3,
    priorityTiers: { healthyAccounts: 1, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 3, queued: 1 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 3, available: 0, usable: 0,
    edgeThrottledCount: 1, usageWalledCount: 0, // 1/3 edge-throttled; the other 2/3 are provably neither
    sustainedlyLimitedCount: 3,
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true, 'the technical exhaustion flag is still real — HOLD placements');
  assert.match(r.advice, /EXHAUSTED/);
  assert.match(r.advice, /1\/3 edge-throttled/, 'names the ACTUAL count, never a stale/inflated one');
  assert.doesNotMatch(r.advice, /DOMINANT CAUSE/, 'must not assert edge-throttle is the dominant/confident cause here');
  assert.doesNotMatch(r.advice, /OWNER-GATED/, 'must not manufacture an owner-gated infra escalation while traffic is flowing');
  assert.doesNotMatch(r.advice, /escalate rather than waiting/i);
  assert.match(r.advice, /IN FLIGHT right now/);
  assert.match(r.advice, /Do NOT escalate on this alone/i);
});

test('WI-36943 — recurrence guard: edge-throttle count alone (edge+wall === total, no inFlight evidence) still escalates as before', () => {
  // Companion negative case: when the counts DO account for the whole pool (no account is provably
  // "neither"), or no traffic is flowing, the suppression must NOT fire — same shape as the pre-existing
  // EI-18664933641195210 dominant-cause test, pinned again here under the new guard's name.
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 0,
    priorityTiers: { healthyAccounts: 3, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 0, queued: 2 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 3, available: 0, usable: 0,
    edgeThrottledCount: 2, usageWalledCount: 1, // edge(2) + wall(1) === total(3) → no account provably "neither"
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.match(r.advice, /DOMINANT CAUSE/);
  assert.match(r.advice, /OWNER-GATED/);
});

/**
 * fleet-lead-instrumentation-audit-2026-08-09 P-007. The live 2026-08-09T05:11Z reading on
 * fleet `nonp2p-bug-drain`: 4 accounts, blind:true / blindAccounts:2, usableAccounts:0,
 * factor:0, inFlight:0 — so the WI-36943 inFlight guard above cannot fire and the advice fell
 * through to the OWNER-GATED escalation. An accounts:probe-capacity run moments later found
 * THREE OF FOUR accounts answering 200. The escalation was manufactured from stale data.
 */
test('P-007 — a BLIND pool reading must not manufacture an owner-gated egress escalation', () => {
  const hr = {
    reachable: true, utilization: 0.99, utilizationPct: 99, paused: true, queueDepth: 4, inFlight: 0,
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 4 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 4, available: 0, usable: 0,
    // edge(3) + wall(1) === total(4) → the WI-36943 "provably neither" bound cannot fire,
    // and inFlight is 0 → its traffic evidence cannot fire either. Blindness is the ONLY
    // thing standing between this reading and a false owner escalation.
    edgeThrottledCount: 3, usageWalledCount: 1,
    blindCount: 2, // 2/4 = 0.5 → majority-blind
    sustainedlyLimitedCount: 4,
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.blind, true, 'fixture must actually be blind, or this test proves nothing');
  assert.equal(r.poolExhausted, true, 'the operational half stays real — HOLD placements is still correct');
  assert.match(r.advice, /EXHAUSTED/);
  // The three clauses that sent a leader at the owner:
  assert.doesNotMatch(r.advice, /DOMINANT CAUSE/, 'a blind reading cannot establish a dominant cause');
  assert.doesNotMatch(r.advice, /OWNER-GATED/, 'must not manufacture an owner escalation from stale data');
  assert.doesNotMatch(r.advice, /escalate rather than waiting/i);
  // …replaced by the one call that actually resolves the ambiguity:
  assert.match(r.advice, /NOT an owner escalation/i);
  assert.match(r.advice, /accounts:probe-capacity/);
});

test('P-007 — companion: the SAME fixture with a non-blind reading still escalates (blindness is what suppresses it)', () => {
  // Falsifiability control. Without this, the assertions above could be passing because the
  // fixture never reaches the escalation branch at all, rather than because `blind` gates it.
  const hr = {
    reachable: true, utilization: 0.99, utilizationPct: 99, paused: true, queueDepth: 4, inFlight: 0,
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 4 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 4, available: 0, usable: 0,
    edgeThrottledCount: 3, usageWalledCount: 1,
    blindCount: 0, // the ONLY difference from the test above
    sustainedlyLimitedCount: 4,
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.blind, false);
  assert.match(r.advice, /DOMINANT CAUSE/, 'a MEASURED edge-throttle majority may still escalate');
  assert.match(r.advice, /OWNER-GATED/);
});

test('EI-19995356951235246 — a marginal edge/usage tie chooses the non-escalating branch', () => {
  const hr = {
    reachable: true, utilization: 0.99, utilizationPct: 99, paused: true, queueDepth: 4, inFlight: 0,
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 4 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 4, available: 0, usable: 0,
    // Equal marginal counts do not identify the binding reset term.
    edgeThrottledCount: 2, usageWalledCount: 2,
    blindCount: 0,
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });

  assert.equal(r.poolExhausted, true);
  assert.equal(r.exhaustionReason, 'usage-wall');
  assert.match(r.advice, /dominant cause: 2\/4 usage-walled/);
  assert.doesNotMatch(r.advice, /DOMINANT CAUSE/);
  assert.doesNotMatch(r.advice, /OWNER-GATED/);
  assert.doesNotMatch(r.advice, /escalate rather than waiting/i);
});

test('EI-19995356951235246 — binding reset terms override marginal counts', () => {
  assert.equal(
    deriveCapacityBindingCause([
      { id: 'edge-a', edgeThrottleResetAt: 2_000 },
      { id: 'edge-b', edgeThrottleResetAt: 2_000 },
      { id: 'wall-a', usageResetAt: 1_000 },
      { id: 'wall-b', usageResetAt: 1_000 },
    ]),
    'usage-wall',
    'the usage-wall accounts recover first even though edge-throttle has the same marginal count',
  );
  const hr = {
    reachable: true, utilization: 0.99, utilizationPct: 99, paused: true, queueDepth: 4, inFlight: 0,
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 4 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 10,
    accountAvailability: {
      provider: 'claude', total: 4, available: 0, usable: 0,
      edgeThrottledCount: 2, usageWalledCount: 2, blindCount: 0,
      accountBindingTerms: [
        { id: 'edge-a', edgeThrottleResetAt: 2_000 },
        { id: 'edge-b', edgeThrottleResetAt: 2_000 },
        { id: 'wall-a', usageResetAt: 1_000 },
        { id: 'wall-b', usageResetAt: 1_000 },
      ],
    },
  });
  assert.equal(r.exhaustionReason, 'usage-wall');
  assert.match(r.advice, /dominant cause: 2\/4 usage-walled/);
  assert.doesNotMatch(r.advice, /OWNER-GATED/);
});

test('EI-18683773458136367 — shared-egress evidence UNKNOWN (not supplied) ⇒ unchanged legacy phrasing (fail-safe-omit)', () => {
  // Regression guard for backward compat: omitting the new fields must reproduce byte-for-byte the
  // same OWNER-GATED escalate language as before this fix (the EI-18664933641195210 test above).
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 2, usable: 0, edgeThrottledCount: 5, usageWalledCount: 1 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.match(r.advice, /DOMINANT CAUSE/);
  assert.match(r.advice, /OWNER-GATED/);
});

test('EI-18683773458136367 — deriveEdgeThrottleEvidence: identical known egress identities ⇒ sharedEgress true', () => {
  const { sharedEgress } = deriveEdgeThrottleEvidence(
    [
      { id: 'a', edgeThrottled: true, penaltyCount: 5, egressIdentity: 'http://proxy1:3128' },
      { id: 'b', edgeThrottled: true, penaltyCount: 3, egressIdentity: 'http://proxy1:3128' },
      { id: 'c', edgeThrottled: false, penaltyCount: 0, egressIdentity: 'http://proxy2:3128' },
    ],
    new Map(),
  );
  assert.equal(sharedEgress, true);
});

test('EI-18683773458136367 — deriveEdgeThrottleEvidence: distinct known egress identities ⇒ sharedEgress false', () => {
  const { sharedEgress } = deriveEdgeThrottleEvidence(
    [
      { id: 'a', edgeThrottled: true, penaltyCount: 26, egressIdentity: 'http://proxy1:3128' },
      { id: 'b', edgeThrottled: true, penaltyCount: 4, egressIdentity: 'http://proxy2:3128' },
      { id: 'c', edgeThrottled: true, penaltyCount: 1, egressIdentity: 'http://proxy3:3128' },
    ],
    new Map(),
  );
  assert.equal(sharedEgress, false);
});

test('EI-18683773458136367 — deriveEdgeThrottleEvidence: fewer than 2 throttled or unknown identities ⇒ sharedEgress undefined', () => {
  assert.equal(
    deriveEdgeThrottleEvidence([{ id: 'a', edgeThrottled: true, penaltyCount: 1 }], new Map()).sharedEgress,
    undefined,
    'only one throttled account — not enough to conclude shared vs distinct',
  );
  assert.equal(
    deriveEdgeThrottleEvidence(
      [
        { id: 'a', edgeThrottled: true, penaltyCount: 1 }, // no egressIdentity known
        { id: 'b', edgeThrottled: true, penaltyCount: 1, egressIdentity: 'http://proxy1:3128' },
      ],
      new Map(),
    ).sharedEgress,
    undefined,
    'not enough known identities to conclude either way',
  );
});

test('EI-18683773458136367 — deriveEdgeThrottleEvidence: rearming detected when resetAt advances AND penaltyCount climbs', () => {
  const prev = new Map([['a', { resetAt: 1000, penaltyCount: 5 }]]);
  const { rearming, nextSnapshot } = deriveEdgeThrottleEvidence(
    [{ id: 'a', edgeThrottled: true, edgeThrottleResetAt: 2000, penaltyCount: 7 }],
    prev,
  );
  assert.equal(rearming, true);
  assert.equal(nextSnapshot.get('a')?.resetAt, 2000);
});

test('EI-18683773458136367 — deriveEdgeThrottleEvidence: NOT rearming when penaltyCount holds steady (cooldown genuinely counting down)', () => {
  const prev = new Map([['a', { resetAt: 2000, penaltyCount: 7 }]]);
  const { rearming } = deriveEdgeThrottleEvidence(
    [{ id: 'a', edgeThrottled: true, edgeThrottleResetAt: 1500, penaltyCount: 7 }],
    prev,
  );
  assert.equal(rearming, false);
});

test('EI-18683773458136367 — deriveEdgeThrottleEvidence: no prior snapshot ⇒ rearming undefined (first read, nothing to compare)', () => {
  const { rearming } = deriveEdgeThrottleEvidence(
    [{ id: 'a', edgeThrottled: true, edgeThrottleResetAt: 1000, penaltyCount: 1 }],
    new Map(),
  );
  assert.equal(rearming, undefined);
});

test('EI-12282 — poolExhausted does NOT fire when real accounts ARE usable (no false alarm)', () => {
  const hr = {
    reachable: true,
    utilization: 0.5,
    paused: false,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 2, tiers: [{ tier: 3, minShare: 16, inFlight: 1, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 4, usable: 4 },
  });
  assert.equal(r.poolExhausted, false);
  assert.equal(r.factor, 1);
  assert.equal(r.usableAccounts, 4);
  assert.equal(r.recommendedHeadroom, 13, 'usable pool → no exhaustion clamp');
  assert.match(r.advice, /abundant/);
});

test('EI-12282 — no account cross-check supplied ⇒ byte-identical to before (fail-safe)', () => {
  const hr = {
    reachable: true,
    utilization: 0.97,
    paused: true,
    queueDepth: 2,
    priorityTiers: { healthyAccounts: 7, tier1Reserve: 2, tiers: [{ tier: 3, minShare: 16, inFlight: 1, queued: 2 }] },
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 13 });
  assert.equal(r.poolExhausted, false);
  assert.equal(r.usableAccounts, null);
  assert.equal(r.availableAccounts, null);
  assert.ok(r.factor > 0.5, 'unchanged escape-hatch behaviour when no cross-check is passed');
});

test('EI-12282 — exhaustion suppressed during the fresh-gateway restart grace (startup snapshot is not the store)', () => {
  const hr = {
    reachable: true,
    utilization: 1,
    paused: true,
    rejected: true,
    queueDepth: 0,
    processUptimeMs: 4_000, // within the 30s restart grace
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 0, tiers: [{ tier: 3, minShare: 16, inFlight: 0, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 0, usable: 0 },
  });
  assert.equal(r.restartRecovering, true);
  assert.equal(r.poolExhausted, false, 'restart grace wins — do not treat startup snapshot as sustained exhaustion');
  assert.equal(r.factor, 1);
  assert.match(r.advice, /recovering/);
});

test('EI-12282 — zero usable accounts but ZERO gateway slots is the ordinary saturated path, not the split-brain flag', () => {
  // When the gateway ALSO reports no spare slots, poolBlocked/saturation already handles it; poolExhausted
  // is specifically the CONTRADICTION (gateway says slots free, store says none) — so it must NOT fire here.
  const hr = {
    reachable: true,
    paused: true,
    rejected: true,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 0, tiers: [{ tier: 3, minShare: 16, inFlight: 16, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 0, usable: 0 },
  });
  assert.equal(r.dispatchBudget, 0);
  assert.equal(r.poolExhausted, false, 'no spare gateway slots → ordinary saturation, not the contradiction flag');
  assert.equal(r.recommendedHeadroom, CFG.minHeadroom, 'still clamps to the floor via the normal saturated path');
  assert.match(r.advice, /SATURATED/);
});

test('EI-18791793869559327 — recurrence guard: usable>0 but ALL usable accounts sustainedlyLimited MUST NOT read abundant/factor 1', () => {
  // The exact measured disagreement from the bug report: fleet:capacity said "abundant → place broadly"
  // while accounts:status showed every serving account sustainedlyLimited (penalties firing every ~15s).
  const hr = {
    reachable: true,
    utilization: 0.1,
    paused: false,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 3, tier1Reserve: 2, tiers: [{ tier: 3, minShare: 16, inFlight: 1, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 10,
    accountAvailability: { provider: 'claude', total: 3, available: 2, usable: 2, sustainedlyLimitedCount: 2 },
  });
  assert.equal(r.poolExhausted, false, 'accounts ARE usable — this is not the all-dead case');
  assert.equal(r.degraded, true, 'every usable account is sustainedlyLimited → DEGRADED, not abundant');
  assert.equal(r.sustainedlyLimitedAccounts, 2);
  assert.ok(r.factor < 1, `factor must be capped below 1, got ${r.factor}`);
  assert.ok(r.factor <= CFG.degradedFactorCap, `factor must be at/under the degraded cap, got ${r.factor}`);
  assert.ok(r.recommendedHeadroom! < 10, 'recommendedHeadroom must be clamped, not the full raw headroom');
  assert.doesNotMatch(r.advice, /^abundant/);
  assert.match(r.advice, /DEGRADED/);
  assert.match(r.advice, /sustainedly rate-limited/);
});

test('EI-18791793869559327 — no false alarm: usable accounts NOT all sustainedlyLimited stays abundant', () => {
  const hr = {
    reachable: true,
    utilization: 0.1,
    paused: false,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 2, tiers: [{ tier: 3, minShare: 16, inFlight: 0, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 10,
    // 1 of 4 usable accounts is sustainedlyLimited — not ALL of them, so this must stay abundant.
    accountAvailability: { provider: 'claude', total: 4, available: 4, usable: 4, sustainedlyLimitedCount: 1 },
  });
  assert.equal(r.degraded, false);
  assert.equal(r.factor, 1);
  assert.equal(r.recommendedHeadroom, 10);
  assert.match(r.advice, /abundant/);
});

test('EI-18791793869559327 — sustainedlyLimitedCount omitted ⇒ fail-safe, byte-identical to before this fix', () => {
  const hr = {
    reachable: true,
    utilization: 0.1,
    paused: false,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 3, tier1Reserve: 2, tiers: [{ tier: 3, minShare: 16, inFlight: 0, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 10,
    accountAvailability: { provider: 'claude', total: 3, available: 2, usable: 2 }, // no sustainedlyLimitedCount
  });
  assert.equal(r.degraded, false, 'no data ⇒ never fires (fail-safe-omit, same contract as the other optional fields)');
  assert.equal(r.sustainedlyLimitedAccounts, null);
  assert.equal(r.factor, 1);
  assert.match(r.advice, /abundant/);
});

test('EI-18791793869559327 — poolExhausted takes precedence over degraded (usable<=0 already covers this)', () => {
  const hr = {
    reachable: true,
    utilization: 0.5,
    paused: true,
    queueDepth: 0,
    priorityTiers: { healthyAccounts: 7, tier1Reserve: 2, tiers: [{ tier: 3, minShare: 16, inFlight: 1, queued: 2 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 13,
    accountAvailability: { provider: 'claude', total: 7, available: 1, usable: 0, sustainedlyLimitedCount: 0 },
  });
  assert.equal(r.poolExhausted, true);
  assert.equal(r.degraded, false, 'usable<=0 → poolExhausted already fired; degraded requires usable>0');
  assert.equal(r.factor, 0);
  assert.match(r.advice, /EXHAUSTED/);
});

test('EI-18791793869559327 — degraded suppressed during the fresh-gateway restart grace', () => {
  const hr = {
    reachable: true,
    utilization: 1,
    paused: true,
    rejected: true,
    queueDepth: 0,
    processUptimeMs: 4_000, // within the 30s restart grace
    priorityTiers: { healthyAccounts: 0, tier1Reserve: 0, tiers: [{ tier: 3, minShare: 16, inFlight: 0, queued: 0 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 10,
    accountAvailability: { provider: 'claude', total: 2, available: 2, usable: 2, sustainedlyLimitedCount: 2 },
  });
  assert.equal(r.restartRecovering, true);
  assert.equal(r.degraded, false, 'restart grace wins, same rationale as poolExhausted suppression');
  assert.equal(r.factor, 1);
});

test('EI-19281217347369076 — a majority-BLIND pool caveats poolExhausted instead of reporting quota-shaped confidence', () => {
  // The real incident this pins: accounts:probe-capacity returned 'no-reading'/'fetch failed' for 4/4
  // accounts (all 3 squid egress proxies down, every account collapsed onto one throttled bare-box IP).
  // fleet:capacity nonetheless rendered a confident "pool EXHAUSTED" with a quota-shaped resetInSec,
  // steering the reader toward passively waiting for a reset that a broken network path can never
  // produce. The blind majority must caveat the reading BEFORE the confident verdict.
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    resetInSec: 12400,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 4, available: 0, usable: 0, blindCount: 4 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true, 'usable<=0 with spare gateway slots still trips the technical flag');
  assert.equal(r.blind, true, '4/4 (100% >= 50%) carry an unresolved probe failure');
  assert.equal(r.blindAccounts, 4);
  assert.equal(r.resetInSec, 12400, 'the raw figure is preserved, never destroyed');
  assert.equal(r.resetInSecActionable, false, 'but flagged non-actionable — a probe failure is network-shaped, not quota-shaped');
  assert.match(r.advice, /BLIND READING/);
  assert.match(r.advice, /4\/4 claude account/);
  assert.match(r.advice, /accounts:test-egress/);
  assert.match(r.advice, /Do NOT wait on resetInSec/);
  // The blind caveat leads; the existing EXHAUSTED verdict still follows it (composes, doesn't replace).
  assert.match(r.advice, /BLIND READING[\s\S]*EXHAUSTED/);
});

test('EI-19281217347369076 — a MINORITY blind (<50%) does NOT trip the caveat; poolExhausted reads with its normal confidence', () => {
  const hr = {
    reachable: true, utilization: 0.97, utilizationPct: 97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 1, usable: 0, blindCount: 2 };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.blind, false, '2/5 (40%) is below the 50% majority threshold');
  assert.equal(r.blindAccounts, 2, 'still reported for visibility even when not majority');
  assert.equal(r.resetInSecActionable, true);
  assert.doesNotMatch(r.advice, /BLIND READING/);
});

test('EI-19281217347369076 — no blindCount supplied ⇒ unchanged (fail-safe-omit, byte-identical to before this field existed)', () => {
  const hr = {
    reachable: true, utilization: 0.97, paused: true, queueDepth: 2, inFlight: 1,
    priorityTiers: { healthyAccounts: 5, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 2 }] },
  };
  const accountAvailability = { provider: 'claude', total: 5, available: 1, usable: 0 }; // no blindCount
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.blind, false);
  assert.equal(r.blindAccounts, null);
  assert.equal(r.resetInSecActionable, true);
  assert.doesNotMatch(r.advice, /BLIND READING/);
});

test('EI-19281217347369076 — no accountAvailability cross-check at all ⇒ blind:false, resetInSecActionable:true, byte-identical advice', () => {
  const hr = { reachable: true, utilization: 0.1, queueDepth: 0 };
  const r = buildCapacityReport(hr, { clampArmed: false });
  assert.equal(r.blind, false);
  assert.equal(r.blindAccounts, null);
  assert.equal(r.resetInSecActionable, true);
  assert.equal(r.advice, 'abundant → place broadly up to your ceiling');
});

test('EI-21282868699055979 — Codex blind advice names a provider-scoped probe', () => {
  const hr = {
    reachable: true,
    utilization: 0.2,
    queueDepth: 0,
    inFlight: 0,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 0, queued: 1 }] },
  };
  const r = buildCapacityReport(hr, {
    clampArmed: true,
    headroom: 10,
    accountAvailability: {
      provider: 'codex',
      total: 4,
      available: 0,
      usable: 0,
      edgeThrottledCount: 4,
      blindCount: 4,
    },
  });

  assert.equal(r.blind, true);
  assert.match(r.advice, /RE-RUN accounts:probe-capacity \{ provider:'codex' \}/);
  assert.doesNotMatch(r.advice, /provider:'claude'/);
});

test('EI-19281217347369076 — gateway unreachable ⇒ blind:false, resetInSecActionable:true (fail-safe early return)', () => {
  const r = buildCapacityReport({ reachable: false }, { clampArmed: false, accountAvailability: { provider: 'claude', total: 3, available: 0, usable: 0, blindCount: 3 } });
  assert.equal(r.reachable, false);
  assert.equal(r.blind, false);
  assert.equal(r.blindAccounts, 3, 'still surfaced even on the unreachable early return');
  assert.equal(r.resetInSecActionable, true);
});

test('EI-19928050541357086 — a majority of MERELY-STALE (never-probe-failed) readings caveats poolExhausted the same as a probe failure', () => {
  // Pins the real incident: fleet:capacity { headroom: 10 } returned poolExhausted:true, usableAccounts:0,
  // "DOMINANT CAUSE: 3/3 edge-throttled ... OWNER-GATED infra issue ... escalate" while 2 of 3 claude
  // accounts had readingStatus:'stale' (readingAgeMs 34min / 99min) — NOT an unresolved probe failure
  // (lastProbeFailedAt was never set on either). ONE accounts:probe-capacity call, with no other change,
  // flipped the verdict to poolExhausted:false, usableAccounts:1, degraded:true. capacity.ts now folds
  // readingStatus !== 'fresh' into blindCount (alongside actual probe failures) so this exact shape — a
  // majority-stale pool that was simply never re-probed recently — trips the same BLIND READING caveat a
  // majority of outright probe failures already did, instead of rendering a confident quota-shaped
  // exhaustion + owner-escalation verdict off data nobody has looked at in over half an hour.
  const hr = {
    reachable: true, utilization: 0.9, utilizationPct: 90, paused: false, rejected: false, queueDepth: 1, inFlight: 1,
    priorityTiers: { healthyAccounts: 3, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 10, inFlight: 1, queued: 1 }] },
  };
  // 2/3 accounts merely stale (no probe ever failed on them) — this is what capacity.ts's
  // `rows.filter((r) => r.lastProbeFailedAt != null || r.readingStatus !== 'fresh').length` would compute.
  const accountAvailability = {
    provider: 'claude', total: 3, available: 0, usable: 0,
    edgeThrottledCount: 3, usageWalledCount: 0,
    blindCount: 2, // 2 stale, 0 probe-failed — folded together by capacity.ts
  };
  const r = buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
  assert.equal(r.poolExhausted, true, 'usable<=0 with spare gateway slots still trips the technical flag');
  assert.equal(r.blind, true, '2/3 (67% >= 50%) counts as majority-blind even though none is an outright probe failure');
  assert.equal(r.blindAccounts, 2);
  assert.equal(r.resetInSecActionable, false, 'a stale-but-unrefreshed reading is not an actionable quota window either');
  assert.match(r.advice, /BLIND READING/);
  assert.match(r.advice, /2\/3 claude account/);
  assert.match(r.advice, /gone stale from lack of a recent refresh/);
  assert.match(r.advice, /Do NOT wait on resetInSec/);
  assert.match(r.advice, /RE-RUN.*accounts:probe-capacity/);
  // The blind caveat still LEADS, before the (still-technically-true) EXHAUSTED verdict — that half of
  // the contract is unchanged: the caveat composes with the operational advice.
  assert.match(r.advice, /BLIND READING[\s\S]*EXHAUSTED/);
  // CONTRACT CHANGE, fleet-lead-instrumentation-audit-2026-08-09 P-007. This assertion previously
  // required `…EXHAUSTED[\s\S]*OWNER-GATED`, pinning the egress ESCALATION as still present on a blind
  // reading ("composes, doesn't replace"). That contradicted this very test's own stated purpose two
  // dozen lines above — folding stale readings into blindCount so the tool stops "rendering a confident
  // quota-shaped exhaustion + owner-escalation verdict off data nobody has looked at in over half an
  // hour." The caveat was prepended but the escalation it warned about was still emitted, at full
  // imperative confidence, in the same string: one advice blob saying both "do NOT treat an
  // owner-escalation reading below as confirmed" and "escalate rather than waiting for a quota reset".
  // Measured live 2026-08-09T05:11Z on fleet nonp2p-bug-drain, the imperative is the half that gets
  // acted on — a leader read it as an owner-gated infra fault while an accounts:probe-capacity moments
  // later found 3 of 4 accounts answering 200. The operational half (HOLD placements) stays; only the
  // causal attribution and the escalation instruction are withheld until the pool is re-measured.
  assert.doesNotMatch(r.advice, /OWNER-GATED/, 'a blind reading must not instruct an owner escalation');
  assert.doesNotMatch(r.advice, /escalate rather than waiting/i);
  assert.match(r.advice, /NOT an owner escalation/i);
});

test('the floor never manufactures slots — a 0-slot pool stays 0 even when paused', () => {
  const d = computeCapacityHeadroom(0, { reachable: true, paused: true });
  assert.equal(d.headroom, 0, 'no raw headroom → no spawns; the floor lets work flow, it does not invent slots');
});

test('a raw headroom already below the floor is not raised by the floor', () => {
  // raw 1 < floor 2, paused → max(floor 2, 0)=2 then min(raw 1, 2)=1 — never exceeds the real headroom
  const d = computeCapacityHeadroom(1, { reachable: true, paused: true });
  assert.equal(d.headroom, 1);
});

test('resolveCapacityConfig — env tuning over defaults; bad values fall back', () => {
  const c = resolveCapacityConfig(undefined, {
    QUEEN_CAPACITY_MIN_HEADROOM: '5',
    QUEEN_CAPACITY_QUEUE_SOFT_CAP: '48',
    QUEEN_CAPACITY_UTIL_HIGH: '0.9',
    QUEEN_CAPACITY_RESTART_GRACE_MS: '15000',
  } as NodeJS.ProcessEnv);
  assert.equal(c.minHeadroom, 5);
  assert.equal(c.queueSoftCap, 48);
  assert.equal(c.utilizationHigh, 0.9);
  assert.equal(c.restartRecoveryWindowMs, 15_000);
  const bad = resolveCapacityConfig(undefined, { QUEEN_CAPACITY_MIN_HEADROOM: 'nope' } as NodeJS.ProcessEnv);
  assert.equal(bad.minHeadroom, CFG.minHeadroom);
});

test('queenCapacityHeadroom — flagOverride:false ⇒ no clamp (byte-identical to today, even with a saturated signal)', async () => {
  const d = await queenCapacityHeadroom(20, { flagOverride: false, signal: { reachable: true, paused: true } });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
});

test('queenCapacityHeadroom — flagOverride:true + injected saturated signal ⇒ clamps to the floor', async () => {
  const d = await queenCapacityHeadroom(20, { flagOverride: true, signal: { reachable: true, paused: true } });
  assert.equal(d.headroom, CFG.minHeadroom);
  assert.equal(d.throttled, true);
});

test('queenCapacityHeadroom — flagOverride:true + injected idle signal ⇒ no clamp', async () => {
  const d = await queenCapacityHeadroom(20, { flagOverride: true, signal: { reachable: true, utilization: 0.2, queueDepth: 0 } });
  assert.equal(d.headroom, 20);
  assert.equal(d.throttled, false);
});

test('buildFleetSizingAdvisory — warns only when requested members exceed healthy account headroom', () => {
  assert.equal(buildFleetSizingAdvisory(3, { reachable: true, healthyAccounts: 3 }), null);
  assert.equal(buildFleetSizingAdvisory(2, { reachable: true, healthyAccounts: 3 }), null);

  const advisory = buildFleetSizingAdvisory(5, { reachable: true, healthyAccounts: 3 });
  assert.ok(advisory);
  assert.equal(advisory?.requestedMembers, 5);
  assert.equal(advisory?.healthyHeadroom, 3);
  assert.equal(advisory?.extraMembers, 2);
  assert.match(advisory?.message ?? '', /requested 5 fleet members, but only 3 healthy accounts/);
});

test('buildFleetSizingAdvisory — fail-soft when the gateway/headroom signal is unavailable', () => {
  assert.equal(buildFleetSizingAdvisory(5, { reachable: false, healthyAccounts: 3 }), null);
  assert.equal(buildFleetSizingAdvisory(5, { reachable: true, healthyAccounts: null }), null);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// P-001 (knowledge-at-symptom-time-2026-08-09) — symptomKnowledge on the alarming branches.
//
// The measured incident: on 2026-08-09 an su read `degraded: true` + "place conservatively (top-ranked
// only)", took the verdict at face value, and told the owner the only remaining lever was to BUY MORE
// ACCOUNTS. It was wrong — three of four accounts held real budget and the pool had collapsed on a
// shared-egress TRANSPORT throttle. The correct reading was already written down in three agent-insights
// pages AND in two standing facts folded into that agent's own second tool call, where they were excerpted
// mid-imperative ("...ALWAYS cross-read acco…"). So the fix is not more documentation: it is putting the
// instruction ON the payload that reports the symptom.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The PROPERTY under test, stated once and applied to BOTH the real subject and the pre-fix control:
 * does the payload that reports the symptom also carry the cross-read imperative, as the FIRST thing a
 * reader meets? Reading `advice` when `symptomKnowledge` is absent is exactly what the pre-fix reader did.
 */
function meetsCrossReadImperativeFirst(payload: { advice: string; symptomKnowledge?: { before: string } }): boolean {
  const lead = (payload.symptomKnowledge?.before ?? payload.advice).trim();
  return /^ALWAYS cross-read accounts:status\b/.test(lead);
}

/** The PRE-FIX implementation of the report shape: identical, minus the field this item added. */
function preFixReport<T extends { symptomKnowledge?: unknown }>(r: T): Omit<T, 'symptomKnowledge'> {
  const { symptomKnowledge: _dropped, ...rest } = r;
  return rest;
}

/** The literal 2026-08-09 incident reading: DEGRADED, all usable accounts sustainedly rate-limited. */
function incidentDegradedReport() {
  const hr = {
    reachable: true, utilization: 0.82, utilizationPct: 82, paused: false, rejected: false, queueDepth: 2, inFlight: 3,
    priorityTiers: { healthyAccounts: 4, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 3, queued: 2 }] },
  };
  const accountAvailability = {
    provider: 'claude', total: 4, available: 1, usable: 1, edgeThrottledCount: 3, usageWalledCount: 0,
    sustainedlyLimitedCount: 1,
  };
  return buildCapacityReport(hr, { clampArmed: true, headroom: 10, accountAvailability });
}

test('P-001 FALSIFIABILITY CONTROL — the PRE-FIX report FAILS the cross-read property on the real 2026-08-09 incident input; the fixed one passes', () => {
  // This control is PERMANENT on purpose. Without it, the assertions below could all pass against an
  // implementation that never delivers the imperative where a reader actually meets it, and the suite
  // would go vacuously green. The control must FAIL on the pre-fix shape or it is not measuring anything.
  const r = incidentDegradedReport();
  assert.equal(r.degraded, true, 'calibration: the fixture must land on the DEGRADED branch the incident hit');

  const preFix = preFixReport(r);
  assert.equal(
    meetsCrossReadImperativeFirst(preFix),
    false,
    'CONTROL: the pre-fix payload (advice only) does NOT lead with the cross-read imperative — this is the reading that produced the misdiagnosis',
  );
  assert.match(preFix.advice, /place conservatively/, 'CONTROL: and what it DOES lead with is an actionable-sounding instruction that is wrong here');

  assert.equal(
    meetsCrossReadImperativeFirst(r),
    true,
    'the fixed payload leads with the imperative — the control above is what proves this assertion is not vacuous',
  );
});

test('P-001 — the imperative LEADS and survives the 180-char excerpt that decapitated it in the incident', () => {
  const r = incidentDegradedReport();
  const before = r.symptomKnowledge?.before ?? '';
  assert.match(before, /^ALWAYS cross-read accounts:status\b/, 'the verb is first, not after the evidence');

  // The two standing facts that would have prevented this were folded in at a 180-char excerpt and BOTH
  // lost their verb mid-word. The instruction here must be whole inside that same budget.
  const excerpt = before.slice(0, 180);
  assert.match(
    excerpt,
    /^ALWAYS cross-read accounts:status before escalating, holding placements, or telling an owner to add accounts\b/,
  );
  assert.ok(before.length <= 180, `the operative clause must fit a 180-char excerpt intact (was ${before.length})`);
  assert.match(before, /NOT self-validating/, 'and it must say why the verdict cannot be taken at face value');
});

test('P-001 — `why` names the THREE collapsed signals that need opposite responses, and `insights` points at the pages that already explain them', () => {
  const sk = incidentDegradedReport().symptomKnowledge;
  assert.ok(sk, 'present on the degraded branch');
  // The whole misdiagnosis was reading one number as one failure. Naming all three is the fix's payload.
  assert.match(sk!.why, /TRANSPORT/i);
  assert.match(sk!.why, /RATE 429|rate/i);
  assert.match(sk!.why, /USAGE WALL/i);
  assert.match(sk!.why, /usageWalled/, 'names the concrete per-account fields to disambiguate with');
  assert.match(sk!.why, /edgeThrottled/);
  assert.equal(sk!.insights.length, 3);
  for (const p of sk!.insights) assert.match(p, /^\/internal\/docs\/agent-insights\//);
});

test('P-001 — present on ALL THREE alarming branches (exhausted / blocked / degraded)', () => {
  // EXHAUSTED: zero usable accounts while the gateway still claims queue slots.
  const exhausted = buildCapacityReport(
    {
      reachable: true, utilization: 0.5, utilizationPct: 50, paused: false, rejected: false, queueDepth: 1, inFlight: 1,
      priorityTiers: { healthyAccounts: 3, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 1, queued: 1 }] },
    },
    { clampArmed: true, headroom: 10, accountAvailability: { provider: 'claude', total: 3, available: 0, usable: 0 } },
  );
  assert.equal(exhausted.poolExhausted, true, 'calibration: fixture lands on the EXHAUSTED branch');
  assert.equal(meetsCrossReadImperativeFirst(exhausted), true);

  // BLOCKED: gateway paused/rejecting with NO tiered spare capacity to override the bound-account block
  // (healthyAccounts + a spare bee-tier slot would suppress poolBlocked — capacity-oracle-false-saturation).
  const blocked = buildCapacityReport(
    {
      reachable: true, utilization: 0.99, utilizationPct: 99, paused: true, rejected: false, queueDepth: 5, inFlight: 2,
      priorityTiers: { healthyAccounts: 0, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 2, inFlight: 2, queued: 5 }] },
    },
    { clampArmed: true, headroom: 10 },
  );
  assert.match(blocked.advice, /SATURATED/, 'calibration: fixture lands on the BLOCKED branch');
  assert.equal(meetsCrossReadImperativeFirst(blocked), true);

  // DEGRADED: covered by the incident fixture.
  assert.equal(meetsCrossReadImperativeFirst(incidentDegradedReport()), true);
});

test('P-001 — ABSENT on a healthy read and on an unreachable gateway (a non-alarming report is byte-identical to pre-fix)', () => {
  const abundant = buildCapacityReport(
    {
      reachable: true, utilization: 0.1, utilizationPct: 10, paused: false, rejected: false, queueDepth: 0, inFlight: 0,
      priorityTiers: { healthyAccounts: 6, tier1Reserve: 1, tiers: [{ tier: 3, minShare: 20, inFlight: 0, queued: 0 }] },
    },
    { clampArmed: true, headroom: 10, accountAvailability: { provider: 'claude', total: 6, available: 5, usable: 5 } },
  );
  assert.match(abundant.advice, /abundant/, 'calibration: fixture lands on the healthy branch');
  assert.equal('symptomKnowledge' in abundant, false, 'the KEY must be absent, not present-and-undefined');
  assert.deepEqual(abundant, preFixReport(abundant), 'a healthy report is byte-identical to the pre-fix shape');

  const unreachable = buildCapacityReport({ reachable: false }, { clampArmed: true, headroom: 10 });
  assert.equal('symptomKnowledge' in unreachable, false);
  assert.deepEqual(unreachable, preFixReport(unreachable));
});

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * P-009 (knowledge-at-symptom-time-2026-08-09): "no explicit egress binding" is the DEFAULT SHARED
 * egress — a known identity — not an unknown one.
 *
 * THE REAL INCIDENT. On 2026-08-08 the datacenter proxy entries were pulled, so all four Claude
 * accounts routed out the box's single egress IP. That IP collected Cloudflare per-IP bare-429 edge
 * throttling, the pool reported `usableAccounts 1 / factor 0`, and `accounts:status` measured only 1
 * of 4 genuinely usage-walled. `deriveEdgeThrottleEvidence` exists to name exactly that ("the fault
 * is the shared egress, not the accounts") — but capacity.ts populated `egressIdentity` as
 * `proxyUrl ?? localAddress ?? undefined`, so with no proxies EVERY identity was undefined,
 * `knownIdentities` was empty, and the verdict could never be reached. The diagnosis was
 * structurally unavailable in precisely the configuration that produced the incident.
 *
 * Owner directive 2026-08-09 ("dont re-renable rayobyte") makes default-shared egress PERMANENT
 * here, so this is the normal configuration, not a transient one to wait out.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** The pre-fix populate expression from capacity.ts, kept verbatim as a permanent control. */
const preFixEgressIdentity = (egress?: { proxyUrl?: string; localAddress?: string }): string | undefined =>
  egress?.proxyUrl ?? egress?.localAddress ?? undefined;

/** The measured incident: 4 accounts, no proxies, all edge-throttled on the one box egress IP. */
const INCIDENT_ACCOUNTS = [
  { id: 'aviynw', edgeThrottled: true, penaltyCount: 12 },
  { id: 'aviynw3', edgeThrottled: true, penaltyCount: 9 },
  { id: 'aviynw10', edgeThrottled: true, penaltyCount: 7 },
  { id: 'avi_storewolf.com', edgeThrottled: true, penaltyCount: 4 },
] as const;

test('P-009 PERMANENT FALSIFIABILITY CONTROL — the pre-fix identity made sharedEgress unreachable on the real incident input', () => {
  // Every account has no binding, so the pre-fix expression yields undefined for all of them...
  const preFix = INCIDENT_ACCOUNTS.map((a) => ({ ...a, egressIdentity: preFixEgressIdentity(undefined) }));
  assert.deepEqual(
    preFix.map((s) => s.egressIdentity),
    [undefined, undefined, undefined, undefined],
    'pre-fix: no binding was reported as UNKNOWN',
  );
  // ...and the shared-egress verdict is therefore unreachable, despite 4 accounts provably sharing one IP.
  assert.equal(
    deriveEdgeThrottleEvidence(preFix, new Map()).sharedEgress,
    undefined,
    'pre-fix: the one signal that explains a pool-wide collapse could not be computed',
  );
});

test('P-009 — egressIdentityOf is TOTAL and reports the default shared egress as a known identity', () => {
  assert.equal(egressIdentityOf({ proxyUrl: 'http://proxy1:3128' }), 'http://proxy1:3128', 'proxy wins');
  assert.equal(egressIdentityOf({ localAddress: '10.0.0.7' }), 'src 10.0.0.7', "matches the gateway's egDesc spelling");
  assert.equal(egressIdentityOf({ proxyUrl: 'http://p:3128', localAddress: '10.0.0.7' }), 'http://p:3128');
  assert.equal(egressIdentityOf({}), DEFAULT_SHARED_EGRESS_IDENTITY, 'binding present but empty ⇒ default shared');
  assert.equal(egressIdentityOf(undefined), DEFAULT_SHARED_EGRESS_IDENTITY, 'no binding at all ⇒ default shared');
});

test('P-009 — with the fix, 4 default-egress accounts all edge-throttled ⇒ sharedEgress TRUE (the incident is now diagnosable)', () => {
  const samples = INCIDENT_ACCOUNTS.map((a) => ({ ...a, egressIdentity: egressIdentityOf(undefined) }));
  const { sharedEgress } = deriveEdgeThrottleEvidence(samples, new Map());
  assert.equal(sharedEgress, true, 'accounts sharing the box default egress are the strongest shared-IP case');
});

test('P-009 — a proxied account throttled alongside a default-egress one still DISPROVES a shared-IP fault', () => {
  const { sharedEgress } = deriveEdgeThrottleEvidence(
    [
      { id: 'a', edgeThrottled: true, penaltyCount: 5, egressIdentity: 'http://proxy1:3128' },
      { id: 'b', edgeThrottled: true, penaltyCount: 5, egressIdentity: egressIdentityOf(undefined) },
    ],
    new Map(),
  );
  assert.equal(sharedEgress, false, 'two throttled accounts on genuinely DIFFERENT egresses ⇒ not a shared-IP fault');
});

/**
 * EI-20613616736215896 — the REAL 2026-08-16 pool, verbatim from `accounts:status`: every claude account
 * is `egressPool`-routed (the singular `egress` is unset) across THREE distinct proxies, and two accounts
 * legitimately share one. `egressPool` supersedes `egress`, so reading only the singular collapsed all of
 * them onto DEFAULT_SHARED_EGRESS_IDENTITY — which P-009 (correctly, for its own case) treats as a KNOWN
 * identity, turning "we cannot tell" into an affirmative shared-IP verdict and emitting the owner-gated
 * "the egress path itself is broken" escalation for a pool that had no such fault.
 */
const POOL_ROUTED_ACCOUNTS = [
  { id: 'aviynw', pool: [{ proxyUrl: 'http://199.182.115.224:3128' }, {}] },
  { id: 'aviynw3', pool: [{ proxyUrl: 'http://199.182.115.224:3128' }, {}] },
  { id: 'avistorewolf.com', pool: [{ proxyUrl: 'http://209.163.116.244:3128' }, {}] },
  { id: 'aviynw10', pool: [{ proxyUrl: 'http://216.213.24.64:3128' }, {}] },
] as const;

test('EI-20613616736215896 FALSIFIABILITY CONTROL — reading only the singular `egress` manufactures sharedEgress TRUE on a 3-proxy pool', () => {
  // The pre-fix call ignored egressPool entirely, so every pool-routed account fell to the same fallback.
  const preFix = POOL_ROUTED_ACCOUNTS.map((a, i) => ({
    id: a.id,
    edgeThrottled: true,
    penaltyCount: i + 1,
    egressIdentity: egressIdentityOf(undefined),
  }));
  assert.equal(
    new Set(preFix.map((s) => s.egressIdentity)).size,
    1,
    'pre-fix: three distinct proxies collapsed onto ONE synthetic identity',
  );
  assert.equal(
    deriveEdgeThrottleEvidence(preFix, new Map()).sharedEgress,
    true,
    'pre-fix: the down-proxy signature was asserted for a pool that is provably NOT on a shared IP — ' +
      'this is the false owner escalation, and it must fail once the pool is consulted',
  );
});

test('EI-20613616736215896 — egressPool SUPERSEDES the singular egress, so distinct proxies disprove a shared-IP fault', () => {
  const samples = POOL_ROUTED_ACCOUNTS.map((a, i) => ({
    id: a.id,
    edgeThrottled: true,
    penaltyCount: i + 1,
    egressIdentity: egressIdentityOf(undefined, a.pool),
  }));
  assert.equal(new Set(samples.map((s) => s.egressIdentity)).size, 3, 'three real egress identities, not one');
  assert.equal(
    deriveEdgeThrottleEvidence(samples, new Map()).sharedEgress,
    false,
    'the owner-gated escalation branch is now unreachable for this pool',
  );
});

test('EI-20613616736215896 — egressPool identity is order-insensitive, deduped, and still names the box default', () => {
  // Two accounts rotating over the SAME set of IPs genuinely share an egress and must compare equal
  // regardless of the order the store returns them in — otherwise a real shared-IP fault reads as distinct.
  assert.equal(
    egressIdentityOf(undefined, [{ proxyUrl: 'http://b:3128' }, { proxyUrl: 'http://a:3128' }]),
    egressIdentityOf(undefined, [{ proxyUrl: 'http://a:3128' }, { proxyUrl: 'http://b:3128' }]),
    'same rotation set ⇒ same identity, whatever the order',
  );
  assert.equal(
    egressIdentityOf(undefined, [{ proxyUrl: 'http://a:3128' }, { proxyUrl: 'http://a:3128' }]),
    'http://a:3128',
    'duplicate entries collapse',
  );
  assert.equal(
    egressIdentityOf(undefined, [{ proxyUrl: 'http://a:3128' }, {}]),
    `${DEFAULT_SHARED_EGRESS_IDENTITY}|http://a:3128`,
    'an unbound pool entry is the box default, named so it participates in the comparison',
  );
  // A real shared pool must still be diagnosable — the P-009 case survives the change.
  const shared = POOL_ROUTED_ACCOUNTS.map((a, i) => ({
    id: a.id,
    edgeThrottled: true,
    penaltyCount: i + 1,
    egressIdentity: egressIdentityOf(undefined, [{ proxyUrl: 'http://199.182.115.224:3128' }, {}]),
  }));
  assert.equal(
    deriveEdgeThrottleEvidence(shared, new Map()).sharedEgress,
    true,
    'a genuinely shared pool still yields the shared-IP verdict',
  );
});

test('EI-20613616736215896 — an EMPTY pool falls through to the singular binding (no silent behavior change)', () => {
  assert.equal(egressIdentityOf({ proxyUrl: 'http://p:3128' }, []), 'http://p:3128', 'empty pool ⇒ singular wins');
  assert.equal(egressIdentityOf({ proxyUrl: 'http://p:3128' }, undefined), 'http://p:3128', 'absent pool ⇒ singular');
  assert.equal(egressIdentityOf(undefined, []), DEFAULT_SHARED_EGRESS_IDENTITY, 'empty pool, no binding ⇒ default');
});

test('P-009 — `undefined` still means GENUINELY UNKNOWN, so the unknown-identity contract is unchanged', () => {
  // The caller no longer manufactures undefined, but the pure function must keep honoring it: a sample
  // whose binding truly could not be read must not be silently folded into the shared-egress majority.
  assert.equal(
    deriveEdgeThrottleEvidence(
      [
        { id: 'a', edgeThrottled: true, penaltyCount: 1 },
        { id: 'b', edgeThrottled: true, penaltyCount: 1, egressIdentity: DEFAULT_SHARED_EGRESS_IDENTITY },
      ],
      new Map(),
    ).sharedEgress,
    undefined,
    'one unknown + one known is still not enough to conclude either way',
  );
});
