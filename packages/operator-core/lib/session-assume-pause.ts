/** Reversible caller fence in the existing session-brief lifecycle. No expiry:
 * a crashed handoff must never restart the caller merely because time passed. */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { assumeTransitionKey, type AssumeCallerRecovery, type AssumePreparation } from './session-assume';

const text = z.string().min(1);
export const assumeCallerPauseSchema = z.object({
  version: z.literal(1), transitionKey: text, workspaceId: text,
  nativeSessionId: text, incarnation: text, hostId: text, attachmentId: text,
  checkpointRef: text, checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pausedLoops: z.array(z.object({ id: text, revision: text }).strict()).optional(),
  restoredLoops: z.array(z.object({ id: text, revision: text }).strict()).optional(),
}).strict();
export type AssumeCallerPause = z.infer<typeof assumeCallerPauseSchema>;

export function ownsAssumeCallerPause(pause: AssumeCallerPause | null, plan: AssumePreparation, recovery: AssumeCallerRecovery): boolean {
  if (!pause) return false;
  const { pausedLoops: _pausedLoops, restoredLoops: _restoredLoops, ...identity } = pause;
  return JSON.stringify(identity) === JSON.stringify(assumeCallerPause(plan, recovery));
}

export function assumeCallerPause(plan: AssumePreparation, recovery: AssumeCallerRecovery): AssumeCallerPause {
  return assumeCallerPauseSchema.parse({ version: 1, transitionKey: assumeTransitionKey(plan),
    workspaceId: plan.caller.workspaceId, nativeSessionId: plan.caller.nativeSessionId,
    incarnation: plan.caller.incarnation, hostId: plan.caller.hostId, attachmentId: plan.caller.attachmentId,
    checkpointRef: recovery.checkpointRef, checkpointSha256: recovery.checkpointSha256 });
}

/** Unlike the general brief read, an unavailable/malformed pause is UNKNOWN,
 * never proof of free custody. Host/launcher effect boundaries use this read. */
export async function readAssumeCallerPause(ownerId: string): Promise<AssumeCallerPause | null> {
  const [row] = await getOrgPg().sql<Array<{ control_state: Record<string, unknown> | null }>>`
    SELECT control_state FROM harness_shared.session_briefs WHERE owner_id = ${ownerId}
  `;
  if (row?.control_state != null && (typeof row.control_state !== 'object' || Array.isArray(row.control_state))) {
    throw new Error('assume-caller-control-invalid');
  }
  const lifecycle = row?.control_state?.lifecycle;
  if (lifecycle == null) return null;
  if (typeof lifecycle !== 'object' || Array.isArray(lifecycle)) throw new Error('assume-caller-pause-invalid');
  if (!Object.prototype.hasOwnProperty.call(lifecycle, 'assumeCaller')) return null;
  return assumeCallerPauseSchema.parse((lifecycle as Record<string, unknown>).assumeCaller);
}

/** SQL CAS preserves unrelated controls and lifecycle markers. A second
 * transition cannot replace the first pause, even under the same owner id. */
export async function installAssumeCallerPause(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<void> {
  const marker = assumeCallerPause(plan, recovery);
  const [row] = await getOrgPg().sql<Array<{ control_state: unknown }>>`
    INSERT INTO harness_shared.session_briefs
      (owner_id, workspace_id, control_state, control_generation, control_updated_at)
    VALUES (${plan.caller.ownerId}, ${plan.caller.workspaceId},
      jsonb_build_object('lifecycle', jsonb_build_object('assumeCaller', ${JSON.stringify(marker)}::text::jsonb)), 1, now())
    ON CONFLICT (owner_id) DO UPDATE SET
      control_state = jsonb_set(COALESCE(harness_shared.session_briefs.control_state, '{}'::jsonb), '{lifecycle}',
        COALESCE(harness_shared.session_briefs.control_state->'lifecycle', '{}'::jsonb) || (EXCLUDED.control_state->'lifecycle')),
      control_generation = harness_shared.session_briefs.control_generation + 1, control_updated_at = now()
    WHERE harness_shared.session_briefs.workspace_id = EXCLUDED.workspace_id
      AND (NOT COALESCE(harness_shared.session_briefs.control_state->'lifecycle', '{}'::jsonb) ? 'assumeCaller'
        OR harness_shared.session_briefs.control_state #> '{lifecycle,assumeCaller}' = ${JSON.stringify(marker)}::text::jsonb)
    RETURNING control_state
  `;
  if (!row) throw new Error('assume-caller-pause-conflict');
  const actual = await readAssumeCallerPause(plan.caller.ownerId);
  if (JSON.stringify(actual) !== JSON.stringify(marker)) throw new Error('assume-caller-pause-unacknowledged');
}

export async function clearAssumeCallerPause(plan: AssumePreparation, recovery: AssumeCallerRecovery): Promise<boolean> {
  const marker = await readAssumeCallerPause(plan.caller.ownerId);
  if (!ownsAssumeCallerPause(marker, plan, recovery)) return false;
  const rows = await getOrgPg().sql`
    UPDATE harness_shared.session_briefs
       SET control_state = control_state #- '{lifecycle,assumeCaller}',
           control_generation = control_generation + 1, control_updated_at = now()
     WHERE owner_id = ${plan.caller.ownerId} AND workspace_id = ${plan.caller.workspaceId}
       AND control_state #> '{lifecycle,assumeCaller}' = ${JSON.stringify(marker)}::text::jsonb
    RETURNING owner_id
  `;
  return rows.length === 1;
}
