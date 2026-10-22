/**
 * messages-inbox.integration.test.ts — `readInbox` recipient-pushdown against REAL
 * Postgres (baseline-schema DB). Coverage for the fleet-concurrency-first P-003 /
 * round4 D-005 fix.
 *
 * BEFORE: `readInbox` loaded the ENTIRE `messages` surface through
 * `coordLog.readLines('messages')` and filtered in JS — O(all messages ever sent),
 * re-transferring + JSON-parsing + allocating every envelope on the operator's
 * single event loop. It is the dominant `coord_event_log` call (every agent, every
 * turn: always-armed inbox-wake + orient + manual coord:inbox), so that per-call
 * cost is multiplied by fleet size — a direct concurrency limiter.
 *
 * AFTER: a PG recipient-pushdown returns only this owner's + broadcast rows
 * (`jsonb_typeof(to)='array' AND (to ? owner OR to ? '*')`), with `filterInbox`
 * STILL run as the final authority over the reduced set. The contract this test
 * pins: the pushdown output is BYTE-IDENTICAL to the authoritative full-surface
 * scan (`filterInbox(readLines('messages'))`) across owners + option combos, and
 * the SQL membership predicate exactly matches filterInbox's recipient+array
 * conditions (broadcast `*` included; non-array `to` excluded; own/notify/since/
 * kinds handled by filterInbox on the reduced set).
 *
 * The fixture keeps the real `PgCoordLog` seam (re-pointed at the baseline DB), so
 * `coordHasPgFastPath()` is true and the pushdown branch is the one exercised here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { filterInbox, type CoordEnvelope, type InboxOptions } from '@papercusp/coordination/core';
import { coordLog, coordWorkspaceId } from './log';
import {
  readInbox,
  readInboxWindow,
  readOutbox,
  INBOX_FAST_PATH_ROW_CAP,
  INBOX_PAGE_ROWS,
  INBOX_MAX_PAGES,
} from './messages';

let fx: BaselineCoordFixture;

/** Build + append one raw envelope directly to the messages surface — bypasses
 *  sendMessage's audience expansion / slot-parking so the seeded `to`/`from`/`kind`
 *  are stored EXACTLY as written (we are testing the read path, not delivery). */
async function seed(env: Partial<CoordEnvelope> & { msg_id: string; ts: string; from: string }): Promise<void> {
  const full = { kind: 'message', summary: env.msg_id, to: [], ...env } as unknown as CoordEnvelope;
  await coordLog.appendLine('messages', env.from, full);
}

/** The authoritative reference: full-surface scan + filterInbox, the path the
 *  pushdown must reproduce exactly. */
async function reference(owner: string, opts: InboxOptions = {}): Promise<CoordEnvelope[]> {
  return filterInbox(await coordLog.readLines('messages'), owner, opts);
}

const ids = (envs: CoordEnvelope[]): string[] => envs.map((e) => e.msg_id);

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
});

