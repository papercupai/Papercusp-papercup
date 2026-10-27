/**
 * listProviderOptions (cupboard-distributable-integrations-2026-10-10 P-004, D-005; SPEC-R-2-P-004):
 * a settings field that declares `x-options: { capability }` gets its choices from every connected
 * source whose installed provider declares that capability — whatever the provider is — through the
 * source's own host.fetch, and one failing source does not hide the others.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { HostFetch } from '@papercusp/plugin-sdk';
import type { OwnedExternalTriggerSourceRow } from '../external-triggers/source-store';
import type { ProviderRegistry, RegisteredProvider } from './provider-registry';
import { listProviderOptions, type ProviderOptionsDeps } from './provider-options';
import { TicketIntegrationError } from './ticket-integrations';

const sql = {} as postgres.Sql;
const SCOPE = { workspaceId: 'ws-test', ownerUserId: '00000000-0000-4000-8000-000000000001' };

function provider(id: string, capabilities: string[], invoke: RegisteredProvider['adapter']['invoke']): RegisteredProvider {
  return {
    descriptor: { id, displayName: id.replace(/^fixture-/, 'Fixture '), capabilities, datatypes: [] } as never,
    adapter: { describe: vi.fn(), syncPage: vi.fn(), invoke } as never,
    pluginName: `${id}-plugin`,
    runtime: 'js',
    registeredAt: 0,
  };
}

function source(id: string, kind: string, config: Record<string, unknown> = {}): OwnedExternalTriggerSourceRow {
  return { id, kind, config, status: 'active' } as unknown as OwnedExternalTriggerSourceRow;
}

function deps(providers: RegisteredProvider[], sources: OwnedExternalTriggerSourceRow[]): ProviderOptionsDeps & {
  hostFetchFor: ReturnType<typeof vi.fn>;
} {
  const registry = { list: () => providers } as unknown as ProviderRegistry;
  return {
    registry,
    listSources: vi.fn(async () => sources),
    hostFetchFor: vi.fn(() => (async () => ({ status: 200, headers: {}, body: '' })) as unknown as HostFetch),
  };
}

describe('listProviderOptions', () => {
  it('asks every connected source whose provider declares the capability, with that source’s own host.fetch', async () => {
    const chatInvoke = vi.fn(async () => ({
      options: [
        { value: 'C1', label: '#bugs', description: 'Bug reports' },
        { value: 'C2', label: '#general' },
      ],
    }));
    const otherInvoke = vi.fn(async () => ({ options: [{ value: 'X', label: 'never asked' }] }));
    const d = deps(
      [provider('fixture-chat', ['chat.channels'], chatInvoke), provider('fixture-mail', ['mail.folders'], otherInvoke)],
      [
        source('11111111-1111-4111-8111-111111111111', 'fixture-chat', { accountLabel: 'Acme workspace', installSlug: 'home' }),
        source('22222222-2222-4222-8222-222222222222', 'fixture-mail'),
        source('33333333-3333-4333-8333-333333333333', 'not-installed'),
      ],
    );

    const result = await listProviderOptions(sql, { ...SCOPE, capability: 'chat.channels', args: { types: 'public' } }, d);

    expect(result).toEqual({
      capability: 'chat.channels',
      groups: [
        {
          sourceId: '11111111-1111-4111-8111-111111111111',
          provider: 'fixture-chat',
          providerName: 'Fixture chat',
          accountLabel: 'Acme workspace',
          options: [
            { value: 'C1', label: '#bugs', description: 'Bug reports' },
            { value: 'C2', label: '#general' },
          ],
          truncated: false,
          error: null,
        },
      ],
    });
    expect(chatInvoke).toHaveBeenCalledWith(
      {
        source: '11111111-1111-4111-8111-111111111111',
        capability: 'chat.channels',
        args: { types: 'public' },
        config: { accountLabel: 'Acme workspace', installSlug: 'home' },
      },
      { fetch: expect.any(Function) },
    );
    expect(otherInvoke).not.toHaveBeenCalled();
    // The token comes from the install that connected the source, bound to that one source.
    expect(d.hostFetchFor).toHaveBeenCalledWith(sql, {
      workspaceId: 'ws-test',
      providerId: 'fixture-chat',
      sourceId: '11111111-1111-4111-8111-111111111111',
      harness: 'home',
    });
  });

  it('reads an existing ticket.containers answer as options unchanged', async () => {
    const d = deps(
      [provider('fixture-tickets', ['ticket.containers'], async () => ({
        containers: [{ id: 'P1', name: 'Bugs', kind: 'project' }, { id: 'P2', kind: 'project' }],
        truncated: true,
      }))],
      [source('44444444-4444-4444-8444-444444444444', 'fixture-tickets')],
    );
    const result = await listProviderOptions(sql, { ...SCOPE, capability: 'ticket.containers' }, d);
    expect(result.groups[0]).toMatchObject({
      options: [{ value: 'P1', label: 'Bugs' }, { value: 'P2', label: 'P2' }],
      truncated: true,
      error: null,
    });
  });

  it('keeps the other sources when one fails, and names the failure on its group', async () => {
    const d = deps(
      [
        provider('fixture-chat', ['chat.channels'], async () => {
          throw Object.assign(new Error('token revoked'), { kind: 'auth' });
        }),
        provider('fixture-forum', ['chat.channels'], async () => ({ options: [{ value: 'F1', label: 'Forum' }] })),
      ],
      [
        source('55555555-5555-4555-8555-555555555555', 'fixture-chat'),
        source('66666666-6666-4666-8666-666666666666', 'fixture-forum'),
      ],
    );
    const result = await listProviderOptions(sql, { ...SCOPE, capability: 'chat.channels' }, d);
    expect(result.groups.map((g) => [g.provider, g.options.map((o) => o.value), g.error?.code ?? null])).toEqual([
      ['fixture-chat', [], 'provider_auth'],
      ['fixture-forum', ['F1'], null],
    ]);
  });

  it('offers create destinations only from providers that can create tickets', async () => {
    const readOnly = vi.fn(async () => ({ options: [{ value: 'P1', label: 'Read only' }] }));
    const writable = vi.fn(async () => ({ options: [{ value: 'P1', label: 'Writable' }] }));
    const d = deps([
      provider('fixture-reader', ['ticket.containers'], readOnly),
      provider('fixture-writer', ['ticket.containers', 'ticket.create'], writable),
    ], [source('reader', 'fixture-reader'), source('writer', 'fixture-writer')]);

    const listed = await listProviderOptions(sql, {
      ...SCOPE, capability: 'ticket.containers', args: { purpose: 'create' },
    }, d);
    expect(listed.groups.map(group => group.sourceId)).toEqual(['writer']);
    expect(readOnly).not.toHaveBeenCalled();
    expect(writable).toHaveBeenCalledOnce();

    await expect(listProviderOptions(sql, {
      ...SCOPE, capability: 'ticket.containers', args: { purpose: 'create' }, sourceId: 'reader',
    }, d)).rejects.toMatchObject({ code: 'provider_capability_unsupported', status: 409 });

    // Read pickers retain containers from both providers.
    const readable = await listProviderOptions(sql, { ...SCOPE, capability: 'ticket.containers' }, d);
    expect(readable.groups.map(group => group.sourceId)).toEqual(['reader', 'writer']);
    expect(readOnly).toHaveBeenCalledOnce();
  });

  it('answers an empty list when no connected provider declares the capability', async () => {
    const d = deps([provider('fixture-mail', ['mail.folders'], vi.fn())], [source('77777777-7777-4777-8777-777777777777', 'fixture-mail')]);
    expect(await listProviderOptions(sql, { ...SCOPE, capability: 'chat.channels' }, d)).toEqual({ capability: 'chat.channels', groups: [] });
  });

  it('narrows to one named source, and refuses a source that is not the owner’s or cannot answer', async () => {
    const invoke = vi.fn(async () => ({ options: [{ value: 'C1', label: '#bugs' }] }));
    const d = deps(
      [provider('fixture-chat', ['chat.channels'], invoke), provider('fixture-mail', ['mail.folders'], vi.fn())],
      [
        source('11111111-1111-4111-8111-111111111111', 'fixture-chat'),
        source('88888888-8888-4888-8888-888888888888', 'fixture-chat'),
        source('22222222-2222-4222-8222-222222222222', 'fixture-mail'),
      ],
    );
    const one = await listProviderOptions(sql, { ...SCOPE, capability: 'chat.channels', sourceId: '88888888-8888-4888-8888-888888888888' }, d);
    expect(one.groups.map((g) => g.sourceId)).toEqual(['88888888-8888-4888-8888-888888888888']);
    expect(invoke).toHaveBeenCalledTimes(1);

    await expect(
      listProviderOptions(sql, { ...SCOPE, capability: 'chat.channels', sourceId: '99999999-9999-4999-8999-999999999999' }, d),
    ).rejects.toMatchObject({ code: 'source_not_found', status: 404 });
    await expect(
      listProviderOptions(sql, { ...SCOPE, capability: 'chat.channels', sourceId: '22222222-2222-4222-8222-222222222222' }, d),
    ).rejects.toMatchObject({ code: 'provider_capability_unsupported', status: 409 });
  });

  it('refuses a malformed option source before reading anything', async () => {
    const d = deps([], []);
    for (const bad of [
      { capability: 'chat.channels.list' },
      { capability: '' },
      { capability: 'chat.channels', args: ['x'] as unknown as Record<string, unknown> },
    ]) {
      const error = await listProviderOptions(sql, { ...SCOPE, ...bad }, d).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TicketIntegrationError);
      expect(error).toMatchObject({ code: 'invalid_option_source', status: 400 });
    }
    expect(d.listSources).not.toHaveBeenCalled();
  });
});
