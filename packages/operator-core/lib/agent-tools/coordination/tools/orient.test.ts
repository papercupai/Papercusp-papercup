import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  composeOrient,
  extractRecoveredFleetScope,
  orientServedDelta,
  bindOrientOutputResult,
  composeSelectedOrientModes,
  orientModeContractsInContext,
  orientRoleFolds,
  assembleOrientOutput,
  ORIENT_AGGREGATE_TIMEOUT_MS,
  ORIENT_PREFLIGHT_LEG_TIMEOUT_MS,
  withOrientAggregateTimeout,
  createOrientAggregateFallback,
  snapshotOrientAggregate,
  summarizeLaneClaim,
  ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
  ORIENT_FLEET_HEALTH_SCHEMA_VERSION,
  ORIENT_MEMORY_NOTE,
  ORIENT_DEEP_WORK_NOTE,
  ORIENT_CROSS_WORKSPACE_FOLD_TOOL_NAMES,
  ORIENT_FOLD_TOOL_NAMES,
  shouldActivateOrientToolSurface,
} from './orient';
import orientTool from './orient';
import { FLEET_DELTA_SCHEMA_VERSION, fingerprintFleet } from './fleet-monitor-delta';
import type { InnerCall } from '../../_compound-dispatch';
import type { GoalPortfolioBrief } from '../../../goal-launch-settings';
import { lookupByMcpName, runToolOrchestration, type ProjectedTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { createPhaseTracker } from '@papercusp/tooldef';
import { MCP_TRANSPORT_CAP_MS } from '../../capability/foreground-transport-cap';

// Unit handler cases do not own an org PG pool. Keep the new root SU receipt's
// targeted presence read at the module seam; dedicated tests inject a value.
vi.mock('../presence', async (original) => ({
  ...(await original<typeof import('../presence')>()),
  getPresence: vi.fn(async () => null),
}));

describe('coord:orient component receipt', () => {
  it('binds root SU from the already-read modes and matching presence assignment', async () => {
    const result = { ok: true, self: { ownerId: 'su-1' } };
    const metadata = vi.fn();
    const binder = vi.fn(async (input: { identityId: string }) => ({ identityId: input.identityId }));
    const modeRows = [{ mode: 'auto' }];
    const assignmentReader = vi.fn(async () => ({ ownerId: 'su-1', workspaceId: 'ws-1',
      intent: 'WI-9 current task', currentPlanSlug: 'plan-1', stale: false }));
    const returned = await bindOrientOutputResult(result,
      { ownerId: 'su-1', workspaceId: 'ws-1', harness: 'papercusp' }, false,
      metadata, binder as never, modeRows, assignmentReader);
    expect(returned).toBe(result);
    expect(assignmentReader).toHaveBeenCalledExactlyOnceWith('su-1');
    expect(binder).toHaveBeenCalledWith(expect.objectContaining({
      identityId: 'su', sourceTier: 'builtin', outputs: [
        { contributionId: 'coord-orientation', value: result },
        { contributionId: 'current-mode-state', value: modeRows },
        { contributionId: 'current-assignment', value: {
          ownerId: 'su-1', intent: 'WI-9 current task', currentPlanSlug: 'plan-1',
        } },
      ],
    }));
    expect(metadata).toHaveBeenCalledExactlyOnceWith({
      identityContribution: { identityId: 'su.practice' },
      rootIdentityContribution: { identityId: 'su' },
    });
  });

  it('reports unavailable root assignment without changing the public orient result', async () => {
    const result = { ok: true, self: { ownerId: 'su-1' } };
    const metadata = vi.fn();
    const binder = vi.fn(async (input: { identityId: string }) => ({ identityId: input.identityId }));
    expect(await bindOrientOutputResult(result,
      { ownerId: 'su-1', workspaceId: 'ws-1', harness: 'papercusp' }, false,
      metadata, binder as never, [{ mode: 'auto' }], async () => null)).toBe(result);
    expect(binder).not.toHaveBeenCalledWith(expect.objectContaining({ identityId: 'su' }));
    expect(metadata.mock.calls[0]![0]).toMatchObject({
      rootIdentityContribution: {
        identityId: 'su', status: 'unavailable', errorRef: 'coord:orient:root-binding-failed',
      },
    });
  });

  it('compiles the root SU orient receipt with the actual built-in identity source', async () => {
    const { bindSelectedIdentityOutputs } = await import('../../../agent-identities/source');
    const result = { ok: true, self: { ownerId: 'su-1' } };
    const metadata = vi.fn();
    expect(await bindOrientOutputResult(result,
      { ownerId: 'su-1', workspaceId: 'ws-1', harness: 'papercusp' }, false,
      metadata, bindSelectedIdentityOutputs, [{ mode: 'auto' }],
      async () => ({ ownerId: 'su-1', workspaceId: 'ws-1',
        intent: 'WI-9 current task', currentPlanSlug: 'plan-1', stale: false }))).toBe(result);
    expect(metadata.mock.calls[0]![0].rootIdentityContribution).toMatchObject({
      identityId: 'su', sourceRevision: expect.any(String),
      contributions: expect.arrayContaining([
        expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound',
          producerRef: 'papercusp.mode-state@1' }),
        expect.objectContaining({ contributionId: 'current-assignment', status: 'bound',
          producerRef: 'papercusp.current-assignment@1' }),
      ]),
    });
  });

  it('keeps the same assembled result and merges the delta marker into one metadata write', async () => {
    const result = { ok: true, inbox: { summary: { total: 2 } } };
    const metadata = vi.fn();
    const receipt = { marker: 'already-composed-orient' };
    const binder = vi.fn(async (_input: unknown) => receipt);
    const returned = await bindOrientOutputResult(
      result,
      { ownerId: 'su-1', workspaceId: 'ws-1', harness: 'papercusp' },
      true,
      metadata,
      binder as never,
    );
    expect(returned).toBe(result);
    expect(binder).toHaveBeenCalledTimes(1);
    expect(binder.mock.calls[0]![0]).toMatchObject({
      identityId: 'su.practice',
      outputs: [{ contributionId: 'coord-orientation', value: result }],
    });
    expect(metadata).toHaveBeenCalledExactlyOnceWith({
      deltaServed: true, identityContribution: receipt,
    });
  });

  it('keeps the public orient result when the component receipt is unavailable', async () => {
    const result = { ok: true, self: { ownerId: 'su-1' } };
    const metadata = vi.fn();
    const returned = await bindOrientOutputResult(
      result,
      { ownerId: 'su-1', workspaceId: 'ws-1', harness: 'papercusp' },
      false,
      metadata,
      (async () => { throw new Error('source unreadable'); }) as never,
    );
    expect(returned).toBe(result);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0]![0]).toMatchObject({
      identityContribution: { status: 'unavailable', errorRef: 'coord:orient:identity-binding-failed' },
    });
    expect(metadata.mock.calls[0]![0]).not.toHaveProperty('deltaServed');
  });
});

describe('coord:orient selected mode definitions', () => {
  const rows = [
    { mode: 'goal', reason: 'owns goal', setBy: 'owner', ownerDirected: true,
      setAt: '2026-09-24T14:00:00.000Z' },
    { mode: 'auto', reason: 'implied by goal', setBy: 'system', ownerDirected: false,
      setAt: '2026-09-24T14:00:00.000Z' },
  ];

  it('uses one selected resolver result for the already-read mode rows', async () => {
    const resolver = vi.fn(async (_ids: readonly string[]) => new Map([
      ['goal', { contract: 'SELECTED GOAL', sourceRevision: 'goal-source',
        contractRevision: 'goal-definition' }],
      ['auto', { contract: 'SELECTED AUTO', sourceRevision: 'auto-source',
        contractRevision: 'auto-definition' }],
    ]));
    const result = await composeSelectedOrientModes(rows, resolver as never);
    expect(resolver).toHaveBeenCalledExactlyOnceWith(['goal', 'auto']);
    expect(result.contracts).toBe('SELECTED GOAL\n\nSELECTED AUTO');
    expect(result.active).toMatchObject(rows);
    expect(result.definitionRevisions).toMatchObject({
      goal: { sourceRevision: 'goal-source', definitionRevision: 'goal-definition' },
      auto: { sourceRevision: 'auto-source', definitionRevision: 'auto-definition' },
    });
  });

  it('keeps active mode attribution while disclosing a stale source instead of built-in text', async () => {
    const result = await composeSelectedOrientModes(
      rows, (async () => { throw new Error('approved source changed'); }) as never,
    );
    expect(result.active).toMatchObject(rows);
    expect(result.contracts).toBe('');
    expect(result.definitionUnavailable).toBe('approved source changed');
  });

  it('replaces repeated contracts with a working mode fetch pointer only after context proof', async () => {
    const contract = 'SELECTED AUTO '.repeat(1000);
    const resolver = vi.fn(async () => new Map([['auto', {
      contract, sourceRevision: 'source', contractRevision: 'definition',
    }]]));
    const proof = vi.fn(async () => true);
    const modeRows = rows.filter((row) => row.mode === 'auto');
    const result = await composeSelectedOrientModes(modeRows, resolver as never, proof);
    expect(proof).toHaveBeenCalledExactlyOnceWith([contract]);
    expect(result).toMatchObject({ contracts: '', contractsInPrompt: true,
      contractsRefetch: 'mode:get { contracts: true }',
      active: modeRows, definitionRevisions: { auto: { sourceRevision: 'source', definitionRevision: 'definition' } } });
    expect(JSON.stringify(result).length).toBeLessThan(1000);
    // Recovery/full callers omit the proof seam and still receive every byte.
    expect((await composeSelectedOrientModes(modeRows, resolver as never)).contracts).toBe(contract);
    expect((await composeSelectedOrientModes(modeRows, resolver as never, async () => { throw new Error('DB unavailable'); })).contracts).toBe(contract);
    expect((await composeSelectedOrientModes(modeRows, resolver as never, async () => false)).contracts).toBe(contract);
  });

  it('keeps a short contract when its pointer would cost more bytes', async () => {
    const resolver = async () => new Map([['auto', { contract: '短い', sourceRevision: 'source', contractRevision: 'definition' }]]);
    const result = await composeSelectedOrientModes(rows.filter((row) => row.mode === 'auto'), resolver as never, async () => true);
    expect(result.contracts).toBe('短い');
    expect(result).not.toHaveProperty('contractsInPrompt');
  });

  const deliveredProof = {
    status: 'applied', specificationRevision: 'spec', stateRevision: 'state',
    desiredSpecificationRevision: 'spec', desiredStateRevision: 'state',
    nativeSessionId: 'native-current', appliedNativeSessionId: 'native-current',
    appliedAt: '2026-10-13T18:00:01Z', epochBumpedAt: '2026-10-13T18:00:00Z',
  };

  it('requires the exact rendered bytes for every active mode after a current-incarnation receipt', async () => {
    const readPrompt = vi.fn(async () => 'prefix\nAUTO\nGOAL\nsuffix');
    expect(await orientModeContractsInContext('owner', 'workspace', ['AUTO', 'GOAL'], {
      readProof: async () => deliveredProof, readPrompt,
    })).toBe(true);
    expect(readPrompt).toHaveBeenCalledExactlyOnceWith({ specificationRevision: 'spec', stateRevision: 'state' });
    for (const contracts of [['AUTO', 'OLD GOAL'], [''], []]) {
      expect(await orientModeContractsInContext('owner', 'workspace', contracts, {
        readProof: async () => deliveredProof, readPrompt,
      })).toBe(false);
    }
  });

  it.each([
    ['native compact after applied', { epochBumpedAt: '2026-10-13T18:00:02Z' }],
    ['prior incarnation', { appliedNativeSessionId: 'native-old' }],
    ['unknown incarnation', { nativeSessionId: '' }],
    ['pending activation', { status: 'prepared' }],
    ['changed definition', { desiredSpecificationRevision: 'new-spec' }],
    ['changed state', { desiredStateRevision: 'new-state' }],
    ['unknown epoch', { epochBumpedAt: 'invalid' }],
    ['unknown receipt time', { appliedAt: 'invalid' }],
  ])('retains full contracts when context proof fails: %s', async (_label, patch) => {
    const readPrompt = vi.fn(async () => 'AUTO');
    expect(await orientModeContractsInContext('owner', 'workspace', ['AUTO'], {
      readProof: async () => ({ ...deliveredProof, ...patch }), readPrompt,
    })).toBe(false);
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('fails open to full contracts when delivery or artifact reads are unavailable', async () => {
    for (const readProof of [async () => null, async () => { throw new Error('proof unavailable'); }]) {
      expect(await orientModeContractsInContext('owner', 'workspace', ['AUTO'], { readProof })).toBe(false);
    }
    for (const readPrompt of [async () => null, async () => { throw new Error('artifact unavailable'); }]) {
      expect(await orientModeContractsInContext('owner', 'workspace', ['AUTO'], {
        readProof: async () => deliveredProof, readPrompt,
      })).toBe(false);
    }
  });
});

// Register every orient fold so the guard checks the projected metadata, not
// merely a duplicated source-file regex. These imports intentionally mirror
// ORIENT_FOLD_TOOL_NAMES; the source-parity assertion below catches drift.
import '../../fleet/assignments';
import '../../work_items/list';
import '../../work_items/claimable';
import '../../work_items/observe';
import './inbox';
import './plan-events';
import './catch-up';
import './glance';
import './whoami';
import './walls';
import './declare-intent';
import '../../scheduler/get_claim_spec';
import '../../work_items/burn_down';
import '../../recipes/search';
import '../../fleet/leader-brief';
import '../../plans/get';
import '../../memory/search';

const foldFactsMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
// EI-18725816532600240: the narrowed (never-drop) fold is a SEPARATE IO read, so it
// needs its own mock — the real one calls the real foldFacts internally (a
// module-scope call the foldFacts mock above cannot intercept) and would attempt a
// live PG connect from a unit test.
const foldNeverDropFactsMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
// P-004 / D-006 (facts-fold census): orient.ts's FULL fold now goes through
// `foldFactsWithCensus`, which runs its own statement (fold + per-selector census in one
// window-function query) rather than calling `foldFacts` — so the `foldFacts` mock above
// is no longer on the full fold's path and, left real, this read would attempt a live PG
// connect from a unit test (the PAPERCUSP_FORBID_REAL_PG rail then throws, orient's
// fail-soft catch nulls the whole fold, and every facts assertion below reads `null`).
// Delegate to `foldFactsMock` so the existing "folded with THESE selectors/audiences"
// assertions keep observing the one IO read, and return an EMPTY census — the tests that
// assert the truncation disclosure set `census` explicitly on this mock.
const foldFactsWithCensusMock = vi.hoisted(() =>
  vi.fn(async (...args: unknown[]): Promise<{ facts: unknown[]; census: unknown[] }> => ({
    // `foldFactsMock` is declared argument-less (its cases only ever set return values), so
    // forward the real call's arguments through a widened signature — the "folded with
    // THESE selectors / audiences" assertions read them off `foldFactsMock.mock.calls`.
    facts: await (foldFactsMock as unknown as (...a: unknown[]) => Promise<unknown[]>)(...args),
    census: [],
  })),
);
// WI-39420: the eviction-disclosure leg (EI-19485000346355077) is an IO read too —
// unmocked, the real one attempts a live PG query from this unit test, throws, and
// (before orient.ts grew the leg's own fail-soft catch) the enclosing catch nulled
// the WHOLE facts fold: 9 cases here red with `facts: null` while the fold itself
// was correct. Same rule as the two folds above: only the IO reads are mocked.
const listFactEvictionDisclosuresMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
// WI-311113 focused tests must not let the read-side contest marker open a live
// PG query. The orient facts fold is deliberately best-effort in production,
// but a unit test that leaves `supersededVersionsForKeys` real can hang for the
// database driver's retry window when the shared test DB is unavailable.
const supersededVersionsForKeysMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));

// P-007: keep the PURE exports real (renderFactSrc renders the provenance-
// hydrated src the fold projection is asserted on) — only the IO reads are mocked.
vi.mock('../../../agent-facts/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-facts/store')>()),
  foldFacts: foldFactsMock,
  foldFactsWithCensus: foldFactsWithCensusMock,
  foldNeverDropFacts: foldNeverDropFactsMock,
  listFactEvictionDisclosures: listFactEvictionDisclosuresMock,
  supersededVersionsForKeys: supersededVersionsForKeysMock,
}));

// EI-18725816532600240: the facts fold is the ONLY consumer of '../watermarks' in
// orient.ts (every other cursor is injected as a parameter), so mocking it here is
// scoped to the facts `changed` marker — and it is what lets the narrowed fold's
// "must not advance the cursor" rule be asserted rather than argued.
const readWatermarkMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ cursors: Record<string, string> }> => ({ cursors: {} })),
);
const writeWatermarkMock = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));

vi.mock('../watermarks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../watermarks')>()),
  readWatermark: readWatermarkMock,
  writeWatermark: writeWatermarkMock,
}));

// EI-9270: the announced-gates fold reads the await store directly — mock it so
// (a) fake-timer tests can't hang on a real PG connect, and (b) full-mode tests
// don't pay the fold's real timeout budget. Default: no announcements.
const listActiveAnnouncementsMock = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
const countActiveAwaitsByPrefixesMock = vi.hoisted(() =>
  vi.fn(async (keys: string[]) => new Map(keys.map((key) => [key, 0]))),
);
const resolveAnnouncementOwnershipMock = vi.hoisted(() => vi.fn(async () => new Map()));

// EI-21833804434126804: handler-level aggregate-timeout coverage must drive the
// real defineTool handler without re-dispatching live tools or opening PG.
const inProcessCallMock = vi.hoisted(() => vi.fn());
const getModesMock = vi.hoisted(() => vi.fn(async () => null as unknown));
const readOwnerPresenceMock = vi.hoisted(() =>
  vi.fn(async () => ({ present: false, lastSeenAgoMs: null, activeSessions: 0 })),
);
const getFlagMock = vi.hoisted(() => vi.fn(async () => false));
const readAgentObligationAgendaMock = vi.hoisted(() => vi.fn(async () => ({ agenda: null })));
const projectAgentTurnStartObligationBriefMock = vi.hoisted(() => vi.fn(() => null));
const resolvePresenceFleetMock = vi.hoisted(() =>
  vi.fn(async () => ({ fleetSlug: null, fleetRole: null })),
);
const fetchOrientPipelineMock = vi.hoisted(() => vi.fn(async () => null as unknown));
const buildCompactionRecoveryMock = vi.hoisted(() =>
  vi.fn(async () => ({
    selfRecall: "sessions:search { session: 'self' }",
    coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
  })),
);
const acknowledgeControlTransitionMock = vi.hoisted(() => vi.fn(async () => true));
const readGovernorStateSnapshotMock = vi.hoisted(() => vi.fn(async () => null as unknown));
const recordOrientDisclosuresMock = vi.hoisted(() => vi.fn(async () => 'unchanged' as const));

vi.mock('../../_compound-dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_compound-dispatch')>()),
  inProcessCall: inProcessCallMock,
}));
vi.mock('../../../modes/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../modes/store')>()),
  getModes: getModesMock,
}));
vi.mock('../../../agent-obligation-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-obligation-reader')>()),
  readAgentObligationAgenda: readAgentObligationAgendaMock,
  projectAgentTurnStartObligationBrief: projectAgentTurnStartObligationBriefMock,
}));
vi.mock('../../../power-user-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../power-user-sessions')>()),
  readOwnerPresence: readOwnerPresenceMock,
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: getFlagMock,
}));
vi.mock('../presence-fleet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presence-fleet')>()),
  resolvePresenceFleet: resolvePresenceFleetMock,
}));
vi.mock('../pipeline-health', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline-health')>()),
  fetchOrientPipeline: fetchOrientPipelineMock,
}));
vi.mock('../compaction-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../compaction-recovery')>()),
  buildCompactionRecovery: buildCompactionRecoveryMock,
}));
vi.mock('../control-anchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../control-anchor')>()),
  acknowledgeControlTransition: acknowledgeControlTransitionMock,
}));
vi.mock('../../../resource-governor/state-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../resource-governor/state-snapshot')>()),
  readGovernorStateSnapshot: readGovernorStateSnapshotMock,
}));
vi.mock('../../../agent-orient-disclosures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-orient-disclosures')>()),
  recordOrientDisclosures: recordOrientDisclosuresMock,
}));

describe('executable continuity output assembly', () => {
  it('folds bounded probe verdicts additively ahead of supplementary orient legs', () => {
    const continuityProbes = {
      total: 1,
      executed: 1,
      truncated: 0,
      results: [{ source: { kind: 'work-item', id: 'WI-1' }, checkIndex: 0, claim: 'green', status: 'fresh' }],
    };
    const out = assembleOrientOutput({
      self: { ownerId: 'su-me' },
      recovery: { ok: true },
      continuityProbes,
      result: { ok: true, me: { summary: {} }, claimable: [], inbox: {}, memory: { hits: [] } },
    });
    expect(out.continuityProbes).toBe(continuityProbes);
    expect(Object.keys(out).indexOf('continuityProbes')).toBeLessThan(Object.keys(out).indexOf('memory'));
  });

  it('keeps the GOAL portfolio in the non-evictable core ahead of optional folds', () => {
    const goalPortfolio = { schemaVersion: 1, goal: { id: 'goal-1' } };
    const out = assembleOrientOutput({
      result: {
        ok: true,
        me: { summary: {} },
        claimable: [],
        inbox: {},
        goalPortfolio,
        memory: { query: 'x', hits: [] },
      },
    });

    expect(out.goalPortfolio).toBe(goalPortfolio);
    expect(Object.keys(out).indexOf('goalPortfolio')).toBeLessThan(Object.keys(out).indexOf('memory'));
  });
});

vi.mock('../../../events/await/store', () => ({
  listActiveAnnouncements: listActiveAnnouncementsMock,
  countActiveAwaitsByPrefixes: countActiveAwaitsByPrefixesMock,
}));
vi.mock('../../events/status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/status')>()),
  resolveAnnouncementOwnership: resolveAnnouncementOwnershipMock,
}));

// P-009 (H4): the fleet control-state fold reads the fleet registry directly
// (dynamic import) — mock the read so a fleet-caller test never attempts a real
// PG connect. Default: fleet unknown (fold absent). Pure exports stay real.
const getFleetMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
const listFleetsLedByMock = vi.hoisted(() => vi.fn(async (): Promise<Array<{ fleetSlug: string }>> => []));

vi.mock('../../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-fleets-store')>()),
  getFleet: getFleetMock,
  listFleetsLedBy: listFleetsLedByMock,
}));
vi.mock('../../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-test',
}));

beforeEach(() => {
  // mockResolvedValue does NOT reset the call log, and these mocks are module-scoped
  // across ~200 tests — so any assertion about WHETHER a fold ran (not just with what)
  // needs the log cleared per test, or it reads a predecessor's calls.
  foldFactsMock.mockClear();
  foldFactsWithCensusMock.mockClear();
  foldNeverDropFactsMock.mockClear();
  listFactEvictionDisclosuresMock.mockClear();
  supersededVersionsForKeysMock.mockClear();
  foldFactsMock.mockResolvedValue([]);
  foldNeverDropFactsMock.mockResolvedValue([]);
  listFactEvictionDisclosuresMock.mockResolvedValue([]);
  supersededVersionsForKeysMock.mockResolvedValue([]);
  readWatermarkMock.mockResolvedValue({ cursors: {} });
  writeWatermarkMock.mockClear();
  listActiveAnnouncementsMock.mockResolvedValue([]);
  countActiveAwaitsByPrefixesMock.mockClear();
  countActiveAwaitsByPrefixesMock.mockImplementation(async (keys: string[]) => new Map(keys.map((key) => [key, 0])));
  resolveAnnouncementOwnershipMock.mockClear();
  resolveAnnouncementOwnershipMock.mockResolvedValue(new Map());
  getFleetMock.mockResolvedValue(null);
  listFleetsLedByMock.mockClear();
  listFleetsLedByMock.mockResolvedValue([]);
  acknowledgeControlTransitionMock.mockClear();
  acknowledgeControlTransitionMock.mockResolvedValue(true);
});

