import { beforeEach, describe, expect, it, vi } from 'vitest';

const getWorkItemsByIds = vi.hoisted(() => vi.fn());
vi.mock('../../work-items', () => ({ getWorkItemsByIds }));

import { unresolvedRefsInBody, MAX_REFS_PROBED } from './unresolved-refs';

describe('unresolvedRefsInBody default batch probe', () => {
  beforeEach(() => getWorkItemsByIds.mockReset());

  it('resolves the bounded ref set in one set-based lookup and preserves missing-ref order', async () => {
    getWorkItemsByIds.mockResolvedValue([{ id: 'EI-100' }, { id: 'WI-200' }]);
    const ids = ['EI-100', 'WI-200', 'EI-300'];

    const result = await unresolvedRefsInBody(`first ${ids[0]}, then ${ids[1]}, then ${ids[2]}`);

    expect(getWorkItemsByIds).toHaveBeenCalledTimes(1);
    expect(getWorkItemsByIds).toHaveBeenCalledWith(ids);
    expect(result?.missing).toEqual(['EI-300']);
  });

  it('applies the reference cap before the single batch lookup', async () => {
    getWorkItemsByIds.mockResolvedValue([]);
    const ids = Array.from({ length: MAX_REFS_PROBED + 20 }, (_, i) => `EI-${i + 1}`);

    await unresolvedRefsInBody(ids.join(' '));

    expect(getWorkItemsByIds).toHaveBeenCalledTimes(1);
    expect(getWorkItemsByIds.mock.calls[0][0]).toHaveLength(MAX_REFS_PROBED);
    expect(getWorkItemsByIds.mock.calls[0][0]).toEqual(ids.slice(0, MAX_REFS_PROBED));
  });

});
