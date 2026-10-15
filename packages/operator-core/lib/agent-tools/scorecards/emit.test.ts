import { describe, expect, it, vi } from 'vitest';
import { lookupByMcpName, readJsonResult } from '@papercusp/agent-mcp';
import { dispatchProjectedTool, type ProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';
import scorecardEmitTool, {
  attachScorecardCompletionReceipt,
  cleanupAcceptanceGraderTasks,
  resolveDeterministicCheckScope,
  resolveHarnessTargetHive,
  scorecardAbortCompletionReceipt,
} from './emit';
import { COORD_ROLES } from '../coordination/roles';
import { mockResolvedTyped } from '../../testing/typed-mock';

const task = (taskId: string, label: string, headless = true) => ({
  taskId,
  workspaceId: 'ws-test',
  rootTaskId: taskId,
  class: 'agent-session',
  title: label,
  argv: [],
  launchedBy: 'su-implementer',
  confined: true,
  state: 'running',
  startedAt: '2026-08-14T00:00:00.000Z',
  lastSeenAt: '2026-08-14T00:00:00.000Z',
  detail: { label, headless },
}) as never;

describe('dedicated acceptance judge lifecycle', () => {
  it('admits judge on scorecards:emit without widening the shared coordination role set', () => {
    expect(scorecardEmitTool.agentRoles).toContain('judge');
    expect(COORD_ROLES).not.toContain('judge');
  });

  it('documents that the persisted acceptance card still carries complete ratings, adopted by reference', () => {
    // P-003 (review-verification-efficiency-2026-09-09) removed the
    // TRANSCRIPTION, not the PERSISTENCE. The card filed for an acceptance
    // verdict must still be schema-complete: plan-acceptance-gate drops
    // incomplete cards from its `complete` filter, and the verdict then reads as
    // `acceptance_not_recorded`. The old wording ("ratings field remains
    // schema-required") is gone; the property it protected is not, so this
    // guard follows the property instead of being deleted with the wording.
    // `args` is a ZodXor (the mutually-exclusive arg variants), NOT a bare
    // ZodObject: it exposes `_def.options`, never a top-level `.shape`. Reading
    // `.shape` here resolved to undefined and the `?? ''` degraded the guard to
    // matching an empty string — which reads as "the wording was deleted" when
    // every description is intact. Resolve the shape from either form, and fail
    // loudly if neither yields one, so a future args refactor cannot quietly
    // turn this back into a guard that asserts nothing.
    type DescribedField = { description?: string } | undefined;
    type FieldShape = Record<string, DescribedField>;
    const resolveShape = (node: unknown): FieldShape | undefined => {
      const n = node as {
        shape?: FieldShape | (() => FieldShape);
        _def?: { shape?: FieldShape | (() => FieldShape); options?: unknown[] };
      };
      const direct = n?.shape ?? n?._def?.shape;
      const shape = typeof direct === 'function' ? direct() : direct;
      if (shape && 'acceptance' in shape) return shape;
      for (const option of n?._def?.options ?? []) {
        const nested = resolveShape(option);
        if (nested) return nested;
      }
      return undefined;
    };
    const shape = resolveShape(scorecardEmitTool.args);
    expect(shape, 'scorecards:emit args no longer expose an `acceptance` field shape').toBeDefined();
    expect(shape?.acceptance?.description ?? '').toMatch(/always carries complete ratings/i);
    expect(shape?.acceptanceOf?.description ?? '').toMatch(/adopts its ratings verbatim/i);
    expect(String(scorecardEmitTool.description)).toMatch(/Every emit persists complete ratings/i);
    expect(JSON.stringify(scorecardEmitTool.guidance)).toMatch(/acceptance adopts ratings via acceptanceOf/i);
  });

  it('defers ambient result trimming until the result door can preserve a committed rating', () => {
    // scorecards:emit is a write receipt. A session-tier bounded projection can
    // strip one populated canonicalRatings entry before the outer result door
    // has a chance to apply its scorecards:emit preservation path and spill the
    // full result. Keep ambient trim off; explicit payloadTier overrides remain
    // caller-controlled by the shared tier resolver.
    expect(scorecardEmitTool.ignoreSessionPayloadTier).toBe(true);
  });

  it('preserves all six populated ratings through the real wrapper in a trimmed session', async () => {
    const ratings = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        `criterion-${index + 1}`,
        { rating: 'pass', evidence: `verified criterion-${index + 1} ${'e'.repeat(1_800)}` },
      ]),
    );
    const data = { ok: true, created: true, issueId: 'EI-trimmed-session-fixture', canonicalRatings: ratings };
    expect(JSON.stringify(data).length).toBeGreaterThan(8_000);

    // Exercise the registered defineTool wrapper and its actual payload-tier
    // dispatch. Stub only the ledger-writing handler so this test does not add
    // a synthetic scorecard to the shared workspace.
    const handler = vi.spyOn(scorecardEmitTool, 'handler');
    mockResolvedTyped(handler, { data });
    try {
      const projected = lookupByMcpName('scorecards:emit');
      expect(projected?.ignoreSessionPayloadTier).toBe(true);
      const dispatched = await dispatchProjectedTool(
        projected!,
        'scorecards:emit',
        { rubricRef: 'test-rubric' },
        {
          log: vi.fn(),
          signal: new AbortController().signal,
          progress: vi.fn(),
          emit: vi.fn(),
          workspaceId: 'default',
          runId: 'scorecards-emit-trimmed-session-regression',
          isSuperuser: true,
          uiClientId: 'su-scorecards-emit-test',
          role: 'su',
          gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp',
          requestedFormat: 'json',
          contextTier: 'trimmed',
          tx: {},
        },
        {},
      );

      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
      const payload = readJsonResult<{ canonicalRatings: typeof ratings; _projection?: unknown }>(dispatched.result!);
      expect(payload?._projection).toBeUndefined();
      expect(payload?.canonicalRatings).toEqual(ratings);
    } finally {
      handler.mockRestore();
    }
  });

  it('kills every live headless task for the exact acceptance-rubric label prefix', async () => {
    const list = vi.fn(async () => [
      task('task-a', 'acceptance-grader:rubric-a:abc123'),
      task('task-b', 'acceptance-grader:rubric-a:def456'),
      task('task-visible', 'acceptance-grader:rubric-a:ghi789', false),
      task('task-other', 'acceptance-grader:rubric-b:abc123'),
    ]);
    const kill = vi.fn(async (taskId: string) => ({ ok: true, taskId, action: 'kill' as const }));

    const result = await cleanupAcceptanceGraderTasks(
      'rubric-a',
      { workspaceId: 'ws-test' },
      { list: list as never, kill: kill as never },
    );

    expect(list).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      states: ['pending', 'running'],
      classes: ['agent-session'],
      limit: 2_000,
    });
    expect(result).toMatchObject({ matched: 2, prefix: 'acceptance-grader:rubric-a:' });
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith('task-a', { includeSubtree: true, escalateAfterMs: 5_000 });
    expect(kill).toHaveBeenCalledWith('task-b', { includeSubtree: true, escalateAfterMs: 5_000 });
  });

  it('escalates grader cleanup to SIGKILL on a bounded grace instead of leaving survivors live (EI-21390074563933948)', async () => {
    // The filed incident: a bare-SIGTERM cleanup returned incomplete with 28
    // processes still alive because the grader tree ignored TERM. These are the
    // rubric's OWN throwaway graders, so cleanup must always arm the escalation
    // window — a regression that drops escalateAfterMs fails here.
    const list = vi.fn(async () => [task('task-a', 'acceptance-grader:rubric-a:abc123')]);
    const kill = vi.fn(async (taskId: string) => ({ ok: true, taskId, action: 'kill' as const }));

    await cleanupAcceptanceGraderTasks('rubric-a', { workspaceId: 'ws-test' }, { list: list as never, kill: kill as never });

    const [, opts] = kill.mock.calls[0] as unknown as [string, { includeSubtree?: boolean; escalateAfterMs?: number }];
    expect(opts.includeSubtree).toBe(true);
    expect(opts.escalateAfterMs).toBeGreaterThan(0);
    expect(opts.escalateAfterMs).toBeLessThanOrEqual(10_000);
  });
});

