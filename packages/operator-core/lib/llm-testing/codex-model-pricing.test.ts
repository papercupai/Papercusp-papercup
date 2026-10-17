/**
 * WI-10004526: the write-time unpriced-model rule must match what llmCall
 * enforces at call time (WI-10004502: an unpriced `gpt-5.4:medium` Scout model
 * failed every cycle, and nothing said so when it was configured).
 */
import { describe, expect, it } from 'vitest';
import { CODEX_LLM_DEFAULT_MODEL, codexWireModel, isCodexModel, unpricedCodexModel } from './codex-model-pricing';
import { bareModelId, CODEX_SAFE_DEFAULT_MODEL } from '../model-context-budget.mjs';
import { DEFAULT_OWNER_STEERING, steeringUnpricedModelSpecs, type OwnerSteering } from '../owner-steering';

describe('unpricedCodexModel', () => {
  it('uses the managed subscription default as a priced bare wire id', () => {
    expect(CODEX_LLM_DEFAULT_MODEL).toBe(bareModelId(CODEX_SAFE_DEFAULT_MODEL));
    expect(isCodexModel(CODEX_LLM_DEFAULT_MODEL)).toBe(true);
    expect(unpricedCodexModel(CODEX_LLM_DEFAULT_MODEL)).toBeNull();
  });

  it('returns the wire id llmCall would refuse for an unpriced Codex spec', () => {
    expect(unpricedCodexModel('gpt-99-unpriced:medium')).toBe('gpt-99-unpriced:medium');
    expect(unpricedCodexModel('openai-codex/gpt-99-unpriced')).toBe('gpt-99-unpriced');
    expect(unpricedCodexModel('chatgpt:99-unpriced')).toBe('gpt-99-unpriced');
  });

  it('is null for priced Codex specs, including the WI-10004502 Scout spec and product aliases', () => {
    for (const spec of ['gpt-5.4:medium', 'gpt-5.4-mini', 'gpt-6.1-sol:xhigh', 'chatgpt:5.5', 'luna', 'sol:high']) {
      expect(unpricedCodexModel(spec), spec).toBeNull();
    }
  });

  it('is null for specs llmCall does not route to Codex (Claude / OMP) and for empty input', () => {
    for (const spec of ['sonnet[1m]:high', 'claude-opus-5', 'haiku', '', '   ', null, undefined]) {
      expect(unpricedCodexModel(spec), String(spec)).toBeNull();
    }
  });

  it('shares the routing rule llm-client uses', () => {
    expect(isCodexModel('gpt-5.5')).toBe(true);
    expect(isCodexModel('claude-opus-5')).toBe(false);
    expect(codexWireModel('chatgpt:5.5')).toBe('gpt-5.5');
    expect(codexWireModel('openai-codex/gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('steeringUnpricedModelSpecs', () => {
  it('flags only the pinned Codex specs that have no price', () => {
    const s: OwnerSteering = {
      ...DEFAULT_OWNER_STEERING,
      modelTiers: [{ name: 'deep', spec: 'gpt-99-unpriced:high', backend: 'codex' }],
      modelOverrides: { overwatch: 'gpt-5.4:medium', papercup: 'sonnet[1m]:high' },
    };
    expect(steeringUnpricedModelSpecs(s)).toEqual(['gpt-99-unpriced:high']);
  });

  it('is empty when steering pins nothing', () => {
    expect(steeringUnpricedModelSpecs(DEFAULT_OWNER_STEERING)).toEqual([]);
  });
});
