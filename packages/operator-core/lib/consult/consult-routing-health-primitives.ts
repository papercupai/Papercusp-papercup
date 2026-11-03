import type { ExpertiseRoutingReceipt, ExpertiseRoutingStage } from './relevance-router';

export interface ExpertiseExecutionHealth {
  cohort: 'routing-execution-start';
  status: 'measured' | 'measured-empty' | 'unavailable';
  unavailableReason: string | null;
  rowsScanned: number;
  invalidReceipts: number;
  truncatedByLimit: boolean;
  groups: Array<{
    caller: string; policy: string; buildSha: string | null; calls: number;
    outcomes: Record<ExpertiseRoutingReceipt['outcome'], number>;
    latencyMs: { observed: number; p50: number | null; p95: number | null };
    stages: Partial<Record<ExpertiseRoutingStage, { observed: number; threw: number; p50: number | null; p95: number | null }>>;
  }>;
}

export function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** Nearest-rank percentiles over observed durations only; empty is unknown. */
function executionLatency(values: number[]) {
  const sorted = values.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { observed: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

/** Routing executions are a third cohort, never a request or launch denominator. */
export function expertiseExecutionHealthFromRows(rows: Array<{ metadata_json: unknown }>, truncatedByLimit = false): ExpertiseExecutionHealth {
  const groups = new Map<string, ExpertiseExecutionHealth['groups'][number] & {
    durations: number[]; stageDurations: Partial<Record<ExpertiseRoutingStage, number[]>>;
  }>();
  let invalidReceipts = 0;
  for (const row of rows) {
    const value = jsonObject(row.metadata_json);
    if (value.schemaVersion !== 1 || typeof value.caller !== 'string' || typeof value.policy !== 'string' ||
        !['returned', 'degraded', 'threw'].includes(String(value.outcome))) { invalidReceipts++; continue; }
    const receipt = value as unknown as ExpertiseRoutingReceipt;
    const buildSha = typeof receipt.buildSha === 'string' ? receipt.buildSha : null;
    const key = JSON.stringify([receipt.caller, receipt.policy, buildSha]);
    let group = groups.get(key);
    if (!group) {
      group = { caller: receipt.caller, policy: receipt.policy, buildSha, calls: 0,
        outcomes: { returned: 0, degraded: 0, threw: 0 }, latencyMs: executionLatency([]), stages: {}, durations: [], stageDurations: {} };
      groups.set(key, group);
    }
    group.calls++; group.outcomes[receipt.outcome]++;
    if (typeof receipt.durationMs === 'number') group.durations.push(receipt.durationMs);
    for (const stage of ['disclosure', 'embedding', 'transcripts', 'verification', 'authorship', 'liveness', 'ranking', 'evidence'] as const) {
      const reading = receipt.stages?.[stage];
      if (!reading || !Number.isFinite(reading.durationMs) || reading.durationMs < 0) continue;
      const values = group.stageDurations[stage] ??= [];
      values.push(reading.durationMs);
      const prior = group.stages[stage];
      group.stages[stage] = { ...executionLatency(values), threw: (prior?.threw ?? 0) + (reading.outcome === 'threw' ? 1 : 0) };
    }
  }
  return {
    cohort: 'routing-execution-start', status: rows.length ? 'measured' : 'measured-empty', unavailableReason: null,
    rowsScanned: rows.length, invalidReceipts, truncatedByLimit,
    groups: [...groups.values()].map(({ durations, stageDurations: _stageDurations, ...group }) => ({ ...group, latencyMs: executionLatency(durations) }))
      .sort((a, b) => a.caller.localeCompare(b.caller) || a.policy.localeCompare(b.policy) || (a.buildSha ?? '').localeCompare(b.buildSha ?? '')),
  };
}
