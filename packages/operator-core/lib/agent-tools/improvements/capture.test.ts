import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { applyPayloadTier } from '@papercusp/tooldef';
import captureTool, { defaultScorecardConditionKey, deriveToolFailureCaptureText } from './capture';
import { coerceCaptureArgs, coerceCaptureKind, coerceIdeateProvenance } from './capture-coerce';
import {
  captureImprovement,
  captureToolInvocationFriction,
  recordCaptureReviewFailure,
  setCaptureReviewState,
} from '../../harness/improvements/capture-core';
import { enterAgentReview } from '../../harness/improvements/agent-review';
import { noveltyPriorArt } from '../../scout/novelty-precheck';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { computeObservationsImpact } from '../../scout/observation-impact-leg';
import { getModes } from '../../modes/store';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { metadataToolFailure, metadataWorkflowTargets } from '../plans/coordination-metadata-fixtures';

const drainAdmission = vi.hoisted(() => ({
  blocked: false,
  unavailable: false,
  gate: vi.fn(),
}));

const stalenessHints = vi.hoisted(() => ({
  toolFailure: vi.fn(async () => null as string | null),
  paths: vi.fn(
    async (_paths: readonly string[], _overrides?: { deployedSha?: () => string | null }) => null as string | null,
  ),
}));

const trustedRuntime = vi.hoisted(() => ({
  read: vi.fn(async () => null as {
    commitSha: string;
    testRunIds: number[];
    workspaceId: string;
    harnessSlug: string;
    runGroupId: string;
    root: string;
    filePaths: string[];
  } | null),
}));
const dedupAlarm = vi.hoisted(() => ({ report: vi.fn(async (_detail: unknown) => undefined) }));

// PG-free unit: capture-core has its own 31-test suite; this pins the tool
// wrapper's two jobs — (1) deriving the `source` label from the caller's
// identity tier, and (2) passing every arg + the resolved identity through to
// the shared core unchanged. (self-learning-central P-001/P-010.)
vi.mock('../../harness/improvements/capture-core');
vi.mock('../../tool-schema-staleness', async () => {
  const actual = await vi.importActual<typeof import('../../tool-schema-staleness')>('../../tool-schema-staleness');
  return {
    ...actual,
    toolFailureStalenessHint: stalenessHints.toolFailure,
    pathsStalenessHint: stalenessHints.paths,
  };
});
vi.mock('../../testing-run-store', async (original) => ({
  ...(await original<typeof import('../../testing-run-store')>()),
  readTrustedHarnessTestRunProvenance: trustedRuntime.read,
}));
vi.mock('../../harness/improvements/agent-review', () => ({
  enterAgentReview: vi.fn(async () => ({
    entered: true,
    state: { status: 'pending', submittedBy: 'su-test', ledgerIdeaId: 'EI-1', round: 1 },
  })),
}));
vi.mock('../coordination/identity');
vi.mock('../../modes/store', () => ({ getModes: vi.fn(async () => []) }));
// P-013 (D-024): the filing door resolves a receipt's ledger ref through this seam.
const reproLedger = vi.hoisted(() => ({
  invocations: new Map<number, { status: string | null; servingBuildSha: string | null }>(),
}));
vi.mock('../../attention/intake-promotion', async (original) => ({
  ...(await original<typeof import('../../attention/intake-promotion')>()),
  defaultReproductionLedgerDeps: () => ({
    readTestRun: async () => null,
    readToolInvocation: async (id: number) => reproLedger.invocations.get(id) ?? null,
    now: () => new Date('2026-10-05T22:00:00Z'),
  }),
}));
vi.mock('../work_items/drain-flow', () => ({ withDrainBugAdmission: drainAdmission.gate }));
vi.mock('../work_items/semantic-dedup-probe-alarm', () => ({
  reportDedupCoverageDegraded: dedupAlarm.report,
}));
// P-008: the novelty pre-check is PG-backed (readNoveltyCorpus) — mock it so this
// suite stays PG-free. Default = resolved undefined ("check unavailable"), which the
// handler renders as an ABSENT priorArt field, leaving every pre-P-008 assertion
// byte-identical; the P-008 describe below sets explicit values.
vi.mock('../../scout/novelty-precheck', () => ({ noveltyPriorArt: vi.fn(async () => undefined) }));
// EI-10607: the su-ideate ledger write was PG-backed and entirely UNMOCKED here, so what
// capture passes to recordRoutedIdea was never asserted by any test — which is exactly where
// the bug lived (it never passed addressesPatternRefs, so no su idea could ever be counted as
// grounded). Mock it so the ledger row's CONTENTS are pinned, PG-free.
vi.mock('../../scout/routed-ledger', () => ({ recordRoutedIdea: vi.fn(async () => undefined) }));
// EI-12147: the generation stamp's real read execs systemctl + git — mock for determinism.
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: vi.fn(async () => ({ sha: 'abc1234', hostStartedAt: '2026-07-14T18:21:25.000Z' })),
}));

const mockCapture = vi.mocked(captureImprovement);
const mockCaptureToolInvocationFriction = vi.mocked(captureToolInvocationFriction);
const mockRecordCaptureReviewFailure = vi.mocked(recordCaptureReviewFailure);
const mockSetCaptureReviewState = vi.mocked(setCaptureReviewState);
const mockEnterAgentReview = vi.mocked(enterAgentReview);
const mockIdentity = vi.mocked(resolveAgentIdentity);
const mockResolveSelfLiteral = vi.mocked(resolveSelfLiteral);
const mockPriorArt = vi.mocked(noveltyPriorArt);
const mockRecordRoutedIdea = vi.mocked(recordRoutedIdea);
const mockGetModes = vi.mocked(getModes);
const mockReadTrustedHarnessTestRunProvenance = trustedRuntime.read;

drainAdmission.gate.mockImplementation(async (_args, persist) => {
  if (drainAdmission.unavailable) {
    return { ok: false, allowed: false, code: 'drain_flow_unavailable', message: 'oracle unavailable' };
  }
  const flow = {
    exact: true,
    totals: { opened: drainAdmission.blocked ? 1 : 0, terminaled: 0, net: drainAdmission.blocked ? 1 : 0 },
    breaker: { tripped: drainAdmission.blocked, blocksNewBugs: drainAdmission.blocked },
  };
  return drainAdmission.blocked
    ? { ok: true, allowed: false, code: 'drain_flow_circuit_open', message: 'terminal one first', flow }
    : { ok: true, allowed: true, flow, value: await persist(flow) };
});

describe('improvements:capture → agent-review enrollment (abolish-human-review D-003/P-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadTrustedHarnessTestRunProvenance.mockResolvedValue(null);
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-filer'));
    mockEnterAgentReview.mockResolvedValue({
      entered: true,
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'EI-42', round: 1 },
    });
    mockSetCaptureReviewState.mockImplementation(async (_id, state) => ({
      workItem: { id: 'EI-42', state },
      requestedState: state,
      appliedState: state,
    }));
    mockRecordCaptureReviewFailure.mockResolvedValue({ released: true, recorded: true });
  });

  it('enrolls a freshly-created change and reports the routing state in the tool result', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: {
        id: 'EI-42', title: 'Replace human review', state: 'blocked',
        assignee: 'su-filer', assignedBy: 'su-filer',
      },
      reviewRequired: true,
      reviewState: 'blocked',
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    const result = await callTool(
      { title: 'Replace human review', kind: 'change', harness: 'papercusp', assign_to: 'self' },
      {
        harnessSlug: 'papercusp',
        workspaceId: 'ws-1',
      },
    );
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(mockEnterAgentReview).toHaveBeenCalledWith({
      id: 'EI-42',
      submittedBy: 'su-filer',
      harnessSlug: 'papercusp',
      workspaceId: 'ws-1',
    });
    expect(mockSetCaptureReviewState).toHaveBeenCalledWith(
      'EI-42',
      'open',
      expect.objectContaining({ harness: 'papercusp', by: 'su-filer' }),
    );
    expect(body.agentReview).toEqual({
      entered: true,
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'EI-42', round: 1 },
    });
    expect(body).toMatchObject({
      reviewState: 'open',
      issue: { state: 'open', assignee: null, assignedBy: 'su-filer' },
    });
  });

  it('preserves su-ideate provenance by recording it before feature enrollment', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'F-42', title: 'A grounded feature' },
      reviewRequired: true,
      reviewState: 'blocked',
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    await callTool({
      title: 'A grounded feature',
      kind: 'feature',
      ideation: { lens: 'risk-first', addressesPatternRefs: ['wi:EI-9'] },
    });

    expect(mockRecordRoutedIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        ideaId: 'F-42',
        origin: 'su-ideate',
        lens: 'risk-first',
        addressesPatternRefs: ['wi:EI-9'],
      }),
    );
    expect(mockRecordRoutedIdea.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnterAgentReview.mock.invocationCallOrder[0],
    );
  });

  it('does not enroll bugs, observations, or a capture that created no row', async () => {
    mockCapture.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-bug' } } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    await callTool({ title: 'bug', kind: 'bug' });

    mockCapture.mockResolvedValue({ ok: true, created: true, issue: { id: 'EI-observation' } } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    await callTool({ title: 'observation', kind: 'change', lane: 'observation' });

    mockCapture.mockResolvedValue({ ok: true, created: false, reason: 'check-only' } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    await callTool({ title: 'duplicate', kind: 'change', checkDuplicatesOnly: true });

    expect(mockEnterAgentReview).not.toHaveBeenCalled();
  });

  it('returns the committed capture and failure metadata when enrollment fails', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-42', title: 'Review me' },
      reviewRequired: true,
      reviewState: 'blocked',
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    mockEnterAgentReview.mockRejectedValueOnce(new Error('enrollment failed'));

    const result = await callTool({ title: 'Review me', kind: 'change' });
    const body = JSON.parse(result.content[0].text) as Record<string, any>;

    expect(body).toMatchObject({
      ok: true,
      created: true,
      issue: { id: 'EI-42' },
      agentReviewFailure: { phase: 'enrollment', message: 'enrollment failed' },
    });
    expect(mockSetCaptureReviewState).toHaveBeenCalledWith(
      'EI-42',
      'blocked',
      expect.objectContaining({ reason: 'agent-review-enrollment-failed' }),
    );
    expect(mockRecordCaptureReviewFailure).toHaveBeenCalledWith(
      'EI-42',
      expect.objectContaining({ phase: 'enrollment', message: 'enrollment failed' }),
      { submittedBy: 'su-filer', harness: 'papercusp' },
    );
  });

  it('returns the committed capture and failure metadata when reopening fails', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-43', title: 'Reopen me' },
      reviewRequired: true,
      reviewState: 'blocked',
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    mockSetCaptureReviewState.mockImplementation(async (_id, state) => {
      if (state === 'open') throw new Error('reopen failed');
      return { workItem: { id: 'EI-43', state }, requestedState: state, appliedState: state };
    });

    const result = await callTool({ title: 'Reopen me', kind: 'change' });
    const body = JSON.parse(result.content[0].text) as Record<string, any>;

    expect(body).toMatchObject({
      ok: true,
      created: true,
      issue: { id: 'EI-43' },
      agentReviewFailure: { phase: 'reopen', message: 'reopen failed' },
    });
    expect(mockSetCaptureReviewState).toHaveBeenNthCalledWith(
      1,
      'EI-43',
      'open',
      expect.objectContaining({ reason: 'agent-review enrollment succeeded' }),
    );
    expect(mockSetCaptureReviewState).toHaveBeenNthCalledWith(
      2,
      'EI-43',
      'blocked',
      expect.objectContaining({ reason: 'agent-review-reopen-failed' }),
    );
    expect(mockRecordCaptureReviewFailure).toHaveBeenCalledWith(
      'EI-43',
      expect.objectContaining({ phase: 'reopen', message: 'reopen failed' }),
      { submittedBy: 'su-filer', harness: 'papercusp' },
    );
  });

  it('does not enroll when the core could not park the committed row', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-44', title: 'Park me' },
      reviewRequired: true,
      agentReviewFailure: { phase: 'block', message: 'blocked write failed', at: '2026-08-25T00:00:00.000Z' },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    const result = await callTool({ title: 'Park me', kind: 'change' });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: true,
      created: true,
      agentReviewFailure: { phase: 'block', message: 'blocked write failed' },
    });
    expect(mockEnterAgentReview).not.toHaveBeenCalled();
    expect(mockSetCaptureReviewState).not.toHaveBeenCalled();
  });
});

describe('improvements:capture — duplicate verdicts are annotations, not inaccessible declines (P-002)', () => {
  it('documents accepted duplicate matches and reserves non-persistence for checkDuplicatesOnly', () => {
    expect(captureTool.description).toContain('Dedup matches are annotated on the created row');
    expect(captureTool.description).not.toContain('declines obvious matches');
    const returns = captureTool.guidance?.returns ?? '';
    expect(returns).toContain('created row carries `payload.dedupVerdict');
    expect(returns).not.toContain('May DECLINE your capture');
    expect(returns).toContain('semantic:"partial"');
    expect(returns).toContain('index coverage is unknown/unmeasured');
    const seeAlso = captureTool.guidance?.seeAlso;
    expect(Array.isArray(seeAlso)).toBe(true);
    if (!Array.isArray(seeAlso)) throw new Error('capture guidance must provide static see-also entries');
    expect(seeAlso.some((entry) => entry.includes('checkDuplicatesOnly:true'))).toBe(true);
  });
});

describe('improvements:capture payload-tier write echo', () => {
  it('keeps the default issue receipt compact while preserving the explicit full-detail path', () => {
    const payload = { report: { message: 'x'.repeat(4_000) } };
    const original = {
      ok: true,
      created: true,
      kind: 'bug',
      issue: {
        id: 'EI-42',
        kind: 'bug',
        harness: 'papercusp',
        state: 'open',
        title: 'T'.repeat(200),
        assignee: 'su-test',
        summary: 'S'.repeat(4_000),
        payload,
      },
      possibleDuplicates: [],
      dedupCoverage: { lexical: 'complete', semantic: 'complete', degraded: false },
    };
    const applyTier = (tier: 'trimmed' | 'standard' | 'full') =>
      applyPayloadTier({
        toolName: 'improvements:capture',
        shape: captureTool.shape,
        response: { data: original } as never,
        tier,
        args: {},
      }).data as Record<string, any>;

    const trimmed = applyTier('trimmed');
    const standard = applyTier('standard');
    const full = applyTier('full');

    expect(trimmed).toMatchObject({ ok: true, created: true, kind: 'bug', issue: {
      id: 'EI-42', kind: 'bug', harness: 'papercusp', state: 'open', assignee: 'su-test',
    } });
    expect(trimmed.issue.title).toHaveLength(90);
    expect(trimmed.issue).not.toHaveProperty('summary');
    expect(trimmed.issue).not.toHaveProperty('payload');
    expect(JSON.stringify(trimmed).length).toBeLessThan(1_000);
    expect(standard.issue.title).toHaveLength(140);
    expect(full.issue.payload).toEqual(payload);
    expect(full.issue.summary).toHaveLength(4_000);
  });
});

