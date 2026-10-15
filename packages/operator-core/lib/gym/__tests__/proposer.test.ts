import { describe, it, expect, vi } from 'vitest';
import { bindNativeGymLlmCalls, buildProposerPrompt, parseProposal, proposeCandidate, throwWithCostUsd, withGymLlmNetworkRetry, type ProposeInput } from '../proposer';
import type { GymLlmCall } from '../task-generator';
type NativeGymRequest = Parameters<Parameters<typeof bindNativeGymLlmCalls>[0]>[0];

/**
 * Reflective proposer (P-015, prompts-only per D-015). Reads the parent's worst
 * train traces + judge rationales + the running changelog and emits a targeted
 * PROMPT diff for one/few roles → a candidate overlay. The judge's rationales are
 * the reflection signal. LLM injected.
 */
const input: ProposeInput = {
  parentOverlay: { promptOverrides: { worker: '# worker v1' } },
  worstTraces: [
    { taskId: 't1', composite: 4.2, rationale: 'worker shipped without handling the empty-list case' },
    { taskId: 't2', composite: 5.0, rationale: 'validator rubber-stamped a missing error path' },
  ],
  changelog: 'cycle 1: tightened worker error-handling (accepted, +0.4).',
  proposerModel: 'claude-sonnet-4-6',
};

describe('native Gym LLM consumer binding', () => {
  const receipt = { text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 };
  const judgeRequest = () => ({ model: 'claude-opus-4-8', thinkingBudgetTokens: 32_000,
    maxTokens: 36_096, messages: [{ role: 'user' as const, content: 'frozen task' }] });

  it('requires the frozen judge bound on the actual cycle transport without changing model or thinking', async () => {
    const call = vi.fn(async (_request: NativeGymRequest) => receipt);
    const { judge } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {} });
    const request = judgeRequest();
    await expect(judge(request)).resolves.toBe(receipt);
    expect(call.mock.calls[0]![0]).toEqual({ ...request, requireOutputTokenLimit: true,
      priority: 'gym', harnessSlug: 'native-harness' });
  });

  it.each([undefined, 0, -1, 0.5, NaN, Infinity])('refuses invalid frozen judge bound %s before transport', async maxTokens => {
    const call = vi.fn(async (_request: NativeGymRequest) => receipt);
    const { judge } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {} });
    await expect(judge({ ...judgeRequest(), maxTokens })).rejects.toMatchObject({ costUsd: 0 });
    expect(call).not.toHaveBeenCalled();
  });

  it('preserves the private frozen request across a known-zero retry and caller mutation', async () => {
    const request = judgeRequest();
    const original = structuredClone(request);
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { costUsd: 0 }))
      .mockResolvedValue(receipt);
    const sleep = vi.fn(async () => {
      request.model = 'changed-model'; request.maxTokens = 1; request.thinkingBudgetTokens = 0;
      request.messages[0]!.content = 'changed task';
    });
    const { judge } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {}, sleep });
    await expect(judge(request)).resolves.toBe(receipt);
    expect(call.mock.calls).toEqual([0, 1].map(() => [{ ...original, requireOutputTokenLimit: true,
      priority: 'gym', harnessSlug: 'native-harness' }]));
  });

  it('preserves an unsupported-provider refusal and does not retry or change the frozen bound', async () => {
    const failure = Object.assign(new Error('Required output token limit unsupported'), { costUsd: 0 });
    const call = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => {});
    const { judge } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {}, sleep });
    await expect(judge(judgeRequest())).rejects.toBe(failure);
    expect(call).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps the proposer model and existing supplied bounds on the native transport', async () => {
    const call = vi.fn(async (_request: NativeGymRequest) => receipt);
    const { proposer } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {} });
    const request = { model: 'gpt-6.1-sol:xhigh', maxTokens: 500,
      messages: [{ role: 'user' as const, content: 'propose' }] };
    await expect(proposer(request)).resolves.toBe(receipt);
    expect(call.mock.calls[0]![0]).toEqual({ ...request, requireOutputTokenLimit: true,
      priority: 'gym', harnessSlug: 'native-harness' });
  });

  it.each([undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an absent or invalid native proposer bound %s before transport', async maxTokens => {
      const call = vi.fn(async (_request: NativeGymRequest) => receipt);
      const sleep = vi.fn(async () => {});
      const { proposer } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {}, sleep });
      await expect(proposer({ model: 'claude-sonnet-4-6', maxTokens,
        messages: [{ role: 'user', content: 'PRIVATE_PROPOSER_TASK' }] }))
        .rejects.toMatchObject({ costUsd: 0 });
      expect(call).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    });

  it('preserves the configured native proposer bound and request across a measured-zero retry', async () => {
    const request = { model: 'gpt-6.1-sol:xhigh', maxTokens: 257,
      messages: [{ role: 'user' as const, content: 'PRIVATE_PROPOSER_TASK' }] };
    const original = structuredClone(request);
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { costUsd: 0 }))
      .mockResolvedValue(receipt);
    const { proposer } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {}, sleep: async () => {
      request.maxTokens = 1; request.model = 'changed'; request.messages[0]!.content = 'changed';
    } });
    await expect(proposer(request)).resolves.toBe(receipt);
    expect(call.mock.calls).toEqual([0, 1].map(() => [{ ...original, requireOutputTokenLimit: true,
      priority: 'gym', harnessSlug: 'native-harness' }]));
  });
});

