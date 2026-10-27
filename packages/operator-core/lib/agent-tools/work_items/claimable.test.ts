/**
 * claimable.test.ts — the work_items:claimable HANDLER (P-001,
 * claimable-read-tool-and-sql-encapsulation-audit-2026-07-21). The single-snapshot
 * claimability read (readIssueClaimability), the fleet claim-spec resolver, and the
 * caller-identity resolver are mocked; this pins the HANDLER's own logic — filter assembly
 * (spec ∧ kind), state/limit/spec threading, the returned payload shape, breakdownOnly, and
 * that it is READ-ONLY (never claims).
 *
 * WI-5947: the handler used to issue THREE independent reads (counts, rows, sample) and
 * present them as one verdict. It now makes exactly ONE call to readIssueClaimability,
 * which reads all three inside one REPEATABLE READ snapshot — pinned below.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/claimable.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';

vi.mock('../../scheduler/get-next', () => ({
  readIssueClaimability: vi.fn(),
}));
vi.mock('../../scheduler/claim-spec-store', () => ({
  getClaimSpecRecord: vi.fn(),
  resolveFleetClaimSpec: vi.fn(),
  listFleetClaimSpecCandidates: vi.fn(),
  resolveClaimSpecWorkspace: (ws: string | null | undefined) => (ws && ws !== '*' ? ws : undefined),
}));
vi.mock('../../scheduler/fleet-scope-admission', () => ({
  readFleetPauseState: vi.fn(),
}));
// EI-23772523186892689: the caller-vs-fleet spec comparison reads the caller's latest fleet
// membership (dynamic import inside the handler's per-agent-spec branch only).
vi.mock('../../fleet-membership-store', () => ({
  latestFleetMembership: vi.fn(),
}));
// EI-21834285144372521: the handler now runs the SAME post-claim plan-lane guard
// scheduler:get_next uses, read-only, over plan-linked rows in the returned page. Mocked so
// existing fixtures (WI-B carries plan:'p') keep their pre-fix "claimable" behaviour by
// default; individual tests below override it to exercise the new exclusion.
vi.mock('../../scheduler/plan-item-lane-guard', () => ({
  planItemLaneBlockReason: vi.fn(),
}));
const hiveMocks = vi.hoisted(() => ({ potHomeSlugForHarness: vi.fn() }));
vi.mock('../../hive-federation', () => hiveMocks);
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'probe' }),
}));

import { readIssueClaimability } from '../../scheduler/get-next';
import { DEFAULT_CLAIM_SPEC, type ClaimSpec } from '../../scheduler/claim-spec';
import {
  getClaimSpecRecord,
  resolveFleetClaimSpec,
  listFleetClaimSpecCandidates,
} from '../../scheduler/claim-spec-store';
import { readFleetPauseState } from '../../scheduler/fleet-scope-admission';
import { latestFleetMembership } from '../../fleet-membership-store';
import { planItemLaneBlockReason } from '../../scheduler/plan-item-lane-guard';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { materializeCountEvidence } from '../../count-evidence-contract';

const readM = vi.mocked(readIssueClaimability);
const recordM = vi.mocked(getClaimSpecRecord);
const recM = vi.mocked(resolveFleetClaimSpec);
const candM = vi.mocked(listFleetClaimSpecCandidates);
const pauseM = vi.mocked(readFleetPauseState);
const laneM = vi.mocked(planItemLaneBlockReason);
const membershipM = vi.mocked(latestFleetMembership);
const logM = vi.fn();

const tool = (await import('./claimable')).default;

const BREAKDOWN = {
  matchedByFilter: 9,
  claimable: 3,
  affinityCoverage: {
    denominator: 3,
    nonEmptyPaths: 2,
    floor: 0.5,
    belowFloor: false,
  },
  excluded: {
    taken: 2,
    claimHold: 1,
    needsHuman: 1,
    observationLane: 1,
    externalBlocker: 0,
    planLaneReserved: 1,
    federationDetector: 0,
    loopNoise: 0,
    alreadyCompleted: 1,
    crossMachineRig: 0,
    blockedDep: 0,
    cooldown: 0,
    remoteOrigin: 0,
  },
  queueControl: {
    activeClaims: 2,
    rawClaimHolds: 1,
    holdOpenLeases: 1,
    durableParks: 1,
    unattributedClaimHolds: 0,
    pendingAgentReview: 1,
    revisionRequestedAgentReview: 0,
    revisionReproductionValidation: 0,
    revisionContentAdoptionCandidates: 0,
    revisionLegacyException: 0,
  },
};
const ROWS = [
  { id: 'WI-A', kind: 'bug', title: 'a', status: 'open', severity: 'minor', plan: null, featureOrder: null, createdTs: 1 },
  { id: 'WI-B', kind: 'change', title: 'b', status: 'open', severity: null, plan: 'p', featureOrder: 2, createdTs: 2 },
  { id: 'WI-C', kind: 'task', title: 'c', status: 'open', severity: null, plan: null, featureOrder: null, createdTs: 3 },
];

const run = async (args: unknown, metadata?: (data: Record<string, unknown>) => void) => {
  const res = (await tool.handler(args as never, { ownerId: 'probe', workspaceId: 'ws-1', log: logM, metadata } as never)) as {
    content: { text: string }[];
  };
  return JSON.parse(res.content[0]!.text);
};

it('binds the exact post-floor admission result to native invocation metadata', async () => {
  const metadata = vi.fn();
  const result = await run({ harness: 'papercusp' }, metadata);
  expect(metadata).toHaveBeenCalledWith({ operationalOutput: { schemaVersion: 1,
    observedAt: result.countEvidence.contract.measuredAt,
    sha256: createHash('sha256').update(canonicalJson(result)).digest('hex') } });
  const changed = structuredClone(result); changed.claimableCount++;
  expect(createHash('sha256').update(canonicalJson(changed)).digest('hex'))
    .not.toBe(metadata.mock.calls[0][0].operationalOutput.sha256);
});

const EMPTY_QUEUE_CONTROL_SAMPLE = {
  activeClaims: [],
  holdOpenLeases: [],
  durableParks: [],
  agentReview: [],
};
const EMPTY_SAMPLE = {
  taken: [],
  claimHold: [],
  needsHuman: [],
  observationLane: [],
  externalBlocker: [],
  planLaneReserved: [],
  federationDetector: [],
  loopNoise: [],
  alreadyCompleted: [],
  crossMachineRig: [],
  blockedDep: [],
  cooldown: [],
  queueControl: EMPTY_QUEUE_CONTROL_SAMPLE,
};
/** What the mocked snapshot read reports as its per-floor sample (a test may override). */
let sampleValue: Record<string, unknown> = EMPTY_SAMPLE;
/**
 * What the mocked snapshot read reports as its ROWS and BREAKDOWN (a test may override).
 * Overridable through the ONE `beforeEach` mock rather than a second `mockImplementation`
 * per test: re-installing readM needs an `as never` cast (its real signature is wider than
 * any fixture), and each such cast defeats the vi.mocked() typecheck AND raises the
 * shrink-only lint:mock-cast-escape ratchet. Same seam as sampleValue/admittedValue above.
 */
