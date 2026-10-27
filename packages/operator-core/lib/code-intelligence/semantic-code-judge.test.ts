import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ modelCalls: [] as Record<string, unknown>[], routes: [] as string[], response: '' }));
vi.mock('../agent-chat-stream', () => ({ resolveStatelessTransport: (account: string) => {
  h.routes.push(account); return { baseURL: 'http://127.0.0.1:1234/', token: 'fixture-delegated-token' };
} }));
vi.mock('../llm-testing/llm-client', () => ({ llmCall: async (request: Record<string, unknown>) => {
  h.modelCalls.push(request); return { text: h.response, inputTokens: 1, outputTokens: 1, costUsd: 0, raw: {},
    execution: { model: request.model, codeHash: null, loadedCode: { llmClient: 'fixture' } } };
} }));
import { extractSemanticFunctions } from './semantic-code';
import { loadSemanticJudgePrompt, isVerifiedSemanticPair, judgeSemanticPair, summarizeSemanticFunction,
  type SemanticJudgeCall, type SemanticPair } from './semantic-code-judge';
import recorded from './__fixtures__/semantic-judge-replay-v1.json';
import frozen from './__fixtures__/semantic-calibration-v1.json';
import contractsV2 from './__fixtures__/semantic-judge-contracts-v2.json';
import * as ts from 'typescript';

describe('semantic judge identity prompt', () => {
  it('loads the fixed identity document and pins the original prompt bytes', async () => {
    const prompt = await loadSemanticJudgePrompt();
    expect(prompt.sourcePath.endsWith('/semantic-code-judge/prompts/domain.md')).toBe(true);
    expect(prompt.text.endsWith('\n')).toBe(false);
    expect(createHash('sha256').update(prompt.text).digest('hex'))
      .toBe('aa5885cd5bb6d71ecc015faad47dc0c952f16af79e275737b50955acc28986bc');
  });
});

const pair: SemanticPair = [
  extractSemanticFunctions({ path: 'src/a.ts', source: 'export function f(xs: number[]) { return xs.reduce((a,b) => a+b, 0); }' })[0],
  extractSemanticFunctions({ path: 'src/b.ts', source: 'export function g(xs: number[]) { let n = 0; for (const x of xs) n += x; return n; }' })[0],
];
const output = { verdict: 'duplicate', duplicate: true, confidence: .95,
  reason: 'Both sum numeric array elements with zero identity and no effects.',
  leftEvidence: 'reduce', rightEvidence: 'n += x' };
const call = (text: string, provenance = true): SemanticJudgeCall => async () => ({ text,
  inputTokens: 100, outputTokens: 50, costUsd: 0, raw: {}, stopReason: 'end_turn',
  ...(provenance ? { execution: { model: 'controlled-replay-v1', codeHash: null,
    loadedCode: { llmClient: 'controlled-transport-fixture' } } } : {}) });
const judge = (invoke: SemanticJudgeCall) => judgeSemanticPair(pair, { model: 'controlled-replay-v1', harness: 'test', call: invoke });

