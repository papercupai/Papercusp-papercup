import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({
  rows: vi.fn(),
  knownOwnerIdSet: vi.fn(),
  resolveRecipientsAgainst: vi.fn(),
  identity: vi.fn(() => ({
    ownerId: 'su-b2cecf28-09b6-47f9-bb60-8b93863d52ea',
    workspaceId: 'ws-test',
  })),
}));

vi.mock('../../tool-call-log-store', () => ({
  toolCallRowsFor: h.rows,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: h.identity,
}));

vi.mock('../coordination/recipient-resolve', () => ({
  knownOwnerIdSet: h.knownOwnerIdSet,
  resolveRecipientsAgainst: h.resolveRecipientsAgainst,
}));

const { default: tool } = await import('./tool-log');

type ArgsSchema = {
  safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> };
};
type Guidance = { when?: string; argRedirects?: { limit?: string } };

const argsSchema = (tool as unknown as { args: ArgsSchema }).args;
const guidance = (tool as unknown as { guidance?: Guidance }).guidance;
const resultSchema = (tool as unknown as {
  result?: { safeParse: (value: unknown) => { success: boolean } };
}).result;

type HandlerResult = {
  isError?: boolean;
  content?: Array<{ text?: string }>;
};

type JsonSchemaProperty = {
  type?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
};

function schemaProperty(name: string): JsonSchemaProperty | undefined {
  const schema = z.toJSONSchema(argsSchema as never) as {
    properties?: Record<string, JsonSchemaProperty>;
    anyOf?: Array<{ properties?: Record<string, JsonSchemaProperty> }>;
  };
  return schema.properties?.[name] ?? schema.anyOf?.map((branch) => branch.properties?.[name]).find(Boolean);
}

function errorBody(result: unknown) {
  const text = (result as HandlerResult).content?.[0]?.text;
  if (!text) throw new Error('expected an error body');
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.mockResolvedValue([]);
});

