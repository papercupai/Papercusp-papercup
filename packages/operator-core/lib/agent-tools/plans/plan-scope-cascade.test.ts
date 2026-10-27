/**
 * plan-scope-cascade.test.ts — guard for review-system-rework-reduction-2026-09-23 P-030
 * (spec RSR-P-030-A): superseding a plan parks the carrier items it made moot and
 * re-evaluates the carrier plan's BAR readiness in the same write, surfacing the blocking
 * code in the carrier plan's Now and on the plan-event rail orient reads.
 *
 * The fake store mirrors the REAL durable-park write (`setWorkItemClaimHold` merges
 * `_claimHold: true` into the payload) and claimability is read with the REAL
 * `isClaimHoldParked` predicate — the JS twin of the SQL floor claim_next /
 * scheduler:get_next apply — so "parked" here means exactly what self-select honours.
 */
import { describe, expect, it } from 'vitest';
import { isClaimHoldParked } from '../../work-items';
import {
  BAR_READINESS_NOW_MARK,
  MOOT_CARRIER_NOW_MARK,
  isMootCarrierTitle,
  propagatePlanScopeWrite,
  reevaluateBarReadinessOnScopeWrite,
  stampBarReadinessNowBlock,
  stampMootCarrierNowBlock,
  type BarReadinessReading,
  type CarrierCandidate,
  type GateReading,
  type PlanScopeCascadeDeps,
} from './plan-scope-cascade';

const SUBJECT = 'test-suite-recovery-2026-08-27';
const CARRIER_PLAN = 'ship-main-greening-program-2026-09-15';

function planBody(state = 'Greening in progress.', next = 'Land the repair queue.'): string {
  return `---\ntitle: Carrier\nslug: ${CARRIER_PLAN}\nstatus: ready\n---\n\n# Carrier\n\n## Now\n\n**State:** ${state}\n\n**Next:** ${next}\n\n## Background\n\nprose\n`;
}

function row(featureId: string, title: string, extra: Partial<CarrierCandidate> = {}): CarrierCandidate {
  return {
    featureId,
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    sourcePlanSlug: CARRIER_PLAN,
    sourcePlanItemIds: ['P-021'],
    title,
    status: 'open',
    takenBy: null,
    payload: {},
    ...extra,
  };
}

function fakeWorld(rows: CarrierCandidate[], gate: GateReading = { satisfied: false, code: 'acceptance_bar_contract_not_ready' }) {
  const payloads = new Map(rows.map((r) => [r.featureId, { ...(r.payload as object) } as Record<string, unknown>]));
  const bodies = new Map([[CARRIER_PLAN, planBody()]]);
  const notified: string[] = [];
  const events: Array<{ plan: string; detail: string }> = [];
  const gateCalls: string[] = [];
  const parks: Array<{ id: string; trigger: string; owner: string; condition: string }> = [];
  const deps: PlanScopeCascadeDeps = {
    async listCandidates() {
      return rows.map((r) => ({ ...r, payload: payloads.get(r.featureId) }));
    },
    isParked: isClaimHoldParked,
    async park(carrier, park) {
      // Same patch shape setWorkItemClaimHold writes for a durable park.
      payloads.set(carrier.featureId, {
        ...payloads.get(carrier.featureId),
        _claimHold: true,
        claim_hold_by: 'su-actor',
        claim_hold_reason: park.reason,
        claim_hold_release: { condition: park.condition, trigger: park.trigger, owner: park.owner },
      });
      parks.push({ id: carrier.featureId, trigger: park.trigger, owner: park.owner, condition: park.condition });
      return true;
    },
    async notifyHolder(carrier) {
      notified.push(carrier.featureId);
    },
    async evaluateGate(planSlug) {
      gateCalls.push(planSlug);
      return gate;
    },
    async stampNow(planSlug, _scope, stamp) {
      const current = bodies.get(planSlug);
      if (!current) return false;
      const next = stampMootCarrierNowBlock(current, stamp);
      if (next === null) return false;
      bodies.set(planSlug, next);
      return true;
    },
    async emitPlanEvent(plan, detail) {
      events.push({ plan, detail });
    },
    releaseTrigger: (slug) => `plan:acceptance:${slug}`,
  };
  const claimable = (id: string) => !isClaimHoldParked(payloads.get(id));
  return { deps, payloads, bodies, notified, events, gateCalls, parks, claimable };
}

