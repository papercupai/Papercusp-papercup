import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ db: null as FreshPgDb | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  withWorkspace: async <T>(_workspaceId: string, fn: (tx: FreshPgDb['sql']) => Promise<T>) => fn(h.db!.sql),
}));

const { defaultAutobindDeps, decideAutobind, runKey, runSpecEvidenceAutobind } = await import('./spec-evidence-autobind');
const file = 'test/feature.test.ts';
const target = { workspaceId: 'ws', harnessSlug: 'app', planSlug: 'plan', specId: 'SPEC-1',
  specRevision: 1, workItemId: 'WI-1', barKey: 'R-1', testFile: file };
const sha = 'a'.repeat(40);

beforeAll(async () => {
  h.db = await createFreshPgDb('spec-evidence-autobind');
  await h.db.sql.unsafe(`CREATE TABLE harness_shared.test_runs (
    id bigint GENERATED ALWAYS AS IDENTITY, workspace_id text, harness_slug text,
    file_path text, status text, source text DEFAULT 'local', commit_sha text,
    worktree_dirty boolean, started_at timestamptz DEFAULT now(), finished_at timestamptz DEFAULT now())`);
  await h.db.sql.unsafe(`CREATE TABLE harness_shared.spec_evidence_bindings (
    id bigint GENERATED ALWAYS AS IDENTITY, workspace_id text, harness_slug text,
    plan_slug text, spec_id text, spec_revision integer, work_item_id text,
    evidence_kind text, evidence_ref text, test_run_id bigint, details jsonb,
    observed_at timestamptz DEFAULT now(), retracted_at timestamptz)`);
}, 90_000);
afterAll(async () => { await h.db?.cleanup(); });
beforeEach(async () => {
  await h.db!.sql`TRUNCATE harness_shared.test_runs, harness_shared.spec_evidence_bindings RESTART IDENTITY`;
});

describe('autobind preserves logical clause proof across work-item origins', () => {
  const richDetails = { adequacy: { targeted: 'r-1', testCases: ['the exact falsifying case'],
    scenarioIds: ['recovery'], causalPairIds: ['baseline-mutant'] } };

  async function seedProof(patch: Record<string, unknown> = {}) {
    await h.db!.sql`
      INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty)
      VALUES ('ws','app',${file},'pass',${sha},false)`;
    const row = { workspace_id: 'ws', harness_slug: 'app', plan_slug: 'plan', spec_id: 'SPEC-1',
      spec_revision: 1, work_item_id: 'WI-manual-origin', evidence_kind: 'test', evidence_ref: file,
      test_run_id: 1, details: richDetails, retracted_at: null, ...patch };
    await h.db!.sql`INSERT INTO harness_shared.spec_evidence_bindings ${h.db!.sql(row)}`;
    const bind = vi.fn(async () => ({ ok: true as const }));
    const deps = { ...defaultAutobindDeps(), loadTargets: async () => [target], bind,
      measuredPaths: async () => ({ ok: true as const, root: '/repo', paths: [file] }),
      uncommittedPaths: async () => [] };
    return { deps, bind };
  }

  it('does not append weaker metadata for the same receipt bound by another work-item', async () => {
    const { deps, bind } = await seedProof();
    const result = await runSpecEvidenceAutobind('ws', deps);
    expect(bind).not.toHaveBeenCalled();
    expect(result.decisions).toEqual({ noop: 1, bind: 0, retract: 0 });
    const rows = await h.db!.sql`SELECT details FROM harness_shared.spec_evidence_bindings`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual(richDetails);
  });

  it.each([
    { workspace_id: 'foreign' }, { harness_slug: 'other' }, { plan_slug: 'other' },
    { spec_id: 'OTHER' }, { spec_revision: 2 }, { evidence_ref: 'other.test.ts' },
    { evidence_kind: 'mutation' }, { retracted_at: new Date().toISOString() },
  ])('does not let a different proof suppress the required bind: %j', async (patch) => {
    const { deps, bind } = await seedProof(patch);
    await runSpecEvidenceAutobind('ws', deps);
    expect(bind).toHaveBeenCalledExactlyOnceWith(target, expect.objectContaining({ id: 1 }));
  });

  it('still retracts cross-work-item proof when a later failure contradicts its receipt', async () => {
    const { deps } = await seedProof();
    await h.db!.sql`
      INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty)
      VALUES ('ws','app',${file},'fail',${sha},false)`;
    const retract = vi.fn(async () => {});
    await runSpecEvidenceAutobind('ws', { ...deps, retract });
    expect(retract).toHaveBeenCalledExactlyOnceWith(target, 1, expect.stringContaining('test-run 2'));
  });
});

describe('autobind selects containing-commit proof from the real ledger', () => {
  it('keeps a clean pass when newer passes are dirty, unknown, commitless, or malformed', async () => {
    await h.db!.sql`
      INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty) VALUES
      ('ws','app',${file},'pass',${sha},false),
      ('ws','app',${file},'pass',${sha},true),
      ('ws','app',${file},'pass',${sha},NULL),
      ('ws','app',${file},'pass',NULL,false),
      ('ws','app',${file},'pass','abc',false),
      ('foreign','app',${file},'pass',${sha},false),
      ('ws','other',${file},'pass',${sha},false)`;
    const selected = (await defaultAutobindDeps().loadLatestRuns('ws', [target])).get(runKey('app', file));
    expect(selected).toMatchObject({ id: 1, status: 'pass', commitSha: sha, worktreeDirty: false });
    expect(decideAutobind(target, selected!, [])).toMatchObject({ kind: 'bind', run: { id: 1 } });
  });

  it('does not resurrect an old clean pass after a dirty failure or error', async () => {
    for (const status of ['fail', 'error']) {
      await h.db!.sql`TRUNCATE harness_shared.test_runs RESTART IDENTITY`;
      await h.db!.sql`
        INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty) VALUES
        ('ws','app',${file},'pass',${sha},false),
        ('ws','app',${file},${status},${sha},true),
        ('ws','app',${file},'pass',${sha},true)`;
      const selected = (await defaultAutobindDeps().loadLatestRuns('ws', [target])).get(runKey('app', file));
      expect(selected).toMatchObject({ id: 2, status, worktreeDirty: true });
      expect(decideAutobind(target, selected!, [{ id: 7, testRunId: 1, evidenceRef: file,
        observedAt: new Date().toISOString() }])).toMatchObject({ kind: 'retract', bindingIds: [7] });
    }
  });

  it('ignores mutation calibration, old runs and unqualified passes', async () => {
    await h.db!.sql`
      INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,commit_sha,worktree_dirty,source,started_at) VALUES
      ('ws','app',${file},'pass',${sha},false,'mutation-probe',now()),
      ('ws','app',${file},'pass',${sha},false,'local',now()-interval '15 days'),
      ('ws','app',${file},'pass',${sha},true,'local',now())`;
    expect(await defaultAutobindDeps().loadLatestRuns('ws', [target])).toEqual(new Map());
  });
});