describe('coord:orient args', () => {
  it('does not auto-activate the dynamic MCP surface for Claude Code', () => {
    expect(shouldActivateOrientToolSurface('claude')).toBe(false);
    expect(shouldActivateOrientToolSurface('codex')).toBe(true);
    expect(shouldActivateOrientToolSurface('omp')).toBe(true);
    // In-process and legacy callers retain the pre-policy behavior.
    expect(shouldActivateOrientToolSurface()).toBe(true);
    expect(shouldActivateOrientToolSurface(null)).toBe(true);
  });

  it('declares a transport budget above the flat MCP deadline for compound bootstrap work', () => {
    expect((orientTool as { timeoutSec?: number }).timeoutSec).toBe(120);
    expect((orientTool as { timeoutSec?: number }).timeoutSec).toBeGreaterThan(55);
  });

  it('fences an unresolved aggregate before the dispatcher deadline with an honest unknown fallback', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = {
      data: {
        ok: true,
        status: 'unknown' as const,
        degraded: true,
        degradedReason: 'aggregate_timeout' as const,
      },
    };

    try {
      const resultPromise = withOrientAggregateTimeout(() => new Promise<typeof fallback>(() => {}), fallback);
      expect(ORIENT_AGGREGATE_TIMEOUT_MS).toBeLessThan((orientTool as { timeoutSec: number }).timeoutSec * 1_000);

      await vi.advanceTimersByTimeAsync(ORIENT_AGGREGATE_TIMEOUT_MS);

      await expect(resultPromise).resolves.toEqual(fallback);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orient:aggregate'));
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('passes the effective parent response deadline to the aggregate work callback', async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.now();
    const callerDeadlineAtMs = startedAtMs + 20_000;
    let observedDeadlineAtMs: number | undefined;
    try {
      const value = await withOrientAggregateTimeout(
        async (deadlineAtMs) => {
          observedDeadlineAtMs = deadlineAtMs;
          return 'complete';
        },
        'fallback',
        undefined,
        callerDeadlineAtMs,
      );

      expect(value).toBe('complete');
      expect(observedDeadlineAtMs).toBe(callerDeadlineAtMs - 1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the aggregate fallback partial and preserves the latest snapshot', () => {
    const fallback = createOrientAggregateFallback();
    const snapshot = {
      ok: true,
      me: { summary: { agents: 1 } },
      claimable: [{ id: 'EI-1' }],
      inbox: { summary: { total: 2 }, entries: [{ msg_id: 'm1' }] },
    };

    snapshotOrientAggregate(fallback, snapshot);

    expect(fallback.data).toMatchObject({
      ...snapshot,
      status: 'unknown',
      degraded: true,
      degradedReason: 'aggregate_timeout',
      partial: true,
    });
  });

  it.each([-1, 0, 500])('does not start recovery when the parent has no response headroom (%s)', async (remainingMs) => {
    const fallback = createOrientAggregateFallback();
    const work = vi.fn(async () => ({ data: { complete: true } }));
    const timeout = vi.fn();
    await expect(withOrientAggregateTimeout(work, fallback, timeout, Date.now() + remainingMs)).resolves.toBe(fallback);
    expect(work).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledWith(0);
  });

  it.each([undefined, NaN, Infinity, 60_000])('never widens the aggregate ceiling for an invalid or longer parent deadline (%s)', async (remainingMs) => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = createOrientAggregateFallback();
    try {
      const deadline = remainingMs === undefined ? undefined : Date.now() + remainingMs;
      const result = withOrientAggregateTimeout(() => new Promise<typeof fallback>(() => {}), fallback, undefined, deadline);
      await vi.advanceTimersByTimeAsync(ORIENT_AGGREGATE_TIMEOUT_MS);
      await expect(result).resolves.toBe(fallback);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('returns the bounded orient snapshot through a live orchestration worker before it expires', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orient = {
      pluginName: 'fix', description: 'bounded recovery', effect: 'read', capabilities: [],
      inputSchema: { type: 'object' }, expose: { mcp: { name: 'coord:orient' } },
      fn: async (_args: unknown, ctx: UnifiedToolContext) => {
        const result = await withOrientAggregateTimeout(
          () => new Promise<ReturnType<typeof createOrientAggregateFallback>>(() => {}),
          createOrientAggregateFallback(), undefined, ctx.deadlineAtMs,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
      },
    } as ProjectedTool;
    try {
      const result = await runToolOrchestration('return await tools.coord.orient({});', {
        ctx: { signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(), role: 'su' } as UnifiedToolContext,
        deps: {}, tools: [orient], timeoutMs: 3_000,
      });
      expect(result.ok).toBe(true);
      expect(result.summary).toMatchObject({ status: 'unknown', partial: true, degradedReason: 'aggregate_timeout' });
      expect(result.detachedCalls).toBeUndefined();
      expect(result.intermediateBytes).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns the stable partial snapshot when the aggregate deadline fires', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallback = createOrientAggregateFallback();
    const snapshot = {
      ok: true,
      me: { agents: [{ ownerId: 'me' }] },
      claimable: [{ id: 'EI-1' }],
      inbox: { summary: { total: 1 }, entries: [] },
    };

    try {
      const resultPromise = withOrientAggregateTimeout(() => new Promise<typeof fallback>(() => {}), fallback);
      snapshotOrientAggregate(fallback, snapshot);

      await vi.advanceTimersByTimeAsync(ORIENT_AGGREGATE_TIMEOUT_MS);

      await expect(resultPromise).resolves.toBe(fallback);
      expect(fallback.data).toMatchObject({
        me: snapshot.me,
        claimable: snapshot.claimable,
        inbox: snapshot.inbox,
        partial: true,
      });
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not wait for disclosure recording after afterCompaction composition', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ownerId = 'su-orient-handler-test';
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      control: { generation: 5 },
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };

    inProcessCallMock.mockReturnValue(async (name: string) => {
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error(`unexpected sub-call: ${name}`);
    });
    getModesMock.mockResolvedValue(null);
  readAgentObligationAgendaMock.mockClear();
  projectAgentTurnStartObligationBriefMock.mockClear();
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    readGovernorStateSnapshotMock.mockResolvedValue(null);
    // This optional background fold must not delay assembly of the useful
    // afterCompaction snapshot.
    // Signal from the mock instead of guessing how many microtasks/dynamic imports
    // the real handler needs before reaching this late fold.
    let disclosuresStartedResolve!: () => void;
    const disclosuresStarted = new Promise<void>((resolve) => {
      disclosuresStartedResolve = resolve;
    });
    recordOrientDisclosuresMock.mockImplementation(() => {
      disclosuresStartedResolve();
      return new Promise(() => {});
    });

    const resultPromise = orientTool.handler(
      {
        afterCompaction: true,
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'su',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
      } as never,
    );

    try {
      await disclosuresStarted;
      expect(recordOrientDisclosuresMock).toHaveBeenCalledWith(
        ownerId,
        'ws-test',
        expect.any(Object),
      );
      const result = (await resultPromise) as { data: Record<string, unknown> };

      expect(result.data).toMatchObject({
        recovery,
        me: {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        },
        claimable: [],
      });
      expect(result.data.degradedReason).not.toBe('aggregate_timeout');
      expect(result.data.partial).not.toBe(true);
      expect(acknowledgeControlTransitionMock).toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('orient:aggregate'));
    } finally {
      recordOrientDisclosuresMock.mockReset();
      recordOrientDisclosuresMock.mockResolvedValue('unchanged');
      acknowledgeControlTransitionMock.mockClear();
      inProcessCallMock.mockReset();
      getModesMock.mockReset();
      getModesMock.mockResolvedValue(null);
      readOwnerPresenceMock.mockReset();
      readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
      getFlagMock.mockReset();
      getFlagMock.mockResolvedValue(false);
      resolvePresenceFleetMock.mockReset();
      resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
      fetchOrientPipelineMock.mockReset();
      fetchOrientPipelineMock.mockResolvedValue(null);
      buildCompactionRecoveryMock.mockReset();
      buildCompactionRecoveryMock.mockResolvedValue(recovery);
      readGovernorStateSnapshotMock.mockReset();
      readGovernorStateSnapshotMock.mockResolvedValue(null);
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not wait for disclosure recording after an early preflight stall', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ownerId = 'su-orient-preflight-timeout-test';

    inProcessCallMock.mockReturnValue(async (name: string) => {
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error(`unexpected sub-call: ${name}`);
    });
    getModesMock.mockResolvedValue(null);
    // Before this regression fix, this unbounded preflight read prevented
    // composeOrient from ever reaching its first progress snapshot.
    readOwnerPresenceMock.mockImplementation(() => new Promise(() => {}));
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      control: { generation: 5 },
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    readGovernorStateSnapshotMock.mockResolvedValue(null);

    let disclosuresStartedResolve!: () => void;
    const disclosuresStarted = new Promise<void>((resolve) => {
      disclosuresStartedResolve = resolve;
    });
    recordOrientDisclosuresMock.mockImplementation(() => {
      disclosuresStartedResolve();
      return new Promise(() => {});
    });

    const resultPromise = orientTool.handler(
      {
        afterCompaction: true,
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'su',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
      } as never,
    );

    try {
      await vi.advanceTimersByTimeAsync(ORIENT_PREFLIGHT_LEG_TIMEOUT_MS);
      await disclosuresStarted;
      const result = (await resultPromise) as { data: Record<string, unknown> };

      expect(result.data).toMatchObject({
        recovery,
        me: {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        },
        claimable: [],
      });
      expect(result.data.degradedReason).not.toBe('aggregate_timeout');
      expect(result.data.partial).not.toBe(true);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('orient:aggregate'));
    } finally {
      recordOrientDisclosuresMock.mockReset();
      recordOrientDisclosuresMock.mockResolvedValue('unchanged');
      acknowledgeControlTransitionMock.mockClear();
      inProcessCallMock.mockReset();
      getModesMock.mockReset();
      getModesMock.mockResolvedValue(null);
      readOwnerPresenceMock.mockReset();
      readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
      getFlagMock.mockReset();
      getFlagMock.mockResolvedValue(false);
      resolvePresenceFleetMock.mockReset();
      resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
      fetchOrientPipelineMock.mockReset();
      fetchOrientPipelineMock.mockResolvedValue(null);
      readGovernorStateSnapshotMock.mockReset();
      readGovernorStateSnapshotMock.mockResolvedValue(null);
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('acknowledges the recovered control generation after a successful afterCompaction assembly', async () => {
    acknowledgeControlTransitionMock.mockClear();
    const ownerId = 'su-orient-handler-success-test';
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      control: { generation: 5 },
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };

    inProcessCallMock.mockReturnValue(async (name: string) => {
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error(`unexpected sub-call: ${name}`);
    });
    getModesMock.mockResolvedValue(null);
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    readGovernorStateSnapshotMock.mockResolvedValue(null);

    const result = (await orientTool.handler(
      {
        afterCompaction: true,
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'su',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
      } as never,
    )) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({ ok: true, recovery });
    expect(recordOrientDisclosuresMock).toHaveBeenCalledWith(
      ownerId,
      'ws-test',
      expect.any(Object),
    );
    expect(acknowledgeControlTransitionMock).toHaveBeenCalledWith(ownerId, 'ws-test', 5);
  });

  // papercusp-performance-audit-2026-10-12 P-001 (PERF-P001-PHASES): orient must track
  // its phases on the DISPATCHER's per-call tracker (ctx.phases), because only that
  // tracker is persisted into tool_invocations.metadata_json.handlerPhases. A private
  // tracker would time the phases and then drop them on every completed call.
  it('tracks its named phases on the dispatcher tracker passed as ctx.phases', async () => {
    const ownerId = 'su-orient-handler-phases-test';
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      control: { generation: 7 },
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };
    inProcessCallMock.mockReturnValue(async (name: string) => {
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error(`unexpected sub-call: ${name}`);
    });
    getModesMock.mockResolvedValue(null);
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    readGovernorStateSnapshotMock.mockResolvedValue(null);

    const phases = createPhaseTracker();
    const result = (await orientTool.handler(
      {
        afterCompaction: true,
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'su',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
        phases,
      } as never,
    )) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({ ok: true });
    const tracked = phases.intervals().map((p) => p.phase);
    expect(tracked).toEqual(
      expect.arrayContaining([
        'handler:preflight',
        'composeOrient',
        'handler:compactionRecovery',
      'background:recordOrientDisclosures',
        'handler:acknowledgeControlTransition',
        'handler:bindOutputResult',
      ]),
    );
    const record = phases.toMetadata();
    expect(record).toMatchObject({ schemaVersion: 'handler-phases-v1', pending: [] });
    expect(record!.phases.length).toBe(tracked.length);
  });

  it('keeps Judge assignment reads self-scoped afterCompaction even when a fleet route is recovered', async () => {
    const ownerId = 'judge-orient-handler-scope-test';
    const nestedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      control: { state: { route: { kind: 'fleet', fleet: 'orch-unify', role: 'member' } } },
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };

    inProcessCallMock.mockReturnValue(async (name: string, args: Record<string, unknown>) => {
      nestedCalls.push({ name, args });
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error('unexpected sub-call: ' + name);
    });
    getModesMock.mockResolvedValue(null);
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    readGovernorStateSnapshotMock.mockResolvedValue(null);

    const result = (await orientTool.handler(
      {
        afterCompaction: true,
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'judge',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
      } as never,
    )) as { data: Record<string, unknown> };

    const assignmentCall = nestedCalls.find((entry) => entry.name === 'fleet:assignments');
    expect(assignmentCall?.args).toEqual({ agent: 'self' });
    expect(result.data).toMatchObject({
      recoveredFleetScope: {
        fleet: 'orch-unify',
        role: 'member',
        note: expect.stringContaining('role-specific scope'),
      },
    });
  });

  it('uses the full-roster snapshot for a recovered member afterCompaction read', async () => {
    const ownerId = 'su-orient-handler-snapshot-test';
    const nestedCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      control: { state: { route: { kind: 'fleet', fleet: 'orch-unify', role: 'member' } } },
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };

    inProcessCallMock.mockReturnValue(async (name: string, args: Record<string, unknown>) => {
      nestedCalls.push({ name, args });
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          detail: 'snapshot',
          summary: { agents: 2, claims: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 1 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error('unexpected sub-call: ' + name);
    });
    getModesMock.mockResolvedValue(null);
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    readGovernorStateSnapshotMock.mockResolvedValue(null);

    await orientTool.handler(
      {
        afterCompaction: true,
        harness: 'papercusp',
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'su',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
      } as never,
    );

    const assignmentCall = nestedCalls.find((entry) => entry.name === 'fleet:assignments');
    expect(assignmentCall?.args).toEqual({ fleet: 'orch-unify', detail: 'snapshot', harness: 'papercusp' });
  });

  it('applies caller-specific tool-surface activation in the real handler', async () => {
    const ownerId = 'su-orient-handler-activation-test';

    inProcessCallMock.mockReturnValue(async (name: string) => {
      if (name === 'fleet:assignments') {
        return {
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        };
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error(`unexpected sub-call: ${name}`);
    });
    getModesMock.mockResolvedValue(null);
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    readGovernorStateSnapshotMock.mockResolvedValue(null);
    recordOrientDisclosuresMock.mockResolvedValue('unchanged');

    const invoke = async (callerAgent: 'claude' | 'codex', activateTools: ReturnType<typeof vi.fn>) =>
      (await orientTool.handler(
        {
          claimableLimit: 0,
          inboxLimit: 0,
          includePlanEvents: false,
          includeFleetCatchUp: false,
          includeFleetHealth: false,
          includeRecipes: false,
          includePeersKnow: false,
        } as never,
        {
          uiClientId: ownerId,
          callerAgent,
          isSuperuser: true,
          workspaceId: 'ws-test',
          role: 'su',
          metadata: vi.fn(),
          log: vi.fn(),
          progress: vi.fn(),
          activateTools,
        } as never,
      )) as { data: Record<string, unknown> };

    try {
      const claudeActivateTools = vi.fn(() => true);
      const claudeResult = await invoke('claude', claudeActivateTools);
      expect(claudeActivateTools).not.toHaveBeenCalled();
      expect(
        (claudeResult.data.taskToolSchemaPack as { activation: unknown }).activation,
      ).toEqual({ requested: false, surfaceChanged: null });

      const codexActivateTools = vi.fn(() => true);
      const codexResult = await invoke('codex', codexActivateTools);
      expect(codexActivateTools).toHaveBeenCalledTimes(1);
      expect(
        (codexResult.data.taskToolSchemaPack as { activation: unknown }).activation,
      ).toEqual({ requested: true, surfaceChanged: true });
    } finally {
      inProcessCallMock.mockReset();
      getModesMock.mockReset();
      getModesMock.mockResolvedValue(null);
      readOwnerPresenceMock.mockReset();
      readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
      getFlagMock.mockReset();
      getFlagMock.mockResolvedValue(false);
      resolvePresenceFleetMock.mockReset();
      resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
      fetchOrientPipelineMock.mockReset();
      fetchOrientPipelineMock.mockResolvedValue(null);
      readGovernorStateSnapshotMock.mockReset();
      readGovernorStateSnapshotMock.mockResolvedValue(null);
      recordOrientDisclosuresMock.mockReset();
      recordOrientDisclosuresMock.mockResolvedValue('unchanged');
    }
  });

  it.each([undefined, 30_000, 44_000])('keeps recovery in the aggregate fallback before the parent deadline (%s)', async (parentBudgetMs) => {
    vi.useFakeTimers();
    const aggregateBudgetMs = parentBudgetMs === undefined ? ORIENT_AGGREGATE_TIMEOUT_MS : parentBudgetMs - 1_000;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ownerId = 'su-orient-recovery-fallback-test';
    const recovery = {
      selfRecall: "sessions:search { session: 'self' }",
      coverage: { selfSession: true, control: true, heldItems: true, staleness: null },
    };

    inProcessCallMock.mockReturnValue(async (name: string) => {
      if (name === 'fleet:assignments') {
        // This call's own 8s bound expires first; the dispatch settles at 8.5s,
        // so the aggregate fallback must name the later governor wait as active.
        return new Promise((resolve) => setTimeout(() => resolve({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: ownerId, isSelf: true, declaredPlanSlug: null, claims: 0 }],
        }), 8_500));
      }
      if (name === 'coord:whoami') return { fleetSlug: null };
      throw new Error(`unexpected sub-call: ${name}`);
    });
    getModesMock.mockResolvedValue(null);
    readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
    getFlagMock.mockResolvedValue(false);
    resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
    fetchOrientPipelineMock.mockResolvedValue(null);
    buildCompactionRecoveryMock.mockResolvedValue(recovery);
    let governorStartedResolve!: () => void;
    const governorStarted = new Promise<void>((resolve) => {
      governorStartedResolve = resolve;
    });
    readGovernorStateSnapshotMock.mockImplementation(async () => {
      governorStartedResolve();
      return new Promise(() => {});
    });

    const resultPromise = orientTool.handler(
      {
        afterCompaction: true,
        claimableLimit: 0,
        inboxLimit: 0,
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      } as never,
      {
        uiClientId: ownerId,
        isSuperuser: true,
        workspaceId: 'ws-test',
        role: 'su',
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
        activateTools: vi.fn(() => false),
        ...(parentBudgetMs === undefined ? {} : { deadlineAtMs: Date.now() + parentBudgetMs }),
      } as never,
    );
    let settled = false;
    void resultPromise.then(() => { settled = true; });

    try {
      await vi.advanceTimersByTimeAsync(8_000);
      await governorStarted;
      // Let the recovery promise's early aggregate-fallback observer run before
      // the later enrichment stalls the handler.
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(aggregateBudgetMs - 8_500);
      expect(settled).toBe(true);
      const result = (await resultPromise) as { data: Record<string, unknown> };

      expect(result.data).toMatchObject({
        ok: true,
        status: 'unknown',
        degraded: true,
        degradedReason: 'aggregate_timeout',
        partial: true,
        recovery,
        me: {
          // The per-leg assignments budget expires at 8s, before this mocked
          // dispatch settles at 8.5s. Preserve that degraded core snapshot while
          // the later governor phase is what exhausts the aggregate budget.
          ok: false,
          degraded: true,
          degradedLeg: 'fleet:assignments',
          degradedReason: 'fleet:assignments read exceeded 8000ms',
          agents: [],
        },
      });
      expect(result.data.phaseDiagnostics).toMatchObject({
        aggregateElapsedMs: aggregateBudgetMs,
        activePhase: 'handler:governor',
        activePhaseSelection: 'latest-started-pending',
        completedDurationsMs: expect.arrayContaining([
          { phase: 'inner:fleet:assignments', durationMs: 8_500 },
        ]),
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orient:aggregate'));
    } finally {
      inProcessCallMock.mockReset();
      getModesMock.mockReset();
      getModesMock.mockResolvedValue(null);
      readOwnerPresenceMock.mockReset();
      readOwnerPresenceMock.mockResolvedValue({ present: false, lastSeenAgoMs: null, activeSessions: 0 });
      getFlagMock.mockReset();
      getFlagMock.mockResolvedValue(false);
      resolvePresenceFleetMock.mockReset();
      resolvePresenceFleetMock.mockResolvedValue({ fleetSlug: null, fleetRole: null });
      fetchOrientPipelineMock.mockReset();
      fetchOrientPipelineMock.mockResolvedValue(null);
      buildCompactionRecoveryMock.mockReset();
      buildCompactionRecoveryMock.mockResolvedValue(recovery);
      readGovernorStateSnapshotMock.mockReset();
      readGovernorStateSnapshotMock.mockResolvedValue(null);
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reports both the early core and final composition snapshots', async () => {
    const progress = vi.fn();
    const { call } = fakeCall({ ...CORE });
    const result = await composeOrient(
      {
        harness: 'h',
        includePlanEvents: false,
        includeFleetCatchUp: false,
        includeFleetHealth: false,
        includeRecipes: false,
        includePeersKnow: false,
      },
      call,
      'me',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      progress,
    );

    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress.mock.calls[0]?.[0]).toMatchObject({
      ok: true,
      me: result.me,
      claimable: [],
      inbox: {},
    });
    expect(progress.mock.calls[1]?.[0]).toMatchObject({
      ok: true,
      me: result.me,
      claimable: result.claimable,
      inbox: result.inbox,
    });
    expect(progress.mock.calls[2]?.[0]).toBe(result);
  });

  it('keeps the aggregate fallback before the MCP transport cap with serialization headroom', () => {
    expect(ORIENT_AGGREGATE_TIMEOUT_MS).toBeLessThan(MCP_TRANSPORT_CAP_MS);
    expect(MCP_TRANSPORT_CAP_MS - ORIENT_AGGREGATE_TIMEOUT_MS).toBeGreaterThanOrEqual(3_000);
  });

  it('starts bounded post-compaction recovery before composeOrient so the budgets overlap', () => {
    const source = readFileSync(new URL('./orient.ts', import.meta.url), 'utf8');
    const recoveryStart = source.indexOf('const compactionRecoveryPromise =');
    const composeStart = source.indexOf("const result = await phaseTracker.track('composeOrient', () => composeOrient(");
    const recoveryAwait = source.indexOf('const recovery = compactionRecoveryPromise');
    const composeDeadline = source.indexOf(
      'const composeDeadlineAtMs = aggregateResponseDeadlineAtMs - ORIENT_PARENT_DEADLINE_HEADROOM_MS;',
    );

    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(composeStart).toBeGreaterThan(recoveryStart);
    expect(composeDeadline).toBeGreaterThanOrEqual(0);
    expect(composeDeadline).toBeLessThan(composeStart);
    expect(source.slice(composeStart, recoveryAwait)).toContain('composeDeadlineAtMs,');
    expect(source.slice(recoveryStart, composeStart)).toContain('withBoundedTimeout');
    expect(recoveryAwait).toBeGreaterThan(composeStart);
  });

  it('derives the recovered fleet scope before composeOrient and awaits it before assignments', () => {
    const source = readFileSync(new URL('./orient.ts', import.meta.url), 'utf8');
    const recoveredScopePromiseStart = source.indexOf('const recoveredFleetScopePromise =');
    const composeCallStart = source.indexOf("const result = await phaseTracker.track('composeOrient', () => composeOrient(");
    const composeDefinitionStart = source.indexOf('export async function composeOrient(');
    const recoveredScopeAwait = source.indexOf(
      'const recovered = await recoveredFleetScopeFold();',
      composeDefinitionStart,
    );
    const assignmentsRead = source.indexOf("call('fleet:assignments',", composeDefinitionStart);

    expect(recoveredScopePromiseStart).toBeGreaterThanOrEqual(0);
    expect(composeCallStart).toBeGreaterThan(recoveredScopePromiseStart);
    expect(recoveredScopeAwait).toBeGreaterThanOrEqual(0);
    expect(assignmentsRead).toBeGreaterThan(recoveredScopeAwait);
  });

  it('starts the handler-owned GOAL portfolio read before composeOrient', () => {
    const source = readFileSync(new URL('./orient.ts', import.meta.url), 'utf8');
    const modesStart = source.indexOf('const runtimeModesPromise =');
    const portfolioStart = source.indexOf('const goalPortfolioStagedPromise =');
    const obligationsStart = source.indexOf('const goalObligationsPromise =');
    const composeStart = source.indexOf("const result = await phaseTracker.track('composeOrient', () => composeOrient(");

    expect(modesStart).toBeGreaterThanOrEqual(0);
    expect(portfolioStart).toBeGreaterThan(modesStart);
    expect(obligationsStart).toBeGreaterThan(portfolioStart);
    expect(obligationsStart).toBeLessThan(composeStart);
    const ownerReportStart = source.indexOf('const goalOwnerReportPromise =', obligationsStart);
    expect(ownerReportStart).toBeGreaterThan(obligationsStart);
    expect(ownerReportStart).toBeLessThan(composeStart);
    const obligationsSlice = source.slice(obligationsStart, ownerReportStart);
    expect(obligationsSlice).toContain('readAgentObligationAgenda');
    expect(obligationsSlice).toContain('projectAgentTurnStartObligationBrief');
    expect(obligationsSlice).toMatch(/const goalObligationsPromise =\s*ownerId\s*\?/);
    expect(obligationsSlice).toContain('const goalObligationsPromise =\n      ownerId');
    expect(obligationsSlice).not.toContain('goalSubject && ownerId');
    expect(source.slice(portfolioStart, composeStart)).toContain('readGoalPortfolioBriefStaged');
    // EI-25191349922959563: the obligation fold (900ms budget) must read the
    // UNCOUNTED snapshot stage, never the counted display read it used to share.
    expect(obligationsSlice).toContain('goalPortfolio: async () => (goalPortfolioSnapshotPromise');
    expect(obligationsSlice).not.toContain('await goalPortfolioReadPromise');
    // WI-2140700: the holder's owner-report obligation starts in the same early
    // window (overlapping the sequential folds) and is folded into
    // `modes.ownerReport`, the field the GOAL contract tells a holder to read
    // FIRST every wake.
    expect(ownerReportStart).toBeGreaterThan(portfolioStart);
    expect(ownerReportStart).toBeLessThan(composeStart);
    expect(source.slice(ownerReportStart, composeStart)).toContain('readGoalOwnerReportObligation');
    expect(source.slice(composeStart)).toContain(
      "modes.ownerReport = await phaseTracker.track('handler:goalOwnerReport', () => goalOwnerReportPromise)",
    );
    expect(composeStart).toBeGreaterThan(portfolioStart);
  });

  it('does not retain the ambient workspace transaction across coordination folds', () => {
    expect((orientTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('accepts an explicit null planSlug for planless lanes', () => {
    expect(orientTool.args.safeParse({ intent: 'planless wake', planSlug: null, planItems: [] }).success).toBe(true);
  });

  it('accepts a fleet compatibility hint without allowing it to override session-inferred membership', () => {
    const description = String((orientTool as { description?: unknown }).description ?? '');

    // e3597dcb shortened the catalog prose to satisfy the hard guidance budget;
    // pin the load-bearing semantics rather than the retired long wording.
    expect(description).toContain('Fleet and workspace are inferred');
    expect(description).toContain('`fleet` is a compatibility hint only');
    expect(description).toContain('pass `harness` only for explicit harness scope');
    const parsed = orientTool.args.safeParse({ fleet: 'nonp2p-bug-drain-headless-0812' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fleet).toBe('nonp2p-bug-drain-headless-0812');
  });

  it('accepts claimableLimit=0 for a lean bootstrap', () => {
    expect(orientTool.args.safeParse({ claimableLimit: 0 }).success).toBe(true);
  });

  it('accepts memoryLimit=0 for a lean bootstrap', () => {
    expect(orientTool.args.safeParse({ memoryLimit: 0 }).success).toBe(true);
  });

  it('accepts inboxLimit=0 for a lean bootstrap', () => {
    expect(orientTool.args.safeParse({ inboxLimit: 0 }).success).toBe(true);
  });

  it('accepts the stale includeFleet/includeInbox/includeAssignments aliases', () => {
    const parsed = orientTool.args.safeParse({
      includeFleet: false,
      includeInbox: false,
      includeAssignments: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        includeFleet: false,
        includeInbox: false,
        includeAssignments: false,
      });
    }
  });

  it('accepts recipesLimit=0 for a lean bootstrap', () => {
    expect(orientTool.args.safeParse({ recipesLimit: 0 }).success).toBe(true);
  });

  it('accepts fleetCatchUpLimit=0 for a narrow fleet-assignment bootstrap', () => {
    expect(orientTool.args.safeParse({ fleetCatchUpLimit: 0 }).success).toBe(true);
  });

  it('exposes the includePeersKnow opt-out in the transport schema', () => {
    const parsed = orientTool.args.safeParse({ includePeersKnow: false });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.includePeersKnow).toBe(false);
  });

  it('accepts stale includeFleetCatchup casing in the transport schema', () => {
    expect(orientTool.args.safeParse({ includeFleetCatchup: false }).success).toBe(true);
  });

  it('keeps every in-process fold classified and outside the ambient workspace transaction', () => {
    const source = readFileSync(new URL('./orient.ts', import.meta.url), 'utf8');
    const called = [...source.matchAll(/\bcall\('([^']+)'/g)].map((match) => match[1]);
    expect(new Set(called)).toEqual(new Set(ORIENT_FOLD_TOOL_NAMES));

    const crossWorkspace: ReadonlySet<string> = new Set(ORIENT_CROSS_WORKSPACE_FOLD_TOOL_NAMES);
    for (const name of ORIENT_FOLD_TOOL_NAMES) {
      const tool = lookupByMcpName(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      if (crossWorkspace.has(name)) {
        expect((tool as { crossWorkspace?: boolean }).crossWorkspace, `${name} must stay crossWorkspace`).toBe(true);
      } else {
        expect(
          (tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx,
          `${name} must opt out of ambient workspace tx`,
        ).toBe(true);
      }
    }
  });
});

describe('EI-21239843876346650 recovered fleet scope', () => {
  it('extracts only a fleet route from the typed control anchor', () => {
    expect(
      extractRecoveredFleetScope({
        state: { route: { kind: 'fleet', fleet: 'orch-unify', role: 'leader' } },
      }),
    ).toEqual({ fleetSlug: 'orch-unify', fleetRole: 'leader' });
    expect(
      extractRecoveredFleetScope({
        state: { route: { kind: 'self' } },
      }),
    ).toBeNull();
    expect(extractRecoveredFleetScope(null)).toBeNull();
  });

  it('waits for the recovered route, reads the fleet, and discloses the widened scope', async () => {
    let resolveScope!: (scope: { fleetSlug: string; fleetRole: string | null }) => void;
    const scopePromise = new Promise<{ fleetSlug: string; fleetRole: string | null }>((resolve) => {
      resolveScope = resolve;
    });
    const { call, calls } = fakeCall({ ...CORE });
    const pending = composeOrient(
      { afterCompaction: true },
      call,
      'member',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { fleetSlug: null, fleetRole: null },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => scopePromise,
    );

    await Promise.resolve();
    expect(calls.some((entry) => entry.name === 'fleet:assignments')).toBe(false);

    resolveScope({ fleetSlug: 'orch-unify', fleetRole: 'member' });
    const result = await pending;
    const assignments = calls.find((entry) => entry.name === 'fleet:assignments');
    expect(assignments?.args).toMatchObject({ fleet: 'orch-unify' });
    expect(assignments?.args).not.toHaveProperty('agent');
    expect(result.recoveredFleetScope).toMatchObject({
      fleet: 'orch-unify',
      role: 'member',
      note: expect.stringContaining('RECOVERED FLEET SCOPE'),
    });
  });
});

function fakeCall(handlers: Record<string, (args: Record<string, unknown>) => unknown>): {
  call: InnerCall;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: InnerCall = async (name, args) => {
    calls.push({ name, args: args as Record<string, unknown> });
    const h = handlers[name];
    if (!h) throw new Error(`unexpected sub-call: ${name}`);
    return h(args as Record<string, unknown>);
  };
  return { call, calls };
}

/** The core three + plan-events (the default folds when no `intent` is passed).
 *  `coord:glance` is included so a test that opts a caller INTO a fleet (via a
 *  `coord:whoami` override) without caring about the fleet-health glance itself
 *  doesn't trip the WI-3818 bounded-timeout `console.warn` on an "unexpected
 *  sub-call" — override it locally when a test asserts on glance behavior. */
const CORE = {
  'fleet:assignments': () => ({ ok: true, summary: { agents: 1 }, agents: [{ ownerId: 'me' }] }),
  // EI-19452326548245557: orient now SOURCES its issue-family lane from the claim
  // oracle (work_items:claimable) and uses work_items:list only for the
  // feature-family lane. This shared stub returns an EMPTY oracle deliberately, so
  // every pre-existing test that drives the backlog through `work_items:list` keeps
  // describing exactly what it always did; the oracle-sourcing behaviour itself is
  // owned by the dedicated tests below, which stub it explicitly.
  'work_items:claimable': () => ({ claimable: [] }),
  'work_items:list': () => [
    { id: 'WI-1', state: 'todo' },
    { id: 'WI-2', state: 'todo' },
  ],
  // WI-5343: orient batch-observes its fetched claimable rows through the same
  // floors work_items:observe applies (claim-hold / plan-item block / live-claim)
  // and drops anything reported available:false. Default: every row passes
  // through unchanged (nothing gated) — tests asserting a specific gated row
  // override this locally.
  'work_items:observe': (a: Record<string, unknown>) => ({
    ok: true,
    results: (a.ids as string[]).map((id) => ({ id, ok: true, available: true })),
  }),
  'coord:inbox': () => ({ summary: { total: 3 }, entries: [{ msg_id: 'm1' }] }),
  'coord:plan-events': () => ({ events: [{ kind: 'item_status_changed', plan: 'p1' }], total: 1, truncated: false }),
  'coord:whoami': () => ({ fleetSlug: null }),
  'coord:glance': () => ({ bees: { running: 0, working: 0 } }),
};

const GOAL_PORTFOLIO: GoalPortfolioBrief = {
  schemaVersion: 1,
  assembledAt: '2026-08-28T02:30:00.000Z',
  goal: {
    id: 'goal-1',
    title: 'Keep the portfolio moving',
    status: 'active',
    body: null,
    killCriterion: null,
    standing: true,
    parentId: null,
  },
  worklist: [],
  pots: [{ harness: 'papercusp', role: 'owner', note: null, killCriterion: null, linkId: 'fixture-link' }],
  drainFleet: {
    slug: 'goal-1-drain',
    exists: true,
    controlState: 'active',
    leaderOwnerId: 'su-drain-leader',
    live: 2,
    working: 1,
  },
  queue: {
    total: 4,
    terminal: 1,
    inFlight: 1,
    blocked: 0,
    needsHuman: 0,
    claimable: 2,
    claimabilityScope: 'issue-family',
  },
  launch: {
    settings: null,
    ceilings: { maxAgents: 12, maxPerFleet: 5 },
    headcount: { total: 3, fleet: 2 },
  },
  budget: {
    budgetCents: null,
    spentCents: null,
    unmeasuredPricedSpend: false,
    spentCentsAt: null,
    spentCentsSource: null,
    interactiveUsageFreshnessStatus: null,
    interactiveUsageLastIngestedAtMs: null,
    budgetWindowSec: null,
  },
  tripwires: [],
  pending: { blenderIdeas: 0, acceptanceRubric: null },
  continuity: { checkpoint: null, lastOwnerReportAt: null },
  priorities: ['Place the next plan item with an independent fleet.'],
  degradedReasons: [],
};

function composeGoalOrient(
  args: Parameters<typeof composeOrient>[0],
  call: InnerCall,
  fold: NonNullable<Parameters<typeof composeOrient>[18]>,
  obligationsFold?: NonNullable<Parameters<typeof composeOrient>[19]>,
): ReturnType<typeof composeOrient> {
  return composeOrient(
    args,
    call,
    'me',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fold,
    obligationsFold,
  );
}

function composeOrientWithDeadline(
  args: Parameters<typeof composeOrient>[0],
  call: InnerCall,
  deadlineAtMs: number,
): ReturnType<typeof composeOrient> {
  return composeOrient(
    args,
    call,
    'me',
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined,
    deadlineAtMs,
  );
}

describe('composeOrient (B-CX-1B compound + P-005 bootstrap folds)', () => {
  it.each([1, 8])('overlaps assignments with the independent backlog chain for %i readers', async (readers) => {
    vi.useFakeTimers();
    const delay = <T>(value: T, ms: number): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value), ms));
    const assignments = { ok: true, agents: [{ ownerId: 'me' }] };
    const rows = [{ id: 'WI-visible' }, { id: 'WI-held' }];
    const inbox = { summary: { unread: 1 }, entries: [{ id: 'message-1' }] };
    const { call, calls } = fakeCall({
      ...CORE,
      'fleet:assignments': () => delay(assignments, 100),
      'work_items:list': () => delay(rows, 80),
      'coord:inbox': () => delay(inbox, 30),
      'work_items:observe': () => delay({ results: [{ id: 'WI-held', available: false }] }, 20),
    });
    const results: Array<Awaited<ReturnType<typeof composeOrient>>> = [];
    const pending = Promise.all(Array.from({ length: readers }, () =>
      composeOrient({ includePlanEvents: false }, call, 'me').then((value) => {
        results.push(value);
      }),
    ));
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.filter((entry) => entry.name === 'work_items:list')).toHaveLength(readers);
      await vi.advanceTimersByTimeAsync(129);
      expect(results).toHaveLength(readers);
      for (const result of results) {
        expect(result).toMatchObject({
          me: assignments,
          claimable: [{ id: 'WI-visible' }],
          inbox: {
            summary: inbox.summary,
            entries: inbox.entries,
            recent: { movedTo: 'inbox.entries', length: inbox.entries.length },
          },
        });
      }
    } finally {
      await vi.runAllTimersAsync();
      await pending;
      vi.useRealTimers();
    }
  });

  it('folds the handler-injected GOAL portfolio on full and monitor orientations', async () => {
    for (const args of [{}, { mode: 'monitor' as const }]) {
      const { call } = fakeCall({ ...CORE });
      const fold = vi.fn(async () => GOAL_PORTFOLIO);
      const result = await composeGoalOrient(args, call, fold);

      expect(result.goalPortfolio).toBe(GOAL_PORTFOLIO);
      expect(fold).toHaveBeenCalledTimes(1);
    }
  });

  it('distinguishes a degraded GOAL portfolio read from a non-GOAL caller', async () => {
    const { call } = fakeCall({ ...CORE });
    const degraded = await composeGoalOrient({}, call, async () => null);
    expect(degraded.goalPortfolio).toBeNull();

    const { call: ordinaryCall } = fakeCall({ ...CORE });
    const ordinary = await composeOrient({}, ordinaryCall, 'me');
    expect(ordinary.goalPortfolio).toBeUndefined();
    expect(ordinary.obligations).toBeUndefined();
  });

  it('folds the complete canonical obligation agenda behind the turn-start recovery reference', async () => {
    const { call } = fakeCall({ ...CORE });
    const obligations = {
      schemaVersion: 'agent-obligations-v1',
      evaluatedAt: '2026-09-08T09:00:00.000Z',
      sourceGeneration: 'agenda-complete-1',
      evaluations: [{ id: 'evaluation-1', status: 'due' }],
      primary: [
        { id: 'obligation-1', status: 'due', title: 'First complete obligation' },
        { id: 'obligation-2', status: 'due', title: 'Second complete obligation' },
      ],
      projection: {
        text: '- [DUE] First complete obligation',
        entries: [{ id: 'obligation-1' }],
        receipt: {
          sink: 'turn-start',
          mode: 'truncate',
          entriesAvailable: 2,
          entriesDelivered: 1,
          entriesOmitted: 1,
          bodyDeliveredChars: 33,
          estimatedTokens: 9,
          bodyTruncated: true,
          refused: false,
          reason: 'entry-cap',
        },
      },
      detailRef: 'coord:orient for the complete obligation agenda',
    } as never;

    const result = await composeGoalOrient({}, call, async () => GOAL_PORTFOLIO, async () => obligations);

    expect(result.obligations).toBe(obligations);
    expect(result.obligations?.primary).toHaveLength(2);
    expect(result.obligations?.projection.receipt.entriesOmitted).toBe(1);
  });

  it('folds assignments + claimable + inbox + plan-events into one result (no intent)', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    expect(r.ok).toBe(true);
    expect((r.me as { agents: Array<{ ownerId: string }> }).agents[0].ownerId).toBe('me');
    expect(r.claimable).toHaveLength(2);
    expect((r.inbox.summary as { total: number }).total).toBe(3);
    expect(r.inbox.entries).toEqual([{ msg_id: 'm1' }]);
    expect(r.planEvents).toEqual({ total: 1, recent: [{ kind: 'item_status_changed', plan: 'p1' }] });
    // No intent ⇒ no memory recall, no declare.
    expect(r.memory).toBeUndefined();
    expect(r.intentDeclared).toBeUndefined();
    // sequential order (never Promise.all on one ctx) + arg forwarding.
    // P-007: coord:whoami is hoisted ABOVE the facts fold (the audience filter
    // needs the caller's fleet), so it now precedes coord:plan-events.
    // WI-5343: work_items:observe (the claimable floor-parity batch check) runs
    // right after coord:inbox, before coord:whoami.
    // EI-19452326548245557: the issue-family lane is sourced from the claim ORACLE
    // (work_items:claimable) and the feature-family lane from work_items:list; the
    // two are fetched together, so the oracle precedes the list.
    expect(calls.map((c) => c.name)).toEqual([
      'fleet:assignments',
      'work_items:claimable',
      'work_items:list',
      'coord:inbox',
      'work_items:observe',
      'coord:whoami',
      'coord:plan-events',
    ]);
    expect(calls[0].args).toMatchObject({ agent: 'me', harness: 'h' });
    // The oracle is asked for the harness lane at the same limit as the fold.
    expect(calls[1].args).toMatchObject({ harness: 'h', limit: 20 });
    // EI-7841: the feature lane must still ask work_items:list to exclude
    // G2-admission-gated items so "claimable" matches what claim will do.
    // D-002/EI-11300: 'open' is the unified claimable token (feature 'todo' retired) —
    // composeOrient's own default (orient.ts line ~518) moved to 'open'; this assertion
    // was stale (last updated for the old default), not a regression in production code.
    expect(calls[2].args).toMatchObject({
      harness: 'h',
      state: 'open',
      limit: 20,
      admissibleOnly: true,
      kind: 'feature',
    });
    expect(calls[3].args).toMatchObject({ limit: 10, max_body_chars: 300 });
    // WI-5343: calls[4] batch-observes every fetched row for the real claim floors.
    expect(calls[4].args).toMatchObject({ ids: ['WI-1', 'WI-2'], harness: 'h' });
    // calls[5] is the hoisted coord:whoami (P-007); plan-events follows it.
    expect(calls[6].args).toMatchObject({ limit: 10 });
  });

  // ── EI-19452326548245557: the claimable fold must BE the claim oracle ──────────
  // Regression context: orient sourced its whole backlog from
  // `work_items:list({ admissibleOnly: true })`, a STRUCTURAL pre-filter that applies
  // remote-origin + observation-lane only. The ~12 real claim floors were never
  // applied, so the fold advertised work `work_items:claim` refuses. Measured
  // 2026-08-04 on `papercusp`: 16 of 20 rows were `[replication-liveness]` EIs held
  // out by the `federationDetector` floor. These four tests are mutually
  // non-vacuous: each fails on a different branch of the fix.

  it('sources the ISSUE lane from the claim oracle, never from work_items:list', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'work_items:claimable': () => ({ claimable: [{ id: 'EI-ORACLE', state: 'open' }] }),
      'work_items:list': () => [{ id: 'F-1', state: 'open' }],
    });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    // The oracle's row is what surfaces, alongside the feature lane.
    expect((r.claimable as Array<{ id: string }>).map((x) => x.id)).toEqual(['EI-ORACLE', 'F-1']);
    // The decisive property: orient never asks work_items:list for issue-family rows
    // at all, so a floor-excluded issue row has no path into the backlog.
    const listCalls = calls.filter((c) => c.name === 'work_items:list');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args).toMatchObject({ kind: 'feature' });
  });

  it('preserves the oracle Hive-home scope and observes rows in the resolved lane', async () => {
    const scope = { requested: 'oddsmith', resolved: 'oddsmith-hive', resolution: 'hive-home' as const };
    const { call, calls } = fakeCall({
      ...CORE,
      'work_items:claimable': () => ({ claimable: [{ id: 'EI-HOME', state: 'open' }], claimableHarnessScope: scope }),
      'work_items:list': () => [],
    });

    const r = await composeOrient({ harness: 'oddsmith' }, call, 'me');

    expect(r.claimableHarnessScope).toEqual(scope);
    expect(calls.find((c) => c.name === 'work_items:observe')?.args).toMatchObject({
      ids: ['EI-HOME'],
      harness: 'oddsmith-hive',
    });
  });

  it('falls back to the unfiltered list when the oracle fails — never an empty backlog', async () => {
    // EI-21127719036550806: the oracle leg is now wrapped in withBoundedTimeout
    // (bounded-core), which logs a console.warn on a caught failure — expected
    // here since this test deliberately makes work_items:claimable throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call, calls } = fakeCall({
      ...CORE,
      'work_items:claimable': () => {
        throw new Error('oracle unavailable');
      },
    });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    // Degrades to the previous behaviour rather than starving self-select agents.
    expect((r.claimable as Array<{ id: string }>).map((x) => x.id)).toEqual(['WI-1', 'WI-2']);
    const listCalls = calls.filter((c) => c.name === 'work_items:list');
    expect(listCalls).toHaveLength(2);
    // The fallback leg is family-agnostic (no `kind` filter) — the old whole-lane read.
    expect(listCalls[1].args.kind).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('omits the oracle entirely when no harness is resolvable (it requires one)', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    await composeOrient({}, call, 'me');
    expect(calls.some((c) => c.name === 'work_items:claimable')).toBe(false);
    const listCalls = calls.filter((c) => c.name === 'work_items:list');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args.kind).toBeUndefined();
  });

  it('reserves room for the feature lane so a full issue window cannot truncate it away', async () => {
    const { call } = fakeCall({
      ...CORE,
      'work_items:claimable': () => ({
        claimable: [1, 2, 3, 4, 5].map((n) => ({ id: `EI-${n}`, state: 'open' })),
      }),
      'work_items:list': () => [{ id: 'F-KEEP', state: 'open' }],
    });
    const r = await composeOrient({ harness: 'h', claimableLimit: 3 }, call, 'me');
    const ids = (r.claimable as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual(['EI-1', 'EI-2', 'F-KEEP']);
  });

  // EI-18667514339699744: coord:orient used to fold coord:inbox's `entries` under
  // `recent`, so a caller reading the other tool's key got a silent []. The first fix
  // aliased both keys to one array, which JSON serialized TWICE (26% of orient spill
  // bytes — oversized-tool-results-reduction-2026-10-12 P-006). Root fix: one name.
  // The rows live under `entries`; `recent` is a pointer that is loud on misuse.
  it('EI-18667514339699744: folds the inbox rows ONCE under `entries`, with a loud `recent` pointer', async () => {
    const { call } = fakeCall({ ...CORE });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    expect(r.inbox.entries).toEqual([{ msg_id: 'm1' }]);
    expect(r.inbox.recent).toEqual({ movedTo: 'inbox.entries', length: 1 });
    // Not iterable: a reader still on the old key throws instead of seeing an empty inbox.
    expect(() => [...(r.inbox.recent as unknown as Iterable<unknown>)]).toThrow(TypeError);
    // The serialized fold carries the row a single time.
    expect(JSON.stringify(r.inbox).split('"m1"').length - 1).toBe(1);
  });

  it('omits the agent filter when no ownerId resolved (fleet-wide assignments)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'work_items:list': () => [],
      'coord:inbox': () => ({ summary: {}, entries: [] }),
    });
    await composeOrient({}, call, undefined);
    expect(calls[0].args.agent).toBeUndefined();
  });

  it('normalizes a { data: [...] } list shape into claimable[]', async () => {
    const { call } = fakeCall({ ...CORE, 'work_items:list': () => ({ data: [{ id: 'WI-9' }] }) });
    const r = await composeOrient({}, call, 'me');
    expect(r.claimable).toEqual([{ id: 'WI-9' }]);
  });

  // WI-5343: work_items:list({admissibleOnly:true}) only applies the G2/origin
  // structural gates, not a claim-hold / assignee / plan-item-block / live-claim
  // floor — so it used to advertise a row work_items:observe itself would report
  // available:false for (a claim-hold park, an already-assigned row, an
  // effectively-blocked or live-claimed linked plan item). Assert the batch
  // observe now drops such a row from `claimable` instead of surfacing it as a
  // bare, ungated id.
  it('WI-5343: drops a row work_items:observe reports available:false for (claim-hold / assignee / plan-item block)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'work_items:observe': (a: Record<string, unknown>) => ({
        ok: true,
        results: (a.ids as string[]).map((id) =>
          id === 'WI-1'
            ? { id, ok: true, available: false, gated: true, claimHoldParked: true }
            : { id, ok: true, available: true },
        ),
      }),
    });
    const r = await composeOrient({ harness: 'h' }, call, 'me');
    expect(r.claimable).toEqual([{ id: 'WI-2', state: 'todo' }]);
    const obs = calls.find((c) => c.name === 'work_items:observe')!;
    expect(obs.args).toMatchObject({ ids: ['WI-1', 'WI-2'], harness: 'h' });
  });

  // A monitor tick skips the claimable leg entirely (EI-8300) — it must not pay
  // the new observe round-trip either.
  it('WI-5343: a monitor tick never calls work_items:observe (claimable leg skipped entirely)', async () => {
    // intent:'tick' still fires coord:declare-intent (not gated by monitor mode) —
    // mock it so the observe assertion isn't incidentally tripped by an unrelated
    // unmocked sub-call.
    const { call, calls } = fakeCall({ ...CORE, 'coord:declare-intent': () => ({ ok: true }) });
    await composeOrient({ mode: 'monitor', intent: 'tick' }, call, 'me');
    expect(calls.some((c) => c.name === 'work_items:observe')).toBe(false);
  });

  // A failed/erroring observe batch must never break orientation — the claimable
  // list stays unfiltered (advisory, as documented) rather than throwing.
  it('WI-5343: fails OPEN — an observe error keeps the unfiltered claimable list', async () => {
    // EI-21127719036550806: observe is now wrapped in withBoundedTimeout, which
    // logs a console.warn on a caught failure — expected here since this test
    // deliberately makes work_items:observe throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = fakeCall({
      ...CORE,
      'work_items:observe': () => {
        throw new Error('boom');
      },
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.claimable).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('folds the injected ownerPresent bit verbatim (P-004), and omits the leg when not resolved', async () => {
    const { call } = fakeCall({ ...CORE });
    const present = { present: true, lastSeenAgoMs: 12_000, activeSessions: 1 };
    const withBit = await composeOrient({}, call, 'me', undefined, present);
    expect(withBit.ownerPresent).toEqual(present);

    const { call: call2 } = fakeCall({ ...CORE });
    const withoutBit = await composeOrient({}, call2, 'me'); // handler didn't resolve it
    expect(withoutBit.ownerPresent).toBeUndefined();

    const { call: call3 } = fakeCall({ ...CORE });
    const failedRead = await composeOrient({}, call3, 'me', undefined, null); // read failed ⇒ null leg
    expect(failedRead.ownerPresent).toBeNull();
  });

  it('honors claimableState / claimableLimit / inboxLimit overrides', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    await composeOrient({ claimableState: 'wip', claimableLimit: 5, inboxLimit: 3 }, call, 'me');
    expect(calls[1].args).toMatchObject({ state: 'wip', limit: 5 });
    expect(calls[2].args).toMatchObject({ limit: 3 });
  });

  it('accepts claimableLimit=0 and skips backlog legs without a false truncation', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ harness: 'h', claimableLimit: 0 }, call, 'me');
    expect(r.claimable).toEqual([]);
    expect(r.claimableTruncated).toBeUndefined();
    expect(calls.some(({ name }) => name === 'work_items:claimable' || name === 'work_items:list')).toBe(false);
  });

  it('accepts memoryLimit=0 and skips the memory recall leg', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:declare-intent': () => ({ ok: true }),
    });
    const r = await composeOrient({ intent: 'lean bootstrap', memoryLimit: 0 }, call, 'me');
    expect(r.memory).toBeUndefined();
    expect(calls.some(({ name }) => name === 'memory:search')).toBe(false);
  });

  it('starts memory recall before independent bootstrap folds and awaits it only at the admission point', async () => {
    let resolveMemory!: (value: { ok: true; results: [] }) => void;
    const memoryDone = new Promise<{ ok: true; results: [] }>((resolve) => {
      resolveMemory = resolve;
    });
    let memoryResolved = false;
    let assignmentsStartedWhileMemoryPending = false;
    const { call, calls } = fakeCall({
      ...CORE,
      'memory:search': async () => {
        const result = await memoryDone;
        memoryResolved = true;
        return result;
      },
      'fleet:assignments': () => {
        assignmentsStartedWhileMemoryPending = !memoryResolved;
        return CORE['fleet:assignments']();
      },
      'coord:declare-intent': () => ({ ok: true }),
    });

    const pending = composeOrient({ intent: 'overlap recall' }, call, 'me');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(assignmentsStartedWhileMemoryPending).toBe(true);
    expect(calls.map((c) => c.name).slice(0, 2)).toEqual(['memory:search', 'fleet:assignments']);
    let orientResolved = false;
    void pending.then(() => {
      orientResolved = true;
    });
    await Promise.resolve();
    expect(orientResolved).toBe(false);

    resolveMemory({ ok: true, results: [] });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.memory).toEqual({ query: 'overlap recall', hits: [] });
  });

  it('accepts inboxLimit=0 and skips the duplicate inbox read', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ harness: 'h', inboxLimit: 0 }, call, 'me');
    expect(r.inbox).toEqual({ summary: undefined, recent: undefined, entries: undefined });
    expect(calls.some(({ name }) => name === 'coord:inbox')).toBe(false);
  });

  it('maps legacy includeInbox:false to inboxLimit=0, while an explicit inboxLimit wins', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ includeInbox: false }, call, 'me');
    expect(r.inbox).toEqual({ summary: undefined, recent: undefined, entries: undefined });
    expect(calls.some(({ name }) => name === 'coord:inbox')).toBe(false);

    const { call: call2, calls: calls2 } = fakeCall({ ...CORE });
    await composeOrient({ includeInbox: false, inboxLimit: 2 }, call2, 'me');
    expect(calls2.find(({ name }) => name === 'coord:inbox')?.args).toMatchObject({ limit: 2 });
  });

  it('with `intent`: folds a memory recall + relevant recipes AND declares the intent (full bootstrap in one call)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'memory:search': () => ({
        ok: true,
        results: [{ id: 'mem1', memory: 'prefers nuqs over useState', score: 0.9 }],
      }),
      'recipes:search': () => ({
        ok: true,
        query: 'implement P-005',
        recipes: [
          {
            id: 'fan-out-wi',
            title: 'Fan-out work items',
            description: 'd',
            runCount: 7,
            toolsUsed: ['work_items:get'],
            similarity: 0.82,
          },
        ],
      }),
      'coord:declare-intent': () => ({ ok: true }),
      // WI-5228: planSlug is passed below, so the new orient-first plan-now leg
      // calls plans:get — register a benign empty-items response so this test
      // (which doesn't assert on r.planNow) stays focused on the intent/recipes
      // bootstrap it's actually testing.
      'plans:get': () => ({ results: [{ now: { state: null, next: null }, items: [] }] }),
    });
    const r = await composeOrient(
      {
        intent: 'implement P-005',
        planSlug: 'tool-call-batching-wrappers-2026-06-21',
        planItems: ['P-005'],
        harness: 'h',
      },
      call,
      'me',
    );
    expect(r.memory).toEqual({
      query: 'implement P-005',
      hits: [{ id: 'mem1', memory: 'prefers nuqs over useState', score: 0.9 }],
      // orient-recall-quality P-003: a non-empty fold always carries the
      // non-exhaustive advisory.
      note: ORIENT_MEMORY_NOTE,
    });
    expect(r.intentDeclared).toBe(true);
    // memory uses intent as the query + harness_slug; declare carries the lane.
    const mem = calls.find((c) => c.name === 'memory:search')!;
    expect(mem.args).toMatchObject({ query: 'implement P-005', harness_slug: 'h', limit: 5 });
    const decl = calls.find((c) => c.name === 'coord:declare-intent')!;
    expect(decl.args).toMatchObject({
      intent: 'implement P-005',
      current_plan_slug: 'tool-call-batching-wrappers-2026-06-21',
      items: ['P-005'],
    });
    // recipes:search uses intent plus the live lane identity as a hard authority filter.
    expect(calls.find((c) => c.name === 'recipes:search')!.args).toMatchObject({
      query: 'implement P-005',
      limit: 3,
      context: {
        plan: 'tool-call-batching-wrappers-2026-06-21',
        harness: 'h',
        items: ['P-005'],
      },
    });
    expect(r.recipes).toEqual([{ id: 'fan-out-wi', title: 'Fan-out work items', runCount: 7, similarity: 0.82 }]);
    // order: memory STARTS first so its latency overlaps the independent core
    // reads; core three → observe → memory ADMISSION → whoami (P-007: hoisted
    // above the facts fold) → plan-events → planNow
    // (WI-5228: planSlug was passed) → recipes → declare
    expect(calls.map((c) => c.name)).toEqual([
      'memory:search',
      'fleet:assignments',
      // EI-19452326548245557: issue lane from the claim oracle, feature lane from the list.
      'work_items:claimable',
      'work_items:list',
      'coord:inbox',
      'work_items:observe',
      'coord:whoami',
      'coord:plan-events',
      'plans:get',
      'recipes:search',
      'coord:declare-intent',
    ]);
  });

  it('opts into history explicitly and keeps a superseded marker in the compact memory body', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'memory:search': () => ({
        ok: true,
        results: [
          {
            id: 'old-memory',
            memory: 'Gemma is the default embedder',
            score: 0.9,
            metadata: {
              validity: {
                status: 'superseded',
                invalid_at: '2026-07-10T15:45:00.000Z',
                superseded_by: 'new-memory',
              },
            },
          },
        ],
      }),
    });

    const r = await composeOrient(
      {
        memoryQuery: 'default embedder history',
        memoryIncludeSuperseded: true,
        harness: 'h',
      },
      call,
      'me',
    );

    expect(calls.find((c) => c.name === 'memory:search')!.args).toMatchObject({
      include_superseded: true,
    });
    expect(r.memory?.hits).toEqual([
      expect.objectContaining({
        id: 'old-memory',
        memory: '[SUPERSEDED 2026-07-10] Gemma is the default embedder',
      }),
    ]);
  });

  it('folds intent-relevant recipes (recipes:search), compact; skipped when includeRecipes:false', async () => {
    const authority = { version: 1, revision: 'a'.repeat(64), context: { harness: 'papercusp' } };
    const recipeHandler = () => ({
      ok: true,
      recipes: [
        {
          id: 'sweep-stale',
          title: 'Sweep stale items',
          description: 'd',
          runCount: 3,
          toolsUsed: ['work_items:list'],
          similarity: 0.7,
          authorityRefs: { harnesses: ['papercusp'] },
          runArgs: { id: 'sweep-stale', authority },
        },
      ],
    });
    // present + relevant → folded
    {
      const { call, calls } = fakeCall({
        ...CORE,
        'recipes:search': recipeHandler,
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'tidy the backlog' }, call, 'me');
      expect(calls.find((c) => c.name === 'recipes:search')!.args).toMatchObject({
        query: 'tidy the backlog',
        limit: 3,
      });
      expect(r.recipes).toEqual([
        {
          id: 'sweep-stale',
          title: 'Sweep stale items',
          runCount: 3,
          similarity: 0.7,
          authorityRefs: { harnesses: ['papercusp'] },
          runArgs: { id: 'sweep-stale', authority },
        },
      ]);
    }
    // includeRecipes:false → no recipes:search call, field absent
    {
      const { call, calls } = fakeCall({
        ...CORE,
        'recipes:search': recipeHandler,
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'tidy the backlog', includeRecipes: false }, call, 'me');
      expect(calls.some((c) => c.name === 'recipes:search')).toBe(false);
      expect(r.recipes).toBeUndefined();
    }
    // no intent/memoryQuery → nothing to search, field absent
    {
      const { call, calls } = fakeCall({ ...CORE, 'recipes:search': recipeHandler });
      const r = await composeOrient({}, call, 'me');
      expect(calls.some((c) => c.name === 'recipes:search')).toBe(false);
      expect(r.recipes).toBeUndefined();
    }
  });

  it('folds peersKnow by default and does not invoke the archive lookup when explicitly disabled', async () => {
    const intent = 'why does the vector scan stop before every relevant row is returned?';
    const hit = {
      answer: 'raise hnsw.ef_search before running the scan',
      ref: 'conv-known-answer',
      responder: 'agent-expert',
      closedAt: '2026-08-20T12:00:00.000Z',
      sim: 0.97,
    };
    const leanArgs = {
      intent,
      claimableLimit: 0,
      inboxLimit: 0,
      memoryLimit: 0,
      includePlanEvents: false,
      includeRecipes: false,
      includeFleetCatchUp: false,
      includeFleetHealth: false,
    };
    const composeWithPeersKnow = (
      args: Parameters<typeof composeOrient>[0],
      call: InnerCall,
      peersKnowFold: NonNullable<Parameters<typeof composeOrient>[14]>,
    ) =>
      composeOrient(
        args,
        call,
        'me',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        peersKnowFold,
      );

    const enabledFold = vi.fn(async () => hit);
    const { call: enabledCall } = fakeCall({
      ...CORE,
      'coord:declare-intent': () => ({ ok: true }),
    });
    const enabled = await composeWithPeersKnow(leanArgs, enabledCall, enabledFold);

    expect(enabledFold).toHaveBeenCalledOnce();
    expect(enabledFold).toHaveBeenCalledWith(intent);
    expect(enabled.peersKnow).toMatchObject(hit);
    expect(enabled.peersKnow?.more).toContain("conversations:get { id: 'conv-known-answer' }");

    const disabledFold = vi.fn(async () => hit);
    const { call: disabledCall } = fakeCall({
      ...CORE,
      'coord:declare-intent': () => ({ ok: true }),
    });
    const disabled = await composeWithPeersKnow({ ...leanArgs, includePeersKnow: false }, disabledCall, disabledFold);

    expect(disabledFold).not.toHaveBeenCalled();
    expect(disabled.peersKnow).toBeUndefined();
  });

  it('best-effort: a failing recipes:search degrades to null, not a thrown orient', async () => {
    const { call } = fakeCall({
      ...CORE,
      'recipes:search': () => {
        throw new Error('capability: intel:read required');
      },
      'coord:declare-intent': () => ({ ok: true }),
    });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.recipes).toBeNull();
    expect(r.claimable).toHaveLength(2);
  });

  it('memoryQuery overrides intent for the recall query', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'memory:search': () => ({ ok: true, results: [] }),
      'coord:declare-intent': () => ({ ok: true }),
    });
    await composeOrient({ intent: 'declare this', memoryQuery: 'search that' }, call, 'me');
    expect(calls.find((c) => c.name === 'memory:search')!.args).toMatchObject({ query: 'search that' });
    expect(calls.find((c) => c.name === 'coord:declare-intent')!.args).toMatchObject({ intent: 'declare this' });
  });

  it('includePlanEvents:false skips the plan-events fold', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    const r = await composeOrient({ includePlanEvents: false }, call, 'me');
    expect(calls.some((c) => c.name === 'coord:plan-events')).toBe(false);
    expect(r.planEvents).toBeUndefined();
  });

  it('D-008 COMPACT: truncates long memory text and caps the plan-events fold', async () => {
    const bigText = 'x'.repeat(5000);
    const manyEvents = Array.from({ length: 100 }, (_, i) => ({ i }));
    const { call } = fakeCall({
      ...CORE,
      'coord:plan-events': () => ({ events: manyEvents, total: 100, truncated: true }),
      'memory:search': () => ({ ok: true, results: [{ id: 'm', memory: bigText, score: 0.5 }] }),
      'coord:declare-intent': () => ({ ok: true }),
    });
    const r = await composeOrient({ intent: 'big' }, call, 'me');
    expect(r.memory!.hits[0].memory!.length).toBe(200); // MEMORY_TEXT_CAP
    expect(r.planEvents!.recent.length).toBe(10); // PLAN_EVENTS_FOLD
    expect(r.planEvents!.total).toBe(100); // true total still reported
    // whole serialized payload stays small despite huge inputs
    expect(JSON.stringify(r).length).toBeLessThan(4000);
  });

  // orient-recall-quality-2026-07-12 P-002/P-003: the AGGREGATE char budget over
  // the folded hits + the non-exhaustive advisory. Deterministic: fixture hits of
  // known size against an env-pinned budget.
  describe('memory fold aggregate budget + advisory (orient-recall-quality P-002/P-003)', () => {
    const ENV = 'PAPERCUSP_ORIENT_MEMORY_BUDGET_CHARS';
    afterEach(() => {
      delete process.env[ENV];
    });

    const bigHits = (n: number) => ({
      ok: true,
      // Each hit's text caps at MEMORY_TEXT_CAP (200) BEFORE the budget, so each
      // admitted hit costs ~200 + id + 24 overhead ≈ 226 chars. Distinct per-hit prefix so
      // the P-008 near-duplicate collapse doesn't fold these (identical text would be — and
      // should be — collapsed); the budget behavior under test is unchanged.
      results: Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        memory: `m${i} ` + 'x'.repeat(5000),
        score: 0.9 - i * 0.01,
      })),
    });

    it('admits hits in relevance order under the budget and reports withheldBudget loudly', async () => {
      process.env[ENV] = '500'; // fits 2 × ~226-char hits, not 3
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => bigHits(5),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'budget probe' }, call, 'me');
      expect(r.memory!.hits).toHaveLength(2);
      expect(r.memory!.hits.map((h) => h.id)).toEqual(['m0', 'm1']); // relevance order kept
      expect(r.memory!.withheldBudget).toBe(3); // loud, never silent
      expect(r.memory!.note).toBe(ORIENT_MEMORY_NOTE);
    });

    it('the FIRST hit is always admitted even when it alone exceeds the budget', async () => {
      process.env[ENV] = '10';
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => bigHits(4),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'tiny budget' }, call, 'me');
      expect(r.memory!.hits).toHaveLength(1);
      expect(r.memory!.withheldBudget).toBe(3);
    });

    it('an empty fold carries NO advisory note and no withheldBudget (zero noise on the empty path)', async () => {
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => ({ ok: true, results: [] }),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'nothing relevant' }, call, 'me');
      expect(r.memory!.hits).toHaveLength(0);
      expect(r.memory!.note).toBeUndefined();
      expect(r.memory!.withheldBudget).toBeUndefined();
    });

    it('env <= 0 disables the aggregate budget (all kept hits fold)', async () => {
      process.env[ENV] = '0';
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => bigHits(5),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'uncapped' }, call, 'me');
      expect(r.memory!.hits).toHaveLength(5);
      expect(r.memory!.withheldBudget).toBeUndefined();
    });
  });

  it('best-effort: a failing memory recall or declare degrades to null/false, not a thrown orient', async () => {
    // EI-21127719036550806: declare-intent is now wrapped in withBoundedTimeout,
    // which logs a console.warn on a caught failure — expected here since this
    // test deliberately makes coord:declare-intent throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = fakeCall({
      ...CORE,
      'memory:search': () => {
        throw new Error('memory_timeout');
      },
      'coord:declare-intent': () => {
        throw new Error('capability: coord:write required');
      },
    });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.memory).toBeNull();
    expect(r.intentDeclared).toBe(false);
    // core orientation still intact
    expect(r.claimable).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('folds a fleet catch-up when the caller belongs to a fleet (P-006 auto-catch-up)', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({
        audience: '@fleet:backend',
        count: 2,
        total: 5,
        rows: [{ msg_id: 'f1' }, { msg_id: 'f2' }],
      }),
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 5, recent: [{ msg_id: 'f1' }, { msg_id: 'f2' }] });
    // addressed the caller's OWN fleet, bounded by the default fold limit
    expect(calls.find((c) => c.name === 'coord:catch-up')!.args).toMatchObject({
      audience: '@fleet:backend',
      limit: 8,
    });
  });

  it('skips fleet catch-up when fleetCatchUpLimit=0 for a narrow bootstrap', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 1, rows: [{ msg_id: 'unexpected' }] }),
    });
    const r = await composeOrient({ fleetCatchUpLimit: 0 }, call, 'me');
    expect(calls.some((c) => c.name === 'coord:catch-up')).toBe(false);
    expect(r.fleetCatchUp).toBeUndefined();
  });

  it('skips the fleet catch-up for a non-fleet caller (no catch-up call, field absent)', async () => {
    const { call, calls } = fakeCall({ ...CORE }); // CORE whoami → fleetSlug null
    const r = await composeOrient({}, call, 'me');
    expect(calls.some((c) => c.name === 'coord:catch-up')).toBe(false);
    expect(r.fleetCatchUp).toBeUndefined();
  });

  it('accepts legacy includeCatchup as an alias for includeFleetCatchUp', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
    });
    const r = await composeOrient({ includeCatchup: false }, call, 'me');
    expect(calls.some((c) => c.name === 'coord:catch-up')).toBe(false);
    expect(r.fleetCatchUp).toBeUndefined();
  });

  it('accepts stale includeFleetCatchup casing as an alias for includeFleetCatchUp', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
    });
    const r = await composeOrient({ includeFleetCatchup: false }, call, 'me');
    expect(calls.some((c) => c.name === 'coord:catch-up')).toBe(false);
    expect(r.fleetCatchUp).toBeUndefined();
  });

  it('maps legacy includeFleet:false to both optional fleet folds while retaining assignments', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
      'coord:glance': () => ({ bees: { running: 0, working: 0 } }),
    });
    const r = await composeOrient({ includeFleet: false, includeAssignments: false }, call, 'me');
    expect(r.fleetCatchUp).toBeUndefined();
    expect(r.fleetHealth).toBeUndefined();
    expect(calls.some(({ name }) => name === 'fleet:assignments')).toBe(true);
    expect(calls.some(({ name }) => name === 'coord:catch-up')).toBe(false);
    expect(calls.some(({ name }) => name === 'coord:glance')).toBe(false);
  });

  it('lets canonical fleet controls override the legacy includeFleet alias', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
      'coord:glance': () => ({ bees: { running: 0, working: 0 } }),
    });
    const r = await composeOrient(
      { includeFleet: false, includeFleetCatchUp: true, includeFleetHealth: true },
      call,
      'me',
    );
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 0, recent: [] });
    expect(r.fleetHealth).toEqual({
      schemaVersion: ORIENT_FLEET_HEALTH_SCHEMA_VERSION,
      status: 'available',
      ref: 'coord:glance',
    });
    expect(calls.some(({ name }) => name === 'coord:catch-up')).toBe(true);
    expect(calls.some(({ name }) => name === 'coord:glance')).toBe(true);
  });

  it('best-effort: a failing fleet catch-up degrades to null, not a thrown orient', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => {
        throw new Error('capability: coord:read required');
      },
      'coord:glance': () => ({ bees: { running: 0, working: 0 } }),
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.fleetCatchUp).toBeNull();
    expect(r.claimable).toHaveLength(2);
  });

  // ── fold #1 (D-002): a tiny fleet-health availability/reference ──
  const GLANCE = () => ({
    ok: true,
    bees: { running: 3, working: 2 },
    wake: { default: 'auto', stagedTotal: 1, stagedOwners: 1 },
    governor: { anyPaused: false, paused: [] },
    activity: [{ x: 1 }],
    tips: ['t'],
    display: { title: 'human render' },
  });

  it('folds only fleet-health availability + ref for a fleet caller; rich state stays behind coord:glance', async () => {
    const { call, calls } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
      'coord:glance': GLANCE,
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.fleetHealth).toEqual({
      schemaVersion: ORIENT_FLEET_HEALTH_SCHEMA_VERSION,
      status: 'available',
      ref: 'coord:glance',
    });
    // called with the lean agent audience + no activity rows (skip the human render).
    expect(calls.find((c) => c.name === 'coord:glance')!.args).toMatchObject({ audience: 'su', activity_limit: 0 });
  });

  it('skips the fleet-health glance off-fleet, and when includeFleetHealth:false', async () => {
    // non-fleet caller → no glance call, field absent
    {
      const { call, calls } = fakeCall({ ...CORE, 'coord:glance': GLANCE });
      const r = await composeOrient({}, call, 'me');
      expect(calls.some((c) => c.name === 'coord:glance')).toBe(false);
      expect(r.fleetHealth).toBeUndefined();
    }
    // in a fleet but includeFleetHealth:false → no glance call
    {
      const { call, calls } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 0, rows: [] }),
        'coord:glance': GLANCE,
      });
      const r = await composeOrient({ includeFleetHealth: false }, call, 'me');
      expect(calls.some((c) => c.name === 'coord:glance')).toBe(false);
      expect(r.fleetHealth).toBeUndefined();
    }
  });

  it('best-effort: a failing fleet-health glance is explicitly unavailable with a recovery ref', async () => {
    // WI-3818: the glance leg is now wrapped in withBoundedTimeout, which logs a
    // console.warn on a caught failure (visibility into a degraded leg) — expected
    // here since this test deliberately makes coord:glance throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
      'coord:glance': () => {
        throw new Error('capability: coord:read required');
      },
    });
    const r = await composeOrient({}, call, 'me');
    expect(r.ok).toBe(true);
    expect(r.fleetHealth).toEqual({
      schemaVersion: ORIENT_FLEET_HEALTH_SCHEMA_VERSION,
      status: 'unavailable',
      ref: 'coord:glance',
      reason: 'coord:glance read failed or timed out',
    });
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 0, recent: [] });
    expect(r.claimable).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ── fold #2 (compaction-fold-audit-2026-07-06): afterCompaction beefs the inbox ──
  it('afterCompaction folds MORE inbox entries + fuller bodies (an explicit inboxLimit still wins)', async () => {
    const { call, calls } = fakeCall({ ...CORE });
    await composeOrient({ afterCompaction: true }, call, 'me');
    expect(calls.find((c) => c.name === 'coord:inbox')!.args).toMatchObject({ limit: 25, max_body_chars: 800 });

    const { call: c2, calls: k2 } = fakeCall({ ...CORE });
    await composeOrient({ afterCompaction: true, inboxLimit: 7 }, c2, 'me');
    expect(k2.find((c) => c.name === 'coord:inbox')!.args).toMatchObject({ limit: 7, max_body_chars: 800 });
  });

  // ── EI-8300: mode:'monitor' skips the heavy legs entirely (not just capped output) ──
  describe("mode: 'monitor' (EI-8300 lean leader/monitor-loop tick)", () => {
    it('skips claimable/plan-events/fleet-catch-up/recipes entirely, even with intent set', async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }), // would trigger catch-up in full mode
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'watch the fleet', mode: 'monitor' }, call, 'leader');
      expect(r.ok).toBe(true);
      expect(r.claimable).toEqual([]);
      // EI-18725816532600240: facts are NARROWED, not skipped — the never-drop fold
      // runs (returning nothing here), the FULL fold does not.
      expect(foldNeverDropFactsMock).toHaveBeenCalledTimes(1);
      expect(foldFactsMock).not.toHaveBeenCalled();
      expect(r.planEvents).toBeUndefined();
      expect(r.fleetCatchUp).toBeUndefined();
      expect(r.fleetHealth).toBeUndefined(); // fold #1 skipped on a monitor tick too
      expect(r.recipes).toBeUndefined();
      expect(r.memory).toBeUndefined(); // no recall even though `intent` was passed
      expect(r.intentDeclared).toBe(true); // declare-intent still fires (cheap, peer-visible)
      // no round-trip at all for the skipped legs — not just an empty/capped result
      const called = new Set(calls.map((c) => c.name));
      expect(called.has('work_items:list')).toBe(false);
      expect(called.has('coord:plan-events')).toBe(false);
      expect(called.has('coord:catch-up')).toBe(false);
      expect(called.has('coord:glance')).toBe(false); // fold #1: no fleet-health glance on a monitor tick
      expect(called.has('coord:whoami')).toBe(false); // fleet block skipped wholesale
      expect(called.has('recipes:search')).toBe(false);
      expect(called.has('memory:search')).toBe(false);
      expect(called.has('conversations:list')).toBe(false); // WI-5951: orient never reads conversations at all now
      // the core kept legs still run
      expect(called.has('fleet:assignments')).toBe(true);
      expect(called.has('coord:inbox')).toBe(true);
      expect(called.has('coord:declare-intent')).toBe(true);
    });

    it('still returns fleet:assignments (me) and the inbox read', async () => {
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ mode: 'monitor' }, call, 'leader');
      expect((r.me as { agents: Array<{ ownerId: string }> }).agents[0].ownerId).toBe('me');
      expect((r.inbox.summary as { total: number }).total).toBe(3);
    });

    it("default (omitted mode / 'full') is byte-identical to today — every heavy leg still runs", async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.claimable).toHaveLength(2);
      expect(calls.some((c) => c.name === 'work_items:list')).toBe(true);
    });

    // ── fleet-leader-frictions P-004: monitor inbox scoped to since-last-shown ──
    describe('monitor inbox watermark (fleet-leader-frictions P-004)', () => {
      const WM_TS = '2026-07-10T03:30:00.000Z';

      // ── RETIRED by D-013 R1 (plan fleet-deltas-leader-primitives-2026-07-10) ──
      // This block used to pin the OPPOSITE contract: monitor mode read
      // `coord:watermark` and scoped the inbox to `since_ts = read_through_ts`.
      //
      // Why that was withdrawn rather than merely made unnecessary: scoping to
      // "newer than what you were last SHOWN" can HIDE a message the agent was
      // shown but has not acted on — and `read_through_ts` advances on the mere
      // act of rendering an inbox, not on the agent doing anything about it. For
      // a monitor loop, whose whole job is to notice outstanding work, that is
      // precisely the wrong window. `unanswered` remains the actionable signal
      // and is computed independently of it.
      //
      // `coord:inbox` is now a VIEW with no caller-supplied floor at all, so the
      // three cases here (scoped / null-watermark / watermark-read-failed) have
      // collapsed into one contract, pinned below. The `coord:watermark` call is
      // gone with them — a whole round-trip that existed only to derive a floor.
      it('monitor mode passes NO floor and does not read the watermark at all (D-013 R1)', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => ({ owner_id: 'leader', self: true, read_through_ts: WM_TS }),
        });
        const r = await composeOrient({ mode: 'monitor' }, call, 'leader');
        expect(r.ok).toBe(true);
        // Even with a perfectly good watermark ON OFFER, it is neither fetched
        // nor applied — that is what makes this a contract and not an accident
        // of the fixture.
        expect(calls.some((c) => c.name === 'coord:watermark')).toBe(false);
        const inboxCall = calls.find((c) => c.name === 'coord:inbox');
        expect(inboxCall?.args.since_ts).toBeUndefined();
      });

      it('a broken watermark source is irrelevant now — orient never touches it', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => {
            throw new Error('pg down');
          },
        });
        const r = await composeOrient({ mode: 'monitor' }, call, 'leader');
        expect(r.ok).toBe(true);
        expect(calls.some((c) => c.name === 'coord:watermark')).toBe(false);
        expect(calls.find((c) => c.name === 'coord:inbox')?.args.since_ts).toBeUndefined();
      });

      it('FULL mode never reads the watermark (unscoped inbox as today)', async () => {
        const { call, calls } = fakeCall({ ...CORE });
        await composeOrient({}, call, 'me');
        expect(calls.some((c) => c.name === 'coord:watermark')).toBe(false);
        expect(calls.find((c) => c.name === 'coord:inbox')?.args.since_ts).toBeUndefined();
      });

      it('afterCompaction OVERRIDES the scoping — a compacted agent needs the fuller re-read ("already shown" ≠ "already known")', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'coord:watermark': () => ({ read_through_ts: WM_TS }),
        });
        await composeOrient({ mode: 'monitor', afterCompaction: true }, call, 'leader');
        expect(calls.some((c) => c.name === 'coord:watermark')).toBe(false);
        const inboxCall = calls.find((c) => c.name === 'coord:inbox');
        expect(inboxCall?.args.since_ts).toBeUndefined();
        expect(inboxCall?.args).toMatchObject({ limit: 25, max_body_chars: 800 });
      });
    });
  });

  // ── fleet-reliability-verification-2026-07-10 P-007: leaderBrief fold ──
  describe("mode:'monitor' leaderBrief fold (P-007)", () => {
    const LEADER_BRIEF_RESULT = { ok: true, summary: { fleet: 'p2p-git', members: 2 }, members: [] };

    it('a resolvable fleet LEADER on a monitor tick gets fleet:leader-brief folded in', async () => {
      const brief = {
        ...LEADER_BRIEF_RESULT,
        members: [{ agentId: 'su-1', workItemIds: ['WI-1', 'WI-outside'] }],
      };
      const claimSpec = {
        source: 'fleet',
        revision: 4,
        harnessSlug: 'papercusp',
        spec: {
          specId: 'rev4',
          view: { filter: { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] } },
        },
      };
      const scopedBurndown = {
        counts: { total: 2, terminal: 1, inFlight: 0, parked: 1, unclaimed: 0 },
        cohortAudit: {
          rows: [
            {
              id: 'WI-1',
              title: 'bare close',
              state: 'done',
              bucket: 'terminal',
              evidenceVerdict: 'missing',
              reopenRecommended: true,
              recommendation: 'reopen',
            },
            {
              id: 'WI-2',
              title: 'owner gate',
              state: 'needs-human',
              bucket: 'parked',
              evidenceVerdict: 'not-applicable',
              reopenRecommended: false,
              recommendation: null,
            },
          ],
        },
      };
      const { call, calls } = fakeCall({
        ...CORE,
        'fleet:leader-brief': () => brief,
        'scheduler:get_claim_spec': () => claimSpec,
        'work_items:burn_down': () => scopedBurndown,
        'coord:walls': () => ({ ok: true, count: 0, walls: [] }),
      });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'leader' },
      );
      expect(r.leaderBrief).toEqual({
        ...brief,
        claimSpec,
        scopedBurndown,
        outOfScopeAssignments: [{ agentId: 'su-1', id: 'WI-outside' }],
        integrityWarnings: [
          {
            id: 'WI-1',
            title: 'bare close',
            state: 'done',
            evidenceVerdict: 'missing',
            reopenRecommended: true,
            recommendation: 'reopen',
          },
        ],
        walls: { ok: true, count: 0, walls: [] },
        announcedGates: [],
        release: {
          status: 'unavailable',
          reason: 'pipeline fold unavailable',
          recoverVia: 'dev:pipeline_position { path }',
        },
        orientProjection: {
          schemaVersion: ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
          status: 'available',
          kind: 'rich-fold',
          recoverVia: "fleet:leader-brief { fleet: 'p2p-git' }",
        },
      });
      const briefCall = calls.find((c) => c.name === 'fleet:leader-brief');
      expect(briefCall?.args).toMatchObject({ fleet: 'p2p-git' });
      expect(calls.find((c) => c.name === 'scheduler:get_claim_spec')?.args).toEqual({ fleet: 'p2p-git' });
      expect(calls.find((c) => c.name === 'work_items:burn_down')?.args).toEqual({
        harness: 'papercusp',
        ids: ['WI-1', 'WI-2'],
      });
      expect(calls.find((c) => c.name === 'coord:walls')?.args).toEqual({});
    });

    it('a non-leader fleet MEMBER never triggers the fold (no round-trip)', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'member',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'member' },
      );
      expect(r.leaderBrief).toBeUndefined();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
    });

    it('a leader with NO fleet resolvable never triggers the fold', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: null, fleetRole: null },
      );
      expect(r.leaderBrief).toBeUndefined();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
    });

    it('ordinary FULL mode folds the bounded actionable summary for a registered leader', async () => {
      const richBrief = {
        ...LEADER_BRIEF_RESULT,
        summary: {
          fleet: 'p2p-git',
          members: 14,
          dead: 1,
          stalled: 1,
          idle_with_claimable: 2,
          abandoned_unclaimed: 1,
        },
        members: [
          ...Array.from({ length: 13 }, (_, i) => ({
            agentId: `su-healthy-${i}`,
            verdict: 'speaking',
            sessionState: 'live',
          })),
          { agentId: 'su-dead', verdict: 'dead', sessionState: 'ended' },
        ],
        memberVerdicts: [
          ...Array.from({ length: 13 }, (_, i) => ({ agentId: `su-healthy-${i}`, verdict: 'speaking' })),
          { agentId: 'su-dead', verdict: 'dead' },
        ],
        abandonedUnclaimed: [
          {
            id: 'WI-abandoned',
            title: 'resume the partially completed item',
            status: 'open',
            priority: 'high',
          },
        ],
        delta: { roster: { available: true, from: 13, to: 14 } },
        deltaSummary: 'members +1, dead +1',
        fleetMetrics: {
          ok: false,
          schemaVersion: 'fleet-metrics-v1',
          error: 'fleet_metrics_unavailable',
          reason: 'bounded canonical read timed out',
          recoverVia: "work_items:burn_down { fleet: 'p2p-git' }",
          requested: {
            fleet: 'p2p-git',
            harness: 'papercusp',
            flowMode: 'current-spec',
            window: 'fleet-lifetime',
          },
        },
      };
      const { call, calls } = fakeCall({ ...CORE, 'fleet:leader-brief': () => richBrief });
      const r = await composeOrient({}, call, 'leader', undefined, undefined, undefined, undefined, undefined, {
        fleetSlug: 'p2p-git',
        fleetRole: 'leader',
      });
      const folded = r.leaderBrief as Record<string, unknown>;
      expect(folded.orientProjection).toEqual({
        schemaVersion: ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
        status: 'available',
        kind: 'bounded-summary',
        recoverVia: "fleet:leader-brief { fleet: 'p2p-git' }",
      });
      expect(folded.summary).toMatchObject({ dead: 1, stalled: 1, idle_with_claimable: 2, abandoned_unclaimed: 1 });
      expect(folded.abandonedUnclaimed).toEqual([
        {
          id: 'WI-abandoned',
          title: 'resume the partially completed item',
          status: 'open',
          priority: 'high',
        },
      ]);
      expect(folded.delta).toEqual(richBrief.delta);
      expect(folded.deltaSummary).toBe(richBrief.deltaSummary);
      expect(folded.fleetMetrics).toEqual(richBrief.fleetMetrics);
      expect(folded.memberVerdicts).toContainEqual({ agentId: 'su-dead', verdict: 'dead' });
      expect(folded.membersTruncated).toMatchObject({ total: 14, shown: 3 });
      expect(folded.release).toMatchObject({ status: 'unavailable', recoverVia: 'dev:pipeline_position { path }' });
      expect(JSON.stringify(folded).length).toBeLessThan(6_000);
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(true);
    });

    // EI-19282566865609166: the RECOVERY orient is the one full-mode call that must fold.
    // A leader coming back from a compaction has the least context and the most to
    // misread: `me` is fleet:assignments scoped to SELF, but its summary carries
    // fleet-shaped field names (agents / orphaned_claims / coverage_collisions) plus
    // `agentsElided: 0`. Measured live 2026-08-01 — the leader of an ELEVEN-member fleet
    // read `agents: 1` off a full-mode afterCompaction orient and opened its turn
    // reporting the fleet dead; leader-brief seconds later showed 11 members, 0 dead,
    // 5 idle-with-claimable, 2 unanswered directed messages.
    it('an afterCompaction RECOVERY orient folds the brief for a leader even in FULL mode', async () => {
      const { call, calls } = fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT });
      const r = await composeOrient(
        { afterCompaction: true },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'leader' },
      );
      expect(r.leaderBrief).toBeDefined();
      expect(r.leaderBrief).not.toBeNull();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(true);
    });

    it('an afterCompaction recovery orient does NOT fold for a non-leader member', async () => {
      // The recovery widening is scoped to the role that can misread it — it must not
      // become a blanket extra round-trip on every member's post-compaction wake.
      const { call, calls } = fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT });
      const r = await composeOrient(
        { afterCompaction: true },
        call,
        'member',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'member' },
      );
      expect(r.leaderBrief).toBeUndefined();
      expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
    });

    it('a failed leaderBrief fold is explicitly unavailable with version and recoverVia', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:leader-brief': () => {
          throw new Error('down');
        },
      });
      const r = await composeOrient(
        { mode: 'monitor' },
        call,
        'leader',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'p2p-git', fleetRole: 'leader' },
      );
      expect(r.ok).toBe(true);
      expect(r.leaderBrief).toEqual({
        orientProjection: {
          schemaVersion: ORIENT_LEADER_BRIEF_SCHEMA_VERSION,
          status: 'unavailable',
          reason: 'fleet:leader-brief read failed',
          recoverVia: "fleet:leader-brief { fleet: 'p2p-git' }",
        },
      });
    });

    describe('EI-203907 all-led fleetSummaries fold', () => {
      const leaderMembership = { fleetSlug: 'p2p-git', fleetRole: 'leader' };

      it('passes the detailed home brief to the summary fold on a monitor tick', async () => {
        const { call } = fakeCall({
          ...CORE,
          'fleet:leader-brief': () => LEADER_BRIEF_RESULT,
        });
        const fleetSummariesFold = vi.fn(async (homeFleet: string, homeBrief: unknown) => [
          {
            fleet: homeFleet,
            summary: (homeBrief as { summary: Record<string, unknown> | null }).summary,
          },
          { fleet: 'android', summary: { members: 4, stalled: 1, cumulative: { admission_blocked: 2 } } },
        ]);

        const r = await composeOrient(
          { mode: 'monitor' },
          call,
          'leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          leaderMembership,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          fleetSummariesFold,
        );

        expect(fleetSummariesFold).toHaveBeenCalledWith(
          'p2p-git',
          expect.objectContaining({ summary: LEADER_BRIEF_RESULT.summary }),
        );
        expect(r.fleetSummaries).toEqual([
          { fleet: 'p2p-git', summary: LEADER_BRIEF_RESULT.summary },
          { fleet: 'android', summary: { members: 4, stalled: 1, cumulative: { admission_blocked: 2 } } },
        ]);
      });

      it('runs the summary fold on afterCompaction recovery but not an ordinary full orient', async () => {
        const fold = vi.fn(async () => []);
        const ordinary = await composeOrient(
          {},
          fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT }).call,
          'leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          leaderMembership,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          fold,
        );
        expect(ordinary.fleetSummaries).toBeUndefined();
        expect(fold).not.toHaveBeenCalled();

        const recovered = await composeOrient(
          { afterCompaction: true },
          fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT }).call,
          'leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          leaderMembership,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          fold,
        );
        expect(recovered.fleetSummaries).toEqual([]);
        expect(fold).toHaveBeenCalledTimes(1);
      });

      it('keeps a failed all-led summary read explicit without breaking orientation', async () => {
        const { call } = fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT });
        const fleetSummariesFold = vi.fn(async () => {
          throw new Error('registry unavailable');
        });
        const r = await composeOrient(
          { mode: 'monitor' },
          call,
          'leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          leaderMembership,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          fleetSummariesFold,
        );
        expect(r.ok).toBe(true);
        expect(r.fleetSummaries).toBeNull();
      });
    });

    // ── EI-18731216945970087: presence/registry leadership DRIFT ──
    describe('presence/registry drift recovery (EI-18731216945970087)', () => {
      it('presence resolves NO fleet, but the registry says the caller leads one: leaderBrief still folds + a LOUD presenceDrift is reported', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'fleet:leader-brief': () => LEADER_BRIEF_RESULT,
        });
        const presenceDriftCheck = vi.fn(async () => 'mail-retirement');
        const r = await composeOrient(
          { mode: 'monitor' },
          call,
          'su-leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          // presence itself found NO fleet — the exact reported failure shape.
          { fleetSlug: null, fleetRole: null },
          undefined,
          undefined,
          presenceDriftCheck,
        );
        expect(presenceDriftCheck).toHaveBeenCalledTimes(1);
        expect(r.leaderBrief).toMatchObject({
          ...LEADER_BRIEF_RESULT,
          claimSpec: null,
        });
        expect(r.presenceDrift).toEqual({
          fleet: 'mail-retirement',
          note: expect.stringContaining('PRESENCE DRIFT'),
        });
        expect(calls.find((c) => c.name === 'fleet:leader-brief')?.args).toMatchObject({
          fleet: 'mail-retirement',
        });
      });

      it('presence resolves the caller as a member, but the registry says it leads that same fleet: role and leaderBrief are reconciled together', async () => {
        const { call, calls } = fakeCall({
          ...CORE,
          'fleet:assignments': () => ({
            ok: true,
            agents: [{ agentId: 'su-leader', fleetSlug: 'p2p-git', fleetRole: 'member' }],
          }),
          'fleet:leader-brief': () => LEADER_BRIEF_RESULT,
        });
        const fleetLeadershipCheck = vi.fn(async () => 'p2p-git');
        const r = await composeOrient(
          { mode: 'monitor' },
          call,
          'su-leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { fleetSlug: 'p2p-git', fleetRole: 'member' },
          undefined,
          undefined,
          undefined,
          fleetLeadershipCheck,
        );

        expect(fleetLeadershipCheck).toHaveBeenCalledTimes(1);
        expect(r.leaderBrief).toMatchObject(LEADER_BRIEF_RESULT);
        expect(r.presenceDrift).toEqual({
          fleet: 'p2p-git',
          note: expect.stringContaining("reported fleetRole 'member'"),
        });
        expect((r.me as { agents: Array<Record<string, unknown>> }).agents[0]).toMatchObject({
          agentId: 'su-leader',
          fleetSlug: 'p2p-git',
          fleetRole: 'leader',
        });
        expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(true);
      });

      it('the registry AGREES the caller leads nothing: no drift reported, no leaderBrief fold, presenceDriftCheck still only fires once', async () => {
        const { call, calls } = fakeCall({ ...CORE });
        const presenceDriftCheck = vi.fn(async () => null);
        const r = await composeOrient(
          { mode: 'monitor' },
          call,
          'su-1',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { fleetSlug: null, fleetRole: null },
          undefined,
          undefined,
          presenceDriftCheck,
        );
        expect(presenceDriftCheck).toHaveBeenCalledTimes(1);
        expect(r.presenceDrift).toBeUndefined();
        expect(r.leaderBrief).toBeUndefined();
        expect(calls.some((c) => c.name === 'fleet:leader-brief')).toBe(false);
      });

      it('presence ALREADY resolved a fleet (member or leader): the drift check never runs — no extra round-trip on the common path', async () => {
        const { call } = fakeCall({ ...CORE, 'fleet:leader-brief': () => LEADER_BRIEF_RESULT });
        const presenceDriftCheck = vi.fn(async () => 'some-other-fleet');
        await composeOrient(
          { mode: 'monitor' },
          call,
          'su-member',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { fleetSlug: 'p2p-git', fleetRole: 'member' },
          undefined,
          undefined,
          presenceDriftCheck,
        );
        expect(presenceDriftCheck).not.toHaveBeenCalled();
      });

      it('FULL mode uses registry authority to recover a leader whose presence has no fleet', async () => {
        const { call } = fakeCall({ ...CORE });
        const presenceDriftCheck = vi.fn(async () => 'mail-retirement');
        const r = await composeOrient(
          {},
          call,
          'su-leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { fleetSlug: null, fleetRole: null },
          undefined,
          undefined,
          presenceDriftCheck,
        );
        expect(presenceDriftCheck).toHaveBeenCalledTimes(1);
        expect(r.presenceDrift).toMatchObject({ fleet: 'mail-retirement' });
        expect(r.leaderBrief).toBeDefined();
      });

      it('a throwing presenceDriftCheck degrades silently — never breaks orientation, no leaderBrief', async () => {
        const { call } = fakeCall({ ...CORE });
        const presenceDriftCheck = vi.fn(async () => {
          throw new Error('registry down');
        });
        const r = await composeOrient(
          { mode: 'monitor' },
          call,
          'su-leader',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { fleetSlug: null, fleetRole: null },
          undefined,
          undefined,
          presenceDriftCheck,
        );
        expect(r.ok).toBe(true);
        expect(r.presenceDrift).toBeUndefined();
        expect(r.leaderBrief).toBeUndefined();
      });
    });
  });

  // ── P-002 / D-001: queen-loop steering is withheld from a RESPONSIVE caller's recall ──
  const STEERING_RECALL = {
    'memory:search': () => ({
      ok: true,
      results: [
        {
          id: 'm-steer',
          memory: 'Owner steering flipped: pauseNewWork=true, maxBees=3. Place no new bees.',
          score: 0.9,
        },
        { id: 'm-ok', memory: 'prefers nuqs over useState', score: 0.8 },
      ],
    }),
    'coord:declare-intent': () => ({ ok: true }),
  };

  it('a responsive caller does NOT receive pauseNewWork/maxBees as a binding recall hit', async () => {
    const { call } = fakeCall({ ...CORE, ...STEERING_RECALL });
    const r = await composeOrient({ intent: 'my task' }, call, 'su-leader', 'responsive');
    expect(r.memory!.hits.map((h) => h.id)).toEqual(['m-ok']); // steering hit stripped
    expect(r.memory!.withheld).toBe(1);
  });

  it('an AUTO caller (the queen-bee loop) still receives its own steering recall', async () => {
    const { call } = fakeCall({ ...CORE, ...STEERING_RECALL });
    const r = await composeOrient({ intent: 'place work' }, call, 's-queen', 'auto');
    expect(r.memory!.hits.map((h) => h.id)).toEqual(['m-steer', 'm-ok']);
    expect(r.memory!.withheld).toBeUndefined();
  });

  it('no driveMode passed ⇒ nothing withheld (backward-compatible default)', async () => {
    const { call } = fakeCall({ ...CORE, ...STEERING_RECALL });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.memory!.hits).toHaveLength(2);
    expect(r.memory!.withheld).toBeUndefined();
  });

  // ── P-007 (coord-authority-hardening): facts fold — recipient audience filter
  // + provenance-hydrated src projection ──
  describe('P-007 facts fold: audience filter + provenance-hydrated src', () => {
    const FLEET_CTX = {
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
    };
    const baseFact = {
      key: 'k',
      createdBy: 'x',
      updatedAt: '2026-07-11T00:00:00Z',
      expiresAt: '2026-07-18T00:00:00Z',
    };

    it('a fleet caller folds with audiences [fleet:<slug>]; aud + verified quote projected', async () => {
      foldFactsMock.mockResolvedValue([
        {
          ...baseFact,
          scope: 'harness',
          scopeRef: 'h',
          body: 'fleet-scoped conclusion',
          sourceRef: 'msg:m-1',
          audienceScope: 'fleet:backend',
          sourceProvenance: {
            kind: 'msg',
            verified: true,
            quote: 'the verbatim origin',
            label: 'msg m-1',
            verifiedAt: 't',
          },
        },
        {
          ...baseFact,
          scope: 'workspace',
          scopeRef: null,
          body: 'plain',
          sourceRef: 'a-plan-slug',
          audienceScope: null,
          sourceProvenance: null,
        },
      ]);
      const { call } = fakeCall({ ...CORE, ...FLEET_CTX });
      const r = await composeOrient({ harness: 'h' }, call, 'me');
      expect(foldFactsMock).toHaveBeenCalledWith(
        [{ scope: 'workspace' }, { scope: 'owner', scopeRef: 'me' }, { scope: 'harness', scopeRef: 'h' }],
        { audiences: ['fleet:backend'] },
      );
      expect(r.facts).toEqual([
        {
          scope: 'harness',
          ref: 'h',
          body: 'fleet-scoped conclusion',
          src: 'msg:m-1 ✓ "the verbatim origin"',
          aud: 'fleet:backend',
        },
        { scope: 'workspace', ref: null, body: 'plain', src: 'a-plan-slug' },
      ]);
    });

    it('a non-fleet caller folds with an EMPTY audience list (only unrestricted facts)', async () => {
      const { call } = fakeCall({ ...CORE });
      await composeOrient({}, call, 'me');
      expect(foldFactsMock).toHaveBeenCalledWith(expect.anything(), { audiences: [] });
    });

    it('an UNVERIFIED typed sourceRef renders LOUDLY in src (never silently dropped)', async () => {
      foldFactsMock.mockResolvedValue([
        {
          ...baseFact,
          scope: 'workspace',
          scopeRef: null,
          body: 'b',
          sourceRef: 'msg:m-gone',
          audienceScope: null,
          sourceProvenance: { kind: 'msg', verified: false, error: 'not_found', verifiedAt: 't' },
        },
      ]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.facts).toEqual([
        { scope: 'workspace', ref: null, body: 'b', src: 'msg:m-gone ✗unverified (not_found)' },
      ]);
    });
  });

  // ── P-018: the fold projection is a WHITELIST, and it used to drop `kind` —
  // so a normative convention arrived byte-identical to a settled conclusion at
  // the one surface every agent reads every wake. Exactly the defect P-033 (e)
  // found in `toAgentMessageRow`. These pin that it stays projected. ──
  describe('P-018 facts fold: the MODALITY survives the projection', () => {
    const baseFact = {
      key: 'migrations-via-runner',
      createdBy: 'x',
      updatedAt: '2026-07-11T00:00:00Z',
      expiresAt: '2026-07-18T00:00:00Z',
      sourceRef: null,
      audienceScope: null,
      sourceProvenance: null,
    };

    it('projects kind + enforcement + a citable ref for a convention', async () => {
      foldFactsMock.mockResolvedValue([
        {
          ...baseFact,
          id: 12,
          scope: 'workspace',
          scopeRef: null,
          body: 'Apply migrations via db:migrate.',
          kind: 'convention',
          enforcement: { tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' },
        },
      ]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.facts).toEqual([
        {
          scope: 'workspace',
          ref: null,
          body: 'Apply migrations via db:migrate.',
          src: null,
          kind: 'convention',
          enforcement: { tier: 'gate', floor: 0.6, reviewBy: '2026-09-01' },
          // D-075 R1: the ref you cite it by, delivered with the rule itself.
          cite: 'fact:workspace:migrations-via-runner@v12',
        },
      ]);
    });

    it('a convention and a conclusion with the SAME body are distinguishable', async () => {
      const body = 'Apply migrations via db:migrate.';
      const fold = async (kind: string) => {
        foldFactsMock.mockResolvedValue([{ ...baseFact, id: 1, scope: 'workspace', scopeRef: null, body, kind }]);
        const { call } = fakeCall({ ...CORE });
        return (await composeOrient({}, call, 'me')).facts;
      };
      expect(await fold('convention')).not.toEqual(await fold('conclusion'));
    });

    it('adds NOTHING for a fact with no declared kind — the common case stays byte-identical', async () => {
      foldFactsMock.mockResolvedValue([
        { ...baseFact, id: 5, scope: 'workspace', scopeRef: null, body: 'b', kind: null },
      ]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.facts).toEqual([{ scope: 'workspace', ref: null, body: 'b', src: null }]);
    });

    it('a conclusion carries its kind but NOT a citation (only conventions are cited)', async () => {
      foldFactsMock.mockResolvedValue([
        { ...baseFact, id: 5, scope: 'workspace', scopeRef: null, body: 'b', kind: 'conclusion' },
      ]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.facts).toEqual([{ scope: 'workspace', ref: null, body: 'b', src: null, kind: 'conclusion' }]);
    });
  });

  // ── P-009 (coord-authority-hardening H4): fleet control-state fold — the
  // late-joiner read of a typed wind-down ──
  describe('P-009 fleet control-state fold', () => {
    const FLEET_CTX = {
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 0, rows: [] }),
    };

    it('a winding-down fleet folds fleetControl for a member orient (the late-joiner read)', async () => {
      getFleetMock.mockResolvedValue({
        fleetSlug: 'backend',
        controlState: 'winding-down',
        controlReason: 'release cut',
        controlBy: 'su-lead',
        controlAt: 1234,
      });
      const { call } = fakeCall({ ...CORE, ...FLEET_CTX });
      const r = await composeOrient({ harness: 'h' }, call, 'me');
      expect(getFleetMock).toHaveBeenCalledWith('ws-test', 'backend');
      expect(r.fleetControl).toEqual({
        fleet: 'backend',
        state: 'winding-down',
        reason: 'release cut',
        by: 'su-lead',
        since: 1234,
      });
    });

    it('an ACTIVE fleet folds nothing (zero noise on the common path)', async () => {
      getFleetMock.mockResolvedValue({
        fleetSlug: 'backend',
        controlState: 'active',
        controlReason: null,
        controlBy: null,
        controlAt: null,
      });
      const { call } = fakeCall({ ...CORE, ...FLEET_CTX });
      const r = await composeOrient({ harness: 'h' }, call, 'me');
      expect(r.fleetControl).toBeUndefined();
    });

    it('a NON-fleet caller never reads the registry; a registry hiccup degrades to absent', async () => {
      getFleetMock.mockClear(); // this file never clearAllMocks — scope the call count to THIS test
      const { call } = fakeCall({ ...CORE });
      const r1 = await composeOrient({}, call, 'me');
      expect(r1.fleetControl).toBeUndefined();
      expect(getFleetMock).not.toHaveBeenCalled();

      getFleetMock.mockRejectedValue(new Error('registry down'));
      const { call: call2 } = fakeCall({ ...CORE, ...FLEET_CTX });
      const r2 = await composeOrient({ harness: 'h' }, call2, 'me');
      expect(r2.fleetControl).toBeUndefined(); // best-effort — orientation never breaks
    });
  });

  describe('WI-5228 (kickoff-prompt-absorption-2026-07-17 P-002): orient-first plan bootstrap', () => {
    it('P-024: an explicit planSlug scopes the plan-events fold to that plan', async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'plans:get': () => ({ results: [{ now: null, items: [] }] }),
      });
      await composeOrient({ planSlug: 'explicit-plan', harness: 'h' }, call, 'me');
      expect(calls.find((c) => c.name === 'coord:plan-events')?.args).toMatchObject({
        plan_slug: 'explicit-plan',
        limit: 10,
      });
    });

    it("P-024: an omitted planSlug scopes plan-events to the self row's declared plan", async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: 'me', isSelf: true, declaredPlanSlug: 'presence-bound-plan', claims: [] }],
        }),
        'plans:get': () => ({ results: [{ now: null, items: [] }] }),
      });
      await composeOrient({}, call, 'me');
      expect(calls.find((c) => c.name === 'coord:plan-events')?.args).toMatchObject({
        plan_slug: 'presence-bound-plan',
        limit: 10,
      });
    });

    it('P-024: a genuinely planless caller keeps the broad plan-events fallback', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      await composeOrient({}, call, 'me');
      const args = calls.find((c) => c.name === 'coord:plan-events')?.args;
      expect(args).toMatchObject({ limit: 10 });
      expect(args).not.toHaveProperty('plan_slug');
    });

    it('an explicit planSlug folds the Now block + next actionable item + my claims', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [
            {
              agentId: 'me',
              isSelf: true,
              declaredPlanSlug: 'some-other-plan',
              claims: [
                { planSlug: 'kickoff-prompt-absorption-2026-07-17', id: 'P-001' },
                { planSlug: 'a-different-plan', id: 'P-999' },
              ],
            },
          ],
        }),
        'plans:get': () => ({
          results: [
            {
              now: { state: 'authored', next: 'first free member claims P-001' },
              items: [
                {
                  id: 'P-001',
                  text: 'Auto-arm the follow-on loop',
                  phase: 'Phase 1',
                  effectiveStatus: 'wip',
                  unresolvedBlockers: [],
                  needsHuman: false,
                },
                {
                  id: 'P-002',
                  text: 'Orient-first bootstrap',
                  phase: 'Phase 1',
                  effectiveStatus: 'todo',
                  unresolvedBlockers: [],
                  needsHuman: false,
                },
                {
                  id: 'P-004',
                  text: 'The shrink',
                  phase: 'Phase 2',
                  effectiveStatus: 'todo',
                  unresolvedBlockers: ['P-001'],
                  needsHuman: false,
                },
              ],
            },
          ],
        }),
      });
      const r = await composeOrient({ planSlug: 'kickoff-prompt-absorption-2026-07-17', harness: 'h' }, call, 'me');
      expect(r.planNow).toEqual({
        planSlug: 'kickoff-prompt-absorption-2026-07-17',
        state: 'authored',
        next: 'first free member claims P-001',
        // P-001 is 'wip' (not 'todo') so it's skipped; P-004 has an unresolved
        // blocker so it's skipped; P-002 is the first genuinely admissible item.
        nextActionable: { id: 'P-002', title: 'Orient-first bootstrap', phase: 'Phase 1' },
        // Only the claim inside THIS plan is surfaced, not the other-plan one.
        myClaims: ['P-001'],
      });
    });

    // ── EI-20108229813877389 regression guards.
    //
    // The test ABOVE mocks `claims` as an ARRAY. That shape is real, but it is
    // the `full` payload tier — which is NOT what orient's own
    // `fleet:assignments` call receives. The shaper collapses per-agent
    // `claims[]` to a COUNT at the trimmed AND standard tiers
    // (assignments-shape.ts:51,101), and trimmed is the default. So the green
    // test above asserted an output the production path could never produce,
    // while the leg threw a TypeError on EVERY real call and this leg's
    // `withBoundedTimeout` fallback turned it into a clean `planNow: null` —
    // indistinguishable from "this plan has no Now". These two cases pin the
    // shapes that actually reach orient.
    it('TRIMMED tier (claims collapsed to a COUNT): still folds Now + nextActionable, and reports myClaims as null-with-a-reason rather than a false empty', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          // The production shape: assignments-shape.ts emits `claims.length`.
          agents: [{ agentId: 'me', isSelf: true, declaredPlanSlug: null, claims: 2, load: 2 }],
        }),
        'plans:get': () => ({
          results: [
            {
              now: { state: 'authored', next: 'first free member claims P-001' },
              items: [
                {
                  id: 'P-002',
                  text: 'Orient-first bootstrap',
                  phase: 'Phase 1',
                  effectiveStatus: 'todo',
                  unresolvedBlockers: [],
                  needsHuman: false,
                },
              ],
            },
          ],
        }),
      });
      const r = await composeOrient({ planSlug: 'kickoff-prompt-absorption-2026-07-17', harness: 'h' }, call, 'me');
      // The leg must SURVIVE the collapsed shape — these three fields are the
      // whole point of the bootstrap and were being lost with it.
      expect(r.planNow?.state).toBe('authored');
      expect(r.planNow?.next).toBe('first free member claims P-001');
      expect(r.planNow?.nextActionable).toEqual({ id: 'P-002', title: 'Orient-first bootstrap', phase: 'Phase 1' });
      expect(r.planNow?.status).toBeUndefined(); // resolved, not degraded
      // `null`, NEVER `[]` — an empty array here says "I hold nothing in this
      // plan" to a caller holding 2 claims, trading a crash for a false zero.
      expect(r.planNow?.myClaims).toBeNull();
      expect(r.planNow?.myClaimsUnavailable).toMatch(/collapsed claims\[\] to a count \(2\)/);
    });

    it('a caller that omits `harness` still gets planNow — the inner plans:get is scoped, not refused', async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: 'me', isSelf: true, declaredPlanSlug: null, claims: 0 }],
        }),
        'plans:get': () => ({ results: [{ now: { state: 'authored', next: 'go' }, items: [] }] }),
      });
      // No `harness` — the common plan-bound path. Before the fix this made the
      // inner plans:get refuse with `harness_required`, which the fallback then
      // swallowed into a bare null.
      const r = await composeOrient({ planSlug: 'kickoff-prompt-absorption-2026-07-17' }, call, 'me');
      expect(r.planNow?.state).toBe('authored');
      const planGet = calls.find(
        (c) => c.name === 'plans:get' && (c.args as { slug?: string }).slug === 'kickoff-prompt-absorption-2026-07-17',
      )!;
      expect((planGet.args as { harness?: string }).harness).toBe('all');
    });

    it('a DEGRADED leg reports status:unknown in band — never a bare null that reads as "no Now"', async () => {
      // bounded-timeout legitimately warns on degrade; assert it, don't trip
      // vitest-fail-on-console.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: 'me', isSelf: true, declaredPlanSlug: null, claims: 0 }],
        }),
        'plans:get': () => {
          throw new Error('plans:get exploded');
        },
      });
      const r = await composeOrient({ planSlug: 'kickoff-prompt-absorption-2026-07-17', harness: 'h' }, call, 'me');
      expect(r.planNow?.status).toBe('unknown');
      expect(r.planNow?.why).toMatch(/exploded/);
      // The sibling fields mean NOT MEASURED here, never "empty".
      expect(r.planNow?.state).toBeNull();
      expect(r.planNow?.myClaims).toBeNull();
      warnSpy.mockRestore();
    });

    it('no planSlug + no declaredPlanSlug on the self row: planNow is null and plans:get is never called', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.planNow).toBeNull();
      expect(calls.some((c) => c.name === 'plans:get')).toBe(false);
    });

    it("falls back to the self row's declaredPlanSlug (fleet:assignments presence) when planSlug is omitted", async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: 'me', isSelf: true, declaredPlanSlug: 'my-bound-plan', claims: [] }],
        }),
        'plans:get': () => ({ results: [{ now: { state: 's', next: 'n' }, items: [] }] }),
      });
      const r = await composeOrient({}, call, 'me');
      expect(calls.find((c) => c.name === 'plans:get')?.args).toMatchObject({ slug: 'my-bound-plan' });
      expect(r.planNow).toEqual({
        planSlug: 'my-bound-plan',
        state: 's',
        next: 'n',
        nextActionable: null,
        myClaims: [],
      });
    });

    it('a monitor tick skips the leg entirely (no plans:get call, no extra round-trip)', async () => {
      const { call, calls } = fakeCall({ ...CORE });
      await composeOrient({ mode: 'monitor', planSlug: 'whatever' }, call, 'me');
      expect(calls.some((c) => c.name === 'plans:get')).toBe(false);
    });

    it('a plans:get failure degrades planNow WITHOUT throwing — and says so in band (best-effort)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'plans:get': () => {
          throw new Error('plan store unavailable');
        },
      });
      const r = await composeOrient({ planSlug: 'whatever', harness: 'h' }, call, 'me');
      // EI-20108229813877389 CHANGED THIS CONTRACT DELIBERATELY. This used to
      // assert `planNow === null`, which is exactly what let two independent
      // defects hide: a swallowed failure was byte-identical to "this plan has
      // no Now", so the leg could be dead in production for an unknown length
      // of time with a green suite. The failure must now be BRANCHABLE.
      expect(r.planNow?.status).toBe('unknown');
      expect(r.planNow?.why).toMatch(/plan store unavailable/);
      expect(r.ok).toBe(true); // orientation as a whole still succeeds
      warnSpy.mockRestore();
    });
  });
});

