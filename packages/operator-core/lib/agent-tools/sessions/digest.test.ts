import { describe, expect, it, vi } from 'vitest';

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
}));

const tool = (await import('./digest')).default;

type Handler = (args: unknown, ctx: unknown) => Promise<unknown>;

function handler(): Handler {
  return (tool as unknown as { handler: Handler }).handler;
}

describe('sessions:digest time-window bounds', () => {
  it('normalizes a documented relative since window before binding PostgreSQL', async () => {
    const before = Date.now();
    const boundValues: unknown[] = [];
    const tx = vi.fn(async (_strings: unknown, ...values: unknown[]) => {
      boundValues.push(...values);
      return [];
    });

    const result = await handler()({ since: '14d' }, { workspaceId: 'ws-test', tx });

    // The fake counts every interpolated fragment as a call (postgres.js runs a tagged
    // template only when awaited), so count the statements by their text: ONE query.
    const statements = tx.mock.calls.map(([strings]) => (Array.isArray(strings) ? strings.join('?') : ''));
    expect(statements.filter((s) => s.includes('WITH scoped'))).toHaveLength(1);
    // D-006 (WI-10005570): the reader rule is part of the digest's scope, and a caller
    // with no identity is not an error — it reads as nobody (fail closed).
    expect(statements.some((s) => s.includes('harness_shared.personal_disclosures'))).toBe(true);
    expect(result).toMatchObject({ data: { ok: true, count: 0, total: 0, digests: [] } });
    const resolvedSince = boundValues.find(
      (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value),
    );
    expect(resolvedSince).toBeDefined();
    expect(Math.abs(Date.parse(resolvedSince!) - (before - 14 * 86_400_000))).toBeLessThan(10_000);
    expect(boundValues).not.toContain('14d');
  });

  it('rejects an invalid since bound before opening a database query', async () => {
    const tx = vi.fn();

    const result = await handler()({ since: 'yesterday-ish' }, { workspaceId: 'ws-test', tx });

    expect(tx).not.toHaveBeenCalled();
    // { data } envelope, not the legacy MCP content[0].text one: digest.ts signals the
    // invalid-bound rejection through the same `data` shape as its success path, so the
    // tool-data-shape ratchet holds. Reading `content` here strands on that contract.
    const { ok, error } = (result as { data: { ok: boolean; error: string } }).data;
    expect(ok).toBe(false);
    expect(error).toContain('relative window like "45m", "12h", "7d"');
  });
});
