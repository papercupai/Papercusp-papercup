import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  FlagAttestation,
  FlagOverrideReadKind,
  FlagResolutionSource,
} from '@papercusp/flags/server';

const flagState = vi.hoisted(() => ({
  next: null as FlagAttestation | null,
  calls: [] as Array<[string, string]>,
}));

vi.mock('@papercusp/flags/server', () => ({
  getFlagAttestation: async (key: string, distinctId: string) => {
    flagState.calls.push([key, distinctId]);
    if (!flagState.next) throw new Error('no attestation queued');
    return flagState.next;
  },
}));

import {
  memoryFederationFlagReadDegradation,
  readMemoryFederationFlagOnce,
} from '../memory-federation-flag-read';
import { FLAGS } from '@papercusp/flags';

function attestation(
  kind: FlagOverrideReadKind,
  source: FlagResolutionSource,
  resolvedValue: boolean,
  loadError: string | null = 'Error: flag backend timed out after 2000ms',
): FlagAttestation {
  return {
    key: FLAGS.MEM0_FEDERATION_EGRESS,
    resolvedValue,
    compiledDefault: false,
    source,
    overrideRead: {
      kind,
      storeConfigured: kind !== 'unconfigured',
      cacheKey: 'test',
      cacheGeneration: null,
      cacheLoadedAtMs: null,
      cacheAgeMs: null,
      ttlMs: 5_000,
      ttlRemainingMs: 0,
      loadError: kind === 'store-error' ? loadError : null,
    },
    backendConfigured: false,
    observedAtMs: 0,
  };
}

describe('memoryFederationFlagReadDegradation (WI-10005919)', () => {
  it('flags ONLY a store-error read as degraded, naming where the value came from and why', () => {
    expect(memoryFederationFlagReadDegradation(attestation('store-error', 'compiled-default', false))).toBe(
      'override store unreadable with no cached map (value came from compiled-default; ' +
        'load error: Error: flag backend timed out after 2000ms)',
    );
    expect(memoryFederationFlagReadDegradation(attestation('store-error', 'posthog', true))).toContain('posthog');
  });

  it('says the load error was not reported rather than inventing one (WI-10006242)', () => {
    expect(
      memoryFederationFlagReadDegradation(attestation('store-error', 'compiled-default', false, null)),
    ).toContain('load error: not reported');
  });

  it.each<[FlagOverrideReadKind, FlagResolutionSource]>([
    ['store-load', 'override-store'],
    ['cache-hit', 'process-cache'],
    ['stale-cache-fallback', 'process-cache'],
    ['not-read', 'env-override'],
    ['not-read', 'test-override'],
    ['unconfigured', 'compiled-default'],
  ])('treats a %s read (source %s) as authoritative', (kind, source) => {
    expect(memoryFederationFlagReadDegradation(attestation(kind, source, true))).toBeNull();
  });
});

describe('readMemoryFederationFlagOnce (WI-10005919)', () => {
  beforeEach(() => {
    flagState.next = null;
    flagState.calls = [];
  });

  it('reads the production flag through getFlagAttestation and reports a degraded store read', async () => {
    flagState.next = attestation('store-error', 'compiled-default', false);
    const read = await readMemoryFederationFlagOnce();
    expect(flagState.calls).toEqual([[FLAGS.MEM0_FEDERATION_EGRESS, 'system']]);
    expect(read.value).toBe(false);
    expect(read.degraded).toContain('override store unreadable');
  });

  it('returns an authoritative value from a healthy store read', async () => {
    flagState.next = attestation('store-load', 'override-store', true);
    await expect(readMemoryFederationFlagOnce()).resolves.toMatchObject({ value: true, degraded: null });
  });

  it('reports a throw as degraded instead of an ordinary OFF', async () => {
    let t = 100;
    const read = await readMemoryFederationFlagOnce(
      async () => {
        t += 2_000;
        throw new Error('flag backend timed out after 2000ms');
      },
      () => t,
    );
    expect(read).toEqual({
      value: false,
      degraded: 'flag read threw (Error: flag backend timed out after 2000ms)',
      elapsedMs: 2_000,
    });
  });

  it('uses an injected reader verbatim and never consults the flag backend', async () => {
    await expect(readMemoryFederationFlagOnce(async () => true)).resolves.toMatchObject({
      value: true,
      degraded: null,
    });
    expect(flagState.calls).toEqual([]);
  });
});
