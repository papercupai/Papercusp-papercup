/** Target custody reuses the existing ended-session reservation. The lease is
 * admission only: the managed launcher must also run its native writer guard
 * immediately before spawning, and finalize that same keyed reservation. */
import { getOrgPg } from '@papercusp/db-org';
import { releaseAdvSessionResume } from './adv-sessions';
import { readAssumeTarget } from './session-assume-preparation';
import {
  assumePreparationFingerprint, assumePreparationSchema, assumeTransitionKey, reserveAssumeTarget,
  type AssumePreparation, type AssumeTransitionDeps,
} from './session-assume';

export function createAssumeCustodyAdapters(
  preparation: AssumePreparation,
  deps: { readTarget?: typeof readAssumeTarget; authorizedStartup?: boolean } = {},
): Pick<AssumeTransitionDeps, 'reserve' | 'checkCustody' | 'releaseTarget'> {
  // Own an immutable copy; neither a caller nor a host callback may change
  // which incarnation this adapter is permitted to reserve or release.
  const plan = assumePreparationSchema.parse(preparation);
  const fingerprint = assumePreparationFingerprint(plan);
  const key = assumeTransitionKey(plan);
  const readTarget = deps.readTarget ?? readAssumeTarget;
  const matchesPlan = (value: AssumePreparation) => assumePreparationFingerprint(value) === fingerprint;
  const unchangedTarget = async () => {
    const current = await readTarget({ requestId: plan.requestId, targetOwnerId: plan.target.ownerId,
      contextMode: plan.target.context.mode }, plan.target.workspaceId,
      deps.authorizedStartup && plan.target.context.mode === 'native-resume' ? plan.target.context : undefined);
    const parsed = assumePreparationSchema.shape.target.safeParse(current);
    return parsed.success && parsed.data.ended && !parsed.data.liveHost && parsed.data.writer === 'free' &&
      JSON.stringify(parsed.data) === JSON.stringify(plan.target);
  };
  const ownsReservation = async () => {
    const { sql } = getOrgPg();
    const rows = await sql`
      SELECT id FROM harness_shared.adv_sessions
       WHERE id = ${plan.target.advSessionId} AND workspace_id = ${plan.target.workspaceId}
         AND coord_owner_id = ${plan.target.ownerId}
         AND session_id IS NOT DISTINCT FROM ${plan.target.binding.sessionId}
         AND (${plan.target.binding.ompThreadId === undefined} OR
           omp_thread_id IS NOT DISTINCT FROM ${plan.target.binding.ompThreadId ?? null})
         AND started_at::text = ${plan.target.binding.startedAt}
         AND ended_at IS NOT NULL AND retired_at IS NULL
         AND resume_claim_key = ${key}
         AND resume_claimed_at + interval '120 seconds' > now()
    `;
    return rows.length === 1;
  };
  return {
    async reserve(value) {
      if (!matchesPlan(value)) throw new Error('assume-custody-preparation-changed');
      return reserveAssumeTarget(plan);
    },
    async checkCustody(value) {
      try {
        return matchesPlan(value) && await ownsReservation() && await unchangedTarget() &&
          // A slow transcript/writer probe cannot extend an expired lease.
          await ownsReservation();
      } catch { return false; }
    },
    async releaseTarget(value) {
      try {
        if (!matchesPlan(value) || !await unchangedTarget()) return false;
        // The canonical writer is keyed and replay-safe. A foreign lease is
        // never cleared, even if it replaced ours after the read above.
        return releaseAdvSessionResume(plan.target.advSessionId, key);
      } catch { return false; }
    },
  };
}
