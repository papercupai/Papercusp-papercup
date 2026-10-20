/**
 * The wearer's identity-bearing launch record, as the host paths that run
 * identity work for a wearer read it (identity-system-everything-migration-2026-10-18
 * P-003, #D-017): async rule reactions (`identity-async-rules.ts`) and turn-start
 * recipe and tool providers (`turn-start-package-sink.ts`).
 *
 * A leaf on purpose: those two modules sit on an import cycle
 * (identity-async-rules → sync-hook-rules → turn-start-package-sink), so the
 * shared read lives here rather than in either of them.
 */
import { getOrgPg } from '@papercusp/db-org';

/**
 * SQL fragment: the `role` of the owner's newest launch record, the same row
 * `readSuLaunchSpecByOwner` reads. Only the role is selected because the record
 * also carries the full specification artifact. Pass the value, wrapped as
 * `{ role }`, to `identityWearerRole`: a null role is an SU record.
 */
export function wearerLaunchRoleSql(ownerId: string) {
  return getOrgPg().sql`(
    SELECT a.launch_spec->'role'
      FROM harness_shared.adv_sessions a
     WHERE a.coord_owner_id = ${ownerId}
     ORDER BY a.started_at DESC
     LIMIT 1)`;
}

/** The `role` of the owner's newest launch record, wrapped for `identityWearerRole`. */
export async function readWearerLaunchRecord(ownerId: string): Promise<{ role: unknown }> {
  const rows = await getOrgPg().sql<{ role: unknown }[]>`SELECT ${wearerLaunchRoleSql(ownerId)} AS role`;
  return { role: rows[0]?.role ?? null };
}
