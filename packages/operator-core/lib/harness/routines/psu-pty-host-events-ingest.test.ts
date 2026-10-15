/**
 * psu-pty host-event ingest + retention (P-007 / D-006).
 *
 * The load-bearing test here is `never deletes a file whose ingest failed`. Ingest-then-GC is
 * the ONLY thing standing between a retention sweep and permanent loss of the diagnostic rows
 * this plan exists to preserve, and an ordering bug there is silent: the file count falls,
 * which is exactly what a working sweep also looks like.
 */
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  hostEventDigest,
  ingestPsuPtyHostEvents,
  ownerIdFromEventLogFilename,
  parseHostEventFile,
} from './psu-pty-host-events-ingest';

const DAY_MS = 86_400_000;

/**
 * Minimal stand-in for the postgres.js client. It must be BOTH callable as `sql(rows, ...cols)`
 * and usable as a tagged template, because the ingester uses both forms in one statement.
 */
function makeFakeSql(opts: { failInsert?: boolean; insertReceipt?: { count?: unknown } } = {}) {
  const statements: string[] = [];
  const inserts: Array<{ text: string; values: unknown[] }> = [];
  let inserted = 0;

  const sql = ((first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      const text = (first as unknown as string[]).join(' ? ');
      statements.push(text);
      if (/INSERT INTO/.test(text)) {
        if (opts.failInsert) return Promise.reject(new Error('insert boom'));
        inserts.push({ text, values: rest });
        // The UNNEST insert binds one array per column and every column array has the same
        // length, so the first array-valued parameter gives the chunk size.
        const firstArray = rest.find((v) => Array.isArray(v)) as unknown[] | undefined;
        const n = firstArray ? firstArray.length : 0;
        inserted += n;
        return Promise.resolve(Object.assign([], opts.insertReceipt ?? { count: n }));
      }
      return Promise.resolve(Object.assign([], { count: 0 }));
    }
    // The `sql(rows, ...cols)` multi-row helper. Reaching this from the ingester would mean
    // the UNNEST form had been replaced, so fail loudly instead of quietly supporting both.
    throw new Error('unexpected sql() helper call — the ingest insert must bind via unnest');
  }) as never;

  return { sql, statements, inserts, insertedCount: () => inserted };
}

async function makeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'psu-pty-ingest-'));
}

function row(kind: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ts, kind, ...extra });
}

describe('hostEventDigest', () => {
  it('routes only confirmed named Claude auth faults, and retains failed reactions for retry', async () => {
    const dir = await makeDir();
    const ts = '2026-10-11T06:35:00.000Z';
    const filename = join(dir, 'su-failed.events.jsonl');
    await writeFile(filename, [
      row('auth-block-detected', ts, { agent: 'claude', accountId: 'bad', confirmedProviderFailure: true }),
      row('auth-block-detected', ts, { agent: 'claude', accountId: 'echo', confirmedProviderFailure: false }),
      row('auth-block-detected', ts, { agent: 'codex', accountId: 'stale-memory', confirmedProviderFailure: true }),
    ].join('\n'));
    const onCredentialFailure = vi.fn(async (): Promise<void> => { throw new Error('health write unavailable'); });
    const { sql } = makeFakeSql();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failed;
    try {
      failed = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, onCredentialFailure });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('health write unavailable'));
    } finally { error.mockRestore(); }
    expect(failed.ingestErrors).toBe(1);
    expect(failed.rowsInserted).toBe(0);
    expect(await readdir(dir)).toContain('su-failed.events.jsonl');
    onCredentialFailure.mockResolvedValue(undefined);
    const succeeded = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, onCredentialFailure });
    expect(succeeded.rowsInserted).toBe(3);
    expect(onCredentialFailure).toHaveBeenCalledTimes(2);
    expect(onCredentialFailure).toHaveBeenLastCalledWith({ accountId: 'bad', ownerId: 'su-failed', observedAt: Date.parse(ts), workspaceId: 'ws' });
  });

  it('is stable regardless of payload key insertion order', () => {
    const a = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'turn-delivered', {
      label: 'x',
      polls: 2,
    });
    const b = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'turn-delivered', {
      polls: 2,
      label: 'x',
    });
    expect(a).toBe(b);
  });

  it('does not collide across tuple boundaries', () => {
    // The property that justifies JSON-encoding the tuple instead of joining it with a
    // separator: shifting a character across a field boundary must change the digest. A naive
    // concatenation without a separator would make these two identical.
    const a = hostEventDigest('su-ab', 'c2026', 'kind', {});
    const b = hostEventDigest('su-a', 'bc2026', 'kind', {});
    expect(a).not.toBe(b);
  });

  it('distinguishes the delivery outcome that the rate depends on', () => {
    const delivered = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'turn-delivered', {});
    const expired = hostEventDigest('su-1', '2026-09-22T00:00:00.000Z', 'busy-gate-expired', {});
    expect(delivered).not.toBe(expired);
  });
});