describe('readInbox recipient-pushdown (P-003 / D-005 SQL path)', () => {
  /** A representative spread: direct, broadcast, other-recipient, own outbox,
   *  notify, multi-recipient ack, and a malformed non-array `to`. */
  async function seedSpread(): Promise<void> {
    await seed({ msg_id: 'm1', ts: '2026-01-01T00:00:01.000Z', from: 'bob', to: ['alice'] });
    await seed({ msg_id: 'm2', ts: '2026-01-01T00:00:02.000Z', from: 'carol', to: ['*'] }); // broadcast
    await seed({ msg_id: 'm3', ts: '2026-01-01T00:00:03.000Z', from: 'carol', to: ['dave'] }); // not alice
    await seed({ msg_id: 'm4', ts: '2026-01-01T00:00:04.000Z', from: 'alice', to: ['alice'] }); // alice's own
    await seed({ msg_id: 'm5', ts: '2026-01-01T00:00:05.000Z', from: 'bob', to: ['alice'], kind: 'notify' });
    await seed({ msg_id: 'm6', ts: '2026-01-01T00:00:06.000Z', from: 'eve', to: ['alice', 'dave'], kind: 'ack' });
    // Malformed: `to` is a bare string, not an array — both paths must exclude it.
    await seed({ msg_id: 'm7', ts: '2026-01-01T00:00:07.000Z', from: 'bob', to: 'alice' as unknown as string[] });
  }

  it('matches the authoritative full-scan + filterInbox, default opts', async () => {
    await seedSpread();
    const got = await readInbox('alice');
    expect(ids(got)).toEqual(await reference('alice').then(ids));
    // Concrete: direct (m1) + broadcast (m2) + ack (m6); NOT other (m3), own (m4),
    // notify (m5, default-excluded), or malformed non-array (m7).
    expect(ids(got)).toEqual(['m1', 'm2', 'm6']);
  });

  it('includes the broadcast (*) row and excludes a non-array `to`', async () => {
    await seedSpread();
    const got = await readInbox('alice');
    expect(ids(got)).toContain('m2'); // to:['*']
    expect(ids(got)).not.toContain('m7'); // to:'alice' (string, not array)
  });

  it('is byte-identical to the reference across owners + option combos', async () => {
    await seedSpread();
    const combos: Array<[string, InboxOptions]> = [
      ['alice', {}],
      ['alice', { excludeOwn: false }], // m4 (alice's own) now included
      ['alice', { kinds: ['notify'] }], // only m5
      ['alice', { kinds: ['message', 'ack'] }],
      ['alice', { since_ts: '2026-01-01T00:00:03.000Z' }],
      ['dave', {}], // direct m3 + broadcast m2 + multi-recipient m6
      ['nobody', {}], // only the broadcast m2
      ['', {}], // empty owner — only the broadcast
    ];
    for (const [owner, opts] of combos) {
      const got = await readInbox(owner, opts);
      const ref = await reference(owner, opts);
      expect({ owner, opts, ids: ids(got) }).toEqual({ owner, opts, ids: ids(ref) });
    }
  });

  it('excludeOwn:false surfaces the caller’s own outbox row (m4)', async () => {
    await seedSpread();
    expect(ids(await readInbox('alice', { excludeOwn: false }))).toContain('m4');
    expect(ids(await readInbox('alice'))).not.toContain('m4');
  });

  it('returns broadcasts only for an owner with no direct mail', async () => {
    await seedSpread();
    expect(ids(await readInbox('nobody'))).toEqual(['m2']);
  });

  it('returns empty when nothing matches', async () => {
    expect(await readInbox('alice')).toEqual([]);
  });

  // WI-3825: the PG fast path now pushes a skew-padded `ts >= …` bound (the row
  // `ts` column, set at INSERT time) when `since_ts` is given, as a SQL
  // pre-filter ahead of `filterInbox`'s authoritative check on `body.ts` (a
  // DIFFERENT field, client-stamped, which the fixtures above seed with
  // arbitrary historical dates while the actual DB row is inserted "now").
  // These pin the two properties that make the pre-filter SAFE: it never
  // wrongly excludes a row `filterInbox` would keep (near-`now` since_ts —
  // the realistic production shape), and a `since_ts` that legitimately
  // excludes everything (in the future relative to every row) still empties
  // out correctly end-to-end.
  describe('since_ts SQL pre-filter safety (row ts vs body.ts skew, WI-3825)', () => {
    it('a near-now since_ts still returns rows just inserted (real production shape)', async () => {
      const now = new Date().toISOString();
      await seed({ msg_id: 'recent1', ts: now, from: 'bob', to: ['alice'] });
      const since = new Date(Date.now() - 1000).toISOString(); // 1s ago
      const got = await readInbox('alice', { since_ts: since });
      expect(ids(got)).toEqual(await reference('alice', { since_ts: since }).then(ids));
      expect(ids(got)).toContain('recent1');
    });

    it('a since_ts in the future (relative to every seeded row) empties out, matching the reference', async () => {
      await seedSpread();
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const got = await readInbox('alice', { since_ts: future });
      expect(got).toEqual([]);
      expect(await reference('alice', { since_ts: future })).toEqual([]);
    });
  });

  // EI-19314819320465915. The row cap is a LIMIT, so the ORDER BY decides WHICH rows
  // survive it. `ORDER BY id ASC LIMIT n` keeps the n OLDEST and silently discards the
  // NEWEST — an inbox that freezes: the owner re-reads ancient mail forever and never
  // sees anything new, while the read still returns a full, plausible 25k rows. It must
  // be `id DESC`, so the cap degrades by forgetting HISTORY instead.
  //
  // Not hypothetical: when this was fixed, `to` matched 20,365 broadcast rows against a
  // 25,000 cap (81%, growing ~150/day). This test is the guard that the ordering never
  // silently flips back — it FAILS on `ASC` and passes on `DESC`.
  //
  // Seeded with ONE bulk INSERT rather than 25k appendLine calls (seconds vs minutes);
  // that is also why it asserts on the RAW cap boundary rather than going through
  // sendMessage.
  describe('fast-path row cap keeps the NEWEST rows, not the oldest (EI-19314819320465915)', () => {
    const OVERFLOW = 50;

    async function seedPastCap(): Promise<void> {
      await fx.admin`
        INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts, workspace_id)
        SELECT 'messages',
               'bulk-' || n,
               jsonb_build_object(
                 'msg_id', 'bulk-' || n,
                 'kind',   'message',
                 'from',   'bulk-sender',
                 'to',     jsonb_build_array('*'),
                 'summary','bulk',
                 'ts',     to_char(TIMESTAMP '2026-01-01 00:00:00' + (n * interval '1 second'),
                                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               ),
               TIMESTAMP '2026-01-01 00:00:00' + (n * interval '1 second'),
               ${coordWorkspaceId()}
          FROM generate_series(1, ${INBOX_FAST_PATH_ROW_CAP + OVERFLOW}) AS n
      `;
    }

    // Hitting the cap DELIBERATELY fires readInbox's own console.warn, so each test
    // here spies it rather than letting vitest-fail-on-console red the file. Spying
    // (not silencing) is the point: it lets us assert the warning says the OLDEST rows
    // were dropped. That sentence was itself backwards before this fix — it claimed the
    // oldest were dropped while `ASC` was in fact dropping the newest, so anyone
    // debugging a frozen inbox was being actively misled by the one line meant to help.
    it('drops the OLDEST rows past the cap and retains the newest', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await seedPastCap();
      const got = await readInbox('alice');
      const seen = new Set(ids(got));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fast-path row cap'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OLDEST matching rows beyond the cap were NOT'));
      warn.mockRestore();

      // Exactly the cap comes back — the LIMIT is doing its job.
      expect(got.length).toBe(INBOX_FAST_PATH_ROW_CAP);

      // The NEWEST row must survive. Under the old `ASC` ordering this was the row
      // most certain to be discarded, which is precisely the bug.
      expect(seen.has(`bulk-${INBOX_FAST_PATH_ROW_CAP + OVERFLOW}`)).toBe(true);

      // ...and the oldest must be the one dropped.
      expect(seen.has('bulk-1')).toBe(false);

      // The retained window is contiguous and newest-anchored: ids OVERFLOW+1..cap+OVERFLOW.
      expect(seen.has(`bulk-${OVERFLOW + 1}`)).toBe(true);
      expect(seen.has(`bulk-${OVERFLOW}`)).toBe(false);
    });

    it('still returns rows sorted ASCENDING by (ts, msg_id) — the SQL order picks rows, never presentation', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await seedPastCap();
      const got = await readInbox('alice');
      warn.mockRestore();
      const tsValues = got.map((e) => new Date(e.ts).getTime());
      const ascending = [...tsValues].sort((a, b) => a - b);
      expect(tsValues).toEqual(ascending);
      // filterInbox re-sorts, so flipping the SQL to DESC must not reverse the output.
      expect(new Date(got[0]!.ts).getTime()).toBeLessThan(new Date(got[got.length - 1]!.ts).getTime());
    });
  });

  /**
   * WI-6939. `readInbox`'s single unbounded query matches ~99.8% broadcast rows for a
   * real owner (~20k rows / ~10MB per call, 30.1 cumulative HOURS of DB time across
   * 491,954 calls). `readInboxWindow` reads a bounded newest-first window instead,
   * paging backwards only while the CALLER's own filters say it needs more.
   *
   * The two properties that make that sound, and that these tests pin:
   *   (1) it must actually STOP early when the caller is satisfied — otherwise it is
   *       just the old read with extra round-trips;
   *   (2) it must never UNDER-DELIVER — a caller that is never satisfied has to end up
   *       with exactly what the authoritative `readInbox` would have returned.
   */
  describe('readInboxWindow — bounded keyset-paged read (WI-6939)', () => {
    const TOTAL = INBOX_PAGE_ROWS * 2 + 500; // spans 2 geometrically growing pages

    async function seedPages(count: number = TOTAL): Promise<void> {
      await fx.admin`
        INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts, workspace_id)
        SELECT 'messages',
               'pg-' || n,
               jsonb_build_object(
                 'msg_id', 'pg-' || n,
                 'kind',   'message',
                 'from',   'bulk-sender',
                 'to',     jsonb_build_array('*'),
                 'summary','bulk',
                 'ts',     to_char(TIMESTAMP '2026-01-01 00:00:00' + (n * interval '1 second'),
                                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               ),
               TIMESTAMP '2026-01-01 00:00:00' + (n * interval '1 second'),
               ${coordWorkspaceId()}
          FROM generate_series(1, ${count}) AS n
      `;
    }

    it('STOPS at the first page when the caller is already satisfied', async () => {
      await seedPages();
      const got = await readInboxWindow('alice', {}, (entries) => entries.length >= 5);

      // The whole point: one page, not the 2,500 rows that exist.
      expect(got.pages).toBe(1);
      expect(got.rowsScanned).toBe(INBOX_PAGE_ROWS);
      expect(got.exhausted).toBe(false);
      expect(got.entries.length).toBe(INBOX_PAGE_ROWS);

      // ...and the page it kept is the NEWEST one, not the oldest.
      const seen = new Set(ids(got.entries));
      expect(seen.has(`pg-${TOTAL}`)).toBe(true);
      expect(seen.has('pg-1')).toBe(false);
    });

    it('PAGES to exhaustion when the caller is never satisfied, matching readInbox exactly', async () => {
      await seedPages();
      const windowed = await readInboxWindow('alice', {}, () => false);
      const authoritative = await readInbox('alice');

      expect(windowed.exhausted).toBe(true);
      expect(windowed.pages).toBe(2);
      expect(windowed.rowsScanned).toBe(TOTAL);
      // No under-delivery: byte-identical to the unbounded read it replaces.
      expect(ids(windowed.entries)).toEqual(ids(authoritative));
    });

    it('keeps paging past a page whose rows the caller filters away — the under-fill hazard', async () => {
      await seedPages();
      // A caller whose own filters reject everything in the bulk pages and only
      // accept a marker that lives in the OLDEST page. A bare `LIMIT` would have
      // returned a full page of rows that all filter out, yielding nothing.
      const got = await readInboxWindow('alice', {}, (entries) =>
        entries.some((e) => e.msg_id === 'pg-1'),
      );
      expect(got.entries.some((e) => e.msg_id === 'pg-1')).toBe(true);
      expect(got.pages).toBeGreaterThan(1);
    });

    it('suppresses a retraction whose NOTICE and TARGET land on different pages', async () => {
      // The invariant the design leans on: a notice is always NEWER than its target
      // and shares its audience, so a newest-first window containing the target also
      // contains the notice. Here the notice is on page 1 and the victim on page 2 —
      // markers must accumulate ACROSS pages, not be collected per-page and dropped.
      await seed({ msg_id: 'victim', ts: '2026-01-01T00:00:00.500Z', from: 'bob', to: ['*'] });
      await seedPages();
      await seed({
        msg_id: 'notice',
        ts: '2026-06-01T00:00:00.000Z',
        from: 'bob',
        to: ['*'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...({ retracts: 'victim' } as any),
      });

      const got = await readInboxWindow('alice', {}, () => false);
      const seen = new Set(ids(got.entries));
      expect(got.pages).toBeGreaterThan(1);
      // The notice survives (the audience keeps the "disregard that" line)...
      expect(seen.has('notice')).toBe(true);
      // ...while the retracted message is gone, exactly as the unbounded path does.
      expect(seen.has('victim')).toBe(false);
      expect(ids(got.entries)).toEqual(ids(await readInbox('alice')));
    });

    it('WARNS instead of truncating silently when the page budget runs out', async () => {
      // The failure shape this guards is the one EI-19314819320465915 was about: a
      // read that returns a plausible full-looking result while quietly omitting
      // matching rows. The caller of readInbox only ever sees `entries`, so budget
      // exhaustion has to be audible.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await seedPages(INBOX_FAST_PATH_ROW_CAP + 50);
      const got = await readInboxWindow('alice', {}, () => false);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('page budget'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('were NOT returned'));
      warn.mockRestore();

      expect(got.exhausted).toBe(false);
      expect(got.pages).toBe(INBOX_MAX_PAGES);
      expect(got.rowsScanned).toBe(INBOX_FAST_PATH_ROW_CAP);
      // Geometric growth preserves the same row horizon while reducing the
      // worst-case serial page count from 25 to five.
      expect(got.pages).toBe(5);
    });

    it('honours since_ts, and a short first page reports exhausted', async () => {
      await seedPages(10);
      const got = await readInboxWindow('alice', {}, () => false);
      expect(got.exhausted).toBe(true);
      expect(got.pages).toBe(1);
      expect(got.rowsScanned).toBe(10);
      expect(ids(got.entries)).toEqual(ids(await readInbox('alice')));
    });
  });
});