describe('scorecard abort completion receipts', () => {
  it('preserves distinct force-write receipts when outer cancellation follows the nested commit', async () => {
    const committed = new Map<string, unknown>();
    const attemptIds: string[] = [];
    const runAttempt = async (issueId: string) => {
      const caller = new AbortController();
      const ctx: UnifiedToolContext = {
        log: vi.fn(),
        signal: caller.signal,
        progress: vi.fn(),
        emit: vi.fn(),
      };
      const tool: ProjectedTool = {
        pluginName: 'scorecard-receipt-fixture',
        description: 'Exercise the production scorecard receipt through the real dispatcher.',
        inputSchema: { type: 'object' },
        capabilities: [],
        expose: { mcp: { name: 'scorecards:emit' } },
        idempotent: scorecardEmitTool.idempotent,
        abortCompletionReceipt: (_args, result, attempt) => {
          attemptIds.push(attempt.callId);
          return scorecardEmitTool.abortCompletionReceipt?.({} as never, result, attempt);
        },
        fn: async () => {
          const data = attachScorecardCompletionReceipt({ ok: true, created: true, issueId });
          committed.set(issueId, data);
          // The write already landed when the caller's enclosing orchestration aborts.
          caller.abort();
          return { content: [{ type: 'text', text: JSON.stringify(data) }] };
        },
      };
      return dispatchProjectedTool(tool, 'scorecards:emit', { force: true }, ctx, {});
    };

    const first = await runAttempt('EI-forced-first');
    const second = await runAttempt('EI-forced-second');

    expect([...committed.keys()]).toEqual(['EI-forced-first', 'EI-forced-second']);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.result?._meta?.abortCompletionReceipt).toMatchObject({
      status: 'recorded',
      effectRef: 'EI-forced-first',
      attemptId: attemptIds[0],
    });
    expect(second.result?._meta?.abortCompletionReceipt).toMatchObject({
      status: 'recorded',
      effectRef: 'EI-forced-second',
      attemptId: attemptIds[1],
    });
    expect(attemptIds).toHaveLength(2);
    expect(attemptIds[0]).toEqual(expect.any(String));
    expect(attemptIds[0]).not.toBe(attemptIds[1]);
  });

  it('fails closed through the dispatcher when a committed write lacks its scorecard receipt', async () => {
    const caller = new AbortController();
    let committed = false;
    const tool: ProjectedTool = {
      pluginName: 'scorecard-receipt-fixture',
      description: 'A committed fixture write whose completion receipt was lost.',
      inputSchema: { type: 'object' },
      capabilities: [],
      expose: { mcp: { name: 'scorecards:emit' } },
      idempotent: scorecardEmitTool.idempotent,
      abortCompletionReceipt: (_args, result, attempt) =>
        scorecardEmitTool.abortCompletionReceipt?.({} as never, result, attempt),
      fn: async () => {
        committed = true;
        caller.abort();
        return { content: [{ type: 'text', text: '{"ok":true,"issueId":"EI-missing-receipt"}' }] };
      },
    };
    const result = await dispatchProjectedTool(tool, 'scorecards:emit', { force: true }, {
      log: vi.fn(),
      signal: caller.signal,
      progress: vi.fn(),
      emit: vi.fn(),
    }, {});

    expect(committed).toBe(true);
    expect(result.ok).toBe(false);
    // The caller's own signal aborted, so the code is 'aborted' (not a dispatcher timeout);
    // the write still committed, so the receipt must survive (WI-10006764).
    expect(result.error).toMatchObject({
      code: 'aborted',
      meta: {
        abortSource: 'parent-signal',
        abortCompletionReceipt: {
          status: 'recovery-incomplete',
          failures: ['missing-completion-receipt'],
          attemptId: expect.any(String),
        },
      },
    });
  });

  it('identifies both a newly-created card and an unchanged-evidence replay by durable issue id', () => {
    expect(attachScorecardCompletionReceipt({ ok: true, created: true, issueId: 'EI-new' })).toMatchObject({
      completionReceipt: { status: 'recorded', effectRef: 'EI-new' },
    });
    expect(
      attachScorecardCompletionReceipt({
        ok: true,
        created: false,
        previousIssueId: 'EI-existing',
        reason: 'unchanged-evidence',
      }),
    ).toMatchObject({
      completionReceipt: {
        status: 'recorded',
        effectRef: 'EI-existing',
        reason: 'unchanged-evidence',
      },
    });
  });

  it('distinguishes a no-write refusal from an incomplete successful receipt', () => {
    expect(attachScorecardCompletionReceipt({ ok: false, code: 'stale_pass_blocked' })).toMatchObject({
      completionReceipt: { status: 'not-recorded', reason: 'stale_pass_blocked' },
    });
    expect(attachScorecardCompletionReceipt({ ok: true, created: true, issueId: null })).toMatchObject({
      completionReceipt: {
        status: 'recovery-incomplete',
        failures: ['missing-issue-id'],
      },
    });
  });

  it('requires the serialized result to carry its explicit receipt and keeps force calls non-idempotent', () => {
    expect(scorecardEmitTool.idempotent).not.toBe(true);
    expect(scorecardEmitTool.abortCompletionReceipt).toEqual(expect.any(Function));
    expect(
      scorecardAbortCompletionReceipt({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              created: true,
              issueId: 'EI-force-attempt',
              completionReceipt: { status: 'recorded', effectRef: 'EI-force-attempt' },
            }),
          },
        ],
      }),
    ).toEqual({ status: 'recorded', effectRef: 'EI-force-attempt' });
    expect(
      scorecardAbortCompletionReceipt({ content: [{ type: 'text', text: '{"ok":true,"issueId":"EI-no-receipt"}' }] }),
    ).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-completion-receipt'],
    });
  });
});

