/**
 * P-028/P-032 live competitor-driver tests. PG-free, python-free, LLM-free: a fake `exec` returns canned
 * runner JSON, fake clone/extractDiff stand in for git. Proves the driver maps the python runner protocol →
 * the canonical HiveBacklogResult (ArmAttempt + git diff + tagged MAST coordEvents), and the deferred-failure
 * contract (clone/exec/parse failures → infra-error attempts, never aborting the backlog).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  makeCompetitorDriver,
  bindLiveCompetitorDrivers,
  parseRunnerResult,
  runnerScriptPath,
  RESULT_SENTINEL,
  DEFAULT_COMPETITOR_MODEL,
  DEFAULT_THINKING_BUDGET_TOKENS,
  type ExecFn,
} from './competitor-live';
import { runCompetitorBacklog, clearCompetitorDrivers } from './competitor-runner';
import type { HiveBacklogRunRequest } from './hive-backlog';
import type { BenchTask, CloneTaskRepo, ExtractDiff, TaskCheckout } from './types';

function task(id: string): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId: id, problemStatement: `fix ${id}`, repo: 'astropy/astropy', baseCommit: 'abc', graderMeta: {} };
}
function req(arm: 'langgraph' | 'crewai' | 'openhands-async', ids: string[]): HiveBacklogRunRequest {
  return { arm, suite: 'swe-bench-pro', runId: 'run-1', seed: 0, backlog: ids.map(task), budget: {} };
}

const clone: CloneTaskRepo = async (t) => ({ dir: `/tmp/${t.instanceId}`, repo: t.repo ?? '', baseCommit: t.baseCommit ?? '', cleanup: async () => {} });
const extractDiff: ExtractDiff = async () => 'DIFF-CONTENT';

/** A fake exec that emits the sentinel-delimited runner result (with a noisy banner before it). */
function okExec(over: Partial<Record<string, unknown>> = {}): ExecFn {
  const result = {
    ok: true, tokensIn: 120, tokensOut: 60, costUsd: 0.02, turns: 5, stopReason: 'done',
    events: [{ ts: 0, kind: 'spawn', agent: 'planner' }, { ts: 10, kind: 'edit', agent: 'worker' }],
    error: null, ...over,
  };
  return async () => ({ stdout: `OpenHands banner...\nlog line\n${RESULT_SENTINEL}${JSON.stringify(result)}\n`, stderr: '', code: 0 });
}

afterEach(() => clearCompetitorDrivers());

describe('parseRunnerResult', () => {
  it('extracts the sentinel-delimited JSON past banners', () => {
    const r = parseRunnerResult(`hi\nbanner\n${RESULT_SENTINEL}{"ok":true,"tokensIn":1}\n`);
    expect(r?.ok).toBe(true);
    expect(r?.tokensIn).toBe(1);
  });
  it('returns null when there is no sentinel', () => {
    expect(parseRunnerResult('just logs, no result')).toBeNull();
  });
});

describe('runnerScriptPath', () => {
  it('resolves the per-framework runner file', () => {
    expect(runnerScriptPath('langgraph')).toMatch(/competitors\/run_langgraph\.py$/);
    expect(runnerScriptPath('openhands-async')).toMatch(/competitors\/run_openhands\.py$/);
  });
});

