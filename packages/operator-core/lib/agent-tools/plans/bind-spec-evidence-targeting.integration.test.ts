/**
 * P-043 (review-system-rework-reduction-2026-09-23), RSR-P-043-A / AUTO-BAR-R-10: the bind-time
 * falsifiability TARGETING refusal, through the real tool, the real `plan_spec_clause_revisions`
 * row and the real bindings table.
 *
 * The unit suite (bind-spec-evidence-targeting.test.ts) pins the bind rule to the evaluator's rule
 * with injected clauses. What only a real database can show is the part the BAR promises to the
 * agent doing the binding: a target the evaluator would reject leaves NOTHING behind (no row to
 * prove, audit and later retract), the refusal names the accepted target, and the corrected call
 * it hands back binds on the same real path.
 *
 * Fixture: the schema below mirrors spec-evidence-store.integration.test.ts (the canonical
 * real-Postgres fixture for these tables). It lives in its own file on purpose — that suite is
 * measured by live proof on several plans, so editing it stales proof nobody here holds. If a
 * migration adds a column to one of the hand-rolled harness_shared tables below, update BOTH
 * fixtures (EI-21270668928342264 is the recurring break when one falls behind).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { SpecClauseWrite } from './spec-clauses-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, repoRoot: '' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: [{ slug: 'web', path: h.repoRoot }] }),
  resolveHarnessContentPath: (registry: { projects: Array<{ slug: string; path: string }> }, slug: string) =>
    registry.projects.find((project) => project.slug === slug)?.path,
}));

const WORKSPACE = 'ws-bind-targeting';
const HARNESS = 'web';
const PLAN = 'targeting-plan';
vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: WORKSPACE,
      harnessSlug: opts.harnessSlug?.trim() || HARNESS,
    }),
  };
});

const specs = await import('./spec-clauses-store');
const bindTool = (await import('./bind-spec-evidence')).default;

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => path.resolve(here, `../../../../../libs/papercusp/libs/db/sql/${name}`);
const MIGRATIONS_IN_ORDER = [
  '1150-test-runs-execution-details.sql',
  '851-first-class-plan-spec-clauses.sql',
  '852-plan-spec-clause-integrity.sql',
  '1111-acceptance-bar-contract-seed.sql',
  '855-work-item-spec-evidence-bindings.sql',
  '929-spec-clause-falsifier.sql',
  '930-spec-clause-falsifier-null-safe.sql',
  '1174-spec-evidence-binding-retraction.sql',
  '1175-spec-evidence-dedup-partial-on-live.sql',
  '1176-spec-evidence-drop-total-dedup-contract-phase.sql',
].map(migration);

const CTX = {
  isSuperuser: true,
  uiClientId: 'su-bind-targeting-integration',
  workspaceId: WORKSPACE,
  harnessSlug: HARNESS,
} as never;

const SPEC_ID = 'SPEC-043-01';
const SIBLING_SPEC_ID = 'SPEC-044-01';
const KILLED = { collected: true, skipped: false, executed: true, outcome: 'killed', testLayer: 'integration' };

let db: FreshPgDb;

function clause(over: Partial<SpecClauseWrite> = {}): SpecClauseWrite {
  return {
    harnessSlug: HARNESS,
    planSlug: PLAN,
    specId: SPEC_ID,
    expectedRevision: 0,
    planItemId: 'P-043',
    behavior: 'A binding the adequacy rule would fail on targeting is refused at bind, naming the accepted targets.',
    behaviorClass: 'failure',
    requiredEvidence: ['integration bind refusal'],
    requiredTestLayers: ['integration'],
    mutationRequired: true,
    lifecycleStatus: 'active',
    acceptanceRef: 'D-043',
    actorId: 'su-bind-targeting-integration',
    ...over,
  };
}

async function seedTestRun(): Promise<number> {
  const [run] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs (workspace_id, harness_slug) VALUES (${WORKSPACE}, ${HARNESS}) RETURNING id`;
  return Number(run!.id);
}

type BindResult = Record<string, unknown> & { ok: boolean };

async function bindMutation(targeted: unknown): Promise<BindResult> {
  const testRunId = await seedTestRun();
  const out = (await bindTool.handler(
    {
      harness: HARNESS,
      slug: PLAN,
      binding: {
        workItemId: 'WI-143',
        specId: SPEC_ID,
        sourceFingerprint: 'git:abc123',
        evidenceKind: 'mutation',
        evidenceRef: `mutation-probe:targeting-guard#target=${String(targeted)}`,
        testRunId,
        details: { adequacy: { ...KILLED, ...(targeted === undefined ? {} : { targeted }) } },
      },
    } as never,
    CTX,
  )) as { data: { results: BindResult[] } };
  expect(out.data.results).toHaveLength(1);
  return out.data.results[0]!;
}

async function liveBindingCount(): Promise<number> {
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.spec_evidence_bindings WHERE retracted_at IS NULL`;
  return Number(row!.n);
}

beforeAll(async () => {
  h.repoRoot = await mkdtemp(path.join(tmpdir(), 'bind-targeting-integration-'));
  db = await createFreshPgDb('bind-spec-evidence-targeting');
  h.sql = db.sql;
  await db.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin; END IF;
  END $$;`);
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      template text,
      content text NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      seq integer NOT NULL,
      owner_gate_marker text,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
    );
    CREATE TABLE harness_shared.harness_plan_assertions (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      val_id text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      verify_text text NOT NULL,
      evidence_text text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'todo',
      requires_test boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, val_id)
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      source_plan_slug text,
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.carry_notes (
      workspace_id text NOT NULL, scope text NOT NULL, note text,
      journal jsonb NOT NULL DEFAULT '[]'::jsonb, updated_ts bigint NOT NULL,
      deps jsonb, body_ts bigint, attested_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, scope)
    );
    CREATE TABLE harness_shared.test_runs (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text,
      harness_slug text,
      file_path text,
      status text,
      finished_at timestamptz,
      run_group_id text,
      commit_sha text,
      worktree_dirty boolean NOT NULL DEFAULT false,
      source text NOT NULL DEFAULT 'local'
    );
    CREATE TABLE harness_shared.testing_surfaces (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL
    );
    CREATE TABLE harness_shared.coverage_evidence (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      surface_ref bigint NOT NULL REFERENCES harness_shared.testing_surfaces(id) ON DELETE CASCADE
    );
  `);
  for (const file of MIGRATIONS_IN_ORDER) await applyMigrationForTest(db.sql, file);
}, 90_000);

afterAll(async () => {
  await Promise.all([db?.cleanup(), rm(h.repoRoot, { recursive: true, force: true })]);
}, 30_000);

beforeEach(async () => {
  await db.sql`TRUNCATE
    harness_shared.carry_notes,
    harness_shared.spec_evidence_bindings,
    harness_shared.work_item_spec_revision_edges,
    harness_shared.plan_spec_clause_revisions,
    harness_shared.plan_spec_clauses,
    harness_shared.harness_plan_assertions,
    harness_shared.plan_items,
    harness_shared.harness_plans,
    harness_shared.coverage_evidence,
    harness_shared.testing_surfaces,
    harness_shared.test_runs,
    harness_shared.work_items RESTART IDENTITY CASCADE`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug) VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN})`;
  await db.sql`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
    VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, 'P-043', 1)`;
  await db.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, source_plan_slug)
    VALUES (${WORKSPACE}, ${HARNESS}, 'WI-143', ${PLAN})`;
  await specs.setSpecClause(clause());
});

describe('plans:bind-spec-evidence targeting refusal against the real clause store (P-043 / AUTO-BAR-R-10)', () => {
  it('refuses boolean, sibling-spec and missing targets before any row is written, naming the accepted target', async () => {
    for (const targeted of [true, SIBLING_SPEC_ID, undefined]) {
      const result = await bindMutation(targeted);
      expect(result).toMatchObject({
        ok: false,
        error: 'mutation_target_rejected',
        clause: `${SPEC_ID}@1`,
        targeted: targeted ?? null,
      });
      // This clause declares no falsifier scenarios, so its own specId is the ONE accepted target.
      const accepted = result.acceptedTargets as string[];
      expect(accepted).toHaveLength(1);
      expect(accepted[0]!.toUpperCase()).toBe(SPEC_ID);
      expect(String(result.reason)).toContain(accepted[0]!);
      // The refusal hands back a corrected call whose only change is the accepted target.
      const corrected = (
        result.correctedCall as { tool: string; args: { binding: { details: { adequacy: Record<string, unknown> } } } }
      );
      expect(corrected.tool).toBe('plans:bind-spec-evidence');
      expect(corrected.args.binding.details.adequacy).toMatchObject({ ...KILLED, targeted: accepted[0] });
    }
    // Refused before the store: nothing was written to prove, audit or retract later.
    expect(await liveBindingCount()).toBe(0);
  });

  it('binds the target the refusal named, on the same real path', async () => {
    const refused = await bindMutation(true);
    expect(refused.ok).toBe(false);
    const accepted = await bindMutation((refused.acceptedTargets as string[])[0]);
    expect(accepted).toMatchObject({ ok: true, status: 'created', specId: SPEC_ID, specRevision: 1 });
    expect(await liveBindingCount()).toBe(1);
  });

  it('judges the target against the clause REVISION being bound, not a stale one', async () => {
    // Positive control for the revision scoping: the same own-specId target stays accepted on a
    // new revision, and a sibling target stays refused there too.
    await specs.setSpecClause(clause({ expectedRevision: 1, behavior: 'Revised: the refusal names every accepted target.' }));
    const sibling = await bindMutation(SIBLING_SPEC_ID);
    expect(sibling).toMatchObject({ ok: false, error: 'mutation_target_rejected', clause: `${SPEC_ID}@2` });
    const own = await bindMutation((sibling.acceptedTargets as string[])[0]);
    expect(own).toMatchObject({ ok: true, specId: SPEC_ID, specRevision: 2 });
  });
});

describe('adequacy attestation advisories against the real store (EI-24903278232142036)', () => {
  type Advisory = Record<string, unknown> & { code?: string; clauses?: unknown };
  type Envelope = { data: { results: BindResult[]; advisories?: Advisory[] } };
  const ATTESTATION = /^adequacy_attestation_/;
  const attestationAdvisories = (out: Envelope) => (out.data.advisories ?? []).filter((a) => ATTESTATION.test(String(a.code)));

  async function bind(ref: string, attestations: Record<string, unknown>): Promise<Envelope> {
    const testRunId = await seedTestRun();
    return (await bindTool.handler(
      {
        harness: HARNESS,
        slug: PLAN,
        binding: {
          workItemId: 'WI-143',
          specId: SPEC_ID,
          sourceFingerprint: 'git:abc123',
          evidenceKind: 'mutation',
          evidenceRef: ref,
          testRunId,
          details: { adequacy: { ...KILLED, targeted: SPEC_ID.toLowerCase(), ...attestations } },
        },
      } as never,
      CTX,
    )) as Envelope;
  }

  async function retract(bindingId: number): Promise<Envelope> {
    return (await bindTool.handler(
      { harness: HARNESS, slug: PLAN, retract: [{ bindingId, reason: 'superseded by the fresh re-bind in this test' }] } as never,
      CTX,
    )) as Envelope;
  }

  it('names the attestations a fresh re-bind lacks, then the ones retracting their last carrier removes', async () => {
    const attested = await bind('mutation-probe:attest#1', { falsifiable: true, pathReachable: true });
    expect(attested.data.results[0]).toMatchObject({ ok: true, status: 'created' });
    expect(attestationAdvisories(attested)).toEqual([]);
    const olderId = Number(attested.data.results[0]!.id);

    const fresh = await bind('mutation-probe:attest#2', {});
    expect(fresh.data.results[0]).toMatchObject({ ok: true, status: 'created' });
    const freshId = Number(fresh.data.results[0]!.id);
    expect(attestationAdvisories(fresh)).toEqual([
      expect.objectContaining({
        code: 'adequacy_attestation_gap',
        clauses: [
          {
            bindingId: freshId,
            specId: SPEC_ID,
            specRevision: 1,
            missing: [
              { key: 'falsifiable', carriedBy: [olderId] },
              { key: 'pathReachable', carriedBy: [olderId] },
            ],
          },
        ],
      }),
    ]);

    const retracted = await retract(olderId);
    expect(retracted.data.results[0]).toMatchObject({ ok: true, status: 'retracted' });
    expect(attestationAdvisories(retracted)).toEqual([
      expect.objectContaining({
        code: 'adequacy_attestation_lost',
        clauses: [
          {
            specId: SPEC_ID,
            specRevision: 1,
            lost: [
              { key: 'falsifiable', lostFrom: [olderId] },
              { key: 'pathReachable', lostFrom: [olderId] },
            ],
          },
        ],
      }),
    ]);
  });

  it('stays silent when the re-bind re-attests, and when a retraction leaves another carrier live', async () => {
    const older = await bind('mutation-probe:attest#1', { falsifiable: true, pathReachable: true });
    const fresh = await bind('mutation-probe:attest#2', { falsifiable: true, pathReachable: true });
    expect(fresh.data.results[0]).toMatchObject({ ok: true, status: 'created' });
    expect(attestationAdvisories(fresh)).toEqual([]);
    const retracted = await retract(Number(older.data.results[0]!.id));
    expect(retracted.data.results[0]).toMatchObject({ ok: true, status: 'retracted' });
    expect(attestationAdvisories(retracted)).toEqual([]);
  });
});
