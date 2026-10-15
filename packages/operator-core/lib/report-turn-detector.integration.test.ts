/** R8/P013: actual unpublished-turn lookup and observation writer against private migrated PG. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { disposeBaselineCoordFixture, setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { activeWorkspaceId } = await import('./workspace-registry');
const { drainDetached } = await import('./detached-imports');
const { publishReport } = await import('./report-library');
const { observeUnpublishedReportTurn } = await import('./turn-end-tracking-io');

const body = '# Architecture audit\n\n## Findings\n' + 'Measured architecture evidence. '.repeat(24)
  + '\n\n## Verdict\nThe fixture audit is complete.';

describe('Reports turn detector against migrated private PostgreSQL', () => {
  let db: OrgTestDb;
  let routing: BaselineCoordFixture | undefined;
  beforeAll(async () => {
    db = await createOrgTestDb();
    // Reuse the maintained fixture's URL/pool resets so nested capture stores
    // use this same private database. No detector or capture module is mocked.
    routing = await setupBaselineCoordFixture({ dsn: db.adminDsn });
  }, 180_000);
  afterEach(async () => {
    await drainDetached();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await drainDetached();
    await disposeBaselineCoordFixture(routing);
    await db?.cleanup();
  });

  function turn() {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    const id = randomUUID();
    return { workspaceId: activeWorkspaceId(), ownerId: `su-report-detector-${id}`,
      sessionId: `report-detector-${id}`, turnRef: `report-detector-${id}:turn-1`,
      sinceIso: '2026-10-01T00:00:00.000Z', assistantText: body, harnessSlug: 'papercusp' };
  }

  async function observations(input: ReturnType<typeof turn>) {
    const key = `unpublished-report:${createHash('sha256').update(input.turnRef).digest('hex')}`;
    return db.adminSql`SELECT issue_id, state, created_by, body, payload FROM harness_shared.engineer_issues
      WHERE payload->>'watchdogKey' = ${key}`;
  }

  async function publication(input: ReturnType<typeof turn>, overrides: { workspaceId?: string; ownerId?: string; at?: string } = {}) {
    const workspaceId = overrides.workspaceId ?? input.workspaceId;
    const report = await publishReport(db.adminSql, { workspaceId, title: 'Detector publication fixture',
      bodyMd: body, visibility: 'owner' }, { harnessSlug: 'papercusp',
      authorOwnerId: overrides.ownerId ?? input.ownerId, authorSessionRef: input.sessionId });
    await db.adminSql`UPDATE harness_shared.report_library SET published_at = ${overrides.at ?? input.sinceIso}::timestamptz
      WHERE workspace_id = ${workspaceId} AND report_id = ${report.reportId}`;
  }

  it('persists a terminal observation with exact turn provenance when the report was not published', async () => {
    const input = turn();
    expect(await observeUnpublishedReportTurn(input)).toBe(true);
    const rows = await observations(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'done', created_by: input.ownerId,
      payload: { lane: 'observation' } });
    expect(rows[0].body).toContain(input.turnRef);
    expect(rows[0].body).toContain(input.sessionId);
    expect(await db.adminSql`SELECT report_id FROM harness_shared.report_library
      WHERE workspace_id = ${input.workspaceId} AND author_owner_id = ${input.ownerId}`).toHaveLength(0);
  });

  it('suppresses the observation only for a publication by this author within the turn window', async () => {
    const input = turn();
    await publication(input);
    expect(await observeUnpublishedReportTurn(input)).toBe(false);
    expect(await observations(input)).toHaveLength(0);
  });

  it('does not let earlier, foreign-author or foreign-workspace publications hide an unpublished turn', async () => {
    const input = turn();
    await publication(input, { at: '2026-09-30T23:59:59.999Z' });
    await publication(input, { ownerId: `${input.ownerId}-other` });
    await publication(input, { workspaceId: `${input.workspaceId}-other` });
    expect(await observeUnpublishedReportTurn(input)).toBe(true);
    expect(await observations(input)).toHaveLength(1);
  });

  it('leaves no observation for ordinary progress or a disabled Reports library', async () => {
    const input = turn();
    expect(await observeUnpublishedReportTurn({ ...input, assistantText: 'Still verifying.' })).toBe(false);
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '0');
    expect(await observeUnpublishedReportTurn(input)).toBe(false);
    expect(await observations(input)).toHaveLength(0);
  });
});
