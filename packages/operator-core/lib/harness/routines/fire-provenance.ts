import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import { getBuildInfo } from '../../build-info';

/** Shared by the census and its independent DBOS boundary observations. */
export const monitoredRuntimeId = `${hostname()}:${process.pid}:${Math.round(Date.now() - process.uptime() * 1000)}`;
interface FireDefinition {
  id: string; workspaceId: string; installSlug: string; targetRole: string;
  triggerConfig: Record<string, unknown>; payloadTemplate: Record<string, unknown> | null;
  rescheduleIntervalSec: number | null; targetOwnerId: string | null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function routineDefinitionHash(row: FireDefinition): string {
  const { id, workspaceId, installSlug, targetRole, triggerConfig, payloadTemplate,
    rescheduleIntervalSec, targetOwnerId } = row;
  return createHash('sha256').update(JSON.stringify(canonical({ id, workspaceId, installSlug, targetRole,
    triggerConfig, payloadTemplate, rescheduleIntervalSec, targetOwnerId }))).digest('hex');
}
export interface RoutineFireProvenance {
  version: 1; origin: 'scheduler' | 'manual'; scheduledAt: string | null; configHash: string;
}
/** Only the scheduled claim path supplies a due slot. An old nine-argument fire stays unknown. */
export function routineFireProvenance(row: FireDefinition, origin: RoutineFireProvenance['origin'],
  dueAt?: Date | null): RoutineFireProvenance {
  return { version: 1, origin, scheduledAt: origin === 'scheduler' && dueAt && Number.isFinite(dueAt.getTime())
    ? dueAt.toISOString() : null, configHash: routineDefinitionHash(row) };
}
export interface MonitoredFireSnapshot {
  sha: string | null; runtime: string; observedAt: string; routineId: string; workspaceId: string;
  harnessSlug: string; targetRole: string; configHash: string; active: boolean;
  expression: string | null; timezone: string;
}
/** Match computeNextFire: RRULE wins; cron-parser uses the process zone and
 * ignores RRULE's tzid option. A snapshot must describe the scheduler it saw. */
export function monitoredScheduleDescriptor(cfg: Record<string, unknown>) {
  const rrule = typeof cfg.rrule === 'string' ? cfg.rrule : null;
  return { expression: rrule ?? (typeof cfg.cron === 'string' ? cfg.cron : null),
    timezone: rrule || cfg.kind === 'rrule'
      ? typeof cfg.tzid === 'string' && cfg.tzid.trim() ? cfg.tzid.trim() : 'UTC'
      : Intl.DateTimeFormat().resolvedOptions().timeZone };
}
/** Read the canonical definition at each workflow boundary; never reconstruct an old schedule
 * from its current next_fire_at (which the successful claim has already advanced). */
export async function readMonitoredFireSnapshot(sql: Sql, workspaceId: string,
  routineId: string): Promise<MonitoredFireSnapshot | null> {
  const [row] = await sql`SELECT id,workspace_id,install_slug,target_role,trigger_config,payload_template,
    reschedule_interval_sec,target_owner_id,active FROM harness_shared.routines
    WHERE workspace_id=${workspaceId} AND id=${routineId}`;
  if (!row) return null;
  const definition: FireDefinition = { id: row.id, workspaceId: row.workspace_id, installSlug: row.install_slug,
    targetRole: row.target_role, triggerConfig: row.trigger_config, payloadTemplate: row.payload_template,
    rescheduleIntervalSec: row.reschedule_interval_sec, targetOwnerId: row.target_owner_id };
  const cfg = definition.triggerConfig;
  return { sha: getBuildInfo().sha, runtime: monitoredRuntimeId, observedAt: new Date().toISOString(),
    routineId: row.id, workspaceId: row.workspace_id, harnessSlug: row.install_slug, targetRole: row.target_role,
    configHash: routineDefinitionHash(definition), active: row.active === true,
    ...monitoredScheduleDescriptor(cfg) };
}
