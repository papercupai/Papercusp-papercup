/**
 * P-005 reconcile — the properties that are expensive to get wrong.
 *
 * The centre of gravity is D-002's asymmetry: an UNREACHABLE app must change
 * nothing, while a REACHABLE app reporting an empty cursor must be refilled.
 * Those two look alike in code and are opposites in effect, so they get direct
 * tests rather than being implied by a happy path.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  appDataProducerReconcileSweep,
  encodeReconcileCursor,
  parseReconcileCursor,
  reconcileOnePair,
  type CanonicalRow,
  type ReconcileDeps,
} from './reconcile';

const SQL = {} as unknown as Sql;
const WORKSPACE = 'papercusp-workspace';
const USER = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-abc';

function row(id: string, at: string, externalId = `ext-${id}`): CanonicalRow {
  return {
    id,
    source: 'gmail',
    // D-010: the stamped datatype, not the provider-named source, routes the row.
    datatypeId: 'email-message',
    kind: 'message',
    externalId,
    occurredAt: at,
    title: 'Subject',
    text: 'Body',
    metadata: { from: 'ada@example.com' },
    cursorAt: at,
  };
}

/** Deps whose every external edge is stubbed; each test overrides what it cares about. */
function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    fetchCursor: vi.fn(async () => ({ reachable: true, cursor: null })),
    selectRows: vi.fn(async () => []),
    deliver: vi.fn(async () => ({ app: 'email' as const, ownerId: OWNER, status: 200, rowCount: 0, response: null })),
    ...over,
  };
}

const PAIR = { userId: USER, app: 'email' as const, ownerId: OWNER };

/**
 * Recorded calls of a stub, positionally.
 *
 * `vi.fn(async () => ...)` infers a ZERO-arg signature, so `.mock.calls[i][n]`
 * is a type error even though the call is recorded correctly at runtime. Read
 * them through here rather than widening each stub's declaration.
 */
