/**
 * start-guard.test.ts — plans:start refuses a terminal plan.
 *
 * The cross-store invariant's forward guard: starting a plan whose
 * git-canonical frontmatter is already shipped/superseded would create the
 * exact started+terminal state the system works to make impossible. The
 * handler reads the frontmatter first and refuses before ever writing the
 * op_status onto the plan's harness_plans row. We mock the plan read + the
 * PG/lock side-effects so the branch is exercised without a database or a
 * real plan row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScratchReference } from '../../../scratch-reference';
import { configurePlanAdmissionPolicySource } from '../plan-admission-gate';
import {
  projectAcceptanceBarContractSnapshot,
  readAcceptanceBarContractSnapshot,
  type AcceptanceBarContractSnapshot,
  type AcceptanceBarContractSnapshotInput,
  type AcceptanceBarTrace,
} from '../../../acceptance-bar-contract-snapshot';

const admissionMocks = vi.hoisted(() => ({ preflight: vi.fn(), laneHealth: vi.fn() }));
const claimSpecMocks = vi.hoisted(() => ({ setClaimSpec: vi.fn() }));
const activationMocks = vi.hoisted(() => ({ gate: vi.fn() }));
const planLockMocks = vi.hoisted(() => ({ withPlanLock: vi.fn() }));

const H = vi.hoisted(() => {
  const state: {
    txCalls: { strings: readonly string[]; values: unknown[] }[];
    frontmatterStatus: string | null;
    /** WI-5825 regression override: force the next statement to match 0 rows. */
    forceNoMatch: boolean;
    specQuality: Record<string, unknown>;
    promotedBody: string;
    parsedItems: Array<{
      id: string;
      storedStatus: string;
      text: string;
      blockedBy: string[];
      importance: 'normal';
      decisionRefs: string[];
      phase: string | null;
      lineNumber: number;
      rawLine: string;
    }>;
  } = {
    txCalls: [],
    frontmatterStatus: 'ready',
    forceNoMatch: false,
    promotedBody: `---\ntitle: mock\nstatus: ready\n---\n\n## Now\n\n**State:** ready\n`,
    parsedItems: [],
    specQuality: {
      satisfied: true,
      applicable: false,
      mode: 'report-only',
      planSlug: 'mock',
      specSetHash: null,
      wouldBlock: ['no-first-class-spec-clauses'],
    },
  };
  const tx = (strings: readonly string[], ...values: unknown[]) => {
    state.txCalls.push({ strings, values });
    // WI-5825 regression hook: force the statement to match 0 rows.
    if (state.forceNoMatch) return Promise.resolve([]);
    // The real pinned resolver reads these tables before the start gates. This
    // fixture has only built-in types and no pins or custom definitions.
    if (/FROM harness_shared\.(?:plan_item_type_definitions|plan_type_definitions|plan_type_pins)\b/.test(strings.join(''))) {
      return Promise.resolve([]);
    }
    return Promise.resolve([{ op_status: 'started', op_updated_at: '2026-06-02T00:00:00.000Z' }]);
  };
  const withWorkspace = async (_wsId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { state, withWorkspace };
});

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

vi.mock('../source', async (orig) => {
  const actual = await orig<typeof import('../source')>();
  return {
    ...actual,
    getPlanRow: vi.fn(async () => ({
      planSlug: 'mock',
      status: H.state.frontmatterStatus,
      template: null,
      templateData: null,
      inputSchema: null,
    })),
    readPlanBySlug: vi.fn(async () => ({
      parsed: { frontmatter: { status: H.state.frontmatterStatus }, items: H.state.parsedItems },
      archived: false,
      row: { planSlug: 'mock', version: 1, opStatus: null, items: [] },
    })),
    // WI-5825: plans:start now resolves its WRITE key through the same authority
    // its READ above uses (resolvePlanScope), instead of re-deriving the tenant
    // from the ambient activeWorkspaceId(). Pin it so the SQL params are
    // deterministic — and deliberately NOT 'default', so a regression to the old
    // literal/ambient path shows up in the assertions below.
    resolvePlanScope: vi.fn(async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: 'ws-of-harness',
      harnessSlug: opts.harnessSlug?.trim() || 'home-harn',
    })),
  };
});

// Keep the real lifecycle evaluator and start gate, but supply their canonical
// subject through the reader seam. An absent DB row is not a legacy-plan fixture.
vi.mock('../../../acceptance-bar-contract-snapshot', async (orig) => ({
  ...(await orig<typeof import('../../../acceptance-bar-contract-snapshot')>()),
  readAcceptanceBarContractSnapshot: vi.fn(),
}));

// WI-38289: `pot/started` is deliberately NOT mocked here.
//
// This suite used to mock `mugKettleSystemEnabled` and default it ON, because it
// once read `FLAGS.MUG_KETTLE_SYSTEM` off the flags server (which this suite has
// no DB for). P-068/D-098 DELETED that flag and collapsed the predicate to a hard
// `return false` (pot/started.ts), so:
//   - the mock has nothing left to insulate us from — the real predicate does no
//     I/O and cannot fail-closed, and
//   - defaulting it ON asserted a tier state production can no longer REACH.
// Every "the op_status UPDATE runs" assertion under that default was coverage of
// an unreachable branch: it reads as meaningful, but no caller can ever produce
// it, and it would keep a dead branch alive through future refactors.
//
// Running against the REAL predicate is strictly stronger: the assertions below
// now describe the only state a caller can observe, and if the tier is ever
// genuinely un-retired this file reds and forces that decision to be re-examined
// here rather than silently passing on a simulated `true`.
//
// The handler's own now-unreachable `axisLive` write branch is separate, tracked
// follow-up (WI-38240) — D-098 is explicit that those branches are retired
// per-file with tests, never by deleting the predicate.

// plans:start awaits promotePlanItems before returning so the caller receives
// its exact queue outcome. Stub it so the suite needs no work_items database —
// and so the retired-axis block below can assert promotion STILL runs with the
// op_status write gated off.
vi.mock('../../../plan-workitem-promotion-run', () => ({
  promotePlanItems: vi.fn(async () => ({ promoted: 0, skipped: 0, flagOff: false })),
}));

