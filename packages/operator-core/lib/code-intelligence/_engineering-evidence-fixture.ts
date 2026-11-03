import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { expect } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from '../agent-tools/plans/source';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';
import { setSpecClause, listSpecClauses } from '../agent-tools/plans/spec-clauses-store';
import { writePlanItemAnchors } from '../plan-items/anchor-store';
import { readEngineeringEvidence, type EngineeringQueryReport, type EngineeringScope } from './engineering-evidence';
import { engineeringEvidenceStore } from './engineering-evidence-store';
import { writeOperatorState } from '../operator-state-pg';
import graphQuery from '../agent-tools/gitnexus/query';

/** Shared private canonical records for reader and public-handler integration. */
export async function setupEngineeringEvidenceFixture(registerPublicRoot = false) {
  let fixture: PlanPgFixture | undefined;
  let db: Sql;
  let scope: EngineeringScope;
  let root: string;
  let runId: number;
  let bindingId: number;
  const plan = `ee-feature-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Use the operator-home plan scope, whose canonical resolver is independent
  // of the composed suite's dispatcher DB. Every row still lives in this
  // fixture's private database and unique plan namespace.
  const harness = 'papercusp';
  const path = 'src/evidence-feature.ts';
  const source = 'export function evidenceFeature() { return 1; }\n';
  const digest = createHash('sha256').update(source).digest('hex');
  const body = `---\ntitle: Evidence fixture\nslug: ${plan}\nstatus: active\n---\n# Evidence fixture\n\n## Work\n\n- **P-001** \`todo\` Inspect exact engineering evidence\n\n## Decisions\n\n### D-001 — Explicit rationale\nRelated: P-001\n\nThis item has an explicit governing rule.\n\n### D-002 — Unscoped context\n\nThis note declares no item relationship.\n\n### D-003 — Administrative amendment\n\nAmendment-Id: fixture-only\n`;
  const store = () => engineeringEvidenceStore({ sql: async () => db,
    root: async s => s.workspaceId === scope.workspaceId && s.harness === harness ? root : null });
  const query = { symbol: { path, name: 'evidenceFeature' } };
  const publicQuery = async (selector: Record<string, unknown> = { file_path: path, name: 'evidenceFeature' }) => {
    const args = graphQuery.args.parse({ op: 'evidence', harnesses: [harness], ...selector });
    const result = await graphQuery.handler(args, { workspaceId: scope.workspaceId, harnessSlug: harness,
      role: 'operator', principal: { slug: 'ee-reader', workspaceId: scope.workspaceId, capabilities: new Set(['intel:read']) },
    } as never) as { data: EngineeringQueryReport };
    return result.data;
  };
  const dispose = async () => {
    try { if (root) await rm(root, { recursive: true, force: true }); }
    finally { await fixture?.dispose(); }
  };

  try {
    fixture = await setupPlanPgFixture({ isolated: true });
    db = fixture.admin;
    root = await mkdtemp(join(tmpdir(), 'ee-reader-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, path), source);
    scope = { workspaceId: fixture.workspaceId, harness, root };
    if (registerPublicRoot) {
      // Measure both clients before the first canonical write. Only include
      // allowlisted endpoint fields: connection URLs contain credentials.
      const canonical = getOrgPg().sql;
      const endpoint = (client: Sql) => ({ host: client.options.host, port: client.options.port,
        database: client.options.database });
      const targets = { direct: endpoint(db), canonical: endpoint(canonical) };
      try {
        const [direct, routed] = await Promise.all([
          db`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port`,
          canonical`SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port() AS port`,
        ]);
        expect(routed[0], JSON.stringify(targets)).toEqual(direct[0]);
      } catch (cause) {
        throw new Error(`Engineering evidence fixture database route probe failed: ${JSON.stringify(targets)}`, { cause });
      }
      await writeOperatorState('harness_registry', { projects: [{ slug: harness, path: root }] }, scope.workspaceId);
    }
    await seedPlan(db, scope.workspaceId, harness, plan, body);
    await db.begin(async tx => {
      await writePlanIndexRows(tx as never, { workspaceId: scope.workspaceId, harnessSlug: harness, planSlug: plan }, deriveIndexFromContent(body));
      await writePlanItemAnchors(tx, { workspaceId: scope.workspaceId, harnessSlug: harness, planSlug: plan }, {
        itemId: 'P-001', anchors: [{ id: undefined, anchorKind: 'path', requested: path, symbolId: null,
          symbolName: null, path, line: null, signature: null, contentHash: digest, consumers: [], consumersTotal: 0,
          tests: [], resolution: 'resolved', unknownReason: null, freshness: 'fresh', resolvedCommit: null }],
      }, 'su-ee-author');
      expect(await setSpecClause({ planSlug: plan, specId: 'EE-1', expectedRevision: 0, planItemId: 'P-001',
        behavior: 'The scoped request returns exact declared engineering records.', behaviorClass: 'happy-path',
        requiredEvidence: ['tree'], requiredTestLayers: ['integration'], mutationRequired: false,
        lifecycleStatus: 'active', actorId: 'su-ee-author',
        falsifier: { observation: 'An unrelated record becomes support.', probeMethod: 'Query the scoped fixture and its foreign control.' },
      }, { executor: tx as never, workspaceId: scope.workspaceId, harnessSlug: harness })).toMatchObject({ status: 'created' });
    });
    const [spec] = await listSpecClauses({ workspaceId: scope.workspaceId, harnessSlug: harness, planSlug: plan, limit: 1 });
    expect(spec).toBeDefined();
    await db`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,source_plan_slug)
      VALUES (${scope.workspaceId},${harness},'WI-ee-proof',${plan})`;
    await db`INSERT INTO harness_shared.work_item_spec_revision_edges
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,created_by)
      VALUES (${scope.workspaceId},${harness},'WI-ee-proof',${plan},'EE-1',1,${spec!.contentHash},'su-ee-author')`;
    const [run] = await db`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,framework,status,source,commit_sha,worktree_dirty)
      VALUES (${scope.workspaceId},${harness},'evidence-feature.integration.test.ts','vitest','pass','local',${'c'.repeat(40)},false)
      RETURNING id`;
    runId = Number(run!.id);
    await db`INSERT INTO harness_shared.test_case_runs (test_run_id,case_index,case_key,occurrence,status)
      VALUES (${runId},0,'ee.intent-exact',1,'pass')`;
    const [binding] = await db`INSERT INTO harness_shared.spec_evidence_bindings
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
        evidence_kind,evidence_ref,source_fingerprint,test_run_id,binding_fingerprint,created_by)
      VALUES (${scope.workspaceId},${harness},'WI-ee-proof',${plan},'EE-1',1,${spec!.contentHash},
        'test','evidence-feature.integration.test.ts',${digest},${runId},${'b'.repeat(64)},'su-ee-author') RETURNING id`;
    bindingId = Number(binding!.id);
    // A separately scoped, same-file row must not become the requested owner.
    await seedPlan(db, 'ee-foreign', harness, 'foreign-plan', body.replaceAll(plan, 'foreign-plan'));
    await db`INSERT INTO harness_shared.plan_items (workspace_id,harness_slug,plan_slug,item_id,seq,item_text,status)
      VALUES ('ee-foreign',${harness},'foreign-plan','P-001',0,'Foreign ownership','todo')`;
    await db`INSERT INTO harness_shared.plan_item_anchors
      (workspace_id,harness_slug,plan_slug,item_id,anchor_kind,requested,path,content_hash,resolution,freshness,created_by)
      VALUES ('ee-foreign',${harness},'foreign-plan','P-001','path',${path},${path},${digest},'resolved','fresh','foreign-author')`;
    return { fixture, db, scope, root, runId, bindingId, plan, harness, path, source, digest, store, query, publicQuery, dispose };
  } catch (cause) {
    try { await dispose(); }
    catch (cleanupCause) { throw new AggregateError([cause, cleanupCause], 'Engineering evidence fixture setup and cleanup failed'); }
    throw cause;
  }
}
