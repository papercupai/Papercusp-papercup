import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as modelContextBudget from './model-context-budget.mjs';

const {
  buildContextBudget,
  CODEX_DENIED_MODEL_IDS,
  CODEX_SAFE_DEFAULT_MODEL,
  claudeInheritedEffortOverride,
  codexModelConfigToml,
  codexModelIdFromSpec,
  codexServiceableForModel,
  formatCodexLaunchContextSection,
  isCodexModelDenied,
  listCodexInstalledModels,
  normalizeCodexCliModel,
  normalizeClaudeModelEffortSpec,
  readLaunchContextText,
  resolveCodexModel,
  resolveCodexModelSelection,
  resolveModelContextWindow,
  listLaunchModelAliases,
  resolveLaunchModelAlias,
} = modelContextBudget;

describe('codexModelIdFromSpec (WI-6554700010030413)', () => {
  it('names the gateway model a launch asks for, resolving aliases exactly as the launch does', () => {
    const sol = normalizeCodexCliModel('sol');
    expect(sol).not.toBe('sol');
    for (const spec of ['sol', ' SOL ', 'sol:high', 'sol[1m]']) expect(codexModelIdFromSpec(spec)).toBe(sol);
    expect(codexModelIdFromSpec(' gpt-6.1-sol:xhigh ')).toBe('gpt-6.1-sol');
    expect(codexModelIdFromSpec('gpt-6.1-sol[1m]')).toBe('gpt-6.1-sol');
    expect(codexModelIdFromSpec('')).toBeNull();
    expect(codexModelIdFromSpec(null)).toBeNull();
  });

  it('reads a per-model serviceable count only from a well-formed entry', () => {
    expect(codexServiceableForModel({ 'GPT-5.5': 3 }, 'gpt-5.5')).toBe(3);
    expect(codexServiceableForModel({ 'gpt-5.5': 0 }, 'gpt-5.5')).toBe(0);
    expect(codexServiceableForModel({ 'gpt-5.5': -1 }, 'gpt-5.5')).toBeNull();
    expect(codexServiceableForModel(['gpt-5.5'], 'gpt-5.5')).toBeNull();
    expect(codexServiceableForModel(null, 'gpt-5.5')).toBeNull();
  });
});

describe('shared launch model aliases', () => {
  it('resolves the requested model wording before backend selection', () => {
    for (const alias of ['sol 6.1', '6.1 sol', 'sol6.1', 'SOL-6.1']) {
      expect(resolveLaunchModelAlias(alias, { effort: 'xhigh' })).toMatchObject({
        agent: 'codex', model: 'gpt-6.1-sol:xhigh', effort: 'xhigh',
      });
      expect(normalizeCodexCliModel(`${alias}:xhigh`)).toBe('gpt-6.1-sol:xhigh');
    }
    expect(resolveLaunchModelAlias('sol 6.1 xhigh').model).toBe('gpt-6.1-sol:xhigh');
  });

  it('echoes the backend-normalized effort without changing other backends', () => {
    expect(resolveLaunchModelAlias('claude opus', { effort: 'xhigh' })).toMatchObject({
      agent: 'claude', model: 'opus:max', effort: 'max',
    });
    expect(resolveLaunchModelAlias('opus[1m]:xhigh').model).toBe('opus[1m]:max');
    expect(resolveLaunchModelAlias('sol 6.1:xhigh').effort).toBe('xhigh');
    expect(resolveLaunchModelAlias('opus:xhigh', { agent: 'omp' }).effort).toBe('xhigh');
  });

  it('refuses unknown and ambiguous aliases with candidate models', () => {
    for (const [model, code] of [['mystery', 'unknown_model_alias'], ['6', 'ambiguous_model_alias']]) {
      try {
        resolveLaunchModelAlias(model);
        expect.fail('Expected an alias refusal');
      } catch (error) {
        expect(error).toMatchObject({ code, candidates: expect.arrayContaining([
          expect.objectContaining({ agent: 'codex', model: 'gpt-6-sol' }),
        ]) });
      }
    }
  });

  it('preserves legacy aliases, native ids and explicit OMP selectors', () => {
    expect(resolveLaunchModelAlias('sol:high').model).toBe('gpt-5.6-sol:high');
    expect(resolveLaunchModelAlias('gpt-future-sol:high').model).toBe('gpt-future-sol:high');
    expect(resolveLaunchModelAlias('openrouter/vendor/model:high', { agent: 'omp' }).model)
      .toBe('openrouter/vendor/model:high');
    expect(resolveLaunchModelAlias('ornith', { agent: 'omp' }).model).toBe('ornith');
    expect(() => resolveLaunchModelAlias('sol 6.1', { agent: 'claude' })).toThrow(/requires agent/);
    expect(() => resolveLaunchModelAlias('sol 6.1', { effort: 'extreme' })).toThrow(/Unknown effort/);
    expect(() => resolveLaunchModelAlias('sol 6.1', { agent: 'unknown' })).toThrow(/Unknown agent/);
  });

  it('prevents a catalog reader from mutating the registry', () => {
    const catalog = listLaunchModelAliases();
    expect(catalog).toContainEqual(expect.objectContaining({ model: 'gpt-6.1-sol', agent: 'codex' }));
    catalog[0].aliases.splice(0);
    expect(resolveLaunchModelAlias('sol 6.1').model).toBe('gpt-6.1-sol');
  });
});

