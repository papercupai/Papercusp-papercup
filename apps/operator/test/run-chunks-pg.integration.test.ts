/**
 * run-chunks-pg.integration.test.ts — real-Postgres coverage for a durable
 * orchestrator module (P-008, Phase 1).
 *
 * `@papercusp/orchestrator`'s *-pg modules are unit-tested only against a
 * hand-rolled `makeMockPg` that records SQL strings and replays canned rows —
 * so the real `ON CONFLICT DO NOTHING` semantics, the `bigint` ts coercion, and
 * the per-(workspace, harness, run) WHERE scoping are NEVER exercised against an
 * actual database. This test runs the real `appendChunkPg` / `readChunksAfterPg`
 * / `pruneChunksPg` against a throwaway testcontainer Postgres, using the
 * module's own `RUN_CHUNKS_DDL`, so a regression in the real SQL is caught.
 *
 * Pattern mirrors fresh-migrate.integration.test.ts: a fresh DB per file so the
 * shared `harness_shared.harness_run_chunks` table is clean; unique runIds keep
 * the individual tests independent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable module
import {
  appendChunkPg,
  readChunksAfterPg,
  pruneChunksPg,
  RUN_CHUNKS_DDL,
  type RunChunksPgContext,
} from '../../../libs/papercusp/packages/orchestrator/src/run-chunks-pg';

let adminUri: string;
let dbName: string;
let sql: postgres.Sql;
let ctx: RunChunksPgContext;

const rid = () => `run_${randomBytes(5).toString('hex')}`;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `rc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), {
    max: 4,
    onnotice: () => {},
    // Mirror production (libs/papercusp/libs/db/src/connection.ts): BIGINT → number.
    // Without this the default client returns int8 as a string and the module's
    // `ts` would be a string — a test-client artifact, not a real-app behavior.
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bigint: { to: 20, from: [20], serialize: (x: any) => String(x), parse: (x: string) => Number(x) } as any,
    },
  });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(RUN_CHUNKS_DDL);
  // postgres.Sql is structurally the OrchestratorPg tagged-template signature.
  ctx = { pg: sql as unknown as RunChunksPgContext['pg'], workspaceId: 'ws_test', harnessSlug: 'demo' };
}, 60_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('run-chunks-pg against real Postgres', () => {
  it('appends a chunk and reads it back', async () => {
    const runId = rid();
    await appendChunkPg(ctx, runId, 0, 'hello');
    const rows = await readChunksAfterPg(ctx, runId, -1);
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(0);
    expect(rows[0].chunkData).toBe('hello');
    // ts is stored as BIGINT — the module must coerce it back to a JS number.
    expect(typeof rows[0].ts).toBe('number');
    expect(rows[0].ts).toBeGreaterThan(0);
  });

  it('returns chunks ordered by seq and respects fromSeq', async () => {
    const runId = rid();
    // Insert out of order to prove the ORDER BY seq is real.
    await appendChunkPg(ctx, runId, 2, 'c2');
    await appendChunkPg(ctx, runId, 0, 'c0');
    await appendChunkPg(ctx, runId, 1, 'c1');

    const all = await readChunksAfterPg(ctx, runId, -1);
    expect(all.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(all.map((r) => r.chunkData)).toEqual(['c0', 'c1', 'c2']);

    const afterZero = await readChunksAfterPg(ctx, runId, 0);
    expect(afterZero.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('is idempotent on (run, seq) — ON CONFLICT DO NOTHING keeps the first value', async () => {
    const runId = rid();
    await appendChunkPg(ctx, runId, 0, 'first');
    await appendChunkPg(ctx, runId, 0, 'second'); // same PK → ignored
    const rows = await readChunksAfterPg(ctx, runId, -1);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkData).toBe('first');
  });

  it('scopes reads by run_id', async () => {
    const runA = rid();
    const runB = rid();
    await appendChunkPg(ctx, runA, 0, 'a');
    await appendChunkPg(ctx, runB, 0, 'b');
    const a = await readChunksAfterPg(ctx, runA, -1);
    expect(a.map((r) => r.chunkData)).toEqual(['a']);
  });

  it('isolates by workspace_id — a different workspace cannot read these chunks', async () => {
    const runId = rid();
    await appendChunkPg(ctx, runId, 0, 'mine');
    const otherCtx: RunChunksPgContext = { ...ctx, workspaceId: 'ws_other' };
    const seenByOther = await readChunksAfterPg(otherCtx, runId, -1);
    expect(seenByOther).toHaveLength(0);
    // …and the owning workspace still sees it.
    expect(await readChunksAfterPg(ctx, runId, -1)).toHaveLength(1);
  });

  it('prunes all chunks for a run and reports the count', async () => {
    const runId = rid();
    await appendChunkPg(ctx, runId, 0, 'x');
    await appendChunkPg(ctx, runId, 1, 'y');
    const deleted = await pruneChunksPg(ctx, runId);
    expect(deleted).toBe(2);
    expect(await readChunksAfterPg(ctx, runId, -1)).toHaveLength(0);
  });
});
