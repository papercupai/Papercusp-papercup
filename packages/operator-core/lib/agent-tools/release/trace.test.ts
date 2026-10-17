import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  gitPipelineSnapshot: vi.fn(),
  gitPipelinePosition: vi.fn(),
  computeDeployStatus: vi.fn(),
  buildReleaseTrace: vi.fn(),
  inspectEventKey: vi.fn(),
  resolveAgentIdentity: vi.fn(),
  resolveManualRunAuthority: vi.fn(async () => null),
  getFlag: vi.fn(async () => true),
}));

vi.mock('../../git-pipeline-stats', () => ({ gitPipelineSnapshot: mocks.gitPipelineSnapshot }));
vi.mock('../../git-pipeline-position', () => ({ gitPipelinePosition: mocks.gitPipelinePosition }));
vi.mock('../../release-deploy-launch', () => ({
  computeDeployStatus: mocks.computeDeployStatus,
  integrationRoot: () => '/test/integration-root',
}));
vi.mock('../../release-trace', () => ({ buildReleaseTrace: mocks.buildReleaseTrace }));
vi.mock('../../events/await/store', () => ({ inspectEventKey: mocks.inspectEventKey }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: mocks.resolveAgentIdentity }));
vi.mock('../../release/manual-run-authority', () => ({
  resolveManualRunAuthority: mocks.resolveManualRunAuthority,
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: mocks.getFlag }));
vi.mock('../../harness/operator-home-harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'test-home',
}));

