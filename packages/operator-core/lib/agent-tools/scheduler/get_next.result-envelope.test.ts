/**
 * WI-38199 — scheduler:get_next returns TWO envelopes, and the SUCCESS one was
 * unpinned by any test.
 *
 * The contract (get_next.ts, end of the handler):
 *   - a COMMITTED claim  → `{ data: payload }`   (structured, complete)
 *   - a miss             → `{ content: [text] }` (the bounded text projection)
 *
 * Why the success arm is structured rather than text: `applyResultDoor` early-
 * returns on a non-array `content` (result-door.ts — `if (!Array.isArray(items))
 * return result`), so the `data` envelope is NOT subject to the result door.
 * That is the point. The claim has ALREADY COMMITTED by the time this response
 * is rendered, so a door-truncated receipt would leave the caller unable to tell
 * whether it holds the item — and a blind retry of a destructive claim is
 * exactly what must not happen.
 *
 * WHY THIS FILE EXISTS: when the success arm switched from `content` to `data`
 * (722551ecc2), nothing asserted the envelope. The break surfaced only as
 * `TypeError: Cannot read properties of undefined (reading '0')` in THREE
 * sibling test files that each carried their own private `content[0].text`
 * accessor — a red release gate, diagnosed from a stack trace pointing at the
 * readers rather than at the contract that moved. Pin the contract here so the
 * next change to it fails ONE loud, self-describing test at the source.
 *
 * The MISS arm is deliberately not re-asserted here: it is already covered by
 * get_next.concurrency-diagnosis.test.ts and get_next.fleet-scope-concurrency.test.ts,
 * which read `content[0].text` on every case and would fail if it moved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getNextForBee: vi.fn(),
  getClaimTimePremises: vi.fn(),
  getClaimTimePriorAttemptBrief: vi.fn(),
  getClaimTimePlanDecisions: vi.fn(),
  renderPlanDecisionsNote: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveClaimSpecWorkspace: vi.fn(),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: mocks.getFlag,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: mocks.resolveAgentIdentity,
}));

vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: mocks.getNextForBee,
  resolveClaimSpecWorkspace: mocks.resolveClaimSpecWorkspace,
}));
vi.mock('../../work-item-claim-lease-wiring', () => ({
  workItemClaimLeaseEnabled: vi.fn(() => false),
  leaseClaimedWorkItem: vi.fn(async () => true),
}));

// This is an envelope unit test, not a live coordination/PG integration test.
// Pin every preflight and post-claim enrichment seam that get_next traverses so
// a cold module cache or saturated database cannot consume Vitest's 5s timeout
// before the envelope assertion runs (EI-20308567859934395).
vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: vi.fn(async () => new Map()),
  // get_next's preflight has read per-owner readings since c7ef831c06; without this
  // stub preflight throws, degrades, and no committed-claim envelope is formed.
  fetchContextPressureReadings: vi.fn(async () => new Map()),
}));
vi.mock('../locks/live-lock-paths', () => ({
  liveLockedPaths: vi.fn(async () => []),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
  readFleetPauseState: vi.fn(async () => ({ windingDown: false, reason: null })),
  diagnoseFleetScopeCooldownMiss: vi.fn(async () => null),
  diagnoseFleetScopeIssueFloorMiss: vi.fn(async () => null),
  diagnoseFleetScopeFeatureFamilyExclusions: vi.fn(async () => null),
  diagnoseFleetScopeTerminalExhaustion: vi.fn(async () => null),
  diagnoseFleetScopePlanTerminality: vi.fn(async () => null),
  diagnoseFleetScopeLeaderLiveness: vi.fn(async () => null),
  fleetScopedMiss: vi.fn(() => ({ ok: false, error: 'scoped miss', windDown: true })),
}));
vi.mock('../../events/await/store', () => ({
  cancelClaimableAwaits: vi.fn(async () => 0),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => undefined),
}));
vi.mock('../../memory/claim-port', () => ({
  buildClaimRecallBlock: vi.fn(async () => null),
}));
vi.mock('../../work-item-checkpoint', () => ({
  getClaimTimeCheckpointHint: vi.fn(async () => null),
}));
vi.mock('../../work-item-prior-work', () => ({
  getClaimTimePriorWorkHint: vi.fn(async () => null),
  priorWorkWarning: vi.fn(() => null),
}));
vi.mock('../../plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: mocks.getClaimTimePlanDecisions,
  renderPlanDecisionsNote: mocks.renderPlanDecisionsNote,
}));
vi.mock('../../prior-attempt-context', () => ({
  getClaimTimePriorAttemptBrief: mocks.getClaimTimePriorAttemptBrief,
}));
vi.mock('../../premises-claim-port', () => ({
  getClaimTimePremises: mocks.getClaimTimePremises,
}));
vi.mock('../work_items/retraction-advisory', () => ({
  getClaimTimeRetractionAdvisory: vi.fn(async () => null),
}));

import getNextTool, { observeLateSchedulerClaim, schedulerDispositionMetadata } from './get_next';

type ToolDef = {
  handler: (
    args: unknown,
    ctx?: unknown,
  ) => Promise<{ content?: Array<{ text: string }>; data?: Record<string, unknown> }>;
};

const callGetNext = (ctx: unknown = {}) =>
  (getNextTool as unknown as ToolDef).handler({ harness: 'papercusp' }, ctx);

/**
 * The predicate under test, factored out so the CONTROL below can prove it is
 * falsifiable. Mutating the real source to prove that is unsafe in this repo:
 * git-sync sweeps the whole tree on a schedule and would commit the mutant.
 */
