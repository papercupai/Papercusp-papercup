/** Real PostgreSQL proves report identity/scope and reload behavior; execution
 * and mirrors are separate tested seams, not a fake SQL implementation. */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'audit-integration' }));
vi.mock('./harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'audit-harness' }));
vi.mock('./text-artifacts', () => ({ saveTextArtifact: vi.fn() }));
vi.mock('./report-library', () => ({ publishReport: vi.fn() }));
vi.mock('./unshipped-plans-audit', () => ({ runUnshippedPlansAudit: vi.fn() }));
import { getPlanAuditRun, listPlanAuditRuns, readAuditArtifact, type PlanAuditRun } from './plan-audit-runs';
let sql: postgres.Sql;
beforeAll(async () => {
  const uri = await getTestPg(), database = 'audit_' + randomBytes(6).toString('hex');
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe('CREATE DATABASE "' + database + '"'); await markManagedTestDatabase(admin, database); } finally { await admin.end({ timeout: 5 }); }
  const url = new URL(uri);url.pathname = '/' + database;
  sql = postgres(url.toString(), { max: 1, onnotice: () => {} });h.sql = sql;
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe('CREATE TABLE harness_shared.harness_text_artifacts (workspace_id text NOT NULL, harness_slug text NOT NULL, rel_path text NOT NULL, content text NOT NULL, updated_at bigint NOT NULL DEFAULT 0, PRIMARY KEY(harness_slug,rel_path))');
}, 90000);
afterAll(async () => { await sql?.end({ timeout: 5 }); });
describe('persisted plan audit artifacts', () => {
  it('reopens the exact full snapshot and hides other workspace/harness report IDs from reads and history', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const run: PlanAuditRun = { schemaVersion: 1, id, workspace: 'audit-integration', harness: 'audit-harness', scope: 'single', planSlugs: ['plan-a'], status: 'complete', startedAt: '2026-10-07T00:00:00Z', reportId: 'rpt_original', rowCount: 1 };
    const snapshot = JSON.stringify({ rows: [{ slug: 'plan-a', citations: Array.from({ length: 1500 }, (_, n) => ({ path: 'src/' + n })) }] });
    const foreign = '22222222-2222-4222-8222-222222222222';
    await sql`INSERT INTO harness_shared.harness_text_artifacts VALUES ('audit-integration','audit-harness',${'reports/plan-audits/' + id + '/run.json'},${JSON.stringify(run)},1), ('audit-integration','audit-harness',${'reports/plan-audits/' + id + '/audit.json'},${snapshot},1), ('foreign-workspace','audit-harness',${'reports/plan-audits/' + foreign + '/run.json'},${JSON.stringify({ ...run, id: foreign, workspace: 'foreign-workspace' })},2)`;
    expect(await getPlanAuditRun(id)).toEqual(run);
    expect(await readAuditArtifact(id, 'audit.json')).toBe(snapshot);
    expect(await getPlanAuditRun(foreign)).toBeNull();
    expect((await listPlanAuditRuns()).map(r => r.id)).toEqual([id]);
  });
});
