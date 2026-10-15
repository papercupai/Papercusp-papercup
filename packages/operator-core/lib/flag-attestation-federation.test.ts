import { describe, expect, it } from 'vitest';
import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import type { ProcessFlagAttestation } from './flag-attestation';
import {
  collectRemoteFlagAttestations,
  gatewayFlagAttestationTarget,
  operatorFlagAttestationTarget,
  probeFlagAttestation,
} from './flag-attestation-federation';

const KEY = ALL_FLAG_KEYS[0] as FlagKey;
const sibling = (port: number, pid: number) => ({
  port,
  pid,
  startedAt: 1_788_523_200_000,
});

function attestation(label: string, pid: number): ProcessFlagAttestation {
  return {
    ok: true,
    key: KEY,
    resolvedValue: true,
    compiledDefault: true,
    source: 'compiled-default',
    backendConfigured: false,
    observedAtMs: 1,
    overrideRead: {
      kind: 'unconfigured',
      storeConfigured: false,
      cacheKey: '',
      cacheGeneration: null,
      cacheLoadedAtMs: null,
      cacheAgeMs: null,
      ttlMs: 5_000,
      ttlRemainingMs: 0,
      loadError: null,
    },
    process: {
      role: 'operator',
      label,
      port: 3170,
      pid,
      processId: label,
      buildSha: 'abc',
    },
  };
}

describe('flag attestation federation', () => {
  it('builds encoded operator and gateway targets from the existing discovery shape', () => {
    const operator = operatorFlagAttestationTarget(sibling(4170, 12), KEY, 'person with spaces');
    const gateway = gatewayFlagAttestationTarget(KEY, 'did', 9788);

    expect(operator.label).toBe('operator:4170');
    expect(operator.expectedPid).toBe(12);
    expect(operator.url).toContain('/api/internal/flags-attest?');
    expect(operator.url).toContain('distinctId=person+with+spaces');
    expect(gateway.label).toBe('inference-gateway:9788');
    expect(gateway.url).toContain('/internal/flags-attest?');
  });

  it('rejects a response from a stale discovered pid instead of attributing it to that process', async () => {
    const target = operatorFlagAttestationTarget(sibling(4170, 12), KEY, 'did');
    const result = await probeFlagAttestation(target, KEY, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => attestation('operator:4170', 99),
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/discovery pid 12.*responder pid 99/i);
  });

  it('bounds each sibling independently so a wedged process does not erase healthy evidence', async () => {
    const healthy = sibling(4170, 12);
    const wedged = sibling(4270, 13);
    const results = await collectRemoteFlagAttestations(KEY, 'did', {
      siblings: [healthy, wedged],
      includeGateway: false,
      timeoutMs: 10_000,
      budgetMs: 10,
      fetchImpl: async (url) => {
        if (url.includes(':4270/')) return new Promise(() => {});
        return {
          ok: true,
          status: 200,
          json: async () => attestation('operator:4170', 12),
        };
      },
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ ok: true, attestation: { process: { pid: 12 } } });
    expect(results[1]).toMatchObject({ ok: false, error: 'probe budget 10ms exceeded' });
  });
});
