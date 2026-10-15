/**
 * A REAL-SQLite `D1Database` for tests, with the actual migrations applied.
 *
 * Why not `fake-d1.ts` here: that harness is a hand-written SQL-STRING MATCHER,
 * and the P-010 commerce feature's core promise is a DATABASE CONSTRAINT —
 * `UNIQUE (provider, provider_event_id)` on `commerce_webhook_inbox`, plus the
 * `ON CONFLICT` clauses that lean on it. A string matcher cannot enforce a
 * unique index, so a test written against it would pass whether or not the
 * constraint existed, which is precisely the property under test.
 *
 * This runs the migration files themselves through `node:sqlite` — the same
 * mechanism `scripts/generate-db-row-types.mjs` already uses to derive row types
 * from the canonical schema — so the tests exercise the shipped DDL rather than
 * a hand-maintained restatement of it. Tests execute in Node, so `node:sqlite`
 * is available even though the Worker runtime is workerd.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

type Row = Record<string, unknown>;

/** D1 binds `undefined` as NULL; node:sqlite rejects it, and booleans too. */
function normalizeBinds(binds: unknown[]): unknown[] {
  return binds.map((b) => {
    if (b === undefined) return null;
    if (typeof b === 'boolean') return b ? 1 : 0;
    return b;
  });
}

function makeStatement(db: DatabaseSync, sql: string, binds: unknown[] = []): D1PreparedStatement {
  const stmt: Partial<D1PreparedStatement> = {
    bind: (...next: unknown[]) => makeStatement(db, sql, next),
    first: async <T>(column?: string) => {
      const row = db.prepare(sql).get(...(normalizeBinds(binds) as never[])) as Row | undefined;
      if (row === undefined) return null;
      return (column ? (row[column] as T) : (row as unknown as T)) ?? null;
    },
    all: async <T>() => {
      const results = db.prepare(sql).all(...(normalizeBinds(binds) as never[])) as unknown as T[];
      return { results, success: true, meta: {} } as unknown as D1Result<T>;
    },
    run: async <T>() => {
      // Report rows changed as real D1 does (`meta.changes`): conditional upserts
      // (ON CONFLICT … WHERE / DO NOTHING) decide their outcome from it.
      const info = db.prepare(sql).run(...(normalizeBinds(binds) as never[]));
      return { results: [], success: true, meta: { changes: Number(info.changes) } } as unknown as D1Result<T>;
    },
    // `raw` is deliberately not implemented: nothing in the commerce path calls
    // it, and D1's overloaded `columnNames` signature cannot be satisfied by a
    // single generic without a cast that would hide a real mismatch later.
  };
  return stmt as D1PreparedStatement;
}

/** An in-memory D1 with every `migrations/*.sql` applied in filename order. */
export function makeSqliteDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) raw.exec(readFileSync(join(migrationsDir, file), 'utf8'));

  // D1 batches are atomic and serialize on the database. Awaiting each local
  // statement otherwise lets another batch BEGIN on this same connection.
  let pendingBatch: Promise<unknown> = Promise.resolve();
  const db: Partial<D1Database> = {
    prepare: (sql: string) => makeStatement(raw, sql),
    batch: <T>(statements: D1PreparedStatement[]) => {
      const result = pendingBatch.then(async () => {
        const out: D1Result<T>[] = [];
        raw.exec('BEGIN IMMEDIATE');
        try {
          for (const s of statements) out.push((await s.run()) as D1Result<T>);
          raw.exec('COMMIT');
          return out;
        } catch (error) {
          raw.exec('ROLLBACK');
          throw error;
        }
      });
      // A failed transaction releases the queue after rollback too.
      pendingBatch = result.then(() => undefined, () => undefined);
      return result;
    },
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { db: db as D1Database, raw };
}
