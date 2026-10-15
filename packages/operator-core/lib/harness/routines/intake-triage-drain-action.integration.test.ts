/**
 * observation-candidate-acceptance-promotion-2026-09-30 P-008 (R-7, D-020) — the
 * intake-triage drain against a fully migrated Postgres.
 *
 * R-7's falsifier: awaiting observations had no registered executor. This proves
 * the drain's population is exactly the awaiting intake (the SHARED P-010
 * predicate), that rows another open run holds are left alone, and that a fire
 * seeds a separate `intake-triage` run whose items are the improvement refs the
 * intake decision path executes — and never claims a work-item.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { createIssue, getIssue } = await import('../../issues-engineer');
const { recordIssueOccurrence } = await import('../../issue-occurrence-ledger');
const { createRun, getRunItems } = await import('../../attention/bulk-run-store');
const { INTAKE_EXECUTION_SCHEMA_VERSION } = await import('../../attention/intake-promotion');
const { makeIntakeTriageDrainAction, readAwaitingIntake, INTAKE_TRIAGE_REQUESTER } = await import(
  './intake-triage-drain-action'
);

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const POLICY = { level: 'L0', mode: 'review-all', minConfidence: 'high' } as const;

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function file(opts: { kind?: 'bug' | 'change' | 'task'; payload?: Record<string, unknown> } = {}) {
  const t = tag();
  return createIssue({
    kind: opts.kind ?? 'bug',
    title: `intake row ${t}`,
    body: `observed ${t}`,
    scope: 'harness:papercusp',
    createdBy: 'su-filer',
    payload: opts.payload ?? { lane: 'observation' },
  });
}

async function workspaceOf(id: string): Promise<string> {
  const [row] = await db.adminSql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${id}`;
  return row!.workspace_id;
}

async function patch(id: string, payload: Record<string, unknown>) {
  await db.adminSql`
    UPDATE harness_shared.work_items SET payload = payload || ${db.adminSql.json(payload as never)}
     WHERE feature_id = ${id}`;
}

function seed(id: string) {
  return { itemId: `improvement:${id}`, kind: 'improvement', title: null, ref: { kind: 'improvement', issueId: id }, ownerAgentId: null };
}

describe('readAwaitingIntake: the drain population is exactly the awaiting intake', () => {
  it('includes awaiting observations newest first and excludes handled, scorecard, terminal, non-observation and open-run rows', async () => {
    const older = await file();
    const newer = await file({ kind: 'change' });
    const handled = await file();
    const scorecard = await file({ payload: { lane: 'observation', observation: { rubricRef: 'rubric-x' } } });
    const terminal = await file();
    const candidate = await file({ payload: {} });
    const task = await file({ kind: 'task' });
    const heldOpen = await file();
    const heldClosed = await file();
    const ws = await workspaceOf(older.id);

    await patch(handled.id, { intakeExecution: { schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION } });
    await db.adminSql`UPDATE harness_shared.work_items SET status = 'done' WHERE feature_id = ${terminal.id}`;
    // Any OPEN run (here an Inbox run) holds its items; a settled run releases them.
    await createRun({ items: [seed(heldOpen.id)], runKind: 'inbox-resolve', workspaceId: ws, automationPolicy: POLICY });
    const closed = await createRun({
      items: [seed(heldClosed.id)],
      runKind: 'intake-triage',
      workspaceId: ws,
      automationPolicy: POLICY,
    });
    await db.adminSql`
      UPDATE harness_shared.attention_bulk_runs SET phase = 'complete' WHERE run_id = ${closed.runId}`;

    const ours = new Set([older, newer, handled, scorecard, terminal, candidate, task, heldOpen, heldClosed].map((i) => i.id));
    const rows = (await readAwaitingIntake(ws, 1000)).filter((r) => ours.has(r.id));
    expect(rows.map((r) => r.id)).toEqual([heldClosed.id, newer.id, older.id]);
    expect(rows[1]).toMatchObject({ harnessSlug: expect.any(String), title: newer.title });
  });

  it('re-opens a retained observation when a newer occurrence lands (shared P-010 predicate)', async () => {
    const obs = await file();
    const ws = await workspaceOf(obs.id);
    await patch(obs.id, {
      intakeDisposition: { schemaVersion: INTAKE_EXECUTION_SCHEMA_VERSION, disposition: 'retain', occurrenceWatermark: 0 },
    });
    const ids = async () => (await readAwaitingIntake(ws, 1000)).map((r) => r.id);
    expect(await ids()).not.toContain(obs.id);
    const later = await recordIssueOccurrence(
      { canonicalId: obs.id, sourceTool: 'system', reportKind: 'duplicate', reportedTitle: 'it happened again' },
      db.adminSql as never,
    );
    expect(later).not.toBeNull();
    expect(await ids()).toContain(obs.id);
  });
});

describe('a drain fire seeds a separate intake-triage run and claims nothing', () => {
  it('launches one intake-triage run over the awaiting rows, and the next fire is single-flight', async () => {
    const obs = await file();
    const ws = await workspaceOf(obs.id);
    const launch = vi.fn(async () => ({ ok: true }));
    const action = makeIntakeTriageDrainAction({
      enabled: async () => true,
      readLaunchProfile: async () => null,
      recentNeverBeat: async () => ({ consecutive: 0, newestCreatedAt: null }),
      readAutomationPolicy: async () => POLICY as never,
      newOwnerId: () => 'su-intake-resolver',
      launch,
      log: () => {},
    });
    const ctx = { installSlug: 'papercusp', workspaceId: ws, triggerConfig: {}, payloadTemplate: null };

    const first = await action.fire(ctx);
    expect(first).toMatchObject({ status: 'launched' });
    if (first.status !== 'launched') return;
    const [run] = await db.adminSql<{ run_kind: string; requested_by: string; phase: string }[]>`
      SELECT run_kind, requested_by, phase FROM harness_shared.attention_bulk_runs WHERE run_id = ${first.runId}`;
    expect(run).toEqual({ run_kind: 'intake-triage', requested_by: INTAKE_TRIAGE_REQUESTER, phase: 'running' });
    const items = await getRunItems(first.runId);
    expect(items.map((i) => i.itemId)).toContain(`improvement:${obs.id}`);
    expect(items.find((i) => i.itemId === `improvement:${obs.id}`)).toMatchObject({
      kind: 'improvement',
      ref: expect.objectContaining({ kind: 'improvement', issueId: obs.id }),
    });

    // The intake row stays unclaimed observation-lane work; only a sealed decision becomes claimable.
    const after = await getIssue(obs.id);
    expect(after?.assignee ?? null).toBeNull();
    expect((after?.payload as Record<string, unknown>).lane).toBe('observation');

    expect(await action.fire(ctx)).toEqual({ status: 'skipped', reason: 'single-flight' });
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
