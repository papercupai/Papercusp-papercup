import { describe, expect, it, vi } from 'vitest';
import { beginQualificationTransaction, reserveQualificationRunner } from './checkpoint-qualification-transaction';
import { callerCheckpointTarget, readCheckpointMetadata, readHarnessCheckpointState } from './harness-checkpoint-state';

const ctx = { workspaceId: 'workspace-a', harnessSlug: 'isolated-drill' };

describe('caller-harness checkpoint state', () => {
  it.each([
    {}, { workspaceId: 'workspace-a' }, { harnessSlug: 'isolated-drill' },
    { ...ctx, harnessSlug: '*' }, { ...ctx, harnessSlug: 'all' },
    { ...ctx, workspaceId: '*' }, { ...ctx, workspaceId: ' ' },
  ])('does not fall back to the home pipeline for %j', async scope => {
    const read = vi.fn();
    expect(callerCheckpointTarget(scope)).toBeNull();
    expect(await readHarnessCheckpointState(scope, read)).toMatchObject({
      assessment: 'unscoped', target: null, unknown: ['caller-checkpoint-target-unresolved'],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('binds workspace and harness in the one authoritative metadata query', async () => {
    const query = vi.fn(async () => [{ metadata: {} }]);
    await readCheckpointMetadata({ workspaceId: 'workspace-a', installSlug: 'isolated-drill' }, query);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('workspace_id = $1 AND install_slug = $2'),
      ['workspace-a', 'isolated-drill']);
    expect(query.mock.calls).toHaveLength(1);
  });

  it('keeps two callers isolated rather than returning an ambient home snapshot', async () => {
    const read = vi.fn(async (target: { workspaceId: string; installSlug: string }) => {
      const transaction = beginQualificationTransaction(null, {
        attemptId: target.installSlug, candidate: target.workspaceId, nowMs: 100,
      }).transaction;
      return { qualificationTransaction: transaction };
    });
    const first = await readHarnessCheckpointState(ctx, read, 200);
    const second = await readHarnessCheckpointState({ workspaceId: 'workspace-b', harnessSlug: 'other-pot' }, read, 200);
    expect(first).toMatchObject({ assessment: 'recorded', target: { workspaceId: 'workspace-a', installSlug: 'isolated-drill' },
      qualification: { attemptId: 'isolated-drill', candidate: 'workspace-a' } });
    expect(second).toMatchObject({ target: { workspaceId: 'workspace-b', installSlug: 'other-pot' },
      qualification: { attemptId: 'other-pot', candidate: 'workspace-b' } });
  });

  it('distinguishes a missing checkpoint, an empty record, and failed reads', async () => {
    expect(await readHarnessCheckpointState(ctx, async () => undefined)).toMatchObject({ assessment: 'no-checkpoint', unknown: [] });
    expect(await readHarnessCheckpointState(ctx, async () => ({}))).toMatchObject({
      assessment: 'recorded', qualification: { status: 'none' }, repairQueue: { status: 'absent' }, unknown: [],
    });
    expect(await readHarnessCheckpointState(ctx, async () => { throw new Error('read failed'); })).toMatchObject({
      assessment: 'unavailable', unknown: ['checkpoint-record-read-failed'],
    });
  });

  it.each([null, [], 'malformed'])('does not turn malformed metadata %j into a measured absence', async raw => {
    expect(await readHarnessCheckpointState(ctx, async () => raw)).toMatchObject({
      assessment: 'unavailable', unknown: ['checkpoint-metadata-malformed'],
    });
  });

  it('preserves unreadable qualification and newer queue schemas as unknown', async () => {
    const result = await readHarnessCheckpointState(ctx, async () => ({
      qualificationTransaction: { schemaVersion: 999 }, repair_queue: { schemaVersion: 999 },
    }));
    expect(result).toMatchObject({ assessment: 'unavailable', qualification: { status: 'unreadable' },
      repairQueue: { status: 'unreadable', reason: 'schema-newer-than-reader' },
      unknown: ['checkpoint-qualification-unreadable', 'checkpoint-repair-queue-unreadable'] });
  });

  it('reports the exact recorded runner without claiming live process evidence', async () => {
    const transaction = beginQualificationTransaction(null, {
      attemptId: 'attempt', candidate: 'candidate', nowMs: 100,
    }).transaction;
    const running = reserveQualificationRunner(transaction, { attemptId: 'attempt', runnerId: 'runner',
      runId: 'run', pid: 42, pidIdentity: 'boot:42', unit: 'isolated.scope', started: true,
      leaseDurationMs: 1000, nowMs: 200 }).transaction;
    const result = await readHarnessCheckpointState(ctx, async () => ({ qualificationTransaction: running }), 300);
    expect(result).toMatchObject({ runId: 'run', recordedRunner: { id: 'runner', pid: 42, pidIdentity: 'boot:42', unit: 'isolated.scope' },
      qualification: { runnerHealth: { liveness: 'unknown' } }, unknown: [] });
  });
});