function expectCommittedClaimEnvelope(out: {
  content?: Array<{ text: string }>;
  data?: Record<string, unknown>;
}): void {
  expect(out.data).toBeDefined();
  expect(out.content).toBeUndefined();
}

describe('scheduler:get_next result envelope (WI-38199)', () => {
  beforeEach(() => {
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-envelope', workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockReset();
    mocks.getClaimTimePremises.mockReset().mockResolvedValue(null);
    mocks.getClaimTimePriorAttemptBrief.mockReset().mockResolvedValue(null);
    mocks.getClaimTimePlanDecisions.mockReset().mockResolvedValue(null);
    mocks.renderPlanDecisionsNote.mockReset().mockReturnValue(null);
  });

  it('returns a COMMITTED claim as structured `data`, not as a door-truncatable text block', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: { id: 'WI-38199', state: 'open' },
      claimedUnder: { specId: 'envelope-spec', revision: 3 },
      specSource: 'fleet',
    });

    const out = await callGetNext();

    // The receipt travels as structured data, NOT as a text content block —
    // a text block is what subjects a result to the result door, and a committed
    // claim must never be truncated away.
    expectCommittedClaimEnvelope(out);
    expect(out.data).toMatchObject({ ok: true });
  });

  it('stamps the committed claim disposition onto the invocation metadata writer', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: { id: 'WI-38199', state: 'open' },
      claimedUnder: { specId: 'envelope-spec', revision: 3 },
      specSource: 'fleet',
    });
    const metadata = vi.fn();

    await callGetNext({ metadata });

    expect(metadata).toHaveBeenCalledTimes(1);
    // EI-7014: the mock's claimedUnder carries a specId/revision, so the enriched
    // disposition now attributes the claim to the spec that produced it (see the
    // dedicated attribution tests below) — this fixture's mock predates that field.
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      schedulerDisposition: {
        kind: 'claimed',
        workItemId: 'WI-38199',
        specId: 'envelope-spec',
        revision: 3,
      },
    }));
  });

  it('builds a structured no-claim diagnosis instead of relying on result text', () => {
    expect(
      schedulerDispositionMetadata(null, {
        ok: false,
        reason: 'fleet_lane_drained',
        message: 'nothing matched',
      }),
    ).toEqual({ kind: 'no-claim', reason: 'fleet_lane_drained' });
  });

  // EI-7014: the disposition attributes a claim/miss to the spec that produced it, when one
  // is supplied — sourced from values the caller already had (res.claimedUnder /
  // reconciliation.scope.record), never a new read performed by this pure function itself.
  it('attributes a claimed disposition to the spec that produced it, when supplied', () => {
    expect(
      schedulerDispositionMetadata({ id: 'EI-9001' }, {}, { specId: 'nonp2p-bug-drain-kinds', revision: 3 }),
    ).toEqual({ kind: 'claimed', workItemId: 'EI-9001', specId: 'nonp2p-bug-drain-kinds', revision: 3 });
  });

  it('omits spec identity entirely when none is supplied — never a guessed default', () => {
    expect(schedulerDispositionMetadata({ id: 'EI-9002' }, {}, null)).toEqual({
      kind: 'claimed',
      workItemId: 'EI-9002',
    });
  });

  it('attributes a no-claim disposition to the fleet-scoped spec that missed under it', () => {
    expect(
      schedulerDispositionMetadata(
        null,
        { ok: false, reason: 'fleet_lane_drained' },
        { specId: 'nonp2p-bug-drain-kinds', revision: null },
      ),
    ).toEqual({ kind: 'no-claim', reason: 'fleet_lane_drained', specId: 'nonp2p-bug-drain-kinds', revision: null });
  });

  it('passes the claimed id to premise citation hydration and surfaces its advisory', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: {
        id: 'EI-aged',
        state: 'open',
        title: 'Build a replacement gate',
        summary: 'EI-aged depends on WI-4329.',
        payload: { source: 'ideation' },
        harness: 'papercusp',
      },
      claimedUnder: { specId: 'envelope-spec', revision: 3 },
      specSource: 'fleet',
    });
    mocks.getClaimTimePremises.mockResolvedValue({
      rendered: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      note: 'Re-check the invalidated premise before building.',
    });

    const out = await callGetNext();

    expect(out.data).toMatchObject({
      workItem: { id: 'EI-aged' },
      premises: ['- ? WI-4329 terminal evidence says the premise was invalid'],
      premisesNote: 'Re-check the invalidated premise before building.',
    });
    expect(mocks.getClaimTimePremises).toHaveBeenCalledWith({
      workItem: {
        id: 'EI-aged',
        title: 'Build a replacement gate',
        summary: 'EI-aged depends on WI-4329.',
        payload: { source: 'ideation' },
      },
      harness: 'papercusp',
      workspaceId: 'ws-test',
    });
  });

  it('surfaces the shared bounded prior-attempt brief after a committed scheduler claim', async () => {
    const workItem = {
      id: 'WI-history',
      state: 'open',
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } },
      harness: 'papercusp',
    };
    const brief = { schemaVersion: 'prior-attempt-brief-v1', fingerprint: 'fp', omission: { omittedRecords: 2 } };
    mocks.getNextForBee.mockResolvedValue({
      workItem,
      claimedUnder: { specId: 'envelope-spec', revision: 3 },
      specSource: 'fleet',
    });
    mocks.getClaimTimePriorAttemptBrief.mockResolvedValue(brief);
    const out = await callGetNext();
    expect(out.data).toMatchObject({ priorAttemptBrief: brief });
    expect(mocks.getClaimTimePriorAttemptBrief).toHaveBeenCalledWith(expect.objectContaining({
      workItem: expect.objectContaining({ id: 'WI-history' }),
      harness: 'papercusp',
    }));
  });

  it('delivers governing plan decisions and their warning in the committed claim payload', async () => {
    const workItem = {
      id: 'WI-decisions',
      state: 'open',
      payload: { plan_item: { plan_slug: 'a-plan', item_id: 'P-1' } },
      harness: 'papercusp',
    };
    const brief = {
      planSlug: 'a-plan',
      decisions: [{ id: 'D-1', title: 'Keep the guard live', ref: 'a-plan#D-1' }],
      totalDecisions: 1,
      totalLocalDecisions: 1,
      totalAffectedDecisions: 0,
      affectedDecisions: 0,
      authorityReadFailed: false,
    };
    const warning = '⚠ GOVERNING PLAN DECISION: a-plan#D-1';
    mocks.getNextForBee.mockResolvedValue({
      workItem,
      claimedUnder: { specId: 'envelope-spec', revision: 3 },
      specSource: 'fleet',
    });
    mocks.getClaimTimePlanDecisions.mockResolvedValue(brief);
    mocks.renderPlanDecisionsNote.mockReturnValue(warning);

    const out = await callGetNext();

    expectCommittedClaimEnvelope(out);
    expect(out.data).toMatchObject({
      workItem: { id: 'WI-decisions' },
      planDecisions: brief.decisions,
      planDecisionsNote: warning,
    });
    expect(Object.keys(out.data!).indexOf('planDecisionsNote')).toBeLessThan(Object.keys(out.data!).indexOf('workItem'));
    expect(mocks.getClaimTimePlanDecisions).toHaveBeenCalledWith({
      workItem: { payload: workItem.payload },
      harness: 'papercusp',
      workspaceId: 'ws-test',
    });
    expect(mocks.renderPlanDecisionsNote).toHaveBeenCalledWith(brief);
  });

  it('CONTROL: the predicate rejects the LEGACY text envelope this guard exists to catch', () => {
    // The exact shape the handler returned before 722551ecc2. If this ever stops
    // throwing, the assertion above has gone vacuous and would pass on a
    // regression — the guard would be decorative.
    expect(() => expectCommittedClaimEnvelope({ content: [{ text: JSON.stringify({ ok: true }) }] })).toThrow();
  });

  it('carries the claimed work-item in the `data` payload so a caller can reconcile without retrying', async () => {
    mocks.getNextForBee.mockResolvedValue({
      workItem: { id: 'WI-38199', state: 'open' },
      claimedUnder: { specId: 'envelope-spec', revision: 3 },
      specSource: 'fleet',
    });

    const out = await callGetNext();

    // The whole reason the success arm bypasses the door: the caller must be able
    // to see WHICH item it now holds, from the response alone.
    expect(JSON.stringify(out.data)).toContain('WI-38199');
  });

  it('records a late claimed result only after the deadline aborts the resolver', async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    const operation = new Promise<unknown>((r) => { resolve = r; });
    const settlements: unknown[] = [];
    const observed = observeLateSchedulerClaim(
      operation,
      controller.signal,
      (settlement) => settlements.push(settlement),
      () => '2026-10-07T16:00:00.000Z',
    );

    controller.abort();
    resolve({ workItem: { id: 'EI-late' } });
    await observed;

    expect(settlements).toEqual([
      { kind: 'claimed', workItemId: 'EI-late', settledAt: '2026-10-07T16:00:00.000Z' },
    ]);
  });

  it('keeps late no-claim distinct from a missing disposition', async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    const operation = new Promise<unknown>((r) => { resolve = r; });
    const settlements: unknown[] = [];
    const observed = observeLateSchedulerClaim(operation, controller.signal, (s) => settlements.push(s), () => 'settled');

    controller.abort();
    resolve(null);
    await observed;

    expect(settlements).toEqual([{ kind: 'no-claim', settledAt: 'settled' }]);
  });

  it('records a rejected late resolver as unknown rather than no-claim', async () => {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const operation = new Promise<unknown>((_resolve, r) => { reject = r; });
    const settlements: unknown[] = [];
    const observed = observeLateSchedulerClaim(operation, controller.signal, (s) => settlements.push(s), () => 'settled');

    controller.abort();
    reject(new Error('settlement failed'));
    await observed;

    expect(settlements).toEqual([{ kind: 'rejected-unknown', settledAt: 'settled' }]);
  });
});
