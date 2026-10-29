import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { PsuPtyHost } from '../../events/await/psu-pty-discovery';
import type { GatewayOwnerExecution } from '../../inference-gateway/observability';
import { recoverExpectedLoopExecution } from './loop-execution-recovery';

let pg: DedicatedNativePg, org: OrgTestDb, sql: Sql;
const savedAdmin = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
const ws = 'ws-expected-execution-recovery';
const nowMs = Date.now();
beforeAll(async () => {
  pg = await startDedicatedNativePg();
  process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
  org = await createOrgTestDb(); sql = org.adminSql;
}, 180_000);
afterAll(async () => {
  try { await org?.cleanup(); } finally {
    await pg?.stop();
    if (savedAdmin === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = savedAdmin;
  }
});
afterEach(() => vi.restoreAllMocks());

async function routine(id: string, active = true, parked = true) {
  await sql`INSERT INTO harness_shared.routines
    (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id,
     last_fired_at, next_fire_at, reschedule_interval_sec, target_owner_id)
    VALUES (${id}, 'papercusp', ${id}, 'cron', '{}'::jsonb, 'su', ${active}, ${ws},
      to_timestamp(${nowMs - 60_000} / 1000.0) + interval '0.000123 seconds',
      ${parked ? 'infinity' : new Date(nowMs + 60_000).toISOString()}::timestamptz, 60, ${id})`;
  const host: PsuPtyHost = { ownerId: id, advSessionId: null, pid: 1, ptyPid: 2, sock: '/fixture',
    command: 'codex', startedAt: nowMs - 100_000,
    execution: { ownerId: id, hostPid: 1, childPid: 2, childGeneration: 1, receivedAtMs: nowMs - 60_000,
      phase: 'failed', turnStartedAt: nowMs - 60_000, lastProgressAt: nowMs - 40_000, pendingTools: 0, observedAt: nowMs } };
  return { host, input: { sql, routineId: id, ownerId: id, nowMs },
    deps: { now: () => nowMs, findHost: async () => host, inference: async (): Promise<GatewayOwnerExecution> => ({
      active: 0, observedAt: nowMs, processInstanceId: 'fixture', activeRequests: [], activeRequestsComplete: true,
    }), arm: vi.fn(async () =>
      ({ awaitId: 1, eventKey: 'fixture', handleNote: 'fixture', minSleepSec: 60 })) } };
}

async function state(id: string) {
  return (await sql<Array<{ parked: boolean; active: boolean; metadata: Record<string, any> }>>`
    SELECT next_fire_at = 'infinity'::timestamptz AS parked, active, metadata
      FROM harness_shared.routines WHERE id = ${id}`)[0]!;
}

describe('durable recovery against isolated Postgres', () => {
  it('leaves pre-observer hosts on the maintained reconciliation path without rewriting failure evidence', async () => {
    const f = await routine('recovery-legacy-host');
    delete f.host.execution;
    const prior = { status: 'blocked', reason: 'native-observation-unavailable', probes: 46,
      attempts: 0, nextProbeAt: nowMs + 300_000, observedAt: nowMs - 1_000,
      generation: null, lastAttemptAt: null };
    await sql`UPDATE harness_shared.routines SET metadata = ${sql.json({ executionRecovery: prior })}
      WHERE id = ${f.input.routineId}`;
    const inference = vi.fn(f.deps.inference);
    expect(await recoverExpectedLoopExecution(f.input, { ...f.deps, inference })).toEqual({ handled: false });
    expect(inference).not.toHaveBeenCalled();
    expect(f.deps.arm).not.toHaveBeenCalled();
    expect(await state(f.input.routineId)).toMatchObject({ parked: true, active: true,
      metadata: { executionRecovery: prior } });
  });

  it('keeps a supported host with an unavailable observation unknown instead of using legacy reconciliation', async () => {
    const f = await routine('recovery-supported-observer-unavailable');
    f.host.execution = undefined;
    expect(await recoverExpectedLoopExecution(f.input, f.deps)).toMatchObject({ handled: true, rearmed: false,
      state: { status: 'unknown', reason: 'native-observation-unavailable', attempts: 0 } });
    expect(f.deps.arm).not.toHaveBeenCalled();
    expect((await state(f.input.routineId)).parked).toBe(true);
  });

  it('clears the failure streak only for a fresh host-bound turn that started after the exact fire', async () => {
    const f = await routine('recovery-verified-successor');
    f.host.execution!.phase = 'running';
    f.host.execution!.turnStartedAt = nowMs - 20_000;
    f.host.execution!.receivedAtMs = nowMs - 20_000;
    const resetFireErrors = vi.fn(async () => 1);
    const result = await recoverExpectedLoopExecution(f.input, {
      ...f.deps,
      resetFireErrors,
      inference: async () => ({ ...await f.deps.inference(), active: 1 }),
    });

    expect(result).toMatchObject({ handled: true, state: {
      status: 'running', reason: 'active-inference', verifiedSuccessorFireAt: nowMs - 60_000,
    } });
    expect(resetFireErrors).toHaveBeenCalledWith('papercusp', f.input.routineId, {
      workspaceId: ws,
      expectedLastFiredAt: expect.any(String),
    });
    expect((await state(f.input.routineId)).metadata.executionRecovery).toMatchObject({
      verifiedSuccessorFireAt: nowMs - 60_000,
    });
  });

  it('does not clear the failure streak for active inference without post-fire native-turn proof', async () => {
    const f = await routine('recovery-no-successor-proof');
    const resetFireErrors = vi.fn(async () => 1);
    const result = await recoverExpectedLoopExecution(f.input, {
      ...f.deps,
      resetFireErrors,
      inference: async () => ({ ...await f.deps.inference(), active: 1 }),
    });

    expect(result).toMatchObject({ handled: true, state: { status: 'running', reason: 'active-inference' } });
    expect(result.state?.verifiedSuccessorFireAt).toBeUndefined();
    expect(resetFireErrors).not.toHaveBeenCalled();
  });

  // WI-6554700010012442 — before the fix this returned handled:true on every sweep, so both
  // callers `continue`d and the parked loop was never re-armed by anything.
  it('hands a spent unknown-probe budget to the ordinary actors instead of holding the loop parked', async () => {
    const f = await routine('recovery-spent-budget');
    f.host.execution!.phase = 'unknown';
    const prior = { status: 'unknown', reason: 'native-start-unverified', probes: 2, attempts: 0,
      nextProbeAt: nowMs - 1, observedAt: nowMs - 30_000, generation: '1:1:2', lastAttemptAt: null };
    await sql`UPDATE harness_shared.routines SET metadata = ${sql.json({ executionRecovery: prior })}
      WHERE id = ${f.input.routineId}`;
    expect(await recoverExpectedLoopExecution(f.input, f.deps)).toMatchObject({ handled: false,
      state: { status: 'blocked', probes: 3 } });
    expect(f.deps.arm).not.toHaveBeenCalled();
    expect(await state(f.input.routineId)).toMatchObject({ parked: true, active: true,
      metadata: { executionRecovery: { status: 'blocked', probes: 3, nextProbeAt: nowMs + 300_000 } } });
    // Inside the block's backoff a fresh controller still hands off, and spends no probe.
    expect(await recoverExpectedLoopExecution(f.input, { ...f.deps })).toMatchObject({ handled: false,
      state: { status: 'blocked', probes: 3 } });
    expect((await state(f.input.routineId)).metadata.executionRecovery.probes).toBe(3);
  });

  it('serializes racing reconciler/guard actors and preserves microsecond fire identity', async () => {
    const f = await routine('recovery-race');
    const results = await Promise.all([recoverExpectedLoopExecution(f.input, f.deps), recoverExpectedLoopExecution(f.input, f.deps)]);
    expect(results.filter(r => r.rearmed)).toHaveLength(1);
    expect(f.deps.arm).toHaveBeenCalledTimes(1);
    expect(await state(f.input.routineId)).toMatchObject({ parked: false, active: true,
      metadata: { executionRecovery: { status: 'recovering', attempts: 1, nextProbeAt: nowMs + 30_000 } } });
  });

  it('retains an owned prerequisite failure and paced next probe across controller replacement', async () => {
    const f = await routine('recovery-prerequisite');
    f.deps.arm.mockRejectedValueOnce(new Error('private fixture outage'));
    expect(await recoverExpectedLoopExecution(f.input, f.deps)).toMatchObject({ handled: true, rearmed: false });
    const first = await state(f.input.routineId);
    expect(first).toMatchObject({ parked: true, active: true, metadata: { executionRecovery: {
      status: 'blocked', reason: 'inbox-wake-repair-failed', attempts: 1, nextProbeAt: nowMs + 30_000 } } });
    // A fresh controller reads the stored deadline; it cannot spend another retry early.
    // A transient blocked prerequisite is still HELD (handled), unlike a spent budget.
    expect(await recoverExpectedLoopExecution(f.input, { ...f.deps })).toMatchObject({ handled: true });
    expect(f.deps.arm).toHaveBeenCalledTimes(1);
    f.host.execution!.observedAt = nowMs + 30_000;
    const next = await recoverExpectedLoopExecution({ ...f.input, nowMs: nowMs + 30_000 }, {
      ...f.deps, inference: async () => ({ ...await f.deps.inference(), observedAt: nowMs + 30_000 }) });
    expect(next).toMatchObject({ rearmed: true, state: { attempts: 2, nextProbeAt: nowMs + 90_000 } });
  });

  it.each(['stopped', 'cadence', 'inference', 'tool', 'owner', 'approval', 'unknown'])('sends no wake for %s', async control => {
    const f = await routine(`recovery-protected-${control}`, control !== 'stopped', control !== 'cadence');
    if (control === 'tool' || control === 'approval') f.host.execution!.pendingTools = 1;
    if (control === 'owner') f.host.execution!.ownerInputPending = true;
    if (control === 'unknown') f.host.execution = undefined;
    const result = await recoverExpectedLoopExecution(f.input, { ...f.deps,
      inference: async () => ({ ...await f.deps.inference(), active: control === 'inference' ? 1 : 0 }) });
    expect(result.rearmed).not.toBe(true);
    expect(f.deps.arm).not.toHaveBeenCalled();
    const row = await state(f.input.routineId);
    expect(row.parked).toBe(control !== 'cadence');
    expect(row.active).toBe(control !== 'stopped');
    if (control === 'unknown') expect(row.metadata.executionRecovery.status).toBe('unknown');
  });

  it('rejects a host generation change after repairing the await', async () => {
    const f = await routine('recovery-generation-race');
    f.deps.arm.mockImplementationOnce(async () => {
      f.host.execution = { ...f.host.execution!, childGeneration: 2, phase: 'running' };
      return { awaitId: 1, eventKey: 'fixture', handleNote: 'fixture', minSleepSec: 60 };
    });
    expect(await recoverExpectedLoopExecution(f.input, f.deps)).toMatchObject({ handled: true });
    expect((await state(f.input.routineId)).parked).toBe(true);
  });
});
