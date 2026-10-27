/** P-003: committed-start census, independent of retained DBOS history. */
import type { Sql } from 'postgres';

export const ROUTINE_FIRE_VOLUME_HOUR_MS = 3_600_000;
export const ROUTINE_FIRE_VOLUME_DAY_MS = 24 * ROUTINE_FIRE_VOLUME_HOUR_MS;
export interface RoutineFireVolumeRow {
  workspaceId: string;
  installSlug: string;
  routineId: string;
  targetRole: string;
  starts: number;
}
export interface RoutineFireVolumeWindow {
  startMs: number;
  endMs: number;
  observedAtMs: number;
  coveredFromMs: number | null;
  triggerEnabled: boolean;
  rows: RoutineFireVolumeRow[];
}
export interface RoutineFireVolumeDisposition {
  workspaceId: string;
  installSlug: string;
  routineId: string;
  justification?: string;
  /** Same-duration measured baseline and its source/window receipt. */
  reduction?: { baselineStarts: number; evidenceRef: string };
}

export function evaluateRoutineFireVolume(
  window: RoutineFireVolumeWindow,
  dispositions: RoutineFireVolumeDisposition[],
): { status: 'pass' | 'fail' | 'unknown'; reasons: string[]; highVolume: RoutineFireVolumeRow[] } {
  const reasons: string[] = [];
  const { startMs, endMs, observedAtMs, coveredFromMs } = window;
  if (![startMs, endMs, observedAtMs].every(Number.isSafeInteger)
    || startMs % ROUTINE_FIRE_VOLUME_HOUR_MS !== 0
    || endMs - startMs !== ROUTINE_FIRE_VOLUME_DAY_MS
    || observedAtMs < endMs || observedAtMs - startMs > 7 * ROUTINE_FIRE_VOLUME_DAY_MS
    || coveredFromMs === null || !Number.isSafeInteger(coveredFromMs) || coveredFromMs > startMs
    || !window.triggerEnabled) reasons.push('Incomplete counter coverage or invalid UTC-hour 24h window');
  const grouped = new Map<string, RoutineFireVolumeRow>();
  for (const row of window.rows) {
    if (!Number.isSafeInteger(row.starts) || row.starts < 0
      || [row.workspaceId, row.installSlug, row.routineId, row.targetRole]
        .some(value => !value || value === '@unattributed')) {
      reasons.push('Invalid count or unattributed committed start');
      continue;
    }
    const key = JSON.stringify([row.workspaceId, row.installSlug, row.routineId]);
    const prior = grouped.get(key);
    const starts = row.starts + (prior?.starts ?? 0);
    if (!Number.isSafeInteger(starts)) reasons.push('Unsafe aggregate count');
    grouped.set(key, { ...row, starts });
  }
  const highVolume = [...grouped.values()].filter(row => row.starts > 2000);
  if (reasons.length) return { status: 'unknown', reasons, highVolume };
  for (const row of highVolume) {
    const matched = dispositions.filter(d => d.workspaceId === row.workspaceId
      && d.installSlug === row.installSlug && d.routineId === row.routineId);
    const disposition = matched.length === 1 ? matched[0] : undefined;
    const reduced = disposition?.reduction;
    if (!disposition?.justification?.trim() && !(reduced?.evidenceRef.trim()
      && Number.isSafeInteger(reduced.baselineStarts) && reduced.baselineStarts > row.starts)) {
      reasons.push(`Missing individual reduction/justification: ${row.workspaceId}/${row.installSlug}/${row.routineId}`);
    }
  }
  return { status: reasons.length ? 'fail' : 'pass', reasons, highVolume };
}

/** One snapshot for attribution, coverage epoch and observation time. Admin SQL
 * is intentional: this census must include deleted routines and unknown tenants. */
export async function readRoutineFireVolume(sql: Sql, startMs: number): Promise<RoutineFireVolumeWindow> {
  const endMs = startMs + ROUTINE_FIRE_VOLUME_DAY_MS;
  return sql.begin('isolation level repeatable read read only', async tx => {
    const [coverage] = await tx<{ provenance: string | null; enabled: boolean; now_ms: string }[]>`
      SELECT (SELECT obj_description(oid, 'pg_trigger') FROM pg_trigger
                WHERE tgrelid = to_regclass('dbos.workflow_status')
                  AND tgname = 'routine_fire_committed_start_counter') AS provenance,
        EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('dbos.workflow_status')
          AND tgname = 'routine_fire_committed_start_counter' AND tgenabled = 'O'
          AND tgfoid = to_regprocedure('harness_shared.count_committed_routine_fire_start()')) AS enabled,
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`;
    const rows = await tx<{
      workspace_id: string; install_slug: string; routine_id: string; target_role: string; starts: string;
    }[]>`SELECT workspace_id, install_slug, routine_id, target_role, sum(starts)::bigint AS starts
      FROM harness_shared.routine_fire_start_counts
      WHERE bucket_start_ms >= ${startMs} AND bucket_start_ms < ${endMs}
      GROUP BY workspace_id, install_slug, routine_id, target_role
      ORDER BY workspace_id, install_slug, routine_id, target_role`;
    let coveredFromMs: number | null = null;
    try {
      const provenance = JSON.parse(coverage?.provenance ?? 'null');
      if (provenance?.schemaVersion === 1 && Number.isSafeInteger(provenance.sinceMs)) coveredFromMs = provenance.sinceMs;
    } catch { /* Missing/corrupt provenance remains unknown. */ }
    return { startMs, endMs, observedAtMs: Number(coverage?.now_ms),
      coveredFromMs, triggerEnabled: coverage?.enabled === true,
      rows: rows.map(row => ({ workspaceId: row.workspace_id, installSlug: row.install_slug,
        routineId: row.routine_id, targetRole: row.target_role, starts: Number(row.starts) })) };
  });
}