function identity(source: ReturnType<typeof resolveAgentIdentity>['source'], ownerId = 'su-test') {
  return {
    ownerId,
    ownerLabel: `${source} · ${ownerId}`,
    source,
    workspaceId: 'ws-1',
    userId: null,
  } as ReturnType<typeof resolveAgentIdentity>;
}

function callTool(args: Record<string, unknown>, ctx: unknown = {}) {
  return (
    captureTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('improvements:capture degraded dedup alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainAdmission.blocked = false;
    drainAdmission.unavailable = false;
    mockReadTrustedHarnessTestRunProvenance.mockResolvedValue(null);
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-filer'));
  });

  it('publishes one advisory signal when a real capture proceeds with incomplete dedup coverage', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-42', title: 'dedup coverage test' },
      possibleDuplicates: [],
      dedupCoverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    await callTool(
      { title: 'dedup coverage test', kind: 'bug' },
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' },
    );

    expect(dedupAlarm.report).toHaveBeenCalledWith({
      source: 'improvements:capture',
      harnessSlug: 'papercusp',
      coverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
    });
  });

  it('preserves check-only exclusion and forwards complete coverage for measured recovery', async () => {
    mockCapture
      .mockResolvedValueOnce({
        ok: true,
        created: false,
        reason: 'check-only',
        possibleDuplicates: [],
        dedupCoverage: { lexical: 'unavailable', semantic: 'unavailable', degraded: true },
      } as unknown as Awaited<ReturnType<typeof captureImprovement>>)
      .mockResolvedValueOnce({
        ok: true,
        created: true,
        issue: { id: 'EI-43', title: 'complete dedup coverage test' },
        possibleDuplicates: [],
        dedupCoverage: { lexical: 'ok', semantic: 'ok', degraded: false },
      } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    await callTool(
      { title: 'dedup coverage check', kind: 'bug', checkDuplicatesOnly: true },
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' },
    );
    expect(dedupAlarm.report).not.toHaveBeenCalled();
    await callTool(
      { title: 'complete dedup coverage test', kind: 'bug' },
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' },
    );

    expect(dedupAlarm.report).toHaveBeenCalledOnce();
    expect(dedupAlarm.report).toHaveBeenCalledWith({
      source: 'improvements:capture', harnessSlug: 'papercusp',
      coverage: { lexical: 'ok', semantic: 'ok', degraded: false },
    });
  });
});

describe('improvements:capture timing diagnostics', () => {
  it('logs request-correlated stage timings, including late search completion, without capture text', async () => {
    vi.clearAllMocks();
    drainAdmission.blocked = false;
    drainAdmission.unavailable = false;
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-filer'));
    mockResolveSelfLiteral.mockImplementation((value, callerOwnerId) => (value === 'self' ? callerOwnerId : value));
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-42', title: 'private timing title' },
      reviewRequired: true,
      reviewState: 'blocked',
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    mockCaptureToolInvocationFriction.mockResolvedValue(null);
    mockEnterAgentReview.mockResolvedValue({
      entered: true,
      state: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'EI-42', round: 1 },
    });
    mockSetCaptureReviewState.mockImplementation(async (_id, state) => ({
      workItem: { id: 'EI-42', state },
      requestedState: state,
      appliedState: state,
    }));
    mockPriorArt.mockResolvedValue(undefined);
    mockRecordRoutedIdea.mockResolvedValue(undefined);

    const log = vi.fn();
    const privateText = 'private timing body sentinel';
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 1_000;
      return now;
    });
    try {
      await callTool(
        { title: 'private timing title', body: privateText, kind: 'feature' },
        {
          harnessSlug: 'papercusp',
          workspaceId: 'ws-1',
          requestOrigin: { mcpRequestTraceId: 'mcp-trace-for-capture-test' },
          log,
        },
      );
    } finally {
      clock.mockRestore();
    }

    const captureInput = mockCapture.mock.calls[mockCapture.mock.calls.length - 1]?.[0] as
      | { onDependencyTiming?: (sample: { dependency: string; elapsedMs: number; outcome: 'fulfilled' | 'rejected' }) => void }
      | undefined;
    captureInput?.onDependencyTiming?.({
      dependency: 'searchIssuesForDedup.pg-transaction',
      elapsedMs: 1_600,
      outcome: 'fulfilled',
    });

    const prefix = '[improvements:capture] timing ';
    const timingLines = log.mock.calls.map(([message]) => String(message)).filter((message) => message.startsWith(prefix));
    const line = timingLines[0];
    expect(line).toBeDefined();
    const timing = JSON.parse(line!.slice(prefix.length)) as {
      traceId: string;
      stages: Array<{ name: string; count: number; totalMs: number; maxMs: number; failures: number }>;
    };
    expect(timing.traceId).toBe('mcp-trace-for-capture-test');
    expect(timing.stages.map((stage) => stage.name)).toEqual(
      expect.arrayContaining([
        'wrapper.persist',
        'wrapper.routedIdeaProvenance',
        'wrapper.agentReview.enroll',
        'wrapper.agentReview.reopen',
        'wrapper.noveltyPriorArt',
        'wrapper.unresolvedRefs',
      ]),
    );
    const lateTiming = timingLines
      .map((entry) => JSON.parse(entry.slice(prefix.length)) as typeof timing)
      .find((entry) => entry.stages.some((stage) => stage.name === 'core.searchIssuesForDedup.pg-transaction'));
    expect(lateTiming?.traceId).toBe('mcp-trace-for-capture-test');
    expect(timingLines.join('\n')).not.toContain(privateText);
    expect(timingLines.join('\n')).not.toContain('private timing title');
  });
});

