/**
 * dispatch.test.ts — coord:dispatch's pure composition (fleet-dispatch-wake-clarity
 * P-002 / D-002). The in-process `call` is mocked (we assert WHICH sub-tools run with
 * WHAT args + how their results fold into the dispatch report), so no PG / no live pump.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  createDispatchPhaseInstrumentation,
  composeDispatch,
  coordDispatchAbortCompletionReceipt,
  finalizePilotDispatchReceipt,
  runInstrumentedDispatch,
  type DispatchArgs,
  type DispatchResult,
} from './dispatch';
import dispatch from './dispatch';
import type { HydratableRef, HydratedRef } from '../ref-hydrate';
import type { RefResolvers } from '../ref-hydrate-resolve';
import type { StableAgentTargetState } from '../actionable-work-item-dispatch';
import { AdmissionRecoveryRefused } from '../../../work-item-admission-recovery';
import { lookupByMcpName, papercuspGateBypass } from '@papercusp/agent-mcp';
import { runDispatchStack, type ToolResult } from '@papercusp/tooldef';

const recoveryIO = vi.hoisted(() => ({ request: vi.fn(), target: vi.fn() }));
vi.mock('../../../work-item-admission-recovery', async (original) => ({
  ...await original<typeof import('../../../work-item-admission-recovery')>(),
  requestAdmissionRecovery: recoveryIO.request,
}));
vi.mock('../actionable-work-item-dispatch', async (original) => ({
  ...await original<typeof import('../actionable-work-item-dispatch')>(),
  resolveStableAgentTarget: recoveryIO.target,
}));

// WI-4165 item-body hydration touches the real PG-backed plan store
// (getPlanRow) when no `deps.hydrateRefs` override is injected. Mock it at
// the module boundary so the pre-existing tests below (which pass no deps,
// exercising the REAL default hydrateRefs) stay DB-free and deterministic —
// a plan-item ref simply resolves to "not found", degrading to the plain
// note exactly like a resolve_error would (fail-soft, same as prod).
vi.mock('../../plans/source', () => ({
  getPlanRow: vi.fn(async () => null),
  planItemsForRow: vi.fn(() => []),
}));

describe('public original-item recovery door (handler wiring, mocked recovery I/O)', () => {
  const base = {
    to: 'reviewer', note: 'resume original review', harness: 'papercusp',
    workItemIds: ['WI-original'], resumeAdmission: true,
  };
  const context = {
    uiClientId: 'su-requester', isSuperuser: true, workspaceId: 'ws-recovery',
    harnessSlug: 'original-harness', profile: 'engineer', transport: 'mcp',
    runId: 'original-run', spawnId: 'original-spawn', chunkId: 'original-chunk',
    admissionRecoveryAuthority: { kind: 'superuser', role: 'operator', credentialSha256: 'a'.repeat(64) },
  };
  const call = async (args = base, ctx = context) => {
    const output = await dispatch.handler(dispatch.args.parse(args), ctx as unknown as Parameters<typeof dispatch.handler>[1]);
    return JSON.parse((output as { content: Array<{ text: string }> }).content[0]!.text);
  };
  beforeEach(() => {
    recoveryIO.request.mockReset().mockResolvedValue({
      ok: true, workItemId: 'WI-original', inProgress: false,
      request: { state: 'queued', pickupConfirmed: false },
    });
    recoveryIO.target.mockReset().mockResolvedValue({ ownerId: 'su-reviewer', present: true });
  });

  it('requires one exact scoped item and excludes the pilot and plan-item paths', () => {
    expect(dispatch.args.safeParse(base).success).toBe(true);
    for (const change of [
      { harness: undefined }, { workItemIds: [] }, { workItemIds: ['WI-1', 'WI-2'] },
      { items: ['P-001'] }, { pilotBinding: { itemId: 'WI-original', bindingReceiptId: 'binding' } },
    ]) {
      expect(dispatch.args.safeParse({ ...base, ...change }).success).toBe(false);
    }
  });

  it('derives caller/workspace from authenticated context and resolves the existing stable recipient', async () => {
    expect(dispatch.args.safeParse({ ...base, caller: 'spoofed', workspaceId: 'wrong' }).success).toBe(false);
    const result = await call({ ...base, body: 'Independent review only; no implementation' } as typeof base);
    expect(recoveryIO.target).toHaveBeenCalledWith({
      targetAgent: 'reviewer', workspaceId: 'ws-recovery', harness: 'papercusp',
    });
    expect(recoveryIO.request).toHaveBeenCalledWith({
      workspaceId: 'ws-recovery', harnessSlug: 'papercusp', workItemId: 'WI-original',
      caller: 'su-requester', target: 'su-reviewer',
      authority: { ...context.admissionRecoveryAuthority, context: {
        workspaceId: 'ws-recovery', harnessSlug: 'original-harness', profile: 'engineer',
        transport: 'mcp', runId: 'original-run', spawnId: 'original-spawn', chunkId: 'original-chunk',
        parentSpawnId: null, featureId: null, planRunSessionId: null,
      } },
      note: base.note, body: 'Independent review only; no implementation',
    });
    expect(result.request).toEqual({ state: 'queued', pickupConfirmed: false });
  });

  it('binds admission authority to the per-call harness for an unscoped caller', async () => {
    await call(base, { ...context, harnessSlug: null });

    expect(recoveryIO.request).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-recovery',
      harnessSlug: 'papercusp',
      authority: expect.objectContaining({
        context: expect.objectContaining({ harnessSlug: 'papercusp' }),
      }),
    }));
  });

  it('resolves the self selector to the authenticated caller before admission recovery', async () => {
    const ownerId = 'su-12345678-abcd-4000-8000-1234567890ab';
    const result = await call({ ...base, to: 'self' }, { ...context, uiClientId: ownerId });

    expect(recoveryIO.target).not.toHaveBeenCalled();
    expect(recoveryIO.request).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-recovery',
      harnessSlug: 'papercusp',
      workItemId: 'WI-original',
      caller: ownerId,
      target: ownerId,
    }));
    expect(result).toMatchObject({ ok: true, workItemId: 'WI-original' });
  });

  it('passes an exact canonical owner ID directly to recovery authorization', async () => {
    const ownerId = 'su-12345678-abcd-4000-8000-1234567890ab';
    const result = await call({ ...base, to: ownerId });

    expect(recoveryIO.target).not.toHaveBeenCalled();
    expect(recoveryIO.request).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-recovery',
      harnessSlug: 'papercusp',
      workItemId: 'WI-original',
      caller: 'su-requester',
      target: ownerId,
    }));
    expect(result.request).toEqual({ state: 'queued', pickupConfirmed: false });
  });

  it('WI-6554700010010992: names an adopter-gone stable name instead of registering recovery for a dead session', async () => {
    recoveryIO.target.mockResolvedValue({
      requested: 'reviewer', ownerId: 'su-dead-1', present: false, sessionState: null, wakeable: false,
      adoptedBy: ['su-dead-1'],
    });
    const result = await call();

    expect(recoveryIO.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false, error: 'target_adopter_gone', target: 'reviewer', adoptedBy: ['su-dead-1'],
      workItemId: 'WI-original', pickupConfirmed: false,
    });
    expect(result.reason).toContain('plan_items:adopt_name { name: "reviewer" }');
    expect(result.nextAction).toMatch(/resumeAdmission:true/);
  });

  it('returns an original-item remedy, not replacement or pickup, on authority refusal', async () => {
    recoveryIO.request.mockRejectedValue(new AdmissionRecoveryRefused('member override denied original item'));
    const result = await call();
    expect(result).toMatchObject({
      ok: false, error: 'admission_recovery_refused', workItemId: 'WI-original',
      responsibleActor: 'su-requester', pickupConfirmed: false,
      reason: 'member override denied original item', nextAction: expect.stringContaining('retry this same item'),
    });
  });

  it('accepts the real dispatchers applied stamp without saving it as authority', async () => {
    const revision = { specificationRevision: 'b'.repeat(64), stateRevision: 'applied-now' };
    const result = await runDispatchStack(lookupByMcpName('coord:dispatch')!, 'coord:dispatch', base, {
      ...context, role: 'operator', gateBypass: papercuspGateBypass({ isSuperuser: true }),
      signal: new AbortController().signal, log: () => {}, emit: () => {}, progress: () => {},
    } as Parameters<typeof runDispatchStack>[3], {
      kernelEnforcement: async () => ({
        decision: 'allow', applied: true, revisionSource: 'applied', executionRevision: revision,
      }),
    });
    expect(result.ok).toBe(true);
    expect(recoveryIO.request).toHaveBeenCalledOnce();
    const authority = recoveryIO.request.mock.calls[0]![0].authority;
    expect(authority.context).toMatchObject({ runId: 'original-run', harnessSlug: 'original-harness' });
    for (const field of ['kernelState', 'kernelEnforcement', 'appliedExecutionRevision', 'executionRevision']) {
      expect(authority.context).not.toHaveProperty(field);
    }
  });

  it('does not enqueue without a concrete authenticated workspace or hide infrastructure errors', async () => {
    expect(await call(base, { ...context, workspaceId: '' })).toMatchObject({ ok: false, pickupConfirmed: false });
    expect(recoveryIO.request).not.toHaveBeenCalled();
    recoveryIO.request.mockRejectedValue(new Error('database unavailable'));
    await expect(call()).rejects.toThrow('database unavailable');
  });
});

/** A mock InnerCall: records every (name,args) and returns a per-tool canned reply. */
function mockCall(replies: Record<string, unknown | ((args: any) => unknown)>) {
  const calls: Array<{ name: string; args: any }> = [];
  const call = vi.fn(async (name: string, args: unknown) => {
    calls.push({ name, args });
    const r = replies[name];
    if (r === undefined) throw new Error(`unexpected sub-call ${name}`);
    return typeof r === 'function' ? (r as (a: any) => unknown)(args) : r;
  });
  return { call: call as unknown as (name: string, args: unknown) => Promise<unknown>, calls };
}

