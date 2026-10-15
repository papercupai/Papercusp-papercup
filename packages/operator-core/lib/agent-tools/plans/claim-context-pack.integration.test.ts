/** R-7: the claim port uses persisted clause edges and the real convention reader. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const WS = 'ws-claim-pack';
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(_ws: string, fn: (tx: postgres.Sql) => Promise<T>) =>
    h.sql.begin((tx) => fn(tx as unknown as postgres.Sql)),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-claim-pack' }));
vi.mock('./source', async (original) => ({
  ...(await original<typeof import('./source')>()),
  resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
    workspaceId: WS, harnessSlug: opts.harnessSlug ?? 'h',
  }),
}));
const { getClaimTimeBehaviorContract, CLAIM_CONTEXT_MAX_BYTES } = await import('../../behavior-contract-claim-port');
let db: FreshPgDb;
beforeAll(async () => {
  db = await createFreshPgDb('claim-context-pack'); h.sql = db.sql;
  await h.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text, harness_slug text, plan_slug text, status text, archived boolean DEFAULT false,
      content text DEFAULT '', decisions jsonb DEFAULT '[]', updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE harness_shared.work_item_spec_revision_edges (
      workspace_id text, harness_slug text, work_item_id text, plan_slug text,
      spec_id text, spec_revision int, spec_fingerprint text
    );
    CREATE TABLE harness_shared.plan_spec_clauses (
      workspace_id text, harness_slug text, plan_slug text, spec_id text, source_val_id text, current_revision int
    );
    CREATE TABLE harness_shared.plan_spec_clause_revisions (
      workspace_id text, harness_slug text, plan_slug text, spec_id text, revision int,
      plan_item_id text, behavior text, behavior_class text DEFAULT 'boundary',
      required_evidence jsonb DEFAULT '[]', required_test_layers jsonb DEFAULT '[]', mutation_required boolean DEFAULT false,
      lifecycle_status text DEFAULT 'active', supersedes_spec_id text, supersedes_revision int,
      exemption jsonb, falsifier jsonb, content_hash text, created_by text DEFAULT 'tester',
      created_at timestamptz DEFAULT now(), accepted_by text, accepted_at timestamptz, acceptance_ref text,
      source_bar_key text, source_bar_hash text, source_bar_set_hash text, source_rubric_slug text,
      source_rubric_revision int, evidence_plane text
    );
    CREATE TABLE harness_shared.agent_facts (
      id bigserial, workspace_id text, scope text, scope_ref text, key text, body text,
      source_ref text, audience_scope text, source_provenance jsonb, confidence text DEFAULT 'verified',
      measurement jsonb, recheck jsonb, kind text DEFAULT 'convention', depends_on jsonb,
      claim jsonb, enforcement jsonb, created_by text DEFAULT 'owner', updated_at timestamptz DEFAULT now(),
      expires_at timestamptz DEFAULT 'infinity', superseded_at timestamptz, retracted_at timestamptz
    );
  `);
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await h.sql.unsafe(`TRUNCATE harness_shared.harness_plans, harness_shared.work_item_spec_revision_edges,
    harness_shared.plan_spec_clauses, harness_shared.plan_spec_clause_revisions, harness_shared.agent_facts`);
  await h.sql`INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,status)
    VALUES (${WS},'h','ours','active'),(${WS},'h','unrelated','active')`;
});
async function clause(id: string, opts: { plan?: string; item?: string; body?: string; linked?: boolean } = {}) {
  const plan = opts.plan ?? 'ours';
  await h.sql`INSERT INTO harness_shared.plan_spec_clauses
    (workspace_id,harness_slug,plan_slug,spec_id,current_revision) VALUES (${WS},'h',${plan},${id},1)`;
  await h.sql`INSERT INTO harness_shared.plan_spec_clause_revisions
    (workspace_id,harness_slug,plan_slug,spec_id,revision,plan_item_id,behavior,falsifier,content_hash)
    VALUES (${WS},'h',${plan},${id},1,${opts.item ?? 'P-001'},${opts.body ?? 'Reject an invalid transition.'},
      ${h.sql.json({ observation: 'Invalid transition is accepted.', probeMethod: 'Attempt the invalid transition.' })},${'a'.repeat(64)})`;
  if (opts.linked) await h.sql`INSERT INTO harness_shared.work_item_spec_revision_edges
    VALUES (${WS},'h','WI-claim',${plan},${id},1,${'a'.repeat(64)})`;
}
const subject = () => ({ id: 'WI-claim', harness: 'h', sourcePlanSlug: 'ours',
  sourcePlanItemIds: ['P-001'], payload: { paths: ['packages/payments/charge.ts'] } });

describe('persisted claim context', () => {
  it('returns current linked promises with intact falsifiers and excludes unrelated clauses', async () => {
    await clause('OWNED'); await clause('EDGE', { item: 'P-002', linked: true });
    await clause('SECRET', { plan: 'unrelated' }); await clause('OTHER-ITEM', { item: 'P-003' });
    const out = (await getClaimTimeBehaviorContract(subject()))!;
    expect(out.behaviorContract.enforceable.map((c) => c.specId).sort()).toEqual(['EDGE', 'OWNED']);
    expect(out.behaviorContract.enforceable.every((c) => c.falsifier?.observation === 'Invalid transition is accepted.')).toBe(true);
    expect(out.behaviorContract.context).toMatchObject({ totalClauses: 2, shownClauses: 2, overflow: false, conventionsReadFailed: false });
  });
  it('uses path-ranked governing conventions while isolating another owner scope', async () => {
    await clause('OWNED');
    await h.sql`INSERT INTO harness_shared.agent_facts (workspace_id,scope,scope_ref,key,body)
      VALUES (${WS},'workspace',NULL,'payments','packages/payments/charge.ts requires idempotency.'),
        (${WS},'owner','someone-else','private','Unrelated owner policy.')`;
    const out = (await getClaimTimeBehaviorContract(subject()))!;
    expect(out.behaviorContract.context.conventions.map((c) => c.title)).toEqual(['payments']);
    expect(out.behaviorContract.context.conventions[0].body).toContain('idempotency');
  });
  it('bounds multibyte bodies without clipping promises and provides an executable overflow pointer', async () => {
    await clause('HUGE', { body: '界'.repeat(5_000) });
    const out = (await getClaimTimeBehaviorContract(subject()))!;
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(CLAIM_CONTEXT_MAX_BYTES);
    expect(out.behaviorContract.enforceable).toEqual([]);
    expect(out.behaviorContract.context).toMatchObject({ totalClauses: 1, shownClauses: 0, overflow: true });
    expect(out.behaviorContract.context.readMore).toContainEqual({ tool: 'plans:get-specs', args: { harness: 'h', slug: 'ours' } });
  });
  it('includes explicitly linked capability namespaces without dragging in their other clauses', async () => {
    await clause('CAPABILITY', { plan: 'unrelated', linked: true });
    await clause('NOT-TOUCHED', { plan: 'unrelated' });
    const out = (await getClaimTimeBehaviorContract(subject()))!;
    expect(out.behaviorContract.enforceable.map((c) => c.specId)).toEqual(['CAPABILITY']);
  });
  it('keeps clause context and declares an unavailable convention read instead of treating it as empty', async () => {
    await clause('OWNED');
    await h.sql`ALTER TABLE harness_shared.agent_facts RENAME TO unavailable_facts`;
    try {
      const out = (await getClaimTimeBehaviorContract(subject()))!;
      expect(out.behaviorContract.enforceable.map((c) => c.specId)).toEqual(['OWNED']);
      expect(out.behaviorContract.context).toMatchObject({ conventionsReadFailed: true, totalConventions: null, overflow: true });
    } finally { await h.sql`ALTER TABLE harness_shared.unavailable_facts RENAME TO agent_facts`; }
  });
});
