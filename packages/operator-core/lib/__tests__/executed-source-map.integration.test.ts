/**
 * WI-6554700010019200 — the pass-proof READ against a real Postgres, through the production `pg`
 * client.
 *
 * The readers select the path arrays as JSON (`to_json(...)`) because `pg`'s JavaScript text[]
 * parser made the operator-core gate read take 19.5s of its 15s budget. The unit tests feed rows
 * through a fake client, so only a real server can show that the JSON form returns the SAME
 * arrays — including paths that text[] has to quote or escape, and empty arrays.
 *
 * The table comes from the REAL migrations that define it, never a hand-rolled CREATE TABLE.
 *
 * Requires Docker (shared testcontainers PG).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  connectExecutedMapPg,
  loadExecutedSourceMap,
  loadReuseProofs,
  loadReuseProofFiles,
} from '../../../../scripts/lib/executed-source-map.mjs';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');
const WS = '@probe/read';
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);
const SIBLING_SHA = 'c'.repeat(40);
const OWN_SHA = 'd'.repeat(40);
/** WI-6554700010019324: the reading install's object store, and a sibling install's. */
const OWN_GIT_DIR = '/repo/.git';
const SIBLING_GIT_DIR = '/sibling/.git';

/** Paths text[] output must quote or escape; JSON must hand back the same strings. */
const AWKWARD = [
  'src/quoted,"module.ts',
  'src/back\\slash.ts',
  'src/{brace}.ts',
  'src/sp ace.ts',
  'NULL',
  'src/ünï.ts',
  "src/semi;colon'.ts",
];

