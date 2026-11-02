/** Read the caller's recorded checkpoint authority without probing the operator-home pipeline. */
import { getOrgPg } from '@papercusp/db-org';
import type { GateVerdictTarget } from './gate-verdict-target';
import {
  CHECKPOINT_QUALIFICATION_METADATA_KEY,
  parseCheckpointQualificationTransaction,
  projectCheckpointQualificationState,
} from './checkpoint-qualification-transaction';
import { parseFrozenCandidateRepairQueueRead } from './frozen-candidate-repair-queue';

export interface CheckpointCallerScope {
  workspaceId?: string | null;
  harnessSlug?: string | null;
}

/** No home fallback: an unscoped caller has no checkpoint subject. */
export function callerCheckpointTarget(ctx: CheckpointCallerScope): GateVerdictTarget | null {
  const workspaceId = ctx.workspaceId?.trim();
  const installSlug = ctx.harnessSlug?.trim();
  const concrete = (value: string | undefined): value is string =>
    !!value && value !== '*' && value.toLowerCase() !== 'all';
  return concrete(workspaceId) && concrete(installSlug) ? { workspaceId, installSlug } : null;
}

type MetadataQuery = (statement: string, parameters: string[]) => Promise<{ metadata: unknown }[]>;

export async function readCheckpointMetadata(
  target: GateVerdictTarget,
  query: MetadataQuery = async (statement, parameters) => getOrgPg().sql.unsafe(statement, parameters),
): Promise<unknown> {
  const rows = await query(
    "SELECT COALESCE(metadata, '{}'::jsonb) AS metadata FROM harness_shared.routines " +
      "WHERE workspace_id = $1 AND install_slug = $2 AND target_role = 'system:green-checkpoint' LIMIT 1",
    [target.workspaceId, target.installSlug],
  );
  return rows[0]?.metadata;
}

/** Stored runner identity is diagnostic evidence; it is never proof of process liveness. */
export async function readHarnessCheckpointState(
  ctx: CheckpointCallerScope,
  read = readCheckpointMetadata,
  nowMs = Date.now(),
) {
  const target = callerCheckpointTarget(ctx);
  const empty = {
    target,
    observedAtMs: nowMs,
    qualification: projectCheckpointQualificationState(null, nowMs),
    runId: null as string | null,
    repairHead: null as string | null,
    pendingRepairHead: null as string | null,
    recordedRunner: null as { id: string; pid: number | null; pidIdentity: string | null; unit: string | null } | null,
    repairQueue: parseFrozenCandidateRepairQueueRead(null) as
      | Exclude<ReturnType<typeof parseFrozenCandidateRepairQueueRead>, { status: 'value' }>
      | { status: 'value'; candidate: string; repairHead: string; phase: string; updatedAtMs: number },
    unknown: [] as string[],
    note: 'Recorded checkpoint state only. Verify the exact runner before launch, replacement, or recovery; a stored identity does not establish liveness.',
  };
  if (!target) return { ...empty, assessment: 'unscoped', unknown: ['caller-checkpoint-target-unresolved'] };
  let raw: unknown;
  try {
    raw = await read(target);
  } catch {
    return { ...empty, assessment: 'unavailable', unknown: ['checkpoint-record-read-failed'] };
  }
  if (raw === undefined) return { ...empty, assessment: 'no-checkpoint' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ...empty, assessment: 'unavailable', unknown: ['checkpoint-metadata-malformed'] };
  const metadata = raw as Record<string, unknown>;
  const transaction = parseCheckpointQualificationTransaction(metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY]);
  const qualification = projectCheckpointQualificationState(metadata[CHECKPOINT_QUALIFICATION_METADATA_KEY], nowMs);
  const queue = parseFrozenCandidateRepairQueueRead(metadata.repair_queue);
  const repairQueue = queue.status === 'value'
    ? { status: 'value' as const, candidate: queue.queue.candidate, repairHead: queue.queue.repairHead,
        phase: queue.queue.phase, updatedAtMs: queue.queue.updatedAtMs }
    : queue;
  const unknown = [
    ...(qualification.status === 'unreadable' ? ['checkpoint-qualification-unreadable'] : []),
    ...(queue.status === 'unreadable' ? ['checkpoint-repair-queue-unreadable'] : []),
  ];
  const runner = transaction?.currentPhysicalRunner;
  return {
    ...empty,
    assessment: unknown.length ? 'unavailable' : 'recorded',
    qualification,
    runId: transaction?.runId ?? null,
    repairHead: transaction?.repairHead ?? null,
    pendingRepairHead: transaction?.pendingRepairHead ?? null,
    recordedRunner: runner ? { id: runner.id, pid: runner.pid ?? null,
      pidIdentity: runner.pidIdentity ?? null, unit: runner.unit ?? null } : null,
    repairQueue,
    unknown,
  };
}
