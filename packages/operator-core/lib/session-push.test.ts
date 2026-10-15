import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
const f = vi.hoisted(() => ({ push: vi.fn(), roster: vi.fn(), append: vi.fn() }));
vi.mock('./device-push-dispatcher', () => ({ notifyWorkspace: (...args: unknown[]) => f.push(...args) }));
vi.mock('./owner-sessions/roster', () => ({ readSessionRosterSnapshot: (...args: unknown[]) => f.roster(...args) }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<object>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('./adv-sessions', async original => ({ ...(await original<typeof import('./adv-sessions')>()), endedRecordedOwnerIds: async () => new Set(), listRecordedLiveSessions: async () => [] }));
vi.mock('./agent-tools/coordination/federation-scope', () => ({ resolveWorkspaceHiveScope: async () => ({ kind: 'none' }) }));
vi.mock('./agent-tools/coordination/nursery-alias-liveness', () => ({ listRunningNurseryAliasRows: async () => [] }));
vi.mock('./agent-tools/coordination/log', () => ({ coordLog: { appendLine: (...args: unknown[]) => f.append(...args) }, coordSql: () => ({}), coordWorkspaceId: () => 'ws-a', coordHasPgFastPath: () => false }));
import { notifySessionOwnerMessage } from './session-push';
import { sendMessage } from './agent-tools/coordination/messages';
const envelope = (over: Record<string, unknown> = {}) => ({ msg_id: 'msg-1', from: 'su-target', to: ['human'], kind: 'message',
  ts: new Date().toISOString(), summary: 'Please review the build', ...over }) as CoordEnvelope;
beforeEach(() => {
  f.push.mockReset().mockResolvedValue([]); f.append.mockReset().mockResolvedValue(1);
  f.roster.mockReset().mockResolvedValue({ active: [{ ownerId: 'su-target', workspaceId: 'ws-a', role: 'su' }], starting: [], pending: [] });
});
describe('owner session push', () => {
  it('uses the existing dispatcher with only a session reference and redacted preview', async () => {
    await notifySessionOwnerMessage(envelope({ summary: 'API_KEY=private-credential-value', toolArgs: { password: 'never-forward' }, transcript: 'never-forward' }), 'ws-a');
    expect(f.push).toHaveBeenCalledWith('ws-a', { title: 'Agent message', body: expect.any(String), data: { kind: 'agent-session', owner: 'su-target' } }, { requiredCapability: 'agent-sessions' });
    const serialized = JSON.stringify(f.push.mock.calls);
    expect(serialized).not.toContain('private-credential-value'); expect(serialized).not.toContain('never-forward');
  });
  it.each([{ to: ['su-peer'] }, { kind: 'ack' }, { auto: true }, { from: 'human' }])('does not push a non-owner agent message (%j)', async over => {
    await notifySessionOwnerMessage(envelope(over), 'ws-a'); expect(f.push).not.toHaveBeenCalled();
  });
  it('refuses a sender belonging to a different workspace even if the roster leaks it', async () => {
    f.roster.mockResolvedValue({ active: [{ ownerId: 'su-target', workspaceId: 'foreign', role: 'su' }], starting: [], pending: [] });
    await notifySessionOwnerMessage(envelope(), 'ws-a'); expect(f.push).not.toHaveBeenCalled();
  });
  it('does not publish a transcript preview under wildcard workspace scope', async () => {
    await notifySessionOwnerMessage(envelope(), '*'); expect(f.push).not.toHaveBeenCalled();
  });
  it('bounds the lock-screen preview', async () => {
    await notifySessionOwnerMessage(envelope({ summary: 'x'.repeat(1000) }), 'ws-a');
    expect(f.push.mock.calls[0][1].body).toHaveLength(200);
  });
  it('hooks a real coord message only after its durable append', async () => {
    let commit!: () => void;
    f.append.mockImplementation(() => new Promise(resolve => { commit = () => resolve(1); }));
    const writing = sendMessage({ ownerId: 'su-target', workspaceId: 'ws-a' } as never,
      { to: ['human'], summary: 'Please review', extra: { expects: 'answer' } });
    await vi.waitFor(() => expect(f.append).toHaveBeenCalled());
    expect(f.push).not.toHaveBeenCalled(); commit();
    const stored = await writing;
    expect(stored).toMatchObject({ kind: 'message', from: 'su-target', to: ['human'] });
    expect(stored.auto).not.toBe(true);
    await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(1));
  });
});