const INPUT = {
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  subjectSlug: SUBJECT,
  cause: 'superseded' as const,
  actor: 'su-actor',
};

describe('isMootCarrierTitle (P-030 carrier detection)', () => {
  it('matches the measured carrier titles', () => {
    expect(
      isMootCarrierTitle(
        'Ship test-suite-recovery-2026-08-27: P-004 canonical exact-repairHead run once the gate is green',
        SUBJECT,
      ),
    ).toBe(true);
    expect(
      isMootCarrierTitle(
        'Ship the original tracker ship-main-greening-plans-2026-08-29: flip its P-002 done',
        'ship-main-greening-plans-2026-08-29',
      ),
    ).toBe(true);
    expect(isMootCarrierTitle('[Unified] Grade and accept test-suite-recovery-2026-08-27', SUBJECT)).toBe(true);
  });

  it('rejects a mention without a carrier verb before the slug', () => {
    expect(isMootCarrierTitle(`Notes on ${SUBJECT} flakiness`, SUBJECT)).toBe(false);
    expect(isMootCarrierTitle(`${SUBJECT} will ship later`, SUBJECT)).toBe(false);
  });

  it('does not let a verb INSIDE the slug stand in for a carrier verb', () => {
    expect(
      isMootCarrierTitle('Audit ship-main-greening-plans-2026-08-29 residue', 'ship-main-greening-plans-2026-08-29'),
    ).toBe(false);
  });

  it('matches the whole slug token only, never a longer sibling slug', () => {
    expect(isMootCarrierTitle(`Ship ${SUBJECT}-v2 now`, SUBJECT)).toBe(false);
    expect(isMootCarrierTitle(`Ship x-${SUBJECT}`, SUBJECT)).toBe(false);
  });
});

