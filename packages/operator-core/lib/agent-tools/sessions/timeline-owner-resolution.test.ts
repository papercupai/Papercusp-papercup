import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TURN_REF_PREFIX } from './_shared';

const h = vi.hoisted(() => ({
  identity: vi.fn(() => ({ ownerId: 'su-caller', workspaceId: 'ws-test' })),
  resolveRecipients: vi.fn(),
  knownOwnerIdSet: vi.fn(),
  resolveRecipientsAgainst: vi.fn(),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: h.identity,
}));

vi.mock('../coordination/recipient-resolve', () => ({
  resolveRecipients: h.resolveRecipients,
  knownOwnerIdSet: h.knownOwnerIdSet,
  resolveRecipientsAgainst: h.resolveRecipientsAgainst,
}));

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: h.sessionSearchEnabled,
  refreshLiveSessionsBeforeRead: h.refreshLiveSessionsBeforeRead,
}));

const tool = (await import('./timeline')).default;

type HandlerResult = {
  isError?: boolean;
  content?: Array<{ text?: string }>;
};

function errorBody(result: unknown) {
  const text = (result as HandlerResult).content?.[0]?.text;
  if (!text) throw new Error('expected a JSON error body');
  return JSON.parse(text) as Record<string, unknown>;
}

function makeTx() {
  const tx = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const parts = [...strings];
      return parts.join(' ').includes('FROM harness_shared.')
        ? Promise.resolve([])
        : { kind: 'fragment' as const, strings: parts, values };
    }),
    {
      unsafe: vi.fn((value: string) => value),
      array: vi.fn((value: unknown[]) => value),
    },
  );
  return tx;
}

function run(owner: string, tx = makeTx()) {
  return (
    tool as unknown as {
      handler: (args: unknown, ctx: unknown) => Promise<unknown>;
    }
  ).handler(
    { owner, since: '2026-08-23T12:00:00Z', until: '2026-08-23T14:00:00Z' },
    { workspaceId: 'ws-test', tx },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sessionSearchEnabled.mockResolvedValue(true);
  h.refreshLiveSessionsBeforeRead.mockResolvedValue({ attempted: 0, refreshed: 0 });
});

