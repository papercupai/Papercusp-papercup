import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn(), route: vi.fn(), lock: vi.fn(), launch: vi.fn() }));
vi.mock('@dbos-inc/dbos-sdk', () => ({
  DBOS: { sleep: vi.fn(async () => {}), runStep: (fn: () => unknown) => fn(),
    registerWorkflow: (fn: unknown) => fn },
  WorkflowQueue: class { constructor(public name: string) {} },
}));
vi.mock('./idempotent-register-workflow', () => ({
  idempotentRegisterWorkflow: (_name: string, create: () => unknown) => create(),
  idempotentWorkflowQueue: (_name: string, create: () => unknown) => create(),
}));
vi.mock('../release-checkpoint-launch', () => ({
  isCheckpointRunLockHeldCheap: mocks.lock, launchDetachedCheckpoint: mocks.launch,
}));
vi.mock('../release-deploy-launch', () => ({ integrationRoot: () => '/tooling' }));
vi.mock('../harness/routines/release-actions', () => ({ readFrozenCandidateRepairQueueState: mocks.read }));
vi.mock('../harness/routines/hive-release-env', () => ({ resolveCheckpointRouting: mocks.route }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'home-workspace' }));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));

import { repairAutoVerifyWorkflow } from './repair-auto-verify-workflow';
import { createFrozenCandidateRepairQueue } from '../release/frozen-candidate-repair-queue';

const target = { workspaceId: 'ws-drill', installSlug: 'slack-asana-bug-drill' };
const head = 'a'.repeat(40);
const input = { candidate: 'c'.repeat(40), repairHead: head, admittedAtMs: 1, quietMs: 0, target };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.route.mockResolvedValue({ root: '/tooling',
    extraEnv: { PAPERCUSP_INTEGRATION_ROOT: '/drill' }, clearEnv: ['DATABASE_URL'] });
  mocks.read.mockResolvedValue({ status: 'value', queue: {
    ...createFrozenCandidateRepairQueue({ candidate: input.candidate, failingTests: ['red.test.ts'], nowMs: 1, base: null }),
    phase: 'ready-to-verify', repairHead: head,
  } });
  mocks.lock.mockReturnValue({ held: false });
  mocks.launch.mockResolvedValue({ launched: true, unit: 'drill-checkpoint' });
});

it('reads, checks the run lock and launches only the selected harness after the durable delay', async () => {
  await expect(repairAutoVerifyWorkflow(input)).resolves.toMatchObject({ status: 'launched' });
  expect(mocks.read).toHaveBeenCalledWith(target);
  expect(mocks.lock).toHaveBeenCalledWith('/drill');
  expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ root: '/tooling', integrationRoot: '/drill', target,
    extraEnv: { PAPERCUSP_INTEGRATION_ROOT: '/drill' }, clearEnv: ['DATABASE_URL'] }));
});

it('refuses a disabled selected harness without falling back to the home queue or launcher', async () => {
  mocks.route.mockResolvedValue({ root: '/tooling', extraEnv: {}, clearEnv: [], skip: { reason: 'not-gated' } });
  await expect(repairAutoVerifyWorkflow(input)).resolves.toMatchObject({ status: 'not-launched' });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.launch).not.toHaveBeenCalled();
});