function callsOf(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

describe('reconcile cursor encoding', () => {
  it('round-trips', () => {
    const c = { at: '2026-08-30T12:00:00.000Z', id: 'abc-1' };
    expect(parseReconcileCursor(encodeReconcileCursor(c))).toEqual(c);
  });

  it('treats absent, blank and malformed cursors as "start from the beginning"', () => {
    // Not an error path: delivery is an idempotent upsert, so re-sending is
    // safe, whereas failing would strand the app on a bad value permanently.
    for (const bad of [null, undefined, '', '   ', 'no-separator', '|only-id', 'not-a-date|abc']) {
      expect(parseReconcileCursor(bad as string | null | undefined)).toBeNull();
    }
  });

  it('keeps the id tiebreak when the timestamp itself contains no pipe', () => {
    const parsed = parseReconcileCursor('2026-08-30T12:00:00.000Z|11111111-1111-4111-8111-111111111111');
    expect(parsed?.id).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('D-002 — the two skip cases must not collapse', () => {
  it('UNREACHABLE app: skips the run and does not read or deliver anything', async () => {
    const d = deps({
      fetchCursor: vi.fn(async () => ({ reachable: false, cursor: null, error: 'ECONNREFUSED' })),
    });
    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('app_unreachable');
    expect(result.rowsDelivered).toBe(0);
    // The load-bearing assertion: an unreachable app must not cause a refill.
    expect(d.selectRows).not.toHaveBeenCalled();
    expect(d.deliver).not.toHaveBeenCalled();
  });

  it('REACHABLE app with an EMPTY cursor: refills from the beginning', async () => {
    const selectRows = vi.fn(async () => [row('r1', '2026-08-30T10:00:00.000Z')]);
    const d = deps({
      fetchCursor: vi.fn(async () => ({ reachable: true, cursor: null })),
      selectRows,
    });
    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);

    expect(result.outcome).toBe('delivered');
    expect(result.rowsDelivered).toBe(1);
    // Selected with a null cursor — i.e. from row zero, the self-healing case.
    expect(callsOf(selectRows)[0][4]).toBeNull();
  });

  it('a thrown cursor probe is a SKIP, not an error that restarts from zero', async () => {
    const d = deps({
      fetchCursor: vi.fn(async () => {
        throw new Error('dns exploded');
      }),
    });
    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);
    expect(result.outcome).toBe('skipped');
    expect(d.selectRows).not.toHaveBeenCalled();
  });
});

describe('reconcile paging and cursor advance', () => {
  it('resumes from the app-reported cursor rather than the beginning', async () => {
    const selectRows = vi.fn(async () => []);
    const d = deps({
      fetchCursor: vi.fn(async () => ({
        reachable: true,
        cursor: '2026-08-30T09:00:00.000Z|prior-row',
      })),
      selectRows,
    });
    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);

    expect(result.outcome).toBe('up-to-date');
    expect(callsOf(selectRows)[0][4]).toEqual({ at: '2026-08-30T09:00:00.000Z', id: 'prior-row' });
  });

  it('pages within one run and sends the LAST row of each page as the next cursor', async () => {
    const pages = [
      [row('a', '2026-08-30T10:00:00.000Z'), row('b', '2026-08-30T10:00:01.000Z')],
      [row('c', '2026-08-30T10:00:02.000Z')],
    ];
    let call = 0;
    const deliver = vi.fn(async () => ({ app: 'email' as const, ownerId: OWNER, status: 200, rowCount: 0, response: null }));
    const d = deps({
      batchSize: 2,
      selectRows: vi.fn(async () => pages[call++] ?? []),
      deliver,
    });

    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);

    expect(result.rowsDelivered).toBe(3);
    expect(result.batches).toBe(2);
    // Each batch carries the cursor of its own last row, so a crash between
    // batches resumes at the right place rather than re-sending page one.
    expect((callsOf(deliver)[0][0] as { body: { cursor?: string } }).body.cursor).toBe('2026-08-30T10:00:01.000Z|b');
    expect((callsOf(deliver)[1][0] as { body: { cursor?: string } }).body.cursor).toBe('2026-08-30T10:00:02.000Z|c');
    expect(result.cursor).toBe('2026-08-30T10:00:02.000Z|c');
  });

  it('reports `more` when it stops at the per-run cap', async () => {
    const d = deps({
      batchSize: 2,
      maxRowsPerRun: 2,
      selectRows: vi.fn(async () => [row('a', '2026-08-30T10:00:00.000Z'), row('b', '2026-08-30T10:00:01.000Z')]),
    });
    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);
    expect(result.rowsDelivered).toBe(2);
    expect(result.more).toBe(true);
  });

  it('steps OVER an unmappable row AND tells the app, so the next RUN resumes past it', async () => {
    // A row with no external id throws in the mapper. Advancing only the local
    // cursor is not enough: the app owns the watermark (D-002), so a row the
    // sweep skipped is re-read on every later run unless the app is told. The
    // flush is a rows-empty batch carrying the advanced cursor.
    const bad = row('bad', '2026-08-30T10:00:00.000Z', '');
    let call = 0;
    const deliver = vi.fn(async () => ({ app: 'email' as const, ownerId: OWNER, status: 200, rowCount: 0, response: null }));
    const d = deps({
      batchSize: 1,
      selectRows: vi.fn(async () => (call++ === 0 ? [bad] : [])),
      deliver,
    });

    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);

    expect(result.outcome).toBe('up-to-date');
    expect(result.rowsDelivered).toBe(0);
    expect(result.rowsRead).toBe(1);
    expect(result.cursor).toBe('2026-08-30T10:00:00.000Z|bad');

    expect(deliver).toHaveBeenCalledTimes(1);
    const flushed = callsOf(deliver)[0][0] as { body: { cursor?: string; messages?: unknown[] } };
    expect(flushed.body.cursor).toBe('2026-08-30T10:00:00.000Z|bad');
    expect(flushed.body.messages).toEqual([]);
  });

  it('does NOT flush when every page delivered — the last batch already carried the cursor', async () => {
    // The flush must be conditional. An unconditional one would POST a
    // redundant empty batch after every ordinary run.
    const deliver = vi.fn(async () => ({ app: 'email' as const, ownerId: OWNER, status: 200, rowCount: 0, response: null }));
    let call = 0;
    const d = deps({
      batchSize: 2,
      selectRows: vi.fn(async () => (call++ === 0 ? [row('a', '2026-08-30T10:00:00.000Z')] : [])),
      deliver,
    });

    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);

    expect(result.batches).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('records a delivery failure as an error result without throwing', async () => {
    const d = deps({
      selectRows: vi.fn(async () => [row('a', '2026-08-30T10:00:00.000Z')]),
      deliver: vi.fn(async () => {
        throw new Error('app_delivery_rejected:email:400: bad batch');
      }),
    });
    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, d);
    expect(result.outcome).toBe('error');
    expect(result.reason).toContain('app_delivery_rejected');
  });
});

/**
 * P-006 — backfill rides this exact path, so the properties that matter are
 * the ones only a COLD corpus exercises: does a many-page corpus actually
 * drain, and is the per-run bound real?
 */
