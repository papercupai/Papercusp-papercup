import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getNextForBee: vi.fn(),
  getClaimTimeIndependenceAdvisory: vi.fn(),
  getClaimTimePremises: vi.fn(),
  getClaimTimePriorAttemptBrief: vi.fn(),
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

vi.mock('../coordination/context-pressure', () => ({
  fetchContextPressure: vi.fn(async () => new Map()),
  // get_next's preflight reads fetchContextPressureReadings; without it the preflight
  // degrades to its fallback and this success-path test sees no claim (red since 2026-10-13).
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

vi.mock('../../work-item-prior-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-item-prior-work')>()),
  getClaimTimePriorWorkHint: vi.fn(async () => null),
  priorWorkWarning: vi.fn(() => null),
}));

vi.mock('../../plan-decisions-claim-port', () => ({
  getClaimTimePlanDecisions: vi.fn(async () => null),
  renderPlanDecisionsNote: vi.fn(() => null),
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

vi.mock('../../behavior-contract-claim-port', () => ({
  getClaimTimeBehaviorContract: vi.fn(async () => null),
}));

vi.mock('../../stale-path-hints-claim-port', () => ({
  getClaimTimeStalePathAdvisory: vi.fn(async () => null),
}));

vi.mock('../../work-item-plan-item-landed', () => ({
  getClaimTimePlanItemLanded: vi.fn(async () => null),
  planItemLandedWarning: vi.fn(() => null),
}));

vi.mock('../../sibling-path-overlap-claim-port', () => ({
  getClaimTimeSiblingPathOverlap: vi.fn(async () => null),
  siblingPathOverlapWarning: vi.fn(() => null),
}));

vi.mock('../../source-citation-claim-port', () => ({
  getClaimTimeSourceCitation: vi.fn(async () => null),
  sourceCitationWarning: vi.fn(() => null),
}));

vi.mock('../../independence-claim-port', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../independence-claim-port')>()),
  getClaimTimeIndependenceAdvisory: mocks.getClaimTimeIndependenceAdvisory,
}));

import getNextTool, { assembleSchedulerClaimResult } from './get_next';
import type { AcceptanceAuthorIdentityOpts } from '../../acceptance-author-identity';
import {
  foldIndependenceContributors,
  foldIndependenceSubjects,
  parseRequiresIndependenceFrom,
  renderIndependenceWarning,
} from '../../independence-claim-port';

type ToolDef = {
  handler: (
    args: unknown,
    ctx?: unknown,
  ) => Promise<{ content?: Array<{ text: string }>; data?: Record<string, unknown> }>;
};

const callGetNext = (ctx: unknown = {}) =>
  (getNextTool as unknown as ToolDef).handler({ harness: 'papercusp' }, ctx);

describe('claim-time independence advisory', () => {
  beforeEach(() => {
    mocks.getFlag.mockResolvedValue(true);
    mocks.resolveAgentIdentity.mockReturnValue({ ownerId: 'su-claimant', workspaceId: 'ws-test' });
    mocks.resolveClaimSpecWorkspace.mockReturnValue('ws-test');
    mocks.getNextForBee.mockReset();
    mocks.getClaimTimeIndependenceAdvisory.mockReset().mockResolvedValue(null);
    mocks.getClaimTimePremises.mockReset().mockResolvedValue(null);
    mocks.getClaimTimePriorAttemptBrief.mockReset().mockResolvedValue(null);
  });

  it('normalizes explicit work-item, decision, plan, and path marker spellings', () => {
    expect(
      parseRequiresIndependenceFrom({
        requiresIndependenceFrom: {
          workItems: ['WI-100'],
          decisions: [{ planSlug: 'plan-a', decisionId: 'D-004' }],
          plans: ['plan-b'],
          paths: ['packages/example.ts'],
        },
      }),
    ).toEqual({
      workItems: ['WI-100'],
      decisions: ['plan-a#D-004'],
      plans: ['plan:plan-b'],
      paths: ['path:packages/example.ts'],
    });
  });

  it('folds post-claim rows without treating the current claim as prior work', () => {
    const marker = parseRequiresIndependenceFrom({ requiresIndependenceFrom: ['WI-100'] })!;
    const subjects = foldIndependenceSubjects(marker);
    expect(
      foldIndependenceContributors(
        subjects,
        [
          {
            subject_kind: 'work-item',
            subject_ref: 'WI-100',
            taken_by: 'su-claimant',
            terminal_owner: 'su-prior',
            last_released_by: null,
            worked_by_history: ['su-prior', 'su-claimant'],
          },
        ],
        'su-claimant',
      ),
    ).toMatchObject({
      contributors: [
        { contributorId: 'su-prior', evidence: 'terminal_owner' },
        { contributorId: 'su-prior', evidence: 'worked_by_history' },
      ],
      unresolvedSubjects: [],
    });
  });

  it('renders a warning only when the claimant is in the recorded contributor lineage', async () => {
    const lookup = vi.fn(async (subjects: readonly { kind: string; ref: string }[], opts: { workspaceId: string; harness?: string | null }) => {
      expect(subjects).toEqual([{ kind: 'work-item', ref: 'WI-100' }]);
      expect(opts).toEqual({ workspaceId: 'ws-test', harness: 'papercusp' });
      return [
        {
          subject_kind: 'work-item' as const,
          subject_ref: 'WI-100',
          taken_by: 'su-prior',
          terminal_owner: null,
          last_released_by: null,
          worked_by_history: [],
        },
      ];
    });
    const lineageRelated = vi.fn(
      async (
        first: string | null | undefined,
        second: string | null | undefined,
        _opts?: AcceptanceAuthorIdentityOpts,
      ) => first === 'su-claimant' && second === 'su-prior',
    );

    const actualIndependence = await vi.importActual<typeof import('../../independence-claim-port')>(
      '../../independence-claim-port',
    );
    const advisory = await actualIndependence.getClaimTimeIndependenceAdvisory({
      workItem: {
        id: 'EI-claim',
        harness: 'papercusp',
        payload: { requiresIndependenceFrom: ['WI-100'] },
      },
      claimant: 'su-claimant',
      workspaceId: 'ws-test',
      lookup,
      lineageRelated,
    });

    expect(advisory?.requiresIndependenceFrom).toEqual({
      workItems: ['WI-100'],
      decisions: [],
      plans: [],
      paths: [],
    });
    expect(advisory?.independenceWarning).toContain('INDEPENDENCE CONFLICT');
    expect(advisory?.independenceWarning).toContain('WI-100 (su-prior)');
    expect(renderIndependenceWarning('su-claimant', [])).toBeNull();
    expect(lineageRelated).toHaveBeenCalledWith('su-claimant', 'su-prior', { workspaceId: 'ws-test' });
  });

  it('assembles the marker and warning as advisory response fields', () => {
    expect(
      assembleSchedulerClaimResult({
        workItem: { id: 'EI-claim' },
        claimedUnder: { specId: 'spec', revision: 1 },
        requiresIndependenceFrom: { workItems: ['WI-100'], decisions: [], plans: [], paths: [] },
        independenceWarning: 'advisory only',
      }),
    ).toMatchObject({
      ok: true,
      claimReceipt: { committed: true, workItemId: 'EI-claim' },
      requiresIndependenceFrom: { workItems: ['WI-100'] },
      independenceWarning: 'advisory only',
    });
  });

  it('wires the fail-soft advisory into a successful scheduler claim without changing claim state', async () => {
    const advisory = {
      requiresIndependenceFrom: { workItems: ['WI-100'], decisions: [], plans: [], paths: [] },
      independenceWarning: 'advisory only',
    };
    mocks.getClaimTimeIndependenceAdvisory.mockResolvedValue(advisory);
    mocks.getNextForBee.mockResolvedValue({
      workItem: {
        id: 'EI-claim',
        state: 'open',
        kind: 'task',
        harness: 'papercusp',
        payload: { requiresIndependenceFrom: ['WI-100'] },
      },
      claimedUnder: { specId: 'spec', revision: 1 },
      specSource: 'fleet',
    });

    const out = await callGetNext();

    expect(out.data).toMatchObject({
      ok: true,
      claimReceipt: { committed: true, workItemId: 'EI-claim' },
      requiresIndependenceFrom: advisory.requiresIndependenceFrom,
      independenceWarning: advisory.independenceWarning,
    });
    expect(mocks.getClaimTimeIndependenceAdvisory).toHaveBeenCalledWith({
      workItem: {
        id: 'EI-claim',
        payload: { requiresIndependenceFrom: ['WI-100'] },
        harness: 'papercusp',
        sourcePlanSlug: undefined,
        sourcePlanItemIds: undefined,
      },
      claimant: 'su-claimant',
      workspaceId: 'ws-test',
    });
  });
});