describe('propagatePlanScopeWrite (P-030 / RSR-P-030-A)', () => {
  it('superseding a plan parks its open carrier out of self-select and leaves unrelated items claimable', async () => {
    const carrier = row('WI-1', `Ship ${SUBJECT}: rebuild the 8-BAR acceptance chain`, { takenBy: 'su-holder' });
    const unrelated = row('WI-2', 'Land the repair queue admission fix', { sourcePlanItemIds: ['P-009'] });
    const mention = row('WI-3', `Notes on ${SUBJECT} flakiness`, { sourcePlanItemIds: ['P-010'] });
    const w = fakeWorld([carrier, unrelated, mention]);

    // Calibration: before the scope write the carrier is claimable (the pre-P-030 state).
    expect(w.claimable('WI-1')).toBe(true);

    const result = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(result.error).toBeUndefined();
    expect(w.claimable('WI-1')).toBe(false);
    expect(w.claimable('WI-2')).toBe(true);
    expect(w.claimable('WI-3')).toBe(true);
    expect(result.carriers.map((c) => c.id)).toEqual(['WI-1']);
    expect(result.carriers[0]).toMatchObject({ parked: true, holderNotified: true, plan: CARRIER_PLAN });
    expect(w.notified).toEqual(['WI-1']);
    // Parked, never dropped, with a release contract keyed to the carrier plan's re-scope.
    expect(w.parks).toEqual([
      expect.objectContaining({ id: 'WI-1', trigger: `plan:acceptance:${CARRIER_PLAN}`, owner: 'su-holder' }),
    ]);
  });

  it('re-evaluates the carrier plan readiness in the same call and surfaces the blocking code in Now and the plan event', async () => {
    const w = fakeWorld([row('WI-1', `Ship ${SUBJECT}`)]);

    const result = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(w.gateCalls).toEqual([CARRIER_PLAN]);
    expect(result.carrierPlans).toEqual([
      expect.objectContaining({
        slug: CARRIER_PLAN,
        gate: { satisfied: false, code: 'acceptance_bar_contract_not_ready' },
        nowStamped: true,
        eventEmitted: true,
      }),
    ]);
    const body = w.bodies.get(CARRIER_PLAN)!;
    expect(body).toContain(`${MOOT_CARRIER_NOW_MARK}: ${SUBJECT}`);
    expect(body).toContain('acceptance gate BLOCKED: acceptance_bar_contract_not_ready');
    expect(body).toContain('Repair the moot carrier WI-1 (P-021)');
    // The author's State/Next survive beneath the banner.
    expect(body).toContain('Greening in progress.');
    expect(body).toContain('Land the repair queue.');
    expect(w.events).toEqual([
      expect.objectContaining({ plan: CARRIER_PLAN, detail: expect.stringContaining('acceptance_bar_contract_not_ready') }),
    ]);
  });

  it('is idempotent: a second run re-parks nothing and stamps nothing new', async () => {
    const w = fakeWorld([row('WI-1', `Ship ${SUBJECT}`)]);
    await propagatePlanScopeWrite(INPUT, w.deps);
    const bodyAfterFirst = w.bodies.get(CARRIER_PLAN);

    const second = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(second.carriers[0]).toMatchObject({ alreadyParked: true, parked: false });
    expect(w.parks).toHaveLength(1);
    expect(second.carrierPlans[0]!.nowStamped).toBe(false);
    expect(w.bodies.get(CARRIER_PLAN)).toBe(bodyAfterFirst);
  });

  it('isolates a per-carrier failure: one park throwing never stops the others', async () => {
    const w = fakeWorld([row('WI-1', `Ship ${SUBJECT}`), row('WI-4', `Accept ${SUBJECT}`, { sourcePlanItemIds: ['P-022'] })]);
    const realPark = w.deps.park;
    w.deps.park = async (carrier, park) => {
      if (carrier.featureId === 'WI-1') throw new Error('pg timeout');
      return realPark(carrier, park);
    };

    const result = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(result.carriers.find((c) => c.id === 'WI-1')).toMatchObject({ parked: false, error: 'park failed: pg timeout' });
    expect(w.claimable('WI-4')).toBe(false);
    expect(result.carrierPlans[0]!.nowStamped).toBe(true);
  });

  it('reports a detection failure instead of throwing into the plan write', async () => {
    const w = fakeWorld([]);
    w.deps.listCandidates = async () => {
      throw new Error('connection closed');
    };

    const result = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(result.error).toBe('carrier detection failed: connection closed');
    expect(result.carriers).toEqual([]);
  });

  it('never parks a same-slug carrier in ANOTHER harness (a different plan)', async () => {
    const mine = row('WI-6', `Ship ${SUBJECT}: rebuild its acceptance chain`);
    const theirs = row('WI-7', `Ship ${SUBJECT}: rebuild its acceptance chain`, { harnessSlug: 'other-harness' });
    const w = fakeWorld([mine, theirs]);

    const result = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(result.carriers.map((c) => c.id)).toEqual(['WI-6']);
    expect(w.claimable('WI-6')).toBe(false);
    expect(w.claimable('WI-7')).toBe(true);
  });

  it('never parks an item of the superseded plan itself', async () => {
    const own = row('WI-5', `Ship ${SUBJECT}`, { sourcePlanSlug: SUBJECT });
    const w = fakeWorld([own]);

    const result = await propagatePlanScopeWrite(INPUT, w.deps);

    expect(result.carriers).toEqual([]);
    expect(w.claimable('WI-5')).toBe(true);
  });
});

