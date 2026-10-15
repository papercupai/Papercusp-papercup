/** R-8: execute the sweep/filer SQL against an isolated real Postgres database. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, serial: 0 }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// Lifecycle/upsert are boundary seams; persist their actual inputs so the sweep's
// SQL and reason-bearing close can be read back independently. Their own suites
// exercise the full canonical writers.
vi.mock('../../work-items', () => ({
  setWorkItemState: async (id: string, status: string, opts: { harness: string; by: string; completionRef: string }) => {
    await h.sql`UPDATE harness_shared.work_items
      SET status = ${status}, terminal_completion_ref = ${opts.completionRef}, terminal_owner = ${opts.by}
      WHERE feature_id = ${id} AND harness_slug = ${opts.harness}`;
  },
}));
vi.mock('../../coord/condition-upsert', () => ({
  upsertConditionWorkItem: async (_key: string, input: {
    workspaceId: string; harness: string; payload: Record<string, postgres.JSONValue>;
  }) => {
    const id = `WI-test-${++h.serial}`;
    await h.sql`INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, status, payload)
      VALUES (${id}, ${input.workspaceId}, ${input.harness}, 'open', ${h.sql.json(input.payload)})`;
    return { created: true, id };
  },
}));

const { runSpecTriadSweepOnce } = await import('./spec-triad-sweep');
const { ensureSpecTriadFiling } = await import('./spec-triad-filing');
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('spec-triad-sweep');
  h.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      status text, archived boolean NOT NULL DEFAULT false, is_legacy boolean NOT NULL DEFAULT false,
      template text, created text, content text NOT NULL, items jsonb NOT NULL DEFAULT '[]',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text NOT NULL,
      status text NOT NULL, payload jsonb NOT NULL, terminal_completion_ref text, terminal_owner text
    );
  `);
});
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await h.sql`TRUNCATE harness_shared.work_items, harness_shared.harness_plans`;
  h.serial = 0;
});

async function plan(slug: string, opts: { workspace?: string; declaration?: string; template?: string } = {}) {
  await h.sql`INSERT INTO harness_shared.harness_plans
    (workspace_id, harness_slug, plan_slug, status, template, created, content, items)
    VALUES (${opts.workspace ?? 'ws'}, 'h', ${slug}, 'active', ${opts.template ?? null}, '2026-10-01',
      ${`---\n${opts.declaration ? `specTriad: ${opts.declaration}\n` : ''}---\n# Plan\n`}, '[{"id":"P-001"}]')`;
}

async function reminder(id: string, slug: string, status: string, opts: {
  reason?: string; evidence?: Record<string, postgres.JSONValue>; workspace?: string;
} = {}) {
  const workspace = opts.workspace ?? 'ws';
  await h.sql`INSERT INTO harness_shared.work_items
    (feature_id, workspace_id, harness_slug, status, terminal_completion_ref, payload)
    VALUES (${id}, ${workspace}, 'h', ${status}, ${opts.reason ?? null},
      ${h.sql.json({ specTriadPlan: `${workspace}/h/${slug}`, ...(opts.evidence ? { _completionEvidence: opts.evidence } : {}) })})`;
}

describe('spec-triad sweep persisted dispositions', () => {
  it('keeps both canonical reason forms sticky across two sweeps and promotion-time filing', async () => {
    await plan('ref-drop');
    await plan('evidence-drop');
    await reminder('WI-ref', 'ref-drop', 'dropped', { reason: 'Owner declined the triad for this investigation.' });
    await reminder('WI-evidence', 'evidence-drop', 'dropped', { evidence: { summary: 'The triad does not apply to this lane.' } });
    for (let i = 0; i < 2; i++) {
      expect(await runSpecTriadSweepOnce({ flagEnabled: true })).toMatchObject({ filed: 0, alreadyFiled: 2 });
    }
    expect(await ensureSpecTriadFiling({ workspaceId: 'ws', harnessSlug: 'h', planSlug: 'ref-drop', missing: ['design'], gap: 'design' }))
      .toMatchObject({ outcome: 'suppressed', id: 'WI-ref' });
    const rows = await h.sql`SELECT feature_id, status FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows.map((r) => [r.feature_id, r.status])).toEqual([['WI-evidence', 'dropped'], ['WI-ref', 'dropped']]);
  });

  it('settles the exempt backlog with evidence and never recreates it', async () => {
    await plan('acceptance-legacy', { declaration: 'required' });
    await plan('declared-exempt', { declaration: 'exempt' });
    await plan('rubric-row', { template: 'rubric' });
    for (const slug of ['acceptance-legacy', 'declared-exempt', 'rubric-row']) await reminder(`WI-${slug}`, slug, 'open');
    expect(await runSpecTriadSweepOnce({ flagEnabled: true })).toMatchObject({ filed: 0, reconciled: 3 });
    expect(await runSpecTriadSweepOnce({ flagEnabled: true })).toMatchObject({ filed: 0, reconciled: 0 });
    const rows = await h.sql`SELECT status, terminal_completion_ref, terminal_owner FROM harness_shared.work_items ORDER BY feature_id`;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'dropped' && r.terminal_owner === 'system:spec-triad')).toBe(true);
    expect(rows.map((r) => r.terminal_completion_ref).join('\n')).toMatch(/acceptance-\*/);
    expect(rows.map((r) => r.terminal_completion_ref).join('\n')).toContain('specTriad: exempt');
    expect(rows.map((r) => r.terminal_completion_ref).join('\n')).toContain("'rubric' template");
    expect(await ensureSpecTriadFiling({ workspaceId: 'ws', harnessSlug: 'h', planSlug: 'acceptance-new', missing: ['design'], gap: 'design' }))
      .toMatchObject({ outcome: 'suppressed' });
  });

  it('does not suppress unreasoned drops, completed work, or another tenant', async () => {
    for (const slug of ['unreasoned', 'done', 'tenant-control']) await plan(slug);
    await reminder('WI-blank', 'unreasoned', 'dropped', { reason: '   ', evidence: { summary: ' ' } });
    await reminder('WI-done', 'done', 'done', { reason: 'An earlier triad was written.' });
    await reminder('WI-foreign', 'tenant-control', 'dropped', { workspace: 'other', reason: 'Foreign disposition' });
    expect(await runSpecTriadSweepOnce({ flagEnabled: true })).toMatchObject({ filed: 3 });
    expect(await runSpecTriadSweepOnce({ flagEnabled: true })).toMatchObject({ filed: 0, alreadyFiled: 3 });
    const rows = await h.sql`SELECT payload->>'specTriadPlan' AS ref FROM harness_shared.work_items WHERE status = 'open' ORDER BY ref`;
    expect(rows.map((r) => r.ref)).toEqual(['ws/h/done', 'ws/h/tenant-control', 'ws/h/unreasoned']);
  });
});
