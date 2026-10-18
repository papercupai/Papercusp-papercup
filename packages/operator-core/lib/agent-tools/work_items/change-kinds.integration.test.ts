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
import {
  attachChangeKindDeclarations,
  completeChangeKindEligibility,
  declareChangeKinds,
  declaredChangeKindsById,
  readChangeKinds,
  writeSucceededEligibility,
} from '../../work-item-change-kinds';

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

describe('entry-point recording (claim, checkpoint, complete share attachChangeKindDeclarations)', () => {
  const base = { declaredBy: 'su-c', workspaceId: WS };

  it('declaredChangeKindsById keeps only entries that declared something', () => {
    const m = declaredChangeKindsById([
      { id: 'EI-10', changeKinds: ['ui'], changeKindReason: 'r' },
      { id: 'EI-11', changeKinds: [] },
      { id: 'EI-12' },
    ]);
    expect([...m.keys()]).toEqual(['EI-10']);
    expect(m.get('EI-10')).toEqual({ kinds: ['ui'], reason: 'r' });
  });

  it('claim and checkpoint record only a successful write, under the canonical workItem id', async () => {
    const declared = declaredChangeKindsById([
      { id: '6554700010099001', changeKinds: ['logic'] },
      { id: 'EI-21', changeKinds: ['docs'] },
      { id: 'EI-22' },
    ]);
    const results = await attachChangeKindDeclarations(
      {
        ...base,
        declared,
        step: 'claim',
        eligible: writeSucceededEligibility('claim'),
        results: [
          { ok: true, id: '6554700010099001', workItem: { id: 'WI-6554700010099001' } },
          { ok: false, id: 'EI-21', error: 'claim_conflict' },
          { ok: true, id: 'EI-22' },
        ],
      },
      db.sql,
    );
    expect(results[0]!.changeKinds).toEqual({ recorded: true, current: ['logic'], step: 'claim', previous: null });
    expect(results[1]!.changeKinds).toEqual({ recorded: false, error: 'changeKinds were not recorded: the claim did not succeed.' });
    expect(results[2]).toEqual({ ok: true, id: 'EI-22' });

    const views = await readChangeKinds(WS, ['WI-6554700010099001', '6554700010099001', 'EI-21'], db.sql);
    expect(views.get('WI-6554700010099001')!.current).toEqual(['logic']);
    expect(views.get('6554700010099001')!.history).toEqual([]);
    expect(views.get('EI-21')!.history).toEqual([]);
  });

  it('complete records a refused close that wrote a completion record, and skips previews and early refusals', async () => {
    const declared = declaredChangeKindsById([
      { id: 'EI-30', changeKinds: ['ui'] },
      { id: 'EI-31', changeKinds: ['service'] },
      { id: 'EI-32', changeKinds: ['migration'] },
      { id: 'EI-33', changeKinds: ['config'] },
    ]);
    const results = await attachChangeKindDeclarations(
      {
        ...base,
        declared,
        step: 'complete',
        eligible: completeChangeKindEligibility,
        results: [
          { ok: false, id: 'EI-30', completion: { summary: 's' }, stateError: 'REJECTED' },
          { ok: true, id: 'EI-31', validationOnly: true },
          { ok: false, id: 'EI-32', error: 'not held' },
          { ok: true, id: 'EI-33', completion: { summary: 's' } },
        ],
      },
      db.sql,
    );
    expect(results[0]!.changeKinds).toMatchObject({ recorded: true, step: 'complete', current: ['ui'] });
    expect(results[1]).toEqual({ ok: true, id: 'EI-31', validationOnly: true });
    expect(results[2]!.changeKinds).toEqual({
      recorded: false,
      error: 'changeKinds were not recorded: this call wrote no completion record.',
    });
    expect(results[3]!.changeKinds).toMatchObject({ recorded: true, step: 'complete', current: ['config'] });

    const views = await readChangeKinds(WS, ['EI-30', 'EI-31', 'EI-32'], db.sql);
    expect(views.get('EI-30')!.history.map((h) => h.step)).toEqual(['complete']);
    expect(views.get('EI-31')!.history).toEqual([]);
    expect(views.get('EI-32')!.history).toEqual([]);
  });

  it('keeps one history entry per step across create, claim, checkpoint and complete', async () => {
    const id = 'EI-40';
    await declareChangeKinds({ workspaceId: WS, featureId: id, kinds: ['ui'], step: 'create', declaredBy: 'su-c' }, db.sql);
    const steps = [
      { step: 'claim' as const, eligible: writeSucceededEligibility('claim'), kinds: ['ui', 'logic'], extra: {} },
      { step: 'checkpoint' as const, eligible: writeSucceededEligibility('checkpoint write'), kinds: ['ui', 'logic', 'service'], extra: {} },
      { step: 'complete' as const, eligible: completeChangeKindEligibility, kinds: ['ui', 'service'], extra: { completion: { summary: 's' } } },
    ];
    for (const s of steps) {
      const [r] = await attachChangeKindDeclarations(
        {
          ...base,
          declared: declaredChangeKindsById([{ id, changeKinds: s.kinds, changeKindReason: s.step === 'complete' ? 'logic moved out' : null }]),
          step: s.step,
          eligible: s.eligible,
          results: [{ ok: true, id, ...s.extra }],
        },
        db.sql,
      );
      expect(r!.changeKinds).toMatchObject({ recorded: true, step: s.step });
    }
    const view = (await readChangeKinds(WS, [id], db.sql)).get(id)!;
    expect(view.current).toEqual(['ui', 'service']);
    expect(view.history.map((h) => [h.step, h.kinds, h.declaredBy, h.reason])).toEqual([
      ['create', ['ui'], 'su-c', null],
      ['claim', ['ui', 'logic'], 'su-c', null],
      // stored in catalog order, not call order
      ['checkpoint', ['ui', 'service', 'logic'], 'su-c', null],
      ['complete', ['ui', 'service'], 'su-c', 'logic moved out'],
    ]);
    for (const h of view.history) expect(Number.isNaN(Date.parse(h.declaredAt))).toBe(false);
  });
});
