import { describe, expect, it, vi } from 'vitest';
import { runRepeatedSessions } from './repeated-session';
import type { AgentRunOutput, RunAgentInput } from './run-topology';

const input: RunAgentInput<{ edits: number }> = {
  task: { benchmark: 'frontier-swe', instanceId: 'fixture', problemStatement: 'Implement the task.', graderMeta: {} },
  handle: { edits: 0 }, role: 'solver', arm: 'repeated-session', teamKey: 'fixture-pair', topic: '',
  directive: 'Use only task files.', forbidTools: ['coord:*'], attemptBudget: { maxCostUsd: 10, maxModelCalls: 20 },
  candidates: [{ index: 0, submission: 'Previous conversational answer must not carry.' }],
};
const receipt = (over: Partial<AgentRunOutput> = {}): AgentRunOutput => ({
  submission: 'partial work', status: 'completed', costUsd: 1, modelCalls: 2,
  tokensIn: 10, tokensOut: 5, turns: 3, ...over,
});

describe('FSWE-P019-MATCHEDCOST repeated fresh sessions', () => {
  it('never opens another session once cumulative spend reaches measured treatment spend', async () => {
    const launch = vi.fn(async () => receipt());
    const result = await runRepeatedSessions(input, { treatmentCostUsd: 2, maxSessions: 10, openFreshSession: launch });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls).toHaveLength(2);
    expect(result.stop).toBe('matched-cost');
    expect(result.usage).toEqual({ costUsd: 2, modelCalls: 4, tokensIn: 20, tokensOut: 10, turns: 6 });
  });

  it('passes only remaining caps and keeps workspace edits with distinct fresh-session identities', async () => {
    const calls: RunAgentInput<typeof input.handle>[] = [];
    const result = await runRepeatedSessions(input, { treatmentCostUsd: 2, maxSessions: 10,
      openFreshSession: async request => { calls.push(request); request.handle.edits++; return receipt(); } });
    expect(calls.map(c => c.attemptBudget)).toEqual([
      { maxCostUsd: 2, maxModelCalls: 20 }, { maxCostUsd: 1, maxModelCalls: 18 },
    ]);
    expect(calls[0].handle).toBe(input.handle);
    expect(calls[1].handle).toBe(input.handle);
    expect(calls.map(c => c.teamKey)).toEqual(['fixture-pair/fresh-session/0', 'fixture-pair/fresh-session/1']);
    expect(calls.every(c => c.candidates === undefined && c.directive.includes('What is not done yet?'))).toBe(true);
    expect(result.sessions).toHaveLength(2);
  });

  it('records actual overshoot and refuses another launch instead of clipping spend', async () => {
    const launch = vi.fn(async () => receipt({ costUsd: 3 }));
    const result = await runRepeatedSessions(input, { treatmentCostUsd: 2, maxSessions: 10, openFreshSession: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.usage.costUsd).toBe(3);
    expect(result.stop).toBe('matched-cost');
  });

  it('opens no session for a zero-spend treatment', async () => {
    const launch = vi.fn(async () => receipt());
    expect((await runRepeatedSessions(input, { treatmentCostUsd: 0, maxSessions: 10, openFreshSession: launch })).stop).toBe('matched-cost');
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    { maxCostUsd: 1 }, { maxModelCalls: 2 }, { maxTokens: 15 },
  ])('honors the original aggregate cap %j', async cap => {
    const launch = vi.fn(async () => receipt());
    const result = await runRepeatedSessions({ ...input, attemptBudget: cap },
      { treatmentCostUsd: 5, maxSessions: 10, openFreshSession: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe('budget-exhausted');
  });

  it('checks elapsed wall time before opening each session', async () => {
    let clock = 0;
    const launch = vi.fn(async () => { clock += 5; return receipt(); });
    const result = await runRepeatedSessions({ ...input, attemptBudget: { maxWallMs: 5 } },
      { treatmentCostUsd: 5, maxSessions: 10, openFreshSession: launch, now: () => clock });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe('budget-exhausted');
  });

  it('charges separate cache tokens before passing the next fresh-session allowance', async () => {
    const requests: RunAgentInput<typeof input.handle>[] = [];
    const cached = { ...receipt(), tokensCacheRead: 20, tokensCacheWrite: 5 };
    const result = await runRepeatedSessions({ ...input, attemptBudget: { maxTokens: 70 } },
      { treatmentCostUsd: 10, maxSessions: 10, openFreshSession: async request => {
        requests.push(request); return cached;
      } });
    expect(requests.map(request => request.attemptBudget.maxTokens)).toEqual([70, 30]);
    expect(result.stop).toBe('budget-exhausted');
    expect(result.usage).toMatchObject({ tokensIn: 20, tokensOut: 10, tokensCacheRead: 40, tokensCacheWrite: 10 });
  });

  it.each(['tokensCacheRead', 'tokensCacheWrite'] as const)('refuses invalid %s before opening another session', async field => {
    const launch = vi.fn(async () => ({ ...receipt(), [field]: NaN }));
    const result = await runRepeatedSessions(input, { treatmentCostUsd: 10, maxSessions: 10, openFreshSession: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe('error');
    expect(result.error).toContain(field);
  });

  it('bounds zero-cost sessions', async () => {
    const launch = vi.fn(async () => receipt({ costUsd: 0, modelCalls: 0 }));
    expect((await runRepeatedSessions(input, { treatmentCostUsd: 2, maxSessions: 3, openFreshSession: launch })).stop).toBe('session-limit');
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it.each([NaN, Infinity, -1])('fails closed on invalid session spend %s', async costUsd => {
    const launch = vi.fn(async () => receipt({ costUsd }));
    const result = await runRepeatedSessions(input, { treatmentCostUsd: 2, maxSessions: 10, openFreshSession: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe('error');
    expect(result.sessions[0].costUsd).toBe(costUsd);
  });

  it('retains infra-failure cost and stops opening sessions', async () => {
    const launch = vi.fn(async () => receipt({ status: 'error', error: 'provider failed' }));
    const result = await runRepeatedSessions(input, { treatmentCostUsd: 2, maxSessions: 10, openFreshSession: launch });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result.usage.costUsd).toBe(1);
    expect(result.error).toBe('provider failed');
  });

  it.each([NaN, Infinity, -1])('refuses an invalid treatment spend %s before launching', async treatmentCostUsd => {
    const launch = vi.fn(async () => receipt());
    await expect(runRepeatedSessions(input, { treatmentCostUsd, maxSessions: 10, openFreshSession: launch })).rejects.toThrow(/treatmentCostUsd/);
    expect(launch).not.toHaveBeenCalled();
  });
});