describe('sessions:timeline owner resolution', () => {
  it('uses canonical sessions:read-compatible refs for transcript turns', async () => {
    const tx = makeTx();

    await run('su-12345678-1234-4234-8234-123456789abc', tx);

    const timelineQuery = tx.mock.calls.find(
      (call) =>
        Array.isArray(call[0]) &&
        call[0].some(
          (part: unknown) =>
            typeof part === 'string' && part.includes('FROM harness_shared.session_turns'),
        ),
    );
    expect(timelineQuery?.slice(1)).toContain(SESSION_TURN_REF_PREFIX);
    const prefixParam = timelineQuery?.slice(1).indexOf(SESSION_TURN_REF_PREFIX) ?? -1;
    const templateParts = timelineQuery?.[0] as readonly string[] | undefined;
    expect(prefixParam).toBeGreaterThanOrEqual(0);
    expect(templateParts?.[prefixParam + 1]).toMatch(/^::text/);
  });

  it('includes historical tool calls only for a trusted signed role-spawn session alias', async () => {
    const owner = 'su-12345678-1234-4234-8234-123456789abc';
    const tx = makeTx();

    await run(owner, tx);

    const invocationQueries = tx.mock.calls.filter(
      (call) =>
        Array.isArray(call[0]) &&
        call[0].some(
          (part: unknown) =>
            typeof part === 'string' && part.includes('FROM harness_shared.tool_invocations'),
        ),
    );
    expect(invocationQueries).toHaveLength(2);

    const ownerPredicates = invocationQueries.map((query) => {
      const fragments = query.slice(1).filter((value) => {
        if (typeof value !== 'object' || value === null) return false;
        const strings = (value as { strings?: unknown }).strings;
        return Array.isArray(strings) && strings.join(' ').includes('coord_owner_id');
      }) as Array<{ strings: readonly string[]; values: unknown[] }>;
      expect(fragments).toHaveLength(1);
      return fragments[0]!;
    });

    // The page and audit count must consume the exact same owner clause. This
    // catches a future one-sided edit that would make entries and totals disagree.
    expect(ownerPredicates[1]).toEqual(ownerPredicates[0]);
    const sqlText = ownerPredicates[0]!.strings.join(' ');
    expect(sqlText).toContain('coord_owner_id =');
    expect(sqlText).toContain("principal_kind = 'harness'");
    expect(sqlText).toContain("principal_auth_method = 'spawn-url'");
    expect(sqlText).toContain("principal_trust = 'trusted'");
    expect(sqlText).toContain("metadata_json->'requestOrigin'->'query'->>'client'");
    expect(sqlText).toContain("'system:' || role || '/' ||");
    expect(ownerPredicates[0]!.values).toEqual([owner, owner, owner]);
  });

  it('normalizes a unique short owner handle before constructing the history query', async () => {
    const short = 'su-peer';
    const full = 'su-12345678-1234-4234-8234-123456789abc';
    h.resolveRecipients.mockResolvedValue({ resolved: [full], unknown: [], ambiguous: [] });
    const tx = makeTx();

    await run(short, tx);

    expect(h.resolveRecipients).toHaveBeenCalledWith([short], 'ws-test');
    expect(h.knownOwnerIdSet).not.toHaveBeenCalled();
    expect(tx.mock.calls.some((call) => call.slice(1).includes(full))).toBe(true);
    expect(tx.mock.calls.some((call) => call.slice(1).includes(short))).toBe(false);
  });

  it('keeps a full session-shaped owner id queryable after the live session ends', async () => {
    const full = 'su-12345678-1234-4234-8234-123456789abc';
    const tx = makeTx();

    await run(full, tx);

    expect(h.resolveRecipients).not.toHaveBeenCalled();
    expect(h.knownOwnerIdSet).not.toHaveBeenCalled();
    expect(tx.mock.calls.some((call) => call.slice(1).includes(full))).toBe(true);
  });

  it('refuses an ambiguous short owner handle instead of returning a valid-looking zero', async () => {
    const short = 'su-peer';
    const matches = [
      'su-12345678-1234-4234-8234-123456789abc',
      'su-87654321-4321-4234-8234-cba987654321',
    ];
    h.resolveRecipients.mockResolvedValue({
      resolved: [],
      unknown: [],
      ambiguous: [{ id: short, matches }],
    });

    const result = await run(short);

    expect((result as HandlerResult).isError).toBe(true);
    expect(errorBody(result)).toMatchObject({
      ok: false,
      error: 'owner_ambiguous',
      owner: short,
      matches,
    });
  });

  it('refuses an unknown short owner handle instead of querying an empty history', async () => {
    const short = 'su-missing';
    h.resolveRecipients.mockResolvedValue({ resolved: [], unknown: [short], ambiguous: [] });

    const result = await run(short);

    expect(errorBody(result)).toMatchObject({ ok: false, error: 'owner_not_found', owner: short });
    expect((result as HandlerResult).isError).toBe(true);
  });

  it('reports roster unavailability when recipient resolution had to pass the handle through', async () => {
    const short = 'su-peer';
    h.resolveRecipients.mockResolvedValue({ resolved: [short], unknown: [], ambiguous: [] });
    h.knownOwnerIdSet.mockResolvedValue(null);

    const result = await run(short);

    expect(errorBody(result)).toMatchObject({
      ok: false,
      error: 'owner_resolution_unavailable',
      owner: short,
    });
    expect((result as HandlerResult).isError).toBe(true);
  });

  it('returns a structured retryable result for raw PostgreSQL contention', async () => {
    const tx = makeTx();
    tx.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      if (
        Array.isArray(template) &&
        template.some(
          (part) => typeof part === 'string' && part.includes('FROM harness_shared.session_turns'),
        )
      ) {
        throw Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        });
      }
      return [];
    });

    const result = await run('su-12345678-1234-4234-8234-123456789abc', tx);

    expect(errorBody(result)).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
    });
    expect(errorBody(result).message).toMatch(/transient database contention/);
  });

  it('still rethrows non-contention query failures', async () => {
    const tx = makeTx();
    tx.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      if (
        Array.isArray(template) &&
        template.some(
          (part) => typeof part === 'string' && part.includes('FROM harness_shared.session_turns'),
        )
      ) {
        throw new Error('relation disappeared');
      }
      return [];
    });

    await expect(run('su-12345678-1234-4234-8234-123456789abc', tx)).rejects.toThrow(
      'relation disappeared',
    );
  });
});
