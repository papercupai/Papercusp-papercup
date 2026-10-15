/**
 * gatherScheduledOccurrences against a REAL migrated Postgres (testcontainer):
 * the calendar-window expansion across templates — recurring + one-shot, armed +
 * disarmed, expiry-bounded, with last-run outcome — excluding instance plans.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/scheduled-occurrences.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-018/P-019/P-026).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { gatherScheduledOccurrences, listPlanSchedules } from './scheduled-occurrences';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-occ';
// Migration 656 canonicalizes the retired `papercup` slug to `papercusp` on
// insert, so cleanup and reads must use the canonical stored value or rows
// survive beforeEach and contaminate later cases.
const HARNESS = 'papercusp';

// A June window: 2026-06-10 .. 2026-06-16 inclusive.
const RANGE_START = Date.parse('2026-06-10T00:00:00.000Z');
const RANGE_END = Date.parse('2026-06-16T23:59:59.000Z');

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
});

async function insertPlan(opts: {
  slug: string;
  schedule?: unknown;
  scheduleActive?: boolean;
  scheduledAt?: string | null;
  expiresAt?: string | null;
  templateSlug?: string | null;
}) {
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash,
       schedule, schedule_active, scheduled_at, expires_at, template_slug)
    VALUES (${WS}, ${HARNESS}, ${opts.slug}, ${opts.slug}, 'active', ${'# ' + opts.slug}, ${'h'},
            ${opts.schedule ? sql`${JSON.stringify(opts.schedule)}::text::jsonb` : null},
            ${opts.scheduleActive ?? false},
            ${opts.scheduledAt ?? null}::timestamptz,
            ${opts.expiresAt ?? null}::timestamptz,
            ${opts.templateSlug ?? null})
  `;
}

async function gather() {
  return gatherScheduledOccurrences(sql, { workspaceId: WS, rangeStartMs: RANGE_START, rangeEndMs: RANGE_END });
}

describe('gatherScheduledOccurrences', () => {
  it('expands a daily recurring template to one occurrence per day in the window', async () => {
    await insertPlan({
      slug: 'daily-monitor',
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00.000Z' },
      scheduleActive: true,
    });
    const occ = await gather();
    expect(occ).toHaveLength(7); // Jun 10–16
    expect(occ.every((o) => o.templateSlug === 'daily-monitor')).toBe(true);
    expect(occ[0].kind).toBe('recurring');
    expect(occ[0].scheduleActive).toBe(true);
    // ascending by fire time
    for (let i = 1; i < occ.length; i++) expect(occ[i].occurrenceMs).toBeGreaterThan(occ[i - 1].occurrenceMs);
  });

  it('includes a one-shot scheduled_at inside the window and excludes one outside', async () => {
    await insertPlan({ slug: 'one-shot-in', scheduledAt: '2026-06-12T15:00:00.000Z' });
    await insertPlan({ slug: 'one-shot-out', scheduledAt: '2026-07-01T15:00:00.000Z' });
    const occ = await gather();
    expect(occ).toHaveLength(1);
    expect(occ[0].templateSlug).toBe('one-shot-in');
    expect(occ[0].kind).toBe('one-shot');
  });

  it('clamps a recurring expansion at expires_at', async () => {
    await insertPlan({
      slug: 'expiring',
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00.000Z' },
      scheduleActive: true,
      expiresAt: '2026-06-12T23:59:59.000Z', // only Jun 10, 11, 12 remain in-window
    });
    const occ = await gather();
    expect(occ).toHaveLength(3);
    expect(occ.every((o) => o.occurrenceMs <= Date.parse('2026-06-12T23:59:59.000Z'))).toBe(true);
  });

  it('renders a DISARMED schedule too, flagged scheduleActive=false', async () => {
    await insertPlan({
      slug: 'paused-monitor',
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00.000Z' },
      scheduleActive: false,
    });
    const occ = await gather();
    expect(occ.length).toBe(7);
    expect(occ.every((o) => o.scheduleActive === false)).toBe(true);
  });

  it('excludes instance plans (template_slug NOT NULL)', async () => {
    await insertPlan({
      slug: 'tmpl@run-123',
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00.000Z' },
      templateSlug: 'tmpl',
    });
    const occ = await gather();
    expect(occ).toHaveLength(0);
  });

  it('attaches the last scheduled run outcome to the occurrences', async () => {
    await insertPlan({
      slug: 'health-monitor',
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00.000Z' },
      scheduleActive: true,
    });
    // two prior runs — the most recent (failed) is the one reported.
    await sql`
      INSERT INTO harness_shared.plan_runs
        (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at, status, run_type, outcome, updated_at)
      VALUES
        (${HARNESS}, 'health-monitor', 'h', 's1', 'system:plan-run', 1000, 'done', 'scheduled', 'success', 1000),
        (${HARNESS}, 'health-monitor', 'h', 's2', 'system:plan-run', 2000, 'done', 'scheduled', 'failed', 2000)
    `;
    const occ = await gather();
    expect(occ.length).toBeGreaterThan(0);
    expect(occ.every((o) => o.lastOutcome === 'failed')).toBe(true);
  });

  it('returns [] for an empty workspace window', async () => {
    expect(await gather()).toEqual([]);
  });
});

describe('listPlanSchedules (D-020 — raw schedule read for the editor)', () => {
  it('returns one row per scheduled plan with the raw schedule, window-independent', async () => {
    await insertPlan({
      slug: 'rec',
      schedule: { kind: 'rrule', rrule: 'FREQ=WEEKLY;INTERVAL=2', dtstart: '2026-06-01T09:00:00.000Z' },
      scheduleActive: true,
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    // A one-shot FAR outside any calendar occurrence window still surfaces here.
    await insertPlan({ slug: 'one-shot-future', scheduledAt: '2027-03-01T10:00:00.000Z' });

    const rows = await listPlanSchedules(sql, { workspaceId: WS });
    expect(rows.map((r) => r.templateSlug).sort()).toEqual(['one-shot-future', 'rec']);

    const rec = rows.find((r) => r.templateSlug === 'rec')!;
    expect(rec.schedule).toMatchObject({ kind: 'rrule', rrule: 'FREQ=WEEKLY;INTERVAL=2' });
    expect(rec.scheduleActive).toBe(true);
    expect(rec.expiresAt).toBe('2026-12-31T00:00:00.000Z');
    expect(rec.scheduledAt).toBeNull();

    const os = rows.find((r) => r.templateSlug === 'one-shot-future')!;
    expect(os.schedule).toBeNull();
    expect(os.scheduledAt).toBe('2027-03-01T10:00:00.000Z');
    expect(os.scheduleActive).toBe(false);
  });

  it('excludes instance plans and returns [] when nothing is scheduled', async () => {
    await insertPlan({ slug: 'tmpl@run-1', schedule: { kind: 'rrule', rrule: 'FREQ=DAILY' }, templateSlug: 'tmpl' });
    expect(await listPlanSchedules(sql, { workspaceId: WS })).toEqual([]);
  });

  it('reads one-shot and expiring schedules after Drizzle changes the real pool timestamp parsers', async () => {
    await insertPlan({ slug: 'drizzle-one-shot', scheduledAt: '2026-06-12T15:00:00.123Z' });
    await insertPlan({ slug: 'drizzle-expiry', schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-06-01T09:00:00Z' },
      expiresAt: '2026-06-12T23:59:59Z' });
    const parsers = sql.options.parsers;
    const originals = { ...parsers };
    try {
      drizzle(sql);
      const raw = await sql`SELECT scheduled_at FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = 'drizzle-one-shot'`;
      expect(typeof raw[0].scheduled_at).toBe('string');
      const occurrences = await gather();
      expect(occurrences.filter(row => row.templateSlug === 'drizzle-expiry')).toHaveLength(3);
      expect(occurrences.find(row => row.templateSlug === 'drizzle-one-shot')?.occurrenceMs).toBe(Date.parse('2026-06-12T15:00:00.123Z'));
      const summaries = await listPlanSchedules(sql, { workspaceId: WS });
      expect(summaries.find(row => row.templateSlug === 'drizzle-one-shot')?.scheduledAt).toBe('2026-06-12T15:00:00.123Z');
      expect(summaries.find(row => row.templateSlug === 'drizzle-expiry')?.expiresAt).toBe('2026-06-12T23:59:59.000Z');
    } finally {
      Object.assign(parsers, originals);
    }
  });
});
