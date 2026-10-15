import { describe, expect, it, vi } from 'vitest';
import type { getOrgPg } from '@papercusp/db-org';
import type { SubmitBlueprintOperationInput, InternalBlueprintOperationSubmission } from '../../blueprint/operation-service';

// Copy-out mutation probes load the action from a scratch mirror so the tracked
// source is never dirty while git-sync is active. Ordinary runs use the real module.
const { runBlueprintOperationAction } = await import(
  /* @vite-ignore */
  process.env.PAPERCUSP_BLUEPRINT_OPERATION_ACTION_PROBE_PATH ?? './blueprint-operation-action'
) as typeof import('./blueprint-operation-action');

describe('system:blueprint-operation routine action', () => {
  it('uses the routine row and DBOS workflow as the stable caller/request receipt', async () => {
    const handle = {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      receiptId: 71,
      operationId: 'daily-triage',
      specificationRevision: 'b'.repeat(64),
      target: { kind: 'work-item' as const, id: 'WI-71' },
    };
    const submit = vi.fn(async (
      _sql: ReturnType<typeof getOrgPg>['sql'],
      _input: SubmitBlueprintOperationInput,
      _internal?: InternalBlueprintOperationSubmission,
    ) => handle);
    const ctx = {
      workspaceId: 'ws-1',
      installSlug: 'schedule-owner',
      routineId: 'routine-44',
      workflowId: 'routine-fire:44:2026-09-26T09:00:00Z',
      triggerConfig: { cron: '0 9 * * *' },
      payloadTemplate: {
        operationHarnessSlug: 'papercusp',
        operationId: 'daily-triage',
        input: { queue: 'support' },
      },
    };
    const sql = {} as never;
    expect(await runBlueprintOperationAction(ctx, { submit, sql })).toEqual({
      diagnostics: { blueprintOperation: handle },
    });
    expect(await runBlueprintOperationAction(ctx, { submit, sql })).toEqual({
      diagnostics: { blueprintOperation: handle },
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]![2]).toMatchObject({ beforeNewAdmission: expect.any(Function) });
    expect(submit.mock.calls[0]![1]).toEqual({
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      callerId: 'routine:routine-44',
      operationId: 'daily-triage',
      requestKey: 'routine-fire:44:2026-09-26T09:00:00Z',
      input: { queue: 'support' },
    });
    expect(submit.mock.calls[1]![1]).toEqual(submit.mock.calls[0]![1]);
  });

  it('refuses execution without the durable routine workflow identity', async () => {
    await expect(
      runBlueprintOperationAction({
        workspaceId: 'ws-1',
        installSlug: 'schedule-owner',
        routineId: 'routine-44',
        triggerConfig: {},
        payloadTemplate: { operationHarnessSlug: 'papercusp', operationId: 'daily-triage' },
      }),
    ).rejects.toThrow('blueprint_operation_routine_workflow_id_required');
  });
});