describe('ownerIdFromEventLogFilename', () => {
  it('extracts the owner and refuses anything else', () => {
    expect(ownerIdFromEventLogFilename('su-abc.events.jsonl')).toBe('su-abc');
    expect(ownerIdFromEventLogFilename('carry-drills.events.jsonl')).toBe('carry-drills');
    expect(ownerIdFromEventLogFilename('notes.txt')).toBeNull();
    expect(ownerIdFromEventLogFilename('.events.jsonl')).toBeNull();
  });
});

describe('parseHostEventFile', () => {
  it('splits ts/kind out of the payload and keeps the rest', () => {
    const { rows, malformed } = parseHostEventFile(
      'ws',
      'su-1',
      row('turn-delivered', '2026-09-22T00:00:00.000Z', { label: 'turn inject', polls: 3 }),
    );
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('turn-delivered');
    expect(rows[0]!.ts).toBe('2026-09-22T00:00:00.000Z');
    expect(rows[0]!.payload).toEqual({ label: 'turn inject', polls: 3 });
  });

  it('counts a severed leading line without discarding the rest of the file', () => {
    // Front-truncation at EVENT_LOG_MAX_BYTES routinely cuts the first line in half. Dropping
    // the whole file on that would throw away every good row behind it.
    const text = [
      '{"ts":"2026-09-22T00:00:00.000Z","kin',
      row('busy-gate-expired', '2026-09-22T00:00:01.000Z'),
      row('turn-delivered', '2026-09-22T00:00:02.000Z'),
    ].join('\n');
    const { rows, malformed } = parseHostEventFile('ws', 'su-1', text);
    expect(malformed).toBe(1);
    expect(rows.map((r) => r.kind)).toEqual(['busy-gate-expired', 'turn-delivered']);
  });

  it('rejects rows without a usable ts or kind rather than inventing one', () => {
    const text = [
      JSON.stringify({ kind: 'turn-delivered' }),
      JSON.stringify({ ts: '2026-09-22T00:00:00.000Z' }),
      JSON.stringify({ ts: 'not-a-date', kind: 'turn-delivered' }),
      JSON.stringify(['an', 'array']),
    ].join('\n');
    const { rows, malformed } = parseHostEventFile('ws', 'su-1', text);
    expect(rows).toHaveLength(0);
    expect(malformed).toBe(4);
  });
});