/** A coord:send envelope with one result carrying the given wake fields. */
const sendEnv = (to: string, wake: Record<string, unknown>, msg_id = 'm-1') => ({
  ok: true,
  results: [{ ok: true, to: [to], msg_id, ts: 't', wake }],
  counts: { ok: 1, failed: 0 },
});

describe('coord:dispatch abort-completion receipt', () => {
  const attempt = { callId: 'dispatch-call-1', toolName: 'coord:dispatch' };
  const result = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  }) as ToolResult;
  const base = {
    ok: true,
    to: 'su-target',
    sessionState: 'parked',
    wakeable: true,
    assigned: null,
    workItems: null,
    delivered: 'message-1',
    woken: 0,
    queued: 1,
    pickupConfirmed: false,
  };

  it('records a persisted message id from the completed dispatch result', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'su-target' }, result(base), attempt)).toEqual({
      status: 'recorded',
      effectRef: 'coord-dispatch:dispatch-call-1:message:message-1',
    });
  });

  it('records only plan assignments whose row and canonical assignment identity agree', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'builder-1' }, result({
      ...base,
      delivered: null,
      assigned: {
        planSlug: 'plan-a', items: ['P-001'], requested: 1, assigned: 1, failed: 0, partial: false,
        results: [{
          ok: true, plan: 'plan-a', item: 'P-001',
          assignment: { planSlug: 'plan-a', itemId: 'P-001', assigneeName: 'builder-1' },
        }],
      },
    }), attempt)).toEqual({
      status: 'recorded',
      effectRef: 'coord-dispatch:dispatch-call-1:plan-item:plan-a#P-001',
    });
  });

  it('records successful atomic work-item claims and the delivered note together', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'su-target' }, result({
      ...base,
      workItems: {
        ok: true, targetAgent: 'su-target', requested: ['EI-1'], actionable: ['EI-1'],
        assigned: ['EI-1'], retained: [], skipped: [], failed: [], executionWorkItemIds: ['EI-1'],
      },
    }), attempt)).toEqual({
      status: 'recorded',
      effectRef: 'coord-dispatch:dispatch-call-1:message:message-1,work-item:EI-1',
    });
  });

  it('keeps a proven message visible but marks an unproven assignment recovery incomplete', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'builder-1' }, result({
      ...base,
      assigned: {
        planSlug: 'plan-a', items: ['P-001'], requested: 1, assigned: 1, failed: 0, partial: false,
        results: [{ ok: true, plan: 'plan-a', item: 'P-001' }],
      },
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      effectRef: 'coord-dispatch:dispatch-call-1:message:message-1',
      failures: ['unresolved-plan-assignment-outcomes'],
    });
  });

  it('fails closed when a failed claim may have committed before its error', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'su-target' }, result({
      ...base,
      delivered: null,
      workItems: {
        ok: false, targetAgent: 'su-target', requested: ['EI-1'], actionable: ['EI-1'],
        assigned: [], retained: [], skipped: [],
        failed: [{ workItemId: 'EI-1', code: 'claim_failed', reason: 'connection closed' }],
        executionWorkItemIds: [],
      },
    }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['unresolved-work-item-assignment-outcomes'],
    });
  });

  it('proves the no-op frontier did not deliver or assign anything', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'su-target' }, result({
      ...base,
      assigned: null,
      workItems: {
        ok: true, targetAgent: 'su-target', requested: ['EI-1'], actionable: [],
        assigned: [], retained: [], skipped: [{ workItemId: 'EI-1', code: 'blocked' }],
        failed: [], executionWorkItemIds: [],
      },
      delivered: null,
    }), attempt)).toEqual({
      status: 'not-recorded',
      reason: 'coord:dispatch found no executable work-items and performed no delivery',
    });
  });

  it('rejects a receipt for the wrong tool attempt', () => {
    expect(coordDispatchAbortCompletionReceipt({ to: 'su-target' }, result(base), {
      ...attempt, toolName: 'coord:send',
    })).toMatchObject({ status: 'recovery-incomplete', failures: ['missing-attempt-identity'] });
  });
});

