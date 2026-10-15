import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, type BlobStore } from '@papercusp/artifact-registry';
import {
  DEFAULT_MAX_SPOOL_BYTES,
  DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS,
  DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT,
  DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES,
  DEFAULT_PAYLOAD_SPOOL_TTL_MS,
  GATEWAY_PAYLOAD_ADDRESSING,
  PayloadSpoolPersistenceError,
  PayloadTooLargeError,
  PgGatewayPayloadStore,
  type PgGatewayPayloadStoreOptions,
  memoryGatewayPayloadSpool,
} from './payload-spool';

const body = (text: string) => Buffer.from(text, 'utf8');

type SqlCall = { text: string; values: unknown[] };
let sqlCalls: SqlCall[] = [];

function fakeSql(responses: unknown[] = []): NonNullable<PgGatewayPayloadStoreOptions['sql']> {
  let responseIndex = 0;
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join(' '), values });
    return Promise.resolve((responses[responseIndex++] ?? []) as never);
  }) as unknown as NonNullable<PgGatewayPayloadStoreOptions['sql']>;
}

beforeEach(() => {
  sqlCalls = [];
});

describe('gateway payload spool — content addressing', () => {
  it('returns the sha256 of the body as the payloadRef', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = body('{"model":"claude-3","messages":[]}');

    const result = await spool.spool(bytes);

    expect(result.payloadRef).toBe(await sha256Hex(bytes));
    expect(result.bytes).toBe(bytes.byteLength);
  });

  // REGRESSION GUARD. contentAddressing({ prefix: '' }) yields `/<hash>` because the
  // helper always joins with a separator. That leading slash would travel as the
  // admission payloadRef and violate migration 1022's
  // `blob_key ~ '^[0-9a-f]{64}$'` CHECK — a failure that only surfaces against a real
  // Postgres, long after the unit suite is green. Assert the shape here instead.
  it('produces a bare 64-char lowercase hex ref with no prefix or separator', async () => {
    const spool = memoryGatewayPayloadSpool();

    const { payloadRef } = await spool.spool(body('payload'));

    expect(payloadRef).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadRef).not.toContain('/');
  });

  it('keeps the storage key identical to the ref, so a reader holding the bytes can recompute it', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = body('recomputable');

    const { payloadRef } = await spool.spool(bytes);

    expect(GATEWAY_PAYLOAD_ADDRESSING.key(payloadRef!)).toBe(payloadRef);
    expect([...spool.data.keys()]).toEqual([payloadRef]);
  });
});

describe('gateway payload spool — D-004 retry idempotency', () => {
  it('dedupes an identical retried body onto one stored blob', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = body('{"idempotent":true}');

    const first = await spool.spool(bytes);
    const second = await spool.spool(Buffer.from(bytes)); // a distinct buffer, identical content

    expect(second.payloadRef).toBe(first.payloadRef);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    // The point of the property: a retry cannot spawn a second stored payload.
    expect(spool.data.size).toBe(1);
  });

  it('gives different bodies different refs', async () => {
    const spool = memoryGatewayPayloadSpool();

    const a = await spool.spool(body('request-a'));
    const b = await spool.spool(body('request-b'));

    expect(a.payloadRef).not.toBe(b.payloadRef);
    expect(spool.data.size).toBe(2);
  });
});

describe('gateway payload spool — round trip', () => {
  it('reads back the exact bytes, including non-UTF8 content', async () => {
    const spool = memoryGatewayPayloadSpool();
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0xfe]);

    const { payloadRef } = await spool.spool(bytes);
    const readBack = await spool.read(payloadRef!);

    expect(readBack).not.toBeNull();
    expect(Buffer.compare(readBack!, bytes)).toBe(0);
  });

  it('returns null for a ref that does not resolve', async () => {
    const spool = memoryGatewayPayloadSpool();

    expect(await spool.read('a'.repeat(64))).toBeNull();
  });

  it('returns null rather than throwing for a malformed ref', async () => {
    const spool = memoryGatewayPayloadSpool();

    expect(await spool.read('not-a-hash')).toBeNull();
  });
});