import tool, {
  RELEASE_TRACE_AWAIT_TIMEOUT_MS,
  RELEASE_TRACE_POSITION_TIMEOUT_MS,
  RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
} from './trace';
import '../cell-registrations-wiring';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('release:trace tool contract', () => {
  it('is the read-only release composition surface for every execution/release role', () => {
    expect(tool.name).toBe('release:trace');
    expect(tool.capability).toBe('intel:read');
    const roles = new Set(tool.agentRoles ?? []);
    for (const role of ['operator', 'worker', 'validator', 'reviewer', 'cup', 'release-fixer', 'release-manager']) {
      expect(roles.has(role), role).toBe(true);
    }
  });

  it('does not hold an ambient workspace transaction during reconciliation (EI-20246294559310854)', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('requires path or sha in the published schema even when work_item is supplied (EI-20232784385629302)', () => {
    const missingTarget = tool.args.safeParse({ work_item: 'WI-38026' });
    expect(missingTarget.success).toBe(false);
    if (!missingTarget.success) {
      expect(missingTarget.error.issues[0]).toMatchObject({ code: 'invalid_union' });
    }

    expect(tool.args.safeParse({ path: 'packages/operator-core/lib/agent-tools/release/trace.ts' }).success).toBe(true);
    expect(tool.args.safeParse({ sha: 'abcd', work_item: 'WI-38026' }).success).toBe(true);

    const published = z.toJSONSchema(tool.args as never) as {
      anyOf?: Array<{ required?: string[] }>;
    };
    expect(published.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: expect.arrayContaining(['path']) }),
        expect.objectContaining({ required: expect.arrayContaining(['sha']) }),
      ]),
    );
  });

  it('uses the sidecar-free snapshot path for diagnostic reads (EI-20264406467393669)', async () => {
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: false,
        repairQueue: { phase: 'blocked', candidate: 'a'.repeat(40), retireAllowed: true },
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234' });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    const out = (await tool.handler(
      { path: 'packages/operator-core/lib/agent-tools/release/trace.ts' } as never,
      {} as never,
    )) as { data: { repairQueue: unknown } };

    expect(mocks.gitPipelineSnapshot).toHaveBeenCalledWith(undefined, {
      useSpawnerSidecar: false,
      includeActiveRun: true,
    });
    expect(out.data.repairQueue).toMatchObject({ phase: 'blocked', retireAllowed: true });
  });

  it('audits the exact fix/candidate/containment tuple with the resolved caller', async () => {
    const metadata = vi.fn();
    const fixSha = 'a'.repeat(40);
    const observedCandidate = 'b'.repeat(40);
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: false,
        observedCandidate,
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: fixSha });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({
      ok: false,
      gate: {
        fixCommitContainment: { fixSha, observedCandidate, verdict: 'contained', reason: null },
      },
    });

    await tool.handler({ sha: fixSha } as never, { metadata } as never);

    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith({
      releaseTraceFixCommitContainment: {
        callerId: 'test-owner',
        fixSha,
        observedCandidate,
        verdict: 'contained',
      },
    });
  });

  it('stamps the operator-home subject and warns a concrete foreign-harness caller', async () => {
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234' });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    const out = (await tool.handler(
      { sha: 'abcd1234' } as never,
      { role: 'cup', harnessSlug: 'sidestage' } as never,
    )) as {
      data: {
        subject: { harness: string; scope: string; integrationRoot: string; note: string };
        harnessMismatch: { callerHarness: string; reportedHarness: string; warning: string };
      };
    };

    expect(out.data.subject).toMatchObject({
      harness: 'test-home',
      scope: 'operator-home-release-pipeline',
      integrationRoot: '/test/integration-root',
    });
    expect(out.data.subject.note).toContain('test-home');
    expect(out.data.harnessMismatch).toMatchObject({
      callerHarness: 'sidestage',
      reportedHarness: 'test-home',
    });
    expect(out.data.harnessMismatch.warning).toContain('sidestage');
    expect(out.data.harnessMismatch.warning).toContain('test-home');
  });

  it('does not invent a mismatch for same-harness, wildcard, or unknown callers', async () => {
    for (const harnessSlug of ['test-home', '*', undefined]) {
      const snapshot = {
        generatedAtMs: 123,
        deploy: { integrationRoot: '/workspace/papercusp' },
        gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
      };
      mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
      mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234' });
      mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
      mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
      mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
      mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

      const out = (await tool.handler(
        { sha: 'abcd1234' } as never,
        { role: 'cup', harnessSlug } as never,
      )) as { data: { subject: { harness: string }; harnessMismatch?: unknown } };

      expect(out.data.subject.harness).toBe('test-home');
      expect(out.data.harnessMismatch).toBeUndefined();
    }
  });

  it('keeps an active checkpoint from surfacing a gate-wedged trace (EI-21313251739637753)', async () => {
    const activeRun = {
      active: true,
      candidate: 'active-candidate',
      startedAtMs: 123,
      elapsedSec: 42,
    };
    const snapshot = {
      generatedAtMs: 123,
      activeRun: {
        active: false,
        candidate: null,
        startedAtMs: null,
        elapsedSec: null,
      },
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: true,
        fireStaleReason: 'no fresh verdict in 9h',
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({
      targetSha: 'abcd1234',
      gate: { checkpointRunInFlight: activeRun },
    });
    mocks.computeDeployStatus.mockImplementationOnce((input) => {
      const active = input.activeRun?.active === true;
      return {
        state: 'staging-buffered',
        gate: {
          fireStale: input.gate.fireStale && !active,
          fireStaleReason: input.gate.fireStale && !active ? input.gate.fireStaleReason : null,
        },
      };
    });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: false });

    await tool.handler({ sha: 'abcd1234' } as never, {} as never);

    expect(mocks.gitPipelineSnapshot).toHaveBeenCalledWith(undefined, {
      useSpawnerSidecar: false,
      includeActiveRun: true,
    });
    expect(mocks.computeDeployStatus).toHaveBeenCalledWith(expect.objectContaining({ activeRun }));
    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          state: 'staging-buffered',
          fireStale: false,
          fireStaleReason: null,
          checkpointRunInFlight: activeRun,
        }),
      }),
    );
  });

  it('stamps the exact target SHA with a candidate-cell re-read handle', async () => {
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234', input: { path: 'apps/x.ts', sha: null } });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true, target: { sha: 'abcd1234' } });

    const out = (await tool.handler(
      { path: 'apps/x.ts' } as never,
      { role: 'cup', harnessSlug: 'papercusp' } as never,
    )) as { data: { plane?: { cells: Array<Record<string, unknown>> } } };

    expect(out.data.plane?.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'target.sha',
          cell: 'gate.greenCheckpoint.candidate',
          reread: { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.candidate', as: 'apps/x.ts' } },
        }),
      ]),
    );
  });

  it('preserves the active checkpoint candidate separately from the terminal observed candidate', async () => {
    const activeRun = {
      active: true,
      candidate: 'active-candidate',
      activeSource: 'run-lock' as const,
      startedAtMs: 123,
      elapsedSec: 42,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: false,
        observedCandidate: 'terminal-candidate',
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({
      targetSha: 'abcd1234',
      gate: {
        observedCandidate: 'terminal-candidate',
        checkpointRunInFlight: activeRun,
      },
    });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    await tool.handler({ sha: 'abcd1234' } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          observedCandidate: 'terminal-candidate',
          checkpointRunInFlight: activeRun,
        }),
      }),
    );
  });

  it('preserves the cancelled no-verdict authority for the pure release:trace guard', async () => {
    const cancelled = {
      status: 'cancelled',
      candidate: 'abcd1234',
      detail: 'externally SIGTERMed before a result marker was published',
      observedAtMs: 123,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 0,
        failingTests: [],
        fireStale: false,
        inconclusive: cancelled,
      },
    };
    const cancelledRun = {
      active: false,
      activeSource: 'run-lock' as const,
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({
      targetSha: 'abcd1234',
      gate: { checkpointRunInFlight: cancelledRun },
    });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    await tool.handler({ sha: 'abcd1234' } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({ inconclusive: cancelled }),
      }),
    );
  });

  it('suppresses prior failing tests when the requested candidate is infra-inconclusive', async () => {
    const targetSha = 'a'.repeat(40);
    const inconclusive = {
      status: 'infra-inconclusive',
      candidate: targetSha.slice(0, 8),
      detail: 'green-checkpoint rendered no code verdict',
      observedAtMs: 123,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 5,
        failingTests: ['historical-red.test.ts'],
        failingTestsMeasured: false,
        fireStale: false,
        observedCandidate: 'older-candidate',
        inconclusive,
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'gate-red' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: false });

    await tool.handler({ sha: targetSha } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          authoritative: false,
          consecutiveReds: 5,
          failingTests: [],
          failingTestsMeasured: false,
          inconclusive,
        }),
      }),
    );
  });

  it('labels prior failing tests as inherited repair-queue context for an exact repair hold', async () => {
    const targetSha = 'b'.repeat(40);
    const inconclusive = {
      status: 'repair-in-progress',
      candidate: targetSha.slice(0, 8),
      detail: 'frozen repair fixer dispatched; no suite run',
      observedAtMs: 123,
    };
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: {
        verdictStale: false,
        consecutiveReds: 5,
        failingTests: ['historical-red.test.ts'],
        fireStale: false,
        observedCandidate: 'older-candidate',
        recordedVerdict: 'not-green',
        inconclusive,
      },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'gate-red' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: false });

    await tool.handler({ sha: targetSha } as never, {} as never);

    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: expect.objectContaining({
          failingTests: [],
          inheritedRepairQueueFailingTests: ['historical-red.test.ts'],
          inheritedRepairQueueFailingTestsSource: 'prior-gate-verdict',
          recordedVerdict: 'not-green',
          inconclusive,
        }),
      }),
    );
  });

  it('returns an unknown, retryable result when the pipeline snapshot exceeds its budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    mocks.gitPipelineSnapshot.mockImplementation(() => new Promise(() => {}));

    const pending = tool.handler(
      { sha: 'abcd1234' } as never,
      { role: 'cup', harnessSlug: 'sidestage' } as never,
    );
    await vi.advanceTimersByTimeAsync(RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      data: {
        ok: false,
        subject: {
          harness: 'test-home',
          scope: 'operator-home-release-pipeline',
          integrationRoot: '/test/integration-root',
        },
        harnessMismatch: { callerHarness: 'sidestage', reportedHarness: 'test-home' },
        trace: { status: 'unknown', complete: false },
        nextVerb: null,
        error: {
          code: 'trace_timeout',
          stage: 'pipeline_snapshot',
          retryable: true,
          timeoutMs: RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS,
        },
      },
    });
    expect(mocks.gitPipelinePosition).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS}ms`));
  });

  it('allows a slow but valid pipeline-position read below the expanded budget', async () => {
    vi.useFakeTimers();
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ targetSha: 'abcd1234' }), 16_000)),
    );
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockResolvedValue({ waiters: [], deliveries: [] });
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    const pending = tool.handler({ sha: 'abcd1234' } as never, {} as never);
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await pending;

    expect(result).toMatchObject({ data: { ok: true } });
    expect(mocks.buildReleaseTrace).toHaveBeenCalled();
  });

  it('returns unknown instead of an all-clear when await-history reconciliation stalls', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockResolvedValueOnce(snapshot);
    mocks.gitPipelinePosition.mockResolvedValueOnce({ targetSha: 'abcd1234' });
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockImplementation(() => new Promise(() => {}));
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });

    const pending = tool.handler({ sha: 'abcd1234' } as never, {} as never);
    await vi.advanceTimersByTimeAsync(RELEASE_TRACE_POSITION_TIMEOUT_MS + RELEASE_TRACE_AWAIT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toMatchObject({
      data: {
        ok: false,
        trace: { status: 'unknown', complete: false },
        nextVerb: null,
        error: {
          code: 'trace_timeout',
          stage: 'await_history',
          retryable: true,
          timeoutMs: RELEASE_TRACE_AWAIT_TIMEOUT_MS,
        },
      },
    });
    expect(mocks.inspectEventKey).toHaveBeenCalledTimes(4);
    expect(mocks.buildReleaseTrace).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`exceeded ${RELEASE_TRACE_AWAIT_TIMEOUT_MS}ms`));
  });

  it('keeps slow authority and flag reads inside the composite transport budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const snapshot = {
      generatedAtMs: 123,
      deploy: { integrationRoot: '/workspace/papercusp' },
      gate: { verdictStale: false, consecutiveReds: 0, failingTests: [], fireStale: false },
    };
    mocks.gitPipelineSnapshot.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(snapshot), RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS - 1)),
    );
    mocks.gitPipelinePosition.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ targetSha: 'abcd1234' }), RELEASE_TRACE_POSITION_TIMEOUT_MS - 1)),
    );
    mocks.computeDeployStatus.mockReturnValueOnce({ state: 'green' });
    mocks.inspectEventKey.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ waiters: [], deliveries: [] }), RELEASE_TRACE_AWAIT_TIMEOUT_MS - 1),
        ),
    );
    mocks.resolveAgentIdentity.mockReturnValueOnce({ ownerId: 'test-owner' });
    mocks.resolveManualRunAuthority.mockImplementationOnce(() => new Promise(() => {}));
    mocks.getFlag.mockImplementationOnce(() => new Promise(() => {}));
    mocks.buildReleaseTrace.mockReturnValueOnce({ ok: true });

    const pending = tool.handler({ sha: 'abcd1234' } as never, {} as never);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(RELEASE_TRACE_AWAIT_TIMEOUT_MS);
    expect(mocks.resolveManualRunAuthority).toHaveBeenCalledTimes(1);
    expect(mocks.getFlag).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(
      RELEASE_TRACE_SNAPSHOT_TIMEOUT_MS - 1 +
        RELEASE_TRACE_POSITION_TIMEOUT_MS - 1 +
        RELEASE_TRACE_AWAIT_TIMEOUT_MS - 1 -
        RELEASE_TRACE_AWAIT_TIMEOUT_MS,
    );
    expect(settled).toBe(true);
    const result = (await pending) as { data: { ok: boolean } };
    expect(result.data.ok).toBe(true);
    expect(mocks.buildReleaseTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        progressCertificateEnabled: true,
        gate: expect.objectContaining({ manualRunAuthority: null }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('release:trace:manual-run-authority'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('release:trace:progress-certificate-flag'));
  });

  it('does not convert a real pipeline read error into a timeout or an all-clear', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('pipeline snapshot unavailable');
    mocks.gitPipelineSnapshot.mockRejectedValueOnce(failure);

    await expect(tool.handler({ sha: 'abcd1234' } as never, {} as never)).rejects.toThrow(failure);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pipeline snapshot unavailable'));
  });
});
