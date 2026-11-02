/** POLICY-IDEMPOTENT: actual routine/event enqueue and DBOS admission on private PG.
 * Only terminal effects and their tool lookup are fixtures; queue conflicts,
 * reaction receipts, workspace policy and invocation history are never mocked.
 * The real routinesTick schedule runs only against this private database;
 * unrelated periodic registrations are parked for the executor's lifetime.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { RoutineFireRow } from './routines-workflow';
import type { DurableReactionInput } from '../events/durable';
import type { ReactionRule } from '../events/types';
import type { SessionUser } from '../auth';
import type { UnifiedToolContext } from '@papercusp/tooldef';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql,
  appSql: undefined as unknown as postgres.Sql, lookup: vi.fn(), dispatch: vi.fn(),
  beforeWorkspaceInvoke: undefined as (() => Promise<void>) | undefined }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: (workspaceId: string, invoke: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    h.appSql.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await h.beforeWorkspaceInvoke?.();
      return invoke(tx);
    }),
}));
vi.mock('@papercusp/tooldef', async original => ({
  ...await original<typeof import('@papercusp/tooldef')>(),
  lookupByMcpName: h.lookup, dispatchProjectedTool: h.dispatch,
}));
vi.mock('../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'startup-dedup-test' }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./bootstrap', () => ({ dbosStarted: () => true, withDbosIdleTxGrace: (url: string) => url }));
vi.mock('../harness/routines/register-system-actions', () => ({}));
vi.mock('../harness/routines/configure-per-workspace', () => ({}));

let db: OrgTestDb;
let DBOS: typeof DBOSType;
let enqueue: typeof import('./routines-workflow').enqueueRoutineFire;
let enqueueEvent: typeof import('./event-reaction-workflow').enqueueDurableReaction;
const executions = new Map<string, string[]>();
const blocked = new Map<string, { wait: Promise<void>; release: () => void }>();
const workspace = 'startup-dedup-test';
const action = 'startup-dedup-test-effect';
const eventAction = 'startup-dedup:effect';
const user: SessionUser = { id: '03ffddab-83cb-44a2-93e5-d16429c72a2f', username: 'startup-dedup-test',
  display_name: 'Startup dedup fixture', has_password: false, workspace_id: workspace, capabilities: ['*'] };
const schedules: Array<{ config: { crontab: string }; original: string }> = [];

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  // Migrations may seed maintenance rows. Only this file's explicitly created
  // routines belong to the automatic scheduler population under test.
  await db.adminSql`UPDATE harness_shared.routines SET active = false`;
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({ name: 'papercusp-startup-dedup-test', systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: 'startup-dedup-test', runAdminServer: false });
  ({ enqueueRoutineFire: enqueue } = await import('./routines-workflow'));
  ({ enqueueDurableReaction: enqueueEvent } = await import('./event-reaction-workflow'));
  h.lookup.mockImplementation((name: string) => name === eventAction ? {} : undefined);
  h.dispatch.mockImplementation(async (_projected: unknown, name: string, _args: unknown, context: UnifiedToolContext) => {
    if (name !== eventAction || !context.reactionCause?.ruleId || !context.runId || context.workspaceId !== workspace)
      throw new Error('Unexpected terminal event dispatch');
    const id = context.reactionCause.ruleId;
    executions.set(id, [...(executions.get(id) ?? []), context.runId]);
    await blocked.get(id)?.wait;
    return { ok: true, result: { privateCountingEffect: true } };
  });
  const registrations = DBOS.getAssociatedInfo('dbos.scheduler');
  expect(registrations.some(registration => registration.methodReg.name === 'routinesTick')).toBe(true);
  for (const registration of registrations) {
    const config = registration.methodConfig as { crontab: string };
    schedules.push({ config, original: config.crontab });
    config.crontab = registration.methodReg.name === 'routinesTick' ? '* * * * * *' : '0 0 0 1 1 *';
  }
  const { registerSystemAction } = await import('../harness/routines/system-actions');
  registerSystemAction(action, async context => {
    if (!context.workflowId || !context.routineId) throw new Error('Expected real routine and workflow identities');
    const prior = executions.get(context.routineId) ?? [];
    executions.set(context.routineId, [...prior, context.workflowId]);
    await blocked.get(context.routineId)?.wait;
    return { diagnostics: { privateCountingEffect: true } };
  }, { scheduling: 'on-demand' });
  await DBOS.launch();
}, 180_000);

afterAll(async () => {
  for (const gate of blocked.values()) gate.release();
  try { await DBOS?.shutdown(); }
  finally {
    for (const { config, original } of schedules) config.crontab = original;
    await db?.cleanup();
  }
}, 120_000);

afterEach(async () => {
  h.beforeWorkspaceInvoke = undefined;
  await db.adminSql`UPDATE harness_shared.routines SET active = false WHERE workspace_id = ${workspace}`;
  await db.adminSql`DELETE FROM harness_shared.operator_paused WHERE workspace_id = ${workspace}`;
});

async function routine(): Promise<RoutineFireRow> {
  const id = `startup-dedup-${randomUUID()}`;
  const row: RoutineFireRow = { id, workspaceId: workspace, installSlug: 'startup-dedup-test', name: id,
    targetRole: `system:${action}`, triggerConfig: { cron: '0 0 0 1 1 *' },
    payloadTemplate: null, rescheduleIntervalSec: null, targetOwnerId: null };
  await db.adminSql`INSERT INTO harness_shared.routines
    (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active, tier, next_fire_at)
    VALUES (${id}, ${workspace}, ${row.installSlug}, ${id}, 'cron',
      ${JSON.stringify(row.triggerConfig)}::text::jsonb, ${row.targetRole}, true, 'durable', 'infinity')`;
  return row;
}

function hold(id: string): () => void {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  blocked.set(id, { wait, release });
  return () => { blocked.delete(id); release(); };
}

async function complete(id: string): Promise<void> {
  await expect.poll(() => executions.get(id)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  await finishWorkflow(executions.get(id)!.at(-1)!);
}

async function finishWorkflow(id: string): Promise<void> {
  await DBOS.getResult<void>(id, 30);
  // A void result cannot distinguish completion from a result-read timeout.
  const [state] = await db.adminSql<{ status: string }[]>`
    SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${id}`;
  expect(state?.status).toBe('SUCCESS');
}

describe('startup routine duplicate admission (real DBOS and PostgreSQL)', () => {
  it('admits one concurrent delivery per routine and permits a later distinct occurrence', async () => {
    const row = await routine();
    const release = hold(row.id);
    try {
      const deliveries = await Promise.all([enqueue(row), enqueue(row)]);
      expect(deliveries.map(result => result.status).sort()).toEqual(['deduplicated', 'enqueued']);
      expect(deliveries.every(result => result.ok && result.deduplicationId === `routine:${row.id}`)).toBe(true);
      await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 15_000 }).toBe(1);
    } finally { release(); }
    await complete(row.id);
    expect(executions.get(row.id)).toHaveLength(1);

    // The mutex guards concurrent deliveries, not every future occurrence of this routine.
    await expect(enqueue(row)).resolves.toMatchObject({ ok: true, status: 'enqueued' });
    await expect.poll(() => executions.get(row.id)?.length, { timeout: 15_000 }).toBe(2);
    await complete(row.id);
    expect(new Set(executions.get(row.id)).size).toBe(2);
  }, 90_000);

  it('does not collapse two distinct routine identities into one execution', async () => {
    const [first, second] = await Promise.all([routine(), routine()]);
    const releaseFirst = hold(first.id);
    const releaseSecond = hold(second.id);
    try {
      const deliveries = await Promise.all([enqueue(first), enqueue(second)]);
      expect(deliveries.map(result => result.status)).toEqual(['enqueued', 'enqueued']);
      expect(new Set(deliveries.map(result => result.deduplicationId)).size).toBe(2);
      await expect.poll(() => [executions.get(first.id)?.length ?? 0, executions.get(second.id)?.length ?? 0],
        { timeout: 15_000 }).toEqual([1, 1]);
    } finally { releaseFirst(); releaseSecond(); }
    await Promise.all([complete(first.id), complete(second.id)]);
    expect(executions.get(first.id)).toHaveLength(1);
    expect(executions.get(second.id)).toHaveLength(1);
  }, 60_000);

  it('collapses an automatic scheduler delivery during a manual fire, then runs a later scheduled occurrence', async () => {
    const row = await routine();
    const release = hold(row.id);
    try {
      await expect(enqueue(row)).resolves.toMatchObject({ ok: true, status: 'enqueued' });
      await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 15_000 }).toBe(1);
      await db.adminSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
        WHERE id = ${row.id}`;
      // Only the actual scheduled tick can claim and advance this row: no tick
      // implementation, claim, enqueue or admission return value is mocked.
      await expect.poll(async () => {
        const [state] = await db.adminSql<{ claimed: boolean }[]>`
          SELECT last_fired_at IS NOT NULL AND next_fire_at > now() AS claimed
          FROM harness_shared.routines WHERE id = ${row.id}`;
        return state?.claimed;
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => {
        const [state] = await db.adminSql<{ finished: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM dbos.workflow_status
            WHERE name = 'routinesTick' AND status = 'SUCCESS'
              AND updated_at >= (SELECT extract(epoch FROM last_fired_at) * 1000
                FROM harness_shared.routines WHERE id = ${row.id})) AS finished`;
        return state?.finished;
      }, { timeout: 30_000 }).toBe(true);
      expect(executions.get(row.id)).toHaveLength(1);
      expect(await db.adminSql`SELECT workflow_uuid FROM dbos.workflow_status
        WHERE deduplication_id = ${`routine:${row.id}`}`).toHaveLength(1);
    } finally { release(); }
    await complete(row.id);

    // A new due occurrence must reach the same real scheduler without being
    // mistaken for a replay of the earlier, already completed manual request.
    await db.adminSql`UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
      WHERE id = ${row.id}`;
    await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 30_000 }).toBe(2);
    await complete(row.id);
    expect(new Set(executions.get(row.id)).size).toBe(2);
    const { startupActivityFeatureId } = await import('../schedule-inventory');
    const featureId = startupActivityFeatureId({ source: 'routines', installSlug: row.installSlug,
      name: row.name, detail: {} }, { workspaceId: workspace });
    const starts = await db.adminSql<{ trigger: string }[]>`
      SELECT details->'startupActivity'->>'trigger' AS trigger FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}
      ORDER BY ts, id`;
    expect(starts.map(start => start.trigger).sort()).toEqual(['manual', 'timer']);
  }, 120_000);

  it('keeps disabled work due across real scheduler passes and runs that occurrence after re-enable', async () => {
    const { setWorkspaceBackgroundActivityPolicy } = await import('../device-operator-actions');
    const { startupActivityFeatureId } = await import('../schedule-inventory');
    const row = await routine();
    const featureId = startupActivityFeatureId({ source: 'routines', installSlug: row.installSlug,
      name: row.name, detail: {} }, { workspaceId: workspace });
    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: false }, 0, user);
    const [due] = await db.adminSql<{ next_fire_at: Date }[]>`
      UPDATE harness_shared.routines SET next_fire_at = now() - interval '1 second'
      WHERE id = ${row.id} RETURNING next_fire_at`;
    const knownTicks = new Set((await db.adminSql<{ workflow_uuid: string }[]>`
      SELECT workflow_uuid FROM dbos.workflow_status WHERE name = 'routinesTick'`)
      .map(tick => tick.workflow_uuid));
    // Observe completed scheduler opportunities, rather than a sleep that could
    // pass with a stopped executor. Neither claim nor admission is mocked.
    await expect.poll(async () => {
      const ticks = await db.adminSql<{ workflow_uuid: string }[]>`
        SELECT workflow_uuid FROM dbos.workflow_status
        WHERE name = 'routinesTick' AND status = 'SUCCESS'`;
      return ticks.filter(tick => !knownTicks.has(tick.workflow_uuid)).length;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(await db.adminSql`SELECT active, last_fired_at, next_fire_at
      FROM harness_shared.routines WHERE id = ${row.id}`)
      .toEqual([{ active: true, last_fired_at: null, next_fire_at: due.next_fire_at }]);
    expect(executions.get(row.id)).toBeUndefined();
    expect(await db.adminSql`SELECT workflow_uuid FROM dbos.workflow_status
      WHERE deduplication_id = ${`routine:${row.id}`}`).toHaveLength(0);
    expect(await db.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}`)
      .toHaveLength(0);

    // Re-enable the original due row: no new occurrence, manual enqueue, or
    // timestamp rewrite is allowed to manufacture the positive control.
    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: true }, 1, user);
    await expect.poll(() => executions.get(row.id)?.length ?? 0, { timeout: 30_000 }).toBe(1);
    await complete(row.id);
    expect(await db.adminSql`SELECT last_fired_at IS NOT NULL AND next_fire_at > now() AS claimed
      FROM harness_shared.routines WHERE id = ${row.id}`).toEqual([{ claimed: true }]);
    expect(await db.adminSql`SELECT details->'startupActivity'->>'trigger' AS trigger
      FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}`)
      .toEqual([{ trigger: 'timer' }]);
    expect(executions.get(row.id)).toHaveLength(1);
  }, 90_000);
});

function eventInput(rule: ReactionRule = { id: `startup-event-${randomUUID()}`,
  on: 'startup-dedup:trigger', fire: eventAction }): DurableReactionInput {
  const root = randomUUID();
  return { rule, fire: eventAction, args: {},
    event: { tool: 'startup-dedup:trigger', args: {}, result: { ok: true },
      ctx: { workspaceId: workspace, runId: root } as UnifiedToolContext },
    cause: { depth: 1, chain: [rule.id], ruleId: rule.id, rootRunId: root } };
}

async function finishEvent(input: DurableReactionInput): Promise<string> {
  const { computeDedupId } = await import('../events/reaction-id');
  const dedupId = computeDedupId(input);
  await finishWorkflow(`reaction:${dedupId}`);
  return dedupId;
}

describe('startup event duplicate admission (real DBOS and PostgreSQL)', () => {
  it('executes one concurrent delivery, reuses its completion, and admits a distinct later event', async () => {
    const input = eventInput();
    const release = hold(input.rule.id);
    try {
      const deliveries = await Promise.allSettled([enqueueEvent(input), enqueueEvent(input)]);
      expect(deliveries.some(result => result.status === 'fulfilled')).toBe(true);
      // A queue conflict is permitted only with the SDK's actual duplicate code.
      for (const result of deliveries)
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ dbosErrorCode: 28 });
      await expect.poll(() => executions.get(input.rule.id)?.length ?? 0, { timeout: 15_000 }).toBe(1);
      expect(await db.adminSql`SELECT dedup_id FROM harness_shared.event_reactions
        WHERE workspace_id = ${workspace} AND rule_id = ${input.rule.id}`).toHaveLength(1);
    } finally { release(); }
    const firstDedupId = await finishEvent(input);

    await enqueueEvent(input);
    await finishEvent(input);
    expect(executions.get(input.rule.id)).toHaveLength(1);

    // Also replay the actual durable body independently of DBOS's workflow ID.
    // The PostgreSQL completion receipt must prevent another terminal effect.
    const { executeDurableReaction } = await import('../events/durable-exec');
    const { serializeParent } = await import('../events/reaction-id');
    await executeDurableReaction({ fire: input.fire, args: input.args, parent: serializeParent(input.event.ctx),
      cause: input.cause, ruleId: input.rule.id, triggerTool: input.event.tool, dedupId: firstDedupId });
    expect(executions.get(input.rule.id)).toHaveLength(1);

    const later = eventInput(input.rule);
    await enqueueEvent(later);
    expect(await finishEvent(later)).not.toBe(firstDedupId);
    expect(executions.get(input.rule.id)).toHaveLength(2);
    expect(new Set(executions.get(input.rule.id)).size).toBe(2);
    expect(await db.adminSql`SELECT status FROM harness_shared.event_reactions
      WHERE workspace_id = ${workspace} AND rule_id = ${input.rule.id} AND status = 'completed'`).toHaveLength(2);
    const { startupReactionFeatureId } = await import('../events/reaction-id');
    const starts = await db.adminSql<{ source: string; trigger: string }[]>`
      SELECT details->'startupActivity'->>'source' AS source,
        details->'startupActivity'->>'trigger' AS trigger FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity'
        AND subject = ${startupReactionFeatureId(workspace, input.rule.id)}`;
    expect(starts).toEqual([{ source: 'event', trigger: 'event' }, { source: 'event', trigger: 'event' }]);
  }, 120_000);

  it('withholds a durable event without a claim or start, then admits a later authorized event', async () => {
    const { setWorkspaceBackgroundActivityPolicy } = await import('../device-operator-actions');
    const input = eventInput();
    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: false }, 0, user);
    await enqueueEvent(input);
    await finishEvent(input);
    expect(executions.get(input.rule.id)).toBeUndefined();
    expect(await db.adminSql`SELECT dedup_id FROM harness_shared.event_reactions
      WHERE workspace_id = ${workspace} AND rule_id = ${input.rule.id}`).toHaveLength(0);
    const { startupReactionFeatureId } = await import('../events/reaction-id');
    const featureId = startupReactionFeatureId(workspace, input.rule.id);
    expect(await db.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}`).toHaveLength(0);

    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: true }, 1, user);
    const later = eventInput(input.rule);
    await enqueueEvent(later);
    await finishEvent(later);
    expect(executions.get(input.rule.id)).toHaveLength(1);
    expect(await db.adminSql`SELECT status FROM harness_shared.event_reactions
      WHERE workspace_id = ${workspace} AND rule_id = ${input.rule.id} AND status = 'completed'`).toHaveLength(1);
    expect(await db.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}`).toHaveLength(1);
  }, 90_000);

  it('releases an admitted reaction when a newer disable wins before the workspace dispatch callback', async () => {
    const { setWorkspaceBackgroundActivityPolicy } = await import('../device-operator-actions');
    const { computeDedupId, startupReactionFeatureId } = await import('../events/reaction-id');
    const input = eventInput();
    const dedupId = computeDedupId(input);
    const featureId = startupReactionFeatureId(workspace, input.rule.id);
    const boundary = `workspace-dispatch:${input.rule.id}`;
    const release = hold(boundary);
    let reachedWorkspace = false;
    // Pause only the existing role-scoped transaction seam. The durable body,
    // claim, policy reads, final dispatch fence and release remain real.
    h.beforeWorkspaceInvoke = async () => {
      reachedWorkspace = true;
      await blocked.get(boundary)?.wait;
    };
    try {
      await enqueueEvent(input);
      await expect.poll(() => reachedWorkspace, { timeout: 15_000 }).toBe(true);
      expect(await db.adminSql`SELECT status FROM harness_shared.event_reactions
        WHERE dedup_id = ${dedupId}`).toEqual([{ status: 'fired' }]);
      await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: false }, 0, user);
    } finally {
      h.beforeWorkspaceInvoke = undefined;
      release();
    }
    await finishEvent(input);
    expect(executions.get(input.rule.id)).toBeUndefined();
    expect(await db.adminSql`SELECT dedup_id FROM harness_shared.event_reactions
      WHERE workspace_id = ${workspace} AND rule_id = ${input.rule.id}`).toHaveLength(0);
    expect(await db.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}`).toHaveLength(0);

    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: true }, 1, user);
    const later = eventInput(input.rule);
    await enqueueEvent(later);
    await finishEvent(later);
    expect(executions.get(input.rule.id)).toHaveLength(1);
    expect(await db.adminSql`SELECT status FROM harness_shared.event_reactions
      WHERE workspace_id = ${workspace} AND rule_id = ${input.rule.id}`).toEqual([{ status: 'completed' }]);
    expect(await db.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspace} AND action = 'background-activity' AND subject = ${featureId}`).toHaveLength(1);
  }, 90_000);
});
