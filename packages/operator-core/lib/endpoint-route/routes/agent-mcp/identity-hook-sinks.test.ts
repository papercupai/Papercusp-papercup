/**
 * identity-hook-sinks.test.ts — the three identity hook ports
 * (portable-identity-packages-2026-09-26 P-011; D-023 §3, D-024 §3).
 *
 * What each port must never do is the load-bearing part: the guard must fail
 * OPEN when the applied artifact is unreadable (closing there denies every tool
 * call fleet-wide) while a guard that cannot evaluate still refuses by name; the
 * context ports must answer inside their wall even when the wearer read hangs.
 * The guard predicate is the real `evaluatePreToolGuards`; only the reads are seams.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { capturePgDiagnosticContext, recordPgResult } from '@papercusp/db-org/acquire-registry';
import { withNamedQueryDiagnosticContext } from '../../../agent-tools/db-diagnostic-correlation-wiring';
const planExecutionGuard = vi.hoisted(() => vi.fn());
const priorityOrgPgMock = vi.hoisted(() => vi.fn(async (run: () => Promise<unknown>) => run()));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withPriorityOrgPg: priorityOrgPgMock,
}));
vi.mock('../../../agent-tools/plans/plan-execution-guard', () => ({ checkPlanExecutionGuard: planExecutionGuard }));

const {
  evaluateHookContextSinkMock, readAppliedWornRulesMock, turnsExistMock, turnEndHeldWorkMock, turnReadMock, turnChargeMock,
  tagTurnForInjectionMock,
} = vi.hoisted(() => ({
  evaluateHookContextSinkMock: vi.fn(),
  readAppliedWornRulesMock: vi.fn(),
  turnsExistMock: vi.fn(),
  turnEndHeldWorkMock: vi.fn(),
  turnReadMock: vi.fn(),
  turnChargeMock: vi.fn(),
  tagTurnForInjectionMock: vi.fn(),
}));

// The stop port's second leg (WI-6554700010015550) reads modes/claims/awaits from PG; keep it a seam.
vi.mock('../../../events/await/turn-end-held-work-guard', () => ({
  evaluateTurnEndHeldWorkStop: turnEndHeldWorkMock,
}));

vi.mock('../../../agent-identities/sync-hook-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../agent-identities/sync-hook-rules')>()),
  evaluateHookContextSink: evaluateHookContextSinkMock,
  readAppliedWornRules: readAppliedWornRulesMock,
  pgHookTurnStore: () => ({ exists: turnsExistMock, begin: turnReadMock, current: turnReadMock, charge: turnChargeMock }),
}));
vi.mock('../../../turn-provenance/turn-provenance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../turn-provenance/turn-provenance')>()),
  tagTurnForInjection: tagTurnForInjectionMock,
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));

import { wornSyncRules, type WornSyncRules } from '../../../agent-identities/sync-hook-rules';
import routes, { compactionSinkDue, guardRefusalText, toolGuardText } from './identity-hook-sinks';

type Route = { path: string; handler: (req: Request) => Promise<Response> };
const route = (path: string): Route => {
  const found = (routes as unknown as Route[]).find((entry) => entry.path === path);
  if (!found) throw new Error(`no route ${path}`);
  return found;
};
const post = async (path: string, body: unknown): Promise<{ ok: boolean; text: string }> => {
  const res = await route(path).handler(new Request(`http://localhost/api${path}`, { method: 'POST', body: JSON.stringify(body) }));
  return (await res.json()) as { ok: boolean; text: string };
};

const meta = (id: string) => ({ id, title: id, description: `${id} rule`, version: '1.0.0', ref: id });
const noRmRules = (): WornSyncRules => wornSyncRules({
  inputs: [
    {
      kind: 'package', packageKind: 'blueprint', ref: 'safe-coder', revision: '1', contentHash: 'h-coder', value: {},
      dependencies: [{ packageKind: 'rule', ref: 'no-rm', revision: '1.0.0', contentHash: 'h-no-rm' }],
    },
    {
      kind: 'package', packageKind: 'rule', ref: 'no-rm', revision: '1.0.0', contentHash: 'h-no-rm',
      value: { ...meta('no-rm'), delivery: 'sync', sink: 'pre-tool',
        guard: { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' } },
    },
  ],
} as never);
const NEVER_EMIT_MARKER = 'never-emit-me';
const call = (command: string) => ({ tool: 'Bash', input: { command }, client: 'claude' });

beforeEach(() => {
  priorityOrgPgMock.mockClear();
  planExecutionGuard.mockReset().mockResolvedValue(null);
  evaluateHookContextSinkMock.mockReset().mockResolvedValue({ text: '', result: null });
  readAppliedWornRulesMock.mockReset().mockResolvedValue(null);
  turnsExistMock.mockReset().mockResolvedValue(false);
  turnEndHeldWorkMock.mockReset().mockResolvedValue('');
  // A turn that has already spent far past every sink budget.
  turnReadMock.mockReset().mockResolvedValue({ turnId: 'turn-spent', tokensSpent: 10_000_000, msSpent: 10_000_000 });
  turnChargeMock.mockReset().mockResolvedValue(undefined);
  tagTurnForInjectionMock.mockReset().mockResolvedValue({
    taggedText: '⟦turn-origin:stop-hook nonce:aabbccddeeff0011⟧\nSTOP CONTEXT',
  });
});

describe('guardRefusalText', () => {
  it('names the identity and rule for a deny, and is empty for no verdict', () => {
    expect(guardRefusalText({ decision: 'deny', identityId: 'safe-coder', ruleId: 'no-rm', reason: 'no recursive deletes' }))
      .toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
    expect(guardRefusalText({ decision: 'none' })).toBe('');
  });
});

describe('toolGuardText (deny-only; unreadable fails open, unevaluable fails closed)', () => {
  const input = (command: string) => ({ ownerId: 'o', workspaceId: 'w', call: call(command) });

  it('refuses a matching call, naming the identity and rule', async () => {
    expect(await toolGuardText(input('rm -rf /'), async () => noRmRules()))
      .toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
    expect(await toolGuardText(input('ls'), async () => noRmRules())).toBe('');
  });

  it('fails OPEN when the applied artifact cannot be read, or nothing is applied', async () => {
    expect(await toolGuardText(input('rm -rf /'), async () => { throw new Error('artifact unreadable'); })).toBe('');
    expect(await toolGuardText(input('rm -rf /'), async () => null)).toBe('');
  });

  it('fails CLOSED when a worn guard cannot see the whole input', async () => {
    // A tool no kernel rail reads, so the worn guard is the one that answers.
    const text = await toolGuardText(
      { ownerId: 'o', workspaceId: 'w', call: { tool: 'Write', input: null, client: 'claude', inputTruncated: true } },
      async () => noRmRules(),
    );
    expect(text).toMatch(/^Refused by identity safe-coder rule no-rm: tool input exceeds/);
  });

  it('overlaps independent authority reads within the native guard wall and retains identity denial', async () => {
    vi.useFakeTimers();
    try {
      planExecutionGuard.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(null), 1100)));
      const read = vi.fn(() => new Promise<WornSyncRules>(resolve => setTimeout(() => resolve(noRmRules()), 600)));
      let settled = false;
      const pending = toolGuardText(input('rm -rf build'), read).then(text => { settled = true; return text; });
      await vi.advanceTimersByTimeAsync(1100);
      expect(settled).toBe(true);
      expect(await pending).toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
      expect(read).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('returns plan refusal without waiting for an independent identity read', async () => {
    vi.useFakeTimers();
    try {
      planExecutionGuard.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({
        code: 'plan_execution_not_ready', reason: 'plan not started',
      }), 100)));
      const read = vi.fn(() => new Promise<WornSyncRules>(() => {}));
      const pending = toolGuardText(input('ls'), read);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe('plan_execution_not_ready: plan not started');
      expect(read).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('compactionSinkDue (D-024 §3)', () => {
  const store = (exists: () => Promise<boolean>) => ({ exists: vi.fn(exists) });

  it('re-seeds on compact and clear without reading the turn store', async () => {
    for (const source of ['compact', 'clear']) {
      const turns = store(async () => false);
      expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source }, turns)).toBe(true);
      expect(turns.exists).not.toHaveBeenCalled();
    }
  });

  it('re-seeds a startup only for an owner that has taken a hook turn before', async () => {
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'startup' }, store(async () => true))).toBe(true);
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'startup' }, store(async () => false))).toBe(false);
  });

  it('treats an unreadable turn store as no signal', async () => {
    const turns = store(async () => { throw new Error('store down'); });
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'startup' }, turns)).toBe(false);
  });

  it('never fires on any other source', async () => {
    const turns = store(async () => true);
    expect(await compactionSinkDue({ ownerId: 'o', workspaceId: 'w', source: 'resume' }, turns)).toBe(false);
    expect(turns.exists).not.toHaveBeenCalled();
  });
});

describe('POST /agent-mcp/tool-guard', () => {
  it('keeps plan and identity reads inside the reserved database scope', async () => {
    let inPriorityScope = false;
    priorityOrgPgMock.mockImplementationOnce(async (run) => {
      inPriorityScope = true;
      try { return await run(); } finally { inPriorityScope = false; }
    });
    planExecutionGuard.mockImplementation(async () => { expect(inPriorityScope).toBe(true); return null; });
    readAppliedWornRulesMock.mockImplementation(async () => { expect(inPriorityScope).toBe(true); return null; });
    expect(await post('/agent-mcp/tool-guard', { owner: 'builder', workspace: 'ws', tool: 'Edit' }))
      .toEqual({ ok: true, text: '' });
    expect(priorityOrgPgMock).toHaveBeenCalledTimes(1);
    expect(inPriorityScope).toBe(false);
  });

  it('reports separate plan and identity durations without changing the verdict', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    planExecutionGuard.mockImplementation(async () => { now += 25; return null; });
    readAppliedWornRulesMock.mockImplementation(async () => { now += 75; return null; });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit' }),
      }));
      expect(await res.json()).toEqual({ ok: true, text: '' });
      expect(res.headers.get('Server-Timing')).toBe('guard;dur=100.0, setup;dur=0.0, plan;dur=25.0, identity;dur=75.0');
    } finally { clock.mockRestore(); }
  });

  it('carries bounded identity-stage timings through a refused call without logging tool content', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readAppliedWornRulesMock.mockImplementation(async (_owner, _workspace, observeTiming) => {
      observeTiming({ stage: 'applied_revision', durationMs: 600 });
      observeTiming({ stage: 'applied_artifact', durationMs: 50 });
      observeTiming({ stage: 'local_rules', durationMs: 40 });
      observeTiming({ stage: 'local_rules', durationMs: 10 });
      observeTiming({ stage: 'private-owner-content', durationMs: 1 });
      observeTiming({ stage: 'invalid', durationMs: Infinity });
      now += 700;
      return noRmRules();
    });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Bash',
          input: { command: 'rm -rf build', secret: NEVER_EMIT_MARKER } }),
      }));
      expect((await res.json()).text).toContain('Refused by identity');
      expect(res.headers.get('Server-Timing')).toContain(
        'identity_applied_revision;dur=600.0, identity_applied_artifact;dur=50.0, identity_local_rules;dur=50.0');
      expect(log).toHaveBeenCalledWith('[tool-guard-timing]', JSON.stringify({
        totalMs: 700, setupMs: 0, planMs: 0, identityMs: 700, aborted: false,
        identityStages: { applied_revision: 600, applied_artifact: 50, local_rules: 50 },
      }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEVER_EMIT_MARKER);
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-owner-content');
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it('links bounded completed database timings to the exact aborted guard request while preserving refusal', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const guardRequestId = randomUUID();
    const record = (pool: string, queryId: number) => recordPgResult(pool, {
      connectionId: 1, queryId, backendPid: 2,
      query: `SELECT '${NEVER_EMIT_MARKER}' FROM harness_shared.session_briefs`,
      command: 'SELECT', rowCount: 1, wireBytes: 20, elapsedMs: 15, preBuildMs: 550, status: 'ok',
      context: capturePgDiagnosticContext(),
    });
    withNamedQueryDiagnosticContext('unrelated-request', () => record('org-admin-priority', 999));
    planExecutionGuard.mockImplementation(async () => {
      expect(capturePgDiagnosticContext()).toMatchObject({
        state: 'linked', correlation: { requestId: guardRequestId, operation: 'native-tool-guard' },
      });
      for (let id = 1; id <= 10; id++) record('org-admin-priority', id);
      record('org-app-priority', 11);
      now = 600;
      controller.abort();
      return { code: 'plan_execution_not_ready', reason: 'Bound plan is draft' };
    });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit', guardRequestId,
          input: { secret: NEVER_EMIT_MARKER } }),
      }));
      expect((await res.json()).text).toBe('plan_execution_not_ready: Bound plan is draft');
      expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
      const diagnostic = JSON.parse(log.mock.calls.find(([label]) => label === '[tool-guard-timing]')![1]);
      expect(diagnostic).toMatchObject({ guardRequestId, aborted: true,
        pgTimings: { coverage: 'retained-completed-results-only',
          timing: 'query-build-to-terminal-not-acquisition',
          preBuildTiming: 'first-query-handle-to-build-excludes-lazy-time' } });
      expect(diagnostic.pgTimings.pools[0]).toMatchObject({ pool: 'org-admin-priority', omittedMatched: 2 });
      expect(diagnostic.pgTimings.pools[0].queries.map((query: { queryId: number }) => query.queryId))
        .toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
      expect(diagnostic.pgTimings.pools[1].queries).toEqual([expect.objectContaining({
        queryId: 11, preBuildMs: 550, elapsedMs: 15, queryFamily: 'select:harness_shared.session_briefs',
      })]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEVER_EMIT_MARKER);
      expect(JSON.stringify(log.mock.calls)).not.toContain('999');
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it('retains slow-request attribution after client abort without logging tool content', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    planExecutionGuard.mockImplementation(async () => { now += 1600; controller.abort(); return null; });
    try {
      await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit', input: { secret: NEVER_EMIT_MARKER } }),
      }));
      expect(log).toHaveBeenCalledWith('[tool-guard-timing]', JSON.stringify({
        totalMs: 1600, setupMs: 0, planMs: 1600, identityMs: 0, aborted: true,
      }));
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEVER_EMIT_MARKER);
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it('aggregates bounded plan-stage timings on a refused request without leaking binding content', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    planExecutionGuard.mockImplementation(async ({ observeTiming }) => {
      observeTiming({ stage: 'bindings', durationMs: 10 });
      observeTiming({ stage: 'start_gate', durationMs: 900 });
      observeTiming({ stage: 'start_gate', durationMs: 800 });
      observeTiming({ stage: 'private-plan-content', durationMs: 1 });
      observeTiming({ stage: 'invalid', durationMs: NaN });
      now += 1710;
      return { code: 'plan_execution_not_ready', reason: 'Bound plan is draft' };
    });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit' }),
      }));
      expect(await res.json()).toEqual({ ok: true, text: 'plan_execution_not_ready: Bound plan is draft' });
      expect(res.headers.get('Server-Timing')).toContain('plan_bindings;dur=10.0, plan_start_gate;dur=1700.0');
      expect(log).toHaveBeenCalledWith('[tool-guard-timing]', JSON.stringify({
        totalMs: 1710, setupMs: 0, planMs: 1710, identityMs: null, aborted: false,
        planStages: { bindings: 10, start_gate: 1700 },
      }));
      expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-plan-content');
    } finally { clock.mockRestore(); log.mockRestore(); }
  });
  it('preserves the complete snapshot timing vocabulary alongside outer guard stages', async () => {
    // Preserve the observed prefix that exhausted the old 16-stage budget, then
    // complete the current emitter vocabulary without importing snapshot runtime.
    const sources = {
      plan: true, rubric: true, vetting: true, lineage: true, grading: true, clauses: true,
      'plan-items': true, 'work-contracts': true, 'lineage-parties': true, evidence: true,
    } satisfies Record<import('../../../acceptance-bar-contract-snapshot').AcceptanceBarSnapshotSource, true>;
    const stages = [
      'bindings', 'goal_module', 'goal_read', 'goal', 'start_proof', 'scope', 'plan_row',
      'goal_leg_work_items', 'goal_leg_plan_items', 'goal_leg_fleet', 'goal_leg_override', 'goal_leg_links',
      'goal_pool_acquire_work_items', 'goal_pool_acquire_plan_items', 'goal_pool_acquire_fleet', 'goal_pool_acquire_override',
      'plan_row_resolve_scope', 'plan_row_wait_for_begin', 'plan_row_workspace_setup',
      'plan_row_acquire_and_setup', 'plan_row_query', 'plan_row_finish_transaction', 'plan_row_row',
      'audit', 'activation', 'admission',
      ...Object.keys(sources).map(source => `start_gate_snapshot_${source}`),
      'start_gate', 'spec_quality', 'critique', 'recheck', 'binding',
    ];
    const expectedStages = Object.fromEntries(stages.map((stage, index) => [stage, index + 1]));
    expectedStages['start_gate_snapshot_plan-items']! += 5;
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    planExecutionGuard.mockImplementation(async ({ observeTiming }) => {
      for (const [index, stage] of stages.entries()) observeTiming({ stage, durationMs: index + 1 });
      observeTiming({ stage: 'start_gate_snapshot_plan-items', durationMs: 5 });
      now = 1000;
      return { code: 'plan_execution_not_ready', reason: 'Bound plan is draft' };
    });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit',
          input: { secret: NEVER_EMIT_MARKER } }),
      }));
      expect(await res.json()).toEqual({ ok: true, text: 'plan_execution_not_ready: Bound plan is draft' });
      expect(res.headers.get('Server-Timing')).toBe('guard;dur=1000.0, setup;dur=0.0, plan;dur=1000.0, '
        + Object.entries(expectedStages).map(([stage, duration]) => `plan_${stage};dur=${duration.toFixed(1)}`).join(', '));
      expect(log).toHaveBeenCalledWith('[tool-guard-timing]', JSON.stringify({
        totalMs: 1000, setupMs: 0, planMs: 1000, identityMs: null, aborted: false, planStages: expectedStages,
      }));
      expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEVER_EMIT_MARKER);
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it('keeps extended plan timings bounded and rejects invalid labels and durations', async () => {
    const stages = Array.from({ length: 48 }, (_, index) =>
      `stage_${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}`);
    planExecutionGuard.mockImplementation(async ({ observeTiming }) => {
      for (const stage of ['private-plan-content', 'start_gate_snapshot_private-content', 'x'.repeat(33),
        'start_gate_snapshot_work-contracts_extra', 'bad;dur=1', 'bad stage', 'Uppercase', '']) {
        observeTiming({ stage, durationMs: 1 });
      }
      for (const durationMs of [NaN, Infinity, -1]) observeTiming({ stage: 'invalid', durationMs });
      for (const stage of stages) observeTiming({ stage, durationMs: 0 });
      observeTiming({ stage: 'overflow', durationMs: 1 });
      observeTiming({ stage: stages[0], durationMs: 2 });
      return { code: 'plan_execution_not_ready', reason: 'Bound plan is draft' };
    });
    const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
      method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit' }),
    }));
    const planTimings = res.headers.get('Server-Timing')!.split(', ').filter(timing => timing.startsWith('plan_'));
    expect(planTimings).toEqual(stages.map((stage, index) => `plan_${stage};dur=${index === 0 ? '2.0' : '0.0'}`));
  });

  it('correlates a slow refused request across its response and server timing log', async () => {
    const guardRequestId = '550e8400-e29b-41d4-a716-446655440000';
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    planExecutionGuard.mockImplementation(async () => {
      now += 1600;
      return { code: 'plan_execution_not_ready', reason: 'Bound plan is draft' };
    });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit',
          guardRequestId, input: { secret: NEVER_EMIT_MARKER } }),
      }));
      expect(await res.json()).toEqual({ ok: true, text: 'plan_execution_not_ready: Bound plan is draft' });
      expect(res.headers.get('X-Papercusp-Guard-Request-Id')).toBe(guardRequestId);
      const diagnostic = JSON.parse(log.mock.calls.find(([label]) => label === '[tool-guard-timing]')![1]);
      expect(diagnostic).toMatchObject({
        guardRequestId, totalMs: 1600, setupMs: 0, planMs: 1600, identityMs: null, aborted: false,
        pgTimings: { coverage: 'retained-completed-results-only' },
      });
      expect(diagnostic.pgTimings.pools.every((pool: { queries: unknown[] }) => pool.queries.length === 0)).toBe(true);
      expect(JSON.stringify(log.mock.calls)).not.toContain(NEVER_EMIT_MARKER);
      expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it('does not reflect an invalid caller identifier into headers or timing logs', async () => {
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    planExecutionGuard.mockImplementation(async () => { now += 600; return null; });
    try {
      const res = await route('/agent-mcp/tool-guard').handler(new Request('http://localhost/api/agent-mcp/tool-guard', {
        method: 'POST', body: JSON.stringify({ owner: 'builder', workspace: 'ws', tool: 'Edit',
          guardRequestId: 'private-caller-prose' }),
      }));
      expect(res.headers.has('X-Papercusp-Guard-Request-Id')).toBe(false);
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-caller-prose');
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it('refuses a native edit or shell write when durable plan readiness refuses, even without worn rules', async () => {
    planExecutionGuard.mockResolvedValue({ code: 'plan_execution_not_ready', reason: 'Bound plan is draft' });
    for (const tool of ['apply_patch', 'Write', 'exec_command']) {
      expect(await post('/agent-mcp/tool-guard', { owner: 'builder', workspace: 'ws', tool, input: { cmd: 'touch x' } }))
        .toEqual({ ok: true, text: 'plan_execution_not_ready: Bound plan is draft' });
      expect(planExecutionGuard).toHaveBeenLastCalledWith({ ownerId: 'builder', workspaceId: 'ws', toolName: tool,
        args: { cmd: 'touch x' }, observeTiming: expect.any(Function) });
    }
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });
  it('reads nothing for a request without an owner or a tool', async () => {
    expect(await post('/agent-mcp/tool-guard', { tool: 'Bash' })).toEqual({ ok: true, text: '' });
    expect(await post('/agent-mcp/tool-guard', { owner: 'o' })).toEqual({ ok: true, text: '' });
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });

  it("refuses from the wearer's worn rules, in the resolved workspace", async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    const out = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: '*', tool: 'Bash', input: { command: 'rm -rf /' } });
    expect(readAppliedWornRulesMock).toHaveBeenCalledWith('o', 'ws-active', expect.any(Function));
    expect(out.text).toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
  });

  it('gives a Codex call the verdict a Claude call gets: the client is recorded, never read', async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    for (const [client, tool] of [['claude', 'Bash'], ['codex', 'shell']] as const) {
      const denied = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', client, tool, input: { command: 'rm -rf /' } });
      expect(denied.text).toBe('Refused by identity safe-coder rule no-rm: no recursive deletes');
      expect(await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', client, tool, input: { command: 'ls' } }))
        .toEqual({ ok: true, text: '' });
    }
  });

  it('drops a cut input rather than evaluating a partial one', async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    const out = await post('/agent-mcp/tool-guard', {
      owner: 'o', workspace: 'w', tool: 'Bash', input: { command: 'ls' }, inputTruncated: true,
    });
    expect(out.text).toMatch(/tool input exceeds/);
  });

  /*
   * R-11 (identity-system-everything-migration-2026-10-18 P-004): no budget
   * drops a kernel safety rail. The port charges nothing to the session's hook
   * turn, so a turn that has spent its whole sink budget still gets the rail;
   * and a shell input over the guard input bound is refused, never passed unread.
   */
  it('a kernel rail refuses through the port after the hook turn has exhausted its sink budget', async () => {
    readAppliedWornRulesMock.mockResolvedValue(noRmRules());
    const out = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', tool: 'Bash', input: { command: 'git reset --hard' } });
    expect(out.text).toMatch(/^Refused by identity kernel rule kernel:git-reset-hard: /);
    expect(turnReadMock).not.toHaveBeenCalled();
    expect(turnChargeMock).not.toHaveBeenCalled();
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });

  it('a shell input over the guard input bound is refused by the kernel with no identity package worn', async () => {
    for (const tool of ['Bash', 'shell', 'capability:bash']) {
      const out = await post('/agent-mcp/tool-guard', { owner: 'o', workspace: 'w', tool, input: { command: 'git reset --hard' }, inputTruncated: true });
      expect(out.text, tool).toMatch(/^Refused by identity kernel rule kernel:guard-input-bound: tool input exceeds the guard input bound/);
    }
    expect(readAppliedWornRulesMock).not.toHaveBeenCalled();
  });
});