vi.mock('../plan-admission-preflight', async (orig) => {
  const actual = await orig<typeof import('../plan-admission-preflight')>();
  return {
    ...actual,
    preflightExactPlanLaneHealth: (...args: unknown[]) => admissionMocks.laneHealth(...args),
    preflightExactPlanAdmission: (...args: unknown[]) => admissionMocks.preflight(...args),
  };
});

vi.mock('../../../scheduler/claim-spec-store', async (orig) => {
  const actual = await orig<typeof import('../../../scheduler/claim-spec-store')>();
  return {
    ...actual,
    setClaimSpec: (...args: unknown[]) => claimSpecMocks.setClaimSpec(...args),
  };
});

vi.mock('../plan-activation-gate', async (orig) => {
  const actual = await orig<typeof import('../plan-activation-gate')>();
  return { ...actual, evaluateConversationActivationGate: (...args: unknown[]) => activationMocks.gate(...args) };
});

vi.mock('../plan-spec-quality-gate', () => ({
  evaluatePlanSpecQualityGate: vi.fn(async () => H.state.specQuality),
}));

const barCritiqueMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<unknown> => null));
vi.mock('../plan-start-critique-gate', () => ({
  evaluatePlanStartBarCritique: (...args: unknown[]) => barCritiqueMock(...args),
}));

// Auto-approve runs inside withPlanLock after a successful start — stub it to
// a no-op so the proceed-case test doesn't need the real lock side-database.
vi.mock('../with-plan-lock', async (orig) => {
  const actual = await orig<typeof import('../with-plan-lock')>();
  return { ...actual, withPlanLock: planLockMocks.withPlanLock };
});

import tool, { PLANS_START_TIMEOUT_SEC } from '../start';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { promotePlanItems, type PromotePlanResult } from '../../../plan-workitem-promotion-run';

const promotePlanItemsMock = vi.mocked(promotePlanItems);

/**
 * The six `blocks`-edge counters every `PromotePlanResult` carries — mirroring the runner's
 * own `NO_EDGES`, for a promotion that wrote no edges. Spelled out so these fixtures stay
 * TYPED: an `as never` cast here would hide a newly-required field from tsc and fail at
 * runtime in some unrelated peer's checkpoint run instead (EI-19282401068515102).
 */
const NO_EDGES = {
  edgesWritten: 0,
  edgeFailures: 0,
  edgesRejectedCyclic: 0,
  blockersDangling: 0,
  blockersUnresolved: 0,
  edgesPreserved: 0,
  workItems: [] as PromotePlanResult['workItems'],
} as const;

const MAKE_CTX = () =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    metadata: vi.fn(),
    workspaceId: DEFAULT_WORKSPACE_ID,
    // no harnessSlug → ctxToPlanSourceOpts resolves the papercup default
    role: 'operator' as const,
    principal: { slug: 'agent-test' },
  }) as never;

const run = async (args: Record<string, unknown>) =>
  (await tool.handler({ harness: 'papercup', ...args } as never, MAKE_CTX())) as {
    data: {
      ok: true;
      results: Array<Record<string, unknown>>;
      counts: { ok: number; failed: number };
    };
    isError?: boolean;
  };

function legacyBarInput(): AcceptanceBarContractSnapshotInput {
  const empty = () => ({ rows: [], limit: 1, truncated: false });
  return {
    planRows: {
      rows: [{
        workspaceId: 'ws-of-harness', harnessSlug: 'papercup', planSlug: 'mock',
        status: 'ready', revision: 1, contentHash: 'fixture',
        adoptionEpoch: null, cohort: null, barSetHash: null,
        rubricSlug: null, rubricRevision: null, seededAt: null, seededBy: null,
      }],
      limit: 2,
      truncated: false,
    },
    rubrics: empty(), planItems: empty(), clauses: empty(),
    workContracts: empty(), evidence: empty(), scorecards: empty(),
    vettingScorecards: empty(),
    lineage: {
      identities: [], workItemRowsRead: 0, auditRowsRead: 0,
      rowLimit: 1, truncated: false,
    },
    partyByIdentity: new Map(),
    graderSelectionVia: new Map(),
  };
}

beforeEach(() => {
  vi.mocked(readAcceptanceBarContractSnapshot).mockReset();
  vi.mocked(readAcceptanceBarContractSnapshot)
    .mockResolvedValue(projectAcceptanceBarContractSnapshot(legacyBarInput()));
  activationMocks.gate.mockReset();
  activationMocks.gate.mockResolvedValue({ satisfied: true, auditSeq: 1 });
  admissionMocks.preflight.mockReset();
  admissionMocks.preflight.mockResolvedValue({
    ready: true,
    status: 'ready',
    reason: 'ready',
    message: 'exact-plan admission ready',
    claimKinds: ['bug', 'change', 'task'],
  });
  admissionMocks.laneHealth.mockReset();
  admissionMocks.laneHealth.mockResolvedValue({ effective: { claimable: 1 } });
  H.state.txCalls = [];
  H.state.frontmatterStatus = 'ready';
  H.state.forceNoMatch = false;
  H.state.parsedItems = [];
  H.state.promotedBody = `---\ntitle: mock\nstatus: ready\n---\n\n## Now\n\n**State:** ready\n`;
  H.state.specQuality = {
    satisfied: true,
    applicable: false,
    mode: 'report-only',
    planSlug: 'mock',
    specSetHash: null,
    wouldBlock: ['no-first-class-spec-clauses'],
  };
  claimSpecMocks.setClaimSpec.mockReset();
  claimSpecMocks.setClaimSpec.mockResolvedValue({ ok: true, errors: [], revision: 1 });
  promotePlanItemsMock.mockReset();
  promotePlanItemsMock.mockResolvedValue({ promoted: 0, skipped: 0, flagOff: false, ...NO_EDGES });
  planLockMocks.withPlanLock.mockReset();
  planLockMocks.withPlanLock.mockResolvedValue({ kind: 'noop', value: false });
  // mockReset drains any unconsumed mockResolvedValueOnce, so a test that refuses
  // before the bar-critique gate cannot leak its verdict into the next test.
  barCritiqueMock.mockReset();
  barCritiqueMock.mockResolvedValue(null);
  // plans:start runs checkPlanStartable -> checkPlanAdmission, whose DEFAULT policy
  // source resolves the pot via potHomeSlugForHarness — a real-PG read this suite has
  // no database for (the rail census refused it, red-pinning every test here). Install
  // the gate's own host seam: a null policy is the gate's documented "no admission
  // policy" answer, so the door admits and the suite exercises plans:start itself.
  configurePlanAdmissionPolicySource(async () => null);
});

