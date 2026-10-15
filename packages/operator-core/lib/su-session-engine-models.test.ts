import { describe, expect, it } from 'vitest';
import { claudeModelOptions, codexModelOptions, listCodexModels, ompModelOptions } from './su-session-engine-models';

// Shapes copied from the installed engines' own answers (2026-10-06): the
// Claude Agent SDK's initializationResult().models and codex app-server
// 0.160.1 model/list.
const CLAUDE_MODELS = [
  {
    value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

const CODEX_MODELS = [
  {
    id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol',
    description: 'Latest workhorse model for coding and everyday work.', hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'high', description: 'Deep' }],
    defaultReasoningEffort: 'low', isDefault: true,
  },
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', hidden: false, isDefault: false },
  { id: 'internal-x', model: 'internal-x', displayName: 'Internal', description: 'not offered', hidden: true },
];

describe('engine model catalogs (WI-10006652)', () => {
  it('maps the Claude SDK catalog to settable rows with the SDK value as the id', () => {
    expect(claudeModelOptions(CLAUDE_MODELS)).toEqual([
      {
        id: 'default', label: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
        resolvedModel: 'claude-opus-5[1m]', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true,
      },
      { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', resolvedModel: 'claude-sonnet-5' },
      { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers', resolvedModel: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('maps Codex model/list rows, uses the turn/start slug, and drops hidden models', () => {
    expect(codexModelOptions(CODEX_MODELS)).toEqual([
      {
        id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.',
        efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true,
      },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' },
    ]);
  });

  it('maps OMP native models to exact provider/model selectors without conflating providers', () => {
    expect(ompModelOptions([
      { provider: 'anthropic', id: 'sonnet', name: 'Sonnet' },
      { provider: 'papercusp-gateway', id: 'sonnet', name: 'Sonnet' },
      { provider: 'anthropic', id: 'sonnet', name: 'Duplicate' },
      { provider: 'openai', id: 'gpt-6.1-sol' },
    ])).toEqual([
      { id: 'anthropic/sonnet', label: 'Sonnet', description: 'anthropic' },
      { id: 'papercusp-gateway/sonnet', label: 'Sonnet', description: 'papercusp-gateway' },
      { id: 'openai/gpt-6.1-sol', label: 'openai/gpt-6.1-sol', description: 'openai' },
    ]);
  });

  it('never invents rows from a malformed answer', () => {
    expect(claudeModelOptions(undefined)).toEqual([]);
    expect(claudeModelOptions([{ displayName: 'no value' }, 'x', null])).toEqual([]);
    expect(codexModelOptions({ data: CODEX_MODELS })).toEqual([]);
    expect(codexModelOptions([{ hidden: false }])).toEqual([]);
    expect(ompModelOptions({ models: [] })).toEqual([]);
    expect(ompModelOptions([null, { provider: 'openai' }, { id: 'missing-provider' }])).toEqual([]);
  });

  it('pages model/list with the returned cursor and stops at the page bound', async () => {
    const calls: Record<string, unknown>[] = [];
    const pages = [
      { data: [CODEX_MODELS[0]], nextCursor: 'page-2' },
      { data: [CODEX_MODELS[1]], nextCursor: null },
    ];
    const models = await listCodexModels(async (frame) => { calls.push(frame); return pages[calls.length - 1]; });
    expect(calls).toEqual([{ method: 'model/list', params: {} }, { method: 'model/list', params: { cursor: 'page-2' } }]);
    expect(models.map((model) => model.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);

    let spins = 0;
    await listCodexModels(async () => { spins += 1; return { data: [], nextCursor: 'again' }; }, 3);
    expect(spins).toBe(3);
  });
});