describe('improvements:capture tool envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainAdmission.blocked = false;
    drainAdmission.unavailable = false;
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockResolveSelfLiteral.mockImplementation((value, callerOwnerId) => (value === 'self' ? callerOwnerId : value));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockCaptureToolInvocationFriction.mockResolvedValue(null);
  });

  it('opts out of the ambient workspace transaction while awaiting capture work (EI-20223628286146305)', () => {
    expect((captureTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('maps an omp-hook-session caller to source="su"', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-abc'));
    await callTool({ title: 'flaky lock hook', kind: 'bug' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'su', createdBy: 'su-abc' }));
  });

  it('resolves assign_to:"self" to the caller ownerId before persistence (EI-22710550330241133)', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-filer'));
    await callTool({ title: 'self-assigned filing', kind: 'bug', assign_to: 'self' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ assignee: 'su-filer' }));
  });

  it('derives a title before forwarding an ordinary body-only capture to the core (EI-22658735915306595)', async () => {
    const body = '\nbody-only capture subject\nfull reproduction details';
    const parsed = (captureTool.args as { parse: (value: unknown) => Record<string, unknown> }).parse({
      kind: 'bug',
      body,
    });

    await callTool(parsed);

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'body-only capture subject',
        body,
        kind: 'bug',
      }),
    );
  });

  it('forwards a bug reporter context to the core so its error can fold (unified-bug-pipeline P-011 / D-046)', async () => {
    const reportContext = {
      appVersion: '0.9.3',
      recentErrors: [{ message: 'TypeError: cannot read properties of undefined (reading "id")', source: 'renderer' }],
    };
    const parsed = (captureTool.args as { parse: (value: unknown) => Record<string, unknown> }).parse({
      kind: 'bug',
      title: 'board crashes on open',
      reportContext,
    });

    await callTool(parsed);

    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bug', reportContext }));
  });

  it('omits reportContext when the caller sent none, and refuses an unknown context field', async () => {
    await callTool({ title: 'no context', kind: 'bug' });
    expect(mockCapture.mock.calls[0]?.[0]).not.toHaveProperty('reportContext');

    const schema = captureTool.args as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse({ kind: 'bug', title: 't', reportContext: { screenshotBytes: 'data:image/png;base64,AAAA' } }).success).toBe(false);
  });

  it('maps a static-client caller to source="su"', async () => {
    mockIdentity.mockReturnValue(identity('static-client'));
    await callTool({ title: 'x', kind: 'bug' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'su' }));
  });

  it('maps every other identity tier (e.g. fleet-spawn / principal) to source="engineer"', async () => {
    for (const src of ['fleet-spawn', 'principal', 'signed-spawn', 'power-user-token'] as const) {
      mockCapture.mockClear();
      mockIdentity.mockReturnValue(identity(src));
      await callTool({ title: 'x', kind: 'change' });
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ source: 'engineer' }));
    }
  });

  it('adds a non-blocking staleCodeWarning for paths newer than the running build', async () => {
    const warning = 'ⓘ Possible STALE RUNTIME: packages/operator-core/lib/x.ts has a newer commit';
    stalenessHints.paths.mockResolvedValueOnce(warning);
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-stale', title: 'runtime report' },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    const result = await callTool({ title: 'runtime report', kind: 'change', paths: ['packages/operator-core/lib/x.ts'] });
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ body: warning }));
    expect(body.staleCodeWarning).toBe(warning);
    expect(stalenessHints.paths).toHaveBeenCalledWith(['packages/operator-core/lib/x.ts']);
  });

  it('separates caller-supplied target runtime from the filing endpoint and uses target SHA for staleness', async () => {
    const warning = 'ⓘ Possible STALE RUNTIME: target runtime is older than the tree';
    stalenessHints.paths.mockResolvedValueOnce(warning);

    await callTool(
      {
        title: 'target runtime report',
        kind: 'change',
        paths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
        observedRuntime: {
          sha: 'target-sha-3170',
          version: 'target-version',
          endpoint: 'http://127.0.0.1:3170',
          evidenceRef: 'run:target-1',
        },
      },
      { transport: 'mcp', requestOrigin: { transport: 'mcp', path: '/api/mcp', query: { harness: 'papercusp' } } },
    );

    const passed = mockCapture.mock.calls[0]![0] as {
      payloadExtra?: {
        runtimeProvenance?: {
          filingEndpointRuntime?: Record<string, unknown>;
          observedTargetRuntime?: Record<string, unknown>;
        };
        freshnessEnvelope?: Record<string, unknown>;
      };
    };
    expect(stalenessHints.paths).toHaveBeenCalledWith(
      ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
      expect.objectContaining({ deployedSha: expect.any(Function) }),
    );
    const stalenessOverride = stalenessHints.paths.mock.calls[0]?.[1] as unknown as {
      deployedSha?: () => string | null;
    };
    expect(stalenessOverride.deployedSha?.()).toBe('target-sha-3170');
    expect(passed.payloadExtra?.runtimeProvenance?.observedTargetRuntime).toMatchObject({
      sha: 'target-sha-3170',
      version: 'target-version',
      endpoint: 'http://127.0.0.1:3170',
      provenance: 'caller-supplied',
    });
    expect(passed.payloadExtra?.runtimeProvenance?.filingEndpointRuntime).toMatchObject({
      transport: 'mcp',
      requestOrigin: expect.objectContaining({ path: '/api/mcp' }),
    });
    expect(passed.payloadExtra?.runtimeProvenance?.filingEndpointRuntime?.sha).not.toBe('target-sha-3170');
    expect(passed.payloadExtra?.freshnessEnvelope).toMatchObject({
      observedSourceSha: 'target-sha-3170',
      observedRuntimeSha: 'target-sha-3170',
      reporterRuntimeVersion: 'target-version',
    });
  });

  it('uses only the normalized SHA from exact clean test-run provenance', async () => {
    mockReadTrustedHarnessTestRunProvenance.mockResolvedValueOnce({
      commitSha: 'trusted-target-sha',
      testRunIds: [41],
      workspaceId: 'ws-target',
      harnessSlug: 'papercusp',
      runGroupId: 'run-target',
      root: '/workspace/papercusp',
      filePaths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
    });

    await callTool({
      title: 'trusted target report',
      kind: 'change',
      paths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
      observedRuntime: {
        sha: 'caller-claimed-sha',
        testRunIds: [41],
        workspaceId: 'ws-target',
        harnessSlug: 'papercusp',
        runGroupId: 'run-target',
        root: '/workspace/papercusp',
        filePaths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
      },
    });

    expect(mockReadTrustedHarnessTestRunProvenance).toHaveBeenCalledWith({
      testRunIds: [41],
      workspaceId: 'ws-target',
      harnessSlug: 'papercusp',
      runGroupId: 'run-target',
      root: '/workspace/papercusp',
      filePaths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
    });
    const passed = mockCapture.mock.calls[0]![0] as { payloadExtra?: Record<string, any> };
    expect(passed.payloadExtra?.runtimeProvenance?.observedTargetRuntime).toMatchObject({
      sha: 'trusted-target-sha',
      provenance: 'trusted-test-run',
    });
    expect(passed.payloadExtra?.freshnessEnvelope?.observedSourceSha).toBe('trusted-target-sha');
    const stalenessOverride = stalenessHints.paths.mock.calls[0]?.[1] as unknown as {
      deployedSha?: () => string | null;
    };
    expect(stalenessOverride.deployedSha?.()).toBe('trusted-target-sha');
  });

  it('does not trust a caller SHA when exact test-run evidence is unavailable', async () => {
    await callTool({
      title: 'unverified target report',
      kind: 'change',
      paths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
      observedRuntime: {
        sha: 'caller-claimed-sha',
        testRunIds: [42],
        workspaceId: 'ws-target',
        harnessSlug: 'papercusp',
        runGroupId: 'run-target',
        root: '/workspace/papercusp',
        filePaths: ['packages/operator-core/lib/agent-tools/improvements/capture.ts'],
      },
    });

    expect(stalenessHints.paths).toHaveBeenCalledWith([
      'packages/operator-core/lib/agent-tools/improvements/capture.ts',
    ]);
    const passed = mockCapture.mock.calls[0]![0] as { payloadExtra?: Record<string, any> };
    expect(passed.payloadExtra?.runtimeProvenance?.observedTargetRuntime).toMatchObject({
      sha: 'caller-claimed-sha',
      provenance: 'unverified-test-run',
    });
    expect(passed.payloadExtra?.freshnessEnvelope).toBeUndefined();
  });

  it('rejects partial test-run provenance instead of silently treating it as a caller-only runtime', () => {
    const parsed = (captureTool.args as { safeParse: (value: unknown) => { success: boolean } }).safeParse({
      title: 'partial target evidence',
      observedRuntime: { sha: 'target-sha', testRunIds: [1], workspaceId: 'ws-target' },
    });
    expect(parsed.success).toBe(false);
  });

  it('publishes the conditional testRunIds prerequisite for observed runtime provenance', () => {
    const argsSchema = captureTool.args as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: {
        observedRuntime?: {
          description?: string;
          properties?: { testRunIds?: { description?: string } };
        };
      };
    };
    const observed = json.properties?.observedRuntime;
    const testRunIds = observed?.properties?.testRunIds?.description;

    expect(observed?.description).toContain('Caller-only form');
    expect(observed?.description).toContain('Trusted test-run form');
    expect(observed?.description).toContain('testRunIds plus every query field');
    expect(testRunIds).toContain('OPTIONAL for caller-only runtime evidence');
    expect(testRunIds).toContain('REQUIRED when any provenance query field is supplied');
    expect(testRunIds).toContain('all query fields must also be non-empty');

    expect(
      argsSchema.safeParse({ title: 'caller-only target evidence', observedRuntime: { sha: 'target-sha' } }).success,
    ).toBe(true);
    expect(
      argsSchema.safeParse({
        title: 'query without test-run evidence',
        observedRuntime: { sha: 'target-sha', workspaceId: 'ws-target' },
      }).success,
    ).toBe(false);
  });

  it('publishes conditional capture prerequisites for title/body/toolFailure and notExercised', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      'x-papercusp-call-constraint'?: string;
    };

    expect(json['x-papercusp-call-constraint']).toContain('at least one of title, body, or toolFailure');
    expect(json['x-papercusp-call-constraint']).toContain(
      'title is required when both body and toolFailure are omitted',
    );
    expect(json['x-papercusp-call-constraint']).toContain(
      'a non-empty observation.notExercised requires observation.rubricRef or the top-level rubricRef compatibility alias',
    );

    const argsSchema = captureTool.args as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(argsSchema.safeParse({ lane: 'observation', checkDuplicatesOnly: true }).success).toBe(false);
    expect(argsSchema.safeParse({ lane: 'observation', body: 'body-only capture' }).success).toBe(true);
    expect(
      argsSchema.safeParse({
        lane: 'observation',
        toolFailure: { toolName: 'facts:assert', message: 'invalid args' },
      }).success,
    ).toBe(true);
  });

  it('routes a one-off tool failure to correlated non-claimable probation', async () => {
    mockIdentity.mockReturnValue(identity('static-client', 'su-reporter'));
    await callTool({
      title: 'coord:send rejected a valid body',
      kind: 'bug',
      toolFailure: {
        toolName: 'coord:send',
        errorCode: 'invalid_args',
        status: 'error',
        message: 'invalid_args: body must be an array',
        schemaRevision: '42',
        fieldPath: 'body',
        runtimeVersion: 'codex-1.2.3',
      },
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'change',
        lane: 'observation',
        watchdogKey: expect.stringMatching(/^repeated-tool-error:coord:send:caller:/),
        payloadExtra: {
          toolFailureProbation: expect.objectContaining({
            state: 'probation',
            intendedKind: 'change',
            reporters: ['su-reporter'],
            correlationFingerprint: expect.stringContaining('coord:send|invalid_args|42|body|codex-1.2.3'),
          }),
        },
      }),
    );
  });

  it('separates incomplete ptool bootstrap causes using the reported field path', async () => {
    const prefix = 'SDK bootstrap failed before operator connection: ';
    await callTool({
      kind: 'bug',
      toolFailure: {
        toolName: 'ptool',
        errorCode: 'sdk_bootstrap_failed',
        message: `${prefix}repoLockName is not a function`,
      },
    });
    await callTool({
      kind: 'bug',
      toolFailure: {
        toolName: 'ptool',
        status: 'ENOSPC',
        fieldPath: '/tmp/pcv/fs-mutex-locks',
        message: `${prefix}ENOSPC while mkdir of a lock in /tmp/pcv/fs-mutex-locks.`,
      },
    });
    await callTool({
      kind: 'bug',
      toolFailure: {
        toolName: 'ptool',
        status: 'ENOSPC',
        fieldPath: '/tmp/pcv/fs-mutex-locks',
        message: `${prefix}ENOSPC while mkdir of a lock in /tmp/pcv/fs-mutex-locks.`,
      },
    });

    const rowKeys = mockCapture.mock.calls.map(([input]) => input.watchdogKey);
    expect(rowKeys[0]).toBe('repeated-tool-error:ptool:structural:md5-8627c9c6c1206235c21992a6dee757ef');
    expect(rowKeys[1]).toBe('tool-failure-signature:ptool:structural:enospc:tmp-pcv-fs-mutex-locks');
    expect(rowKeys[1]).not.toBe(rowKeys[0]);
    expect(rowKeys[2]).toBe(rowKeys[1]);
    const firstProbation = (mockCapture.mock.calls[0]?.[0].payloadExtra as Record<string, unknown>)
      ?.toolFailureProbation as Record<string, unknown>;
    const enospcProbation = (mockCapture.mock.calls[1]?.[0].payloadExtra as Record<string, unknown>)
      ?.toolFailureProbation as Record<string, unknown>;
    expect(firstProbation.watchdogKey).toBe(rowKeys[0]);
    expect(enospcProbation.watchdogKey).toBe(
      'repeated-tool-error:ptool:structural:md5-7a7a4b4cbc261d5b0c59a376c9fb3f1a',
    );
    expect(enospcProbation.watchdogKey).not.toBe(firstProbation.watchdogKey);
  });

  it('keeps distinct status-502 lock failures separate through the regular capture route', async () => {
    mockIdentity.mockReturnValue(identity('static-client', 'su-lock-filer'));
    const prefix = 'locks:acquire failed (502): read ECONNRESET while acquiring the file lock for ';
    const messages = [
      `${prefix}packages/operator-core/lib/agent-tools/locks/alpha.ts`,
      `${prefix}packages/operator-core/lib/agent-tools/locks/beta.ts`,
    ];
    const ctx = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };

    for (const message of messages) {
      await callTool({
        kind: 'bug',
        toolFailure: {
          toolName: 'locks:acquire',
          errorCode: 'ECONNRESET',
          status: '502',
          message,
        },
      }, ctx);
    }

    // 502 is not accepted by the narrower invocation-friction helper, so both
    // reports must fall through to captureImprovement with their own full-message key.
    expect(mockCaptureToolInvocationFriction).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(2);
    const inputs = mockCapture.mock.calls.map(([input]) => input as {
      watchdogKey?: string;
      payloadExtra?: { toolFailureProbation?: { watchdogKey?: string; messageFingerprint?: string | null } };
    });
    const rowKeys = inputs.map((input) => input.watchdogKey);
    expect(rowKeys[0]).toMatch(/^repeated-tool-error:locks:acquire:transient:md5-[a-f0-9]{32}$/);
    expect(rowKeys[1]).toMatch(/^repeated-tool-error:locks:acquire:transient:md5-[a-f0-9]{32}$/);
    expect(rowKeys[1]).not.toBe(rowKeys[0]);
    const probation = inputs.map((input) => input.payloadExtra?.toolFailureProbation);
    expect(probation[0]?.watchdogKey).toBe(rowKeys[0]);
    expect(probation[1]?.watchdogKey).toBe(rowKeys[1]);
    expect(probation[1]?.messageFingerprint).not.toBe(probation[0]?.messageFingerprint);
  });

  it('routes output-spill failures through the signature-aware subsystem writer (EI-25309649835141283)', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-spill-filer'));
    mockCaptureToolInvocationFriction
      .mockResolvedValueOnce({
        ok: true,
        created: true,
        issue: { id: 'EI-result-door', title: 'result-door failure' },
      } as unknown as Awaited<ReturnType<typeof captureToolInvocationFriction>>)
      .mockResolvedValueOnce({
        ok: true,
        created: false,
        reason: 'coalesced',
        issue: { id: 'EI-result-door', title: 'result-door failure' },
      } as unknown as Awaited<ReturnType<typeof captureToolInvocationFriction>>);

    const ctx = { workspaceId: 'ws-1', harnessSlug: 'papercusp' };
    await callTool({
      toolFailure: {
        toolName: 'facts:list',
        errorCode: 'output_spill_failed',
        message: 'the result-door could not persist its spill',
      },
    }, ctx);
    await callTool({
      toolFailure: {
        toolName: 'work_items:get',
        errorCode: 'output_spill_failed',
        message: 'the result-door could not persist its spill',
      },
    }, ctx);

    expect(mockCaptureToolInvocationFriction).toHaveBeenCalledTimes(2);
    expect(mockCaptureToolInvocationFriction.mock.calls.map(([input]) => input.failure.toolName)).toEqual([
      'facts:list',
      'work_items:get',
    ]);
    expect(mockCaptureToolInvocationFriction.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      ownerId: 'su-spill-filer',
      failure: { errorCode: 'output_spill_failed' },
    });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('preserves an explicit conditionKey when toolFailure wording changes (EI-22722288208033107)', async () => {
    const conditionKey = 'repeated-tool-error:sessions:read:structural:invalid-escape-string';
    const failure = (message: string) => ({
      toolName: 'sessions:read',
      errorCode: 'invalid_args',
      status: 'error',
      message,
      schemaRevision: '42',
      fieldPath: 'tail',
      runtimeVersion: 'codex-1.2.3',
    });

    await callTool({
      kind: 'bug',
      conditionKey,
      toolFailure: failure('invalid escape string in the first report'),
    });
    await callTool({
      kind: 'bug',
      conditionKey,
      toolFailure: failure('invalid escape string with revised context'),
    });

    expect(mockCapture.mock.calls.map(([input]) => input.watchdogKey)).toEqual([conditionKey, conditionKey]);
    const firstProbation = (mockCapture.mock.calls[0]?.[0].payloadExtra as Record<string, unknown>)
      ?.toolFailureProbation as Record<string, unknown>;
    const secondProbation = (mockCapture.mock.calls[1]?.[0].payloadExtra as Record<string, unknown>)
      ?.toolFailureProbation as Record<string, unknown>;
    expect(firstProbation.watchdogKey).not.toBe(conditionKey);
    expect(secondProbation.watchdogKey).not.toBe(conditionKey);
    expect(secondProbation.watchdogKey).not.toBe(firstProbation.watchdogKey);
  });

  it('derives bounded title/body text for the canonical toolFailure-only shorthand', async () => {
    await callTool({
      toolFailure: {
        toolName: 'coord:send',
        errorCode: 'invalid_args',
        status: 'error',
        message: 'body must be an array',
        schemaRevision: 'projected-tool-registry-v1:42',
        fieldPath: 'body',
        runtimeVersion: 'codex-1.2.3',
      },
    });

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'coord:send tool-call failure (invalid_args)',
        body: expect.stringContaining('Message: body must be an array'),
        kind: 'change',
        lane: 'observation',
      }),
    );
    const body = mockCapture.mock.calls[0]?.[0].body ?? '';
    expect(body.length).toBeLessThanOrEqual(16_000);
  });

  it('P-001 R-7 measures manual retry fields separately from already-derived incident prose', async () => {
    const requests = [
      { toolFailure: { ...metadataToolFailure } },
      { toolFailure: { ...metadataToolFailure } },
    ];
    for (const request of requests) {
      await callTool(captureTool.args.parse(request));
    }
    expect(mockCapture).toHaveBeenCalledTimes(requests.length);
    expect(requests.reduce((sum, request) => sum + Object.keys(request.toolFailure).length, 0))
      .toBe(metadataWorkflowTargets.retryIncidentFields.before);
    expect(requests.reduce((sum, request) =>
      sum + ['title', 'body'].filter((key) => Object.hasOwn(request, key)).length, 0))
      .toBe(metadataWorkflowTargets.retryIncidentNarratives.before);
    for (const [input] of mockCapture.mock.calls) {
      expect(input).toMatchObject({
        title: 'coord:send tool-call failure (invalid_args)',
        body: expect.stringContaining(`Message: ${metadataToolFailure.message}`),
        lane: 'observation',
        payloadExtra: {
          toolFailureProbation: {
            state: 'probation',
            class: 'caller',
            report: metadataToolFailure,
            reporters: ['su-test'],
          },
        },
      });
    }
    // This test measures the real parser/handler boundary, not persistence or
    // automatic invocation-ledger delivery. Same-row proof lives in capture-core.
  });

  it('files a reproduced server failure directly as claimable bug work', async () => {
    await callTool({
      title: 'terminal writer rejects a valid state',
      kind: 'bug',
      toolFailure: {
        toolName: 'work_items:complete',
        message: 'terminal writer rejected a valid state',
        reproduced: true,
      },
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        lane: undefined,
        payloadExtra: {
          toolFailureProbation: expect.objectContaining({ state: 'promoted', directEvidence: true }),
        },
      }),
    );
  });

  it('keeps a reproduced miss on an unseeded direct wrapper as caller-side observation', async () => {
    await callTool({
      toolFailure: {
        toolName: 'locks:list',
        message: 'The normalized direct wrapper tools.mcp__papercusp_su__locks_list was undefined, so attempting it raised a local TypeError before MCP dispatch. tools:find activated locks:list; no server-side locks:list call was made.',
        reproduced: true,
      },
    });
    expect(mockCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'change',
        lane: 'observation',
        payloadExtra: expect.objectContaining({
          toolFailureProbation: expect.objectContaining({ state: 'probation', class: 'caller' }),
        }),
      }),
    );
  });

  it('keeps legacy caller attestations in probation but accepts structured caller evidence', async () => {
    await callTool({
      toolFailure: {
        toolName: 'sessions:read',
        errorCode: 'invalid_args',
        message: 'invalid_args: tail too big — use 200',
        clearServerMismatch: true,
      },
    });
    expect(mockCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'bug',
        lane: 'observation',
        payloadExtra: {
          toolFailureProbation: expect.objectContaining({ state: 'probation' }),
        },
      }),
    );

    await callTool({
      toolFailure: {
        toolName: 'sessions:read',
        errorCode: 'invalid_args',
        message: 'invalid_args: documented tail=220 rejected as greater than 200',
        directEvidence: {
          kind: 'server-contract-mismatch',
          expected: 'the active schema documents tail <= 220',
          actual: 'the server rejects tail=220 against a maximum of 200',
        },
      },
    });
    expect(mockCapture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'bug',
        lane: undefined,
        body: expect.stringContaining('Direct evidence expected: the active schema documents tail <= 220'),
        payloadExtra: {
          toolFailureProbation: expect.objectContaining({ state: 'promoted', directEvidence: true }),
        },
      }),
    );
  });

  it('passes every arg + the resolved ownerId through to the core unchanged', async () => {
    mockIdentity.mockReturnValue(identity('static-client', 'su-owner'));
    await callTool({
      title: 'db-tooling friction',
      kind: 'change',
      body: 'repro steps',
      severity: 'major',
      subTopic: 'db-tooling',
      scope: 'harness:foo',
      foundDuring: 'WI-9',
      paths: ['a.ts', 'b.ts'],
      force: true,
      checkDuplicatesOnly: false,
      origin: 'drill',
    });
    expect(mockCapture).toHaveBeenCalledWith({
      title: 'db-tooling friction',
      kind: 'change',
      body: 'repro steps',
      severity: 'major',
      subTopic: 'db-tooling',
      scope: 'harness:foo',
      foundDuring: 'WI-9',
      paths: ['a.ts', 'b.ts'],
      force: true,
      checkDuplicatesOnly: false,
      requireCompleteDedupCoverage: false,
      origin: 'drill',
      createdBy: 'su-owner',
      // WI-2140701 (b): the concrete workspace the goal-provenance stamp resolves in.
      workspaceId: 'ws-1',
      source: 'su',
      reviewRequired: true,
      reviewHarness: 'foo',
      // The agent-facing door always arms the poor-rating disposition gate
      // (scorecard-poor-rating-disposition, owner-directed 2026-08-31).
      enforcePoorRatingDisposition: true,
    });
  });

  it('derives fail-closed dedup admission from live DRAIN mode for bugs only', async () => {
    mockGetModes.mockResolvedValueOnce([{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }] as Awaited<
      ReturnType<typeof getModes>
    >);
    await callTool({ title: 'direct drain blocker', kind: 'bug' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', requireCompleteDedupCoverage: true }),
    );
    expect(drainAdmission.gate).toHaveBeenCalledOnce();

    mockCapture.mockClear();
    mockGetModes.mockResolvedValueOnce([{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }] as Awaited<
      ReturnType<typeof getModes>
    >);
    await callTool({ title: 'drain bookkeeping change', kind: 'change' });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'change', requireCompleteDedupCoverage: false }),
    );
  });

  it('returns the exact flow and does not call capture-core when the DRAIN circuit is open', async () => {
    mockGetModes.mockResolvedValueOnce([{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }] as Awaited<
      ReturnType<typeof getModes>
    >);
    drainAdmission.blocked = true;
    const res = await callTool(
      { title: 'would grow the drain queue', kind: 'bug' },
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' },
    );
    expect(mockCapture).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      ok: false,
      created: false,
      error: 'drain_flow_circuit_open',
      drainFlow: { exact: true, totals: { opened: 1, terminaled: 0, net: 1 } },
    });
  });

  it('keeps checkDuplicatesOnly available without persistence while the DRAIN circuit is open', async () => {
    mockGetModes.mockResolvedValueOnce([{ mode: 'drain', setAt: '2026-08-13T08:00:00.000Z' }] as Awaited<
      ReturnType<typeof getModes>
    >);
    drainAdmission.blocked = true;
    await callTool(
      { title: 'probe duplicate coverage', kind: 'bug', checkDuplicatesOnly: true },
      { harnessSlug: 'papercusp', workspaceId: 'ws-1' },
    );
    expect(drainAdmission.gate).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ checkDuplicatesOnly: true }));
  });

  it('normalizes the common top-level harness spelling to the canonical capture scope', async () => {
    await callTool({ title: 'scoped capture', kind: 'bug', harness: 'papercusp' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ scope: 'harness:papercusp' }));
  });

  it('rejects conflicting canonical scope and harness alias values', async () => {
    await expect(
      callTool({ title: 'conflicting scope', kind: 'bug', scope: 'harness:one', harness: 'two' }),
    ).rejects.toThrow(/conflicting capture scopes/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  // EI-20309391070582534 (+3 sibling filings the same day): the same Pot named twice
  // used to bounce the WHOLE capture, so the finding was lost over a spelling.
  it('files a capture whose scope merely repeats the harness alias', async () => {
    const res = await callTool({ title: 'same pot twice', kind: 'bug', scope: 'papercusp', harness: 'papercusp' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ scope: 'harness:papercusp' }));
    expect(JSON.parse(res.content[0].text).warnings).toBeUndefined();
  });

  it('files a capture with a subject-area scope, and warns where it landed', async () => {
    const res = await callTool({ title: 'area scope', kind: 'bug', scope: 'coordination', harness: 'papercusp' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ scope: 'harness:papercusp' }));
    const warnings = JSON.parse(res.content[0].text).warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('coordination');
    expect(warnings[0]).toContain('harness:papercusp');
  });

  it('returns the core result verbatim for a non-observation filing', async () => {
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-42', created: true, duplicateOf: null } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    const res = await callTool({ title: 'x', kind: 'bug' });
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, id: 'EI-42', created: true, duplicateOf: null });
  });

  it('maps an unmatched watchdog identity conflict to a structured refusal', async () => {
    const conflict = Object.assign(new Error('A watchdog identity conflict could not be safely coalesced.'), {
      name: 'CaptureWatchdogIdentityConflictError',
      code: 'watchdog_identity_conflict',
      reason: 'no_compatible_winner',
      retryable: false,
      watchdogKey: 'tool-failure:work_items:get:23505',
      relatedIds: ['EI-41', 'EI-42'],
    });
    mockCapture.mockRejectedValueOnce(conflict);

    const res = await callTool({
      title: 'capture conflict',
      kind: 'bug',
      watchdogKey: 'tool-failure:work_items:get:23505',
    });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;

    expect(body).toEqual({
      ok: false,
      error: 'watchdog_identity_conflict',
      retryable: false,
      reason: 'no_compatible_winner',
      watchdogKey: 'tool-failure:work_items:get:23505',
      relatedIds: ['EI-41', 'EI-42'],
      message: 'A watchdog identity conflict could not be safely coalesced.',
    });
  });

  it('maps bounded database contention to a retryable timeout envelope', async () => {
    mockCapture.mockRejectedValueOnce(new OrgTxnTimeoutError('55P03', new Error('lock timeout')));

    const res = await callTool({ title: 'contention', kind: 'bug' });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;

    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
    });
    expect(body.message).toEqual(expect.stringContaining('retry now'));
  });

  it('preserves the retryable timeout envelope for PostgreSQL statement timeouts', async () => {
    mockCapture.mockRejectedValueOnce(new OrgTxnTimeoutError('57014', new Error('statement timeout')));

    const res = await callTool({ title: 'statement timeout', kind: 'bug' });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;

    expect(body).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '57014',
    });
    expect(body.message).toEqual(expect.stringContaining('retry now'));
  });

  it('returns a byte-identical plain success for fresh and folded unkeyed observations (P-008)', async () => {
    mockCapture.mockResolvedValueOnce({
      ok: true,
      created: true,
      issue: { id: 'EI-fresh' },
      possibleDuplicates: [],
      dedupCoverage: { lexical: 'available', semantic: 'available', degraded: false },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    const fresh = await callTool({ title: 'one recurring observation', lane: 'observation' });

    mockCapture.mockResolvedValueOnce({
      ok: true,
      created: false,
      reason: 'coalesced',
      issue: { id: 'EI-survivor' },
      coalescedOnto: {
        id: 'EI-survivor',
        repeatCount: 2,
        identity: 'derived',
        textDisposition: 'append-only',
        foldRule: 'co-signal',
      },
      possibleDuplicates: [{ id: 'EI-survivor', semantic: 'hard' }],
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    const folded = await callTool({ title: 'one recurring observation', lane: 'observation' });

    expect(fresh.content[0].text).toBe('{"ok":true}');
    expect(folded.content[0].text).toBe(fresh.content[0].text);
  });

  it('keeps keyed machine-emitter coalesce details visible', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: false,
      reason: 'coalesced',
      issue: { id: 'EI-standing' },
      coalescedOnto: { id: 'EI-standing', repeatCount: 9, identity: 'keyed' },
      possibleDuplicates: [],
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    const res = await callTool({
      title: 'queue depth remains above threshold',
      lane: 'observation',
      conditionKey: 'system:queue-depth',
    });

    expect(JSON.parse(res.content[0].text)).toMatchObject({
      reason: 'coalesced',
      coalescedOnto: { id: 'EI-standing', repeatCount: 9 },
    });
  });

  it('keeps explicit duplicate checks detailed even on the observation lane', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: false,
      reason: 'check-only',
      possibleDuplicates: [{ id: 'EI-existing', semantic: 'hard' }],
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);

    const res = await callTool({
      title: 'inspect this observation before filing',
      lane: 'observation',
      checkDuplicatesOnly: true,
    });

    expect(JSON.parse(res.content[0].text)).toMatchObject({
      reason: 'check-only',
      possibleDuplicates: [{ id: 'EI-existing', semantic: 'hard' }],
    });
  });
});

