import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shapeWorkItemsGet } from './get-shape';

const h = vi.hoisted(() => ({ read: vi.fn(), item: vi.fn(), txn: vi.fn() }));
vi.mock('../../work-item-touch-history', () => ({ readWorkItemTouchHistory: h.read }));
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.txn }));
vi.mock('../../work-items', () => ({
  getWorkItem: h.item, getWorkItemsByIds: vi.fn(), getWorkItemDetail: h.item,
  getWorkItemThreadWindow: vi.fn(), SETTLED_WORK_ITEM_STATES: ['done'],
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'test-workspace',
}));
import get from './get';

type TouchModule = typeof import('../../work-item-touch-history');
const actualTouch = () => vi.importActual<TouchModule>('../../work-item-touch-history');

const history = { status: 'available', totalFiles: 1, truncated: false, files: [
  { file: 'src/a.ts', symbols: ['run'], symbolsIncomplete: false, symbolsTruncated: false },
] };
beforeEach(() => {
  h.item.mockReset().mockResolvedValue({ id: 'WI-1', harness: 'canonical', state: 'open' });
  h.read.mockReset().mockResolvedValue(history);
  h.txn.mockReset();
});

async function call(pick: string[], ids = { id: 'WI-1' }) {
  return await get.handler({ ...ids, harness: 'request-alias' } as never, {
    workspaceId: 'test-workspace', sourceProjection: { pick },
  } as never) as { data: { results: Array<Record<string, unknown>> } };
}

/** One row per file, as the ledger query returns it after merging that file's ledger rows. */
function fileRow(file: string, symbols: string[], opts: { unknown?: boolean; allUnknown?: boolean; total?: number } = {}) {
  return {
    file, symbols, symbols_unknown: opts.unknown ?? false,
    symbols_all_unknown: opts.allUnknown ?? false, total_files: String(opts.total ?? 1),
  };
}

describe('work_items:get touch history', () => {
  it('returns the ledger history on an ordinary read, scoped to the resolved item', async () => {
    const result = await call(['results[].id', 'results[].touchHistory']);
    expect(result.data.results[0].touchHistory).toEqual(history);
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'test-workspace', harness: 'canonical', workItemId: 'WI-1',
    }));
  });

  it('does not read the ledger for unrelated source projections or absent items', async () => {
    await call(['results[].workItem.state']);
    expect(h.read).not.toHaveBeenCalled();
    h.item.mockResolvedValue(null);
    await call(['results[].touchHistory']);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('preserves an unavailable ledger without failing or inventing an empty list', async () => {
    h.read.mockResolvedValue({ status: 'unavailable', reason: 'ledger-read-failed' });
    const result = await call(['results[].touchHistory']);
    expect(result.data.results[0]).toMatchObject({ ok: true, touchHistory: { status: 'unavailable', reason: 'ledger-read-failed' } });
  });

  it.each(['standard', 'trimmed'] as const)('keeps small touch histories in the %s result tier', (tier) => {
    const result = shapeWorkItemsGet({ ok: true, counts: { ok: 1, failed: 0 }, results: [
      { ok: true, id: 'WI-1', workItem: { id: 'WI-1' }, touchHistory: history },
    ] }, tier) as { results: Array<Record<string, unknown>> };
    expect(result.results[0].touchHistory).toEqual(history);
  });
});

describe('readWorkItemTouchHistory result mapping', () => {
  it('lists each touched file with the symbols merged from its ledger rows', async () => {
    const { readWorkItemTouchHistory } = await actualTouch();
    h.txn.mockResolvedValue([
      fileRow('src/a.ts', ['parse', 'run'], { total: 2 }),
      fileRow('src/b.ts', ['emit'], { total: 2 }),
    ]);
    const result = await readWorkItemTouchHistory({ workspaceId: 'ws', harness: 'h', workItemId: 'WI-9' });
    expect(result).toEqual({
      status: 'available', totalFiles: 2, truncated: false, files: [
        { file: 'src/a.ts', symbols: ['parse', 'run'], symbolsIncomplete: false, symbolsTruncated: false },
        { file: 'src/b.ts', symbols: ['emit'], symbolsIncomplete: false, symbolsTruncated: false },
      ],
    });
  });

  it('reports truncation when more files were touched than the file limit returns', async () => {
    const { readWorkItemTouchHistory } = await actualTouch();
    h.txn.mockResolvedValue([fileRow('src/a.ts', ['run'], { total: 7 })]);
    const result = await readWorkItemTouchHistory({ workspaceId: 'ws', harness: 'h', workItemId: 'WI-9' });
    expect(result).toMatchObject({ status: 'available', totalFiles: 7, truncated: true });
  });

  it('reports a file whose rows all predate symbol capture as unknown symbols, not an empty list', async () => {
    const { readWorkItemTouchHistory } = await actualTouch();
    h.txn.mockResolvedValue([
      fileRow('src/old.ts', [], { unknown: true, allUnknown: true, total: 2 }),
      fileRow('src/mixed.ts', ['run'], { unknown: true, total: 2 }),
    ]);
    const result = await readWorkItemTouchHistory({ workspaceId: 'ws', harness: 'h', workItemId: 'WI-9' });
    expect(result.status === 'available' && result.files).toEqual([
      { file: 'src/old.ts', symbols: null, symbolsIncomplete: true, symbolsTruncated: false },
      { file: 'src/mixed.ts', symbols: ['run'], symbolsIncomplete: true, symbolsTruncated: false },
    ]);
  });

  it('caps the symbol list at the symbol limit and marks it truncated', async () => {
    const { readWorkItemTouchHistory, WORK_ITEM_TOUCH_SYMBOL_LIMIT } = await actualTouch();
    const many = Array.from({ length: WORK_ITEM_TOUCH_SYMBOL_LIMIT + 1 }, (_, i) => `fn${String(i).padStart(3, '0')}`);
    h.txn.mockResolvedValue([fileRow('src/big.ts', many)]);
    const result = await readWorkItemTouchHistory({ workspaceId: 'ws', harness: 'h', workItemId: 'WI-9' });
    const file = result.status === 'available' ? result.files[0] : null;
    expect(file?.symbols).toHaveLength(WORK_ITEM_TOUCH_SYMBOL_LIMIT);
    expect(file?.symbolsTruncated).toBe(true);
  });

  it('reports an unavailable ledger, never an empty edit list, when the read fails or scope is missing', async () => {
    const { readWorkItemTouchHistory } = await actualTouch();
    h.txn.mockRejectedValue(new Error('column "symbols" does not exist'));
    await expect(readWorkItemTouchHistory({ workspaceId: 'ws', harness: 'h', workItemId: 'WI-9' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'ledger-read-failed' });
    await expect(readWorkItemTouchHistory({ workspaceId: null, harness: 'h', workItemId: 'WI-9' }))
      .resolves.toEqual({ status: 'unavailable', reason: 'scope-unavailable' });
    expect(h.txn).toHaveBeenCalledTimes(1);
  });
});
