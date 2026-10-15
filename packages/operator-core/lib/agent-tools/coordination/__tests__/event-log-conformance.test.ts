/**
 * P-050 dual-impl proof for CoordEventLog: run the SHARED conformance suite
 * (the one InMemoryCoordLog + FsCoordLog pass in
 * packages/coordination/src/event-log/event-log.test.ts) against the
 * PRODUCTION-grade `PgCoordLog` over a real Postgres handle. Three backends
 * passing the SAME assertions is what makes the "optional PG log" swappable
 * (P-011) and the dual-impl claim real (P-050) — the event-log analogue of
 * the peer's presence-conformance.test.ts.
 *
 * Connects via `connectionString()` (env→discovery→fallback, the resolver
 * `pgClientFields` uses — `getOrgPg()` needs an operator bootstrap a
 * standalone vitest run lacks) and mirrors getOrgPg()'s postgres-js options
 * (esp. `prepare: false`, which governs jsonb round-tripping). The
 * `coord_event_log` table is created idempotently via the package's own
 * `ensureCoordEventLogTable`, so the proof RUNS wherever PG is reachable —
 * live operator or CI testcontainer — and soft-skips only when no PG exists.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PgCoordLog, ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import { describeCoordEventLogConformance } from '@papercusp/coordination/event-log/conformance';
import { connectionString } from '../../../memory/mem0-connection';
import { PG_BIGINT_AS_NUMBER_TYPES } from '@papercusp/db-org';

let sql: Sql | null = null;
let pgOk = false;

try {
  const url = await connectionString();
  sql = postgres(url, {
    onnotice: () => {},
    connection: { search_path: 'harness_shared, public' },
    prepare: false,
    max: 4,
    // EI-9265: this handle must mirror getOrgPg()'s bigint→Number coercion
    // exactly — the drift that let a bigserial cursor (coord_event_log.id)
    // silently come back as a string in THIS client while production's
    // getOrgPg() client already coerced it correctly.
    types: PG_BIGINT_AS_NUMBER_TYPES,
  });
  await sql`SELECT 1`;
  await ensureCoordEventLogTable(sql);
  pgOk = true;
} catch (e) {
   
  console.error('[event-log-conformance] PG not reachable, skipping:', (e as Error)?.message);
}

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

// Scope every clear to a dedicated test workspace so the suite never touches
// real coord rows. This matters now that the operator writes live messages to
// harness_shared.coord_event_log (post-cutover) under the 'default' workspace —
// an unscoped DELETE would wipe them. D-007's workspace_id is exactly this lever.
const TEST_WS = 'test-coord-conformance';

describeCoordEventLogConformance(
  'PgCoordLog (live PG)',
  async () => {
    // A full clear of THIS test workspace per case gives every test an empty
    // surface to start from — matching the in-mem/fs factories.
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    return {
      log: new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS }),
      cleanup: async () => {
        await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
      },
    };
  },
  pgOk ? describe : describe.skip,
);

// D-007: two PgCoordLog instances bound to different workspace_ids share the
// table but never see each other's rows — the scoping that makes the
// multi-install case (Q-3) a non-event. Parity with coord_presence's
// workspace_id filter.
(pgOk ? describe : describe.skip)('PgCoordLog workspace_id isolation (D-007)', () => {
  it('a row written in one workspace is invisible to another', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id IN ('wsA', 'wsB')`;
    const wsA = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: 'wsA' });
    const wsB = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: 'wsB' });

    // LINE surface: A's message must not appear in B's union read.
    await wsA.appendLine('messages', 'agentA', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'm-a', kind: 'message', from: 'agentA', to: ['*'],
    });
    expect((await wsA.readLines('messages')).map((l) => l.msg_id)).toEqual(['m-a']);
    expect(await wsB.readLines('messages')).toEqual([]);

    // EVENT surface: the same msg_id in two workspaces are distinct rows
    // (the unique index includes workspace_id), each visible only in its own.
    await wsA.putEvent('escalations', 'shared-id', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'shared-id', kind: 'escalation', from: 'agentA', to: ['human'],
    });
    await wsB.putEvent('escalations', 'shared-id', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'shared-id', kind: 'escalation', from: 'agentB', to: ['human'],
    });
    expect((await wsA.getEvent('escalations', 'shared-id'))?.from).toBe('agentA');
    expect((await wsB.getEvent('escalations', 'shared-id'))?.from).toBe('agentB');

    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id IN ('wsA', 'wsB')`;
  });
});

// WI-3826 (fleet-reliability-verification-2026-07-10): the `ts` COLUMN must agree with the
// envelope's own `body->>'ts'` — a safe `WHERE ts >= $since` SQL pushdown (the optimization
// this bug was found while designing) is only possible when they can never diverge. Column
// used to default to now() at INSERT time, which could lag body.ts by however long
// sendMessage's audience/hive-scope resolution took between stamping `ts` and calling
// appendLine — silently dropping messages from any future since_ts pushdown (found: >1s
// drift on 2,317/53,560 live `messages` rows). appendLine now stamps `ts` FROM the envelope,
// so this asserts they agree by construction (the invariant the historical rows were
// one-time-repaired to by migration 546).
(pgOk ? describe : describe.skip)('coord_event_log.ts agrees with body->>\'ts\' (WI-3826)', () => {
  it('appendLine (LINE surface, e.g. messages) stamps the ts COLUMN from the envelope\'s own ts — never DB now()', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    // An envelope ts far from "now" proves the column is NOT defaulting to now() —
    // if it silently fell back to the DB default, this row's ts would land near the
    // test's wall-clock time, not two years in the past.
    const envelopeTs = '2024-03-01T00:00:00.000Z';
    await log.appendLine('messages', 'agent-ts-check', {
      ts: envelopeTs, msg_id: 'ts-invariant-1', kind: 'message', from: 'agent-ts-check', to: ['*'],
    });
    const rows = await sql!<{ ts: string; body: unknown }[]>`
      SELECT ts, body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${TEST_WS} AND msg_id = 'ts-invariant-1'
    `;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].ts).toISOString()).toBe(envelopeTs);
    const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
    expect(body.ts).toBe(envelopeTs);

    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  });

  it('putEvent (EVENT surface, e.g. escalations) also stamps ts from the envelope on its FIRST insert', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    const envelopeTs = '2024-03-01T00:00:00.000Z';
    await log.putEvent('escalations', 'ts-invariant-event-1', {
      ts: envelopeTs, msg_id: 'ts-invariant-event-1', kind: 'escalation', from: 'agent-ts-check', to: ['human'],
    });
    const rows = await sql!<{ ts: string }[]>`
      SELECT ts FROM harness_shared.coord_event_log
       WHERE workspace_id = ${TEST_WS} AND msg_id = 'ts-invariant-event-1'
    `;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].ts).toISOString()).toBe(envelopeTs);

    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  });
});

// EI-1576 regression: ensureCoordEventLogTable must be idempotent WITHOUT a
// destructive DROP/CREATE window. It runs against the LIVE org DB (here via
// connectionString, and in the operator's getOrgPg seam), so dropping an
// already-correct index — even momentarily — makes every concurrent putEvent
// upsert fail with `42P10: there is no unique or exclusion constraint matching
// the ON CONFLICT specification`. An index's OID is stable iff it was NOT
// dropped+recreated, so a second call that leaves the OID unchanged proves the
// window is gone.
(pgOk ? describe : describe.skip)('ensureCoordEventLogTable idempotency (EI-1576)', () => {
  it('does not drop+recreate an already-correct partial unique index', async () => {
    // First call guarantees the index exists in its correct, scoped shape.
    await ensureCoordEventLogTable(sql!);
    const oidOf = async (): Promise<string | undefined> =>
      (
        await sql!<{ oid: string }[]>`
          SELECT c.oid::text AS oid
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'harness_shared'
             AND c.relname = 'coord_event_log_event_uq'
        `
      )[0]?.oid;
    const before = await oidOf();
    expect(before).toBeTruthy(); // the partial unique index is present

    // A redundant call must be a no-op for the index — same OID, no churn,
    // no ACCESS-EXCLUSIVE window for concurrent upserts to fall into.
    await ensureCoordEventLogTable(sql!);
    expect(await oidOf()).toBe(before);

    // And the upsert the index backs still works end-to-end (would raise the
    // 42P10 above if the arbiter index were missing/mismatched).
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    await log.putEvent('escalations', 'ei1576', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'ei1576', kind: 'escalation', from: 'a', to: ['human'],
    });
    await log.putEvent('escalations', 'ei1576', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'ei1576', kind: 'escalation', from: 'b', to: ['human'],
    });
    expect((await log.getEvent('escalations', 'ei1576'))?.from).toBe('b');
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  });
});

// WI-3912: coord:feed (feed.ts's compareByTsThenId) crashed on EVERY call with
// "Cannot read properties of undefined (reading 'localeCompare')" because a
// FEDERATED remote row (coord_event_log id 458510, live prod) had a `body`
// with no `ts`/`msg_id` keys — the fold-apply path for remote rows stores
// whatever shape a peer sent verbatim, unlike the local write paths
// (appendLine/putEvent) which always stamp both from the envelope. Pins the
// pg-log.ts `parseBody` fix: every read method backstops body.ts/body.msg_id
// from the row's own NOT-NULL `ts`/`msg_id` columns when body omits them.
(pgOk ? describe : describe.skip)('parseBody backstops ts/msg_id from row columns (WI-3912)', () => {
  const insertMalformedRow = async (): Promise<void> => {
    // Bypass appendLine on purpose — simulates a federated remote row whose
    // body was folded in verbatim without CoordEnvelope validation (the
    // actual live root cause), not a row this package's own write path could
    // ever produce.
    await sql!`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${TEST_WS}, 'messages', 'wi3912-malformed', '{"summary": "no ts or msg_id in body"}'::jsonb, '2026-07-09T22:19:21.700Z'::timestamptz)
    `;
  };

  afterAll(async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  });

  it('readLines backstops ts/msg_id instead of returning undefined', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    await insertMalformedRow();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    const [row] = await log.readLines('messages');
    expect(row?.ts).toBe('2026-07-09T22:19:21.700Z');
    expect(row?.msg_id).toBe('wi3912-malformed');
  });

  it('readLinesBounded backstops ts/msg_id', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    await insertMalformedRow();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    const [row] = await log.readLinesBounded('messages', { limit: 10 });
    expect(row?.ts).toBe('2026-07-09T22:19:21.700Z');
    expect(row?.msg_id).toBe('wi3912-malformed');
  });

  it('readLinesBoundedCursor backstops ts/msg_id (the coord:feed read path)', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    await insertMalformedRow();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    const page = await log.readLinesBoundedCursor('messages', { limit: 10 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.envelope.ts).toBe('2026-07-09T22:19:21.700Z');
    expect(page.rows[0]?.envelope.msg_id).toBe('wi3912-malformed');
    // The actual live crash: sorting rows via a real (ts, msg_id) comparator
    // (feed.ts's compareByTsThenId shape) must never throw on this row.
    expect(() =>
      [...page.rows].sort(
        (a, b) => a.envelope.ts.localeCompare(b.envelope.ts) || a.envelope.msg_id.localeCompare(b.envelope.msg_id),
      ),
    ).not.toThrow();
  });

  it('read paths canonicalize a conflicting persisted body.msg_id from the row column', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    await sql!`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (
        ${TEST_WS},
        'messages',
        'wi253229-column-id',
        '{"ts":"2026-07-09T22:19:21.700Z","msg_id":"legacy-stale-body-id","kind":"message","from":"remote","to":["human"]}'::jsonb,
        '2026-07-09T22:19:21.700Z'::timestamptz
      )
    `;
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });

    const page = await log.readLinesBoundedCursor('messages', { limit: 10 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.envelope.msg_id).toBe('wi253229-column-id');

    const [line] = await log.readLines('messages');
    expect(line?.msg_id).toBe('wi253229-column-id');
  });

  it('a well-formed body is left untouched (no column override of a present value)', async () => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.appendLine('messages', 'agent', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'well-formed', kind: 'message', from: 'agent', to: ['*'],
    });
    const [row] = await log.readLines('messages');
    expect(row?.ts).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.msg_id).toBe('well-formed');
  });
});

// WI-3937: readLines used to be an unbounded full-surface read on EVERY call
// (~28k bodies/call fleet-wide) — the PG furnace that starved the bg-host
// substrate drain (P-059 RED). It now keeps an incremental per-(ws,surface)
// cache: one full read per instance, then `id > watermark - overlap` deltas
// with a recent-id dedupe, and a TTL'd full refresh so out-of-band GC deletes
// eventually fold out. These tests pin the delta path, the dedupe (contiguous
// test ids land INSIDE the overlap window, so any dedupe bug shows as
// duplicates), the TTL refresh, the copy-per-call contract, and the kill
// switch.
(pgOk ? describe : describe.skip)('readLines incremental cache (WI-3937)', () => {
  const envelope = (msgId: string): Parameters<PgCoordLog['appendLine']>[2] => ({
    ts: '2026-01-01T00:00:00.000Z', msg_id: msgId, kind: 'message', from: 'agent', to: ['*'],
  });
  const clear = async (): Promise<void> => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  };
  const savedEnv = {
    cache: process.env.PAPERCUSP_COORD_READLINES_CACHE,
    ttl: process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS,
  };
  const restoreEnv = (): void => {
    if (savedEnv.cache === undefined) delete process.env.PAPERCUSP_COORD_READLINES_CACHE;
    else process.env.PAPERCUSP_COORD_READLINES_CACHE = savedEnv.cache;
    if (savedEnv.ttl === undefined) delete process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS;
    else process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS = savedEnv.ttl;
  };
  afterAll(async () => {
    restoreEnv();
    await clear();
  });

  it('delta path: rows appended AFTER the first read appear, in order, without duplicates', async () => {
    restoreEnv(); // cache ON (default)
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.appendLine('messages', 'a', envelope('c1'));
    await log.appendLine('messages', 'a', envelope('c2'));
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['c1', 'c2']); // full read
    await log.appendLine('messages', 'a', envelope('c3'));
    // Delta read — c1/c2's ids are within the overlap window, so the dedupe
    // set is what keeps them from appearing twice.
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['c1', 'c2', 'c3']);
    // A read with nothing new is stable (and still a fresh array copy).
    const again = await log.readLines('messages');
    expect(again.map((l) => l.msg_id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('returns a fresh array copy per call (mutating a result never corrupts the cache)', async () => {
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.appendLine('messages', 'a', envelope('m1'));
    const first = await log.readLines('messages');
    first.length = 0; // caller mangles its copy
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['m1']);
  });

  it('serves from cache between refreshes (an out-of-band DELETE is not seen yet), then the TTL full refresh folds it out', async () => {
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.appendLine('messages', 'a', envelope('keep'));
    await log.appendLine('messages', 'a', envelope('gc-me'));
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['keep', 'gc-me']);
    // Out-of-band delete (what escalation GC does — bypasses this instance).
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS} AND msg_id = 'gc-me'`;
    // Within the TTL the cache still serves the deleted row — the documented
    // (and deliberate) staleness bound. This also PROVES the cache is in play.
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['keep', 'gc-me']);
    // Force the TTL refresh: 1ms TTL + a beat → next read is a FULL read.
    process.env.PAPERCUSP_COORD_READLINES_CACHE_TTL_MS = '1';
    await new Promise((r) => setTimeout(r, 5));
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['keep']);
  });

  it('kill switch PAPERCUSP_COORD_READLINES_CACHE=0 restores the always-fresh full read', async () => {
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.appendLine('messages', 'a', envelope('k1'));
    expect((await log.readLines('messages')).map((l) => l.msg_id)).toEqual(['k1']); // primes the cache
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS} AND msg_id = 'k1'`;
    process.env.PAPERCUSP_COORD_READLINES_CACHE = '0';
    expect(await log.readLines('messages')).toEqual([]); // bypasses the (stale) cache entirely
  });
});

// WI-3993 (the WI-3937 class, EVENT-surface leg): readEvents used to be the
// LAST raw unbounded full-surface body read in the seam — every call streamed
// the whole surface (live escalations ≈ 27k rows / 14MB), and one such read
// stuck on a jammed client event loop held the coord server down ~30min on
// 2026-07-10. Now cached like readLines, with event-surface-specific delta
// semantics. These tests pin the delta path (new puts), the UPSERT ts-leg (an
// in-place re-put keeps its `id` — an id watermark alone would serve the stale
// body forever, so this is THE event-surface regression), the TTL'd GC
// fold-out, and the kill switch.
(pgOk ? describe : describe.skip)('readEvents incremental cache (WI-3993)', () => {
  const esc = (
    msgId: string,
    extra: Record<string, unknown> = {},
  ): Parameters<PgCoordLog['putEvent']>[2] => ({
    ts: '2026-01-01T00:00:00.000Z', msg_id: msgId, kind: 'escalation', from: 'agent', to: ['human'], ...extra,
  });
  const clear = async (): Promise<void> => {
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS}`;
  };
  const savedEnv = {
    cache: process.env.PAPERCUSP_COORD_READEVENTS_CACHE,
    ttl: process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS,
  };
  const restoreEnv = (): void => {
    if (savedEnv.cache === undefined) delete process.env.PAPERCUSP_COORD_READEVENTS_CACHE;
    else process.env.PAPERCUSP_COORD_READEVENTS_CACHE = savedEnv.cache;
    if (savedEnv.ttl === undefined) delete process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS;
    else process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS = savedEnv.ttl;
  };
  afterAll(async () => {
    restoreEnv();
    await clear();
  });

  it('delta path: events put AFTER the first read appear, in order, without duplicates', async () => {
    restoreEnv(); // cache ON (default)
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.putEvent('escalations', 'e1', esc('e1'));
    await log.putEvent('escalations', 'e2', esc('e2'));
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['e1', 'e2']); // full read
    await log.putEvent('escalations', 'e3', esc('e3'));
    // Delta read — e1/e2 land inside the id-overlap window, so the
    // replace-by-msg_id fold is what keeps them from appearing twice.
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['e1', 'e2', 'e3']);
    // A read with nothing new is stable (and still a fresh array copy).
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('an in-place UPSERT (same msg_id, rewritten body) is visible through the cache', async () => {
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.putEvent('escalations', 'u1', esc('u1', { summary: 'v1' }));
    expect((await log.readEvents('escalations')).map((e) => e.summary)).toEqual(['v1']); // primes the cache
    await log.putEvent('escalations', 'u1', esc('u1', { summary: 'v2' })); // ON CONFLICT: same id, ts=now()
    const after = await log.readEvents('escalations');
    expect(after).toHaveLength(1); // replaced, never duplicated
    expect(after[0].summary).toBe('v2'); // the rewritten body is served
  });

  it('the upsert ts-leg specifically: a re-put whose id fell OUTSIDE the id-overlap window is still seen', async () => {
    // In the test above the overlap window (watermark − 1000) reaches id 0, so
    // the id leg alone would mask a broken ts leg. Here we push the shared
    // bigserial SEQUENCE forward past the window (harmless: sequences may skip
    // arbitrarily; rows never collide) so the re-put's untouched id is
    // genuinely below `maxId − overlap` and ONLY the `ts > lastRead − skew`
    // leg can surface it — the exact hazard that would silently serve a stale
    // escalation body forever.
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.putEvent('escalations', 't1', esc('t1', { summary: 'stale' }));
    expect((await log.readEvents('escalations')).map((e) => e.summary)).toEqual(['stale']); // primes; maxId = id(t1)
    // Advance the sequence 5000 past t1, then land t2 up there → maxId jumps,
    // putting t1's id outside the 1000-id overlap window.
    const seq = await sql!`SELECT pg_get_serial_sequence('harness_shared.coord_event_log', 'id') AS s`;
    const seqName = seq[0].s as string;
    await sql!`SELECT setval(${seqName}, nextval(${seqName}) + 5000)`;
    await log.putEvent('escalations', 't2', esc('t2'));
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['t1', 't2']); // folds t2, maxId≈+5000
    await log.putEvent('escalations', 't1', esc('t1', { summary: 'fresh' })); // upsert: id(t1) unchanged, ts=now()
    const after = await log.readEvents('escalations');
    expect(after.map((e) => e.msg_id)).toEqual(['t1', 't2']);
    expect(after[0].summary).toBe('fresh'); // only the ts leg can have caught this
  });

  it('serves from cache between refreshes (an out-of-band GC DELETE not seen yet), then the TTL full refresh folds it out', async () => {
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.putEvent('escalations', 'keep', esc('keep'));
    await log.putEvent('escalations', 'gc-me', esc('gc-me'));
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['keep', 'gc-me']);
    // Out-of-band delete (what escalation-log-gc does — bypasses this instance).
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS} AND msg_id = 'gc-me'`;
    // Within the TTL the cache still serves the deleted row — the documented
    // (and deliberate) staleness bound. This also PROVES the cache is in play.
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['keep', 'gc-me']);
    // Force the TTL refresh: 1ms TTL + a beat → next read is a FULL read.
    process.env.PAPERCUSP_COORD_READEVENTS_CACHE_TTL_MS = '1';
    await new Promise((r) => setTimeout(r, 5));
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['keep']);
  });

  it('kill switch PAPERCUSP_COORD_READEVENTS_CACHE=0 restores the always-fresh full read', async () => {
    restoreEnv();
    await clear();
    const log = new PgCoordLog({ getSql: () => sql!, ensureSchema: async () => {}, workspaceId: TEST_WS });
    await log.putEvent('escalations', 'k1', esc('k1'));
    expect((await log.readEvents('escalations')).map((e) => e.msg_id)).toEqual(['k1']); // primes the cache
    await sql!`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${TEST_WS} AND msg_id = 'k1'`;
    process.env.PAPERCUSP_COORD_READEVENTS_CACHE = '0';
    expect(await log.readEvents('escalations')).toEqual([]); // bypasses the (stale) cache entirely
  });
});