describe('directed-pair pilot dispatch receipt', () => {
  const delivered = (): DispatchResult => ({
    ok: true,
    to: 'su-target',
    sessionState: 'parked',
    wakeable: true,
    assigned: null,
    workItems: null,
    delivered: 'coord-msg-1',
    woken: 0,
    queued: 1,
    pickupConfirmed: false,
  });

  it('persists the server-linked receipt only after delivery lands', async () => {
    const persist = vi.fn(async () => ({
      receiptId: 'dispatch-1',
      bindingReceiptId: 'binding-1',
      itemId: 'WI-1',
      ownerId: 'su-target',
      sessionId: 'session-target',
      role: 'implementer' as const,
      dispatchedAtMs: 200,
    }));

    const result = await finalizePilotDispatchReceipt(
      {
        to: 'target',
        note: 'take the role',
        harness: 'papercusp',
        pilotBinding: { itemId: 'WI-1', bindingReceiptId: 'binding-1' },
      },
      delivered(),
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      persist,
    );

    expect(persist).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      itemId: 'WI-1',
      bindingReceiptId: 'binding-1',
      ownerId: 'su-target',
    });
    expect(result.pilotDispatchReceipt).toMatchObject({ receiptId: 'dispatch-1' });
  });

  it('reports deliveryLanded when receipt persistence fails', async () => {
    const result = await finalizePilotDispatchReceipt(
      {
        to: 'target',
        note: 'take the role',
        pilotBinding: { itemId: 'WI-1', bindingReceiptId: 'binding-1' },
      },
      delivered(),
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      vi.fn(async () => { throw new Error('binding session changed'); }),
    );

    expect(result).toMatchObject({ ok: false, deliveryLanded: true });
    expect(result.pilotReceiptError).toMatch(/binding session changed/);
  });

  it('does not mint a receipt when coord:send did not deliver', async () => {
    const persist = vi.fn();
    const result = await finalizePilotDispatchReceipt(
      {
        to: 'target',
        note: 'take the role',
        pilotBinding: { itemId: 'WI-1', bindingReceiptId: 'binding-1' },
      },
      { ...delivered(), delivered: null },
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      persist,
    );

    expect(persist).not.toHaveBeenCalled();
    expect(result.pilotDispatchReceipt).toBeUndefined();
  });
});

const presence = (rows: Array<Record<string, unknown>>) => ({ active: rows, summary: {} });

const baseArgs: DispatchArgs = {
  to: 'su-7a2a',
  note: 'take fleet-dispatch P-001..P-004',
  planSlug: 'fleet-dispatch-wake-clarity-2026-06-22',
  items: ['P-001', 'P-002'],
};

function expectQueuedWake(result: { queued?: number; woken: number; pickupConfirmed?: boolean }, queued = 1) {
  expect(result.queued).toBe(queued);
  expect(result.woken).toBe(0);
  expect(result.pickupConfirmed).toBe(false);
}

