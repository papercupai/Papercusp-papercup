// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listDueCronRoutines } from '@papercusp/db-org';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { claimDueRoutine } from '@papercusp/operator-core/lib/harness/routines/claim';
import { recoverExpectedLoopExecution } from '@papercusp/operator-core/lib/harness/routines/loop-execution-recovery';
import { executeWake, type ExecuteWakeDeps } from '@papercusp/operator-core/lib/events/await/wake-executor';
import type { DeliveryWork } from '@papercusp/operator-core/lib/events/await/types';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { hostThroughPty, metaPathFor, socketPathFor, nativeLatestExecution, eventLogPathForOwner } from '../scripts/psu-pty-host.mjs';
import { injectIntoHostWithConfirmation, type PsuPtyHost } from '@papercusp/operator-core/lib/events/await/psu-pty-discovery';
import {
  fallbackObservationCounters, flushFallbackObservations, observeFallback,
} from '@papercusp/operator-core/lib/degradation/fallback-observations';

const privateDatabase = vi.hoisted(() => ({ sql: undefined as OrgTestDb['adminSql'] | undefined }));
// The composed wake imports producers whose telemetry flushes asynchronously.
// Route their implicit accessor too, not just the explicit routine SQL handle.
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => {
    if (!privateDatabase.sql) throw new Error('private recovery database is not initialized');
    return { sql: privateDatabase.sql };
  },
}));

let org: OrgTestDb;
beforeAll(async () => {
  org = await createOrgTestDb();
  privateDatabase.sql = org.adminSql;
}, 180_000);
afterEach(async () => {
  expect((await flushFallbackObservations()).failed, 'implicit telemetry must remain on the private database').toBe(0);
  expect(fallbackObservationCounters().failed).toBe(0);
});
afterAll(async () => {
  await flushFallbackObservations();
  await org?.cleanup();
  privateDatabase.sql = undefined;
});

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let ownerCounter = 0;
async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await delay(20);
  expect(check()).toBe(true);
}