describe('exact semantic judge provenance', () => {
  it('binds the reviewed domain into measured input and prevents scoped controls from unrestricted filing', async () => {
    const contractDomain = contractsV2.positive.behaviorDomainReview.domain;
    const result = await judgeSemanticPair(pair, { model: 'controlled-replay-v1', harness: 'test', contractDomain,
      call: async request => {
        expect(JSON.parse(request.messages[0].content)).toEqual({ left: pair[0], right: pair[1], contractDomain });
        return call(JSON.stringify(output))(request);
      } });
    expect(result.status).toBe('verified');
    expect(result.request.contractDomain).toBe(contractDomain);
    expect(result.promptDigest).not.toBe((await judge(call(JSON.stringify(output)))).promptDigest);
    expect(isVerifiedSemanticPair(pair, result)).toBe(false);
    // Removing just the scope tag cannot launder its domain-bearing input.
    expect(isVerifiedSemanticPair(pair, { ...result, request: { ...result.request, contractDomain: undefined } })).toBe(false);
  });
  it('D018 checks the preregistered replacement positive over its written numeric-array domain before inference', () => {
    expect(contractsV2.qualificationInferenceAllowed).toBe(false);
    const load = (source: string) => {
      const exports: Record<string, (xs: number[]) => number> = {};
      new Function('exports', ts.transpile(source, { module: ts.ModuleKind.CommonJS }))(exports);
      return Object.values(exports)[0];
    };
    const left = load(contractsV2.positive.leftSource), right = load(contractsV2.positive.rightSource);
    const sparse = Array<number>(2), sparseTail = Array<number>(2); sparseTail[1] = 1;
    const cases: Record<string, number[]> = { empty: [], sparse, 'sparse-with-tail': sparseTail,
      singleton: [3], NaN: [NaN], 'negative-zero': [-0], 'positive-infinity': [Infinity],
      'negative-infinity': [-Infinity], 'mixed-infinities': [Infinity, -Infinity],
      overflow: [Number.MAX_VALUE, Number.MAX_VALUE], 'rounding-order': [1e16, 1, -1e16] };
    expect(Object.keys(cases).sort()).toEqual([...contractsV2.positive.behaviorDomainReview.requiredExecutableCases].sort());
    for (const [name, values] of Object.entries(cases)) {
      const before = values.slice();
      expect(Object.is(left(values), right(values)), name).toBe(true);
      expect(values, `${name} input stays unchanged`).toEqual(before);
    }
  });
  it('replays the actual model rejection and confirms its sparse-array counterexample against the frozen source', async () => {
    const result = await judgeSemanticPair(recorded.pair as unknown as SemanticPair, {
      model: recorded.request.model, harness: 'test', call: async () => ({ ...recorded.response,
        inputTokens: 1, outputTokens: 1, costUsd: 0, raw: {} }) });
    expect(result.status).toBe('distinct');
    expect(result.promptDigest).toBe(recorded.promptDigest);
    expect(result.request.input).toBe(recorded.request.input);
    expect(result.output).toBe(recorded.response.text);
    expect(isVerifiedSemanticPair(recorded.pair as unknown as SemanticPair, result)).toBe(false);
    const load = (source: string) => {
      const exports: Record<string, (xs: number[]) => number> = {};
      new Function('exports', ts.transpile(source, { module: ts.ModuleKind.CommonJS }))(exports);
      return Object.values(exports)[0];
    };
    const left = load(frozen.samples[0].source), right = load(frozen.judgePairs[0].rightSource);
    const sparse = Array<number>(2); sparse[1] = 1;
    expect(Number.isNaN(left(sparse))).toBe(true);
    expect(right(sparse)).toBe(1);
  });
  it('routes the default judge through the shared auto pool instead of an ambient credential', async () => {
    h.response = JSON.stringify(output); h.modelCalls.length = 0; h.routes.length = 0;
    const result = await judgeSemanticPair(pair, { model: 'configured-v1', harness: 'test' });
    expect(result.status).toBe('verified');
    expect(h.routes).toEqual(['auto']);
    expect(h.modelCalls[0]).toMatchObject({ model: 'configured-v1', statelessGateway:
      { baseURL: 'http://127.0.0.1:1234/', token: 'fixture-delegated-token' }, maxTokens: 1200 });
    expect(result.request.outputTokenLimit).toBe('requested-not-enforced');
  });
  it('builds a bounded query-independent behavioral summary and rejects unavailable or malformed summaries', async () => {
    const summary = await summarizeSemanticFunction(pair[0], { model: 'replay', harness: 'test', call: async request => {
      expect(JSON.parse(request.messages[0].content)).toEqual(pair[0]);
      return { text: JSON.stringify({ summary: 'Returns the numeric sum, with zero for an empty input.' }),
        raw: {}, inputTokens: 1, outputTokens: 1, costUsd: 0 };
    } });
    expect(summary).toContain('Returns the numeric sum');
    expect(summary.startsWith(pair[0].summary)).toBe(true);
    await expect(summarizeSemanticFunction(pair[0], { model: 'replay', harness: 'test', call: call('{}') })).rejects.toThrow();
  });
  it('retains exact model, prompt, bodies and structured output for positive replay', async () => {
    const result = await judge(call(JSON.stringify(output)));
    expect(isVerifiedSemanticPair(pair, result)).toBe(true);
    expect(result).toMatchObject({ status: 'verified', request: { model: 'controlled-replay-v1' },
      execution: { model: 'controlled-replay-v1' }, output: JSON.stringify(output), parsed: output });
    for (const field of ['promptDigest', 'pairDigest', 'outputDigest'] as const) expect(result[field]).toMatch(/^[a-f0-9]{64}$/);
    expect(isVerifiedSemanticPair([{ ...pair[0], blobSha: 'changed' }, pair[1]], result)).toBe(false);
    expect(isVerifiedSemanticPair(pair, { ...result, request: { ...result.request, system: 'changed' } })).toBe(false);
    expect(isVerifiedSemanticPair(pair, { ...result, output: '{}' })).toBe(false);
    expect(isVerifiedSemanticPair(pair, { ...result, execution: null })).toBe(false);
    // The shared adapter can truthfully leave remote/runtime code unresolved.
    // R7 requires exact configured model/prompt/input/output, not a fabricated
    // complete deployment hash for the inference service.
    expect(isVerifiedSemanticPair(pair, { ...result, execution: { model: 'controlled-replay-v1', codeHash: null,
      loadedCode: { llmClient: null }, unresolved: ['gateway-runtime'] } })).toBe(true);
  });
  it.each([
    ['reject', { ...output, verdict: 'distinct', duplicate: false }, 'distinct'],
    ['abstain', { ...output, verdict: 'abstain', duplicate: false }, 'abstain'],
    ['below confidence cutoff', { ...output, confidence: .899 }, 'abstain'],
    ['contradictory duplicate', { ...output, duplicate: false }, 'unknown'],
    ['invented evidence', { ...output, leftEvidence: 'not present' }, 'unknown'],
  ])('fails closed for %s', async (_name, value, status) => {
    const result = await judge(call(JSON.stringify(value)));
    expect(result.status).toBe(status);
    expect(isVerifiedSemanticPair(pair, result)).toBe(false);
  });
  it('fails closed on malformed output, outage, missing provenance and cancellation', async () => {
    const aborted = new AbortController(); aborted.abort();
    const results = [await judge(call('not json')), await judge(call(JSON.stringify(output), false)),
      await judge(async () => { throw new Error('controlled gateway outage'); }),
      await judgeSemanticPair(pair, { model: 'replay', harness: 'test', signal: aborted.signal, call: call(JSON.stringify(output)) })];
    expect(results.map(row => row.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    for (const result of results) expect(isVerifiedSemanticPair(pair, result)).toBe(false);
  });
});
