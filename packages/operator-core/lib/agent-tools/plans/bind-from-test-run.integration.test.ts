/** EI-23688165604547604: exercise the ledger query, not a fabricated root field. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, repoRoot: '' }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(_workspace: string, fn: (tx: postgres.Sql) => Promise<T>) =>
    h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
}));
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: [{ slug: 'web', path: h.repoRoot }] }),
  resolveHarnessContentPath: () => h.repoRoot,
}));

const { defaultTestRunBindingDeps, expandTestRunBinding } = await import('./bind-from-test-run');
const scope = { workspaceId: 'ws-recorded-root', harnessSlug: 'web' };
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('bind-from-recorded-root');
  h.sql = db.sql;
  // test_runs has NO root column. The reporter stores it in execution_details.
  // Keep that production distinction explicit so SELECT root cannot pass here.
  await db.sql.unsafe(`CREATE TABLE harness_shared.test_runs (
    id bigserial PRIMARY KEY, file_path text, status text, source text,
    harness_slug text, workspace_id text, commit_sha text,
    worktree_dirty boolean, execution_details jsonb,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
  )`);
  h.repoRoot = await mkdtemp(path.join(tmpdir(), 'bind-recorded-root-'));
  const dir = path.join(h.repoRoot, 'libs/child/src');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'subject.ts'), 'export const subject = true;\n');
  await writeFile(path.join(dir, 'subject.test.ts'), "import { subject } from './subject';\n");
});

afterAll(async () => {
  if (h.repoRoot) await rm(h.repoRoot, { recursive: true, force: true });
  await db?.cleanup();
});

it.each(['object', 'string'] as const)('loads the reporter root from JSONB %s and expands the nested test to canonical paths', async (encoding) => {
  const nestedRoot = path.join(h.repoRoot, 'libs/child');
  const details = { root: nestedRoot, collected: true, skipped: false, executed: true, testLayer: 'unit' };
  const [run] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs
      (file_path, status, source, harness_slug, workspace_id, worktree_dirty, execution_details, finished_at)
    VALUES ('src/subject.test.ts', 'pass', 'local', ${scope.harnessSlug}, ${scope.workspaceId},
      false, ${db.sql.json(encoding === 'string' ? JSON.stringify(details) : details)}, now())
    RETURNING id`;

  expect(await defaultTestRunBindingDeps.loadRun(scope, run!.id)).toMatchObject({ root: nestedRoot });
  expect(await expandTestRunBinding({ workItemId: 'WI-root', specId: 'SPEC-root', fromTestRun: run!.id }, scope))
    .toMatchObject({
      ok: true,
      binding: {
        evidenceRef: 'libs/child/src/subject.test.ts',
        measurement: { sourcePaths: ['libs/child/src/subject.ts'], testPaths: ['libs/child/src/subject.test.ts'] },
        details: { testRun: { recordedRoot: nestedRoot, recordedFilePath: 'src/subject.test.ts' } },
      },
    });
});

it('preserves absent historical roots as unknown instead of inventing a checkout', async () => {
  const [run] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs (file_path, execution_details)
    VALUES ('src/subject.test.ts', '{}'::jsonb) RETURNING id`;
  expect(await defaultTestRunBindingDeps.loadRun(scope, run!.id)).toMatchObject({ root: null });
});
