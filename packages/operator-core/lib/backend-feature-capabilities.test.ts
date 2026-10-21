import { describe, expect, it } from 'vitest';
import {
  BACKEND_FEATURE_CAPABILITIES,
  accountProviderForInteractiveBackend,
  backendFeatureCapability,
  backendFeatureGuard,
  backendSupportsFeature,
  interactiveBackendFromSpawnBackend,
  type BackendFeature,
  type InteractiveBackend,
} from './backend-feature-capabilities';

const BACKENDS: InteractiveBackend[] = ['claude', 'codex', 'omp'];
const FEATURES: BackendFeature[] = [
  'fresh-su',
  'resume',
  'role-session',
  'launch-context',
  'saved-prompts',
  'slash-tool-prompts',
  'account-pinning',
  'gateway-routing',
  'file-lock-enforcement',
  'native-fork',
  'native-web-search',
  'native-code-review',
  'native-image-input',
  'native-image-generation',
  'native-subagents',
  'native-app-server',
  'brain-pinning',
  'forced-native-session-id',
  'runtime-home-inheritance',
  'mcp-http-auth',
  'settings-diagnostics',
];

describe('BACKEND_FEATURE_CAPABILITIES', () => {
  it('covers every backend and feature with an explicit state', () => {
    for (const backend of BACKENDS) {
      expect(Object.keys(BACKEND_FEATURE_CAPABILITIES[backend]).sort()).toEqual([...FEATURES].sort());
      for (const feature of FEATURES) {
        expect(BACKEND_FEATURE_CAPABILITIES[backend][feature].mechanism).toBeTruthy();
      }
    }
  });

  it('records Codex parity guarantees and honest non-native gaps', () => {
    expect(backendSupportsFeature('codex', 'launch-context')).toBe(true);
    expect(backendSupportsFeature('codex', 'mcp-http-auth')).toBe(true);
    expect(backendSupportsFeature('codex', 'runtime-home-inheritance')).toBe(true);
    expect(backendSupportsFeature('codex', 'native-fork')).toBe(true);
    expect(backendSupportsFeature('codex', 'native-web-search')).toBe(true);
    expect(backendSupportsFeature('codex', 'native-code-review')).toBe(true);
    expect(backendSupportsFeature('codex', 'native-image-input')).toBe(true);
    expect(backendSupportsFeature('codex', 'native-image-generation')).toBe(true);
    expect(backendSupportsFeature('codex', 'native-app-server')).toBe(true);

    expect(backendFeatureCapability('codex', 'file-lock-enforcement').state).toBe('supported');
    expect(backendFeatureCapability('codex', 'forced-native-session-id').unsupportedReason).toMatch(/cannot/i);
  });

  it('records Codex-native surfaces that no longer need to be treated as absent', () => {
    expect(backendFeatureCapability('codex', 'native-web-search')).toMatchObject({
      state: 'supported',
      mechanism: expect.stringMatching(/--search|web_search/i),
    });
    expect(backendFeatureCapability('codex', 'native-code-review')).toMatchObject({
      state: 'supported',
      mechanism: expect.stringMatching(/codex review/i),
    });
    expect(backendFeatureCapability('codex', 'native-image-input')).toMatchObject({
      state: 'supported',
      mechanism: expect.stringMatching(/--image|-i/i),
    });
    expect(backendFeatureCapability('codex', 'native-image-generation')).toMatchObject({
      state: 'supported',
      mechanism: expect.stringMatching(/image generation|imagegen/i),
    });
    expect(backendFeatureCapability('codex', 'native-app-server')).toMatchObject({
      state: 'supported',
      mechanism: expect.stringMatching(/app-server|remote/i),
    });
  });

  it('codex native subagents are denied by default', () => {
    // Plan client-native-features-adoption-2026-10-21 R-1: same posture as Claude.
    expect(backendSupportsFeature('codex', 'native-subagents')).toBe(false);
    expect(backendSupportsFeature('claude', 'native-subagents')).toBe(false);
    expect(backendFeatureCapability('codex', 'native-subagents')).toMatchObject({
      state: 'unsupported',
      mechanism: expect.stringMatching(/--allow-subagents/),
      unsupportedReason: expect.stringMatching(/denied by default/i),
    });
  });

  it('documents native fork support where the current backend exposes it', () => {
    expect(backendFeatureCapability('codex', 'native-fork')).toMatchObject({
      state: 'supported',
      mechanism: expect.stringMatching(/codex fork/i),
    });
    expect(backendFeatureCapability('omp', 'native-fork')).toMatchObject({
      state: 'unsupported',
      unsupportedReason: expect.stringMatching(/launch_context/i),
    });
  });

  it('documents retired brain pinning as backend-neutral converse, not a Claude-only path', () => {
    for (const backend of BACKENDS) {
      expect(backendFeatureCapability(backend, 'brain-pinning')).toMatchObject({
        state: 'unsupported',
        unsupportedReason: expect.stringMatching(/operator\/sentinel converse/i),
      });
    }
  });

  it('marks OMP gateway/account routing supported via the models.yml gateway provider (D-006)', () => {
    expect(backendFeatureCapability('omp', 'account-pinning').state).toBe('supported');
    expect(backendFeatureCapability('omp', 'gateway-routing').state).toBe('supported');
    expect(backendFeatureCapability('omp', 'settings-diagnostics').state).toBe('supported');
  });

  it('provides a reusable fail-closed guard reason for live launcher paths', () => {
    expect(backendFeatureGuard('claude', 'account-pinning')).toMatchObject({ supported: true, reason: null });
    // OMP account-pinning is now supported (D-006); native-fork remains a real CLI gap → fail-closed guard.
    expect(backendFeatureGuard('omp', 'account-pinning')).toMatchObject({ supported: true, reason: null });
    expect(backendFeatureGuard('omp', 'native-fork')).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/fork/i),
    });
  });

  it('normalizes spawn backend names into the matrix backend keys', () => {
    expect(interactiveBackendFromSpawnBackend('claude-code')).toBe('claude');
    expect(interactiveBackendFromSpawnBackend('codex')).toBe('codex');
    expect(interactiveBackendFromSpawnBackend('omp')).toBe('omp');
  });

  it('derives account providers for backends with supported pinning + routing (omp pins claude accounts, D-006)', () => {
    expect(accountProviderForInteractiveBackend('claude')).toBe('claude');
    expect(accountProviderForInteractiveBackend('codex')).toBe('codex');
    expect(accountProviderForInteractiveBackend('omp')).toBe('claude');
  });
});
