/** D-021's final current-build matrix. Run only after the launcher source wall. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { executeOperationalRun } from '../agent-tools/testing/record-run';
import { ompAgentHomeForSessionKey } from '../session-transcript-resolvers';
import { pgSessionArchiveStore } from '../session-archive';
import { findCanonicalClaudeLiveJsonl, findCanonicalNativeLiveJsonl, readCanonicalClaudeArchive,
  readCanonicalNativeArchive, readStableLiveJsonl } from './source';
import { adaptNativeSessionJsonl } from './native-adapter';
import { SESSION_PORT_SUPPORTED_PAIRS, type SessionBackend } from './types';

const root = resolve(import.meta.dirname, '../../../..');
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const enabled = Boolean(profilePath && process.env.PAPERCUSP_CBP_FINAL_MATRIX === '1');
const workspace = 'papercusp-workspace';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Session = { id: string; agent: SessionBackend; coord_owner_id: string;
  session_id: string | null; omp_thread_id: string | null; ended_at: string | null };
const MATRIX_SOURCE_PATHS = [
  'apps/operator/scripts/psu-launcher.mjs',
  'apps/operator/scripts/psu-pty-host.mjs',
] as const;
type MatrixSourceLock = { lockId: string; domain: string };
type HeldMatrixSourceLocks = { sourceRoot: string; origin: string; locks: MatrixSourceLock[] };

function verifiedEmptyCleanup(name: string, args: Record<string, unknown>, status: number | null,
  value: Record<string, any> | undefined) {
  return name === 'processes:kill' && args.reapTerminalResidue === true && status === 5 &&
    emptyOwnedScope(String(args.taskId), value);
}

function emptyOwnedScope(taskId: string, value: Record<string, any> | undefined) {
  const row = value?.results?.[0];
  return value?.results?.length === 1 && row.taskId === taskId && row.error === 'not_live' &&
    typeof row.detail === 'string' && row.detail.includes('holds no live process right now; nothing to reap');
}

function call(name: string, args: Record<string, unknown>, origin: string, idempotencyKey?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' };
  delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = spawnSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
    ...(idempotencyKey ? ['--idempotency-key', idempotencyKey] : []),
    'tools:invoke', `--url=${origin}`, '--json', '-'], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ name, args: { ...args, payloadTier: 'full' } }),
  });
  let value: Record<string, any> | undefined;
  try { value = JSON.parse(result.stdout); } catch { /* Report the original CLI failure below. */ }
  if (!verifiedEmptyCleanup(name, args, result.status, value) &&
    (result.status !== 0 || !value || value.ok === false)) {
    // stderr starts with connection traces. The actual tool refusal is normally
    // in stdout; retain that receipt before throwing into the operational recorder.
    const diagnostic = { name, status: result.status, signal: result.signal,
      error: result.error?.message, receipt: value ?? result.stdout, stderr: result.stderr };
    console.error('CBP_FINAL_MCP_FAILURE', JSON.stringify(diagnostic));
    throw new Error(`MCP ${name} failed: ${JSON.stringify(value ?? result.stdout)}\n` +
      `exit=${result.status} signal=${result.signal} error=${result.error?.message ?? 'none'}\n` +
      result.stderr.slice(-1000));
  }
  if (!value) throw new Error(`MCP ${name} returned no readable receipt`);
  return value;
}

describe('owned matrix cleanup receipt', () => {
  const args = { taskId: 'owned-task', reapTerminalResidue: true };
  const receipt = { ok: false, results: [{ taskId: 'owned-task', error: 'not_live',
    detail: 'state is exited — reap requested but scope owned.service holds no live process right now; nothing to reap' }] };
  it('accepts only a positively verified empty owned scope', () => {
    expect(verifiedEmptyCleanup('processes:kill', args, 5, receipt)).toBe(true);
  });
  it('does not infer cleanup from a terminal ledger row alone', () => {
    expect(verifiedEmptyCleanup('processes:kill', args, 5, { ok: false,
      results: [{ taskId: 'owned-task', error: 'not_live', detail: 'state is exited' }] })).toBe(false);
  });
  it('rejects unknown outcomes and receipts for another task', () => {
    expect(verifiedEmptyCleanup('processes:kill', args, null, receipt)).toBe(false);
    expect(verifiedEmptyCleanup('processes:kill', { ...args, taskId: 'another-task' }, 5, receipt)).toBe(false);
    expect(verifiedEmptyCleanup('processes:kill', { taskId: 'owned-task' }, 5, receipt)).toBe(false);
  });
});

function rows(sql: string, origin: string) {
  return call('dev:pg_query', { sql, maxRows: 10, timeoutMs: 15_000,
    allowUnscoped: false, allowUnboundedJsonSearch: false }, origin).rows as Array<Record<string, any>>;
}

function matrixParentTaskId(env: NodeJS.ProcessEnv = process.env) {
  const id = env.PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID;
  if (!id || !/^[0-9a-z]{4,64}$/.test(id)) {
    throw new Error('The final matrix requires a durable parent task before launching API fixtures');
  }
  return id;
}

function matrixParentWorkItemId(parentTaskId: string, tasks: unknown) {
  const matches = Array.isArray(tasks)
    ? tasks.filter(task => task?.taskId === parentTaskId && task?.state === 'running')
    : [];
  const workItemId = matches[0]?.workItemId;
  if (matches.length !== 1 || typeof workItemId !== 'string' || !workItemId.trim()) {
    throw new Error('The final matrix requires exactly one live parent task with a held work item');
  }
  return workItemId;
}