describe('native Gym network retry spend evidence', () => {
  it.each([
    ['absent', {}], ['positive', { costUsd: 0.23 }],
    ['negative', { costUsd: -1 }], ['nonfinite', { costUsd: NaN }],
    ['non-numeric', { costUsd: '0' }],
    ['missing zero', { costUsd: 0, costUsdMeasurementMissing: true }],
    ['partial zero', { costUsd: 0, unreportedFrames: 1 }],
    ['invalid completeness', { costUsd: 0, costUsdMeasurementMissing: 'false' }],
    ['invalid frame count', { costUsd: 0, unreportedFrames: NaN }],
  ])('preserves %s failed spend without another dispatch', async (_label, usage) => {
    const failure = Object.assign(new Error('fetch failed'), usage);
    const call = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ costUsd: 0.02 });
    const sleep = vi.fn(async () => {});
    await expect(withGymLlmNetworkRetry(call, { log: () => {}, sleep })()).rejects.toBe(failure);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recovers only after complete measured-zero failures and preserves the successful receipt', async () => {
    const receipt = { costUsd: 0.02, costUsdMeasurementMissing: true, unreportedFrames: 1 };
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { costUsd: 0 }))
      .mockRejectedValueOnce(Object.assign(new Error('EAI_AGAIN'), {
        costUsd: 0, costUsdMeasurementMissing: false, unreportedFrames: 0,
      })).mockResolvedValue(receipt);
    const sleep = vi.fn(async () => {});
    const args = { model: input.proposerModel };
    await expect(withGymLlmNetworkRetry(call, { log: () => {}, sleep })(args)).resolves.toBe(receipt);
    expect(call.mock.calls).toEqual([[args], [args], [args]]);
    expect(sleep.mock.calls).toEqual([[2_000], [4_000]]);
  });

  it('stops at a later unknown-spend failure, preserving that exact error', async () => {
    const unknown = new Error('ECONNRESET');
    const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { costUsd: 0 }))
      .mockRejectedValueOnce(unknown).mockResolvedValue({ costUsd: 0.02 });
    const sleep = vi.fn(async () => {});
    await expect(withGymLlmNetworkRetry(call, { log: () => {}, sleep })()).rejects.toBe(unknown);
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[2_000]]);
  });

  it('exhausts three known-zero attempts without sleeping after the last', async () => {
    const failure = Object.assign(new Error('ETIMEDOUT'), { costUsd: 0 });
    const call = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => {});
    await expect(withGymLlmNetworkRetry(call, { log: () => {}, sleep })()).rejects.toBe(failure);
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [4_000]]);
  });

  it('keeps non-network errors outside the retry lane', async () => {
    const failure = Object.assign(new Error('HTTP 400'), { costUsd: 0 });
    const call = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => {});
    await expect(withGymLlmNetworkRetry(call, { log: () => {}, sleep })()).rejects.toBe(failure);
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('buildProposerPrompt', () => {
  it('feeds the failures, rationales, and changelog, and asks for a JSON prompt diff', () => {
    const { system, user } = buildProposerPrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toMatch(/prompt/i);
    expect(user).toContain('worker shipped without handling the empty-list case');
    expect(user).toContain('validator rubber-stamped');
    expect(user).toContain('cycle 1: tightened worker error-handling');
  });

  // P-032 (learning-system-audit): triage-routed gym ideas as candidate directions.
  it('zero candidate directions → the prompt is byte-identical (purely additive)', () => {
    const base = buildProposerPrompt(input);
    expect(buildProposerPrompt({ ...input, candidateDirections: [] })).toEqual(base);
    expect(buildProposerPrompt({ ...input, candidateDirections: undefined })).toEqual(base);
    expect(base.user).not.toMatch(/Candidate directions/i);
  });

  it('routed gym ideas appear as an optional-directions section', () => {
    const { user } = buildProposerPrompt({
      ...input,
      candidateDirections: ['Validator rubber-stamps — tighten the validator prompt', 'Workers skip re-reads'],
    });
    expect(user).toMatch(/## Candidate directions/);
    expect(user).toContain('- Validator rubber-stamps — tighten the validator prompt');
    expect(user).toContain('- Workers skip re-reads');
    // advisory, not a mandate — the proposer may ignore them
    expect(user).toMatch(/otherwise ignore/i);
  });
});

describe('parseProposal', () => {
  it('parses {promptOverrides, rationale} and validates roles', () => {
    const p = parseProposal({ promptOverrides: { worker: '# worker v2' }, rationale: 'handle empty list' });
    expect(p.promptOverrides).toEqual({ worker: '# worker v2' });
    expect(p.rationale).toBe('handle empty list');
  });
  it('throws on an unknown role or missing rationale', () => {
    expect(() => parseProposal({ promptOverrides: { nonsense: 'x' }, rationale: 'r' })).toThrow();
    expect(() => parseProposal({ promptOverrides: { worker: 'x' } })).toThrow();
  });
});

function fakeLlm(json: unknown): GymLlmCall {
  return async () => ({ text: '', json, costUsd: 0.02, inputTokens: 200, outputTokens: 80 });
}

describe('proposeCandidate', () => {
  it('forwards a supplied proposer output bound without changing its model or prompt', async () => {
    const requests: Parameters<GymLlmCall>[0][] = [];
    const llmCall: GymLlmCall = async request => {
      requests.push(request); return { text: '', json: { promptOverrides: { worker: 'x' }, rationale: 'r' },
        costUsd: 0, inputTokens: 0, outputTokens: 0 };
    };
    await proposeCandidate({ ...input, maxTokens: 257 } as ProposeInput, { llmCall });
    expect(requests[0]).toMatchObject({ model: input.proposerModel, maxTokens: 257 });
    expect(requests[0]!.system).toBe(buildProposerPrompt(input).system);
    expect(requests[0]!.messages[0]!.content).toBe(buildProposerPrompt(input).user);
    await proposeCandidate(input, { llmCall });
    expect(requests[1]).not.toHaveProperty('maxTokens');
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid supplied proposer output bound %s with known-zero usage', async maxTokens => {
      const llmCall = vi.fn(fakeLlm({ promptOverrides: { worker: 'x' }, rationale: 'r' }));
      await expect(proposeCandidate({ ...input, maxTokens } as ProposeInput, { llmCall }))
        .rejects.toMatchObject({ costUsd: 0 });
      expect(llmCall).not.toHaveBeenCalled();
    });
  it.each([
    { label: 'absent', usage: {}, subtotal: 0 },
    { label: 'NaN', usage: { costUsd: NaN }, subtotal: 0 },
    { label: 'infinite', usage: { costUsd: Infinity }, subtotal: 0 },
    { label: 'negative', usage: { costUsd: -1 }, subtotal: 0 },
    { label: 'partial', usage: { costUsd: 0.42, unreportedFrames: 1 }, subtotal: 0.42 },
    { label: 'marked missing', usage: { costUsd: 0.42, costUsdMeasurementMissing: true }, subtotal: 0.42 },
  ])('preserves incomplete $label usage on a valid proposal', async ({ usage, subtotal }) => {
    const response = { text: '', json: { promptOverrides: { validator: '# validator v2' }, rationale: 'r' },
      inputTokens: 12, outputTokens: 4, ...usage };
    const value = await proposeCandidate(input, { llmCall: async () => response as Awaited<ReturnType<GymLlmCall>> });
    expect(value).toMatchObject({ overlay: { promptOverrides: { worker: '# worker v1', validator: '# validator v2' } },
      rationale: 'r', costUsd: subtotal, costUsdMeasurementMissing: true });
    if ('unreportedFrames' in usage) expect(value).toMatchObject({ unreportedFrames: usage.unreportedFrames });
  });

  it.each([0, 0.42])('keeps complete successful spend $%s complete', async costUsd => {
    const value = await proposeCandidate(input, { llmCall: async () => ({ text: '',
      json: { promptOverrides: { worker: '# worker v2' }, rationale: 'r' },
      costUsd, inputTokens: 12, outputTokens: 4 }) });
    expect(value.costUsd).toBe(costUsd);
    expect(value).not.toHaveProperty('costUsdMeasurementMissing');
  });

  it.each([
    { label: 'absent', usage: {} },
    { label: 'NaN', usage: { costUsd: NaN } },
    { label: 'infinite', usage: { costUsd: Infinity } },
    { label: 'negative', usage: { costUsd: -1 } },
    { label: 'partial', usage: { costUsd: 0.42, unreportedFrames: 1 } },
    { label: 'marked missing', usage: { costUsd: 0.42, costUsdMeasurementMissing: true } },
  ])('retains incomplete $label failed-call usage instead of inventing a complete zero', async ({ usage }) => {
    const failure = Object.assign(new Error('failed after dispatch'), usage);
    let caught: unknown;
    try {
      await proposeCandidate(input, { llmCall: async () => { throw failure; } });
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(caught).toMatchObject({ costUsdMeasurementMissing: true,
      costUsd: 'costUsd' in usage && typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)
        && usage.costUsd >= 0 ? usage.costUsd : 0 });
  });

  it.each([0, 0.42])('retains a complete failed-call measurement of $%s', async costUsd => {
    const failure = Object.assign(new Error('measured failed call'), { costUsd });
    await expect(proposeCandidate(input, { llmCall: async () => { throw failure; } }))
      .rejects.toMatchObject({ costUsd });
    expect(failure).not.toHaveProperty('costUsdMeasurementMissing');
  });

  it('preserves missingness and the subtotal when a non-Error failure is wrapped', () => {
    const failure = { costUsd: 0.2, unreportedFrames: 1, costUsdMeasurementMissing: true };
    expect(() => throwWithCostUsd(failure, 0.3)).toThrow();
    try { throwWithCostUsd(failure, 0.3); } catch (error) {
      expect(error).toMatchObject({ costUsd: 0.5, costUsdMeasurementMissing: true, unreportedFrames: 1 });
    }
  });

  it('a measured zero response remains complete when validation fails', async () => {
    let caught: unknown;
    try {
      await proposeCandidate(input, { llmCall: async () => ({ text: 'invalid', costUsd: 0,
        inputTokens: 0, outputTokens: 0 }) });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ costUsd: 0 });
    expect(caught).not.toHaveProperty('costUsdMeasurementMissing');
  });

  it('merges the proposed role change onto the parent overlay (prompts-only)', async () => {
    const cand = await proposeCandidate(input, {
      llmCall: fakeLlm({ promptOverrides: { validator: '# validator stricter' }, rationale: 'stop rubber-stamping' }),
    });
    // parent worker override preserved, validator change added
    expect(cand.overlay.promptOverrides).toEqual({
      worker: '# worker v1',
      validator: '# validator stricter',
    });
    expect(cand.rationale).toBe('stop rubber-stamping');
    expect(cand.diffFromParent).toContain('validator');
    expect(cand.costUsd).toBeCloseTo(0.02, 6);
  });

  it('overrides a role the parent already changed', async () => {
    const cand = await proposeCandidate(input, {
      llmCall: fakeLlm({ promptOverrides: { worker: '# worker v2' }, rationale: 'handle empty list' }),
    });
    expect(cand.overlay.promptOverrides.worker).toBe('# worker v2');
  });

  it('calls the proposer model', async () => {
    let model = '';
    await proposeCandidate(input, {
      llmCall: async (o) => {
        model = o.model;
        return { text: '', json: { promptOverrides: { worker: 'x' }, rationale: 'r' }, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      },
    });
    expect(model).toBe('claude-sonnet-4-6');
  });

  it('preserves provider cost when response validation fails after the call', async () => {
    await expect(
      proposeCandidate(input, {
        llmCall: async () => ({
          text: '',
          json: { promptOverrides: { nonsense: 'x' }, rationale: 'invalid role' },
          costUsd: 0.37,
          inputTokens: 10,
          outputTokens: 5,
        }),
      }),
    ).rejects.toMatchObject({ costUsd: 0.37 });
  });
});
