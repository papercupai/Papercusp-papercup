import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./coordination-domain', () => ({
  candidateResourceLockDomains: vi.fn(() => []),
}));
vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(() => ({})),
  listLiveResourceDomains: vi.fn(async () => []),
  readResourceQueue: vi.fn(async () => ({ holders: [] })),
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(),
  assertResourceFenceCurrent: vi.fn(),
}));
vi.mock('./in-workspace-txn', () => ({ inWorkspaceTxn: vi.fn() }));
vi.mock('./resource-acquire-wait', () => ({ acquireResourceExclusiveWithWait: vi.fn() }));
vi.mock('./resource-broadcast', () => ({
  broadcastResourceDrainStart: vi.fn(),
  broadcastResourceBackUp: vi.fn(),
}));
vi.mock('./identity', () => ({ readIdentity: vi.fn() }));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));

import { inWorkspaceTxn } from './in-workspace-txn';
import { tryAcquireResource } from './su-lock-store';
import { acquireResourceExclusiveWithWait } from './resource-acquire-wait';
import { guardResource } from './resource-lock-guard';

const foreignCoordinationDomain = join(tmpdir(), 'papercusp-release');
const txnM = vi.mocked(inWorkspaceTxn);
const sharedAcquireM = vi.mocked(tryAcquireResource);
const exclusiveAcquireM = vi.mocked(acquireResourceExclusiveWithWait);

const exclusionDetail = {
  resource: 'dev-server',
  requested_domain: 'papercusp-host-global',
  coordination_domain: foreignCoordinationDomain,
  owner: 'su-peer',
  mode: 'exclusive',
  status: 'held',
};
const exclusionError = () =>
  Object.assign(new Error('Host-global resource has a conflicting lease in another coordination domain'), {
    code: '23P01',
    constraint_name: 'resource_host_global_exclusion',
    detail: JSON.stringify(exclusionDetail),
  });

beforeEach(() => {
  vi.clearAllMocks();
  txnM.mockReset();
  txnM.mockImplementation(async (_domain: string, _owner: string, fn: (tx: Sql) => Promise<unknown>) =>
    fn({} as Sql),
  );
  sharedAcquireM.mockReset();
  exclusiveAcquireM.mockReset();
});

describe('guardResource host-global exclusion handling', () => {
  it.each(['shared', 'exclusive'] as const)(
    'returns a structured refusal when the atomic host-global fence rejects a %s acquire',
    async (mode) => {
      const error = exclusionError();
      if (mode === 'shared') sharedAcquireM.mockRejectedValueOnce(error);
      else exclusiveAcquireM.mockRejectedValueOnce(error);

      const run = vi.fn(async () => 'must not run');
      const result = await guardResource(
        {
          coordinationDomain: 'papercusp-host-global',
          ownerId: 'su-caller',
          ownerLabel: 'caller',
          coordIdentity: { ownerId: 'su-caller' } as never,
          resource: 'dev-server',
          mode,
        },
        run,
      );

      expect(result).toEqual({
        acquired: false,
        reason: 'held_in_other_domain',
        holders: [
          {
            owner: 'su-peer',
            owner_label: null,
            mode: 'exclusive',
            status: 'held',
            coordination_domain: foreignCoordinationDomain,
          },
        ],
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('does not convert unrelated constraint failures into a lock refusal', async () => {
    const error = Object.assign(new Error('other exclusion violation'), {
      code: '23P01',
      constraint_name: 'some_other_constraint',
      detail: JSON.stringify(exclusionDetail),
    });
    sharedAcquireM.mockRejectedValueOnce(error);

    await expect(
      guardResource(
        {
          coordinationDomain: 'papercusp-host-global',
          ownerId: 'su-caller',
          ownerLabel: 'caller',
          coordIdentity: { ownerId: 'su-caller' } as never,
          resource: 'dev-server',
          mode: 'shared',
        },
        async () => 'must not run',
      ),
    ).rejects.toBe(error);
  });
});