/** Real PTY and socket, sanitized native event shapes, no model or live DB. */
async function fixture(agent: string, autoStart: boolean, failInitially: boolean | 'capacity' = false) {
  const root = mkdtempSync(join(tmpdir(), 'loop-native-recovery-'));
  const config = join(root, '.papercusp', `session-${agent}`);
  const nativeDir = agent === 'omp' ? join(config, 'agent', 'sessions')
    : join(config, agent === 'claude' ? 'projects' : 'sessions');
  const nativeId = agent === 'codex' ? '12345678-1234-4234-8234-123456789abc' : undefined;
  const transcript = join(nativeDir, nativeId ? `rollout-${nativeId}.jsonl` : 'fixture.jsonl');
  mkdirSync(nativeDir, { recursive: true });
  if (agent === 'codex') writeFileSync(join(config, 'config.toml'), '');
  const ownerId = `rx-${process.pid}-${agent[0]}-${++ownerCounter}`;
  const sock = socketPathFor(ownerId);
  const normalizedLogPath = join(root, 'headless.log');
  expect(Buffer.byteLength(sock), 'fixture Unix socket path must fit the platform bound').toBeLessThan(104);
  let output = '';
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, resume() {}, pause() {} });
  const stdout = { isTTY: false, columns: 120, rows: 30, write(chunk: string) { output += chunk; return true; } };
  const code = `
    const fs = require('node:fs');
    const agent = ${JSON.stringify(agent)}, path = ${JSON.stringify(transcript)};
    let line = '', count = 0, pending = false;
    function append(row) { fs.appendFileSync(path, JSON.stringify({...row, id:'fixture-'+count, uuid:'fixture-'+count,
      timestamp: new Date().toISOString()})+'\\n'); }
    function start() {
      if (!pending) return; pending = false;
      if (${Boolean(failInitially)} && count === 1) {
        append(agent === 'codex' ? {type:'event_msg',payload: ${failInitially === 'capacity'
          ? JSON.stringify({type:'task_complete',turn_id:'capacity-turn',error:{codex_error_info:'server_overloaded',message:'Selected model is at capacity.'}})
          : "{type:'turn_aborted'}"}} :
          agent === 'claude' ? {type:'system',subtype:'api_error'} :
          {type:'message',message:{role:'assistant',stopReason:'aborted',content:[]}});
        process.stdout.write('NATIVE_FAILED\\n'); return;
      }
      append(agent === 'codex' ? {type:'event_msg',payload:{type:'task_started'}} :
        agent === 'claude' ? {type:'assistant',message:{role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:'working'}]}} :
        {type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'working'}]}});
      process.stdout.write('NATIVE_STARTED\\n');
    }
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { for (const c of data) {
      if (c === '\\x04') { process.exit(0); return; }
      if (c === '\\x12') { start(); continue; }
      if (c === '\\r') {
        if (!line) continue;
        append(agent === 'codex' ? {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:line}]}} :
          agent === 'claude' ? {type:'user',message:{role:'user',content:line}} :
          {type:'message',message:{role:'user',content:[{type:'text',text:line}]}});
        pending = true; line = ''; process.stdout.write('SUBMIT:'+(++count)+'\\n');
        if (${autoStart}) setTimeout(start, 40);
      } else line += c;
    }});
    process.stdout.write('READY\\n');
    setTimeout(()=>process.exit(0),${failInitially ? 90000 : 15000});
  `;
  const env = hermeticEnv({ PAPERCUSP_SID: ownerId, PAPERCUSP_AGENT: agent,
    ...(agent === 'codex' ? { CODEX_HOME: config } : agent === 'claude' ? { CLAUDE_CONFIG_DIR: config } : { PI_CONFIG_DIR: config }),
    PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS: '10', PAPERCUSP_PSU_PTY_BUSY_CAP_MS: '100',
    PAPERCUSP_PSU_PTY_NATIVE_START_TIMEOUT_MS: '250',
    PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS: '10', PAPERCUSP_PSU_PTY_SUBMIT_CR_MS: '10',
  });
  // Fail before spawning a child when the real adapter cannot read this root.
  const settled = agent === 'codex' ? { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fixture' } }
    : agent === 'claude' ? { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } }
      : { type: 'message', message: { role: 'assistant', stopReason: 'stop' } };
  writeFileSync(transcript, JSON.stringify({ ...settled, id: 'fixture-complete', uuid: 'fixture-complete',
    timestamp: new Date().toISOString() }) + '\n');
  expect(nativeLatestExecution({ agent, env, nativeSessionId: nativeId }).phase,
    `${agent} fixture exact native binding preflight`).toBe('settled');
  const done = hostThroughPty({ command: process.execPath, args: ['-e', code], cwd: root,
    ownerId, env, io: { stdin, stdout }, bridgeTty: false, activityPersistMs: 25, normalizedLogPath,
    resolveRespawnNativeId: nativeId ? () => nativeId : null, onExit: () => {} });
  await until(() => output.includes('READY') && existsSync(metaPathFor(ownerId)) && existsSync(sock));
  const meta = JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
  expect(meta.execution, `${agent} metadata must carry native observation`).toBeDefined();
  const message = { mode: 'turn' as const, ownerId, deliveryId: `native-${agent}`, requireNativeTurnStart: true,
    expectedChildGeneration: meta.execution.childGeneration, expectedHostStartedAt: meta.startedAt,
    data: '⟦turn-origin:loop-fire nonce:1234567890abcdef⟧\nContinue approved recovery.' };
  const readHost = (): PsuPtyHost => JSON.parse(readFileSync(metaPathFor(ownerId), 'utf8'));
  return { message, sock, readHost, normalizedLogPath,
    events: () => readFileSync(eventLogPathForOwner(ownerId), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    output: () => output, async close() {
    await injectIntoHostWithConfirmation(sock, { mode: 'raw', ownerId, data: '\x04' }).catch(() => null);
    await done;
    expect(existsSync(metaPathFor(ownerId))).toBe(false);
    expect(existsSync(sock)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  } };
}

describe('cross-client native recovery handshake', () => {
  it('surfaces a post-start capacity failure once and recovers the same non-loop native session', async () => {
    const f = await fixture('codex', true, 'capacity');
    try {
      const original = f.readHost();
      const first = { ...f.message, deliveryId: 'capacity-first', requireNativeTurnStart: false,
        data: '⟦turn-origin:coord-wake nonce:1234567890abcdef⟧\nReview the approved plan.' };
      expect(first.data, 'the fixture must provide native-verifiable wake provenance').toMatch(/^⟦turn-origin:coord-wake nonce:[a-f0-9]{16}⟧\n/);
      expect(await injectIntoHostWithConfirmation(f.sock, first)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => f.readHost().execution?.phase === 'failed' && f.output().includes('[psu] native-turn-failed'));
      expect(f.readHost().execution).toMatchObject({ pendingTools: 0,
        failure: { code: 'server_overloaded', retryable: true, retryAfterMs: 60_000 } });
      await delay(150); // Multiple existing activity ticks must not repeat the edge.
      const events = f.events().filter(row => row.kind === 'native-turn-failed');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ nativeSessionId: original.nativeSessionId,
        childGeneration: original.execution!.childGeneration,
        failure: { code: 'server_overloaded', retryable: true } });
      expect(f.output().match(/\[psu\] native-turn-failed/g)).toHaveLength(1);
      expect(readFileSync(f.normalizedLogPath, 'utf8')).toContain('native-turn-failed agent=codex code=server_overloaded');
      // This explicit bounded wake exercises the same host/socket. There is no
      // routine, automatic retry, new child, model substitution, or new session.
      const retry = { ...f.message, deliveryId: 'capacity-recovery',
        data: '⟦turn-origin:coord-wake nonce:fedcba0987654321⟧\nContinue the same approved review.' };
      expect(retry.data, 'the recovery fixture must satisfy native-start preflight').toMatch(/^⟦turn-origin:coord-wake nonce:[a-f0-9]{16}⟧\n/);
      expect(await injectIntoHostWithConfirmation(f.sock, retry)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => f.output().includes('NATIVE_STARTED'));
      await until(() => f.readHost().execution?.phase === 'running');
      let confirmed = false;
      for (let n = 0; n < 20 && !confirmed; n++) {
        confirmed = (await injectIntoHostWithConfirmation(f.sock, retry)).reason === 'duplicate-delivery-id';
        if (!confirmed) await delay(30);
      }
      expect(confirmed).toBe(true);
      expect(f.output().match(/SUBMIT:/g)).toHaveLength(2);
      expect(f.readHost()).toMatchObject({ pid: original.pid, ptyPid: original.ptyPid,
        nativeSessionId: original.nativeSessionId, execution: { childGeneration: original.execution!.childGeneration } });
      expect(f.readHost().execution).not.toHaveProperty('failure');
      const terminalEvents = f.events().filter(row => row.kind === 'native-turn-failed');
      expect(terminalEvents, JSON.stringify({ terminalEvents, execution: f.readHost().execution,
        output: f.output() })).toHaveLength(1);
    } finally { await f.close(); }
  }, 25_000);

  it('persists implicit fallback telemetry through the real timer into the private database', async () => {
    const mechanism = `native-recovery-isolation-${process.pid}`;
    expect(observeFallback(mechanism, { eligible: 1, applied: 1, reason: 'applied' })).toBe(true);
    let rows: Array<{ database: string; samples: number }> = [];
    const deadline = Date.now() + 10_000;
    // Do not explicitly flush or pass SQL: exercise the same delayed default
    // accessor that previously attempted to open the protected live admin pool.
    while (rows.length === 0 && Date.now() < deadline) {
      await delay(25);
      rows = await org.adminSql`SELECT current_database() AS database, samples
        FROM harness_shared.fallback_observations WHERE mechanism = ${mechanism}`;
    }
    expect(rows).toEqual([{ database: org.dbName, samples: 1 }]);
    expect(fallbackObservationCounters().failed).toBe(0);
  }, 15_000);

  it.each(['codex', 'claude', 'omp'])('requires a native %s turn and deduplicates repeated delivery', async agent => {
    const f = await fixture(agent, true);
    try {
      expect(await injectIntoHostWithConfirmation(f.sock, f.message)).toMatchObject({ ok: true, reason: 'accepted' });
      await until(() => f.output().includes('NATIVE_STARTED'));
      let confirmed = false;
      for (let n = 0; n < 20 && !confirmed; n++) {
        const result = await injectIntoHostWithConfirmation(f.sock, f.message);
        confirmed = result.reason === 'duplicate-delivery-id';
        if (!confirmed) await delay(30);
      }
      expect(confirmed).toBe(true);
      expect(f.output().match(/SUBMIT:/g)).toHaveLength(1);
    } finally { await f.close(); }
  }, 25_000);

  it.each(['codex', 'claude', 'omp'])('keeps a %s prompt without model activity pending across retries', async agent => {
    const f = await fixture(agent, false);
    try {
      await injectIntoHostWithConfirmation(f.sock, f.message);
      await until(() => f.output().includes('SUBMIT:1'));
      await delay(350);
      expect(await injectIntoHostWithConfirmation(f.sock, f.message)).toMatchObject({ reason: 'pending-delivery-id' });
      expect(f.output()).not.toContain('SUBMIT:2');
      await injectIntoHostWithConfirmation(f.sock, { mode: 'raw', ownerId: f.message.ownerId, data: '\x12' });
      await until(() => f.output().includes('NATIVE_STARTED'));
      expect(await injectIntoHostWithConfirmation(f.sock, f.message)).toMatchObject({ reason: 'duplicate-delivery-id' });
      expect(f.output().match(/SUBMIT:/g)).toHaveLength(1);
    } finally { await f.close(); }
  }, 25_000);

  it('refuses an older child generation without writing a prompt', async () => {
    const f = await fixture('codex', true);
    try {
      await injectIntoHostWithConfirmation(f.sock, { ...f.message, expectedChildGeneration: 99 });
      await delay(300);
      expect(f.output()).not.toContain('SUBMIT:');
    } finally { await f.close(); }
  }, 25_000);
});