afterEach(() => {
  configurePlanAdmissionPolicySource(null);
});

/**
 * The retired branch's plan-row READ, found by CONTENT rather than by position.
 * The handler runs other reads through the same mocked `withWorkspace` — the
 * P-006 `checkPlanStartable` gate reads the plan row first — so indexing
 * `txCalls[0]` pins the transaction's statement ORDER, which no assertion here
 * is actually about. Adding a read ahead of it then reds this file for a change
 * that never touched it at all (it did, 2026-08-01).
 *
 * `op_status AS prev_op_status` is the retired SELECT's own distinctive shape,
 * so this cannot accidentally match the gate's separate read of the same table.
 */
const planRowRead = (): { strings: readonly string[]; values: unknown[] } => {
  const call = H.state.txCalls.find((c) => c.strings.join('§').includes('op_status AS prev_op_status'));
  if (!call) throw new Error(`no plan-row read among ${H.state.txCalls.length} tx call(s) — the read never ran`);
  return call;
};

/**
 * WI-38289: the op_status write is UNREACHABLE — `mugKettleSystemEnabled()` is a
 * hard `false`, so no input can steer the handler into its UPDATE branch. Assert
 * that as a standing property rather than deleting the subject outright: if the
 * branch ever becomes reachable again, these tests red instead of quietly
 * describing a system that no longer exists.
 */
const expectNoOpStatusWrite = (): void => {
  const writes = H.state.txCalls.filter((c) => c.strings.join('§').includes('UPDATE harness_shared.harness_plans'));
  expect(writes).toEqual([]);
};

describe('plans:start canonical BAR subject readiness', () => {
  it.each([
    { failure: 'missing', code: 'bar_snapshot_plan_missing' },
    { failure: 'unavailable', code: 'bar_snapshot_source_unavailable' },
    { failure: 'partial-unavailable', code: 'bar_snapshot_source_unavailable' },
    { failure: 'ambiguous', code: 'bar_snapshot_plan_ambiguous' },
    { failure: 'truncated', code: 'bar_snapshot_source_truncated' },
  ])('refuses a $failure subject without approval or promotion', async ({ failure, code }) => {
    const input = legacyBarInput();
    if (failure === 'missing' || failure === 'unavailable') input.planRows.rows = [];
    if (failure === 'unavailable' || failure === 'partial-unavailable') {
      input.readFailures = { plan: 'canonical subject read failed' };
    }
    if (failure === 'ambiguous') input.planRows.rows.push({ ...input.planRows.rows[0]! });
    if (failure === 'truncated') input.planRows.truncated = true;
    vi.mocked(readAcceptanceBarContractSnapshot)
      .mockResolvedValue(projectAcceptanceBarContractSnapshot(input));

    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({
      ok: false,
      error: 'plan_inputs_not_ready',
      code: 'acceptance_bar_contract_not_ready',
      source: 'acceptance-bar-contract',
      missing: expect.arrayContaining([code]),
    });
    expect(readAcceptanceBarContractSnapshot).toHaveBeenCalled();
    expect(planLockMocks.withPlanLock).not.toHaveBeenCalled();
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expectNoOpStatusWrite();
  });
});