describe('ingestPsuPtyHostEvents', () => {
  it('ingests rows and reports what it read', async () => {
    const dir = await makeDir();
    await writeFile(
      join(dir, 'su-1.events.jsonl'),
      [
        row('turn-delivered', '2026-09-22T00:00:00.000Z'),
        row('busy-gate-expired', '2026-09-22T00:00:01.000Z'),
      ].join('\n'),
    );
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.filesScanned).toBe(1);
    expect(res.rowsRead).toBe(2);
    expect(res.rowsInserted).toBe(2);
    expect(res.filesDeleted).toBe(0); // fresh file — never GC'd
  });

  it('binds jsonb as a pre-stringified ::jsonb[] parameter, never a raw object', async () => {
    // The EI-607 footgun, made falsifiable. On the getOrgPg client sql.json() THROWS and a
    // bare object does not bind at all — while on the default-config db() pool the opposite
    // is true and JSON.stringify double-encodes. A regression either way would surface only
    // at runtime, so assert the WIRE FORM here: the payload column must arrive as JSON text
    // and the statement must carry the explicit array cast.
    const dir = await makeDir();
    await writeFile(
      join(dir, 'su-1.events.jsonl'),
      row('turn-delivered', '2026-09-22T00:00:00.000Z', { label: 'turn inject', polls: 3 }),
    );
    const { sql, inserts } = makeFakeSql();
    await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.text).toContain('::jsonb[]');

    const payloadArray = inserts[0]!.values.find(
      (v): v is string[] =>
        Array.isArray(v) && v.length > 0 && typeof v[0] === 'string' && v[0].startsWith('{'),
    );
    expect(payloadArray).toBeDefined();
    expect(JSON.parse(payloadArray![0]!)).toEqual({ label: 'turn inject', polls: 3 });
  });

  it('NEVER deletes a file whose ingest failed, even when it is past retention', async () => {
    // THE safety property. If this inverts, retention silently destroys the only copy of the
    // rows. `filesRetainedUningested` exists so the refusal is visible rather than inferred.
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);

    const { sql } = makeFakeSql({ failInsert: true });
    // The ingester deliberately console.error()s a failed INSERT rather than swallowing it —
    // a bare `catch {}` there once made a 100%-failing write look exactly like "nothing to
    // ingest". vitest-fail-on-console turns any unasserted console.error into a failure, so
    // the log has to be captured AND asserted: that keeps the non-swallowing guarantee pinned
    // instead of merely tolerated.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    let res;
    try {
      res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    } finally {
      spy.mockRestore();
    }

    expect(res.filesRetainedUningested).toBe(1);
    expect(res.filesDeleted).toBe(0);
    expect(await readdir(dir)).toContain('su-old.events.jsonl');
    expect(res.ingestErrors).toBe(1);
    expect(res.firstIngestError).toMatch(/insert boom/);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toMatch(/INSERT failed for su-old/);
  });

  it('deletes a past-retention file once its rows are persisted', async () => {
    // The positive control for the test above: without this, "never deletes" would also pass
    // for a sweep that simply never deletes anything.
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);

    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });

    expect(res.rowsInserted).toBe(1);
    expect(res.filesDeleted).toBe(1);
    expect(await readdir(dir)).not.toContain('su-old.events.jsonl');
  });

  it.each([
    { label: 'missing', receipt: {} },
    { label: 'null', receipt: { count: null } },
    { label: 'negative', receipt: { count: -1 } },
    { label: 'fractional', receipt: { count: 0.5 } },
    { label: 'greater than the batch', receipt: { count: 2 } },
    { label: 'NaN', receipt: { count: Number.NaN } },
  ])('retains the file and reports a $label INSERT row count', async ({ receipt }) => {
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);
    const { sql } = makeFakeSql({ insertReceipt: receipt });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));
    let res;
    try {
      res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    } finally {
      spy.mockRestore();
    }
    expect(res.rowsInserted).toBe(0);
    expect(res.filesIngested).toBe(0);
    expect(res.filesRetainedUningested).toBe(1);
    expect(res.filesDeleted).toBe(0);
    expect(res.ingestErrors).toBe(1);
    expect(res.firstIngestError).toMatch(/INSERT row count/);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toMatch(/INSERT failed for su-old/);
    expect(await readdir(dir)).toContain('su-old.events.jsonl');
  });

  it('accepts a measured zero INSERT count when all rows already exist', async () => {
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);
    const { sql } = makeFakeSql({ insertReceipt: { count: 0 } });
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.rowsInserted).toBe(0);
    expect(res.filesIngested).toBe(1);
    expect(res.ingestErrors).toBe(0);
    expect(res.filesDeleted).toBe(1);
    expect(await readdir(dir)).not.toContain('su-old.events.jsonl');
  });

  it('never deletes a file a live host may still be appending to', async () => {
    // mtime IS the liveness evidence — a running session writes continuously.
    const dir = await makeDir();
    await writeFile(
      join(dir, 'su-live.events.jsonl'),
      row('turn-delivered', '2026-09-22T00:00:00.000Z'),
    );
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.filesDeleted).toBe(0);
    expect(await readdir(dir)).toContain('su-live.events.jsonl');
  });

  it('dryRun mutates nothing on disk and issues no INSERT or DELETE', async () => {
    const dir = await makeDir();
    const path = join(dir, 'su-old.events.jsonl');
    await writeFile(path, row('busy-gate-expired', '2026-07-01T00:00:00.000Z'));
    const old = (Date.now() - 60 * DAY_MS) / 1000;
    await utimes(path, old, old);

    const { sql, statements } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.filesDeleted).toBe(1); // reported as "would delete"
    expect(await readdir(dir)).toContain('su-old.events.jsonl');
    expect(statements.filter((s) => /INSERT INTO|DELETE FROM/.test(s))).toHaveLength(0);
  });

  it('is a no-op when the directory does not exist', async () => {
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({
      sql,
      workspaceId: 'ws',
      dir: join(tmpdir(), 'psu-pty-ingest-does-not-exist-12345'),
    });
    expect(res.filesScanned).toBe(0);
    expect(res.rowsInserted).toBe(0);
  });

  it('bounds the work per run', async () => {
    const dir = await makeDir();
    for (let i = 0; i < 5; i++) {
      await writeFile(
        join(dir, `su-${i}.events.jsonl`),
        row('turn-delivered', '2026-09-22T00:00:00.000Z'),
      );
    }
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, maxFilesPerRun: 2 });
    expect(res.filesScanned).toBe(2);
  });

  /**
   * REGRESSION GUARD (measured 2026-09-22). Selection was `entries.filter(...).slice(0, n)` —
   * an UNSORTED readdir prefix. readdir order is stable for an unchanging directory, so the
   * routine re-processed the SAME arbitrary files every run: 500 of 15,040 real files (3.3%),
   * with the other 14,540 — including every file written that day — permanently unreachable.
   * It still reported `filesScanned: 500` and no error while the table sat frozen for 92
   * minutes across multiple fires, which is why nothing caught it from the result alone.
   *
   * The guard picks its victim FROM THE LIVE readdir order rather than assuming one, so it
   * stays falsifying on any filesystem: whichever file the old prefix would have missed is
   * made the newest, and the assertion is that its rows were ingested anyway.
   */
  it('selects the NEWEST files, not a readdir prefix', async () => {
    const dir = await makeDir();
    for (let i = 0; i < 6; i++) {
      await writeFile(
        join(dir, `su-${i}.events.jsonl`),
        row('turn-delivered', '2026-09-22T00:00:00.000Z', { seq: i }),
      );
    }
    const maxFilesPerRun = 2;
    const order = (await readdir(dir)).filter((f) => f.endsWith('.events.jsonl'));
    // The file the OLD prefix-slice could never reach.
    const unreachable = order[order.length - 1];
    expect(order.length).toBeGreaterThan(maxFilesPerRun);

    const old = new Date(Date.now() - 10 * DAY_MS);
    for (const f of order) await utimes(join(dir, f), old, old);
    const fresh = new Date();
    await utimes(join(dir, unreachable), fresh, fresh);

    const { sql, inserts } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir, maxFilesPerRun });

    expect(res.filesScanned).toBe(maxFilesPerRun);
    // UNNEST binds one array per column in the order (workspace_id, owner_id, ts, kind, …),
    // so the second array parameter is the owner column.
    const owners = inserts.flatMap((i) => (i.values[1] as string[]) ?? []);
    expect(owners).toContain(ownerIdFromEventLogFilename(unreachable));
    // The population is reported beside the sample, so a bounded run cannot read as a total.
    expect(res.filesEligible).toBe(order.length);
    expect(res.filesUnprocessed).toBe(order.length - maxFilesPerRun);
  });

  it('ignores files that are not per-owner event logs', async () => {
    const dir = await makeDir();
    await writeFile(join(dir, 'README.txt'), 'not an event log');
    const { sql } = makeFakeSql();
    const res = await ingestPsuPtyHostEvents({ sql, workspaceId: 'ws', dir });
    expect(res.filesScanned).toBe(0);
  });
});