describe('memory-recall relevance floor — P-004 fleet-member-dx (EI-9017)', () => {
  const CORE_FLOOR = {
    'fleet:assignments': () => ({ ok: true, summary: {}, agents: [] }),
    'work_items:list': () => [],
    'coord:inbox': () => ({ summary: { total: 0 }, entries: [] }),
    'coord:plan-events': () => ({ total: 0, recent: [] }),
    'coord:whoami': () => ({ fleetSlug: null }),
    'recipes:search': () => ({ ok: true, recipes: [] }),
    'coord:declare-intent': () => ({ ok: true }),
  };

  // orient-recall-quality-2026-07-12 (live finding): the EI-9017 noise floor is
  // REGIME-SCOPED — it applies only to a DEGRADED response (the lexical-fallback
  // noise it was written for). A healthy hybrid response returns RRF rank-fusion
  // scores on the SAME numeric band (rank-1 ≈ 0.0164–0.0328 = a STRONG hit), so
  // the old blanket floor silently emptied orient's whole fold on hybrid configs.
  it('drops near-zero-score hits ONLY on a DEGRADED COSINE response and surfaces filteredLowScore', async () => {
    const { call } = fakeCall({
      ...CORE_FLOOR,
      'memory:search': () => ({
        ok: true,
        degraded: true,
        degraded_reason: 'embedding_backend_degraded',
        score_scale: 'cosine',
        results: [
          { id: 'good', memory: 'a real recall hit', score: 0.42 },
          { id: 'noise1', memory: 'lexical-fallback noise', score: 0.0306 },
          { id: 'noise2', memory: 'more noise', score: 0.016 },
        ],
      }),
    });
    const r = await composeOrient({ intent: 'do the thing' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['good']);
    expect((r.memory as { filteredLowScore?: number }).filteredLowScore).toBe(2);
  });

  it.each(['rrf', 'lexical', 'unknown', undefined] as const)(
    'a DEGRADED %s response fails open and retains its low-band hits',
    async (scoreScale) => {
      const { call } = fakeCall({
        ...CORE_FLOOR,
        'memory:search': () => ({
          ok: true,
          degraded: true,
          degraded_reason: 'embedding_backend_degraded',
          ...(scoreScale !== undefined ? { score_scale: scoreScale } : {}),
          results: [
            { id: 'rrf-or-lexical', memory: 'backend-native low-band score', score: 0.0164 },
            { id: 'another', memory: 'another backend-native low-band score', score: 0.03 },
          ],
        }),
      });
      const r = await composeOrient({ intent: `scale ${scoreScale ?? 'missing'}` }, call, 'me');
      expect(r.memory?.hits.map((h) => h.id)).toEqual(['rrf-or-lexical', 'another']);
      expect(r.memory?.filteredLowScore).toBeUndefined();
      expect(r.memory?.scoreScale).toBe(scoreScale);
    },
  );

  it('a HEALTHY response keeps RRF-band scores (0.016–0.033 = rank-1 hybrid hits, not noise)', async () => {
    const { call } = fakeCall({
      ...CORE_FLOOR,
      'memory:search': () => ({
        ok: true, // no degraded marker — backend admission already ran
        results: [
          { id: 'rrf-both-legs', memory: 'rank-1 on both legs', score: 0.0328 },
          { id: 'rrf-one-leg', memory: 'rank-1 on one leg', score: 0.0164 },
        ],
      }),
    });
    const r = await composeOrient({ intent: 'do the thing' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['rrf-both-legs', 'rrf-one-leg']);
    expect('filteredLowScore' in (r.memory as object)).toBe(false);
  });

  it('a hit with NO numeric score passes (fail-open), and no noise ⇒ no filteredLowScore key', async () => {
    const { call } = fakeCall({
      ...CORE_FLOOR,
      'memory:search': () => ({
        ok: true,
        results: [
          { id: 'unscored', memory: 'no score field' },
          { id: 'good', memory: 'scored fine', score: 0.5 },
        ],
      }),
    });
    const r = await composeOrient({ intent: 'do the thing' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['unscored', 'good']);
    expect('filteredLowScore' in (r.memory as object)).toBe(false);
  });
});

// ── EI-9031: orient must PROPAGATE memory:search's degraded signal so an empty
// recall during an embedding-backend outage is NOT read as "nothing relevant
// exists". Before the fix, orient dropped ok/reason/degraded and folded a bare
// `hits: []` — byte-indistinguishable from a genuine empty. ──
describe('memory recall degraded propagation — EI-9031', () => {
  const CORE_DEG = {
    'fleet:assignments': () => ({ ok: true, summary: {}, agents: [] }),
    'work_items:list': () => [],
    'coord:inbox': () => ({ summary: { total: 0 }, entries: [] }),
    'coord:plan-events': () => ({ total: 0, recent: [] }),
    'coord:whoami': () => ({ fleetSlug: null }),
    'recipes:search': () => ({ ok: true, recipes: [] }),
    'coord:declare-intent': () => ({ ok: true }),
  };

  it('stamps degraded + degradedReason when memory:search reports an embed failure (empty is NOT informative)', async () => {
    const { call } = fakeCall({
      ...CORE_DEG,
      // The exact shape the memory:search embed-failure branch returns.
      'memory:search': () => ({ ok: false, reason: 'embed_quota_exhausted', degraded: true, results: [] }),
    });
    const r = await composeOrient({ intent: 'own-log-fork-guard work' }, call, 'me');
    expect(r.memory?.hits).toEqual([]);
    expect((r.memory as { degraded?: boolean }).degraded).toBe(true);
    expect((r.memory as { degradedReason?: string }).degradedReason).toBe('embed_quota_exhausted');
  });

  it('stamps degraded from the ok:true reduced-breadth fallback (silent local-vec empty), preferring degraded_reason', async () => {
    const { call } = fakeCall({
      ...CORE_DEG,
      // OpenAI in cooldown → auto cascade fell back to local vec table → ok:true but empty.
      'memory:search': () => ({ ok: true, degraded: true, degraded_reason: 'embedding_backend_degraded', results: [] }),
    });
    const r = await composeOrient({ intent: 'own-log-fork-guard work' }, call, 'me');
    expect(r.memory?.hits).toEqual([]);
    expect((r.memory as { degraded?: boolean }).degraded).toBe(true);
    expect((r.memory as { degradedReason?: string }).degradedReason).toBe('embedding_backend_degraded');
  });

  it('a HEALTHY recall carries no degraded marker (backward-compatible)', async () => {
    const { call } = fakeCall({
      ...CORE_DEG,
      'memory:search': () => ({ ok: true, results: [{ id: 'm1', memory: 'a real hit', score: 0.7 }] }),
    });
    const r = await composeOrient({ intent: 'x' }, call, 'me');
    expect(r.memory?.hits.map((h) => h.id)).toEqual(['m1']);
    expect('degraded' in (r.memory as object)).toBe(false);
    expect('degradedReason' in (r.memory as object)).toBe(false);
  });
});

// ── P-004 (fleet-deltas-leader-primitives): monitor-mode fleet DELTA over the
// injected server-side read cursor — the caller carries nothing.
describe("mode:'monitor' fleet delta (P-004 server-side cursor)", () => {
  const FLEET = {
    ...CORE,
    'fleet:assignments': () => ({
      ok: true,
      summary: { agents: 3 },
      agents: [
        { agentId: 'su-lead', isSelf: true, verdict: 'speaking', sessionState: 'live', claims: 1 },
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
        { agentId: 'su-b', verdict: 'stalled', sessionState: 'live', claims: 1 },
      ],
      orphaned: [],
      stalled: [{ id: 'WI-9' }],
    }),
  };

  it('BASELINE (first read): fleetDelta.baseline=true and `me` keeps the FULL roster', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta).toEqual({
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      baseline: true,
      fullReplacement: true,
    });
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
    // The cursor received THIS read's fingerprint — the next call diffs against it.
    expect(cursor).toHaveBeenCalledWith(
      expect.objectContaining({
        members: expect.objectContaining({ 'su-b': { v: 'stalled', s: 'live', c: 1 } }),
        stalled: 1,
      }),
    );
  });

  it('DELTA: transitions since committed; `me` slims to the self row + agentsElided', async () => {
    const { call } = fakeCall({ ...FLEET });
    const committed = fingerprintFleet({
      ok: true,
      agents: [
        { agentId: 'su-lead', isSelf: true, verdict: 'speaking', sessionState: 'live', claims: 1 },
        { agentId: 'su-a', verdict: 'speaking', sessionState: 'live', doing: 'WI-1', claims: 2 },
        { agentId: 'su-b', verdict: 'speaking', sessionState: 'live', claims: 1 },
      ],
      orphaned: [],
      stalled: [],
    })!;
    const cursor = vi.fn(async () => ({ committed, baseline: false }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta?.baseline).toBe(false);
    expect(r.fleetDelta?.schemaVersion).toBe(FLEET_DELTA_SCHEMA_VERSION);
    expect(r.fleetDelta?.changes).toEqual([
      {
        change: 'updated',
        type: 'member',
        id: 'su-b',
        from: { v: 'speaking', s: 'live', c: 1 },
        to: { v: 'stalled', s: 'live', c: 1 },
      },
    ]);
    expect(r.fleetDelta?.unchanged).toBe(2);
    expect(r.fleetDelta?.stalled).toEqual({ from: 0, to: 1 });
    const me = r.me as { agents: Array<{ agentId: string }>; peerRowsElidedFromScope: number };
    expect(me.agents).toEqual([expect.objectContaining({ agentId: 'su-lead', isSelf: true })]);
    expect(me.peerRowsElidedFromScope).toBe(2);
  });

  it('FAIL-OPEN: a throwing cursor keeps the full roster fold and omits fleetDelta', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => {
      throw new Error('pg down');
    });
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta).toBeUndefined();
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
  });

  it('FAIL-OPEN: an unrecognizable roster shape (e.g. TOON string) never touches the cursor', async () => {
    const { call } = fakeCall({ ...FLEET, 'fleet:assignments': () => 'opaque-toon-string' });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(cursor).not.toHaveBeenCalled();
    expect(r.fleetDelta).toBeUndefined();
    expect(r.me).toBe('opaque-toon-string');
  });

  it('P-005: FULL mode ALSO consults an injected cursor (the handler, not composeOrient, decides per-mode whether to inject — see the full-mode delta describe block below)', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({}, call, 'su-lead', undefined, undefined, cursor);
    expect(cursor).toHaveBeenCalledTimes(1);
    expect(r.fleetDelta).toEqual({
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      baseline: true,
      fullReplacement: true,
    });
  });

  it('RESET: an old cursor schema returns a full replacement and keeps the full roster', async () => {
    const { call } = fakeCall({ ...FLEET });
    const cursor = vi.fn(async () => ({ committed: { schemaVersion: 'fleet-delta-v1' }, baseline: false }));
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead', undefined, undefined, cursor);
    expect(r.fleetDelta).toMatchObject({
      schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
      baseline: false,
      reset: { reason: 'schema-mismatch' },
      fullReplacement: true,
    });
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
  });

  it('stages the cursor after leader metrics, announced gates, and pipeline are hydrated', async () => {
    listActiveAnnouncementsMock.mockResolvedValue([
      {
        eventKey: 'fleet:backend:release-ready',
        note: 'ship it',
        scopeKind: 'fleet',
        scopeRef: 'backend',
        subscriberId: 'su-lead',
        expiresTs: null,
      },
    ]);
    const fleetMetrics = {
      ok: true,
      snapshot: {
        schemaVersion: 'fleet-metrics-v1',
        scope: {
          fleet: 'backend',
          harness: 'papercusp',
          window: {
            kind: 'fleet-lifetime',
            startAt: '2026-08-21T00:00:00.000Z',
            startSource: 'fleet-created-at',
          },
          stock: { mode: 'current-spec', specId: 'spec-a', revision: 9 },
          flow: { mode: 'current-spec', specId: 'spec-a', revision: 9, source: 'fleet' },
          population: { stock: 'current-spec-work-items', flow: 'current-spec-work-items' },
        },
        flow: {
          opened: 0,
          terminalLifecycle: 0,
          terminalCounted: 0,
          netLifecycle: 0,
          netCounted: 0,
          unit: 'work-items',
        },
        remaining: {
          total: 0,
          buckets: {
            needsHuman: 0,
            blocked: 0,
            claimHeld: 0,
            inFlight: 0,
            claimable: 0,
            otherUnclaimable: 0,
          },
        },
        authority: {
          lifecycleTerminal: 0,
          counted: 0,
          committed: 0,
          validated: 0,
          proposed: 0,
          pendingHuman: 0,
          invalid: 0,
          legacy: 0,
        },
        issueUnits: { canonicalBugs: 0, observations: 0, occurrences: 0, duplicateOccurrences: 0 },
      },
    };
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const { call } = fakeCall({
      ...FLEET,
      'fleet:leader-brief': () => ({ ok: true, summary: { fleet: 'backend' }, fleetMetrics, members: [] }),
    });
    const r = await composeOrient(
      { mode: 'monitor', harness: 'papercusp' },
      call,
      'su-lead',
      undefined,
      undefined,
      cursor,
      undefined,
      undefined,
      { fleetSlug: 'backend', fleetRole: 'leader' },
      undefined,
      async () => ({ gate: 'green', deploy: 'current', checkedAtMs: Date.now() }),
    );
    expect(cursor).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: FLEET_DELTA_SCHEMA_VERSION,
        scope: expect.objectContaining({
          fleet: 'backend',
          harness: 'papercusp',
          specId: 'spec-a',
          stockPopulation: 'current-spec-work-items',
          flowPopulation: 'current-spec-work-items',
          workItemUnit: 'work-items',
        }),
        axes: expect.objectContaining({
          metrics: expect.objectContaining({ availability: 'measured', flow: expect.objectContaining({ opened: 0 }) }),
          gates: ['fleet:backend:release-ready'],
          promotion: { availability: 'measured', gate: 'green', deploy: 'current' },
        }),
      }),
    );
    expect((r.leaderBrief as Record<string, unknown>).fleetMetrics).toEqual(fleetMetrics);
  });

  it('no cursor injected (flag off / unresolved identity) ⇒ pre-P-004 monitor behavior, byte-identical', async () => {
    const { call } = fakeCall({ ...FLEET });
    const r = await composeOrient({ mode: 'monitor' }, call, 'su-lead');
    expect(r.fleetDelta).toBeUndefined();
    expect((r.me as { agents: unknown[] }).agents).toHaveLength(3);
  });
});