describe('Claude Opus 5 effort compatibility', () => {
  it('maps only Opus 5 xhigh specs to Claude Code max', () => {
    expect(normalizeClaudeModelEffortSpec('opus:xhigh')).toBe('opus:max');
    expect(normalizeClaudeModelEffortSpec('opus[1m]:XHIGH')).toBe('opus[1m]:max');
    expect(normalizeClaudeModelEffortSpec('claude-opus-5-5:xhigh')).toBe('claude-opus-5-5:max');
    expect(normalizeClaudeModelEffortSpec('claude-opus-5.5:xhigh')).toBe('claude-opus-5.5:max');
  });

  it('preserves other models and effort levels', () => {
    for (const spec of [
      'claude-opus-4-8:xhigh',
      'claude-sonnet-5:xhigh',
      'opus:high',
      'opus:max',
      'gpt-5.5:xhigh',
    ]) {
      expect(normalizeClaudeModelEffortSpec(spec)).toBe(spec);
    }
  });

  // WI-10005900: a launch whose argv names no effort inherits settings.json effortLevel.
  it('clamps an inherited Opus 5 xhigh effortLevel to max', () => {
    // Model-less launch: the settings model decides.
    expect(
      claudeInheritedEffortOverride({ model: null, settings: { model: 'opus[1m]', effortLevel: 'xhigh' } }),
    ).toBe('max');
    // Model without an effort suffix: the argv model decides, not settings.model.
    expect(
      claudeInheritedEffortOverride({
        model: 'claude-opus-5-5',
        settings: { model: 'sonnet', effortLevel: 'XHIGH' },
      }),
    ).toBe('max');
  });

  it('leaves the inherited effort alone when nothing needs clamping', () => {
    const cases: Array<Parameters<typeof claudeInheritedEffortOverride>[0]> = [
      // The argv carries its own effort, so settings.effortLevel never applies.
      { model: 'opus:high', settings: { model: 'opus', effortLevel: 'xhigh' } },
      // Supported level, or a family that keeps xhigh.
      { model: null, settings: { model: 'opus[1m]', effortLevel: 'max' } },
      { model: 'claude-sonnet-5', settings: { effortLevel: 'xhigh' } },
      // Nothing to inherit, or no model to judge it against.
      { model: 'opus', settings: { model: 'opus' } },
      { model: null, settings: { effortLevel: 'xhigh' } },
      { model: 'opus', settings: null },
      { model: 'opus', settings: { effortLevel: 42 } },
    ];
    for (const input of cases) {
      expect(claudeInheritedEffortOverride(input)).toBeNull();
    }
  });
});

