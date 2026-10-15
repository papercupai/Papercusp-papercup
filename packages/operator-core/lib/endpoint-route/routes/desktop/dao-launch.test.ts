import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), review: vi.fn(), list: vi.fn() }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'signed-in-person', username: 'person', display_name: 'Current person' }) }));
vi.mock('../../../dao-launch-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../dao-launch-store')>();
  return { ...actual, createDaoLaunch: io.create, updateDaoLaunch: io.update, reviewDaoLaunch: io.review, listDaoLaunches: io.list };
});
import routes from './dao-launch';
import { createDaoLaunchSchema } from '../../../dao-launch';
import { DaoLaunchError } from '../../../dao-launch-store';
import type { RouteContext } from '../../define-route';
const context: RouteContext = {
  principal: null,
  input: undefined,
  params: { id: 'organization-id' },
  log: () => {},
  signal: new AbortController().signal,
};

describe('DAO launch routes', () => {
  beforeEach(() => { Object.values(io).forEach(mock => mock.mockReset()); });
  it('keeps preparation behind the existing authenticated route stack', () => {
    expect(routes.map(route => route.auth)).toEqual([{}, {}, {}, {}]);
    expect(routes.map(route => route.method)).toEqual(['GET', 'POST', 'PATCH', 'POST']);
  });
  it('uses the current authenticated person for the founder, not a caller-supplied identity', async () => {
    io.create.mockResolvedValue({ id: 'organization-id' });
    const response = await routes[1]!.handler(new Request('http://local/api/desktop/dao-launch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Example', purpose: 'Work together' }),
    }), context);
    expect(response.status).toBe(201);
    expect(io.create).toHaveBeenCalledWith({ name: 'Example', purpose: 'Work together' }, { id: 'signed-in-person', name: 'Current person' });
  });
  it('reports invalid JSON as a correctable input error and stale writes as conflicts', async () => {
    io.create.mockImplementation(input => createDaoLaunchSchema.parse(input));
    const invalid = await routes[1]!.handler(new Request('http://local/api/desktop/dao-launch', { method: 'POST', body: '{' }), context);
    expect(invalid.status).toBe(400);
    io.update.mockRejectedValue(new DaoLaunchError('revision-conflict', 'Reload the draft'));
    const conflict = await routes[2]!.handler(new Request('http://local/api/desktop/dao-launch/organization-id', { method: 'PATCH', body: '{}' }), context);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'revision-conflict' });
  });
  it('returns unavailable for a draft outside the current workspace and refuses premature review', async () => {
    io.update.mockRejectedValue(new DaoLaunchError('not-found', 'Unknown organization'));
    const missing = await routes[2]!.handler(new Request('http://local/api/desktop/dao-launch/organization-id', { method: 'PATCH', body: '{}' }), context);
    expect(missing.status).toBe(404);
    io.review.mockRejectedValue(new DaoLaunchError('not-ready', 'Prepare earlier sections'));
    const refused = await routes[3]!.handler(new Request('http://local/api/desktop/dao-launch/organization-id/review', { method: 'POST', body: '{}' }), context);
    expect(refused.status).toBe(409);
    expect(io.review).toHaveBeenCalledWith('organization-id', {});
  });
});
