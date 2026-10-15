import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  evaluateRoutineEngineLiveness,
  readRoutineEngineLiveness,
} from './routine-engine-liveness';

const NOW_MS = Date.parse('2026-09-23T05:33:00.000Z');

afterEach(() => vi.unstubAllEnvs());

describe('evaluateRoutineEngineLiveness', () => {
  it('considers a recent successful tick live', () => {
    expect(evaluateRoutineEngineLiveness(NOW_MS - 30_000, NOW_MS)).toMatchObject({
      stale: false,
      unknown: false,
      staleMs: 30_000,
    });
  });

  it('considers an old successful tick stale', () => {
    expect(evaluateRoutineEngineLiveness(NOW_MS - 7 * 60_000, NOW_MS)).toMatchObject({
      stale: true,
      unknown: false,
      staleMs: 7 * 60_000,
    });
  });

  it('keeps a missing tick measurement unknown', () => {
    expect(evaluateRoutineEngineLiveness(null, NOW_MS)).toMatchObject({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
  });
});

describe('readRoutineEngineLiveness', () => {
  it.each([
    { workflow_status: false, operation_outputs: false },
    { workflow_status: true, operation_outputs: false },
    { workflow_status: false, operation_outputs: true },
  ])('does not query absent watermark relations: %j', async (relations) => {
    const mockSql = vi.fn(async (_strings: TemplateStringsArray) => [relations]);

    await expect(readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS })).resolves.toEqual({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
    expect(mockSql).toHaveBeenCalledOnce();
    const query = mockSql.mock.calls[0]![0];
    expect(query.join(' ')).toContain("to_regclass('dbos.workflow_status')");
    expect(query.join(' ')).toContain("to_regclass('dbos.operation_outputs')");
  });

  it('reads the shared background watermark when DBOS is disabled on this request worker', async () => {
    vi.stubEnv('PAPERCUSP_DBOS_ENABLE', '0');
    const mockSql = vi.fn(async (strings: TemplateStringsArray) => strings.join(' ').includes('to_regclass')
      ? [{ workflow_status: true, operation_outputs: true }]
      : [{ last_tick_ms: NOW_MS - 2_000 }]);

    await expect(readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS })).resolves.toMatchObject({
      stale: false,
      unknown: false,
      staleMs: 2_000,
    });
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('reads ticks that completed the due-routine step, not successful early returns', async () => {
    let queryText = '';
    const mockSql = (strings: TemplateStringsArray) => {
      queryText = strings.join(' ');
      if (queryText.includes('to_regclass')) return Promise.resolve([{ workflow_status: true, operation_outputs: true }]);
      return Promise.resolve([{ last_tick_ms: NOW_MS - 2_000 }]);
    };

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({ stale: false, unknown: false, staleMs: 2_000 });
    expect(queryText).toContain('MAX(tick.completed_at)');
    expect(queryText).toContain("status = 'SUCCESS'");
    expect(queryText).toContain('dbos.operation_outputs');
    expect(queryText).toContain("function_name = 'list-due-routines'");
    expect(queryText).toContain('operation.error IS NULL');
    expect(queryText).not.toContain('MAX(created_at)');
  });

  it('parses the PostgreSQL timestamp string returned by the pooled getOrgPg client', async () => {
    const mockSql = (strings: TemplateStringsArray) => Promise.resolve(strings.join(' ').includes('to_regclass')
      ? [{ workflow_status: true, operation_outputs: true }]
      : [{ last_tick_ms: '2026-09-23 01:32:58.000-04' }]);

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({
      lastTickMs: NOW_MS - 2_000,
      stale: false,
      unknown: false,
      staleMs: 2_000,
    });
  });

  it('keeps an unparseable timestamp unknown', async () => {
    const mockSql = (strings: TemplateStringsArray) => Promise.resolve(strings.join(' ').includes('to_regclass')
      ? [{ workflow_status: true, operation_outputs: true }]
      : [{ last_tick_ms: 'not-a-timestamp' }]);

    await expect(readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS })).resolves.toMatchObject({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
  });

  it('keeps an early-return SUCCESS with no due-routine step unknown', async () => {
    let queryText = '';
    const mockSql = (strings: TemplateStringsArray) => {
      queryText = strings.join(' ');
      if (queryText.includes('to_regclass')) return Promise.resolve([{ workflow_status: true, operation_outputs: true }]);
      return Promise.resolve([{ last_tick_ms: null }]);
    };

    const result = await readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS });

    expect(result).toMatchObject({ stale: false, unknown: true, lastTickMs: null, staleMs: null });
    expect(queryText).toContain("function_name = 'list-due-routines'");
  });

  it('keeps query failures unknown rather than inventing scheduler liveness', async () => {
    const mockSql = () => Promise.reject(new Error('database unavailable'));

    await expect(readRoutineEngineLiveness(mockSql as unknown as Sql, { nowMs: NOW_MS })).resolves.toMatchObject({
      stale: false,
      unknown: true,
      lastTickMs: null,
      staleMs: null,
    });
  });
});
