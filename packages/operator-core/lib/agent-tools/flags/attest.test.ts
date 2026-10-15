import { describe, expect, it } from 'vitest';
import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import type { ProcessFlagAttestation } from '../../flag-attestation';
import { buildFlagAttestationReport } from './attest';

import '../index';

const KEY = ALL_FLAG_KEYS[0] as FlagKey;

function processAttestation(input: {
  label: string;
  resolvedValue: boolean;
  compiledDefault?: boolean;
  source?: ProcessFlagAttestation['source'];
  cacheGeneration?: number | null;
  ttlRemainingMs?: number;
}): ProcessFlagAttestation {
  const compiledDefault = input.compiledDefault ?? true;
  const cacheGeneration = input.cacheGeneration ?? null;
  const ttlRemainingMs = input.ttlRemainingMs ?? 0;
  return {
    ok: true,
    key: KEY,
    resolvedValue: input.resolvedValue,
    compiledDefault,
    source: input.source ?? 'compiled-default',
    backendConfigured: true,
    observedAtMs: 1,
    overrideRead: {
      kind: cacheGeneration === null ? 'not-read' : 'store-load',
      storeConfigured: true,
      cacheKey: '',
      cacheGeneration,
      cacheLoadedAtMs: cacheGeneration === null ? null : 1,
      cacheAgeMs: cacheGeneration === null ? null : 0,
      ttlMs: 5_000,
      ttlRemainingMs,
      loadError: null,
    },
    process: {
      role: 'operator',
      label: input.label,
      port: 3170,
      pid: 100,
      processId: input.label,
      buildSha: 'abc',
    },
  };
}

describe('flags:attest report', () => {
  it('keeps unreachable processes explicit and reports a freshly loaded cache TTL window', async () => {
    const local = processAttestation({
      label: 'operator:3170',
      resolvedValue: true,
      source: 'override-store',
      cacheGeneration: 4,
      ttlRemainingMs: 4_900,
    });
    const report = await buildFlagAttestationReport(KEY, 'did', {
      local: async () => local,
      remote: async () => [
        {
          target: { label: 'inference-gateway:8788', url: 'http://127.0.0.1', expectedPid: null },
          ok: false,
          attestation: null,
          error: 'connect refused',
          elapsedMs: 2,
        },
      ],
    });

    expect(report.status).toBe('partial');
    expect(report.consistent).toBe(true);
    expect(report.unknownProcesses).toEqual([{ target: 'inference-gateway:8788', error: 'connect refused' }]);
    expect(report.cacheWindowProcesses).toEqual([
      {
        process: 'operator:3170',
        cacheGeneration: 4,
        ttlRemainingMs: 4_900,
        source: 'override-store',
        readKind: 'store-load',
      },
    ]);
  });

  it('separates cross-process divergence from resolved-vs-compiled-default evidence', async () => {
    const local = processAttestation({ label: 'operator:3170', resolvedValue: true });
    const remote = processAttestation({
      label: 'inference-gateway:8788',
      resolvedValue: false,
      source: 'process-cache',
      cacheGeneration: 9,
      ttlRemainingMs: 1_000,
    });
    const report = await buildFlagAttestationReport(KEY, 'did', {
      local: async () => local,
      remote: async () => [
        {
          target: { label: remote.process.label, url: 'http://127.0.0.1', expectedPid: null },
          ok: true,
          attestation: remote,
          elapsedMs: 1,
        },
      ],
    });

    expect(report.status).toBe('divergent');
    expect(report.mismatches).toEqual([
      {
        process: 'inference-gateway:8788',
        resolvedValue: false,
        compiledDefault: true,
        source: 'process-cache',
      },
    ]);
    expect(report.defaultMismatches).toEqual(report.mismatches);
  });

  it('is registered on the full projected tool surface', () => {
    const registered = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === 'flags:attest');
    expect(registered?.agentRoles).toContain('operator');
    expect(registered?.guidance?.when).toMatch(/runtime proof/i);
  });
});