describe('failed native turn → durable routine retry → native wake', () => {
  it.each([
    ['codex', true], ['claude', true], ['omp', true], ['codex', 'capacity'],
  ] as const)('recovers one %s turn (%s) through the real claim and AUTO wake paths', async (agent, failureKind) => {
    const f = await fixture(agent, true, failureKind);
    const sql = org.adminSql;
    const owner = f.message.ownerId;
    const routineId = `routine-${owner}`;
    const workspaceId = 'ws-composed-native-recovery';
    try {
      const original = f.readHost();
      const fireAt = Date.now();
      await sql`INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id,
         last_fired_at, next_fire_at, reschedule_interval_sec, target_owner_id)
        VALUES (${routineId}, 'papercusp', ${routineId}, 'cron', '{}'::jsonb, 'su', TRUE, ${workspaceId},
          ${new Date(fireAt).toISOString()}::timestamptz, 'infinity'::timestamptz, 60, ${owner})`;
      await injectIntoHostWithConfirmation(f.sock, { ...f.message, deliveryId: `failed-${owner}`,
        requireNativeTurnStart: false });
      // Native failure can arrive before the host finishes the ordered submit
      // keystrokes. Wait for that commit clock as well as the transcript row.
      await until(() => {
        const execution = f.readHost().execution;
        return f.output().includes('NATIVE_FAILED') && execution?.phase === 'failed'
          && Number(execution.receivedAtMs) >= fireAt;
      });
      const failure = f.readHost().execution!;
      expect(failure.receivedAtMs, 'failure observation must belong to this actual fire').toBeGreaterThanOrEqual(fireAt);
      const failedAt = failure.lastProgressAt!;
      if (failureKind === 'capacity') {
        expect(failure.failure).toMatchObject({ code: 'server_overloaded',
          retryable: true, retryAfterMs: 60_000 });
      }
      // Exercise the real failed-turn grace and retry deadline, with no clock override.
      await until(() => Date.now() - failedAt >= 30_000, 35_000);
      const arm = vi.fn(async () => ({ awaitId: 1, eventKey: 'fixture-inbox', handleNote: 'fixture', minSleepSec: 60 }));
      const recovery = await recoverExpectedLoopExecution({ sql, routineId, ownerId: owner, nowMs: Date.now() }, {
        findHost: async () => f.readHost(), arm,
        inference: async () => ({ active: 0, observedAt: Date.now(), processInstanceId: 'fixture',
          activeRequests: [], activeRequestsComplete: true }),
      });
      expect(recovery, JSON.stringify({ recovery, host: f.readHost().execution })).toMatchObject({
        handled: true, rearmed: true, state: { status: 'recovering', attempts: 1 } });
      expect(arm).toHaveBeenCalledTimes(1);
      const stored = (await sql<Array<{ next_ms: string; metadata: any }>>`
        SELECT (extract(epoch FROM next_fire_at) * 1000)::bigint::text AS next_ms, metadata
        FROM harness_shared.routines WHERE id = ${routineId}`)[0]!;
      expect(Number(stored.next_ms)).toBe(recovery.state!.nextProbeAt);
      expect(stored.metadata.executionRecovery).toMatchObject({ status: 'recovering', attempts: 1 });
      if (failureKind === 'capacity') expect(Number(stored.next_ms)).toBeGreaterThanOrEqual(failedAt + 60_000);
      expect((await listDueCronRoutines(sql)).some(row => row.id === routineId)).toBe(false);
      await until(() => Date.now() >= recovery.state!.nextProbeAt, 35_000);
      const due = (await listDueCronRoutines(sql)).find(row => row.id === routineId)!;
      expect(due).toBeDefined();
      expect(await claimDueRoutine(sql, due)).toBe(true);
      expect(await claimDueRoutine(sql, due)).toBe(false);

      const at = new Date().toISOString();
      const delivery: DeliveryWork = { id: 900 + ownerCounter, workspaceId, awaitId: 1, subscriberId: owner,
        eventKey: `fixture:recovery:${owner}`, payload: null, summary: 'Continue approved recovery',
        status: 'delivering', channel: null, attempts: 1, lastError: null, nextAttemptAt: at, createdAt: at,
        deliveredAt: null, urgent: false, minSleepSec: null, coalescedCount: 1, source: null,
        wakeHandle: null, note: null, turnProof: null, turnStartedAt: null, pickupDeadlineAt: null };
      const wakeDeps: ExecuteWakeDeps = {
        findPsuHost: async () => f.readHost(), injectPsuHostWithConfirmation: injectIntoHostWithConfirmation,
        resolveWakeModeFn: async () => 'auto', stageManualWakeFn: async () => undefined,
        getLatestSessionForOwner: async () => null, coldAutoEnabled: async () => false,
        presence: async () => null,
      };
      expect(await executeWake(delivery, wakeDeps)).toMatchObject({ kind: 'park', hostCommitPending: true });
      await until(() => f.output().includes('NATIVE_STARTED'));
      let delivered = false;
      for (let n = 0; n < 20 && !delivered; n++) {
        const outcome = await executeWake(delivery, wakeDeps);
        delivered = outcome.kind === 'delivered';
        if (!delivered) await delay(30);
      }
      expect(delivered).toBe(true);
      expect(f.output().match(/SUBMIT:/g)).toHaveLength(2);
      expect(f.readHost()).toMatchObject({ pid: original.pid, ptyPid: original.ptyPid,
        nativeSessionId: original.nativeSessionId,
        execution: { childGeneration: original.execution!.childGeneration } });
    } finally { await f.close(); }
  }, 85_000);
});
