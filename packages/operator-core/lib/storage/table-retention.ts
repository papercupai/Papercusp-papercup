/**
 * Canonical database-retention policy for the durable-headroom plan (P-010/R-8).
 *
 * The existing `system:telemetry-retention` action and `storage/prune.ts` are
 * the executor. This module is the one policy seam they consume, so the
 * schedule, the seed script and tests cannot silently drift to different
 * horizons. Session archives are already zstd-compressed by session-archive.ts;
 * they remain the lossless recovery source and are never age-deleted here.
 */
export interface TableRetentionTarget {
  category: string;
  retentionDays: number;
  rationale: string;
}

/** Local diagnostic tables: 30 days. Query text remains the shorter, explicit
 * privacy window because it contains agent-authored retrieval text. */
export const TABLE_RETENTION_TARGETS: readonly TableRetentionTarget[] = [
  { category: 'route-invocations', retentionDays: 30, rationale: 'HTTP routing telemetry' },
  { category: 'tool-invocations', retentionDays: 30, rationale: 'tool dispatch telemetry' },
  { category: 'harness-run-output', retentionDays: 30, rationale: 'local run output telemetry' },
  { category: 'agent-activity', retentionDays: 30, rationale: 'fleet activity telemetry' },
  { category: 'memory-recall-query-text', retentionDays: 3, rationale: 'agent-authored retrieval text' },
  { category: 'code-intel-research-trails', retentionDays: 7, rationale: 'optional recent caller-session code subjects' },
];

export function tableRetentionTargets(): Array<{ category: string; retention_days: number }> {
  return TABLE_RETENTION_TARGETS.map(({ category, retentionDays }) => ({
    category,
    retention_days: retentionDays,
  }));
}

export function retentionDaysForTable(category: string): number | null {
  return TABLE_RETENTION_TARGETS.find((target) => target.category === category)?.retentionDays ?? null;
}
