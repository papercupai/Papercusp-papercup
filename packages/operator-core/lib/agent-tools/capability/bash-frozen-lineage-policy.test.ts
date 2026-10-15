/**
 * capability:bash frozen-lineage launch boundary (WI-10000422 / P-005).
 *
 * The pure classifier/evaluator has exhaustive policy coverage beside the
 * shared module. These tests pin the handler property: the CAS runs adjacent
 * to spawn, a refusal never reaches bash-jobs, and focused work pays no marker
 * or Git probe.
 */
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const markerIo = vi.hoisted(() => ({ read: vi.fn() }));
const queueIo = vi.hoisted(() => ({ read: vi.fn() }));
const gitIo = vi.hoisted(() => ({ head: vi.fn() }));
const sourceHoldIo = vi.hoisted(() => ({ read: vi.fn() }));
const sessionRestrictionIo = vi.hoisted(() => ({ read: vi.fn() }));
const jobs = vi.hoisted(() => ({
  startBackground: vi.fn(() => ({
    id: 'bash-frozen-lineage',
    taskId: 'task-frozen-lineage',
    status: 'completed' as const,
    exitCode: 0,
    startedAt: 1,
    endedAt: 2,
    logPath: '/tmp/bash-frozen-lineage.log',
    timeoutMs: 10_000,
    deadlineAt: 10_001,
  })),
  waitForJobResponse: vi.fn(async () => 'terminal' as const),
  snapshotJobResult: vi.fn(),
}));

vi.mock('../../release/frozen-repair-edit-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/frozen-repair-edit-marker')>()),
  readFrozenRepairMarker: markerIo.read,
}));
vi.mock('../../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueue: queueIo.read,
}));
vi.mock('../../harness/docs/git-runner', () => ({ repoHeadSha: gitIo.head }));
vi.mock('../../personal-vault/git-sync-hold', () => ({ readRestrictedSourceHoldState: sourceHoldIo.read }));
vi.mock('../../personal-vault/binding-enforcement', () => ({ readSessionRestriction: sessionRestrictionIo.read }));
vi.mock('./bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bash-jobs')>()),
  startBackground: jobs.startBackground,
  waitForJobResponse: jobs.waitForJobResponse,
  snapshotJobResult: jobs.snapshotJobResult,
}));
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxPolicy: vi.fn(async () => ({
    enabled: false,
    required: false,
    profile: { kind: 'trusted', reason: 'test' },
  })),
}));

import bashTool from './bash';

const ROOT = resolve('.');
const CANDIDATE = 'c'.repeat(40);
const REPAIR_HEAD = 'r'.repeat(40);
const MARKER = {
  candidate: CANDIDATE,
  repairHead: REPAIR_HEAD,
  phase: 'repair-in-progress',
  failingPaths: [],
  updatedAtMs: 1_788_763_360_000,
  admittedPaths: [],
  legs: [],
};
const QUEUE = {
  ...MARKER,
  phase: 'ready-to-verify',
};

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type Tool = { handler: (args: unknown, ctx: unknown) => Promise<ToolResult> };
const bash = bashTool as unknown as Tool;

function ctx() {
  return {
    projectDir: ROOT,
    stateDir: ROOT,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'operator',
  } as never;
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PAPERCUSP_INTEGRATION_ROOT = ROOT;
  sourceHoldIo.read.mockResolvedValue('clear');
  sessionRestrictionIo.read.mockResolvedValue(false);
  // The queue is authoritative. Keep the marker deliberately stale so these
  // handler tests cannot pass by accidentally falling back to the projection.
  markerIo.read.mockReturnValue({ ...MARKER, repairHead: CANDIDATE, updatedAtMs: 1 });
  queueIo.read.mockResolvedValue(QUEUE);
  gitIo.head.mockResolvedValue(CANDIDATE);
  jobs.snapshotJobResult.mockReturnValue({
    status: 'completed',
    exitCode: 0,
    output: 'ok',
    totalBytes: 2,
    truncated: false,
    logPath: '/tmp/bash-frozen-lineage.log',
    durationMs: 1,
  });
});

