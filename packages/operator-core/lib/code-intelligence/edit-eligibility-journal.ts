/** D018: persist edit-time eligibility on its original candidate row.
 * The first observation wins; replaying after a peer releases its lock cannot
 * rewrite history. Missing rows and missing observations stay unobserved.
 */
import type { Sql } from 'postgres';
import type { InterfaceEligibility } from './interface-eligibility';

export interface EditEligibilityIdentity {
  id: string;
  workspace: string;
  /** The row's own harness_slug. NULL is a real value here (83% of ledger rows,
   * measured 2026-10-27), matched NULL-safely so it is journalled, not dropped. */
  harness: string | null;
  owner: string;
  repoRoot: string;
  file: string;
}

export async function persistInterfaceEligibility(
  input: EditEligibilityIdentity, observation: InterfaceEligibility, sql: Sql,
): Promise<boolean> {
  if (!/^[1-9][0-9]*$/.test(input.id) || !Number.isFinite(Date.parse(observation.capturedAt))) return false;
  // `::text::jsonb`, not `::jsonb`: a client without the raw jsonb serializer (e.g.
  // createFreshPgDb) would JSON.stringify the string again and store a JSON STRING,
  // which push-leg-liveness's `->'interface'->>'verdict'` reads as NULL.
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.edit_attribution_ledger
       SET signal_eligibility = jsonb_set(COALESCE(signal_eligibility, '{}'::jsonb),
         '{interface}', ${JSON.stringify(observation)}::text::jsonb)
     WHERE id = ${input.id}::bigint
       AND workspace_id = ${input.workspace} AND harness_slug IS NOT DISTINCT FROM ${input.harness}
       AND agent_id = ${input.owner} AND repo_root = ${input.repoRoot} AND file = ${input.file}
       AND ts BETWEEN ${observation.capturedAt}::timestamptz - interval '1 minute'
                  AND ${observation.capturedAt}::timestamptz + interval '1 minute'
       AND (signal_eligibility IS NULL OR NOT (signal_eligibility ? 'interface'))
     RETURNING id::text`;
  return rows.length === 1;
}