describe('gateway payload spool — bodies that are not spooled', () => {
  it('treats an empty body as nothing to spool rather than an error', async () => {
    const spool = memoryGatewayPayloadSpool();

    const result = await spool.spool(Buffer.alloc(0));

    // A null ref is the contract: there is nothing to replay, so admission simply
    // carries no payloadRef. An error here would reject legitimate bodyless requests.
    expect(result.payloadRef).toBeNull();
    expect(result.bytes).toBe(0);
    expect(spool.data.size).toBe(0);
  });

  it('rejects an oversize body with a typed error and stores nothing', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 16 });

    await expect(spool.spool(body('x'.repeat(17)))).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(spool.data.size).toBe(0);
  });

  it('accepts a body exactly at the limit', async () => {
    const spool = memoryGatewayPayloadSpool({ maxBytes: 16 });

    const result = await spool.spool(body('x'.repeat(16)));

    expect(result.payloadRef).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults the ceiling to 32 MiB', () => {
    expect(DEFAULT_MAX_SPOOL_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe('gateway payload spool — D-003 persistence failure never yields a false receipt', () => {
  // The whole point of D-003: a request may fail for "inability to persist truthfully".
  // What it must NEVER do is hand back a ref the gateway cannot later honour.
  const explodingStore = (): BlobStore<{ body: Uint8Array; size: number }> => ({
    head: async () => null,
    put: async () => {
      throw new Error('pg: connection terminated');
    },
    get: async () => null,
    delete: async () => {},
  });

  it('propagates a backend write failure instead of returning a ref', async () => {
    const { createGatewayPayloadSpool } = await import('./payload-spool');
    const spool = createGatewayPayloadSpool({ store: explodingStore() });

    await expect(spool.spool(body('will not persist'))).rejects.toThrow(/connection terminated/);
  });

  it('surfaces a non-413 store rejection as a typed persistence error', async () => {
    const { createGatewayPayloadSpool } = await import('./payload-spool');
    // A store that silently accepts the write but never stores it would make
    // putContentAddressed report success; the failure mode we guard is the store
    // REPORTING a problem, which must become PayloadSpoolPersistenceError.
    const rejectingStore: BlobStore<{ body: Uint8Array; size: number }> = {
      head: async () => null,
      put: async () => {
        throw new PayloadSpoolPersistenceError('inference-gateway: store unavailable', 503);
      },
      get: async () => null,
      delete: async () => {},
    };
    const spool = createGatewayPayloadSpool({ store: rejectingStore });

    await expect(spool.spool(body('nope'))).rejects.toBeInstanceOf(PayloadSpoolPersistenceError);
  });
});

// This double-only describe is deliberately NOT the whole sweep/GC contract: the
// production PgGatewayPayloadStore adapter has a materially different sweep policy
// (expiry-gated, not immediate-on-ref-zero) and is exercised against a REAL Postgres
// in payload-spool.integration.test.ts (EI-21858853737380027) — read that file
// before assuming this block alone proves the production sweep works.
describe('gateway payload spool — refcounted retention', () => {
  it('does not sweep a payload a live receipt still names', async () => {
    const spool = memoryGatewayPayloadSpool();
    const { payloadRef } = await spool.spool(body('pinned by a receipt'));

    await spool.retain(payloadRef!);
    const removed = await spool.sweep();

    expect(removed).toBe(0);
    expect(await spool.read(payloadRef!)).not.toBeNull();
  });

  it('sweeps a payload once its last reference is released', async () => {
    const spool = memoryGatewayPayloadSpool();
    const { payloadRef } = await spool.spool(body('unreferenced'));

    await spool.retain(payloadRef!);
    await spool.release(payloadRef!);
    const removed = await spool.sweep();

    expect(removed).toBe(1);
    expect(await spool.read(payloadRef!)).toBeNull();
  });

  it('keeps a shared payload alive while any receipt still holds it', async () => {
    const spool = memoryGatewayPayloadSpool();
    // Two requests carrying identical bodies dedupe onto ONE blob, so releasing
    // one receipt must not collect the payload the other is still going to execute.
    const bytes = body('shared between two receipts');
    const first = await spool.spool(bytes);
    const second = await spool.spool(Buffer.from(bytes));
    expect(second.payloadRef).toBe(first.payloadRef);

    await spool.retain(first.payloadRef!);
    await spool.retain(second.payloadRef!);
    await spool.release(first.payloadRef!);

    expect(await spool.sweep()).toBe(0);
    expect(await spool.read(first.payloadRef!)).not.toBeNull();
  });

  it('does not drive the refcount negative on a repeated release', async () => {
    const spool = memoryGatewayPayloadSpool();
    const { payloadRef } = await spool.spool(body('double released'));

    await spool.retain(payloadRef!);
    await spool.release(payloadRef!);
    await spool.release(payloadRef!); // a retried settle path
    await spool.retain(payloadRef!); // a fresh receipt takes it

    // If the double release had gone to -1, this retain would leave it at 0 and the
    // sweep would collect a payload that a live receipt is about to execute.
    expect(await spool.sweep()).toBe(0);
    expect(await spool.read(payloadRef!)).not.toBeNull();
  });
});

describe('PgGatewayPayloadStore — EI-21880026143110293 contention retry on the blob-persist write', () => {
  // A pg lock_timeout/statement_timeout error, shaped the way the reported
  // failure named it: `.code` is what `isWorkspaceContended` matches.
  const contentionError = (code: '55P03' | '57014' = '57014') => Object.assign(new Error('canceling statement due to statement timeout'), { code });

  function fakeSqlWithFailures(
    failures: unknown[],
    finalResponse: unknown[] = [],
  ): NonNullable<PgGatewayPayloadStoreOptions['sql']> {
    let call = 0;
    return ((strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push({ text: strings.join(' '), values });
      const idx = call++;
      if (idx < failures.length) return Promise.reject(failures[idx]);
      return Promise.resolve(finalResponse as never);
    }) as unknown as NonNullable<PgGatewayPayloadStoreOptions['sql']>;
  }

  it('retries a transient contention timeout and lands the write without surfacing an error', async () => {
    const store = new PgGatewayPayloadStore({
      sql: fakeSqlWithFailures([contentionError('57014'), contentionError('55P03')]),
      workspaceId: 'ws-payload-test',
      contentionBackoffsMs: [0, 0],
      contentionSleep: async () => {},
    });

    await expect(store.put('a'.repeat(64), body('retried write'))).resolves.toBeUndefined();
    // Two failed attempts (each fails at its first statement) + the attempt that lands,
    // which runs D-017's three statements: find/refresh chunks, insert missing chunks,
    // insert the manifest.
    expect(sqlCalls).toHaveLength(5);
  });

  it('surfaces a typed, contention-labelled error once retries are exhausted — never a bare opaque timeout', async () => {
    const store = new PgGatewayPayloadStore({
      sql: fakeSqlWithFailures([contentionError(), contentionError(), contentionError()]),
      workspaceId: 'ws-payload-test',
      contentionBackoffsMs: [0, 0],
      contentionSleep: async () => {},
    });

    const attempt = store.put('a'.repeat(64), body('never lands'));

    await expect(attempt).rejects.toBeInstanceOf(PayloadSpoolPersistenceError);
    await expect(attempt).rejects.toThrow(/contention retries were exhausted/);
    // 1 initial attempt + 2 backoff retries = 3 calls; the 3rd failure is terminal.
    expect(sqlCalls).toHaveLength(3);
  });

  it('does not retry, and does not relabel, a non-contention failure', async () => {
    const store = new PgGatewayPayloadStore({
      sql: fakeSqlWithFailures([new Error('relation "gateway_payload_blobs" does not exist')]),
      workspaceId: 'ws-payload-test',
      contentionBackoffsMs: [0, 0],
      contentionSleep: async () => {},
    });

    const attempt = store.put('a'.repeat(64), body('genuine failure'));

    await expect(attempt).rejects.toBeInstanceOf(PayloadSpoolPersistenceError);
    await expect(attempt).rejects.toThrow(/does not exist/);
    await expect(attempt).rejects.not.toThrow(/contention retries were exhausted/);
    // Non-contention errors propagate on the first attempt — no retry spent on a real bug.
    expect(sqlCalls).toHaveLength(1);
  });
});

/**
 * A pinned-grace value that collides with nothing else the sweep binds — deliberately not
 * 2h, which is what ttlMs and legacyGraceMs both default to. Distinctness is what lets the
 * assertions below attribute a bound value to a specific predicate leg.
 */
const PINNED_GRACE_PROBE_MS = 11 * 60_000;

describe('PgGatewayPayloadStore — finite retention and bounded GC', () => {
  it('writes a finite default expiry for newly stored payloads', async () => {
    const now = Date.parse('2026-08-30T00:00:00.000Z');
    const store = new PgGatewayPayloadStore({
      sql: fakeSql(),
      workspaceId: 'ws-payload-test',
      now: () => now,
    });

    await store.put('a'.repeat(64), body('finite-retention'));

    // The default must stay within the measured seconds-to-minutes retry/lease
    // window; a day-scale default can fill the host before expiry despite a
    // healthy bounded sweep. WI-10003469: two minutes, not two hours, so most rows
    // are written and deleted inside one checkpoint cycle (see the constant's doc).
    expect(DEFAULT_PAYLOAD_SPOOL_TTL_MS).toBe(2 * 60 * 1000);
    // D-017: find/refresh chunks, insert the (all-new) chunks, then the manifest row.
    expect(sqlCalls).toHaveLength(3);
    const manifest = sqlCalls[2]!;
    expect(manifest.text).toContain('INSERT INTO harness_shared.gateway_payload_blobs');
    expect(manifest.text).toContain('expires_at');
    expect(manifest.values).toContainEqual(new Date(now + DEFAULT_PAYLOAD_SPOOL_TTL_MS));
  });

  it('renews the expiry on a dedupe HEAD hit, so the sweep cannot race the caller’s retain()', async () => {
    const now = Date.parse('2026-09-28T00:00:00.000Z');
    const store = new PgGatewayPayloadStore({
      sql: fakeSql([[{ byte_length: 7 }]]),
      workspaceId: 'ws-payload-test',
      now: () => now,
    });

    await expect(store.head('a'.repeat(64))).resolves.toEqual({ size: 7 });

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain('UPDATE harness_shared.gateway_payload_blobs');
    expect(sqlCalls[0]!.text).toContain('GREATEST(expires_at');
    expect(sqlCalls[0]!.values).toContainEqual(new Date(now + DEFAULT_PAYLOAD_SPOOL_TTL_MS));
  });

  it('backfills bounded legacy rows from created_at and rechecks ref_count in the outer DELETE', async () => {
    const store = new PgGatewayPayloadStore({
      sql: fakeSql([[], [{ blob_key: 'a'.repeat(64) }]]),
      workspaceId: 'ws-payload-test',
      ttlMs: DEFAULT_PAYLOAD_SPOOL_TTL_MS,
      legacyGraceMs: DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS,
      // Deliberately NOT the 2h default: legacyGraceMs and the pinned default are both
      // 7_200_000, so with the default the two branches bind an identical value and the
      // assertions below could not tell them apart — dropping either leg would still pass.
      pinnedGraceMs: PINNED_GRACE_PROBE_MS,
    });

    await expect(store.sweep(7.9)).resolves.toBe(1);

    // Legacy backfill, manifest DELETE, then D-017's chunk DELETE.
    expect(sqlCalls).toHaveLength(3);
    const [backfill, deletion] = sqlCalls;
    expect(backfill!.text).toContain('expires_at IS NULL');
    expect(backfill!.text).toContain('created_at');
    expect(backfill!.text).toContain('LIMIT');
    expect(backfill!.text).toContain('SET expires_at = blobs.created_at');
    expect(backfill!.values).toContain(7);

    // Both the candidate predicate and the outer DELETE must carry the UNREFERENCED
    // branch's ref_count = 0, because retain() can race after candidate selection.
    //
    // ⚠ WI-2141342 narrowed what this means: ref_count = 0 is no longer required by the
    // statement as a whole. The ABANDONED branch reclaims a row with ref_count > 0 that
    // has sat untouched past pinnedGraceMs, and it is guarded by last_accessed_at rather
    // than by the refcount — safely, because retain()/get() both refresh last_accessed_at
    // and so push a re-adopted row back out of the window. Do not "restore" a top-level
    // ref_count = 0 here; that is the bug (the leak was a refcount floor with no time
    // dimension, so a pin that outlived its process was immortal).
    expect((deletion!.text.match(/ref_count = 0/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(deletion!.text).toContain('cumulative_bytes');
    expect(deletion!.text).toContain('sweep_rank = 1');
    expect(deletion!.text).toContain('last_accessed_at');
    expect(deletion!.text).toContain('expires_at IS NULL');
    expect(deletion!.values).toContain(7);
    expect(deletion!.values).toContain(DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES);
    // The abandoned branch binds two values that exist ONLY if it is wired, so each leg
    // fails closed independently if dropped — unlike a text match, which the surviving
    // branch-1 text would still satisfy.
    expect(deletion!.values).toContain(PINNED_GRACE_PROBE_MS); // expired-and-idle leg
    expect(deletion!.values).toContain(DEFAULT_PAYLOAD_SPOOL_LEGACY_GRACE_MS + PINNED_GRACE_PROBE_MS); // NULL-expiry leg
  });

  it('uses the bounded default sweep size when the caller passes a non-finite limit', async () => {
    const store = new PgGatewayPayloadStore({
      sql: fakeSql([[], []]),
      workspaceId: 'ws-payload-test',
    });

    await store.sweep(Number.NaN);

    // Legacy backfill, manifest DELETE, then D-017's chunk DELETE.
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls.flatMap((call) => call.values)).toContain(DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT);
    expect(sqlCalls.flatMap((call) => call.values)).toContain(DEFAULT_PAYLOAD_SPOOL_SWEEP_MAX_BYTES);
  });

  it('uses a byte budget in addition to the row limit', async () => {
    const store = new PgGatewayPayloadStore({
      sql: fakeSql([[], []]),
      workspaceId: 'ws-payload-test',
    });

    await store.sweep(2_000, 123_456);

    const deletion = sqlCalls[1]!;
    expect(deletion.text).toContain('sum(candidate.byte_length)');
    expect(deletion.text).toContain('ranked.cumulative_bytes <=');
    expect(deletion.values).toContain(2_000);
    expect(deletion.values).toContain(123_456);
  });
});

describe('PgGatewayPayloadStore — WI-10002667 single-flight lifecycle sweep', () => {
  // The gateway timer fires every 60s without waiting for the previous pass. A DELETE
  // measured open for 6 minutes under WAL pressure had a second one queued behind it
  // from the same process. These tests hold the DELETE open and fire again.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  // A pass is the manifest DELETE followed by D-017's chunk DELETE. Only the manifest
  // DELETE is held open: holding every DELETE would park the chunk statement on a
  // promise no test settles, and the pass would never resolve.
  const MANIFEST_DELETE = 'DELETE FROM harness_shared.gateway_payload_blobs';
  const CHUNK_DELETE = 'DELETE FROM harness_shared.gateway_payload_chunks';
  const countDeletes = () => sqlCalls.filter((c) => c.text.includes(MANIFEST_DELETE)).length;
  const countChunkDeletes = () => sqlCalls.filter((c) => c.text.includes(CHUNK_DELETE)).length;

  function heldDeleteSql(outcomes: Array<'resolve' | 'reject'> = ['resolve', 'resolve']) {
    const pending: Array<{ resolve: (v: never) => void; reject: (e: unknown) => void }> = [];
    let settled = 0;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ');
      sqlCalls.push({ text, values });
      if (!text.includes(MANIFEST_DELETE)) return Promise.resolve([] as never);
      return new Promise<never>((resolve, reject) => pending.push({ resolve, reject }));
    }) as unknown as NonNullable<PgGatewayPayloadStoreOptions['sql']>;
    const settleNext = (rows: unknown[] = [{ blob_key: 'a'.repeat(64) }]) => {
      const next = pending.shift()!;
      const outcome = outcomes[settled++] ?? 'resolve';
      if (outcome === 'reject') next.reject(Object.assign(new Error('WALWrite timeout'), { code: '57014' }));
      else next.resolve(rows as never);
    };
    return { sql, settleNext, pendingCount: () => pending.length };
  }

  it('does not start a second DELETE while one is still running; the overlapping call joins it', async () => {
    const held = heldDeleteSql();
    const store = new PgGatewayPayloadStore({ sql: held.sql, workspaceId: 'ws-payload-test' });

    const first = store.sweep(2_000);
    await flush();
    const second = store.sweep(2_000);
    const third = store.sweep(50);
    await flush();

    expect(countDeletes()).toBe(1);
    expect(held.pendingCount()).toBe(1);
    expect(countChunkDeletes()).toBe(0); // the chunk sweep waits for the manifest DELETE

    held.settleNext([{ blob_key: 'a'.repeat(64) }, { blob_key: 'b'.repeat(64) }]);
    await expect(first).resolves.toBe(2);
    await expect(second).resolves.toBe(2);
    await expect(third).resolves.toBe(2);
    expect(countDeletes()).toBe(1);
    // The joined callers share one pass, so the chunk sweep ran once, not three times.
    expect(countChunkDeletes()).toBe(1);
  });

  it('runs a fresh pass once the previous one has settled', async () => {
    const held = heldDeleteSql();
    const store = new PgGatewayPayloadStore({ sql: held.sql, workspaceId: 'ws-payload-test' });

    const first = store.sweep(2_000);
    await flush();
    held.settleNext();
    await expect(first).resolves.toBe(1);

    const second = store.sweep(2_000);
    await flush();
    expect(countDeletes()).toBe(2);
    held.settleNext([]);
    await expect(second).resolves.toBe(0);
  });

  it('clears the guard when a pass fails, so a rejected DELETE cannot wedge GC', async () => {
    const held = heldDeleteSql(['reject', 'resolve']);
    const store = new PgGatewayPayloadStore({ sql: held.sql, workspaceId: 'ws-payload-test' });

    const failing = store.sweep(2_000);
    const joined = store.sweep(2_000);
    await flush();
    expect(countDeletes()).toBe(1);
    held.settleNext();
    await expect(failing).rejects.toThrow('WALWrite timeout');
    await expect(joined).rejects.toThrow('WALWrite timeout');

    const retry = store.sweep(2_000);
    await flush();
    expect(countDeletes()).toBe(2);
    held.settleNext();
    await expect(retry).resolves.toBe(1);
  });
});