describe('pass-proof reads against real Postgres (WI-6554700010019200)', () => {
  let db: FreshPgDb;
  let client: Client;

  beforeAll(async () => {
    db = await createFreshPgDb('esmread');
    const migrations = readdirSync(SQL_DIR)
      .filter((f) => f.endsWith('.sql') && readFileSync(join(SQL_DIR, f), 'utf8').includes('test_executed_sources'))
      .sort();
    // Positive control: if the migration dir moved, fail loudly instead of testing nothing.
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    for (const f of migrations) await applyMigrationForTest(db.sql, join(SQL_DIR, f));

    const insert = (
      file: string,
      sha: string,
      at: string,
      modules: string[],
      readPaths: string[],
      gitDir: string | null = null,
    ) => db.sql`
      INSERT INTO harness_shared.test_executed_sources
        (workspace_name, test_file, recorded_sha, executed_modules, module_count, recorded_at,
         read_paths, inputs_captured, opaque_reasons, run_context, runner_identity, recorded_git_dir)
      VALUES (${WS}, ${file}, ${sha}, ${modules}, ${modules.length}, ${at},
              ${readPaths}, true, ${['reason,with"quotes']}, 'green-checkpoint', 'runner', ${gitDir})`;
    await insert('src/awkward.test.ts', OLD_SHA, '2026-10-20T00:00:00Z', ['src/stale.ts'], ['fixtures/stale.json']);
    await insert('src/awkward.test.ts', NEW_SHA, '2026-10-21T00:00:00Z', ['src/awkward.test.ts', ...AWKWARD], AWKWARD);
    // Newest of all, but recorded by a sibling install at a sha this repository may not hold.
    await insert('src/awkward.test.ts', SIBLING_SHA, '2026-10-22T00:00:00Z', ['src/sibling.ts'], [], SIBLING_GIT_DIR);
    await insert('src/empty.test.ts', NEW_SHA, '2026-10-21T00:00:00Z', ['src/empty.test.ts'], []);
    // This install's own proof wins over a newer pre-1552 row nobody can attribute.
    await insert('src/own.test.ts', OWN_SHA, '2026-10-20T00:00:00Z', ['src/own.test.ts'], [], OWN_GIT_DIR);
    await insert('src/own.test.ts', NEW_SHA, '2026-10-21T00:00:00Z', ['src/legacy.ts'], []);

    client = await connectExecutedMapPg({ env: { PAPERCUSP_TEST_RUNS_DB_URL: db.url } });
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await db?.cleanup();
  });

  it('loadReuseProofs returns the newest proof with every awkward path intact', async () => {
    const { proofs, rows } = await loadReuseProofs({
      client,
      workspaceName: WS,
      runContext: 'green-checkpoint',
      runnerIdentity: 'runner',
      gitDir: OWN_GIT_DIR,
    });
    expect(rows).toBe(3);
    expect(proofs.get('src/awkward.test.ts')).toMatchObject({
      recordedSha: NEW_SHA,
      executedModules: ['src/awkward.test.ts', ...AWKWARD],
      readPaths: AWKWARD,
      inputsCaptured: true,
      opaqueReasons: ['reason,with"quotes'],
      runContext: 'green-checkpoint',
      runnerIdentity: 'runner',
    });
    expect(proofs.get('src/empty.test.ts')).toMatchObject({ executedModules: ['src/empty.test.ts'], readPaths: [] });
  });

  it('loadReuseProofs reads its own install ahead of legacy rows and never a sibling install (WI-6554700010019324)', async () => {
    const { proofs } = await loadReuseProofs({
      client,
      workspaceName: WS,
      runContext: 'green-checkpoint',
      runnerIdentity: 'runner',
      gitDir: OWN_GIT_DIR,
    });
    expect(proofs.get('src/own.test.ts')?.recordedSha).toBe(OWN_SHA);
    expect(proofs.get('src/awkward.test.ts')?.recordedSha).toBe(NEW_SHA);

    const sibling = await loadReuseProofs({
      client,
      workspaceName: WS,
      runContext: 'green-checkpoint',
      runnerIdentity: 'runner',
      gitDir: SIBLING_GIT_DIR,
    });
    expect(sibling.proofs.get('src/awkward.test.ts')?.recordedSha).toBe(SIBLING_SHA);
    expect(sibling.proofs.get('src/own.test.ts')?.recordedSha).toBe(NEW_SHA);
  });

  it('P005 selects runtime before newest-per-file selection and proof membership', async () => {
    const workspaceName = '@probe/runtime-read';
    const file = 'src/runtime.test.ts';
    for (const [runtime, sha, at] of [
      ['node', OLD_SHA, '2026-10-20T00:00:00Z'],
      ['bun', NEW_SHA, '2026-10-21T00:00:00Z'],
      [null, SIBLING_SHA, '2026-10-22T00:00:00Z'],
    ]) {
      await db.sql`INSERT INTO harness_shared.test_executed_sources
        (workspace_name, test_file, recorded_sha, executed_modules, module_count,
         recorded_at, inputs_captured, run_context, runner_identity, recorded_git_dir)
        VALUES (${workspaceName}, ${file}, ${sha}, ${[file]}, 1,
          ${at}, true, 'green-checkpoint', ${runtime}, ${OWN_GIT_DIR})`;
    }
    const options = { client, workspaceName, runContext: 'green-checkpoint', gitDir: OWN_GIT_DIR };
    for (const [runnerIdentity, recordedSha] of [['node', OLD_SHA], ['bun', NEW_SHA]]) {
      const loaded = await loadReuseProofs({ ...options, runnerIdentity, files: [file] });
      expect(loaded.rows).toBe(1);
      expect(loaded.proofs.get(file)).toMatchObject({ runnerIdentity, recordedSha });
      expect(await loadReuseProofFiles({ ...options, runnerIdentity })).toEqual({ files: [file], rows: 1 });
      const map = await loadExecutedSourceMap({ ...options, runnerIdentity, repoRoot: '/repo', files: [file] });
      expect(map.map.get(join('/repo', file))?.recordedSha).toBe(recordedSha);
    }
    for (const runnerIdentity of [null, '', 'other-runtime']) {
      expect(await loadReuseProofs({ ...options, runnerIdentity })).toEqual({ proofs: new Map(), rows: 0 });
      expect(await loadReuseProofFiles({ ...options, runnerIdentity })).toEqual({ files: [], rows: 0 });
      expect(await loadExecutedSourceMap({ ...options, runnerIdentity, repoRoot: '/repo' }))
        .toEqual({ map: new Map(), rows: 0 });
    }
  });

  it('loadExecutedSourceMap re-anchors the same awkward module paths', async () => {
    const repoRoot = '/repo';
    const { map, rows } = await loadExecutedSourceMap({
      client,
      workspaceName: WS,
      repoRoot,
      gitDir: OWN_GIT_DIR,
      runnerIdentity: 'runner',
      files: ['src/awkward.test.ts'],
    });
    expect(rows).toBe(1);
    const entry = map.get(join(repoRoot, 'src/awkward.test.ts'));
    expect(entry?.recordedSha).toBe(NEW_SHA);
    expect([...(entry?.executed ?? [])].sort()).toEqual(
      ['src/awkward.test.ts', ...AWKWARD].map((p) => join(repoRoot, p)).sort(),
    );
  });
});
