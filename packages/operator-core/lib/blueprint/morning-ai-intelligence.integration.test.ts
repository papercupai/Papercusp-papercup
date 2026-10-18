/** AI consumer contracts on the real schedule and Reports substrate. This
 * suite does not certify model-authored claims or the native owner viewer. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { armPlanSchedule, disarmPlanSchedule } from '../harness/routines/arm-plan-schedule';
import { computeNextFire } from '../harness/routines/schedule-next';
import { planScheduleRoutineName } from '../harness/routines/materialize-plan-schedule';
import { getReport, listReports, publishReport, ReportRequestConflictError } from '../report-library';
import { checkAgainstJsonSchema } from '../json-schema-validation';

const path = fileURLToPath(new URL(
  '../../../../libs/papercusp/packages/harness/blueprints/morning-ai-intelligence/blueprint.yaml', import.meta.url));
const blueprint = loadBlueprintFromFile(path).blueprint;
const operation = blueprint.operations!.find(entry => entry.id === 'daily-ai-brief')!;
const properties = (operation.inputSchema as { properties: Record<string, { const?: unknown; default?: unknown }> }).properties;
const input = Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, schema.const ?? schema.default]));
const WS = 'morning-ai-consumer-it';
const HARNESS = 'morning-ai-consumer';
const SLUG = 'morning-ai-daily';
const series = 'series:papercusp-ai-brief';
const subject = { kind: 'external' as const, ref: 'ai-news:papercusp', label: 'Papercusp AI news' };
let org: OrgTestDb;
let sql: Sql;
beforeAll(async () => { org = await createOrgTestDb(); sql = org.adminSql; });
afterAll(async () => org?.cleanup());

describe('morning AI native schedule and report lifecycle', () => {
  it('materializes the uncapped research input once and pauses through native controls', async () => {
    expect(checkAgainstJsonSchema(operation.inputSchema, input)).toEqual({ ok: true });
    const schedule = { kind: 'rrule' as const,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
      dtstart: '2026-10-08T09:00:00.000Z', tzid: 'America/New_York',
      concurrency: 'skip' as const,
      operation: { harnessSlug: HARNESS, operationId: operation.id, input } };
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, content, content_hash, status, schedule, schedule_active)
      VALUES (${WS}, ${HARNESS}, ${SLUG}, 'Morning AI', '# Morning AI', 'h', 'ready', ${JSON.stringify(schedule)}::text::jsonb, false)`;
    const args = { sql, workspaceId: WS, harnessSlug: HARNESS, templateSlug: SLUG, schedule };
    const first = await armPlanSchedule(args);
    expect(first.ok).toBe(true);
    expect(await armPlanSchedule(args)).toEqual(first);
    const rows = await sql<Array<{ id: string; active: boolean; schedule_active: boolean;
      target_role: string; concurrency: string; next_fire_at: Date; trigger_config: Record<string, unknown>;
      payload_template: Record<string, unknown> }>>`
      SELECT r.*, p.schedule_active FROM harness_shared.routines r
       JOIN harness_shared.harness_plans p ON p.workspace_id = r.workspace_id
        AND p.harness_slug = r.install_slug AND p.plan_slug = ${SLUG}
      WHERE r.workspace_id = ${WS} AND r.name = ${planScheduleRoutineName(SLUG)}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: true, schedule_active: true,
      target_role: 'system:blueprint-operation', concurrency: 'skip',
      trigger_config: { tzid: 'America/New_York' },
      payload_template: { operationHarnessSlug: HARNESS, operationId: 'daily-ai-brief', input } });
    expect(rows[0].trigger_config).not.toHaveProperty('operation');
    expect(rows[0].trigger_config).not.toHaveProperty('costCapCents');
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    expect(local.format(new Date(rows[0].next_fire_at))).toBe('09:00');
    for (const [from, next] of [
      ['2026-10-31T19:00:00Z', '2026-11-01T14:00:00.000Z'],
      ['2027-03-13T19:00:00Z', '2027-03-14T13:00:00.000Z'],
    ]) expect(computeNextFire(schedule, new Date(from))?.toISOString()).toBe(next);
    await disarmPlanSchedule(args);
    const [paused] = await sql<Array<{ active: boolean; schedule_active: boolean }>>`
      SELECT r.active, p.schedule_active FROM harness_shared.routines r JOIN harness_shared.harness_plans p
        ON p.workspace_id = r.workspace_id AND p.harness_slug = r.install_slug AND p.plan_slug = ${SLUG}
       WHERE r.workspace_id = ${WS} AND r.id = ${rows[0].id}`;
    expect(paused).toEqual({ active: false, schedule_active: false });
  });

  it('keeps daily editions separate, scopes retries to the operation, and preserves correction citations', async () => {
    const origin = { authorOwnerId: 'accepted-worker-a', authorSessionRef: 'codex:a', harnessSlug: HARNESS,
      requestScope: 'blueprint-operation:morning-ai-fixture' };
    const edition = (date: string, body: string, requestKey: string) => ({ workspaceId: WS,
      title: `Papercusp AI Brief — ${date}`, bodyMd: body, requestKey,
      kind: 'status-digest' as const, subject, visibility: 'workspace' as const,
      tags: ['ai-intelligence', 'papercusp', series, `edition:${date}`] });
    const body = '# Act now\n\nFixture release changed MCP interoperability.\n\n'
      + 'Event: 2026-10-07; publication: 2026-10-07.\n\n'
      + '[Primary release](https://example.test/releases/v2)\n\n'
      + 'Papercusp fit: verify compatibility at the existing MCP seam.\n\nCoverage: fixture only.\n';
    const old = await publishReport(sql, edition('2026-10-07', body, 'run-7'), origin);
    const quiet = await publishReport(sql, edition('2026-10-08', '# No material updates\n\nFull fixture coverage.', 'run-8'), origin);
    expect(quiet.lineageId).not.toBe(old.lineageId);
    const retry = await publishReport(sql, edition('2026-10-08', quiet.bodyMd, 'run-8'),
      { ...origin, authorOwnerId: 'accepted-worker-b', authorSessionRef: 'codex:b' });
    expect(retry.reportId).toBe(quiet.reportId);
    await expect(publishReport(sql, edition('2026-10-08', 'Changed content', 'run-8'), origin))
      .rejects.toBeInstanceOf(ReportRequestConflictError);
    const correction = await publishReport(sql, {
      ...edition('2026-10-07', body.replace('v2)', 'v2.1)'), 'correction-7'), supersedes: old.reportId,
    }, origin);
    expect(correction.lineageId).toBe(old.lineageId);
    const editions = await listReports(sql, { workspaceId: WS, viewer: { isOwner: true },
      subject, tags: [series], limit: 20 });
    expect(editions.map(report => report.reportId).sort()).toEqual([quiet.reportId, correction.reportId].sort());
    expect((await getReport(sql, WS, old.reportId, { isOwner: true }))?.bodyMd).toBe(body);
    expect((await getReport(sql, WS, correction.reportId, { isOwner: true }))?.bodyMd)
      .toContain('https://example.test/releases/v2.1');
    expect(await listReports(sql, { workspaceId: WS, tags: [series],
      subject: { kind: 'external', ref: 'wrong-series' } })).toEqual([]);
    const partial = { reportId: correction.reportId, reportPath: `/reports?sel=${correction.reportId}`,
      editionDate: '2026-10-07', itemCount: 1, sourceCount: 20, unavailableSources: ['failed-feed'], status: 'partial' };
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, partial)).toEqual({ ok: true });
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, { ...partial, status: 'published' })).toMatchObject({ ok: false });
    expect(checkAgainstJsonSchema(operation.acceptance.resultSchema, { ...partial, status: 'no-material-updates', itemCount: 0 })).toMatchObject({ ok: false });
  });
});
