import { describe, expect, it, vi } from 'vitest';
import type { ToolResult, UnifiedToolContext } from '@papercusp/tooldef';
import { DURABLE_RUN_FOLLOW_UP, runDurableCode } from './durable-run';
import { inspectOrchestration } from '../orchestration/inspect';
import { runOrchestration, type ServerScriptRunDeps } from '../orchestration/run';
import { MAX_ORCHESTRATION_SCRIPT_CHARS, orchestrationScriptSourceSchema } from '../orchestration/public-contract';
import codeRunTool from './run';

const ctx = { workspaceId: 'ws-code', harnessSlug: 'papercusp', role: 'su', uiClientId: 'su-code',
  idempotencyKey: 'original-request' } as UnifiedToolContext;
const execution = { lifecycle: 'background', durability: 'durable', timeoutSec: 180 } as const;
const workflowId = 'orchestrate-durable:ws-code:original';
function payload(result: ToolResult) {
  const text = result.content.find(item => item.type === 'text');
  if (!text || !('text' in text)) throw new Error('missing result');
  return JSON.parse(text.text);
}
function admission() {
  const startDurable = vi.fn().mockResolvedValue({ workflowId });
  const runCode = vi.fn<ServerScriptRunDeps['runCode']>();
  return { startDurable, runCode, deps: { inspect: inspectOrchestration,
    run: (args: Parameters<typeof runOrchestration>[0], caller: UnifiedToolContext) =>
      runOrchestration(args, caller, { server: { startDurable, runCode } }) } };
}

describe('code:run durable adapter uses the existing orchestration lifecycle', () => {
  it('admits the exact large script, inputs, attribution and independent deadline once', async () => {
    const { deps, startDurable, runCode } = admission();
    const script = '/*' + 'large script '.repeat(2500) + '*/ return inputs.answer;';
    expect(script.length).toBeGreaterThan(20_000);
    expect(codeRunTool.args.safeParse({ script, execution }).success).toBe(true);
    expect(orchestrationScriptSourceSchema.safeParse({ source: script }).success).toBe(true);
    const result = payload(await runDurableCode({ script, execution, inputs: { answer: 42 }, work_item_id: 'WI-1' }, ctx, deps));
    expect(result.state, JSON.stringify(result)).toBe('complete');
    expect(JSON.parse(result.summary)).toEqual({ durableRun: { workflowId, status: 'admitted' } });
    // The admission reply is where a compact-tier caller learns the follow-up doors.
    expect(result.next).toBe(DURABLE_RUN_FOLLOW_UP);
    expect(startDurable).toHaveBeenCalledTimes(1);
    expect(startDurable).toHaveBeenCalledWith(expect.objectContaining({
      script, inputs: { answer: 42 }, timeoutSec: 180, link: { workItemId: 'WI-1' },
      caller: { ownerId: 'su-code', workspaceId: 'ws-code', harnessSlug: 'papercusp', role: 'su' },
      pin: { sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), bindingsSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }));
    expect(runCode).not.toHaveBeenCalled();
  });

  it.each(['return Date.now();', 'return Math.random();', 'await sleep(120000);'])('refuses replay-unsafe source before enqueue: %s', async script => {
    const { deps, startDurable, runCode } = admission();
    const result = payload(await runDurableCode({ script, execution }, ctx, deps));
    expect(result).toMatchObject({ state: 'error', error: { code: 'durable_replay_unsafe' } });
    expect(startDurable).not.toHaveBeenCalled();
    expect(runCode).not.toHaveBeenCalled();
  });

  it('refuses unknown tools before enqueue', async () => {
    const { deps, startDurable } = admission();
    const result = payload(await runDurableCode({ script: 'return await tools.no_such_tool.read({});', execution }, ctx, deps));
    expect(result.ok).toBe(false);
    expect(startDurable).not.toHaveBeenCalled();
  });

  it('does not duplicate the orchestration read/control selectors on code:run', () => {
    // WI-6554700010029562: these selectors cost ~600 B of every seeded catalog while
    // orchestrate:inspect / orchestrate:run already own them.
    expect(Object.keys(codeRunTool.args.shape)).not.toContain('durableRun');
    expect(Object.keys(codeRunTool.args.shape)).not.toContain('durableControl');
    expect(DURABLE_RUN_FOLLOW_UP).toContain('orchestrate:inspect { durableRun:');
    expect(DURABLE_RUN_FOLLOW_UP).toContain('orchestrate:run { durableControl:');
  });

  it('the named follow-up read door returns the terminal output without starting another workflow', async () => {
    const status = { workflowId, status: 'SUCCESS', outcome: { status: 'succeeded', summary: { answer: 42 }, steps: [] }, steps: [] };
    const durableStatus = vi.fn().mockResolvedValue(status);
    const result = await inspectOrchestration({ durableRun: { workflowId } }, ctx, { durableStatus });
    expect((result as ToolResult & { data?: unknown }).data).toEqual({ ok: true, durableRun: status });
    expect(durableStatus).toHaveBeenCalledExactlyOnceWith(workflowId);
  });

  it('the named follow-up doors refuse foreign-workspace reads and cancellation before touching DBOS', async () => {
    const foreign = 'orchestrate-durable:other:run';
    const durableStatus = vi.fn();
    const durableControl = vi.fn();
    const read = await inspectOrchestration({ durableRun: { workflowId: foreign } }, ctx, { durableStatus });
    const cancel = payload(await runOrchestration({ durableControl: { workflowId: foreign, action: 'cancel' } }, ctx, { durableControl }));
    expect((read as ToolResult & { data?: unknown }).data).toMatchObject({ ok: false, error: { code: 'capability_denied' } });
    expect(cancel).toMatchObject({ state: 'error', error: { code: 'capability_denied' } });
    expect(durableStatus).not.toHaveBeenCalled();
    expect(durableControl).not.toHaveBeenCalled();
  });

  it('the named follow-up control door cancels the existing workflow without executing source', async () => {
    const durableControl = vi.fn().mockResolvedValue(undefined);
    const result = payload(await runOrchestration({ durableControl: { workflowId, action: 'cancel' } }, ctx, { durableControl }));
    expect(result.state).toBe('complete');
    expect(durableControl).toHaveBeenCalledExactlyOnceWith({ workflowId, action: 'cancel' });
  });

  it('rejects incomplete requests and foreground-only options without any adapter calls', async () => {
    const inspect = vi.fn(); const run = vi.fn();
    const requests = [
      ...[{ kernel: {} }, { dryRun: true }, { timeoutSec: 10 }].map(extra => ({ script: 'return 1;', execution, ...extra })),
      { execution }, { script: 'return 1;' },
    ];
    for (const request of requests) {
      const result = payload(await runDurableCode(request, ctx, { inspect, run }));
      expect(result).toMatchObject({ ok: false, executed: false, error: 'durable_execution_args_invalid' });
      expect(result.message).toContain(DURABLE_RUN_FOLLOW_UP);
    }
    expect(inspect).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  it('bounds source size at the same limit on both public doors', () => {
    const script = 'x'.repeat(MAX_ORCHESTRATION_SCRIPT_CHARS + 1);
    expect(codeRunTool.args.safeParse({ script }).success).toBe(false);
    expect(orchestrationScriptSourceSchema.safeParse({ source: script }).success).toBe(false);
  });
});
