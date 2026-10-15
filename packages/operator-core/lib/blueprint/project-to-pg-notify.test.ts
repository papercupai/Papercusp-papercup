import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlueprintSchema } from '@papercusp/orchestrator/blueprint';
import type { Sql } from 'postgres';
const ports = vi.hoisted(() => ({ notify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: ports.notify }));
import { projectBlueprintToPg } from './project-to-pg';
const blueprint = BlueprintSchema.parse({ id: 'support', workItem: { kind: 'task' },
  roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } } });
beforeEach(() => vi.clearAllMocks());
describe('Workflows declaration invalidation after projection', () => {
  it('pushes the existing catalog only after a successful pointer write', async () => {
    const writes: string[] = [];
    const sql = vi.fn(async () => { writes.push('persisted'); return []; });
    ports.notify.mockImplementation(async () => { expect(writes).toEqual(['persisted']); });
    await projectBlueprintToPg(sql as unknown as Sql, { workspaceId: 'workspace-a', harnessSlug: 'support', blueprint });
    expect(ports.notify).toHaveBeenCalledExactlyOnceWith('automation.catalog');
  });
  it('publishes no approved declaration after a failed projection', async () => {
    const sql = vi.fn().mockRejectedValue(new Error('write refused'));
    await expect(projectBlueprintToPg(sql as unknown as Sql, { workspaceId: 'workspace-a', harnessSlug: 'support', blueprint }))
      .rejects.toThrow('write refused');
    expect(ports.notify).not.toHaveBeenCalled();
  });
});