describe('P-005 full-mode delta (plan-events + fleet catch-up, server-side cursors)', () => {
  const EVENTS_V1 = [{ msg_id: 'e1', kind: 'item_status_changed', detail: 'P-001' }];
  const EVENTS_V2 = [
    { msg_id: 'e2', kind: 'item_status_changed', detail: 'P-002' },
    { msg_id: 'e1', kind: 'item_status_changed', detail: 'P-001' },
  ];
  const CATCHUP_V1 = [{ msg_id: 'c1', summary: 'hello' }];

  it("plan-events BASELINE: full delivery, cursor receives this batch's id fingerprint", async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 1 }) });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 1, recent: EVENTS_V1 });
    expect(cursor).toHaveBeenCalledWith({ ids: ['e1'] });
  });

  it('plan-events UNCHANGED: same ids as committed ⇒ recent:[] + unchanged:true, total still fresh', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 7 }) });
    const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 7, recent: [], unchanged: true });
  });

  it('plan-events CHANGED: different ids than committed ⇒ full delivery, no unchanged marker', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V2, total: 2 }) });
    const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 2, recent: EVENTS_V2 });
  });

  it('plan-events FAIL-OPEN: a throwing cursor still delivers in full (no unchanged, no throw)', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 1 }) });
    const cursor = vi.fn(async () => {
      throw new Error('pg down');
    });
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
    expect(r.planEvents).toEqual({ total: 1, recent: EVENTS_V1 });
  });

  it('plan-events: no cursor injected ⇒ pre-P-005 behavior, byte-identical', async () => {
    const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 1 }) });
    const r = await composeOrient({}, call, 'me');
    expect(r.planEvents).toEqual({ total: 1, recent: EVENTS_V1 });
  });

  it('fleet catch-up UNCHANGED: same row ids as committed ⇒ recent:[] + unchanged:true', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 9, rows: CATCHUP_V1 }),
    });
    const cursor = vi.fn(async () => ({ committed: { ids: ['c1'] }, baseline: false }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 9, recent: [], unchanged: true });
  });

  it('fleet catch-up CHANGED: delivers in full and updates the cursor', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 1, rows: CATCHUP_V1 }),
    });
    const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 1, recent: CATCHUP_V1 });
    expect(cursor).toHaveBeenCalledWith({ ids: ['c1'] });
  });

  it('fleet catch-up FAIL-OPEN: a throwing cursor still delivers in full', async () => {
    const { call } = fakeCall({
      ...CORE,
      'coord:whoami': () => ({ fleetSlug: 'backend' }),
      'coord:catch-up': () => ({ total: 1, rows: CATCHUP_V1 }),
    });
    const cursor = vi.fn(async () => {
      throw new Error('pg down');
    });
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
    expect(r.fleetCatchUp).toEqual({ fleet: 'backend', total: 1, recent: CATCHUP_V1 });
  });

  describe('EI-9130 orientServedDelta — generic delta-served breadcrumb', () => {
    it('true when fleetDelta actually served transitions (baseline:false)', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({
          ok: true,
          summary: { agents: 1 },
          agents: [{ agentId: 'me', verdict: 'stalled', sessionState: 'live', claims: 1 }],
          orphaned: [],
          stalled: [],
        }),
      });
      const cursor = vi.fn(async () => ({
        committed: { members: { me: { v: 'speaking', s: 'live', c: 1 } }, orphaned: 0, stalled: 0 },
        baseline: false,
      }));
      const r = await composeOrient({ mode: 'monitor' }, call, 'me', undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(true);
    });

    it('true when plan-events resolved unchanged', async () => {
      const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V1, total: 7 }) });
      const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
      const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(true);
    });

    it('true when fleet catch-up resolved unchanged', async () => {
      const { call } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 9, rows: CATCHUP_V1 }),
      });
      const cursor = vi.fn(async () => ({ committed: { ids: ['c1'] }, baseline: false }));
      const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(true);
    });

    it('false on a baseline (first) read — nothing was actually narrowed', async () => {
      const { call } = fakeCall({ ...CORE });
      const cursor = vi.fn(async () => ({ committed: null, baseline: true }));
      const r = await composeOrient({ mode: 'monitor' }, call, 'me', undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(false);
    });

    it('false when no cursor mechanism is engaged at all (flag off / pre-P-004 shape)', async () => {
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(orientServedDelta(r)).toBe(false);
    });

    it('false when plan-events changed (full delivery, no unchanged marker)', async () => {
      const { call } = fakeCall({ ...CORE, 'coord:plan-events': () => ({ events: EVENTS_V2, total: 2 }) });
      const cursor = vi.fn(async () => ({ committed: { ids: ['e1'] }, baseline: false }));
      const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, cursor);
      expect(orientServedDelta(r)).toBe(false);
    });
  });

  // EI-9270: announced gate events — declared-but-unfired gates fold into orient,
  // scoped to the caller's fleet/plan/harness (+ global), so a member learns what
  // to events:await with zero leader messages.
  describe('EI-9270 announced-gates fold', () => {
    it('folds gates visible to the caller (own fleet + global), dropping other fleets', async () => {
      listActiveAnnouncementsMock.mockResolvedValue([
        {
          eventKey: 'fleet:backend:phase3-open',
          note: 'opens on verified green',
          scopeKind: 'fleet',
          scopeRef: 'backend',
          subscriberId: 'su-l',
          expiresTs: null,
        },
        {
          eventKey: 'fleet:frontend:phase2-open',
          note: null,
          scopeKind: 'fleet',
          scopeRef: 'frontend',
          subscriberId: 'su-l',
          expiresTs: null,
        },
        {
          eventKey: 'migration-freeze-lifted',
          note: 'system-wide',
          scopeKind: 'global',
          scopeRef: null,
          subscriberId: 'su-o',
          expiresTs: null,
        },
      ]);
      const { call } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 0, rows: [] }),
      });
      const r = await composeOrient({}, call, 'me');
      expect(r.announcedGates?.map((g) => g.event)).toEqual(['fleet:backend:phase3-open', 'migration-freeze-lifted']);
      expect(r.announcedGates?.[0]).toMatchObject({
        note: 'opens on verified green',
        scope: 'fleet:backend',
        announcedBy: 'su-l',
      });
    });

    it('absent when nothing is visible, but monitor still performs the compact gate read', async () => {
      listActiveAnnouncementsMock.mockResolvedValue([
        {
          eventKey: 'fleet:frontend:phase2-open',
          note: null,
          scopeKind: 'fleet',
          scopeRef: 'frontend',
          subscriberId: 'su-l',
          expiresTs: null,
        },
      ]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.announcedGates).toBeUndefined();
      const before = listActiveAnnouncementsMock.mock.calls.length;
      const monitor = await composeOrient({ mode: 'monitor' }, fakeCall({ ...CORE }).call, 'me');
      expect(monitor.announcedGates).toBeUndefined();
      expect(listActiveAnnouncementsMock.mock.calls.length).toBe(before + 1);
    });

    it('monitor mode scopes announced gates with the injected authoritative fleet membership', async () => {
      listActiveAnnouncementsMock.mockResolvedValue([
        {
          eventKey: 'fleet:backend:green',
          note: 'resume',
          scopeKind: 'fleet',
          scopeRef: 'backend',
          subscriberId: 'su-l',
          expiresTs: null,
        },
        {
          eventKey: 'fleet:frontend:green',
          note: null,
          scopeKind: 'fleet',
          scopeRef: 'frontend',
          subscriberId: 'su-l',
          expiresTs: null,
        },
      ]);
      const { call } = fakeCall({
        ...CORE,
        'fleet:leader-brief': () => ({ ok: true, summary: { fleet: 'backend' }, members: [] }),
      });
      const monitor = await composeOrient(
        { mode: 'monitor' },
        call,
        'me',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { fleetSlug: 'backend', fleetRole: 'leader' },
      );
      expect(monitor.announcedGates?.map((g) => g.event)).toEqual(['fleet:backend:green']);
    });

    it('projects catalog metadata and warns on stale owners and unqualified global plan-item-like keys', async () => {
      listActiveAnnouncementsMock.mockResolvedValue([
        {
          id: 41,
          eventKey: 'p006-complete',
          note: 'a different plan owns this gate',
          scopeKind: null,
          scopeRef: null,
          subscriberId: 'su-ended',
          expiresTs: null,
          logicalGateKey: 'P-006',
        },
        {
          id: 42,
          eventKey: 'fleet:backend:release-ready',
          note: null,
          scopeKind: 'fleet',
          scopeRef: 'backend',
          subscriberId: 'su-leader',
          expiresTs: null,
          logicalGateKey: 'release-ready',
        },
      ]);
      countActiveAwaitsByPrefixesMock.mockResolvedValue(
        new Map([
          ['p006-complete', 4],
          ['fleet:backend:release-ready', 2],
        ]),
      );
      resolveAnnouncementOwnershipMock.mockResolvedValue(
        new Map([
          [41, { declaredByLiveness: 'ended', liveSuccessorIds: [], staleOwner: true }],
          [42, { declaredByLiveness: 'live', liveSuccessorIds: ['su-successor'], staleOwner: false }],
        ]),
      );
      const { call } = fakeCall({ ...CORE, 'coord:whoami': () => ({ fleetSlug: 'backend' }) });

      const r = await composeOrient({ harness: 'h' }, call, 'me');

      expect(r.announcedGates).toEqual([
        expect.objectContaining({
          event: 'p006-complete',
          logical_gate: 'P-006',
          live_awaiters: 4,
          stale_owner: true,
          warning: expect.stringContaining('STALE announced gate'),
        }),
        expect.objectContaining({
          event: 'fleet:backend:release-ready',
          live_awaiters: 2,
          live_successor_ids: ['su-successor'],
        }),
      ]);
      expect(r.announcedGates?.[0]?.warning).toContain('AMBIGUOUS GLOBAL');
      expect(resolveAnnouncementOwnershipMock).toHaveBeenCalledWith(expect.any(Array), 'ws-test');
    });

    it('omits optional metadata when either advisory read fails, preserving the gate row', async () => {
      listActiveAnnouncementsMock.mockResolvedValue([
        {
          id: 43,
          eventKey: 'global-release-ready',
          note: null,
          scopeKind: null,
          scopeRef: null,
          subscriberId: 'su-leader',
          expiresTs: null,
          logicalGateKey: null,
        },
      ]);
      countActiveAwaitsByPrefixesMock.mockRejectedValueOnce(new Error('await count unavailable'));
      resolveAnnouncementOwnershipMock.mockRejectedValueOnce(new Error('liveness unavailable'));
      const { call } = fakeCall({ ...CORE });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const row = (await composeOrient({ harness: 'h' }, call, 'me')).announcedGates?.[0];

        expect(row).toMatchObject({ event: 'global-release-ready', logical_gate: null });
        expect(row).not.toHaveProperty('live_awaiters');
        expect(row).not.toHaveProperty('live_successor_ids');
        expect(row).not.toHaveProperty('stale_owner');
        expect(row).not.toHaveProperty('warning');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // WI-3818: fleet:assignments (`me`) and coord:glance (`fleetHealth`) fan out to
  // presence/assignments/Tier-1 reads with no internal budget — during the
  // 2026-07-10 host-load storm either could hang orient until the 55s MCP client
  // timeout. Both legs are now bounded (withBoundedTimeout) and degrade instead
  // of hanging; these tests exercise the ACTUAL timeout path (not just a thrown
  // error, already covered above) with fake timers.
  describe('WI-3818 bounded fleet legs — a hung call degrades instead of hanging orient', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('`me` degrades to a minimal empty-roster shape when fleet:assignments never resolves (BOTH modes affected — this is the one fleet-related call monitor mode makes)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({ mode: 'monitor' }, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.me).toMatchObject({
        ok: false,
        degraded: true,
        degradedLeg: 'fleet:assignments',
        degradedReason: 'fleet:assignments read exceeded 8000ms',
        retryable: true,
        agents: [],
      });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('preserves recovered self membership when the fleet assignment roster exceeds orient budget', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ownerId = 'su-recovered-membership-timeout-test';
      const { call, calls } = fakeCall({
        ...CORE,
        'fleet:assignments': () => new Promise(() => {}),
      });
      const recoveredScope = async () => ({ fleetSlug: 'orch-unify', fleetRole: 'member' });
      try {
        const resultPromise = composeOrient(
          { mode: 'monitor', afterCompaction: true },
          call,
          ownerId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { fleetSlug: null, fleetRole: null },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          recoveredScope,
        );

        await vi.advanceTimersByTimeAsync(8_000);
        const result = await resultPromise;
        const assignmentCall = calls.find((entry) => entry.name === 'fleet:assignments');

        expect(assignmentCall?.args).toEqual({ fleet: 'orch-unify', detail: 'snapshot' });
        expect(result.me).toMatchObject({
          ok: false,
          degraded: true,
          degradedLeg: 'fleet:assignments',
          degradedReason: 'fleet:assignments read exceeded 8000ms',
          retryable: true,
          agents: [
            {
              agentId: ownerId,
              isSelf: true,
              fleetSlug: 'orch-unify',
              fleetRole: 'member',
            },
          ],
        });
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('annotates an unsuccessful fleet:assignments envelope even when it resolves without timing out', async () => {
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => ({ ok: false, summary: null, agents: [] }),
      });
      const r = await composeOrient({ mode: 'monitor' }, call, 'me');
      expect(r.ok).toBe(true);
      expect(r.me).toMatchObject({
        ok: false,
        summary: null,
        agents: [],
        degraded: true,
        degradedLeg: 'fleet:assignments',
        degradedReason: 'fleet:assignments returned an unsuccessful response',
        retryable: true,
      });
    });

    it('`me` degrading never crashes the full-mode delta fold (fingerprintFleet stays try/catch-safe)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'fleet:assignments': () => new Promise(() => {}),
      });
      const fleetCursor = vi.fn(async () => ({ committed: null, baseline: true }));
      const resultPromise = composeOrient({}, call, 'me', undefined, undefined, fleetCursor);
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.claimable).toHaveLength(2); // the rest of orient still completes normally
      warnSpy.mockRestore();
    });

    it('fleetHealth becomes explicitly unavailable (not a hang) when coord:glance never resolves', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'coord:whoami': () => ({ fleetSlug: 'backend' }),
        'coord:catch-up': () => ({ total: 0, rows: [] }),
        'coord:glance': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({}, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.fleetHealth).toEqual({
        schemaVersion: ORIENT_FLEET_HEALTH_SCHEMA_VERSION,
        status: 'unavailable',
        ref: 'coord:glance',
        reason: 'coord:glance read failed or timed out',
      });
      expect(r.claimable).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // EI-21127719036550806: coord:orient timed out ENTIRELY during host memory-pressure
  // stalls (PSI mem full, all tasks stalled on reclaim/swap) — the claimable backlog,
  // coord:inbox, coord:plan-events, and coord:declare-intent legs carried NO internal
  // budget, so under real memory pressure any ONE of these sequential DB round-trips
  // could hang past the caller's own deadline with the whole orient call reporting
  // NOTHING back (an MCP request_timeout the caller was warned not to blindly retry),
  // instead of the bounded degrade-to-fallback every other core leg already gets
  // (WI-3818). These legs are now bounded the same way; these tests exercise the
  // ACTUAL hang path (not just a thrown error, already covered above) with fake timers.
  describe('EI-21127719036550806 bounded core legs — a hung call degrades instead of hanging orient', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('claimable degrades to the fallback list (never an empty backlog) when work_items:claimable never resolves', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'work_items:claimable': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({ harness: 'h' }, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect((r.claimable as Array<{ id: string }>).map((x) => x.id)).toEqual(['WI-1', 'WI-2']);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('inbox degrades to an empty-shaped fold (not a hang) when coord:inbox never resolves', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'coord:inbox': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({}, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.inbox).toEqual({ summary: undefined, recent: undefined, entries: undefined });
      // the rest of orient still completes normally
      expect(r.claimable).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('planEvents degrades to null (not a hang, and never a false "zero events") when coord:plan-events never resolves', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'coord:plan-events': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({}, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.planEvents).toBeNull();
      expect(r.claimable).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('declare-intent degrades to intentDeclared:false (not a hang) when coord:declare-intent never resolves', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'coord:declare-intent': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({ intent: 'x' }, call, 'me');
      await vi.advanceTimersByTimeAsync(8_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.intentDeclared).toBe(false);
      expect(r.claimable).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('the whole call still resolves promptly even when EVERY newly-bounded core leg hangs at once (the reported memory-pressure shape)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...CORE,
        'work_items:claimable': () => new Promise(() => {}),
        'work_items:list': () => new Promise(() => {}),
        'coord:inbox': () => new Promise(() => {}),
        'coord:plan-events': () => new Promise(() => {}),
        'coord:declare-intent': () => new Promise(() => {}),
      });
      const resultPromise = composeOrient({ harness: 'h', intent: 'x' }, call, 'me');
      // Every leg is bounded to the same ORIENT_CORE_LEG_TIMEOUT_MS budget, but the
      // legs run SEQUENTIALLY (composeOrient's own contract), so each hung leg's
      // 8s deadline starts only once the PRIOR leg has settled — this is the exact
      // aggregate-stall shape the bug reported. Advance generously past every
      // sequential hop (claimable's Promise.all round, inbox, plan-events,
      // declare-intent) plus the smaller announcements budget in between.
      await vi.advanceTimersByTimeAsync(40_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.planEvents).toBeNull();
      expect(r.intentDeclared).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  it('caps the final declare-intent wait to the remaining aggregate budget after sequential folds', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + 17_500;
    const delay = <T>(value: T, ms: number): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value), ms));
    let declareStartedAtMs: number | undefined;
    const { call } = fakeCall({
      ...CORE,
      // These individually healthy legs consume 15s in composeOrient's sequential
      // backlog → inbox fold, leaving less than the final leg's normal 8s budget.
      'work_items:claimable': () => delay({ claimable: [] }, 7_500),
      'coord:inbox': () => delay({ summary: { total: 0 }, entries: [] }, 7_500),
      'memory:search': () => ({ hits: [] }),
      'coord:declare-intent': () => {
        declareStartedAtMs = Date.now();
        return new Promise(() => {});
      },
    });
    const resultPromise = composeOrientWithDeadline(
      { harness: 'h', intent: 'sequential bootstrap', includePlanEvents: false },
      call,
      deadlineAtMs,
    ).then((result) => ({ result, resolvedAtMs: Date.now() }));

    try {
      await vi.advanceTimersByTimeAsync(deadlineAtMs - startedAtMs);
      const { result, resolvedAtMs } = await resultPromise;

      expect(declareStartedAtMs).toBeGreaterThanOrEqual(startedAtMs + 15_000);
      expect(deadlineAtMs - declareStartedAtMs!).toBeLessThan(8_000);
      expect(resolvedAtMs).toBeLessThanOrEqual(deadlineAtMs);
      expect(result.intentDeclared).toBe(false);
    } finally {
      await vi.runAllTimersAsync();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// ── P-016 (voice-public-release-readiness-2026-07-12): role-specific pane folds —
// the papercup FAST dock pane orients with the SAME live-system digest the converse
// brain walks in with (papercup-context.ts), and the papercup-deep pane orients with
// its OPEN QUESTION THREAD (unanswered directed messages awaiting its reply). The
// handler resolves ctx.role through the PURE orientRoleFolds gate and injects the
// fold CLOSURES, so composeOrient stays IO-free — these tests drive the injected
// seam exactly like the cursor/fleetMembership params above.
describe('P-016 role-specific pane folds (papercup paneContext / papercup-deep deepWork)', () => {
  it('orientRoleFolds: papercup earns paneContext, papercup-deep earns deepWork, monitor + every other role neither', () => {
    expect(orientRoleFolds('papercup', undefined)).toEqual({ paneContext: true, deepWork: false });
    expect(orientRoleFolds('papercup', 'full')).toEqual({ paneContext: true, deepWork: false });
    expect(orientRoleFolds('papercup-deep', 'full')).toEqual({ paneContext: false, deepWork: true });
    // A monitor tick skips both — even for the pane roles (the EI-8300 cost
    // discipline every heavy leg follows).
    expect(orientRoleFolds('papercup', 'monitor')).toEqual({ paneContext: false, deepWork: false });
    expect(orientRoleFolds('papercup-deep', 'monitor')).toEqual({ paneContext: false, deepWork: false });
    for (const other of ['cup', 'mug', 'kettle', 'worker', 'operator', 'su', null, undefined]) {
      expect(orientRoleFolds(other as string | null | undefined, 'full')).toEqual({
        paneContext: false,
        deepWork: false,
      });
    }
  });

  it('folds an injected paneContext render into the result (the fast pane walks in with the pot picture)', async () => {
    const { call } = fakeCall({ ...CORE });
    const digest =
      '## Live system status — papercusp\n### Anomalies — detected drift (act on these)\n_no anomalies — system healthy._';
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, undefined, undefined, {
      paneContext: async () => digest,
    });
    expect(r.ok).toBe(true);
    expect(r.paneContext).toBe(digest);
    expect(r.deepWork).toBeUndefined(); // the OTHER pane's fold never rides along
  });

  it('folds an injected deepWork thread into the result (the deep pane leads with what it owes answers to)', async () => {
    const { call } = fakeCall({ ...CORE });
    const thread = {
      count: 2,
      oldestAgeMs: 60_000,
      newest: [{ msgId: 'm-2', from: 'sentinel-1', summary: 'why is the deploy red?', ageMs: 10_000 }],
      note: ORIENT_DEEP_WORK_NOTE,
    };
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, undefined, undefined, {
      deepWork: async () => thread,
    });
    expect(r.deepWork).toEqual(thread);
    expect(r.paneContext).toBeUndefined();
  });

  it('neither fold is present when no roleFolds are injected (every non-pane caller is byte-identical)', async () => {
    const { call } = fakeCall({ ...CORE });
    const r = await composeOrient({}, call, 'me');
    expect('paneContext' in r).toBe(false);
    expect('deepWork' in r).toBe(false);
  });

  it('a THROWING fold degrades to null — orientation never breaks on a pane-context/deep-work failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { call } = fakeCall({ ...CORE });
    const r = await composeOrient({}, call, 'me', undefined, undefined, undefined, undefined, undefined, undefined, {
      paneContext: async () => {
        throw new Error('digest gather exploded');
      },
      deepWork: async () => {
        throw new Error('unanswered read exploded');
      },
    });
    expect(r.ok).toBe(true);
    expect(r.paneContext).toBeNull();
    expect(r.deepWork).toBeNull();
    expect(r.claimable).toHaveLength(2); // the rest of orient completed normally
    warnSpy.mockRestore();
  });

  it('a HANGING paneContext gather degrades to null at its own budget (never hangs orientation — WI-3818)', async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({ ...CORE });
      const resultPromise = composeOrient(
        {},
        call,
        'me',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          paneContext: () => new Promise(() => {}),
        },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await resultPromise;
      expect(r.ok).toBe(true);
      expect(r.paneContext).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** EI-20013545515660920: `coord:orient { planSlug, planItems }` returned ok:true
 *  with no warning while claiming NOTHING. coord:declare-intent had already
 *  computed the reason (unknown ids + a `hint`); orient discarded its entire
 *  response and recorded only `intentDeclared: true`.
 *
 *  The invariant these tests pin: after orient, a caller can always tell whether
 *  it HOLDS the lane it asked for. Every path ending in "you hold none of it"
 *  must say so — including the paths where declare-intent never even attempted a
 *  claim (no planSlug, no coord:write, no claims block). */
describe('EI-20013545515660920 laneClaim — a failed lane claim is never silent', () => {
  describe('summarizeLaneClaim (pure)', () => {
    it('warns when the declaration SUCCEEDED but nothing was claimed (the filed bug)', () => {
      const s = summarizeLaneClaim(
        ['P-005', 'P-046'],
        {
          claimed: [],
          alreadyHeld: [],
          conflicts: [],
          released: [],
          unknown: ['P-005', 'P-046'],
          hint: 'none of the declared items parse as items of this plan',
        },
        { planSlugGiven: true },
      );

      expect(s.warning).toBeDefined();
      expect(s.warning).toContain('do NOT hold this lane');
      expect(s.unknown).toEqual(['P-005', 'P-046']);
      // declare-intent's own explanation is carried through, not paraphrased away.
      expect(s.hint).toContain('parse as items of this plan');
      expect(s.warning).toContain('parse as items of this plan');
    });

    // CALIBRATION: the control for the assertions above. Without it, a bug that
    // set `warning` unconditionally would pass every other case in this block.
    it('does NOT warn when items were actually claimed', () => {
      const s = summarizeLaneClaim(
        ['P-005'],
        { claimed: ['P-005'], alreadyHeld: [], conflicts: [], released: [], unknown: [] },
        { planSlugGiven: true },
      );
      expect(s.warning).toBeUndefined();
      expect(s.claimed).toEqual(['P-005']);
    });

    it('does NOT warn when the lane was ALREADY held (a re-declare is a legitimate no-op)', () => {
      const s = summarizeLaneClaim(
        ['P-005'],
        { claimed: [], alreadyHeld: ['P-005'], conflicts: [], released: [], unknown: [] },
        { planSlugGiven: true },
      );
      expect(s.warning).toBeUndefined();
    });

    it('warns and names the peer conflict when the lane is contested', () => {
      const s = summarizeLaneClaim(
        ['P-005'],
        {
          claimed: [],
          alreadyHeld: [],
          released: [],
          unknown: [],
          conflicts: [{ itemId: 'P-005', holder: 'su-peer' }],
        },
        { planSlugGiven: true },
      );
      expect(s.warning).toContain('conflicts');
      expect(s.conflicts).toHaveLength(1);
    });

    it('warns when planItems was passed WITHOUT planSlug — declare-intent skips the claim entirely', () => {
      // The second silent no-op on this path: reconcile runs only when BOTH are
      // present, so without planSlug nothing is attempted and nothing errors.
      const s = summarizeLaneClaim(['P-005'], undefined, { planSlugGiven: false });
      expect(s.warning).toContain('WITHOUT planSlug');
      expect(s.claimed).toEqual([]);
    });

    it('warns when the declaration itself failed (no coord:write)', () => {
      const s = summarizeLaneClaim(['P-005'], undefined, { planSlugGiven: true, declareFailed: true });
      expect(s.warning).toContain('FAILED');
    });

    it('routes WI/EI/F work-item ids to work_items:claim instead of plans:set-status', () => {
      const s = summarizeLaneClaim(['EI-20247200923975596'], undefined, {
        planSlugGiven: true,
        declareFailed: true,
      });

      expect(s.warning).toContain('work_items:claim');
      expect(s.warning).toContain('scheduler:get_next');
      expect(s.warning).not.toContain('plans:set-status');
    });

    it('warns when no claims block came back at all', () => {
      const s = summarizeLaneClaim(['P-005'], undefined, { planSlugGiven: true });
      expect(s.warning).toContain('no claims block');
    });

    it('never reports a claim the payload did not contain (defensive against a shape change)', () => {
      const s = summarizeLaneClaim(['P-005'], { claimed: 'P-005' }, { planSlugGiven: true });
      expect(s.claimed).toEqual([]);
      expect(s.warning).toBeDefined();
    });
  });

  describe('composeOrient wiring', () => {
    const LANE_CORE = {
      ...CORE,
      'plans:get': () => ({ results: [{ now: { state: null, next: null }, items: [] }] }),
    };

    it('surfaces the warning while intentDeclared is STILL true (proving the old signal was insufficient)', async () => {
      const { call } = fakeCall({
        ...LANE_CORE,
        'coord:declare-intent': () => ({
          ok: true,
          claims: {
            claimed: [],
            alreadyHeld: [],
            conflicts: [],
            released: [],
            unknown: ['P-005', 'P-046'],
            hint: 'none of the declared items parse as items of this plan',
          },
        }),
      });

      const r = await composeOrient(
        {
          intent: 'work the lane',
          planSlug: 'retire-mug-kettle-su-only-2026-08-09',
          planItems: ['P-005', 'P-046'],
          harness: 'h',
        },
        call,
        'me',
      );

      // This is the exact pair that made the bug invisible: ok + intentDeclared
      // both true. They stay true; laneClaim is what disambiguates them.
      expect(r.ok).toBe(true);
      expect(r.intentDeclared).toBe(true);
      expect(r.laneClaim?.warning).toContain('do NOT hold this lane');
      expect(r.laneClaim?.unknown).toEqual(['P-005', 'P-046']);
    });

    it('reports a successful claim without a warning', async () => {
      const { call } = fakeCall({
        ...LANE_CORE,
        'coord:declare-intent': () => ({
          ok: true,
          claims: { claimed: ['P-005'], alreadyHeld: [], conflicts: [], released: [], unknown: [] },
        }),
      });
      const r = await composeOrient(
        { intent: 'work the lane', planSlug: 'p', planItems: ['P-005'], harness: 'h' },
        call,
        'me',
      );
      expect(r.laneClaim?.claimed).toEqual(['P-005']);
      expect(r.laneClaim?.warning).toBeUndefined();
    });

    it('omits laneClaim entirely when no planItems were requested', async () => {
      const { call } = fakeCall({ ...LANE_CORE, 'coord:declare-intent': () => ({ ok: true }) });
      const r = await composeOrient({ intent: 'just declaring' }, call, 'me');
      expect(r.laneClaim).toBeUndefined();
    });

    it('still reports the lane as unheld when declare-intent throws', async () => {
      // EI-21127719036550806: declare-intent is now wrapped in withBoundedTimeout,
      // which logs a console.warn on a caught failure — expected here since this
      // test deliberately makes coord:declare-intent throw.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { call } = fakeCall({
        ...LANE_CORE,
        'coord:declare-intent': () => {
          throw new Error('no coord:write');
        },
      });
      const r = await composeOrient(
        { intent: 'work the lane', planSlug: 'p', planItems: ['P-005'], harness: 'h' },
        call,
        'me',
      );
      expect(r.intentDeclared).toBe(false);
      expect(r.laneClaim?.warning).toContain('FAILED');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('keeps work-item recovery refs out of declare-intent while preserving the declaration', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { call, calls } = fakeCall({
          ...LANE_CORE,
          // Model the nested tool's strict P-NNN schema. Before the fix, orient
          // forwards the EI ref and this handler rejects the whole declaration.
          'coord:declare-intent': (args) => {
            if (Object.prototype.hasOwnProperty.call(args, 'items')) {
              throw new Error('P-NNN form required');
            }
            return { ok: true };
          },
        });

        const r = await composeOrient(
          {
            intent: 'resume the recovered work-item',
            planSlug: 'p',
            planItems: ['EI-21189833138443321'],
            harness: 'h',
          },
          call,
          'me',
        );

        const declaration = calls.find((c) => c.name === 'coord:declare-intent')!;
        expect(declaration.args).not.toHaveProperty('items');
        expect(r.intentDeclared).toBe(true);
        expect(r.laneClaim?.requested).toEqual(['EI-21189833138443321']);
        expect(r.laneClaim?.warning).toContain('work_items:claim');
        expect(r.laneClaim?.warning).toContain('scheduler:get_next');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

/**
 * EI-20113865649946366 — every trim orient does to ITSELF must announce itself AND
 * name a fetch path. Owner criterion (2026-08-10): a DISCLOSED trim is fine; a SILENT
 * one is the bug, because the agent cannot tell "this is all there is" from "this is
 * the first N" — and orient is the once-per-session bootstrap where that costs most.
 *
 * EVERY case below is asserted in BOTH directions: the marker appears when something
 * was genuinely cut, and is ABSENT when nothing was. The absence half is the half that
 * matters — a one-directional suite passes just as happily on a fold that hardcodes
 * `truncated: true`, which would train agents to ignore the marker entirely.
 */
describe('EI-20113865649946366: orient discloses its own trims (two-directional)', () => {
  describe('claimable', () => {
    it("reports the ORACLE's authoritative total — not the limit-bounded row count", async () => {
      // The defect this pins: orient sliced rows to `claimableLimit` and published the
      // resulting LENGTH as the total, so a bounded 20 read as "there are 20" while the
      // oracle's own count was ~1677. The oracle returns that count in the SAME response
      // the rows come from; `unwrapRows` was discarding it.
      const { call } = fakeCall({
        ...CORE,
        'work_items:claimable': () => ({
          claimable: [
            { id: 'EI-1', state: 'open' },
            { id: 'EI-2', state: 'open' },
          ],
          claimableCount: 1677,
        }),
        'work_items:list': () => [],
      });
      const r = await composeOrient({ harness: 'h', claimableLimit: 2 }, call, 'me');
      expect(r.claimableTruncated).toBeDefined();
      expect(r.claimableTruncated?.total).toBe(1677);
      expect(r.claimableTruncated?.shown).toBe(2);
      // The whole point: the total must NOT be the row count. If a future refactor
      // re-derives it from `claimable.length`, this is what fails.
      expect(r.claimableTruncated?.total).not.toBe(r.claimable.length);
      expect(r.claimableTruncated?.more).toMatch(/work_items:claimable/);
      // Scope is stated, so the number can't be read as "everything claimable".
      expect(r.claimableTruncated?.totalScope).toMatch(/issue-family/);
    });

    it('ABSENT when the oracle says the delivered rows are the whole lane', async () => {
      const { call } = fakeCall({
        ...CORE,
        'work_items:claimable': () => ({
          claimable: [
            { id: 'EI-1', state: 'open' },
            { id: 'EI-2', state: 'open' },
          ],
          claimableCount: 2,
        }),
        'work_items:list': () => [],
      });
      const r = await composeOrient({ harness: 'h', claimableLimit: 20 }, call, 'me');
      expect(r.claimable).toHaveLength(2);
      expect(r.claimableTruncated).toBeUndefined();
    });

    it('no oracle (no harness) + a FULL page ⇒ truncatedByLimit, and NEVER a fabricated total', async () => {
      // The fallback leg cannot know the population. Asking for N and getting N back is
      // evidence that more exist; it is not a count of them. Publishing `shown` as a
      // total here would be the very defect above, one layer down.
      const { call } = fakeCall({
        ...CORE,
        'work_items:list': () => [
          { id: 'WI-1', state: 'todo' },
          { id: 'WI-2', state: 'todo' },
        ],
      });
      const r = await composeOrient({ claimableLimit: 2 }, call, 'me');
      expect(r.claimableTruncated?.truncatedByLimit).toBe(true);
      expect(r.claimableTruncated?.limit).toBe(2);
      expect(r.claimableTruncated?.total).toBeUndefined();
    });

    it('ABSENT on the no-oracle leg when the page came back short', async () => {
      const { call } = fakeCall({
        ...CORE,
        'work_items:list': () => [{ id: 'WI-1', state: 'todo' }],
      });
      const r = await composeOrient({ claimableLimit: 20 }, call, 'me');
      expect(r.claimableTruncated).toBeUndefined();
    });
  });

  describe('memory hit bodies', () => {
    const longBody = 'x'.repeat(500); // > MEMORY_TEXT_CAP (200)

    it('marks a clipped hit and says how much is missing', async () => {
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => ({ ok: true, results: [{ id: 'mem1', memory: longBody, score: 0.9 }] }),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'recall something' }, call, 'me');
      const hit = r.memory?.hits[0];
      expect(hit?.truncated).toBe(true);
      expect(hit?.fullChars).toBe(500);
      expect(hit?.memory?.length).toBe(200);
      // Fold-level: a count of clipped bodies + the verb that returns them. Distinct
      // from `note`, which says the RECALL is non-exhaustive — a different claim from
      // "the facts you WERE given are themselves cut".
      expect(r.memory?.bodiesTruncated?.hits).toBe(1);
      expect(r.memory?.bodiesTruncated?.cap).toBe(200);
      expect(r.memory?.bodiesTruncated?.more).toMatch(/memory:search/);
    });

    it('ABSENT when every delivered body fits under the cap', async () => {
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => ({ ok: true, results: [{ id: 'mem1', memory: 'short fact', score: 0.9 }] }),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'recall something' }, call, 'me');
      expect(r.memory?.hits[0]?.truncated).toBeUndefined();
      expect(r.memory?.hits[0]?.fullChars).toBeUndefined();
      expect(r.memory?.bodiesTruncated).toBeUndefined();
    });
  });

  describe('recipes', () => {
    it('recipesLimit=0 skips the optional recipe search fold', async () => {
      const { call, calls } = fakeCall({
        ...CORE,
        'recipes:search': () => ({ ok: true, recipes: [{ id: 'should-not-run' }] }),
        'coord:declare-intent': () => ({ ok: true }),
      });
      const r = await composeOrient({ intent: 'batch some tools', recipesLimit: 0 }, call, 'me');
      expect(calls.some((c) => c.name === 'recipes:search')).toBe(false);
      expect(r.recipes).toBeUndefined();
    });

    it('discloses a full page and a clipped title', async () => {
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => ({ ok: true, results: [] }),
        'coord:declare-intent': () => ({ ok: true }),
        'recipes:search': () => ({
          ok: true,
          recipes: [{ id: 'r1', title: 'T'.repeat(300), runCount: 1, similarity: 0.9 }],
        }),
      });
      const r = await composeOrient({ intent: 'batch some tools', recipesLimit: 1 }, call, 'me');
      expect(r.recipesTruncated?.truncatedByLimit).toBe(true);
      expect(r.recipesTruncated?.titlesClipped).toBe(1);
      expect(r.recipesTruncated?.more).toMatch(/recipes:search/);
    });

    it('ABSENT when the page is short and every title fits', async () => {
      const { call } = fakeCall({
        ...CORE,
        'memory:search': () => ({ ok: true, results: [] }),
        'coord:declare-intent': () => ({ ok: true }),
        'recipes:search': () => ({ ok: true, recipes: [{ id: 'r1', title: 'short', runCount: 1, similarity: 0.9 }] }),
      });
      const r = await composeOrient({ intent: 'batch some tools', recipesLimit: 10 }, call, 'me');
      expect(r.recipes).toHaveLength(1);
      expect(r.recipesTruncated).toBeUndefined();
    });
  });

  describe('announcedGates', () => {
    // The load-bearing one. This fold is HOW an agent discovers which gate key to park
    // on, so a gate dropped past the fold is not cosmetic: the agent never learns the
    // key exists and parks on the wrong event — or on nothing — and waits forever.
    const gate = (i: number) => ({
      eventKey: `gate:${i}`,
      note: null,
      scopeKind: null,
      scopeRef: null,
      subscriberId: 'su-leader',
      expiresTs: null,
    });

    it('discloses the count when more gates are visible than the fold shows', async () => {
      listActiveAnnouncementsMock.mockResolvedValue(Array.from({ length: 12 }, (_, i) => gate(i)));
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ harness: 'h' }, call, 'me');
      expect(r.announcedGates).toHaveLength(8);
      expect(r.announcedGatesTruncated).toEqual({
        shown: 8,
        total: 12,
        more: expect.stringContaining('events:catalog'),
      });
    });

    it('ABSENT when every visible gate fits in the fold', async () => {
      listActiveAnnouncementsMock.mockResolvedValue(Array.from({ length: 3 }, (_, i) => gate(i)));
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ harness: 'h' }, call, 'me');
      expect(r.announcedGates).toHaveLength(3);
      expect(r.announcedGatesTruncated).toBeUndefined();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// EI-18725816532600240 — a monitor tick must still deliver the OVERRIDE slots.
//
// The incident: a cold wake reconciled with mode:'monitor', which skipped the facts
// fold ENTIRELY, so a `dead-end:` fact that had already falsified the carry-note's
// "Next action" never reached the agent — which then went and implemented the
// falsified approach. Dead-ends and walls exist precisely to override a stale plan,
// so they are the one thing a context-budget elision must not drop.
// ───────────────────────────────────────────────────────────────────────────────
describe('EI-18725816532600240: never-drop facts survive a monitor tick', () => {
  const factAt = (over: Record<string, unknown>) => ({
    key: 'k',
    createdBy: 'x',
    updatedAt: '2026-07-11T00:00:00Z',
    expiresAt: '2026-07-18T00:00:00Z',
    scope: 'workspace',
    scopeRef: null,
    body: 'b',
    sourceRef: null,
    audienceScope: null,
    sourceProvenance: null,
    ...over,
  });

  const DEAD_END = factAt({
    key: 'dead-end:attach-race-hypothesis',
    body: '⛔ DEAD END — the attach-race fix is a no-op; falsified by a fresh probe.',
  });

  it('DELIVERS a dead-end fact on a monitor tick (the incident, inverted)', async () => {
    foldNeverDropFactsMock.mockResolvedValue([DEAD_END]);
    const { call } = fakeCall({ ...CORE });
    const r = await composeOrient({ mode: 'monitor' }, call, 'me');

    // the override signal actually ARRIVES — this is the whole item
    expect(r.facts).toEqual([
      {
        scope: 'workspace',
        ref: null,
        body: '⛔ DEAD END — the attach-race fix is a no-op; falsified by a fresh probe.',
        src: null,
      },
    ]);
    // narrowed, not full: one bounded read, and the full fold never runs
    expect(foldNeverDropFactsMock).toHaveBeenCalledTimes(1);
    expect(foldFactsMock).not.toHaveBeenCalled();
  });

  it('folds the never-drop slots with the SAME scoping + audience semantics as the full fold', async () => {
    foldNeverDropFactsMock.mockResolvedValue([]);
    const { call } = fakeCall({ ...CORE, 'coord:whoami': () => ({ fleetSlug: 'backend' }) });
    await composeOrient({ mode: 'monitor', harness: 'h' }, call, 'me');
    // NOTE: a monitor tick skips the fleet block wholesale, so there is no fleetSlug
    // to filter on — the audience list is empty exactly as it is for a non-fleet caller.
    expect(foldNeverDropFactsMock).toHaveBeenCalledWith(
      [{ scope: 'workspace' }, { scope: 'owner', scopeRef: 'me' }, { scope: 'harness', scopeRef: 'h' }],
      { audiences: [] },
    );
  });

  describe('the narrowing is DISCLOSED (a bounded read is never rendered as a census)', () => {
    it('marks factsNarrowed on a monitor tick, naming the prefixes from the store constant', async () => {
      const { NEVER_DROP_KEY_PREFIXES, DEAD_END_KEY_PREFIX, WALL_KEY_PREFIX, GUARD_RAIL_KEY_PREFIX } =
        await import('../../../agent-facts/store');
      foldNeverDropFactsMock.mockResolvedValue([DEAD_END]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ mode: 'monitor' }, call, 'me');

      expect(r.factsNarrowed?.fold).toBe('never-drop');
      // sourced from the store's own constant — a hand-listed copy here would drift
      // silently, which is the failure DEAD_END_KEY_PREFIX's own doc warns about
      expect(r.factsNarrowed?.prefixes).toEqual([...NEVER_DROP_KEY_PREFIXES]);
      expect(r.factsNarrowed?.prefixes).toEqual([DEAD_END_KEY_PREFIX, WALL_KEY_PREFIX, GUARD_RAIL_KEY_PREFIX]);
      expect(r.factsNarrowed?.reason).toMatch(/not evidence they do not exist/);
    });

    it('marks it even when the narrowed fold found NOTHING — absence is the least safe reading to transcribe', async () => {
      foldNeverDropFactsMock.mockResolvedValue([]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ mode: 'monitor' }, call, 'me');
      expect(r.facts).toBeUndefined();
      expect(r.factsNarrowed?.fold).toBe('never-drop');
    });

    it('does NOT mark a full fold', async () => {
      foldFactsMock.mockResolvedValue([DEAD_END]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.factsNarrowed).toBeUndefined();
      expect(r.facts).toHaveLength(1);
    });
  });

  describe('afterCompaction takes the FULL fold whatever the mode', () => {
    it('monitor + afterCompaction ⇒ full fold, no narrowing marker', async () => {
      foldFactsMock.mockResolvedValue([DEAD_END]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ mode: 'monitor', afterCompaction: true }, call, 'me');
      expect(foldFactsMock).toHaveBeenCalledTimes(1);
      expect(foldNeverDropFactsMock).not.toHaveBeenCalled();
      expect(r.factsNarrowed).toBeUndefined();
      expect(r.facts).toHaveLength(1);
    });

    it('plain monitor (no afterCompaction) stays narrowed — the control for the case above', async () => {
      const { call } = fakeCall({ ...CORE });
      await composeOrient({ mode: 'monitor' }, call, 'me');
      expect(foldFactsMock).not.toHaveBeenCalled();
      expect(foldNeverDropFactsMock).toHaveBeenCalledTimes(1);
    });
  });

  // The subtle one. nextCursor is the MAX cell version across the folded rows, so a
  // narrowed fold that advanced it would push the cursor PAST ordinary facts the
  // caller was never shown — permanently suppressing their `changed` mark on the
  // next FULL orient. Silent, and it degrades the exact "what moved since I looked"
  // signal the watermark exists to provide.
  describe('watermark: a narrowed fold must not claim the caller saw the rest', () => {
    const VERSIONED = factAt({ key: 'dead-end:x', body: 'd', cellVersion: 'hlc-9' });

    it('does NOT advance the facts cursor on a narrowed (monitor) fold', async () => {
      foldNeverDropFactsMock.mockResolvedValue([VERSIONED]);
      const { call } = fakeCall({ ...CORE });
      await composeOrient({ mode: 'monitor' }, call, 'me');
      expect(writeWatermarkMock).not.toHaveBeenCalled();
    });

    it('DOES advance it on a full fold (the control — proves the assertion above can fail)', async () => {
      foldFactsMock.mockResolvedValue([VERSIONED]);
      const { call } = fakeCall({ ...CORE });
      await composeOrient({}, call, 'me');
      expect(writeWatermarkMock).toHaveBeenCalledWith('me', { cursors: { facts: 'hlc-9' } });
    });

    // Found by writing the assertion above: the SET was keyed with `\x00`
    // separators and the LOOKUP with spaces, so `changed` was dead for EVERY fact
    // on every path, full folds included. Nothing asserted the marker, so nothing
    // caught it. Both keys now come from one function.
    it('marks `changed` on a FULL fold — the marker was dead for every fact before this', async () => {
      readWatermarkMock.mockResolvedValue({ cursors: { facts: 'hlc-1' } });
      foldFactsMock.mockResolvedValue([VERSIONED]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({}, call, 'me');
      expect(r.facts?.[0]?.changed).toBe(true);
    });

    it('still MARKS changed on the narrowed rows it did fold (the cursor is read, just not written)', async () => {
      readWatermarkMock.mockResolvedValue({ cursors: { facts: 'hlc-1' } });
      foldNeverDropFactsMock.mockResolvedValue([VERSIONED]);
      const { call } = fakeCall({ ...CORE });
      const r = await composeOrient({ mode: 'monitor' }, call, 'me');
      expect(r.facts?.[0]?.changed).toBe(true);
      expect(writeWatermarkMock).not.toHaveBeenCalled();
    });
  });
});
