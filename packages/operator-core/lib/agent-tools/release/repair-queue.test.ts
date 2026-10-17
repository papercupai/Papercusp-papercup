import type { ToolResult } from '@papercusp/tooldef';
import { projectBoundedPayload } from '@papercusp/tooldef';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drainDetached, trackDetached } from '../../detached-imports';
import { checkpointRootMirror } from '../../release-checkpoint-launch';
import type { FrozenCandidateRepairQueue } from '../../release/frozen-candidate-repair-queue';
import type { FrozenRepairEditLedgerRow } from '../../release/frozen-repair-edit-ledger';
import { checkpointPidIdentity } from '../../release/checkpoint-qualification-transaction';
import { AdmissionOffthreadTimeoutError } from '../../release/admission-offthread';
import { precheckPopulation } from '../../release/admission-fix-precheck';
import {
  runAdmissionPrecheckWorker,
  type AdmissionPrecheckWorkerInput,
} from '../../release/admission-fix-precheck-managed';

vi.mock('../../release/gate-action-receipt', () => ({
  executeWithGateActionReceipt: vi.fn(async (input: { run: () => Promise<unknown>; ownerId: string }) => ({
    ok: true, receiptId: 'test-repair-queue-receipt',
    ownership: { certainty: 'claim-row-locked-through-effect', workItem: 'WI-gate',
      holder: input.ownerId, takenAt: '2026-09-26T18:00:00.000Z' },
    effect: await input.run(),
  })),
}));

const queue = {
  schemaVersion: 3 as const,
  phase: 'awaiting-fixer' as const,
  candidate: 'a'.repeat(40),
  base: 'b'.repeat(40),
  repairHead: 'c'.repeat(40),
  worktreePath: '/tmp/repair',
  attempts: 1,
  openedAtMs: 1,
  updatedAtMs: 2,
  fixerSpawnId: 'fixer-1',
  failingTests: ['lib/red.test.ts'],
  signature: [],
  admissionPrecheck: {
    schemaVersion: 1 as const,
    operationId: 'repair-precheck-fixture',
    status: 'passed' as const,
    candidate: 'a'.repeat(40),
    repairHead: 'c'.repeat(40),
    builtCommit: 'd'.repeat(40),
    builtTree: 'f'.repeat(40),
    files: ['lib/red.test.ts'],
    actor: 'su-test',
    startedAtMs: 1,
    updatedAtMs: 2,
    expiresAtMs: 60_002,
    verdict: {
      ok: true as const,
      ran: true as const,
      commit: 'd'.repeat(40),
      population: {
        signatureTestFiles: [],
        admittedTestFiles: ['lib/red.test.ts'],
        nonTestKinds: [],
        canProveDoesNotFix: false,
        files: ['lib/red.test.ts'],
      },
      results: [{ path: 'lib/red.test.ts', status: 'pass' as const }],
      passing: ['lib/red.test.ts'],
      failing: [],
      unmeasured: [],
      fixes: [],
    },
  },
};
const NEW_HEAD = 'd'.repeat(40);
const ALT_HEAD = 'e'.repeat(40);
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readState: vi.fn(),
  retire: vi.fn(),
  write: vi.fn(),
  alive: vi.fn(),
  audit: vi.fn(),
  admit: vi.fn(),
  population: vi.fn(),
  admissionJobOptions: vi.fn(),
  admissionGit: vi.fn(),
  lineage: vi.fn(),
  retract: vi.fn(),
  containment: vi.fn(),
  presence: vi.fn(),
  listPresence: vi.fn().mockResolvedValue([]),
  // P-020: the hunk-exact source builder + the ledger read the admit op consults first.
  hunkExact: vi.fn(),
  committedPatch: vi.fn(),
  foreign: vi.fn(),
  ledger: vi.fn(),
  importPreflight: vi.fn(),
  // P-006 (R6): the admit door's two-phase pre-check seam — the runner FACTORY the door
  // creates for the canonical root, and the root canonicalization it consults first.
  precheckFactory: vi.fn(),
  canonicalRoot: vi.fn(),
  getTask: vi.fn(),
  startPrecheckWorker: vi.fn(),
  transition: vi.fn(),
  gateOwnership: vi.fn(),
  emitAwaitedEvent: vi.fn(),
  // WI-10004151 part 2: the admit door's dependency-generation prediction seam.
  predict: vi.fn(),
  // P-004: the sole-editor fallback's tagged-template read of edit_attribution_ledger.
  attributionSql: vi.fn(),
}));
vi.mock('../../release/dependency-admission-prediction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/dependency-admission-prediction')>()),
  predictDependencyGeneration: mocks.predict,
}));
vi.mock('../../coord/gate-ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coord/gate-ownership')>()),
  readGateOwnership: mocks.gateOwnership,
}));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: mocks.emitAwaitedEvent }));
vi.mock('../../harness/routines/release-actions', () => ({
  applyFrozenCandidateRepairQueueTransition: mocks.transition,
  readFrozenCandidateRepairQueue: mocks.read,
  readFrozenCandidateRepairQueueState: mocks.readState,
  retireFrozenCandidateRepairQueue: mocks.retire,
  writeFrozenCandidateRepairQueue: mocks.write,
}));
vi.mock('../../release/fixer-liveness', () => ({ releaseFixerSpawnAlive: mocks.alive }));
vi.mock('../../release-deploy-launch', () => ({ integrationRoot: () => '/repo' }));
vi.mock('../../harness/routines/hive-release-env', () => ({
  resolvePotSuiteCommand: vi.fn(async () => 'npm test'),
  resolveCheckpointRouting: vi.fn(async () => ({ root: '/tooling',
    extraEnv: { PAPERCUSP_INTEGRATION_ROOT: '/drill' }, clearEnv: [] })),
}));
vi.mock('../../release/frozen-lineage-ledger-reconcile', () => ({
  reconcileFrozenRepairQueueWithLineageRef: (current: unknown) => mocks.lineage(current),
}));
vi.mock('../../release/admission-fix-precheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/admission-fix-precheck')>()),
  createCheckpointTreeFixPrecheckRunner: mocks.precheckFactory,
  resolveCanonicalIntegrationRoot: mocks.canonicalRoot,
}));
vi.mock('../../task-manager/store', () => ({ getTask: mocks.getTask }));
vi.mock('../../release/admission-fix-precheck-managed', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/admission-fix-precheck-managed')>()),
  startAdmissionPrecheckWorker: mocks.startPrecheckWorker,
}));
vi.mock('../../release/judged-sha-containment', () => ({
  integrationBranch: () => 'staging',
  containmentForPaths: mocks.containment,
}));
vi.mock('../../release/repair-head-admission', async (importOriginal) => ({
  // Real pure helpers (normalizeAdmissionPath, used by the P-004 attribution verdict).
  ...(await importOriginal<typeof import('../../release/repair-head-admission')>()),
  admitPathsOntoRepairHead: mocks.admit,
  realAdmissionGit: mocks.admissionGit,
  retractAdmission: mocks.retract,
}));
vi.mock('../../release/hunk-exact-admission', async (importOriginal) => ({
  // The REAL attributeUnledgeredPaths + SOLE_EDITOR_WINDOW_MARGIN_MS: the P-004 fallback's verdict
  // is exercised end-to-end through the door, not re-mocked.
  ...(await importOriginal<typeof import('../../release/hunk-exact-admission')>()),
  buildHunkExactSource: mocks.hunkExact,
  buildCommittedPatchSource: mocks.committedPatch,
  summarizeForeignHunks: mocks.foreign,
}));
vi.mock('../../release/frozen-repair-edit-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/frozen-repair-edit-ledger')>()),
  readFrozenRepairEditLedger: mocks.ledger,
}));
vi.mock('../../release/admission-import-completeness', () => ({
  importCompletenessPreflight: mocks.importPreflight,
}));
// WI-10005223: production runs these jobs on a worker thread, where vi.mock cannot reach.
// Route them through the REAL job dispatcher inline, so the builder mocks above still apply
// and the spec → preflight-closure rebuild (admissionPreflightFromSpec) is exercised too.
// The worker path itself is covered by release/admission-offthread.test.ts.
vi.mock('../../release/admission-offthread', async () => {
  const { executeAdmissionJob } = await import('../../release/admission-jobs');
  const original = await vi.importActual<typeof import('../../release/admission-offthread')>(
    '../../release/admission-offthread',
  );
  return {
    ...original,
    runAdmissionJob: async (
      job: Parameters<typeof executeAdmissionJob>[0],
      options?: { timeoutMs?: number; stepName?: string },
    ) => {
      mocks.admissionJobOptions(job, options);
      if (job.kind === 'precheck-population') return mocks.population(job.input);
      return executeAdmissionJob(job);
    },
  };
});
/** P-020: what the hunk-exact builder returns for a clean single-path replay. */
const HX_SOURCE = 'h'.repeat(40);
const hunkExactOf = (paths = ['lib/red.test.ts']) => ({
  ok: true as const,
  sourceCommit: HX_SOURCE,
  tree: 'x'.repeat(40),
  ledgerRowIds: [41],
  perPath: paths.map((path) => ({
    path,
    applied: 1,
    agents: ['su-test'],
    foreignHunks: 0,
    foreignAgents: [] as string[],
    baseBlob: null,
    blob: 'f'.repeat(40),
    unchanged: false,
  })),
  allUnchanged: false,
});
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
vi.mock('../locks/identity', () => ({ readIdentity: () => ({ ownerId: 'su-test' }) }));
// P-021 claim-leg: claiming a leg claims its paths — the caller's presence current_files.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su · test', workspaceId: 'ws-1' }),
}));
vi.mock('../coordination/presence', () => ({
  writePresence: mocks.presence,
  listPresence: mocks.listPresence,
}));

/** A P-021 repair manifest with one red test-file leg whose subject path is known. */
const manifestRow = {
  legId: 'test-file:lib/red.test.ts',
  kind: 'test-file' as const,
  recipe: 'npm run test:file -- lib/red.test.ts',
  subjectPaths: ['lib/red.test.ts'],
  subjectPathsTruncated: 0,
  subjectSource: 'leg-id' as const,
  status: { kind: 'red-at-candidate' as const },
  statusLabel: 'red-at-candidate',
  admitCommand: "release:repair-queue { op:'admit', paths:['lib/red.test.ts'] }",
  claim: null,
};
const manifest = {
  schemaVersion: 1 as const,
  candidate: queue.candidate,
  repairHead: queue.repairHead,
  signatureFingerprint: 'fp-1',
  builtAtMs: 5,
  rows: [manifestRow],
  rowsTruncated: 0,
};
const queueWithManifest = { ...queue, manifest };

/** What the P-001 primitive returns for a clean single-path admission onto the fixture queue. */
const admissionOf = (published: boolean, paths = ['lib/red.test.ts'], commit = NEW_HEAD) => ({
  ok: true as const,
  commit,
  tree: 'f'.repeat(40),
  diff: paths,
  unchanged: [] as string[],
  lineageRef: `refs/papercusp/frozen/${'a'.repeat(40)}`,
  published,
  entry: {
    atMs: 10,
    actor: 'su-test',
    source: { ref: 'staging', sha: 'e'.repeat(40) },
    fromRepairHead: 'c'.repeat(40),
    toRepairHead: commit,
    paths,
    unchanged: [] as string[],
    blobs: Object.fromEntries(paths.map((p) => [p, 'f'.repeat(40)])),
  },
});
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign((...a: unknown[]) => mocks.attributionSql(...a), { unsafe: mocks.audit }),
  }),
}));

const repairQueueModule = await import('./repair-queue');
const tool = repairQueueModule.default;
const { assessFrozenRepairFixerAuthorization, repairQueueAbortCompletionReceipt } = repairQueueModule;
const { decisionFieldsFirst } = repairQueueModule;
type Out = { data?: unknown; content?: { text: string }[] };
const body = (value: unknown) => {
  const out = value as Out;
  return 'data' in out ? out.data : JSON.parse(out.content![0]!.text);
};
const toolResult = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ data: payload }) }],
});

describe('release:repair-queue abort-completion receipts', () => {
  const attempt = { callId: 'repair-queue-call-1', toolName: 'release:repair-queue' };

  it('identifies completed admit, claim-leg, record-edit, and retire writes by their durable effect ids', () => {
    const completedWrites = [
      ['admit', 'release:repair-queue:admit:receipt-admit'],
      ['claim-leg', 'release:repair-queue:claim-leg:receipt-claim'],
      ['record-edit', 'release:repair-queue:record-edit:42'],
      ['retire', 'release:repair-queue:retire:receipt-retire'],
      ['admit-precheck', 'release:repair-queue:admit-precheck:operation-1'],
    ] as const;

    for (const [op, effectRef] of completedWrites) {
      expect(repairQueueAbortCompletionReceipt({}, toolResult({
        op,
        completionReceipt: { status: 'recorded', effectRef },
      }), attempt)).toEqual({ status: 'recorded', effectRef });
    }
  });

  it('returns not-recorded only for explicit read, preview, no-op, or failed-CAS outcomes', () => {
    const noEffects = [
      { op: 'get', ok: true },
      { op: 'admit', dryRun: true, admitted: false },
      { op: 'admit', pending: true, verdict: 'precheck-running', dryRun: false },
      { op: 'retire', alreadyClear: true, retired: false },
      { op: 'claim-leg', verdict: 'no-frozen-queue', claimed: false },
      { op: 'record-edit', recorded: true, inserted: false },
      { op: 'retire', retired: false, casMiss: true },
      { op: 'claim-leg', refused: true, effectMayHaveRun: false },
    ];

    for (const payload of noEffects) {
      expect(repairQueueAbortCompletionReceipt({}, toolResult(payload), attempt).status).toBe('not-recorded');
    }
  });

  it('fails closed when a write result lacks a durable receipt or its effect may have run', () => {
    expect(repairQueueAbortCompletionReceipt(
      {},
      toolResult({ op: 'claim-leg', ok: true, claimed: true, persisted: true }),
      attempt,
    )).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-completion-receipt'] });
    expect(repairQueueAbortCompletionReceipt(
      {},
      toolResult({ op: 'admit', refused: false, effectMayHaveRun: true }),
      attempt,
    ).status).toBe('recovery-incomplete');
    expect(repairQueueAbortCompletionReceipt(
      {},
      toolResult({ op: 'retire', completionReceipt: { status: 'recorded', effectRef: 'other:receipt' } }),
      attempt,
    ).status).toBe('recovery-incomplete');
  });
});

