/**
 * The inbox recipient predicate must stay in PostgreSQL's native JSONB
 * membership operator form. `coord_event_log_msgs_to_gin` can answer `?`, while
 * the equivalent `jsonb_exists(...)` spelling falls back to a parallel
 * sequential scan of the whole messages surface (EI-22716128794728115).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const { sqlMock, readLinesMock, fastPathState } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  readLinesMock: vi.fn(async () => [] as unknown[]),
  fastPathState: { on: false },
}));

vi.mock('./log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => fastPathState.on,
}));

import type { CoordEnvelope } from '@papercusp/coordination/core';
import {
  dropAgedBroadcasts,
  INBOX_BROADCAST_HORIZON_MS,
  inboxBroadcastCutoff,
  readInbox,
  readInboxWindow,
} from './messages';

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: '2026-09-08T20:00:00.000Z',
    msg_id: 'm1',
    from: 'bob',
    to: ['alice'],
    kind: 'message',
    ...p,
  } as CoordEnvelope;
}

/**
 * The conditional SQL fragments are evaluated before the outer tagged query,
 * so return a fragment-shaped value for them and rows only for SELECTs.
 */
function primeSql(rows: { body: unknown; ts?: unknown; msg_id?: string; id?: number }[]) {
  const seen: { text: string; values: unknown[] }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (!text.includes('SELECT')) return { fragment: text, values };
    seen.push({ text, values });
    return Promise.resolve(rows);
  });
  return seen;
}

function renderSqlValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderSqlValue).join(' ');
  if (value && typeof value === 'object') {
    const record = value as { fragment?: unknown; values?: unknown };
    return [record.fragment, record.values].map(renderSqlValue).join(' ');
  }
  return '';
}

function renderedQuery(query: { text: string; values: unknown[] }): string {
  return [query.text, ...query.values.map(renderSqlValue)].join(' ').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  fastPathState.on = true;
  readLinesMock.mockResolvedValue([]);
});

describe('readInbox recipient predicate remains GIN-indexable', () => {
  it('uses native JSONB ? membership in the single-shot fast path', async () => {
    const seen = primeSql([{ body: env() }]);

    await readInbox('alice');

    expect(seen).toHaveLength(1);
    const text = renderedQuery(seen[0]!);
    expect(text).toContain("(body->'to') ?");
    expect(text).not.toContain('jsonb_exists');
  });

  it('uses the same native predicate in the keyset-paged path', async () => {
    const seen = primeSql([]);

    const result = await readInboxWindow('alice', {}, () => false);

    expect(result.exhausted).toBe(true);
    expect(seen).toHaveLength(1);
    const text = renderedQuery(seen[0]!);
    expect(text).toContain("(body->'to') ?");
    expect(text).not.toContain('jsonb_exists');
  });

  it('returns the indexed id for a legacy row whose body carries a conflicting id', async () => {
    primeSql([{
      body: env({ msg_id: 'legacy-stale-body-id' }),
      ts: '2026-09-08T20:00:00.000Z',
      msg_id: 'row-canonical-id',
    }]);

    const entries = await readInbox('alice');

    expect(entries.map((entry) => entry.msg_id)).toContain('row-canonical-id');
  });

  it('keeps the indexed id in the keyset-paged inbox path too', async () => {
    primeSql([{
      id: 1,
      body: env({ msg_id: 'legacy-stale-body-id' }),
      ts: '2026-09-08T20:00:00.000Z',
      msg_id: 'row-canonical-id',
    }]);

    const page = await readInboxWindow('alice');

    expect(page.entries.map((entry) => entry.msg_id)).toContain('row-canonical-id');
  });
});

/**
 * WI-6554700010029423: broadcast rows only enter an inbox read inside
 * INBOX_BROADCAST_HORIZON_MS. Without the bound, every read lacking a tight
 * since_ts decoded the newest 25,000 broadcast bodies (182k in retention), which
 * drove the :3070 request workers into memory-watchdog recycles and event-loop
 * wedge kills that dropped every MCP connection on the worker.
 */
describe('readInbox broadcast read horizon', () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const aged = new Date(now - INBOX_BROADCAST_HORIZON_MS - 60 * 60_000).toISOString();
  const rows = () => [
    { body: env({ msg_id: 'old-bcast', to: ['*'], ts: aged }), ts: aged, msg_id: 'old-bcast', id: 3 },
    { body: env({ msg_id: 'old-direct', to: ['alice'], ts: aged }), ts: aged, msg_id: 'old-direct', id: 2 },
    { body: env({ msg_id: 'new-bcast', to: ['*'], ts: fresh }), ts: fresh, msg_id: 'new-bcast', id: 1 },
  ];

  it('bounds only the broadcast arm by ts in the single-shot SQL', async () => {
    const seen = primeSql([]);
    await readInbox('alice');
    const text = renderedQuery(seen[0]!);
    expect(text).toMatch(/\(body->'to'\) \? '\*' AND ts >= /);
    // the directed arm stays unbounded: the owner predicate is not ANDed with ts
    expect(text).toMatch(/\(\(body->'to'\) \? \S+ OR \(\(body->'to'\) \? '\*' AND ts >= /);
  });

  it('bounds the broadcast arm by ts in the keyset-paged SQL too', async () => {
    const seen = primeSql([]);
    await readInboxWindow('alice', {}, () => false);
    expect(renderedQuery(seen[0]!)).toMatch(/\(body->'to'\) \? '\*' AND ts >= /);
  });

  it('drops aged broadcasts but keeps aged directed mail and fresh broadcasts (PG fast path)', async () => {
    primeSql(rows());
    const ids = (await readInbox('alice')).map((e) => e.msg_id);
    expect(ids).toEqual(expect.arrayContaining(['old-direct', 'new-bcast']));
    expect(ids).not.toContain('old-bcast');
  });

  it('applies the same horizon in the keyset-paged path', async () => {
    primeSql(rows());
    const ids = (await readInboxWindow('alice')).entries.map((e) => e.msg_id);
    expect(ids).toEqual(expect.arrayContaining(['old-direct', 'new-bcast']));
    expect(ids).not.toContain('old-bcast');
  });

  it('applies the same horizon on the non-PG seam', async () => {
    fastPathState.on = false;
    readLinesMock.mockResolvedValue(rows().map((r) => r.body));
    const ids = (await readInbox('alice')).map((e) => e.msg_id);
    expect(ids).toEqual(expect.arrayContaining(['old-direct', 'new-bcast']));
    expect(ids).not.toContain('old-bcast');
  });

  it('keeps a broadcast that also names the owner, and a row whose ts cannot be parsed', () => {
    const out = dropAgedBroadcasts(
      [
        env({ msg_id: 'both', to: ['*', 'alice'], ts: aged }),
        env({ msg_id: 'undated', to: ['*'], ts: 'not-a-date' }),
        env({ msg_id: 'aged-bcast', to: ['*'], ts: aged }),
      ],
      'alice',
      inboxBroadcastCutoff(now),
    );
    expect(out.map((e) => e.msg_id)).toEqual(['both', 'undated']);
  });
});