describe('makeCompetitorDriver — runner protocol → canonical HiveBacklogResult', () => {
  it('routes competitor LLM egress through the bounded benchmark priority lane', async () => {
    let capturedInput: Record<string, unknown> | undefined;
    let capturedEnv: Record<string, string> | undefined;
    const exec: ExecFn = async (_bin, _args, stdin, opts) => {
      capturedInput = JSON.parse(stdin) as Record<string, unknown>;
      capturedEnv = opts.env;
      return okExec()(_bin, _args, stdin, opts);
    };
    const driver = makeCompetitorDriver({
      competitorId: 'langgraph', pythonBin: 'py', runnerScript: 's.py', model: 'anthropic/x',
      clone, extractDiff, exec,
    });
    await driver.run(req('langgraph', ['a']));
    expect(capturedInput?.priority).toBe('benchmark');
    expect(capturedEnv?.ANTHROPIC_CUSTOM_HEADERS).toBe('x-papercusp-priority: benchmark');
  });

  it('maps a successful run to ArmAttempts + git diff + tagged MAST coordEvents', async () => {
    const driver = makeCompetitorDriver({
      competitorId: 'langgraph', pythonBin: 'py', runnerScript: 's.py', model: 'anthropic/x',
      clone, extractDiff, exec: okExec(), now: (() => { let t = 1000; return () => (t += 100); })(),
    });
    const r = await driver.run(req('langgraph', ['a', 'b']));
    expect(r.arm).toBe('langgraph');
    expect(r.taskResults).toHaveLength(2);
    const at = r.taskResults[0].attempt;
    expect(at.arm).toBe('langgraph');
    expect(at.stopReason).toBe('done');
    expect(at.diff).toBe('DIFF-CONTENT');
    expect(at.tokensIn).toBe(120);
    expect(at.turns).toBe(5);
    // events tagged with the backlog task id for MAST attribution
    expect(r.coordEvents.length).toBe(4); // 2 events × 2 tasks
    expect(r.coordEvents.every((e) => e.taskId === 'a' || e.taskId === 'b')).toBe(true);
  });

  it('a runner error result → infra-error attempt (no diff), surfaced not scored', async () => {
    const driver = makeCompetitorDriver({
      competitorId: 'crewai', pythonBin: 'py', runnerScript: 's.py', model: 'anthropic/x',
      clone, extractDiff, exec: okExec({ ok: false, error: 'agent crashed', stopReason: 'error' }),
    });
    const r = await driver.run(req('crewai', ['a']));
    expect(r.taskResults[0].attempt.stopReason).toBe('error');
    expect(r.taskResults[0].attempt.generationError).toMatch(/agent crashed/);
    expect(r.taskResults[0].attempt.diff).toBe('');
  });

  it('no sentinel in stdout → infra-error attempt + error coordEvent, backlog not aborted', async () => {
    const badExec: ExecFn = async () => ({ stdout: 'only logs, crashed before result', stderr: 'boom', code: 1 });
    const driver = makeCompetitorDriver({
      competitorId: 'langgraph', pythonBin: 'py', runnerScript: 's.py', model: 'anthropic/x', clone, extractDiff, exec: badExec,
    });
    const r = await driver.run(req('langgraph', ['a', 'b']));
    expect(r.taskResults).toHaveLength(2);
    expect(r.taskResults.every((t) => t.attempt.stopReason === 'error')).toBe(true);
    expect(r.coordEvents.every((e) => e.kind === 'error')).toBe(true);
  });

  it('a clone failure for one task degrades that task only', async () => {
    const flakyClone: CloneTaskRepo = async (t) => {
      if (t.instanceId === 'a') throw new Error('network down');
      return { dir: `/tmp/${t.instanceId}`, repo: '', baseCommit: '', cleanup: async () => {} };
    };
    const driver = makeCompetitorDriver({
      competitorId: 'crewai', pythonBin: 'py', runnerScript: 's.py', model: 'anthropic/x', clone: flakyClone, extractDiff, exec: okExec(),
    });
    const r = await driver.run(req('crewai', ['a', 'b']));
    const a = r.taskResults.find((t) => t.attempt.instanceId === 'a')!;
    const b = r.taskResults.find((t) => t.attempt.instanceId === 'b')!;
    expect(a.attempt.stopReason).toBe('error');
    expect(a.attempt.generationError).toMatch(/clone failed: network down/);
    expect(b.attempt.stopReason).toBe('done');
  });
});

describe('bindLiveCompetitorDrivers — one-call binding', () => {
  it.each([
    { thinkingBudgetTokens: 1024, maxTokens: 2048 },
    { thinkingBudgetTokens: 1024, maxTokens: undefined },
    { thinkingBudgetTokens: undefined, maxTokens: 40000 },
    { thinkingBudgetTokens: undefined, maxTokens: undefined },
  ])('preserves configured runner token limits and defaults (%j)', async (limits) => {
    const inputs: Array<Record<string, unknown>> = [];
    const reply = okExec();
    const exec: ExecFn = async (bin, args, stdin, opts) => {
      inputs.push(JSON.parse(stdin) as Record<string, unknown>);
      return reply(bin, args, stdin, opts);
    };
    bindLiveCompetitorDrivers({ ...limits, clone, extractDiff, exec });
    for (const arm of ['openhands-async', 'crewai', 'langgraph'] as const) {
      const result = await runCompetitorBacklog(req(arm, ['a']));
      expect(result.runError).toBeUndefined();
      expect(result.taskResults[0].attempt.stopReason).toBe('done');
    }
    const thinking = limits.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
    expect(inputs).toHaveLength(3);
    expect(inputs.map(input => input.thinkingBudgetTokens)).toEqual(Array(3).fill(thinking));
    expect(inputs.map(input => input.maxTokens)).toEqual(Array(3).fill(limits.maxTokens ?? thinking + 16384));
  });

  it.each([undefined, 'anthropic/custom-model'])('sends the documented model to every bound runner (override %s)', async (model) => {
    const inputs: Array<Record<string, unknown>> = [];
    const reply = okExec();
    const exec: ExecFn = async (bin, args, stdin, opts) => {
      inputs.push(JSON.parse(stdin) as Record<string, unknown>);
      return reply(bin, args, stdin, opts);
    };
    bindLiveCompetitorDrivers({ model, clone, extractDiff, exec });
    for (const arm of ['openhands-async', 'crewai', 'langgraph'] as const) {
      const result = await runCompetitorBacklog(req(arm, ['a']));
      expect(result.runError).toBeUndefined();
      expect(result.taskResults[0].attempt.stopReason).toBe('done');
    }
    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => input.model)).toEqual(Array(3).fill(model ?? DEFAULT_COMPETITOR_MODEL));
  });

  it('binds the core three and routes runCompetitorBacklog through the live driver', async () => {
    const bound = bindLiveCompetitorDrivers({ model: 'anthropic/x', clone, extractDiff, exec: okExec() });
    expect(bound).toEqual(['openhands-async', 'crewai', 'langgraph']);
    const r = await runCompetitorBacklog(req('langgraph', ['a']));
    expect(r.runError).toBeUndefined();
    expect(r.taskResults[0].attempt.arm).toBe('langgraph');
    expect(r.taskResults[0].attempt.diff).toBe('DIFF-CONTENT');
  });
});