describe('selected harness repair queue', () => {
  it('predicts a foreign lockfile using operator tooling and the target checkout', async () => {
    mocks.admit.mockReturnValue(admissionOf(false, ['package-lock.json']));
    mocks.hunkExact.mockReturnValue(hunkExactOf(['package-lock.json']));
    const ctx = { role: 'su', harnessSlug: 'slack-asana-bug-drill', workspaceId: 'ws-drill' } as never;
    await tool.handler({ op: 'admit', paths: ['package-lock.json'] } as never, ctx);
    expect(mocks.predict).toHaveBeenCalledWith({
      integrationRoot: '/drill', toolingRoot: '/tooling', ref: NEW_HEAD, paths: ['package-lock.json'],
    });
  });

  it('passes foreign source and operator tooling separately into the managed admission runner', async () => {
    mocks.admit.mockImplementation((input: { dryRun: boolean; paths: string[] }) => admissionOf(!input.dryRun, input.paths));
    mocks.readState.mockResolvedValue({ status: 'value', queue: { ...queue, admissionPrecheck: undefined } });
    const ctx = { role: 'su', harnessSlug: 'slack-asana-bug-drill', workspaceId: 'ws-drill' } as never;
    const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, ctx));
    expect(result).toMatchObject({ verdict: 'precheck-running', admitted: false });
    expect(mocks.startPrecheckWorker).toHaveBeenCalledWith(expect.objectContaining({
      integrationRoot: '/drill', toolingRoot: '/tooling', testCommand: ['npm', 'test'],
      queueTarget: { workspaceId: 'ws-drill', installSlug: 'slack-asana-bug-drill' },
    }));
  });
  it('reads a foreign queue and previews its admission against that harness checkout', async () => {
    mocks.admit.mockReturnValue(admissionOf(false));
    const ctx = { role: 'su', harnessSlug: 'slack-asana-bug-drill', workspaceId: 'ws-drill' } as never;
    const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, ctx));
    expect(mocks.readState).toHaveBeenCalledWith({ workspaceId: 'ws-drill', installSlug: 'slack-asana-bug-drill' });
    expect(result).toMatchObject({ target: { workspaceId: 'ws-drill', installSlug: 'slack-asana-bug-drill' },
      source: { root: '/drill', ref: 'staging' } });
    expect(mocks.gateOwnership).toHaveBeenCalledWith({ harness: 'slack-asana-bug-drill' });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gateOwnership.mockResolvedValue({
    assessment: 'unowned', claimState: 'no-object', workItem: null, takenBy: null, unknown: null,
  });
  mocks.read.mockResolvedValue(queue);
  mocks.readState.mockResolvedValue({ status: 'value', queue });
  mocks.alive.mockResolvedValue(false);
  mocks.retire.mockResolvedValue({ retired: true, current: null });
  mocks.audit.mockResolvedValue([]);
  mocks.write.mockResolvedValue(undefined);
  mocks.transition.mockImplementation(async (_target, transition) => {
    const fresh = (mocks.write.mock.calls.at(-1)?.[1] ?? queue) as typeof queue;
    return {
      status: 'written',
      queue: await transition(fresh),
      fresh,
      retries: 0,
    };
  });
  mocks.lineage.mockImplementation((current: unknown) => ({
    status: 'in-sync',
    queue: current,
    detail: 'fixture lineage is in sync',
    reconciled: [],
  }));
  mocks.presence.mockResolvedValue(undefined);
  mocks.retract.mockReturnValue(true);
  mocks.admissionGit.mockReturnValue({ status: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' });
  mocks.ledger.mockResolvedValue([]);
  mocks.attributionSql.mockResolvedValue([]);
  mocks.foreign.mockReturnValue({ count: 0, agents: [], byPath: {} });
  mocks.importPreflight.mockReturnValue(() => null);
  mocks.hunkExact.mockReturnValue(hunkExactOf());
  mocks.population.mockImplementation((input) => ({ ok: true, population: precheckPopulation(input) }));
  mocks.canonicalRoot.mockImplementation((root: string) => root);
  mocks.precheckFactory.mockReturnValue(async ({ commit, files }: { commit: string; files: readonly string[] }) => ({
    ran: true as const,
    commit,
    results: files.map((path) => ({ path, status: 'pass' as const })),
  }));
  mocks.getTask.mockResolvedValue({ state: 'running', confined: true });
  mocks.startPrecheckWorker.mockImplementation(async (input: AdmissionPrecheckWorkerInput) => {
    const pending = mocks.write.mock.calls.at(-1)?.[1] as FrozenCandidateRepairQueue | undefined;
    const worker = runAdmissionPrecheckWorker(input, {
      getTask: (taskId) => mocks.getTask(taskId),
      readQueue: async () => pending
        ? { status: 'value', queue: pending }
        : { status: 'absent' },
      transition: (queueTarget, update) => mocks.transition(queueTarget, update),
      createRunner: () => mocks.precheckFactory({
        integrationRoot: input.integrationRoot,
        checkpointRoot: input.checkpointRoot,
      }),
    });
    void trackDetached(worker);
    return { taskId: input.taskId, confined: true };
  });
  mocks.containment.mockImplementation((paths: string[], judgedSha: string) =>
    paths.map((path) => ({ path, containedInJudgedSha: judgedSha === NEW_HEAD, judgedBlob: null, stagingBlob: null })),
  );
  mocks.predict.mockReset();
});

