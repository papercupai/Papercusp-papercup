import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  purge: vi.fn(),
  search: vi.fn(),
  authorize: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'user-1' }) }));
vi.mock('../../personal-vault/store', () => ({
  purgePersonalSource: mocks.purge,
  searchPersonalDocuments: mocks.search,
}));
vi.mock('../../personal-vault/authorization', () => ({ authorizePersonalAccess: mocks.authorize }));
// Labelling has its own suites (disclosure-labels / disclosure-ledger); here every result is unrestricted.
vi.mock('../../personal-vault/disclosure-ledger', () => ({
  discloseDocuments: async (_sql: unknown, params: { documents: unknown[] }) => ({
    documents: params.documents,
    withheld: 0,
    disclosed: 0,
  }),
}));
vi.mock('../../personal-vault/embedding', () => ({
  PERSONAL_EMBEDDER_MODE: 'gemma',
  buildPersonalQueryEmbedder: async () => mocks.embed,
}));

import purgeTool from './purge';
import searchTool from './search';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.purge.mockResolvedValue({ documents: 2, cursors: 1, aliases: 1, identities: 0 });
  mocks.embed.mockResolvedValue([0.1, 0.2]);
  mocks.search.mockResolvedValue([{ id: 'doc-1' }]);
  mocks.authorize.mockResolvedValue({
    allowed: true,
    principal: { kind: 'user', id: 'user-1' },
    scopes: ['gmail'],
  });
});

describe('Personal Vault defineTool response contract', () => {
  it('personal:purge returns the required ToolResponse data envelope', async () => {
    const result = await purgeTool.handler({ source: 'gmail', confirm: true }, {
      principal: { kind: 'user', workspaceId: 'ws-1' },
      tx: {},
    } as never);
    expect(result).toEqual({
      data: {
        ok: true,
        source: 'gmail',
        sourceId: null,
        providerAccountId: null,
        deleted: { documents: 2, cursors: 1, aliases: 1, identities: 0 },
      },
    });
    expect(mocks.purge).toHaveBeenCalledWith({}, 'ws-1', 'user-1', 'gmail', {
      sourceId: undefined,
      providerAccountId: undefined,
    });
  });

  it('personal:purge forwards account provenance for surgical deletion', async () => {
    const sourceId = '00000000-0000-4000-8000-000000000101';
    const result = await purgeTool.handler(
      {
        source: 'gmail',
        sourceId,
        providerAccountId: 'owner@example.com',
        confirm: true,
      },
      {
        principal: { kind: 'user', workspaceId: 'ws-1' },
        tx: {},
      } as never,
    );
    expect(result).toMatchObject({
      data: { source: 'gmail', sourceId, providerAccountId: 'owner@example.com' },
    });
    expect(mocks.purge).toHaveBeenCalledWith({}, 'ws-1', 'user-1', 'gmail', {
      sourceId,
      providerAccountId: 'owner@example.com',
    });
  });

  it('personal:search envelopes both granted and refused results', async () => {
    const ctx = { workspaceId: 'ws-1', principal: { workspaceId: 'ws-1' }, tx: {} } as never;
    const granted = await searchTool.handler({ query: 'meeting', scopes: ['gmail'] }, ctx);
    expect(granted).toMatchObject({
      data: { allowed: true, grantedScopes: ['gmail'], vectorLeg: 'gemma', results: [{ id: 'doc-1' }] },
    });

    mocks.authorize.mockResolvedValueOnce({ allowed: false, reason: 'grant_required', scopes: [] });
    const refused = await searchTool.handler({ query: 'meeting' }, ctx);
    expect(refused).toEqual({
      data: { allowed: false, refusal: 'grant_required', results: [], grantedScopes: [] },
    });
  });

  it('personal:search accepts offset-aware RFC3339 time ranges', () => {
    const parsed = searchTool.args.safeParse({
      query: 'meeting',
      timeRange: {
        from: '2025-08-26T00:00:00-04:00',
        to: '2025-08-27T00:00:00-04:00',
      },
    });

    expect(parsed.success).toBe(true);
  });
});
