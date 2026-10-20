// WI-6554700010018038 (plan bug-inflow-one-problem-one-row-2026-10-18, R-1/R-9): a
// transient or rate-limit tool failure is COUNTED in probation, never born promoted on the
// legacy direct-evidence booleans (reproduced / clearServerMismatch / hardInternal). Only a
// structured `toolFailure.directEvidence` lifts it, and other classes keep their existing
// born-promoted behaviour. This pins the capture TOOL half; the second-reporter half lives in
// harness/improvements/capture-core-volume-gate.test.ts.
//
// The mock set mirrors capture.test.ts so the handler runs PG-free; capture-core is
// auto-mocked, so the assertions read the payload the handler hands to captureImprovement.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import captureTool from './capture';
import {
  captureImprovement,
  captureToolInvocationFriction,
} from '../../harness/improvements/capture-core';
import { classifyToolError } from '../../harness/improvements/tool-error-classifier';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';

const drainAdmission = vi.hoisted(() => ({ gate: vi.fn() }));
const stalenessHints = vi.hoisted(() => ({
  toolFailure: vi.fn(async () => null as string | null),
  paths: vi.fn(async (_paths: readonly string[]) => null as string | null),
}));

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
  readTrustedHarnessTestRunProvenance: vi.fn(async () => null),
}));
vi.mock('../../harness/improvements/agent-review', () => ({
  enterAgentReview: vi.fn(async () => ({
    entered: true,
    state: { status: 'pending', submittedBy: 'su-test', ledgerIdeaId: 'EI-1', round: 1 },
  })),
}));
vi.mock('../coordination/identity');
vi.mock('../../modes/store', () => ({ getModes: vi.fn(async () => []) }));
vi.mock('../../attention/intake-promotion', async (original) => ({
  ...(await original<typeof import('../../attention/intake-promotion')>()),
  defaultReproductionLedgerDeps: () => ({
    readTestRun: async () => null,
    readToolInvocation: async () => null,
    now: () => new Date('2026-10-20T08:00:00Z'),
  }),
}));
vi.mock('../work_items/drain-flow', () => ({ withDrainBugAdmission: drainAdmission.gate }));
vi.mock('../work_items/semantic-dedup-probe-alarm', () => ({
  reportDedupCoverageDegraded: vi.fn(async () => undefined),
}));
vi.mock('../../scout/novelty-precheck', () => ({ noveltyPriorArt: vi.fn(async () => undefined) }));
vi.mock('../../scout/routed-ledger', () => ({ recordRoutedIdea: vi.fn(async () => undefined) }));
vi.mock('../../scout/generation-watermark', () => ({
  readRunningGeneration: vi.fn(async () => ({ sha: 'abc1234', hostStartedAt: '2026-10-20T08:00:00.000Z' })),
}));

const mockCapture = vi.mocked(captureImprovement);
const mockCaptureToolInvocationFriction = vi.mocked(captureToolInvocationFriction);
const mockIdentity = vi.mocked(resolveAgentIdentity);
const mockResolveSelfLiteral = vi.mocked(resolveSelfLiteral);

drainAdmission.gate.mockImplementation(async (_args, persist) => {
  const flow = {
    exact: true,
    totals: { opened: 0, terminaled: 0, net: 0 },
    breaker: { tripped: false, blocksNewBugs: false },
  };
  return { ok: true, allowed: true, flow, value: await persist(flow) };
});

function callTool(args: Record<string, unknown>) {
  return (
    captureTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(captureTool.args.parse(args), {});
}

function lastProbation(): Record<string, unknown> | undefined {
  const input = mockCapture.mock.calls.at(-1)?.[0] as
    | { payloadExtra?: { toolFailureProbation?: Record<string, unknown> } }
    | undefined;
  return input?.payloadExtra?.toolFailureProbation;
}

function lastLane(): unknown {
  return (mockCapture.mock.calls.at(-1)?.[0] as { lane?: unknown } | undefined)?.lane;
}

const TRANSIENT = { toolName: 'work_items:list', errorCode: 'timeout', message: 'statement timeout after 30000ms' };
const RATE_LIMIT = {
  toolName: 'memory:search',
  errorCode: 'handler_error',
  message: 'openai embed: rate limit exceeded (tokens per min)',
};
const STRUCTURAL = {
  toolName: 'work_items:complete',
  errorCode: 'handler_error',
  message: 'terminal writer rejected a valid state',
};

describe('improvements:capture — volume-gated tool-error classes are counted, not born promoted (WI-6554700010018038)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({
      ownerId: 'su-test',
      ownerLabel: 'omp-hook-session · su-test',
      source: 'omp-hook-session',
      workspaceId: 'ws-1',
      userId: null,
    } as ReturnType<typeof resolveAgentIdentity>);
    mockResolveSelfLiteral.mockImplementation((value, callerOwnerId) => (value === 'self' ? callerOwnerId : value));
    mockCapture.mockResolvedValue({ ok: true, id: 'EI-1', created: true } as unknown as Awaited<
      ReturnType<typeof captureImprovement>
    >);
    mockCaptureToolInvocationFriction.mockResolvedValue(null);
  });

  it('precondition: the fixtures land in the classes under test (guards against classifier drift)', () => {
    expect(classifyToolError(TRANSIENT.errorCode, null, TRANSIENT.message)).toBe('transient');
    expect(classifyToolError(RATE_LIMIT.errorCode, null, RATE_LIMIT.message)).toBe('rate-limit');
    expect(classifyToolError(STRUCTURAL.errorCode, null, STRUCTURAL.message)).toBe('structural');
  });

  for (const [label, legacy] of [
    ['reproduced', { reproduced: true }],
    ['clearServerMismatch', { clearServerMismatch: true }],
    ['hardInternal', { hardInternal: true }],
  ] as const) {
    it(`keeps a transient failure in probation when the only evidence is legacy ${label}`, async () => {
      await callTool({ toolFailure: { ...TRANSIENT, ...legacy } });
      expect(mockCapture).toHaveBeenCalledTimes(1);
      expect(lastLane()).toBe('observation');
      expect(lastProbation()).toMatchObject({ state: 'probation', class: 'transient' });
      expect(lastProbation()?.directEvidence).toBeUndefined();
    });
  }

  it('keeps a rate-limit failure in probation on legacy reproduced:true', async () => {
    await callTool({ toolFailure: { ...RATE_LIMIT, reproduced: true } });
    expect(lastLane()).toBe('observation');
    expect(lastProbation()).toMatchObject({ state: 'probation', class: 'rate-limit' });
  });

  it('promotes a transient failure that carries structured directEvidence', async () => {
    await callTool({
      toolFailure: {
        ...TRANSIENT,
        directEvidence: {
          kind: 'hard-internal',
          expected: 'work_items:list answers a 20-row slice within its 30s budget',
          actual: 'every call times out at 30000ms on an idle box, reproduced 3 times',
        },
      },
    });
    expect(lastLane()).toBeUndefined();
    expect(lastProbation()).toMatchObject({ state: 'promoted', directEvidence: true });
  });

  it('CONTROL: a structural failure on legacy reproduced:true is still born promoted', async () => {
    await callTool({ title: 'terminal writer rejects a valid state', kind: 'bug', toolFailure: { ...STRUCTURAL, reproduced: true } });
    expect(lastLane()).toBeUndefined();
    expect(lastProbation()).toMatchObject({ state: 'promoted', directEvidence: true });
  });
});
