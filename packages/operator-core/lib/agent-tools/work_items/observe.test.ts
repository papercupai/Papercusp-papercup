/**
 * observe.test.ts — the work_items:observe HANDLER (observeWorkItem mocked). The
 * tuple-space `rd`: read a work-item's claimability without taking it. Pins the
 * found → { ok:true, ...obs } spread and the missing → { ok:false, error } mapping. A
 * regression that reports a missing item as observable is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/observe.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-items', () => ({ observeWorkItem: vi.fn() }));

import { observeWorkItem } from '../../work-items';
const obsM = vi.mocked(observeWorkItem);
const tool = (await import('./observe')).default;

type Out = { data: any };
const call = () => tool.handler({ id: 'WI-1', harness: 'web' } as never, {} as never) as Promise<Out>;
const body = (o: Out) => (o.data);

beforeEach(() => vi.clearAllMocks());

describe('work_items:observe handler (bulk keyed-array)', () => {
  it('spreads the observation as the item\'s result when it exists', async () => {
    obsM.mockResolvedValue({ id: 'WI-1', claimable: true, assignee: null } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', claimable: true });
  });

  it('maps a missing item to that item\'s { ok:false, id, error } without failing the batch', async () => {
    obsM.mockResolvedValue(null as never);
    const b = body(await call());
    expect(b.ok).toBe(false); // DERIVED from counts.failed — the sole item failed
    expect(b.counts).toEqual({ ok: 0, failed: 1 }); // …the batch still RAN, no throw
    expect(b.results[0].ok).toBe(false);
    expect(String(b.results[0].error)).toMatch(/WI-1.*not found/i);
  });

  it('stops the candidate walk after the caller aborts the active observation', async () => {
    const controller = new AbortController();
    obsM.mockImplementationOnce(async (_id, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error('bounded core leg timed out'));
      return null as never;
    });

    const b = body(await tool.handler(
      { ids: ['WI-1', 'WI-2', 'WI-3'], harness: 'web' } as never,
      { signal: controller.signal } as never,
    ) as Out);

    expect(obsM).toHaveBeenCalledTimes(1);
    expect(b.counts).toEqual({ ok: 0, failed: 3 });
    expect(b.results.slice(1)).toMatchObject([
      { ok: false, id: 'WI-2', error: 'observation aborted by parent signal' },
      { ok: false, id: 'WI-3', error: 'observation aborted by parent signal' },
    ]);
  });
});
