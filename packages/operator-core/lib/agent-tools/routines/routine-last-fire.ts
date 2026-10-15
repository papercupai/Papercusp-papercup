/**
 * routine-last-fire.ts — EI-25264102161745452.
 *
 * A system action reports what one fire DID through `SystemActionResult.diagnostics`
 * (system-actions.ts), and that contract says the value is "retained in the action's
 * DBOS operation_output" because "logs alone are not a durable measurement surface".
 * The retention was real; the READ was not: no tool returned it, so the only way to
 * learn what a fire did (e.g. which reds operator-e2e-red-filer filed, owned or left
 * unassigned) was a hand-written query against `dbos.operation_outputs`, and the
 * routine's own `health` stays null on a clean fire that nevertheless did something
 * worth checking.
 *
 * This module supplies that read for `routines:list`. It is attached only when the
 * caller pins the read with `name` — the lookup joins DBOS tables, and a full listing
 * of every routine should not pay for it.
 *
 * Binding: a routine fire runs as a DBOS `routineFire` workflow whose FIRST input is
 * the routine id, and the action's step is recorded under `function_name =
 * target_role` (`system:<action>`). The same action can be installed in several
 * installs, so the function name alone would misattribute another install's fire; the
 * routine id is what binds a fire to THIS row.
 */

/** Fires older than this are not looked up (keeps the scan on the leading
 *  `completed_at_epoch_ms` column of idx_operation_outputs_completed_at_function_name).
 *  Eight days so a weekly routine still reports its last fire. */
export const ROUTINE_LAST_FIRE_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

/** A diagnostics body larger than this is replaced by a bounded head, so one chatty
 *  action cannot blow the tool's result budget. */
export const ROUTINE_LAST_FIRE_MAX_CHARS = 4_000;

/** Bound on a recorded thrown-error string. */
const ERROR_MAX_CHARS = 500;

export interface RoutineLastFire {
  /** When the action's step completed (ISO), null if DBOS recorded no completion time. */
  completedAt: string | null;
  /** The DBOS workflow id of the fire (for a follow-up read of the whole workflow). */
  workflowId: string;
  /** The action's `diagnostics`, or null when the fire returned none. */
  diagnostics: unknown;
  /** The action's fail-soft sub-pass error, or null. */
  softError: string | null;
  /** The error DBOS recorded when the step THREW, or null. */
  error: string | null;
  /** Present only when `diagnostics` was replaced by a bounded head. */
  diagnosticsTruncated?: { chars: number; head: string };
}

/** What `lastFire` holds on a row: a fire, an explicit unavailability, or null when
 *  the read was not pinned / the routine is not a system action / no fire in the window. */
export type RoutineLastFireReading = RoutineLastFire | { unavailable: string } | null;

/** DBOS serializes step outputs with superjson: `{ json: <value>, meta? }`. Older rows
 *  may be plain JSON. Returns the deserialized value, or undefined when unparseable. */
function unwrapDbosValue(raw: string | null): unknown {
  if (raw === null || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'json' in parsed) {
      return (parsed as { json: unknown }).json;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Pure: turn one `dbos.operation_outputs` row into the `lastFire` reading. */
export function parseRoutineFireOutput(row: {
  workflow_uuid: string;
  output: string | null;
  error: string | null;
  completed_at_epoch_ms: string | number | null;
}): RoutineLastFire {
  const value = unwrapDbosValue(row.output);
  const result = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { diagnostics?: unknown; softError?: unknown })
    : null;
  const diagnostics = result?.diagnostics ?? null;
  const softError = typeof result?.softError === 'string' ? result.softError : null;

  let error: string | null = null;
  if (row.error) {
    const e = unwrapDbosValue(row.error);
    const message = e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string'
      ? (e as { message: string }).message
      : row.error;
    error = message.length > ERROR_MAX_CHARS ? `${message.slice(0, ERROR_MAX_CHARS)}…` : message;
  }

  const ms = row.completed_at_epoch_ms === null ? NaN : Number(row.completed_at_epoch_ms);
  const fire: RoutineLastFire = {
    completedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    workflowId: row.workflow_uuid,
    diagnostics,
    softError,
    error,
  };
  if (diagnostics !== null) {
    const text = JSON.stringify(diagnostics) ?? '';
    if (text.length > ROUTINE_LAST_FIRE_MAX_CHARS) {
      fire.diagnostics = null;
      fire.diagnosticsTruncated = { chars: text.length, head: text.slice(0, ROUTINE_LAST_FIRE_MAX_CHARS) };
    }
  }
  return fire;
}

/** Minimal tagged-template surface this module needs from `getOrgPg().sql`. */
export type LastFireSql = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

type LastFireRow = {
  routine_id: string;
  workflow_uuid: string;
  output: string | null;
  error: string | null;
  completed_at_epoch_ms: string | number | null;
};

type LastFireQueryRunner = (
  query: (sql: LastFireSql) => Promise<LastFireRow[]>,
) => Promise<LastFireRow[]>;

/**
 * Read the newest completed fire of each SYSTEM routine in `routines` (keyed by
 * routine id). Non-system routines are absent from the map. A failed lookup (e.g.
 * the DBOS schema lives in another database on this deployment) maps every system
 * routine to `{ unavailable }` rather than failing the whole listing.
 */
export async function readRoutineLastFires(
  sql: LastFireSql,
  routines: ReadonlyArray<{ id: string; targetRole: string }>,
  nowMs: number = Date.now(),
  runQuery?: LastFireQueryRunner,
): Promise<Map<string, RoutineLastFireReading>> {
  const out = new Map<string, RoutineLastFireReading>();
  const system = routines.filter((r) => r.targetRole.startsWith('system:'));
  if (system.length === 0) return out;
  const ids = system.map((r) => r.id);
  const roles = [...new Set(system.map((r) => r.targetRole))];
  try {
    const query = (querySql: LastFireSql) => querySql<LastFireRow[]>`
      SELECT DISTINCT ON (x.routine_id) x.routine_id, x.workflow_uuid, x.output, x.error, x.completed_at_epoch_ms
        FROM (
          SELECT o.workflow_uuid, o.output, o.error, o.completed_at_epoch_ms,
                 (w.inputs::jsonb -> 'json' ->> 0) AS routine_id
            FROM dbos.operation_outputs o
            JOIN dbos.workflow_status w ON w.workflow_uuid = o.workflow_uuid
           WHERE o.completed_at_epoch_ms > ${nowMs - ROUTINE_LAST_FIRE_LOOKBACK_MS}
             AND o.function_name = ANY(${roles}::text[])
             AND w.name = 'routineFire'
        ) x
       WHERE x.routine_id = ANY(${ids}::text[])
       ORDER BY x.routine_id, x.completed_at_epoch_ms DESC`;
    const rows = await (runQuery ? runQuery(query) : query(sql));
    for (const id of ids) out.set(id, null);
    for (const row of rows) out.set(row.routine_id, parseRoutineFireOutput(row));
  } catch (err) {
    const reason = `last-fire lookup failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    for (const id of ids) out.set(id, { unavailable: reason });
  }
  return out;
}