// review-system-rework-reduction-2026-09-23 P-003 (RSR-P-003-A): plans:start refuses a
// post-epoch BAR whose METHOD, structured check or test layers are missing, or whose
// check files cannot satisfy a declared layer — before any proof is bound — and names
// the missing field. Real evaluator + real start gate; only the snapshot is supplied.
describe('plans:start BAR contract completeness before proof (P-003)', () => {
  const completeBar = (): AcceptanceBarTrace => ({
    barKey: 'R-1', criterionKey: 'r-1', barHash: 'a'.repeat(64),
    model: 'The export contains every matching row.',
    method: 'Export a multi-page fixture and compare rows.',
    check: { kind: 'tests', files: ['packages/operator-core/lib/export.integration.test.ts'] },
    requiredTestLayers: ['integration'],
    replication: null, falsifier: 'A matching row is missing.', role: 'outcome', mandatory: true,
    requiredScope: ['tree'], evidencePlane: 'tree', passRatings: ['healthy'], coversBarKeys: [],
    provenance: { lifecycle: 'pre-implementation', declaredAt: '2026-09-04T12:00:00.000Z', declaredBy: 'su-author' },
    mappings: [{
      planItemId: 'P-001', planItemStatus: 'todo', specId: 'spec-1', specRevision: 1,
      specContentHash: 'spec-hash', sourceBarHash: 'a'.repeat(64), sourceBarSetHash: 'b'.repeat(64),
      sourceRubricRevision: 1, evidencePlane: 'tree',
    }],
    workContracts: [{ workItemId: 'WI-1', specId: 'spec-1', specRevision: 1, specFingerprint: 'spec-hash', current: true }],
    proof: {
      state: 'missing', currentEvidence: 0, staleEvidence: 0, kinds: [], evidenceRefs: [],
      uncertainEvidence: 0, evidencePlanes: [],
    },
    grading: {
      state: 'missing', scorecardId: null, rubricRevision: null, gradedBy: null,
      selectedVia: null, rating: null, evidence: null,
    },
    readiness: { state: 'ready', codes: [], mapping: 'live', method: 'declared', workContract: 'current' },
  });
  const postEpochSnapshot = (trace: AcceptanceBarTrace): AcceptanceBarContractSnapshot => ({
    schemaVersion: 1, contentHash: 'c'.repeat(64), planSlug: 'mock', applicable: true,
    plan: {
      workspaceId: 'ws-of-harness', harnessSlug: 'papercup', planSlug: 'mock', status: 'ready',
      revision: 1, contentHash: 'fixture', adoptionEpoch: 1, cohort: 'post-epoch',
      barSetHash: 'b'.repeat(64), rubricSlug: 'acceptance-mock', rubricRevision: 1,
      seededAt: '2026-09-04T12:00:00.000Z', seededBy: 'su-author',
    },
    rubric: {
      rubricId: 'acceptance-mock', revision: 1, criteriaHash: 'criteria', barSetHash: 'b'.repeat(64),
      contract: {
        schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 1,
        seededAt: '2026-09-04T12:00:00.000Z', seededBy: 'su-author',
      },
      createdBy: 'su-author', ratingScale: ['healthy', 'degraded', 'broken', 'unknown'], classRef: null,
    },
    sourceRevisions: { subjectPlan: 1, rubricPlan: 1, clauses: [], workContracts: [], scorecardIds: [] },
    bounded: {
      plans: { rowsRead: 1, limit: 1, truncated: false },
      rubrics: { rowsRead: 1, limit: 2, truncated: false },
      planItems: { rowsRead: 1, limit: 500, truncated: false },
      clauses: { rowsRead: 1, limit: 1000, truncated: false },
      workContracts: { rowsRead: 1, limit: 1000, truncated: false },
      evidence: { rowsRead: 0, limit: 2000, truncated: false },
      scorecards: { rowsRead: 0, limit: 50, truncated: false },
      vetting: { rowsRead: 0, limit: 50, truncated: false },
      lineage: { rowsRead: 1, limit: 1000, truncated: false },
    },
    completeness: { complete: true, truncated: false, problems: [] },
    lineage: { identities: ['su-impl'], parties: [], complete: true },
    grading: {
      authoritativeScorecardId: null, gradedBy: null, selectedVia: null, rubricRevision: null,
      vetting: { state: 'missing', scorecardId: null, rubricRevision: null },
      authorVerdict: { state: 'missing', scorecardId: null, verdict: null },
    },
    bars: [trace],
    readiness: { state: 'ready', codes: [], nextRepair: null },
  });

  it('admits a complete contract past the BAR gate (positive control)', async () => {
    vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(postEpochSnapshot(completeBar()));
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).not.toMatchObject({ code: 'acceptance_bar_contract_not_ready' });
    expect(planLockMocks.withPlanLock).toHaveBeenCalled();
  });

  it('admits an explicitly manual BAR before clauses are projected', async () => {
    const bar = completeBar();
    bar.check = { kind: 'instrument', instrumentKey: 'none' };
    bar.requiredTestLayers = [];
    bar.automatedProofRequired = false;
    bar.mappings = [];
    vi.mocked(readAcceptanceBarContractSnapshot).mockResolvedValue(postEpochSnapshot(bar));

    const result = await run({ slug: 'mock', consulted: true });

    expect(result.data.results[0]).not.toMatchObject({ code: 'acceptance_bar_contract_not_ready' });
    expect(planLockMocks.withPlanLock).toHaveBeenCalled();
  });

  it.each([
    { defect: 'no METHOD', patch: { method: '' }, code: 'bar_snapshot_method_missing', field: 'METHOD is empty' },
    { defect: 'no structured check', patch: { check: null }, code: 'bar_snapshot_check_missing', field: 'no structured check' },
    { defect: 'no test layers', patch: { requiredTestLayers: [] }, code: 'bar_snapshot_proof_depth_missing',
      field: 'declares no requiredTestLayers' },
    { defect: 'a check file that cannot satisfy its declared layer',
      patch: { check: { kind: 'tests' as const, files: ['packages/operator-core/lib/export.test.ts'] } },
      code: 'bar_snapshot_check_invalid', field: 'no check.files entry is a test at that layer' },
  ])('refuses a BAR with $defect and names the field, without promotion', async ({ patch, code, field }) => {
    vi.mocked(readAcceptanceBarContractSnapshot)
      .mockResolvedValue(postEpochSnapshot({ ...completeBar(), ...patch } as AcceptanceBarTrace));
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({
      ok: false,
      error: 'plan_inputs_not_ready',
      code: 'acceptance_bar_contract_not_ready',
      source: 'acceptance-bar-contract',
      missing: expect.arrayContaining([code]),
      issues: expect.arrayContaining([expect.stringContaining(`R-1: `), expect.stringContaining(field)]),
    });
    expect(planLockMocks.withPlanLock).not.toHaveBeenCalled();
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });
});

