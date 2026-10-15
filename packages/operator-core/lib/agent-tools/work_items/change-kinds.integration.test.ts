/**
 * Plan change-kind-declared-proof-2026-10-15, P-001 / R-1 — real Postgres.
 *
 * Applies migration 1518 to a throwaway database and drives the storage functions the
 * work_items entry points call: a declaration is stored with who, when and at which step;
 * re-declaring keeps the earlier row as history; unknown kinds and empty sets never reach
 * the table; the table's own CHECKs refuse a bad step or an empty kinds array from a caller
 * that bypasses the code path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { declareChangeKinds, readChangeKinds } from '../../work-item-change-kinds';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const MIGRATION = '1518-work-item-change-kind-declarations.sql';

function migrationText(): string {
  const armed = resolve(SQL_DIR, MIGRATION);
  const path = existsSync(armed) ? armed : `${armed}.DRAFT`;
  return readFileSync(path, 'utf8');
}

const WS = 'ws-change-kinds';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('change-kinds');
  await db.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await db.sql.unsafe(migrationText());
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('work-item change-kind declarations (migration 1518)', () => {
  it('stores a declaration with who, when and step, and reads it back as current', async () => {
    const res = await declareChangeKinds(
      { workspaceId: WS, featureId: 'EI-1', kinds: ['logic', 'ui'], step: 'claim', declaredBy: 'su-a' },
      db.sql,
    );
    expect(res).toEqual({ recorded: true, current: ['ui', 'logic'], step: 'claim', previous: null });

    const view = (await readChangeKinds(WS, ['EI-1'], db.sql)).get('EI-1')!;
    expect(view.current).toEqual(['ui', 'logic']);
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toMatchObject({ kinds: ['ui', 'logic'], step: 'claim', declaredBy: 'su-a', reason: null });
    expect(Number.isNaN(Date.parse(view.history[0]!.declaredAt))).toBe(false);
  });

  it('a re-declaration becomes current and keeps the earlier one as history, oldest first', async () => {
    await declareChangeKinds({ workspaceId: WS, featureId: 'EI-2', kinds: ['ui'], step: 'create', declaredBy: 'su-a' }, db.sql);
    await declareChangeKinds({ workspaceId: WS, featureId: 'EI-2', kinds: ['ui', 'service'], step: 'checkpoint', declaredBy: 'su-a' }, db.sql);
    const third = await declareChangeKinds(
      { workspaceId: WS, featureId: 'EI-2', kinds: ['service'], step: 'complete', declaredBy: 'su-b', reason: 'the UI part moved to EI-3' },
      db.sql,
    );
    expect(third).toEqual({ recorded: true, current: ['service'], step: 'complete', previous: ['ui', 'service'] });

    const view = (await readChangeKinds(WS, ['EI-2'], db.sql)).get('EI-2')!;
    expect(view.current).toEqual(['service']);
    expect(view.history.map((h) => [h.step, h.kinds, h.declaredBy, h.reason])).toEqual([
      ['create', ['ui'], 'su-a', null],
      ['checkpoint', ['ui', 'service'], 'su-a', null],
      ['complete', ['service'], 'su-b', 'the UI part moved to EI-3'],
    ]);
  });

  it('refuses an unknown kind and an empty set without writing a row', async () => {
    const unknown = await declareChangeKinds(
      { workspaceId: WS, featureId: 'EI-4', kinds: ['ui', 'frontend'], step: 'claim', declaredBy: 'su-a' },
      db.sql,
    );
    expect(unknown).toEqual({ recorded: false, error: 'unknown change kind(s): frontend' });
    const empty = await declareChangeKinds({ workspaceId: WS, featureId: 'EI-4', kinds: [], step: 'claim', declaredBy: 'su-a' }, db.sql);
    expect(empty.recorded).toBe(false);
    const view = (await readChangeKinds(WS, ['EI-4'], db.sql)).get('EI-4')!;
    expect(view).toEqual({ current: null, history: [] });
  });

  it('scopes reads by workspace and returns an empty view for items never declared', async () => {
    await declareChangeKinds({ workspaceId: 'other-ws', featureId: 'EI-5', kinds: ['docs'], step: 'claim', declaredBy: 'su-a' }, db.sql);
    const views = await readChangeKinds(WS, ['EI-5', 'EI-1'], db.sql);
    expect(views.get('EI-5')).toEqual({ current: null, history: [] });
    expect(views.get('EI-1')!.current).toEqual(['ui', 'logic']);
  });

  it('the table refuses a bad step and an empty kinds array from a direct insert', async () => {
    await expect(
      db.sql`INSERT INTO harness_shared.work_item_change_kind_declarations (workspace_id, feature_id, kinds, step, declared_by)
             VALUES (${WS}, 'EI-6', ${['ui']}, 'release', 'su-a')`,
    ).rejects.toThrow(/check/i);
    await expect(
      db.sql`INSERT INTO harness_shared.work_item_change_kind_declarations (workspace_id, feature_id, kinds, step, declared_by)
             VALUES (${WS}, 'EI-6', ${[] as string[]}, 'claim', 'su-a')`,
    ).rejects.toThrow(/check/i);
  });

  it('reports a storage failure instead of throwing', async () => {
    const broken = (() => {
      throw new Error('connection refused');
    }) as unknown as typeof db.sql;
    const res = await declareChangeKinds({ workspaceId: WS, featureId: 'EI-7', kinds: ['ui'], step: 'claim', declaredBy: 'su-a' }, broken);
    expect(res).toEqual({ recorded: false, error: 'change-kind declaration not stored: connection refused' });
  });
});
