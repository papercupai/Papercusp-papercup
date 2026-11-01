import { describe, expect, it, vi } from 'vitest';
import { cleanupExpiredSessionPorts } from './cleanup';
import type { SessionPortRow } from './store';

const row = (over: Partial<SessionPortRow> = {}): SessionPortRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws',
  idempotencyKey: 'idem',
  protocolVersion: 1,
  sourceAdvSessionId: 4,
  targetAdvSessionId: 9,
  sourceBackend: 'claude',
  targetBackend: 'codex',
  targetModel: 'gpt-test',
  status: 'expired',
  sourceHash: 'a'.repeat(64),
  normalizedHash: 'b'.repeat(64),
  renderedHash: 'c'.repeat(64),
  tokenHash: 'd'.repeat(64),
  artifactPath: '/managed/seed',
  metadata: {},
  error: 'expired',
  preparedAt: '2026-07-14T00:00:00.000Z',
  pendingAt: null,
  deliveredAt: null,
  failedAt: '2026-07-14T00:15:00.000Z',
  expiresAt: '2026-07-14T00:15:00.000Z',
  ...over,
});

describe('session-port stale cleanup', () => {
  it('fails a pending target, deletes its artifact, and marks cleanup complete', async () => {
    const updateTarget = vi.fn(async () => true);
    const endTarget = vi.fn(async () => true);
    const recordTelemetry = vi.fn(async () => true);
    const transition = vi.fn(async (id, workspaceId, status, fields) => row({ id, workspaceId, status, metadata: fields.metadata }));
    const result = await cleanupExpiredSessionPorts({
      workspaceId: 'ws',
      rows: [row()],
      deleteArtifact: async () => true,
      pruneArtifacts: async () => ({ scanned: 1, removed: 1, errors: 0 }),
      updateTarget,
      endTarget,
      transition,
      recordTelemetry,
    });
    expect(result).toEqual({ expiredRows: 1, targetsFailed: 1, artifactsDeleted: 1, orphanArtifactsDeleted: 1, errors: 0 });
    expect(updateTarget).toHaveBeenCalledWith(9, 'ws', 'failed', { deliveryErrorClass: 'preparation-expired' });
    // exitCode is NULL, not a fabricated 1: this session was never reaped, so no status was
    // ever observed, and a sentinel would be indistinguishable from an observed failure. The
    // failure itself is carried by the updateTarget('failed') assertion above. See the
    // rationale on cleanup.ts's endTarget call and adv-sessions.ts reconcileDeadTerminalLaunches.
    expect(endTarget).toHaveBeenCalledWith(9, null, 'cleanup');
    expect(transition.mock.calls[0][3].metadata.cleanupComplete).toBe(true);
    expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'failed',
      portId: row().id,
      cleanupOutcome: 'deleted',
      failureClass: 'preparation-expired',
    }));
  });

  it('leaves cleanup incomplete for retry when target projection fails', async () => {
    const transition = vi.fn(async (id, workspaceId, status, fields) => row({ id, workspaceId, status, metadata: fields.metadata }));
    const result = await cleanupExpiredSessionPorts({
      workspaceId: 'ws',
      rows: [row()],
      deleteArtifact: async () => false,
      pruneArtifacts: async () => ({ scanned: 0, removed: 0, errors: 0 }),
      updateTarget: async () => false,
      endTarget: async () => false,
      transition,
      recordTelemetry: async () => true,
    });
    expect(result.errors).toBe(1);
    expect(transition.mock.calls[0][3].metadata.cleanupComplete).toBe(false);
  });

  it('keeps a receipt-committed target pending when native persistence proof is absent', async () => {
    const updateTarget = vi.fn(async () => true);
    const endTarget = vi.fn(async () => true);
    const transition = vi.fn(async (id, workspaceId, status, fields) =>
      row({ id, workspaceId, status, error: fields.error, metadata: fields.metadata }));
    const recordTelemetry = vi.fn(async () => true);

    const result = await cleanupExpiredSessionPorts({
      workspaceId: 'ws',
      rows: [row({
        status: 'pending',
        metadata: {
          bootstrapReceiptCommitted: true,
          bootstrapReceiptTargetAdvSessionId: 9,
        },
      })],
      deleteArtifact: async () => true,
      pruneArtifacts: async () => ({ scanned: 0, removed: 0, errors: 0 }),
      updateTarget,
      endTarget,
      transition,
      recordTelemetry,
    });

    expect(result).toEqual({
      expiredRows: 1,
      targetsFailed: 0,
      artifactsDeleted: 1,
      orphanArtifactsDeleted: 0,
      errors: 0,
    });
    expect(updateTarget).toHaveBeenCalledWith(9, 'ws', 'pending', {
      deliveryErrorClass: 'delivery-ack-unknown',
    });
    expect(endTarget).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledWith(
      row().id,
      'ws',
      'expired',
      expect.objectContaining({
        error: 'delivery acknowledgement unknown after committed bootstrap receipt',
        metadata: expect.objectContaining({
          cleanupComplete: true,
          cleanupTargetEnded: false,
          cleanupTargetDisposition: 'delivery-ack-unknown',
          deliveryErrorClass: 'delivery-ack-unknown',
        }),
      }),
    );
    expect(recordTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'failed',
      failureClass: 'delivery-ack-unknown',
    }));
  });
});