describe('coord:dispatch phase instrumentation', () => {
  it('keeps cumulative phase evidence and the nested coord:send timings in metadata', async () => {
    const metadata = vi.fn();
    const trace = createDispatchPhaseInstrumentation(metadata);
    const sent = sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 });
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
      'plan_items:status': { items: [] },
      'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
      'coord:send': {
        ...sent,
        results: sent.results.map((result) => ({
          ...result,
          phaseTimingsMs: { prePersistMs: 3, persistMs: 5, postPersistMs: 8 },
        })),
      },
    });

    const result = await runInstrumentedDispatch(
      baseArgs,
      call,
      {},
      'su-dispatcher',
      { workspaceId: 'ws-dispatch', harnessSlug: 'papercusp' },
      trace,
    );

    expect(result.delivered).toBe('m-1');
    const dispatchTrace = metadata.mock.calls.at(-1)?.[0]?.coordDispatch;
    expect(dispatchTrace).toMatchObject({
      schemaVersion: 'coord-dispatch-phase-v1',
      status: 'completed',
      elapsedMs: expect.any(Number),
      phases: [
        { phase: 'target_resolution', status: 'completed', elapsedMs: expect.any(Number) },
        { phase: 'assignment_preflight', status: 'completed', elapsedMs: expect.any(Number) },
        { phase: 'assignment', status: 'completed', elapsedMs: expect.any(Number) },
        { phase: 'hydration', status: 'completed', elapsedMs: expect.any(Number) },
        { phase: 'required_delivery', status: 'completed', elapsedMs: expect.any(Number) },
        { phase: 'finalization', status: 'completed', elapsedMs: expect.any(Number) },
      ],
      coordSendPhaseTimingsMs: { prePersistMs: 3, persistMs: 5, postPersistMs: 8 },
    });
    expect(JSON.stringify(dispatchTrace)).not.toContain(baseArgs.note);
    expect(JSON.stringify(dispatchTrace)).not.toContain('su-7a2a');
  });

  it('records an abort while required delivery is still pending', async () => {
    const metadata = vi.fn();
    const controller = new AbortController();
    const trace = createDispatchPhaseInstrumentation(metadata, controller.signal);
    let beginDelivery!: () => void;
    let settleDelivery!: (value: unknown) => void;
    const deliveryStarted = new Promise<void>((resolve) => { beginDelivery = resolve; });
    const pendingDelivery = new Promise<unknown>((resolve) => { settleDelivery = resolve; });
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-abort-target', sessionState: 'parked', wakeable: true }]),
      'coord:send': () => {
        beginDelivery();
        return pendingDelivery;
      },
    });
    const running = runInstrumentedDispatch(
      { to: 'su-abort-target', note: 'private abort regression' },
      call,
      {},
      'su-dispatcher',
      { workspaceId: 'ws-dispatch', harnessSlug: 'papercusp' },
      trace,
    );

    await deliveryStarted;
    controller.abort();

    const abortedTrace = metadata.mock.calls.at(-1)?.[0]?.coordDispatch;
    expect(abortedTrace).toMatchObject({
      status: 'aborted',
      currentPhase: 'required_delivery',
      phases: expect.arrayContaining([
        expect.objectContaining({ phase: 'target_resolution', status: 'completed' }),
        expect.objectContaining({ phase: 'required_delivery', status: 'aborted', elapsedMs: expect.any(Number) }),
      ]),
    });

    settleDelivery(sendEnv('su-abort-target', { mode: 'required', targets: ['su-abort-target'], woken: 1 }));
    await expect(running).resolves.toMatchObject({ delivered: 'm-1' });
    expect(metadata.mock.calls.at(-1)?.[0]?.coordDispatch.status).toBe('aborted');
  });
});