describe('plans:start commit-time readiness', () => {
  const body = '---\ntitle: mock\nslug: mock\nstatus: draft\n---\n\n## Now\n**State:** draft\n**Next:** start\n';
  const meta = {
    version: 1, contentHash: 'fixture', opStatus: null,
    templateData: null, inputSchema: null, outputSchema: null,
  };

  function locked(over: Partial<typeof meta>, beforeCommit: () => void = () => {}) {
    const writes: string[] = [];
    planLockMocks.withPlanLock.mockImplementation(async (
      _ctx: unknown, _opts: unknown,
      mutate: (current: string, metadata: unknown) => Promise<{ newBody: string | null; value: unknown }>,
    ) => {
      beforeCommit();
      const result = await mutate(body, { ...meta, ...over });
      if (result.newBody !== null) writes.push(result.newBody);
      return { kind: 'applied', value: result.value, version: 1 };
    });
    return writes;
  }

  it('rejects a changed revision before approval and promotion', async () => {
    const writes = locked({ version: 2 });
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({ ok: false, error: 'plan_changed' });
    expect(writes).toEqual([]);
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('revalidates the locked schema and reports both input defects, with no partial write', async () => {
    const writes = locked({
      inputSchema: {
        type: 'object', properties: { harness: { type: 'string' }, attempts: { type: 'integer' } },
        required: ['harness'],
      } as never,
      templateData: { attempts: 'invalid' } as never,
    });
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({
      ok: false, error: 'plan_inputs_not_ready',
      readiness: { missing: ['harness'], issues: [expect.stringContaining('attempts')] },
    });
    expect(writes).toEqual([]);
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('still approves an unchanged no-schema legacy plan', async () => {
    const writes = locked({});
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({ ok: true, autoApproved: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('status: ready');
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
  });

  it('refuses policy/evidence invalidation between preflight and approval', async () => {
    const writes = locked({}, () => {
      H.state.specQuality = {
        satisfied: false, applicable: true, mode: 'enforced', planSlug: 'mock', specSetHash: 'changed',
        code: 'spec_quality_scorecard_missing', wouldBlock: ['current-policy-scorecard-missing'],
      };
    });
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({ ok: false, error: 'spec_quality_scorecard_missing' });
    expect(writes).toEqual([]);
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('does not promote while the commit lock is unavailable', async () => {
    planLockMocks.withPlanLock.mockResolvedValue({ kind: 'busy', busy: [] });
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({ ok: false, error: 'plan_locked' });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('does not swallow a commit-time conversation audit refusal', async () => {
    planLockMocks.withPlanLock.mockResolvedValue({
      kind: 'applied', value: { ok: false, code: 'conversation_audit_required', message: 'audit required' },
    });
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({ ok: false, error: 'conversation_audit_required' });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('does not proceed when commit-time validation is unavailable', async () => {
    planLockMocks.withPlanLock.mockRejectedValue(new Error('lock transaction unavailable'));
    const result = await run({ slug: 'mock', consulted: true });
    expect(result.data.results[0]).toMatchObject({ ok: false, error: 'plan_start_revalidation_unavailable' });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });
});

describe('plans:start terminal guard', () => {
  it('opts into idempotent completion so a slow finished saga surfaces its outcome', () => {
    // plans:start may commit approval, promotion, and/or the Promoted block
    // before its 60s transport budget expires. The dispatcher must return the
    // handler's structured outcome when the retry-safe saga finishes after the
    // abort, rather than replacing it with an ambiguous timeout.
    expect((tool as { idempotent?: boolean }).idempotent).toBe(true);
  });

  it('declares a transport budget above the flat MCP deadline for the saga', () => {
    expect((tool as { timeoutSec?: number }).timeoutSec).toBe(PLANS_START_TIMEOUT_SEC);
    expect(PLANS_START_TIMEOUT_SEC).toBeGreaterThan(55);
  });

  it('rejects a draft forward ref at activation before any gate, row write, or promotion', async () => {
    H.state.frontmatterStatus = 'draft';
    H.state.parsedItems = [
      {
        id: 'P-001',
        storedStatus: 'todo',
        text: 'depends on a missing item',
        blockedBy: ['P-099'],
        importance: 'normal',
        decisionRefs: [],
        phase: 'Phase 1',
        lineNumber: 1,
        rawLine: '- **P-001** `todo` depends on a missing item blocked-by: P-099',
      },
    ];

    const result = await run({ slug: 'invalid-dependency-plan' });

    expect(result.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(result.data.results[0]).toMatchObject({
      ok: false,
      error: 'invalid_plan_dependencies',
      dependencyDiagnostics: [
        {
          code: 'dependency_endpoint_missing',
          itemId: 'P-001',
          ref: 'P-099',
          path: ['P-001', 'P-099'],
        },
      ],
    });
    expect(activationMocks.gate).not.toHaveBeenCalled();
    expect(H.state.txCalls).toEqual([]);
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('refuses before start gates/promotion when the conversation audit is missing', async () => {
    activationMocks.gate.mockResolvedValue({
      satisfied: false,
      code: 'conversation_audit_required',
      message: 'run plans:audit phase activation',
    });

    const result = await run({ slug: 'mock' });

    expect(result.data.results[0]).toMatchObject({
      ok: false,
      error: 'conversation_audit_required',
      message: 'run plans:audit phase activation',
    });
    expect(admissionMocks.preflight).not.toHaveBeenCalled();
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
  });

  it('refuses before approval and promotion when the pre-promotion lane is unknown', async () => {
    admissionMocks.laneHealth.mockResolvedValueOnce({ effective: { claimable: null } });

    const result = await run({ slug: 'live-plan-2026-06-02', consulted: true });

    expect(result.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(result.data.results[0]).toMatchObject({
      ok: false,
      error: 'admission_refused',
      admissionReason: 'lane-unknown',
      laneHealthPreflight: { effective: { claimable: null } },
    });
    expect(result.data.results[0].message).toContain('before approval or promotion');
    expect(planLockMocks.withPlanLock).not.toHaveBeenCalled();
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(admissionMocks.preflight).not.toHaveBeenCalled();
  });

  it('fails closed before promotion when an adopted spec set lacks a current quality verdict', async () => {
    H.state.specQuality = {
      satisfied: false,
      applicable: true,
      mode: 'enforced',
      planSlug: 'live-plan-2026-06-02',
      specSetHash: 'hash-one',
      code: 'spec_quality_scorecard_missing',
      wouldBlock: ['exact-specSetHash-scorecard-missing'],
    };
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({
      ok: false,
      error: 'spec_quality_not_current',
      code: 'spec_quality_scorecard_missing',
    });
    expect(() => planRowRead()).toThrow();
  });

  it('SPEC-P-007 R-7: refuses a contracted plan with a stale bar critique before approval and promotion', async () => {
    H.state.specQuality = {
      satisfied: true,
      applicable: true,
      mode: 'enforced',
      planSlug: 'live-plan-2026-06-02',
      specSetHash: 'hash-one',
      wouldBlock: [],
    };
    barCritiqueMock.mockResolvedValueOnce({
      mode: 'enforced',
      authorIds: ['su-author'],
      mandatoryOutcomeBarCount: 1,
      nonDroppedItemCount: 1,
      verdict: {
        satisfied: false,
        planSlug: 'live-plan-2026-06-02',
        code: 'critique_stale',
        message: 'stale',
        threshold: 1,
        barSetHash: null,
        consultIds: ['c-1'],
        critics: ['L:critic'],
        authorLineageConsultIds: [],
        clauseShortfalls: [{ specId: 'S-1', revision: 2, coveredBy: 0, reason: 'stale' }],
        barSetShortfall: null,
      },
    });
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(barCritiqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'live-plan-2026-06-02', contractEnforced: true }),
    );
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'critique_stale', message: 'stale' });
    expect(promotePlanItemsMock).not.toHaveBeenCalled();
    expect(() => planRowRead()).toThrow();
  });

  it('SPEC-P-007 cohort: a report-only bar-critique verdict is surfaced but never refuses', async () => {
    H.state.specQuality = {
      satisfied: true,
      applicable: true,
      mode: 'enforced',
      planSlug: 'live-plan-2026-06-02',
      specSetHash: 'hash-one',
      wouldBlock: [],
    };
    barCritiqueMock.mockResolvedValueOnce({
      mode: 'report-only',
      reportOnlyReason: 'pre-cohort',
      authorIds: [],
      mandatoryOutcomeBarCount: 0,
      nonDroppedItemCount: 1,
      verdict: {
        satisfied: false,
        planSlug: 'live-plan-2026-06-02',
        code: 'critique_missing',
        message: 'missing',
        threshold: 1,
        barSetHash: null,
        consultIds: [],
        critics: [],
        authorLineageConsultIds: [],
        clauseShortfalls: [{ specId: 'S-1', revision: 1, coveredBy: 0, reason: 'missing' }],
        barSetShortfall: null,
      },
    });
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({ ok: true, barCritique: { mode: 'report-only', reportOnlyReason: 'pre-cohort' } });
  });

  it('surfaces no-clause rollout as report-only while allowing the start path', async () => {
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({
      ok: true,
      specQuality: { satisfied: true, applicable: false, mode: 'report-only' },
    });
  });

  it.each(['shipped', 'superseded'])('refuses a %s plan without writing the started row', async (status) => {
    H.state.frontmatterStatus = status;
    const res = await run({ slug: 'done-plan-2026-06-02' });

    expect(res.isError).toBeUndefined();
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_terminal', status });
    // The guard returns BEFORE the INSERT — no started row is created.
    expect(H.state.txCalls).toHaveLength(0);
  });

  it('starts a non-terminal (ready) plan — the guard lets it through to the plan row', async () => {
    H.state.frontmatterStatus = 'ready';
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.isError).toBeUndefined();
    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({ ok: true });
    // The positive control for the two refusals above: a non-terminal plan gets
    // PAST the guard and reaches its row. What the handler does once there is the
    // retired-axis block's subject, not this one's.
    expect(() => planRowRead()).not.toThrow();
  });

  it('starts a legacy/no-frontmatter plan (status null → not terminal)', async () => {
    H.state.frontmatterStatus = null;
    const res = await run({ slug: 'legacy-plan' });
    expect(res.isError).toBeUndefined();
    // The contract is that a MISSING status is not read as terminal. Assert the
    // refusal's ABSENCE — this used to be asserted via "the UPDATE ran", which
    // WI-38289 removed as coverage of an unreachable branch.
    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).not.toMatchObject({ error: 'plan_terminal' });
    expect(() => planRowRead()).not.toThrow();
  });

  it('WI-5825: the plan row is keyed on the resolvePlanScope pair — the same authority the plan READ used', async () => {
    H.state.frontmatterStatus = 'ready';
    await run({ slug: 'live-plan-2026-06-02' });
    const { values } = planRowRead();
    // This handler reads the plan through the reader path and then addresses the
    // row; keying that off a SECOND resolver (activeWorkspaceId / the raw ctx
    // slug) is exactly how the two came to disagree. The retired branch reads on
    // the same key the write used, so the invariant outlives the write itself.
    expect(values).toContain('ws-of-harness');
    expect(values).not.toContain(DEFAULT_WORKSPACE_ID);
  });
});

/**
 * P-047 / D-010 — the OPERATIONAL axis (op_status) retires with the Mug/Kettle
 * tier, and this is the half that actually matters: op_status does not ENABLE
 * anything for su, it RESERVES the plan's items from scheduler self-selection
 * (`reservedPlanLaneExclusionSql`) for a dispatcher that no longer runs. So the
 * contract is asymmetric and both halves need pinning: the WRITE must not
 * happen, and everything else the verb does — approval and, above all,
 * promotion — must still happen. A gate that also stopped promotion would be
 * the P-044 mistake ("the cut was backwards"): the su queue would never fill.
 */
describe('plans:start — the retired op_status axis (P-047)', () => {
  it('writes NO op_status while the tier is retired — and says so instead of claiming a start', async () => {
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    // The whole point: no UPDATE reached harness_plans.
    expectNoOpStatusWrite();
    // Reporting `status:'started'` on a row that carries nothing is the WI-5825
    // "announced a start that never happened" bug wearing a flag.
    expect(res.data.results[0]).toMatchObject({ ok: true, status: null, opStatusRetired: true });
    // EI-21016597300738770: the response now carries the exact synchronous
    // promotion outcome instead of returning ok while a detached refusal is lost.
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
    expect(res.data.results[0]).toMatchObject({
      promotion: { promoted: 0, skipped: 0, flagOff: false },
    });
    expect(res.data.results[0].message).toContain('promotion completed before this response');
    // transitioned MUST stay false, or the `plan started` demand event fires at
    // the retired Queen for a transition that did not occur. This is the trap in
    // the retired branch: prev_op_status mirrors the CURRENT value there, so a
    // never-started plan scores `null !== 'started'` unless axisLive gates it.
    expect(res.data.results[0]).toMatchObject({ transitioned: false });
  });

  it('surfaces a spec-triad promotion refusal and its concrete repair work-item', async () => {
    promotePlanItemsMock.mockResolvedValue({
      promoted: 0,
      skipped: 3,
      specTriadBlocked: true,
      specTriadMissing: ['requirements', 'design'],
      specTriadWorkItem: 'WI-TRIAD-1',
      ...NO_EDGES,
    });

    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.results[0]).toMatchObject({
      ok: true,
      promotion: {
        promoted: 0,
        skipped: 3,
        specTriadBlocked: true,
        specTriadWorkItem: 'WI-TRIAD-1',
      },
    });
    expect(res.data.results[0].message).toContain('requirements, design');
    expect(res.data.results[0].message).toContain('WI-TRIAD-1');
  });

  it('surfaces an acceptance BAR promotion refusal instead of claiming completion', async () => {
    promotePlanItemsMock.mockResolvedValue({
      promoted: 0,
      skipped: 4,
      acceptanceBarBlocked: true,
      acceptanceBarLifecycle: {
        phase: 'pre-start',
        applicable: true,
        satisfied: false,
        codes: [],
        blockingBars: [],
        contractCodes: [],
        codeAttribution: [],
        nextRepair: null,
        staleGradingScorecardId: null,
        message: 'acceptance BAR contract is not ready for start — 1 of 1 BAR(s) blocking',
      },
      ...NO_EDGES,
    });

    const res = await run({ slug: 'live-plan-2026-06-02' });
    console.log('PROBE_BAR', JSON.stringify({ ok: res.data.results[0]?.ok, code: res.data.results[0]?.code, error: res.data.results[0]?.error, readiness: res.data.results[0]?.readiness, msg: String(res.data.results[0]?.message ?? '').slice(0, 300) }).slice(0, 1500));

    expect(res.data.results[0]).toMatchObject({
      ok: true,
      promotion: {
        promoted: 0,
        skipped: 4,
        acceptanceBarBlocked: true,
      },
    });
    expect(res.data.results[0].message).toContain(
      'Item promotion is blocked by the acceptance BAR contract: acceptance BAR contract is not ready for start',
    );
    expect(res.data.results[0].message).not.toContain('promotion completed before this response');
  });

  it('keeps approval best-effort but reports a promotion exception explicitly', async () => {
    promotePlanItemsMock.mockRejectedValue(new Error('promotion boom'));

    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.results[0]).toMatchObject({
      ok: true,
      promotion: null,
      promotionError: 'promotion boom',
    });
    expect(res.data.results[0].message).toContain('Item promotion failed: promotion boom');
  });

  it('refuses a start whose exact-plan admission is not ready while preserving promotion evidence', async () => {
    admissionMocks.preflight.mockResolvedValueOnce({
      ready: false,
      status: 'refused',
      reason: 'promotion-lag',
      message: 'Actionable plan items lack a promoted row: P-002.',
    });

    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({
      ok: false,
      error: 'admission_refused',
      status: null,
      opStatusRetired: true,
      promotion: { promoted: 0, skipped: 0, flagOff: false },
      admission: { ready: false, reason: 'promotion-lag' },
    });
    expect(res.data.results[0].message).toContain('Actionable plan items lack a promoted row: P-002.');
    expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
    expectNoOpStatusWrite();
  });

  it('persists the ready exact-plan claim spec for the starter before returning', async () => {
    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(res.data.results[0]).toMatchObject({
      ok: true,
      claimSpecBinding: { ok: true, revision: 1 },
    });
    expect(claimSpecMocks.setClaimSpec).toHaveBeenCalledTimes(1);
    expect(claimSpecMocks.setClaimSpec).toHaveBeenCalledWith(expect.objectContaining({
      cupId: 'agent-test',
      workspaceId: 'ws-of-harness',
      updatedBy: 'agent-test',
      potSlug: 'papercup',
      spec: expect.objectContaining({
        specId: 'plans-start-live-plan-2026-06-02',
        view: {
          filter: {
            all: [
              { field: 'plan', op: '=', value: 'live-plan-2026-06-02' },
              { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
            ],
          },
        },
      }),
    }));
  });

  it('returns an immutable receipt before trimmed HTTP shaping can hide a post-promotion refusal', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'plan-start-receipt-'));
    const previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    try {
      admissionMocks.preflight.mockResolvedValueOnce({ ready: false, status: 'refused',
        reason: 'floor-gated', message: 'P-001 is excluded.', diagnostic: 'detail '.repeat(4_000) });
      const ctx = { ...(MAKE_CTX() as object), transport: 'http', contextTier: 'trimmed' };
      const out = await tool.handler({ harness: 'papercup', slug: 'live-plan-2026-06-02' } as never, ctx as never) as any;
      const body = JSON.parse(out.content[0].text);
      expect(body.results[0]).toMatchObject({ error: 'admission_refused',
        promotion: { promoted: 0, skipped: 0 }, admission: { ready: false, reason: 'floor-gated' } });
      expect(body._projection.cursor.tool).toBe('capability:read');
      const reference = parseScratchReference(readFileSync(body._projection.cursor.args.file_path))!;
      const original = JSON.parse(reference.payload.subarray(body._projection.cursor.bodyOffsetInPayload).toString());
      expect(original.results[0].admission.diagnostic).toHaveLength(28_000);
      expect(promotePlanItemsMock).toHaveBeenCalledTimes(1);
      expect(admissionMocks.preflight).toHaveBeenCalledTimes(1);
    } finally {
      if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps a mixed-family admission binding broad', async () => {
    admissionMocks.preflight.mockResolvedValueOnce({
      ready: true,
      status: 'ready',
      reason: 'ready',
      message: 'exact-plan admission ready',
      claimKinds: null,
    });

    const res = await run({ slug: 'mixed-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 1, failed: 0 });
    expect(claimSpecMocks.setClaimSpec).toHaveBeenCalledWith(expect.objectContaining({
      spec: expect.objectContaining({
        view: { filter: { field: 'plan', op: '=', value: 'mixed-plan-2026-06-02' } },
      }),
    }));
  });

  it('refuses the start when the exact-plan claim-spec binding cannot be persisted', async () => {
    claimSpecMocks.setClaimSpec.mockRejectedValueOnce(new Error('claim spec store unavailable'));

    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({
      ok: false,
      error: 'claim_spec_binding_failed',
      status: null,
      opStatusRetired: true,
      admission: { ready: true, reason: 'ready' },
      claimSpecBinding: null,
      claimSpecBindingError: 'claim spec store unavailable',
    });
    expect(res.data.results[0].message).toContain('Exact-plan claim-spec binding failed: claim spec store unavailable');
  });

  it('WI-5825: still detects plan_not_found — the retired branch reads the SAME key the write used', async () => {
    H.state.forceNoMatch = true;
    const res = await run({ slug: 'ghost-plan' });
    expect(res.data.counts).toEqual({ ok: 0, failed: 1 });
    expect(res.data.results[0]).toMatchObject({ ok: false, error: 'plan_not_found' });
    // ...and crucially it is NOT reported as started, so the `plan started` demand
    // event (which fires on transitioned:true) cannot fire on a row that missed.
    // WI-5825 originally pinned this against the UPDATE; the retired read inherits
    // it verbatim because it is keyed identically, which is why WI-38289 could
    // drop the write-side copy without losing the contract.
    expect(res.data.results[0]).not.toMatchObject({ status: 'started' });
  });

  /**
   * CONTROL (WI-38289) — permanent, and deliberately wrong on purpose.
   *
   * `expectNoOpStatusWrite()` asserts the ABSENCE of something no input can
   * produce any more, so nothing in this file can ever trip it: on its own it is
   * indistinguishable from an assertion that is simply broken. That is the exact
   * vacuous-guard shape this item was filed about, one level up — so the detector
   * gets its own falsification here, against a synthetic tx record rather than a
   * mutated tree. If someone weakens the matcher, THIS reds.
   */
  it('control: expectNoOpStatusWrite actually detects an op_status write', () => {
    H.state.txCalls.push({ strings: ['UPDATE harness_shared.harness_plans SET op_status'], values: [] });
    expect(() => expectNoOpStatusWrite()).toThrow();
  });

  it('KEEPS promoting items into work_items — the gate is on the write, never on the mechanism', async () => {
    const { promotePlanItems } = await import('../../../plan-workitem-promotion-run');
    await run({ slug: 'live-plan-2026-06-02' });
    // Fire-and-forget inside the handler (`void import(...)`), so wait for it
    // rather than asserting synchronously on a promise nobody awaited.
    await vi.waitFor(() => expect(promotePlanItems).toHaveBeenCalled());
    expect(vi.mocked(promotePlanItems).mock.calls[0][0]).toMatchObject({
      planSlug: 'live-plan-2026-06-02',
      workspaceId: 'ws-of-harness',
    });
  });

  it('writes the promoted work-item rows back to the plan with source provenance', async () => {
    H.state.parsedItems = [
      {
        id: 'P-001',
        storedStatus: 'todo',
        text: 'Build the API',
        blockedBy: [],
        importance: 'normal',
        decisionRefs: [],
        phase: 'Phase 1',
        lineNumber: 1,
        rawLine: '- **P-001** `todo` Build the API',
      },
    ];
    promotePlanItemsMock.mockResolvedValue({
      promoted: 1,
      skipped: 0,
      ...NO_EDGES,
      workItems: [
        { planItemId: 'P-001', workItemId: 'WI-123', newlyPromoted: true, actionable: true },
      ],
    });
    H.state.promotedBody = `---\ntitle: mock\nstatus: ready\n---\n\n## Now\n\n**State:** ready\n`;
    planLockMocks.withPlanLock.mockImplementation(
      async (
        _ctx: unknown,
        opts: { intent?: string },
        mutator: (current: string | null, meta: unknown) => Promise<{ newBody: string | null; value: unknown }>,
      ) => {
        if (!opts.intent?.includes('write ## Promoted')) return { kind: 'noop', value: false };
        const outcome = await mutator(H.state.promotedBody, null);
        if (outcome.newBody !== null) H.state.promotedBody = outcome.newBody;
        return {
          kind: 'applied',
          value: outcome.value,
          filePath: 'plans/mock.md',
          version: 2,
          scope: { workspaceId: 'ws-of-harness', harnessSlug: 'papercup' },
        };
      },
    );

    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.results[0]).toMatchObject({
      ok: true,
      promotedBlock: { ok: true, rows: 1, changed: true },
    });
    expect(H.state.promotedBody).toContain('## Promoted');
    expect(H.state.promotedBody).toContain('- [ ] WI-123 — Build the API <!-- P-001 -->');
  });

  it('surfaces a plan-lock failure while retaining the successful promotion outcome', async () => {
    H.state.parsedItems = [
      {
        id: 'P-001',
        storedStatus: 'todo',
        text: 'Build the API',
        blockedBy: [],
        importance: 'normal',
        decisionRefs: [],
        phase: 'Phase 1',
        lineNumber: 1,
        rawLine: '- **P-001** `todo` Build the API',
      },
    ];
    promotePlanItemsMock.mockResolvedValue({
      promoted: 1,
      skipped: 0,
      ...NO_EDGES,
      workItems: [
        { planItemId: 'P-001', workItemId: 'WI-123', newlyPromoted: true, actionable: true },
      ],
    });
    planLockMocks.withPlanLock.mockImplementation(async (_ctx: unknown, opts: { intent?: string }) =>
      opts.intent?.includes('write ## Promoted')
        ? { kind: 'busy', busy: [] }
        : { kind: 'noop', value: false },
    );

    const res = await run({ slug: 'live-plan-2026-06-02' });

    expect(res.data.results[0]).toMatchObject({
      ok: true,
      promotion: { promoted: 1 },
      promotedBlockError: 'plan_locked',
    });
    expect(res.data.results[0].message).toContain('Generated `## Promoted` block write failed: plan_locked');
  });
});