describe('managed Codex model policy', () => {
  it('rejects unresolved model input with a stable missing_model code', () => {
    for (const input of [undefined, null, '', '  ']) {
      try {
        resolveCodexModel(input);
        throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
      } catch (error) {
        expect(error).toMatchObject({ code: 'missing_model' });
      }
    }
  });

  it('resolves GPT-6.1 Sol xhigh only through an explicit configured-default selection', () => {
    expect(CODEX_SAFE_DEFAULT_MODEL).toBe('gpt-6.1-sol:xhigh');
    expect(resolveCodexModelSelection(undefined, { source: 'configured-default' })).toEqual({
      model: 'gpt-6.1-sol:xhigh',
      source: 'configured-default',
    });
    expect(codexModelConfigToml(CODEX_SAFE_DEFAULT_MODEL)).toEqual([
      'model = "gpt-6.1-sol"',
      'model_reasoning_effort = "xhigh"',
      '',
    ]);
  });

  it('preserves explicit and inherited source provenance', () => {
    expect(resolveCodexModelSelection('terra:high', { source: 'explicit' })).toEqual({
      model: 'gpt-5.6-terra:high',
      source: 'explicit',
    });
    expect(resolveCodexModelSelection('gpt-5.5:xhigh', { source: 'inherited' })).toEqual({
      model: 'gpt-5.5:xhigh',
      source: 'inherited',
    });
  });

  it('denies Spark across provider prefixes, effort suffixes, and case', () => {
    for (const spec of [
      'gpt-5.3-codex-spark',
      'GPT-5.3-CODEX-SPARK:high',
      'openai-codex/gpt-5.3-codex-spark:xhigh',
      'papercusp-gateway/gpt-5.3-codex-spark',
      'chatgpt:5.3-codex-spark',
      'chatgpt:5.3-codex-spark:turbo',
    ]) {
      expect(isCodexModelDenied(spec), spec).toBe(true);
      expect(() => resolveCodexModel(spec), spec).toThrow(/denied/i);
    }
    expect(CODEX_DENIED_MODEL_IDS).toContain('gpt-5.3-codex-spark');
  });

  it('renders an explicit model and reasoning effort for resume-safe CODEX_HOME config', () => {
    expect(codexModelConfigToml('sol:high')).toEqual([
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "high"',
      '',
    ]);
  });

  it('preserves GPT-6.1 Sol selection and max effort in the resume config', () => {
    expect(resolveCodexModelSelection('chatgpt:6.1-sol:max')).toEqual({
      model: 'gpt-6.1-sol:max',
      source: 'explicit',
    });
    expect(codexModelConfigToml('gpt-6.1-sol:max')).toEqual([
      'model = "gpt-6.1-sol"',
      'model_reasoning_effort = "max"',
      '',
    ]);
  });
});

describe('model-context-budget', () => {
  it('normalizes user-facing Codex families while preserving native ids and effort', () => {
    expect(normalizeCodexCliModel('sol')).toBe('gpt-5.6-sol');
    expect(normalizeCodexCliModel('terra:xhigh')).toBe('gpt-5.6-terra:xhigh');
    expect(normalizeCodexCliModel('luna:max')).toBe('gpt-5.6-luna:max');
    expect(normalizeCodexCliModel('chatgpt:5.5:high')).toBe('gpt-5.5:high');
    expect(normalizeCodexCliModel('gpt-5.6-sol:high')).toBe('gpt-5.6-sol:high');
  });

  it('reads the selected Codex model window from the installed cache', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-codex-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-test', context_window: 272_000 }] }),
    );
    expect(resolveModelContextWindow({ agent: 'codex', model: 'gpt-test:high', home })).toEqual({
      window: 272_000,
      source: 'codex-model-cache',
    });
  });

  it('reads a direct CODEX_HOME registry when no HOME override is supplied', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'psu-budget-codex-home-'));
    writeFileSync(
      join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }],
      }),
    );
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      expect(modelContextBudget.codexContextWindowConfig('gpt-6-astra')).toEqual({
        model: 'gpt-6-astra',
        window: 872_000,
        autoCompactLimit: 784_800,
        source: 'codex-model-cache-max',
      });
      expect(modelContextBudget.codexContextWindowConfig('gpt-6-astra', { codexHome })).toEqual(
        modelContextBudget.codexContextWindowConfig('gpt-6-astra'),
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it('reads OMP contextWindow and clamps declared configuration to a live backend', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-omp-'));
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.omp', 'agent', 'models.json'),
      JSON.stringify({ models: [{ id: 'ornith-test', contextWindow: 200_000 }] }),
    );
    expect(resolveModelContextWindow({ agent: 'omp', model: 'ollama-cc/ornith-test:xhigh', home })).toEqual({
      window: 200_000,
      source: 'omp-model-registry',
    });
    expect(resolveModelContextWindow({ agent: 'omp', declaredWindow: 200_000, liveWindow: 180_000 })).toEqual({
      window: 180_000,
      source: 'declared-live-min',
    });
  });

  it('reads a YAML-only OMP registry record through end-of-file', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-omp-yaml-'));
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.omp', 'agent', 'models.yml'),
      ['- id: first', '  contextWindow: 64000', '- id: target-last', '  contextWindow: 131072', ''].join('\n'),
    );
    expect(resolveModelContextWindow({ agent: 'omp', model: 'target-last', home })).toEqual({
      window: 131_072,
      source: 'omp-models-yml',
    });
  });

  it('counts the exact bounded launch-context bytes in the shared budget', () => {
    const home = mkdtempSync(join(tmpdir(), 'psu-budget-context-'));
    const path = join(home, 'brief.md');
    writeFileSync(path, 'mission context');
    const context = readLaunchContextText(path);
    const without = buildContextBudget({ agent: 'codex', promptText: 'base', declaredWindow: 200_000 });
    const withContext = buildContextBudget({
      agent: 'codex',
      promptText: 'base',
      additionalPromptText: formatCodexLaunchContextSection(context),
      declaredWindow: 200_000,
    });
    expect(withContext.promptTokens).toBeGreaterThan(without.promptTokens);
    expect(withContext.availableInputTokens).toBeLessThan(without.availableInputTokens);
  });

  it('returns one versioned budget used by bootstrap, preflight, and port fitting', () => {
    const budget = buildContextBudget({
      agent: 'claude',
      model: 'opus[1m]:high',
      contextSize: 'trimmed',
      estimatedPromptTokens: 20_000,
    });
    expect(budget).toMatchObject({
      version: 1,
      window: 1_000_000,
      promptTokens: 20_000,
      runtimeOverheadTokens: 50_000,
      baselineTokens: 70_000,
      reserveTokens: 15_000,
      availableInputTokens: 915_000,
      level: 'ok',
    });
  });
});