describe('composeDispatch', () => {
  it('accepts over-cap notes and bodies for coord:send chunking', () => {
    const base = { to: 'su-target', note: 'take the assigned lane' };
    expect(dispatch.args.safeParse({ ...base, body: 'x'.repeat(600) }).success).toBe(true);
    expect(dispatch.args.safeParse({ ...base, body: 'x'.repeat(731) }).success).toBe(true);
    expect(dispatch.args.safeParse({ ...base, note: 'x'.repeat(731) }).success).toBe(true);
  });

  it('skips the optional presence read for an exact owner id so delivery cannot wait on alias resolution', async () => {
    const target = 'su-c7a0035f-da52-48f1-88f1-7f939f04c1b7';
    const { call, calls } = mockCall({
      'coord:presence': () => { throw new Error('exact ids must not need a roster lookup'); },
      'plan_items:status': { items: [] },
      'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
      'coord:send': sendEnv(target, { mode: 'required', targets: [target], woken: 1 }),
    });

    const result = await composeDispatch({ ...baseArgs, to: target }, call);

    expect(calls.map((entry) => entry.name)).not.toContain('coord:presence');
    expect(calls.map((entry) => entry.name)).toContain('coord:send');
    expect(result).toMatchObject({ to: target, sessionState: null, wakeable: null });
    expectQueuedWake(result);
  });

  it('full dispatch to a PARKED target: assigns lane + delivers note + queues wake without pickup', async () => {
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
      'plan_items:status': { items: [] },
      'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
      'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
    });
    const res = await composeDispatch(baseArgs, call);

    // all four legs ran, in order (EI-2292 inserts the pre-assign status guard read)
    expect(calls.map((c) => c.name)).toEqual([
      'coord:presence',
      'plan_items:status',
      'plan_items:assign',
      'coord:send',
    ]);
    // the lane assign carried the plan + items + assignee
    expect(calls[2].args).toMatchObject({
      plan: baseArgs.planSlug,
      itemIds: ['P-001', 'P-002'],
      assignee: 'su-7a2a',
    });
    // the send opted into the REQUIRED wake on the single target
    expect(calls[3].args).toMatchObject({ to: ['su-7a2a'], summary: baseArgs.note, wake: 'required' });

    expect(res.ok).toBe(true);
    expect(res.to).toBe('su-7a2aFULL'); // resolved ownerId from the send result
    expect(res.sessionState).toBe('parked');
    expect(res.wakeable).toBe(true);
    expect(res.assigned).toMatchObject({ ok: true, planSlug: baseArgs.planSlug, items: ['P-001', 'P-002'] });
    expect(res.delivered).toBe('m-1');
    expectQueuedWake(res);
    expect(res.warning).toMatch(/pickup is NOT confirmed/i);
    expect(res.recipient_absent).toBeUndefined();
  });

  it('preserves sessionState from a tier-shaped coord:presence row', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-shaped', state: 'parked', wakeable: true }]),
      'coord:send': sendEnv('su-shaped', { mode: 'required', targets: ['su-shaped'], woken: 1 }),
    });

    const res = await composeDispatch({ to: 'su-shaped', note: 'resume shaped dispatch' }, call);

    expect(res.sessionState).toBe('parked');
    expect(res.wakeable).toBe(true);
  });

  it('dispatch to an ENDED target is a LOUD miss — lane assigned, but warning + recipient_dead', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-dead', sessionState: 'ended', wakeable: false }]),
      'plan_items:assign': { ok: true, results: [{ ok: true }] },
      'coord:send': sendEnv('su-dead', {
        mode: 'required',
        targets: ['su-dead'],
        woken: 0,
        recipient_absent: true,
        recipient_dead: ['su-dead'],
      }),
    });
    const res = await composeDispatch({ ...baseArgs, to: 'su-dead', items: ['P-001'] }, call);

    expect(res.sessionState).toBe('ended');
    expect(res.queued).toBe(0);
    expect(res.woken).toBe(0);
    expect(res.pickupConfirmed).toBe(false);
    expect(res.recipient_dead).toEqual(['su-dead']);
    expect(res.assigned?.ok).toBe(true); // the durable lane still landed
    expect(res.ok).toBe(false);
    expect(res.failure).toMatchObject({ code: 'target_dead', queuePreserved: true });
    expect(res.warning).toMatch(/RELAUNCH|relaunch/);
    expect(res.warning).toMatch(/no LIVE session/i);
  });

  describe('WI-6554700010010992: a stable name whose every adopter ended', () => {
    const gone: StableAgentTargetState = {
      requested: 'reviewer',
      ownerId: 'su-dead-1',
      present: false,
      sessionState: null,
      wakeable: false,
      adoptedBy: ['su-dead-1', 'su-dead-2'],
    };
    const failedSend = (to = 'su-dead-1') =>
      mockCall({
        'coord:presence': presence([]),
        'plan_items:assign': { ok: true, results: [{ ok: true }] },
        'coord:send': sendEnv(to, { mode: 'required', targets: [to], woken: 0, recipient_absent: true }),
      });

    it('reports target_adopter_gone naming the NAME and its adopt_name repair', async () => {
      const { call } = failedSend();
      const resolveStableTarget = vi.fn(async () => gone);
      const res = await composeDispatch({ ...baseArgs, to: 'reviewer', items: ['P-001'] }, call, { resolveStableTarget });

      expect(resolveStableTarget).toHaveBeenCalledWith('reviewer');
      expect(res.ok).toBe(false);
      expect(res.failure).toMatchObject({ code: 'target_adopter_gone', target: 'reviewer', queuePreserved: true });
      expect(res.failure?.message).toContain('plan_items:adopt_name { name: "reviewer" }');
      expect(res.failure?.message).toContain('su-dead-1, su-dead-2');
      expect(res.warning).toMatch(/no live adopter/);
      expect(res.warning).toContain('plan_items:adopt_name');
    });

    it('keeps target_absent when the name is present or was never adopted', async () => {
      const states: StableAgentTargetState[] = [
        { ...gone, present: true, sessionState: 'parked', wakeable: true },
        { requested: 'reviewer', ownerId: 'reviewer', present: false, sessionState: null, wakeable: false },
      ];
      for (const state of states) {
        const { call } = failedSend();
        const res = await composeDispatch({ ...baseArgs, to: 'reviewer', items: ['P-001'] }, call, {
          resolveStableTarget: async () => state,
        });
        expect(res.failure?.code).toBe('target_absent');
      }
    });

    it('never consults the resolver for a canonical owner id or a delivered wake', async () => {
      const resolveStableTarget = vi.fn(async () => gone);
      const ownerId = 'su-12345678-abcd-4000-8000-1234567890ab';
      const canonical = await composeDispatch(
        { ...baseArgs, to: ownerId, items: ['P-001'] },
        failedSend(ownerId).call,
        { resolveStableTarget },
      );
      expect(canonical.failure?.code).toBe('target_absent');

      const { call } = mockCall({
        'coord:presence': presence([]),
        'plan_items:assign': { ok: true, results: [{ ok: true }] },
        'coord:send': sendEnv('su-live', { mode: 'required', targets: ['su-live'], queued: 1 }),
      });
      const delivered = await composeDispatch({ ...baseArgs, to: 'reviewer', items: ['P-001'] }, call, {
        resolveStableTarget,
      });
      expect(delivered.failure).toBeUndefined();
      expect(resolveStableTarget).not.toHaveBeenCalled();
    });

    it('a resolver error degrades to the raw classification', async () => {
      const { call } = failedSend();
      const res = await composeDispatch({ ...baseArgs, to: 'reviewer', items: ['P-001'] }, call, {
        resolveStableTarget: async () => {
          throw new Error('roster unavailable');
        },
      });
      expect(res.failure?.code).toBe('target_absent');
    });
  });

  it('pure directed wake (no planSlug/items) skips plan_items:assign entirely', async () => {
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
      'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
    });
    const res = await composeDispatch({ to: 'su-7a2a', note: 'resume what I sent you' }, call);
    expect(calls.map((c) => c.name)).toEqual(['coord:presence', 'coord:send']); // NO assign
    expect(res.assigned).toBeNull();
    expectQueuedWake(res);
    expect(res.delivered).toBe('m-1');
  });

  it('degrades when the presence read fails — sessionState null, dispatch still runs', async () => {
    const { call, calls } = mockCall({
      'coord:presence': () => {
        throw new Error('presence down');
      },
      'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
      'coord:send': sendEnv('su-7a2a', { mode: 'required', targets: ['su-7a2a'], woken: 1 }),
    });
    const res = await composeDispatch(baseArgs, call);
    expect(res.sessionState).toBeNull();
    expect(res.wakeable).toBeNull();
    expectQueuedWake(res); // the durable wake was queued, but pickup is unconfirmed
    expect(calls.map((c) => c.name)).toContain('coord:send');
  });

  it('a failed assign leg does NOT swallow the wake — assigned.ok false + error, send still runs', async () => {
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': () => {
        throw new Error('cross-user refused');
      },
      'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
    });
    const res = await composeDispatch(baseArgs, call);
    expect(res.assigned?.ok).toBe(false);
    expect(res.assigned?.error).toMatch(/cross-user/);
    expectQueuedWake(res); // the critical leg still queued the durable wake
    expect(calls.map((c) => c.name)).toContain('coord:send');
  });

  it('all-refused assignment is a failed dispatch, but the note and wake evidence remain', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-winding-down', sessionState: 'parked', wakeable: true }]),
      // The shared bulk envelope is execution-successful even though its only
      // item was refused — this is the shape coord:dispatch must interpret.
      'plan_items:assign': {
        ok: true,
        results: [{ ok: false, plan: baseArgs.planSlug, item: 'P-001', refused: 'fleet_winding_down' }],
        counts: { ok: 0, failed: 1 },
      },
      'coord:send': sendEnv('su-winding-down', { mode: 'required', targets: ['su-winding-down'], woken: 1 }),
    });

    const res = await composeDispatch({ ...baseArgs, to: 'su-winding-down', items: ['P-001'] }, call);

    expect(res.ok).toBe(false);
    expect(res.assigned).toMatchObject({
      ok: false,
      requested: 1,
      assigned: 0,
      failed: 1,
      partial: false,
    });
    expectQueuedWake(res);
    expect(res.delivered).toBe('m-1');
    expect(res.warning).toMatch(/assigned 0 of 1 requested/);
  });

  it('mixed assignment remains a successful dispatch with an explicit partial summary', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-partial', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': {
        ok: true,
        results: [
          { ok: true, plan: baseArgs.planSlug, item: 'P-001' },
          { ok: false, plan: baseArgs.planSlug, item: 'P-002', refused: 'fleet_winding_down' },
        ],
        counts: { ok: 1, failed: 1 },
      },
      'coord:send': sendEnv('su-partial', { mode: 'required', targets: ['su-partial'], woken: 1 }),
    });

    const res = await composeDispatch({ ...baseArgs, to: 'su-partial' }, call);

    expect(res.ok).toBe(true);
    expect(res.assigned).toMatchObject({
      ok: false,
      requested: 2,
      assigned: 1,
      failed: 1,
      partial: true,
    });
    expectQueuedWake(res);
  });

  it('EI-5957: a MANUAL-mode target (staged, woken 0) gets the LOUD "STAGED not delivered" warning', async () => {
    // The member is ALIVE (parked) but in manual wake-mode, so coord:send stages
    // the directed note instead of delivering it: woken:0, staged:1, NOT dead/absent.
    // Before the fix this produced NO warning (a quiet staged read as delivered).
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-manual', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': { ok: true, results: [{ ok: true }] },
      'coord:send': sendEnv('su-manual', {
        mode: 'required',
        targets: ['su-manual'],
        woken: 0,
        staged: 1,
        stagedTargets: ['su-manual'],
        note: 'wake STAGED, NOT delivered for su-manual: target(s) are in MANUAL wake-mode …',
      }),
    });
    const res = await composeDispatch({ ...baseArgs, to: 'su-manual', items: ['P-001'] }, call);
    expect(res.queued).toBe(0);
    expect(res.woken).toBe(0);
    expect(res.pickupConfirmed).toBe(false);
    expect(res.staged).toBe(1);
    expect(res.recipient_dead).toBeUndefined();
    expect(res.recipient_absent).toBeUndefined();
    expect(res.assigned?.ok).toBe(true); // the durable lane still landed
    expect(res.warning).toMatch(/STAGED/);
    expect(res.warning).toMatch(/MANUAL wake-mode/);
    expect(res.warning).toMatch(/wake-queue|wake-mode/);
  });

  it('a live-but-paused target (woken 0, not dead) gets the softer "confirm pickup" warning', async () => {
    const { call } = mockCall({
      'coord:presence': presence([{ ownerId: 'su-paused', sessionState: 'parked', wakeable: true }]),
      'plan_items:assign': { ok: true, results: [{ ok: true }] },
      'coord:send': sendEnv('su-paused', {
        mode: 'required',
        targets: ['su-paused'],
        woken: 0,
        recipient_absent: true,
      }),
    });
    const res = await composeDispatch({ ...baseArgs, to: 'su-paused', items: ['P-001'] }, call);
    expect(res.queued).toBe(0);
    expect(res.recipient_absent).toBe(true);
    expect(res.recipient_dead).toBeUndefined();
    expect(res.pickupConfirmed).toBe(false);
    expect(res.warning).toMatch(/confirm pickup/i);
  });

  describe('WI-4165: assigned plan-item body hydration', () => {
    const hydratedRef = (item: string, snippet: string): HydratedRef => ({
      ref: { kind: 'plan-item', slug: baseArgs.planSlug as string, item },
      ok: true,
      label: `plan:${baseArgs.planSlug}#${item} [todo]`,
      snippet,
    });

    it("inlines each assigned item's hydrated body into the delivered note", async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(
        async (_refs: HydratableRef[], _opts?: { resolvers?: RefResolvers }): Promise<HydratedRef[]> => [
          hydratedRef('P-001', 'Wire the DHT bootstrap fixture.'),
          hydratedRef('P-002', 'Verify the cold-join path.'),
        ],
      );
      const res = await composeDispatch(baseArgs, call, { hydrateRefs });

      // the resolver was scoped by the module's own budget/consumer contract —
      // one ref per assigned item, in order, no harness override (baseArgs has none)
      expect(hydrateRefs).toHaveBeenCalledTimes(1);
      const [refsArg] = hydrateRefs.mock.calls[0];
      expect(refsArg).toEqual([
        { kind: 'plan-item', slug: baseArgs.planSlug, item: 'P-001' },
        { kind: 'plan-item', slug: baseArgs.planSlug, item: 'P-002' },
      ]);

      // The structured-body gate (owner directive 2026-07-28) makes `body` a SECTION ARRAY:
      // coord:send refuses a plain string, and dispatch sends expects:'action', for which a
      // body is mandatory. The hydrated text rides the first section's `text`.
      const sendArgs = calls[calls.length - 1].args as { body?: Array<{ text?: string }> };
      const text = sendArgs.body?.[0]?.text;
      expect(text).toContain('Wire the DHT bootstrap fixture.');
      expect(text).toContain('Verify the cold-join path.');
      expect(text).toContain('P-001');
      expect(text).toContain('P-002');
      expect(res.itemsHydrated).toBe(2);
    });

    it('prepends an explicit args.body before the hydrated item bodies', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => [hydratedRef('P-001', 'Wire the DHT bootstrap fixture.')]);
      await composeDispatch({ ...baseArgs, body: 'extra context up top' }, call, { hydrateRefs });

      const sendArgs = calls[calls.length - 1].args as { body?: Array<{ text?: string }> };
      const text = sendArgs.body?.[0]?.text ?? '';
      expect(text.indexOf('extra context up top')).toBeLessThan(text.indexOf('Wire the DHT bootstrap fixture.'));
    });

    it('keeps the explicit body when hydration would exceed coord:send\'s inbox cap', async () => {
      const explicitBody = 'x'.repeat(550);
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => [hydratedRef('P-001', 'y'.repeat(100))]);

      const res = await composeDispatch(
        { ...baseArgs, items: ['P-001'], body: explicitBody },
        call,
        { hydrateRefs },
      );

      const sendArgs = calls[calls.length - 1].args as { body?: Array<{ text?: string }> };
      expect(sendArgs.body?.[0]?.text).toBe(explicitBody);
      expect(sendArgs.body?.[0]?.text?.length).toBe(550);
      expect(res.itemsHydrated).toBeUndefined();
      expectQueuedWake(res);
    });

    it('fail-soft: a hydrate error still delivers the plain note (falls back to the note, wake unaffected)', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => {
        throw new Error('plan store down');
      });
      const res = await composeDispatch(baseArgs, call, { hydrateRefs });

      // Pre-gate this asserted `body === undefined`. It can no longer be: dispatch sends
      // expects:'action', which now REQUIRES a body — so the fail-soft path degrades to a
      // one-section body carrying the plain note, rather than dropping the body entirely and
      // making the send itself unsendable. What the test is really pinning is unchanged: a
      // hydration failure must not cost the note or the wake.
      const sendArgs = calls[calls.length - 1].args as { body?: Array<{ text?: string }> };
      expect(sendArgs.body).toHaveLength(1);
      expect(sendArgs.body?.[0]?.text).toBe(baseArgs.note);
      expect(res.itemsHydrated).toBeUndefined();
      expectQueuedWake(res); // the critical leg is unaffected by the hydration failure
    });

    it('skips hydration entirely for a pure directed wake (no planSlug/items)', async () => {
      const { call } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const hydrateRefs = vi.fn(async () => []);
      await composeDispatch({ to: 'su-7a2a', note: 'resume what I sent you' }, call, { hydrateRefs });
      expect(hydrateRefs).not.toHaveBeenCalled();
    });
  });

  describe('EI-2292: pre-assign guard skips live-claimed / owner-gated items', () => {
    it('drops an item live-claimed by ANOTHER agent — not re-assigned, but the note still delivers', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:status': {
          items: [
            { itemId: 'P-001', itemStatus: 'wip', claim: { owner: 'su-holder', ownerName: 'su-holder' } },
            { itemId: 'P-002', itemStatus: 'todo', claim: null },
          ],
        },
        'plan_items:assign': { ok: true, results: [{ ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const res = await composeDispatch(baseArgs, call);

      // only the unclaimed item reached plan_items:assign
      const assignCall = calls.find((c) => c.name === 'plan_items:assign');
      expect(assignCall?.args).toMatchObject({ itemIds: ['P-002'] });
      expect(res.assigned?.items).toEqual(['P-002']);
      expect(res.skippedItems).toEqual([{ item: 'P-001', reason: expect.stringMatching(/live-claimed by su-holder/) }]);
      expect(res.warning).toMatch(/skipped 1 of 2 requested item/);
      // the directed note still delivers — dispatch is not aborted by a partial skip
      expectQueuedWake(res);
    });

    it('keeps an item already live-claimed BY THE TARGET ITSELF (re-affirming your own claim is not a collision)', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:status': {
          items: [
            { itemId: 'P-001', itemStatus: 'wip', claim: { owner: 'su-7a2aFULL', ownerName: 'su-7a2aFULL' } },
            { itemId: 'P-002', itemStatus: 'todo', claim: null },
          ],
        },
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const res = await composeDispatch(baseArgs, call);
      const assignCall = calls.find((c) => c.name === 'plan_items:assign');
      expect(assignCall?.args).toMatchObject({ itemIds: ['P-001', 'P-002'] });
      expect(res.skippedItems).toBeUndefined();
    });

    it('drops a needs-human item — the exact su-aede8 harm (owner-gated work re-pushed every cycle)', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:status': {
          items: [
            { itemId: 'P-001', itemStatus: 'needs-human', claim: null },
            { itemId: 'P-002', itemStatus: 'todo', claim: null },
          ],
        },
        'plan_items:assign': { ok: true, results: [{ ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const res = await composeDispatch(baseArgs, call);
      const assignCall = calls.find((c) => c.name === 'plan_items:assign');
      expect(assignCall?.args).toMatchObject({ itemIds: ['P-002'] });
      expect(res.skippedItems).toEqual([{ item: 'P-001', reason: expect.stringMatching(/needs-human.*owner-gated/) }]);
    });

    it('drops a blocked item the same way as needs-human', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:status': {
          items: [
            { itemId: 'P-001', itemStatus: 'blocked', claim: null },
            { itemId: 'P-002', itemStatus: 'todo', claim: null },
          ],
        },
        'plan_items:assign': { ok: true, results: [{ ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const res = await composeDispatch(baseArgs, call);
      const assignCall = calls.find((c) => c.name === 'plan_items:assign');
      expect(assignCall?.args).toMatchObject({ itemIds: ['P-002'] });
      expect(res.skippedItems?.[0]).toMatchObject({ item: 'P-001' });
    });

    it('ALL requested items skipped: plan_items:assign is never called, but the note still delivers', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:status': {
          items: [
            { itemId: 'P-001', itemStatus: 'needs-human', claim: null },
            { itemId: 'P-002', itemStatus: 'wip', claim: { owner: 'su-other', ownerName: 'su-other' } },
          ],
        },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const res = await composeDispatch(baseArgs, call);
      expect(calls.map((c) => c.name)).not.toContain('plan_items:assign');
      expect(res.assigned).toBeNull();
      expect(res.skippedItems).toHaveLength(2);
      expectQueuedWake(res); // the wake itself is not blocked by a fully-skipped lane
    });

    it('fail-open: a plan_items:status read error degrades to the pre-fix unfiltered behavior', async () => {
      const { call, calls } = mockCall({
        'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
        'plan_items:status': () => {
          throw new Error('status read down');
        },
        'plan_items:assign': { ok: true, results: [{ ok: true }, { ok: true }] },
        'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
      });
      const res = await composeDispatch(baseArgs, call);
      const assignCall = calls.find((c) => c.name === 'plan_items:assign');
      expect(assignCall?.args).toMatchObject({ itemIds: ['P-001', 'P-002'] }); // unfiltered
      expect(res.skippedItems).toBeUndefined();
      expectQueuedWake(res);
    });

    describe('EI-21868454553879365: DAG-blocked descendants (raw stored status disagrees with blocked-by)', () => {
      it('drops a descendant stored "todo" whose blocked-by dependency is unresolved — the reported regression', async () => {
        // Exact reproduction shape: P-511 is stored 'todo' (nothing ever flagged
        // it 'blocked' by hand) but declares blocked-by: P-508, and P-508 itself
        // is still 'todo' (unresolved). The pre-fix guard only read P-511's own
        // raw itemStatus ('todo') and let it through — this is the bug.
        const { call, calls } = mockCall({
          'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
          'plan_items:status': {
            items: [
              { itemId: 'P-508', itemStatus: 'todo', blockedBy: [], claim: null },
              { itemId: 'P-511', itemStatus: 'todo', blockedBy: ['P-508'], claim: null },
            ],
          },
          'plan_items:assign': { ok: true, results: [{ ok: true }] },
          'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
        });
        const res = await composeDispatch({ ...baseArgs, items: ['P-508', 'P-511'] }, call);

        // P-508 is a genuinely open (unblocked) todo item, so it is legitimately
        // assignable itself — only P-511 (the DAG-blocked descendant) is skipped.
        const assignCall = calls.find((c) => c.name === 'plan_items:assign');
        expect(assignCall?.args).toMatchObject({ itemIds: ['P-508'] });
        expect(res.assigned?.items).toEqual(['P-508']);
        expect(res.skippedItems).toEqual([
          { item: 'P-511', reason: expect.stringMatching(/blocked by unresolved dependency \(P-508\)/) },
        ]);
      });

      it('assigns a descendant whose blocked-by dependency has already resolved (done) — no false positive', async () => {
        const { call, calls } = mockCall({
          'coord:presence': presence([{ ownerId: 'su-7a2aFULL', sessionState: 'parked', wakeable: true }]),
          'plan_items:status': {
            items: [
              { itemId: 'P-508', itemStatus: 'done', blockedBy: [], claim: null },
              { itemId: 'P-511', itemStatus: 'todo', blockedBy: ['P-508'], claim: null },
            ],
          },
          'plan_items:assign': { ok: true, results: [{ ok: true }] },
          'coord:send': sendEnv('su-7a2aFULL', { mode: 'required', targets: ['su-7a2aFULL'], woken: 1 }),
        });
        const res = await composeDispatch({ ...baseArgs, items: ['P-511'] }, call);

        const assignCall = calls.find((c) => c.name === 'plan_items:assign');
        expect(assignCall?.args).toMatchObject({ itemIds: ['P-511'] });
        expect(res.skippedItems).toBeUndefined();
      });
    });
  });
});

