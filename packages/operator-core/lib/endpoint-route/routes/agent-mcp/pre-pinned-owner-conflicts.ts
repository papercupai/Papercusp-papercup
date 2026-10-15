import type { LivenessVerdict } from '../../../agent-tools/coordination/liveness-oracle';
import {
  classifyPrePinnedOwnerRows,
  describePrePinnedConflicts,
  mapPrePinnedOwnerSessionState,
  type PrePinnedOwnerClassification,
  type PrePinnedOwnerRow,
} from './pre-pinned-owner-rows';

/**
 * ONE read of whether a coord owner id may be bound to a new session — shared by
 * bootstrap-su (which enforces it at launch) and the session-port inspect route
 * (which must refuse a cross-backend resume BEFORE preparation when the launch
 * would be refused anyway; consult-backed-parking-2026-10-12#P-010, D-009).
 *
 * Measured 2026-10-11/07: 8 `psu --resume` claude→codex ports failed AFTER
 * preparation with bootstrap-su's 409 "owner_id … is already bound to live adv
 * session N" because the source session was still running (adv 39975 ran
 * 19:42→21:08Z; the port failed at 19:56Z). A cross-backend port continues the
 * source coordination identity, so a live source is a guaranteed refusal. Two
 * separate predicates would drift; both callers read this one.
 *
 * Steps, in the order bootstrap-su has always applied them:
 *  1. repair half-terminal ghosts (ended_by set, ended_at NULL) — narrow and
 *     idempotent, EI-21417550055038906;
 *  2. load every un-ended row bound to the owner;
 *  3. take the shared liveness oracle's owner verdict (fail-soft: a failed read
 *     stays blocking, EI-21442511412659661);
 *  4. classify by value (precursor / reclaimable / conflict).
 *
 * It never ENDS a reclaimable row: that write belongs to the launch that adopts
 * the identity (bootstrap-su), not to a read-only preview.
 */
export type PrePinnedOwnerBindings = PrePinnedOwnerClassification<PrePinnedOwnerRow> & {
  /** The oracle's raw owner verdict; undefined when the read failed or had none. */
  sessionState: LivenessVerdict['sessionState'] | undefined;
};

export interface PrePinnedOwnerBindingDeps {
  repairStaleTerminalMarkers?: (ownerId: string) => Promise<unknown>;
  loadUnendedRows?: (ownerId: string) => Promise<Array<Omit<PrePinnedOwnerRow, 'liveness'>>>;
  resolveOwnerSessionState?: (ownerId: string) => Promise<LivenessVerdict['sessionState'] | undefined>;
}

async function defaultRepair(ownerId: string): Promise<unknown> {
  const { repairStaleAdvSessionTerminalMarkers } = await import('../../../adv-sessions');
  return repairStaleAdvSessionTerminalMarkers(ownerId);
}

async function defaultLoadUnendedRows(ownerId: string): Promise<Array<Omit<PrePinnedOwnerRow, 'liveness'>>> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  return sql<Array<{ id: string; display: string | null; has_session: boolean; launched: boolean }>>`
    SELECT id::text, display, (session_id IS NOT NULL) AS has_session,
           (launched_at IS NOT NULL) AS launched
      FROM harness_shared.adv_sessions
     WHERE coord_owner_id = ${ownerId} AND ended_at IS NULL
     ORDER BY id DESC
  `;
}

async function defaultResolveOwnerSessionState(
  ownerId: string,
): Promise<LivenessVerdict['sessionState'] | undefined> {
  const { resolveSessionStates } = await import('../../../agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates([{ ownerId }], { hydratePerId: true });
  return verdicts.get(ownerId)?.sessionState;
}

export async function readPrePinnedOwnerBindings(
  ownerId: string,
  deps: PrePinnedOwnerBindingDeps = {},
): Promise<PrePinnedOwnerBindings> {
  await (deps.repairStaleTerminalMarkers ?? defaultRepair)(ownerId);
  const rows = await (deps.loadUnendedRows ?? defaultLoadUnendedRows)(ownerId);
  // Fail-soft: an oracle failure is indistinguishable from an unknown verdict and
  // must keep the binding blocking — never authorise a reclaim.
  const sessionState = await (deps.resolveOwnerSessionState ?? defaultResolveOwnerSessionState)(ownerId)
    .catch(() => undefined);
  const liveness = mapPrePinnedOwnerSessionState(sessionState);
  return {
    ...classifyPrePinnedOwnerRows(rows.map((row) => ({ ...row, liveness }))),
    sessionState,
  };
}

/**
 * The owner-facing refusal for a cross-backend resume whose source session is
 * still running. Names the session, its verdict and the way out, instead of the
 * launch-internal "pre-pinned owners must be fresh" wording psu used to surface
 * only after a port had been prepared.
 */
export function describeLiveSourceRefusal(input: {
  sourceAdvSessionId: number;
  ownerId: string;
  targetBackend: string;
  bindings: Pick<PrePinnedOwnerBindings, 'conflicts' | 'sessionState'>;
}): string {
  const verdict = input.bindings.sessionState ?? 'unknown';
  return `source session ${input.sourceAdvSessionId} (${input.ownerId}) is still running ` +
    `(sessionState=${verdict}); resuming it in ${input.targetBackend} continues that same ` +
    `coordination identity, which cannot be bound to two live sessions. Exit the source session ` +
    `first, then rerun psu --resume. Nothing was prepared or launched. ` +
    `[live rows: ${describePrePinnedConflicts(input.bindings.conflicts)}]`;
}
