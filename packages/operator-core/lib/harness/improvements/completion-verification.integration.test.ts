/**
 * P-007 Phase C (unified-bug-pipeline-and-honest-queue-2026-10-05, D-028) on a fully migrated
 * Postgres: a completion that lands 'proposed' on an item that still blocks live work spawns
 * one completion verification task, and that task gates the dependents through ordinary
 * `blocks` edges.
 *
 * The pure policy is covered by completion-verification.test.ts. This file proves the
 * Postgres-backed store (completion-verification-store.ts) composes with the real writers:
 * createIssue stores a task whose sealed acceptance still matches its row (so the claim floor
 * from migration 1373 admits it), linkIssue's edges hold the dependents in the scheduler's
 * self-select read, the closer is refused at the by-id claim, a reject reopens the subject to
 * its closer, and settlement accepts an open task.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { FilterNode } from '../../scheduler/claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { createIssue, claimIssue, issueRef, linkIssue } = await import('../../issues-engineer');
const { setWorkItemState } = await import('../../work-items');
const { readIssueClaimability } = await import('../../scheduler/get-next');
const { IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS } = await import('./agent-review-policy');
const store = await import('./completion-verification-store');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const CLOSER = 'su-cv-closer';
const VERIFIER = 'su-cv-verifier';
const WORKER = 'su-cv-worker';
/** D-018 §3: a row dated after the cutover is judged by the acceptance floor whatever the sentinel is. */
const POST_CUTOVER = IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS + 60_000;

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Row {
  feature_id: string;
  workspace_id: string;
  harness_slug: string;
  item_kind: string;
  status: string;
  title: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  taken_by: string | null;
  terminal_owner: string | null;
}

async function row(id: string): Promise<Row> {
  const [r] = await db.adminSql<Row[]>`
    SELECT feature_id, workspace_id, harness_slug, item_kind, status, title, summary, payload, taken_by, terminal_owner
      FROM harness_shared.work_items WHERE feature_id = ${id}`;
  if (!r) throw new Error(`no work_items row for ${id}`);
  return r;
}

async function tasksFor(subjectId: string): Promise<string[]> {
  const rows = await db.adminSql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE payload -> 'verification' ->> 'subject' = ${subjectId} AND payload ? 'completionVerification'`;
  return rows.map((r) => r.feature_id).sort();
}

/** A by-id claim's verdict is the row's holder afterwards; a refusal may throw or return. */
async function claims(id: string, assignee: string): Promise<boolean> {
  const { workspace_id } = await row(id);
  try {
    await claimIssue(id, assignee, { workspaceId: workspace_id } as never);
  } catch {
    /* refused */
  }
  return (await row(id)).taken_by === assignee;
}

/** The scheduler's self-select read, scoped to one row: false while any blocker holds it. */
async function selfSelectable(id: string): Promise<boolean> {
  const { workspace_id, harness_slug } = await row(id);
  const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
  const read = await readIssueClaimability(filter, {
    harness: harness_slug, workspaceId: workspace_id, states: ['open'], assignee: WORKER, client: db.adminSql,
  }, { limit: 10 });
  return read.rows.some((r) => r.id === id);
}

/** A subject that blocks one live dependent, closed 'proposed' by CLOSER. */
async function proposedSubjectWithDependent(t: string) {
  const subject = await createIssue({
    kind: 'task',
    title: `rotate the export signing key ${t}`,
    body: `the export signing key expires on the first of the month ${t}`,
    scope: 'harness:papercusp',
    createdBy: CLOSER,
  });
  const dependent = await createIssue({
    kind: 'task',
    title: `re-sign last month's exports ${t}`,
    body: `exports signed with the old key must be re-signed ${t}`,
    scope: 'harness:papercusp',
    createdBy: WORKER,
  });
  await linkIssue(subject.id, issueRef(dependent.id), 'blocks', 'fixture', 'success');
  // Positive control: the edge holds the dependent while the subject is open.
  expect(await selfSelectable(dependent.id)).toBe(false);
  const { harness_slug } = await row(subject.id);
  await setWorkItemState(subject.id, 'resolved', {
    harness: harness_slug,
    by: CLOSER,
    completionAuthority: 'proposed',
    completionEvidence: { verifiedHow: 'manual', testsRun: 'none', testResult: 'not run' },
  });
  // Without a verification task, a 'proposed' close releases the dependent (D-028 keeps what
  // satisfies a blocker unchanged); this is what the task exists to hold.
  expect(await selfSelectable(dependent.id)).toBe(true);
  return { subject, dependent, harness: harness_slug };
}

