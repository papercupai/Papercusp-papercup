import { beforeEach, describe, expect, it, vi } from 'vitest';
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'this-workspace' }));
import { dispatchNativeWindowIntent, dispatchUiIntent } from './dispatch-intent';
beforeEach(() => sql.mockReset());

describe('existing UI transport for native desktop focus', () => {
  it('selects only a fresh native client in this workspace and waits for its result', async () => {
    sql.mockResolvedValueOnce([{ client_id: 'native-client' }]).mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: 'done', result: { focused: true }, error_message: null }]);
    expect(await dispatchNativeWindowIntent({ action: 'focus', title: 'Papercup — exact' })).toEqual({ focused: true });
    const [query, workspace] = sql.mock.calls[0];
    expect(query.join(' ')).toContain("viewport->>'nativeDesktop' = 'true'");
    expect(query.join(' ')).toContain("interval '45 seconds'");
    expect(workspace).toBe('this-workspace');
    const inserted = sql.mock.calls[1].slice(1);
    expect(inserted).toEqual(['native-client', 'native_window', expect.any(String), 'system:operator', 'this-workspace']);
    expect(JSON.parse(inserted[2])).toMatchObject({ action: 'focus', title: 'Papercup — exact', expiresAt: expect.any(Number) });
  });
  it('does not dispatch without an eligible native client', async () => {
    sql.mockResolvedValueOnce([]);
    expect(await dispatchNativeWindowIntent({ action: 'focus', title: 'Agent' })).toBeNull();
    expect(sql).toHaveBeenCalledTimes(1);
  });
  it('expires pending focus requests so an offline client cannot steal focus later', async () => {
    sql.mockResolvedValueOnce([{ id: 4 }]).mockResolvedValue([]);
    expect(await dispatchUiIntent({ clientId: 'native', intent: 'native_window', args: {}, requestedBy: 'agent:self', timeoutMs: 0 })).toMatchObject({ id: 4, status: 'timeout' });
    expect(sql.mock.calls.at(-1)![0].join(' ')).toContain("AND status = 'pending'");
  });
});