describe('release:repair-queue', () => {
  it('allows the four-minute admission preview to finish before the MCP deadline', () => {
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec).toBe(295);
  });

  it('refuses a queue mutation by a nonowner while a live gate fixer holds the condition', async () => {
    mocks.gateOwnership.mockResolvedValue({
      assessment: 'held-live', claimState: 'held', workItem: 'WI-38026', takenBy: 'su-live-peer',
      holderSessionState: 'live', unknown: null, duplicates: [],
    });
    const result = body(await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never,
      { role: 'su' } as never));
    expect(result).toMatchObject({ ok: false, refused: true, reason: 'gate_condition_claimed_by_live_peer' });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('documents request scope without accepting target identity in the operation payload', () => {
    // 32963fcf18 moved the "selected harness scope" sentence into guidance.notWhen; the
    // description still names the request scope, so assert each where it actually lives.
    expect(tool.description).toContain('for the selected harness (operator home if unscoped)');
    expect(tool.guidance?.notWhen).toContain('Use the selected harness scope, not a harness/workspace key in the payload');
    expect(tool.args.safeParse({ op: 'get', harness: 'other' }).success).toBe(false);
  });

  it('defaults an empty args object to get while preserving strict branch validation', () => {
    const omittedOp = tool.args.safeParse({});
    expect(omittedOp.success).toBe(true);
    expect(omittedOp.success && omittedOp.data).toEqual({ op: 'get' });
    expect(tool.args.safeParse({ op: 'admit' }).success).toBe(false);
    expect(tool.args.safeParse({ op: 'retire' }).success).toBe(false);
    // `status` is the read verb across the sibling release:* family —
    // `release:deploy { op: 'status' }` is the documented read for the same
    // intent — so agents reach for it here too (measured 3x in 24h from 2
    // distinct agents). It aliases onto the read branch rather than leaving the
    // family's naming split, and must NORMALIZE so the parsed op is `get`.
    const statusAlias = tool.args.safeParse({ op: 'status' });
    expect(statusAlias.success).toBe(true);
    expect((statusAlias as { data: { op: string } }).data.op).toBe('get');
    // Falsifiability control: a neighbouring unknown op must STILL be refused,
    // so the assertions above cannot pass merely because the schema went
    // permissive. If this line ever goes green, the alias is over-broad.
    expect(tool.args.safeParse({ op: 'state' }).success).toBe(false);
    expect(tool.effectForCall?.({} as never)).toBe('read');
    expect(tool.effectForCall?.({ op: 'admit', confirm: false } as never)).toBe('read');
    expect(tool.effectForCall?.({ op: 'admit', confirm: true } as never)).toBe('write');
  });

  it('accepts the complete queue identity tuple on admit/converge and rejects partial tuples', () => {
    const identity = {
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
    };
    expect(tool.args.safeParse({ op: 'admit', paths: ['lib/red.test.ts'], ...identity }).success).toBe(true);
    expect(tool.args.safeParse({ op: 'converge', paths: ['lib/red.test.ts'], ...identity }).success).toBe(true);
    for (const missing of Object.keys(identity) as Array<keyof typeof identity>) {
      const partial = { ...identity };
      delete partial[missing];
      expect(tool.args.safeParse({ op: 'admit', paths: ['lib/red.test.ts'], ...partial }).success).toBe(false);
      expect(tool.args.safeParse({ op: 'converge', paths: ['lib/red.test.ts'], ...partial }).success).toBe(false);
    }
  });

  it('accepts workItem on both admission variants', () => {
    const workItem = 'WI-10000288';
    expect(tool.args.safeParse({ op: 'admit', paths: ['lib/red.test.ts'], workItem }).success).toBe(true);
    expect(tool.args.safeParse({ op: 'converge', paths: ['lib/red.test.ts'], workItem }).success).toBe(true);
  });

  it('get exposes one normalized queue and never advertises retire for a recoverable one', async () => {
    const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(result).toMatchObject({
      ok: true,
      target: { workspaceId: 'ws-1', installSlug: 'papercusp' },
      repairQueue: {
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        updatedAtMs: queue.updatedAtMs,
        fixerAlive: false,
        retireAllowed: true,
      },
    });
    // WI-1586801: this fixture is a dead-fixer queue, so retirement is permitted but the
    // decision is `recover-dead-fixer`. The tool must surface the safe verb, not a
    // paste-ready call that would destroy a queue the gate is about to recover.
    expect(result.repairQueue.nextAction).not.toContain('expectedUpdatedAtMs: 2');
    expect(result.repairQueue.nextAction).toContain("op: 'admit'");
    expect(result.callerAuthorization).toMatchObject({
      status: 'not-applicable',
      authorized: null,
    });
  });

  it('runs both lineage probes through the admission worker, including the fresh CAS reducer', async () => {
    mocks.lineage.mockImplementation((current: typeof queue) => ({
      status: 'reconciled',
      queue: { ...current, updatedAtMs: current.updatedAtMs + 1 },
      refHead: NEW_HEAD,
      detail: 'fixture lineage was rebuilt',
      reconciled: [],
    }));
    await tool.handler({ op: 'get' } as never, { role: 'su' } as never);
    expect(mocks.admissionJobOptions).toHaveBeenCalledTimes(2);
    for (const [job, options] of mocks.admissionJobOptions.mock.calls) {
      expect(job).toMatchObject({ kind: 'reconcile-lineage', root: '/repo' });
      expect(options).toMatchObject({ timeoutMs: 120_000, stepName: 'lineage-reconcile' });
    }
    expect(mocks.lineage).toHaveBeenCalledTimes(2);
  });

  it('keeps delegated-fixer authorization visible when a large queue diagnostic is bounded', () => {
    const callerAuthorization = {
      status: 'authorized-delegate',
      authorized: true,
      callerSpawnId: 'fixer-1',
      queueFixerSpawnId: 'fixer-1',
      safeAction: 'Continue using this delegated fixer identity.',
    };
    const response = decisionFieldsFirst({
      ok: true,
      op: 'get',
      target: { workspaceId: 'ws-1', installSlug: 'papercusp' },
      repairQueue: Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [`diagnostic${i}`, 'x'.repeat(2_000)]),
      ),
      repairQueueRead: { status: 'value', schemaVersion: 3 },
      callerAuthorization,
    });

    const projected = projectBoundedPayload(response, {
      toolName: 'release:repair-queue',
      tier: 'trimmed',
      targetChars: 1_500,
    });

    expect(projected).toMatchObject({
      ok: true,
      op: 'get',
      callerAuthorization: {
        status: 'authorized-delegate',
        authorized: true,
        callerSpawnId: 'fixer-1',
        queueFixerSpawnId: 'fixer-1',
      },
    });
    expect(JSON.stringify(projected)).toContain('authorized-delegate');
  });

  describe('WI-10007509: get marks same-head-contradicted signature entries', () => {
    const leg = '@papercusp/operator-core :: test:lane-stateful';
    const mixedQueue = { ...queue, failingTests: [leg, 'lib/red.test.ts'] };
    const legsAt = (head: string, status: 'pass' | 'fail') => [{
      legs: {
        head: head.slice(0, 12),
        atMs: 1_791_000_000_000,
        ok: status === 'pass',
        failingSignatures: status === 'pass' ? [] : [leg],
        legs: [{ id: leg, status, durationMs: 1_159_000 }],
      },
    }];

    it('marks a leg the tick passed at the live repairHead and keeps the signature whole', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: mixedQueue });
      mocks.audit.mockResolvedValueOnce(legsAt(queue.repairHead, 'pass'));
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
      expect(result.sameHeadContradicted).toMatchObject({
        status: 'contradicted',
        entries: [leg],
        allContradicted: false,
        measuredAtHead: queue.repairHead.slice(0, 12),
      });
      expect(result.sameHeadContradicted.note).toContain('fix the remaining entries');
      const [sqlText, params] = mocks.audit.mock.calls[0]! as [string, unknown[]];
      expect(sqlText).toContain("'repairTickLegs'");
      expect(params).toEqual(['papercusp']);
    });

    it('says re-verify, not fix, when every entry is contradicted', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: { ...queue, failingTests: [leg] } });
      mocks.audit.mockResolvedValueOnce(legsAt(queue.repairHead, 'pass'));
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
      expect(result.sameHeadContradicted).toMatchObject({ entries: [leg], allContradicted: true });
      expect(result.sameHeadContradicted.note).toContain('needs a re-verification, not a fix');
    });

    it.each([
      ['a tick from an earlier head', () => legsAt('d'.repeat(40), 'pass')],
      ['a tick that failed the leg', () => legsAt(queue.repairHead, 'fail')],
      ['no tick measurement', () => []],
    ])('omits the field for %s', async (_label, rows) => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: mixedQueue });
      mocks.audit.mockResolvedValueOnce(rows());
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
      expect(result).not.toHaveProperty('sameHeadContradicted');
    });

    it('reports unknown, never "no contradiction", when the measurement read fails', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: mixedQueue });
      mocks.audit.mockRejectedValueOnce(new Error('pg down'));
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
      expect(result.sameHeadContradicted).toMatchObject({
        status: 'unknown',
        reason: 'repair-tick-legs-read-failed',
      });
    });
  });

  it('P-025: get renders a newer-schema queue as unreadable instead of null/none', async () => {
    mocks.readState.mockResolvedValue({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: 5,
    });
    const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(result).toMatchObject({
      ok: true,
      op: 'get',
      repairQueue: {
        status: 'unreadable',
        reason: 'schema-newer-than-reader',
        schemaVersion: 5,
      },
      repairQueueRead: { status: 'unreadable' },
      callerAuthorization: { status: 'queue-unreadable', authorized: false },
    });
  });

  it.each([
    ['admit', { op: 'admit', paths: ['lib/red.test.ts'], confirm: true }],
    [
      'retire',
      {
        op: 'retire',
        expectedCandidate: queue.candidate,
        expectedRepairHead: queue.repairHead,
        expectedUpdatedAtMs: queue.updatedAtMs,
        reason: 'owner-authorized retirement',
        confirm: true,
      },
    ],
  ] as const)('P-025: %s refuses an unreadable queue without mutating anything', async (op, args) => {
    mocks.readState.mockResolvedValue({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: 5,
    });
    const result = body(await tool.handler(args as never, { role: 'su' } as never));
    expect(result).toMatchObject({
      ok: false,
      op,
      refused: true,
      reason: 'repair-queue-unreadable',
      repairQueue: { status: 'unreadable', schemaVersion: 5 },
    });
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it('authorizes only the exact verified signed fixer delegated by the queue', async () => {
    const authorized = assessFrozenRepairFixerAuthorization(queue, {
      role: 'release-fixer',
      spawnId: 'fixer-1',
      sigVerifiedSpawn: true,
    });
    expect(authorized).toMatchObject({
      status: 'authorized-delegate',
      authorized: true,
      callerSpawnId: 'fixer-1',
      queueFixerSpawnId: 'fixer-1',
    });
    expect(authorized.safeAction).toContain('delegator, not a competing fixer');

    expect(
      assessFrozenRepairFixerAuthorization(queue, {
        role: 'release-fixer',
        spawnId: 'fixer-2',
        sigVerifiedSpawn: true,
      }),
    ).toMatchObject({ status: 'different-fixer', authorized: false });
    expect(
      assessFrozenRepairFixerAuthorization(queue, {
        role: 'release-fixer',
        spawnId: 'fixer-1',
        sigVerifiedSpawn: false,
      }),
    ).toMatchObject({ status: 'unsigned-caller', authorized: false });
  });

  it('get derives the authorization verdict from the handler signed-spawn context', async () => {
    const result = body(
      await tool.handler(
        { op: 'get' } as never,
        { role: 'release-fixer', spawnId: 'fixer-1', sigVerifiedSpawn: true } as never,
      ),
    );
    expect(result.callerAuthorization).toMatchObject({
      status: 'authorized-delegate',
      authorized: true,
      callerSpawnId: 'fixer-1',
    });
  });

  // ---- admit: THE door onto the judged lineage (P-002 / D-004 / D-010) -------------------

  it('admit REFUSES without paths, touching neither git nor the row — an admission is by explicit allowlist', async () => {
    const result = body(await tool.handler({ op: 'admit' } as never, { role: 'su' } as never));
    expect(result).toMatchObject({ ok: false, op: 'admit', refused: true, reason: 'paths_required', admitted: false });
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('admit reports no-frozen-queue when nothing is frozen, and builds nothing', async () => {
    mocks.readState.mockResolvedValue({ status: 'absent' });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({ ok: true, op: 'admit', verdict: 'no-frozen-queue', admitted: false });
    expect(result.nextAction).toMatch(/Do not fire release:checkpoint-run/);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it('dry run: the primitive builds + proves with dryRun:true onto the CURRENT repairHead, and nothing is published or persisted', async () => {
    mocks.admit.mockReturnValue(admissionOf(false));
    // The realistic hunk-exact world: the caller's edit reached the frozen ledger. (An empty ledger
    // would make hunk-exact refuse `no-ledgered-hunks` and route through the P-004 sole-editor
    // fallback instead, which is covered by its own tests.)
    mocks.ledger.mockResolvedValueOnce([
      {
        id: 1,
        candidate: queue.candidate,
        agent: 'su-test',
        path: 'lib/red.test.ts',
        hunk: { kind: 'edit', old: 'a', new: 'b', replaceAll: false },
        atMs: Date.now(),
        toolUseId: 'toolu_dry',
        editIndex: 0,
        workItem: null,
      },
    ]);
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never),
    );
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    expect(mocks.admit.mock.calls[0]![0]).toMatchObject({
      root: '/repo',
      candidate: queue.candidate,
      repairHead: queue.repairHead,
      paths: ['lib/red.test.ts'],
      // P-020: the primitive admits from the synthesised hunk-exact source, never the tip.
      source: { ref: HX_SOURCE },
      actor: 'su-test',
      dryRun: true,
    });
    expect(result).toMatchObject({
      ok: true,
      op: 'admit',
      dryRun: true,
      admitted: false,
      verdict: 'would-admit',
      judgedSha: queue.repairHead,
      wouldMoveRepairHead: { from: queue.repairHead, to: NEW_HEAD },
      proof: { diff: ['lib/red.test.ts'], unchanged: [] },
    });
    expect(result.note).toMatch(/confirm:true/);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.retract).not.toHaveBeenCalled();
    // WI-6554700010009422: a bounded-payload door keeps LEADING fields, so the decision fields
    // must precede the bulky queue echo, or a budget cut returns ok:true with no verdict.
    const keys = Object.keys(result);
    for (const decision of ['ok', 'admitted', 'verdict', 'judgedSha', 'proof']) {
      expect(keys.indexOf(decision)).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(decision)).toBeLessThan(keys.indexOf('repairQueue'));
    }
    expect(keys.indexOf('callerAuthorization')).toBeLessThan(keys.indexOf('repairQueue'));
    expect(keys.slice(-5).sort()).toEqual(
      ['repairQueue', 'repairQueueRead', 'source', 'target', 'timings'].sort(),
    );
    // WI-10005695: the response names where the admit spent its time, step by step.
    expect(result.timings.inFlight).toEqual([]);
    expect(result.timings.steps.map((s: { step: string }) => s.step)).toEqual([
      'inspect-queue',
      'ledger-read',
      'hunk-exact',
      'build-proof',
      'containment',
    ]);
    expect(result.timings.steps.every((s: { ms: number; ok: boolean }) => s.ok && s.ms >= 0)).toBe(true);
  });

  describe('P-004 sole post-freeze editor fallback (EI-24313562050732849 / EI-24557368838482892)', () => {
    const PIN = '7'.repeat(40);
    const CUT_SEC = 1_700_000_000;
    /** Route the fallback's git reads by argv; everything else keeps the suite default. */
    const routeGit = () =>
      mocks.admissionGit.mockImplementation((argv: string[]) => {
        if (argv[0] === 'show' && argv.includes('--format=%ct')) return { status: 0, stdout: `${CUT_SEC}\n`, stderr: '' };
        if (argv[0] === 'rev-parse' && (argv[2] === 'staging^{commit}' || argv[2] === `${PIN}^{commit}`)) {
          return { status: 0, stdout: `${PIN}\n`, stderr: '' };
        }
        return { status: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' };
      });
    const attributionRow = (agent: string) => ({
      file: 'lib/red.test.ts',
      agent_id: agent,
      ts: new Date(CUT_SEC * 1000 + 60_000),
    });

    it('nothing ledgered + only the caller in the edit attribution ledger ⇒ admits staging’s blob pinned to the tip read now, under a recorded auto reason', async () => {
      routeGit();
      mocks.attributionSql.mockResolvedValueOnce([attributionRow('su-test')]);
      mocks.admit.mockReturnValue(admissionOf(false));
      const result = body(
        await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never),
      );
      expect(mocks.attributionSql).toHaveBeenCalledTimes(1);
      // Never the hunk replay: there is nothing ledgered to replay.
      expect(mocks.hunkExact).not.toHaveBeenCalled();
      expect(mocks.admit).toHaveBeenCalledTimes(1);
      expect(mocks.admit.mock.calls[0]![0]).toMatchObject({
        paths: ['lib/red.test.ts'],
        source: { ref: PIN, recordAsRef: 'staging' },
        dryRun: true,
      });
      expect(result).toMatchObject({ ok: true, verdict: 'would-admit', mode: 'whole-blob' });
      expect(result.timings.steps.map((s: { step: string }) => s.step)).toEqual(
        expect.arrayContaining(['sole-editor-candidate-time', 'sole-editor-pin']),
      );
    });

    it('a peer in the edit attribution ledger ⇒ no whole-blob fallback; the hunk-exact refusal names the peer', async () => {
      routeGit();
      mocks.attributionSql.mockResolvedValueOnce([attributionRow('su-test'), attributionRow('su-peer')]);
      mocks.hunkExact.mockReturnValueOnce({
        ok: false,
        code: 'no-ledgered-hunks',
        detail: 'lib/red.test.ts has no ledgered hunk by su-test',
        path: 'lib/red.test.ts',
        exits: [],
      });
      const result = body(
        await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never),
      );
      expect(mocks.attributionSql).toHaveBeenCalledTimes(1);
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, refused: true, reason: 'no-ledgered-hunks', mode: 'hunk-exact' });
      expect(result.detail).toMatch(/edit attribution ledger: .*su-peer/);
    });

    it('a ledgered hunk on the path ⇒ the attribution ledger is never consulted', async () => {
      mocks.ledger.mockResolvedValueOnce([
        {
          id: 1,
          candidate: queue.candidate,
          agent: 'su-test',
          path: 'lib/red.test.ts',
          hunk: { kind: 'edit', old: 'a', new: 'b', replaceAll: false },
          atMs: Date.now(),
          toolUseId: 'toolu_x',
          editIndex: 0,
          workItem: null,
        },
      ]);
      mocks.admit.mockReturnValue(admissionOf(false));
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never);
      expect(mocks.attributionSql).not.toHaveBeenCalled();
      expect(mocks.hunkExact).toHaveBeenCalledTimes(1);
    });
  });

  it('returns a structured read-only timeout when a dry-run admission worker reaches its deadline', async () => {
    mocks.admit.mockRejectedValueOnce(new AdmissionOffthreadTimeoutError('admit', 240_000, 'build-proof'));
    const result = body(
      await tool.handler(
        {
          op: 'admit',
          paths: ['lib/red.test.ts'],
          wholeBlob: true,
          reason: 'verify the timeout result shape',
        } as never,
        { role: 'su' } as never,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      op: 'admit',
      admitted: false,
      refused: true,
      dryRun: true,
      verdict: 'timeout',
      reason: 'admission-preview-timeout',
      mode: 'whole-blob',
      timedOutStep: 'build-proof',
      timeoutMs: 240_000,
      timings: {
        inFlight: [],
        steps: expect.arrayContaining([expect.objectContaining({ step: 'build-proof', ok: false })]),
      },
    });
    expect(mocks.admissionJobOptions).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'admit', input: expect.objectContaining({ dryRun: true }) }),
      { timeoutMs: 240_000, stepName: 'build-proof' },
    );
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.retract).not.toHaveBeenCalled();
  });

  it('rejects a stale expected queue identity before reading the edit ledger or building an admission', async () => {
    const result = body(
      await tool.handler(
        {
          op: 'admit',
          paths: ['lib/red.test.ts'],
          expectedCandidate: queue.candidate,
          expectedRepairHead: 'd'.repeat(40),
          expectedUpdatedAtMs: queue.updatedAtMs,
        } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      admitted: false,
      refused: true,
      reason: 'exact_queue_identity_mismatch',
      currentQueueIdentity: {
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        updatedAtMs: queue.updatedAtMs,
      },
    });
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(mocks.hunkExact).not.toHaveBeenCalled();
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('confirm:true publishes, marks the queue ADMITTED (repairHead moved, phase ready-to-verify, ledger entry), persists and audits', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const metadata = vi.fn();
    const result = body(
      await tool.handler(
        {
          op: 'admit',
          paths: ['lib/red.test.ts'],
          confirm: true,
          reason: 'gate red on this file',
          workItem: 'WI-10000288',
        } as never,
        { role: 'su', metadata } as never,
      ),
    );
    // R6 two-phase: the LAST admission call is the publish (the first is the measured build).
    expect(mocks.admit.mock.calls.at(-1)![0]).toMatchObject({ dryRun: false, reason: 'gate red on this file' });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const [target, written] = mocks.write.mock.calls[0]!;
    expect(target).toEqual({ workspaceId: 'ws-1', installSlug: 'papercusp' });
    expect(written).toMatchObject({
      candidate: queue.candidate,
      repairHead: NEW_HEAD,
      phase: 'ready-to-verify',
      admissions: [{ fromRepairHead: queue.repairHead, toRepairHead: NEW_HEAD, paths: ['lib/red.test.ts'] }],
    });
    expect(result).toMatchObject({
      ok: true,
      op: 'admit',
      admitted: true,
      verdict: 'admitted',
      persisted: true,
      auditRecorded: true,
      completionReceipt: {
        status: 'recorded',
        effectRef: 'release:repair-queue:admit:test-repair-queue-receipt',
      },
      judgedSha: NEW_HEAD,
      movedRepairHead: { from: queue.repairHead, to: NEW_HEAD },
      repairQueue: { repairHead: NEW_HEAD, phase: 'ready-to-verify' },
    });
    // Containment is reported against the NEW judged sha, where the path is now carried.
    expect(result.containment).toEqual([
      expect.objectContaining({ path: 'lib/red.test.ts', containedInJudgedSha: true }),
    ]);
    expect(result.nextAction).toMatch(/Do NOT fire release:checkpoint-run/);
    expect(metadata).toHaveBeenLastCalledWith(expect.objectContaining({
      gateActionReceipt: expect.objectContaining({
        action: 'repair-queue:admit',
        ownership: expect.objectContaining({ certainty: 'claim-row-locked-through-effect' }),
        target: { candidate: queue.candidate, repairHead: queue.repairHead },
        effect: expect.objectContaining({ status: 'repair-head-published', persisted: true }),
      }),
    }));
    expect(mocks.retract).not.toHaveBeenCalled();
    // The audit row names the admission, never a tip.
    const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
    expect(auditDetails).toMatchObject({
      op: 'admit',
      from: queue.repairHead,
      to: NEW_HEAD,
      paths: ['lib/red.test.ts'],
      workItem: 'WI-10000288',
      persisted: true,
    });
  });

  it('forwards expectedUpdatedAtMs to the queue writer on a confirmed CAS-guarded admission', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const identity = {
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
    };
    const result = body(
      await tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, ...identity } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, admitted: true, persisted: true });
    expect(mocks.write).toHaveBeenCalledWith(
      { workspaceId: 'ws-1', installSlug: 'papercusp' },
      expect.objectContaining({ repairHead: NEW_HEAD }),
      { expectedUpdatedAtMs: queue.updatedAtMs },
    );
  });

  it('WI-10006866: a CAS miss because a concurrent read RECONCILED the row to this admission is persisted, never retracted', async () => {
    // Measured 2026-10-06 19:12Z: a repair-queue read in the admit window rebuilt the row from
    // the ref (provenance reconciled-from-ref, synthetic 2000-01-01 atMs), so the door's CAS
    // missed. The old bare catch reported persist_failed and retracted the ref: ref-behind-row.
    mocks.admit.mockReturnValue(admissionOf(true));
    mocks.write.mockRejectedValueOnce(new Error('frozen repair queue write conflict: updatedAtMs moved'));
    const door = admissionOf(true).entry;
    const reconciledRow = {
      ...queue,
      repairHead: NEW_HEAD,
      admissions: [{ ...door, atMs: 946_684_800_000, provenance: 'reconciled-from-ref' }],
      updatedAtMs: queue.updatedAtMs + 1,
    };
    mocks.transition.mockImplementationOnce(async (_target, transition) => ({
      status: 'written',
      queue: transition(reconciledRow as typeof queue),
      fresh: reconciledRow as typeof queue,
      retries: 0,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adopt-reconciled → persisted=true/));
    warn.mockRestore();
    expect(mocks.retract).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      admitted: true,
      persisted: true,
      judgedSha: NEW_HEAD,
      persistError: expect.stringMatching(/write conflict/),
      persistSettlement: 'adopt-reconciled',
    });
    // The door's richer entry replaced the reconciled rebuild (the synthetic date is gone).
    const settled = await (mocks.transition.mock.results.at(-1)?.value as Promise<{ queue: typeof queue & { admissions: Array<{ atMs: number; provenance?: string }> } }>);
    expect(settled.queue.admissions).toHaveLength(1);
    expect(settled.queue.admissions[0]!.provenance).toBeUndefined();
    expect(settled.queue.admissions[0]!.atMs).not.toBe(946_684_800_000);
  });

  it('WI-6554700010009332: a CAS miss whose fresh row already records the admission is persisted, never retracted', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    mocks.write.mockRejectedValueOnce(new Error('frozen repair queue write conflict: updatedAtMs moved'));
    const door = admissionOf(true).entry;
    const recordedRow = {
      ...queue,
      repairHead: NEW_HEAD,
      admissions: [door],
      updatedAtMs: queue.updatedAtMs + 1,
    };
    mocks.transition.mockImplementationOnce(async (_target, transition) => ({
      status: 'unchanged',
      queue: transition(recordedRow as typeof queue),
      fresh: recordedRow as typeof queue,
      retries: 0,
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recorded.*persisted=true/));
    warn.mockRestore();
    expect(mocks.retract).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      admitted: true,
      persisted: true,
      judgedSha: NEW_HEAD,
      persistSettlement: 'recorded',
    });
  });

  it('WI-6554700010009332: a settle failure retracts only after a fresh row proves the admission parent', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    mocks.write.mockRejectedValueOnce(new Error('queue CAS moved'));
    mocks.transition.mockRejectedValueOnce(new Error('settle read timed out'));
    // The first read is inspectQueue; the second is the guard's fresh re-read.
    mocks.readState.mockResolvedValueOnce({ status: 'value', queue });
    mocks.readState.mockResolvedValueOnce({ status: 'value', queue });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/settle-failed: settle read timed out → persisted=false/));
    warn.mockRestore();
    expect(mocks.retract).toHaveBeenCalledWith({
      root: '/repo',
      candidate: queue.candidate,
      published: NEW_HEAD,
      previousRepairHead: queue.repairHead,
    });
    expect(result).toMatchObject({
      ok: false,
      admitted: false,
      refused: true,
      reason: 'persist_failed',
      persisted: false,
      judgedSha: queue.repairHead,
      retractionProof: 'parent',
    });
    expect(result.note).toMatch(/retracted/);
  });

  it('WI-6554700010009332: a settle failure with an unknown fresh re-read preserves the lineage ref', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    mocks.write.mockRejectedValueOnce(new Error('pg down'));
    mocks.transition.mockRejectedValueOnce(new Error('pg down'));
    // The first read is inspectQueue; the second cannot establish the row state.
    mocks.readState.mockResolvedValueOnce({ status: 'value', queue });
    mocks.readState.mockResolvedValueOnce({ status: 'unreadable', reason: 'invalid-shape', schemaVersion: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/settle-failed: pg down → persisted=false/));
    warn.mockRestore();
    expect(mocks.retract).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      admitted: false,
      refused: true,
      reason: 'persist_failed',
      persisted: false,
      judgedSha: queue.repairHead,
      retractionProof: 'unknown',
      retractionDetail: expect.stringMatching(/unreadable|unknown/),
    });
    expect(result.note).toMatch(/inconclusive|preserved/);
  });

  it('a primitive refusal (stray-paths) is surfaced verbatim and nothing is written', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'stray-paths',
      stray: ['lib/other.ts'],
      detail: 'REFUSED: the built admission touches 1 path(s) outside the allowlist',
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: false,
      refused: true,
      verdict: 'refused',
      reason: 'stray-paths',
      stray: ['lib/other.ts'],
      judgedSha: queue.repairHead,
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('P-004: an admission-incomplete refusal surfaces missing[] and an admitCommand widened by exactly the wanted paths; the door wires the preflight; nothing is written', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'admission-incomplete',
      detail: 'REFUSED: admission is incomplete',
      commit: 'e'.repeat(40),
      missing: [
        {
          from: 'lib/red.test.ts',
          specifier: './red-helper',
          wanted: 'lib/red-helper.ts',
          tried: ['lib/red-helper.ts', 'lib/red-helper.tsx'],
          atProbeRef: 'present',
        },
      ],
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: false,
      refused: true,
      verdict: 'refused',
      reason: 'admission-incomplete',
      missing: [{ from: 'lib/red.test.ts', wanted: 'lib/red-helper.ts', atProbeRef: 'present' }],
      judgedSha: queue.repairHead,
    });
    const admitCommand = (result as { admitCommand?: string }).admitCommand ?? '';
    expect(admitCommand).toMatch(/op: 'admit'/);
    expect(admitCommand).toContain('"lib/red.test.ts"');
    expect(admitCommand).toContain('"lib/red-helper.ts"');
    expect((admitCommand.match(/lib\/red-helper\.ts/g) ?? []).length).toBe(1);
    expect(String((result as { note?: string }).note)).toContain('never widened');
    // The door hands the primitive the P-004 preflight on every admission.
    expect(mocks.admit.mock.calls[0]?.[0]).toMatchObject({ preflight: expect.any(Function) });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('nothing-to-admit reads as already-admitted: idempotent, ok:true, no write', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'nothing-to-admit',
      detail: 'every named path already has its staging content',
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: true,
      admitted: false,
      verdict: 'already-admitted',
      judgedSha: queue.repairHead,
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('path-not-found remains a refusal instead of reading as already-admitted', async () => {
    mocks.admit.mockReturnValue({
      ok: false,
      code: 'path-not-found',
      detail: 'lib/never-existed.ts is absent from the candidate, source, and repairHead',
    });
    const result = body(
      await tool.handler({ op: 'admit', paths: ['lib/never-existed.ts'], confirm: true } as never, { role: 'su' } as never),
    );
    expect(result).toMatchObject({
      ok: false,
      admitted: false,
      refused: true,
      verdict: 'refused',
      reason: 'path-not-found',
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("converge is an ALIAS of admit — same door, same semantics, result op:'admit'", async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const result = body(
      await tool.handler(
        { op: 'converge', paths: ['lib/red.test.ts'], confirm: true } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, op: 'admit', verdict: 'admitted', admitted: true });
    expect(mocks.admit.mock.calls.at(-1)![0]).toMatchObject({ paths: ['lib/red.test.ts'], dryRun: false });
    // The alias never fast-forwards: the only head it can produce is the primitive's commit.
    expect(result.movedRepairHead).toEqual({ from: queue.repairHead, to: NEW_HEAD });
  });

  describe('R6 admission pre-check wiring (P-006)', () => {
    const dryRuns = () => mocks.admit.mock.calls.map((c) => (c[0] as { dryRun: boolean }).dryRun);
    const queueWithoutPrecheck = () => ({ ...queue, admissionPrecheck: undefined });

    it('WI-8351 runs the built gitlink population before publication and refuses a paired helper red', async () => {
      const pairedFiles = ['component/paired.test.mjs', 'parent.test.mjs'];
      const gitlinkQueue = { ...queueWithoutPrecheck(), signature: [{ kind: 'workspace-task' as const, id: 'component::test' }] };
      mocks.readState.mockResolvedValue({ status: 'value', queue: gitlinkQueue });
      mocks.hunkExact.mockReturnValue(hunkExactOf(['component']));
      mocks.admit.mockReturnValue(admissionOf(false, ['component']));
      mocks.population.mockImplementation((input) => ({ ok: true,
        population: precheckPopulation({ ...input, affectedTestFiles: pairedFiles }) }));
      mocks.precheckFactory.mockReturnValue(async ({ commit, files }: { commit: string; files: readonly string[] }) => ({
        ran: true as const, commit, results: files.map((path) => ({ path, status: path.startsWith('component/') ? 'fail' : 'pass' })),
      }));
      const started = body(await tool.handler({ op: 'admit', paths: ['component'], confirm: true } as never, { role: 'su' } as never));
      expect(started).toMatchObject({ pending: true, precheckOperation: { builtCommit: NEW_HEAD, files: pairedFiles } });
      expect(mocks.population).toHaveBeenCalledWith({ root: '/repo', commit: NEW_HEAD, signature: gitlinkQueue.signature, admittedPaths: ['component'] });
      expect(dryRuns()).toEqual([true]);
      const settled = await settledPrecheckQueue();
      expect(settled.admissionPrecheck).toMatchObject({ status: 'failed', verdict: {
        code: 'admission-imports-red', importedRed: ['component/paired.test.mjs'], population: { canProveDoesNotFix: false },
      } });
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const refused = body(await tool.handler({ op: 'admit', paths: ['component'], confirm: true } as never, { role: 'su' } as never));
      expect(refused).toMatchObject({ admitted: false, refused: true, reason: 'admission-imports-red' });
      expect(dryRuns().every((dry) => dry === true)).toBe(true);
    });

    it('WI-8351 refuses unknown immutable inventory before launching or publishing', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      mocks.hunkExact.mockReturnValue(hunkExactOf(['component']));
      mocks.admit.mockReturnValue(admissionOf(false, ['component']));
      mocks.population.mockReturnValue({ ok: false, detail: 'pinned component object unavailable' });
      const result = body(await tool.handler({ op: 'admit', paths: ['component'], confirm: true } as never, { role: 'su' } as never));
      expect(result).toMatchObject({ refused: true, reason: 'admission-precheck-unavailable', builtCommit: NEW_HEAD });
      expect(mocks.startPrecheckWorker).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
      expect(dryRuns()).toEqual([true]);
    });
    const settledPrecheckQueue = async () => {
      await drainDetached();
      const transitionResult = mocks.transition.mock.results.at(-1)?.value as
        | Promise<{ queue: typeof queue }>
        | undefined;
      if (!transitionResult) throw new Error('expected detached pre-check settlement');
      return (await transitionResult).queue;
    };

    it('settles a dead host-generation runner as failed on get instead of advertising a live pre-check', async () => {
      const pending = {
        ...queueWithoutPrecheck(),
        admissionPrecheck: {
          ...queue.admissionPrecheck,
          status: 'running' as const,
          verdict: undefined,
          runnerPid: 999_999_999,
          runnerPidIdentity: 'old-boot:123',
          startedAtMs: Date.now() - 1000,
          expiresAtMs: Date.now() + 60_000,
        },
      };
      let persisted: FrozenCandidateRepairQueue = pending;
      mocks.readState.mockImplementation(async () => ({ status: 'value', queue: persisted }));
      mocks.transition.mockImplementation(async (_target, transition) => {
        persisted = transition(persisted);
        return { status: 'written', queue: persisted, fresh: persisted, retries: 0 };
      });
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never)) as {
        repairQueue: { admissionPrecheck: { status: string; verdict: { ok: boolean; detail: string } } };
      };
      expect(result.repairQueue.admissionPrecheck).toMatchObject({
        status: 'failed',
        verdict: { ok: false, detail: expect.stringContaining('host process 999999999 ended or was replaced') },
      });
      expect(persisted.dispatchReservation).toBeUndefined();
      expect(mocks.transition).toHaveBeenCalledTimes(1);
    });

    it('does not falsely fail a legacy running marker without a process identity', async () => {
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: {
          ...queueWithoutPrecheck(),
          admissionPrecheck: {
            ...queue.admissionPrecheck,
            status: 'running',
            verdict: undefined,
            expiresAtMs: Date.now() + 60_000,
          },
        },
      });
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never)) as {
        repairQueue: { admissionPrecheck: { status: string } };
      };
      expect(result.repairQueue.admissionPrecheck.status).toBe('running');
      expect(mocks.transition).not.toHaveBeenCalled();
    });

    it('distinguishes a recycled live PID from its recorded process start', async () => {
      const liveIdentity = checkpointPidIdentity(process.pid);
      expect(liveIdentity).not.toBeNull();
      let persisted: FrozenCandidateRepairQueue = {
        ...queueWithoutPrecheck(),
        admissionPrecheck: {
          ...queue.admissionPrecheck,
          status: 'running',
          verdict: undefined,
          runnerPid: process.pid,
          runnerPidIdentity: `${liveIdentity}-recycled`,
          expiresAtMs: Date.now() + 60_000,
        },
      };
      mocks.readState.mockImplementation(async () => ({ status: 'value', queue: persisted }));
      mocks.transition.mockImplementation(async (_target, transition) => {
        persisted = transition(persisted);
        return { status: 'written', queue: persisted, fresh: persisted, retries: 0 };
      });
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never)) as {
        repairQueue: { admissionPrecheck: { status: string } };
      };
      expect(result.repairQueue.admissionPrecheck.status).toBe('failed');
      expect(mocks.transition).toHaveBeenCalledTimes(1);
    });

    it('keeps a live managed task running across host identity replacement and returns its persisted progress', async () => {
      const liveIdentity = checkpointPidIdentity(process.pid);
      expect(liveIdentity).not.toBeNull();
      const updatedAtMs = Date.now() - 100;
      const pending: FrozenCandidateRepairQueue = {
        ...queueWithoutPrecheck(),
        updatedAtMs,
        admissionPrecheck: {
          ...queue.admissionPrecheck,
          status: 'running',
          verdict: undefined,
          runnerPid: process.pid,
          runnerPidIdentity: `${liveIdentity}-replaced`,
          runnerTaskId: 'managed-task-live',
          startedAtMs: updatedAtMs - 1000,
          updatedAtMs,
          expiresAtMs: Date.now() + 60_000,
          currentFile: 'lib/red.test.ts',
          completedCount: 1,
          totalCount: 1,
          heartbeatAtMs: updatedAtMs,
        },
      };
      mocks.getTask.mockResolvedValue({ state: 'running', confined: true });
      mocks.readState.mockResolvedValue({ status: 'value', queue: pending });

      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never)) as {
        repairQueue: { admissionPrecheck: { status: string; currentFile: string; completedCount: number; heartbeatAtMs: number } };
      };

      expect(mocks.getTask).toHaveBeenCalledWith('managed-task-live');
      expect(result.repairQueue.admissionPrecheck).toMatchObject({
        operationId: queue.admissionPrecheck.operationId,
        runnerTaskId: 'managed-task-live',
        status: 'running',
        currentFile: 'lib/red.test.ts',
        completedCount: 1,
        heartbeatAtMs: updatedAtMs,
      });
      expect(mocks.transition).not.toHaveBeenCalled();
    });

    it('a live pre-check serializes the queue: another confirmed admission returns the same handle without building or launching', async () => {
      const pending = {
        ...queueWithoutPrecheck(),
        admissionPrecheck: {
          ...queue.admissionPrecheck,
          status: 'running' as const,
          verdict: undefined,
          expiresAtMs: Date.now() + 60_000,
        },
      };
      mocks.readState.mockResolvedValue({ status: 'value', queue: pending });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/other.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { operationId: 'repair-precheck-fixture', status: 'running' },
      });
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.precheckFactory).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('an expired running pre-check is replaced by one fresh operation instead of wedging the queue', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const expiredOperationId = 'repair-precheck-expired';
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: {
          ...queueWithoutPrecheck(),
          admissionPrecheck: {
            ...queue.admissionPrecheck,
            operationId: expiredOperationId,
            status: 'running' as const,
            verdict: undefined,
            expiresAtMs: Date.now() - 1,
          },
        },
      });

      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD },
      });
      expect(result.precheckOperation.operationId).not.toBe(expiredOperationId);
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      expect(mocks.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          admissionPrecheck: expect.objectContaining({ operationId: result.precheckOperation.operationId }),
          dispatchReservation: expect.objectContaining({ token: result.precheckOperation.operationId }),
        }),
        expect.anything(),
      );
      await drainDetached();
    });

    it('confirm:true returns after a durable pre-check marker; a later confirmed call publishes only after the stored pass', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      // The serving host's root is a LINKED worktree on :3170; the runner must be created for the
      // main worktree (checkpoint tree, run-lock and setup-release-checkout all key off it).
      mocks.canonicalRoot.mockReturnValue('/canonical');
      const progressSnapshots: Array<{
        currentFile: string;
        completedCount: number;
        totalCount: number;
        heartbeatAtMs: number;
      }> = [];
      const runner = vi.fn(async ({ commit, files, onProgress }: {
        commit: string;
        files: readonly string[];
        onProgress?: (snapshot: {
          currentFile: string;
          completedCount: number;
          totalCount: number;
          heartbeatAtMs: number;
        }) => Promise<void> | void;
      }) => {
        const snapshot = {
          currentFile: files[0] as string,
          completedCount: 0,
          totalCount: files.length,
          heartbeatAtMs: Date.now(),
        };
        await onProgress?.(snapshot);
        progressSnapshots.push(snapshot);
        return {
          ran: true as const,
          commit,
          results: files.map((path) => ({ path, status: 'pass' as const })),
        };
      });
      mocks.precheckFactory.mockReturnValue(runner);
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        builtCommit: NEW_HEAD,
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD, files: ['lib/red.test.ts'] },
      });
      expect(started.completionReceipt).toEqual({
        status: 'recorded',
        effectRef: `release:repair-queue:admit-precheck:${started.precheckOperation.operationId}`,
      });
      expect(dryRuns()).toEqual([true]);
      expect(mocks.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          admissionPrecheck: expect.objectContaining({
            status: 'running',
            currentFile: 'lib/red.test.ts',
            completedCount: 0,
            totalCount: 1,
            heartbeatAtMs: expect.any(Number),
          }),
        }),
        { expectedUpdatedAtMs: queue.updatedAtMs },
      );
      expect(mocks.canonicalRoot).toHaveBeenCalledWith('/repo');
      expect(mocks.startPrecheckWorker).toHaveBeenCalledTimes(1);
      expect(mocks.startPrecheckWorker).toHaveBeenCalledWith(expect.objectContaining({
        operationId: started.precheckOperation.operationId,
        taskId: started.precheckOperation.runnerTaskId,
        queueTarget: { workspaceId: 'ws-1', installSlug: 'papercusp' },
        integrationRoot: '/canonical',
        checkpointRoot: checkpointRootMirror('/canonical'),
        expiresAtMs: started.precheckOperation.expiresAtMs,
      }));
      expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.startPrecheckWorker.mock.invocationCallOrder[0],
      );
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      expect(mocks.precheckFactory).toHaveBeenCalledWith({
        integrationRoot: '/canonical',
        checkpointRoot: checkpointRootMirror('/canonical'),
      });
      expect(runner).toHaveBeenCalledWith({
        commit: NEW_HEAD,
        files: ['lib/red.test.ts'],
        onProgress: expect.any(Function),
      });
      const settled = await settledPrecheckQueue();
      expect(settled.admissionPrecheck).toMatchObject({ status: 'passed', builtCommit: NEW_HEAD });
      expect(progressSnapshots).toEqual([
        { currentFile: 'lib/red.test.ts', completedCount: 0, totalCount: 1, heartbeatAtMs: expect.any(Number) },
      ]);
      const progressTransition = mocks.transition.mock.calls[0]?.[1] as
        | ((fresh: typeof queue) => typeof queue)
        | undefined;
      expect(progressTransition).toEqual(expect.any(Function));
      const pendingMarker = mocks.write.mock.calls[0]?.[1] as typeof queue;
      const progressed = progressTransition!(pendingMarker);
      expect(progressed).toMatchObject({
        admissionPrecheck: {
          operationId: started.precheckOperation.operationId,
          status: 'running',
          currentFile: 'lib/red.test.ts',
          completedCount: 0,
          totalCount: 1,
          heartbeatAtMs: expect.any(Number),
          updatedAtMs: expect.any(Number),
        },
        updatedAtMs: expect.any(Number),
      });
      expect(progressed.updatedAtMs).toBeGreaterThan(pendingMarker.updatedAtMs);
      expect(progressed.admissionPrecheck.updatedAtMs).toBe(progressed.updatedAtMs);
      expect((settled as { dispatchReservation?: unknown }).dispatchReservation).toBeUndefined();
      expect(dryRuns()).toEqual([true]); // the detached leg never publishes
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const published = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(published).toMatchObject({ ok: true, admitted: true, verdict: 'admitted' });
      expect(dryRuns()).toEqual([true, true, false]);
    });

    it('retries a whole-blob pre-check with its persisted source SHA after staging advances', async () => {
      const sourceCommit = 'e'.repeat(40);
      const admissionFromSource = (published: boolean) => {
        const result = admissionOf(published);
        return {
          ...result,
          entry: { ...result.entry, source: { ref: 'staging', sha: sourceCommit } },
        };
      };
      mocks.admit
        .mockReturnValueOnce(admissionFromSource(false))
        .mockReturnValueOnce(admissionFromSource(false))
        .mockReturnValueOnce(admissionFromSource(true));
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const initialArgs = {
        op: 'admit',
        paths: ['lib/red.test.ts'],
        wholeBlob: true,
        reason: 'pin reviewed source commit',
        confirm: true,
      };

      const started = body(await tool.handler(initialArgs as never, { role: 'su' } as never));
      expect(started).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { status: 'running', sourceCommit },
      });
      expect(started.note).toContain(`sourceCommit:'${sourceCommit}'`);

      const settled = await settledPrecheckQueue();
      expect(settled.admissionPrecheck).toMatchObject({ status: 'passed', sourceCommit });
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      mocks.admissionGit
        .mockReturnValueOnce({ status: 0, stdout: `${sourceCommit}\n`, stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

      const published = body(
        await tool.handler(
          {
            ...initialArgs,
            sourceCommit,
            expectedCandidate: settled.candidate,
            expectedRepairHead: settled.repairHead,
            expectedUpdatedAtMs: settled.updatedAtMs,
          } as never,
          { role: 'su' } as never,
        ),
      );

      expect(published).toMatchObject({ ok: true, admitted: true, verdict: 'admitted' });
      expect(dryRuns()).toEqual([true, true, false]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      expect(mocks.admit.mock.calls[1]![0]).toMatchObject({
        source: { ref: sourceCommit, recordAsRef: 'staging' },
        dryRun: true,
      });
      expect(mocks.admit.mock.calls[2]![0]).toMatchObject({
        source: { ref: sourceCommit, recordAsRef: 'staging' },
        dryRun: false,
      });
    });

    it('reuses a passed legacy pre-check when provenance changes the commit id but not its tree', async () => {
      const { builtTree: _builtTree, ...legacyPrecheck } = queue.admissionPrecheck;
      mocks.admit.mockImplementation((input: { dryRun: boolean; paths: string[] }) =>
        admissionOf(!input.dryRun, input.paths, ALT_HEAD),
      );
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: { ...queue, admissionPrecheck: legacyPrecheck },
      });

      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        admitted: true,
        verdict: 'admitted',
        movedRepairHead: { from: queue.repairHead, to: ALT_HEAD },
      });
      expect(dryRuns()).toEqual([true, false]);
      expect(mocks.precheckFactory).not.toHaveBeenCalled();
      expect(mocks.admissionGit).toHaveBeenCalledWith(['rev-parse', '--verify', `${NEW_HEAD}^{tree}`], {
        cwd: '/repo',
      });
    });

    it('a stored red measurement refuses on the follow-up and the detached leg never publishes', async () => {
      mocks.admit.mockReturnValue(admissionOf(false));
      mocks.precheckFactory.mockReturnValue(
        async ({ commit, files }: { commit: string; files: readonly string[] }) => ({
          ran: true as const,
          commit,
          results: files.map((path) => ({ path, status: 'fail' as const })),
        }),
      );
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({ ok: true, admitted: false, verdict: 'precheck-running' });
      const settled = await settledPrecheckQueue();
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({ ok: false, refused: true, admitted: false, builtCommit: NEW_HEAD });
      expect(result.reason).toMatch(/^admission-(does-not-fix|imports-red)$/);
      expect(dryRuns()).toEqual([true, true]);
    });

    it('a stored runner failure refuses publication; retryPrecheck is the explicit restart route', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.precheckFactory.mockReturnValue(async () => ({
        ran: false as const,
        reason: 'runner-failed' as const,
        detail: 'setup-release-checkout exited 1',
      }));
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({ ok: true, admitted: false, verdict: 'precheck-running' });
      const settled = await settledPrecheckQueue();
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({
        ok: false,
        admitted: false,
        refused: true,
        reason: 'admission-precheck-unavailable',
        builtCommit: NEW_HEAD,
      });
      expect(dryRuns()).toEqual([true, true]);
      expect(JSON.stringify(result.precheck)).toContain('runner-failed');
    });

    it('retryPrecheck:true replaces a matching terminal failure without publishing in that call', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const failedOperationId = 'repair-precheck-failed';
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: {
          ...queueWithoutPrecheck(),
          admissionPrecheck: {
            ...queue.admissionPrecheck,
            operationId: failedOperationId,
            status: 'failed' as const,
            verdict: {
              ok: false as const,
              ran: false as const,
              code: 'admission-precheck-unavailable' as const,
              reason: 'runner-failed' as const,
              detail: 'setup-release-checkout exited 1',
              population: queue.admissionPrecheck.verdict.population,
            },
          },
        },
      });

      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, retryPrecheck: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(result).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD },
      });
      expect(result.precheckOperation.operationId).not.toBe(failedOperationId);
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      await drainDetached();
      expect(dryRuns()).toEqual([true]);
    });

    it('checkpoint-tree-busy settles as the explicit pass-through and publishes loud only on the follow-up', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.precheckFactory.mockReturnValue(async () => ({
        ran: false as const,
        reason: 'checkpoint-tree-busy' as const,
        detail: 'gate run holds the checkpoint tree',
        holder: { pid: 7, elapsedSec: 30 },
      }));
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(started).toMatchObject({ ok: true, admitted: false, verdict: 'precheck-running' });
      const settled = await settledPrecheckQueue();
      expect(settled.admissionPrecheck).toMatchObject({
        status: 'deferred',
        verdict: { ok: true, ran: false, reason: 'checkpoint-tree-busy' },
      });
      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(result).toMatchObject({ ok: true, admitted: true });
      expect(dryRuns()).toEqual([true, true, false]);
      expect(JSON.stringify(result.precheck)).toContain('checkpoint-tree-busy');
    });

    it('retryPrecheck:true refreshes a busy-tree deferral without publishing until the new measured pass', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const deferredOperationId = 'repair-precheck-deferred';
      mocks.readState.mockResolvedValue({
        status: 'value',
        queue: {
          ...queueWithoutPrecheck(),
          admissionPrecheck: {
            ...queue.admissionPrecheck,
            operationId: deferredOperationId,
            status: 'deferred' as const,
            verdict: {
              ok: true as const,
              ran: false as const,
              reason: 'checkpoint-tree-busy' as const,
              detail: 'previous gate run held the checkpoint tree',
              population: queue.admissionPrecheck.verdict.population,
            },
          },
        },
      });

      const started = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, retryPrecheck: true } as never,
          { role: 'su' } as never,
        ),
      );

      expect(started).toMatchObject({
        ok: true,
        admitted: false,
        pending: true,
        verdict: 'precheck-running',
        precheckOperation: { status: 'running', builtCommit: NEW_HEAD },
      });
      expect(started.precheckOperation.operationId).not.toBe(deferredOperationId);
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
      const settled = await settledPrecheckQueue();
      expect(settled.admissionPrecheck).toMatchObject({
        operationId: started.precheckOperation.operationId,
        status: 'passed',
        verdict: { ok: true, ran: true },
      });
      expect(dryRuns()).toEqual([true]);

      mocks.readState.mockResolvedValue({ status: 'value', queue: settled });
      const published = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, retryPrecheck: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(published).toMatchObject({ ok: true, admitted: true, precheck: { ran: true } });
      expect(dryRuns()).toEqual([true, true, false]);
      expect(mocks.precheckFactory).toHaveBeenCalledTimes(1);
    });

    it('a dry run never creates the runner', async () => {
      mocks.admit.mockReturnValue(admissionOf(false));
      body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never));
      expect(dryRuns()).toEqual([true]);
      expect(mocks.precheckFactory).not.toHaveBeenCalled();
    });

    // EI-23408302754355167: the `skipPrecheck` + `precheckReason` opt-out was the ONE arm of the
    // R6 pre-check policy with zero coverage repo-wide. It is the deliberate escape from "an
    // unmeasured result never counts as passing" (D-002), so it is precisely the arm that needs
    // pinning: an un-reasoned skip must REFUSE, and a reasoned one must be LEDGERED — an opt-out
    // that published silently would leave no record of who declined measurement, or why.
    describe('the skipPrecheck opt-out arm', () => {
      it('REFUSES an un-reasoned skip, measuring nothing and publishing nothing', async () => {
        mocks.admit.mockReturnValue(admissionOf(true));
        mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
        const result = body(
          await tool.handler(
            { op: 'admit', paths: ['lib/red.test.ts'], confirm: true, skipPrecheck: true } as never,
            { role: 'su' } as never,
          ),
        );
        expect(result).toMatchObject({
          ok: false,
          admitted: false,
          refused: true,
          verdict: 'refused',
          reason: 'precheck-reason-required',
        });
        // The guard sits BEFORE the build: no admission is constructed, nothing is written, and
        // no runner is created. A refusal that had already built would leave a commit behind.
        expect(mocks.admit).not.toHaveBeenCalled();
        expect(mocks.write).not.toHaveBeenCalled();
        expect(mocks.precheckFactory).not.toHaveBeenCalled();
      });

      it('holds the 8-char reason floor against whitespace padding', async () => {
        mocks.admit.mockReturnValue(admissionOf(true));
        mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
        // The handler TRIMS before measuring, so spaces cannot pad a 5-char reason past the floor.
        const result = body(
          await tool.handler(
            {
              op: 'admit',
              paths: ['lib/red.test.ts'],
              confirm: true,
              skipPrecheck: true,
              precheckReason: '      short      ',
            } as never,
            { role: 'su' } as never,
          ),
        );
        expect(result).toMatchObject({ refused: true, reason: 'precheck-reason-required' });
        expect(mocks.write).not.toHaveBeenCalled();
      });

      // Defence in depth: the arg schema rejects a short reason before the handler's own guard
      // ever runs. Both layers are asserted because the handler is reachable directly (as every
      // test in this file reaches it), so the zod floor alone would not pin the behaviour.
      it('rejects a sub-floor reason at the args schema too', () => {
        const admit = { op: 'admit', paths: ['lib/red.test.ts'], skipPrecheck: true };
        expect(tool.args.safeParse({ ...admit, precheckReason: '1234567' }).success).toBe(false);
        expect(tool.args.safeParse({ ...admit, precheckReason: '12345678' }).success).toBe(true);
      });

      it('a reasoned skip publishes WITHOUT measuring, and ledgers the opt-out with its reason', async () => {
        mocks.admit.mockReturnValue(admissionOf(true));
        mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithoutPrecheck() });
        const precheckReason = 'deliberate wide admission: shared lint config, measured by the re-judge';
        const result = body(
          await tool.handler(
            {
              op: 'admit',
              paths: ['lib/red.test.ts'],
              confirm: true,
              skipPrecheck: true,
              precheckReason,
            } as never,
            { role: 'su' } as never,
          ),
        );
        expect(result).toMatchObject({ ok: true, admitted: true, verdict: 'admitted' });
        // The whole point of the opt-out: the built commit is never measured.
        expect(mocks.precheckFactory).not.toHaveBeenCalled();
        // ...and the skip is RECORDED on the ledger entry, so the audit trail carries who
        // declined measurement and why, rather than an entry indistinguishable from a pass.
        const [, written] = mocks.write.mock.calls[0]!;
        expect(written).toMatchObject({
          repairHead: NEW_HEAD,
          admissions: [
            expect.objectContaining({
              precheck: expect.objectContaining({ ran: false, reason: 'skipped', precheckReason }),
            }),
          ],
        });
        // The same record rides the result, so the caller sees the skip it asked for.
        expect(result.precheck).toMatchObject({ ran: false, reason: 'skipped', precheckReason });
      });
    });
  });

  // EI-22208176411693669: assessFrozenRepairFixerAuthorization correctly labels the
  // SU-bearer transport 'not-applicable' (never 'authorized-delegate') because that
  // transport carries no verified per-spawn signature regardless of its cosmetic
  // ?role= catalog hint. But the admit write-gate is a SEPARATE `if` a few lines
  // below callerAuthorization, and before this fix it independently required
  // role==='su' OR an OPERATOR_CONFIG_WRITE_ROLE OR authorized===true — none of which
  // a superuser caller whose ?role= was forwarded as 'release-fixer' satisfied — so it
  // was thrown out even though dispatch on that transport is already unconditional.
  // This pins that the write-gate itself, not just the label, bypasses.
  it('EI-22208176411693669: an isSuperuser caller may admit even when its cosmetic role hint is release-fixer', async () => {
    mocks.admit.mockReturnValue(admissionOf(true));
    const result = body(
      await tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
        {
          role: 'release-fixer',
          isSuperuser: true,
          spawnId: 'fixer-1',
          sigVerifiedSpawn: false,
        } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, admitted: true, persisted: true });
    expect(result.callerAuthorization).toMatchObject({ status: 'not-applicable', authorized: null });
    expect(result.callerAuthorization.safeAction).toContain('PAPERCUSP_SID');
    expect(result.callerAuthorization.safeAction).not.toContain('PAPERCUSP_SPAWN_ID');
    expect(mocks.write).toHaveBeenCalled();
  });

  // Control for the test above: a non-superuser release-fixer that is NOT the
  // queue-delegated fixer must still be refused. This is what proves the fix bypasses
  // on isSuperuser specifically, rather than having widened the gate for every
  // release-fixer-labelled caller.
  it('control: a non-superuser caller with an unverified or mismatched release-fixer identity is still refused admission', async () => {
    await expect(
      tool.handler(
        { op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never,
        {
          role: 'release-fixer',
          isSuperuser: false,
          spawnId: 'fixer-2',
          sigVerifiedSpawn: true,
        } as never,
      ),
    ).rejects.toThrow(/requires an operator-config write role, su/);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('refuses retirement while the fixer is live', async () => {
    mocks.alive.mockResolvedValue(true);
    const result = body(
      await tool.handler(
        {
          op: 'retire',
          expectedCandidate: queue.candidate,
          expectedRepairHead: queue.repairHead,
          expectedUpdatedAtMs: queue.updatedAtMs,
          reason: 'terminal incident cleanup',
          confirm: true,
        } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: true, reason: 'live-fixer' });
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it('is dry-run by default and executes only the exact inspected queue with confirm:true', async () => {
    const args = {
      op: 'retire',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
      reason: 'terminal incident cleanup',
    } as const;
    expect(body(await tool.handler(args as never, { role: 'su' } as never))).toMatchObject({
      ok: true,
      dryRun: true,
      retired: false,
    });
    expect(mocks.retire).not.toHaveBeenCalled();

    const result = body(await tool.handler({ ...args, confirm: true } as never, { role: 'su' } as never));
    expect(mocks.retire).toHaveBeenCalledWith({ workspaceId: 'ws-1', installSlug: 'papercusp' }, queue);
    expect(result).toMatchObject({ ok: true, retired: true, auditRecorded: true });
  });

  it('emits exact-SHA inconclusive terminals after retiring an unjudged repairHead', async () => {
    const result = body(await tool.handler({
      op: 'retire',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
      reason: 'terminal incident cleanup',
      confirm: true,
    } as never, { role: 'su' } as never)) as {
      retired?: boolean;
      inconclusiveTerminal?: { status: string; sha: string; emittedKeys: string[]; failedKeys: string[] };
    };

    expect(result.retired).toBe(true);
    expect(mocks.retire).toHaveBeenCalledTimes(1);
    expect(mocks.emitAwaitedEvent).toHaveBeenCalledTimes(2);
    expect(mocks.retire.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emitAwaitedEvent.mock.invocationCallOrder[0],
    );
    expect(mocks.emitAwaitedEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      key: 'green-checkpoint:inconclusive',
      payload: expect.objectContaining({
        sha: queue.repairHead,
        from: queue.candidate,
        pipeline: 'papercusp',
        reason: 'repair-queue-retired-before-verification',
      }),
      source: 'release:repair-queue-retire',
    }));
    expect(mocks.emitAwaitedEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      key: 'green-checkpoint:inconclusive:papercusp',
      payload: expect.objectContaining({ sha: queue.repairHead }),
    }));
    expect(result.inconclusiveTerminal).toEqual({
      status: 'emitted',
      sha: queue.repairHead,
      emittedKeys: ['green-checkpoint:inconclusive', 'green-checkpoint:inconclusive:papercusp'],
      failedKeys: [],
    });
  });

  it('does not emit inconclusive when a successfully retired repairHead already has a red verdict', async () => {
    const judgedQueue = {
      ...queue,
      convergenceRounds: [{ round: 1, head: queue.repairHead, failingCount: 1, atMs: 3 }],
    };
    mocks.readState.mockResolvedValue({ status: 'value', queue: judgedQueue as typeof queue });

    const result = body(await tool.handler({
      op: 'retire',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
      reason: 'terminal incident cleanup',
      confirm: true,
    } as never, { role: 'su' } as never)) as { retired?: boolean; inconclusiveTerminal?: unknown };

    expect(result.retired).toBe(true);
    expect(result.inconclusiveTerminal).toBeUndefined();
    expect(mocks.emitAwaitedEvent).not.toHaveBeenCalled();
  });

  // WI-1105109 [owner 2026-08-30, OWNER-interactive]: "How can we make sure another
  // agent uses the frozen candidate system next and doesn't retire it like you did."
  //
  // The recorded failure was NOT the retire — that one was provably correct. It was
  // firing release:checkpoint-run twice immediately AFTER it, each cutting a fresh
  // candidate at tip: the re-cut-at-tip treadmill D-007 diagnosed, reintroduced by hand
  // moments after clearing the thing that prevents it. `notWhen` already forbids this,
  // but guidance is read BEFORE the call while the mistake happens AFTER it — so the
  // procedure has to ride on the RESULT the caller is holding when they pick their next
  // move. This pins that it does.
  it('states the post-retire procedure on a SUCCESSFUL retire, and only then (WI-1105109)', async () => {
    const args = {
      op: 'retire',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
      reason: 'terminal incident cleanup',
    } as const;

    const retired = body(await tool.handler({ ...args, confirm: true } as never, { role: 'su' } as never)) as {
      retired?: boolean;
      completionReceipt?: {
        status: 'recorded' | 'not-recorded' | 'recovery-incomplete';
        effectRef?: string;
      };
      nextStep?: string;
    };
    expect(retired.retired).toBe(true);
    expect(retired.completionReceipt).toEqual({
      status: 'recorded',
      effectRef: 'release:repair-queue:retire:test-repair-queue-receipt',
    });
    expect(
      retired.nextStep,
      'a successful retire must carry the next-step procedure, not leave it to guidance',
    ).toEqual(expect.any(String));
    // The two facts that actually prevent the treadmill: the gate re-freezes by itself,
    // and checkpoint-run is NOT the lever to restart it.
    expect(retired.nextStep).toMatch(/re-?freez/i);
    expect(retired.nextStep).toMatch(/release:checkpoint-run/);
    expect(retired.nextStep).toMatch(/op: "admit"/);

    // CONTROL — the assertions above are all "field is present and matches", so they
    // would pass just as well if `nextStep` were emitted unconditionally on every
    // branch, which would make it noise rather than a signal about what just happened.
    // A dry run retires NOTHING, so it must NOT claim a post-retire procedure.
    const dryRun = body(await tool.handler(args as never, { role: 'su' } as never)) as {
      retired?: boolean;
      nextStep?: string;
    };
    expect(dryRun.retired).toBe(false);
    expect(dryRun.nextStep, 'control: nothing was retired, so there is no post-retire step to state').toBeUndefined();
  });

  it('refuses a stale caller identity before the storage CAS', async () => {
    const result = body(
      await tool.handler(
        {
          op: 'retire',
          expectedCandidate: queue.candidate,
          expectedRepairHead: 'd'.repeat(40),
          expectedUpdatedAtMs: queue.updatedAtMs,
          reason: 'terminal incident cleanup',
          confirm: true,
        } as never,
        { role: 'su' } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, reason: 'exact_queue_identity_mismatch' });
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it('rechecks replacement fixer liveness after a CAS miss before rendering its diagnostic', async () => {
    const replacement = { ...queue, fixerSpawnId: 'fixer-2', updatedAtMs: 3 };
    mocks.retire.mockResolvedValueOnce({ retired: false, current: replacement });
    mocks.alive.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    const result = body(
      await tool.handler(
        {
          op: 'retire',
          expectedCandidate: queue.candidate,
          expectedRepairHead: queue.repairHead,
          expectedUpdatedAtMs: queue.updatedAtMs,
          reason: 'terminal incident cleanup',
          confirm: true,
        } as never,
        { role: 'su' } as never,
      ),
    );

    expect(mocks.alive).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      casMiss: true,
      reason: 'cas-miss',
      current: {
        fixerSpawnId: 'fixer-2',
        fixerAlive: false,
        retireAllowed: true,
        retireRefusal: null,
      },
    });
  });

  it('fails closed when a replacement fixer becomes liveness-unknown after the preflight proves the old fixer dead', async () => {
    const replacement = { ...queue, fixerSpawnId: 'fixer-2', updatedAtMs: 3 };
    mocks.retire.mockResolvedValueOnce({ retired: false, current: replacement });
    // The first read authorizes the attempted retirement of the old dead fixer. The second read
    // observes a replacement whose liveness is unavailable; that must remain a refusal, never a
    // retry or an inferred death.
    mocks.alive.mockResolvedValueOnce(false).mockResolvedValueOnce(null);

    const result = body(
      await tool.handler(
        {
          op: 'retire',
          expectedCandidate: queue.candidate,
          expectedRepairHead: queue.repairHead,
          expectedUpdatedAtMs: queue.updatedAtMs,
          reason: 'terminal incident cleanup',
          confirm: true,
        } as never,
        { role: 'su' } as never,
      ),
    );

    expect(mocks.retire).toHaveBeenCalledTimes(1);
    expect(mocks.alive).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      casMiss: true,
      reason: 'cas-miss',
      current: {
        fixerSpawnId: 'fixer-2',
        fixerAlive: null,
        retireAllowed: false,
        retireRefusal: 'liveness-unknown',
      },
    });
  });

  // P-021 (D-007 #1): the repair manifest rides on get, and claim-leg takes one row of it.
  describe('claim-leg (P-021 repair manifest)', () => {
    it('get renders the manifest rows + summary when the queue carries one', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
      expect(result.repairQueue.manifest).toMatchObject({
        candidate: queue.candidate,
        rows: [{ legId: manifestRow.legId }],
      });
      expect(result.repairQueue.manifestSummary).toEqual({
        legs: 1,
        red: 1,
        admitted: 0,
        green: 0,
        claimed: 0,
        pathless: 0,
      });
    });

    it('claims the leg: persists the claim on the queue row, sets presence current_files to its paths, audits, returns the admit command', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      const result = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(mocks.write).toHaveBeenCalledTimes(1);
      const [target, written] = mocks.write.mock.calls[0]!;
      expect(target).toEqual({ workspaceId: 'ws-1', installSlug: 'papercusp' });
      expect(written).toMatchObject({
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        manifest: { rows: [{ legId: manifestRow.legId, claim: { actor: 'su-test' } }] },
      });
      // Claiming a leg claims its paths: presence current_files = the leg's subject paths.
      expect(mocks.presence).toHaveBeenCalledTimes(1);
      expect(mocks.presence.mock.calls[0]![1]).toEqual({ currentFiles: ['lib/red.test.ts'] });
      expect(result).toMatchObject({
        ok: true,
        op: 'claim-leg',
        claimed: true,
        released: false,
        verdict: 'claimed',
        persisted: true,
        auditRecorded: true,
        completionReceipt: {
          status: 'recorded',
          effectRef: 'release:repair-queue:claim-leg:test-repair-queue-receipt',
        },
        paths: ['lib/red.test.ts'],
        presenceFiles: ['lib/red.test.ts'],
        admitCommand: manifestRow.admitCommand,
        row: { legId: manifestRow.legId, claim: { actor: 'su-test' } },
        repairQueue: { manifestSummary: { claimed: 1 } },
      });
      expect(result.nextAction).toContain(manifestRow.admitCommand);
      expect(result.nextAction).toMatch(/Do NOT fire release:checkpoint-run/);
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails).toMatchObject({
        op: 'claim-leg',
        leg: manifestRow.legId,
        paths: ['lib/red.test.ts'],
        persisted: true,
      });
    });

    it('release:true hands the leg back (holder only) and does not touch presence', async () => {
      const held = { ...manifest, rows: [{ ...manifestRow, claim: { actor: 'su-test', atMs: 7 } }] };
      mocks.readState.mockResolvedValue({ status: 'value', queue: { ...queue, manifest: held } });
      const result = body(
        await tool.handler(
          { op: 'claim-leg', leg: manifestRow.legId, release: true } as never,
          { role: 'su' } as never,
        ),
      );
      expect(mocks.write.mock.calls[0]![1]).toMatchObject({
        manifest: { rows: [{ legId: manifestRow.legId, claim: null }] },
      });
      expect(mocks.presence).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, claimed: false, released: true, verdict: 'released', persisted: true });
    });

    it('never contests a live claim: a leg held by another actor is refused with the holder named, and nothing is written', async () => {
      const held = { ...manifest, rows: [{ ...manifestRow, claim: { actor: 'su-other', atMs: 7 } }] };
      mocks.readState.mockResolvedValue({ status: 'value', queue: { ...queue, manifest: held } });
      const result = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.presence).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        claimed: false,
        refused: true,
        reason: 'held-by-other',
        holder: { actor: 'su-other' },
      });
    });

    it('refuses an unknown leg id and lists the legs the manifest names', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      const result = body(await tool.handler({ op: 'claim-leg', leg: 'nope' } as never, { role: 'su' } as never));
      expect(mocks.write).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, refused: true, reason: 'no-such-leg', legIds: [manifestRow.legId] });
    });

    it('refuses no-manifest when the queue has not been re-derived yet, and no-frozen-queue when nothing is frozen', async () => {
      const noManifest = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(noManifest).toMatchObject({ ok: false, refused: true, reason: 'no-manifest' });
      mocks.readState.mockResolvedValue({ status: 'absent' });
      const none = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(none).toMatchObject({ ok: true, claimed: false, verdict: 'no-frozen-queue' });
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('a queue-row write failure reports persist_failed and leaves presence untouched', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      mocks.write.mockRejectedValueOnce(new Error('pg down'));
      const result = body(
        await tool.handler({ op: 'claim-leg', leg: manifestRow.legId } as never, { role: 'su' } as never),
      );
      expect(mocks.presence).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: false,
        claimed: false,
        persisted: false,
        refused: true,
        reason: 'persist_failed',
      });
    });
  });

  describe('record-edit (P-019 edit ledger, D-008 layer 1 — hook plumbing)', () => {
    const hunk = { kind: 'edit', old: 'a', new: 'b' };
    const ctx = { role: 'su' } as never;

    it('records the hunk under the LIVE queue candidate, attributed to the caller identity, reports the radius + admit command, and never touches the queue row or git', async () => {
      mocks.readState.mockResolvedValue({ status: 'value', queue: queueWithManifest });
      mocks.audit.mockResolvedValueOnce([{ id: 42 }]);
      const result = body(
        await tool.handler(
          {
            op: 'record-edit',
            path: './lib/red.test.ts',
            hunk,
            toolUseId: 'toolu_1',
            editIndex: 0,
            atMs: 777,
            candidate: 'f'.repeat(40),
          } as never,
          ctx,
        ),
      );
      expect(result).toMatchObject({
        ok: true,
        op: 'record-edit',
        recorded: true,
        inserted: true,
        completionReceipt: { status: 'recorded', effectRef: 'release:repair-queue:record-edit:42' },
        oversize: false,
        ledgerId: 42,
        path: 'lib/red.test.ts',
        agent: 'su-test',
        candidate: queue.candidate,
        judgedSha: queue.repairHead,
        inRepairRadius: true,
        // The hook's marker named a different candidate: reported, never trusted over the queue.
        candidateMismatch: { marker: 'f'.repeat(40), queue: queue.candidate },
      });
      expect(result.admitCommand).toContain('admit');
      expect(result.admitCommand).toContain('lib/red.test.ts');
      const [sqlText, params] = mocks.audit.mock.calls[0]! as [string, unknown[]];
      expect(sqlText).toContain('INSERT INTO harness_shared.frozen_repair_edit_ledger');
      expect(params).toEqual(
        expect.arrayContaining(['ws-1', 'papercusp', queue.candidate, 'su-test', 'lib/red.test.ts', 'toolu_1', 777]),
      );
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('a path OUTSIDE the repair radius is still recorded — the source fix is as attributable as the failing test — and flagged inRepairRadius:false', async () => {
      mocks.audit.mockResolvedValueOnce([{ id: 1 }]);
      const result = body(
        await tool.handler({ op: 'record-edit', path: 'lib/src.ts', hunk: { kind: 'write', body: 'x' } } as never, ctx),
      );
      expect(result).toMatchObject({
        ok: true,
        recorded: true,
        inserted: true,
        inRepairRadius: false,
        path: 'lib/src.ts',
      });
      expect(result.candidateMismatch).toBeUndefined();
    });

    it('an idempotent retry (same agent/path/toolUseId/editIndex) inserts nothing: recorded:true, inserted:false', async () => {
      mocks.audit.mockResolvedValueOnce([]);
      const result = body(
        await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk, toolUseId: 'toolu_1' } as never, ctx),
      );
      expect(result).toMatchObject({ ok: true, recorded: true, inserted: false });
    });

    it('nothing frozen ⇒ recorded:false with no-frozen-queue, and NO SQL — there is no lineage to attribute to', async () => {
      mocks.readState.mockResolvedValue({ status: 'absent' });
      const result = body(await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk } as never, ctx));
      expect(result).toMatchObject({ ok: true, op: 'record-edit', recorded: false, verdict: 'no-frozen-queue' });
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('a malformed hunk or a path that escapes the repo is refused without SQL', async () => {
      const bad = body(
        await tool.handler(
          { op: 'record-edit', path: 'lib/red.test.ts', hunk: { kind: 'patch', text: '...' } } as never,
          ctx,
        ),
      );
      expect(bad).toMatchObject({ ok: false, recorded: false, refused: true, reason: 'invalid-hunk' });
      const escape = body(await tool.handler({ op: 'record-edit', path: '../../etc/passwd', hunk } as never, ctx));
      expect(escape).toMatchObject({ ok: false, recorded: false, refused: true, reason: 'invalid-path' });
      expect(mocks.audit).not.toHaveBeenCalled();
    });

    it('a database failure is persist_failed, ok:false — the hook then tells the agent its hunks were NOT recorded', async () => {
      mocks.audit.mockRejectedValueOnce(new Error('pg down'));
      const result = body(await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk } as never, ctx));
      expect(result).toMatchObject({ ok: false, recorded: false, refused: true, reason: 'persist_failed' });
    });

    it('an unreadable queue row refuses with op:record-edit / recorded:false (P-025: unreadable is not absent)', async () => {
      mocks.readState.mockResolvedValue({ status: 'unreadable', reason: 'schema-newer', schemaVersion: 99 });
      const result = body(await tool.handler({ op: 'record-edit', path: 'lib/red.test.ts', hunk } as never, ctx));
      expect(result).toMatchObject({
        ok: false,
        op: 'record-edit',
        recorded: false,
        refused: true,
        reason: 'repair-queue-unreadable',
      });
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  });

  describe('P-020 hunk-exact admission (D-008 layers 2–3)', () => {
    const ctx = { role: 'su' } as never;
    type Written = { admissions: Array<Record<string, unknown>> };
    const patch = { commit: 'e'.repeat(40), parent: 'f'.repeat(40), sha256: '1'.repeat(64) };
    const patchArgs = {
      op: 'admit',
      paths: ['lib/red.test.ts'],
      patchCommit: patch.commit,
      reason: 'reviewed missing hook capture',
      expectedCandidate: queue.candidate,
      expectedRepairHead: queue.repairHead,
      expectedUpdatedAtMs: queue.updatedAtMs,
    };

    it('committed patch requires reason and excludes the other source modes, in schema AND direct handler', async () => {
      expect(tool.args.safeParse(patchArgs).success).toBe(true);
      expect(tool.args.safeParse({ ...patchArgs, op: 'converge' }).success).toBe(true);
      for (const extra of [
        { reason: undefined },
        { wholeBlob: true },
        { sourceCommit: '1'.repeat(40) },
        { includeHunksFrom: [] },
        { ledgerRowIds: [41] },
      ]) {
        const args = { ...patchArgs, ...extra };
        expect(tool.args.safeParse(args).success).toBe(false);
        expect(body(await tool.handler(args as never, ctx))).toMatchObject({
          ok: false,
          reason: 'invalid-patch-source',
        });
      }
      expect(mocks.committedPatch).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'committed patch confirm=%s retains path preflight, preview/CAS and durable provenance without hook attribution',
      async (confirm) => {
        mocks.committedPatch.mockReturnValue({ ok: true, sourceCommit: HX_SOURCE, tree: 'a'.repeat(40), patch });
        mocks.admit.mockReturnValue(admissionOf(confirm));
        // A missing/unavailable ledger cannot be invented or mislabeled as proof.
        mocks.ledger.mockRejectedValueOnce(new Error('ledger unavailable'));
        const result = body(await tool.handler({ ...patchArgs, confirm } as never, ctx));
        expect(result).toMatchObject({ ok: true, admitted: confirm, mode: 'committed-patch', patch });
        expect(result.source).toEqual({ ref: HX_SOURCE, root: '/repo' });
        expect(mocks.hunkExact).not.toHaveBeenCalled();
        expect(mocks.committedPatch).toHaveBeenCalledWith(
          expect.objectContaining({
            root: '/repo',
            repairHead: queue.repairHead,
            integrationRef: 'staging',
            patchCommit: patch.commit,
            paths: patchArgs.paths,
          }),
        );
        expect(mocks.admit).toHaveBeenCalledWith(
          expect.objectContaining({
            source: { ref: HX_SOURCE },
            dryRun: !confirm,
            paths: patchArgs.paths,
            preflight: expect.any(Function),
          }),
        );
        if (confirm) {
          expect(mocks.write).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
            expectedUpdatedAtMs: queue.updatedAtMs,
          });
          const entry = (mocks.write.mock.calls[0]![1] as Written).admissions[0];
          expect(entry).toMatchObject({ mode: 'committed-patch', patch });
          expect(entry).not.toHaveProperty('hunks');
          expect(entry).not.toHaveProperty('foreignHunksAccepted');
          expect(JSON.parse(mocks.audit.mock.calls[0]![1][5])).toMatchObject({ mode: 'committed-patch', patch });
        } else {
          expect(mocks.write).not.toHaveBeenCalled();
          expect(mocks.audit).not.toHaveBeenCalled();
        }
      },
    );

    it('committed patch refusal and stale queue never publish or write', async () => {
      mocks.committedPatch.mockReturnValue({
        ok: false,
        code: 'patch-conflict',
        detail: 'exact patch conflicts',
        exits: [],
      });
      expect(body(await tool.handler({ ...patchArgs, confirm: true } as never, ctx))).toMatchObject({
        ok: false,
        reason: 'patch-conflict',
      });
      mocks.committedPatch.mockClear();
      expect(
        body(await tool.handler({ ...patchArgs, expectedRepairHead: '0'.repeat(40), confirm: true } as never, ctx)),
      ).toMatchObject({ ok: false, reason: 'exact_queue_identity_mismatch' });
      expect(mocks.committedPatch).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('committed patch keeps import preflight refusals and retracts publication on failed queue CAS', async () => {
      mocks.committedPatch.mockReturnValue({ ok: true, sourceCommit: HX_SOURCE, tree: 'a'.repeat(40), patch });
      mocks.admit.mockReturnValueOnce({ ok: false, code: 'admission-incomplete', detail: 'missing sibling' });
      expect(body(await tool.handler({ ...patchArgs, confirm: true } as never, ctx))).toMatchObject({
        ok: false,
        reason: 'admission-incomplete',
      });
      expect(mocks.write).not.toHaveBeenCalled();
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.write.mockRejectedValueOnce(new Error('queue CAS moved'));
      // WI-10006866 / WI-6554700010009332: a CAS miss retracts only when the FRESH row proves
      // the admission parent. Here it moved to an unrelated head, so the ref is preserved.
      mocks.transition.mockImplementationOnce(async (_target, transition) => {
        const diverged = { ...queue, repairHead: '9'.repeat(40) };
        return { status: 'unchanged', queue: transition(diverged as typeof queue), fresh: diverged, retries: 0 };
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(body(await tool.handler({ ...patchArgs, confirm: true } as never, ctx))).toMatchObject({
        ok: false,
        admitted: false,
        reason: 'persist_failed',
        persistSettlement: expect.stringMatching(/^diverged: /),
        retractionProof: 'head-moved',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/settled against the fresh row as diverged/));
      warn.mockRestore();
      expect(mocks.retract).not.toHaveBeenCalled();
    });

    it('DEFAULT: reads the ledger for the named paths, builds the hunk-exact source for the CALLER, admits FROM that commit, and the ledger entry + audit carry mode + hunks', async () => {
      mocks.admit.mockReturnValue(admissionOf(true));
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, ctx));
      expect(mocks.ledger).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workspaceId: 'ws-1',
          installSlug: 'papercusp',
          candidate: queue.candidate,
          paths: ['lib/red.test.ts'],
        }),
      );
      expect(mocks.hunkExact.mock.calls[0]![0]).toMatchObject({
        root: '/repo',
        candidate: queue.candidate,
        repairHead: queue.repairHead,
        paths: ['lib/red.test.ts'],
        actor: 'su-test',
        includeHunksFrom: [],
      });
      expect(mocks.admit.mock.calls[0]![0]).toMatchObject({ source: { ref: HX_SOURCE } });
      expect(mocks.importPreflight).toHaveBeenCalledWith({ root: '/repo', probeRef: 'staging' });
      expect(result).toMatchObject({
        ok: true,
        admitted: true,
        mode: 'hunk-exact',
        hunkExact: [{ path: 'lib/red.test.ts', applied: 1, agents: ['su-test'], foreignHunksExcluded: 0 }],
      });
      const written = mocks.write.mock.calls[0]![1] as Written;
      expect(written.admissions[0]).toMatchObject({
        mode: 'hunk-exact',
        ledgerRowIds: [41],
        hunks: { 'lib/red.test.ts': { applied: 1, agents: ['su-test'] } },
      });
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails).toMatchObject({ mode: 'hunk-exact', ledgerRowIds: [41], hunks: { 'lib/red.test.ts': { applied: 1 } } });
    });

    it('passes the exact reviewed selection and prior consumed ids independently of publication time', async () => {
      const selectedQueue = { ...queue, admissions: [{ ...admissionOf(true).entry, ledgerRowIds: [40] }] };
      mocks.readState.mockResolvedValue({ status: 'value', queue: selectedQueue });
      mocks.admit.mockReturnValue(admissionOf(false));
      const args = { op: 'admit', paths: ['lib/red.test.ts'], ledgerRowIds: [41] };
      expect(tool.args.safeParse(args).success).toBe(true);
      expect(tool.args.safeParse({ ...args, op: 'converge' }).success).toBe(true);
      await tool.handler(args as never, ctx);
      expect(mocks.readState).toHaveBeenCalled();
      expect(queue).not.toHaveProperty('admissions');
      expect(mocks.hunkExact.mock.calls[0]![0]).toMatchObject({
        ledgerRowIds: [41], consumedLedgerRowIds: [40],
      });
    });

    it('never widens an explicit hunk selection to a whole blob', async () => {
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'],
        ledgerRowIds: [41], wholeBlob: true, reason: 'reviewed whole blob' } as never, ctx));
      expect(result).toMatchObject({ ok: false, reason: 'invalid-ledger-selection' });
      expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('includeHunksFrom is forwarded to the builder verbatim (the explicit widening, D-008 3a)', async () => {
      mocks.admit.mockReturnValue(admissionOf(false));
      await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], includeHunksFrom: [' peer ', ''] } as never, ctx);
      expect(mocks.hunkExact.mock.calls[0]![0]).toMatchObject({ includeHunksFrom: ['peer'] });
    });

    it('a builder refusal (no-ledgered-hunks / hunk-conflict) is surfaced with its exits and the primitive is NEVER called', async () => {
      mocks.hunkExact.mockReturnValue({
        ok: false,
        code: 'no-ledgered-hunks',
        path: 'lib/red.test.ts',
        foreignAgents: ['peer'],
        detail: 'nothing to replay',
        exits: ['includeHunksFrom exit', 'wholeBlob exit'],
      });
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], confirm: true } as never, ctx));
      expect(result).toMatchObject({
        ok: false,
        admitted: false,
        refused: true,
        verdict: 'refused',
        reason: 'no-ledgered-hunks',
        path: 'lib/red.test.ts',
        foreignAgents: ['peer'],
        exits: ['includeHunksFrom exit', 'wholeBlob exit'],
        mode: 'hunk-exact',
      });
      expect(mocks.admit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('a ledger read failure refuses ledger-unavailable rather than silently admitting the whole blob', async () => {
      mocks.ledger.mockRejectedValueOnce(new Error('pg down'));
      const result = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, ctx));
      expect(result).toMatchObject({ ok: false, refused: true, reason: 'ledger-unavailable', mode: 'hunk-exact' });
      expect(mocks.hunkExact).not.toHaveBeenCalled();
      expect(mocks.admit).not.toHaveBeenCalled();
    });

    it('wholeBlob:true REQUIRES a reason; with one it admits from the integration branch and RECORDS the foreign hunks it carries (D-008 3b)', async () => {
      const noReason = body(
        await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'], wholeBlob: true } as never, ctx),
      );
      expect(noReason).toMatchObject({ ok: false, refused: true, reason: 'reason_required', mode: 'whole-blob' });
      expect(mocks.admit).not.toHaveBeenCalled();

      mocks.foreign.mockReturnValue({ count: 2, agents: ['peer'], byPath: { 'lib/red.test.ts': 2 } });
      mocks.admit.mockReturnValue(admissionOf(true));
      const result = body(
        await tool.handler(
          {
            op: 'admit',
            paths: ['lib/red.test.ts'],
            wholeBlob: true,
            reason: 'shared refactor: the peer hunks are part of this fix',
            confirm: true,
          } as never,
          ctx,
        ),
      );
      expect(mocks.hunkExact).not.toHaveBeenCalled();
      expect(mocks.admit.mock.calls[0]![0]).toMatchObject({ source: { ref: 'staging' } });
      expect(result).toMatchObject({
        ok: true,
        admitted: true,
        mode: 'whole-blob',
        foreignHunksAccepted: 2,
        foreignAgents: ['peer'],
        foreignHunksByPath: { 'lib/red.test.ts': 2 },
      });
      const written = mocks.write.mock.calls[0]![1] as Written;
      expect(written.admissions[0]).toMatchObject({
        mode: 'whole-blob',
        foreignHunksAccepted: 2,
        foreignAgents: ['peer'],
      });
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails).toMatchObject({ mode: 'whole-blob', foreignHunksAccepted: 2, foreignAgents: ['peer'] });
    });

    it('a whole-blob admission records the ledger rows its admitted blob carries, so a later hunk-exact admit treats them as consumed (WI-6554700010009991)', async () => {
      const ledgerRow = (id: number, agent: string, hunk: FrozenRepairEditLedgerRow['hunk']): FrozenRepairEditLedgerRow => ({
        id, candidate: 'a'.repeat(40), agent, path: 'lib/red.test.ts', hunk, atMs: 5, toolUseId: `t${id}`, editIndex: 0, workItem: null,
      });
      mocks.ledger.mockResolvedValueOnce([
        ledgerRow(51, 'su-test', { kind: 'edit', old: 'x\n', new: 'x\ny\n', replaceAll: false }),
        ledgerRow(52, 'peer', { kind: 'edit', old: 'a = 1', new: 'a = 2', replaceAll: false }),
        // Edited after the admitted blob was cut: its post-image is absent, so it stays unconsumed.
        ledgerRow(53, 'su-test', { kind: 'edit', old: 'z = 1', new: 'z = 9', replaceAll: false }),
      ]);
      mocks.foreign.mockReturnValue({ count: 1, agents: ['peer'], byPath: { 'lib/red.test.ts': 1 } });
      mocks.admit.mockReturnValue(admissionOf(true));
      mocks.admissionGit.mockImplementation((argv: string[]) =>
        argv[0] === 'cat-file'
          ? { status: 0, stdout: 'x\ny\na = 2\nz = 1\n', stderr: '' }
          : { status: 0, stdout: `${'f'.repeat(40)}\n`, stderr: '' },
      );
      const result = body(
        await tool.handler(
          { op: 'admit', paths: ['lib/red.test.ts'], wholeBlob: true, reason: 'shared refactor reviewed', confirm: true } as never,
          ctx,
        ),
      );
      expect(mocks.admissionGit).toHaveBeenCalledWith(['cat-file', 'blob', 'f'.repeat(40)], { cwd: '/repo' });
      expect(result).toMatchObject({ ok: true, admitted: true, mode: 'whole-blob', ledgerRowIds: [51, 52] });
      const written = mocks.write.mock.calls[0]![1] as Written;
      expect(written.admissions[0]).toMatchObject({ mode: 'whole-blob', ledgerRowIds: [51, 52] });
      expect(JSON.parse(mocks.audit.mock.calls[0]![1][5])).toMatchObject({ mode: 'whole-blob', ledgerRowIds: [51, 52] });
    });

    it('wholeBlob sourceCommit pins the reviewed integration ancestor instead of rereading a moving staging tip', async () => {
      const sourceCommit = '1'.repeat(40);
      expect(
        tool.args.safeParse({
          op: 'admit',
          paths: ['lib/red.test.ts'],
          wholeBlob: true,
          sourceCommit,
          reason: 'pin the reviewed preview',
        }).success,
      ).toBe(true);
      expect(
        tool.args.safeParse({
          op: 'admit',
          paths: ['lib/red.test.ts'],
          sourceCommit,
          reason: 'missing whole blob opt in',
        }).success,
      ).toBe(false);

      mocks.admissionGit
        .mockReturnValueOnce({ status: 0, stdout: `${sourceCommit}\n`, stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
      mocks.admit.mockReturnValue(admissionOf(false));
      const result = body(
        await tool.handler(
          {
            op: 'admit',
            paths: ['lib/red.test.ts'],
            wholeBlob: true,
            sourceCommit,
            reason: 'pin the reviewed preview',
          } as never,
          ctx,
        ),
      );

      expect(mocks.admissionGit.mock.calls).toEqual([
        [['rev-parse', '--verify', `${sourceCommit}^{commit}`], { cwd: '/repo' }],
        [['merge-base', '--is-ancestor', sourceCommit, 'staging'], { cwd: '/repo' }],
      ]);
      expect(mocks.admit).toHaveBeenCalledWith(
        expect.objectContaining({
          source: { ref: sourceCommit, recordAsRef: 'staging' },
          preflight: expect.any(Function),
        }),
      );
      expect(mocks.importPreflight).toHaveBeenCalledWith({ root: '/repo', probeRef: sourceCommit, enforceSourceCohort: true });
      expect(result).toMatchObject({
        ok: true,
        mode: 'whole-blob',
        source: { ref: sourceCommit, root: '/repo' },
      });
    });

    it('wholeBlob sourceCommit fails closed when the commit is absent or not integrated', async () => {
      const sourceCommit = '1'.repeat(40);
      const args = {
        op: 'admit',
        paths: ['lib/red.test.ts'],
        wholeBlob: true,
        sourceCommit,
        reason: 'pin the reviewed preview',
      };
      mocks.admissionGit.mockReturnValueOnce({ status: 128, stdout: '', stderr: 'bad revision' });
      expect(body(await tool.handler(args as never, ctx))).toMatchObject({
        ok: false,
        reason: 'source-commit-unresolvable',
      });
      expect(mocks.admit).not.toHaveBeenCalled();

      mocks.admissionGit
        .mockReturnValueOnce({ status: 0, stdout: `${sourceCommit}\n`, stderr: '' })
        .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });
      expect(body(await tool.handler(args as never, ctx))).toMatchObject({
        ok: false,
        reason: 'source-commit-not-integrated',
      });
      expect(mocks.admit).not.toHaveBeenCalled();
    });
  });

  // WI-10004151 part 2: a lockfile admission moved repairHead 5955f82b onto dependency inputs no
  // installed tree could produce, and verification parked an hour later with no cause named. The
  // door now asks dependency-generation.sh --predict-ref about the BUILT commit before publishing.
  describe('WI-10004151: admit-time dependency-generation prediction', () => {
    const LOCK = 'package-lock.json';
    const prediction = (verdict: string, extra: Record<string, unknown> = {}) => ({
      verdict,
      ref: NEW_HEAD,
      paths: [LOCK],
      inputFingerprint: '1'.repeat(64),
      liveFingerprint: '2'.repeat(64),
      droppedLinks: verdict === 'buildable' ? 2 : 0,
      reasons: verdict === 'refused' ? ['node_modules/pkg: version "1.0.0" (ref) vs "2.0.0" (live)'] : [],
      durationMs: 5,
      ...extra,
    });
    const lockAdmit = (extra: Record<string, unknown> = {}) =>
      tool.handler({ op: 'admit', paths: [LOCK], ...extra } as never, { role: 'su' } as never);

    beforeEach(() => {
      mocks.hunkExact.mockReturnValue(hunkExactOf([LOCK]));
    });

    it('asks about the BUILT commit on a dry run and warns that a confirmed admit will be refused', async () => {
      mocks.admit.mockReturnValue(admissionOf(false, [LOCK]));
      mocks.predict.mockResolvedValue(prediction('refused'));
      const result = body(await lockAdmit());
      expect(mocks.predict).toHaveBeenCalledWith({ integrationRoot: '/repo', ref: NEW_HEAD, paths: [LOCK] });
      expect(result).toMatchObject({
        ok: true,
        verdict: 'would-admit',
        dependencyGeneration: { verdict: 'refused', ref: NEW_HEAD },
      });
      expect(result.note).toContain('A confirmed admit will be REFUSED (dependency-generation-unbuildable)');
      expect(result.note).toContain('version "1.0.0" (ref) vs "2.0.0" (live)');
    });

    it('refuses a confirmed admit of an unbuildable lock BEFORE publishing anything', async () => {
      mocks.admit.mockReturnValue(admissionOf(false, [LOCK]));
      mocks.predict.mockResolvedValue(prediction('refused'));
      const result = body(await lockAdmit({ confirm: true }));
      expect(result).toMatchObject({
        ok: false,
        admitted: false,
        refused: true,
        verdict: 'refused',
        reason: 'dependency-generation-unbuildable',
        builtCommit: NEW_HEAD,
        judgedSha: queue.repairHead,
      });
      expect(result.detail).toContain('NO installed tree can produce');
      expect(result.note).toContain('npm run install:safe');
      // Only the unpublished build ran; no publish, no queue write.
      expect(mocks.admit.mock.calls.every(([input]) => input.dryRun === true)).toBe(true);
      expect(mocks.write).not.toHaveBeenCalled();
    });

    it('skipPrecheck + precheckReason overrides the refusal loudly', async () => {
      mocks.admit.mockReturnValue(admissionOf(true, [LOCK]));
      mocks.predict.mockResolvedValue(prediction('refused'));
      const result = body(
        await lockAdmit({ confirm: true, skipPrecheck: true, precheckReason: 'installing the lock in step two' }),
      );
      expect(result).toMatchObject({ ok: true, admitted: true, dependencyGeneration: { verdict: 'refused' } });
      expect(result.nextAction).toContain('Admitted PAST an unbuildable-dependency prediction');
      const auditDetails = JSON.parse(mocks.audit.mock.calls[0]![1][5]);
      expect(auditDetails.dependencyGeneration).toMatchObject({ verdict: 'refused' });
    });

    it.each([
      ['buildable', "the gate's --ensure-ref builds it from the live trees (2 live-only link(s) dropped)"],
      ['unknown', 'buildability could not be predicted'],
    ])('publishes a %s prediction and says so in nextAction', async (verdict, phrase) => {
      mocks.admit.mockReturnValue(admissionOf(true, [LOCK]));
      mocks.predict.mockResolvedValue(prediction(verdict, verdict === 'unknown' ? { detail: 'timed out' } : {}));
      const result = body(await lockAdmit({ confirm: true }));
      expect(result).toMatchObject({ ok: true, admitted: true, dependencyGeneration: { verdict } });
      expect(result.nextAction).toContain(phrase);
    });

    it('stays silent for prewarmed inputs and never asks for a non-dependency admission', async () => {
      mocks.admit.mockReturnValue(admissionOf(true, [LOCK]));
      mocks.predict.mockResolvedValue(prediction('prewarmed'));
      const prewarmed = body(await lockAdmit({ confirm: true }));
      expect(prewarmed.dependencyGeneration).toMatchObject({ verdict: 'prewarmed' });
      expect(prewarmed.nextAction).not.toContain('Dependency inputs changed');

      mocks.predict.mockClear();
      mocks.hunkExact.mockReturnValue(hunkExactOf());
      mocks.admit.mockReturnValue(admissionOf(false));
      const plain = body(await tool.handler({ op: 'admit', paths: ['lib/red.test.ts'] } as never, { role: 'su' } as never));
      expect(plain.verdict).toBe('would-admit');
      expect(mocks.predict).not.toHaveBeenCalled();
      expect(plain).not.toHaveProperty('dependencyGeneration');
    });
  });
});

