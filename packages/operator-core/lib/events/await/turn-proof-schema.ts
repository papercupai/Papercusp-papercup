/**
 * turn-proof-schema.ts — does the live database carry migration 1441's turn-proof columns yet?
 *
 * P-006 (WI-10008157, D-004) books turn-start proof in four columns that migration 1441 adds to
 * `harness_shared.event_wake_deliveries`. Code and migration ship on DIFFERENT clocks: a host
 * re-bundles the working tree on every restart, while a migration can stay withheld behind the
 * migration/backup rendezvous for an hour or more (WI-10008177). Measured 2026-10-10: bg-host
 * restarted at 20:19Z onto this code with 1441 withheld, and from then on every wake-pump kick,
 * sweep and pickup sweep failed with `column "turn_proof" of relation "event_wake_deliveries"
 * does not exist` — no wake was booked `delivered` fleet-wide.
 *
 * So every store write/read of those columns asks this probe first and, while it answers false,
 * runs the pre-1441 SQL instead (which is correct on BOTH schemas). Turn proof is simply not
 * recorded until the columns exist; rows booked meanwhile keep `turn_proof = NULL`, which the
 * migration already defines as "unknown, never read as either outcome".
 *
 * A PRESENT answer is cached for the life of the process (the columns are additive and never
 * dropped). An ABSENT answer is re-probed at most every {@link TURN_PROOF_SCHEMA_RECHECK_MS}, so a
 * running host starts recording proof within that window of the migration landing, without a
 * restart. A probe that throws reads as ABSENT, the safe direction.
 */
import { getOrgPg } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';

/** The columns migration 1441 adds; all four must exist before any of them is written. */
export const TURN_PROOF_COLUMNS = [
  'turn_proof',
  'turn_started_at',
  'pickup_deadline_at',
  'pickup_escalated_at',
] as const;

/** How long an ABSENT answer is trusted before the catalog is asked again. */
export const TURN_PROOF_SCHEMA_RECHECK_MS = 30_000;

const state = pinModuleState('@papercusp/operator-core.events.await.turn-proof-schema', () => ({
  ready: false,
  checkedAtMs: 0,
  inflight: null as Promise<boolean> | null,
  override: null as boolean | null,
}));

/**
 * True once all of {@link TURN_PROOF_COLUMNS} exist on `harness_shared.event_wake_deliveries`.
 * Cheap on the hot path: a cached boolean after the first probe; concurrent callers share one
 * in-flight probe.
 */
export async function turnProofColumnsReady(): Promise<boolean> {
  if (state.override !== null) return state.override;
  if (state.ready) return true;
  if (state.inflight) return state.inflight;
  if (state.checkedAtMs > 0 && Date.now() - state.checkedAtMs < TURN_PROOF_SCHEMA_RECHECK_MS) return false;
  state.inflight = probe().finally(() => {
    state.inflight = null;
  });
  return state.inflight;
}

async function probe(): Promise<boolean> {
  state.checkedAtMs = Date.now();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ n: number | string }>>`
      SELECT count(*)::int AS n
        FROM pg_catalog.pg_attribute
       WHERE attrelid = to_regclass('harness_shared.event_wake_deliveries')
         AND attname = ANY(${[...TURN_PROOF_COLUMNS] as string[]})
         AND NOT attisdropped
    `;
    state.ready = Array.isArray(rows) && Number(rows[0]?.n) === TURN_PROOF_COLUMNS.length;
  } catch {
    state.ready = false;
  }
  return state.ready;
}

/** Test seam: force the answer (`null` restores real probing) and clear the cached probe. */
export function setTurnProofColumnsReadyForTests(value: boolean | null): void {
  state.override = value;
  state.ready = false;
  state.checkedAtMs = 0;
  state.inflight = null;
}
