import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDaoLaunchSections, type DaoLaunchRecord } from './dao-launch';
const storage = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), notifications: vi.fn() }));
vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(async (_table: string, workspace: string) => storage.rows.get(workspace) ?? null),
  updateOperatorState: vi.fn(async (_table: string, fallback: Record<string, unknown>, mutator: (r: Record<string, unknown>) => Record<string, unknown>, workspace: string) => {
    const next = mutator(structuredClone(storage.rows.get(workspace) ?? fallback));
    storage.rows.set(workspace, next); return next;
  }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-a' }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: storage.notifications }));
import { createDaoLaunch, listDaoLaunches, updateDaoLaunch, reviewDaoLaunch } from './dao-launch-store';

describe('workspace-scoped DAO launch store', () => {
  beforeEach(() => { storage.rows.clear(); storage.notifications.mockReset(); });
  it('preserves unrelated onboarding state and refuses cross-workspace draft access', async () => {
    storage.rows.set('workspace-a', { install_id: 'install-a', step_status: { accounts: 'completed' } });
    const created = await createDaoLaunch({ name: 'Example', purpose: 'Work together' }, { id: 'user-a', name: 'Founder' });
    expect(storage.rows.get('workspace-a')?.install_id).toBe('install-a');
    expect(await listDaoLaunches('workspace-b')).toEqual([]);
    await expect(updateDaoLaunch(created.id, { expectedRevision: 1, name: 'Changed', sections: created.sections }, 'workspace-b')).rejects.toMatchObject({ code: 'not-found' });
    expect((await listDaoLaunches())[0]?.name).toBe('Example');
    expect(storage.notifications).toHaveBeenCalledWith('dao.launches');
  });
  it('accepts one concurrent revision and rejects the stale edit instead of losing data', async () => {
    const created = await createDaoLaunch({ name: 'Example', purpose: 'Work together' }, { id: 'user-a', name: 'Founder' });
    const payload = { expectedRevision: 1, sections: created.sections };
    const results = await Promise.allSettled([
      updateDaoLaunch(created.id, { ...payload, name: 'First edit' }),
      updateDaoLaunch(created.id, { ...payload, name: 'Second edit' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await listDaoLaunches())[0]?.name).toBe('First edit');
    expect((await listDaoLaunches())[0]?.revision).toBe(2);
  });
  it('pushes committed draft revisions and stays silent on refused mutations', async () => {
    const pushedRevisions: number[] = [];
    storage.notifications.mockImplementation((name: string) => {
      expect(name).toBe('dao.launches');
      const records = storage.rows.get('workspace-a')?.dao_launches as Record<string, DaoLaunchRecord>;
      pushedRevisions.push(Object.values(records)[0]!.revision);
    });
    const created = await createDaoLaunch({ name: 'Example', purpose: 'Work together' }, { id: 'user-a', name: 'Founder' });
    await updateDaoLaunch(created.id, { expectedRevision: 1, name: 'Changed', sections: created.sections });
    await expect(updateDaoLaunch(created.id, { expectedRevision: 1, name: 'Stale', sections: created.sections })).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(reviewDaoLaunch(created.id, { expectedRevision: 2, acknowledgePreparationOnly: true })).rejects.toMatchObject({ code: 'not-ready' });
    expect(pushedRevisions).toEqual([1, 2]);
    expect(storage.notifications).toHaveBeenCalledTimes(2);
  });
  it('blocks premature review and invalidates exact-version review after a later edit', async () => {
    const created = await createDaoLaunch({ name: 'Example', purpose: 'Work together' }, { id: 'user-a', name: 'Founder' });
    await expect(reviewDaoLaunch(created.id, { expectedRevision: 1, acknowledgePreparationOnly: true })).rejects.toMatchObject({ code: 'not-ready' });
    const sections = defaultDaoLaunchSections('Founder'); sections.purpose = 'Work together';
    sections.governance.prepared = true; sections.funding.prepared = true; sections.funding.basis = 'contributions';
    sections.legal = { route: 'new', country: 'US', entityName: 'Example', registrationReference: '', documentReference: 'charter-1', advisor: 'Counsel', reviewState: 'prepared' };
    sections.banking = { provider: 'Bank', applicationReference: 'application-1', reservePlan: 'Reserves', chain: 'Base', safeAddress: '', signers: ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)], threshold: 2, prepared: true };
    const updated = await updateDaoLaunch(created.id, { expectedRevision: 1, name: 'Example', sections });
    const reviewed = await reviewDaoLaunch(created.id, { expectedRevision: updated.revision, acknowledgePreparationOnly: true });
    expect(reviewed.preparationReady).toBe(true);
    expect(reviewed.fundingActive).toBe(false);
    const edited = await updateDaoLaunch(created.id, { expectedRevision: reviewed.revision, name: 'New name', sections });
    expect(edited.reviewedRevision).toBeNull();
    expect(edited.preparationReady).toBe(false);
  });
  it('does not persist failed validation or accept client-supplied review fields', async () => {
    await expect(createDaoLaunch({ name: '', purpose: 'Test' }, { id: 'user-a', name: 'Founder' })).rejects.toThrow();
    expect(storage.rows.size).toBe(0);
    const created = await createDaoLaunch({ name: 'Example', purpose: 'Work together' }, { id: 'user-a', name: 'Founder' });
    await expect(updateDaoLaunch(created.id, { expectedRevision: 1, name: 'Example', sections: created.sections, reviewedRevision: 2 })).rejects.toThrow();
    expect((await listDaoLaunches())[0]?.revision).toBe(1);
  });
});
