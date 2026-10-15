import { expect, it } from 'vitest';
import { waitForPrivateHealthSnapshot } from '../../../test/portal-roster-browser-fixture';

function clock() {
  let time = 0;
  return { now: () => time, pause: async (ms: number) => { time += ms; }, timeoutMs: 2_000 };
}

it('waits for the selected workspace collector generation after an older successful response', async () => {
  const bodies = [
    { rows: [{ workspaceId: 'byoc-a', generation: 1 }] },
    { rows: [{ workspaceId: 'byoc-b', generation: 2 }] },
    { rows: [{ workspaceId: 'byoc-a', generation: 2 }] },
  ];
  let reads = 0;
  const body = await waitForPrivateHealthSnapshot(async () => bodies[reads++], 'byoc-a', row => row.generation === 2, clock());
  expect(body).toEqual(bodies[2]);
  expect(reads).toBe(3);
});

it.each(['byoc-a', 'byoc-b'])('fails at the deadline when %s never supplies the expected selected reading', async workspaceId => {
  let reads = 0;
  await expect(waitForPrivateHealthSnapshot(async () => {
    reads++;
    return { rows: [{ workspaceId, generation: workspaceId === 'byoc-a' ? 1 : 2 }] };
  }, 'byoc-a', row => row.generation === 2, clock())).rejects.toThrow('did not converge');
  expect(reads).toBe(3);
});

it('propagates query failures instead of disguising them as stale generations', async () => {
  await expect(waitForPrivateHealthSnapshot(async () => { throw new Error('private query denied'); },
    'byoc-a', () => true, clock())).rejects.toThrow('private query denied');
});