describe('POST /agent-mcp/stop-context and /agent-mcp/compaction-context', () => {
  it('evaluates the stop sink and returns its text', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    const out = await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' });
    expect(evaluateHookContextSinkMock.mock.calls[0]![0]).toMatchObject({ ownerId: 'o', workspaceId: 'w', sink: 'stop' });
    expect(evaluateHookContextSinkMock.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(out.text).toBe('STOP CONTEXT');
  });

  it('enrolls Codex Stop-hook context with machine provenance before returning it', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    const out = await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w', client: 'codex' });
    expect(tagTurnForInjectionMock).toHaveBeenCalledWith({
      sid: 'o',
      origin: 'stop-hook',
      text: 'STOP CONTEXT',
    });
    expect(out.text).toBe('⟦turn-origin:stop-hook nonce:aabbccddeeff0011⟧\nSTOP CONTEXT');
  });

  it('leads with the held-work refusal and keeps the identity text (WI-6554700010015550)', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    turnEndHeldWorkMock.mockResolvedValue('TURN-END REFUSED');
    const out = await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' });
    expect(turnEndHeldWorkMock).toHaveBeenCalledWith({ ownerId: 'o', workspaceId: 'w' });
    expect(out.text).toBe('TURN-END REFUSED\n\nSTOP CONTEXT');
  });

  it('answers inside the wall when the held-work read never settles', async () => {
    turnEndHeldWorkMock.mockReturnValue(new Promise(() => undefined));
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'STOP CONTEXT', result: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    expect(await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' })).toEqual({ ok: true, text: 'STOP CONTEXT' });
    expect(Date.now() - started).toBeLessThan(2400);
    warn.mockRestore();
  });

  it('answers inside the wall when the sink never settles', async () => {
    evaluateHookContextSinkMock.mockReturnValue(new Promise(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    expect(await post('/agent-mcp/stop-context', { owner: 'o', workspace: 'w' })).toEqual({ ok: true, text: '' });
    expect(Date.now() - started).toBeLessThan(2400);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('identity-hook:stop exceeded 2000ms'));
    warn.mockRestore();
  });

  it('evaluates the compaction sink only when a fresh context is due', async () => {
    evaluateHookContextSinkMock.mockResolvedValue({ text: 'RESEED', result: null });
    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'resume' })).text).toBe('');
    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'startup' })).text).toBe('');
    expect(evaluateHookContextSinkMock).not.toHaveBeenCalled();

    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'compact' })).text).toBe('RESEED');
    expect(evaluateHookContextSinkMock.mock.calls[0]![0]).toMatchObject({ sink: 'compaction' });

    turnsExistMock.mockResolvedValue(true);
    expect((await post('/agent-mcp/compaction-context', { owner: 'o', workspace: 'w', source: 'startup' })).text).toBe('RESEED');
  });
});
