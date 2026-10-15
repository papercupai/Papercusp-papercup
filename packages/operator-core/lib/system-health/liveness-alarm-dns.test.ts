/**
 * WI-6554700010008585 recurrence guard: the infra-liveness alarm must page when DNS resolution fails
 * box-wide. On 2026-10-11 systemd-resolved rejected every lookup for ~46 minutes (stale DNSSEC root
 * trust anchor) and nothing fired because the evaluator had no DNS signal.
 */
import { describe, expect, it } from 'vitest';
import {
  EVALUATED_LIVENESS_SIGNATURES,
  deriveSignatureFromSummary,
  evaluateLivenessAlarm,
  isEvaluatedLivenessSignature,
  unobservableLivenessSignatures,
} from './liveness-alarm';
import type { DnsProbeResult } from './dns-probe';
import type { HealthPanel, SystemHealth } from './types';

const KEY = 'dns-resolution-failing';

function healthWithInfra(infra: Partial<HealthPanel<unknown>> | undefined): SystemHealth {
  const panels: Record<string, HealthPanel<unknown>> = {};
  if (infra) panels.infra = { key: 'infra', label: 'Infra', status: 'ok', summary: 'ok', metrics: [], data: null, ...infra } as HealthPanel<unknown>;
  return {
    workspaceId: 'ws',
    evaluatedAt: 1_000_000,
    overall: 'ok',
    crossMonitor: { queenAlive: true, overwatchAlive: null },
    panels: panels as unknown as SystemHealth['panels'],
  } as SystemHealth;
}

function probe(results: Array<[string, string | null]>): DnsProbeResult {
  const names = results.map(([name, error]) => (error ? { name, ok: false, ms: 3, error } : { name, ok: true, ms: 3 }));
  const okCount = names.filter((n) => n.ok).length;
  return { ok: okCount === names.length, allFailed: okCount === 0, probeMs: 4, names };
}

const withDns = (dns: DnsProbeResult | null | undefined) =>
  healthWithInfra({ data: dns === undefined ? { pg: null } : { dns } });

describe('dns-resolution-failing liveness signal', () => {
  it('fires a blocker naming every failing canary when ALL canaries fail (the 2026-10-11 outage shape)', () => {
    const h = withDns(probe([['registry-1.docker.io', 'ESERVFAIL'], ['api.github.com', 'ESERVFAIL'], ['api.openai.com', 'ESERVFAIL']]));
    const sig = evaluateLivenessAlarm(h, null).find((s) => s.key === KEY);
    expect(sig?.severity).toBe('blocker');
    expect(sig?.summary).toContain('DNS resolution FAILING box-wide');
    expect(sig?.summary).toContain('registry-1.docker.io: ESERVFAIL');
    expect(sig?.summary).toContain('api.openai.com: ESERVFAIL');
    // The summary prefix maps back to the signature for rows written without a stamped signature.
    expect(deriveSignatureFromSummary(sig!.summary)).toBe(KEY);
    expect(deriveSignatureFromSummary(`[infra-liveness] ${sig!.summary}`)).toBe(KEY);
  });

  it('does NOT fire when only some canaries fail (one upstream domain dark is not a resolver outage)', () => {
    const h = withDns(probe([['registry-1.docker.io', 'ENOTFOUND'], ['api.github.com', null], ['api.openai.com', null]]));
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain(KEY);
  });

  it('does NOT fire when DNS is healthy, and a healthy reading is an OBSERVED recovery', () => {
    const h = withDns(probe([['registry-1.docker.io', null], ['api.github.com', null], ['api.openai.com', null]]));
    expect(evaluateLivenessAlarm(h, null).map((s) => s.key)).not.toContain(KEY);
    expect(unobservableLivenessSignatures(h).has(KEY)).toBe(false);
  });

  it('a partial failure is also an observation, so an open row may resolve on it', () => {
    const h = withDns(probe([['registry-1.docker.io', 'ENOTFOUND'], ['api.github.com', null]]));
    expect(unobservableLivenessSignatures(h).has(KEY)).toBe(false);
  });

  it('treats a missing probe as UNOBSERVED, never as recovery (no fire, and an open row stays open)', () => {
    const cases: Array<[string, SystemHealth]> = [
      ['probe could not run (dns null)', withDns(null)],
      ['snapshot from a build without the probe (no dns key)', withDns(undefined)],
      ['infra panel errored', healthWithInfra({ status: 'unknown', error: 'boom', data: null })],
      ['infra panel absent', healthWithInfra(undefined)],
    ];
    for (const [label, h] of cases) {
      expect(evaluateLivenessAlarm(h, null).map((s) => s.key), label).not.toContain(KEY);
      expect(unobservableLivenessSignatures(h).has(KEY), label).toBe(true);
    }
  });

  it('is in the evaluated-signature registry, so this build auto-resolves its own rows', () => {
    expect(EVALUATED_LIVENESS_SIGNATURES.has(KEY)).toBe(true);
    expect(isEvaluatedLivenessSignature(KEY)).toBe(true);
  });
});