describe('improvements:capture — absence-shaped empty dedup gets a shipped-code recheck (EI-19390763763662489)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({
      ok: true,
      id: 'EI-new',
      created: true,
      possibleDuplicates: [],
      dedupCoverage: { lexical: 'ok', semantic: 'ok', degraded: false },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
  });

  async function bodyOf(args: Record<string, unknown>) {
    const response = await callTool(args);
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
  }

  it('reports what the empty result did NOT search and names the existing code-search surfaces', async () => {
    const body = await bodyOf({
      title: 'Add the missing offers reader',
      kind: 'change',
      body: 'There is no exported read helper for harness_shared.p2p_work_offers, so one must be built.',
    });

    expect(body.ok).toBe(true); // report-only: the capture still lands
    expect(body.shippedCodeSearch).toMatchObject({
      absencePremises: [
        {
          claim: expect.stringContaining('no exported read helper'),
          recheck: expect.stringMatching(/whole repo/i),
        },
      ],
      note: expect.stringContaining('work-item-text'),
    });
    const note = (body.shippedCodeSearch as { note: string }).note;
    expect(note).toContain('NOT evidence');
    expect(note).toContain('rg');
    expect(note).toContain('graph:query');
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('also reports on checkDuplicatesOnly, before the caller turns the premise into implementation work', async () => {
    const body = await bodyOf({
      title: 'There is no watchdog for silent queue stalls',
      kind: 'change',
      checkDuplicatesOnly: true,
    });
    expect(body.shippedCodeSearch).toMatchObject({ absencePremises: [expect.any(Object)] });
  });

  it('stays absent for ordinary proposals, quoted errors, and a result that already names a duplicate', async () => {
    expect(
      'shippedCodeSearch' in
        (await bodyOf({ title: 'Extend the existing reader with one field', kind: 'change' })),
    ).toBe(false);
    expect(
      'shippedCodeSearch' in
        (await bodyOf({
          title: 'Improve the schema diagnostic',
          kind: 'bug',
          body: 'The tool returned `column "payload" does not exist`; keep that evidence visible.',
        })),
    ).toBe(false);

    mockCapture.mockResolvedValueOnce({
      ok: true,
      created: true,
      issue: { id: 'EI-duplicate' },
      dedupVerdict: 'likely-duplicate',
      possibleDuplicates: [{ id: 'EI-existing', title: 'The existing reader', state: 'open' }],
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    expect(
      'shippedCodeSearch' in
        (await bodyOf({
          title: 'Add the missing offers reader',
          kind: 'change',
          body: 'There is no exported read helper for the offers table.',
        })),
    ).toBe(false);
  });
});

describe('improvements:capture — conditionKey threads to watchdogKey (EI-15448)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it("lane:'observation' + conditionKey → passed through as watchdogKey", async () => {
    await callTool({
      title: 'escalation-aging holding flat at 312',
      lane: 'observation',
      conditionKey: 'overwatch:escalation-aging',
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ lane: 'observation', watchdogKey: 'overwatch:escalation-aging' }),
    );
  });

  it('conditionKey is also threaded to watchdogKey for ordinary improvement/bug captures', async () => {
    await callTool({ title: 'a real bug', kind: 'bug', conditionKey: 'overwatch:not-an-observation' });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ watchdogKey: 'overwatch:not-an-observation' }),
    );
  });

  it('omitting conditionKey on an observation leaves watchdogKey undefined (always re-files, per contract)', async () => {
    await callTool({ title: 'a one-off reading', lane: 'observation' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ lane: 'observation', watchdogKey: undefined }));
  });

  // EI-19325151590626958 — a rubric-graded SCORECARD is inherently recurring (it is auto-titled
  // from its rubricRef, so each emission mints a near-identical row). Measured: 823 + 490 filings,
  // ~1,162 still open, every one keyless — and keyless items escape dedup, aging AND auto-close.
  // The one-off contract pinned by the test above is deliberately preserved: the default applies
  // ONLY when a rubricRef is present.
  it('a rubric-graded observation DEFAULTS a scorecard conditionKey (rubric + hive)', async () => {
    await callTool({
      title: 'pot-coordination-health scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'pot-coordination-health',
        sourceHive: 'papercusp',
        ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: '12/12 lanes advanced' } },
      },
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ lane: 'observation', watchdogKey: 'scorecard:pot-coordination-health:papercusp' }),
    );
  });

  it('an EXPLICIT conditionKey still wins over the scorecard default', async () => {
    await callTool({
      title: 'pot-coordination-health scorecard',
      lane: 'observation',
      conditionKey: 'overwatch:my-own-key',
      observation: {
        rubricRef: 'pot-coordination-health',
        sourceHive: 'papercusp',
        ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'n/a' } },
      },
    });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ watchdogKey: 'overwatch:my-own-key' }));
  });

  it('DIFFERENT hives get DIFFERENT keys — a per-pot health signal must never overwrite its siblings', async () => {
    const keyFor = async (sourceHive: string): Promise<unknown> => {
      vi.clearAllMocks();
      await callTool({
        title: 'pot-coordination-health scorecard',
        lane: 'observation',
        observation: {
          rubricRef: 'pot-coordination-health',
          sourceHive,
          ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'n/a' } },
        },
      });
      return (mockCapture.mock.calls[0]?.[0] as { watchdogKey?: unknown }).watchdogKey;
    };
    expect(await keyFor('papercusp')).toBe('scorecard:pot-coordination-health:papercusp');
    expect(await keyFor('sb-devboard-hive')).toBe('scorecard:pot-coordination-health:sb-devboard-hive');
  });

  it('a rubricRef with NO resolvable hive stays KEYLESS rather than guessing a collapsing key', async () => {
    // ctx.harnessSlug is '*'/absent for an unscoped session, so sourceHive cannot be derived.
    // Keying on rubricRef alone would merge unrelated pots — strictly worse than the flood.
    await callTool({
      title: 'pot-coordination-health scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'pot-coordination-health',
        ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'n/a' } },
      },
    });
    const call = mockCapture.mock.calls[0]?.[0] as { watchdogKey?: unknown };
    expect(call.watchdogKey).toBeUndefined();
  });
});

describe('defaultScorecardConditionKey (EI-19325151590626958) — the pure derivation', () => {
  it('requires BOTH a rubricRef and a sourceHive', () => {
    expect(defaultScorecardConditionKey({ rubricRef: 'r', sourceHive: 'h' })).toBe('scorecard:r:h');
    expect(defaultScorecardConditionKey({ rubricRef: 'r' })).toBeUndefined();
    expect(defaultScorecardConditionKey({ sourceHive: 'h' })).toBeUndefined();
    expect(defaultScorecardConditionKey({})).toBeUndefined();
    expect(defaultScorecardConditionKey(undefined)).toBeUndefined();
  });

  it('is stable across calls (the whole point — a recurring reading must hash to one row)', () => {
    const a = defaultScorecardConditionKey({ rubricRef: 'pot-coordination-health', sourceHive: 'papercusp' });
    const b = defaultScorecardConditionKey({ rubricRef: 'pot-coordination-health', sourceHive: 'papercusp' });
    expect(a).toBe(b);
  });

  it('matches the shape the existing scorecard emitters already established', () => {
    // scorecard-emission-pulse / overwatch-scorecard-backstop use `scorecard-pulse:<hive>` and
    // `scorecard-backstop:<hive>` — rubric/emitter AND hive, never a bare rubric.
    expect(defaultScorecardConditionKey({ rubricRef: 'x', sourceHive: 'y' })).toMatch(/^scorecard:[^:]+:[^:]+$/);
  });
});

