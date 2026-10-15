import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSuSessionHostOwner } from './su-session-persistence';

const db = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: db.sql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-default' }));
const owner = { pid: 11, hostId: 'host', nonce: 'nonce', recordedAt: '2026-10-08T00:00:00Z' };

describe('exact SU attached owner read', () => {
  beforeEach(() => db.sql.mockReset().mockResolvedValue([{ su_host_owner: owner }]));

  it('binds the exact adv id and makes the latest-chat branch ineligible even when both selectors are supplied', async () => {
    expect(await readSuSessionHostOwner({ workspaceId: 'workspace', advSessionId: 77, agentChatId: 'same-chat' })).toEqual(owner);
    const [parts, ...values] = db.sql.mock.calls[0]!;
    expect(parts.join('?')).toContain('?::bigint IS NOT NULL AND id = ?');
    expect(parts.join('?')).toContain('?::bigint IS NULL AND su_agent_chat_id = ?');
    expect(values).toEqual(['workspace', 77, 77, 77, 'same-chat']);
  });

  it('retains the existing latest-chat selector for ordinary session operations', async () => {
    expect(await readSuSessionHostOwner({ agentChatId: 'chat' })).toEqual(owner);
    expect(db.sql.mock.calls[0]!.slice(1)).toEqual(['workspace-default', null, null, null, 'chat']);
  });

  it.each([0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid exact id %s without falling back to a chat read', async advSessionId => {
    expect(await readSuSessionHostOwner({ advSessionId, agentChatId: 'chat' })).toBeNull();
    expect(db.sql).not.toHaveBeenCalled();
  });

  it('keeps an unreadable or malformed ownership record absent from dispatch authority', async () => {
    db.sql.mockRejectedValueOnce(new Error('unavailable'));
    expect(await readSuSessionHostOwner({ advSessionId: 77 })).toBeNull();
    db.sql.mockResolvedValueOnce([{ su_host_owner: { ...owner, pid: -1 } }]);
    expect(await readSuSessionHostOwner({ advSessionId: 77 })).toBeNull();
  });
});