function assertLauncherLogProgress(taskId: string, log: string) {
  if (/JOB END: status=(?:failed|killed|timed_out)|JOB DIED|refusing to launch|session-port target bootstrap\/spawn failed/.test(log)) {
    throw new Error(`Owned matrix launcher failed (${taskId}): ${log.slice(-4000)}`);
  }
}

function matrixFailureResult(observations: Array<Record<string, unknown>>, expected: number, error: unknown) {
  let message = String(error instanceof Error ? error.message : error).trim() || 'Unknown matrix failure';
  if (message.length > 2000) {
    const omission = '\n[exception truncated: ' + message.length + ' characters]\n';
    message = message.slice(0, 600) + omission + message.slice(-(2000 - 600 - omission.length));
  }
  return {
    exitCode: 1,
    summary: 'Final matrix stopped after ' + observations.length + '/' + expected + ' observations.',
    assertions: [
      ...observations.map((observation, index) => ({
        id: 'completed-observation-' + (index + 1),
        passed: true,
        evidence: JSON.stringify(observation).slice(0, 2000),
      })),
      { id: 'matrix-stop', passed: false, evidence: message },
    ],
  };
}

function assertMatrixCapacity(provider: 'claude' | 'codex', report: Record<string, unknown>) {
  // `serving` is the probe's policy-checked STATE. `ok`, HTTP 200, unknown
  // projections and the `unwalled` DELTA do not establish eligible capacity.
  if (report.provider !== provider || report.dryRun !== true ||
    !Array.isArray(report.serving) || !report.serving.some(id => typeof id === 'string' && id.length > 0)) {
    throw new Error(`Final matrix has no eligible ${provider} capacity from its dry probe: ` +
      JSON.stringify({ provider: report.provider, dryRun: report.dryRun, probed: report.probed,
        serving: report.serving, confirmedWalled: report.confirmedWalled, failed: report.failed }));
  }
}

function maintainedCanonicalTree(env: Partial<Pick<NodeJS.ProcessEnv,
  'PAPERCUSP_CANONICAL_TREE' | 'PAPERCUSP_INTEGRATION_ROOT'>>) {
  const canonical = env.PAPERCUSP_CANONICAL_TREE || env.PAPERCUSP_INTEGRATION_ROOT;
  if (!canonical) throw new Error('The final matrix requires the maintained canonical tree selector');
  return resolve(canonical);
}

function matrixSourceLockDomains(sourceRoot: string, canonical: string) {
  return [...new Set([resolve(sourceRoot), resolve(canonical)])];
}

function matrixSourceLockArgs(domain: string, sourceRoot: string) {
  const resolvedRoot = resolve(sourceRoot);
  const resolvedDomain = resolve(domain);
  return {
    paths: [...MATRIX_SOURCE_PATHS],
    intent: 'Keep launcher source bytes stable throughout the final resume matrix.',
    ttl_sec: 900,
    ...(resolvedDomain === resolvedRoot ? {} : { coordination_domain: resolvedDomain }),
  };
}

function assertMatrixSourceLock(receipt: Record<string, any>) {
  const held = Array.isArray(receipt.held) ? receipt.held as unknown[] : [];
  if (typeof receipt.lock_id !== 'string' ||
    !MATRIX_SOURCE_PATHS.every(path => held.includes(path))) {
    throw new Error('Final matrix could not secure both launcher source files: ' +
      JSON.stringify({ lockId: receipt.lock_id, held: receipt.held, busy: receipt.busy }));
  }
  return receipt.lock_id as string;
}

type MatrixLockCall = (name: string, args: Record<string, unknown>, origin: string,
  idempotencyKey?: string) => Record<string, any>;

function matrixLockReleaseState(lock: MatrixSourceLock, sourceRoot: string, origin: string,
  invoke: MatrixLockCall) {
  const resolvedRoot = resolve(sourceRoot);
  const args = {
    paths: [...MATRIX_SOURCE_PATHS],
    ...(lock.domain === resolvedRoot ? {} : { coordination_domain: lock.domain }),
  };
  let latest: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    latest = invoke('locks:queue', args, origin);
    if (!Array.isArray(latest.active_locks)) {
      throw new Error(`Source-lock verification returned no active_locks array for ${lock.lockId}`);
    }
    const held = latest.active_locks.some((row: Record<string, unknown>) => row.lock_id === lock.lockId);
    if (held) return { held: true, state: latest };
    if (!latest._dataPlaneMayBeDegraded && latest._partial !== true) return { held: false, state: latest };
  }
  throw new Error(`Source-lock absence for ${lock.lockId} remains unverified after degraded queue reads: ` +
    JSON.stringify(latest));
}

function releaseMatrixSourceLocks(locks: MatrixSourceLock[], sourceRoot: string, origin: string,
  invoke: MatrixLockCall = call) {
  const resolvedRoot = resolve(sourceRoot);
  for (const lock of [...locks].reverse()) {
    const args = {
      lock_id: lock.lockId,
      ...(lock.domain === resolvedRoot ? {} : { coordination_domain: lock.domain }),
    };
    try {
      invoke('locks:release', args, origin);
      continue;
    } catch (releaseError) {
      const observed = matrixLockReleaseState(lock, sourceRoot, origin, invoke);
      if (!observed.held) continue;
      const idempotencyKey = String(releaseError instanceof Error ? releaseError.message : releaseError)
        .match(/idempotencyKey=([0-9a-f-]{36})/i)?.[1];
      if (!idempotencyKey) {
        throw new Error(`Source lock ${lock.lockId} is still held after release failed, and no replay key was returned: ` +
          String(releaseError));
      }
      try {
        invoke('locks:release', args, origin, idempotencyKey);
      } catch (retryError) {
        const afterRetry = matrixLockReleaseState(lock, sourceRoot, origin, invoke);
        if (!afterRetry.held) continue;
        throw new Error(`Source lock ${lock.lockId} remains held after same-key release replay. ` +
          `First failure: ${String(releaseError)}; replay failure: ${String(retryError)}`);
      }
    }
  }
}