/**
 * plan codex-1m-context-window-2026-08-17 D-008. The load-bearing property is
 * not "big number goes in" — it is that a model with NO extended window emits
 * NOTHING, so a launch argv for gpt-5.5 stays byte-identical to before this
 * feature existed. A policy that fell back to a default on that path would
 * declare a window the model does not have.
 */
describe('codex extended-window launch config', () => {
  const {
    CODEX_MAX_CONFIGURED_WINDOW,
    codexContextConfigArgs,
    codexContextConfigToml,
    codexContextWindowConfig,
  } = modelContextBudget;

  /** A codex home whose models_cache.json carries exactly `models`. */
  const codexHome = (models: unknown[], label = 'cfg') => {
    const home = mkdtempSync(join(tmpdir(), `psu-codex-${label}-`));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models }));
    return home;
  };

  const SOL = { slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 872_000 };
  const GPT55 = { slug: 'gpt-5.5', context_window: 272_000, max_context_window: 272_000 };
  const MINI = { slug: 'gpt-5.4-mini', context_window: 400_000, max_context_window: 400_000 };
  const NANO = { slug: 'gpt-5.4-nano', context_window: 400_000, max_context_window: 400_000 };

  it('keeps the exact 1M opt-in for an official model despite an 872k runtime record max', () => {
    const home = codexHome([SOL, GPT55], 'sol');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toEqual({
      model: 'gpt-5.6-sol',
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
  });

  it('clamps only the native auto-compaction threshold to the active per-session limit', () => {
    const home = codexHome([SOL], 'session-limit');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home, compactionLimit: 250_000 })).toEqual({
      model: 'gpt-5.6-sol',
      window: 1_000_000,
      autoCompactLimit: 200_000,
      source: 'codex-official-1m-policy',
    });
    expect(codexContextConfigArgs('gpt-5.6-sol', { home, compactionLimit: 250_000 })).toEqual([
      '-c',
      'model_context_window=1000000',
      '-c',
      'model_auto_compact_token_limit=200000',
    ]);
    expect(codexContextConfigToml('gpt-5.6-sol', { home, compactionLimit: 250_000 })).toBe(
      'model_context_window = 1000000\nmodel_auto_compact_token_limit = 200000\n',
    );
  });

  it('starts native compaction before the scheduler reaches 90% of a managed budget', () => {
    const home = codexHome([SOL], 'managed-headroom');
    const config = codexContextWindowConfig('gpt-5.6-sol', { home, compactionLimit: 200_000 });
    expect(config).toMatchObject({ window: 1_000_000, autoCompactLimit: 160_000 });
    expect(config!.autoCompactLimit).toBeLessThan(200_000 * 0.9);
  });

  it('does not let a session limit raise the model-derived native threshold', () => {
    expect(codexContextWindowConfig('gpt-5.6-sol', { compactionLimit: 1_200_000 })).toMatchObject({
      window: 1_000_000,
      autoCompactLimit: 900_000,
    });
  });

  it('resolves a psu alias + effort suffix to the same config as the native id', () => {
    const home = codexHome([SOL], 'alias');
    expect(codexContextWindowConfig('sol:high', { home })).toEqual(
      codexContextWindowConfig('gpt-5.6-sol', { home }),
    );
  });

  it('emits NOTHING for sub-1M models whose max equals their default window', () => {
    const home = codexHome([SOL, GPT55, MINI, NANO], 'flat');
    for (const model of ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(codexContextWindowConfig(model, { home }), model).toBeNull();
      expect(codexContextConfigArgs(model, { home }), model).toEqual([]);
      expect(codexContextConfigToml(model, { home }), model).toBe('');
    }
  });

  it('does not let a stale flat runtime record disable the explicit 1M opt-in', () => {
    const home = codexHome([{ slug: 'gpt-5.6-sol', context_window: 272_000, max_context_window: 272_000 }], 'shrink');
    expect(codexContextWindowConfig('gpt-5.6-sol', { home })).toMatchObject({
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
  });

  it('does not guess for an unrecognised runtime record that lacks a usable max', () => {
    const home = codexHome([{ slug: 'gpt-unrecognised', context_window: 272_000 }], 'missing-max');
    expect(codexContextWindowConfig('gpt-unrecognised', { home })).toBeNull();
  });

  it('caps a registry ceiling above 1M at exactly 1M', () => {
    const home = codexHome([{ slug: 'gpt-future', context_window: 272_000, max_context_window: 4_000_000 }], 'cap');
    const cfg = codexContextWindowConfig('gpt-future', { home })!;
    expect(cfg.window).toBe(CODEX_MAX_CONFIGURED_WINDOW);
    expect(cfg.window).toBe(1_000_000);
    expect(cfg.autoCompactLimit).toBe(900_000);
  });

  it('uses the official 1M table when the registry is missing or lacks the model', () => {
    const noRegistry = mkdtempSync(join(tmpdir(), 'psu-codex-bare-'));
    expect(codexContextWindowConfig('gpt-5.6-sol', { home: noRegistry })).toMatchObject({
      window: 1_000_000,
      source: 'codex-official-1m-policy',
    });
    // A registry that simply does not carry this model is the same case.
    const other = codexHome([GPT55], 'partial');
    expect(codexContextWindowConfig('gpt-5.4', { home: other })).toMatchObject({
      window: 1_000_000,
      source: 'codex-official-1m-policy',
    });
    // ...and an unknown model gets nothing rather than a guess.
    expect(codexContextWindowConfig('gpt-unknown-model', { home: noRegistry })).toBeNull();
  });

  it('uses Astra\'s 1M fresh-home fallback but honors a direct registry max on resume', () => {
    const noRegistry = mkdtempSync(join(tmpdir(), 'psu-codex-astra-bare-'));
    expect(codexContextWindowConfig('gpt-6-astra', { home: noRegistry })).toMatchObject({
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
    const sessionHome = mkdtempSync(join(tmpdir(), 'psu-codex-astra-session-'));
    writeFileSync(
      join(sessionHome, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: 'gpt-6-astra', context_window: 272_000, max_context_window: 872_000 }] }),
    );
    expect(codexContextWindowConfig('gpt-6-astra', { codexHome: sessionHome })).toMatchObject({
      window: 872_000,
      autoCompactLimit: 784_800,
      source: 'codex-model-cache-max',
    });
  });

  it.each(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'])('%s uses the 1M fresh-home fallback and a registry max after discovery', (model) => {
    const noRegistry = mkdtempSync(join(tmpdir(), `psu-codex-${model}-bare-`));
    expect(codexContextWindowConfig(model, { home: noRegistry })).toMatchObject({
      model,
      window: 1_000_000,
      autoCompactLimit: 900_000,
      source: 'codex-official-1m-policy',
    });
    const sessionHome = mkdtempSync(join(tmpdir(), `psu-codex-${model}-session-`));
    writeFileSync(
      join(sessionHome, 'models_cache.json'),
      JSON.stringify({ models: [{ slug: model, context_window: 272_000, max_context_window: 872_000 }] }),
    );
    expect(codexContextWindowConfig(model, { codexHome: sessionHome })).toMatchObject({
      model,
      window: 872_000,
      autoCompactLimit: 784_800,
      source: 'codex-model-cache-max',
    });
    expect(codexContextWindowConfig(model, { home: noRegistry, compactionLimit: 200_000 })).toMatchObject({
      window: 1_000_000,
      autoCompactLimit: 160_000,
    });
    expect(codexContextWindowConfig(model, { codexHome: sessionHome, compactionLimit: 200_000 })).toMatchObject({
      window: 872_000,
      autoCompactLimit: 160_000,
    });
  });

  it('preserves registry-derived sub-1M extended-window behavior for unrecognised models', () => {
    const home = codexHome([
      { slug: 'gpt-registered-extended', context_window: 272_000, max_context_window: 400_000 },
    ], 'registered-sub-1m');
    expect(codexContextWindowConfig('gpt-registered-extended', { home })).toEqual({
      model: 'gpt-registered-extended',
      window: 400_000,
      autoCompactLimit: 360_000,
      source: 'codex-model-cache-max',
    });
  });

  it('emits the CLI override pair and the config.toml fragment from one policy', () => {
    const home = codexHome([SOL], 'emit');
    expect(codexContextConfigArgs('sol', { home })).toEqual([
      '-c',
      'model_context_window=1000000',
      '-c',
      'model_auto_compact_token_limit=900000',
    ]);
    expect(codexContextConfigToml('sol', { home })).toBe(
      'model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n',
    );
  });

  it('reports the window we LAUNCH with, not the registry default, to the budget math', () => {
    // Without this, a preflight would size the launch context against 272k while
    // the session actually runs the configured runtime-record max.
    const home = codexHome([SOL], 'budget');
    expect(resolveModelContextWindow({ agent: 'codex', model: 'sol:high', home })).toEqual({
      window: 1_000_000,
      source: 'codex-official-1m-policy',
    });
  });
});

