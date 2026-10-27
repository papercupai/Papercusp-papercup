/**
 * plans:conformance (R-17, spec-driven-tooling-integration-2026-10-05 P-028): the
 * production wiring around the pure deviation core — owner-turn verification
 * strictness, the reserved-fence opt-in on the decision write, and arg validation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhaseTracker, dispatchProjectedTool, lookupByMcpName } from '@papercusp/tooldef';

const mocks = vi.hoisted(() => ({
  readPlanBySlug: vi.fn(),
  addDecisionOne: vi.fn(),
  loadConformanceReportPlans: vi.fn(),
  runSpecConformanceSweep: vi.fn(),
  productionSweepDeps: vi.fn(),
}));

vi.mock('./source', () => ({ readPlanBySlug: mocks.readPlanBySlug }));
vi.mock('./add-decision', () => ({ addDecisionOne: mocks.addDecisionOne }));
vi.mock('../../spec-conformance/sweep-action', () => ({
  runSpecConformanceSweep: mocks.runSpecConformanceSweep,
  productionSweepDeps: mocks.productionSweepDeps,
}));
vi.mock('../../spec-conformance/conformance-report', async (orig) => ({
  ...(await orig<typeof import('../../spec-conformance/conformance-report')>()),
  loadConformanceReportPlans: mocks.loadConformanceReportPlans,
}));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: async () => ({ workspaceId: 'ws', harnessSlug: 'h' }) }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'su-test' }) }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (harness: string | undefined, ctx: { harnessSlug?: string }) => ({ ...ctx, ...(harness ? { harnessSlug: harness } : {}) }),
}));

import tool, { appendResultFrom, conformanceRunAbortCompletionReceipt, ownerTurnVerificationFrom, verifyOwnerTurnRef } from './conformance';
import type { TurnRefVerdict } from '../../turn-provenance/turn-ref';

const verdict = (over: Partial<TurnRefVerdict>): TurnRefVerdict => ({
  ref: '[turn:abcd1234@2026-10-14T10:00:00Z]',
  found: true,
  verdict: 'owner-typed',
  origin: null,
  snippet: 'yes, drop R-2',
  quote: null,
  quoteMatch: null,
  checked: true,
  ...over,
});

describe('ownerTurnVerificationFrom', () => {
  it('verifies a found owner turn', () => {
    expect(ownerTurnVerificationFrom(verdict({}))).toMatchObject({ verified: true, verdict: 'owner-typed' });
    expect(ownerTurnVerificationFrom(verdict({ verdict: 'owner-dialog' })).verified).toBe(true);
  });

  it('refuses an agent-injected turn even when it was found', () => {
    expect(ownerTurnVerificationFrom(verdict({ verdict: 'agent-injected' }))).toMatchObject({ verified: false, verdict: 'agent-injected' });
  });

  it('refuses an unknown classification (an indexed row without affirmative owner evidence)', () => {
    expect(ownerTurnVerificationFrom(verdict({ verdict: 'unknown' as TurnRefVerdict['verdict'] })).verified).toBe(false);
  });

  it('refuses a resolvable owner turn whose attached quote is not in it (EI-12890)', () => {
    expect(ownerTurnVerificationFrom(verdict({ quote: 'approve everything', quoteMatch: false })).verified).toBe(false);
  });

  it('distinguishes searched-and-absent from never-checked', () => {
    expect(ownerTurnVerificationFrom(verdict({ found: false, verdict: null, checked: true })).detail).toContain('searched');
    expect(ownerTurnVerificationFrom(verdict({ found: false, verdict: null, checked: false })).detail).toContain('could not be located');
    expect(ownerTurnVerificationFrom(undefined).verified).toBe(false);
  });
});

describe('verifyOwnerTurnRef', () => {
  it('requires exactly one [turn:…] anchor and verifies it cross-session', async () => {
    const verify = vi.fn(async () => [verdict({})]);
    expect((await verifyOwnerTurnRef('su-x', 'the owner said so', verify as never)).verified).toBe(false);
    expect(
      (await verifyOwnerTurnRef('su-x', '[turn:abcd1234@2026-10-14T10:00:00Z] [turn:efgh5678@2026-10-14T11:00:00Z]', verify as never)).verified,
    ).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    const ok = await verifyOwnerTurnRef('su-x', '[turn:abcd1234@2026-10-14T10:00:00Z]', verify as never);
    expect(ok.verified).toBe(true);
    expect(verify).toHaveBeenCalledWith('su-x', expect.any(Array), { scope: 'cross-session' });
  });
});

describe('appendResultFrom', () => {
  it('maps success and failure', () => {
    expect(appendResultFrom({ ok: true, decisionId: 'D-012', ref: 'p#D-012' })).toEqual({ ok: true, decisionId: 'D-012', ref: 'p#D-012' });
    expect(appendResultFrom({ ok: false, error: 'busy', message: 'held' })).toEqual({ ok: false, error: 'busy', message: 'held' });
    expect(appendResultFrom({ ok: true })).toMatchObject({ ok: false, error: 'decision_write_failed' });
  });
});

const PLAN = [
  '---',
  'slug: p',
  'status: active',
  '---',
  '# P',
  '',
  '## Requirements',
  '',
  '**R-2 — An agent requirement.**',
  '```requirement',
  JSON.stringify({
    intent: { request: 'Do R-2.', sourceRefs: ['P-004'] },
    acceptance: { condition: 'R-2 holds.', falsifier: 'R-2 broken.' },
    verification: { method: 'Run it.', check: { kind: 'tests', files: ['x.test.ts'] } },
  }),
  '```',
  '',
  '## Decisions',
  '',
].join('\n');

const call = async (args: Record<string, unknown>) => {
  const output = (await tool.handler(args as never, { workspaceId: 'ws', harnessSlug: 'h' } as never)) as {
    data?: Record<string, unknown>;
    content?: { text: string }[];
  };
  return output.data ?? JSON.parse(output.content![0].text) as Record<string, unknown>;
};

describe('plans:conformance handler', () => {
  beforeEach(() => {
    mocks.readPlanBySlug.mockReset();
    mocks.addDecisionOne.mockReset();
    mocks.readPlanBySlug.mockResolvedValue({ row: { content: PLAN } });
    mocks.addDecisionOne.mockResolvedValue({ ok: true, decisionId: 'D-001', ref: 'p#D-001' });
  });

  it('propose-deviation writes through addDecisionOne with the reserved-fence opt-in and plan-item refs only', async () => {
    const out = await call({ op: 'propose-deviation', slug: 'p', requirement: 'R-2', reason: 'Superseded by R-3.' });
    expect(out).toMatchObject({ ok: true, op: 'propose-deviation', decisionId: 'D-001', ownerSourced: false });
    expect(mocks.addDecisionOne).toHaveBeenCalledTimes(1);
    const [input, , opts] = mocks.addDecisionOne.mock.calls[0]!;
    expect(opts).toEqual({ allowDeviationFence: true });
    expect(input.refs).toEqual([]);
    expect(input.body).toContain('```deviation');
    expect(input.body).toContain('"proposedBy": "su-test"');
  });

  it('refuses a propose without reason and an approve without proposal, writing nothing', async () => {
    expect(await call({ op: 'propose-deviation', slug: 'p', requirement: 'R-2' })).toMatchObject({ error: 'invalid_args' });
    expect(await call({ op: 'approve-deviation', slug: 'p', requirement: 'R-2' })).toMatchObject({ error: 'invalid_args' });
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });

  it('surfaces a missing plan as plan_not_found', async () => {
    mocks.readPlanBySlug.mockResolvedValue(null);
    expect(await call({ op: 'propose-deviation', slug: 'p', requirement: 'R-2', reason: 'x' })).toMatchObject({ ok: false, error: 'plan_not_found' });
  });

  it('refuses a deviation op without slug or requirement, writing nothing', async () => {
    expect(await call({ op: 'propose-deviation', requirement: 'R-2', reason: 'x' })).toMatchObject({ error: 'invalid_args' });
    expect(await call({ op: 'approve-deviation', slug: 'p', proposal: 'D-001' })).toMatchObject({ error: 'invalid_args' });
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });
});

describe("plans:conformance op:'run'", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPlanBySlug.mockResolvedValue({ row: { content: PLAN, harnessSlug: 'h' } });
    mocks.productionSweepDeps.mockReturnValue({});
    mocks.runSpecConformanceSweep.mockResolvedValue({
      scanned: 1, candidates: 1, ran: [{ key: 'h/p', ok: true, summary: { drifting: ['R-2'] } }],
      skipped: [], deferred: [], idle: 0, footprintProbeErrors: [],
    });
  });

  it('reads one plan in the resolved scope and returns its exact runner outcome', async () => {
    const out = await call({ op: 'run', harness: 'h', slug: 'p' });
    expect(out).toMatchObject({ ok: true, op: 'run', harnessSlug: 'h', planSlug: 'p', ran: [{ summary: { drifting: ['R-2'] } }] });
    expect(mocks.readPlanBySlug).toHaveBeenCalledExactlyOnceWith('p', { workspaceId: 'ws', harnessSlug: 'h' });
    expect(mocks.productionSweepDeps).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws', phases: expect.objectContaining({ track: expect.any(Function) }) });
    const [opts, deps] = mocks.runSpecConformanceSweep.mock.calls[0];
    expect(opts).toEqual({ target: { harnessSlug: 'h', planSlug: 'p' } });
    expect(await deps.listPlans()).toEqual([{ harnessSlug: 'h', planSlug: 'p', content: PLAN }]);
    expect(mocks.loadConformanceReportPlans).not.toHaveBeenCalled();
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });

  it('refuses a missing slug or missing plan without starting a sweep', async () => {
    expect(await call({ op: 'run' })).toMatchObject({ ok: false, error: 'invalid_args' });
    expect(await call({ op: 'run', harness: 'all', slug: 'p' })).toMatchObject({ ok: false, error: 'invalid_args' });
    mocks.readPlanBySlug.mockResolvedValue(null);
    expect(await call({ op: 'run', slug: 'missing' })).toMatchObject({ ok: false, error: 'plan_not_found' });
    expect(mocks.runSpecConformanceSweep).not.toHaveBeenCalled();
  });

  it('preserves a failed or skipped target as an unsuccessful tool result', async () => {
    mocks.runSpecConformanceSweep.mockResolvedValue({ ran: [{ key: 'h/p', ok: false, summary: { error: 'boom' } }] });
    expect(await call({ op: 'run', slug: 'p' })).toMatchObject({ ok: false, ran: [{ summary: { error: 'boom' } }] });
    mocks.runSpecConformanceSweep.mockResolvedValue({ ran: [], skipped: [{ key: 'h/p', reason: 'no-requirements' }] });
    expect(await call({ op: 'run', slug: 'p' })).toMatchObject({ ok: false, skipped: [{ reason: 'no-requirements' }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('identifies a pending plan read before the sweep starts without retrying it', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    let finishRead!: (value: unknown) => void;
    mocks.readPlanBySlug.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const phases = createPhaseTracker();
    const pending = tool.handler({ op: 'run', slug: 'p' } as never, {
      workspaceId: 'ws', harnessSlug: 'h', phases,
      dispatchCallId: 'call-plan-read', requestOrigin: { transport: 'mcp', mcpRequestTraceId: 'trace-plan-read' },
    } as never);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0].replace('[spec-conformance-phase] ', ''))).toMatchObject({
      event: 'pending', traceId: 'trace-plan-read', dispatchCallId: 'call-plan-read',
      phases: { activePhase: 'readPlan', activePhases: ['readPlan'] },
    });
    expect(mocks.runSpecConformanceSweep).not.toHaveBeenCalled();
    expect(mocks.readPlanBySlug).toHaveBeenCalledTimes(1);
    finishRead({ row: { content: PLAN, harnessSlug: 'h' } });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes a pending footprint from checks and records late settlement', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    let finishWindow!: (value: unknown) => void;
    const window = { headSha: 'abc', commits: [] };
    const plan = { harnessSlug: 'h', planSlug: 'p', content: PLAN };
    const original = {
      readWatermarks: vi.fn(async () => new Map()),
      footprintWindow: vi.fn(() => new Promise((resolve) => { finishWindow = resolve; })),
      runConformance: vi.fn(async () => ({ checked: [] })),
    };
    mocks.productionSweepDeps.mockReturnValue(original);
    mocks.runSpecConformanceSweep.mockImplementationOnce(async (_opts, deps) => {
      await deps.readWatermarks();
      await deps.footprintWindow(plan, null);
      await deps.runConformance(plan);
      return { ran: [{ ok: true }] };
    });
    const phases = createPhaseTracker();
    const pending = tool.handler({ op: 'run', slug: 'p' } as never, {
      workspaceId: 'ws', harnessSlug: 'h', phases,
      requestOrigin: { transport: 'mcp', mcpRequestTraceId: 'trace-footprint' },
    } as never);
    await vi.advanceTimersByTimeAsync(5_000);
    const first = JSON.parse(log.mock.calls[0]![0].replace('[spec-conformance-phase] ', ''));
    expect(first).toMatchObject({ event: 'pending', traceId: 'trace-footprint', phases: { activePhase: 'footprintWindow' } });
    expect(original.footprintWindow).toHaveBeenCalledExactlyOnceWith(plan, null);
    expect(original.runConformance).not.toHaveBeenCalled();
    finishWindow(window);
    await pending;
    const events = log.mock.calls.map(([line]) => JSON.parse(line.replace('[spec-conformance-phase] ', '')));
    expect(events.some((event) => event.event === 'progress' && event.phases.activePhase === 'runConformance')).toBe(true);
    expect(events.at(-1)).toMatchObject({ event: 'settled', phases: { activePhase: null, activePhases: [] } });
    expect(phases.toMetadata()?.phases.map((phase) => phase.phase)).toContain('footprintWindow');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps fast calls quiet and preserves errors even when diagnostic logging fails', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('logger unavailable'); });
    await call({ op: 'run', slug: 'p' });
    expect(log).not.toHaveBeenCalled();
    let failRead!: (reason: Error) => void;
    mocks.readPlanBySlug.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }));
    const pending = call({ op: 'run', slug: 'p' });
    const rejection = expect(pending).rejects.toThrow('original read failure');
    await vi.advanceTimersByTimeAsync(5_000);
    failRead(new Error('original read failure'));
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps inner dependency phases on the same request through pending and late settlement', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    let finish!: () => void;
    mocks.productionSweepDeps.mockImplementationOnce(({ phases }) => ({
      runConformance: () => phases.track('conformance:tests:ledger', () => new Promise<void>((resolve) => { finish = resolve; })),
    }));
    mocks.runSpecConformanceSweep.mockImplementationOnce(async (_opts, deps) => {
      await deps.runConformance({ harnessSlug: 'h', planSlug: 'p', content: PLAN });
      return { ran: [{ ok: true }] };
    });
    const phases = createPhaseTracker();
    const pending = tool.handler({ op: 'run', slug: 'p' } as never, {
      workspaceId: 'ws', harnessSlug: 'h', phases, dispatchCallId: 'inner-call',
      requestOrigin: { transport: 'mcp', mcpRequestTraceId: 'inner-trace' },
    } as never);
    await vi.advanceTimersByTimeAsync(5_000);
    const events = () => log.mock.calls.map(([line]) => JSON.parse(line.replace('[spec-conformance-phase] ', '')));
    expect(events()[0]).toMatchObject({
      event: 'pending', traceId: 'inner-trace', dispatchCallId: 'inner-call',
      phases: { activePhase: 'conformance:tests:ledger' },
    });
    finish();
    await pending;
    expect(events().at(-1)).toMatchObject({
      event: 'settled', traceId: 'inner-trace', dispatchCallId: 'inner-call',
      phases: { activePhase: null, activePhases: [] },
    });
    expect(phases.toMetadata()?.phases.map((phase) => phase.phase)).toContain('conformance:tests:ledger');
    expect(mocks.runSpecConformanceSweep).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers the persisted run after a parent abort without claiming that unmeasured checks passed', async () => {
    const parent = new AbortController();
    const row = {
      harnessSlug: 'h', planSlug: 'p', lastRunAt: '2026-10-23T17:58:48.718Z',
      footprintHeadSha: 'abc', lastTransitionAt: null, triggers: ['requested'], outcome: { unmeasured: 18 },
    };
    const writeWatermark = vi.fn(async () => { parent.abort(); });
    mocks.productionSweepDeps.mockReturnValue({ writeWatermark });
    mocks.runSpecConformanceSweep.mockImplementationOnce(async (_opts, deps) => {
      await deps.writeWatermark(row);
      return { ran: [{ key: 'h/p', ok: true, summary: row.outcome }] };
    });
    const args = { op: 'run', slug: 'p', harness: 'h' };
    const result = await tool.handler(args as never, {
      workspaceId: 'ws', harnessSlug: 'h', signal: parent.signal, dispatchCallId: 'attempt-returned',
    } as never);
    expect(parent.signal.aborted).toBe(true);
    expect(writeWatermark).toHaveBeenCalledExactlyOnceWith(row);
    expect(tool.abortCompletionReceipt).toBe(conformanceRunAbortCompletionReceipt);
    expect(conformanceRunAbortCompletionReceipt(args, result as never, {
      callId: 'attempt-returned', toolName: 'plans:conformance',
    })).toMatchObject({
      status: 'recorded',
      effectRef: 'spec-conformance:attempt-returned:ws:h:p:2026-10-23T17:58:48.718Z',
      diagnostics: { summary: { unmeasured: 18 } },
    });
    expect(tool).not.toHaveProperty('idempotent', true);
  });

  it('does not acknowledge a watermark write that rejected', async () => {
    const writeWatermark = vi.fn(async () => { throw new Error('write not acknowledged'); });
    mocks.productionSweepDeps.mockReturnValue({ writeWatermark });
    mocks.runSpecConformanceSweep.mockImplementationOnce(async (_opts, deps) => {
      await deps.writeWatermark({ harnessSlug: 'h', planSlug: 'p' });
      return { ran: [{ key: 'h/p', ok: true }] };
    });
    await expect(call({ op: 'run', slug: 'p' })).rejects.toThrow('write not acknowledged');
  });

  it.each(['http', 'mcp'] as const)('preserves the acknowledged run through real %s dispatch after parent abort', async (transport) => {
    const parent = new AbortController();
    const row = {
      harnessSlug: 'h', planSlug: 'p', lastRunAt: '2026-10-23T17:58:48.718Z',
      footprintHeadSha: 'abc', lastTransitionAt: null, triggers: ['requested'], outcome: { unmeasured: 18 },
    };
    const writeWatermark = vi.fn(async () => { parent.abort(); });
    mocks.productionSweepDeps.mockReturnValue({ writeWatermark });
    mocks.runSpecConformanceSweep.mockImplementationOnce(async (_opts, deps) => {
      await deps.writeWatermark(row);
      return { ran: [{ key: 'h/p', ok: true, summary: row.outcome }] };
    });
    const dispatched = await dispatchProjectedTool(lookupByMcpName('plans:conformance')!, 'plans:conformance', {
      op: 'run', slug: 'p', harness: 'h',
    }, {
      transport,
      ...(transport === 'mcp' ? { requestedFormat: 'toon' as const } : {}),
      signal: parent.signal, workspaceId: 'ws', harnessSlug: 'h',
      log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
      gateBypass: { role: true, capability: true },
    }, {});
    expect(writeWatermark).toHaveBeenCalledExactlyOnceWith(row);
    expect(dispatched.ok).toBe(true);
    expect(dispatched.result?._meta?.format).toBe(transport === 'mcp' ? 'toon' : 'json');
    expect(dispatched.result?._meta?.abortCompletionReceipt).toMatchObject({
      status: 'recorded', attemptId: expect.any(String),
      effectRef: expect.stringMatching(/^spec-conformance:[^:]+:ws:h:p:2026-10-23T17:58:48\.718Z$/),
      diagnostics: { summary: { unmeasured: 18 } },
    });
  });

  it('keeps real dispatch aborted when a returned run has no acknowledged watermark', async () => {
    const parent = new AbortController();
    mocks.runSpecConformanceSweep.mockImplementationOnce(async () => {
      parent.abort();
      return { ran: [{ key: 'h/p', ok: true }] };
    });
    const dispatched = await dispatchProjectedTool(lookupByMcpName('plans:conformance')!, 'plans:conformance', {
      op: 'run', slug: 'p', harness: 'h',
    }, {
      transport: 'mcp', requestedFormat: 'toon',
      signal: parent.signal, workspaceId: 'ws', harnessSlug: 'h',
      log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
      gateBypass: { role: true, capability: true },
    }, {});
    expect(dispatched.ok).toBe(false);
    expect(dispatched.error).toMatchObject({
      code: 'aborted',
      meta: { abortCompletionReceipt: { status: 'recovery-incomplete' } },
    });
  });
});

describe('conformance abort receipt identity', () => {
  const payload = {
    ok: true, op: 'run', harnessSlug: 'h', planSlug: 'p', ran: [{ key: 'h/p', ok: true }],
    runReceipt: { attemptId: 'attempt', workspaceId: 'ws', harnessSlug: 'h', planSlug: 'p', lastRunAt: '2026-10-23T17:58:48.718Z' },
  };
  it.each([
    { ...payload, runReceipt: undefined },
    { ...payload, runReceipt: { ...payload.runReceipt, attemptId: 'other-attempt' } },
    { ...payload, runReceipt: { ...payload.runReceipt, planSlug: 'other-plan' } },
    { ...payload, runReceipt: { ...payload.runReceipt, harnessSlug: 'other-harness' } },
    { ...payload, runReceipt: { ...payload.runReceipt, lastRunAt: 'not-a-date' } },
    { ...payload, ran: [] },
    { ...payload, ok: false },
  ])('refuses missing, mismatched, or unsuccessful receipt %#', (data) => {
    expect(conformanceRunAbortCompletionReceipt({ op: 'run', slug: 'p', harness: 'h' },
      { structuredContent: data, content: [] }, { toolName: 'plans:conformance', callId: 'attempt' },
    ).status).toBe('recovery-incomplete');
  });
});

describe("plans:conformance op:'report' (R-22)", () => {
  beforeEach(() => {
    mocks.loadConformanceReportPlans.mockReset();
    mocks.addDecisionOne.mockReset();
    mocks.loadConformanceReportPlans.mockResolvedValue([
      { planSlug: 'p', harnessSlug: 'h', status: 'active', content: PLAN },
      { planSlug: 'q', harnessSlug: 'h', status: 'active', content: '# Q\n' },
    ]);
  });

  it('censuses the loaded plans read-only, with no slug, and writes no decision', async () => {
    const out = await call({ op: 'report' });
    expect(out).toMatchObject({ ok: true, op: 'report', statuses: ['active', 'ready'] });
    expect((out.plans as unknown[]).length).toBe(2);
    expect(mocks.loadConformanceReportPlans).toHaveBeenCalledWith({ workspaceId: 'ws' });
    expect(mocks.addDecisionOne).not.toHaveBeenCalled();
  });

  it('forwards an explicit harness and statuses filter to the loader and the census', async () => {
    const out = await call({ op: 'report', harness: 'h', statuses: ['shipped'] });
    expect(mocks.loadConformanceReportPlans).toHaveBeenCalledWith({ workspaceId: 'ws', harnessSlug: 'h', statuses: ['shipped'] });
    expect(out).toMatchObject({ ok: true, statuses: ['shipped'] });
    // the census re-filters by status, so active rows from a loose loader are excluded
    expect((out.plans as unknown[]).length).toBe(0);
  });
});
