/** Session-independent recovery on the existing gate-watcher cadence.
 * A session dying is evidence of lost custody, never evidence of fulfillment.
 * Reuse the condition-key queue, directive_ref ownership, and dead-claim reaper.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';
import { boundedOrgTxn } from './pg-bounded-txn';
import { routeOpenDirectives, type DirectiveRoute } from './owner-directive-routing';
import { upsertConditionWorkItemInTransaction } from './coord/condition-upsert';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { ackAndRead, stage } from './agent-tools/coordination/read-cursors';

export const DIRECTIVE_RECOVERY_ACTOR = 'system:owner-directive-recovery';
const SURFACE = 'owner-directive-recovery';
const PAGE_SIZE = 50;
export interface RecoveryDirective { id: number; recordedBy: string }
export type DirectiveRecoveryRegistration = { id: string; created: boolean } | null;

/** Called under the directive row lock; a retry/concurrent sweep keeps one task.
 * Existing linked work, including parked or unclaimed work, keeps its custody.
 * The normal dead-owner lease reaper handles a recovery worker that dies too.
 */
export async function registerDirectiveRecovery(
  tx: TransactionSql,
  input: { workspaceId: string; harness: string; directive: RecoveryDirective },
): Promise<DirectiveRecoveryRegistration> {
  const { workspaceId, harness, directive } = input;
  const [open] = await tx<{ id: number }[]>`
    SELECT id FROM harness_shared.owner_directives
     WHERE workspace_id = ${workspaceId} AND id = ${directive.id}
       AND recorded_by = ${directive.recordedBy} AND dispositioned_at IS NULL
     FOR UPDATE`;
  if (!open) return null;
  const [linked] = await tx<{ id: string }[]>`
    SELECT feature_id AS id FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND directive_ref = ${directive.id}
       AND NOT (status = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
     ORDER BY created_ts, feature_id LIMIT 1`;
  if (linked) return { id: linked.id, created: false };

  const task = await upsertConditionWorkItemInTransaction(tx,
    `owner-directive-recovery:${workspaceId}:${directive.id}`, {
      kind: 'task', workspaceId, harness, createdBy: DIRECTIVE_RECOVERY_ACTOR,
      title: `Recover unresolved owner directive #${directive.id}`,
      summary: `Directive #${directive.id} lost its session without a live holder or fleet leader. ` +
        `Read orders:get { id: ${directive.id} } and its source conversation and linked work before acting. ` +
        'Establish what was fulfilled and what remains. Preserve owner decisions, scope, admission, ' +
        'security, publication and live-gate constraints; recovery is not a new execution grant. ' +
        'Finish authorized work, hand it to an eligible holder, or record the exact blocker. ' +
        'Close the directive with orders:disposition and evidence before closing this recovery task. ' +
        'Do not infer done from age, session death, or a terminal linked work-item alone.',
      payload: { ownerDirectiveRecovery: { directiveId: directive.id, recordedBy: directive.recordedBy } },
    });
  if (!task.id) throw new Error('directive recovery registration returned no work-item');
  await tx`
    UPDATE harness_shared.work_items SET directive_ref = ${directive.id}
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harness}
       AND feature_id = ${task.id} AND directive_ref IS NULL`;
  return { id: task.id, created: task.created };
}

export interface DirectiveRecoveryDeps {
  readCursor(): Promise<number>;
  stageCursor(afterId: number): Promise<void>;
  list(afterId: number, limit: number): Promise<RecoveryDirective[]>;
  routes(rows: RecoveryDirective[]): Promise<Map<number, DirectiveRoute>>;
  register(row: RecoveryDirective): Promise<DirectiveRecoveryRegistration>;
  announce(id: string): Promise<void>;
}

export function directiveRecoveryDeps(workspaceId: string, harness: string): DirectiveRecoveryDeps {
  return {
    async readCursor() {
      const { committed } = await ackAndRead(DIRECTIVE_RECOVERY_ACTOR, SURFACE);
      return typeof committed?.afterId === 'number' ? committed.afterId : 0;
    },
    stageCursor: (afterId) => stage(DIRECTIVE_RECOVERY_ACTOR, SURFACE, { afterId }),
    async list(afterId, limit) {
      const rows = await getOrgPg().sql<{ id: number | string; recorded_by: string }[]>`
        SELECT id, recorded_by FROM harness_shared.owner_directives
         WHERE workspace_id = ${workspaceId} AND dispositioned_at IS NULL AND id > ${afterId}
         ORDER BY id LIMIT ${limit}`;
      return rows.map((row) => ({ id: Number(row.id), recordedBy: row.recorded_by }));
    },
    routes: (rows) => routeOpenDirectives(workspaceId, rows),
    register: (directive) => boundedOrgTxn((tx) => registerDirectiveRecovery(tx as unknown as TransactionSql,
      { workspaceId, harness, directive })),
    async announce(id) {
      const [{ getWorkItem }, { emitWorkItemCreatedEvent }] = await Promise.all([
        import('./work-items'), import('./work-items-events'),
      ]);
      const item = await getWorkItem(id, harness);
      if (item) emitWorkItemCreatedEvent(item);
    },
  };
}

/** One bounded keyset page per tick, using the existing durable read cursor.
 * Stage after processing the page: a crash retries idempotent registrations.
 * Wrapping revisits failures and live/unknown sessions; one broken registration
 * must not starve every directive in a later page.
 */
export async function sweepOwnerDirectiveRecovery(input: {
  workspaceId: string; harness: string; deps?: DirectiveRecoveryDeps;
}): Promise<{ examined: number; created: number; retained: number; errors: string[] }> {
  const deps = input.deps ?? directiveRecoveryDeps(input.workspaceId, input.harness);
  const afterId = await deps.readCursor();
  const rows = await deps.list(afterId, PAGE_SIZE);
  const routes = await deps.routes(rows);
  const result = { examined: rows.length, created: 0, retained: 0, errors: [] as string[] };
  for (const row of rows) {
    if (routes.get(row.id)?.kind !== 'unhandled') continue;
    try {
      const recovery = await deps.register(row);
      if (!recovery) continue; // disposition won the race
      if (recovery.created) result.created++;
      else result.retained++;
      // Re-advertise an unclaimed incumbent too: a crash between its commit
      // and its event must not strand a task while queue workers are asleep.
      await deps.announce(recovery.id);
    } catch (error) {
      result.errors.push(`#${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await deps.stageCursor(rows.length === PAGE_SIZE ? rows[rows.length - 1].id : 0);
  return result;
}

/** Completion guard: only recovery tasks carry this marker. */
export async function directiveRecoveryClosureError(payload: unknown, workspaceId: string): Promise<string | null> {
  const marker = (payload as { ownerDirectiveRecovery?: { directiveId?: unknown } } | null)?.ownerDirectiveRecovery;
  if (!marker) return null;
  if (!Number.isSafeInteger(marker.directiveId) || Number(marker.directiveId) <= 0) {
    return 'Recovery task has invalid directive provenance; repair it before closing.';
  }
  const [row] = await getOrgPg().sql<{ dispositioned_at: unknown }[]>`
    SELECT dispositioned_at FROM harness_shared.owner_directives
     WHERE workspace_id = ${workspaceId} AND id = ${Number(marker.directiveId)}`;
  if (!row) return `Cannot verify directive #${marker.directiveId} in this workspace; recovery stays open.`;
  return row.dispositioned_at == null
    ? `Directive #${marker.directiveId} is still open. Read orders:get, verify fulfillment and record orders:disposition before completing recovery; checkpoint any remaining blocker.`
    : null;
}