/**
 * WI-126377 — LISTING the same registry `codexModelRecord` has been reading one
 * model at a time. psu's resume picker could offer only three hardcoded aliases
 * until this existed, so an installed gpt-5.5 had to be typed from memory.
 */
describe('listCodexInstalledModels', () => {
  const home = (models: unknown[], label: string) => {
    const dir = mkdtempSync(join(tmpdir(), `psu-codex-list-${label}-`));
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'models_cache.json'), JSON.stringify({ models }));
    return dir;
  };

  it('drops the registry\'s own hidden entries rather than a hand-kept exclusion list', () => {
    // Measured on this box 2026-08-27: gpt-reserve and codex-auto-review ship
    // with visibility 'hide'. They are real models, but not what a human means
    // by "the model list".
    const dir = home(
      [
        { slug: 'gpt-5.5', visibility: 'list', priority: 7 },
        { slug: 'gpt-reserve', visibility: 'hide', priority: 3 },
      ],
      'hidden',
    );
    expect(listCodexInstalledModels({ home: dir }).map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('orders by the registry\'s OWN priority, so a new model needs no code change to rank', () => {
    const dir = home(
      [
        { slug: 'gpt-5.4', priority: 16 },
        { slug: 'gpt-5.6-sol', priority: 1 },
        { slug: 'gpt-5.5', priority: 7 },
      ],
      'priority',
    );
    expect(listCodexInstalledModels({ home: dir }).map((m) => m.id)).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4']);
  });

  it('flattens each model\'s supported reasoning levels to bare effort strings', () => {
    const dir = home(
      [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          default_reasoning_level: 'medium',
          context_window: 272_000,
          max_context_window: 272_000,
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast responses' },
            { effort: 'high', description: 'Greater depth' },
          ],
        },
      ],
      'efforts',
    );
    expect(listCodexInstalledModels({ home: dir })[0]).toEqual({
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      description: null,
      efforts: ['low', 'high'],
      defaultEffort: 'medium',
      contextWindow: 272_000,
      maxContextWindow: 272_000,
    });
  });

  it('returns [] — never throws — when the cache is missing or unparseable', () => {
    // The caller must degrade to its alias rows, not lose the picker.
    const missing = mkdtempSync(join(tmpdir(), 'psu-codex-list-missing-'));
    expect(listCodexInstalledModels({ home: missing })).toEqual([]);

    const broken = mkdtempSync(join(tmpdir(), 'psu-codex-list-broken-'));
    mkdirSync(join(broken, '.codex'), { recursive: true });
    writeFileSync(join(broken, '.codex', 'models_cache.json'), '{ not json');
    expect(listCodexInstalledModels({ home: broken })).toEqual([]);
  });

  it('skips a record with no usable id instead of emitting a blank row', () => {
    const dir = home([{ display_name: 'nameless' }, { slug: 'gpt-5.5' }], 'blank');
    expect(listCodexInstalledModels({ home: dir }).map((m) => m.id)).toEqual(['gpt-5.5']);
  });
});
