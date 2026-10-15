import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../testing/typed-mock';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('./coordination-domain', () => ({
  hostGlobalLockDomain: vi.fn(() => 'papercusp-host-global'),
  HOST_GLOBAL_RESOURCES: new Set(['staging-server', 'staging-server-cooldown']),
}));
vi.mock('./cross-domain-conflict', () => ({ findCrossDomainResourceConflicts: vi.fn() }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_domain: string, _owner: string, fn: (tx: unknown) => unknown) => fn({ tx: true })),
}));
vi.mock('./su-lock-store', () => ({ registerResource: vi.fn(), stampResourceCoordinationDomainKind: vi.fn() }));

import { inWorkspaceTxn } from './in-workspace-txn';
import { registerResource, stampResourceCoordinationDomainKind } from './su-lock-store';
import { findCrossDomainResourceConflicts } from './cross-domain-conflict';

const registerM = vi.mocked(registerResource);
const txnM = vi.mocked(inWorkspaceTxn);
const stampM = vi.mocked(stampResourceCoordinationDomainKind);
const conflictsM = vi.mocked(findCrossDomainResourceConflicts);
const tool = (await import('./register_resource')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

const row = {
  resource: 'deploy:example',
  description: 'one deploy at a time',
  rule_text: 'Acquire exclusive before deployment.',
  enforcement: 'enforced' as const,
  match_patterns: [],
  max_holders: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  stampM.mockResolvedValue(true);
  conflictsM.mockResolvedValue([]);
});

describe('locks:register_resource', () => {
  it('creates a resource through the global registration transaction', async () => {
    registerM.mockResolvedValue({ created: true, resource: row });

    const result = body(
      await (tool.handler(
        {
          resource: row.resource,
          description: row.description,
          rule_text: row.rule_text,
          enforcement: row.enforcement,
          max_holders: row.max_holders,
        } as never,
        {} as never,
      ) as Promise<Out>),
    );

    expect(txnM).toHaveBeenCalledWith('papercusp-host-global', 'me', expect.any(Function));
    expect(registerM).toHaveBeenCalledWith(expect.objectContaining({ tx: true }), {
      resource: row.resource,
      description: row.description,
      rule_text: row.rule_text,
      enforcement: row.enforcement,
      max_holders: row.max_holders,
    });
    expect(result).toMatchObject({ ok: true, created: true, resource: row });
    expect(stampM).not.toHaveBeenCalled();
  });

  it('reports an existing resource without overwriting its policy', async () => {
    registerM.mockResolvedValue({ created: false, resource: row });

    const result = body(await (tool.handler({ resource: row.resource } as never, {} as never) as Promise<Out>));

    expect(result).toMatchObject({ ok: true, created: false, resource: row });
    expect(stampM).not.toHaveBeenCalled();
  });

  it.each(['staging-server', 'staging-server-cooldown'])(
    'publishes the maintained %s domain for an existing registration without changing policy', async resource => {
      const existing = { ...row, resource };
      registerM.mockResolvedValue({ created: false, resource: existing });
      const result = body(await (tool.handler({ resource } as never, {} as never) as Promise<Out>));
      expect(registerM).toHaveBeenCalledWith(expect.objectContaining({ tx: true }), { resource });
      expect(stampM).toHaveBeenCalledWith(expect.objectContaining({ tx: true }), resource, 'host-global');
      expect(result).toMatchObject({ ok: true, created: false, resource: existing });
    });

  it('publishes a newly registered maintained resource in the same transaction', async () => {
    registerM.mockResolvedValue({ created: true, resource: { ...row, resource: 'staging-server' } });
    await tool.handler({ resource: 'staging-server' } as never, {} as never);
    expect(stampM).toHaveBeenCalledTimes(1);
    expect(stampM).toHaveBeenCalledWith(expect.objectContaining({ tx: true }), 'staging-server', 'host-global');
  });

  it('refuses declaration while any legacy-domain owner, including the caller, holds the resource', async () => {
    mockResolvedTyped(conflictsM, [
      {
        coordination_domain: '/legacy',
        resource: 'staging-server',
        owner: 'me',
        owner_label: 'Me',
        mode: 'shared',
        status: 'held',
        reason: 'test fixture',
        acquired_ts: '2026-10-05T00:00:00.000Z',
        expires_ts: '2026-10-06T00:00:00.000Z',
      },
    ]);
    const result = body(await (tool.handler({ resource: 'staging-server' } as never, {} as never) as Promise<Out>));
    expect(result).toMatchObject({ ok: false, reason: 'held_in_other_domain' });
    expect(conflictsM).toHaveBeenCalledWith({ resource: 'staging-server', targetDomain: 'papercusp-host-global',
      requestedMode: 'exclusive', owner: '' });
    expect(registerM).not.toHaveBeenCalled();
    expect(stampM).not.toHaveBeenCalled();
  });

  it('does not report success when declaration publication fails', async () => {
    registerM.mockResolvedValue({ created: false, resource: { ...row, resource: 'staging-server' } });
    stampM.mockRejectedValue(new Error('registry unavailable'));
    await expect(tool.handler({ resource: 'staging-server' } as never, {} as never))
      .rejects.toThrow('registry unavailable');
  });
});