describe('deriveToolFailureCaptureText (WI-2146402) — title and body derive independently', () => {
  const toolFailure = {
    toolName: 'facts:assert',
    errorCode: 'invalid_args',
    message: 'Attempting to assert a scoped work-item fact without harness was rejected.',
    reproduced: true,
  } as const;

  it('derives a body from toolFailure even when the caller supplies its own title', () => {
    // This is the exact defect shape measured live: 23 of 24 permanently-empty
    // ungraded filings carried a custom title alongside a toolFailure report and no
    // body — the prior implementation discarded toolFailure entirely once title was
    // truthy, so the body was never derived.
    const { title, body } = deriveToolFailureCaptureText({
      title: 'facts:assert work-item scope requires shareable harness and settledBy fields',
      toolFailure,
    });
    expect(title).toBe('facts:assert work-item scope requires shareable harness and settledBy fields');
    expect(body).toBeTruthy();
    expect(body).toContain('facts:assert');
    expect(body).toContain(toolFailure.message);
  });

  it('still derives both title and body when neither is supplied (the original shorthand)', () => {
    const { title, body } = deriveToolFailureCaptureText({ toolFailure });
    expect(title).toContain('facts:assert');
    expect(body).toContain(toolFailure.message);
  });

  it('never overrides an explicitly supplied body', () => {
    const { title, body } = deriveToolFailureCaptureText({
      title: 'custom title',
      body: 'custom body',
      toolFailure,
    });
    expect(title).toBe('custom title');
    expect(body).toBe('custom body');
  });

  it('still throws when neither title nor toolFailure is supplied', () => {
    expect(() => deriveToolFailureCaptureText({})).toThrow(
      'improvements:capture requires title, body, or toolFailure',
    );
  });

  it('derives the title from the first non-empty body line for an ordinary body-only capture', () => {
    const body = '\nbody-only capture subject\nfull reproduction details';
    expect(deriveToolFailureCaptureText({ body })).toEqual({
      title: 'body-only capture subject',
      body,
    });
  });

  it('an explicit title with no toolFailure carries no derived body (unchanged, non-toolFailure path)', () => {
    const { title, body } = deriveToolFailureCaptureText({ title: 'plain title' });
    expect(title).toBe('plain title');
    expect(body).toBeUndefined();
  });
});

describe('improvements:capture — observation strict/fail-loud (P-012)', () => {
  // The tool's args zod is the strip-or-reject boundary (the handler-direct tests above bypass it).
  // `.strict()` on the observation object makes an UNKNOWN key a LOUD arg-parse error instead of a
  // silent strip — the silent strip dropped data live (su-2a0b4: an Overwatch scorecard against the
  // not-yet-deployed schema persisted scope-only, no error). Tested via the exposed args zod.
  const argsSchema = (
    captureTool as unknown as {
      args: { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: unknown[] } } };
    }
  ).args;

  it('accepts the documented structured toolFailure payload (EI-20242355653715593)', () => {
    const r = argsSchema.safeParse({
      title: 'improvements:capture rejected a tool failure report',
      kind: 'bug',
      toolFailure: {
        toolName: 'improvements:capture',
        errorCode: 'invalid_args',
        status: 'error',
        message: 'unrecognized key: toolFailure',
        schemaRevision: '7511ab5b86',
        fieldPath: 'toolFailure',
        runtimeVersion: 'operator-2026-08-12',
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toMatchObject({
        toolFailure: {
          toolName: 'improvements:capture',
          errorCode: 'invalid_args',
          fieldPath: 'toolFailure',
        },
      });
    }
  });

  it('validates inspectable direct evidence for caller-class overrides', () => {
    const accepted = argsSchema.safeParse({
      toolFailure: {
        toolName: 'sessions:read',
        errorCode: 'invalid_args',
        message: 'documented tail=220 was rejected',
        directEvidence: {
          kind: 'server-contract-mismatch',
          expected: 'tail <= 220',
          actual: 'tail > 200 rejected',
        },
      },
    });
    expect(accepted.success).toBe(true);

    const emptyEvidence = argsSchema.safeParse({
      toolFailure: {
        toolName: 'sessions:read',
        message: 'documented tail=220 was rejected',
        directEvidence: {
          kind: 'server-contract-mismatch',
          expected: '',
          actual: 'tail > 200 rejected',
        },
      },
    });
    expect(emptyEvidence.success).toBe(false);
  });

  it('coerces numeric toolFailure status codes to strings (EI-21444808398450659)', () => {
    const r = argsSchema.safeParse({
      title: 'numeric tool failure status',
      kind: 'bug',
      toolFailure: {
        toolName: 'work_items:complete',
        errorCode: 'invalid_args',
        status: 400,
        message: 'terminal writer rejected a numeric status',
      },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ toolFailure: { status: '400' } });
  });

  it('makes direct-evidence flag placement explicit and keeps the top-level shape invalid', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: { toolFailure?: { description?: string } };
    };
    expect(json.properties?.toolFailure?.description).toContain('toolFailure.reproduced');
    expect(json.properties?.toolFailure?.description).toContain('toolFailure.directEvidence');
    expect(json.properties?.toolFailure?.description).toContain('do not pass them at the top level');

    const misplaced = argsSchema.safeParse({
      title: 'misplaced reproduced flag',
      kind: 'bug',
      reproduced: true,
      toolFailure: { toolName: 'improvements:capture', message: 'direct reproduction' },
    });
    expect(misplaced.success).toBe(false);
    expect(JSON.stringify(misplaced.success ? [] : misplaced.error!.issues)).toContain('reproduced');
  });

  it('accepts toolFailure without duplicated title/body and rejects a truly empty call (P-002)', () => {
    const shorthand = argsSchema.safeParse({
      toolFailure: {
        toolName: 'improvements:capture',
        message: 'title was required even though the structured report was complete',
      },
    });
    expect(shorthand.success).toBe(true);
    expect(argsSchema.safeParse({}).success).toBe(false);
    expect(argsSchema.safeParse({ kind: 'bug' }).success).toBe(false);
  });

  it('accepts an ordinary body-only capture and leaves the body available for title derivation', () => {
    const body = '\nbody-only capture subject\nfull reproduction details';
    const parsed = argsSchema.safeParse({ kind: 'bug', body });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ kind: 'bug', body });
  });

  it('accepts a known observation (kind/scope/confidence/refs)', () => {
    const r = argsSchema.safeParse({
      title: 'friction note',
      lane: 'observation',
      observation: { kind: 'friction', scope: 'self', confidence: 'high', refs: ['tool:foo'] },
    });
    expect(r.success).toBe(true);
  });

  it('documents observation confidence separately from fact-registry confidence', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: {
        observation?: { properties?: { confidence?: { description?: string; enum?: string[] } } };
      };
    };
    const confidence = json.properties?.observation?.properties?.confidence;
    expect(confidence?.enum).toEqual(['low', 'med', 'high']);
    expect(confidence?.description).toContain('Evidence strength for this observation');
    expect(confidence?.description).toContain('verified/provisional/suspected');
    expect(confidence?.description).toContain('facts:assert');

    expect(argsSchema.safeParse({
      title: 'fact confidence is not observation confidence',
      lane: 'observation',
      observation: { confidence: 'verified' },
    }).success).toBe(false);
  });

  it('accepts a test-failure observation kind (EI-21565027021959535)', () => {
    const r = argsSchema.safeParse({
      title: 'test failure note',
      lane: 'observation',
      observation: { kind: 'test-failure', scope: 'self', confidence: 'high' },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a typed feedback revision link (rel='revises')", () => {
    const r = argsSchema.safeParse({
      title: 'revision incorporating grader feedback',
      kind: 'feature',
      observation: { linkTo: [{ targetId: 'EI-1', rel: 'revises' }] },
    });
    expect(r.success).toBe(true);
  });

  it('rejects top-level linkTo while accepting the nested dispatch shape (EI-21314316567182083)', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: {
        linkTo?: unknown;
        observation?: { properties?: { linkTo?: unknown } };
      };
    };
    expect(json.properties?.linkTo).toBeUndefined();
    expect(json.properties?.observation?.properties?.linkTo).toBeDefined();

    const misplaced = argsSchema.safeParse({
      title: 'top-level linkTo schema mismatch',
      kind: 'feature',
      linkTo: [{ targetId: 'EI-1', rel: 'revises' }],
    });
    expect(misplaced.success).toBe(false);
    expect(JSON.stringify(misplaced.success ? [] : misplaced.error!.issues)).toContain('linkTo');
  });

  it('teaches the nested home when top-level linkTo is attempted (EI-21490971340666010)', () => {
    expect(captureTool.guidance?.argRedirects?.linkTo).toBe('observation.linkTo');
  });

  it('routes the prose-carrying aliases to body rather than dead-ending (EI-20221816695899285)', () => {
    // Both are rejected by the strict schema — that part is correct and asserted here
    // so the redirect can never be mistaken for the key becoming accepted.
    for (const alias of ['description', 'evidence'] as const) {
      const parsed = argsSchema.safeParse({ title: `top-level ${alias}`, kind: 'bug', [alias]: 'the prose' });
      expect(parsed.success).toBe(false);
      expect(captureTool.guidance?.argRedirects?.[alias]).toBe('body');
    }
  });

  it('accepts a rubric-graded observation (rubricRef + ratings with evidence)', () => {
    const r = argsSchema.safeParse({
      title: 'scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'pot-coordination-health',
        ratings: { placement: { rating: 'healthy', evidence: '0 stalls this wake' } },
      },
    });
    expect(r.success).toBe(true);
  });

  it('accepts the legacy top-level rubric aliases instead of silently stripping a scorecard (EI-12176)', () => {
    const r = argsSchema.safeParse({
      title: 'legacy scorecard',
      lane: 'observation',
      rubricRef: 'pot-coordination-health',
      ratings: { placement: { rating: 'healthy', evidence: '0 stalls this wake' } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toMatchObject({
        rubricRef: 'pot-coordination-health',
        ratings: { placement: { rating: 'healthy', evidence: '0 stalls this wake' } },
      });
    }
  });

  it('REJECTS an unknown top-level field instead of returning ok after stripping it (EI-12176)', () => {
    const r = argsSchema.safeParse({
      title: 'mis-shaped capture',
      rubricReff: 'typo-must-fail-loud',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? [] : r.error!.issues)).toContain('rubricReff');
  });

  it('keeps provenance server-authored and documents the supported attribution paths (EI-20271029497680025)', () => {
    // Split across two guidance fields under P-011 prompt-weight pressure: the
    // PROHIBITION stays in `notWhen` (counted, and the caller must see it before
    // the call), while the longer attribution remedy moved to `seeAlso` (not
    // counted). Asserted per-field rather than over a concatenation, so a future
    // trim that drops the prohibition from the weighted half cannot be masked by
    // the free half still mentioning it.
    const guidance = captureTool.guidance as { notWhen?: string; seeAlso?: string[] };
    expect(guidance.notWhen).toMatch(/Never pass createdBy/);
    expect(guidance.notWhen).toMatch(/sourceRole/);
    const seeAlso = (guidance.seeAlso ?? []).join('\n');
    expect(seeAlso).toMatch(/assign_to:"self"/);
    expect(seeAlso).toMatch(/claims non-observation filings/);
    expect(seeAlso).toMatch(/lane:"observation" records are non-claimable sensor readings and ignore assign_to/);
    expect(seeAlso).toMatch(/observation\.refs/);

    const r = argsSchema.safeParse({
      title: 'caller-supplied provenance must fail loud',
      kind: 'bug',
      createdBy: 'spoofed-owner',
      sourceRole: 'Scout',
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? [] : r.error!.issues)).toContain('createdBy');
    expect(JSON.stringify(r.success ? [] : r.error!.issues)).toContain('sourceRole');
  });

  it('REJECTS an unknown observation field (was silently stripped — su-2a0b4) and names the key', () => {
    const r = argsSchema.safeParse({
      title: 'scorecard against a newer schema',
      lane: 'observation',
      observation: { kind: 'friction', bogusNewField: 'a field the deployed schema does not know' },
    });
    expect(r.success).toBe(false);
    // fail-loud: the rejection NAMES the unrecognized key (not a silent strip / no opaque pass)
    expect(JSON.stringify(r.success ? [] : r.error!.issues)).toContain('bogusNewField');
  });

  it('routes free-text observations to top-level body and rejects nested prose fields (EI-21310187819463956)', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: { observation?: { description?: string } };
    };
    expect(json.properties?.observation?.description).toMatch(/top-level body/i);
    expect(json.properties?.observation?.description).toMatch(/observation\.body is not a valid field/i);
    expect(json.properties?.observation?.description).toMatch(/observation\.evidence is not a valid field/i);
    expect(json.properties?.observation?.description).toMatch(/observation\.ratings\[criterion\]\.evidence/i);

    const misplacedBody = argsSchema.safeParse({
      title: 'free-text observation body routing',
      lane: 'observation',
      observation: { kind: 'friction', body: 'narrative evidence' },
    });
    expect(misplacedBody.success).toBe(false);
    expect(JSON.stringify(misplacedBody.success ? [] : misplacedBody.error!.issues)).toContain('body');

    const misplaced = argsSchema.safeParse({
      title: 'free-text observation evidence routing',
      lane: 'observation',
      observation: { kind: 'friction', evidence: 'narrative evidence' },
    });
    expect(misplaced.success).toBe(false);
    expect(JSON.stringify(misplaced.success ? [] : misplaced.error!.issues)).toContain('evidence');

    const correctlyPlaced = argsSchema.safeParse({
      title: 'free-text observation evidence routing',
      lane: 'observation',
      body: 'narrative evidence',
      observation: { kind: 'friction' },
    });
    expect(correctlyPlaced.success).toBe(true);
  });
});

/**
 * WI-1974 — improvements:capture (the self-improvement loop's OWN intake tool) failed
 * ~17% of calls, 29/34 on the top-level `kind` enum, and every reject LOSES the captured
 * insight. Live 48h failing-`kind` values: observation 18 · null 11 · process/tooling/
 * improvement/reliability/issue/tool-friction 9 · friction/gap 3. We coerce these to intent
 * BEFORE validation — never rejecting on `kind` — while leaving the DELIBERATE observation
 * `.strict()` key-rejection intact.
 */
