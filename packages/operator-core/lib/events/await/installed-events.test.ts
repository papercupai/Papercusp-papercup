import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ saved: vi.fn() }));
vi.mock('../saved-event-type', () => ({ readSavedEventCatalog: h.saved }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default-ws' }));
vi.mock('../../cupboard/plugin-listings', () => ({ listAllInstalledPlugins: async () => [] }));
import { readInstalledUnitEvents } from './installed-events';

beforeEach(() => vi.resetAllMocks());

it('discovers locally declared event types in the caller workspace', async () => {
  const saved = [{ unit: 'local:alice', events: [{ family: 'local:demo', keyTemplate: 'demo:ready' }] }];
  h.saved.mockResolvedValue(saved);
  expect(await readInstalledUnitEvents({ warmHost: false, workspaceId: 'private-ws' })).toEqual(saved);
  expect(h.saved).toHaveBeenCalledWith('private-ws');
});

it('keeps existing catalog discovery available when the durable registry is unavailable', async () => {
  h.saved.mockRejectedValue(new Error('connection unavailable'));
  expect(await readInstalledUnitEvents({ warmHost: false })).toEqual([]);
});
