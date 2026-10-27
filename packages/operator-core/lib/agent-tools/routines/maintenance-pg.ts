import type { Sql } from 'postgres';
import { runControlMutation, type ControlAuditRecord } from '../../gateway-control/control-harness';
import { revertRoutineAudit } from './revert';
import { readRoutineSnap, writeRoutineSnap, routineSnapEqual, stableJson } from './routine-snapshot';
import { validateMaintenancePlan, type MaintenancePlan, type MaintenanceStore, type MaintenanceTarget } from './maintenance';

const rootId = (id: string) => `routine-maintenance:${id}`;
const subject = (t: MaintenanceTarget) => `${t.installSlug}/${t.name}`;
const targetKey = (t: { installSlug: string; name: string }) => JSON.stringify([t.installSlug, t.name]);
const equal = (a: unknown, b: unknown) => JSON.stringify(stableJson(a)) === JSON.stringify(stableJson(b));

/** Extends the existing audit store. Intents commit before any effect; each
 * effect and its routines:set audit commit in ONE row-locked transaction.
 * Recovery seals the same operation lock before enumerating committed effects,
 * including effects whose response was lost. No operator HTTP is involved. */
export function maintenancePgStore(sql: Sql, workspaceId: string, actor: string, queryTimeoutMs = 5_000): MaintenanceStore {
  if (!workspaceId || !actor || !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs <= 0)
    throw new Error('Maintenance database binding requires workspace, actor and a finite query timeout');
  async function transaction<T>(id: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return await sql.begin(async raw => {
      const tx = raw as unknown as Sql;
      await tx`SELECT set_config('statement_timeout', ${String(queryTimeoutMs)}, true),
                      set_config('lock_timeout', ${String(queryTimeoutMs)}, true),
                      set_config('idle_in_transaction_session_timeout', ${String(queryTimeoutMs)}, true),
                      set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${rootId(id)}))`;
      return fn(tx);
    }) as T;
  }
  async function audit(tx: Sql, id: string, action: string, target: string, details: unknown) {
    await tx`INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${id}, ${Date.now()}, ${actor}, ${action}, ${target}, ${JSON.stringify(details)}::text::jsonb, ${workspaceId})`;
  }
  async function planAt(tx: Sql, id: string): Promise<MaintenancePlan | undefined> {
    const rows = await tx<{ actor: string; details: { plan: MaintenancePlan } }[]>`
      SELECT actor, details FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId} AND id = ${rootId(id)}`;
    if (!rows[0]) return undefined;
    if (rows[0].actor !== actor) throw new Error('Maintenance operation belongs to another actor');
    return rows[0].details.plan;
  }
  async function isSealed(tx: Sql, id: string) {
    const rows = await tx`SELECT id FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId} AND id = ${rootId(id) + ':sealed'}`;
    return rows.length > 0;
  }
  async function assertCohort(tx: Sql, expected: MaintenanceTarget[]) {
    const rows = await tx<{ install_slug: string; name: string }[]>`
      SELECT install_slug, name FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND name = 'git-sync' AND active = true ORDER BY install_slug, name`;
    const actual = rows.map(row => targetKey({ installSlug: row.install_slug, name: row.name })).sort();
    if (!equal(actual, expected.map(targetKey).sort())) throw new Error('Active Git cohort changed; fresh previews required');
  }
  const strictWriter = (tx: Sql, id: string, extra = {}) => async (rec: ControlAuditRecord) => {
    await audit(tx, id, `gateway-control.${rec.action}`, rec.subject, {
      prev: rec.prev, next: rec.next, verify: rec.verify,
      ...(rec.revertOf ? { revert_of: rec.revertOf } : {}), ...extra,
    });
    return id;
  };
  return {
    prepare: plan => transaction(plan.operationId, async tx => {
      validateMaintenancePlan(plan);
      if (plan.ownerId !== actor) throw new Error('Maintenance owner differs from database actor');
      if (await isSealed(tx, plan.operationId)) throw new Error('Maintenance operation is sealed');
      // An operation id is never a retry token for starting another window.
      if (await planAt(tx, plan.operationId)) throw new Error('Maintenance operation already prepared; recover it instead');
      await assertCohort(tx, [...plan.others, plan.canonical]);
      for (const target of [...plan.others, plan.canonical]) {
        if (!routineSnapEqual(await readRoutineSnap(tx, workspaceId, target.installSlug, target.name), target.before))
          throw new Error(`Stale routine preview: ${subject(target)}`);
      }
      await audit(tx, rootId(plan.operationId), 'gateway-control.routines:maintenance-intent', plan.operationId, { plan });
    }),
    pause: (plan, target, index) => transaction(plan.operationId, async tx => {
      const stored = await planAt(tx, plan.operationId);
      if (!stored || !equal(stored, plan) || await isSealed(tx, plan.operationId)) throw new Error('Maintenance intent missing, changed or sealed');
      if (Date.now() >= stored.deadlineMs - stored.cleanupTimeoutMs) throw new Error('Maintenance work deadline reached');
      let expected = stored.others[index];
      if (index === stored.others.length) {
        const preview = await tx<{ details: { target: MaintenanceTarget } }[]>`SELECT details FROM harness_shared.audit_log
          WHERE workspace_id = ${workspaceId} AND id = ${rootId(plan.operationId) + ':canonical-preview'}`;
        expected = preview[0]?.details.target;
      }
      if (!expected || !equal(expected, target)) throw new Error('Target is outside the reviewed operation');
      const id = rootId(plan.operationId) + ':pause:' + index;
      const exists = await tx`SELECT id FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId} AND id = ${id}`;
      if (exists.length) throw new Error('Pause outcome already committed; recover instead of replaying');
      const locked = await tx`SELECT id FROM harness_shared.routines WHERE workspace_id = ${workspaceId}
        AND install_slug = ${target.installSlug} AND name = ${target.name} FOR UPDATE`;
      if (locked.length !== 1) throw new Error('Maintenance target missing');
      const read = () => readRoutineSnap(tx, workspaceId, target.installSlug, target.name);
      const before = await read();
      if (!routineSnapEqual(before, target.before)) throw new Error(`Stale routine preview: ${subject(target)}`);
      if (Date.now() >= stored.deadlineMs - stored.cleanupTimeoutMs) throw new Error('Maintenance work deadline reached');
      const next = { ...before, active: false, metadata: { ...before.metadata, pause: {
        reason: plan.reason, pausedBy: actor, pausedAtMs: Date.now(), maintenanceOperationId: plan.operationId,
      } } };
      const outcome = await runControlMutation({
        action: 'routines:set', subject: subject(target), actor, capturePrev: read,
        apply: async () => { await writeRoutineSnap(tx, workspaceId, target.installSlug, target.name, next); return next; },
        revertTo: snap => writeRoutineSnap(tx, workspaceId, target.installSlug, target.name, snap),
        verify: async snap => ({ ok: routineSnapEqual(await read(), snap) }),
      }, {}, { writeAudit: strictWriter(tx, id, { maintenanceOperationId: plan.operationId, index }) });
      if (!outcome.applied || outcome.verify?.ok !== true || outcome.auditId !== id) throw new Error('Pause did not verify');
    }),
    previewCanonical: plan => transaction(plan.operationId, async tx => {
      const stored = await planAt(tx, plan.operationId);
      if (!stored || !equal(stored, plan) || await isSealed(tx, plan.operationId)) throw new Error('Unknown/changed/sealed operation');
      const target = { ...stored.canonical, before: await readRoutineSnap(tx, workspaceId, stored.canonical.installSlug, stored.canonical.name) };
      if (!target.before.active || target.before.groupSlug === 'release') throw new Error('Canonical schedule no longer eligible');
      await audit(tx, rootId(plan.operationId) + ':canonical-preview', 'gateway-control.routines:maintenance-preview', subject(target), { target });
      return target;
    }),
    assertCohort: (plan, canonicalActive) => transaction(plan.operationId, async tx => {
      if (await isSealed(tx, plan.operationId)) throw new Error('Maintenance operation sealed');
      await assertCohort(tx, canonicalActive ? [plan.canonical] : []);
    }),
    seal: id => transaction(id, async tx => {
      const plan = await planAt(tx, id);
      if (!(await isSealed(tx, id)))
        await audit(tx, rootId(id) + ':sealed', 'gateway-control.routines:maintenance-sealed', id, { maintenanceOperationId: id });
      return plan;
    }),
    applied: id => transaction(id, async tx => {
      if (!(await isSealed(tx, id))) throw new Error('Must seal before recovering ambiguous effects');
      const rows = await tx<{ id: string; details: { index: number } }[]>`
        SELECT id, details FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId}
          AND actor = ${actor} AND action = 'gateway-control.routines:set'
          AND details->>'maintenanceOperationId' = ${id}`;
      return rows.map(row => ({ auditId: row.id, index: row.details.index }));
    }),
    restore: async auditId => {
      // Source id is generated here, never accepted as an arbitrary audit route.
      const match = /^routine-maintenance:([0-9a-f-]{36}):pause:(\d+)$/i.exec(auditId);
      if (!match) throw new Error('Invalid maintenance source audit');
      await transaction(match[1]!, async tx => {
        const plan = await planAt(tx, match[1]!);
        if (!plan || !(await isSealed(tx, plan.operationId))) throw new Error('Unsealed/unknown maintenance restore');
        const target = [...plan.others, plan.canonical][Number(match[2])];
        if (!target) throw new Error('Audit index is outside the intended cohort');
        await tx`SELECT id FROM harness_shared.routines WHERE workspace_id = ${workspaceId}
          AND install_slug = ${target.installSlug} AND name = ${target.name} FOR UPDATE`;
        const restoredId = auditId + ':restored';
        const prior = await tx`SELECT id FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId} AND id = ${restoredId}`;
        // Recheck through the audited revert even on recovery retry: a stored
        // receipt alone cannot attest that a peer has not since changed state.
        const receipt = await revertRoutineAudit({ auditId }, {
          sql: tx, workspaceId, actor,
          writeAudit: prior.length ? async () => restoredId : strictWriter(tx, restoredId),
        });
        if (!receipt.applied || receipt.reverted || receipt.verify?.ok !== true) throw new Error('Restore did not verify');
      });
    },
  };
}