describe('composeDispatch — promoted workItemIds', () => {
  const assignment = (patch: Record<string, unknown> = {}) => ({
    ok: true,
    targetAgent: 'agent-email-full',
    requested: ['WI-READY', 'WI-BLOCKED'],
    actionable: ['WI-READY'],
    assigned: ['WI-READY'],
    retained: [],
    skipped: [
      {
        workItemId: 'WI-BLOCKED',
        code: 'dependency_blocked' as const,
        reason: 'unresolved work-item blocker: WI-ROOT',
        blockers: ['WI-ROOT'],
      },
    ],
    failed: [],
    executionWorkItemIds: ['WI-READY'],
    ...patch,
  });

  it('assigns and wakes only the filtered actionable work-item frontier', async () => {
    const assignWorkItems = vi.fn(async () => assignment());
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'agent-email-full', sessionState: 'parked', wakeable: true }]),
      'coord:send': sendEnv('agent-email-full', {
        mode: 'required',
        targets: ['agent-email-full'],
        queued: 1,
        woken: 1,
      }),
    });

    const result = await composeDispatch(
      {
        to: 'agent-email',
        note: 'execute the plan-run frontier',
        planSlug: 'email-run-42',
        workItemIds: ['WI-READY', 'WI-BLOCKED'],
        harness: 'email',
      },
      call,
      { assignWorkItems },
    );

    expect(assignWorkItems).toHaveBeenCalledWith({
      workItemIds: ['WI-READY', 'WI-BLOCKED'],
      targetAgent: 'agent-email-full',
      harness: 'email',
    });
    expect(calls.map((c) => c.name)).toEqual(['coord:presence', 'coord:send']);
    const sentBody = JSON.stringify(calls[1]?.args.body);
    expect(sentBody).toContain('WI-READY');
    expect(sentBody).not.toContain('WI-BLOCKED');
    expect(result.workItems).toEqual(assignment());
    expect(result.assigned).toBeNull();
    expect(result.ok).toBe(true);
    expectQueuedWake(result);
  });

  it('does not send or wake when every promoted work-item is still blocked', async () => {
    const allBlocked = assignment({
      requested: ['WI-BLOCKED'],
      actionable: [],
      assigned: [],
      skipped: [
        {
          workItemId: 'WI-BLOCKED',
          code: 'plan_lane_blocked',
          reason: 'blocked-by P-001',
        },
      ],
      executionWorkItemIds: [],
    });
    const { call, calls } = mockCall({
      'coord:presence': presence([{ ownerId: 'agent-email-full', sessionState: 'parked', wakeable: true }]),
    });

    const result = await composeDispatch(
      {
        to: 'agent-email',
        note: 'execute the plan-run frontier',
        workItemIds: ['WI-BLOCKED'],
      },
      call,
      { assignWorkItems: vi.fn(async () => allBlocked) },
    );

    expect(calls.map((c) => c.name)).toEqual(['coord:presence']);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBeNull();
    expect(result.queued).toBe(0);
    expect(result.warning).toMatch(/remain unassigned.*not woken/i);
  });

  it('returns a loud structured absent-target failure without undoing assignment', async () => {
    const readyOnly = assignment({
      targetAgent: 'agent-email-stable',
      requested: ['WI-READY'],
      skipped: [],
    });
    const { call } = mockCall({
      'coord:presence': presence([]),
      'coord:send': sendEnv('agent-email-stable', {
        mode: 'required',
        targets: ['agent-email-stable'],
        queued: 0,
        woken: 0,
        recipient_absent: true,
      }),
    });

    const result = await composeDispatch(
      {
        to: 'agent-email-stable',
        note: 'execute the plan-run frontier',
        workItemIds: ['WI-READY'],
      },
      call,
      { assignWorkItems: vi.fn(async () => readyOnly) },
    );

    expect(result.workItems?.assigned).toEqual(['WI-READY']);
    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({
      code: 'target_absent',
      target: 'agent-email-stable',
      recoverable: true,
      queuePreserved: true,
    });
    expect(result.recipient_absent).toBe(true);
  });
});