// plan-verification-friction-reduction-2026-10-11 P-005 (R-6): `harness` names the subject
// plan's harness, as in every plans tool, so it maps to targetHive — never to sourceHive.
describe('scorecards:emit harness alias (P-005)', () => {
  it('accepts harness and resolves the subject target hive from it', async () => {
    const parsed = scorecardEmitTool.args.safeParse({
      rubricRef: 'acceptance-friction-plan',
      harness: 'papercusp',
      sourceHive: 'grader-hive',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const resolved = resolveHarnessTargetHive(parsed.data);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.args).toMatchObject({ targetHive: 'papercusp', sourceHive: 'grader-hive' });
    expect(resolved.args).not.toHaveProperty('harness');
    // The resolved targetHive is what scopes the card's deterministic checks to the subject tree.
    const scope = await resolveDeterministicCheckScope(resolved.args, {
      ctxHarness: 'papercusp',
      workspaceId: 'ws-test',
      checkRoot: '/tmp/subject-tree',
    });
    expect(scope).toMatchObject({ root: '/tmp/subject-tree', workspaceId: 'ws-test', harnessSlug: 'papercusp' });
    // A matching targetHive is the same instruction, not a conflict.
    expect(resolveHarnessTargetHive({ harness: 'papercusp', targetHive: 'papercusp' }))
      .toEqual({ ok: true, args: { targetHive: 'papercusp' } });
  });

  it('refuses a call whose harness disagrees with targetHive', async () => {
    const args = { rubricRef: 'acceptance-friction-plan', harness: 'papercusp', targetHive: 'portal' };
    expect(scorecardEmitTool.args.safeParse(args).success).toBe(true);
    const refused = resolveHarnessTargetHive(args);
    expect(refused).toMatchObject({ ok: false, code: 'harness_target_hive_mismatch' });
    // The public handler refuses before any read or write, with a not-recorded receipt.
    const result = (await scorecardEmitTool.handler(args as never, {} as never)) as { data: unknown };
    expect(result.data).toMatchObject({ ok: false, code: 'harness_target_hive_mismatch' });
    expect(JSON.stringify(result.data)).toContain('not-recorded');
  });
});