describe('P-007 (#D-040) — precheckRecordOf persists the admission radius on every branch', () => {
  const overCap = { status: 'skipped' as const, reason: 'over-cap(5572/40)', guarded: [], reportOnly: [], legs: {} };
  const population = precheckPopulation({ signature: [], admittedPaths: ['lib/src.ts'], radius: overCap });
  const ctx = { skipPrecheck: false, precheckReason: '', dryRun: false, population };
  const expected = { status: 'skipped', reason: 'over-cap(5572/40)' };

  it.each([
    ['not run', null, ctx],
    ['skipped by the caller', null, { ...ctx, skipPrecheck: true, precheckReason: 'operator override' }],
    ['dry run', null, { ...ctx, dryRun: true }],
    ['nothing to run', null, { ...ctx, population: { ...population, files: [] } }],
    ['ran', { ok: true, ran: true, commit: 'abc', population, results: [], passing: [], failing: [], unmeasured: [], fixes: [] }, ctx],
    ['busy', { ok: true, ran: false, reason: 'checkpoint-tree-busy', detail: 'gate holds the tree', population }, ctx],
  ] as const)('%s', (_label, verdict, branchCtx) => {
    const record = repairQueueModule.precheckRecordOf(verdict as never, branchCtx as never);
    expect(record.radius).toEqual(expected);
  });

  it('keeps the measured radius files and their legs', () => {
    const measured = precheckPopulation({
      signature: [],
      admittedPaths: ['lib/src.ts'],
      radius: { status: 'measured', reason: 'ok', guarded: ['lib/a.test.ts'], reportOnly: ['lib/b.test.ts'], legs: { 'lib/a.test.ts': '@papercusp/x' } },
    });
    const record = repairQueueModule.precheckRecordOf(null, { ...ctx, population: measured });
    expect(record.radius).toEqual({
      status: 'measured',
      reason: 'ok',
      files: ['lib/a.test.ts', 'lib/b.test.ts'],
      legs: { 'lib/a.test.ts': '@papercusp/x' },
    });
  });

  it('carries no radius when the door computed none (gitlink or legacy population)', () => {
    const none = precheckPopulation({ signature: [], admittedPaths: ['lib/src.ts'] });
    expect(repairQueueModule.precheckRecordOf(null, { ...ctx, population: none })).not.toHaveProperty('radius');
  });
});
