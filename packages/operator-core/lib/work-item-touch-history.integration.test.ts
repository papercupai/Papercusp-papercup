import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ db: null as FreshPgDb | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.db!.sql }),
}));
import { readWorkItemTouchHistory, WORK_ITEM_TOUCH_FILE_LIMIT, WORK_ITEM_TOUCH_SYMBOL_LIMIT } from './work-item-touch-history';

const scope = { workspaceId: 'ws', harness: 'papercusp', workItemId: 'WI-1' };
beforeAll(async () => {
  h.db = await createFreshPgDb('item-touch-history');
  await applyMigrationsForTest(h.db.sql, [
    '363-commit-attribution-ledger.sql',
    '364-edit-attribution-ledger-repo-root.sql',
    '784-edit-attribution-acquired-via.sql',
    '1367-edit-attribution-dispatch-call-id.sql',
    '1540-git-sync-commit-attribution-repo-committed-at.sql',
    // P-007's producer migration: the real nullable symbols text[] column and its indexes.
    '1584-edit-attribution-symbols.sql',
    '1587-edit-attribution-signal-eligibility.sql',
    '1599-edit-attribution-work-item-resolution.sql',
  ]);
}, 120_000);
afterAll(async () => { await h.db?.cleanup(); });
beforeEach(async () => { await h.db!.sql`TRUNCATE harness_shared.edit_attribution_ledger`; });

async function add(file: string, symbols: string[] | null, overrides: Partial<typeof scope> = {}) {
  const s = { ...scope, ...overrides };
  await h.db!.sql`
    INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, harness_slug, work_item_id, file, symbols, agent_id, ts)
    VALUES (${s.workspaceId}, ${s.harness}, ${s.workItemId}, ${file}, ${symbols}, 'agent', '2020-01-01')`;
}

describe('item touch history over the real edit ledger', () => {
  it('merges all historical rows, deduplicates symbols and keeps scope boundaries', async () => {
    await add('src/a.ts', ['z', 'a']);
    await add('src/a.ts', ['b', 'a']);
    await add('src/b.ts', ['other']);
    await add('secret.ts', ['foreign'], { workspaceId: 'other' });
    await add('secret.ts', ['foreign'], { harness: 'other' });
    await add('secret.ts', ['foreign'], { workItemId: 'WI-2' });
    expect(await readWorkItemTouchHistory(scope)).toEqual({
      status: 'available', totalFiles: 2, truncated: false,
      files: [
        { file: 'src/a.ts', symbols: ['a', 'b', 'z'], symbolsIncomplete: false, symbolsTruncated: false },
        { file: 'src/b.ts', symbols: ['other'], symbolsIncomplete: false, symbolsTruncated: false },
      ],
    });
  });

  it('distinguishes unknown, known empty and partly known symbols', async () => {
    await add('unknown.ts', null);
    await add('empty.ts', []);
    await add('mixed.ts', null);
    await add('mixed.ts', ['observed']);
    const result = await readWorkItemTouchHistory(scope);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.files).toEqual([
      { file: 'empty.ts', symbols: [], symbolsIncomplete: false, symbolsTruncated: false },
      { file: 'mixed.ts', symbols: ['observed'], symbolsIncomplete: true, symbolsTruncated: false },
      { file: 'unknown.ts', symbols: null, symbolsIncomplete: true, symbolsTruncated: false },
    ]);
  });

  it('bounds files and symbols after merging and discloses both caps', async () => {
    const symbols = Array.from({ length: WORK_ITEM_TOUCH_SYMBOL_LIMIT + 2 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    await add('000.ts', symbols);
    await h.db!.sql`
      INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, harness_slug, work_item_id, file, agent_id, symbols)
      SELECT 'ws', 'papercusp', 'WI-1', 'file-' || n || '.ts', 'agent', ARRAY[]::text[]
      FROM generate_series(1, ${WORK_ITEM_TOUCH_FILE_LIMIT}) AS n`;
    const result = await readWorkItemTouchHistory(scope);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.totalFiles).toBe(WORK_ITEM_TOUCH_FILE_LIMIT + 1);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(WORK_ITEM_TOUCH_FILE_LIMIT);
    expect(result.files[0].symbols).toEqual(symbols.slice(0, WORK_ITEM_TOUCH_SYMBOL_LIMIT));
    expect(result.files[0].symbolsTruncated).toBe(true);
  });

  it('reports a measured empty history separately from a missing scope', async () => {
    expect(await readWorkItemTouchHistory(scope)).toEqual({ status: 'available', totalFiles: 0, truncated: false, files: [] });
    expect(await readWorkItemTouchHistory({ ...scope, harness: null })).toEqual({ status: 'unavailable', reason: 'scope-unavailable' });
  });

  it('reports an unavailable ledger when the producer schema is not ready', async () => {
    await h.db!.sql`ALTER TABLE harness_shared.edit_attribution_ledger DROP COLUMN symbols`;
    try {
      expect(await readWorkItemTouchHistory(scope)).toEqual({ status: 'unavailable', reason: 'ledger-read-failed' });
    } finally {
      await h.db!.sql`ALTER TABLE harness_shared.edit_attribution_ledger ADD COLUMN symbols text[]`;
    }
  });
});