describe('P-006 — backfill drains the corpus in bounded pages', () => {
  /** A corpus of `n` mappable rows, one second apart, served page by page. */
  function corpus(n: number): CanonicalRow[] {
    return Array.from({ length: n }, (_, i) =>
      row(`r${String(i).padStart(4, '0')}`, new Date(Date.UTC(2026, 7, 30, 10, 0, i)).toISOString()),
    );
  }

  /** Serve `all` the way the real SQL does: the page after `cursor`, up to `take`. */
  function pagedSelect(all: CanonicalRow[]) {
    return vi.fn(async (...args: unknown[]) => {
      const cursor = args[4] as { at: string; id: string } | null;
      const take = args[5] as number;
      const after = cursor
        ? all.filter((r) => r.cursorAt > cursor.at || (r.cursorAt === cursor.at && r.id > cursor.id))
        : all;
      return after.slice(0, take);
    });
  }

  it('drains a corpus spanning many pages in ONE run, then reports up-to-date on the next', async () => {
    const all = corpus(713); // the live gmail+calendar corpus is this order of magnitude
    const select = pagedSelect(all);
    const deliver = vi.fn(async () => ({ app: 'email' as const, ownerId: OWNER, status: 200, rowCount: 0, response: null }));

    const first = await reconcileOnePair(SQL, WORKSPACE, PAIR, deps({ selectRows: select, deliver }));

    expect(first.rowsDelivered).toBe(713);
    expect(first.rowsRead).toBe(713);
    // 713 rows at the 200-row batch size = 4 POSTs, and the run does NOT stop
    // at the cap, so nothing is left behind for a second pass.
    expect(first.batches).toBe(4);
    expect(first.more).toBe(false);
    expect(first.cursor).toBe(`${all[712]!.cursorAt}|${all[712]!.id}`);

    // Second run, resuming from the cursor the app was just given: nothing left.
    const second = await reconcileOnePair(SQL, WORKSPACE, PAIR, deps({
      selectRows: pagedSelect(all),
      fetchCursor: vi.fn(async () => ({ reachable: true, cursor: first.cursor })),
    }));
    expect(second.outcome).toBe('up-to-date');
    expect(second.rowsRead).toBe(0);
  });

  it('bounds the run on rows READ, not rows delivered, when a whole span is unmappable', async () => {
    // THE DEFECT THIS PINS: the loop used to bound on `rowsDelivered`, which an
    // all-unmappable page never advances — so one routinesTick step would read
    // the WHOLE corpus regardless of the cap. Every row here is unmappable, so
    // a delivered-row bound reads all 900; a read bound stops at 400.
    const all = corpus(900).map((r) => ({ ...r, externalId: '' }));
    const select = pagedSelect(all);

    const result = await reconcileOnePair(SQL, WORKSPACE, PAIR, deps({
      batchSize: 100,
      maxRowsPerRun: 400,
      selectRows: select,
    }));

    expect(result.rowsRead).toBe(400);
    expect(result.rowsDelivered).toBe(0);
    expect(result.more).toBe(true);
    expect(select).toHaveBeenCalledTimes(4);
  });

  it('a skipped span longer than the cap still TERMINATES — each run resumes past the last', async () => {
    // With the read bound in place but no cursor flush this wedges: every run
    // reads the same 400 unmappable rows, delivers nothing, and backfill never
    // reaches the mappable tail.
    const all: CanonicalRow[] = [
      ...corpus(400).map((r) => ({ ...r, externalId: '' })),
      row('zzzz', '2026-08-30T11:00:00.000Z'),
    ];

    let appCursor: string | null = null;
    const deliver = vi.fn(async (batch: unknown) => {
      // Stand in for the app: persist whatever cursor the batch carried,
      // rows-empty flush included (recordSyncStatus does this unconditionally).
      const body = (batch as { body: { cursor?: string } }).body;
      if (body.cursor) appCursor = body.cursor;
      return { app: 'email' as const, ownerId: OWNER, status: 200, rowCount: 0, response: null };
    });

    const run = () => reconcileOnePair(SQL, WORKSPACE, PAIR, deps({
      batchSize: 100,
      maxRowsPerRun: 400,
      selectRows: pagedSelect(all),
      fetchCursor: vi.fn(async () => ({ reachable: true, cursor: appCursor })),
      deliver: deliver as unknown as ReconcileDeps['deliver'],
    }));

    const first = await run();
    expect(first.rowsRead).toBe(400);
    expect(first.rowsDelivered).toBe(0);
    expect(first.more).toBe(true);
    // The flush moved the app's watermark past the skipped span.
    expect(appCursor).toBe(`${all[399]!.cursorAt}|${all[399]!.id}`);

    const second = await run();
    expect(second.rowsRead).toBe(1);
    expect(second.rowsDelivered).toBe(1);
    expect(second.more).toBe(false);
  });
});

describe('appDataProducerReconcileSweep — fail-soft orchestration', () => {
  it('one unreachable app does not stop the others catching up', async () => {
    const d = deps({
      listMappings: vi.fn(async () => [
        { workspaceId: WORKSPACE, userId: USER, app: 'email' as const, ownerId: 'owner-email', note: null },
        { workspaceId: WORKSPACE, userId: USER, app: 'calendar' as const, ownerId: 'owner-cal', note: null },
      ]) as never,
      fetchCursor: vi.fn(async (app: 'email' | 'calendar') =>
        app === 'email'
          ? { reachable: false, cursor: null, error: 'down' }
          : { reachable: true, cursor: null },
      ) as never,
      selectRows: vi.fn(async () => [row('c1', '2026-08-30T10:00:00.000Z')]),
    });

    const results = await appDataProducerReconcileSweep(SQL, WORKSPACE, d);

    expect(results).toHaveLength(2);
    expect(results.find((r) => r.app === 'email')?.outcome).toBe('skipped');
    expect(results.find((r) => r.app === 'calendar')?.outcome).toBe('delivered');
  });

  it('returns [] rather than throwing into the shared tick when the work list is unreadable', async () => {
    const d = deps({
      listMappings: vi.fn(async () => {
        throw new Error('relation does not exist');
      }) as never,
    });
    await expect(appDataProducerReconcileSweep(SQL, WORKSPACE, d)).resolves.toEqual([]);
  });
});