describe('stampMootCarrierNowBlock', () => {
  it('returns null for a plan with no Now block (never invents one)', () => {
    expect(
      stampMootCarrierNowBlock('---\nslug: x\n---\n\n# X\n\n## Background\n', {
        subjectSlug: SUBJECT,
        cause: 'superseded',
        carriers: ['WI-1'],
        gate: null,
      }),
    ).toBeNull();
  });

  it('reports an unmeasured gate honestly rather than as satisfied', () => {
    const out = stampMootCarrierNowBlock(planBody(), {
      subjectSlug: SUBJECT,
      cause: 'superseded',
      carriers: ['WI-1'],
      gate: { satisfied: null, code: null, error: 'timeout' },
    });
    expect(out).toContain('not measured (timeout)');
    expect(out).not.toContain('acceptance gate satisfied');
  });
});

// P-031 (merged into P-030 by D-005): every scope write re-evaluates BAR readiness and keeps
// ONE banner in the plan's Now. The end-to-end guard that drives the REAL snapshot projection
// lives beside its fixture in acceptance-bar-contract-snapshot.test.ts; these pin the banner
// rules and the never-throw contract.
describe('BAR readiness re-evaluation on a scope write (P-031)', () => {
  const day = new Date('2026-09-23T12:00:00.000Z');
  const blocked = (codes: string[]): BarReadinessReading => ({
    state: 'blocked',
    codes,
    nextRepair: { code: codes[0]!, barKey: 'R-1', action: 'Map the outstanding BAR to a live replacement item or amend the BAR.' },
  });
  const count = (body: string) => body.split(BAR_READINESS_NOW_MARK).length - 1;

  it('stamps the blocking codes at the top of the State and keeps the author Now beneath', () => {
    const out = stampBarReadinessNowBlock(planBody(), blocked(['bar_snapshot_mapping_dropped_only']), 'item-dropped', day);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/\*\*State:\*\* ⚠ BAR READINESS BLOCKED \(2026-09-23, after item-dropped\): bar_snapshot_mapping_dropped_only\./);
    expect(out!).toContain('Next repair: Map the outstanding BAR');
    expect(out!).toContain('Greening in progress.');
    expect(out!).toContain('**Next:** Land the repair queue.');
  });

  it('is idempotent for an unchanged verdict and REPLACES (never stacks) a changed one', () => {
    const first = stampBarReadinessNowBlock(planBody(), blocked(['bar_snapshot_mapping_dropped_only']), 'item-dropped', day)!;
    const later = new Date('2026-09-24T09:00:00.000Z');
    expect(stampBarReadinessNowBlock(first, blocked(['bar_snapshot_mapping_dropped_only']), 'decision-added', later)).toBeNull();
    const changed = stampBarReadinessNowBlock(
      first,
      blocked(['bar_snapshot_mapping_dropped_only', 'bar_snapshot_mapping_missing']),
      'decision-added',
      later,
    );
    expect(changed).not.toBeNull();
    expect(count(changed!)).toBe(1);
    expect(changed!).toContain('bar_snapshot_mapping_missing');
  });

  it('clears the banner once readiness is ready, and never erases it on an unmeasured read', () => {
    const stamped = stampBarReadinessNowBlock(planBody(), blocked(['bar_snapshot_mapping_dropped_only']), 'item-dropped', day)!;
    expect(stampBarReadinessNowBlock(stamped, { state: null, codes: [], nextRepair: null, error: 'x' }, 'decision-added')).toBeNull();
    const cleared = stampBarReadinessNowBlock(stamped, { state: 'ready', codes: [], nextRepair: null }, 'decision-added');
    expect(cleared).not.toBeNull();
    expect(count(cleared!)).toBe(0);
    expect(cleared!).toContain('Greening in progress.');
    // Ready with no banner present: nothing to write.
    expect(stampBarReadinessNowBlock(planBody(), { state: 'ready', codes: [], nextRepair: null }, 'item-dropped')).toBeNull();
  });

  it('refreshes a generated repair Next after a rubric amendment but preserves authored Next text', () => {
    const stale = planBody(
      `${BAR_READINESS_NOW_MARK} (2026-10-24, after decision-added): bar_snapshot_cohort_incomplete. ` +
        'Next repair: repair seed. (re-evaluated in the same write by the scope-write cascade, P-030/P-031)',
      'repair seed',
    );
    const cleared = stampBarReadinessNowBlock(
      stale,
      { state: 'ready', codes: [], nextRepair: null },
      'rubric-amended',
      day,
    );
    expect(cleared).not.toBeNull();
    expect(cleared!).toContain('**State:** —');
    expect(cleared!).toContain('**Next:** —');
    expect(cleared!).not.toContain('bar_snapshot_cohort_incomplete');

    const authoredNext = planBody(
      `${BAR_READINESS_NOW_MARK} (2026-10-24, after decision-added): bar_snapshot_mapping_missing. ` +
        'Next repair: repair seed. (re-evaluated in the same write by the scope-write cascade, P-030/P-031)',
      'Land the repair queue.',
    );
    const preserved = stampBarReadinessNowBlock(
      authoredNext,
      { state: 'ready', codes: [], nextRepair: null },
      'rubric-amended',
      day,
    );
    expect(preserved).not.toBeNull();
    expect(preserved!).toContain('**Next:** Land the repair queue.');
  });

  it('coexists with a moot-carrier banner in the same Now', () => {
    const moot = stampMootCarrierNowBlock(planBody(), {
      subjectSlug: SUBJECT,
      cause: 'superseded',
      carriers: ['WI-1 (P-022)'],
      gate: { satisfied: false, code: 'acceptance_bar_contract_not_ready' },
      today: day,
    })!;
    const both = stampBarReadinessNowBlock(moot, blocked(['bar_snapshot_mapping_dropped_only']), 'item-dropped', day)!;
    expect(both).toContain(MOOT_CARRIER_NOW_MARK);
    expect(count(both)).toBe(1);
  });

  it('preserves the activation-audit receipt from the follow-up restamp write', async () => {
    const activationAudit = {
      currentPlanRevision: { id: null, seq: null, contentHash: 'after-restamp', planVersion: 14, recorded: false },
    } as any;
    const result = await reevaluateBarReadinessOnScopeWrite(
      { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: CARRIER_PLAN, cause: 'decision-added' },
      {
        async readBarReadiness() {
          return blocked(['bar_snapshot_mapping_dropped_only']);
        },
        async restampNow() {
          return { stamped: true, activationAudit };
        },
      },
    );

    expect(result.nowStamped).toBe(true);
    expect(result.activationAudit).toBe(activationAudit);
  });

  it('never throws: a failed read is NOT measured and skips the stamp; a failed stamp keeps the codes', async () => {
    let stampCalls = 0;
    const failedRead = await reevaluateBarReadinessOnScopeWrite(
      { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: CARRIER_PLAN, cause: 'decision-added' },
      {
        async readBarReadiness() {
          throw new Error('pool exhausted');
        },
        async restampNow() {
          stampCalls += 1;
          return true;
        },
      },
    );
    expect(failedRead.state).toBeNull();
    expect(failedRead.error).toContain('pool exhausted');
    expect(stampCalls).toBe(0);

    const failedStamp = await reevaluateBarReadinessOnScopeWrite(
      { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: CARRIER_PLAN, cause: 'item-dropped' },
      {
        async readBarReadiness() {
          return blocked(['bar_snapshot_mapping_dropped_only']);
        },
        async restampNow() {
          throw new Error('plan lock busy');
        },
      },
    );
    expect(failedStamp.codes).toEqual(['bar_snapshot_mapping_dropped_only']);
    expect(failedStamp.nowStamped).toBe(false);
    expect(failedStamp.error).toContain('plan lock busy');
  });
});
