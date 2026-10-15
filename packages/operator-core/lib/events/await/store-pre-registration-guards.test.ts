import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  boundedOrgTxn: vi.fn(),
  rawSql: vi.fn(),
  tx: Object.assign(vi.fn(), { array: vi.fn() }),
}));

vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.rawSql }),
}));

const { AWAIT_SUPERSEDED_BY_REGISTRATION, cancelAwaitsForSubscribersOnKeys, findAnnouncementsForKey, registerAwait } =
  await import('./store');

const boundedOptions = {
  acquireTimeoutMs: 5_000,
  statementTimeoutMs: 5_000,
  lockTimeoutMs: 5_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.boundedOrgTxn.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(h.tx));
  h.tx.array.mockImplementation((values: unknown[]) => values);
  h.tx.mockImplementation(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    if (query.includes('SELECT *') && query.includes('causal_generation')) return [];
    if (query.includes('causal_generation')) {
      return [{ causal_generation: 7, fired_at: null, fired_reason: null, cancelled_at: null, superseded_at: null }];
    }
    return query.includes('SELECT *')
      ? []
      : [
          {
            id: 1,
            workspace_id: 'ws-test',
            subscriber_id: 'sub-test',
            event_key: 'gate:test',
            policy: 'wake',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ];
  });
});

describe('events:await pre-registration store guards', () => {
  it('bounds announcement lookup before an await can be registered', async () => {
    await expect(findAnnouncementsForKey('gate:test')).resolves.toEqual([]);

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.tx).toHaveBeenCalledTimes(1);
    expect(h.rawSql).not.toHaveBeenCalled();
  });

  it('bounds supersede cancellation before an await can be registered', async () => {
    await expect(cancelAwaitsForSubscribersOnKeys(['sub-a'], ['gate:test'])).resolves.toBe(1);

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    // Two optional SQL fragments (`once` + note scope) are composed through
    // the same tagged-template seam before the UPDATE itself executes, then the
    // queued-delivery settle runs through that SAME seam as a fourth call — it is
    // threaded `{ client: tx }` so it stays inside these bounds. That fourth call
    // is the point of the assertion, not an incidental count: before WI-1215582 the
    // settle omitted the client and fell through to the UNBOUNDED `getOrgPg().sql`,
    // which is what `h.rawSql` below catches. Read the two together — a drop back to
    // 3 here means the settle left the transaction, not that it stopped running.
    expect(h.tx).toHaveBeenCalledTimes(4);
    expect(h.rawSql).not.toHaveBeenCalled();
  });

  it('bounds supersede-and-insert registration', async () => {
    await expect(
      registerAwait({
        subscriberId: 'sub-test',
        eventKey: 'gate:test',
        note: 'surface: current',
        supersedePending: { includeNotePrefix: 'surface: ' },
      }),
    ).resolves.toMatchObject({ id: 1, supersededPendingCount: 1 });

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.rawSql).not.toHaveBeenCalled();
  });

  // WI-10005938: a registration that retires a pending row must say why. A NULL
  // cancel_reason made 22 superseded obligation watches read as unexplained
  // churn, and the caller's later measured reason could no longer land.
  it.each([
    ['exact one-shot dedup', { subscriberId: 'sub-test', eventKey: 'gate:test' }],
    [
      'supersedePending',
      { subscriberId: 'sub-test', eventKey: 'gate:test', note: 'surface: current', supersedePending: { includeNotePrefix: 'surface: ' } },
    ],
  ] as const)('stamps a cancel_reason on every row a registration retires (%s)', async (_label, input) => {
    await registerAwait(input as Parameters<typeof registerAwait>[0]);

    const retires = h.tx.mock.calls.filter(([strings]) => {
      const query = Array.isArray(strings) ? strings.join('?') : '';
      return /UPDATE\s+harness_shared\.event_awaits/.test(query) && /SET\s+cancelled_at\s*=\s*now\(\)/.test(query);
    });
    expect(retires.length).toBeGreaterThan(0);
    for (const [strings, ...values] of retires) {
      expect((strings as readonly string[]).join('?')).toMatch(/cancel_reason\s*=\s*\?/);
      expect(values).toContain(AWAIT_SUPERSEDED_BY_REGISTRATION);
    }
  });

  it('bounds generation-pinned registration', async () => {
    await expect(
      registerAwait({ subscriberId: 'sub-test', eventKey: 'gate:test', expectedGeneration: 7 }),
    ).resolves.toMatchObject({ id: 1 });

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.rawSql).not.toHaveBeenCalled();
  });

  it('bounds ordinary exact one-shot registration', async () => {
    await expect(registerAwait({ subscriberId: 'sub-test', eventKey: 'gate:test' })).resolves.toMatchObject({ id: 1 });

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.rawSql).not.toHaveBeenCalled();
  });

  it('bounds the legacy standing-watch insert instead of using raw SQL', async () => {
    await expect(
      registerAwait({ subscriberId: 'sub-test', eventKey: 'gate:test', once: false }),
    ).resolves.toMatchObject({ id: 1 });

    expect(h.boundedOrgTxn).toHaveBeenCalledWith(expect.any(Function), boundedOptions);
    expect(h.rawSql).not.toHaveBeenCalled();
  });
});