let rowsValue: Record<string, unknown>[] = ROWS;
let breakdownValue: Record<string, unknown> = BREAKDOWN;

/**
 * A HEALTHY admitted composition (WI-6673) — the default, so the composition warning is
 * off unless a test opts into the degenerate shape. `admitted` is a REQUIRED field of
 * IssueClaimabilityReading; this fixture went stale when it was added and took all 11
 * tests in this file down with a `Cannot read properties of undefined` — invisible to tsc
 * because the mock is cast `as never`. If you add another field to that interface, add it
 * here too.
 */
const HEALTHY_ADMITTED = {
  total: 3,
  byKind: { bug: 2, change: 1 },
  bySeverity: { major: 2, minor: 1 },
  lowSeverityShare: 1 / 3,
  degenerate: false,
  peakDay: { day: '2026-08-01', count: 3 },
};
/** What the mocked snapshot read reports as the admitted composition (a test may override). */
let admittedValue: Record<string, unknown> = HEALTHY_ADMITTED;

beforeEach(() => {
  vi.clearAllMocks();
  logM.mockClear();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
  sampleValue = EMPTY_SAMPLE;
  admittedValue = HEALTHY_ADMITTED;
  rowsValue = ROWS;
  breakdownValue = BREAKDOWN;
  // Stands in for the ONE snapshot read: honours breakdownOnly/sampleLimit exactly as the
  // real readIssueClaimability does, so the handler's payload assembly is what's under test.
  readM.mockImplementation((async (_filter: unknown, _opts: unknown, readOpts: {
    breakdownOnly?: boolean;
    sampleLimit?: number;
    onStageTiming?: (stage: string, elapsedMs: number) => void;
  }) => {
    readOpts.onStageTiming?.('candidate-materialization', 12);
    readOpts.onStageTiming?.('claimable-rows', 3);
    return {
      breakdown: breakdownValue,
      rows: readOpts.breakdownOnly ? [] : rowsValue,
      admitted: admittedValue,
      ...(readOpts.sampleLimit ? { sample: sampleValue } : {}),
    };
  }) as never);
  recordM.mockResolvedValue({
    source: 'default',
    spec: {
      ...DEFAULT_CLAIM_SPEC,
      specId: 'default-fixed-ordering',
      revision: 0,
      view: { filter: undefined },
    },
    revision: null,
    updatedBy: null,
    updatedAt: null,
  });
  mockResolvedTyped(recM, null);
  mockResolvedTyped(candM, []);
  pauseM.mockResolvedValue({ windingDown: false, reason: null });
  laneM.mockResolvedValue(null);
});

