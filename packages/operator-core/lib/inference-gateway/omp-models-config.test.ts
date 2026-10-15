import { describe, it, expect } from 'vitest';
import {
  ompGatewayModelsConfig,
  ompGatewayModelFromSpec,
  ompProviderForAccountProvider,
  ompModelIdFromSpec,
  OMP_MODELS_REL_PATH,
  OMP_GATEWAY_PROVIDER_ID,
  OMP_GATEWAY_PLACEHOLDER_KEY,
} from './omp-models-config';

describe('ompModelIdFromSpec (P-005 per-role fidelity)', () => {
  it('extracts the bare Claude id from a full spec (strips provider + tier)', () => {
    expect(ompModelIdFromSpec('anthropic/claude-opus-4-8:high')).toBe('claude-opus-4-8');
    expect(ompModelIdFromSpec('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(ompModelIdFromSpec('claude-sonnet-4-6:medium')).toBe('claude-sonnet-4-6');
  });
  it('returns null for incompatible provider/model combinations and empty specs', () => {
    expect(ompModelIdFromSpec('ollama/ornith:fast')).toBe(null);
    expect(ompModelIdFromSpec('amazon-bedrock/anthropic.claude-opus-4-8')).toBe(null);
    expect(ompModelIdFromSpec('')).toBe(null);
    expect(ompModelIdFromSpec(null)).toBe(null);
    expect(ompModelIdFromSpec(undefined)).toBe(null);
  });
});

describe('ompGatewayModelFromSpec (P-005 fail-closed compatibility)', () => {
  it('maps only known Anthropic-wire OMP providers while preserving the model id', () => {
    expect(ompGatewayModelFromSpec('claude-bridge/claude-opus-4-8:high')).toEqual({
      modelId: 'claude-opus-4-8',
      gatewayProvider: 'anthropic',
      accountProvider: 'claude',
    });
    expect(ompGatewayModelFromSpec('anthropic/claude-sonnet-4-6')).toEqual({
      modelId: 'claude-sonnet-4-6',
      gatewayProvider: 'anthropic',
      accountProvider: 'claude',
    });
  });

  it('maps OpenAI Codex selectors to the OpenAI wire + Codex account pool', () => {
    expect(ompGatewayModelFromSpec('openai-codex/gpt-5.6-terra:xhigh')).toEqual({
      modelId: 'gpt-5.6-terra',
      gatewayProvider: 'openai',
      accountProvider: 'codex',
    });
  });

  it('does not infer compatibility from a Claude-looking id owned by another provider', () => {
    expect(ompGatewayModelFromSpec('amazon-bedrock/anthropic.claude-opus-4-8')).toBeNull();
    expect(ompGatewayModelFromSpec('google-vertex/claude-opus-4-8')).toBeNull();
    expect(ompGatewayModelFromSpec('ollama-cc/ornith:fast')).toBeNull();
  });
});

describe('ompGatewayModelsConfig', () => {
  it('returns null when no account is pinned (fail-soft, direct egress)', () => {
    expect(ompGatewayModelsConfig({ provider: 'anthropic' })).toBeNull();
    expect(ompGatewayModelsConfig({ provider: 'anthropic', accountId: '   ' })).toBeNull();
  });

  it('emits an unpinned provider for explicit gateway auto mode', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', gatewayOn: true, ownerId: 'su-1', port: 8788 })!;
    expect(cfg.modelSelector).toBe('papercusp-gateway/claude-sonnet-4-6');
    expect(cfg.headers).toEqual({ 'x-papercusp-owner': 'su-1' });
    expect(cfg.content).not.toContain('x-papercusp-account');
    expect(cfg.content).toContain('baseUrl: "http://127.0.0.1:8788"');
  });

  it('omits the headers field instead of emitting YAML null when auto has no attribution headers', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', gatewayOn: true, port: 8788 })!;
    expect(cfg.headers).toEqual({});
    expect(cfg.content).not.toContain('    headers:');
    expect(cfg.content).toContain('    models:');
  });

  it('emits a DEDICATED anthropic-wire gateway provider pinned to the account', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'acct-7', port: 8788 })!;
    expect(cfg.relPath).toBe(OMP_MODELS_REL_PATH);
    expect(cfg.providerId).toBe(OMP_GATEWAY_PROVIDER_ID);
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8788');
    expect(cfg.headers['x-papercusp-account']).toBe('acct-7');
    expect(cfg.models).toEqual(['claude-sonnet-4-6']);
    expect(cfg.modelSelector).toBe('papercusp-gateway/claude-sonnet-4-6');
    // dedicated provider block, NOT a bare `anthropic` override (D-006)
    expect(cfg.content).toContain('# BEGIN PAPERCUSP_OMP_GATEWAY');
    expect(cfg.content).toContain('  papercusp-gateway:');
    expect(cfg.content).not.toMatch(/^\s{2}anthropic:/m);
    expect(cfg.content).toContain('baseUrl: "http://127.0.0.1:8788"');
    expect(cfg.content).toContain(`apiKey: "${OMP_GATEWAY_PLACEHOLDER_KEY}"`);
    expect(cfg.content).toContain('api: anthropic-messages');
    // The placeholder credential hides the upstream OAuth token from OMP.
    // Its supported auth mode must request OAuth wire formatting explicitly.
    expect(cfg.content).toContain('auth: oauth');
    expect(cfg.content).toContain('"x-papercusp-account": "acct-7"');
    expect(cfg.content).toContain('- id: "claude-sonnet-4-6"');
  });

  it('routes the openai wire through the /v1 path with the responses api', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'openai', accountId: 'oa-1', models: ['gpt-6.1-sol'], port: 8788 })!;
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8788/v1');
    expect(cfg.content).toContain('api: openai-responses');
    expect(cfg.content).toContain('auth: apiKey');
  });

  it('refuses an absent or blank OpenAI model instead of substituting an obsolete default', () => {
    expect(() => ompGatewayModelsConfig({ provider: 'openai', gatewayOn: true })).toThrow('explicit supported model');
    expect(() => ompGatewayModelsConfig({ provider: 'openai', gatewayOn: true, models: ['   '] })).toThrow('explicit supported model');
    expect(ompGatewayModelsConfig({ provider: 'openai' })).toBeNull();
  });

  it('exposes caller-supplied models and selects the first', () => {
    const cfg = ompGatewayModelsConfig({
      provider: 'anthropic',
      accountId: 'a',
      models: ['claude-opus-4', 'claude-sonnet-4'],
      port: 8788,
    })!;
    expect(cfg.models).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(cfg.modelSelector).toBe('papercusp-gateway/claude-opus-4');
    expect(cfg.content).toContain('- id: "claude-opus-4"');
    expect(cfg.content).toContain('- id: "claude-sonnet-4"');
  });

  it('includes owner + priority headers only when provided', () => {
    const withAll = ompGatewayModelsConfig({
      provider: 'anthropic',
      accountId: 'a',
      ownerId: 'spawn-9',
      priority: 'mug',
      port: 8788,
    })!;
    expect(withAll.headers['x-papercusp-owner']).toBe('spawn-9');
    expect(withAll.content).toContain('"x-papercusp-owner": "spawn-9"');
    expect(withAll.content).toContain('"x-papercusp-priority": "mug"');

    const minimal = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'a', port: 8788 })!;
    expect(minimal.headers['x-papercusp-owner']).toBeUndefined();
    expect(minimal.content).not.toContain('x-papercusp-owner');
    expect(minimal.content).not.toContain('x-papercusp-priority');
  });

  it('escapes YAML-significant characters in header values', () => {
    const cfg = ompGatewayModelsConfig({ provider: 'anthropic', accountId: 'a"b\\c', port: 8788 })!;
    expect(cfg.content).toContain('"x-papercusp-account": "a\\"b\\\\c"');
  });

  it('maps pool account provider → pi wire', () => {
    expect(ompProviderForAccountProvider('claude')).toBe('anthropic');
    expect(ompProviderForAccountProvider('codex')).toBe('openai');
  });
});
