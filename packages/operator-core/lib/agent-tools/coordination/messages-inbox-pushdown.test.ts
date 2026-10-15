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
import { readInbox, readInboxWindow } from './messages';

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