function acquireMatrixSourceLocks(sourceRoot: string, canonical: string, origin: string) {
  const locks: MatrixSourceLock[] = [];
  try {
    for (const domain of matrixSourceLockDomains(sourceRoot, canonical)) {
      const receipt = call('locks:acquire', matrixSourceLockArgs(domain, sourceRoot), origin);
      locks.push({ lockId: assertMatrixSourceLock(receipt), domain });
    }
    return locks;
  } catch (error) {
    try { releaseMatrixSourceLocks(locks, sourceRoot, origin); }
    catch (releaseError) {
      throw new Error(`Final matrix source-lock acquisition failed: ${String(error)}\n` +
        `Partial lock cleanup failed: ${String(releaseError)}`);
    }
    throw error;
  }
}

function assertCodexAutoRoute(report: Record<string, unknown>) {
  const accounts = Array.isArray(report.codexAccounts)
    ? report.codexAccounts.filter((account): account is string => typeof account === 'string' && account.length > 0)
    : [];
  // gateway:status quarantines the legacy pool-health fields under `legacy`.
  // A missing cause remains a refusal; only the explicit healthy/null state or
  // psu's advisory temporary-cooldown state permits the auto route.
  const legacy = report.legacy && typeof report.legacy === 'object'
    ? report.legacy as Record<string, unknown>
    : {};
  const causePresent = Object.prototype.hasOwnProperty.call(legacy, 'codexUnserviceableCause');
  const cause = causePresent ? legacy.codexUnserviceableCause : undefined;
  // psu treats a temporary cooldown as an advisory and launches with normal
  // gateway retry handling. All other non-null causes refuse the exact route.
  if (report.ok !== true || accounts.length === 0 ||
    !causePresent || (cause !== null && cause !== 'temporary-cooldown')) {
    throw new Error('Final matrix has no launchable Codex auto-route from fresh gateway status: ' +
      JSON.stringify({ codexAccounts: report.codexAccounts,
        codexHealthyAccounts: legacy.codexHealthyAccounts,
        codexUnserviceableCause: causePresent ? cause : '<missing>',
        codexReachability: legacy.codexReachability }));
  }
}

function matrixCapacityProbeArgs(provider: 'claude' | 'codex') {
  // The explicit Codex matrix target is gpt-6.1-sol:xhigh. Probe that same
  // model family: accounts:probe-capacity otherwise defaults to gpt-5.6-sol,
  // which can report serving capacity while the requested model is at capacity.
  return {
    provider,
    ...(provider === 'codex' ? { model: 'gpt-6.1-sol' } : {}),
    apply: false,
  };
}

function assertResumableArchiveRow(source: Session, sessions: Array<Record<string, any>>) {
  const row = sessions.find(candidate => Number(candidate.id) === Number(source.id));
  const expectedNativeId = source.agent === 'omp'
    ? source.omp_thread_id ?? source.session_id : source.session_id;
  const actualNativeId = row?.agent === 'omp'
    ? row.ompThreadId ?? row.sessionId : row?.sessionId;
  if (!row || row.agent !== source.agent || !expectedNativeId || actualNativeId !== expectedNativeId ||
    row.hasArchive !== true) {
    throw new Error(`Archived source ${source.id} is not safely resumable: ` + JSON.stringify({
      expectedAgent: source.agent, expectedNativeId, actualAgent: row?.agent,
      actualNativeId, hasArchive: row?.hasArchive,
    }));
  }
}

