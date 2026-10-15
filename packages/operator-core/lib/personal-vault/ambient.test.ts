import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { authorizePersonalAccess } from './authorization';
import {
  buildPersonalAmbientContextBlock,
  resolvePersonalAmbientToolContext,
  type PersonalAmbientDeps,
} from './ambient';
import type { PersonalSearchResult, PersonalToolContext } from './types';

function sequencedSql(...responses: unknown[][]): {
  sql: Sql;
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let index = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(responses[index++] ?? []);
  }) as unknown as Sql;
  return { sql, calls };
}

function result(overrides: Partial<PersonalSearchResult> = {}): PersonalSearchResult {
  return {
    id: 'doc-1',
    source: 'gmail',
    scopeKey: 'personal:mail',
    sourceId: '00000000-0000-4000-8000-000000000101',
    providerAccountId: 'owner@example.com',
    kind: 'mail',
    externalId: 'thread-1',
    occurredAt: '2026-08-20T14:00:00.000Z',
    participants: ['alex@example.com'],
    participantIds: ['person-1'],
    title: 'Acme review follow-up',
    snippet: 'Alex asked to revisit the renewal timeline before Friday.',
    metadata: {},
    score: 0.91,
    lexicalRank: 0.88,
    vectorRank: 0.79,
    ...overrides,
  };
}

function deps(overrides: Partial<PersonalAmbientDeps> = {}): PersonalAmbientDeps {
  return {
    sql: (() => Promise.resolve([])) as unknown as Sql,
    resolveContext: vi.fn().mockResolvedValue({
      workspaceId: 'ws-1',
      role: 'meeting-prep',
      planRunSessionId: 'run-1',
    } satisfies PersonalToolContext),
    authorize: vi.fn().mockResolvedValue({
      allowed: true,
      scopes: ['personal:mail'],
      principal: { type: 'plan-template', id: 'meeting-prep-brief' },
    }),
    embedQuery: vi.fn().mockResolvedValue([0.1, 0.2]),
    search: vi.fn().mockResolvedValue([result()]),
    disclose: vi.fn(async (_sql: Sql, params: { documents: PersonalSearchResult[] }) => ({
      documents: params.documents.map((doc) => ({ ...doc, privacy: null })),
      withheld: 0,
      disclosed: 0,
    })),
    ...overrides,
  };
}

describe('resolvePersonalAmbientToolContext', () => {
  it('uses only server-owned presence, direct plan-run, and claimed binding state', async () => {
    const { sql, calls } = sequencedSql(
      [{ agent_role: 'meeting-prep' }],
      [{ session_id: 'run-1' }],
      [{ feature_id: 'binding-1', payload: {} }],
    );

    await expect(resolvePersonalAmbientToolContext(sql, 'run-1', 'ws-1')).resolves.toEqual({
      workspaceId: 'ws-1',
      role: 'meeting-prep',
      featureId: 'binding-1',
      planRunSessionId: 'run-1',
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.values.includes('ws-1'))).toBe(true);
  });

  it('resolves a claimed plan-run pointer when the owner id is not the run session id', async () => {
    const { sql, calls } = sequencedSql(
      [{ agent_role: 'meeting-prep' }],
      [],
      [{
        feature_id: 'binding-1',
        payload: { plan_run: { instancePlanSlug: 'meeting-prep-brief--2026-08-22' } },
      }],
      [{ session_id: 'resolved-run-1' }],
    );

    const context = await resolvePersonalAmbientToolContext(sql, 'agent-1', 'ws-1');

    expect(context.planRunSessionId).toBe('resolved-run-1');
    expect(calls).toHaveLength(4);
    expect(calls[3]?.values).toContain('meeting-prep-brief--2026-08-22');
  });
});

describe('buildPersonalAmbientContextBlock', () => {
  const input = {
    ownerId: 'meeting-prep-run-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    query: 'prepare me for the Acme review',
  };

  it('injects a bounded, separately labelled block for a granted context', async () => {
    const d = deps();

    const block = await buildPersonalAmbientContextBlock(input, d);

    expect(block).toContain('## Granted Personal Vault context');
    expect(block).toContain('scopes: personal:mail');
    expect(block).toContain('Acme review follow-up');
    expect(block).toContain('[personal:mail · account:owner@example.com · 2026-08-20 · thread-1]');
    expect(d.search).toHaveBeenCalledWith(d.sql, 'ws-1', 'user-1', {
      query: input.query,
      scopes: ['personal:mail'],
      limit: 4,
      snippetChars: 360,
      queryEmbedding: [0.1, 0.2],
    });
  });

  it('injects zero bytes for a coding role and never embeds or searches', async () => {
    const embedQuery = vi.fn();
    const search = vi.fn();
    const d = deps({
      sql: (() => {
        throw new Error('coding denial must happen before database access');
      }) as unknown as Sql,
      resolveContext: vi.fn().mockResolvedValue({ role: 'su' }),
      authorize: authorizePersonalAccess,
      embedQuery,
      search,
    });

    await expect(buildPersonalAmbientContextBlock(input, d)).resolves.toBeNull();
    expect(embedQuery).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('injects zero bytes for an ungranted context and never embeds or searches', async () => {
    const embedQuery = vi.fn();
    const search = vi.fn();
    const d = deps({
      authorize: vi.fn().mockResolvedValue({
        allowed: false,
        reason: 'no_live_grant',
        scopes: [],
        principal: { type: 'plan-template', id: 'meeting-prep-brief' },
      }),
      embedQuery,
      search,
    });

    await expect(buildPersonalAmbientContextBlock(input, d)).resolves.toBeNull();
    expect(embedQuery).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('emits no heading when a granted search returns no documents', async () => {
    const d = deps({ search: vi.fn().mockResolvedValue([]) });
    await expect(buildPersonalAmbientContextBlock(input, d)).resolves.toBeNull();
  });

  it('fails silent when context resolution or storage fails', async () => {
    const d = deps({
      resolveContext: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    await expect(buildPersonalAmbientContextBlock(input, d)).resolves.toBeNull();
  });

  it('records a disclosure against the session identity and renders the restriction', async () => {
    const disclose = vi.fn(async (_sql: Sql, params: { documents: PersonalSearchResult[] }) => ({
      documents: params.documents.map((doc) => ({
        ...doc,
        privacy: { level: 'sender-only' as const, readerSet: ['alex@example.com'] },
      })),
      withheld: 0,
      disclosed: params.documents.length,
    }));
    const d = deps({ disclose });

    const block = await buildPersonalAmbientContextBlock(input, d);

    expect(disclose).toHaveBeenCalledWith(d.sql, {
      workspaceId: 'ws-1',
      userId: 'user-1',
      agentOwnerId: 'meeting-prep-run-1',
      documents: [result()],
    });
    expect(block).toContain('(restricted sender-only: send only to alex@example.com or the owner)');
  });

  it('withholds the whole block when the disclosure cannot be recorded', async () => {
    const d = deps({ disclose: vi.fn().mockRejectedValue(new Error('ledger unavailable')) });
    await expect(buildPersonalAmbientContextBlock(input, d)).resolves.toBeNull();
  });
});
