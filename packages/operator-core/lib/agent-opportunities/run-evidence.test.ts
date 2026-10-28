import { beforeEach, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { readMonitoredRunEvidence, type MonitoredRunReadOptions } from './run-evidence';

const sdk = vi.hoisted(() => ({
  initialized: vi.fn(), status: vi.fn(), steps: vi.fn(), launch: vi.fn(),
  client: vi.fn(), remoteStatus: vi.fn(), remoteSteps: vi.fn(),
}));
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: {
  isInitialized: sdk.initialized, getWorkflowStatus: sdk.status,
  listWorkflowSteps: sdk.steps, launch: sdk.launch,
} }));
vi.mock('../dbos/primary-dbos-client', () => ({ getPrimaryDbosClient: sdk.client }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => { throw new Error('unexpected default DB'); } }));

let opts: MonitoredRunReadOptions;
beforeEach(() => {
  vi.resetAllMocks();
  sdk.initialized.mockReturnValue(false);
  sdk.remoteStatus.mockResolvedValue(undefined);
  sdk.remoteSteps.mockResolvedValue(undefined);
  sdk.status.mockResolvedValue(null);
  sdk.steps.mockResolvedValue(undefined);
  sdk.client.mockResolvedValue({ getWorkflow: sdk.remoteStatus, listWorkflowSteps: sdk.remoteSteps });
  // Routing control only: the canonical parent is sufficient to reach the SDK.
  // No workflow outcome or passing shipment receipt is authored by this test.
  const sql = vi.fn(async () => [{ run_id: 'a0000000-0000-0000-0000-000000000001',
    routine_id: 'census', workflow_id: 'scheduled-census', source_sha: 'a'.repeat(40), runtime_id: 'bg:1:2' }]);
  opts = { workspaceId: 'sdk-route', harnessSlug: 'sdk-test', runId: 'a0000000-0000-0000-0000-000000000001',
    scope: { workspaceId: 'sdk-route', sourceBoundary: 'tool-ledger', epoch: 'sdk-route', key: new Uint8Array(32).fill(7) },
    client: sql as unknown as Sql, authorize: async () => true };
});

it('uses the primary SDK read client without starting an executor in a request process', async () => {
  expect(await readMonitoredRunEvidence(opts)).toEqual({ status: 'UNKNOWN',
    reasons: ['workflow-evidence-missing-or-truncated'] });
  expect(sdk.remoteStatus).toHaveBeenCalledExactlyOnceWith('scheduled-census');
  expect(sdk.remoteSteps).toHaveBeenCalledExactlyOnceWith('scheduled-census', { limit: 129 });
  expect(sdk.status).not.toHaveBeenCalled();
  expect(sdk.steps).not.toHaveBeenCalled();
  expect(sdk.launch).not.toHaveBeenCalled();
});
it('retains the executor SDK route when DBOS is already initialized', async () => {
  sdk.initialized.mockReturnValue(true);
  expect(await readMonitoredRunEvidence(opts)).toMatchObject({ status: 'UNKNOWN' });
  expect(sdk.status).toHaveBeenCalledExactlyOnceWith('scheduled-census');
  expect(sdk.steps).toHaveBeenCalledExactlyOnceWith('scheduled-census', { limit: 129 });
  expect(sdk.client).not.toHaveBeenCalled();
  expect(sdk.launch).not.toHaveBeenCalled();
});
it('keeps client errors UNKNOWN and never repairs them by launching an executor', async () => {
  sdk.client.mockRejectedValue(new Error('unavailable'));
  expect(await readMonitoredRunEvidence(opts)).toEqual({ status: 'UNKNOWN', reasons: ['canonical-evidence-unavailable'] });
  expect(sdk.launch).not.toHaveBeenCalled();
});
it('does not open the workflow client when current scope authorization fails', async () => {
  expect(await readMonitoredRunEvidence({ ...opts, authorize: async () => false })).toEqual({
    status: 'UNKNOWN', reasons: ['scope-denied'] });
  expect(sdk.client).not.toHaveBeenCalled();
  expect(sdk.status).not.toHaveBeenCalled();
});