describe('activity:tool-log timestamp boundaries', () => {
  it('advertises and enforces max_lines as an integer in the range 5..200', () => {
    expect(schemaProperty('max_lines')).toMatchObject({ type: 'integer', minimum: 5, maximum: 200 });
    expect(argsSchema.safeParse({ owner: 'self', max_lines: 5 }).success).toBe(true);
    expect(argsSchema.safeParse({ owner: 'self', max_lines: 200 }).success).toBe(true);
    expect(argsSchema.safeParse({ owner: 'self', max_lines: 4 }).success).toBe(false);
    expect(argsSchema.safeParse({ owner: 'self', max_lines: 201 }).success).toBe(false);
  });

  it('advertises and enforces top_k as an integer in the range 1..25', () => {
    expect(schemaProperty('top_k')).toMatchObject({ type: 'integer', minimum: 1, maximum: 25 });
    expect(schemaProperty('top_k')?.description).toContain('default 8');
    expect(schemaProperty('top_k')?.description).toContain('maximum 25');
    expect(guidance?.argRedirects?.limit).toContain('integer 1-25');
    expect(argsSchema.safeParse({ owner: 'self', top_k: 25 }).success).toBe(true);
    expect(argsSchema.safeParse({ owner: 'self', top_k: 26 }).success).toBe(false);
    expect(argsSchema.safeParse({ owner: 'self', top_k: 0 }).success).toBe(false);
  });

  it('rejects relative durations before they reach the timestamptz query', () => {
    expect(argsSchema.safeParse({ owner: 'self', since: '-15 min' }).success).toBe(false);
    expect(argsSchema.safeParse({ owner: 'self', until: '10m' }).success).toBe(false);
    expect(h.rows).not.toHaveBeenCalled();
  });

  it('accepts offset ISO timestamps and normalizes them to UTC for the store', async () => {
    const parsed = argsSchema.safeParse({
      owner: 'self',
      since: '2026-08-12T18:00:00-04:00',
      until: '2026-08-12T19:30:00+01:00',
      max_lines: 5,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || !parsed.data) throw new Error('expected valid tool args');

    h.rows.mockResolvedValueOnce([]);
    await tool.handler(parsed.data as never, {} as never);

    expect(h.rows).toHaveBeenCalledWith({
      ownerId: 'su-b2cecf28-09b6-47f9-bb60-8b93863d52ea',
      sessionId: undefined,
      sinceIso: '2026-08-12T22:00:00.000Z',
      untilIso: '2026-08-12T18:30:00.000Z',
    });
  });

  it('resolves a unique displayed short owner handle before querying the ledger', async () => {
    const short = 'su-b2cecf28';
    const full = 'su-b2cecf28-09b6-47f9-bb60-8b93863d52ea';
    h.knownOwnerIdSet.mockResolvedValue(new Set([full]));
    h.resolveRecipientsAgainst.mockReturnValue({ resolved: [full], unknown: [], ambiguous: [] });

    await tool.handler(argsSchema.safeParse({ owner: short }).data as never, {} as never);

    expect(h.resolveRecipientsAgainst).toHaveBeenCalledWith([short], [full]);
    expect(h.rows).toHaveBeenCalledWith(expect.objectContaining({ ownerId: full }));
  });

  it('refuses an ambiguous short owner handle instead of returning a valid-looking zero', async () => {
    const short = 'su-b2cecf28';
    const matches = [
      'su-b2cecf28-09b6-47f9-bb60-8b93863d52ea',
      'su-b2cecf28-2a1e-4cc1-a40d-fd6e5ebd8a10',
    ];
    h.knownOwnerIdSet.mockResolvedValue(new Set(matches));
    h.resolveRecipientsAgainst.mockReturnValue({
      resolved: [],
      unknown: [],
      ambiguous: [{ id: short, matches }],
    });

    const result = await tool.handler(argsSchema.safeParse({ owner: short }).data as never, {} as never);

    expect((result as HandlerResult).isError).toBe(true);
    expect(errorBody(result)).toMatchObject({ ok: false, error: 'owner_ambiguous', owner: short, matches });
    expect(h.rows).not.toHaveBeenCalled();
  });

  it('refuses an unknown short owner handle instead of querying an empty history', async () => {
    const short = 'su-does-not-exist';
    h.knownOwnerIdSet.mockResolvedValue(new Set(['su-b2cecf28-09b6-47f9-bb60-8b93863d52ea']));
    h.resolveRecipientsAgainst.mockReturnValue({ resolved: [], unknown: [short], ambiguous: [] });

    const result = await tool.handler(argsSchema.safeParse({ owner: short }).data as never, {} as never);

    expect(errorBody(result)).toMatchObject({ ok: false, error: 'owner_not_found', owner: short });
    expect(h.rows).not.toHaveBeenCalled();
  });

  it('reports roster unavailability for a non-canonical handle', async () => {
    const short = 'su-b2cecf28';
    h.knownOwnerIdSet.mockResolvedValue(null);

    const result = await tool.handler(argsSchema.safeParse({ owner: short }).data as never, {} as never);

    expect(errorBody(result)).toMatchObject({ ok: false, error: 'owner_resolution_unavailable', owner: short });
    expect(h.rows).not.toHaveBeenCalled();
  });

  it('keeps a full session-shaped owner id usable for historical queries when the roster is unavailable', async () => {
    const full = 'su-b2cecf28-09b6-47f9-bb60-8b93863d52ea';
    h.knownOwnerIdSet.mockResolvedValue(null);

    await tool.handler(argsSchema.safeParse({ owner: full }).data as never, {} as never);

    expect(h.knownOwnerIdSet).not.toHaveBeenCalled();
    expect(h.rows).toHaveBeenCalledWith(expect.objectContaining({ ownerId: full }));
  });

  it('keeps a su-respawn owner id usable for historical queries without a live roster match', async () => {
    const full = 'su-respawn-1529d5283907a0f8c68b462778e0d1e3';

    await tool.handler(argsSchema.safeParse({ owner: full }).data as never, {} as never);

    expect(h.knownOwnerIdSet).not.toHaveBeenCalled();
    expect(h.rows).toHaveBeenCalledWith(expect.objectContaining({ ownerId: full }));
  });

  it('documents that both boundaries are absolute ISO timestamps', () => {
    expect(guidance?.when ?? '').toMatch(/absolute ISO 8601 timestamps/i);
    expect(guidance?.when ?? '').toMatch(/relative durations.*not supported/i);
  });
});

describe('activity:tool-log structured return contract (EI-23219101783641313)', () => {
  it('publishes the handler data shape for tools:find and code:run callers', () => {
    expect(resultSchema).toBeDefined();
    expect(resultSchema?.safeParse({
      ok: true,
      calls: 2,
      rawRows: 3,
      span: { from: '2026-09-14T07:00:00.000Z', to: '2026-09-14T07:01:00.000Z' },
      log: 'activity:tool-log ✓',
    }).success).toBe(true);
  });

  it('requires the actual structured keys instead of an invented content envelope', () => {
    expect(resultSchema?.safeParse({
      ok: true,
      content: [{ type: 'text', text: JSON.stringify({ calls: 2 }) }],
    }).success).toBe(false);
  });
});
