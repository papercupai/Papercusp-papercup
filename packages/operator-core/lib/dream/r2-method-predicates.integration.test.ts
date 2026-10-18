import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import candidate from './__fixtures__/r2-method-candidate.json';

// Exact frozen, UNAPPLIED METHOD SQL. Synthetic rows only, on the migrated test
// database. A passing fixture proves predicate behavior, never live acceptance.
const tables = ['spec_evidence_bindings', 'plan_spec_clauses', 'plan_spec_clause_revisions', 'test_runs', 'harness_text_artifacts'];
const ws = 'papercusp-workspace', harness = 'papercusp';
const plan = 'self-learning-dreaming-verified-shipment-2026-10-03', spec = 'AUTO-BAR-R-2-P-002';
const binding = 1;
const verifier = 2;
const wanted = ['reader:containing-build', 'reader:wrong-runtime-refuses', 'reader:exact-runtime-scope',
  'r2:complete-current-observation', 'r2:dream-resolved-caps', 'r2:gym-null-refusal', 'reader:uncertainty-preserved',
  'r2:full-admission-and-spend', 'r2:scout-zero-route-lens-cap-provenance', 'r2:actual-attempts-or-explicit-policy-skips'];
type Row = Record<string, unknown>;

describe('R2 frozen METHOD predicates on current PostgreSQL schema', () => {
  let db: OrgTestDb;
  let raw: Row;
  let finishedAt: string;
  let startedAt: string;
  const identity = { workspace_id: ws, harness_slug: harness, plan_slug: plan, spec_id: spec };
  async function insert(table: string, row: Row) {
    // Clones inherit current production column TYPES, not production rows or
    // constraints. jsonb_populate_record catches schema/type mismatches too.
    await db.adminSql.unsafe(`INSERT INTO r2_fixture.${table} SELECT * FROM jsonb_populate_record(NULL::harness_shared.${table}, $1::jsonb)`, [JSON.stringify(row)]);
  }
  async function read() {
    return Promise.all(candidate.sql.map(async sql => {
      const rows = await db.adminSql.unsafe(sql.replaceAll('harness_shared.', 'r2_fixture.'));
      return rows[0]?.ok;
    }));
  }
  async function saveRaw() {
    await db.adminSql`UPDATE r2_fixture.harness_text_artifacts SET content = ${JSON.stringify(raw)}`;
  }
  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql`CREATE SCHEMA r2_fixture`;
    for (const table of tables) await db.adminSql.unsafe(`CREATE TABLE r2_fixture.${table} AS SELECT * FROM harness_shared.${table} WITH NO DATA`);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); if (!process.env.KEEP_TEST_PG) await teardownTestPg(); });
  beforeEach(async () => {
    for (const table of tables) await db.adminSql.unsafe(`TRUNCATE r2_fixture.${table}`);
    const now = Date.now();
    startedAt = new Date(now - 1000).toISOString();
    finishedAt = new Date(now).toISOString();
    const runtime = { host: 'port-3170', processId: 'fixture-process', buildSha: 'fixture-build' };
    const scope = { workspaceId: ws, potSlug: harness, since: new Date(now - 86_400_000).toISOString(), until: startedAt, expectedRuntime: runtime };
    const observed = (value: unknown) => ({ status: 'observed', value, sourceRefs: ['fixture:authoritative-source'] });
    const tick = (lens: string, offset: number) => ({ origin: 'scout', ideatorCount: 1, lenses: [lens], ideasRouted: 0, costUsd: 0.12,
      oneIdeatorZeroRoute: true, raw: { workspace_id: ws, pot_slug: harness, install_slug: harness, origin: 'scout',
        tick_at: new Date(now - offset).toISOString(), budget_used_usd: 0.12, detail: { ideators: [{ lens, ok: true, raw: 0, produced: 0 }] } } });
    const observation = { schemaVersion: 'dream-control-observations-v1', status: 'observed', scope, runtime,
      capturedAt: startedAt, expiresAt: new Date(now + 59_000).toISOString(), observations: {
        flags: observed({ dream: true }),
        dream: observed({ resolved: { auto: { maxDreamsPerCycle: 3, maxCostUsd: 1, rolling24hCostUsd: 5, timeoutMs: 600000, autoIdleRatioFloor: 0.5 } },
          routines: [{ name: 'dream-cycle-auto', active: true, payload_template: { mode: 'auto' } }] }),
        gym: observed({ autoloop: { enabled: true, status: 'idle', budgetUsd: null, spentUsd: 0 }, budgetFloorUsd: 0.5,
          remainingUsd: null, cycleHardCapUsd: null, nativeBudgetEligible: false, nullBudgetRefusesUnattended: true }),
        governors: observed({ steering: [{ workspace_id: ws, harness_slug: harness, value: { dream: true } }] }),
        rollingSpend: observed({ workspaceId: ws, totalUsd: 0.12, accounting: 'maintained-conservative-admission-total' }),
        activity: observed({ scout: { hasMore: false, observations: [tick('analogical', 5000), tick('counterfactual', 4000)] } }),
      } };
    raw = { schemaVersion: 1, exitCode: 0, startedAt, finishedAt, consumedAt: finishedAt, scope,
      source: { sourcePath: 'packages/operator-core/lib/dream/dream-control-observations.ts', blobSha256: 'fixture-source',
        testedSourceSha256: 'fixture-source', localAssessorSha256: 'fixture-source', loadedSha: runtime.buildSha },
      requests: { observation: { body: { rows: [observation] } } },
      assertions: wanted.map(id => ({ id, passed: true, evidence: 'Synthetic predicate fixture; not operational proof' })),
    };
    await insert('plan_spec_clauses', { ...identity, current_revision: 1 });
    await insert('plan_spec_clause_revisions', { ...identity, revision: 1, content_hash: 'fixture-clause' });
    const base = { ...identity, spec_revision: 1, spec_fingerprint: 'fixture-clause', source_fingerprint: 'fixture-source',
      test_fingerprint: 'fixture-test', environment_fingerprint: 'fixture-env', created_by: 'fixture-author',
      details: { evidencePlane: 'live', currentMeasurement: { runtimeUnits: ['fixture-runtime'] },
        testRun: { operationalArtifact: { sha256: 'a'.repeat(64), commitSha: 'fixture-commit' } } } };
    await insert('spec_evidence_bindings', { ...base, id: binding, evidence_kind: 'operational', test_run_id: 1 });
    await insert('spec_evidence_bindings', { ...base, id: verifier, evidence_kind: 'independent-verification', verifies_binding_id: binding, created_by: 'fixture-reviewer' });
    const run = { workspace_id: ws, harness_slug: harness, status: 'pass', worktree_dirty: false, is_scratch_config: false,
      commit_sha: 'fixture-commit', finished_at: finishedAt, execution_details: { collectionFailed: false, passed: 10, failed: 0,
        skipped: 0, runStartedAt: startedAt, operational: { schemaVersion: 1 }, passedCaseTitles: wanted } };
    await insert('test_runs', { ...run, id: 1, file_path: 'docs/evidence/fixture.json', source: 'operational-evidence' });
    const required = [...candidate.sql[0].matchAll(/\('([^']+\.test\.ts)','(unit|integration)'\)/g)];
    expect(required).toHaveLength(19);
    for (const [i, match] of required.entries()) {
      const id = i + 2;
      await insert('test_runs', { ...run, id, file_path: match[1], source: 'local', execution_details: { ...run.execution_details, testLayer: match[2] } });
      await insert('spec_evidence_bindings', { ...base, id: id + 2, evidence_kind: 'test', test_run_id: id });
    }
    await insert('harness_text_artifacts', { workspace_id: ws, harness_slug: harness,
      rel_path: 'verification/WI-6554700010016926/fixture-runtime-raw.json', content: JSON.stringify(raw) });
  });

  it('accepts a complete coherent synthetic edition in all seven exact frozen predicates', async () => {
    expect(await read()).toEqual(Array(7).fill(true));
  });
  it.each(['wrong-scope', 'wrong-hash', 'retracted', 'dispatch-only', 'missing-assertion', 'wrong-runtime', 'stale'])(
    'rejects %s without mutating live controls', async fault => {
      if (fault === 'wrong-scope') await db.adminSql`UPDATE r2_fixture.spec_evidence_bindings SET workspace_id = 'foreign'`;
      if (fault === 'wrong-hash') await db.adminSql`UPDATE r2_fixture.spec_evidence_bindings SET spec_fingerprint = 'foreign'`;
      if (fault === 'retracted') await db.adminSql`UPDATE r2_fixture.spec_evidence_bindings SET retracted_at = now()`;
      if (fault === 'dispatch-only') await db.adminSql`UPDATE r2_fixture.test_runs SET source = 'routine-dispatch' WHERE id = 1`;
      if (fault === 'missing-assertion') raw.assertions = [];
      const observation = (raw.requests as { observation: { body: { rows: Row[] } } }).observation.body.rows[0];
      if (fault === 'wrong-runtime') observation.runtime = { host: 'another-host', processId: 'another-process', buildSha: 'another-build' };
      if (fault === 'stale') {
        observation.capturedAt = new Date(Date.now() - 120_000).toISOString();
        observation.expiresAt = new Date(Date.parse(String(observation.capturedAt)) + 60_000).toISOString();
      }
      await saveRaw();
      expect((await read()).every(Boolean)).toBe(false);
    });
});
