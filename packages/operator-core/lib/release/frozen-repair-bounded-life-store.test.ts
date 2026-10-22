import { expect, it, vi } from 'vitest';
import type { FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';
import type { FrozenRepairBoundedLifeRecord } from './frozen-repair-bounded-life';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => { throw new Error('automatic retirement must not acquire a database'); },
}));

it('refuses a legacy automatic-retire request before acquiring or mutating state', async () => {
  const { retireFrozenRepairQueueForBoundedLife } = await import('./frozen-repair-bounded-life-store');
  await expect(retireFrozenRepairQueueForBoundedLife(
    { workspaceId: 'ws', installSlug: 'papercusp' },
    {} as FrozenCandidateRepairQueue, {} as FrozenRepairBoundedLifeRecord,
  )).resolves.toEqual({ retired: false, refusal: 'automatic-retirement-disabled' });
});