describe('capability:bash frozen-lineage guard', () => {
  it('uses the authoritative repair_queue identity instead of a stale marker', async () => {
    const result = await bash.handler({ command: 'npm test', cwd: ROOT }, ctx());

    expect(queueIo.read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: expect.any(String) }));
    expect(markerIo.read).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'frozen_candidate_lineage_violation',
      checkoutHead: CANDIDATE,
      liveIdentity: { candidate: CANDIDATE, repairHead: REPAIR_HEAD },
    });
  });

  it('refuses a canonical root test from a checkout other than repairHead', async () => {
    const result = await bash.handler({ command: 'npm test', cwd: ROOT }, ctx());
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      commandKind: 'canonical-root-test',
      checkoutHead: CANDIDATE,
      liveIdentity: { candidate: CANDIDATE, repairHead: REPAIR_HEAD },
    });
    expect(gitIo.head).toHaveBeenCalledWith(ROOT);
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it('allows the exact live repairHead root test', async () => {
    gitIo.head.mockResolvedValue(REPAIR_HEAD);
    const result = await bash.handler({ command: 'npm run test:affected', cwd: ROOT }, ctx());
    expect(result.isError).not.toBe(true);
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it.each([
    ['node scripts/affected-tests.mjs --changed-paths libs/papercusp --base HEAD^ --dry'],
    ['node scripts/affected-tests.mjs --changed-paths libs/papercusp --base HEAD^ --print-affected'],
  ] as const)('runs selection-only affected-tests probes without a candidate-verdict check: %s', async (command) => {
    const result = await bash.handler({ command, cwd: ROOT }, ctx());
    expect(result.isError).not.toBe(true);
    expect(queueIo.read).not.toHaveBeenCalled();
    expect(markerIo.read).not.toHaveBeenCalled();
    expect(gitIo.head).not.toHaveBeenCalled();
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it('treats an authoritative ready-to-test queue as inactive even when the marker is stale', async () => {
    queueIo.read.mockResolvedValue({ ...QUEUE, phase: 'ready-to-test' });

    const result = await bash.handler({ command: 'npm test', cwd: ROOT }, ctx());

    expect(result.isError).not.toBe(true);
    expect(markerIo.read).not.toHaveBeenCalled();
    expect(gitIo.head).not.toHaveBeenCalled();
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it('refuses a governed test when its effective checkout cwd cannot be resolved', async () => {
    const result = await bash.handler({ command: 'cd "$UNKNOWN_CWD" && npm test', cwd: ROOT }, ctx());

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'frozen_candidate_lineage_violation',
      reason: 'checkout-cwd-unresolved',
    });
    expect(gitIo.head).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it.each([
    'npm run test:file -- packages/operator-core/lib/release/frozen-lineage-execution-policy.test.ts',
    'ptool release:repair-queue --json - <<\'JSON\'\n{"op":"admit","paths":["a.ts"]}\nJSON',
    // P-015: a sibling checkout's suite and worktree cut are not papercusp lineage operations.
    'cd /tmp/p015-sibling-checkout || exit 1; npm test',
    'R=/tmp/p015-sibling-checkout; git -C "$R" worktree add --detach /tmp/p015-w staging',
  ])('preserves focused tests and explicit repair admission without marker/Git probes: %s', async (command) => {
    const result = await bash.handler({ command, cwd: ROOT }, ctx());
    expect(result.isError).not.toBe(true);
    expect(markerIo.read).not.toHaveBeenCalled();
    expect(gitIo.head).not.toHaveBeenCalled();
    expect(jobs.startBackground).toHaveBeenCalledOnce();
  });

  it('refuses a staging worktree candidate cut before spawn and without a HEAD probe', async () => {
    const result = await bash.handler(
      { command: 'git worktree add --detach /tmp/frozen-candidate staging', cwd: ROOT },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'frozen_candidate_lineage_violation',
      commandKind: 'candidate-worktree-cut',
      unsafeSource: 'staging',
      selectedRef: 'staging',
    });
    expect(gitIo.head).not.toHaveBeenCalled();
    expect(jobs.startBackground).not.toHaveBeenCalled();
  });

  it.each(['held', 'unknown'] as const)('requires the no-egress sandbox before spawn when the source hold is %s', async (state) => {
    sourceHoldIo.read.mockResolvedValue(state);
    const result = await bash.handler({ command: 'python3 -c "open(\'https://example.invalid\')"', cwd: ROOT }, ctx());

    expect(result.isError).not.toBe(true);
    expect(sourceHoldIo.read).toHaveBeenCalledWith(ROOT);
    expect(jobs.startBackground).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxEnabled: true,
        sandboxRequired: true,
        sandboxBuildOpts: { denyAllEgress: true, srtBin: null },
      }),
      expect.any(Number),
    );
  });

  it('keeps the source-hold decision clear for a clean tree and unrestricted session', async () => {
    const result = await bash.handler({ command: 'echo ok', cwd: ROOT }, ctx());
    expect(result.isError).not.toBe(true);
    expect(jobs.startBackground).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxEnabled: false, sandboxRequired: false }),
      expect.any(Number),
    );
  });
});
