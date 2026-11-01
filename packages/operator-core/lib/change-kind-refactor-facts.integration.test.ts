import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));
const { nativeRefactorFactsResolver } = await import('./change-kind-refactor-facts');

const WS = 'default';
const HARNESS = 'papercusp';
const SUBJECT = 'packages/a/lib/release/removed.ts';
const GUARD = `sync-delta-guard:lint:guard-reachability:${SUBJECT}`;
const FAMILY = 'ts:v1:renamed:removed-fingerprint';
let db: OrgTestDb;
let root: string;
let landing: string;
let nextId = 0;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'refactor fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'refactor fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  } }).trim();
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  root = await mkdtemp(join(tmpdir(), 'refactor-native-sql-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packages/a'), { recursive: true });
  await writeFile(join(root, 'packages/a/broken.ts'), 'export function broken( {');
  // Only the database routing is under test; the fixed detector fixture reports a
  // nonempty population with the removed subject absent.
  await writeFile(join(root, 'scripts/check-lint-guard-reachability.mjs'),
    'console.log(JSON.stringify({modules:{measurable:true,population:1,inventory:[{module:"packages/a/lib/kept.ts",dead:false}]}}));\n');
  await writeFile(join(root, 'README.md'), 'before\n');
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture parent');
  await writeFile(join(root, 'README.md'), 'after\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'fixture landing');
  landing = git('rev-parse', 'HEAD');
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.work_items`;
});

async function seed(payload: unknown, condition: string | null = null, updated = 1, workspace = WS): Promise<void> {
  await db.adminSql`INSERT INTO harness_shared.work_items
    (workspace_id, harness_slug, feature_id, item_kind, title, summary, status, payload, condition_key, created_ts, updated_ts)
    VALUES (${workspace}, ${HARNESS}, ${`EI-${++nextId}`}, 'change', ${`native refactor SQL fixture ${nextId}`},
      'isolated fixture', 'open', ${db.adminSql.json(JSON.parse(JSON.stringify(payload)))}, ${condition}, 1, ${updated})`;
}

function resolve(finding: string) {
  return nativeRefactorFactsResolver({ root, workspaceId: WS, harness: HARNESS })({
    landingCommit: landing, beforeRunIds: [], afterRunIds: [], finding,
  });
}

describe('native refactor filed-finding queries against the migrated work-item schema', () => {
  it('uses the base table timestamp rather than the compatibility view column', async () => {
    const columns = await db.adminSql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND table_name = 'work_items'`;
    expect(columns.map(c => c.column_name)).toContain('updated_ts');
    expect(columns.map(c => c.column_name)).not.toContain('updated_at');
  });

  it('reads the registered guard record through the native SQL and closed detector adapter', async () => {
    await seed({ filedBy: 'system:sync-batch-lint-guards', paths: [SUBJECT], _conditionUpsert: { conditionKey: GUARD } }, GUARD);
    expect(await resolve(GUARD)).toMatchObject({ findingStillReported: false, errors: [] });
  });

  it('reads clone areas without using the compatibility view timestamp', async () => {
    await seed({ cloneArea: { families: [{ id: FAMILY, members: [{ path: 'packages/a/removed.ts' }] }] } }, 'clone-area:packages/a');
    expect(await resolve('clone-area:packages/a')).toMatchObject({ findingStillReported: false, errors: [] });
  });

  it('selects the latest matching clone family by updated_ts', async () => {
    await seed({ cloneArea: { families: [{ id: FAMILY, members: [{ path: 'packages/a/broken.ts' }] }] } }, null, 1);
    await seed({ cloneArea: { families: [{ id: FAMILY, members: [{ path: 'packages/a/removed.ts' }] }] } }, null, 2);
    expect(await resolve(`clone-family:${FAMILY}`)).toMatchObject({ findingStillReported: false, errors: [] });
  });

  it('does not accept a guard row from another workspace or an unregistered reporter', async () => {
    await seed({ filedBy: 'system:sync-batch-lint-guards', paths: [SUBJECT], _conditionUpsert: { conditionKey: GUARD } }, GUARD, 9, 'foreign');
    let facts = await resolve(GUARD);
    expect(facts.findingStillReported).toBeNull();
    expect(facts.errors).toEqual([expect.stringContaining('no filed cleanup item names')]);
    await seed({ filedBy: 'agent', paths: [SUBJECT], _conditionUpsert: { conditionKey: GUARD } }, GUARD);
    facts = await resolve(GUARD);
    expect(facts.findingStillReported).toBeNull();
    expect(facts.errors).toEqual([expect.stringContaining('no filed cleanup item names')]);
  });
});