describe('improvements:capture kind coercion (WI-1974)', () => {
  const parse = (x: unknown) => (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse(x);

  describe('coerceCaptureKind (unit)', () => {
    it('leaves a valid {bug,change,feature} kind untouched', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'bug' })).toEqual({ title: 't', kind: 'bug' });
    });

    it('case-normalises a valid kind (BUG → bug) instead of rejecting', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'BUG' })).toEqual({ title: 't', kind: 'bug' });
    });

    it('drops an explicit null kind so the schema default applies (the 11× null case)', () => {
      expect(coerceCaptureKind({ title: 't', kind: null })).toEqual({ title: 't' });
    });

    it("maps kind:'observation' → lane:'observation', dropping the bad kind (the 18× dominant case)", () => {
      expect(coerceCaptureKind({ title: 't', kind: 'observation' })).toEqual({ title: 't', lane: 'observation' });
    });

    it('maps an observation SUB-kind → lane:observation + observation.kind', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'friction' })).toEqual({
        title: 't',
        lane: 'observation',
        observation: { kind: 'friction' },
      });
    });

    it("maps kind:'test-failure' to the observation lane", () => {
      expect(coerceCaptureKind({ title: 't', kind: 'test-failure' })).toEqual({
        title: 't',
        lane: 'observation',
        observation: { kind: 'test-failure' },
      });
    });

    it('does not clobber a caller-provided observation.kind when mapping a sub-kind', () => {
      expect(coerceCaptureKind({ title: 't', kind: 'gap', observation: { kind: 'surprise', scope: 'self' } })).toEqual({
        title: 't',
        lane: 'observation',
        observation: { kind: 'surprise', scope: 'self' },
      });
    });

    it("maps a free-form label ('tooling','process','improvement','issue') → the default 'change'", () => {
      for (const label of ['tooling', 'process', 'improvement', 'reliability', 'issue', 'tool-friction']) {
        expect((coerceCaptureKind({ title: 't', kind: label }) as { kind: string }).kind).toBe('change');
      }
    });

    it('passes a non-object through untouched', () => {
      expect(coerceCaptureKind('x')).toBe('x');
      expect(coerceCaptureKind(null)).toBe(null);
    });
  });

  describe('through the real args schema (the wire shapes that 400ed now parse)', () => {
    it("kind:'observation' parses to lane:observation (was: kind Invalid option)", () => {
      const p = parse({ title: 'turn-end note', kind: 'observation' });
      expect(p.lane).toBe('observation');
      expect(p.kind).toBeUndefined();
    });

    it('kind:null parses (was: expected one of bug|change|feature)', () => {
      expect(() => parse({ title: 't', kind: null })).not.toThrow();
    });

    it('accepts the top-level harness compatibility alias and keeps the slug available to the handler', () => {
      const p = parse({ title: 'scoped bug', kind: 'bug', harness: 'papercusp' });
      expect(p.harness).toBe('papercusp');
    });

    it('an observation sub-kind parses to a lane:observation record', () => {
      const p = parse({ title: 'hit a gap', kind: 'gap' });
      expect(p.lane).toBe('observation');
      expect(p.observation).toMatchObject({ kind: 'gap' });
    });

    it("a free-form label parses as kind:'change'", () => {
      expect(parse({ title: 'flaky tool', kind: 'tooling' }).kind).toBe('change');
    });

    it('a well-formed kind:bug is unaffected', () => {
      expect(parse({ title: 't', kind: 'bug' }).kind).toBe('bug');
    });

    it('STILL fails loud on an unknown observation key (the deliberate .strict() is preserved)', () => {
      expect(() => parse({ title: 't', lane: 'observation', observation: { kind: 'friction', bogus: 1 } })).toThrow();
    });
  });

  it('the published tools/list JSON schema still advertises kind as the {bug,change,feature} enum', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: { kind?: { enum?: string[]; type?: string } };
    };
    expect(json.properties?.kind?.enum).toEqual(['bug', 'change', 'feature']);
  });
});

// EI-21601117899178959: the persisted/domain model names learning provenance
// `signalOrigin`, while improvements:capture historically exposed only the core's
// `origin` spelling. Keep the compatibility alias at the tool boundary and always
// forward the canonical field to capture-core.
describe('improvements:capture signalOrigin compatibility alias (EI-21601117899178959)', () => {
  const parse = (x: unknown) => (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse(x);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-origin'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-origin', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it('canonicalizes signalOrigin to origin before schema validation', () => {
    expect(coerceCaptureArgs({ title: 't', signalOrigin: 'drill' })).toEqual({ title: 't', origin: 'drill' });
  });

  it('accepts the domain-model spelling and exposes only canonical origin to the handler', () => {
    const parsed = parse({ title: 't', signalOrigin: 'replay' });
    expect(parsed).toMatchObject({ title: 't', origin: 'replay' });
    expect(parsed.signalOrigin).toBeUndefined();
  });

  it('accepts equal origin and signalOrigin values while retaining one canonical field', () => {
    expect(parse({ title: 't', origin: 'shadow', signalOrigin: 'shadow' })).toMatchObject({ origin: 'shadow' });
  });

  it('rejects conflicting origin and signalOrigin values loudly', () => {
    const result = (captureTool.args as { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } }).safeParse({
      title: 'conflicting provenance',
      origin: 'drill',
      signalOrigin: 'replay',
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? [] : result.error!.issues)).toContain('conflicting origin values');
  });

  it('forwards a raw signalOrigin alias when an in-process caller bypasses preprocessing', async () => {
    await callTool({ title: 'direct alias', kind: 'bug', signalOrigin: 'shadow' });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ origin: 'shadow' }));
  });

  it('rejects conflicting aliases before forwarding to capture-core', async () => {
    await expect(
      callTool({ title: 'conflicting direct aliases', kind: 'bug', origin: 'drill', signalOrigin: 'replay' }),
    ).rejects.toThrow('conflicting origin values');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('publishes signalOrigin as the documented compatibility enum', () => {
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: { signalOrigin?: { enum?: string[] } };
    };
    expect(json.properties?.signalOrigin?.enum).toEqual(['organic', 'drill', 'replay', 'shadow']);
  });
});

// EI-10424: an IDEATE-pass proposal left at kind:'change' (the ambiguous default)
// must be coerced into the reviewed kind:'feature' lane — never land as ordinary
// claimable change-work with no lane. Guard for the exact defect the bug reported.
describe('improvements:capture IDEATE-provenance coercion (EI-10424)', () => {
  const ideation = { lens: 'risk-first', bet: 'upside' };

  describe('coerceIdeateProvenance (unit)', () => {
    it("an ideation payload with kind omitted → kind:'feature'", () => {
      expect(coerceIdeateProvenance({ title: 't', ideation })).toEqual({ title: 't', ideation, kind: 'feature' });
    });

    it("an ideation payload with kind:'change' → kind:'feature'", () => {
      expect(coerceIdeateProvenance({ title: 't', kind: 'change', ideation })).toEqual({
        title: 't',
        kind: 'feature',
        ideation,
      });
    });

    it("foundDuring naming an ideate pass, no ideation payload → kind:'feature'", () => {
      expect(coerceIdeateProvenance({ title: 't', foundDuring: 'su-ideate pass 2026-07-12: memory frontier' })).toEqual(
        {
          title: 't',
          foundDuring: 'su-ideate pass 2026-07-12: memory frontier',
          kind: 'feature',
        },
      );
    });

    it('an unrelated foundDuring / no ideation signal is left untouched (stays change-default)', () => {
      expect(coerceIdeateProvenance({ title: 't', foundDuring: 'triaging the drain queue' })).toEqual({
        title: 't',
        foundDuring: 'triaging the drain queue',
      });
    });

    it("an EXPLICIT kind:'bug' found while ideating is never overridden (a real defect stays a bug)", () => {
      expect(coerceIdeateProvenance({ title: 't', kind: 'bug', foundDuring: 'su-ideate pass: audit' })).toEqual({
        title: 't',
        kind: 'bug',
        foundDuring: 'su-ideate pass: audit',
      });
    });

    it("lane:'observation' is never coerced (never enters the work queue regardless of kind)", () => {
      expect(coerceIdeateProvenance({ title: 't', lane: 'observation', ideation })).toEqual({
        title: 't',
        lane: 'observation',
        ideation,
      });
    });

    it('an empty ideation object (no lens/bet/cheapExperiment) is not a signal', () => {
      expect(coerceIdeateProvenance({ title: 't', ideation: {} })).toEqual({ title: 't', ideation: {} });
    });

    it('passes a non-object through untouched', () => {
      expect(coerceIdeateProvenance('x')).toBe('x');
    });
  });

  describe('through the real args schema — the exact EI-10424 defect shape', () => {
    const parse = (x: unknown) => (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse(x);

    it('an su-ideate capture with kind omitted parses to kind:feature, not the change default', () => {
      const p = parse({ title: 'idea', foundDuring: 'su-ideate: memory frontier', ideation });
      expect(p.kind).toBe('feature');
    });

    it('an su-ideate capture explicitly (mis)sent as kind:change is corrected to kind:feature', () => {
      const p = parse({ title: 'idea', kind: 'change', foundDuring: 'su-ideate: memory frontier', ideation });
      expect(p.kind).toBe('feature');
    });

    it('a genuine bug found during an ideate pass stays kind:bug (not coerced)', () => {
      const p = parse({ title: 'found a real bug', kind: 'bug', foundDuring: 'su-ideate pass: audit' });
      expect(p.kind).toBe('bug');
    });

    it('an ordinary change-work capture (no ideate provenance) is unaffected', () => {
      const p = parse({ title: 'bump a timeout', kind: 'change' });
      expect(p.kind).toBe('change');
    });
  });

  it('end-to-end: the coerced kind:feature makes the handler actually persist the ideation payload', async () => {
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    // Simulate the real wire path: parse through the schema (where coercion runs) THEN
    // hand the parsed args to the handler — callTool()/`.handler()` alone skips
    // z.preprocess, per the direct-handler tests above.
    const parsed = (captureTool.args as { parse: (v: unknown) => Record<string, unknown> }).parse({
      title: 'idea',
      foundDuring: 'su-ideate: memory frontier',
      ideation,
    });
    await callTool(parsed);
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ kind: 'feature', payloadExtra: { ideation } }));
  });
});

describe('improvements:capture — IDEATE-pass ideation persistence (su-ideate-learning-substrate P-007)', () => {
  const ideation = {
    lens: 'risk-first',
    bet: 'halves triage latency for su ideas',
    cheapExperiment: {
      hypothesis: 'triage decisions land twice as fast',
      method: 'measure one week of triage latency',
      falsifiableSignal: 'median triage latency unchanged',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it("persists the declared ideation onto the created item's payload (payloadExtra.ideation) for a feature capture", async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: { ideation } }));
  });

  it('drops absent fields instead of persisting undefined keys', async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation: { bet: 'upside only' } });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({ payloadExtra: { ideation: { bet: 'upside only' } } }),
    );
  });

  it('a non-feature kind never persists ideation (contract: ignored for non-feature kinds)', async () => {
    await callTool({ title: 'su idea', kind: 'change', ideation });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: undefined }));
  });

  it('lane:observation never persists ideation', async () => {
    await callTool({ title: 'su idea', kind: 'feature', lane: 'observation', ideation });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: undefined }));
  });

  it('an empty ideation object persists nothing (absence changes nothing, D-005)', async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation: {} });
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ payloadExtra: undefined }));
  });
});

// ---------------------------------------------------------------------------
// EI-10607 — THE GROUNDING LEG. Before this, no su-reachable verb could write
// `addresses_pattern_refs`: capture never passed it and blender:route-idea never took it
// (only Scout's internal router did). So observationsImpact.ideasGrounded/shipped were pinned
// at 0 BY CONSTRUCTION — 122 su ideas, 0 grounded, against Scout's 24/24 — and the zero read
// to every agent as an honest "no impact yet".
//
// The load-bearing guard is the LAST one: it proves the metric CAN MOVE. Asserting only that
// recordRoutedIdea was called with the field would pin the plumbing and still tell us nothing
// about whether the funnel it feeds can ever report a nonzero.
// ---------------------------------------------------------------------------
describe('improvements:capture — the su-ideate GROUNDING leg (EI-10607)', () => {
  const patternRef = 'wi:EI-10587';

  beforeEach(() => {
    vi.clearAllMocks();
    // capture.ts maps the identity tier to its `source` label: only omp-hook-session /
    // static-client resolve to 'su', and ONLY an 'su' source writes the ideate ledger row.
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-900', title: 'su idea' },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
  });

  it('records the declared pattern refs on the su-ideate ledger row', async () => {
    await callTool({
      title: 'su idea',
      kind: 'feature',
      ideation: { lens: 'risk-first', addressesPatternRefs: [patternRef] },
    });
    expect(mockRecordRoutedIdea).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'su-ideate', addressesPatternRefs: [patternRef] }),
    );
  });

  it('omits the key entirely when the caller grounds on nothing (row shape unchanged for an ungrounded filing)', async () => {
    await callTool({ title: 'su idea', kind: 'feature', ideation: { lens: 'risk-first' } });
    const arg = mockRecordRoutedIdea.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(arg).toBeDefined();
    expect('addressesPatternRefs' in arg).toBe(false);
  });

  it('THE METRIC CAN NOW MOVE: an idea filed with a citing pattern ref lands as `grounded` in observationsImpact — and without it, cannot', async () => {
    await callTool({
      title: 'su idea',
      kind: 'feature',
      ideation: { lens: 'risk-first', addressesPatternRefs: [patternRef] },
    });
    const written = mockRecordRoutedIdea.mock.calls[0][0] as {
      ideaId: string;
      routedRef: string;
      origin?: string;
      addressesPatternRefs?: string[];
    };

    // My observation, and the digest pattern whose exemplar ref cites it.
    const filings = [{ id: 'EI-10587', title: 'a recurring friction', filedAtMs: Date.now() }];
    const patterns = [{ ref: patternRef, summary: 'the pattern', category: 'capability-gap', weight: 0.67 }];
    const asLedgerRow = (refs: string[]) => ({
      ideaId: written.ideaId,
      routedRef: written.routedRef,
      origin: written.origin,
      outcome: 'won' as const,
      addressesPatternRefs: refs,
    });

    // Fed the row capture ACTUALLY writes, the funnel now reports the full arc.
    const after = computeObservationsImpact(filings, patterns, [asLedgerRow(written.addressesPatternRefs ?? [])]);
    expect(after.summary).toMatchObject({ filings: 1, surfacedAsPattern: 1, ideasGrounded: 1, shipped: 1 });
    expect(after.ideas[0]?.viaPatternRefs).toEqual([patternRef]);

    // The PRE-FIX row (capture wrote no refs) can never be counted, however good the idea —
    // this is the exact zero every su agent has been reading as "no impact yet".
    const before = computeObservationsImpact(filings, patterns, [asLedgerRow([])]);
    expect(before.summary).toMatchObject({ surfacedAsPattern: 1, ideasGrounded: 0, shipped: 0 });
  });
});

/**
 * P-008 (su-ideate-learning-substrate-2026-07-10): the REPORT-ONLY novelty
 * pre-check on the su kind:'feature' path. Pins the gate (su + feature +
 * improvement lane only), the response field semantics (array = checked, [] =
 * checked-and-clean, absent = not checked / check failed), and that a pre-check
 * failure NEVER fails the capture (D-005 — duplicate matching is annotation-only).
 */
