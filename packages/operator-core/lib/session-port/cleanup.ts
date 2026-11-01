import { markAdvSessionEnded, updateAdvSessionPortStatus } from '../adv-sessions';
import { deleteSessionPortArtifact, pruneStaleSessionPortArtifacts } from './artifact';
import {
  sessionPortsNeedingCleanup,
  transitionSessionPort,
  type SessionPortRow,
} from './store';
import { recordSessionPortTelemetry } from './telemetry';

export interface SessionPortCleanupResult {
  expiredRows: number;
  targetsFailed: number;
  artifactsDeleted: number;
  orphanArtifactsDeleted: number;
  errors: number;
}

/** Reused by the existing telemetry-retention action. This is deliberately not
 * its own timer/routine: immediate delivery deletion is primary, and this
 * idempotent pass repairs only crash/TTL residue. */
export async function cleanupExpiredSessionPorts(input: {
  workspaceId: string;
  rows?: SessionPortRow[];
  list?: typeof sessionPortsNeedingCleanup;
  deleteArtifact?: typeof deleteSessionPortArtifact;
  pruneArtifacts?: typeof pruneStaleSessionPortArtifacts;
  updateTarget?: typeof updateAdvSessionPortStatus;
  endTarget?: typeof markAdvSessionEnded;
  transition?: typeof transitionSessionPort;
  recordTelemetry?: typeof recordSessionPortTelemetry;
}): Promise<SessionPortCleanupResult> {
  const list = input.list ?? sessionPortsNeedingCleanup;
  const rows = input.rows ?? await list(input.workspaceId);
  const deleteArtifact = input.deleteArtifact ?? deleteSessionPortArtifact;
  const updateTarget = input.updateTarget ?? updateAdvSessionPortStatus;
  const endTarget = input.endTarget ?? markAdvSessionEnded;
  const transition = input.transition ?? transitionSessionPort;
  const recordTelemetry = input.recordTelemetry ?? recordSessionPortTelemetry;
  const out: SessionPortCleanupResult = {
    expiredRows: rows.length,
    targetsFailed: 0,
    artifactsDeleted: 0,
    orphanArtifactsDeleted: 0,
    errors: 0,
  };

  for (const row of rows) {
    const bootstrapReceiptCommitted = row.metadata.bootstrapReceiptCommitted === true;
    const failureClass = bootstrapReceiptCommitted ? 'delivery-ack-unknown' : 'preparation-expired';
    const failureMessage = bootstrapReceiptCommitted
      ? 'delivery acknowledgement unknown after committed bootstrap receipt'
      : row.error ?? 'preparation expired before native persistence';
    let artifactComplete = false;
    let cleanupOutcome: 'deleted' | 'already-absent' | 'failed' = 'failed';
    try {
      const deleted = await deleteArtifact(row.artifactPath);
      if (deleted) out.artifactsDeleted += 1;
      cleanupOutcome = deleted ? 'deleted' : 'already-absent';
      artifactComplete = true; // false means already absent, also complete
    } catch {
      out.errors += 1;
    }

    let targetComplete = row.targetAdvSessionId == null;
    if (row.targetAdvSessionId != null) {
      try {
        targetComplete = await updateTarget(
          row.targetAdvSessionId,
          input.workspaceId,
          bootstrapReceiptCommitted ? 'pending' : 'failed',
          { deliveryErrorClass: failureClass },
        );
        if (!bootstrapReceiptCommitted) {
          // 'cleanup', not 'self': this janitor did not observe a process exit.
          // exitCode stays NULL because no exit status was observed.
          await endTarget(row.targetAdvSessionId, null, 'cleanup');
          if (targetComplete) out.targetsFailed += 1;
        }
        if (!targetComplete) out.errors += 1;
      } catch {
        out.errors += 1;
      }
    }

    try {
      await transition(row.id, input.workspaceId, 'expired', {
        error: failureMessage,
        metadata: {
          cleanupComplete: artifactComplete && targetComplete,
          cleanupArtifactAbsent: artifactComplete,
          cleanupTargetEnded: !bootstrapReceiptCommitted && row.targetAdvSessionId != null && targetComplete,
          cleanupTargetDisposition: row.targetAdvSessionId == null
            ? 'no-target'
            : bootstrapReceiptCommitted ? 'delivery-ack-unknown' : 'preparation-expired',
          deliveryErrorClass: failureClass,
        },
      });
    } catch {
      out.errors += 1;
    }

    // Expiration is a failed delivery, not merely a maintenance counter. Keep
    // the lifecycle visible with the same content-free allowlisted telemetry
    // as immediate failures; telemetry itself remains best-effort.
    await recordTelemetry({
      workspaceId: input.workspaceId,
      stage: 'failed',
      portId: row.id,
      sourceAdvSessionId: row.sourceAdvSessionId,
      targetAdvSessionId: row.targetAdvSessionId,
      sourceBackend: row.sourceBackend,
      targetBackend: row.targetBackend,
      targetModel: row.targetModel,
      sourceHash: row.sourceHash,
      renderedHash: row.renderedHash,
      protocolVersion: row.protocolVersion,
      cleanupOutcome,
      failureClass,
    });
  }

  try {
    const pruned = await (input.pruneArtifacts ?? pruneStaleSessionPortArtifacts)();
    out.orphanArtifactsDeleted = pruned.removed;
    out.errors += pruned.errors;
  } catch {
    out.errors += 1;
  }
  return out;
}