async function assertResumableArchiveEndpoint(source: Session, origin: string) {
  const url = new URL('/api/adv/sessions/resumable', origin);
  url.searchParams.set('id', String(source.id));
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Archived source ${source.id} preflight returned HTTP ${response.status}`);
  const body = await response.json() as { sessions?: Array<Record<string, any>> };
  assertResumableArchiveRow(source, Array.isArray(body.sessions) ? body.sessions : []);
}

describe('final resume archived-source preflight', () => {
  const source: Session = { id: '42', agent: 'omp', coord_owner_id: 'fixture-owner',
    session_id: null, omp_thread_id: '01a133bc-e525-75a1-885d-ea1cd5d4a1e5', ended_at: '2026-10-13T00:00:00Z' };
  it('requires the exact OMP thread identity and archive marker before launching targets', () => {
    expect(() => assertResumableArchiveRow(source, [{ id: 42, agent: 'omp', sessionId: null,
      ompThreadId: source.omp_thread_id, hasArchive: true }])).not.toThrow();
  });
  it('fails before launch when the endpoint omits the source or archive marker', () => {
    expect(() => assertResumableArchiveRow(source, [])).toThrow('not safely resumable');
    expect(() => assertResumableArchiveRow(source, [{ id: 42, agent: 'omp', sessionId: null,
      ompThreadId: source.omp_thread_id, hasArchive: false }])).toThrow('not safely resumable');
  });
  it('does not accept a same-id row from a different backend', () => {
    expect(() => assertResumableArchiveRow(source, [{ id: 42, agent: 'claude',
      sessionId: source.omp_thread_id, hasArchive: true }])).toThrow('not safely resumable');
  });
});

describe('owned matrix capacity preflight', () => {
  it('probes the same Codex model family as the explicit matrix target', () => {
    expect(matrixCapacityProbeArgs('codex')).toEqual({
      provider: 'codex', model: 'gpt-6.1-sol', apply: false,
    });
    expect(matrixCapacityProbeArgs('claude')).toEqual({ provider: 'claude', apply: false });
  });

  it('accepts measured serving capacity without requiring an unwall correction', () => {
    expect(() => assertMatrixCapacity('claude', { provider: 'claude', dryRun: true,
      probed: 1, serving: ['healthy'], unwalled: [] })).not.toThrow();
  });
  it.each([
    { confirmedWalled: ['weekly-full'], failed: [] },
    { confirmedWalled: [], failed: ['insufficient-credit'] },
    { confirmedWalled: [], failed: [], ok: true, available: true },
  ])('refuses walls, missing readings and success-shaped projections before launching fixtures: %j', detail => {
    expect(() => assertMatrixCapacity('claude', { provider: 'claude', dryRun: true,
      probed: 1, serving: [], ...detail })).toThrow('no eligible claude capacity');
  });
  it('does not substitute another provider or a projection-writing probe', () => {
    expect(() => assertMatrixCapacity('claude', { provider: 'codex', dryRun: true,
      serving: ['healthy-codex'] })).toThrow('no eligible claude capacity');
    expect(() => assertMatrixCapacity('claude', { provider: 'claude', dryRun: false,
      serving: ['healthy'] })).toThrow('dry probe');
  });

  it('requires the maintained canonical selector before live preflights', () => {
    expect(() => maintainedCanonicalTree({})).toThrow('maintained canonical tree selector');
    expect(maintainedCanonicalTree({ PAPERCUSP_CANONICAL_TREE: '/canonical' })).toBe(resolve('/canonical'));
    expect(maintainedCanonicalTree({ PAPERCUSP_INTEGRATION_ROOT: '/integration' })).toBe(resolve('/integration'));
  });

  it('locks both source trees and requires both launcher paths in the receipt', () => {
    expect(matrixSourceLockDomains('/source', '/source')).toEqual(['/source']);
    expect(matrixSourceLockDomains('/source', '/canonical')).toEqual(['/source', '/canonical']);
    expect(matrixSourceLockArgs('/source', '/source')).not.toHaveProperty('coordination_domain');
    expect(matrixSourceLockArgs('/canonical', '/source').coordination_domain).toBe('/canonical');
    expect(assertMatrixSourceLock({ lock_id: 'lock-1', held: [...MATRIX_SOURCE_PATHS] })).toBe('lock-1');
    expect(() => assertMatrixSourceLock({ lock_id: 'lock-1', held: [MATRIX_SOURCE_PATHS[0]] }))
      .toThrow('could not secure both launcher source files');
  });

  it('accepts a lost release reply only after a clean exact-lock absence read', () => {
    const key = '11111111-1111-4111-8111-111111111111';
    const lock = { lockId: 'lock-1', domain: '/source' };
    const calls: string[] = [];
    const queueReads = [
      { active_locks: [], waiting: [], _dataPlaneMayBeDegraded: 'retry' },
      { active_locks: [], waiting: [] },
    ];
    const invoke: MatrixLockCall = (name) => {
      calls.push(name);
      if (name === 'locks:release') throw new Error(`request timed out idempotencyKey=${key}`);
      return queueReads.shift()!;
    };

    expect(() => releaseMatrixSourceLocks([lock], '/source', 'origin', invoke)).not.toThrow();
    expect(calls).toEqual(['locks:release', 'locks:queue', 'locks:queue']);
  });

  it('replays the same release key when the exact source lock is still held', () => {
    const key = '22222222-2222-4222-8222-222222222222';
    const lock = { lockId: 'lock-1', domain: '/source' };
    const releaseKeys: Array<string | undefined> = [];
    const invoke: MatrixLockCall = (name, _args, _origin, idempotencyKey) => {
      if (name === 'locks:release') {
        releaseKeys.push(idempotencyKey);
        if (releaseKeys.length === 1) throw new Error(`request timed out idempotencyKey=${key}`);
        return { ok: true };
      }
      return { active_locks: [{ lock_id: lock.lockId }], waiting: [] };
    };

    expect(() => releaseMatrixSourceLocks([lock], '/source', 'origin', invoke)).not.toThrow();
    expect(releaseKeys).toEqual([undefined, key]);
  });

  it('keeps cleanup failure visible when the exact lock survives the release replay', () => {
    const key = '33333333-3333-4333-8333-333333333333';
    const lock = { lockId: 'lock-1', domain: '/source' };
    const invoke: MatrixLockCall = (name) => {
      if (name === 'locks:release') throw new Error(`request timed out idempotencyKey=${key}`);
      return { active_locks: [{ lock_id: lock.lockId }], waiting: [] };
    };

    expect(() => releaseMatrixSourceLocks([lock], '/source', 'origin', invoke))
      .toThrow('remains held after same-key release replay');
  });

  it('follows psu route policy: refuse unavailable routes but allow a temporary-cooldown warning', () => {
    const route = (cause: unknown) => ({ ok: true, codexAccounts: ['chatgpt-sub-cli'],
      legacy: { codexUnserviceableCause: cause } });
    expect(() => assertCodexAutoRoute(route(null))).not.toThrow();
    expect(() => assertCodexAutoRoute(route('accounts-unserviceable')))
      .toThrow('no launchable Codex auto-route');
    expect(() => assertCodexAutoRoute(route('temporary-cooldown'))).not.toThrow();
    expect(() => assertCodexAutoRoute(route('upstream-unreachable')))
      .toThrow('no launchable Codex auto-route');
    expect(() => assertCodexAutoRoute({ ok: true, codexAccounts: [],
      legacy: { codexUnserviceableCause: null } })).toThrow('no launchable Codex auto-route');
    expect(() => assertCodexAutoRoute({ ok: true, codexAccounts: ['chatgpt-sub-cli'],
      codexUnserviceableCause: null })).toThrow('no launchable Codex auto-route');
    expect(() => assertCodexAutoRoute({ ok: true, codexAccounts: ['chatgpt-sub-cli'], legacy: {} }))
      .toThrow('no launchable Codex auto-route');
  });
});

// expect.poll retries exceptions as assertion failures. A dead launcher is a
// terminal error, so propagate it immediately rather than hiding it for 240s.
async function waitForLauncherObservation(observe: () => boolean | Promise<boolean>, timeout: number,
  interval = 5000) {
  const deadline = Date.now() + timeout;
  while (true) {
    if (await observe()) return;
    if (Date.now() >= deadline) throw new Error(`Owned matrix observation did not converge within ${timeout}ms`);
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
  }
}

async function cleanupOwnedMatrixLauncher(taskId: string, deps: {
  stop: () => Record<string, any>;
  sessions: () => Session[];
  reportEnded: (session: Session, observedAt: string, endAttemptKey: string) => Promise<{ reported: boolean }>;
  remaining: () => Session[];
  timeout?: number;
  interval?: number;
}) {
  // A successful kill receipt can mean "termination pending". Do not end a
  // session, or start its next pair, until the kernel confirms this scope empty.
  // Capture the death boundary before signalling so a late report cannot end a
  // newer incarnation of the same adv row.
  const observedAt = new Date().toISOString();
  const timeout = deps.timeout ?? 60_000;
  const interval = deps.interval ?? 1000;
  await waitForLauncherObservation(() => emptyOwnedScope(taskId, deps.stop()), timeout, interval);
  for (const session of deps.sessions()) {
    const receipt = await deps.reportEnded(session, observedAt, `cbp-final-cleanup:${taskId}:${session.id}`);
    if (!receipt.reported) throw new Error(`Owned matrix session ${session.id} end was not acknowledged`);
  }
  await waitForLauncherObservation(() => deps.remaining().length === 0, timeout, interval);
}

describe('owned matrix lifecycle convergence', () => {
  const session = { id: '42', agent: 'codex' as const, coord_owner_id: 'fixture-owner',
    session_id: 'native', omp_thread_id: null, ended_at: null };
  const empty = (taskId = 'owned-task') => ({ ok: false, results: [{ taskId, error: 'not_live',
    detail: 'scope holds no live process right now; nothing to reap' }] });
  it('waits through termination pending and persisted session closure before continuing', async () => {
    const actions: string[] = [];
    let stops = 0;
    let reads = 0;
    await cleanupOwnedMatrixLauncher('owned-task', {
      stop: () => { actions.push('stop'); return ++stops === 1 ? { ok: true,
        results: [{ taskId: 'owned-task', detail: 'termination pending' }] } : empty(); },
      sessions: () => [session],
      reportEnded: async (target, observedAt, key) => {
        actions.push('report');
        expect(target).toBe(session);
        expect(Number.isFinite(Date.parse(observedAt))).toBe(true);
        expect(key).toBe('cbp-final-cleanup:owned-task:42');
        return { reported: true };
      },
      remaining: () => { actions.push('read'); return ++reads === 1 ? [session] : []; },
      timeout: 1000, interval: 0,
    });
    expect(actions).toEqual(['stop', 'stop', 'report', 'read', 'read']);
  });
  it('never reports death from a terminal row or an empty receipt for another task', async () => {
    for (const receipt of [{ ok: false, results: [{ taskId: 'owned-task', error: 'not_live',
      detail: 'state is killed' }] }, empty('other-task')]) {
      let reports = 0;
      await expect(cleanupOwnedMatrixLauncher('owned-task', {
        stop: () => receipt, sessions: () => [session],
        reportEnded: async () => { reports++; return { reported: true }; },
        remaining: () => [], timeout: 0, interval: 0,
      })).rejects.toThrow('did not converge');
      expect(reports).toBe(0);
    }
  });
  it('refuses an unacknowledged lifecycle end and a still-live session row', async () => {
    for (const acknowledged of [false, true]) {
      await expect(cleanupOwnedMatrixLauncher('owned-task', {
        stop: () => empty(), sessions: () => [session],
        reportEnded: async () => ({ reported: acknowledged }), remaining: () => [session],
        timeout: 0, interval: 0,
      })).rejects.toThrow(acknowledged ? 'did not converge' : 'not acknowledged');
    }
  });
});

function assertSourceAvailable(source: Session, origin: string) {
  const active = rows(`SELECT active.id FROM harness_shared.adv_sessions active
    WHERE active.workspace_id = ${literal(workspace)} AND active.ended_at IS NULL
    AND (active.id = ${Number(source.id)} OR active.coord_owner_id = ${literal(source.coord_owner_id)}
      OR active.id IN (SELECT port.target_adv_session_id FROM harness_shared.session_ports port
        WHERE port.workspace_id = ${literal(workspace)} AND port.source_adv_session_id = ${Number(source.id)}))
    ORDER BY active.id DESC LIMIT 10`, origin);
  expect(active, `Source ${source.id} still has a live fixture; cleanup must finish before another launch`).toEqual([]);
}

describe('owned matrix lifetime and progress', () => {
  it('requires the real managed parent marker', () => {
    expect(matrixParentTaskId({ PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: 'parent123' })).toBe('parent123');
    expect(() => matrixParentTaskId({})).toThrow('durable parent task');
    expect(() => matrixParentTaskId({ PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '../bad' })).toThrow();
  });
  it('uses the live parent task work item for nested fixture launches', () => {
    expect(matrixParentWorkItemId('parent123', [
      { taskId: 'other', state: 'running', workItemId: 'WI-legacy' },
      { taskId: 'parent123', state: 'running', workItemId: 'EI-current' },
    ])).toBe('EI-current');
    expect(() => matrixParentWorkItemId('parent123', [
      { taskId: 'parent123', state: 'exited', workItemId: 'EI-current' },
    ])).toThrow('live parent task');
    expect(() => matrixParentWorkItemId('parent123', [
      { taskId: 'parent123', state: 'running' },
    ])).toThrow('held work item');
  });
  it.each(['failed', 'killed', 'timed_out'])('stops immediately when the launcher is %s', async status => {
    let observations = 0;
    await expect(waitForLauncherObservation(() => {
      observations++;
      assertLauncherLogProgress('fixture123', `[capability:bash] JOB END: status=${status} exit=1`);
      return false;
    }, 240_000)).rejects.toThrow('Owned matrix launcher failed');
    expect(observations).toBe(1);
  });
  it('waits for a pending observation and accepts a clean launcher exit', async () => {
    let observations = 0;
    await waitForLauncherObservation(() => {
      assertLauncherLogProgress('fixture123', '[capability:bash] JOB END: status=completed exit=0');
      return ++observations === 3;
    }, 1000, 0);
    expect(observations).toBe(3);
  });
});

describe('owned matrix failure evidence', () => {
  it('retains completed observations and the stop cause when a later port fails', () => {
    const observation = { source: 'claude', target: 'codex', targetAdvSessionId: '43472' };
    const result = matrixFailureResult([observation], 9, new Error('explicit xhigh launch refused'));
    expect(result.exitCode).toBe(1);
    expect(result.summary).toBe('Final matrix stopped after 1/9 observations.');
    expect(result.assertions).toEqual([
      { id: 'completed-observation-1', passed: true, evidence: JSON.stringify(observation) },
      { id: 'matrix-stop', passed: false, evidence: 'explicit xhigh launch refused' },
    ]);
  });

  it('keeps both the trace start and semantic tail when the stop error is clipped', () => {
    const result = matrixFailureResult([], 9,
      new Error('MCP launch trace start\n' + 'connection detail\n'.repeat(400) + 'explicit xhigh refusal'));
    const failure = result.assertions.at(-1)!;
    expect(failure.evidence).toContain('MCP launch trace start');
    expect(failure.evidence).toContain('[exception truncated:');
    expect(failure.evidence).toContain('explicit xhigh refusal');
    expect(failure.evidence.length).toBeLessThanOrEqual(2000);
  });
});

async function native(session: Session, archivedSource = false) {
  const id = session.agent === 'omp' ? session.omp_thread_id ?? session.session_id : session.session_id;
  if (!id) return undefined;
  const path = await (session.agent === 'claude'
    ? findCanonicalClaudeLiveJsonl(sessionClaudeConfigDir(session.coord_owner_id), id)
    : findCanonicalNativeLiveJsonl(join(session.agent === 'codex'
      ? codexHomeForSessionKey(Number(session.id)) : ompAgentHomeForSessionKey(Number(session.id)), 'sessions'), session.agent, id))
    .catch(error => { if (!archivedSource) throw error; return null; });
  // Ended fixtures are archived and removed from disk by the normal lifecycle.
  // Read their exact native archive with the production manifest/hash guards.
  // A fresh cross-backend target must still prove its physical live transcript.
  if (!path && !archivedSource) return undefined;
  const snapshot = path ? await readStableLiveJsonl(path) : session.agent === 'claude'
    ? await readCanonicalClaudeArchive({ sessionId: id }, pgSessionArchiveStore())
    : await readCanonicalNativeArchive({ backend: session.agent, sessionId: id }, pgSessionArchiveStore());
  const text = adaptNativeSessionJsonl(session.agent, snapshot.bytes.toString('utf8'), id)
    .turns.flatMap(turn => turn.blocks.flatMap(block => 'text' in block ? [String(block.text)] : [])).join('\n');
  return { id, path, sha256: snapshot.sha256, text };
}

describe.skipIf(!enabled)('final live session resume matrix', () => {
  let heldSourceLocks: HeldMatrixSourceLocks | null = null;
  afterEach(() => {
    const held = heldSourceLocks;
    heldSourceLocks = null;
    if (held) releaseMatrixSourceLocks(held.locks, held.sourceRoot, held.origin);
  });

  it('delivers six cross-backend ports and three original-backend PUI-shaped resumes', async () => {
    const canonical = maintainedCanonicalTree(process.env);
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    const origin = profile.origin as string;
    const recordContext = { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root };
    expect(resolveAgentWorkspaceRoot(recordContext), 'Recorder must measure this committed test tree').toBe(root);
    const owner = call('coord:whoami', {}, origin).ownerId as string;
    expect(owner).toBe(process.env.PAPERCUSP_SID);
    const parentTaskId = matrixParentTaskId();
    const parentWorkItemId = matrixParentWorkItemId(parentTaskId,
      call('processes:list', { taskId: parentTaskId }, origin).tasks);
    heldSourceLocks = { sourceRoot: root, origin, locks: acquireMatrixSourceLocks(root, canonical, origin) };
    // Import only after acquiring the lock so cleanup uses the exact launcher
    // bytes that the matrix hashes and holds stable through every fixture.
    const { reportSessionEnded } = await import(pathToFileURL(
      resolve(canonical, 'apps/operator/scripts/psu-launcher.mjs')).href);
    const sourceHashes: Record<string, string> = {};
    for (const path of MATRIX_SOURCE_PATHS) {
      const hash = (base: string) => createHash('sha256').update(readFileSync(resolve(base, path))).digest('hex');
      sourceHashes[path] = hash(root);
      expect(hash(canonical), `Canonical ${path} changed after source lock`).toBe(sourceHashes[path]);
    }

    // The upstream capacity probe is not the exact account=auto launch route.
    // Read the gateway's route-level serviceability before preparing any targets;
    // psu's own launch refusal remains the final guard against state changing later.
    const route = call('gateway:status', {}, origin);
    const legacyRoute = route.legacy && typeof route.legacy === 'object'
      ? route.legacy as Record<string, unknown>
      : {};
    const routeCausePresent = Object.prototype.hasOwnProperty.call(legacyRoute, 'codexUnserviceableCause');
    console.info('CBP_FINAL_ROUTE_PREFLIGHT', JSON.stringify({ ok: route.ok,
      codexAccounts: route.codexAccounts,
      codexHealthyAccounts: legacyRoute.codexHealthyAccounts,
      codexUnserviceableCause: routeCausePresent ? legacyRoute.codexUnserviceableCause : '<missing>',
      codexReachability: legacyRoute.codexReachability }));
    assertCodexAutoRoute(route);
    // Both target backends, and Claude maintenance summarization, are required
    // by the unchanged matrix profile. Refuse known capacity walls before any
    // fixture is launched; dry probes neither unwall nor readmit accounts.
    for (const provider of ['claude', 'codex'] as const) {
      const capacityArgs = matrixCapacityProbeArgs(provider);
      const capacity = call('accounts:probe-capacity', capacityArgs, origin);
      console.info('CBP_FINAL_CAPACITY_PREFLIGHT', JSON.stringify({ provider,
        model: capacityArgs.model ?? 'tool-default',
        dryRun: capacity.dryRun, probed: capacity.probed, serving: capacity.serving,
        confirmedWalled: capacity.confirmedWalled, failed: capacity.failed }));
      assertMatrixCapacity(provider, capacity);
    }
    const ids = profile.resumeMatrix.sourceAdvSessionIds as number[];
    expect(ids).toHaveLength(3);
    expect(ids.every(id => Number.isSafeInteger(id) && id > 0)).toBe(true);
    const sessions = rows(`SELECT id, agent, coord_owner_id, session_id, omp_thread_id, ended_at
      FROM harness_shared.adv_sessions WHERE workspace_id = ${literal(workspace)}
      AND id IN (${ids.join(',')}) ORDER BY id LIMIT 3`, origin) as Session[];
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map(session => session.agent))).toEqual(new Set(['claude', 'codex', 'omp']));
    for (const source of sessions) {
      expect(source.ended_at, `Source ${source.id} must be an ended plan fixture`).toBeTruthy();
      assertSourceAvailable(source, origin);
      // Check the live launcher preflight surface before starting any expensive
      // target host: a canonical archive read alone does not prove that psu's
      // resumable endpoint exposes the same native identity and hasArchive key.
      await assertResumableArchiveEndpoint(source, origin);
      const snapshot = await native(source, true);
      expect(snapshot?.text).toContain('MATRIX-SRC');
    }
    const observations: Array<Record<string, unknown>> = [];
    const attemptId = randomUUID();
    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/session-port/resume.live.e2e.test.ts',
      name: 'D-021 six ordered session ports and original-backend PUI resume shapes', framework: 'operational',
      command: ['npm', 'run', 'test:file', '--', 'packages/operator-core/lib/session-port/resume.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const launch = async (source: Session, target?: SessionBackend) => {
          assertSourceAvailable(source, origin);
          const startedAt = new Date().toISOString();
          const args = ['--no-picker', '--headless', `--workspace=${workspace}`, '--harness=papercusp',
            '--no-plan', '--context-size=trimmed', '--account=auto', `--launched-by=${owner}`,
            `--resume=${source.id}`, `--label=cbp-final-${source.agent}-${target ?? 'same'}`];
          // A completed semantic request is intentionally idempotent. This
          // validation is a new request, so bind its actual instruction to this
          // attempt rather than accidentally reopening yesterday's target.
          const instruction = `Resume validation ${attemptId}, ${source.agent} to ${target ?? source.agent}. ` +
            'Report the fixture marker already present in the carried user history. Do not call tools or start other work.';
          args.push(`--kickoff=${instruction}`);
          if (target) {
            args.push(`--agent=${target}`);
            // Preserve the established matrix's compatible backend profiles.
            if (target === 'codex') args.push('--model=gpt-6.1-sol:xhigh', '--model-source=explicit');
            if (target === 'claude') args.push('--model=fable[1m]');
          }
          const command = ['env', '-u', 'PAPERCUSP_SID', '-u', 'PAPERCUSP_CAPABILITY_BASH_FOREGROUND',
            `PAPERCUSP_PSU_LAUNCHER=${canonical}/apps/operator/scripts/psu-launcher.mjs`,
            `PAPERCUSP_OPERATOR_URL=${origin}`, process.execPath,
            `${canonical}/apps/operator/scripts/psu-launcher.mjs`, ...args].map(shellQuote).join(' ');
          const task = call('capability:bash', { command, cwd: canonical, timeout: 900_000,
            run_in_background: true, work_item_id: parentWorkItemId,
            parent_task_id: parentTaskId,
            description: `Final matrix ${source.agent} to ${target ?? 'original backend'}` }, origin);
          expect(task.task_id).toBeTruthy();
          expect(task.log_path).toBeTruthy();
          console.info('CBP_FINAL_RESUME_TASK', JSON.stringify(task));
          const assertLauncherProgress = () => {
            let log = '';
            try { log = readFileSync(task.log_path, 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            assertLauncherLogProgress(task.task_id, log);
          };
          let primaryError: unknown;
          try {
            let resumed!: Session;
            let port: Record<string, any> | undefined;
            await waitForLauncherObservation(() => {
              assertLauncherProgress();
              const candidates = rows(`SELECT id, agent, coord_owner_id, session_id, omp_thread_id, ended_at,
                port_id FROM harness_shared.adv_sessions WHERE workspace_id = ${literal(workspace)}
                AND ${target ? `label = ${literal(`cbp-final-${source.agent}-${target}`)}
                  AND started_at >= ${literal(startedAt)}::timestamptz` : `id = ${Number(source.id)} AND ended_at IS NULL`}
                ORDER BY id DESC LIMIT 1`, origin);
              if (!candidates[0]) return false;
              resumed = candidates[0] as Session;
              if (resumed.agent !== (target ?? source.agent)) return false;
              if (!target) return Boolean(resumed.session_id || resumed.omp_thread_id);
              port = rows(`SELECT id, status, source_adv_session_id, target_adv_session_id, metadata
                FROM harness_shared.session_ports WHERE workspace_id = ${literal(workspace)}
                AND source_adv_session_id = ${Number(source.id)}
                AND prepared_at >= ${literal(startedAt)}::timestamptz
                AND target_adv_session_id = ${Number(resumed.id)} ORDER BY prepared_at DESC LIMIT 1`, origin)[0];
              return port?.status === 'delivered';
            }, 240_000);
            let snapshot: Awaited<ReturnType<typeof native>>;
            await waitForLauncherObservation(async () => {
              assertLauncherProgress();
              snapshot = await native(resumed);
              return Boolean(snapshot?.text.includes(target ? `port-id: ${port!.id}` : 'MATRIX-SRC'));
            }, 120_000);
            if (!target) expect(snapshot!.id).toBe(source.agent === 'omp'
              ? source.omp_thread_id ?? source.session_id : source.session_id);
            else {
              expect(Number(port!.source_adv_session_id)).toBe(Number(source.id));
              expect(port!.metadata.persistenceProof).toBeTruthy();
            }
            observations.push({ source: source.agent, target: target ?? source.agent,
              attemptId,
              sourceAdvSessionId: source.id, targetAdvSessionId: resumed.id,
              port, nativePath: snapshot!.path, nativeSha256: snapshot!.sha256, nativeSessionId: snapshot!.id });
            console.info('CBP_FINAL_RESUME_OBSERVATION', JSON.stringify(observations.at(-1)));
          } catch (error) {
            primaryError = error;
            throw error;
          } finally {
            // This task was created by this test; stop its managed subtree only.
            try {
              const ownedSessions = () => rows(`SELECT id, agent, coord_owner_id, session_id,
                omp_thread_id, ended_at FROM harness_shared.adv_sessions
                WHERE workspace_id = ${literal(workspace)} AND ended_at IS NULL
                AND coord_owner_id = ${literal(source.coord_owner_id)}
                AND ${target ? `label = ${literal(`cbp-final-${source.agent}-${target}`)}
                  AND started_at >= ${literal(startedAt)}::timestamptz` : `id = ${Number(source.id)}`}
                ORDER BY id LIMIT 10`, origin) as Session[];
              await cleanupOwnedMatrixLauncher(task.task_id, {
                stop: () => call('processes:kill', { taskId: task.task_id,
                  includeSubtree: true, escalateAfterMs: 5000, reapTerminalResidue: true }, origin),
                sessions: ownedSessions,
                reportEnded: (session, observedAt, endAttemptKey) => reportSessionEnded(session.id, null, {
                  operatorUrl: origin, observedAt, endAttemptKey, killedBySignal: 'SIGTERM',
                }),
                remaining: ownedSessions,
              });
              console.info('CBP_FINAL_RESUME_CLEANUP', JSON.stringify({ taskId: task.task_id,
                scopeEmpty: true, sessionsEnded: true }));
            } catch (cleanupError) {
              // A finally failure must not erase the observation that failed first.
              throw new Error(`Owned matrix cleanup failed (${task.task_id}): ${String(cleanupError)}\n` +
                `Primary observation failure: ${primaryError === undefined ? 'none' : String(primaryError)}`);
            }
          }
        };
        try {
          for (const pair of SESSION_PORT_SUPPORTED_PAIRS) {
            await launch(sessions.find(session => session.agent === pair.source)!, pair.target);
          }
          for (const source of sessions) await launch(source);
          expect(observations).toHaveLength(9);
          for (const [path, sha256] of Object.entries(sourceHashes)) {
            expect(createHash('sha256').update(readFileSync(resolve(canonical, path))).digest('hex')).toBe(sha256);
          }
        } catch (error) {
          // Return a failed artifact instead of throwing here: executeOperationalRun
          // can persist the completed ports and first stop cause only when its callback
          // returns. The test's final pass expectation still fails the Vitest run.
          return matrixFailureResult(observations, SESSION_PORT_SUPPORTED_PAIRS.length + sessions.length, error);
        }
        return { exitCode: 0, summary: 'Six fresh delivered ports and three PUI-shaped original-backend native resumes',
          assertions: observations.map((observation, index) => ({
            id: `resume-${index}-${observation.source}-${observation.target}`, passed: true,
            evidence: JSON.stringify(observation).slice(0, 2000),
          })) };
      },
    }, recordContext);
    console.info('CBP_FINAL_RESUME_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
  }, 3_600_000);
});
