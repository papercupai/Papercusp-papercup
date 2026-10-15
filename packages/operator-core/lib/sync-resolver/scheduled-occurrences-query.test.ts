import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ gather: vi.fn(), sql: vi.fn() }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: H.sql }),
}));
vi.mock('../workspace-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../workspace-registry')>(),
  activeWorkspaceId: () => 'calendar-test-workspace',
}));
vi.mock('../harness/routines/scheduled-occurrences', () => ({
  gatherScheduledOccurrences: (...args: unknown[]) => H.gather(...args),
}));

import { getRegistryEntryV2, MAX_SCHEDULED_OCCURRENCES_WINDOW_MS, resolveNamedQueryV2 } from './index';

const schema = getRegistryEntryV2('plans.scheduledOccurrences')?.argsSchema;

describe('plans.scheduledOccurrences argument guard', () => {
  it('rejects zero, negative, fractional, and unsafe millisecond bounds', () => {
    expect(schema).toBeDefined();
    expect(() => schema!.parse({ rangeStartMs: 0, rangeEndMs: 1 })).toThrow();
    expect(() => schema!.parse({ rangeStartMs: -1, rangeEndMs: 1 })).toThrow();
    expect(() => schema!.parse({ rangeStartMs: 1.5, rangeEndMs: 2 })).toThrow();
    expect(() => schema!.parse({ rangeStartMs: Number.MAX_SAFE_INTEGER + 1, rangeEndMs: 2 })).toThrow();
  });

  it('rejects inverted and pathological multi-year windows', () => {
    expect(schema).toBeDefined();
    expect(() => schema!.parse({ rangeStartMs: 2_000, rangeEndMs: 1_000 })).toThrow(
      'rangeEndMs must be greater than or equal to rangeStartMs',
    );
    expect(() =>
      schema!.parse({ rangeStartMs: 1_000, rangeEndMs: 1_000 + MAX_SCHEDULED_OCCURRENCES_WINDOW_MS + 1 }),
    ).toThrow('scheduled occurrence windows may not exceed three years');
  });

  it('accepts a normal calendar window, including an exact three-year boundary', () => {
    const rangeStartMs = Date.parse('2026-01-01T00:00:00.000Z');
    expect(schema!.parse({
      rangeStartMs,
      rangeEndMs: rangeStartMs + MAX_SCHEDULED_OCCURRENCES_WINDOW_MS,
      harnessSlug: 'papercusp',
    })).toMatchObject({ harnessSlug: 'papercusp' });
  });
});

describe('plans.scheduledOccurrences read failure contract', () => {
  const args = { rangeStartMs: Date.parse('2026-10-01T00:00:00Z'), rangeEndMs: Date.parse('2026-11-01T00:00:00Z'), harnessSlug: 'calendar-test-harness' };
  beforeEach(() => H.gather.mockReset());

  it('propagates an occurrence read failure so transport can report it instead of a successful empty array', async () => {
    H.gather.mockRejectedValueOnce(new Error('occurrence database unavailable'));
    await expect(resolveNamedQueryV2('plans.scheduledOccurrences', args)).rejects.toThrow('occurrence database unavailable');
  });

  it('preserves workspace, harness and range scope and returns the recovered occurrence rows', async () => {
    const rows = [{ templateSlug: 'calendar-test-plan', occurrenceMs: args.rangeStartMs + 1 }];
    H.gather.mockResolvedValueOnce(rows);
    await expect(resolveNamedQueryV2('plans.scheduledOccurrences', args)).resolves.toEqual(rows);
    expect(H.gather).toHaveBeenCalledWith(H.sql, { workspaceId: 'calendar-test-workspace', ...args });
  });

  it('preserves a genuinely empty successful read', async () => {
    H.gather.mockResolvedValueOnce([]);
    await expect(resolveNamedQueryV2('plans.scheduledOccurrences', args)).resolves.toEqual([]);
  });
});
