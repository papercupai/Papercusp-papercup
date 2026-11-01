/**
 * Real-Postgres barriers for the session-port attempt fence. Unit mocks cannot
 * prove that the port row lock, target allocation, and replay receipt commit as
 * one transaction across two database sessions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TRANSFORM_VERSION } from './types';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  createPreparedSessionPort,
  findSessionPortByIdempotency,
  getSessionPort,
  readSessionPortBootstrapDisposition,
  recordSessionPortBootstrapReceipt,
  reserveSessionPortTarget,
  sessionPortsNeedingCleanup,
  transitionSessionPort,
} = await import('./store');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { verifyResumeStarted } = await import('../agent-launch-core');
const { getAdvSessionInWorkspace, updateAdvSessionPortStatus } = await import('../adv-sessions');

describe('session-port atomic attempt lifecycle (real PG)', () => {
  let db: OrgTestDb;
  const workspaceId = 'ws-session-port-attempts';
  let sourceAdvSessionId = 0;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    const rows = await db.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, mode, cwd, coord_owner_id, session_id)
      VALUES
        (${workspaceId}, 'claude', 'console', '/workspace', 'su-port-source',
         '11111111-1111-4111-8111-111111111111')
      RETURNING id`;
    sourceAdvSessionId = rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const preparedInput = (
    id: string,
    retryOfPortId: string | null = null,
    idempotencyKey = 'same-logical-request',
    expiresAt = '2099-01-01T00:00:00.000Z',
  ) => ({
    id,
    workspaceId,
    idempotencyKey,
    retryOfPortId,
    protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
    sourceAdvSessionId,
    sourceBackend: 'claude' as const,
    targetBackend: 'codex' as const,
    targetModel: 'gpt-5.5',
    sourceHash: 'a'.repeat(64),
    normalizedHash: 'b'.repeat(64),
    renderedHash: 'c'.repeat(64),
    tokenHash: 'd'.repeat(64),
    artifactPath: `/tmp/${id}.seed.md`,
    metadata: {
      summary: {
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
        versions: { transform: SESSION_PORT_TRANSFORM_VERSION },
      },
    },
    expiresAt,
  });

  const target = {
    planSlug: 'plan-a',
    agent: 'codex' as const,
    mode: 'console',
    cwd: '/workspace',
    label: null,
    coordOwnerId: 'su-port-source',
    nativeSessionId: null,
    launchArgv: ['psu', '--resume', String(sourceAdvSessionId)],
    portMetadata: { protocolVersion: SESSION_PORT_PROTOCOL_VERSION },
  };

  it('verifies a conversion through the real source, target, committed bootstrap and native delivery rows', async () => {
    const portId = randomUUID();
    const nativeId = randomUUID();
    const requestHash = 'e'.repeat(64);
    const input = preparedInput(portId, null, `resume-verifier-${portId}`);
    input.metadata = {
      ...input.metadata,
      sourceCoordOwnerId: 'su-port-source',
      summary: {
        ...input.metadata.summary,
        source: { backend: 'claude', advSessionId: sourceAdvSessionId, workspaceId,
          nativeSessionId: '11111111-1111-4111-8111-111111111111' },
        target: { backend: 'codex' }, hashes: { rendered: input.renderedHash },
      },
    } as typeof input.metadata;
    await createPreparedSessionPort(input);
    const reservation = await reserveSessionPortTarget({ portId, workspaceId, requestHash,
      target: { ...target, nativeSessionId: nativeId } });
    if (reservation.status !== 'reserved') throw new Error(`unexpected reservation ${reservation.status}`);
    const targetId = reservation.targetAdvSessionId;
    const host = { ownerId: 'su-port-source', advSessionId: String(targetId), command: 'codex',
      args: ['resume', nativeId], nativeSessionId: nativeId };
    const options = { expectedSessionId: '11111111-1111-4111-8111-111111111111',
      expectedPort: { sourceAdvSessionId, targetBackend: 'codex' as const },
      readAdvSession: (id: number) => getAdvSessionInWorkspace(id, workspaceId),
      findHost: () => host as never, timeoutMs: 0 };
    await expect(verifyResumeStarted('su-port-source', options)).resolves.toMatchObject({
      started: null, mismatch: false,
    });
    await recordSessionPortBootstrapReceipt({ portId, workspaceId, requestHash, targetAdvSessionId: targetId,
      receipt: { sid: 'su-port-source', sessionId: targetId } });
    await expect(verifyResumeStarted('su-port-source', options)).resolves.toMatchObject({
      started: null, mismatch: false,
    });
    const persistenceProof = { persisted: true, nativeRef: `/native/rollout-${nativeId}.jsonl`,
      renderedHash: input.renderedHash };
    await transitionSessionPort(portId, workspaceId, 'delivered', { metadata: { persistenceProof } });
    await updateAdvSessionPortStatus(targetId, workspaceId, 'delivered', { persistenceProof });
    await expect(verifyResumeStarted('su-port-source', options)).resolves.toMatchObject({
      started: true, mismatch: false, expectedSessionId: nativeId, actualSessionId: nativeId,
    });
    // Requested argv can retain a predecessor after a carry; only the host's
    // observed child UUID can establish or contradict the delivered target.
    host.args = ['resume', randomUUID()];
    await expect(verifyResumeStarted('su-port-source', options)).resolves.toMatchObject({
      started: true, mismatch: false, expectedSessionId: nativeId, actualSessionId: nativeId,
    });
    host.nativeSessionId = randomUUID();
    await expect(verifyResumeStarted('su-port-source', options)).resolves.toMatchObject({
      started: false, mismatch: true, expectedSessionId: nativeId,
    });
  }, 120_000);

  it('serializes two bootstraps to one target, replays the receipt, and links a terminal retry', async () => {
    const firstPortId = randomUUID();
    const first = await createPreparedSessionPort(preparedInput(firstPortId));
    expect(first).toMatchObject({ id: firstPortId, status: 'prepared', targetAdvSessionId: null });
    await expect(
      transitionSessionPort(firstPortId, workspaceId, 'prepared', {
        targetAdvSessionId: 999_999,
      }),
    ).rejects.toThrow(/same-state transition cannot introduce a target binding/);
    expect((await getSessionPort(firstPortId, workspaceId))?.targetAdvSessionId).toBeNull();

    const requestHash = 'e'.repeat(64);
    const raced = await Promise.all([
      reserveSessionPortTarget({ portId: firstPortId, workspaceId, requestHash, target }),
      reserveSessionPortTarget({ portId: firstPortId, workspaceId, requestHash, target }),
    ]);
    const reserved = raced.find((result) => result.status === 'reserved');
    const inProgress = raced.find((result) => result.status === 'in_progress');
    expect(reserved).toBeDefined();
    expect(inProgress).toBeDefined();
    if (!reserved || reserved.status !== 'reserved' || !inProgress || inProgress.status !== 'in_progress') {
      throw new Error(`unexpected reservation race: ${JSON.stringify(raced)}`);
    }
    const targetAdvSessionId = reserved.targetAdvSessionId;
    expect(inProgress.targetAdvSessionId).toBe(targetAdvSessionId);

    const targetRows = await db.adminSql<Array<{ id: number; port_id: string }>>`
      SELECT id, port_id::text AS port_id
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${workspaceId} AND port_id = ${firstPortId}`;
    expect(targetRows).toEqual([{ id: targetAdvSessionId, port_id: firstPortId }]);

    await expect(
      reserveSessionPortTarget({
        portId: firstPortId,
        workspaceId,
        requestHash: 'f'.repeat(64),
        target,
      }),
    ).rejects.toThrow(/immutable prepared request/);
    expect((await getSessionPort(firstPortId, workspaceId))?.targetAdvSessionId).toBe(targetAdvSessionId);

    const receipt = {
      status: 'ok',
      sessionId: targetAdvSessionId,
      agent: 'codex',
      workspaceId,
      cwd: '/workspace',
    };
    await recordSessionPortBootstrapReceipt({
      portId: firstPortId,
      workspaceId,
      requestHash,
      targetAdvSessionId,
      receipt,
    });
    await expect(
      readSessionPortBootstrapDisposition({
        portId: firstPortId,
        workspaceId,
        requestHash,
      }),
    ).resolves.toMatchObject({ status: 'replay', targetAdvSessionId, receipt });
    await expect(
      reserveSessionPortTarget({
        portId: firstPortId,
        workspaceId,
        requestHash,
        target,
      }),
    ).resolves.toMatchObject({ status: 'replay', targetAdvSessionId, receipt });

    await transitionSessionPort(firstPortId, workspaceId, 'failed', { error: 'native spawn failed' });
    const retryPortId = randomUUID();
    const retry = await createPreparedSessionPort(preparedInput(retryPortId, firstPortId));
    expect(retry).toMatchObject({
      id: retryPortId,
      retryOfPortId: firstPortId,
      status: 'prepared',
      targetAdvSessionId: null,
    });
    const attempts = await db.adminSql<
      Array<{
        id: string;
        status: string;
        retry_of_port_id: string | null;
        idempotency_key: string;
        logical_request_key: string;
      }>
    >`
      SELECT id::text, status, retry_of_port_id::text, idempotency_key, logical_request_key
        FROM harness_shared.session_ports
       WHERE workspace_id = ${workspaceId} AND idempotency_key = 'same-logical-request'
          OR (workspace_id = ${workspaceId} AND logical_request_key = 'same-logical-request')
       ORDER BY prepared_at`;
    expect(attempts).toEqual([
      {
        id: firstPortId,
        status: 'failed',
        retry_of_port_id: null,
        idempotency_key: `same-logical-request:terminal:${firstPortId}`,
        logical_request_key: 'same-logical-request',
      },
      {
        id: retryPortId,
        status: 'prepared',
        retry_of_port_id: firstPortId,
        idempotency_key: 'same-logical-request',
        logical_request_key: 'same-logical-request',
      },
    ]);

    const stalePortId = randomUUID();
    await createPreparedSessionPort(
      preparedInput(stalePortId, null, 'expired-logical-request', '2020-01-01T00:00:00.000Z'),
    );
    await expect(findSessionPortByIdempotency(workspaceId, 'expired-logical-request')).resolves.toMatchObject({
      id: stalePortId,
      status: 'expired',
    });
    const replacementPortId = randomUUID();
    await expect(
      createPreparedSessionPort(preparedInput(replacementPortId, stalePortId, 'expired-logical-request')),
    ).resolves.toMatchObject({
      id: replacementPortId,
      retryOfPortId: stalePortId,
      status: 'prepared',
    });

    const hungPortId = randomUUID();
    await createPreparedSessionPort(preparedInput(hungPortId, null, 'hung-logical-request'));
    const hungReservation = await reserveSessionPortTarget({
      portId: hungPortId,
      workspaceId,
      requestHash,
      target,
    });
    expect(hungReservation).toMatchObject({ status: 'reserved' });
    await db.adminSql`
      UPDATE harness_shared.session_ports
         SET expires_at = '2020-01-01T00:00:00.000Z'
       WHERE id = ${hungPortId}`;
    await expect(
      readSessionPortBootstrapDisposition({
        portId: hungPortId,
        workspaceId,
        requestHash,
      }),
    ).resolves.toMatchObject({ status: 'terminal', port: { status: 'expired' } });
    const hungRetryPortId = randomUUID();
    await expect(
      createPreparedSessionPort(preparedInput(hungRetryPortId, hungPortId, 'hung-logical-request')),
    ).resolves.toMatchObject({
      id: hungRetryPortId,
      retryOfPortId: hungPortId,
      status: 'prepared',
    });
  }, 120_000);

  it('keeps committed bootstrap receipt expirations classified as acknowledgement unknown', async () => {
    const makeCommittedExpiredPort = async (idempotencyKey: string) => {
      const portId = randomUUID();
      const requestHash = 'f'.repeat(64);
      await createPreparedSessionPort(preparedInput(portId, null, idempotencyKey));
      const reservation = await reserveSessionPortTarget({
        portId,
        workspaceId,
        requestHash,
        target,
      });
      if (reservation.status !== 'reserved') throw new Error('unexpected reservation ' + reservation.status);
      await recordSessionPortBootstrapReceipt({
        portId,
        workspaceId,
        requestHash,
        targetAdvSessionId: reservation.targetAdvSessionId,
        receipt: { targetAdvSessionId: reservation.targetAdvSessionId },
      });
      await db.adminSql`
        UPDATE harness_shared.session_ports
           SET expires_at = '2020-01-01T00:00:00.000Z'
         WHERE id = ${portId}`;
      return portId;
    };

    const cleanupPortId = await makeCommittedExpiredPort('cleanup-receipt-' + randomUUID());
    const cleanupRows = await sessionPortsNeedingCleanup(workspaceId);
    expect(cleanupRows.find((candidate) => candidate.id === cleanupPortId)).toMatchObject({
      status: 'expired',
      error: 'delivery acknowledgement unknown after committed bootstrap receipt',
      metadata: { bootstrapReceiptCommitted: true },
    });

    const lookupIdempotencyKey = 'lookup-receipt-' + randomUUID();
    const lookupPortId = await makeCommittedExpiredPort(lookupIdempotencyKey);
    const lookup = await findSessionPortByIdempotency(
      workspaceId,
      lookupIdempotencyKey,
    );
    expect(lookup).toMatchObject({
      id: lookupPortId,
      status: 'expired',
      error: 'delivery acknowledgement unknown after committed bootstrap receipt',
      metadata: { bootstrapReceiptCommitted: true },
    });
  }, 120_000);
});