describe('work_items:claimable handler', () => {
  it('logs SQL read stages and bounded plan-lane guard timings without changing the result', async () => {
    laneM.mockResolvedValue(null);

    const out = await run({ harness: 'papercup' });

    expect(out.claimable.map((row: { id: string }) => row.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    expect(logM).toHaveBeenCalledTimes(1);
    const timingMessage = logM.mock.calls[0]![0] as string;
    const timingMarker = '[work_items:claimable:timing] ';
    expect(timingMessage.startsWith(timingMarker)).toBe(true);
    const timing = JSON.parse(timingMessage.slice(timingMarker.length)) as {
      planLaneGuard: { elapsedMs: number };
    };
    expect(timing).toMatchObject({
      level: 'info',
      outcome: 'ok',
      readStageMs: expect.objectContaining({
        'candidate-materialization': 12,
        'claimable-rows': 3,
      }),
      planLaneGuard: expect.objectContaining({
        rowsScanned: ROWS.length,
        planLinkedRowsChecked: 1,
        blockedPlanRows: 0,
      }),
    });
    expect(timing.planLaneGuard.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves member harnesses to their Hive home and discloses both scopes', async () => {
    hiveMocks.potHomeSlugForHarness.mockResolvedValue('oddsmith-hive');

    const out = await run({ harness: 'oddsmith' });

    expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('ws-1', 'oddsmith');
    expect(readM.mock.calls[0]![1]).toEqual(expect.objectContaining({ harness: 'oddsmith-hive' }));
    expect(out.harness).toBe('oddsmith-hive');
    expect(out.claimableHarnessScope).toEqual({
      requested: 'oddsmith',
      resolved: 'oddsmith-hive',
      resolution: 'hive-home',
    });
  });

  it('no spec/kind: reads the caller-effective lane; claimableCount === oracle survivors; rows from the lister; default provenance for solo callers', async () => {
    const out = await run({ harness: 'papercup' });
    // the snapshot read was called with an EMPTY filter (whole issue-family lane), caller identity threaded.
    expect(readM).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ harness: 'papercup', assignee: 'probe' }),
      expect.objectContaining({ limit: 20 }),
    );
    expect(out.claimableCount).toBe(3); // === breakdown.claimable (the authoritative number)
    expect(out.claimableCallerScope).toEqual({
      assignee: 'probe',
      callerRelative: true,
      filingGraceSeconds: 600,
      peerReadinessMayDiffer: true,
    });
    expect(out.note).toContain('authoritative for THIS CALLER');
    expect(out.note).toContain('another fleet member may have a different total');
    expect(out.note).toContain('up to 600s');
    expect(out.matchedByFilter).toBe(9);
    expect(out.affinityCoverage).toEqual({ denominator: 3, nonEmptyPaths: 2, floor: 0.5, belowFloor: false });
    expect(out.returned).toBe(3);
    expect(out.claimable.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    expect(out.excludedBreakdown.taken).toBe(2);
    expect(out.queueControl).toEqual(BREAKDOWN.queueControl);
    expect(out.spec).toEqual({ specId: 'default-fixed-ordering', revision: 0, source: 'default' });
    expect(recordM).toHaveBeenCalledWith({ cupId: 'probe', workspaceId: 'ws-1' });
    // NEVER claims — this read only resolves the caller's spec and measures the oracle.
    expect(recM).not.toHaveBeenCalled();
  });

  it('EI-22395160648139412: omitted spec resolves the caller-effective inherited fleet spec instead of DEFAULT_CLAIM_SPEC', async () => {
    recordM.mockResolvedValue({
      source: 'fleet',
      spec: {
        ...DEFAULT_CLAIM_SPEC,
        specId: 'goal-drain-lane',
        revision: 4,
        view: { filter: { field: 'goal', op: '=', value: 'work-on-everything-813959' } },
        states: ['open'],
      },
      revision: 4,
      updatedBy: null,
      updatedAt: null,
      harnessSlug: null,
      fleetSlug: 'goal-drain-work-on-everything-813959',
    });

    const out = await run({ harness: 'papercup' });

    expect(recordM).toHaveBeenCalledWith({ cupId: 'probe', workspaceId: 'ws-1' });
    expect(readM.mock.calls[0]![0]).toEqual({
      field: 'goal',
      op: '=',
      value: 'work-on-everything-813959',
    });
    expect(readM.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        states: ['open'],
        spec: expect.objectContaining({ specId: 'goal-drain-lane', revision: 4 }),
      }),
    );
    expect(out.spec).toEqual({
      specId: 'goal-drain-lane',
      revision: 4,
      source: 'fleet',
      fleetSlug: 'goal-drain-work-on-everything-813959',
      matchedBy: 'caller-effective',
    });
    expect(out.countEvidence.contract.population.selector.claimSpec).toMatchObject({
      specId: 'goal-drain-lane',
      revision: 4,
      source: 'fleet',
      fleetSlug: 'goal-drain-work-on-everything-813959',
      matchedBy: 'caller-effective',
    });
  });

  it('EI-22395160648139412: winding-down fleet keeps the effective spec identity but reports no new claimable rows', async () => {
    recordM.mockResolvedValue({
      source: 'fleet',
      spec: {
        ...DEFAULT_CLAIM_SPEC,
        specId: 'goal-drain-lane',
        revision: 4,
        view: { filter: { field: 'goal', op: '=', value: 'work-on-everything-813959' } },
        states: ['open'],
      },
      revision: 4,
      updatedBy: null,
      updatedAt: null,
      harnessSlug: null,
      fleetSlug: 'goal-drain-work-on-everything-813959',
    });
    pauseM.mockResolvedValue({ windingDown: true, reason: 'drain complete' });

    const out = await run({ harness: 'papercup' });

    expect(out.spec).toMatchObject({
      specId: 'goal-drain-lane',
      revision: 4,
      source: 'fleet',
      fleetSlug: 'goal-drain-work-on-everything-813959',
      matchedBy: 'caller-effective',
    });
    expect(out.fleetControl).toEqual({
      state: 'winding-down',
      reason: 'drain complete',
      newWork: 'blocked',
    });
    expect(out.claimableCount).toBe(0);
    expect(out.rows).toEqual([]);
    expect(out.note).toContain('FLEET WINDING DOWN');
    expect(out.note).toContain('matchedByFilter is diagnostic only');
  });

  describe('EI-23772523186892689: a per-agent spec that overrides the caller\'s fleet spec is named in-band', () => {
    const FLEET = 'goal-drain-work-on-everything-60d3a8';
    const specWith = (specId: string, revision: number): ClaimSpec => ({
      ...DEFAULT_CLAIM_SPEC,
      specId,
      revision,
      view: { filter: { field: 'goal', op: '=', value: 'g' } },
      states: ['open'],
    });
    const cupRecord = (specId: string, revision = 3) => ({
      source: 'cup' as const,
      spec: specWith(specId, revision),
      revision,
      updatedBy: null,
      updatedAt: null,
      harnessSlug: null,
    });
    const fleetResolved = (
      specId: string,
      matchedBy: 'fleet-slug' | 'spec-id' = 'fleet-slug',
      revision = 3,
    ) => ({
      record: {
        source: 'fleet' as const,
        spec: specWith(specId, revision),
        revision,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: FLEET,
      },
      fleetSlug: FLEET,
      matchedBy,
    });

    it('different spec ids: names BOTH lanes, says diverges, and the note refuses the "fleet has no work" reading', async () => {
      recordM.mockResolvedValue(cupRecord('plans-start-dry-run-lane'));
      membershipM.mockResolvedValueOnce({ fleetSlug: FLEET, fleetRole: 'leader' });
      recM.mockResolvedValueOnce(fleetResolved('goal-fleet-lane'));

      const out = await run({ harness: 'papercup' });

      expect(recM).toHaveBeenCalledWith({ spec: FLEET, workspaceId: 'ws-1' });
      expect(out.spec).toMatchObject({ specId: 'plans-start-dry-run-lane', source: 'cup', matchedBy: 'caller-effective' });
      expect(out.claimableCallerScope.fleetSpecComparison).toEqual({
        fleetSlug: FLEET,
        callerSpecId: 'plans-start-dry-run-lane',
        callerSpecRevision: 3,
        fleetSpecId: 'goal-fleet-lane',
        fleetSpecRevision: 3,
        diverges: true,
      });
      expect(out.note).toContain("CALLER SPEC ≠ YOUR FLEET'S SPEC");
      expect(out.note).toContain("'plans-start-dry-run-lane'");
      expect(out.note).toContain("'goal-fleet-lane' rev 3");
      expect(out.note).toContain('a 0 here does not mean the fleet has no work');
      expect(out.note).toContain(`spec:'${FLEET}'`);
    });

    it('same spec id: reports diverges:false and adds NO warning', async () => {
      recordM.mockResolvedValue(cupRecord('shared-lane'));
      membershipM.mockResolvedValueOnce({ fleetSlug: FLEET, fleetRole: 'member' });
      recM.mockResolvedValueOnce(fleetResolved('shared-lane'));

      const out = await run({ harness: 'papercup' });

      expect(out.claimableCallerScope.fleetSpecComparison.diverges).toBe(false);
      expect(out.note).not.toContain('CALLER SPEC');
    });

    it('same spec id but different revisions: reports diverges and names both revisions', async () => {
      recordM.mockResolvedValue(cupRecord('shared-lane', 15));
      membershipM.mockResolvedValueOnce({ fleetSlug: FLEET, fleetRole: 'member' });
      recM.mockResolvedValueOnce(fleetResolved('shared-lane', 'fleet-slug', 14));

      const out = await run({ harness: 'papercup' });

      expect(out.claimableCallerScope.fleetSpecComparison).toEqual({
        fleetSlug: FLEET,
        callerSpecId: 'shared-lane',
        callerSpecRevision: 15,
        fleetSpecId: 'shared-lane',
        fleetSpecRevision: 14,
        diverges: true,
      });
      expect(out.note).toContain("CALLER SPEC ≠ YOUR FLEET'S SPEC");
      expect(out.note).toContain("'shared-lane' rev 15");
      expect(out.note).toContain("spec 'shared-lane' rev 14");
    });

    it("fleet spec unreadable: diverges is null (not false) and the note says it MAY differ", async () => {
      recordM.mockResolvedValue(cupRecord('plans-start-dry-run-lane'));
      membershipM.mockResolvedValueOnce({ fleetSlug: FLEET, fleetRole: 'leader' });
      recM.mockResolvedValueOnce(null);

      const out = await run({ harness: 'papercup' });

      expect(out.claimableCallerScope.fleetSpecComparison).toEqual({
        fleetSlug: FLEET,
        callerSpecId: 'plans-start-dry-run-lane',
        callerSpecRevision: 3,
        fleetSpecId: null,
        fleetSpecRevision: null,
        diverges: null,
      });
      expect(out.note).toContain("CALLER SPEC MAY DIFFER FROM YOUR FLEET'S");
    });

    it('a match in the specId namespace is NOT this fleet\'s spec (some other row wearing a coincident name)', async () => {
      recordM.mockResolvedValue(cupRecord('plans-start-dry-run-lane'));
      membershipM.mockResolvedValueOnce({ fleetSlug: FLEET, fleetRole: 'leader' });
      recM.mockResolvedValueOnce(fleetResolved('someone-elses-lane', 'spec-id'));

      const out = await run({ harness: 'papercup' });

      expect(out.claimableCallerScope.fleetSpecComparison.fleetSpecId).toBeNull();
      expect(out.claimableCallerScope.fleetSpecComparison.diverges).toBeNull();
    });

    it('per-agent spec but no fleet membership (or an explicit leave): no comparison, no fleet lookup', async () => {
      recordM.mockResolvedValue(cupRecord('solo-lane'));
      membershipM.mockResolvedValueOnce({ fleetSlug: null, fleetRole: null });

      const out = await run({ harness: 'papercup' });

      expect(out.claimableCallerScope).not.toHaveProperty('fleetSpecComparison');
      expect(recM).not.toHaveBeenCalled();
      expect(out.note).not.toContain('CALLER SPEC');
    });

    it('a failed membership read never fails the claimability read — the comparison is simply absent', async () => {
      recordM.mockResolvedValue(cupRecord('plans-start-dry-run-lane'));
      membershipM.mockRejectedValueOnce(new Error('pg down'));

      const out = await run({ harness: 'papercup' });

      expect(out.ok).toBe(true);
      expect(out.claimableCallerScope).not.toHaveProperty('fleetSpecComparison');
    });

    it('a fleet-inherited caller spec (source:fleet) never triggers the comparison', async () => {
      recordM.mockResolvedValue({ ...cupRecord('goal-fleet-lane'), source: 'fleet' as const, fleetSlug: FLEET });

      const out = await run({ harness: 'papercup' });

      expect(membershipM).not.toHaveBeenCalled();
      expect(out.claimableCallerScope).not.toHaveProperty('fleetSpecComparison');
    });
  });

  it('emits self-identifying count evidence with an explicit no-cutoff contract', async () => {
    const out = await run({ harness: 'papercup', kind: 'bug' });
    const claimable = materializeCountEvidence(out.countEvidence, 'claimable');
    const matched = materializeCountEvidence(out.countEvidence, 'matchedByFilter');

    expect(claimable).toMatchObject({
      value: 3,
      contract: {
        population: {
          id: 'current-claim-spec-issue-work-items',
          selector: { kinds: ['bug'] },
        },
        cutoff: { kind: 'none' },
        status: { id: 'claimable-for-caller' },
        writer: { id: 'readIssueClaimability+planItemLaneBlockReason' },
        unit: { id: 'canonical-work-item' },
        exactness: { status: 'exact' },
        scope: { resolvedHarness: 'papercup', caller: 'probe', callerRelative: true },
      },
    });
    expect(claimable?.contract.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(claimable?.contract.zeroMeaning).toContain('does not mean a fixed batch completed');
    expect(matched).toMatchObject({
      value: 9,
      contract: {
        metric: { id: 'matched-by-filter-count' },
        status: { id: 'filter-match-before-floors' },
        exactness: { status: 'exact' },
      },
    });
  });

  it('marks claimability as an upper bound when breakdownOnly cannot run the row-bounded plan-prose guard', async () => {
    const out = await run({ harness: 'papercup', breakdownOnly: true });
    const claimable = materializeCountEvidence(out.countEvidence, 'claimable');
    const matched = materializeCountEvidence(out.countEvidence, 'matchedByFilter');

    expect(claimable?.contract.exactness).toMatchObject({
      status: 'bounded',
      bound: 'upper',
      reason: expect.stringContaining('breakdownOnly'),
    });
    expect(matched?.contract.exactness).toEqual({ status: 'exact' });
  });

  it('EI-21834285144372521: a plan-linked row the post-claim guard would block is excluded from claimable/rows, the count is corrected, and it is surfaced in ownerGateExcluded — never checked for a plan-less row', async () => {
    laneM.mockImplementation(async ({ id }: { id?: string }) =>
      id === 'WI-B'
        ? {
            reason: `plan-item p#P-011's plan text marks it owner-gated ("owner-gated")`,
            planSlug: 'p',
            itemId: 'P-011',
            effectiveStatus: 'wip',
            // WI-7316 made this REQUIRED on PlanItemLaneBlock. `null` is the ordinary case —
            // the resolver found no contradiction — and keeps this test's assertion below
            // exact: a null hint must add NO key to the ownerGateExcluded row.
            staleBlockedHint: null,
          }
        : null,
    );

    const out = await run({ harness: 'papercup' });

    expect(out.claimable.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-C']);
    expect(out.rows.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-C']);
    expect(out.returned).toBe(2);
    expect(out.claimableCount).toBe(2); // breakdown.claimable(3) - 1 excluded
    expect(out.count).toBe(2);
    expect(out.ownerGateExcluded).toEqual([
      { id: 'WI-B', plan: 'p', reason: `plan-item p#P-011's plan text marks it owner-gated ("owner-gated")` },
    ]);
    expect(out.note).not.toContain('OVER-count'); // page was not truncated (3 rows < default limit 20)
    // Only WI-B carries a `plan`; WI-A/WI-C (plan: null) must never even reach the guard —
    // a cheap prefilter, not a wasted lookup.
    expect(laneM).toHaveBeenCalledTimes(1);
    expect(laneM).toHaveBeenCalledWith({ id: 'WI-B', harness: 'papercup', family: 'issue', payload: null });
  });

  it('EI-21834285144372521: the guard resolving null (default) leaves every row claimable — no false exclusion', async () => {
    const out = await run({ harness: 'papercup' });
    // WI-B is the only row carrying `plan`, so it is the only one checked; it resolves null.
    expect(laneM).toHaveBeenCalledTimes(1);
    expect(out.claimable.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    expect(out.claimableCount).toBe(3);
    expect(out).not.toHaveProperty('ownerGateExcluded');
  });

  it('EI-21834285144372521: a lookup error from the guard fails OPEN — the row stays claimable, same as no linkage', async () => {
    laneM.mockRejectedValue(new Error('plan read hiccup'));

    const out = await run({ harness: 'papercup' });

    expect(out.claimable.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    expect(out.claimableCount).toBe(3);
    expect(out).not.toHaveProperty('ownerGateExcluded');
  });

  describe('WI-7316: a stale-blocked exclusion must not read as a drained lane', () => {
    /** A lane-guard block whose plan item is blocked on nothing that is still unresolved. */
    const STALE_BLOCK = {
      reason: 'plan-item p#P-011 is effectively blocked',
      planSlug: 'p',
      itemId: 'P-011',
      effectiveStatus: 'blocked',
      staleBlockedHint:
        "stored status 'blocked' but every blocked-by dependency (P-004) is already resolved — clear it with plans:set-status",
    };

    it('carries the hint per-row on ownerGateExcluded and leads the note with a ⚠, even when other rows are still claimable', async () => {
      laneM.mockImplementation(async ({ id }: { id?: string }) => (id === 'WI-B' ? STALE_BLOCK : null));

      const out = await run({ harness: 'papercup' });

      expect(out.ownerGateExcluded).toEqual([
        { id: 'WI-B', plan: 'p', reason: STALE_BLOCK.reason, staleBlockedHint: STALE_BLOCK.staleBlockedHint },
      ]);
      expect(out.note).toContain('1 of the 1 excluded row(s) are gated by a plan item');
      expect(out.note).toContain('WI-B — ' + STALE_BLOCK.staleBlockedHint);
      expect(out.note).toContain('plans:set-status');
      // Two rows survived, so this is a qualification, not a verdict about the whole lane.
      expect(out.note).not.toContain('NOT DRAINED');
    });

    it('says NOT DRAINED when the stale block is why the result is empty — the case a bare claimableCount:0 hides', async () => {
      // Every returned row is plan-linked, so the guard can empty the page entirely.
      rowsValue = [{ id: 'WI-B', kind: 'change', title: 'b', status: 'open', severity: null, plan: 'p', featureOrder: 2, createdTs: 2 }];
      breakdownValue = { ...BREAKDOWN, claimable: 1 };
      mockResolvedTyped(laneM, STALE_BLOCK);

      const out = await run({ harness: 'papercup' });

      expect(out.returned).toBe(0);
      expect(out.claimableCount).toBe(0);
      expect(out.note).toContain('NOT DRAINED');
      expect(out.note).toContain('this empty result is self-inflicted');
      expect(out.note).toContain(STALE_BLOCK.staleBlockedHint);
    });

    it('stays silent when the block carries no hint — an ordinary honest block reads exactly as before', async () => {
      laneM.mockImplementation(async ({ id }: { id?: string }) =>
        id === 'WI-B'
          ? { reason: 'plan-item p#P-011 is effectively blocked (blocked-by: P-004)', planSlug: 'p', itemId: 'P-011', effectiveStatus: 'blocked', staleBlockedHint: null }
          : null,
      );

      const out = await run({ harness: 'papercup' });

      expect(out.ownerGateExcluded).toEqual([
        { id: 'WI-B', plan: 'p', reason: 'plan-item p#P-011 is effectively blocked (blocked-by: P-004)' },
      ]);
      expect(out.note).not.toContain('NOT DRAINED');
      expect(out.note).not.toContain('plans:set-status');
    });
  });

  it('a single kind narrows the filter to a `= kind` leaf', async () => {
    await run({ harness: 'papercup', kind: 'bug' });
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'kind', op: '=', value: 'bug' });
  });

  it('multiple kinds narrow the filter to an `in [kinds]` leaf', async () => {
    await run({ harness: 'papercup', kind: ['bug', 'task'] });
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'kind', op: 'in', value: ['bug', 'task'] });
  });

  it('a fleet spec (by SLUG) scopes the lane by its filter/states/rank + reports its provenance', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'myfleet',
      matchedBy: 'fleet-slug',
      record: {
        source: 'fleet',
        spec: { specId: 'bug-drain', revision: 4, view: { filter: { field: 'plan', op: '=', value: 'x' } }, states: ['open'] },
        revision: 4,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'myfleet',
      },
    } as never);
    const out = await run({ harness: 'papercup', spec: 'myfleet' });
    // resolved via the shared fleet/specId resolver under the caller's claim-spec workspace.
    expect(recM).toHaveBeenCalledWith({ spec: 'myfleet', workspaceId: 'ws-1' });
    // the spec's own filter scopes the oracle + lister; the spec + its states ride through.
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'x' });
    expect(readM.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ states: ['open'], spec: expect.objectContaining({ specId: 'bug-drain' }) }),
    );
    expect(out.spec).toEqual({
      specId: 'bug-drain',
      revision: 4,
      source: 'fleet',
      fleetSlug: 'myfleet',
      matchedBy: 'fleet-slug',
    });
  });

  it('a fleet spec resolved by its own specId (not the fleet slug) still scopes the lane + reports matchedBy', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'p2p-release',
      matchedBy: 'spec-id',
      record: {
        source: 'fleet',
        spec: { specId: 'p2p-release-lane', revision: 12, view: { filter: { field: 'plan', op: '=', value: 'y' } }, states: ['open'] },
        revision: 12,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'p2p-release',
      },
    } as never);
    const out = await run({ harness: 'papercup', spec: 'p2p-release-lane' });
    expect(recM).toHaveBeenCalledWith({ spec: 'p2p-release-lane', workspaceId: 'ws-1' });
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'y' });
    expect(out.spec).toEqual({
      specId: 'p2p-release-lane',
      revision: 12,
      source: 'fleet',
      fleetSlug: 'p2p-release',
      matchedBy: 'spec-id',
    });
  });

  it('a unique revN shorthand scopes the lane and reports revision-shorthand provenance', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'revision-fleet',
      matchedBy: 'revision-shorthand',
      record: {
        source: 'fleet',
        spec: {
          specId: 'revision-lane',
          revision: 47,
          view: { filter: { field: 'plan', op: '=', value: 'z' } },
          states: ['open'],
        },
        revision: 47,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'revision-fleet',
      },
    } as never);
    const out = await run({ harness: 'papercup', spec: 'rev47' });
    expect(recM).toHaveBeenCalledWith({ spec: 'rev47', workspaceId: 'ws-1' });
    expect(readM.mock.calls[0]![0]).toEqual({ field: 'plan', op: '=', value: 'z' });
    expect(out.spec).toEqual({
      specId: 'revision-lane',
      revision: 47,
      source: 'fleet',
      fleetSlug: 'revision-fleet',
      matchedBy: 'revision-shorthand',
    });
  });

  it('an unrecognized `spec` (neither namespace matches) ERRORS with candidates — never falls back to the whole backlog', async () => {
    mockResolvedTyped(recM, null);
    mockResolvedTyped(candM, [{ fleetSlug: 'p2p-release', specId: 'p2p-release-lane', revision: 12 }]);
    const out = await run({ harness: 'papercup', spec: 'bogus-spec' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no unique fleet or claim-spec named 'bogus-spec'/);
    expect(out.candidates).toEqual([{ fleetSlug: 'p2p-release', specId: 'p2p-release-lane', revision: 12 }]);
    // never widened to the unfiltered lane — the snapshot read was never even issued.
    expect(readM).not.toHaveBeenCalled();
    // no revN shape in the caller's spec — candidates come from the general (unfiltered) window.
    expect(candM).toHaveBeenCalledWith({ workspaceId: 'ws-1', revision: undefined });
  });

  it('an AMBIGUOUS revN shorthand ERRORS with candidates filtered to the true match set for that revision — EI-21857753284071679', async () => {
    // resolveFleetClaimSpec rejects `rev13` as ambiguous (>=2 live fleet specs at revision 13).
    mockResolvedTyped(recM, null);
    // The general most-recently-updated-20 window only surfaces ONE of the (actually 3) live
    // revision-13 fleets — that's the exact bug: listFleetClaimSpecCandidates must be called
    // WITH revision:13 so the full match set (the real cause of the ambiguity) is returned.
    mockResolvedTyped(candM, [
      { fleetSlug: 'goal-drain-work-on-everything-070565', specId: null, revision: 13 },
      { fleetSlug: 'nonp2p-bug-drain-0816', specId: null, revision: 13 },
      { fleetSlug: 'p2p-parity-lanes', specId: null, revision: 13 },
    ]);
    const out = await run({ harness: 'papercup', spec: 'rev13' });
    expect(out.ok).toBe(false);
    expect(candM).toHaveBeenCalledWith({ workspaceId: 'ws-1', revision: 13 });
    expect(out.candidates).toHaveLength(3);
    // the error explains WHY 3 candidates at one revision means "ambiguous", not "broken".
    expect(out.error).toMatch(/filtered to every live fleet spec currently at revision 13/);
    expect(readM).not.toHaveBeenCalled();
  });

  it('spec ∧ kind AND-combine into one filter tree', async () => {
    recM.mockResolvedValue({
      fleetSlug: 'f',
      matchedBy: 'fleet-slug',
      record: {
        source: 'fleet',
        spec: { specId: 's', revision: 1, view: { filter: { field: 'plan', op: '=', value: 'x' } }, states: ['open'] },
        revision: 1,
        updatedBy: null,
        updatedAt: null,
        harnessSlug: null,
        fleetSlug: 'f',
      },
    } as never);
    await run({ harness: 'papercup', spec: 'f', kind: 'bug' });
    expect(readM.mock.calls[0]![0]).toEqual({
      all: [
        { field: 'plan', op: '=', value: 'x' },
        { field: 'kind', op: '=', value: 'bug' },
      ],
    });
  });

  it('breakdownOnly skips the row lister entirely and returns an empty list + the count', async () => {
    const out = await run({ harness: 'papercup', breakdownOnly: true });
    expect(readM.mock.calls[0]![2]).toEqual(expect.objectContaining({ breakdownOnly: true }));
    expect(out.claimable).toEqual([]);
    expect(out.returned).toBe(0);
    expect(out.claimableCount).toBe(3); // the count still comes from the oracle
  });

  it('threads explicit states + limit through to both primitives', async () => {
    await run({ harness: 'papercup', states: ['open', 'failing'], limit: 5 });
    expect(readM.mock.calls[0]![1]).toEqual(expect.objectContaining({ states: ['open', 'failing'] }));
    expect(readM.mock.calls[0]![2]).toEqual(expect.objectContaining({ limit: 5 }));
  });

  it('EI-21667003842480166: accepts and threads rigAvailable so rig-equipped callers see the same floor as scheduler:get_next', async () => {
    const parsed = (tool.args as { safeParse: (value: unknown) => { success: boolean } }).safeParse({
      harness: 'papercup',
      rigAvailable: true,
    });
    expect(parsed.success).toBe(true);

    await run({ harness: 'papercup', rigAvailable: true });
    expect(readM.mock.calls[0]![1]).toEqual(expect.objectContaining({ rigAvailable: true }));
  });

  it('EI-22390504942653694: rejects includeObservations deliberately and routes observation reads to curation/exclusion surfaces', () => {
    // `claimable` is a verdict over rows that survive every claim floor. Observation-lane
    // rows are a permanent floor by design, so accepting this sibling list/search flag would
    // either lie that notes are work or silently ignore the caller's request.
    const parsed = (tool.args as { safeParse: (value: unknown) => { success: boolean } }).safeParse({
      harness: 'papercup',
      includeObservations: true,
    });
    expect(parsed.success).toBe(false);

    const notWhen = tool.guidance?.notWhen ?? '';
    expect(notWhen).toContain('`includeObservations` is intentionally unsupported');
    expect(notWhen).toContain('observation-lane rows are never claimable');
    expect(notWhen).toContain('work_items:list/work_items:search { includeObservations:true }');
    expect(notWhen).toContain('sampleExcluded');
    expect(notWhen).toContain('observationLane');
  });

  describe('WI-6673: admittedBreakdown + the composition warning', () => {
    it('surfaces admittedBreakdown UNCONDITIONALLY — no opt-in flag, because the failure is quoting a count without asking what is in it', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.admittedBreakdown).toEqual(HEALTHY_ADMITTED);
    });

    it('is present under breakdownOnly too — the cheap read is exactly where a caller quotes a bare number', async () => {
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      expect(out.admittedBreakdown).toEqual(HEALTHY_ADMITTED);
    });

    it('a HEALTHY pool gets NO composition warning — a warning that cries wolf is ignored when it matters', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.note).not.toMatch(/COMPOSITION WARNING/);
      expect(out.note).toMatch(/authoritative for THIS CALLER/); // the base, caller-scoped note still lands
    });

    it('a DEGENERATE pool appends the warning, naming the share, the burst day and the item id', async () => {
      admittedValue = {
        total: 12_729,
        byKind: { change: 12_729 },
        bySeverity: { nit: 11_584, minor: 980, major: 165 },
        lowSeverityShare: 12_564 / 12_729,
        degenerate: true,
        peakDay: { day: '2026-07-31', count: 9_312 },
      };
      const out = await run({ harness: 'papercup' });
      expect(out.note).toMatch(/⚠ COMPOSITION WARNING/);
      // EI-22184028605968917: counts first, then a FLOORED percentage — 98.70% renders as
      // 98.7, and the 165 major rows stay visible in the sentence, not just in the buckets.
      expect(out.note).toContain('12564 of 12729 row(s) in this lane (98.7%) are nit/minor severity');
      expect(out.note).toContain('9312 of them were filed on a single day (2026-07-31)');
      expect(out.note).toContain('is NOT a workload');
      expect(out.note).toContain('WI-6673');
    });

    it('a degenerate pool with no peakDay still warns — the day clause is optional, the warning is not', async () => {
      admittedValue = {
        total: 900,
        byKind: { change: 900 },
        bySeverity: { nit: 900 },
        lowSeverityShare: 1,
        degenerate: true,
        peakDay: null,
      };
      const out = await run({ harness: 'papercup' });
      expect(out.note).toMatch(/⚠ COMPOSITION WARNING/);
      // 100% is reachable — but only because the non-low population really IS empty here.
      expect(out.note).toContain('900 of 900 row(s) in this lane (100%) are nit/minor severity');
      expect(out.note).not.toContain('filed on a single day');
    });

    it('REGRESSION (EI-22184028605968917): a lane with major-severity rows can never print 100%', async () => {
      // The measured payload: 2018 minor + 345 nit + 3 major = 2366, share 99.873%.
      // `Math.round(share * 100)` printed "100% of this lane is nit/minor severity",
      // erasing the only three rows in the lane that were actual workload — and that
      // rounded sentence propagated into a plan Decision as a durable claim.
      admittedValue = {
        total: 2_366,
        byKind: { change: 2_366 },
        bySeverity: { major: 3, minor: 2_018, nit: 345 },
        lowSeverityShare: 2_363 / 2_366,
        degenerate: true,
        peakDay: null,
      };
      const out = await run({ harness: 'papercup' });
      expect(out.note).toContain('2363 of 2366 row(s) in this lane (99.8%) are nit/minor severity');
      expect(out.note).not.toContain('100%');
    });

    it('the warning rides on `note`, where a caller reading the count cannot miss it — not a field they must know to ask for', async () => {
      admittedValue = { ...HEALTHY_ADMITTED, degenerate: true, lowSeverityShare: 0.91, peakDay: null };
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      // Same read that returns claimableCount carries the caveat about claimableCount.
      expect(out.claimableCount).toBe(3);
      expect(out.note).toMatch(/COMPOSITION WARNING/);
    });
  });

  describe('EI-16028: affinity path coverage guard', () => {
    it('surfaces the full claimable denominator and path-bearing count, including the 50% floor', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.affinityCoverage).toEqual({ denominator: 3, nonEmptyPaths: 2, floor: 0.5, belowFloor: false });
      expect(out.note).not.toMatch(/AFFINITY PATH COVERAGE WARNING/);
    });

    it('puts a below-floor warning on the same note as the claimable count', async () => {
      BREAKDOWN.affinityCoverage = { denominator: 3, nonEmptyPaths: 1, floor: 0.5, belowFloor: true };
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      expect(out.affinityCoverage).toEqual({ denominator: 3, nonEmptyPaths: 1, floor: 0.5, belowFloor: true });
      expect(out.note).toContain('⚠ AFFINITY PATH COVERAGE WARNING');
      expect(out.note).toContain('1/3 claimable row(s)');
      expect(out.note).toContain('50% floor');
    });
  });

  it('omitting sampleExcluded skips the sampler entirely and omits excludedSample from the payload', async () => {
    const out = await run({ harness: 'papercup' });
    expect(readM.mock.calls[0]![2]!.sampleLimit).toBeUndefined();
    expect(out.excludedSample).toBeUndefined();
  });

  it('documents the sampleExcluded limit that its schema enforces', () => {
    const argsSchema = tool.args as unknown as {
      shape: { sampleExcluded: { description?: string } };
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(argsSchema.shape.sampleExcluded.description).toContain(
      'Valid values are 1 through 10 (maximum 10 ids per floor).',
    );
    expect(argsSchema.safeParse({ harness: 'papercup', sampleExcluded: 10 }).success).toBe(true);
    expect(argsSchema.safeParse({ harness: 'papercup', sampleExcluded: 11 }).success).toBe(false);
  });

  it('distinguishes ordinary-claim review exclusions from pending reviewer candidates', () => {
    const description = String(tool.description ?? '');
    expect(description).toContain('`excludedSample.agentReview`');
    expect(description).toContain('can include `revision-requested` reviews');
    expect(description).toContain('`excludedSample.queueControl.agentReview`');
    expect(description).toContain('pending reviewer candidates only');
  });

  it('names spec as the fleet selector and rejects the historical fleet argument', () => {
    const argsSchema = tool.args as unknown as { safeParse: (value: unknown) => { success: boolean } };
    const description = String(tool.description ?? '');
    const when = String(tool.guidance?.when ?? '');
    expect(description).toContain("Fleet scoping uses `spec:'<fleet-slug>'`");
    expect(description).toContain('this tool has no `fleet` argument');
    expect(when).toContain("pass `spec:'<fleet-slug>'`");
    expect(when).toContain('`fleet` is not an argument here');
    expect(argsSchema.safeParse({ harness: 'papercup', spec: 'enterprise-readiness' }).success).toBe(true);
    expect(argsSchema.safeParse({ harness: 'papercup', fleet: 'enterprise-readiness' }).success).toBe(false);
  });

  it('sampleExcluded rides through as sampleLimit on the SAME snapshot read + surfaces excludedSample', async () => {
    sampleValue = {
      ...EMPTY_SAMPLE,
      taken: ['WI-1', 'WI-2'],
      claimHold: ['WI-3'],
      queueControl: {
        ...EMPTY_QUEUE_CONTROL_SAMPLE,
        durableParks: [{
          id: 'WI-3',
          parker: 'su-park',
          reason: 'release once P-003 lands',
          parkedAt: null,
          age: { status: 'missing', ageMs: null, bucket: 'unknown' },
          unparkCondition: { status: 'stated', text: 'release once P-003 lands' },
          releaseLiveness: { status: 'unverified' },
        }],
      },
    };
    const out = await run({ harness: 'papercup', kind: 'bug', sampleExcluded: 5 });
    expect(readM).toHaveBeenCalledWith(
      { field: 'kind', op: '=', value: 'bug' },
      expect.objectContaining({ harness: 'papercup', assignee: 'probe' }),
      expect.objectContaining({ sampleLimit: 5 }),
    );
    expect(out.excludedSample.taken).toEqual(['WI-1', 'WI-2']);
    expect(out.excludedSample.claimHold).toEqual(['WI-3']);
    expect(out.excludedSample.queueControl.durableParks[0]).toMatchObject({
      id: 'WI-3',
      parker: 'su-park',
      age: { status: 'missing', bucket: 'unknown' },
      unparkCondition: { status: 'stated' },
    });
  });

  it('EI-25283593910350444: breakdownOnly still returns the requested excluded sample', async () => {
    const reviewRow = {
      id: 'WI-4',
      status: 'pending',
      submittedBy: 'su-submitter',
      ledgerIdeaId: 'idea-4',
      round: 1,
    };
    sampleValue = {
      ...EMPTY_SAMPLE,
      queueControl: {
        ...EMPTY_QUEUE_CONTROL_SAMPLE,
        agentReview: [reviewRow],
      },
    };

    const out = await run({ harness: 'papercup', kind: 'bug', breakdownOnly: true, sampleExcluded: 5 });

    expect(readM).toHaveBeenCalledWith(
      { field: 'kind', op: '=', value: 'bug' },
      expect.objectContaining({ harness: 'papercup', assignee: 'probe' }),
      expect.objectContaining({ breakdownOnly: true, sampleLimit: 5 }),
    );
    expect(out.claimable).toEqual([]);
    expect(out.excludedSample.queueControl.agentReview).toEqual([reviewRow]);
  });

  it('keeps revision-requested review rows in the excluded sample, not the claimable rows', async () => {
    const reviewRow = {
      id: 'EI-review-revision-requested',
      status: 'revision-requested',
      submittedBy: 'su-author',
      ledgerIdeaId: 'idea-revision-requested',
      round: 1,
    };
    sampleValue = {
      ...EMPTY_SAMPLE,
      queueControl: {
        ...EMPTY_QUEUE_CONTROL_SAMPLE,
        agentReview: [reviewRow],
      },
    };

    const out = await run({ harness: 'papercup', kind: 'bug', sampleExcluded: 5 });

    expect(out.claimable.map((row: { id: string }) => row.id)).not.toContain(reviewRow.id);
    expect(out.excludedSample.queueControl.agentReview).toEqual([reviewRow]);
  });

  it('WI-5947: the counts, the rows and the sample come from ONE read — the handler never issues them separately', async () => {
    await run({ harness: 'papercup', sampleExcluded: 3 });
    // Three independent round-trips presented as one verdict is the defect; one call is the fix.
    expect(readM).toHaveBeenCalledTimes(1);
  });

  describe('EI-18835176695181727: rows/count aliases', () => {
    it('exposes `rows` as an alias of `claimable` and `count` as an alias of `claimableCount`', async () => {
      const out = await run({ harness: 'papercup' });
      expect(out.rows).toEqual(out.claimable);
      expect(out.count).toBe(out.claimableCount);
      expect(out.count).toBe(3);
      expect(out.rows.map((r: { id: string }) => r.id)).toEqual(['WI-A', 'WI-B', 'WI-C']);
    });

    it('the aliases stay correct under breakdownOnly (empty rows, count still the oracle total)', async () => {
      const out = await run({ harness: 'papercup', breakdownOnly: true });
      expect(out.rows).toEqual([]);
      expect(out.count).toBe(3);
    });
  });
});
