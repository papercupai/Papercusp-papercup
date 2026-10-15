/**
 * personal:ask response contract (plan personal-data-reader-set-labels-2026-10-01,
 * P-007 / R-12). The delivery rule itself is proven against a real database in
 * personal-vault/delegated-read.integration.test.ts; this suite pins how the verb
 * wires it: default-deny authorization, the caller identity and acceptLabel it
 * passes, the transaction it searches in, and that a withheld envelope never
 * carries an answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  authorize: vi.fn(),
  delegatedRead: vi.fn(),
  statements: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'user-1' }) }));
vi.mock('../../personal-vault/store', () => ({ searchPersonalDocuments: mocks.search }));
vi.mock('../../personal-vault/authorization', () => ({ authorizePersonalAccess: mocks.authorize }));
vi.mock('../../personal-vault/embedding', () => ({
  PERSONAL_EMBEDDER_MODE: 'gemma',
  buildPersonalQueryEmbedder: async () => async () => [0.1, 0.2],
}));
vi.mock('../_disclosure-subject', () => ({ disclosureSubject: () => 'su-caller' }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: {
      begin: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          unsafe: async (sql: string, params: unknown[]) => {
            mocks.statements.push({ sql, params });
            return [];
          },
        }),
    },
  }),
}));
vi.mock('../../personal-vault/delegated-read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../personal-vault/delegated-read')>()),
  delegatedRead: mocks.delegatedRead,
}));

import askTool from './ask';

const ctx = { workspaceId: 'ws-1', principal: { workspaceId: 'ws-1' } } as never;
const DOC = { id: 'doc-1', source: 'gmail', participants: [], title: 't', snippet: 's' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.statements.length = 0;
  mocks.search.mockResolvedValue([DOC]);
  mocks.authorize.mockResolvedValue({ allowed: true, principal: { kind: 'user', id: 'user-1' }, scopes: ['gmail'] });
});

describe('personal:ask', () => {
  it('is a default-deny read verb registered under the personal-vault capability', () => {
    expect(askTool.name).toBe('personal:ask');
    expect(askTool.capability).toBe('search:read');
    expect(askTool.args.safeParse({ question: 'how many?' }).success).toBe(true);
    expect(askTool.args.safeParse({ question: '' }).success).toBe(false);
  });

  it('refuses without a grant and never reaches the delegate', async () => {
    mocks.authorize.mockResolvedValueOnce({ allowed: false, reason: 'grant_required', scopes: [] });
    const refused = await askTool.handler({ question: 'how many?' }, ctx);
    expect(refused).toEqual({ data: { allowed: false, refusal: 'grant_required', grantedScopes: [] } });
    expect(mocks.delegatedRead).not.toHaveBeenCalled();
  });

  it('searches inside a workspace-scoped transaction and hands the delegate the caller identity and acceptLabel', async () => {
    mocks.delegatedRead.mockResolvedValueOnce({ delivered: true, answer: 'One.', labelled: false, consulted: 1 });
    const res = await askTool.handler({ question: 'how many?', scopes: ['gmail'] }, ctx);
    expect(res).toEqual({ data: { allowed: true, withheld: false, answer: 'One.', consulted: 1, labelled: false } });
    expect(mocks.statements[0]).toEqual({ sql: `SELECT set_config('app.workspace_id', $1, true)`, params: ['ws-1'] });
    expect(mocks.search).toHaveBeenCalledWith(expect.anything(), 'ws-1', 'user-1', expect.objectContaining({ query: 'how many?', scopes: ['gmail'] }));
    const [params, deps] = mocks.delegatedRead.mock.calls[0];
    expect(params).toEqual({ workspaceId: 'ws-1', userId: 'user-1', callerOwnerId: 'su-caller', question: 'how many?', documents: [DOC], acceptLabel: false });
    expect(typeof deps.answer).toBe('function');
    expect(typeof deps.inWorkspaceTx).toBe('function');
  });

  it('a withheld answer is never in the envelope', async () => {
    mocks.delegatedRead.mockResolvedValueOnce({ delivered: false, reason: 'delegate_answer_carries_restricted', consulted: 1, carriedRestricted: 1 });
    const res = (await askTool.handler({ question: 'what did it say?' }, ctx)) as { data: Record<string, unknown> };
    expect(res.data).toMatchObject({ allowed: true, withheld: true, reason: 'delegate_answer_carries_restricted', carriedRestricted: 1 });
    expect(res.data).not.toHaveProperty('answer');
  });

  it('a labelled answer carries its labels and the restriction note', async () => {
    const labels = [{ documentId: 'doc-1', source: 'gmail', privacy: { level: 'participants', readerSet: ['a@x.example'] } }];
    mocks.delegatedRead.mockResolvedValueOnce({ delivered: true, answer: 'quoted', labelled: true, consulted: 1, labels });
    const res = (await askTool.handler({ question: 'what did it say?', acceptLabel: true }, ctx)) as { data: Record<string, unknown> };
    expect(mocks.delegatedRead.mock.calls[0][0]).toMatchObject({ acceptLabel: true });
    expect(res.data).toMatchObject({ allowed: true, withheld: false, labelled: true, labels });
    expect(res.data.restrictionNote).toContain('privacy.readerSet');
  });
});