describe('IDEATE-pass novelty pre-check (P-008 priorArt)', () => {
  const A_MATCH = [
    { kind: 'idea', ref: 'wi:EI-77', title: 'the same idea, already dropped', similarity: 0.83, state: 'dropped' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockPriorArt.mockResolvedValue([]);
  });

  async function bodyOf(args: Record<string, unknown>) {
    const res = await callTool(args);
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  }

  it("an su feature filing gets priorArt in the response, checked against the filing's title", async () => {
    mockPriorArt.mockResolvedValue(A_MATCH as Awaited<ReturnType<typeof noveltyPriorArt>>);
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(mockPriorArt).toHaveBeenCalledWith('a fresh su idea');
    expect(body.priorArt).toEqual(A_MATCH);
  });

  it('a clean check surfaces as priorArt: [] (checked, nothing similar) — distinct from absent', async () => {
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(body.priorArt).toEqual([]);
  });

  it('runs on a duplicate-annotated filing too (the collision report is MOST useful there)', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-5' },
      dedupVerdict: 'likely-duplicate',
    } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockPriorArt.mockResolvedValue(A_MATCH as Awaited<ReturnType<typeof noveltyPriorArt>>);
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    expect(body.priorArt).toEqual(A_MATCH);
  });

  it('non-feature kinds, the observation lane, and non-su callers are never checked', async () => {
    await callTool({ title: 'x', kind: 'change' });
    await callTool({ title: 'x', kind: 'bug' });
    await callTool({ title: 'x', kind: 'feature', lane: 'observation' });
    mockIdentity.mockReturnValue(identity('signed-spawn'));
    await callTool({ title: 'x', kind: 'feature' });
    expect(mockPriorArt).not.toHaveBeenCalled();
  });

  it('a pre-check failure NEVER fails the capture — the field is simply absent (report-only, D-005)', async () => {
    mockPriorArt.mockRejectedValue(new Error('corpus read exploded'));
    const body = await bodyOf({ title: 'a fresh su idea', kind: 'feature' });
    // P-007/D-010 added `experimentGap` to this same response, WI-38065 added
    // `lensAttribution`, and P-006/EI-10607 added `groundingGap` (this su filing declares
    // no cheapExperiment, no ideation.lens, and no addressesPatternRefs, so all three are
    // reported). Kept as a STRICT whole-body equality so a future field addition still has
    // to come through this assertion deliberately — which is exactly how WI-38065 and
    // P-006 were each caught here rather than silently widening it.
    expect(body).toEqual({
      ok: true,
      id: 'EI-1',
      created: true,
      experimentGap: { missing: ['hypothesis', 'method', 'falsifiableSignal'], note: expect.any(String) },
      lensAttribution: { sentinel: true, lenses: expect.any(Array), note: expect.any(String) },
      groundingGap: { note: expect.any(String) },
    });
    expect('priorArt' in body).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// gym-real-fitness-signal P-007 / D-010 — the cheapExperiment gap is REPORTED, never enforced.
//
// The load-bearing guards here are the NEGATIVE ones: that a kind:'feature' capture with no
// experiment still SUCCEEDS, and that the tool has no path to reject on this ground. P-007's
// R-2 originally proposed making the block required; that would have contradicted
// su-ideate-learning-substrate D-005 ("Enrich, never gate … no idea is too speculative to
// file"), and — measured 2026-08-08 — would have rejected ~2 of every 3 feature filings
// (21 of 66 post-schema su feature captures carry a complete block, not the 0.07% R-2 claimed
// from a whole-corpus denominator). Asserting only that the field APPEARS would pin the
// nudge while leaving the thing that actually matters — that nothing is ever lost — untested.
// ---------------------------------------------------------------------------
describe('improvements:capture — cheapExperiment gap is report-only (P-007/D-010)', () => {
  const complete = { hypothesis: 'h', method: 'm', falsifiableSignal: 's' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockPriorArt.mockResolvedValue([]);
  });

  async function bodyOf(args: Record<string, unknown>) {
    const res = await callTool(args);
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  }

  it('NEVER gates: a feature filing with no experiment is still captured, and reports the gap', async () => {
    const body = await bodyOf({ title: 'an unbettable idea', kind: 'feature' });
    // the idea LANDED — this is the D-005 guarantee, and the whole point of report-over-reject
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ title: 'an unbettable idea' }));
    expect(body.ok).toBe(true);
    expect(body.experimentGap).toEqual({
      missing: ['hypothesis', 'method', 'falsifiableSignal'],
      note: expect.stringContaining('not a rejection'),
    });
  });

  it('a COMPLETE experiment reports no gap at all (absent, not empty)', async () => {
    const body = await bodyOf({ title: 'a bettable idea', kind: 'feature', ideation: { cheapExperiment: complete } });
    expect('experimentGap' in body).toBe(false);
  });

  it('a PARTIAL experiment names only the fields actually missing', async () => {
    const body = await bodyOf({
      title: 'half a bet',
      kind: 'feature',
      ideation: { cheapExperiment: { hypothesis: 'h', method: 'm' } },
    });
    expect(body.experimentGap).toMatchObject({ missing: ['falsifiableSignal'] });
  });

  it('names the actual payload repair path for an existing item', async () => {
    const note = ((await bodyOf({ title: 'an unbettable idea', kind: 'feature' })).experimentGap as { note: string })
      .note;
    expect(note).toContain('work_items:update { id, payload: { ideation: { cheapExperiment:');
    expect(note).not.toContain('amend with ideation.cheapExperiment');
  });

  it('is scoped to where a supplied block would be PERSISTED — never other kinds or the observation lane', async () => {
    // capture.ts only stores ideation for kind:'feature' outside the observation lane, so
    // nudging anywhere else would demand a field the handler would discard anyway.
    expect('experimentGap' in (await bodyOf({ title: 'x', kind: 'change' }))).toBe(false);
    expect('experimentGap' in (await bodyOf({ title: 'x', kind: 'bug' }))).toBe(false);
    expect('experimentGap' in (await bodyOf({ title: 'x', kind: 'feature', lane: 'observation' }))).toBe(false);
  });

  it('reports on a duplicate-annotated filing too — the filer sees the advisory with the accepted row', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-5' },
      dedupVerdict: 'likely-duplicate',
    } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    const body = await bodyOf({ title: 'a dup', kind: 'feature' });
    expect(body.experimentGap).toMatchObject({ missing: ['hypothesis', 'method', 'falsifiableSignal'] });
  });

  it('CONTROL — a missing experiment is never itself a failure reason (falsifies "gate crept back in")', async () => {
    // A gate would surface as ok:false / an error / an uncalled core. This is the assertion
    // that fails if anyone later "tightens" the nudge into a rejection.
    const res = await callTool({ title: 'no experiment here', kind: 'feature' });
    const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });
});

describe('improvements:capture — lens attribution is report-only (WI-38065)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only an 'su' source writes the su-ideate ledger row, so only an su source has a lens
    // to attribute — the advisory is scoped to match.
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-900', title: 'su idea' },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
    mockPriorArt.mockResolvedValue([]);
  });

  async function bodyOf(args: Record<string, unknown>, ctx: unknown = {}) {
    const res = await callTool(args, ctx);
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  }

  it('reports the sentinel when an su feature filing declares no lens — and still files it', async () => {
    const body = await bodyOf({ title: 'an unlensed idea', kind: 'feature' });
    // It LANDED. Report-over-reject is the whole contract here.
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ title: 'an unlensed idea' }));
    expect(body.ok).toBe(true);
    expect(body.lensAttribution).toMatchObject({
      sentinel: true,
      note: expect.stringContaining('not a rejection'),
    });
    // The advisory must OFFER the vocabulary — a nudge the filer cannot act on without a
    // second lookup is most of the reason the pre-existing arg guidance was losing.
    expect((body.lensAttribution as { lenses: string[] }).lenses).toContain('risk-first');
  });

  it('the row it describes really did get the sentinel — the advisory is not decorative', async () => {
    await callTool({ title: 'an unlensed idea', kind: 'feature' });
    expect(mockRecordRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ lens: 'su-ideate' }));
  });

  it('a DECLARED lens reports nothing at all (absent, not empty) and is stamped on the row', async () => {
    const body = await bodyOf({ title: 'a lensed idea', kind: 'feature', ideation: { lens: 'risk-first' } });
    expect('lensAttribution' in body).toBe(false);
    expect(mockRecordRoutedIdea).toHaveBeenCalledWith(expect.objectContaining({ lens: 'risk-first' }));
  });

  it('is scoped exactly to the filings that GET a ledger row — never other kinds or the observation lane', async () => {
    expect('lensAttribution' in (await bodyOf({ title: 'x', kind: 'change' }))).toBe(false);
    expect('lensAttribution' in (await bodyOf({ title: 'x', kind: 'bug' }))).toBe(false);
    expect('lensAttribution' in (await bodyOf({ title: 'x', kind: 'feature', lane: 'observation' }))).toBe(false);
  });

  it('is scoped to an su SOURCE — a non-su caller writes no ledger row, so has no lens to attribute', async () => {
    // capture.ts:546 maps ONLY omp-hook-session / static-client to source 'su'; every other
    // IdentitySource resolves to 'engineer' and writes no su-ideate row.
    mockIdentity.mockReturnValue(identity('power-user-token'));
    const body = await bodyOf({ title: 'x', kind: 'feature' });
    expect('lensAttribution' in body).toBe(false);
    // Pin WHY it is absent — no ledger row was written, so there was no lens to attribute.
    // Without this the assertion would also pass if the advisory silently stopped firing.
    expect(mockRecordRoutedIdea).not.toHaveBeenCalled();
  });

  it('reports on a duplicate-annotated filing too — the filer sees the advisory with the accepted row', async () => {
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-5' },
      dedupVerdict: 'likely-duplicate',
    } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    expect((await bodyOf({ title: 'a dup', kind: 'feature' })).lensAttribution).toMatchObject({ sentinel: true });
  });

  it('CONTROL — an omitted lens is never itself a failure reason (falsifies "gate crept in")', async () => {
    // capture.ts documents the ideation block as "Never a gate: purely additive", and WI-38065
    // deliberately did NOT overturn that. A gate would surface as ok:false / an error / an
    // uncalled core. This is the assertion that fails if anyone later "tightens" this advisory
    // into a rejection or a required arg.
    const body = await bodyOf({ title: 'no lens here', kind: 'feature' });
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockRecordRoutedIdea).toHaveBeenCalledTimes(1);
  });

  // ── P-005 (system-notices-on-its-own-2026-08-16): the note states a MECHANISM, never a rate ──
  //
  // The note used to assert "Two thirds of su filings currently land this way". That number was
  // measured once (41/62 on 2026-08-12) and then hardcoded into a user-facing string, where it
  // could not be re-measured — so it kept asserting the PRE-FIX rate at every filer for exactly
  // as long as this advisory succeeded at lowering it. Re-measured 2026-08-16 the real rate was
  // 42.6% and falling (weekly 100 → 81 → 72 → 67 → 43), i.e. the sentence was simply false, and
  // false in the direction that overstates the problem the advisory is arguing about.
  //
  // A corpus statistic belongs in the module comment, dated and beside its query. These pin that
  // it stays out of the string a filer reads.
  it('the note carries no hardcoded population statistic — those decay silently', async () => {
    const body = await bodyOf({ title: 'an unlensed idea', kind: 'feature' });
    const note = (body.lensAttribution as { note: string }).note;
    expect(note).not.toMatch(/\b\d{1,3}(\.\d+)?\s*%/); // "43%", "42.6 %"
    expect(note).not.toMatch(/\b(two[- ]thirds|a third|half|most|majority)\s+of\s+(su\s+)?filings/i);
    expect(note).not.toMatch(/\b\d+\s+of\s+\d+\b/); // "41 of 62"
  });

  it('CALIBRATION — the matchers above really do catch the sentence that was there', () => {
    // Without this, the assertions could pass because the patterns match nothing at all.
    const removed =
      'it cannot be kept alive by the diversity floor. Two thirds of su filings currently land ' +
      'this way, which means that learning runs on a minority of the corpus.';
    expect(removed).toMatch(/\b(two[- ]thirds|a third|half|most|majority)\s+of\s+(su\s+)?filings/i);
    expect('the sentinel was 41 of 62 (66%)').toMatch(/\b\d{1,3}(\.\d+)?\s*%/);
    expect('the sentinel was 41 of 62').toMatch(/\b\d+\s+of\s+\d+\b/);
  });

  it('still tells the filer the CONSEQUENCE and the repair — trimming the stat kept the substance', async () => {
    const note = ((await bodyOf({ title: 'an unlensed idea', kind: 'feature' })).lensAttribution as { note: string })
      .note;
    expect(note).toContain('su-ideate');
    expect(note).toMatch(/excluded from every per-lens statistic/i);
    expect(note).toMatch(/diversity floor/i);
    expect(note).toMatch(/ideation\.lens/);
    expect(note).toContain('work_items:update { id, payload: { ideation: { lens:');
    expect(note).not.toContain('amend with `ideation.lens`');
  });

  // ── P-006 (blender-loop-repair-and-opus5-xhigh-2026-08-16) / EI-10607: groundingGap ──
  // Same report-only shape as lensAttribution, for the OTHER ideation field nobody passed:
  // addressesPatternRefs. Shares this block's su-source setup deliberately — the advisory's
  // eligibility must track the ledger row's exactly.
  describe('groundingGap (addressesPatternRefs advisory)', () => {
    it('reports when an su feature filing declares no pattern refs — and still files it', async () => {
      const body = await bodyOf({ title: 'an ungrounded idea', kind: 'feature' });
      expect(body.ok).toBe(true);
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect((body.groundingGap as { note: string }).note).toContain('not a rejection');
      // The nudge must name the exact repair — field AND where the refs come from.
      expect((body.groundingGap as { note: string }).note).toMatch(/ideation\.addressesPatternRefs/);
      expect((body.groundingGap as { note: string }).note).toMatch(/observationsImpact\.patterns\[\]\.ref/);
      expect((body.groundingGap as { note: string }).note).toContain(
        'work_items:update { id, payload: { ideation: { addressesPatternRefs:',
      );
    });

    it('DECLARED refs report nothing (absent, not empty) and land on the ledger row', async () => {
      const body = await bodyOf({
        title: 'a grounded idea',
        kind: 'feature',
        ideation: { addressesPatternRefs: ['wi:EI-10587'] },
      });
      expect('groundingGap' in body).toBe(false);
      expect(mockRecordRoutedIdea).toHaveBeenCalledWith(
        expect.objectContaining({ addressesPatternRefs: ['wi:EI-10587'] }),
      );
    });

    it('is scoped exactly to the filings that GET a ledger row', async () => {
      expect('groundingGap' in (await bodyOf({ title: 'x', kind: 'change' }))).toBe(false);
      expect('groundingGap' in (await bodyOf({ title: 'x', kind: 'bug' }))).toBe(false);
      expect('groundingGap' in (await bodyOf({ title: 'x', kind: 'feature', lane: 'observation' }))).toBe(false);
    });

    it('carries no hardcoded population statistic — those decay silently (house rule above)', async () => {
      const note = ((await bodyOf({ title: 'an ungrounded idea', kind: 'feature' })).groundingGap as { note: string })
        .note;
      expect(note).not.toMatch(/\b\d{1,3}(\.\d+)?\s*%/);
      expect(note).not.toMatch(/\b\d+\s+of\s+\d+\b/);
    });

    it('CONTROL — omitted refs are never a failure reason (falsifies "gate crept in")', async () => {
      const body = await bodyOf({ title: 'no refs here', kind: 'feature' });
      expect(body.ok).toBe(true);
      expect(body.error).toBeUndefined();
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(mockRecordRoutedIdea).toHaveBeenCalledTimes(1);
    });
  });
});

