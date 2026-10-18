/** Private PG + immutable git protocol integration; no inference or product writes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { currentBenchObservationReader, currentBenchIdentityFromObservation, liveCurrentBenchObservationReaderPorts,
  currentSuBenchHarnessDriver, liveCurrentSuBenchPorts, readCurrentBenchCompletion, type CurrentSuBenchOptions,
  liveCurrentBenchNativeCostReader, currentBenchLaunchRequest, currentBenchNativeSessionCostDelta,
  requireCurrentBenchNativeRunCost, beginCurrentBenchNativeSession,
  currentBenchAssignmentId, currentBenchGatewayController, currentBenchWorkloadLockStateReader,
  type CurrentBenchLockStateAllocation,
  currentBenchWorkloadTransitionReader, currentBenchWorkloadArtifactReader, currentBenchWorkloadContextReader,
  currentBenchWorkloadCheckpointReader, currentBenchWorkloadHandoffReader, currentBenchWorkloadProviderInputReader,
  currentBenchWorkloadToolResultReader, currentBenchWorkloadLockGrantReader, currentBenchWorkloadGradeReader,
  currentBenchWorkloadProviderInputCapture,
  currentBenchProviderAuthenticator, currentBenchOpenAiInputContract, currentBenchOpenAiInputReader,
  type CurrentBenchTask } from './current-su';
import { preregister } from './reproducibility/prereg';
import { readBenchRunCost, type BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentProtocolFixture, controlledProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { readProcessIdentity } from '../process-identity';
import { createInferenceGateway, type GatewayDeps } from '../inference-gateway/gateway';
import { createFailoverPool } from '../inference-gateway/account-failover';
import { resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';
import { closedCodexSessionPopulation } from '../interactive-usage/ingest-adapters';
import { registerLearningLoop, reserveLearningSpend, recordLearningSpendAttemptResult, getLearningSpendPositions,
  settleLearningSpend, listLearningSpendEvents } from '../learning-governor/store';
import type { GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import { startGatewayService } from '../inference-gateway/launch';
import { makeBearerCredentialResolver } from '../inference-gateway/credential-store';
import { shortCarryHash, computeWorkItemSubjectFingerprint } from '../carry-note';
import { canonicalJson } from './reproducibility/canonical-json';
import { emitRollout, rolloutIdFor } from './reproducibility/emit';
import { computePreregHash } from './reproducibility/prereg';
import { currentBenchTaskProviderCapture, freezeCurrentBenchTaskProviderReservation,
  currentBenchTaskProviderInputReader, freezeCurrentBenchTaskLockState, currentBenchTaskLockStateReader,
  type CurrentTaskInput } from './run-launcher';

vi.mock('../sync-sse', async importOriginal => ({ ...await importOriginal<typeof import('../sync-sse')>(),
  notifySyncInvalidate: vi.fn().mockResolvedValue(undefined) }));

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
// Goal admission is an independent boundary. Its production service binding
// reads the host org DB; this fixture owns only the private benchmark DB.
const goalAdmission = vi.hoisted(() => vi.fn());
// The private launch has no accepted operation receipt. Resolve that fact at
// the trusted composition seam rather than querying an unrelated live org DB.
const operationPolicy = vi.hoisted(() => vi.fn<NonNullable<GatewayDeps['readAcceptedOperationModelPolicy']>>());
const operationAttestation = vi.hoisted(() => vi.fn<NonNullable<GatewayDeps['recordAcceptedOperationModelAttestation']>>());
const hostHome = vi.hoisted(() => ({ path: '', byId: new Map<number, string>() }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('benchmark-test-private-route'),
  INTERNAL_SCOPED_SESSION_CONFINEMENT: Symbol.for('benchmark-test-server-ceiling') }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));
// Only the private home allocator is substituted. SQL bindings, filesystem
// bytes, process pins, request observation and HTTP reads use production IO.
vi.mock('@papercusp/orchestrator/session-launch-dirs', () => ({ codexHomeForSessionKey: (id: number | string) => hostHome.byId.get(Number(id)) ?? hostHome.path }));

const workspaceId = 'bench-current-private';
const handle = { slug: 'xbench-current-private', featureId: 'xbench-private-task', worktreePath: '/private/task' };
const config = currentProtocolFixture('PRIVATE');
const ctx = { workspaceId, authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
let sql: postgres.Sql;
let repoRoot: string;
const roots: string[] = [];
const gateways: Array<{ stop(): Promise<void> }> = [];
const scope = () => ({ workspaceId, sql: sql as never });
const request = {
  blueprintId: 'su', task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement: 'Fix the public issue.', graderMeta: {} },
  checkout: { dir: '/private/task', repo: 'fixture/repo', baseCommit: 'base', cleanup: async () => {} },
  budget: { maxUsd: 3, maxWallClockMs: 100 },
};
function commitProtocol(filePath: string, body: string): void {
  // Force a conflicting configured default: this exercises the explicit branch
  // under every CI host, including machines whose global default is main.
  execFileSync('git', ['-c', 'init.defaultBranch=fixture-other', 'init', '-q', '--initial-branch=main'], { cwd: repoRoot });
  const stream = `blob\nmark :1\ndata ${Buffer.byteLength(body)}\n${body}\ncommit refs/heads/main\ncommitter Fixture <fixture@example.invalid> 1577836800 +0000\ndata 6\nfrozen\nM 100644 :1 ${filePath}\n\ndone\n`;
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repoRoot, input: stream });
  expect(execFileSync('git', ['symbolic-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('refs/heads/main');
  execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot });
}
function prepareContext(config: ReturnType<typeof currentProtocolFixture>) {
  const initialSnapshot = JSON.stringify({ entries: [{ key: 'permitted:private-fixture', text: 'Shared frozen private context.' }] });
  for (const kind of ['corpus', 'memory']) writeFileSync(join(repoRoot, `${kind}.json`), initialSnapshot);
  config.context = { ...config.context, corpusRef: 'corpus.json', memoryRef: 'memory.json',
    corpusHash: createHash('sha256').update(initialSnapshot).digest('hex'),
    memoryHash: createHash('sha256').update(initialSnapshot).digest('hex') };
  handle.worktreePath = mkdtempSync(join(tmpdir(), 'current-bench-checkout-')); roots.push(handle.worktreePath);
}
async function execution(committed = true) {
  prepareContext(config);
  const frozen = await preregister({ ...scope(), runId: 'PRIVATE', suites: [], config, repoRoot });
  if (committed) commitProtocol(frozen.filePath, readFileSync(frozen.absFilePath, 'utf8'));
  const opts: CurrentSuBenchOptions = {
    workspaceId, runId: 'PRIVATE', armId: 'papercusp', seed: 1, agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto',
    preregistration: { preregHash: frozen.preregHash, config, repoRoot }, pollIntervalMs: 1, driveTimeoutMs: 100,
  };
  const admit = vi.fn(async () => ({ admitted: true, receiptRef: 'budget:private-fixture' }));
  // Unknown native identity stays unknown and cannot establish a verified
  // completion. These tests exercise protocol/SQL binding and that refusal;
  // actual native client/serving observation has its own acceptance clause.
  const controller = currentBenchGatewayController({ workspaceId, loopId: 'private-host-loop', token: 'a'.repeat(64),
    preregHash: frozen.preregHash, protocol: config, armId: opts.armId, taskId: 't1', seed: opts.seed,
    resources: { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50, usdPerArm: 3, maxOpenUsd: 3,
      wallClockMs: 1000, wallClockMsPerArm: 100,
      armIds: config.arms.map(a => currentBenchAssignmentId(config.runId, a.id, 't1', 1)) },
    authenticateProvider: async () => null });
  const hosted = await controller.startNativeGateway(() => {}, async () => ({ port: 32101, stop: async () => {} } as never));
  gateways.push(hosted);
  const ports = liveCurrentSuBenchPorts(ctx, { admit, observeIdentity: async () => null, ...hosted }, opts, scope());
  const lifecycle: BenchHarnessOps = {
    now: () => 0, createHarness: async () => handle,
    addFeature: async () => { await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, 'done')`; },
    driveToDone: async () => ({ disposition: 'error' }),
    collectCost: async () => ({ costUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0 }), teardown: async () => {},
  };
  native.launch.mockImplementation(async args => ({ data: { launch: { agentStarted: true, tasks: [{ taskId: 'private-native' }] } } }));
  native.kill.mockResolvedValue({ ok: true, taskId: 'private-native', action: 'kill' });
  const task = () => ({ taskId: 'private-native', workspaceId, state: 'running' as const, exitCode: null,
    detail: { label: native.launch.mock.calls[0][0].label } });
  const live = { ...ports, getTask: async () => task(), listTasks: async () => [task()] };
  return { opts, frozen, ports, admit, run: () => currentSuBenchHarnessDriver(lifecycle, live, opts).spinRunAndCost(request) };
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `currentbench_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE "${dbName}"`); await markManagedTestDatabase(admin, dbName); } finally { await admin.end({ timeout: 5 }); }
  const uri = new URL(adminUri); uri.pathname = `/${dbName}`;
  sql = postgres(uri.toString(), { max: 2, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.benchmark_prereg (
      prereg_hash text PRIMARY KEY, run_id text NOT NULL, workspace_id text NOT NULL,
      label text, suites jsonb NOT NULL DEFAULT '[]', config jsonb NOT NULL, file_path text NOT NULL,
      git_committed boolean NOT NULL DEFAULT false, git_commit_sha text, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, run_id));
    CREATE TABLE harness_shared.benchmark_run_result (run_id text, workspace_id text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.work_items (workspace_id text, harness_slug text, feature_id text, status text);
    CREATE TABLE harness_shared.carry_notes (workspace_id text, scope text, note text, journal jsonb, updated_ts bigint);
    CREATE TABLE harness_shared.coord_event_log (workspace_id text, surface text, msg_id text, ts timestamptz, harness_slug text, body jsonb);
    CREATE TABLE harness_shared.event_key_fires (workspace_id text, event_key text, first_fired_at timestamptz,
      last_fired_at timestamptz, last_fired_by text, last_payload jsonb, fire_count bigint,
      PRIMARY KEY (workspace_id, event_key));
    CREATE TABLE harness_shared.task_ledger (task_id text, workspace_id text, session_id text, detail jsonb,
      class text DEFAULT 'agent-session', state text DEFAULT 'exited', parent_task_id text,
      started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
    CREATE TABLE harness_shared.adv_sessions (id bigserial, workspace_id text, coord_owner_id text, session_id text,
      agent text, started_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.tool_invocations (id bigserial PRIMARY KEY, workspace_id text, harness_slug text,
      tool_name text, coord_owner_id text, invoked_at timestamptz, duration_ms int, status text,
      args_json jsonb, metadata_json jsonb, output_ref text, error_code text);
    CREATE TABLE harness_shared.runtime_vintage (workspace_id text, unit text, host text, tree_sha text,
      build_time timestamptz, bundle_version text, pid int, extra jsonb, reported_at timestamptz);
    CREATE TABLE harness_shared.interactive_usage_files (workspace_id text, file_path text, byte_offset bigint, parser_state jsonb);
    CREATE TABLE harness_shared.agent_usage_samples (id bigserial, workspace_id text, session_id text,
      usage_event_key text, usage_provenance jsonb, cost_source text, cost_usd numeric,
      identity_activation_event_id text, identity_owner_id text, identity_principal_id text,
      identity_specification_revision text, identity_state_revision text);
    CREATE VIEW harness_shared.agent_usage_samples_identity_attribution AS SELECT * FROM harness_shared.agent_usage_samples;`);
  await sql.unsafe('ALTER TABLE harness_shared.agent_usage_samples ADD COLUMN harness_slug text, ADD COLUMN run_id text, ADD COLUMN input_tokens bigint, ADD COLUMN output_tokens bigint');
  // Use the maintained benchmark persistence schema and real emission entry
  // point for grade-reader tests, rather than a hand-shaped grade receipt.
  await sql.unsafe('DROP TABLE harness_shared.benchmark_run_result');
  await sql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/291-benchmark-reproducibility.sql', import.meta.url), 'utf8')
    .split('\n').filter(line => !/^GRANT /.test(line)).join('\n'));
  await sql.unsafe('ALTER TABLE harness_shared.benchmark_run_result ADD COLUMN score double precision, ADD COLUMN fleet_run_id text');
  for (const name of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql']) {
    const body = readFileSync(new URL(`../../../../libs/papercusp/libs/db/sql/${name}`, import.meta.url), 'utf8')
      .split('\n').filter(line => !/\bGRANT\b|^\s*\\/.test(line)).join('\n');
    await sql.unsafe(body);
  }
  await sql.unsafe('ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text');
  await sql.unsafe('ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text');
  await sql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/296-bench-run-operational-store.sql', import.meta.url), 'utf8')
    .split('\n').filter(line => !/^GRANT /.test(line)).join('\n'));
  // Shared private side-store setup must run even when a focused selection
  // exercises provider composition without selecting the lock-grant describe.
  await sql.unsafe(`CREATE TABLE agent_lock_waiters (ticket_id uuid PRIMARY KEY, coordination_domain text,
    owner text, owner_label text, paths text[], intent text, goal_ref text, queued_ts timestamptz, wait_until timestamptz,
    status text, granted_lock_id uuid, granted_expires_ts timestamptz);
    CREATE TABLE agent_file_locks (coordination_domain text, path text, owner text, owner_label text,
    intent text, goal_ref text, lock_id uuid, acquired_ts timestamptz, expires_ts timestamptz,
    PRIMARY KEY (coordination_domain, path));`);
  // Canonical lifecycle fields from migration 696. Fail setup immediately if
  // this reduced private fixture cannot exercise the production timing read.
  await sql`SELECT started_at, ended_at FROM harness_shared.task_ledger LIMIT 0`;
}, 90_000);
beforeEach(async () => {
  goalAdmission.mockReset().mockResolvedValue({ allowed: true, goalId: null, reason: 'no-goal' });
  operationPolicy.mockReset().mockResolvedValue({ status: 'none' });
  operationAttestation.mockReset().mockResolvedValue(undefined);
  vi.clearAllMocks();
  hostHome.byId.clear();
  await sql`TRUNCATE agent_lock_waiters, agent_file_locks`;
  await sql`TRUNCATE harness_shared.bench_runs CASCADE`;
  await sql`TRUNCATE harness_shared.coord_event_log, harness_shared.carry_notes, harness_shared.event_key_fires, harness_shared.benchmark_prereg, harness_shared.benchmark_run_result, harness_shared.benchmark_rollout, harness_shared.work_items,
    harness_shared.task_ledger, harness_shared.adv_sessions, harness_shared.runtime_vintage,
    harness_shared.interactive_usage_files, harness_shared.agent_usage_samples, harness_shared.tool_invocations,
    harness_shared.learning_governor_loops, harness_shared.learning_spend_events, harness_shared.learning_spend_reservations`;
  repoRoot = mkdtempSync(join(tmpdir(), 'current-bench-protocol-')); roots.push(repoRoot);
});

let hostGateway: ReturnType<typeof createInferenceGateway> | undefined;

describe('private workload lock-grant authority', () => {
  const binding = { runId: 'private-lock-run', trialBindingHash: 'a'.repeat(64) };
  async function fixture() {
    const ticketId = randomUUID(), lockId = randomUUID(), ownerId = `private-lock-owner:${randomUUID()}`;
    const subjectId = 'private-lock-subject', ownerLabel = 'Private lock worker', intent = 'Private workload edit';
    const queued = new Date(Date.now() - 3000), acquired = new Date(queued.getTime() + 1000);
    const fired = new Date(queued.getTime() + 2000), expires = new Date(Date.now() + 60_000);
    const paths = ['src/a.ts', 'src/b.ts'], eventKey = `lock:grant:${ticketId}`;
    const receiptRef = `${eventKey}@${BigInt(queued.getTime()) * 1000n}#1`;
    const receipt = { receiptRef, subjectId, ticketId, lockId, ownerId, ownerLabel, intent,
      paths, queuedAt: queued.toISOString(), transitionId: 'private-lock-grant', index: 3 };
    const payload = { granted: true, ticket_id: ticketId, lock_id: lockId, paths, expires_ts: expires.toISOString() };
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, 'private-lock-harness', ${subjectId}, 'wip')`;
    await sql`INSERT INTO agent_lock_waiters VALUES (${ticketId}::uuid, ${repoRoot}, ${ownerId}, ${ownerLabel},
      ${paths}, ${intent}, ${subjectId}, ${queued}, ${expires}, 'granted', ${lockId}::uuid, ${expires})`;
    for (const path of paths) await sql`INSERT INTO agent_file_locks VALUES (${repoRoot}, ${path}, ${ownerId},
      ${ownerLabel}, ${intent}, ${subjectId}, ${lockId}::uuid, ${acquired}, ${expires})`;
    await sql`INSERT INTO harness_shared.event_key_fires VALUES (${workspaceId}, ${eventKey}, ${queued}, ${fired},
      'lock-grant-bridge', ${sql.json(payload)}, 1)`;
    return { receipt, payload, eventKey, options: { sql, locksSql: sql, workspaceId, harnessSlug: 'private-lock-harness',
      ...binding, coordinationDomain: repoRoot, notBefore: queued.toISOString(), receipts: [receipt] } };
  }
  it('binds the exact live full lock set, queued ticket and bridge fire without fabricating an invocation', async () => {
    const f = await fixture(), reader = currentBenchWorkloadLockGrantReader(f.options);
    const rows = await reader(f.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: 'tool-result', name: 'lock:grant', content: canonicalJson(f.payload),
      metadata: { ...binding, receiptRef: f.receipt.receiptRef,
        durableTransition: { id: 'private-lock-grant', from: 'waiting', to: 'granted' },
        lockGrantSource: { basis: 'live-private-lock-side-store-and-bridge', ownerId: f.receipt.ownerId,
          ticketId: f.receipt.ticketId, lockId: f.receipt.lockId, paths: f.receipt.paths } } });
    expect(rows?.[0].metadata).not.toHaveProperty('nativeToolSource');
    f.receipt.ownerId = 'candidate-owner'; f.receipt.paths.push('candidate.ts');
    expect(await reader(f.receipt.receiptRef, binding)).toEqual(rows);
    expect(await reader('candidate-ref', binding)).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, runId: 'foreign' })).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
  });
  it.each(['workspace', 'harness', 'subject', 'duplicate-subject', 'owner', 'label', 'domain', 'intent', 'goal',
    'queue-time', 'ticket-paths', 'ticket-status', 'ticket-lock', 'partial-release', 'full-release', 'expired',
    'lock-owner', 'lock-label', 'lock-intent', 'lock-goal', 'lock-extra-path', 'lock-expiry', 'late-acquire',
    'no-fire', 'fire-source', 'fire-count', 'fire-generation', 'fire-before-queue', 'payload-ticket',
    'payload-lock', 'payload-paths', 'payload-expiry', 'terminal-payload', 'replaced-root'])
  ('refuses %s substitution or stale grant', async fault => {
    const f = await fixture(), reader = currentBenchWorkloadLockGrantReader(f.options);
    if (fault === 'workspace') await sql`UPDATE harness_shared.work_items SET workspace_id = 'foreign'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign'`;
    if (fault === 'subject') await sql`UPDATE harness_shared.work_items SET feature_id = 'foreign'`;
    if (fault === 'duplicate-subject') await sql`INSERT INTO harness_shared.work_items SELECT * FROM harness_shared.work_items`;
    if (fault === 'owner') await sql`UPDATE agent_lock_waiters SET owner = 'foreign'`;
    if (fault === 'label') await sql`UPDATE agent_lock_waiters SET owner_label = 'foreign'`;
    if (fault === 'domain') await sql`UPDATE agent_lock_waiters SET coordination_domain = '/foreign'`;
    if (fault === 'intent') await sql`UPDATE agent_lock_waiters SET intent = 'foreign'`;
    if (fault === 'goal') await sql`UPDATE agent_lock_waiters SET goal_ref = 'foreign'`;
    if (fault === 'queue-time') await sql`UPDATE agent_lock_waiters SET queued_ts = queued_ts - interval '1 second'`;
    if (fault === 'ticket-paths') await sql`UPDATE agent_lock_waiters SET paths = ARRAY['foreign.ts']`;
    if (fault === 'ticket-status') await sql`UPDATE agent_lock_waiters SET status = 'waiting'`;
    if (fault === 'ticket-lock') await sql`UPDATE agent_lock_waiters SET granted_lock_id = ${randomUUID()}::uuid`;
    if (fault === 'partial-release') await sql`DELETE FROM agent_file_locks WHERE path = 'src/a.ts'`;
    if (fault === 'full-release') await sql`DELETE FROM agent_file_locks`;
    if (fault === 'expired') await sql`UPDATE agent_lock_waiters SET granted_expires_ts = clock_timestamp() - interval '1 second'`;
    if (fault === 'lock-owner') await sql`UPDATE agent_file_locks SET owner = 'foreign'`;
    if (fault === 'lock-label') await sql`UPDATE agent_file_locks SET owner_label = 'foreign'`;
    if (fault === 'lock-intent') await sql`UPDATE agent_file_locks SET intent = 'foreign'`;
    if (fault === 'lock-goal') await sql`UPDATE agent_file_locks SET goal_ref = 'foreign'`;
    if (fault === 'lock-extra-path') await sql`INSERT INTO agent_file_locks
      SELECT coordination_domain, 'src/extra.ts', owner, owner_label, intent, goal_ref, lock_id, acquired_ts, expires_ts
        FROM agent_file_locks LIMIT 1`;
    if (fault === 'lock-expiry') await sql`UPDATE agent_file_locks SET expires_ts = expires_ts + interval '1 second'`;
    if (fault === 'late-acquire') await sql`UPDATE agent_file_locks SET acquired_ts = clock_timestamp() + interval '10 seconds'`;
    if (fault === 'no-fire') await sql`TRUNCATE harness_shared.event_key_fires`;
    if (fault === 'fire-source') await sql`UPDATE harness_shared.event_key_fires SET last_fired_by = 'candidate'`;
    if (fault === 'fire-count') await sql`UPDATE harness_shared.event_key_fires SET fire_count = 2`;
    if (fault === 'fire-generation') await sql`UPDATE harness_shared.event_key_fires SET first_fired_at = first_fired_at + interval '1 second'`;
    if (fault === 'fire-before-queue') await sql`UPDATE harness_shared.event_key_fires SET last_fired_at = first_fired_at - interval '1 second'`;
    if (fault.startsWith('payload-') || fault === 'terminal-payload') {
      const payload = { ...f.payload };
      if (fault === 'payload-ticket') payload.ticket_id = randomUUID();
      if (fault === 'payload-lock') payload.lock_id = randomUUID();
      if (fault === 'payload-paths') payload.paths = ['src/foreign.ts'];
      if (fault === 'payload-expiry') payload.expires_ts = new Date(Date.now() + 120_000).toISOString();
      if (fault === 'terminal-payload') payload.granted = false;
      await sql`UPDATE harness_shared.event_key_fires SET last_payload = ${sql.json(payload)}`;
    }
    if (fault === 'replaced-root') {
      renameSync(repoRoot, `${repoRoot}-old`); roots.push(`${repoRoot}-old`); mkdirSync(repoRoot);
    }
    expect(await reader(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('refuses duplicate or unsafe host allocations and a symlink coordination domain', async () => {
    const f = await fixture();
    expect(() => currentBenchWorkloadLockGrantReader({ ...f.options, workspaceId: 'papercusp-workspace' })).toThrow(/PRODUCTION/);
    expect(() => currentBenchWorkloadLockGrantReader({ ...f.options, receipts: [f.receipt, f.receipt] })).toThrow(/unique exact/);
    expect(() => currentBenchWorkloadLockGrantReader({ ...f.options, receipts: [{ ...f.receipt, paths: ['../escape'] }] })).toThrow(/unique exact/);
    const linked = `${repoRoot}-link`; symlinkSync(repoRoot, linked); roots.push(linked);
    expect(() => currentBenchWorkloadLockGrantReader({ ...f.options, coordinationDomain: linked })).toThrow(/canonical private/);
  });

  async function stateFixture(phase: CurrentBenchLockStateAllocation['receipt']['phase'] = 'granted') {
    const f = await fixture();
    const holder = { ownerId: 'prior-private-holder', ownerLabel: 'Prior holder', intent: 'Hold private paths', lockId: randomUUID() };
    const waiter = { ownerId: f.receipt.ownerId, ownerLabel: f.receipt.ownerLabel, intent: f.receipt.intent,
      ticketId: f.receipt.ticketId, queuedAt: f.receipt.queuedAt, lockId: f.receipt.lockId };
    if (['held', 'contended', 'queued'].includes(phase)) await sql`UPDATE agent_file_locks
      SET owner = ${holder.ownerId}, owner_label = ${holder.ownerLabel}, intent = ${holder.intent}, lock_id = ${holder.lockId}::uuid`;
    if (['held', 'contended'].includes(phase)) await sql`DELETE FROM agent_lock_waiters`;
    if (phase === 'queued') await sql`UPDATE agent_lock_waiters SET status = 'waiting', granted_lock_id = NULL, granted_expires_ts = NULL`;
    if (phase === 'released') await sql`DELETE FROM agent_file_locks`;
    const allocation: CurrentBenchLockStateAllocation = { workspaceId, harnessSlug: f.options.harnessSlug, ...binding,
      coordinationDomain: repoRoot, notBefore: f.receipt.queuedAt,
      receipt: { receiptRef: `private-state:${phase}`, subjectId: f.receipt.subjectId, index: 4, phase,
        paths: f.receipt.paths, holder, waiter } };
    const protocol = currentProtocolFixture(binding.runId), arm = protocol.arms.find(row => row.id === 'papercusp')!;
    const input: CurrentTaskInput = { options: { workspaceId, runId: binding.runId, armId: arm.id, seed: 1,
      agent: 'codex', model: arm.model, effort: 'high', account: arm.account,
      preregistration: { preregHash: 'b'.repeat(64), config: protocol } }, protocol,
      task: request.task as CurrentTaskInput['task'], scope: { sql, workspaceId },
      context: { workspaceId, principal: { slug: 'private-host' } } as CurrentTaskInput['context'],
      resources: {} as CurrentTaskInput['resources'], loopId: 'private-lock-state-loop', hostRunId: 'private-lock-state-host',
      checkout: { dir: repoRoot, repo: 'fixture', baseCommit: 'a'.repeat(40), cleanup: async () => {} },
      observation: { runtimeWorkspaceId: 'private-runtime', workerUnit: 'worker', gatewayUnit: 'gateway' } };
    await sql`INSERT INTO harness_shared.bench_runs (id, workspace_id, arm, task_set_id, model, status, config)
      VALUES (${input.hostRunId}, ${workspaceId}, 'papercusp', 'custom', ${arm.model}, 'running',
        ${JSON.stringify({ current: { preregHash: 'b'.repeat(64) }, protocol, loopId: input.loopId })}::text::jsonb)`;
    return { ...f, allocation, input, reader: currentBenchWorkloadLockStateReader({ ...allocation, sql, locksSql: sql }) };
  }
  it.each(['held', 'contended', 'queued', 'granted', 'released'] as const)
  ('private lock-state capture samples %s without claiming native causality or provider consumption', async phase => {
    const f = await stateFixture(phase), rows = await f.reader(f.allocation.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ name: `lock:state:${phase}`, metadata: { ...binding,
      lockStateSource: { basis: 'live-private-lock-side-store', phase, coordinationDomain: repoRoot } } });
    const body = JSON.parse(rows![0].content!);
    expect(body.locks).toHaveLength(phase === 'released' ? 0 : 2);
    expect(body.waiters).toHaveLength(['held', 'contended'].includes(phase) ? 0 : 1);
    expect(rows![0].metadata).not.toHaveProperty('durableTransition');
    expect(rows![0].metadata).not.toHaveProperty('nativeToolSource');
    expect(rows![0].metadata).not.toHaveProperty('providerInputSource');
  });
  it.each(['foreign-owner', 'extra-path', 'expired', 'wrong-ticket', 'queue-time', 'partial-release', 'foreign-subject', 'future-start'])
  ('private lock-state capture refuses %s state substitution', async fault => {
    const f = await stateFixture();
    if (fault === 'foreign-owner') await sql`UPDATE agent_file_locks SET owner = 'foreign'`;
    if (fault === 'extra-path') await sql`INSERT INTO agent_file_locks SELECT coordination_domain, 'src/extra.ts', owner,
      owner_label, intent, goal_ref, lock_id, acquired_ts, expires_ts FROM agent_file_locks LIMIT 1`;
    if (fault === 'expired') await sql`UPDATE agent_file_locks SET expires_ts = clock_timestamp() - interval '1 second'`;
    if (fault === 'wrong-ticket') await sql`UPDATE agent_lock_waiters SET ticket_id = ${randomUUID()}::uuid`;
    if (fault === 'queue-time') await sql`UPDATE agent_lock_waiters SET queued_ts = queued_ts - interval '1 second'`;
    if (fault === 'partial-release') await sql`DELETE FROM agent_file_locks WHERE path = 'src/a.ts'`;
    if (fault === 'foreign-subject') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign'`;
    if (fault === 'future-start') f.allocation.notBefore = new Date(Date.now() + 10000).toISOString();
    const reader = fault === 'future-start' ? currentBenchWorkloadLockStateReader({ ...f.allocation,
      receipt: { ...f.allocation.receipt, waiter: { ...f.allocation.receipt.waiter!, queuedAt: f.allocation.notBefore } }, sql, locksSql: sql }) : f.reader;
    expect(await reader(f.allocation.receipt.receiptRef, binding)).toBeNull();
  });
  it('private lock-state capture freezes bytes before release and retains read-only evidence after checkout cleanup', async () => {
    const f = await stateFixture(), pin = await freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql });
    const reader = currentBenchTaskLockStateReader(f.input, { receiptRef: pin.allocation.receipt.receiptRef,
      observationSha256: pin.observationSha256, trialBindingHash: binding.trialBindingHash });
    await sql`DELETE FROM agent_file_locks`; await sql`UPDATE agent_lock_waiters SET status = 'cancelled'`;
    expect(await freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql })).toEqual(pin);
    const [before] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    rmSync(repoRoot, { recursive: true, force: true });
    const observed = await reader(pin.allocation.receipt.receiptRef, binding);
    expect(observed).toEqual([pin.observation]);
    observed![0].content = 'caller mutation';
    expect(await reader(pin.allocation.receipt.receiptRef, binding)).toEqual([pin.observation]);
    expect((await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`)[0]).toEqual(before);
    expect(await reader('candidate-ref', binding)).toBeNull();
  });
  it('private lock-state capture refuses an expired queued ticket even while the holder remains live', async () => {
    const f = await stateFixture('queued');
    await sql`UPDATE agent_lock_waiters SET wait_until = clock_timestamp() - interval '1 second'`;
    expect(await f.reader(f.allocation.receipt.receiptRef, binding)).toBeNull();
  });
  it.each(['observation', 'protocol', 'preregistration', 'loop', 'hash'])
  ('private lock-state capture historical reader refuses %s checkpoint drift', async fault => {
    const f = await stateFixture(), pin = await freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql });
    const reader = currentBenchTaskLockStateReader(f.input, { receiptRef: pin.allocation.receipt.receiptRef,
      observationSha256: pin.observationSha256, trialBindingHash: binding.trialBindingHash });
    const path = fault === 'protocol' ? ['protocol'] : fault === 'preregistration' ? ['current', 'preregHash'] :
      fault === 'loop' ? ['loopId'] : ['workloadLockStates', currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1),
        pin.allocation.receipt.receiptRef, fault === 'hash' ? 'observationSha256' : 'observation', ...(fault === 'observation' ? ['content'] : [])];
    await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, ${path}::text[], '"changed"'::jsonb)`;
    expect(await reader(pin.allocation.receipt.receiptRef, binding)).toBeNull();
  });
  it('private lock-state capture serializes independent pins and refuses changed allocation or duplicate indices', async () => {
    const f = await stateFixture();
    const second = structuredClone(f.allocation); second.receipt.receiptRef += ':second'; second.receipt.index++;
    const pins = await Promise.all([freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql }),
      freezeCurrentBenchTaskLockState(f.input, second, { locksSql: sql })]);
    const [row] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    expect(Object.keys(row.config.workloadLockStates[currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1)])).toHaveLength(2);
    const changed = structuredClone(f.allocation); changed.receipt.holder.ownerId = 'changed';
    await expect(freezeCurrentBenchTaskLockState(f.input, changed, { locksSql: sql })).rejects.toThrow(/changed after/);
    changed.receipt.receiptRef = 'third'; changed.receipt.index = pins[1].observation.index;
    await expect(freezeCurrentBenchTaskLockState(f.input, changed, { locksSql: sql })).rejects.toThrow(/unique observation/);
  });

  async function frozenGrantFixture() {
    const f = await stateFixture();
    const grant = { receiptRef: f.receipt.receiptRef, transitionId: f.receipt.transitionId, index: f.receipt.index };
    const pin = await freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql, grant });
    const selection = { receiptRef: pin.allocation.receipt.receiptRef, observationSha256: pin.observationSha256,
      trialBindingHash: binding.trialBindingHash, lockGrant: { receiptRef: grant.receiptRef,
        observationSha256: pin.lockGrant!.observationSha256,
        allocationSha256: createHash('sha256').update(canonicalJson(pin.lockGrant!.allocation)).digest('hex') } };
    return { ...f, grant, pin, selection, reader: currentBenchTaskLockStateReader(f.input, selection) };
  }
  it('private lock-state grant freezes the independent live bridge before release and reads it after checkout cleanup', async () => {
    const f = await frozenGrantFixture();
    expect(f.pin.lockGrant?.observation).toMatchObject({ name: 'lock:grant', content: canonicalJson(f.payload),
      metadata: { durableTransition: { from: 'waiting', to: 'granted' },
        lockGrantSource: { rootDevice: (f.pin.observation.metadata?.lockStateSource as Record<string, unknown>).rootDevice,
          rootInode: (f.pin.observation.metadata?.lockStateSource as Record<string, unknown>).rootInode } } });
    await sql`DELETE FROM agent_file_locks`;
    await sql`UPDATE agent_lock_waiters SET status = 'released'`;
    await sql`UPDATE harness_shared.event_key_fires SET fire_count = 2, last_payload = '{}'::jsonb`;
    await sql`UPDATE harness_shared.bench_runs SET status = 'done'`;
    rmSync(repoRoot, { recursive: true, force: true });
    const before = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    const rows = await f.reader(f.selection.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows![0].content).toBe(f.pin.observation.content);
    expect(rows![0].metadata?.lockGrantCorrelation).toMatchObject({
      basis: 'host-frozen-lock-state-and-bridge-grant', grantObservation: f.pin.lockGrant!.observation });
    for (const field of ['durableTransition', 'nativeToolSource', 'providerInputSource', 'lockStateCorrelation'])
      expect(rows![0].metadata).not.toHaveProperty(field);
    expect(await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`).toEqual(before);
    expect(await f.reader(f.grant.receiptRef, binding)).toBeNull();
    expect(await f.reader(f.selection.receiptRef, { ...binding, runId: 'other-arm' })).toBeNull();
    expect(await f.reader(f.selection.receiptRef, { ...binding, trialBindingHash: 'c'.repeat(64) })).toBeNull();
  });
  it('private lock-state grant keeps immutable selection and refuses retargeting an existing state pin', async () => {
    const f = await frozenGrantFixture();
    const rows = await f.reader(f.selection.receiptRef, binding);
    f.selection.lockGrant.receiptRef = 'candidate-receipt';
    f.selection.lockGrant.observationSha256 = 'c'.repeat(64);
    expect(await f.reader(f.pin.allocation.receipt.receiptRef, binding)).toEqual(rows);
    expect(await freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql, grant: f.grant })).toEqual(f.pin);
    await expect(freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql })).rejects.toThrow(/changed after/);
    await expect(freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql,
      grant: { ...f.grant, transitionId: 'different-transition' } })).rejects.toThrow(/changed after/);
  });
  it.each(['missing-fire', 'wrong-source', 'wrong-payload', 'wrong-grantee', 'after-state'])
  ('private lock-state grant refuses %s live authority and leaves no partial host pin', async fault => {
    const f = await stateFixture();
    if (fault === 'missing-fire') await sql`DELETE FROM harness_shared.event_key_fires`;
    if (fault === 'wrong-source') await sql`UPDATE harness_shared.event_key_fires SET last_fired_by = 'candidate'`;
    if (fault === 'wrong-payload') await sql`UPDATE harness_shared.event_key_fires SET last_payload = '{}'::jsonb`;
    if (fault === 'wrong-grantee') await sql`UPDATE agent_file_locks SET owner = 'other-arm'`;
    if (fault === 'after-state') await sql`UPDATE harness_shared.event_key_fires SET last_fired_at = clock_timestamp() + interval '10 seconds'`;
    await expect(freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql,
      grant: { receiptRef: f.receipt.receiptRef, transitionId: f.receipt.transitionId, index: f.receipt.index } })).rejects.toThrow(/could not verify/);
    const [row] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    expect(row.config).not.toHaveProperty('workloadLockStates');
  });
  it.each(['grant-bytes', 'grant-hash', 'allocation', 'state-bytes', 'slot', 'protocol', 'preregistration', 'loop'])
  ('private lock-state grant refuses %s historical pin substitution', async fault => {
    const f = await frozenGrantFixture();
    const prefix = ['workloadLockStates', currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1), f.selection.receiptRef];
    const path = fault === 'protocol' ? ['protocol'] : fault === 'preregistration' ? ['current', 'preregHash'] :
      fault === 'loop' ? ['loopId'] : fault === 'slot' ? prefix : fault === 'state-bytes' ? [...prefix, 'observation', 'content'] :
      [...prefix, 'lockGrant', ...(fault === 'grant-bytes' ? ['observation', 'content'] :
        fault === 'grant-hash' ? ['observationSha256'] : ['allocation', 'coordinationDomain'])];
    await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, ${path}::text[], '"changed"'::jsonb)`;
    expect(await f.reader(f.selection.receiptRef, binding)).toBeNull();
  });
  it.each(['receipt', 'observation-hash', 'allocation-hash'])
  ('private lock-state grant refuses borrowed %s selection', async fault => {
    const f = await frozenGrantFixture(), selected = structuredClone(f.selection);
    if (fault === 'receipt') selected.lockGrant.receiptRef = 'other-grant';
    if (fault === 'observation-hash') selected.lockGrant.observationSha256 = 'c'.repeat(64);
    if (fault === 'allocation-hash') selected.lockGrant.allocationSha256 = 'c'.repeat(64);
    expect(await currentBenchTaskLockStateReader(f.input, selected)(selected.receiptRef, binding)).toBeNull();
  });
  it('private lock-state grant refuses another root instance even when its bridge bytes have a valid selected hash', async () => {
    const f = await frozenGrantFixture(), grant = structuredClone(f.pin.lockGrant!);
    (grant.observation.metadata!.lockGrantSource as Record<string, unknown>).rootInode = 'other-root-inode';
    grant.observationSha256 = createHash('sha256').update(canonicalJson(grant.observation)).digest('hex');
    const selected = structuredClone(f.selection); selected.lockGrant.observationSha256 = grant.observationSha256;
    const path = ['workloadLockStates', currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1),
      selected.receiptRef, 'lockGrant'];
    await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, ${path}::text[], ${JSON.stringify(grant)}::text::jsonb)`;
    expect(await currentBenchTaskLockStateReader(f.input, selected)(selected.receiptRef, binding)).toBeNull();
  });
  it('private lock-state grant requires granted state and distinct exact pins before capture', async () => {
    const f = await stateFixture('queued'), grant = { receiptRef: f.receipt.receiptRef, transitionId: f.receipt.transitionId,
      index: f.receipt.index };
    await expect(freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql, grant })).rejects.toThrow(/distinct exact bridge/);
    expect(() => currentBenchTaskLockStateReader(f.input, { receiptRef: f.allocation.receipt.receiptRef,
      observationSha256: 'a'.repeat(64), trialBindingHash: binding.trialBindingHash,
      lockGrant: { receiptRef: f.allocation.receipt.receiptRef, observationSha256: 'a'.repeat(64), allocationSha256: 'b'.repeat(64) } })).toThrow(/exact separate/);
    expect(() => currentBenchTaskLockStateReader(f.input, { receiptRef: f.allocation.receipt.receiptRef,
      observationSha256: 'a'.repeat(64), trialBindingHash: binding.trialBindingHash,
      lockGrant: { receiptRef: f.receipt.receiptRef, observationSha256: 'invalid', allocationSha256: 'b'.repeat(64) } })).toThrow(/exact separate/);
  });

  async function correlationFixture(operation: 'locks:acquire' | 'locks:release' = 'locks:acquire', wrapper = false) {
    const f = await stateFixture('held'), n = await workloadToolResultFixture(binding);
    const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
    n.receipt.subjectId = f.receipt.subjectId;
    f.allocation.receipt.index = 1;
    if (operation === 'locks:release') {
      delete f.allocation.receipt.waiter;
      f.allocation.receipt.holder.ownerId = n.receipt.ownerId;
      await sql`UPDATE agent_file_locks SET owner = ${n.receipt.ownerId}`;
    } else f.allocation.receipt.waiter!.ownerId = n.receipt.ownerId;
    const before = await freezeCurrentBenchTaskLockState(f.input, f.allocation, { locksSql: sql });
    const afterAllocation = structuredClone(f.allocation);
    afterAllocation.receipt.receiptRef = 'private-state:after'; afterAllocation.receipt.index = 3;
    afterAllocation.receipt.phase = operation === 'locks:release' ? 'released' : 'contended';
    if (operation === 'locks:release') await sql`DELETE FROM agent_file_locks`;
    const after = await freezeCurrentBenchTaskLockState(f.input, afterAllocation, { locksSql: sql });
    const args = operation === 'locks:release' ? { lock_id: f.allocation.receipt.holder.lockId, coordination_domain: repoRoot } :
      { paths: f.allocation.receipt.paths, intent: f.allocation.receipt.waiter!.intent, coordination_domain: repoRoot };
    const records = n.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
    records[2].timestamp = records[3].timestamp = before.observation.at;
    const argumentsText = wrapper ? 'text(await tools.mcp__papercusp_su__locks_acquire(selected));' : canonicalJson(args);
    Object.assign(records[2].payload, { namespace: wrapper ? 'functions' : 'mcp',
      name: wrapper ? 'exec' : operation === 'locks:release' ? 'locks_release' : 'locks_acquire', arguments: argumentsText });
    const transcript = records.map(row => JSON.stringify(row) + '\n').join('');
    const [source] = await sql`SELECT file_path FROM harness_shared.interactive_usage_files`;
    writeFileSync(source.file_path, transcript);
    await sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = ${Buffer.byteLength(transcript)}`;
    const at = new Date(before.observation.at!), started = new Date(at.getTime() - 1000), ended = new Date(at.getTime() + 1000);
    await sql`UPDATE harness_shared.task_ledger SET started_at = ${started}, ended_at = ${ended}`;
    await sql`UPDATE harness_shared.adv_sessions SET started_at = ${started}`;
    const [adv] = await sql`SELECT id FROM harness_shared.adv_sessions`;
    const metadata = { requestOrigin: { transport: 'mcp', mcpRequestTraceId: 'private-state-trace', nativeSession: {
      carrier: 'meta:threadId', binding: 'bound', candidateAdvSessionId: Number(adv.id),
      valueFingerprint: fingerprint(n.receipt.nativeSessionId), callIdFingerprint: fingerprint(n.receipt.callId) } } };
    const [invocation] = await sql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, tool_name, coord_owner_id, invoked_at, duration_ms, status, args_json, metadata_json)
      VALUES (${workspaceId}, ${f.allocation.harnessSlug}, ${operation}, ${n.receipt.ownerId}, ${at}, 0, 'ok',
        ${JSON.stringify(args)}::text::jsonb, ${JSON.stringify(metadata)}::text::jsonb) RETURNING id`;
    const dispatch = { invocationId: String(invocation.id), requestTraceId: 'private-state-trace', toolName: operation,
      argumentsSha256: hash(args), invocationSha256: '' };
    async function repinDispatch() {
      const [row] = await sql`SELECT to_jsonb(invocation) AS invocation FROM harness_shared.tool_invocations invocation`;
      dispatch.invocationSha256 = hash(row.invocation);
    }
    await repinDispatch();
    const receipt = { ...n.receipt, index: 2, toolName: wrapper ? 'functions.exec' : operation === 'locks:release' ? 'mcp.locks_release' : 'mcp.locks_acquire',
      sourceSha256: fingerprint(transcript), argumentsSha256: fingerprint(argumentsText), dispatch };
    const selection = { receiptRef: after.allocation.receipt.receiptRef, observationSha256: after.observationSha256,
      trialBindingHash: binding.trialBindingHash, nativeCorrelation: { operation, receipt,
        allocationSha256: hash(after.allocation), before: { receiptRef: before.allocation.receipt.receiptRef,
          observationSha256: before.observationSha256, allocationSha256: hash(before.allocation) } } };
    async function repinStates() {
      before.observationSha256 = hash(before.observation); after.observationSha256 = hash(after.observation);
      selection.observationSha256 = after.observationSha256;
      selection.nativeCorrelation.allocationSha256 = hash(after.allocation);
      selection.nativeCorrelation.before.observationSha256 = before.observationSha256;
      selection.nativeCorrelation.before.allocationSha256 = hash(before.allocation);
      const key = currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1);
      await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, ${['workloadLockStates', key]}::text[],
        ${JSON.stringify({ [before.allocation.receipt.receiptRef]: before, [after.allocation.receipt.receiptRef]: after })}::text::jsonb)`;
    }
    return { ...f, before, after, selection, args, hash, repinStates, repinDispatch };
  }
  it.each([['locks:acquire', false], ['locks:acquire', true], ['locks:release', false]] as const)
  ('private lock-state correlation pairs %s wrapper=%s while preserving separate authority', async (operation, wrapper) => {
    const f = await correlationFixture(operation, wrapper), reader = currentBenchTaskLockStateReader(f.input, f.selection);
    await sql`DELETE FROM agent_file_locks`; await sql`DELETE FROM agent_lock_waiters`;
    rmSync(repoRoot, { recursive: true, force: true });
    const [before] = await sql`SELECT config FROM harness_shared.bench_runs`;
    const rows = await reader(f.selection.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ content: f.after.observation.content, metadata: {
      lockStateCorrelation: { basis: 'host-frozen-samples-and-native-dispatch', operation,
        before: { observationSha256: f.before.observationSha256, observation: f.before.observation },
        nativeObservation: { name: f.selection.nativeCorrelation.receipt.toolName,
          metadata: { platformInvocationSource: { status: 'ok', toolName: operation } } } } } });
    // An ok dispatch, contended state and fixture output are not business success/denial or causality.
    expect(rows?.[0].metadata).not.toHaveProperty('durableTransition');
    expect(rows?.[0].metadata).not.toHaveProperty('nativeToolSource');
    expect(rows?.[0].metadata).not.toHaveProperty('providerInputSource');
    f.selection.nativeCorrelation.receipt.ownerId = 'candidate';
    expect(await reader(f.selection.receiptRef, binding)).toEqual(rows);
    expect((await sql`SELECT config FROM harness_shared.bench_runs`)[0]).toEqual(before);
  });
  it.each(['before-hash', 'after-hash', 'allocation-hash', 'subject', 'actor', 'path', 'inode', 'device',
    'before-time', 'after-time', 'index', 'dispatch-domain', 'dispatch-intent', 'dispatch-path', 'native-pin', 'missing-before'])
  ('private lock-state correlation refuses %s borrowing even with repinned structural changes', async fault => {
    const f = await correlationFixture();
    if (fault === 'subject') f.after.allocation.receipt.subjectId = 'foreign';
    if (fault === 'actor') f.after.allocation.receipt.waiter!.ownerId = 'foreign';
    if (fault === 'path') f.after.allocation.receipt.paths = ['foreign.ts'];
    if (fault === 'inode' || fault === 'device') {
      const source = f.after.observation.metadata!.lockStateSource as Record<string, unknown>;
      source[fault === 'inode' ? 'rootInode' : 'rootDevice'] = 'foreign';
    }
    if (fault === 'before-time') f.before.observation.at = new Date(Date.parse(f.after.observation.at!) + 1000).toISOString();
    if (fault === 'after-time') f.after.observation.at = new Date(Date.parse(f.before.observation.at!) - 1000).toISOString();
    if (fault === 'index') f.before.observation.index = f.before.allocation.receipt.index = 2;
    await f.repinStates();
    if (fault === 'before-hash') f.selection.nativeCorrelation.before.observationSha256 = 'b'.repeat(64);
    if (fault === 'after-hash') f.selection.observationSha256 = 'b'.repeat(64);
    if (fault === 'allocation-hash') f.selection.nativeCorrelation.allocationSha256 = 'b'.repeat(64);
    if (fault === 'native-pin') f.selection.nativeCorrelation.receipt.sourceSha256 = 'b'.repeat(64);
    if (fault === 'missing-before') await sql`UPDATE harness_shared.bench_runs SET config = config #-
      ${['workloadLockStates', currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1), f.before.allocation.receipt.receiptRef]}::text[]`;
    if (fault.startsWith('dispatch-')) {
      const args = { ...f.args } as Record<string, unknown>;
      if (fault === 'dispatch-domain') args.coordination_domain = '/foreign';
      if (fault === 'dispatch-intent') args.intent = 'foreign';
      if (fault === 'dispatch-path') args.paths = ['foreign.ts'];
      await sql`UPDATE harness_shared.tool_invocations SET args_json = ${JSON.stringify(args)}::text::jsonb`;
      f.selection.nativeCorrelation.receipt.dispatch.argumentsSha256 = f.hash(args);
      await f.repinDispatch();
    }
    expect(await currentBenchTaskLockStateReader(f.input, f.selection)(f.selection.receiptRef, binding)).toBeNull();
  });
  it('private lock-state correlation requires distinct samples and a selected dispatch before reads', async () => {
    const f = await correlationFixture();
    f.selection.nativeCorrelation.before.receiptRef = f.selection.receiptRef;
    expect(() => currentBenchTaskLockStateReader(f.input, f.selection)).toThrow(/distinct pinned/);
    f.selection.nativeCorrelation.before.receiptRef = f.before.allocation.receipt.receiptRef;
    f.selection.nativeCorrelation.receipt.dispatch.toolName = 'locks:release';
    expect(() => currentBenchTaskLockStateReader(f.input, f.selection)).toThrow(/exact native dispatch/);
  });
});

describe('private workload status authority', () => {
  const eventKey = 'work-item:status:private-dependency';
  const receiptRef = `${eventKey}@1791676800000000#1`;
  const binding = { runId: 'private-workload-run', trialBindingHash: 'a'.repeat(64) };
  const payload = { id: 'private-dependency', harness: 'private-workload-harness', prevState: 'wip', state: 'done' };
  const options = () => ({ sql, workspaceId, harnessSlug: payload.harness, ...binding,
    notBefore: '2026-10-11T00:00:00Z',
    receipts: [{ receiptRef, subjectId: payload.id, transitionId: 'dependency-complete', index: 2 }] });
  async function populate() {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${payload.harness}, ${payload.id}, 'done')`;
    await sql`INSERT INTO harness_shared.event_key_fires VALUES (${workspaceId}, ${eventKey},
      '2026-10-11T00:00:00Z', '2026-10-11T00:00:01Z', 'work-items', ${sql.json(payload)}, 1)`;
  }
  it('projects the independently stored before/after edge with the exact fire identity', async () => {
    await populate();
    expect(await currentBenchWorkloadTransitionReader(options())(receiptRef, binding)).toEqual([
      { index: 2, kind: 'tool-result', name: 'work-item:status', at: '2026-10-11T00:00:01.000Z',
        content: JSON.stringify({ harness: payload.harness, id: payload.id, prevState: 'wip', state: 'done' }),
        metadata: { ...binding, receiptRef, durableTransition: { id: 'dependency-complete',
          subjectRef: 'work-item:private-workload-harness:private-dependency', from: 'wip', to: 'done' } } },
    ]);
  });
  it('does not treat a done item without its status receipt as an observed edge', async () => {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${payload.harness}, ${payload.id}, 'done')`;
    expect(await currentBenchWorkloadTransitionReader(options())(receiptRef, binding)).toBeNull();
  });
  it.each(['workspace', 'harness', 'subject', 'source', 'count', 'generation', 'old', 'payload-harness', 'no-edge'])
  ('rejects %s authority substitution', async fault => {
    await populate();
    if (fault === 'workspace') await sql`UPDATE harness_shared.event_key_fires SET workspace_id = 'foreign-workspace'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign-harness'`;
    if (fault === 'subject') await sql`UPDATE harness_shared.event_key_fires SET last_payload = ${sql.json({ ...payload, id: 'foreign-subject' })}`;
    if (fault === 'source') await sql`UPDATE harness_shared.event_key_fires SET last_fired_by = 'candidate'`;
    if (fault === 'count') await sql`UPDATE harness_shared.event_key_fires SET fire_count = 2`;
    if (fault === 'generation') await sql`UPDATE harness_shared.event_key_fires SET first_fired_at = first_fired_at + interval '1 microsecond'`;
    if (fault === 'old') await sql`UPDATE harness_shared.event_key_fires SET last_fired_at = '2026-10-10T23:59:59Z'`;
    if (fault === 'payload-harness') await sql`UPDATE harness_shared.event_key_fires SET last_payload = ${sql.json({ ...payload, harness: 'foreign-harness' })}`;
    if (fault === 'no-edge') await sql`UPDATE harness_shared.event_key_fires SET last_payload = ${sql.json({ ...payload, prevState: 'done' })}`;
    expect(await currentBenchWorkloadTransitionReader(options())(receiptRef, binding)).toBeNull();
  });
  it('keeps host allocation fixed and refuses foreign bindings and unallocated refs', async () => {
    await populate();
    const allocation = options(), reader = currentBenchWorkloadTransitionReader(allocation);
    allocation.harnessSlug = 'foreign-harness'; allocation.receipts[0].index = 99;
    expect((await reader(receiptRef, binding))?.[0].index).toBe(2);
    expect(await reader(receiptRef, { ...binding, runId: 'another-run' })).toBeNull();
    expect(await reader(receiptRef, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    expect(await reader('candidate-chosen-ref', binding)).toBeNull();
  });
  it('refuses production allocation and ambiguous receipt mappings before reading', () => {
    expect(() => currentBenchWorkloadTransitionReader({ ...options(), workspaceId: 'papercusp-workspace' })).toThrow(/PRODUCTION/);
    expect(() => currentBenchWorkloadTransitionReader({ ...options(), receipts: [...options().receipts, ...options().receipts] })).toThrow(/unique exact receipts/);
  });
});

describe('private workload stored grade authority', () => {
  const binding = { runId: 'private-grade-run', trialBindingHash: 'a'.repeat(64) };
  const harnessSlug = 'private-grade-harness', subjectId = 'private-grade-subject';
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  async function fixture(resolved = true) {
    const protocol = currentProtocolFixture(binding.runId), preregHash = computePreregHash(protocol);
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${harnessSlug}, ${subjectId}, 'done')`;
    await sql`INSERT INTO harness_shared.benchmark_prereg
      (prereg_hash, run_id, workspace_id, config, suites, file_path, git_committed, git_commit_sha, created_at)
      VALUES (${preregHash}, ${binding.runId}, ${workspaceId}, ${JSON.stringify(protocol)}::text::jsonb,
        '["swe-bench-pro"]'::jsonb, 'fixture-prereg.json', true, ${'1'.repeat(40)}, '2026-10-10T23:00:00Z')`;
    const submission = 'private graded submission π\n', rawOutput = canonicalJson({ resolved });
    const input = { ...binding, preregHash, suite: 'swe-bench-pro' as const, modality: 'diff' as const,
      taskId: 't1', arm: 'papercusp' as const, seed: 1,
      generation: { status: 'completed' as const, tokensIn: 1, tokensOut: 1, tokensTotal: 2,
        wallClockMs: 1, modelId: protocol.arms[0].model, harnessVersion: 'private-harness', submission },
      grading: { resolved, status: resolved ? 'passed' as const : 'failed' as const,
        family: protocol.grader.family, version: protocol.grader.version, rawOutput },
      provenance: { configSnapshot: { ...protocol } } };
    await emitRollout(input, { sql, workspaceId });
    const rolloutId = rolloutIdFor(binding.runId, input.suite, input.taskId, input.arm, input.seed);
    const receipt = { receiptRef: 'grade:private', subjectId, rolloutId, taskId: input.taskId, arm: input.arm, seed: 1,
      index: 8, outcomeId: 'answer-correctness', graderRef: 'benchmark-grader:official@pinned',
      resultSha256: '', rolloutSha256: '', submissionSha256: sha(submission), rawGraderOutputSha256: sha(rawOutput) };
    const options = { sql, workspaceId, harnessSlug, ...binding, notBefore: '2026-10-11T00:00:00Z',
      preregHash, protocol, receipts: [receipt] };
    const pin = async () => {
      const [r] = await sql`SELECT to_jsonb(result) AS result, to_jsonb(rollout) AS rollout
        FROM harness_shared.benchmark_run_result result JOIN harness_shared.benchmark_rollout rollout USING (rollout_id)`;
      receipt.resultSha256 = sha(canonicalJson(r.result)); receipt.rolloutSha256 = sha(canonicalJson(r.rollout));
    };
    await pin();
    return { input, options, receipt, pin };
  }
  it.each([true, false])('resolves actual emitted grade bytes, including resolved=%s', async resolved => {
    const f = await fixture(resolved);
    const [stored] = await sql`SELECT to_jsonb(result) AS result, to_jsonb(rollout) AS rollout, to_jsonb(prereg) AS prereg
      FROM harness_shared.benchmark_run_result result
      JOIN harness_shared.benchmark_rollout rollout USING (rollout_id)
      JOIN harness_shared.benchmark_prereg prereg ON prereg.prereg_hash = result.prereg_hash`;
    const decode = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
    const result = decode(stored.result), rollout = decode(stored.rollout), prereg = decode(stored.prereg);
    // Keep fixture/emission failures distinguishable from reader refusals.
    expect(f.receipt.resultSha256, `result JSON transport type: ${typeof stored.result}`).toBe(sha(canonicalJson(result)));
    expect(f.receipt.rolloutSha256, `rollout JSON transport type: ${typeof stored.rollout}`).toBe(sha(canonicalJson(rollout)));
    const identity = { workspace_id: workspaceId, run_id: binding.runId, rollout_id: f.receipt.rolloutId,
      prereg_hash: f.options.preregHash, suite: f.input.suite, task_id: f.input.taskId, arm: f.input.arm,
      seed: f.input.seed, model_id: f.input.generation.modelId, harness_version: f.input.generation.harnessVersion,
      grader_family: f.input.grading.family, grader_version: f.input.grading.version };
    expect(result).toMatchObject({ ...identity, generation_status: 'completed', generation_error: null, resolved,
      grader_status: resolved ? 'passed' : 'failed', submission_ref: `rollout:${f.receipt.rolloutId}#submission`,
      raw_grader_output_ref: `rollout:${f.receipt.rolloutId}#grader` });
    expect(rollout).toMatchObject({ ...identity, submission: f.input.generation.submission,
      raw_grader_output: f.input.grading.rawOutput, config_snapshot: f.options.protocol });
    expect(prereg).toMatchObject({ workspace_id: workspaceId, run_id: binding.runId,
      prereg_hash: f.options.preregHash, suites: [f.input.suite], config: f.options.protocol,
      git_committed: true, git_commit_sha: '1'.repeat(40) });
    expect(sha(canonicalJson(prereg.config))).toBe(f.options.preregHash);
    expect(Date.parse(String(prereg.created_at))).toBeLessThan(Date.parse(f.options.notBefore));
    for (const row of [result, rollout]) expect(Date.parse(String(row.created_at))).toBeGreaterThanOrEqual(Date.parse(f.options.notBefore));
    const rows = await currentBenchWorkloadGradeReader(f.options)(f.receipt.receiptRef, binding);
    expect(rows?.[0]).toMatchObject({ index: 8, kind: 'tool-result', name: 'benchmark:grade',
      metadata: { ...binding, workloadOutcome: { id: 'answer-correctness', value: resolved,
        graderRef: f.receipt.graderRef }, gradeSource: { basis: 'stored-benchmark-grade', rolloutId: f.receipt.rolloutId } } });
    expect(rows?.[0].metadata).not.toHaveProperty('durableTransition');
  });
  it.each(['workspace', 'harness', 'subject', 'missing-subject', 'duplicate-subject', 'missing-rollout',
    'missing-result', 'missing-prereg', 'prereg-config', 'uncommitted', 'commit', 'late-prereg',
    'old-result', 'old-rollout', 'arm', 'seed', 'task', 'model', 'grader', 'rollout-id', 'snapshot',
    'generation', 'generation-error', 'ungraded', 'status', 'harness-version', 'submission-ref',
    'grader-ref', 'submission', 'raw-output'] as const)('refuses %s even after grade-row pins are refreshed', async fault => {
    const f = await fixture();
    if (fault === 'workspace') f.options.workspaceId = 'foreign-bench-workspace';
    if (fault === 'harness') f.options.harnessSlug = 'foreign-harness';
    if (fault === 'subject') f.receipt.subjectId = 'foreign-subject';
    if (fault === 'missing-subject') await sql`DELETE FROM harness_shared.work_items`;
    if (fault === 'duplicate-subject') await sql`INSERT INTO harness_shared.work_items SELECT * FROM harness_shared.work_items`;
    if (fault === 'missing-rollout') await sql`DELETE FROM harness_shared.benchmark_rollout`;
    if (fault === 'missing-result') await sql`DELETE FROM harness_shared.benchmark_run_result`;
    if (fault === 'missing-prereg') await sql`DELETE FROM harness_shared.benchmark_prereg`;
    if (fault === 'prereg-config') await sql`UPDATE harness_shared.benchmark_prereg SET config = '{}'::jsonb`;
    if (fault === 'uncommitted') await sql`UPDATE harness_shared.benchmark_prereg SET git_committed = false`;
    if (fault === 'commit') await sql`UPDATE harness_shared.benchmark_prereg SET git_commit_sha = 'not-a-commit'`;
    if (fault === 'late-prereg') await sql`UPDATE harness_shared.benchmark_prereg SET created_at = now()`;
    if (fault === 'old-result') await sql`UPDATE harness_shared.benchmark_run_result SET created_at = '2026-10-10T00:00:00Z'`;
    if (fault === 'old-rollout') await sql`UPDATE harness_shared.benchmark_rollout SET created_at = '2026-10-10T00:00:00Z'`;
    if (fault === 'arm') await sql`UPDATE harness_shared.benchmark_rollout SET arm = 'baseline'`;
    if (fault === 'seed') await sql`UPDATE harness_shared.benchmark_rollout SET seed = 2`;
    if (fault === 'task') await sql`UPDATE harness_shared.benchmark_rollout SET task_id = 'foreign-task'`;
    if (fault === 'model') await sql`UPDATE harness_shared.benchmark_rollout SET model_id = 'foreign-model'`;
    if (fault === 'grader') await sql`UPDATE harness_shared.benchmark_rollout SET grader_version = 'foreign-grader'`;
    if (fault === 'rollout-id') f.receipt.rolloutId = 'b'.repeat(64);
    if (fault === 'snapshot') await sql`UPDATE harness_shared.benchmark_rollout SET config_snapshot = '{}'::jsonb`;
    if (fault === 'generation') await sql`UPDATE harness_shared.benchmark_run_result SET generation_status = 'error'`;
    if (fault === 'generation-error') await sql`UPDATE harness_shared.benchmark_run_result SET generation_error = 'failed'`;
    if (fault === 'ungraded') await sql`UPDATE harness_shared.benchmark_run_result SET resolved = null`;
    if (fault === 'status') await sql`UPDATE harness_shared.benchmark_run_result SET grader_status = 'failed'`;
    if (fault === 'harness-version') await sql`UPDATE harness_shared.benchmark_rollout SET harness_version = 'foreign'`;
    if (fault === 'submission-ref') await sql`UPDATE harness_shared.benchmark_run_result SET submission_ref = 'foreign'`;
    if (fault === 'grader-ref') await sql`UPDATE harness_shared.benchmark_run_result SET raw_grader_output_ref = 'foreign'`;
    if (fault === 'submission') await sql`UPDATE harness_shared.benchmark_rollout SET submission = 'changed'`;
    if (fault === 'raw-output') await sql`UPDATE harness_shared.benchmark_rollout SET raw_grader_output = 'changed'`;
    if (!['missing-rollout', 'missing-result'].includes(fault)) await f.pin();
    expect(await currentBenchWorkloadGradeReader(f.options)(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('refuses an overwritten deterministic rollout rather than borrowing its new verdict', async () => {
    const f = await fixture(), reader = currentBenchWorkloadGradeReader(f.options);
    await emitRollout({ ...f.input, grading: { ...f.input.grading, resolved: false, status: 'failed', rawOutput: 'new grade' } }, { sql, workspaceId });
    expect(await reader(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('freezes the allocation and rejects foreign bindings and candidate refs', async () => {
    const f = await fixture(), reader = currentBenchWorkloadGradeReader(f.options);
    f.options.protocol.grader.version = 'changed'; f.receipt.outcomeId = 'candidate-outcome';
    expect((await reader('grade:private', binding))?.[0].metadata?.workloadOutcome).toMatchObject({ id: 'answer-correctness' });
    expect(await reader('grade:private', { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader('grade:private', { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    expect(await reader('candidate-ref', binding)).toBeNull();
  });
  it('refuses production, ambiguous records and protocols outside the frozen assignment', async () => {
    const f = await fixture();
    expect(() => currentBenchWorkloadGradeReader({ ...f.options, workspaceId: 'papercusp-workspace' })).toThrow(/PRODUCTION/);
    expect(() => currentBenchWorkloadGradeReader({ ...f.options, receipts: [f.receipt, f.receipt] })).toThrow(/unique pinned/);
    expect(() => currentBenchWorkloadGradeReader({ ...f.options, preregHash: 'b'.repeat(64) })).toThrow(/frozen private protocol/);
    expect(() => currentBenchWorkloadGradeReader({ ...f.options, receipts: [{ ...f.receipt, graderRef: 'candidate-grader' }] })).toThrow(/frozen private protocol/);
  });
});

describe('private workload artifact authority', () => {
  const binding = { runId: 'private-artifact-run', trialBindingHash: 'a'.repeat(64) };
  const subjectId = 'private-artifact-subject', harnessSlug = 'private-artifact-harness', ref = 'artifact:private-result';
  const content = Buffer.from('resolved private output π\n');
  const options = () => ({ sql, workspaceId, harnessSlug, ...binding, checkoutRoot: repoRoot,
    artifacts: [{ ref, subjectId, path: 'output/result.txt', maxBytes: 1024 }] });
  async function populate() {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${harnessSlug}, ${subjectId}, 'wip')`;
    mkdirSync(join(repoRoot, 'output')); writeFileSync(join(repoRoot, 'output/result.txt'), content);
  }
  it('reads actual private artifact bytes through the existing context path boundary', async () => {
    await populate();
    expect(await currentBenchWorkloadArtifactReader(options())(ref, binding)).toEqual(content);
  });
  it.each(['workspace', 'harness', 'subject', 'missing', 'duplicate'])('refuses %s subject membership', async fault => {
    await populate();
    if (fault === 'workspace') await sql`UPDATE harness_shared.work_items SET workspace_id = 'foreign-workspace'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign-harness'`;
    if (fault === 'subject') await sql`UPDATE harness_shared.work_items SET feature_id = 'foreign-subject'`;
    if (fault === 'missing') await sql`DELETE FROM harness_shared.work_items`;
    if (fault === 'duplicate') await sql`INSERT INTO harness_shared.work_items SELECT * FROM harness_shared.work_items`;
    expect(await currentBenchWorkloadArtifactReader(options())(ref, binding)).toBeNull();
  });
  it.each(['missing', 'empty', 'oversize', 'directory', 'file-link', 'parent-link', 'traversal', 'absolute'])
  ('refuses %s filesystem substitution', async fault => {
    await populate();
    const allocation = options();
    if (fault === 'missing') rmSync(join(repoRoot, 'output/result.txt'));
    if (fault === 'empty') writeFileSync(join(repoRoot, 'output/result.txt'), '');
    if (fault === 'oversize') writeFileSync(join(repoRoot, 'output/result.txt'), Buffer.alloc(1025));
    if (fault === 'directory') { rmSync(join(repoRoot, 'output/result.txt')); mkdirSync(join(repoRoot, 'output/result.txt')); }
    if (fault === 'file-link') { rmSync(join(repoRoot, 'output/result.txt')); symlinkSync(join(repoRoot, 'foreign.txt'), join(repoRoot, 'output/result.txt')); }
    if (fault === 'parent-link') { rmSync(join(repoRoot, 'output'), { recursive: true }); symlinkSync(tmpdir(), join(repoRoot, 'output')); }
    if (fault === 'traversal') allocation.artifacts[0].path = '../foreign.txt';
    if (fault === 'absolute') allocation.artifacts[0].path = join(repoRoot, 'output/result.txt');
    expect(await currentBenchWorkloadArtifactReader(allocation)(ref, binding)).toBeNull();
  });
  it('freezes host allocation and refuses a foreign run, binding or unallocated ref', async () => {
    await populate();
    const allocation = options(), reader = currentBenchWorkloadArtifactReader(allocation);
    allocation.checkoutRoot = tmpdir(); allocation.artifacts[0].path = 'foreign.txt';
    expect(await reader(ref, binding)).toEqual(content);
    expect(await reader(ref, { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader(ref, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    expect(await reader('candidate-chosen-path', binding)).toBeNull();
  });
  it('refuses replacement of the allocated checkout with another directory at the same path', async () => {
    await populate();
    const reader = currentBenchWorkloadArtifactReader(options());
    const moved = repoRoot + '-moved'; roots.push(moved); renameSync(repoRoot, moved);
    mkdirSync(repoRoot); mkdirSync(join(repoRoot, 'output'));
    writeFileSync(join(repoRoot, 'output/result.txt'), content);
    expect(await reader(ref, binding)).toBeNull();
  });
  it('refuses a symbolic checkout root even when its target contains the artifact', async () => {
    await populate();
    const linked = repoRoot + '-link'; roots.push(linked); symlinkSync(repoRoot, linked);
    expect(() => currentBenchWorkloadArtifactReader({ ...options(), checkoutRoot: linked })).toThrow(/private checkout root/);
  });
  it('refuses production allocation, repeated refs/paths and invalid read bounds', () => {
    expect(() => currentBenchWorkloadArtifactReader({ ...options(), workspaceId: 'papercusp-workspace' })).toThrow(/PRODUCTION/);
    const allocation = options();
    expect(() => currentBenchWorkloadArtifactReader({ ...allocation, artifacts: [...allocation.artifacts, ...allocation.artifacts] })).toThrow(/unique bounded artifacts/);
    expect(() => currentBenchWorkloadArtifactReader({ ...allocation, artifacts: [allocation.artifacts[0], { ...allocation.artifacts[0], ref: 'another-ref' }] })).toThrow(/unique bounded artifacts/);
    expect(() => currentBenchWorkloadArtifactReader({ ...allocation, artifacts: [{ ...allocation.artifacts[0], maxBytes: 0 }] })).toThrow(/bounded artifacts/);
  });
});

describe('private workload checkpoint authority', () => {
  const binding = { runId: 'private-checkpoint-run', trialBindingHash: 'a'.repeat(64) };
  const harnessSlug = 'private-checkpoint-harness', subjectId = 'private-checkpoint-subject';
  const scope = `workitem:${harnessSlug}:${subjectId}`;
  const at = Date.parse('2026-10-11T00:00:01Z');
  const checkpoint = 'Preserve partial output π\nResume with exact whitespace.';
  // The journal stores only a prefix; the full current note contains the update.
  const note = 'Older preparation\n'.repeat(100) + checkpoint;
  const subjectFingerprint = computeWorkItemSubjectFingerprint({ id: subjectId, harness: harnessSlug,
    kind: 'feature', title: 'Private recovery', summary: 'Preserve partial work', state: 'wip' });
  const entry = () => ({ at, note: note.slice(0, 500), subjectFingerprint,
    latestUpdate: { noteHash: shortCarryHash(note), offset: note.indexOf(checkpoint), length: checkpoint.length } });
  const options = () => ({ sql, workspaceId, harnessSlug, ...binding, notBefore: '2026-10-11T00:00:00Z',
    receipts: [{ receiptRef: 'checkpoint:private-recovery', subjectId, transitionId: 'partial-checkpoint',
      index: 2, at, checkpointSha256: createHash('sha256').update(checkpoint).digest('hex'), fromState: 'wip', subjectFingerprint: { ...subjectFingerprint } }] });
  async function populate() {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${harnessSlug}, ${subjectId}, 'wip')`;
    await sql`INSERT INTO harness_shared.carry_notes VALUES (${workspaceId}, ${scope}, ${note}, ${JSON.stringify([entry()])}::text::jsonb, ${at})`;
  }
  it('resolves exact authored bytes through the writer span despite a truncated journal prefix', async () => {
    await populate();
    const receipt = options().receipts[0];
    expect(await currentBenchWorkloadCheckpointReader(options())(receipt.receiptRef, binding)).toEqual([
      { index: 2, kind: 'tool-result', name: 'work-item:checkpoint', at: new Date(at).toISOString(), content: checkpoint,
        metadata: { ...binding, receiptRef: receipt.receiptRef,
          durableTransition: { id: 'partial-checkpoint', subjectRef: `work-item:${harnessSlug}:${subjectId}`, from: 'wip', to: 'checkpointed' },
          checkpointSource: { basis: 'hash-bound-work-item-latest-update', scope, journalAt: at,
            checkpointSha256: receipt.checkpointSha256, subjectFingerprint } } },
    ]);
  });
  it.each(['workspace', 'harness', 'subject', 'duplicate-subject', 'missing-note', 'foreign-scope',
    'advanced', 'evicted', 'duplicate-entry', 'legacy-subject', 'foreign-subject', 'missing-span',
    'wrong-note-hash', 'bad-span', 'changed-bytes'])('refuses %s checkpoint substitution', async fault => {
    await populate();
    const journal: Array<Record<string, unknown>> = [entry()];
    if (fault === 'workspace') await sql`UPDATE harness_shared.carry_notes SET workspace_id = 'foreign-workspace'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign-harness'`;
    if (fault === 'subject') await sql`UPDATE harness_shared.work_items SET feature_id = 'foreign-subject'`;
    if (fault === 'duplicate-subject') await sql`INSERT INTO harness_shared.work_items SELECT * FROM harness_shared.work_items`;
    if (fault === 'missing-note') await sql`DELETE FROM harness_shared.carry_notes`;
    if (fault === 'foreign-scope') await sql`UPDATE harness_shared.carry_notes SET scope = 'workitem:foreign:foreign'`;
    if (fault === 'advanced') {
      journal.push({ ...entry(), at: at + 1 });
      await sql`UPDATE harness_shared.carry_notes SET updated_ts = ${at + 1}`;
    }
    if (fault === 'evicted') journal.length = 0;
    if (fault === 'duplicate-entry') journal.push(entry());
    if (fault === 'legacy-subject') delete journal[0].subjectFingerprint;
    if (fault === 'foreign-subject') journal[0].subjectFingerprint = { version: 1, sha256: 'b'.repeat(64) };
    if (fault === 'missing-span') delete journal[0].latestUpdate;
    if (fault === 'wrong-note-hash') journal[0].latestUpdate = { ...entry().latestUpdate, noteHash: 'wrong' };
    if (fault === 'bad-span') journal[0].latestUpdate = { ...entry().latestUpdate, length: note.length + 1 };
    if (fault === 'changed-bytes') {
      const changed = note.replace(checkpoint, 'X'.repeat(checkpoint.length));
      await sql`UPDATE harness_shared.carry_notes SET note = ${changed}`;
      journal[0].latestUpdate = { ...entry().latestUpdate, noteHash: shortCarryHash(changed) };
    }
    await sql`UPDATE harness_shared.carry_notes SET journal = ${JSON.stringify(journal)}::text::jsonb`;
    expect(await currentBenchWorkloadCheckpointReader(options())(options().receipts[0].receiptRef, binding)).toBeNull();
  });
  it('freezes host allocation and refuses other runs, bindings and candidate refs', async () => {
    await populate();
    const allocation = options(), receipt = allocation.receipts[0], reader = currentBenchWorkloadCheckpointReader(allocation);
    allocation.harnessSlug = 'foreign-harness'; receipt.fromState = 'done'; receipt.subjectFingerprint.sha256 = 'b'.repeat(64);
    expect((await reader(receipt.receiptRef, binding))?.[0].metadata?.durableTransition).toMatchObject({ from: 'wip' });
    expect(await reader(receipt.receiptRef, { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader(receipt.receiptRef, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    expect(await reader('candidate-chosen-ref', binding)).toBeNull();
  });
  it('refuses production, old checkpoints and ambiguous allocation before reads', () => {
    expect(() => currentBenchWorkloadCheckpointReader({ ...options(), workspaceId: 'papercusp-workspace' })).toThrow(/PRODUCTION/);
    expect(() => currentBenchWorkloadCheckpointReader({ ...options(), notBefore: '2026-10-11T00:00:02Z' })).toThrow(/unique exact checkpoints/);
    const allocation = options();
    expect(() => currentBenchWorkloadCheckpointReader({ ...allocation, receipts: [...allocation.receipts, ...allocation.receipts] })).toThrow(/unique exact checkpoints/);
    expect(() => currentBenchWorkloadCheckpointReader({ ...allocation, receipts: [allocation.receipts[0],
      { ...allocation.receipts[0], receiptRef: 'different-ref', index: 3 }] })).toThrow(/unique exact checkpoints/);
  });
});

describe('private workload handoff authority', () => {
  const binding = { runId: 'private-handoff-run', trialBindingHash: 'a'.repeat(64) };
  const harnessSlug = 'private-handoff-harness', subjectId = 'private-handoff-subject';
  const offer = { msg_id: 'private-offer', ts: '2026-10-11T00:00:01Z', kind: 'handoff',
    from: 'private-producer', to: ['private-consumer'], plan_slug: 'private-plan', harness_slug: harnessSlug,
    summary: 'Private brief', body: 'Preserve the partial output π\nand complete the declared transformation.' };
  const acceptance = { msg_id: 'private-acceptance', ts: '2026-10-11T00:00:02Z', kind: 'handoff_accepted',
    from: 'private-consumer', to: ['private-producer'], plan_slug: 'private-plan', related_msg_id: offer.msg_id,
    summary: 'Accepted private brief' };
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const options = () => ({ sql, workspaceId, harnessSlug, ...binding, notBefore: '2026-10-11T00:00:00Z',
    receipts: [{ receiptRef: 'handoff:private-receipt', subjectId, transitionId: 'brief-accepted', index: 2,
      planSlug: 'private-plan', offerMsgId: offer.msg_id, acceptanceMsgId: acceptance.msg_id,
      producerOwnerId: offer.from, consumerOwnerId: acceptance.from, offerSha256: hash(offer), acceptanceSha256: hash(acceptance) }] });
  async function populate() {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${harnessSlug}, ${subjectId}, 'wip')`;
    await sql`INSERT INTO harness_shared.coord_event_log VALUES
      (${workspaceId}, 'handoffs', ${offer.msg_id}, ${offer.ts}, ${harnessSlug}, ${sql.json(offer)}),
      (${workspaceId}, 'handoffs', ${acceptance.msg_id}, ${acceptance.ts}, NULL, ${sql.json(acceptance)})`;
  }
  it('projects the exact stored offer and linked acceptance by the declared private consumer', async () => {
    await populate();
    const receipt = options().receipts[0];
    expect(await currentBenchWorkloadHandoffReader(options())(receipt.receiptRef, binding)).toEqual([
      { index: 2, kind: 'tool-result', name: 'coord:handoff', at: '2026-10-11T00:00:02.000Z',
        content: canonicalJson({ offer, acceptance }), metadata: { ...binding, receiptRef: receipt.receiptRef,
          durableTransition: { id: 'brief-accepted', subjectRef: 'handoff:private-offer', from: 'offered', to: 'accepted' },
          handoffSource: { offerMsgId: offer.msg_id, acceptanceMsgId: acceptance.msg_id,
            producerOwnerId: offer.from, consumerOwnerId: acceptance.from,
            offerSha256: receipt.offerSha256, acceptanceSha256: receipt.acceptanceSha256 } } },
    ]);
  });
  it.each(['workspace', 'surface', 'harness', 'subject', 'duplicate-subject', 'missing-acceptance', 'duplicate-acceptance',
    'foreign-actor', 'foreign-recipient', 'foreign-link', 'foreign-plan', 'wrong-kind', 'changed-brief',
    'body-identity', 'column-harness', 'column-time', 'before-offer', 'old'])('refuses %s handoff substitution', async fault => {
    await populate();
    const changedOffer = structuredClone(offer), changedAccept = structuredClone(acceptance);
    if (fault === 'workspace') await sql`UPDATE harness_shared.coord_event_log SET workspace_id = 'foreign-workspace'`;
    if (fault === 'surface') await sql`UPDATE harness_shared.coord_event_log SET surface = 'messages'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign-harness'`;
    if (fault === 'subject') await sql`UPDATE harness_shared.work_items SET feature_id = 'foreign-subject'`;
    if (fault === 'duplicate-subject') await sql`INSERT INTO harness_shared.work_items SELECT * FROM harness_shared.work_items`;
    if (fault === 'missing-acceptance') await sql`DELETE FROM harness_shared.coord_event_log WHERE msg_id = ${acceptance.msg_id}`;
    if (fault === 'duplicate-acceptance') await sql`INSERT INTO harness_shared.coord_event_log SELECT * FROM harness_shared.coord_event_log WHERE msg_id = ${acceptance.msg_id}`;
    if (fault === 'foreign-actor') changedAccept.from = 'foreign-consumer';
    if (fault === 'foreign-recipient') changedOffer.to = ['foreign-consumer'];
    if (fault === 'foreign-link') changedAccept.related_msg_id = 'foreign-offer';
    if (fault === 'foreign-plan') changedAccept.plan_slug = 'foreign-plan';
    if (fault === 'wrong-kind') changedAccept.kind = 'message';
    if (fault === 'changed-brief') changedOffer.body = 'Candidate replacement';
    if (fault === 'body-identity') changedAccept.msg_id = 'foreign-acceptance';
    if (fault === 'column-harness') await sql`UPDATE harness_shared.coord_event_log SET harness_slug = 'foreign-harness' WHERE msg_id = ${offer.msg_id}`;
    if (fault === 'column-time') await sql`UPDATE harness_shared.coord_event_log SET ts = ts + interval '1 second'`;
    if (fault === 'before-offer') changedAccept.ts = '2026-10-11T00:00:00Z';
    const allocation = options();
    if (fault === 'old') allocation.notBefore = '2026-10-11T00:00:02Z';
    await sql`UPDATE harness_shared.coord_event_log SET body = ${sql.json(changedOffer)} WHERE msg_id = ${offer.msg_id}`;
    await sql`UPDATE harness_shared.coord_event_log SET body = ${sql.json(changedAccept)} WHERE msg_id = ${acceptance.msg_id}`;
    // Re-pin changed envelope hashes to isolate structural/timing checks from
    // the byte-substitution guard. The changed-brief control retains its old pin.
    if (fault !== 'changed-brief') {
      allocation.receipts[0].offerSha256 = hash(changedOffer);
      allocation.receipts[0].acceptanceSha256 = hash(changedAccept);
    }
    expect(await currentBenchWorkloadHandoffReader(allocation)(allocation.receipts[0].receiptRef, binding)).toBeNull();
  });
  it('keeps host allocation fixed and refuses foreign bindings and candidate refs', async () => {
    await populate();
    const allocation = options(), receipt = allocation.receipts[0], reader = currentBenchWorkloadHandoffReader(allocation);
    allocation.harnessSlug = 'foreign-harness'; receipt.consumerOwnerId = 'foreign-consumer';
    expect((await reader(receipt.receiptRef, binding))?.[0].metadata?.handoffSource).toMatchObject({ consumerOwnerId: 'private-consumer' });
    expect(await reader(receipt.receiptRef, { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader(receipt.receiptRef, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    expect(await reader('candidate-chosen-ref', binding)).toBeNull();
  });
  it('refuses production and ambiguous mappings before authority reads', () => {
    expect(() => currentBenchWorkloadHandoffReader({ ...options(), workspaceId: 'papercusp-workspace' })).toThrow(/PRODUCTION/);
    const allocation = options();
    expect(() => currentBenchWorkloadHandoffReader({ ...allocation, receipts: [...allocation.receipts, ...allocation.receipts] })).toThrow(/unique exact handoffs/);
    expect(() => currentBenchWorkloadHandoffReader({ ...allocation, receipts: [{ ...allocation.receipts[0], consumerOwnerId: offer.from }] })).toThrow(/unique exact handoffs/);
  });
});

async function workloadContextFixture(binding: { runId: string; trialBindingHash: string }) {
    const home = mkdtempSync(join(tmpdir(), 'private-context-source-')); roots.push(home);
    const nativeSessionId = randomUUID(), nativeTurnId = randomUUID();
    const text = 'Resolved dependency output π\nwith exact whitespace.';
    const transcript = [
      { type: 'session_meta', payload: { id: nativeSessionId } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: nativeTurnId } },
      { timestamp: '2026-10-11T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'turn_context', payload: { turn_id: nativeTurnId, model: 'configured-alias' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 },
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 } } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: nativeTurnId } },
    ].map(row => JSON.stringify(row) + '\n').join('');
    const dir = join(home, 'sessions', '2026', '10', '11'); mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-11T00-00-00-${nativeSessionId}.jsonl`); writeFileSync(file, transcript);
    const receipt = { receiptRef: 'native-input:private-context', subjectId: 'private-context-subject', taskId: 'private-context-task',
      ownerId: 'private-context-owner', label: 'private-context-label', codexHome: home, nativeSessionId, nativeTurnId,
      recordIndex: 2, contentIndex: 0, contextId: 'dependency-context', consumer: 'dependent-solver', index: 3 };
    const harnessSlug = 'private-context-harness';
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${harnessSlug}, ${receipt.subjectId}, 'wip')`;
    await sql`INSERT INTO harness_shared.task_ledger (workspace_id, task_id, detail, started_at, ended_at)
      VALUES (${workspaceId}, ${receipt.taskId}, ${sql.json({ coordOwnerId: receipt.ownerId, label: receipt.label })},
        '2026-10-11T00:00:00Z', '2026-10-11T00:00:02Z')`;
    const [adv] = await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent, started_at)
      VALUES (${workspaceId}, ${receipt.ownerId}, ${nativeSessionId}, 'codex', '2026-10-11T00:00:00Z') RETURNING id`;
    hostHome.byId.set(Number(adv.id), home);
    await sql`INSERT INTO harness_shared.interactive_usage_files VALUES (${workspaceId}, ${file}, ${Buffer.byteLength(transcript)},
      ${sql.json({ initialized: true, fileGeneration: 0 })})`;
    return { text, transcript, receipt, options: { sql, workspaceId, harnessSlug, ...binding,
      notBefore: '2026-10-11T00:00:00Z', receipts: [receipt] } };
}
describe('private workload context authority', () => {
  const binding = { runId: 'private-context-run', trialBindingHash: 'a'.repeat(64) };
  const fixture = () => workloadContextFixture(binding);
  it('projects source-defined input bytes under the exact private task, native home and trial binding', async () => {
    const f = await fixture();
    expect(await currentBenchWorkloadContextReader(f.options)(f.receipt.receiptRef, binding)).toEqual([
      { index: 3, kind: 'input', role: 'dependent-solver', at: '2026-10-11T00:00:01.000Z', content: f.text,
        metadata: { ...binding, receiptRef: f.receipt.receiptRef, contextId: 'dependency-context', nativeInputSource: {
          basis: 'closed-native-recorded-input', nativeSessionId: f.receipt.nativeSessionId, nativeTurnId: f.receipt.nativeTurnId,
          recordIndex: 2, contentIndex: 0, sourceSha256: createHash('sha256').update(f.transcript).digest('hex') } } },
    ]);
  });
  it.each(['workspace', 'harness', 'owner', 'label', 'native-session', 'native-home', 'live-task', 'missing-end', 'before-launch', 'after-end', 'old'])
  ('rejects %s native input borrowing', async fault => {
    const f = await fixture();
    if (fault === 'workspace') await sql`UPDATE harness_shared.task_ledger SET workspace_id = 'foreign-workspace'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign-harness'`;
    if (fault === 'owner') await sql`UPDATE harness_shared.adv_sessions SET coord_owner_id = 'foreign-owner'`;
    if (fault === 'label') await sql`UPDATE harness_shared.task_ledger SET detail = ${sql.json({ coordOwnerId: f.receipt.ownerId, label: 'foreign-label' })}`;
    if (fault === 'native-session') await sql`UPDATE harness_shared.adv_sessions SET session_id = ${randomUUID()}`;
    if (fault === 'native-home') hostHome.byId.clear();
    if (fault === 'live-task') await sql`UPDATE harness_shared.task_ledger SET state = 'running'`;
    if (fault === 'missing-end') await sql`UPDATE harness_shared.task_ledger SET ended_at = NULL`;
    if (fault === 'before-launch') await sql`UPDATE harness_shared.adv_sessions SET started_at = '2026-10-11T00:00:02Z'`;
    if (fault === 'after-end') await sql`UPDATE harness_shared.task_ledger SET ended_at = '2026-10-11T00:00:00Z'`;
    if (fault === 'old') f.options.notBefore = '2026-10-11T00:00:02Z';
    expect(await currentBenchWorkloadContextReader(f.options)(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('keeps the host context allocation fixed and refuses foreign bindings or candidate refs', async () => {
    const f = await fixture(), reader = currentBenchWorkloadContextReader(f.options);
    f.options.receipts[0].consumer = 'foreign-consumer'; f.options.receipts[0].contentIndex = 99;
    expect((await reader(f.receipt.receiptRef, binding))?.[0].role).toBe('dependent-solver');
    expect(await reader(f.receipt.receiptRef, { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    expect(await reader('candidate-chosen-ref', binding)).toBeNull();
  });
});

async function workloadToolResultFixture(binding: { runId: string; trialBindingHash: string },
  base?: Awaited<ReturnType<typeof workloadContextFixture>>, kind: 'function' | 'custom' = 'function') {
    const f = base ?? await workloadContextFixture(binding);
    const argumentsText = '{"paths":["private/task.txt"],"intent":"exact π"}', output = '{"ok":false,"busy":["private/task.txt"]}';
    const records = f.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
    records[2] = { timestamp: '2026-10-11T00:00:00.500Z', type: 'response_item', payload: { type: kind === 'function' ? 'function_call' : 'custom_tool_call',
      call_id: 'private-tool-call', namespace: 'mcp', name: 'locks_acquire', ...(kind === 'function' ? { arguments: argumentsText } : { input: argumentsText }) } };
    records.splice(3, 0, { timestamp: '2026-10-11T00:00:01Z', type: 'response_item',
      payload: { type: kind === 'function' ? 'function_call_output' : 'custom_tool_call_output', call_id: 'private-tool-call', output } });
    const transcript = records.map(row => JSON.stringify(row) + '\n').join('');
    const [source] = await sql`SELECT file_path FROM harness_shared.interactive_usage_files`;
    writeFileSync(source.file_path, transcript);
    await sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = ${Buffer.byteLength(transcript)}`;
    const receipt = { ...f.receipt, receiptRef: 'native-tool:private-context', callRecordIndex: 2, resultRecordIndex: 3,
      callId: 'private-tool-call', toolName: 'mcp.locks_acquire', sourceSha256: createHash('sha256').update(transcript).digest('hex'),
      argumentsSha256: createHash('sha256').update(argumentsText).digest('hex'), outputSha256: createHash('sha256').update(output).digest('hex') };
    return { ...f, transcript, argumentsText, output, receipt, options: { ...f.options, receipts: [receipt] } };
}

describe('private workload native dispatch correlation', () => {
  const binding = { runId: 'private-dispatch-run', trialBindingHash: 'a'.repeat(64) };
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const fingerprint = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  async function fixture(wrapper = false) {
    const f = await workloadToolResultFixture(binding);
    if (wrapper) {
      const records = f.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
      const argumentsText = 'text(await tools.mcp__papercusp_su__locks_acquire({paths:["private/task.txt"],intent:"exact π"}));';
      Object.assign(records[2].payload, { namespace: 'functions', name: 'exec', arguments: argumentsText });
      f.transcript = records.map(row => JSON.stringify(row) + '\n').join('');
      const [source] = await sql`SELECT file_path FROM harness_shared.interactive_usage_files`;
      writeFileSync(source.file_path, f.transcript);
      await sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = ${Buffer.byteLength(f.transcript)}`;
      f.receipt.toolName = 'functions.exec';
      f.receipt.argumentsSha256 = fingerprint(argumentsText);
      f.receipt.sourceSha256 = fingerprint(f.transcript);
    }
    const [adv] = await sql`SELECT id FROM harness_shared.adv_sessions`;
    const args = JSON.parse(f.argumentsText);
    const metadata = { requestOrigin: { transport: 'mcp', mcpRequestTraceId: 'private-request-trace', nativeSession: {
      carrier: 'meta:threadId', binding: 'bound', candidateAdvSessionId: Number(adv.id),
      valueFingerprint: fingerprint(f.receipt.nativeSessionId), callIdFingerprint: fingerprint(f.receipt.callId) } } };
    const [row] = await sql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, tool_name, coord_owner_id, invoked_at, duration_ms, status, args_json, metadata_json)
      VALUES (${workspaceId}, ${f.options.harnessSlug}, 'locks:acquire', ${f.receipt.ownerId},
        '2026-10-11T00:00:00.800Z', 100, 'ok', ${JSON.stringify(args)}::text::jsonb,
        ${JSON.stringify(metadata)}::text::jsonb) RETURNING id`;
    const dispatch = { invocationId: String(row.id), requestTraceId: metadata.requestOrigin.mcpRequestTraceId,
      toolName: 'locks:acquire', argumentsSha256: hash(args), invocationSha256: '' };
    const receipt = { ...f.receipt, dispatch };
    async function repin() {
      const [row] = await sql`SELECT to_jsonb(invocation) AS invocation FROM harness_shared.tool_invocations invocation
        WHERE id = ${dispatch.invocationId}::bigint`;
      dispatch.invocationSha256 = hash(row.invocation);
    }
    await repin();
    return { ...f, receipt, dispatch, metadata, repin, options: { ...f.options, receipts: [receipt] } };
  }
  it.each([false, true])('native dispatch correlation joins direct/wrapper=%s without inventing lock authority', async wrapper => {
    const f = await fixture(wrapper), reader = currentBenchWorkloadToolResultReader(f.options);
    const rows = await reader(f.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ name: wrapper ? 'functions.exec' : 'mcp.locks_acquire', content: f.output,
      metadata: { platformInvocationSource: { basis: 'native-call-correlated-dispatch', toolName: 'locks:acquire',
        invocationId: f.dispatch.invocationId, status: 'ok', arguments: JSON.parse(f.argumentsText) } } });
    expect(rows?.[0].metadata).not.toHaveProperty('durableTransition');
    f.dispatch.requestTraceId = 'candidate'; f.options.receipts[0].toolName = 'candidate';
    expect(await reader(f.receipt.receiptRef, binding)).toEqual(rows);
  });
  it.each(['missing', 'workspace', 'harness', 'owner', 'call', 'session', 'carrier', 'binding', 'adv',
    'trace', 'target', 'args', 'truncated', 'before', 'after', 'duration', 'replayed', 'duplicate', 'changed-pin'])
  ('native dispatch correlation refuses %s substitution', async fault => {
    const f = await fixture(true);
    if (fault === 'missing') await sql`DELETE FROM harness_shared.tool_invocations`;
    if (fault === 'workspace') await sql`UPDATE harness_shared.tool_invocations SET workspace_id = 'foreign'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.tool_invocations SET harness_slug = 'foreign'`;
    if (fault === 'owner') await sql`UPDATE harness_shared.tool_invocations SET coord_owner_id = 'foreign'`;
    if (fault === 'call') f.metadata.requestOrigin.nativeSession.callIdFingerprint = fingerprint('foreign');
    if (fault === 'session') f.metadata.requestOrigin.nativeSession.valueFingerprint = fingerprint('foreign');
    if (fault === 'carrier') f.metadata.requestOrigin.nativeSession.carrier = 'header:x-papercusp-native-session';
    if (fault === 'binding') f.metadata.requestOrigin.nativeSession.binding = 'unbound';
    if (fault === 'adv') f.metadata.requestOrigin.nativeSession.candidateAdvSessionId++;
    if (fault === 'trace') f.metadata.requestOrigin.mcpRequestTraceId = 'foreign';
    await sql`UPDATE harness_shared.tool_invocations SET metadata_json = ${JSON.stringify(f.metadata)}::text::jsonb`;
    if (fault === 'target') await sql`UPDATE harness_shared.tool_invocations SET tool_name = 'locks:release'`;
    if (fault === 'args') await sql`UPDATE harness_shared.tool_invocations SET args_json = '{"paths":["foreign"]}'::jsonb`;
    if (fault === 'truncated') {
      const args = { _truncated: true, _size: 40000 }; f.dispatch.argumentsSha256 = hash(args);
      await sql`UPDATE harness_shared.tool_invocations SET args_json = ${JSON.stringify(args)}::text::jsonb`;
    }
    if (fault === 'before') await sql`UPDATE harness_shared.tool_invocations SET invoked_at = '2026-10-11T00:00:00.400Z'`;
    if (fault === 'after') await sql`UPDATE harness_shared.tool_invocations SET invoked_at = '2026-10-11T00:00:01.100Z'`;
    if (fault === 'duration') await sql`UPDATE harness_shared.tool_invocations SET duration_ms = 400`;
    if (fault === 'replayed') await sql`UPDATE harness_shared.tool_invocations SET status = 'replayed'`;
    if (fault === 'duplicate') await sql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, tool_name, coord_owner_id, invoked_at, duration_ms, status, args_json, metadata_json)
      SELECT workspace_id, harness_slug, tool_name, coord_owner_id, invoked_at, duration_ms, status, args_json, metadata_json
        FROM harness_shared.tool_invocations`;
    // Re-pin the altered row to distinguish structural refusal from hash drift.
    if (fault !== 'missing' && fault !== 'changed-pin') await f.repin();
    if (fault === 'changed-pin') await sql`UPDATE harness_shared.tool_invocations SET error_code = 'late-replacement'`;
    expect(await currentBenchWorkloadToolResultReader(f.options)(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('native dispatch correlation refuses duplicate host selection before reads', async () => {
    const f = await fixture();
    expect(() => currentBenchWorkloadToolResultReader({ ...f.options, receipts: [f.receipt,
      { ...f.receipt, receiptRef: 'different', index: 9 }] })).toThrow(/unique pinned/);
  });
});

describe('private workload native tool-result authority', () => {
  const binding = { runId: 'private-tool-result-run', trialBindingHash: 'a'.repeat(64) };
  const fixture = () => workloadToolResultFixture(binding);
  it('binds exact call/result source bytes to the private task without inventing a durable transition', async () => {
    const f = await fixture();
    expect(await currentBenchWorkloadToolResultReader(f.options)(f.receipt.receiptRef, binding)).toEqual([
      { index: 3, kind: 'tool-result', name: 'mcp.locks_acquire', at: '2026-10-11T00:00:01.000Z', content: f.output,
        metadata: { ...binding, receiptRef: f.receipt.receiptRef, nativeToolSource: { basis: 'closed-native-recorded-tool-result',
          nativeSessionId: f.receipt.nativeSessionId, nativeTurnId: f.receipt.nativeTurnId, callRecordIndex: 2, resultRecordIndex: 3,
          callId: f.receipt.callId, callType: 'function_call', outputKind: 'text',
          sourceSha256: f.receipt.sourceSha256, arguments: f.argumentsText,
          argumentsSha256: f.receipt.argumentsSha256, outputSha256: f.receipt.outputSha256,
          calledAt: '2026-10-11T00:00:00.500Z', isError: null } } },
    ]);
  });
  it.each(['workspace', 'harness', 'owner', 'label', 'native-session', 'native-home', 'live-task', 'missing-end',
    'before-launch', 'after-end', 'old', 'sourceSha256', 'argumentsSha256', 'outputSha256', 'callId', 'toolName'])
  ('refuses %s native tool-result borrowing', async fault => {
    const f = await fixture();
    if (fault === 'workspace') await sql`UPDATE harness_shared.task_ledger SET workspace_id = 'foreign-workspace'`;
    if (fault === 'harness') await sql`UPDATE harness_shared.work_items SET harness_slug = 'foreign-harness'`;
    if (fault === 'owner') await sql`UPDATE harness_shared.adv_sessions SET coord_owner_id = 'foreign-owner'`;
    if (fault === 'label') await sql`UPDATE harness_shared.task_ledger SET detail = ${sql.json({ coordOwnerId: f.receipt.ownerId, label: 'foreign-label' })}`;
    if (fault === 'native-session') await sql`UPDATE harness_shared.adv_sessions SET session_id = ${randomUUID()}`;
    if (fault === 'native-home') hostHome.byId.clear();
    if (fault === 'live-task') await sql`UPDATE harness_shared.task_ledger SET state = 'running'`;
    if (fault === 'missing-end') await sql`UPDATE harness_shared.task_ledger SET ended_at = NULL`;
    if (fault === 'before-launch') await sql`UPDATE harness_shared.adv_sessions SET started_at = '2026-10-11T00:00:01Z'`;
    if (fault === 'after-end') await sql`UPDATE harness_shared.task_ledger SET ended_at = '2026-10-11T00:00:00Z'`;
    if (fault === 'old') f.options.notBefore = '2026-10-11T00:00:01Z';
    if (fault === 'sourceSha256' || fault === 'argumentsSha256' || fault === 'outputSha256') f.receipt[fault] = 'b'.repeat(64);
    if (fault === 'callId') f.receipt.callId = 'foreign-call';
    if (fault === 'toolName') f.receipt.toolName = 'locks:acquire';
    expect(await currentBenchWorkloadToolResultReader(f.options)(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('freezes host receipt pins and refuses candidate-selected refs, foreign bindings and duplicate allocations', async () => {
    const f = await fixture(), reader = currentBenchWorkloadToolResultReader(f.options);
    f.receipt.toolName = 'candidate-wrapper'; f.receipt.outputSha256 = 'c'.repeat(64);
    expect((await reader(f.receipt.receiptRef, binding))?.[0].name).toBe('mcp.locks_acquire');
    expect(await reader('candidate-ref', binding)).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, trialBindingHash: 'b'.repeat(64) })).toBeNull();
    f.options.receipts.push({ ...f.receipt });
    expect(() => currentBenchWorkloadToolResultReader(f.options)).toThrow(/unique pinned/);
  });
});

describe('private workload provider input authority', () => {
  const binding = { runId: 'private-provider-input-run', trialBindingHash: 'a'.repeat(64) };
  async function fixture() {
    const f = await workloadContextFixture(binding), reservationId = randomUUID();
    const host = { workspaceId, loopId: `private-provider-input:${randomUUID()}`, runId: binding.runId,
      preregHash: 'b'.repeat(64), assignmentId: currentBenchAssignmentId(binding.runId, 'papercusp', 't1', 1) };
    const body = { model: 'configured-alias', reasoning: { effort: 'high' }, max_output_tokens: 10,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ session_id: f.receipt.nativeSessionId,
        thread_id: f.receipt.nativeSessionId, turn_id: f.receipt.nativeTurnId }) },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: f.text }] }] };
    const bytes = JSON.stringify(body);
    const identity = { attemptId: reservationId, manifestSha256: host.preregHash, armId: host.assignmentId,
      nativeSessionId: f.receipt.nativeSessionId, nativeTurnId: f.receipt.nativeTurnId, transport: 'bearer-http' as const,
      accountId: 'private-provider-account', credentialHeader: 'authorization' as const, credentialSha256: 'c'.repeat(64),
      bodySha256: createHash('sha256').update(bytes).digest('hex'), clockId: 'private-provider-clock',
      target: 'https://api.openai.com/v1/responses' };
    const candidateCheckoutRoot = join(repoRoot, 'candidate'); mkdirSync(candidateCheckoutRoot);
    const captureOptions = { accountingBinding: host, captureRoot: repoRoot, candidateCheckoutRoot,
      model: body.model, effort: body.reasoning.effort, accountId: identity.accountId, maxRequests: 2, maxBytes: 16_384 };
    const capture = currentBenchWorkloadProviderInputCapture(captureOptions);
    const attempt = { ...identity, body: bytes, signal: new AbortController().signal };
    await capture.captureProviderInput(attempt);
    const captured = capture.readCapture(reservationId);
    expect(captured).not.toBeNull();
    const resources = { inputTokens: 1000, outputTokens: 100, requestsPerArm: 10, armIds: [host.assignmentId],
      usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 60_000, wallClockMsPerArm: 60_000 };
    await registerLearningLoop(sql, { workspaceId, loopId: host.loopId, budgetKind: 'lifetime', budgetUsd: 60,
      enabled: true, meta: { reservationBinding: host.preregHash, reservationResourceBudget: resources } });
    expect((await reserveLearningSpend(sql, { workspaceId, loopId: host.loopId, requestedUsd: 0.003, floorUsd: 0,
      attemptKind: 'evaluation', note: JSON.stringify({ nativeGatewayAttempt: identity }),
      exact: { reservationId, binding: host.preregHash, expectedBudgetUsd: 60,
        resources: { armId: host.assignmentId, inputTokens: 100, outputTokens: 10 }, expectedResourceBudget: resources } })).ok).toBe(true);
    const headers: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: reservationId,
      outcome: 'response-headers', responseStatus: 200, costUsdMeasurementMissing: true };
    expect(await recordLearningSpendAttemptResult(sql, { workspaceId, reservationId, result: headers })).toEqual({ ok: true });
    const result: GatewayCarryTrialAttemptResult = { ...headers, outcome: 'response-completed', responseStatus: 200,
      responseSha256: 'd'.repeat(64), responseBytes: 300, providerCompletion: { responseId: 'private-response',
        model: 'configured-alias', providerEffort: 'high', usage: { inputTokenBasis: 'inclusive', inputTokens: 100,
          outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } } };
    expect(await recordLearningSpendAttemptResult(sql, { workspaceId, reservationId, result })).toEqual({ ok: true });
    await sql`UPDATE harness_shared.learning_spend_reservations SET created_at = '2026-10-11T00:00:01.500Z'
      WHERE id = ${reservationId}`;
    const [row] = await sql`SELECT note FROM harness_shared.learning_spend_reservations WHERE id = ${reservationId}`;
    const receipt = { ...f.receipt, reservationId, reservationNoteSha256: createHash('sha256').update(row.note).digest('hex'),
      bodyRef: captured!.bodyRef, bodyPath: captured!.bodyPath, maxBytes: 16_384, inputIndex: 0, textIndex: 0,
      model: 'configured-alias', effort: 'high', accountId: identity.accountId };
    return { ...f, body, identity, result, headers, host, capture, captureOptions, attempt, captured: captured!, note: JSON.parse(row.note), receipt,
      options: { ...f.options, checkoutRoot: repoRoot, accountingBinding: host, receipts: [receipt] } };
  }
  it('publishes exact private request bytes and an immutable credential-free host receipt', async () => {
    const f = await fixture();
    expect(readFileSync(join(repoRoot, f.captured.bodyPath), 'utf8')).toBe(f.attempt.body);
    expect(JSON.stringify(f.captured)).not.toMatch(/credential|authorization|signal/);
    expect(Object.isFrozen(f.captured)).toBe(true);
    expect(Object.isFrozen(f.captured.accountingBinding)).toBe(true);
    expect(f.capture.readCapture(randomUUID())).toBeNull();
    f.captureOptions.accountingBinding.assignmentId = 'candidate-arm'; f.captureOptions.model = 'candidate-model';
    expect(f.capture.readCapture(f.identity.attemptId)).toEqual(f.captured);
    await expect(f.capture.captureProviderInput(f.attempt)).rejects.toThrow();
    expect(f.capture.readCapture(f.identity.attemptId)).toEqual(f.captured);
  });
  it('bounds capture allocation and isolates arms even when native attempt ids coincide', async () => {
    const f = await fixture(), second = { ...f.attempt, attemptId: randomUUID() };
    await f.capture.captureProviderInput(second);
    await expect(f.capture.captureProviderInput({ ...second, attemptId: randomUUID() })).rejects.toThrow(/exhausted/);
    const otherBinding = { ...f.host, assignmentId: currentBenchAssignmentId(binding.runId, 'stock', 't1', 1) };
    const other = currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, accountingBinding: otherBinding });
    await expect(other.captureProviderInput(f.attempt)).rejects.toThrow(/foreign/);
    await other.captureProviderInput({ ...f.attempt, armId: otherBinding.assignmentId });
    expect(other.readCapture(f.identity.attemptId)?.bodyRef).not.toBe(f.captured.bodyRef);
    expect(f.capture.readCapture(f.identity.attemptId)).toEqual(f.captured);
  });
  it('restores retained host pins from serialized state without resetting the request cap', async () => {
    const f = await fixture(), state = f.capture.recoveryState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.captures)).toBe(true);
    expect(Object.isFrozen(state.captures[0])).toBe(true);
    expect(JSON.stringify(state)).not.toMatch(/credential|authorization|signal/);
    const checkpointPath = join(repoRoot, 'host-recovery.json');
    writeFileSync(checkpointPath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    const restored = currentBenchWorkloadProviderInputCapture({ ...f.captureOptions,
      recovery: JSON.parse(readFileSync(checkpointPath, 'utf8')) });
    expect(restored.readCapture(f.identity.attemptId)).toEqual(f.captured);
    const second = { ...f.attempt, attemptId: randomUUID() };
    await restored.captureProviderInput(second);
    expect(restored.readCapture(second.attemptId)).not.toBeNull();
    await expect(restored.captureProviderInput({ ...second, attemptId: randomUUID() })).rejects.toThrow(/exhausted/);
    // An old retained snapshot cannot reset slots or discover newly published
    // evidence, even if the original host instance is still reachable.
    const stale = currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, recovery: state });
    expect(stale.readCapture(second.attemptId)).toBeNull();
    await expect(stale.captureProviderInput({ ...second, attemptId: randomUUID() })).rejects.toThrow(/exhausted/);
    await expect(f.capture.captureProviderInput({ ...second, attemptId: randomUUID() })).rejects.toThrow(/exhausted/);
  });
  it('retains an interrupted slot without treating a partial receipt as published evidence', async () => {
    const f = await fixture(), state = f.capture.recoveryState();
    const directory = join(repoRoot, f.captured.bodyPath.split('/')[0]), interrupted = randomUUID();
    writeFileSync(join(directory, 'allocation-1'), '', { flag: 'wx', mode: 0o600 });
    mkdirSync(join(directory, interrupted), { mode: 0o700 });
    writeFileSync(join(directory, interrupted, 'body.json'), f.attempt.body, { flag: 'wx', mode: 0o600 });
    const restored = currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, recovery: state });
    expect(restored.readCapture(f.identity.attemptId)).toEqual(f.captured);
    expect(restored.readCapture(interrupted)).toBeNull();
    await expect(restored.captureProviderInput({ ...f.attempt, attemptId: interrupted })).rejects.toThrow(/exhausted/);
  });
  it.each(['policy', 'account', 'root', 'namespace', 'duplicate-pin', 'receipt-pin', 'body', 'receipt', 'slot-symlink',
    'extra-slot', 'permissions'])('refuses %s recovery drift', async fault => {
    const f = await fixture(), recovery = structuredClone(f.capture.recoveryState());
    const options = { ...f.captureOptions, recovery }, directory = join(repoRoot, f.captured.bodyPath.split('/')[0]);
    if (fault === 'policy') options.maxRequests++;
    if (fault === 'account') options.accountId = 'other-account';
    if (fault === 'root') recovery.rootIdentity += '1';
    if (fault === 'namespace') recovery.directoryIdentity += '1';
    if (fault === 'duplicate-pin') recovery.captures = [...recovery.captures, { ...recovery.captures[0] }];
    if (fault === 'receipt-pin') recovery.captures = [{ ...recovery.captures[0], receiptSha256: 'e'.repeat(64) }];
    if (fault === 'body') writeFileSync(join(repoRoot, f.captured.bodyPath), f.attempt.body + ' ');
    if (fault === 'receipt') writeFileSync(join(directory, f.identity.attemptId, 'receipt.json'), '{}');
    if (fault === 'slot-symlink') { rmSync(join(directory, 'allocation-0')); symlinkSync(join(repoRoot, 'host-slot'), join(directory, 'allocation-0')); }
    if (fault === 'extra-slot') writeFileSync(join(directory, 'allocation-2'), '', { mode: 0o600 });
    if (fault === 'permissions') chmodSync(directory, 0o755);
    expect(() => currentBenchWorkloadProviderInputCapture(options)).toThrow();
    if (['body', 'receipt', 'permissions'].includes(fault)) expect(() => f.capture.recoveryState()).toThrow();
  });
  it('refuses a hash-pinned receipt whose contents borrow another assignment', async () => {
    const f = await fixture(), recovery = structuredClone(f.capture.recoveryState());
    const path = join(repoRoot, f.captured.bodyPath.replace('/body.json', '/receipt.json'));
    const borrowed = canonicalJson({ ...f.captured, accountingBinding: { ...f.host, assignmentId: 'bench-assignment:foreign' } });
    writeFileSync(path, borrowed);
    recovery.captures = [{ reservationId: f.identity.attemptId,
      receiptSha256: createHash('sha256').update(borrowed).digest('hex') }];
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, recovery })).toThrow(/altered/);
  });
  it.each(['manifest', 'arm', 'account', 'hash', 'turn', 'model', 'effort', 'too-large', 'aborted'])
  ('refuses %s before publishing a request capture', async fault => {
    const f = await fixture(), attempt = { ...f.attempt, attemptId: randomUUID() };
    if (fault === 'manifest') attempt.manifestSha256 = 'e'.repeat(64);
    if (fault === 'arm') attempt.armId = 'foreign';
    if (fault === 'account') attempt.accountId = 'foreign';
    if (fault === 'hash') attempt.bodySha256 = 'e'.repeat(64);
    if (fault === 'turn') attempt.nativeTurnId = randomUUID();
    if (fault === 'model') attempt.body = JSON.stringify({ ...f.body, model: 'foreign' });
    if (fault === 'effort') attempt.body = JSON.stringify({ ...f.body, reasoning: { effort: 'low' } });
    if (fault === 'too-large') attempt.body += ' '.repeat(f.captureOptions.maxBytes);
    if (['model', 'effort', 'too-large'].includes(fault)) attempt.bodySha256 = createHash('sha256').update(attempt.body).digest('hex');
    if (fault === 'aborted') { const controller = new AbortController(); controller.abort(); attempt.signal = controller.signal; }
    await expect(f.capture.captureProviderInput(attempt)).rejects.toThrow();
    expect(f.capture.readCapture(attempt.attemptId)).toBeNull();
    expect(f.capture.readCapture(f.identity.attemptId)).toEqual(f.captured);
  });
  it.each(['body', 'receipt', 'symlink', 'root'])('refuses %s capture substitution', async fault => {
    const f = await fixture(), bodyPath = join(repoRoot, f.captured.bodyPath);
    if (fault === 'body') writeFileSync(bodyPath, f.attempt.body + ' ');
    if (fault === 'receipt') writeFileSync(bodyPath.replace('/body.json', '/receipt.json'), '{}');
    if (fault === 'symlink') { renameSync(bodyPath, join(repoRoot, 'elsewhere.json')); symlinkSync(join(repoRoot, 'elsewhere.json'), bodyPath); }
    if (fault === 'root') { renameSync(repoRoot, `${repoRoot}-old`); roots.push(`${repoRoot}-old`); mkdirSync(repoRoot); }
    expect(f.capture.readCapture(f.identity.attemptId)).toBeNull();
    if (fault === 'root') await expect(f.capture.captureProviderInput({ ...f.attempt, attemptId: randomUUID() })).rejects.toThrow();
  });
  it('refuses shared/candidate roots, duplicate assignment allocation and unbounded capture policy', async () => {
    const f = await fixture();
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, captureRoot: f.captureOptions.candidateCheckoutRoot })).toThrow(/private host/);
    expect(() => currentBenchWorkloadProviderInputCapture(f.captureOptions)).toThrow();
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, maxRequests: 0 })).toThrow(/bounded/);
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.captureOptions, maxBytes: 16 * 1024 * 1024 + 1 })).toThrow(/bounded/);
  });
  it('joins recorded native bytes, captured request bytes and the completed provider reservation', async () => {
    const f = await fixture(), reader = currentBenchWorkloadProviderInputReader(f.options);
    const rows = await reader(f.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: 'input', content: f.text, metadata: { contextId: 'dependency-context',
      nativeInputSource: { nativeSessionId: f.receipt.nativeSessionId, nativeTurnId: f.receipt.nativeTurnId },
      providerInputSource: { basis: 'completed-provider-request-input', reservationId: f.receipt.reservationId,
        bodySha256: f.identity.bodySha256, accountId: f.receipt.accountId, responseId: 'private-response' } } });
    f.options.receipts[0].accountId = 'candidate-account'; f.options.receipts[0].inputIndex = 99;
    expect(await reader(f.receipt.receiptRef, binding)).toEqual(rows);
    expect(await reader('candidate-ref', binding)).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, runId: 'foreign-run' })).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, trialBindingHash: 'e'.repeat(64) })).toBeNull();
  });
  it.each(['workspace', 'loop', 'run-ref', 'arm', 'kind', 'cancelled', 'early', 'late', 'note-changed',
    'headers-only', 'body-changed', 'wrong-text', 'wrong-role', 'wrong-turn', 'wrong-account', 'wrong-model',
    'wrong-effort', 'response-hash', 'no-native-source', 'no-artifact', 'body-symlink'])
  ('refuses %s provider input substitution', async fault => {
    const f = await fixture();
    if (fault === 'workspace') await sql`UPDATE harness_shared.learning_spend_reservations SET workspace_id = 'foreign'`;
    if (fault === 'loop') await sql`UPDATE harness_shared.learning_spend_reservations SET loop_id = 'foreign'`;
    if (fault === 'run-ref') await sql`UPDATE harness_shared.learning_spend_reservations SET run_ref = 'foreign'`;
    if (fault === 'arm') await sql`UPDATE harness_shared.learning_spend_reservations SET arm_id = 'foreign'`;
    if (fault === 'kind') await sql`UPDATE harness_shared.learning_spend_reservations SET attempt_kind = 'proposer'`;
    if (fault === 'cancelled') await sql`UPDATE harness_shared.learning_spend_reservations SET status = 'cancelled'`;
    if (fault === 'early') await sql`UPDATE harness_shared.learning_spend_reservations SET created_at = '2026-10-11T00:00:00Z'`;
    if (fault === 'late') await sql`UPDATE harness_shared.learning_spend_reservations SET created_at = '2026-10-11T00:00:03Z'`;
    if (fault === 'note-changed') await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' '`;
    if (fault === 'body-changed') writeFileSync(join(repoRoot, f.receipt.bodyPath), JSON.stringify(f.body) + ' ');
    if (fault === 'no-native-source') await sql`TRUNCATE harness_shared.interactive_usage_files`;
    if (fault === 'no-artifact') rmSync(join(repoRoot, f.receipt.bodyPath));
    if (fault === 'body-symlink') {
      renameSync(join(repoRoot, f.receipt.bodyPath), join(repoRoot, 'elsewhere.json'));
      symlinkSync('elsewhere.json', join(repoRoot, f.receipt.bodyPath));
    }
    if (['headers-only', 'wrong-account', 'wrong-model', 'wrong-effort', 'response-hash'].includes(fault)) {
      if (fault === 'headers-only') f.note.nativeGatewayAttemptResult = f.headers;
      if (fault === 'wrong-account') f.note.nativeGatewayAttemptResult.accountId = 'foreign';
      if (fault === 'wrong-model') f.note.nativeGatewayAttemptResult.providerCompletion.model = 'foreign';
      if (fault === 'wrong-effort') f.note.nativeGatewayAttemptResult.providerCompletion.providerEffort = 'low';
      if (fault === 'response-hash') f.note.nativeGatewayAttemptResult.responseSha256 = 'invalid';
      const note = JSON.stringify(f.note); f.receipt.reservationNoteSha256 = createHash('sha256').update(note).digest('hex');
      await sql`UPDATE harness_shared.learning_spend_reservations SET note = ${note}`;
    }
    if (['wrong-text', 'wrong-role', 'wrong-turn'].includes(fault)) {
      if (fault === 'wrong-text') f.body.input[0].content[0].text = 'Other context';
      if (fault === 'wrong-role') f.body.input[0].role = 'developer';
      if (fault === 'wrong-turn') f.body.client_metadata['x-codex-turn-metadata'] = JSON.stringify({
        thread_id: f.receipt.nativeSessionId, turn_id: randomUUID() });
      const bytes = JSON.stringify(f.body); writeFileSync(join(repoRoot, f.receipt.bodyPath), bytes);
      f.note.nativeGatewayAttempt.bodySha256 = f.note.nativeGatewayAttemptResult.bodySha256 = createHash('sha256').update(bytes).digest('hex');
      const note = JSON.stringify(f.note); f.receipt.reservationNoteSha256 = createHash('sha256').update(note).digest('hex');
      await sql`UPDATE harness_shared.learning_spend_reservations SET note = ${note}`;
    }
    expect(await currentBenchWorkloadProviderInputReader(f.options)(f.receipt.receiptRef, binding)).toBeNull();
  });
  it('allows absent provider effort only when the exact forwarded request retains the frozen effort', async () => {
    const f = await fixture(); f.note.nativeGatewayAttemptResult.providerCompletion.providerEffort = null;
    const note = JSON.stringify(f.note); f.receipt.reservationNoteSha256 = createHash('sha256').update(note).digest('hex');
    await sql`UPDATE harness_shared.learning_spend_reservations SET note = ${note}`;
    expect((await currentBenchWorkloadProviderInputReader(f.options)(f.receipt.receiptRef, binding))?.[0].content).toBe(f.text);
  });
  async function toolFixture(kind: 'function' | 'custom' = 'function') {
    const f = await fixture(), native = await workloadToolResultFixture(binding, f, kind);
    const call = { type: kind === 'function' ? 'function_call' : 'custom_tool_call', call_id: native.receipt.callId,
      namespace: 'mcp', name: 'locks_acquire', ...(kind === 'function' ? { arguments: native.argumentsText } : { input: native.argumentsText }) };
    const output = { type: kind === 'function' ? 'function_call_output' : 'custom_tool_call_output',
      call_id: native.receipt.callId, output: native.output };
    const body = { ...f.body, input: [call, output] }, bytes = JSON.stringify(body);
    writeFileSync(join(repoRoot, f.receipt.bodyPath), bytes);
    f.note.nativeGatewayAttempt.bodySha256 = f.note.nativeGatewayAttemptResult.bodySha256 = createHash('sha256').update(bytes).digest('hex');
    const note = JSON.stringify(f.note);
    await sql`UPDATE harness_shared.learning_spend_reservations SET note = ${note}`;
    const receipt = { ...f.receipt, ...native.receipt, nativeSource: 'tool-result' as const, inputIndex: 1,
      reservationNoteSha256: createHash('sha256').update(note).digest('hex') };
    return { ...f, body, native, receipt, options: { ...f.options, receipts: [receipt] } };
  }
  async function composedFixture<F extends Awaited<ReturnType<typeof fixture>> | Awaited<ReturnType<typeof toolFixture>>>(f: F, freeze = true,
    prepare?: (input: CurrentTaskInput) => Promise<void>) {
    const protocol = currentProtocolFixture(binding.runId);
    for (const arm of protocol.arms) arm.account = f.identity.accountId;
    const input: CurrentTaskInput = { options: { workspaceId, runId: binding.runId, armId: 'papercusp', seed: 1,
      agent: 'codex', model: f.body.model, effort: 'high', account: f.identity.accountId,
      preregistration: { preregHash: f.host.preregHash, config: protocol } }, protocol,
      task: { benchmark: 'swe-bench-pro', instanceId: 't1', repo: 'fixture', baseCommit: 'a'.repeat(40),
        problemStatement: 'Private receipt composition', graderMeta: { dockerhub_tag: 't1', FAIL_TO_PASS: [], PASS_TO_PASS: [], testFiles: [] } },
      scope: { sql, workspaceId }, context: { workspaceId, principal: { slug: 'private-host' } } as CurrentTaskInput['context'],
      resources: { requestsPerArm: 2 } as CurrentTaskInput['resources'], loopId: f.host.loopId,
      hostRunId: 'private-composition-host', checkout: { dir: f.captureOptions.candidateCheckoutRoot,
        repo: 'fixture', baseCommit: 'a'.repeat(40), cleanup: async () => {} },
      observation: { runtimeWorkspaceId: 'private-runtime', workerUnit: 'worker', gatewayUnit: 'gateway' } };
    const config = { current: { preregHash: f.host.preregHash }, protocol, loopId: f.host.loopId };
    await sql`INSERT INTO harness_shared.bench_runs (id, workspace_id, arm, task_set_id, model, status, config)
      VALUES (${input.hostRunId}, ${workspaceId}, 'papercusp', 'custom', ${input.options.model!}, 'running',
        ${JSON.stringify(config)}::text::jsonb)`;
    await prepare?.(input);
    const host = await currentBenchTaskProviderCapture(input); roots.push(host.captureRoot);
    const body = JSON.stringify(f.body);
    await host.captureProviderInput({ ...f.attempt, body, bodySha256: createHash('sha256').update(body).digest('hex') });
    expect((await settleLearningSpend(sql, { workspaceId, reservationId: f.receipt.reservationId,
      disposition: 'used', usedUsd: 0.002 })).ok).toBe(true);
    if (freeze) await freezeCurrentBenchTaskProviderReservation(input, f.receipt.reservationId);
    const allocation = { harnessSlug: f.options.harnessSlug, trialBindingHash: binding.trialBindingHash,
      notBefore: f.options.notBefore, receipts: [f.receipt] };
    return { ...f, input, host, allocation };
  }
  async function lockProviderFixture(kind: 'function' | 'custom' = 'function') {
    const f = await toolFixture(kind), hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
    let selection!: Parameters<typeof currentBenchTaskLockStateReader>[1];
    const composed = await composedFixture(f, true, async input => {
      const holder = { ownerId: f.native.receipt.ownerId, ownerLabel: 'Private holder', intent: 'Hold private file', lockId: randomUUID() };
      const paths = ['src/private.ts'], domain = input.checkout.dir, start = new Date(Date.now() - 1000), expiry = new Date(Date.now() + 60_000);
      await sql`INSERT INTO agent_file_locks (coordination_domain, path, owner, owner_label, intent, goal_ref,
        lock_id, acquired_ts, expires_ts) VALUES (${domain}, ${paths[0]}, ${holder.ownerId}, ${holder.ownerLabel},
        ${holder.intent}, ${f.native.receipt.subjectId}, ${holder.lockId}::uuid, ${start}, ${expiry})`;
      const allocation: CurrentBenchLockStateAllocation = { workspaceId, harnessSlug: f.options.harnessSlug, ...binding,
        coordinationDomain: domain, notBefore: f.options.notBefore,
        receipt: { receiptRef: 'private-provider-lock:before', index: 1, phase: 'held', paths, holder,
          subjectId: f.native.receipt.subjectId } };
      const before = await freezeCurrentBenchTaskLockState(input, allocation, { locksSql: sql });
      await sql`DELETE FROM agent_file_locks`;
      const after = await freezeCurrentBenchTaskLockState(input, { ...allocation,
        receipt: { ...allocation.receipt, receiptRef: 'private-provider-lock:after', index: 3, phase: 'released' } }, { locksSql: sql });
      const args = { lock_id: holder.lockId, coordination_domain: domain }, argumentsText = canonicalJson(args);
      const records = f.native.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
      records[2].timestamp = records[3].timestamp = before.observation.at;
      Object.assign(records[2].payload, { namespace: 'mcp', name: 'locks_release',
        ...(kind === 'function' ? { arguments: argumentsText } : { input: argumentsText }) });
      const transcript = records.map(row => JSON.stringify(row) + '\n').join('');
      const [source] = await sql`SELECT file_path FROM harness_shared.interactive_usage_files`;
      writeFileSync(source.file_path, transcript);
      await sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = ${Buffer.byteLength(transcript)}`;
      const at = new Date(before.observation.at!), started = new Date(at.getTime() - 1000), ended = new Date(at.getTime() + 1000);
      await sql`UPDATE harness_shared.task_ledger SET started_at = ${started}, ended_at = ${ended}`;
      await sql`UPDATE harness_shared.adv_sessions SET started_at = ${started}`;
      await sql`UPDATE harness_shared.learning_spend_reservations SET created_at = ${new Date(at.getTime() + 100)}`;
      const [adv] = await sql`SELECT id FROM harness_shared.adv_sessions`;
      const metadata = { requestOrigin: { transport: 'mcp', mcpRequestTraceId: 'private-provider-lock-trace', nativeSession: {
        carrier: 'meta:threadId', binding: 'bound', candidateAdvSessionId: Number(adv.id),
        valueFingerprint: fingerprint(f.native.receipt.nativeSessionId), callIdFingerprint: fingerprint(f.native.receipt.callId) } } };
      const [invocation] = await sql`INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, coord_owner_id, invoked_at, duration_ms, status, args_json, metadata_json)
        VALUES (${workspaceId}, ${f.options.harnessSlug}, 'locks:release', ${holder.ownerId}, ${at}, 0, 'ok',
          ${JSON.stringify(args)}::text::jsonb, ${JSON.stringify(metadata)}::text::jsonb) RETURNING id`;
      const [row] = await sql`SELECT to_jsonb(invocation) AS invocation FROM harness_shared.tool_invocations invocation`;
      const dispatch = { invocationId: String(invocation.id), requestTraceId: 'private-provider-lock-trace', toolName: 'locks:release',
        argumentsSha256: hash(args), invocationSha256: hash(row.invocation) };
      Object.assign(f.native.receipt, { index: 2, toolName: 'mcp.locks_release', sourceSha256: fingerprint(transcript),
        argumentsSha256: fingerprint(argumentsText), dispatch });
      Object.assign(f.receipt, f.native.receipt);
      Object.assign(f.body.input[0], { name: 'locks_release', ...(kind === 'function' ? { arguments: argumentsText } : { input: argumentsText }) });
      const bodySha256 = fingerprint(JSON.stringify(f.body));
      f.note.nativeGatewayAttempt.bodySha256 = f.note.nativeGatewayAttemptResult.bodySha256 = bodySha256;
      await sql`UPDATE harness_shared.learning_spend_reservations SET note = ${JSON.stringify(f.note)}`;
      selection = { receiptRef: after.allocation.receipt.receiptRef, observationSha256: after.observationSha256,
        trialBindingHash: binding.trialBindingHash, nativeCorrelation: { operation: 'locks:release',
          receipt: { ...f.native.receipt, dispatch }, allocationSha256: hash(after.allocation),
          before: { receiptRef: before.allocation.receipt.receiptRef, observationSha256: before.observationSha256,
            allocationSha256: hash(before.allocation) }, providerInput: { ...f.native.receipt, dispatch,
            nativeSource: 'tool-result', contextId: f.receipt.contextId, consumer: f.receipt.consumer,
            reservationId: f.receipt.reservationId, inputIndex: 1 } } };
    });
    return { ...composed, selection };
  }
  it.each(['function', 'custom'] as const)('lock provider correlation preserves separate %s state, native and consumed-result authority', async kind => {
    const f = await lockProviderFixture(kind);
    // The native fixture carries extra provider fields from its base fixture;
    // those fields must not replace independent completed-request selection.
    expect(f.native.receipt).toHaveProperty('inputIndex', 0);
    expect(f.selection.nativeCorrelation!.providerInput).toHaveProperty('inputIndex', 1);
    const reader = currentBenchTaskLockStateReader(f.input, f.selection);
    await sql`UPDATE harness_shared.bench_runs SET status = 'done' WHERE id = ${f.input.hostRunId}`;
    rmSync(f.input.checkout.dir, { recursive: true });
    const [before] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    const rows = await reader(f.selection.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: 'tool-result', name: 'lock:state:released', metadata: {
      lockStateCorrelation: { nativeObservation: { content: f.native.output,
        metadata: { platformInvocationSource: { toolName: 'locks:release' } } } },
      lockProviderCorrelation: { basis: 'host-completed-request-and-exact-native-result', providerObservation: {
        kind: 'input', content: f.native.output, metadata: { nativeToolSource: { callId: f.receipt.callId },
          providerInputSource: { callId: f.receipt.callId, reservationId: f.receipt.reservationId } } } } } });
    expect(JSON.parse(rows![0].content!).locks).toHaveLength(0);
    for (const name of ['durableTransition', 'nativeToolSource', 'providerInputSource', 'businessOutcome', 'grade'])
      expect(rows?.[0].metadata).not.toHaveProperty(name);
    f.selection.nativeCorrelation!.providerInput!.consumer = 'candidate';
    expect(await reader(f.selection.receiptRef, binding)).toEqual(rows);
    expect((await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`)[0]).toEqual(before);
  });
  it.each(['receiptRef', 'subjectId', 'taskId', 'ownerId', 'label', 'codexHome', 'nativeSessionId',
    'nativeTurnId', 'callRecordIndex', 'resultRecordIndex', 'callId', 'toolName', 'sourceSha256',
    'argumentsSha256', 'outputSha256', 'index', 'dispatch'] as const)
  ('lock provider correlation refuses %s receipt borrowing before reads', async fault => {
    const f = await lockProviderFixture(), provider = f.selection.nativeCorrelation!.providerInput! as unknown as Record<string, unknown>;
    provider[fault] = fault === 'dispatch' ? { ...(provider.dispatch as object), requestTraceId: 'foreign' } : 'foreign';
    expect(() => currentBenchTaskLockStateReader(f.input, f.selection)).toThrow(/exact selected native tool-result/);
  });
  it.each(['status', 'note'] as const)('lock provider correlation refuses %s settlement drift without changing saved states', async fault => {
    const f = await lockProviderFixture(), reader = currentBenchTaskLockStateReader(f.input, f.selection);
    if (fault === 'status') await sql`UPDATE harness_shared.learning_spend_reservations SET status = 'open'`;
    else await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' '`;
    const [before] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    expect(await reader(f.selection.receiptRef, binding)).toBeNull();
    expect((await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`)[0]).toEqual(before);
  });
  it('lock provider correlation refuses a missing host settlement pin without creating one', async () => {
    const f = await lockProviderFixture(), key = f.host.allocation.accountingBinding.assignmentId;
    await sql`UPDATE harness_shared.bench_runs SET config = config #- ${['providerInputCaptures', key, 'settledProviderInputs']}::text[]`;
    const [before] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    await expect(currentBenchTaskLockStateReader(f.input, f.selection)(f.selection.receiptRef, binding)).rejects.toThrow(/explicitly frozen/);
    expect((await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`)[0]).toEqual(before);
  });
  it('host provider composition binds closed native input to settled host pins after checkout removal without writing', async () => {
    const f = await composedFixture(await fixture());
    await sql`UPDATE harness_shared.bench_runs SET status = 'done' WHERE id = ${f.input.hostRunId}`;
    rmSync(f.input.checkout.dir, { recursive: true });
    const [before] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    const reader = await currentBenchTaskProviderInputReader(f.input, f.allocation);
    const rows = await reader(f.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: 'input', content: f.text,
      metadata: { nativeInputSource: { nativeSessionId: f.receipt.nativeSessionId },
        providerInputSource: { reservationId: f.receipt.reservationId, bodyRef: f.host.readCapture(f.receipt.reservationId)!.bodyRef } } });
    expect((await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`)[0]).toEqual(before);
    expect((await sql`SELECT status FROM harness_shared.learning_spend_reservations WHERE id = ${f.receipt.reservationId}`)[0].status).toBe('settled');
    expect(await reader('foreign', binding)).toBeNull();
    expect(await reader(f.receipt.receiptRef, { ...binding, runId: 'foreign' })).toBeNull();
  });
  it.each(['function', 'custom'] as const)('host provider composition preserves exact %s tool consumption without claiming lock authority', async kind => {
    const f = await composedFixture(await toolFixture(kind));
    const rows = await (await currentBenchTaskProviderInputReader(f.input, f.allocation))(f.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: 'input', content: f.receipt.nativeSource === 'tool-result' ? f.native.output : '',
      metadata: { nativeToolSource: { callId: f.receipt.callId }, providerInputSource: { callId: f.receipt.callId } } });
    expect(rows?.[0].metadata).not.toHaveProperty('durableTransition');
  });
  it('host provider composition refuses an unfrozen final note without implicitly finalizing it', async () => {
    const f = await composedFixture(await fixture(), false);
    await expect(currentBenchTaskProviderInputReader(f.input, f.allocation)).rejects.toThrow(/explicitly frozen/);
    const [row] = await sql`SELECT config FROM harness_shared.bench_runs WHERE id = ${f.input.hostRunId}`;
    expect(row.config.providerInputCaptures[f.host.allocation.accountingBinding.assignmentId]).not.toHaveProperty('settledProviderInputs');
  });
  it('host provider composition derives provider fields from host pins rather than caller replacements', async () => {
    const f = await composedFixture(await fixture());
    Object.assign(f.allocation.receipts[0], { bodyPath: '../foreign', bodyRef: 'foreign', accountId: 'foreign',
      model: 'foreign', effort: 'low', reservationNoteSha256: 'e'.repeat(64), settledAt: 'invalid', maxBytes: 1 });
    const rows = await (await currentBenchTaskProviderInputReader(f.input, f.allocation))(f.receipt.receiptRef, binding);
    expect(rows?.[0].content).toBe(f.text);
  });
  it.each(['status', 'settled-at', 'note', 'native-source', 'native-turn', 'frozen-body', 'missing-pin', 'missing-settlement-time'])
  ('host provider composition refuses %s authority drift', async fault => {
    const f = await composedFixture(await fixture()), reader = await currentBenchTaskProviderInputReader(f.input, f.allocation);
    if (fault === 'status') await sql`UPDATE harness_shared.learning_spend_reservations SET status = 'open'`;
    if (fault === 'settled-at') await sql`UPDATE harness_shared.learning_spend_reservations SET settled_at = settled_at + interval '1 second'`;
    if (fault === 'note') await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' '`;
    if (fault === 'native-source') await sql`TRUNCATE harness_shared.interactive_usage_files`;
    if (fault === 'native-turn') {
      f.allocation.receipts[0].nativeTurnId = randomUUID();
      await expect(currentBenchTaskProviderInputReader(f.input, f.allocation)).rejects.toThrow(/native host request/); return;
    }
    if (fault === 'frozen-body' || fault === 'missing-pin' || fault === 'missing-settlement-time') {
      const path = ['providerInputCaptures', f.host.allocation.accountingBinding.assignmentId, 'settledProviderInputs', f.receipt.reservationId];
      const replacement = fault === 'missing-pin' ? null : fault === 'missing-settlement-time' ? f.host.readCapture(f.receipt.reservationId) :
        { ...f.host.readCapture(f.receipt.reservationId), bodyPath: '../foreign' };
      await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config, ${path}::text[],
        ${JSON.stringify(replacement)}::text::jsonb)`;
      await expect(currentBenchTaskProviderInputReader(f.input, f.allocation)).rejects.toThrow(); return;
    }
    expect(await reader(f.receipt.receiptRef, binding)).toBeNull();
  });
  it.each(['function', 'custom'] as const)('binds exact %s call/result consumption with completed provider identity', async kind => {
    const f = await toolFixture(kind), reader = currentBenchWorkloadProviderInputReader(f.options);
    const rows = await reader(f.receipt.receiptRef, binding);
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ kind: 'input', role: f.receipt.consumer, content: f.native.output,
      metadata: { contextId: f.receipt.contextId, nativeToolSource: { callId: f.receipt.callId },
        providerInputSource: { callId: f.receipt.callId, inputIndex: 1, responseId: 'private-response' } } });
    expect(rows?.[0].metadata).not.toHaveProperty('durableTransition');
    f.receipt.inputIndex = 0; f.receipt.callId = 'candidate';
    expect(await reader(f.native.receipt.receiptRef, binding)).toEqual(rows);
  });
  it.each(['no-call', 'duplicate-call', 'duplicate-output', 'output-before-call', 'call-name', 'call-namespace',
    'call-arguments', 'call-type', 'output-type', 'call-id', 'output-id', 'output-content', 'wrong-index',
    'foreign-native-pin', 'foreign-binding', 'missing-source', 'changed-request', 'headers-only'])
  ('refuses %s tool-result provider borrowing', async fault => {
    const f = await toolFixture();
    if (fault === 'no-call') f.body.input.shift();
    if (fault === 'duplicate-call') f.body.input.push(f.body.input[0]);
    if (fault === 'duplicate-output') f.body.input.push(f.body.input[1]);
    if (fault === 'output-before-call') { f.body.input.reverse(); f.receipt.inputIndex = 0; }
    if (fault === 'call-name') Object.assign(f.body.input[0], { name: 'other' });
    if (fault === 'call-namespace') Object.assign(f.body.input[0], { namespace: 'other' });
    if (fault === 'call-arguments') Object.assign(f.body.input[0], { arguments: '{}' });
    if (fault === 'call-type') Object.assign(f.body.input[0], { type: 'custom_tool_call', input: f.native.argumentsText });
    if (fault === 'output-type') Object.assign(f.body.input[1], { type: 'custom_tool_call_output' });
    if (fault === 'call-id') Object.assign(f.body.input[0], { call_id: 'other' });
    if (fault === 'output-id') Object.assign(f.body.input[1], { call_id: 'other' });
    if (fault === 'output-content') Object.assign(f.body.input[1], { output: 'candidate output' });
    if (fault === 'wrong-index') f.receipt.inputIndex = 0;
    if (fault === 'foreign-native-pin') f.receipt.outputSha256 = 'e'.repeat(64);
    if (fault === 'missing-source') await sql`TRUNCATE harness_shared.interactive_usage_files`;
    if (fault === 'headers-only') f.note.nativeGatewayAttemptResult = f.headers;
    const bytes = JSON.stringify(f.body) + (fault === 'changed-request' ? ' ' : '');
    writeFileSync(join(repoRoot, f.receipt.bodyPath), bytes);
    if (fault !== 'changed-request') f.note.nativeGatewayAttempt.bodySha256 =
      f.note.nativeGatewayAttemptResult.bodySha256 = createHash('sha256').update(bytes).digest('hex');
    const note = JSON.stringify(f.note); f.receipt.reservationNoteSha256 = createHash('sha256').update(note).digest('hex');
    await sql`UPDATE harness_shared.learning_spend_reservations SET note = ${note}`;
    expect(await currentBenchWorkloadProviderInputReader(f.options)(f.receipt.receiptRef,
      fault === 'foreign-binding' ? { ...binding, trialBindingHash: 'f'.repeat(64) } : binding)).toBeNull();
  });
  it('refuses ambiguous request allocations and foreign accounting bindings before reads', async () => {
    const f = await fixture();
    expect(() => currentBenchWorkloadProviderInputReader({ ...f.options, receipts: [f.receipt, { ...f.receipt, receiptRef: 'different', index: 4 }] })).toThrow(/unique exact requests/);
    expect(() => currentBenchWorkloadProviderInputReader({ ...f.options, accountingBinding: { ...f.host, workspaceId: 'foreign' } })).toThrow(/private accounting binding/);
  });
});

describe('legacy SQL usage measurement', () => {
  it('distinguishes known empty usage from an incomplete charged population', async () => {
    expect(await readBenchRunCost(sql, 'private-legacy', workspaceId))
      .toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 });
    await sql`INSERT INTO harness_shared.agent_usage_samples (workspace_id, harness_slug, run_id, input_tokens, output_tokens, cost_usd)
      VALUES (${workspaceId}, 'private-legacy', 'private-run', 100, NULL, 0.002)`;
    expect(await readBenchRunCost(sql, 'private-legacy', workspaceId))
      .toMatchObject({ tokensIn: 100, tokensOut: 0, costUsd: 0.002, turns: 1, costUsdMeasurementMissing: true });
  });
  it('reports a missing dollar measurement alongside the known token subtotal', async () => {
    await sql`INSERT INTO harness_shared.agent_usage_samples (workspace_id, harness_slug, run_id, input_tokens, output_tokens, cost_usd)
      VALUES (${workspaceId}, 'private-legacy', 'private-run', 100, 20, NULL)`;
    expect(await readBenchRunCost(sql, 'private-legacy', workspaceId))
      .toMatchObject({ tokensIn: 100, tokensOut: 20, costUsd: 0, turns: 1, costUsdMeasurementMissing: true });
  });
});

describe('production native accounting with private PG and full source bytes', () => {
  async function costFixture(maxWallClockMs = 100, repeated = false) {
    const fixtureProtocol = repeated ? controlledProtocolFixture() : currentProtocolFixture('PRIVATE', maxWallClockMs);
    if (repeated) {
      fixtureProtocol.runId = 'PRIVATE';
      for (const arm of fixtureProtocol.arms) arm.generationBudget = { maxUsd: 3, maxTokens: 1000, maxWallClockMs };
      fixtureProtocol.arms.find(arm => arm.id === 'repeated-session')!.id = 'baseline';
    }
    const opts: CurrentSuBenchOptions = { workspaceId, runId: 'PRIVATE', armId: repeated ? 'baseline' : 'papercusp', seed: 1,
      agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto',
      preregistration: { preregHash: createHash('sha256').update(repeated ? canonicalJson(fixtureProtocol) : 'private-cost-protocol')
        .digest('hex'), config: fixtureProtocol } };
    const label = currentBenchLaunchRequest(opts, handle, 'Private cost fixture.').label;
    async function addSource(home: string, ownerId: string) {
      const nativeSessionId = randomUUID(), nativeTurnId = randomUUID();
      const dir = join(home, 'sessions', '2026', '10', '10'); mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-2026-10-10T00-00-00-${nativeSessionId}.jsonl`);
      const transcript = [
        { type: 'session_meta', payload: { id: nativeSessionId, cli_version: '0.162.0' } },
        { type: 'turn_context', payload: { turn_id: nativeTurnId, model: 'configured-alias', effort: 'high' } },
        { type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 100, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 },
        } } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: nativeTurnId } },
      ].map(record => JSON.stringify(record) + '\n').join('');
      writeFileSync(file, transcript);
      const population = closedCodexSessionPopulation({ transcript, file, fileGeneration: 0, nativeSessionId });
      if (!population.ok) throw new Error(population.detail);
      await sql`INSERT INTO harness_shared.interactive_usage_files VALUES
        (${workspaceId}, ${file}, ${Buffer.byteLength(transcript)}, '{"initialized":true,"fileGeneration":0}'::jsonb)`;
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, session_id, usage_event_key, usage_provenance, cost_source, cost_usd,
         identity_activation_event_id, identity_owner_id, identity_principal_id, identity_specification_revision, identity_state_revision)
        VALUES (${workspaceId}, ${nativeSessionId}, ${population.usageEventKeys[0]},
          ${sql.json({ turnId: nativeTurnId, costBound: null })}, 'provider', 0.002,
          'private-cost-activation', ${ownerId}, 'private-cost-principal', 'private-spec', 'private-state')`;
      return { file, nativeSessionId, nativeTurnId };
    }
    async function addParticipant(taskId: string, ownerId: string, parentTaskId: string | null = null) {
      const home = join(repoRoot, taskId), source = await addSource(home, ownerId);
      const [a] = await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent)
        VALUES (${workspaceId}, ${ownerId}, ${source.nativeSessionId}, 'codex') RETURNING id`;
      hostHome.byId.set(Number(a.id), home);
      await sql`INSERT INTO harness_shared.task_ledger (task_id, workspace_id, session_id, detail, class, state, parent_task_id)
        VALUES (${taskId}, ${workspaceId}, ${source.nativeSessionId},
          ${sql.json({ coordOwnerId: ownerId, ...(parentTaskId === null ? { label } : {}) })}, 'agent-session', 'exited', ${parentTaskId})`;
      return { ...source, home, taskId, ownerId };
    }
    const solver = await addParticipant('private-cost-solver', 'su-private-cost-solver');
    async function accountingFixture(startHost = false) {
      const loopId = `private-benchmark:${randomUUID()}`, protocol = fixtureProtocol;
      const armWallClockMs = protocol.arms[0].generationBudget.maxWallClockMs!;
      const totalTokensPerArm = protocol.arms.find(arm => arm.id === opts.armId)!.generationBudget.maxTokens;
      const resources = { inputTokens: 1000, outputTokens: 100, requestsPerArm: 50,
        armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)),
        ...(totalTokensPerArm === undefined ? {} : { totalTokensPerArm }),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: armWallClockMs * 10, wallClockMsPerArm: armWallClockMs };
      await registerLearningLoop(sql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: 60,
        enabled: true, meta: { reservationBinding: opts.preregistration.preregHash, reservationResourceBudget: resources } });
      const controller = currentBenchGatewayController({ workspaceId, loopId, token: randomUUID(),
        preregHash: opts.preregistration.preregHash, protocol, armId: opts.armId, taskId: 't1', seed: 1, resources,
        authenticateProvider: async () => null });
      const binding = controller.accountingBinding;
      const hosted = startHost ? await controller.startNativeGateway(() => {},
        async () => ({ port: 32103, stop: async () => {} } as never)) : undefined;
      if (hosted) gateways.push(hosted); else controller.revoke();
      async function addAttempt(source: { nativeSessionId: string; nativeTurnId: string },
        outcome: 'response-completed' | 'fetch-failed' = 'response-completed') {
        const id = randomUUID(), identity = { attemptId: id, manifestSha256: binding.preregHash, armId: binding.assignmentId,
          nativeSessionId: source.nativeSessionId, nativeTurnId: source.nativeTurnId, transport: 'bearer-http' as const,
          accountId: 'private-provider-account', credentialHeader: 'authorization' as const,
          credentialSha256: 'b'.repeat(64), bodySha256: 'c'.repeat(64), clockId: 'private-host-clock',
          target: 'https://api.openai.com/v1/responses' };
        const receipt = await reserveLearningSpend(sql, { workspaceId, loopId, requestedUsd: 0.003, floorUsd: 0,
          attemptKind: 'evaluation', note: JSON.stringify({ nativeGatewayAttempt: identity }),
          exact: { reservationId: id, binding: binding.preregHash, expectedBudgetUsd: 60,
            resources: { armId: binding.assignmentId, inputTokens: 100, outputTokens: 10 }, expectedResourceBudget: resources } });
        const refusalClock = receipt.ok ? [] : await sql`
          SELECT EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at))) * 1000 AS age_ms
          FROM harness_shared.learning_spend_reservations
          WHERE workspace_id = ${workspaceId} AND loop_id = ${loopId}`;
        expect(receipt.ok, JSON.stringify({ receipt, refusalClock, resources })).toBe(true);
        const headers: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: id,
          outcome: outcome === 'fetch-failed' ? 'fetch-failed' : 'response-headers',
          responseStatus: outcome === 'fetch-failed' ? null : 200, costUsdMeasurementMissing: true };
        expect(await recordLearningSpendAttemptResult(sql, { workspaceId, reservationId: id, result: headers })).toEqual({ ok: true });
        if (outcome === 'response-completed') {
          const terminal: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: id, outcome, responseStatus: 200,
            costUsdMeasurementMissing: true, responseSha256: 'd'.repeat(64), responseBytes: 300,
            providerCompletion: { responseId: `response-${id}`, model: 'configured-alias', providerEffort: 'high',
              usage: { inputTokenBasis: 'inclusive', inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 0 } } };
          expect(await recordLearningSpendAttemptResult(sql, { workspaceId, reservationId: id, result: terminal })).toEqual({ ok: true });
        }
        return id;
      }
      await addAttempt(solver);
      return { binding, hosted, addAttempt, read: liveCurrentBenchNativeCostReader(handle, opts, scope(), binding) };
    }
    return { solver, addParticipant, addSource, opts, accountingFixture, read: liveCurrentBenchNativeCostReader(handle, opts, scope()) };
  }

  it('reconciles production reservation evidence with exact host-native source requests using the frozen controller scope', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    expect(await accounting.read()).toMatchObject({ costUsdMeasurementMissing: false,
      armMeta: { nativeCostAccounting: { sourceCensusComplete: true, attemptAccountingComplete: true, billedCostUsd: 0.002 } } });
    const positions = await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId, includeReservations: true });
    expect(positions.positions).toMatchObject({ unsettledUsd: 0, usedUsd: 0.002 });
    expect(positions.census).toMatchObject({ status: 'complete', reservations: [{ status: 'settled', usedUsd: 0.002 }] });
  });
  it('composes the issued host HTTP route, authenticated provider, SQL admission and native source census', async () => {
    const f = await costFixture(), protocol = currentProtocolFixture('PRIVATE', 60_000);
    prepareContext(protocol);
    f.opts.preregistration.repoRoot = repoRoot;
    protocol.maxInFlightUsd = 0.00012;
    protocol.priceSchedule.rates[0].inputTokenCeiling = 100;
    protocol.priceSchedule.rates[0].inputTokenCeilingSourceSha256 = currentBenchOpenAiInputContract('configured-alias', 100);
    f.opts.preregistration.config = protocol;
    const loopId = `private-host-http:${randomUUID()}`, key = join(repoRoot, 'private-provider-key');
    writeFileSync(key, 'PRIVATE_HOST_PROVIDER_CREDENTIAL', { mode: 0o600 });
    const account = { id: 'private-host-account', provider: 'codex' as const, credentialRef: `token:${key}` };
    const resources = { inputTokens: 1000, outputTokens: 10, requestsPerArm: 50, usdPerArm: 3,
      maxOpenUsd: protocol.maxInFlightUsd, wallClockMs: 60_000, wallClockMsPerArm: 60_000,
      armIds: protocol.arms.map(a => currentBenchAssignmentId(protocol.runId, a.id, 't1', 1)) };
    await registerLearningLoop(sql, { workspaceId, loopId, budgetKind: 'lifetime', budgetUsd: 60,
      enabled: true, meta: { reservationBinding: f.opts.preregistration.preregHash, reservationResourceBudget: resources } });
    const count = vi.fn<typeof fetch>(async () => Response.json({ object: 'response.input_tokens', input_tokens: 100 }));
    const reader = currentBenchOpenAiInputReader({ model: 'configured-alias', inputTokens: 100 }, { fetch: count });
    const auth = currentBenchProviderAuthenticator({ workspaceId, preregHash: f.opts.preregistration.preregHash,
      protocol, armId: 'papercusp', taskId: 't1', seed: 1, readNativeInputCeiling: reader.read }, {
      readAccount: async (_workspace, id) => id === account.id ? account : null,
      credentialResolver: (_provider, ref) => makeBearerCredentialResolver(ref),
    });
    const authenticate = vi.fn(auth.authenticateProvider);
    const controller = currentBenchGatewayController({ workspaceId, loopId, token: 'h'.repeat(64),
      preregHash: f.opts.preregistration.preregHash, protocol, resources, armId: 'papercusp', taskId: 't1', seed: 1,
      authenticateProvider: authenticate }, { enabled: async () => true, getSql: async () => sql, log: () => {} });
    const providerEvidence: Array<{ target: string; credentialMatches: boolean; model: string; outputLimit: number;
      beforeSend: Awaited<ReturnType<typeof getLearningSpendPositions>> }> = [];
    const provider = vi.fn<typeof fetch>(async (target, init) => {
      // The maintained bearer adapter forwards Uint8Array, whose String()
      // representation is comma-separated byte values, not the JSON text.
      const body = JSON.parse(typeof init?.body === 'string' ? init.body :
        new TextDecoder().decode(init?.body as Uint8Array));
      providerEvidence.push({ target: String(target),
        credentialMatches: new Headers(init?.headers).get('authorization') === 'Bearer PRIVATE_HOST_PROVIDER_CREDENTIAL',
        model: body.model, outputLimit: body.max_output_tokens,
        beforeSend: await getLearningSpendPositions(sql, { workspaceId, loopId, includeReservations: true }) });
      return Response.json({ id: 'host-http-provider-response', model: 'configured-alias', status: 'completed',
        reasoning: { effort: 'high' }, output: [],
        usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } } });
    });
    const hosted = await controller.startNativeGateway(() => {}, options => startGatewayService({ ...options,
      checkGoalInferenceAdmission: goalAdmission,
      readAcceptedOperationModelPolicy: operationPolicy,
      recordAcceptedOperationModelAttestation: operationAttestation,
      resolveAccounts: async () => [{ accountId: account.id, credentialRef: account.credentialRef, source: 'env' }],
      resolveLocalBackends: async () => [], observePool: () => () => {}, fetchImpl: provider,
      refreshIntervalMs: 0, poolReloadIntervalMs: 0, localBackendReloadIntervalMs: 0 }));
    const ports = liveCurrentSuBenchPorts(ctx, { ...hosted, admit: async () => ({ admitted: true, receiptRef: 'host-http:admit' }),
      observeIdentity: async () => null }, f.opts, scope());
    const send = () => fetch(`${hosted.nativeGateway.baseURL}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hosted.nativeGateway.token}`,
        'x-papercusp-owner': f.solver.ownerId },
      body: JSON.stringify({ model: 'configured-alias', input: 'private benchmark task', instructions: 'private native instructions',
        tools: [{ type: 'function', name: 'private_native_tool', parameters: { type: 'object' } }], reasoning: { effort: 'high' },
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: f.solver.nativeSessionId, turn_id: f.solver.nativeTurnId }) } }),
    });
    try {
      const context = await ports.restoreContext(handle, 't1');
      await ports.launch(currentBenchLaunchRequest(f.opts, handle, 'private task', context));
      expect(native.launch.mock.calls.at(-1)![1][Symbol.for('benchmark-test-private-route')]).toEqual(hosted.nativeGateway);
      goalAdmission.mockResolvedValueOnce({ allowed: false, goalId: 'private-denied-goal', status: 403,
        code: 'goal_budget_exhausted', message: 'Private fixture goal allowance exhausted.' });
      const withheld = await send(), withheldBody = await withheld.text();
      expect(goalAdmission).toHaveBeenCalledExactlyOnceWith(f.solver.ownerId);
      expect(withheld.status, withheldBody).toBe(403); expect(withheldBody).toContain('goal_budget_exhausted');
      expect(count).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
      expect(operationPolicy).not.toHaveBeenCalled();
      operationPolicy.mockResolvedValueOnce({ status: 'unavailable', reason: 'private fixture policy unavailable' });
      const unavailable = await send(), unavailableBody = await unavailable.text();
      expect(unavailable.status, unavailableBody).toBe(503);
      expect(unavailableBody).toContain('private fixture policy unavailable');
      expect(operationPolicy).toHaveBeenCalledExactlyOnceWith(f.solver.ownerId, 'codex');
      expect(count).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
      expect((await getLearningSpendPositions(sql, { workspaceId, loopId })).positions.reservedUsd).toBe(0);
      await sql`INSERT INTO harness_shared.runtime_vintage VALUES
        ('private-current-runtime', 'private-current-worker', ${hostname()}, ${'a'.repeat(40)}, null, null, ${process.pid},
         ${sql.json({ kernelProcessIdentity: readProcessIdentity(process.pid) })},
         ${new Date(Date.now() - 10_000).toISOString()}::timestamptz)`;
      const accepted = await send(), acceptedBody = await accepted.text();
      const authority = await authenticate.mock.results.at(-1)?.value;
      const lastAttempt = authenticate.mock.calls.at(-1)?.[0];
      expect(accepted.status, JSON.stringify({ body: acceptedBody, counted: count.mock.calls.length,
        authenticated: authenticate.mock.calls.length, target: lastAttempt?.target,
        transport: lastAttempt?.transport, accountId: lastAttempt?.accountId,
        bodyFields: lastAttempt ? Object.keys(JSON.parse(lastAttempt.body)) : [],
        authority: authority ? { inputTokens: authority.inputTokens, outputTokens: authority.outputTokens, requestedUsd: authority.requestedUsd } : null,
        providerCalls: provider.mock.calls.length,
        providerBodyKind: provider.mock.calls[0]?.[1]?.body?.constructor.name,
        providerEvidence, positions: (await getLearningSpendPositions(sql, { workspaceId, loopId })).positions })).toBe(200);
      expect(provider).toHaveBeenCalledOnce();
      expect(operationAttestation).not.toHaveBeenCalled();
      expect(providerEvidence).toHaveLength(1);
      expect(providerEvidence[0]).toMatchObject({ target: 'https://api.openai.com/v1/responses', credentialMatches: true,
        model: 'configured-alias', outputLimit: 10, beforeSend: { positions: { unsettledUsd: 0.00012 },
          census: { status: 'complete', reservations: [{ status: 'open' }] } } });
      const nativeTasks = await sql`SELECT started_at FROM harness_shared.task_ledger WHERE task_id = ${f.solver.taskId}`;
      const nativeTask: CurrentBenchTask = { taskId: f.solver.taskId, workspaceId, sessionId: f.solver.nativeSessionId,
        startedAt: new Date(nativeTasks[0].started_at).toISOString(), state: 'exited', exitCode: 0,
        detail: { coordOwnerId: f.solver.ownerId } };
      const observationOptions = { ...scope(), runtimeWorkspaceId: 'private-current-runtime',
        workerUnit: 'private-current-worker', gatewayUnit: 'unregistered-private-gateway', gatewayBaseUrl: hosted.nativeGateway.baseURL };
      // Diagnose the real IO prerequisites before the composite fail-closed
      // reader can collapse them to null. This is the same acceptance boundary
      // exercised below for a separately supervised gateway.
      const observationIo = liveCurrentBenchObservationReaderPorts(observationOptions, hosted);
      expect(await observationIo.readBinding(nativeTask), 'issued host stage: exact SQL binding').toEqual({
        ownerId: f.solver.ownerId, nativeSessionId: f.solver.nativeSessionId, codexHome: f.solver.home });
      const runtimeRows = await observationIo.readRuntimes();
      expect(observationIo.measureRuntimes(runtimeRows, ['private-current-worker']), 'issued host stage: boot identity').toMatch(/^[a-f0-9]{64}$/);
      expect(await observationIo.readTranscript(f.solver.nativeSessionId, f.solver.home), 'issued host stage: full native transcript')
        .toBe(readFileSync(f.solver.file, 'utf8'));
      const hostReport = await observationIo.readGateway(f.solver.ownerId);
      expect(hostReport, 'issued host stage: process-matched HTTP report').toMatchObject({ owner: f.solver.ownerId,
        process: { pid: process.pid, identity: readProcessIdentity(process.pid) }, stageTelemetry: { ownerId: f.solver.ownerId } });
      const timeline = hostReport!.stageTelemetry.recent.filter(row => row.nativeCorrelation.status === 'observed' &&
        row.nativeCorrelation.threadId === f.solver.nativeSessionId).sort((a, b) => b.finalizedAt - a.finalizedAt)[0];
      expect(timeline, 'issued host stage: exact provider/native request').toMatchObject({
        nativeCorrelation: { status: 'observed', threadId: f.solver.nativeSessionId, turnId: f.solver.nativeTurnId },
        providerIdentity: { model: 'configured-alias', responseId: 'host-http-provider-response', accountId: account.id },
        forwardedEffort: 'high', outcome: 'ok', finalStatus: 200 });
      expect(timeline.startedAt, 'issued host stage: request after all pinned lifetimes').toBeGreaterThanOrEqual(Math.max(
        Date.parse(nativeTask.startedAt!), Date.parse(runtimeRows[0].reportedAt), hostReport!.process.startedAt));
      expect(currentBenchIdentityFromObservation(nativeTask, {
        worker: { taskId: nativeTask.taskId, workspaceId, ownerId: f.solver.ownerId, nativeSessionId: f.solver.nativeSessionId,
          runtimeRevision: observationIo.measureRuntimes(runtimeRows, ['private-current-worker'])!,
          sourceRevision: 'a'.repeat(40), evidenceRef: 'runtime-vintage:private-issued-host' },
        nativeTranscript: readFileSync(f.solver.file, 'utf8'), gateway: { processRef: `gateway:${hostReport!.process.identity}`, timeline },
      }), 'issued host stage: native/provider identity agreement').not.toBeNull();
      const observed = await currentBenchObservationReader(observationOptions, observationIo, hosted)(nativeTask);
      expect(observed, 'issued private HTTP service needs only the actual host boot record').not.toBeNull();
      expect(currentBenchIdentityFromObservation(nativeTask, observed!)).toMatchObject({ sourceRevision: 'a'.repeat(40),
        model: 'configured-alias', accountId: account.id, clientVersion: 'codex/0.162.0', providerResponseId: 'host-http-provider-response' });
      expect(await ports.collectCost!({ handle, workspaceId })).toMatchObject({ costUsdMeasurementMissing: false,
        armMeta: { nativeCostAccounting: { attemptAccountingComplete: true, billedCostUsd: 0.002 } } });
      const denied = await send(); expect(denied.status).toBe(403); await denied.text();
      expect(provider).toHaveBeenCalledOnce();
      const final = await getLearningSpendPositions(sql, { workspaceId, loopId, includeReservations: true });
      expect(final.positions).toMatchObject({ unsettledUsd: 0, usedUsd: 0.002 });
      expect(final.positions.overrunAttempts).toBe(1);
      expect(final.census).toMatchObject({ status: 'complete', reservations: [{ status: 'settled', usedUsd: 0.002 }] });
      if (final.census?.status !== 'complete') throw new Error('Incomplete private SQL census');
      const note = final.census.reservations[0].note!;
      expect(note).not.toContain('PRIVATE_HOST_PROVIDER_CREDENTIAL');
      expect(JSON.parse(note)).toMatchObject({ nativeGatewayAttemptResult: { outcome: 'response-completed',
        providerCompletion: { responseId: 'host-http-provider-response' } } });
      expect(count).toHaveBeenCalledTimes(2);
    } finally { await hosted.stop(); controller.revoke(); auth.revoke(); reader.revoke(); }
  });
  it('joins every recovered native file and unlabeled reviewer request to the same exact assignment', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    const recovered = await f.addSource(f.solver.home, f.solver.ownerId);
    const reviewer = await f.addParticipant('private-reviewer', 'private-reviewer-owner', f.solver.taskId);
    await sql`UPDATE harness_shared.agent_usage_samples SET cost_usd = 0.007 WHERE identity_owner_id = ${reviewer.ownerId}`;
    await accounting.addAttempt(recovered); await accounting.addAttempt(reviewer);
    const result = await accounting.read();
    expect(result.costUsd).toBeCloseTo(0.00033, 10);
    expect(result).toMatchObject({ costUsdMeasurementMissing: false,
      armMeta: { nativeCostAccounting: { attemptAccountingComplete: true, billedCostUsd: 0.011 } } });
    const positions = await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId, includeReservations: true });
    expect(positions.positions.usedUsd).toBeCloseTo(0.011, 12);
    expect(positions.positions.unsettledUsd).toBe(0);
    if (positions.census?.status !== 'complete') throw new Error('Incomplete role settlement census');
    expect(positions.census.reservations.map(row => row.status)).toEqual(['settled', 'settled', 'settled']);
    expect(positions.census.reservations.map(row => row.usedUsd).sort()).toEqual([0.002, 0.002, 0.007]);
  });
  it.each(['complete', 'missing-successor-bill'] as const)(
    'measures a fresh recovered session through production source and billing readers (%s)', async evidence => {
      // Source bytes and provider bills are private fixtures. The runtime census,
      // identity attribution, settlement and delta readers are production code.
      // This protocol permits the full two-session SQL workflow. The helper's
      // default 100 ms protocol remains available for short-budget controls.
      const f = await costFixture(60_000), accounting = await f.accountingFixture();
      const before = requireCurrentBenchNativeRunCost(await accounting.read());
      const successor = await f.addSource(f.solver.home, f.solver.ownerId);
      await sql`UPDATE harness_shared.adv_sessions SET session_id = ${successor.nativeSessionId}
        WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${f.solver.ownerId}`;
      await accounting.addAttempt(successor);
      if (evidence === 'missing-successor-bill') {
        await sql`DELETE FROM harness_shared.agent_usage_samples
          WHERE workspace_id = ${workspaceId} AND session_id = ${successor.nativeSessionId}`;
      }
      const after = await accounting.read();
      if (evidence === 'missing-successor-bill') {
        expect(after).toMatchObject({ costUsdMeasurementMissing: true,
          armMeta: { nativeCostAccounting: { billedCostUsd: null, sourceCensusComplete: true } } });
        expect(() => currentBenchNativeSessionCostDelta(before,
          requireCurrentBenchNativeRunCost(after), successor.nativeSessionId)).toThrow(/incomplete/);
        return;
      }
      const complete = requireCurrentBenchNativeRunCost(after);
      expect(complete).toMatchObject({ tokensIn: 160, tokensOut: 20, tokensCacheRead: 40,
        armMeta: { nativeCostAccounting: { billedCostUsd: 0.004, attemptAccountingComplete: true } } });
      const delta = currentBenchNativeSessionCostDelta(before, complete, successor.nativeSessionId);
      expect(delta).toMatchObject({ nativeSessionId: successor.nativeSessionId, tokensIn: 80,
        tokensOut: 10, tokensCacheRead: 20, billedCostUsd: 0.002, sourceComplete: true });
      expect(delta.normalizedCostUsd).toBeCloseTo(before.costUsd, 12);
      expect(complete.armMeta.nativeCostAccounting.sources).toHaveLength(2);
      expect(() => currentBenchNativeSessionCostDelta(before, complete, f.solver.nativeSessionId))
        .toThrow(/reused|non-monotone/);
      // Rereading a recovered home must neither change its receipts nor bill its
      // predecessor again after the native session pointer moves to the successor.
      expect(await accounting.read()).toEqual(complete);
      const positions = await getLearningSpendPositions(sql,
        { workspaceId, loopId: accounting.binding.loopId, includeReservations: true });
      expect(positions.positions).toMatchObject({ usedUsd: 0.004, unsettledUsd: 0 });
      expect(await listLearningSpendEvents(sql, { workspaceId, loopId: accounting.binding.loopId }))
        .toHaveLength(2);
    });
  it('carries production measured usage through retired and fresh host-issued session allowances', async () => {
    // Native source bytes and bills are fixtures; this joins the production
    // SQL/accounting and allowance lifecycles without launching a client or inference.
    const f = await costFixture(60_000, true), accounting = await f.accountingFixture(true);
    const hosted = accounting.hosted!;
    const observations = (sessionBudget: ReturnType<typeof hosted.issueSessionBudget>) => ({ ...hosted, sessionBudget,
      admit: async () => ({ admitted: true, receiptRef: 'private-measured-allowance' }), observeIdentity: async () => null });
    const ports = (sessionBudget: ReturnType<typeof hosted.issueSessionBudget>) =>
      liveCurrentSuBenchPorts(ctx, observations(sessionBudget), f.opts, scope());
    const total = { maxUsd: 0.001, maxTokens: 1000, maxWallClockMs: 60_000 };
    const first = hosted.issueSessionBudget(total), firstPorts = ports(first);
    await firstPorts.admit(handle, first.budget, 't1');
    beginCurrentBenchNativeSession(observations(first), f.opts, handle)();
    const before = requireCurrentBenchNativeRunCost(await accounting.read());
    await firstPorts.releaseGateway!();
    expect(() => beginCurrentBenchNativeSession(observations(first), f.opts, handle)).toThrow(/active host-issued/);
    const remaining = { ...total, maxUsd: total.maxUsd - before.costUsd,
      maxTokens: total.maxTokens - before.tokensIn - before.tokensOut - before.tokensCacheRead! - before.tokensCacheWrite! };
    const second = hosted.issueSessionBudget(remaining, before), secondPorts = ports(second);
    expect(second.index).toBe(1);
    expect(second.priorUsage).toEqual({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, tokensCacheWrite: 0,
      costUsd: before.costUsd });
    expect(second.budget).toEqual(remaining);
    const copied = { ...second };
    await expect(ports(copied).admit(handle, remaining, 't1')).rejects.toThrow(/active host-issued/);
    await secondPorts.admit(handle, remaining, 't1');
    const spawn = beginCurrentBenchNativeSession(observations(second), f.opts, handle);
    spawn(); expect(() => spawn()).toThrow(/already spawned/);
    const successor = await f.addSource(f.solver.home, f.solver.ownerId);
    await sql`UPDATE harness_shared.adv_sessions SET session_id = ${successor.nativeSessionId}
      WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${f.solver.ownerId}`;
    await accounting.addAttempt(successor);
    const after = requireCurrentBenchNativeRunCost(await accounting.read());
    const delta = currentBenchNativeSessionCostDelta(before, after, successor.nativeSessionId);
    expect(delta).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, billedCostUsd: 0.002 });
    expect(after.costUsd - second.priorUsage!.costUsd).toBeCloseTo(delta.normalizedCostUsd, 12);
    expect(after.armMeta.nativeCostAccounting.billedCostUsd).toBe(0.004);
    await secondPorts.releaseGateway!();
    const third = hosted.issueSessionBudget({ ...remaining, maxUsd: total.maxUsd - after.costUsd }, after);
    expect(third.index).toBe(2);
    expect(third.priorUsage?.costUsd).toBe(after.costUsd);
    expect(await accounting.read()).toEqual(after);
    expect(await listLearningSpendEvents(sql, { workspaceId, loopId: accounting.binding.loopId })).toHaveLength(2);
    await ports(third).releaseGateway!();
  });
  it('settles only the source-matched provider bill once and preserves its request provenance', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    await accounting.read(); await accounting.read();
    const final = await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId, includeReservations: true });
    expect(final.positions).toMatchObject({ usedUsd: 0.002, unsettledUsd: 0 });
    expect(await listLearningSpendEvents(sql, { workspaceId, loopId: accounting.binding.loopId })).toHaveLength(1);
    if (final.census?.status !== 'complete') throw new Error('Incomplete settlement census');
    const note = JSON.parse(final.census.reservations[0].note!);
    expect(note).toMatchObject({ nativeGatewayAttemptResult: { outcome: 'response-completed' },
      nativeGatewaySettlement: { billedInferenceMicros: '2000', nativeSessionId: f.solver.nativeSessionId,
        nativeTurnId: f.solver.nativeTurnId, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        usageEventKey: expect.stringMatching(/^[a-f0-9]{64}$/), sampleId: expect.any(String),
        activationEventId: 'private-cost-activation' } });
  });
  it('refuses settlement when the reservation changed after its bill was matched', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    const before = await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId, includeReservations: true });
    if (before.census?.status !== 'complete') throw new Error('Incomplete settlement census');
    const row = before.census.reservations[0];
    const expectedNoteSha256 = createHash('sha256').update(row.note!).digest('hex');
    await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' ' WHERE id = ${row.id}`;
    expect(await settleLearningSpend(sql, { workspaceId, reservationId: row.id, disposition: 'used', usedUsd: 0.002,
      expectedNoteSha256 })).toMatchObject({ ok: false, reason: 'reservation-changed', reservation: { status: 'open' } });
    expect((await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId })).positions.unsettledUsd).toBe(0.003);
    expect(await listLearningSpendEvents(sql, { workspaceId, loopId: accounting.binding.loopId })).toHaveLength(0);
  });
  it('keeps failed retry exposure and efficiency uncertainty even when the completed request has a native source and bill', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    await accounting.addAttempt(f.solver, 'fetch-failed');
    expect(await accounting.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { attemptAccountingComplete: false, billedCostUsd: null, billedKnownSubtotalUsd: 0.002 } } });
    expect((await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId })).positions.unsettledUsd).toBe(0.006);
  });
  it('does not replace actual provider billing with matched native token usage', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    await sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimate'`;
    expect(await accounting.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { attemptAccountingComplete: true, billedCostUsd: null, missingBills: 1 } } });
    expect((await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId })).positions.unsettledUsd).toBe(0.003);
  });
  it('settles a repaired provider measurement after retaining the earlier unknown exposure', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    await sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimate'`;
    expect((await accounting.read()).costUsdMeasurementMissing).toBe(true);
    expect(await listLearningSpendEvents(sql, { workspaceId, loopId: accounting.binding.loopId })).toHaveLength(0);
    await sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'provider'`;
    expect((await accounting.read()).costUsdMeasurementMissing).toBe(false);
    expect((await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId })).positions)
      .toMatchObject({ usedUsd: 0.002, unsettledUsd: 0, openAttempts: 0 });
  });
  it('refuses a mutated complete reservation population during native source validation', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    let frontiers = 0;
    const guarded = new Proxy(sql, { apply(target, self, args) {
      const result = Reflect.apply(target, self, args);
      if (!String(args[0]).includes('harness_shared.interactive_usage_files') || ++frontiers !== 2) return result;
      return Promise.resolve(result).then(async rows => {
        await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' ' WHERE loop_id = ${accounting.binding.loopId}`;
        return rows;
      });
    } });
    expect(await liveCurrentBenchNativeCostReader(handle, f.opts, { ...scope(), sql: guarded as unknown as ReturnType<typeof scope>['sql'] }, accounting.binding)())
      .toMatchObject({ costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { attemptAccountingComplete: false, billedCostUsd: null } } });
    expect(frontiers).toBeGreaterThanOrEqual(2);
    expect((await getLearningSpendPositions(sql, { workspaceId, loopId: accounting.binding.loopId })).positions.unsettledUsd).toBe(0.003);
  });
  it('rejects a fabricated controller scope before accounting IO', async () => {
    const f = await costFixture(), accounting = await f.accountingFixture();
    expect(() => liveCurrentBenchNativeCostReader(handle, f.opts, scope(), { ...accounting.binding, preregHash: 'f'.repeat(64) }))
      .toThrow('exact frozen controller binding');
  });

  it('uses exact full native bytes and provider attribution while leaving gateway-attempt reconciliation explicit', async () => {
    const f = await costFixture(), result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { normalizedCostUsd: result.costUsd, billedKnownSubtotalUsd: 0.002,
        billedCostUsd: null, sourceCensusComplete: true, attemptAccountingComplete: false, missingBills: 0 } } });
  });
  it('includes an unlabeled native reviewer subtree and excludes another workspace', async () => {
    const f = await costFixture();
    await f.addParticipant('private-cost-reviewer', 'su-private-cost-reviewer', f.solver.taskId);
    await sql`INSERT INTO harness_shared.task_ledger (task_id, workspace_id, detail, class, state, parent_task_id)
      VALUES ('foreign-workspace-task', 'other-workspace', '{"coordOwnerId":"foreign-owner"}'::jsonb, 'agent-session', 'running', ${f.solver.taskId})`;
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00022, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { sourceCensusComplete: true, billedKnownSubtotalUsd: 0.004,
      participantTaskIds: ['private-cost-reviewer', 'private-cost-solver'] } });
  });
  it('projects exact recursive task lifetimes and refuses an unknown end instead of reporting free time', async () => {
    const f = await costFixture();
    await f.addParticipant('private-cost-reviewer', 'su-private-cost-reviewer', f.solver.taskId);
    await sql`UPDATE harness_shared.task_ledger SET started_at = '2026-01-01T00:00:00Z', ended_at = '2026-01-01T00:00:00.100Z'
      WHERE task_id = ${f.solver.taskId}`;
    await sql`UPDATE harness_shared.task_ledger SET started_at = '2026-01-01T00:00:00.010Z', ended_at = '2026-01-01T00:00:00.020Z'
      WHERE task_id = 'private-cost-reviewer'`;
    const result = await f.read();
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { taskLedgerConcurrency: {
      basis: 'task-ledger-lifetime', averageBasis: 'time-weighted', complete: true, participantCensusStable: true,
      startedAtMs: Date.parse('2026-01-01T00:00:00Z'), endedAtMs: Date.parse('2026-01-01T00:00:00.100Z'),
      wallClockMs: 100, participantWallClockMs: 110,
      concurrencyTimeline: { peakConcurrent: 2, avgConcurrent: 1.1,
        samples: [{ tMs: 0, live: 1 }, { tMs: 10, live: 2 }, { tMs: 20, live: 1 }, { tMs: 100, live: 0 }] } } } });
    await sql`UPDATE harness_shared.task_ledger SET ended_at = NULL WHERE task_id = 'private-cost-reviewer'`;
    expect(await f.read()).toMatchObject({ armMeta: { nativeCostAccounting: { taskLedgerConcurrency: {
      complete: false, missingTimingTaskIds: ['private-cost-reviewer'], wallClockMs: null,
      participantWallClockMs: null, concurrencyTimeline: null } } } });
  });
  it('accounts for the prior carry source even though adv_sessions names only the latest native session', async () => {
    const f = await costFixture(); await f.addSource(f.solver.home, f.solver.ownerId);
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00022, 10); expect(result.turns).toBe(2);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { sourceCensusComplete: true, billedKnownSubtotalUsd: 0.004 } });
  });
  it('preserves normalized tokens when ledger dollars are estimated rather than provider bills', async () => {
    const f = await costFixture(); await sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimated'`;
    const result = await f.read(); expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { billedCostUsd: null, billedKnownSubtotalUsd: 0, missingBills: 1 } });
  });
  it.each(['open turn', 'partial record'] as const)('preserves a source-proven closed subtotal before an incomplete %s without certifying a total', async tail => {
    const f = await costFixture();
    const source = readFileSync(f.solver.file, 'utf8');
    const suffix = tail === 'open turn' ? JSON.stringify({ type: 'turn_context', payload: {
      turn_id: randomUUID(), model: 'configured-alias' } }) + '\n' : '{"type":"event_msg"';
    writeFileSync(f.solver.file, source + suffix);
    const result = await f.read();
    expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result).toMatchObject({ tokensIn: 80, tokensOut: 10, tokensCacheRead: 20, turns: 1,
      costUsdMeasurementMissing: true, armMeta: { nativeCostAccounting: { sourceCensusComplete: false,
        billedKnownSubtotalUsd: 0.002, billedCostUsd: null, missingSources: 1, missingBills: 0 } } });
  });
  it('marks an incomplete ingest frontier as missing usage without guessing free work', async () => {
    const f = await costFixture(); await sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = 0`;
    expect(await f.read()).toMatchObject({ costUsdMeasurementMissing: true,
      armMeta: { nativeCostAccounting: { sourceCensusComplete: false, missingSources: 1, billedCostUsd: null } } });
  });
  it('preserves known cost while refusing an unbound or foreign billed identity', async () => {
    const f = await costFixture(); await sql`UPDATE harness_shared.agent_usage_samples SET identity_owner_id = 'foreign-owner'`;
    const result = await f.read(); expect(result.costUsd).toBeCloseTo(0.00011, 10);
    expect(result.armMeta).toMatchObject({ nativeCostAccounting: { billedCostUsd: null, billedKnownSubtotalUsd: 0, missingBills: 1 } });
  });
});
let hostProvider: http.Server | undefined;
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.stop();
  await hostGateway?.close(); hostGateway = undefined;
  if (hostProvider) await new Promise<void>(resolve => hostProvider!.close(() => resolve()));
  hostProvider = undefined; resetGovernorRegistry();
});

async function hostFixture() {
  resetGovernorRegistry();
  const ownerId = `su-private-${randomUUID()}`, nativeSessionId = randomUUID(), turnId = randomUUID();
  const taskId = `host-task-${randomUUID()}`, taskAt = new Date(Date.now() - 5000).toISOString();
  hostHome.path = join(repoRoot, 'native-home');
  const dir = join(hostHome.path, 'sessions', '2026', '10', '10'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-10T00-00-00-${nativeSessionId}.jsonl`);
  writeFileSync(file, [
    { type: 'session_meta', payload: { id: nativeSessionId, cli_version: '0.162.0' } },
    { type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-6-sol', effort: 'high' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent)
    VALUES (${workspaceId}, ${ownerId}, ${nativeSessionId}, 'codex')`;
  await sql`INSERT INTO harness_shared.task_ledger (task_id, workspace_id, session_id, detail) VALUES (${taskId}, ${workspaceId}, ${nativeSessionId},
    ${sql.json({ coordOwnerId: ownerId })})`;
  const storedBinding = await sql`
    SELECT t.session_id, t.detail, jsonb_typeof(t.detail) AS detail_type, a.coord_owner_id
    FROM harness_shared.task_ledger t JOIN harness_shared.adv_sessions a
      ON a.workspace_id = t.workspace_id AND a.session_id = t.session_id
    WHERE t.task_id = ${taskId} AND t.workspace_id = ${workspaceId}`;
  expect(storedBinding, 'host stage: SQL stores object-valued task attribution').toMatchObject([
    { session_id: nativeSessionId, detail: { coordOwnerId: ownerId }, detail_type: 'object', coord_owner_id: ownerId },
  ]);
  hostProvider = http.createServer((req, res) => {
    req.resume(); req.once('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp-private-host', model: 'gpt-6-sol', status: 'completed', output: [],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
    });
  });
  await new Promise<void>(resolve => hostProvider!.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (hostProvider.address() as { port: number }).port;
  hostGateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
    codexPool: createFailoverPool([{ accountId: 'private-account', token: async () => 'PRIVATE_LOOPBACK_TOKEN' }]),
    openaiUpstreamBase: `http://127.0.0.1:${upstreamPort}`, requestAbsorbMs: 0, selfHeal: { enabled: false } });
  const port = await hostGateway.listen(0), gatewayBaseUrl = `http://127.0.0.1:${port}`;
  const processPin = readProcessIdentity(process.pid);
  expect(processPin).toBeTruthy();
  for (const unit of ['host-worker', 'host-gateway']) {
    await sql`INSERT INTO harness_shared.runtime_vintage VALUES
      ('host-runtime-private', ${unit}, ${hostname()}, ${'a'.repeat(40)}, null, null, ${process.pid},
       ${sql.json({ kernelProcessIdentity: processPin, ...(unit === 'host-gateway' ? { port } : {}) })},
       ${new Date(Date.now() - 10_000).toISOString()}::timestamptz)`;
  }
  const response = await fetch(`${gatewayBaseUrl}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-owner': ownerId },
    body: JSON.stringify({ model: 'gpt-6-sol', input: 'PRIVATE_FIXTURE_INPUT', instructions: 'PRIVATE_FIXTURE_SYSTEM',
      tools: [{ type: 'function', name: 'private_tool', parameters: { type: 'object' } }], reasoning: { effort: 'high' },
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: nativeSessionId, turn_id: turnId }) } }) });
  expect(response.status).toBe(200); await response.text();
  const task: CurrentBenchTask = { taskId, workspaceId, sessionId: nativeSessionId, startedAt: taskAt,
    state: 'exited', exitCode: 0, detail: { coordOwnerId: ownerId } };
  const options = { ...scope(), runtimeWorkspaceId: 'host-runtime-private',
    workerUnit: 'host-worker', gatewayUnit: 'host-gateway', gatewayBaseUrl };
  const io = liveCurrentBenchObservationReaderPorts(options);
  // Assert each real IO precondition before the composite reader can collapse
  // a failure to null. Every negative test starts from this verified fixture.
  const binding = await io.readBinding(task);
  expect(binding, 'host stage: exact SQL binding').toEqual({ ownerId, nativeSessionId, codexHome: hostHome.path });
  const runtimes = await io.readRuntimes();
  const units = ['host-worker', 'host-gateway'];
  const environment = io.measureRuntimes(runtimes, units);
  const runtimeRevision = io.measureRuntimes(runtimes, ['host-worker']);
  expect(environment, 'host stage: live runtime environment').toMatch(/^[a-f0-9]{64}$/);
  expect(runtimeRevision, 'host stage: live worker identity').toMatch(/^[a-f0-9]{64}$/);
  expect(await io.readTranscript(nativeSessionId, hostHome.path), 'host stage: stable native transcript')
    .toBe(readFileSync(file, 'utf8'));
  const report = await io.readGateway(ownerId);
  expect(report, 'host stage: local gateway report').toMatchObject({ owner: ownerId,
    process: { pid: process.pid, identity: processPin }, stageTelemetry: { ownerId } });
  const recent = report!.stageTelemetry.recent;
  expect(recent, 'host stage: finalized request census').toHaveLength(1);
  const timeline = recent[0];
  expect(timeline, 'host stage: exact native correlation and provider identity').toMatchObject({
    nativeCorrelation: { status: 'observed', threadId: nativeSessionId, turnId },
    providerIdentity: { model: 'gpt-6-sol', responseId: 'resp-private-host', accountId: 'private-account' },
    forwardedEffort: 'high', outcome: 'ok', finalStatus: 200,
  });
  expect(timeline.startedAt, 'host stage: request after pinned lifetimes').toBeGreaterThanOrEqual(
    Math.max(Date.parse(taskAt), Date.parse(runtimes.find(row => row.unit === 'host-worker')!.reportedAt), report!.process.startedAt));
  expect(io.measureRuntimes(await io.readRuntimes(), units), 'host stage: unchanged runtime environment').toBe(environment);
  expect(currentBenchIdentityFromObservation(task, {
    worker: { taskId, workspaceId, ownerId, nativeSessionId, runtimeRevision: runtimeRevision!,
      sourceRevision: 'a'.repeat(40), evidenceRef: 'runtime-vintage:private-physical-fixture' },
    nativeTranscript: readFileSync(file, 'utf8'), gateway: { processRef: `gateway:${processPin}`, timeline },
  }), 'host stage: native/provider identity agreement').not.toBeNull();
  const read = currentBenchObservationReader(options);
  return { task, read, file, ownerId, nativeSessionId };
}

describe('host-backed benchmark observation with private physical IO', () => {
  it('joins actual private SQL, transcript bytes, process pins and gateway provider evidence', async () => {
    const f = await hostFixture(), observation = await f.read(f.task);
    expect(observation).not.toBeNull();
    expect(currentBenchIdentityFromObservation(f.task, observation!)).toMatchObject({
      sourceRevision: 'a'.repeat(40), model: 'gpt-6-sol', clientVersion: 'codex/0.162.0',
      accountId: 'private-account', nativeSessionId: f.nativeSessionId, providerResponseId: 'resp-private-host' });
    const identity = currentBenchIdentityFromObservation(f.task, observation!);
    expect(JSON.stringify(identity)).not.toMatch(/PRIVATE_|private_tool/);
  });
  it('rejects an ambiguous native binding and a foreign task workspace', async () => {
    const f = await hostFixture();
    expect(await f.read({ ...f.task, workspaceId: 'other-private' })).toBeNull();
    await sql`INSERT INTO harness_shared.adv_sessions (workspace_id, coord_owner_id, session_id, agent)
      VALUES (${workspaceId}, ${f.ownerId}, ${f.nativeSessionId}, 'codex')`;
    expect(await f.read(f.task)).toBeNull();
  });
  it('rejects stale kernel pins instead of restamping from a live process', async () => {
    const f = await hostFixture();
    await sql`UPDATE harness_shared.runtime_vintage SET extra = '{"kernelProcessIdentity":"foreign-process"}'::jsonb
      WHERE unit = 'host-worker'`;
    expect(await f.read(f.task)).toBeNull();
  });
  it('rejects string-valued JSONB attribution and restores an object-valued binding', async () => {
    const f = await hostFixture();
    // postgres serializes a string again when its bind type is JSONB. This
    // reproduces the original fixture defect without accepting it as identity.
    await sql`UPDATE harness_shared.task_ledger SET detail = ${JSON.stringify({ coordOwnerId: f.ownerId })}::jsonb`;
    const [stored] = await sql`SELECT jsonb_typeof(detail) AS type FROM harness_shared.task_ledger`;
    expect(stored.type).toBe('string');
    expect(await f.read(f.task)).toBeNull();
    await sql`UPDATE harness_shared.task_ledger SET detail = ${sql.json({ coordOwnerId: f.ownerId })}`;
    expect(await f.read(f.task)).not.toBeNull();
  });
  it('rejects a symlinked native transcript even when its bytes and UUID match', async () => {
    const f = await hostFixture();
    expect(await f.read(f.task)).not.toBeNull();
    renameSync(f.file, f.file + '.target'); symlinkSync(f.file + '.target', f.file);
    expect(await f.read(f.task)).toBeNull();
  });
});
afterAll(async () => { for (const gateway of gateways) await gateway.stop();
  await sql?.end({ timeout: 5 }); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

describe('production current benchmark protocol and private completion bindings', () => {
  it('refuses direct native launch before physical restoration, then accepts the exact restored assignment', async () => {
    const f = await execution();
    await expect(f.ports.launch(currentBenchLaunchRequest(f.opts, handle, 'private task'))).rejects.toThrow(/physically restored/);
    expect(native.launch).not.toHaveBeenCalled();
    const context = await f.ports.restoreContext(handle, 't1');
    expect(await f.ports.verifyContext(handle, 't1')).toEqual(context);
    await f.ports.launch(currentBenchLaunchRequest(f.opts, handle, 'private task', context));
    expect(native.launch).toHaveBeenCalledOnce();
    expect(native.launch.mock.calls[0][0].brief).toContain('Shared frozen private context.');
    expect(native.launch.mock.calls[0][1][Symbol.for('benchmark-test-server-ceiling')]).toMatchObject({ denyAmbientContext: true,
      denyWorkItemsOutside: { id: handle.featureId, harness: handle.slug, checkout: handle.worktreePath },
      denyOutside: ['coord:whoami', 'session:request-compaction', 'work_items:get', 'work_items:checkpoint', 'work_items:complete'] });
  });
  it.each(['corpus.json', 'memory.json', 'receipt.json'])('refuses changed restored %s at the production launch port', async file => {
    const f = await execution(), context = await f.ports.restoreContext(handle, 't1');
    writeFileSync(join(handle.worktreePath, '.papercusp/benchmark-context', file), '{}');
    await expect(f.ports.launch(currentBenchLaunchRequest(f.opts, handle, 'private task', context))).rejects.toThrow(/snapshot bytes|receipt differs/);
    expect(native.launch).not.toHaveBeenCalled();
  });
  it('refuses a different checkout or brief even when its snapshot receipt was valid', async () => {
    const f = await execution(), context = await f.ports.restoreContext(handle, 't1');
    const args = currentBenchLaunchRequest(f.opts, handle, 'private task', context);
    await expect(f.ports.launch({ ...args, cwd: repoRoot })).rejects.toThrow(/physically restored/);
    await expect(f.ports.launch({ ...args, brief: 'caller supplied context' })).rejects.toThrow(/physically restored/);
    expect(native.launch).not.toHaveBeenCalled();
  });
  it('rejects private work-item completion without native identity while retaining committed protocol, receipt and cleanup', async () => {
    const f = await execution();
    const result = await f.run();
    expect(result.telemetry.generationError).toMatch(/identity.*unobserved/i);
    expect(result.telemetry.stopReason).toBe('error');
    expect(f.admit).toHaveBeenCalledOnce();
    expect(native.launch).toHaveBeenCalledWith(expect.objectContaining({ harness: handle.slug, workItem: handle.featureId }),
      expect.objectContaining({ ...ctx, [Symbol.for('benchmark-test-private-route')]: {
        baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64),
      } }));
    expect(native.kill).toHaveBeenCalledWith('private-native', { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      preregistration: { preregHash: f.frozen.preregHash, gitCommitSha: expect.stringMatching(/^[a-f0-9]{40}$/) },
      identityStatus: 'unknown', measured: null, protocolIdentity: { status: 'unobserved' },
      terminalReceipt: { taskId: 'private-native' }, retiredTaskIds: ['private-native'],
    });
  });
  it('rejects an uncommitted protocol before budget reservation or native launch', async () => {
    const f = await execution(false);
    expect((await f.run()).telemetry.generationError).toMatch(/committed/);
    expect(f.admit).not.toHaveBeenCalled(); expect(native.launch).not.toHaveBeenCalled();
  });
  it.each([{ ...config, taskIds: ['other'] }, { ...config, seeds: [2] }, { ...config, grader: { ...config.grader, version: 'changed' } }])(
    'rejects drift from frozen task, seed or grader configuration: %j', async changed => {
      const f = await execution();
      f.opts.preregistration.config = changed;
      expect((await f.run()).telemetry.generationError).toMatch(/exact frozen|frozen protocol/);
      expect(f.admit).not.toHaveBeenCalled(); expect(native.launch).not.toHaveBeenCalled();
    },
  );
  it('refuses a caller context for a different workspace before any SQL/launch binding', async () => {
    const f = await execution();
    expect(() => liveCurrentSuBenchPorts(ctx, { admit: f.admit, observeIdentity: async () => null }, { ...f.opts, workspaceId: 'other-private' }, scope())).toThrow(/isolated/);
  });
  it.each(['done', 'passed', 'resolved'])('recognizes maintained successful work-item state %s', async status => {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, ${status})`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBe('done');
  });
  it.each(['dropped', 'deprecated', 'closed'])('reports abandoned work-item state %s as failure', async status => {
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, ${status})`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBe('failed');
  });
  it('ignores another workspace, harness or feature and refuses production scope', async () => {
    await sql`INSERT INTO harness_shared.work_items VALUES
      ('papercusp-workspace', ${handle.slug}, ${handle.featureId}, 'done'),
      (${workspaceId}, 'peer-harness', ${handle.featureId}, 'done'),
      (${workspaceId}, ${handle.slug}, 'peer-feature', 'done')`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBeNull();
    await expect(readCurrentBenchCompletion(handle, { ...scope(), workspaceId: 'papercusp-workspace' })).rejects.toThrow(/PRODUCTION/);
    await sql`INSERT INTO harness_shared.work_items VALUES (${workspaceId}, ${handle.slug}, ${handle.featureId}, 'wip')`;
    expect(await readCurrentBenchCompletion(handle, scope())).toBeNull();
  });
});
