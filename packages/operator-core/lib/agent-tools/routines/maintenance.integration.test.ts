import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { maintenancePgStore } from './maintenance-pg';
import { recoverRoutineMaintenance, runRoutineMaintenance, type MaintenancePlan } from './maintenance';
import { readRoutineSnap } from './routine-snapshot';

const workspaceId = 'ws-routine-maintenance-test';
const actor = 'su-maintenance-test';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const exec = promisify(execFile);
let org: OrgTestDb;
let plan: MaintenancePlan;

beforeAll(async () => { org = await createOrgTestDb(); });
afterAll(async () => { await org?.cleanup(); });
beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.audit_log WHERE workspace_id = ${workspaceId}`;
  await org.adminSql`DELETE FROM harness_shared.routines WHERE workspace_id = ${workspaceId}`;
  for (const [slug, active] of [['papercusp', true], ['calendar', true], ['crm', true], ['papercusp/libs/generic/cache', true], ['deliberately-paused', false]] as const) {
    await org.adminSql`INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, active, payload_template, metadata)
      VALUES (${randomUUID()}, ${workspaceId}, ${slug}, 'git-sync', 'cron', '{}'::jsonb, 'system:git-sync', ${active}, '{}'::jsonb, '{}'::jsonb)`;
  }
  const target = async (installSlug: string) => ({ installSlug, name: 'git-sync' as const,
    before: await readRoutineSnap(org.adminSql, workspaceId, installSlug, 'git-sync') });
  plan = { operationId: randomUUID(), ownerId: actor, workItemId: 'WI-maintenance-test', reason: 'isolated verification',
    canonical: await target('papercusp'), others: [await target('calendar'), await target('crm'), await target('papercusp/libs/generic/cache')],
    deadlineMs: Date.now() + 60_000, phaseTimeoutMs: 10_000, cleanupTimeoutMs: 10_000 };
});
const store = () => maintenancePgStore(org.adminSql, workspaceId, actor);
const snap = (slug: string) => readRoutineSnap(org.adminSql, workspaceId, slug, 'git-sync');

describe('maintenance atomicity and recovery (real private PG)', () => {
  it('commits intent before effects, restores exact snapshots and preserves existing pauses', async () => {
    const port = store();
    await port.prepare(plan);
    expect((await snap('calendar')).active).toBe(true);
    const intent = await org.adminSql`SELECT id FROM harness_shared.audit_log
      WHERE workspace_id = ${workspaceId} AND action = 'gateway-control.routines:maintenance-intent'`;
    expect(intent).toHaveLength(1);
    await port.pause(plan, plan.others[0]!, 0);
    expect((await snap('calendar')).active).toBe(false);
    await expect(port.pause(plan, plan.others[0]!, 0)).rejects.toThrow('already committed');
    const recovered = await recoverRoutineMaintenance(store(), plan.operationId, 10_000);
    expect(recovered).toMatchObject({ ok: true, residue: [] });
    expect(await snap('calendar')).toEqual(plan.others[0]!.before);
    expect((await snap('deliberately-paused')).active).toBe(false);
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
  });
  it('recovers committed effects after losing the apply receipt and original in-memory store', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await port.pause(plan, plan.others[1]!, 1);
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
    expect((await snap('calendar')).active).toBe(true);
    expect((await snap('crm')).active).toBe(true);
  });
  it('rolls the pause back if its mandatory audit cannot commit', async () => {
    const port = store();
    await port.prepare(plan);
    await org.adminSql`CREATE FUNCTION harness_shared.fail_maintenance_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'gateway-control.routines:set' THEN RAISE EXCEPTION 'injected audit unavailable'; END IF; RETURN NEW; END $$`;
    await org.adminSql`CREATE TRIGGER maintenance_audit_failure BEFORE INSERT ON harness_shared.audit_log
      FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_maintenance_audit()`;
    try {
      await expect(port.pause(plan, plan.others[0]!, 0)).rejects.toThrow('injected audit unavailable');
      expect(await snap('calendar')).toEqual(plan.others[0]!.before);
    } finally {
      await org.adminSql`DROP TRIGGER maintenance_audit_failure ON harness_shared.audit_log`;
      await org.adminSql`DROP FUNCTION harness_shared.fail_maintenance_audit()`;
    }
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
  });
  it('preserves newer peer pauses and continues cleaning other rows', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await port.pause(plan, plan.others[1]!, 1);
    await org.adminSql`UPDATE harness_shared.routines SET metadata = jsonb_set(metadata, '{pause,reason}', '"peer hold"'::jsonb)
      WHERE workspace_id = ${workspaceId} AND install_slug = 'crm'`;
    const result = await recoverRoutineMaintenance(store(), plan.operationId, 10_000);
    expect(result).toMatchObject({ ok: false, residue: [{ ownerId: actor, workItemId: plan.workItemId }] });
    expect((await snap('crm')).metadata).toMatchObject({ pause: { reason: 'peer hold' } });
    expect((await snap('crm')).active).toBe(false);
    expect((await snap('calendar')).active).toBe(true);
  });
  it('preserves unrelated health metadata written after the pause', async () => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    await org.adminSql`UPDATE harness_shared.routines SET metadata = metadata || '{"health":{"tick":99}}'::jsonb
      WHERE workspace_id = ${workspaceId} AND install_slug = 'calendar'`;
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
    expect(await snap('calendar')).toMatchObject({ active: true, metadata: { health: { tick: 99 } } });
  });
  it('seals late preparation and delayed applies instead of allowing a post-cleanup pause', async () => {
    expect((await recoverRoutineMaintenance(store(), plan.operationId, 10_000)).ok).toBe(true);
    await expect(store().prepare(plan)).rejects.toThrow('sealed');
    plan.operationId = randomUUID();
    const port = store();
    await port.prepare(plan);
    await port.seal(plan.operationId);
    await expect(port.pause(plan, plan.others[0]!, 0)).rejects.toThrow('sealed');
    expect((await snap('calendar')).active).toBe(true);
  });
  it('requires the complete current cohort and fresh per-row previews', async () => {
    const port = store();
    await expect(port.prepare({ ...plan, others: plan.others.slice(0, 1) })).rejects.toThrow('cohort changed');
    await org.adminSql`UPDATE harness_shared.routines SET metadata = '{"health":"changed"}'::jsonb
      WHERE workspace_id = ${workspaceId} AND install_slug = 'calendar'`;
    await expect(port.prepare(plan)).rejects.toThrow('Stale routine preview');
    expect((await snap('crm')).active).toBe(true);
  });
  it('uses a fresh canonical preview after publication and restores on adoption refusal', async () => {
    let adoptionCalls = 0;
    const result = await runRoutineMaintenance(plan, store(), {
      publication: async () => {
        await org.adminSql`UPDATE harness_shared.routines SET metadata = '{"gitPass":"qualified"}'::jsonb
          WHERE workspace_id = ${workspaceId} AND install_slug = 'papercusp'`;
      },
      adoption: async () => { adoptionCalls++; throw new Error('ordinary restart refused'); },
    });
    expect(result).toMatchObject({ ok: false, cleanup: { ok: true } });
    expect(adoptionCalls).toBe(1);
    expect(await snap('papercusp')).toMatchObject({ active: true, metadata: { gitPass: 'qualified' } });
  });
  it.each(['immediate', 'guardian-interruption'])('cleans up from a separate native process with no operator HTTP server: %s', async mode => {
    const port = store();
    await port.prepare(plan);
    await port.pause(plan, plan.others[0]!, 0);
    const script = resolve(root, 'scripts/routine-maintenance-recover.mts');
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', script, '--check-runtime'], { cwd: root, timeout: 30_000 });
    const runtime = JSON.parse(stdout.trim());
    const dir = await mkdtemp(join(tmpdir(), 'maintenance-recovery-test-'));
    try {
      const manifest = join(dir, 'manifest.json');
      await writeFile(manifest, JSON.stringify({ ...runtime, schemaVersion: 'routine-maintenance-recovery-v1',
        workspaceId, ownerId: actor, operationId: plan.operationId, timeoutMs: 10_000,
        deadlineMs: Date.now() + (mode === 'immediate' ? 0 : 60_000) }));
      const args = ['--import', 'tsx', script, '--manifest', manifest, ...(mode === 'immediate' ? [] : ['--watch'])];
      const env = { ...process.env, PAPERCUSP_MAINTENANCE_DATABASE_URL: org.adminDsn };
      let output: string;
      if (mode === 'immediate') {
        output = (await exec(process.execPath, args, { cwd: root, env, timeout: 45_000, maxBuffer: 128_000 })).stdout;
      } else {
        output = await new Promise<string>((done, fail) => {
          const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '', stderr = '', interrupted = false;
          const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('Guardian did not finish within test bound')); }, 45_000);
          child.stdout.on('data', bytes => {
            stdout += String(bytes);
            if (!interrupted && stdout.split('\n').some(line => { try { return JSON.parse(line).armed === true; } catch { return false; } })) {
              interrupted = true;
              child.kill('SIGTERM');
            }
          });
          child.stderr.on('data', bytes => { stderr += String(bytes); });
          child.on('error', error => { clearTimeout(timer); fail(error); });
          child.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && interrupted) done(stdout);
            else fail(new Error(`Guardian failed (${code}): ${stderr.slice(-3000)}`));
          });
        });
        expect(output).toContain('"armed":true');
      }
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, residue: [] });
      expect((await snap('calendar')).active).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 90_000);
});
