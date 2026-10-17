/** EI-23688165604547604: exercise the ledger query, not a fabricated root field. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const { defaultTestRunBindingDeps, decideMutationReaim, expandTestRunBinding } = await import('./bind-from-test-run');
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
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, framework text
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
  const details = { root: nestedRoot, runStartedAt: new Date().toISOString(), collected: true, skipped: false, executed: true, testLayer: 'unit' };
  const [run] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs
      (file_path, status, source, harness_slug, workspace_id, worktree_dirty, execution_details, finished_at)
    VALUES ('src/subject.test.ts', 'pass', 'local', ${scope.harnessSlug}, ${scope.workspaceId},
      false, ${db.sql.json(encoding === 'string' ? JSON.stringify(details) : details)}, now())
    RETURNING id`;

  expect(await defaultTestRunBindingDeps.loadRun(scope, run!.id)).toMatchObject({ root: nestedRoot });
  const expanded = await expandTestRunBinding({ workItemId: 'WI-root', specId: 'SPEC-root', fromTestRun: run!.id }, scope);
  expect(expanded, JSON.stringify(expanded))
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

describe('mutation survivor consumption controls (WI-6554700010015717)', () => {
  const fingerprint = 'a'.repeat(64);
  const mutation = {
    schemaVersion: 1, probeInvocationId: 'probe-survivor-0001', mode: 'copy-out',
    subjectPath: 'pkg/subject.ts', mutateExpression: 's/verified/true/', againstCommit: null,
    subjectBeforeSha256: 'b'.repeat(64), subjectAfterSha256: 'c'.repeat(64),
    mutantDiff: '-verified\n+true\n', mutantDiffTruncated: false,
    testCommandSha256: 'd'.repeat(64), testFileSha256: fingerprint,
  };

  async function insertRun(file: string, leg: string, overrides: {
    status?: string; workspace?: string; harness?: string; source?: string;
    descriptor?: Record<string, unknown>; details?: Record<string, unknown>;
    finished?: boolean;
  } = {}) {
    const details = {
      schemaVersion: 1, root: '/fixture/root', testNamePattern: null,
      mutationPhase: leg, collectionFailed: false, passed: 3, failed: 0, skipped: 0,
      mutation: { ...mutation, leg, ...overrides.descriptor }, ...overrides.details,
    };
    const [row] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.test_runs
        (file_path, status, source, harness_slug, workspace_id, execution_details, started_at, finished_at)
      VALUES (${file}, ${overrides.status ?? 'pass'}, ${overrides.source ?? 'mutation-probe'},
        ${overrides.harness ?? scope.harnessSlug}, ${overrides.workspace ?? scope.workspaceId},
        ${db.sql.json(details)}, ${leg === 'mutant' ? '2026-10-16T01:00:00Z' : '2026-10-16T01:00:02Z'},
        ${overrides.finished === false ? null : leg === 'mutant' ? '2026-10-16T01:00:01Z' : '2026-10-16T01:00:03Z'})
      RETURNING id`;
    return Number(row!.id);
  }

  it('does not call a passing mutant a survivor when the identical poisoned-module control also passed', async () => {
    const file = 'pkg/module-not-loaded.test.ts';
    await insertRun(file, 'mutant');
    await insertRun(file, 'load-check');
    const survivors = await defaultTestRunBindingDeps.loadMutationSurvivors!(scope, [file], fingerprint, 'probe-catch-0001');
    expect(survivors).toEqual([]);
    expect(decideMutationReaim({ testRunId: 42, caught: mutation, survivors, justification: undefined })).toEqual({ ok: true, record: null });
  });

  it.each([
    ['no control', null],
    ['real module-load failure', { status: 'fail' }],
    ['unmeasured control', { details: { collectionFailed: null } }],
    ['no executed cases', { details: { passed: 0 } }],
    ['skipped cases', { details: { skipped: 1 } }],
    ['unfinished control', { finished: false }],
    ['other invocation', { descriptor: { probeInvocationId: 'probe-other-0001' } }],
    ['changed test bytes', { descriptor: { testFileSha256: 'e'.repeat(64) } }],
    ['changed command', { descriptor: { testCommandSha256: 'e'.repeat(64) } }],
    ['changed subject', { descriptor: { subjectPath: 'pkg/other.ts' } }],
    ['changed subject bytes', { descriptor: { subjectAfterSha256: 'e'.repeat(64) } }],
    ['other workspace', { workspace: 'other-workspace' }],
    ['other harness', { harness: 'other-harness' }],
    ['other source', { source: 'local' }],
    ['other root', { details: { root: '/other/root' } }],
    ['other selected cases', { details: { testNamePattern: 'unrelated' } }],
  ] as const)('keeps the refusal for %s', async (label, control) => {
    const file = `pkg/survivor-${label.replaceAll(' ', '-')}.test.ts`;
    const id = await insertRun(file, 'mutant');
    if (control) await insertRun(file, 'load-check', control);
    const survivors = await defaultTestRunBindingDeps.loadMutationSurvivors!(scope, [file], fingerprint, 'probe-catch-0001');
    expect(survivors.map((row) => row.id)).toEqual([id]);
    expect(decideMutationReaim({ testRunId: 42, caught: mutation, survivors, justification: undefined }))
      .toMatchObject({ ok: false, error: 'mutation_reaim_unjustified', unjustifiedSurvivors: [{ testRunId: id, why: 'same-mutation-as-catch' }] });
  });

  it('does not use a passing control for a different test file', async () => {
    const file = 'pkg/guard-still-survives.test.ts';
    const id = await insertRun(file, 'mutant');
    await insertRun('pkg/other-guard.test.ts', 'load-check');
    expect(await defaultTestRunBindingDeps.loadMutationSurvivors!(scope, [file], fingerprint, 'probe-catch-0001'))
      .toMatchObject([{ id }]);
  });
});