async function spawnFor(subjectId: string, harness: string) {
  const s = await row(subjectId);
  return store.spawnCompletionVerificationForClose({
    id: subjectId,
    title: s.title ?? subjectId,
    kind: s.item_kind,
    closer: s.terminal_owner ?? CLOSER,
    harness,
  });
}

async function closeTask(taskId: string, harness: string, verifier: string) {
  await setWorkItemState(taskId, 'resolved', {
    harness,
    by: verifier,
    completionAuthority: 'committed',
    completionEvidence: { verifiedHow: 'integration', testsRun: 'completion review', testResult: 'passed' },
  });
}

describe('P-007 Phase C a proposed completion is verified before its dependents proceed', () => {
  it('spawns one task that holds the dependent, refuses the closer, admits a verifier, and releases on accept', async () => {
    const t = tag();
    const { subject, dependent, harness } = await proposedSubjectWithDependent(t);
    expect((await row(subject.id)).terminal_owner).toBe(CLOSER);

    const spawned = await spawnFor(subject.id, harness);
    expect(spawned).toMatchObject({ outcome: 'created', gated: [dependent.id], notGated: [] });
    if (spawned.outcome !== 'created') return;
    const taskId = spawned.taskId;
    expect(await selfSelectable(dependent.id)).toBe(false);

    // Idempotent per subject: a second spawn reuses the open task and adds no second one.
    expect(await spawnFor(subject.id, harness)).toMatchObject({ outcome: 'reused', taskId, gated: [dependent.id] });
    expect(await tasksFor(subject.id)).toEqual([taskId]);

    // The stored row still matches its sealed acceptance (createIssue keeps the title and
    // stores the body as the summary), so the 1373 claim floor admits it as post-cutover work.
    const task = await row(taskId);
    expect(task.item_kind).toBe('task');
    expect(task.summary).toContain(`${subject.id} was closed by ${CLOSER}`);
    await db.adminSql`UPDATE harness_shared.work_items SET created_ts = ${POST_CUTOVER} WHERE feature_id = ${taskId}`;

    // Falsifiability control: an identical row whose block names a different subject is refused.
    const twin = `${taskId}-TWIN`;
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload, origin, title, summary, admission)
      SELECT harness_slug, ${twin}, item_kind, status, workspace_id, created_ts, updated_ts,
             jsonb_set(payload, '{verification,subject}', to_jsonb(${`${subject.id}-OTHER`}::text)),
             origin, title, summary, admission
        FROM harness_shared.work_items WHERE feature_id = ${taskId}`;
    expect(await claims(twin, VERIFIER)).toBe(false);

    // The closer can never verify their own completion; an independent verifier can.
    expect(await claims(taskId, CLOSER)).toBe(false);
    expect(await claims(taskId, VERIFIER)).toBe(true);

    await closeTask(taskId, harness, VERIFIER);
    const applied = await store.applyCompletionVerdictForClose({
      taskPayload: task.payload,
      completion: { verificationVerdict: { verdict: 'accept' } },
      verifier: VERIFIER,
    });
    expect(applied).toEqual({ applied: 'accept', subject: subject.id });
    // Accept writes nothing: the subject stays closed (a task stores 'resolved' as 'done').
    expect((await row(subject.id)).status).toBe('done');
    expect(await selfSelectable(dependent.id)).toBe(true);
  });

  it('a reject reopens the subject to its closer, whose own edge holds the dependent again', async () => {
    const t = tag();
    const { subject, dependent, harness } = await proposedSubjectWithDependent(t);
    const spawned = await spawnFor(subject.id, harness);
    if (spawned.outcome !== 'created') throw new Error(`expected a created task, got ${spawned.outcome}`);
    expect(await claims(spawned.taskId, VERIFIER)).toBe(true);
    const task = await row(spawned.taskId);

    await closeTask(spawned.taskId, harness, VERIFIER);
    // The task is done, so only the subject's own edge can hold the dependent from here.
    expect(await selfSelectable(dependent.id)).toBe(true);
    const applied = await store.applyCompletionVerdictForClose({
      taskPayload: task.payload,
      completion: { verificationVerdict: { verdict: 'reject', reason: 'the old key still signs new exports' } },
      verifier: VERIFIER,
    });
    expect(applied).toEqual({ applied: 'reject', subject: subject.id });
    const reopened = await row(subject.id);
    expect(reopened.status).toBe('open');
    expect(reopened.taken_by).toBe(CLOSER);
    expect(await selfSelectable(dependent.id)).toBe(false);
  });

  it('settlement that upgrades the subject accepts the open task and releases the dependent', async () => {
    const t = tag();
    const { subject, dependent, harness } = await proposedSubjectWithDependent(t);
    const spawned = await spawnFor(subject.id, harness);
    if (spawned.outcome !== 'created') throw new Error(`expected a created task, got ${spawned.outcome}`);
    expect(await selfSelectable(dependent.id)).toBe(false);

    // A still-proposed settlement accepts nothing.
    expect(await store.acceptCompletionOnSettlementForSubject(subject.id, 'proposed')).toBeNull();
    expect((await row(spawned.taskId)).status).toBe('open');

    expect(await store.acceptCompletionOnSettlementForSubject(subject.id, 'committed')).toEqual({ accepted: spawned.taskId });
    expect((await row(spawned.taskId)).status).toBe('done');
    expect(await selfSelectable(dependent.id)).toBe(true);
    // Accepted tasks are terminal, so a later lookup finds nothing to accept.
    expect(await store.acceptCompletionOnSettlementForSubject(subject.id, 'committed')).toBeNull();
  });

  it('a proposed close that blocks nothing live spawns no task', async () => {
    const t = tag();
    const lone = await createIssue({
      kind: 'task',
      title: `tidy the export bucket lifecycle rule ${t}`,
      body: `the lifecycle rule keeps objects a day too long ${t}`,
      scope: 'harness:papercusp',
      createdBy: CLOSER,
    });
    const { harness_slug } = await row(lone.id);
    await setWorkItemState(lone.id, 'resolved', {
      harness: harness_slug,
      by: CLOSER,
      completionAuthority: 'proposed',
      completionEvidence: { verifiedHow: 'manual', testsRun: 'none', testResult: 'not run' },
    });
    expect(await spawnFor(lone.id, harness_slug)).toEqual({ outcome: 'no-dependents' });
    expect(await tasksFor(lone.id)).toEqual([]);
  });

  // WI-6554700010008447: feature-family edges name the dependent harness-QUALIFIED (D-009), so a
  // bare `feature_id = blocked_ref` join never matched them and such dependents went ungated.
  it('liveDependents finds a feature-family dependent through its qualified edge and skips a terminal one', async () => {
    const t = tag();
    const subject = await createIssue({
      kind: 'task',
      title: `publish the rotated key fingerprint ${t}`,
      body: `downstream verifiers pin the export key fingerprint ${t}`,
      scope: 'harness:papercusp',
      createdBy: CLOSER,
    });
    const issueDependent = await createIssue({
      kind: 'task',
      title: `update the pinned fingerprint in the verifier ${t}`,
      body: `the verifier pins the old fingerprint ${t}`,
      scope: 'harness:papercusp',
      createdBy: WORKER,
    });
    await linkIssue(subject.id, issueRef(issueDependent.id), 'blocks', 'fixture', 'success');
    const { harness_slug } = await row(subject.id);
    const liveFeature = `WI-CVF-${t}`;
    const doneFeature = `WI-CVF-DONE-${t}`;
    for (const [featureId, status] of [[liveFeature, 'open'], [doneFeature, 'done']] as const) {
      await db.adminSql`
        INSERT INTO harness_shared.work_items
          (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload, origin, title, summary, admission)
        SELECT harness_slug, ${featureId}, 'feature', ${status}, workspace_id, created_ts, updated_ts, '{}'::jsonb,
               origin, ${`ship the fingerprint rollout ${featureId}`}, summary, admission
          FROM harness_shared.work_items WHERE feature_id = ${subject.id}`;
      await db.adminSql`
        INSERT INTO harness_shared.work_item_deps
          (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)
        VALUES (${DEFAULT_COORD_WORKSPACE}, 'feature', ${`${harness_slug}#${featureId}`}, 'issue', ${subject.id},
                'blocks', 'success', 'fixture')`;
    }

    const found = await store.liveDependents(subject.id);
    expect(found.map((d) => d.ref).sort()).toEqual([issueDependent.id, `${harness_slug}#${liveFeature}`].sort());
    expect(found.find((d) => d.ref === `${harness_slug}#${liveFeature}`)?.kind).toBe('feature');
  });
});