/**
 * EI-19323045109346905 — the OUTBOX half of the same bounded-window mechanism,
 * riding the extracted `pageCoordEventLogDesc` pager rather than a second copy
 * of the keyset loop.
 *
 * The economics differ from the inbox and that is worth stating, because it is
 * the reason this is a smaller change and not a second 30-hour win: the outbox
 * predicate (`body->>'from' = owner`) is genuinely SELECTIVE, where the inbox
 * predicate matched ~99.8% broadcast rows that had nothing to do with the
 * caller. So the bound here fixes a read-to-use RATIO (the `sidebar.cupMail`
 * resolver pulled a sender's entire history to render `tail(50)`), not a
 * whole-table scan.
 *
 * The property that actually has to hold is therefore equivalence, not speed:
 * a windowed read must render EXACTLY what the unbounded read rendered.
 */
describe('readOutbox — bounded keyset-paged window (EI-19323045109346905)', () => {
  const TOTAL = INBOX_PAGE_ROWS * 2 + 500; // spans 3 pages
  const SENDER = 'bulk-sender';
  /** The resolver's actual stopping rule + slice (sync-resolver `sidebar.cupMail`). */
  const TAIL = 50;
  const tail = <T>(arr: T[]): T[] => (arr.length > TAIL ? arr.slice(arr.length - TAIL) : arr);

  async function seedSent(count: number = TOTAL): Promise<void> {
    await fx.admin`
      INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts, workspace_id)
      SELECT 'messages',
             'ob-' || n,
             jsonb_build_object(
               'msg_id', 'ob-' || n,
               'kind',   'message',
               'from',   ${SENDER}::text,
               'to',     jsonb_build_array('someone-else'),
               'summary','bulk',
               'ts',     to_char(TIMESTAMP '2026-01-01 00:00:00' + (n * interval '1 second'),
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             ),
             TIMESTAMP '2026-01-01 00:00:00' + (n * interval '1 second'),
             ${coordWorkspaceId()}
        FROM generate_series(1, ${count}) AS n
    `;
  }

  it('is UNCHANGED when no window is passed — the param is purely opt-in', async () => {
    await seedSent();
    expect((await readOutbox(SENDER, {})).length).toBe(TOTAL);
  });

  it('STOPS at the first page when the caller is satisfied, keeping the NEWEST rows', async () => {
    await seedSent();
    const got = await readOutbox(SENDER, {}, { enough: (e) => e.length >= TAIL });

    // One page, not the 2,500 rows that exist.
    expect(got.length).toBe(INBOX_PAGE_ROWS);
    const seen = new Set(ids(got));
    expect(seen.has(`ob-${TOTAL}`)).toBe(true); // newest kept
    expect(seen.has('ob-1')).toBe(false); // oldest not fetched
  });

  it('renders the IDENTICAL tail(50) the unbounded read did — the resolver-equivalence property', async () => {
    // This is the test that licenses the change: sidebar.cupMail slices tail(50)
    // off whatever it gets, so the bound is only safe if that slice is untouched.
    await seedSent();
    const windowed = await readOutbox(SENDER, {}, { enough: (e) => e.length >= TAIL });
    const authoritative = await readOutbox(SENDER, {});
    expect(ids(tail(windowed))).toEqual(ids(tail(authoritative)));
  });

  it('PAGES to exhaustion when never satisfied, matching the unbounded read exactly', async () => {
    await seedSent();
    const windowed = await readOutbox(SENDER, {}, { enough: () => false });
    expect(ids(windowed)).toEqual(ids(await readOutbox(SENDER, {})));
  });

  it('pages on when FEWER than the tail exist, rather than returning a short read', async () => {
    // `enough` never goes true here; the stop must come from history exhaustion.
    await seedSent(10);
    const got = await readOutbox(SENDER, {}, { enough: (e) => e.length >= TAIL });
    expect(got.length).toBe(10);
    expect(ids(got)).toEqual(ids(await readOutbox(SENDER, {})));
  });

  it('returns ASCENDING by ts even though the window pages DESC', async () => {
    // The trap the fast-path cap comment already calls out on this function: the
    // SQL order picks which ROWS are fetched, never the presentation order. The
    // windowed path must go through `filterOutbox`'s re-sort like the capped one.
    await seedSent(10);
    const got = await readOutbox(SENDER, {}, { enough: (e) => e.length >= 5 });
    const tsList = got.map((e) => e.ts);
    expect(tsList).toEqual([...tsList].sort());
  });

  it('does not leak another sender’s rows into the window', async () => {
    await seedSent(10);
    await seed({ msg_id: 'other-1', ts: '2026-06-01T00:00:00.000Z', from: 'someone-else', to: ['*'] });
    const got = await readOutbox(SENDER, {}, { enough: () => false });
    expect(ids(got)).not.toContain('other-1');
    expect(got.every((e) => e.from === SENDER)).toBe(true);
  });
});
