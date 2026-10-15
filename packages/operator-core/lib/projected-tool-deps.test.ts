/**
 * Operator-core WIRING of PROJECTED_DEPS — the shared `DispatchProjectedDeps`
 * the @papercusp/agent-mcp dispatcher runs on every transport (HTTP / IPC / MCP).
 *
 * HE-02 / P-010 gap #7 (hive-run-evaluation-2026-06-13 — close the Class-1
 * deterministic gaps the HE-01 audit found). The GENERIC dispatch step is tested
 * inside @papercusp/agent-mcp and the envelope POLICY in
 * capability-envelope/policy.test.ts — but the operator-core BINDING was
 * untested: the enforce-vs-observe flag read on a beyond-envelope hit, the
 * decision-ledger emit on every settled call (and that it can never break its
 * trigger), the llm-testing override wiring, and that `defaultDeny:true` is
 * plumbed. This pins that binding, using the REAL (pure) evaluateCapabilityEnvelope
 * and mocking only the flag + the PG-touching leaves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// PARTIAL mocks only (importOriginal) — preserve every other export so the heavy
// dispatch import graph (agent-mcp bootstrap reads the REAL @papercusp/db-org
// `generated` at module load) still resolves, and so a cross-worker registry
// leak can never strip a sibling's real export (the fleet flagged full vi.mock of
// shared modules as a flake source). We override ONLY: the enforce flag-read, the
// ledger emit (assert called + throws swallowed without a real PG insert), and the
// llm-testing override registry. @papercusp/db-org is left REAL + un-mocked —
// getOrgPg is lazy and never invoked by these tests.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(),
}));
vi.mock('@papercusp/testing-shell/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/testing-shell/llm')>()),
  getOverride: vi.fn(),
}));
vi.mock('./decision-ledger/emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./decision-ledger/emit')>()),
  recordDecisionLedger: vi.fn(),
}));
vi.mock('./agent-tools/coordination/dispatch-heartbeat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/dispatch-heartbeat')>()),
  maybeBeatPresenceOnDispatch: vi.fn(),
}));

import {
  PROJECTED_DEPS,
  authorizationFailureHint,
  operatorKernelEnforcement,
  setKernelEnforcementResolver,
  wrapOperatorKernelSpawn,
  setReactionPostInvoke,
  jsonbSafeStringify,
  isPaletteUiPollRead,
} from './projected-tool-deps';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOverride, PASS_THROUGH as TESTING_SHELL_PASS_THROUGH } from '@papercusp/testing-shell/llm';
import { recordDecisionLedger } from './decision-ledger/emit';
import { maybeBeatPresenceOnDispatch } from './agent-tools/coordination/dispatch-heartbeat';
import { PASS_THROUGH } from '@papercusp/agent-mcp';
import type { PostInvokeEvent, UnifiedToolContext } from '@papercusp/agent-mcp';
import { __resetFailureLoopCircuitBreakerForTests, takePendingFailureLoopHint } from './failure-loop-circuit-breaker';

function ctx(over: Partial<UnifiedToolContext> = {}): UnifiedToolContext {
  return { workspaceId: 'default', ...over } as UnifiedToolContext;
}

afterEach(() => {
  vi.clearAllMocks();
  __resetFailureLoopCircuitBreakerForTests();
  // The reaction port is a module-level singleton — reset between tests so an
  // installed handler does not leak.
  setReactionPostInvoke(null);
  setKernelEnforcementResolver(null);
});

describe('PROJECTED_DEPS.kernelEnforcement — D-030 activation/ownership seat', () => {
  it('denies an explicitly revoked session before any handler work', async () => {
    const verdict = await operatorKernelEnforcement({
      phase: 'preflight',
      boundary: 'dispatch',
      toolName: 'plans:set-status',
      capabilities: ['plans:write'],
      args: {},
      ctx: ctx({ kernelState: { revoked: true } }),
    });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'revoked', availability: 'available' });
  });

  it('denies a requested revision that is not the host-applied revision', async () => {
    const verdict = await operatorKernelEnforcement({
      phase: 'enforce',
      boundary: 'dispatch',
      toolName: 'plans:set-status',
      capabilities: ['plans:write'],
      args: {},
      requestedRevision: { specificationRevision: 'spec-new', stateRevision: 'state-new' },
      appliedRevision: { specificationRevision: 'spec-old', stateRevision: 'state-old' },
      ctx: ctx(),
    });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'stale-activation' });
  });

  it('requires explicit resource ownership when the host marks a check required', async () => {
    const denied = await operatorKernelEnforcement({
      phase: 'preflight',
      boundary: 'dispatch',
      toolName: 'work_items:complete',
      capabilities: ['work_items:write'],
      args: {},
      ownership: { required: true, resourceId: 'WI-1', resourceOwnerId: 'owner-a' },
      ctx: ctx({ isSuperuser: true, uiClientId: 'owner-b' }),
    });
    expect(denied).toMatchObject({ decision: 'deny', code: 'ownership' });

    const allowed = await operatorKernelEnforcement({
      phase: 'enforce',
      boundary: 'dispatch',
      toolName: 'work_items:complete',
      capabilities: ['work_items:write'],
      args: {},
      ownership: { required: true, resourceId: 'WI-1', resourceOwnerId: 'owner-a' },
      ctx: ctx({ isSuperuser: true, uiClientId: 'owner-a' }),
    });
    expect(allowed).toMatchObject({ decision: 'allow', availability: 'unavailable' });
  });

  it('returns actual applied revision for telemetry attribution, never prepared state', async () => {
    const revision = { specificationRevision: 'spec-a', stateRevision: 'state-1' };
    const applied = await operatorKernelEnforcement({
      phase: 'enforce',
      boundary: 'dispatch',
      toolName: 'plans:set-status',
      capabilities: ['plans:write'],
      args: {},
      ctx: ctx({ kernelState: { activation: { applied: revision } } }),
    });
    expect(applied).toMatchObject({ decision: 'allow', revisionSource: 'applied', executionRevision: revision });

    const prepared = await operatorKernelEnforcement({
      phase: 'enforce',
      boundary: 'dispatch',
      toolName: 'plans:set-status',
      capabilities: ['plans:write'],
      args: {},
      ctx: ctx({ kernelState: { activation: { prepared: revision } } }),
    });
    expect(prepared).toMatchObject({ decision: 'allow', revisionSource: 'prepared' });
    expect(prepared?.executionRevision).toEqual(revision);
  });

  it('is replaceable by a live control-plane resolver without changing PROJECTED_DEPS identity', async () => {
    const resolver = vi.fn(async () => ({ decision: 'deny' as const, code: 'live-revocation' }));
    setKernelEnforcementResolver(resolver);
    expect(PROJECTED_DEPS.kernelEnforcement).toBe(operatorKernelEnforcement);
    const verdict = await PROJECTED_DEPS.kernelEnforcement!({
      phase: 'preflight',
      boundary: 'dispatch',
      toolName: 'coord:send',
      capabilities: ['coord:write'],
      args: {},
      ctx: ctx(),
    });
    expect(verdict).toMatchObject({ decision: 'deny', code: 'live-revocation' });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('wraps native/shell spawn and never calls the executor after revocation', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', killed: false }));
    setKernelEnforcementResolver(async () => ({ decision: 'deny', code: 'revoked', reason: 'revoked' }));
    const wrapped = wrapOperatorKernelSpawn(spawn, ctx({ isSuperuser: true, uiClientId: 'su-a' }), ['compute:exec:echo']);
    await expect(wrapped('echo', ['ok'])).rejects.toMatchObject({ name: 'KernelEnforcementDeniedError' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('PROJECTED_DEPS.onDispatchStart — in-flight liveness wiring', () => {
  it('beats presence with the dispatch context before handler settlement', () => {
    const event = {
      toolName: 'code:run',
      pluginName: 'agent-mcp',
      args: { script: 'await longTask()' },
      ctx: ctx({ runId: 'run-long-task' }),
    };

    PROJECTED_DEPS.onDispatchStart!(event);

    expect(maybeBeatPresenceOnDispatch).toHaveBeenCalledOnce();
    expect(maybeBeatPresenceOnDispatch).toHaveBeenCalledWith(event.ctx);
  });
});

describe('authorizationFailureHint — judge MCP route guidance (EI-21543450341912836, generalized EI-21907885860611918)', () => {
  const judgeCtx = ctx({
    transport: 'mcp',
    role: 'judge',
    principal: {
      kind: 'system',
      slug: 'system:judge',
      workspaceId: 'default',
      capabilities: new Set(),
      authMethod: 'spawn-url',
      trust: 'trusted',
    },
  });

  it('explains that tools:invoke preserves the denied principal and names the authorized route', () => {
    const hint = authorizationFailureHint({
      toolName: 'plans:audit',
      missingCapability: 'plans:write',
      ctx: judgeCtx,
    });
    expect(hint).toContain('same judge principal');
    expect(hint).toContain('do not retry it in this session');
    expect(hint).toContain('denied identically');
    expect(hint).toContain('separate authorized su/operator session');
    expect(hint).toContain('papercusp-su');
    expect(hint).toContain('tools:invoke');
    expect(hint).not.toContain('for example, tools:invoke');
  });

  // EI-21907885860611918: the hint used to fire for plans:audit alone, so the
  // identical judge-principal misrouting was independently re-filed against
  // each of these tools in turn. The hint must fire for the judge-mismatch
  // SHAPE regardless of which tool/capability triggered it — one allowlisted
  // tool at a time is exactly how this bug kept recurring.
  it.each([
    ['memory:search', 'memory:read'],
    ['locks:acquire', 'locks:write'],
    ['capability:edit', 'capability:fs-write'],
    ['db:next-migration', 'locks:write'],
  ])('names the papercusp-su route for %s denied %s', (toolName, missingCapability) => {
    const hint = authorizationFailureHint({ toolName, missingCapability, ctx: judgeCtx });
    expect(hint).toContain(toolName);
    expect(hint).toContain('papercusp-su');
    expect(hint).toContain('tools:invoke');
  });

  it('routes a judge denied capability:git to the read-only pinned-evidence reader', () => {
    const hint = PROJECTED_DEPS.authorizationFailureHint!({
      toolName: 'capability:git',
      missingCapability: 'capability:git',
      ctx: judgeCtx,
    });
    expect(hint).toContain('`capability:git` is intentionally withheld from judge sessions');
    expect(hint).toContain('capability:git-evidence');
    expect(hint).toContain('op: "readFileAtCommit"');
    expect(hint).toContain('full commit SHA');
    expect(hint).toContain('repository-relative path');
    expect(hint).toContain('separate authorized su/operator session');
  });

  // R-7 / P-012 (acceptance-machinery-seam-fixes-2026-09-16): a ROLE denial names the
  // allowed roles and nothing else, so the caller learns what WOULD work but not where
  // to get it. Both denial shapes have the same remedy, so they share this seam.
  it('hints a ROLE-allowlist denial, not only a capability denial', () => {
    const hint = authorizationFailureHint({
      toolName: 'coord:send',
      deniedRole: 'judge',
      allowedRoles: ['scoper', 'worker'],
      ctx: judgeCtx,
    });
    expect(hint).toContain('coord:send');
    expect(hint).toContain('allowlist');
    expect(hint).toContain('scoper, worker');
    // The remedy is the whole point — it must be the SAME one the capability path gives.
    expect(hint).toContain('papercusp-su');
    expect(hint).toContain('do not retry it in this session');
  });

  it('keeps the capability wording byte-identical now that the input is a union', () => {
    // Widening the input must not perturb the message the capability path has always
    // emitted — that text is quoted in filed work-items and agent memories.
    expect(
      authorizationFailureHint({ toolName: 'plans:audit', missingCapability: 'plans:write', ctx: judgeCtx }),
    ).toContain('this principal lacks plans:write for plans:audit');
  });

  it('does not hint a role denial outside a judge-scoped MCP session', () => {
    expect(
      authorizationFailureHint({
        toolName: 'coord:send',
        deniedRole: 'worker',
        allowedRoles: ['scoper'],
        ctx: ctx({ ...judgeCtx, role: 'worker' }),
      }),
    ).toBeUndefined();
  });

  it('does not hint an already-authorized superuser context', () => {
    expect(authorizationFailureHint({
      toolName: 'plans:audit',
      missingCapability: 'plans:write',
      ctx: ctx({ ...judgeCtx, isSuperuser: true }),
    })).toBeUndefined();
  });

  it('does not hint a non-judge role, a non-mcp transport, or an unrelated principal', () => {
    const base = { toolName: 'plans:audit', missingCapability: 'plans:write' };
    expect(authorizationFailureHint({ ...base, ctx: ctx({ ...judgeCtx, role: 'su' }) })).toBeUndefined();
    expect(authorizationFailureHint({ ...base, ctx: ctx({ ...judgeCtx, transport: 'http' }) })).toBeUndefined();
    expect(authorizationFailureHint({
      ...base,
      ctx: ctx({
        ...judgeCtx,
        principal: { ...judgeCtx.principal!, slug: 'system:other' },
      }),
    })).toBeUndefined();
  });

  // THE INJECTION, not just the function. Every assertion above imports
  // `authorizationFailureHint` directly and proves the FORMATTER is correct —
  // but production never calls it that way. The dispatch stack reaches it only
  // through `deps.authorizationFailureHint?.({...})` (dispatch-stack.ts, in
  // roleAllowlistStep), which is OPTIONALLY chained and wrapped in a catch that
  // sets `hint = undefined`, so an unwired dep degrades SILENTLY to the bare
  // denial. The wiring is one line in PROJECTED_DEPS. Until this assertion
  // existed, deleting that line realized R-7's driftMarker verbatim — a real
  // `role_not_allowed` naming no door — while every test in this file stayed
  // green. Found by su-4342525e's rev-9 vetting critique (finding A3) on
  // conv-mu50ok3h. Mirrors the kernelEnforcement identity assertion above.
  it('is WIRED into PROJECTED_DEPS, so a real role denial can reach it', () => {
    expect(PROJECTED_DEPS.authorizationFailureHint).toBe(authorizationFailureHint);
  });

  // ...and the wired reference still produces the door when invoked the way the
  // dispatch stack invokes it. Identity alone would survive both symbols being
  // re-pointed at a stub together; this closes that.
  it('produces the papercusp-su door when called THROUGH the injected dep', () => {
    const hint = PROJECTED_DEPS.authorizationFailureHint!({
      toolName: 'plans:audit',
      deniedRole: 'judge',
      allowedRoles: ['su'],
      ctx: judgeCtx,
    });
    expect(hint).toContain('papercusp-su');
  });
});

describe('PROJECTED_DEPS.checkCapabilityEnvelope — enforce/observe wiring (gap #7)', () => {
  it('returns null (no verdict) for an EXEMPT superuser caller — flag never read (D-002)', async () => {
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'secrets.read',
      capabilities: ['secrets:read:db'],
      ctx: ctx({ isSuperuser: true }),
      args: {},
    });
    expect(v).toBeNull();
    // D-002 is "an exempt caller gets no verdict", and the mechanism this pins is that such a caller
    // never reaches the ENFORCE/observe decision — `await getFlag(FLAGS.CAPABILITY_ENVELOPE, …)`,
    // which sits after the `if (!decision.applied) return null` early-out. Assert THAT flag, not
    // "no getFlag call whatsoever".
    //
    // The broad form was written when the enforce flag was the only getFlag reachable on this path,
    // and it went red on 2026-08-03 (EI-19448574704459898) for an unrelated reason: migrating
    // capability-envelope-overrides.ts onto lazyFlagRefresh moved its cache population from import to
    // the first reader call, so the `envelopeRoleOverrides()` / `envelopeProtectedAdditions()` reads
    // at the TOP of checkCapabilityEnvelopeImpl now kick a one-time system config warm —
    // getFlag(CAPABILITY_ENVELOPE_OVERRIDES, systemDistinctId()). That is a DIFFERENT flag, read
    // under the SYSTEM distinctId rather than the caller's, producing no verdict and no gating, so
    // the exemption invariant is intact. Narrowing keeps this failing for the regression it exists
    // to catch (an exempt caller reaching the enforce read) without reporting a module-warm as a
    // D-002 violation.
    expect(getFlag).not.toHaveBeenCalledWith(FLAGS.CAPABILITY_ENVELOPE, expect.anything());
  });

  it('returns null for a non-fleet / roleless caller', async () => {
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'plans.get',
      capabilities: ['plans:read'],
      ctx: ctx({ role: undefined }),
      args: {},
    });
    expect(v).toBeNull();
    expect(getFlag).not.toHaveBeenCalled();
  });

  it('ALLOWS a within-envelope fleet call (posture auto) without reading the flag (hot path stays sync)', async () => {
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'plans.set-status',
      capabilities: ['plans:write'],
      ctx: ctx({ role: 'worker' }),
      args: {},
    });
    expect(v).toEqual({ decision: 'allow', posture: 'auto', applied: true });
    expect(getFlag).not.toHaveBeenCalled();
  });

  it('DENIES a beyond-envelope (protected) fleet call when the enforce flag is ON', async () => {
    vi.mocked(getFlag).mockResolvedValue(true);
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'secrets.read',
      capabilities: ['secrets:read:db'],
      ctx: ctx({ role: 'worker' }),
      args: {},
    });
    expect(getFlag).toHaveBeenCalledOnce();
    expect(v).toMatchObject({ decision: 'deny', posture: 'rejected', applied: true });
    expect(v?.reason).toContain('never-auto protected set');
  });

  it('OBSERVES (does not block) a beyond-envelope call when the enforce flag is OFF — default-OFF shadow', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    const v = await PROJECTED_DEPS.checkCapabilityEnvelope!({
      toolName: 'processes.kill',
      capabilities: ['processes:kill'],
      ctx: ctx({ role: 'cup' }),
      args: {},
    });
    expect(getFlag).toHaveBeenCalledOnce();
    expect(v).toMatchObject({ decision: 'observe', posture: 'gated', applied: true });
    expect(v?.reason).toContain('protected set');
  });
});

describe('PROJECTED_DEPS.postInvoke — decision-ledger emit + never breaks its trigger (gap #7)', () => {
  const event = (): PostInvokeEvent =>
    ({
      toolName: 'plans.set-status',
      pluginName: 'agent-mcp',
      args: { slug: 'p', status: 'wip' },
      result: { ok: true, result: { content: [] } },
      ctx: ctx({ role: 'worker', runId: 'r1', spawnId: 's1' }) as PostInvokeEvent['ctx'],
      durationMs: 5,
      capabilities: ['plans:write'],
    }) as PostInvokeEvent;

  it('records a decision-ledger row on every settled dispatch', () => {
    PROJECTED_DEPS.postInvoke!(event());
    expect(recordDecisionLedger).toHaveBeenCalledOnce();
  });

  it('attributes settled failures and queues the third identical signal for mid-turn delivery', () => {
    const failed = event();
    failed.ctx = ctx({
      principal: {
        slug: 'system:failure-loop-test',
        workspaceId: 'default',
        capabilities: new Set<string>(),
      },
    }) as PostInvokeEvent['ctx'];
    failed.result = {
      ok: false,
      error: { code: 'invalid_input', message: 'raw detail' },
    } as PostInvokeEvent['result'];

    PROJECTED_DEPS.postInvoke!(failed);
    PROJECTED_DEPS.postInvoke!(failed);
    PROJECTED_DEPS.postInvoke!(failed);

    expect(takePendingFailureLoopHint('system:failure-loop-test')).toMatchObject({
      ownerId: 'system:failure-loop-test',
      toolName: 'plans.set-status',
      errorClass: 'dispatch:invalid_input',
      count: 3,
    });
  });

  it('uses the private detector session key for pending delivery without changing public ownerId', () => {
    const failed = event();
    failed.ctx = ctx({
      principal: {
        slug: 'harness:papercusp',
        workspaceId: 'default',
        capabilities: new Set<string>(),
      },
      failureLoopSessionKey: 'auditor-session-a',
    }) as PostInvokeEvent['ctx'];
    failed.toolName = 'dev:pg_query';
    failed.result = { ok: false, error: { code: 'missing_capability', message: 'raw detail' } } as PostInvokeEvent['result'];

    for (let i = 0; i < 3; i++) PROJECTED_DEPS.postInvoke!(failed);

    expect(takePendingFailureLoopHint('auditor-session-a')).toMatchObject({
      ownerId: 'harness:papercusp',
      toolName: 'dev:pg_query',
      errorClass: 'dispatch:missing_capability',
    });
    expect(takePendingFailureLoopHint('harness:papercusp')).toBeNull();
  });

  it('does not attribute repeated failures from a declared hook dispatch', () => {
    const failed = event();
    failed.ctx = ctx({
      principal: {
        slug: 'system:judge',
        workspaceId: 'default',
        capabilities: new Set<string>(),
      },
      failureLoopSessionKey: 'judge-session',
      requestOrigin: { transport: 'mcp', query: { origin: 'hook' } },
    }) as PostInvokeEvent['ctx'];
    failed.toolName = 'activity:report';
    failed.result = { ok: false, error: { code: 'invalid_input', message: 'raw detail' } } as PostInvokeEvent['result'];

    for (let i = 0; i < 3; i++) PROJECTED_DEPS.postInvoke!(failed);

    expect(takePendingFailureLoopHint('judge-session')).toBeNull();
  });

  it('routes equivalent successful test results through the same production post-invoke delivery seam', () => {
    const repeated = event();
    repeated.toolName = 'testing:run';
    repeated.args = { files: ['test/fixture.ts'] };
    repeated.ctx = ctx({ principal: { slug: 'system:repeat-test', workspaceId: 'default', capabilities: new Set<string>() } }) as PostInvokeEvent['ctx'];
    repeated.result = { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ passed: 1,
      evidenceBundle: { verificationFingerprint: 'measured-source-and-test' } }) }] } } as PostInvokeEvent['result'];
    for (let i = 0; i < 3; i++) PROJECTED_DEPS.postInvoke!(repeated);
    expect(takePendingFailureLoopHint('system:repeat-test')).toMatchObject({ kind: 'repetition', category: 'test', count: 3 });
  });

  it('forwards the event to the installed reaction handler', () => {
    const seen: PostInvokeEvent[] = [];
    setReactionPostInvoke((e) => {
      seen.push(e);
    });
    PROJECTED_DEPS.postInvoke!(event());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe('plans.set-status');
  });

  it('still records the ledger even when an installed reaction handler throws (a reaction must never break its trigger)', () => {
    setReactionPostInvoke(() => {
      throw new Error('reaction boom');
    });
    expect(() => PROJECTED_DEPS.postInvoke!(event())).not.toThrow();
    expect(recordDecisionLedger).toHaveBeenCalledOnce();
  });

  it('swallows a throwing decision-ledger emit (the ledger must never break its trigger)', () => {
    vi.mocked(recordDecisionLedger).mockImplementationOnce(() => {
      throw new Error('ledger boom');
    });
    expect(() => PROJECTED_DEPS.postInvoke!(event())).not.toThrow();
  });
});

describe('PROJECTED_DEPS.overrideTool — llm-testing dispatch-override wiring (gap #7)', () => {
  // overrideToolImpl is async (EI-6842 fix: it must await override.override(...) to
  // translate testing-shell's own PASS_THROUGH sentinel into tooldef's before
  // returning — the two packages each mint a distinct `Symbol('PASS_THROUGH')`), so
  // every call here is awaited; a bare synchronous compare would compare against the
  // returned Promise, not its resolved value.
  it('passes through when the ctx is not an llm-testing run (registry not consulted)', async () => {
    const r = await PROJECTED_DEPS.overrideTool!('plans.get', {}, ctx({ uiClientId: 'desktop' }));
    expect(r).toBe(PASS_THROUGH);
    expect(getOverride).not.toHaveBeenCalled();
  });

  it('passes through a tagged llm-testing run with no registered override', async () => {
    vi.mocked(getOverride).mockReturnValue(undefined as never);
    const r = await PROJECTED_DEPS.overrideTool!('plans.get', {}, ctx({ uiClientId: 'llm-testing/run_x' }));
    expect(getOverride).toHaveBeenCalledWith('run_x');
    expect(r).toBe(PASS_THROUGH);
  });

  it('returns the registered override result for a tagged llm-testing run', async () => {
    const overridden = { ok: true, result: { content: [{ type: 'text', text: 'stub' }] } };
    const overrideFn = vi.fn().mockReturnValue(overridden);
    vi.mocked(getOverride).mockReturnValue({ override: overrideFn } as never);
    const r = await PROJECTED_DEPS.overrideTool!('plans.get', { a: 1 }, ctx({ uiClientId: 'llm-testing/run_y' }));
    expect(overrideFn).toHaveBeenCalledWith('plans.get', { a: 1 });
    expect(r).toBe(overridden);
  });

  // EI-6842: the actual bug the typecheck caught — testing-shell's PASS_THROUGH is a
  // DIFFERENT symbol instance than tooldef's, so it must be translated at this
  // boundary or dispatch-stack.ts's `ov !== PASS_THROUGH` check would treat it as a
  // real ToolResult instead of falling through to the real handler.
  it("translates testing-shell's own PASS_THROUGH sentinel into tooldef's before returning", async () => {
    const overrideFn = vi.fn().mockReturnValue(TESTING_SHELL_PASS_THROUGH);
    vi.mocked(getOverride).mockReturnValue({ override: overrideFn } as never);
    const r = await PROJECTED_DEPS.overrideTool!('plans.get', {}, ctx({ uiClientId: 'llm-testing/run_z' }));
    expect(r).toBe(PASS_THROUGH); // tooldef's sentinel, not testing-shell's
  });
});

describe('PROJECTED_DEPS.defaultDeny — fail-closed floor for ungated tools (gap #7)', () => {
  it('is plumbed ON (a future/third-party tool with no declared gate gets a loud ungated 403)', () => {
    expect(PROJECTED_DEPS.defaultDeny).toBe(true);
  });
});

// recordInvocation writes args_json/metadata_json via `JSON.stringify(...)::jsonb`.
// Postgres jsonb rejects the U+0000 escape ("unsupported Unicode escape
// sequence"), so a tool call whose args carried a NUL byte (binary-ish payloads,
// truncated reads, terminal output) threw and the WHOLE invocation row was
// dropped (the catch swallows it -> telemetry silently lost). jsonbSafeStringify
// strips NUL from string values so the cast succeeds.
describe('jsonbSafeStringify -- NUL-byte sanitization for ::jsonb', () => {
  const NUL = String.fromCharCode(0);
  const NUL_ESCAPE = '\\u0000'; // the 6-char escape JSON.stringify emits for a real NUL

  it('strips NUL from string values so the output has no u0000 escape (jsonb-castable)', () => {
    const out = jsonbSafeStringify({ a: 'x' + NUL + 'y', b: ['p' + NUL, 'q'], n: 1 });
    expect(out.includes(NUL_ESCAPE)).toBe(false);
    expect(out.includes(NUL)).toBe(false);
    expect(JSON.parse(out)).toEqual({ a: 'xy', b: ['p', 'q'], n: 1 });
  });

  it('handles a top-level NUL-bearing string and deep nesting', () => {
    expect(jsonbSafeStringify(NUL + 'lead')).toBe('"lead"');
    const out = jsonbSafeStringify({ deep: { arr: [{ s: 'a' + NUL + 'b' }] } });
    expect(out.includes(NUL_ESCAPE)).toBe(false);
    expect(JSON.parse(out)).toEqual({ deep: { arr: [{ s: 'ab' }] } });
  });

  it('leaves a LITERAL backslash-u-0000 text intact (not an actual NUL byte)', () => {
    const literal = '\\u0000'; // six real chars: backslash u 0 0 0 0 -- valid in jsonb
    expect(JSON.parse(jsonbSafeStringify({ a: literal }))).toEqual({ a: literal });
  });

  it('is identical to JSON.stringify when there is no NUL (no behavior change otherwise)', () => {
    const v = { a: 1, b: 'hello', c: [true, null, { d: 'x' }] };
    expect(jsonbSafeStringify(v)).toBe(JSON.stringify(v));
  });
});

// EI-2112: the loopback command-palette bridge (ctx.spawnId='palette', stamped by
// lib/capabilities/invoke.ts) drives the desktop dock's wake-board refresh tick,
// which polled coord:wake-queue{list} + coord:wake-mode (read) ~6.6x/sec, 24/7 ->
// 817K rows/24h = 74.5% of the WHOLE tool_invocations table. recordInvocationImpl
// drops those UI poll-reads via this predicate so the table reflects AGENT tool
// calls. Scoped tight: only the palette identity, only the READ shape -- a palette
// ACTION (a wake release/skip, a wake-mode set) and a REAL agent reading the board
// both still record.
describe('isPaletteUiPollRead -- exclude palette UI poll-reads from telemetry (EI-2112)', () => {
  const palette = (toolName: string, args: unknown) =>
    isPaletteUiPollRead({ toolName, ctx: ctx({ spawnId: 'palette' }), args });

  it('DROPS coord:wake-queue list polls (explicit action and the zod default)', () => {
    expect(palette('coord:wake-queue', { action: 'list' })).toBe(true);
    expect(palette('coord:wake-queue', {})).toBe(true); // action defaults to 'list'
    expect(palette('coord:wake-queue', { agent: 'su-x', action: 'list' })).toBe(true);
  });

  it('RECORDS coord:wake-queue mutating actions (release / skip / *_all stay audited)', () => {
    expect(palette('coord:wake-queue', { action: 'release', agent: 'su-x', id: 7 })).toBe(false);
    expect(palette('coord:wake-queue', { action: 'skip', agent: 'su-x', id: 7 })).toBe(false);
    expect(palette('coord:wake-queue', { action: 'release_all', agent: 'su-x' })).toBe(false);
    expect(palette('coord:wake-queue', { action: 'skip_all', agent: 'su-x' })).toBe(false);
  });

  it('DROPS coord:wake-mode reads (global default read and an agent read)', () => {
    expect(palette('coord:wake-mode', {})).toBe(true);
    expect(palette('coord:wake-mode', { agent: 'su-x' })).toBe(true);
  });

  it('RECORDS coord:wake-mode sets (a mode is a human-initiated action)', () => {
    expect(palette('coord:wake-mode', { agent: 'su-x', mode: 'manual' })).toBe(false);
    expect(palette('coord:wake-mode', { mode: 'auto' })).toBe(false);
  });

  it('RECORDS a non-board palette action (e.g. pot:start) — only the board polls are dropped', () => {
    expect(palette('pot:start', { harness: 'papercup' })).toBe(false);
    expect(palette('coord:send', { to: ['*'], summary: 'hi' })).toBe(false);
  });

  it('RECORDS a REAL agent reading the board — spawn_id != palette is genuine activity', () => {
    expect(
      isPaletteUiPollRead({
        toolName: 'coord:wake-queue',
        ctx: ctx({ spawnId: 's-123-abc' }),
        args: { action: 'list' },
      }),
    ).toBe(false);
    expect(
      isPaletteUiPollRead({
        toolName: 'coord:wake-mode',
        ctx: ctx({ spawnId: 's-123-abc' }),
        args: {},
      }),
    ).toBe(false);
  });

  it('RECORDS when spawnId is absent (no palette identity to key on)', () => {
    expect(isPaletteUiPollRead({ toolName: 'coord:wake-queue', ctx: ctx({}), args: { action: 'list' } })).toBe(false);
  });

  it('tolerates a non-object / missing args payload without throwing', () => {
    expect(palette('coord:wake-queue', undefined)).toBe(true); // no action -> read
    expect(palette('coord:wake-mode', null)).toBe(true); // no mode -> read
    expect(palette('coord:wake-queue', 'garbage')).toBe(true);
  });
});