describe('improvements:capture — gradedGeneration stamp (EI-12147)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-abc'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-9', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  const passedObservation = () =>
    (mockCapture.mock.calls[0]![0] as { payloadExtra?: { observation?: Record<string, unknown> } }).payloadExtra
      ?.observation;

  it('stamps a rubric SCORECARD (rubricRef + ratings) with the running generation, server-side', async () => {
    await callTool({
      title: 'release scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'blender-release-readiness',
        ratings: { 'cycle-error-rate': { rating: 'pass', evidence: '0/8 post-watermark' } },
      },
    });
    expect(passedObservation()?.gradedGeneration).toEqual({
      sha: 'abc1234',
      hostStartedAt: '2026-07-14T18:21:25.000Z',
    });
  });

  it('normalizes legacy top-level rubric aliases into the canonical observation payload (EI-12176)', async () => {
    await callTool({
      title: 'legacy release scorecard',
      lane: 'observation',
      rubricRef: 'blender-release-readiness',
      ratings: { 'cycle-error-rate': { rating: 'pass', evidence: '0/8 post-watermark' } },
    });
    expect(passedObservation()).toMatchObject({
      rubricRef: 'blender-release-readiness',
      ratings: { 'cycle-error-rate': { rating: 'pass', evidence: '0/8 post-watermark' } },
      gradedGeneration: {
        sha: 'abc1234',
        hostStartedAt: '2026-07-14T18:21:25.000Z',
      },
    });
  });

  it('coalesces equivalent nested and compatibility-alias ratings into the canonical observation payload', async () => {
    await callTool({
      title: 'scorecard with repeated ratings aliases',
      lane: 'observation',
      rubricRef: 'blender-release-readiness',
      ratings: { 'cycle-error-rate': { evidence: '0/8 post-watermark', rating: 'pass' } },
      observation: {
        rubricRef: 'blender-release-readiness',
        ratings: { 'cycle-error-rate': { rating: 'pass', evidence: '0/8 post-watermark' } },
      },
    });
    expect(passedObservation()).toMatchObject({
      rubricRef: 'blender-release-readiness',
      ratings: { 'cycle-error-rate': { rating: 'pass', evidence: '0/8 post-watermark' } },
    });
  });

  it('rejects conflicting nested and compatibility-alias ratings loudly', async () => {
    await expect(
      callTool({
        title: 'conflicting scorecard ratings',
        lane: 'observation',
        rubricRef: 'blender-release-readiness',
        ratings: { 'cycle-error-rate': { rating: 'pass', evidence: '0/8 post-watermark' } },
        observation: {
          rubricRef: 'blender-release-readiness',
          ratings: { 'cycle-error-rate': { rating: 'broken', evidence: '8/8 failures' } },
        },
      }),
    ).rejects.toThrow(/conflicting ratings values/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('rejects conflicting nested and compatibility-alias rubric values loudly', async () => {
    await expect(
      callTool({
        title: 'conflicting scorecard',
        lane: 'observation',
        rubricRef: 'legacy-ref',
        observation: {
          rubricRef: 'canonical-ref',
          ratings: { k: { rating: 'healthy', evidence: 'measured' } },
        },
      }),
    ).rejects.toThrow(/conflicting rubricRef values/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('does NOT stamp a plain (non-rubric) observation — the stamp is scorecard identity, not ambient metadata', async () => {
    await callTool({
      title: 'a plain reflection',
      lane: 'observation',
      observation: { kind: 'friction', refs: ['tool:foo'] },
    });
    expect(passedObservation()).toBeDefined();
    expect(passedObservation()?.gradedGeneration).toBeUndefined();
  });

  it('a caller CANNOT supply gradedGeneration (strict schema rejects) — provenance stays server-authored', () => {
    const schema = (captureTool as unknown as { args: { safeParse: (v: unknown) => { success: boolean } } }).args;
    const r = schema.safeParse({
      title: 'forged stamp',
      lane: 'observation',
      observation: {
        rubricRef: 'r',
        ratings: { k: { rating: 'pass', evidence: 'e' } },
        gradedGeneration: { sha: 'deadbeef', hostStartedAt: '2020-01-01T00:00:00Z' },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('improvements:capture — notExercised shorthand (rubric-system-improvements P-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-abc'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-9', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it('expands each listed key to an idle:-tagged unknown and strips the shorthand from the stored observation', async () => {
    await callTool({
      title: 'scoped drill scorecard',
      lane: 'observation',
      observation: {
        rubricRef: 'su-agent-behavior',
        ratings: { 'recall-utilization': { rating: 'pass', evidence: 'one targeted search' } },
        notExercised: ['fleet-stewardship', 'engineering-discipline'],
      },
    });
    const passed = mockCapture.mock.calls[0]![0] as {
      payloadExtra?: {
        observation?: { ratings?: Record<string, { rating: string; evidence: string }>; notExercised?: unknown };
      };
    };
    const obs = passed.payloadExtra?.observation;
    expect(obs?.notExercised).toBeUndefined(); // stripped — stored payload stays pure ratings
    expect(obs?.ratings?.['recall-utilization']).toEqual({ rating: 'pass', evidence: 'one targeted search' });
    expect(obs?.ratings?.['fleet-stewardship']).toEqual({
      rating: 'unknown',
      evidence: 'idle: not exercised by this run.',
    });
    expect(obs?.ratings?.['engineering-discipline']).toEqual({
      rating: 'unknown',
      evidence: 'idle: not exercised by this run.',
    });
  });

  it('an explicit rating for a key ALSO listed in notExercised wins over the expansion', async () => {
    await callTool({
      title: 'conflicting shorthand',
      lane: 'observation',
      observation: {
        rubricRef: 'r',
        ratings: { wake: { rating: 'degraded', evidence: 'real signal' } },
        notExercised: ['wake'],
      },
    });
    const passed = mockCapture.mock.calls[0]![0] as {
      payloadExtra?: { observation?: { ratings?: Record<string, { rating: string; evidence: string }> } };
    };
    expect(passed.payloadExtra?.observation?.ratings?.wake).toEqual({ rating: 'degraded', evidence: 'real signal' });
  });

  it('rejects notExercised without a rubric at the shorthand boundary', async () => {
    await expect(
      callTool({
        title: 'release-gate friction',
        lane: 'observation',
        observation: {
          kind: 'friction',
          notExercised: ['Whether the gate failure was related was not established.'],
        },
      }),
    ).rejects.toThrow(/observation\.notExercised.*requires.*rubricRef/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('accepts notExercised when the rubric uses the top-level compatibility alias', async () => {
    await callTool({
      title: 'legacy scoped scorecard',
      lane: 'observation',
      rubricRef: 'r',
      observation: { notExercised: ['wake'] },
    });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        payloadExtra: expect.objectContaining({
          observation: expect.objectContaining({
            rubricRef: 'r',
            ratings: { wake: { rating: 'unknown', evidence: 'idle: not exercised by this run.' } },
          }),
        }),
      }),
    );
  });

  it('the args schema accepts notExercised (strict observation object knows the key)', () => {
    const argsSchema = (
      captureTool as unknown as {
        args: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).args;
    const r = argsSchema.safeParse({
      title: 'scoped scorecard',
      lane: 'observation',
      observation: { rubricRef: 'r', ratings: { a: { rating: 'pass', evidence: 'e' } }, notExercised: ['b'] },
    });
    expect(r.success).toBe(true);
  });

  it('publishes the conditional rubric prerequisite without making free-text observations require a rubric', () => {
    const argsSchema = (
      captureTool as unknown as {
        args: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).args;
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: {
        rubricRef?: { description?: string };
        observation?: {
          required?: string[];
          properties?: {
            rubricRef?: { description?: string };
            notExercised?: { description?: string };
          };
        };
      };
    };

    expect(json.properties?.observation?.properties?.notExercised?.description).toMatch(
      /non-empty.*observation\.rubricRef.*top-level rubricRef compatibility alias/i,
    );
    expect(json.properties?.observation?.properties?.rubricRef?.description).toMatch(
      /notExercised.*top-level rubricRef compatibility alias/i,
    );
    expect(json.properties?.rubricRef?.description).toMatch(/notExercised.*observation\.rubricRef/i);
    expect(json.properties?.observation?.required).toBeUndefined();

    expect(
      argsSchema.safeParse({
        title: 'free-text observation',
        lane: 'observation',
        body: 'narrative evidence belongs in body',
        observation: { kind: 'friction' },
      }).success,
    ).toBe(true);
    expect(
      argsSchema.safeParse({
        title: 'legacy scoped scorecard',
        lane: 'observation',
        rubricRef: 'r',
        observation: { notExercised: ['wake'] },
      }).success,
    ).toBe(true);
  });
});

/**
 * EI-10943 — a provenance LABEL must never destroy the capture.
 *
 * `foundDuring` was `z.string().max(120)`: a HARD reject. Overrun it by a few chars
 * and the whole call bounced — the finding is lost, and the agent gets the entire
 * (very large) args schema dumped back at it as the error. For a field the tool only
 * stores + echoes, into a DB column that is unbounded `text`. The cap is presentation
 * policy, so it must behave like one: truncate, warn, and keep the finding.
 *
 * The clamp is HANDLER-side, never a zod `.transform()` — a transform is
 * unrepresentable in JSON Schema and `z.toJSONSchema(def.args)` runs unguarded at
 * defineTool registration AND in the HTTP tools/list handler, so one would crash
 * schema-gen for the WHOLE catalog. The last test here pins exactly that.
 */
describe('improvements:capture — foundDuring is soft-capped (EI-10943)', () => {
  const parseArgs = (x: unknown) =>
    (captureTool.args as { safeParse: (v: unknown) => { success: boolean } }).safeParse(x);
  const LABEL_CAP = 120;
  const LONG = 'x'.repeat(300);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue(identity('omp-hook-session'));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
  });

  it('ACCEPTS an over-length foundDuring instead of rejecting the capture', () => {
    // The old schema failed here — and took the whole finding down with it.
    expect(parseArgs({ title: 't', foundDuring: LONG }).success).toBe(true);
  });

  it('truncates the stored value to the cap', async () => {
    await callTool({ title: 't', foundDuring: LONG });
    const passed = mockCapture.mock.calls[0]![0] as { foundDuring?: string };
    expect(passed.foundDuring).toHaveLength(LABEL_CAP);
    expect(passed.foundDuring).toBe('x'.repeat(LABEL_CAP));
  });

  it('WARNS that it truncated — silent truncation would be its own trap', async () => {
    const res = await callTool({ title: 't', foundDuring: LONG });
    const body = JSON.parse(res.content[0]!.text) as { warnings?: string[] };
    expect(body.warnings?.[0]).toMatch(/foundDuring was 300 chars — truncated to 120/);
    // and it says where the detail SHOULD have gone
    expect(body.warnings?.[0]).toMatch(/body/);
  });

  it('leaves a within-cap value untouched, with no warning', async () => {
    const res = await callTool({ title: 't', foundDuring: 'the agent-DX audit' });
    const passed = mockCapture.mock.calls[0]![0] as { foundDuring?: string };
    expect(passed.foundDuring).toBe('the agent-DX audit');
    expect(JSON.parse(res.content[0]!.text).warnings).toBeUndefined();
  });

  it('the args schema stays JSON-Schema-representable — a .transform() here would crash the WHOLE tools/list catalog', () => {
    // Not hypothetical: a top-level .transform() on a core-seed tool's args took out
    // schema-gen for every tool in the catalog (EI-10996) and redded the release gate.
    // This is why the clamp lives in the handler.
    expect(() => z.toJSONSchema(captureTool.args as never)).not.toThrow();
    const json = z.toJSONSchema(captureTool.args as never) as {
      properties?: Record<string, { type?: string; maxLength?: number }>;
    };
    const fd = json.properties?.foundDuring;
    expect(fd?.type).toBe('string');
    // advertised as a plain string: no maxLength to bounce a caller on
    expect(fd?.maxLength).toBeUndefined();
  });
});

// observation-candidate-acceptance-promotion-2026-09-30 P-013 (D-024): an encountered
// bug files its encounter as the reproduction receipt; the verdict is the server's.
describe('improvements:capture reproduction receipt (D-024)', () => {
  const BUILD = 'abcdef1234567';
  const passedPayload = () =>
    (mockCapture.mock.calls[0]![0] as { payloadExtra?: Record<string, unknown> }).payloadExtra ?? {};

  beforeEach(() => {
    vi.clearAllMocks();
    reproLedger.invocations.clear();
    mockReadTrustedHarnessTestRunProvenance.mockResolvedValue(null);
    mockIdentity.mockReturnValue(identity('omp-hook-session', 'su-filer'));
    mockCapture.mockResolvedValue({
      ok: true,
      created: true,
      issue: { id: 'EI-77', title: 'writer rejects a valid state' },
    } as unknown as Awaited<ReturnType<typeof captureImprovement>>);
  });

  it('stamps a ledger-verified encounter on the filing and reports its status', async () => {
    reproLedger.invocations.set(7, { status: 'error', servingBuildSha: BUILD });
    const result = await callTool({
      title: 'writer rejects a valid state',
      kind: 'bug',
      reproduction: { ref: 'tool_invocations:7', buildSha: BUILD },
    });
    expect(passedPayload().reproduction).toMatchObject({
      schemaVersion: 'bug-reproduction-v1',
      filedBy: 'su-filer',
      receipt: { kind: 'encounter', ref: 'tool_invocations:7', buildSha: BUILD },
      verification: { status: 'verified' },
    });
    expect(JSON.parse(result.content[0].text).reproduction).toMatchObject({ status: 'verified' });
  });

  it('records what the ledger says, not what the filer claims: a succeeded invocation is refuted', async () => {
    reproLedger.invocations.set(8, { status: 'ok', servingBuildSha: BUILD });
    const result = await callTool({
      title: 'writer rejects a valid state',
      kind: 'bug',
      reproduction: { ref: 'tool_invocations:8', buildSha: BUILD },
    });
    expect(passedPayload().reproduction).toMatchObject({ verification: { status: 'refuted' } });
    expect(JSON.parse(result.content[0].text).reproduction).toMatchObject({ status: 'refuted' });
  });

  it('a caller-classified tool failure keeps its probation path: the receipt is stored as not-eligible', async () => {
    reproLedger.invocations.set(7, { status: 'error', servingBuildSha: BUILD });
    await callTool(
      captureTool.args.parse({
        toolFailure: { ...metadataToolFailure },
        reproduction: { ref: 'tool_invocations:7', buildSha: BUILD },
      }),
    );
    expect(passedPayload()).toMatchObject({
      toolFailureProbation: { state: 'probation', class: 'caller' },
      reproduction: { verification: { status: 'not-eligible' } },
    });
  });

  it('refuses a receipt whose build sha is not a git sha, before filing anything', async () => {
    await expect(
      callTool({ title: 'x', kind: 'bug', reproduction: { ref: 'stack trace line', buildSha: 'staging' } }),
    ).rejects.toThrow(/buildSha/);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('files without a reproduction key when none is supplied', async () => {
    await callTool({ title: 'writer rejects a valid state', kind: 'bug' });
    expect(passedPayload()).not.toHaveProperty('reproduction');
  });
});
