/**
 * Integration tests for the UI run launcher + the spend-safety teardown
 * (benchmark-evaluation-ui-2026-06-16 P-004 / P-005) against a real (testcontainer)
 * Postgres.
 *
 * P-004: launchBenchRun persists status=running + returns a runId immediately,
 * drives the (injected) engine detached, and finalizes to done. Single-active-run
 * is enforced.
 *
 * P-005 HARD GATE (closes impartial-benchmark-suite D-022 — the orphan-respin
 * gap): the detached run ALWAYS dissolves its hive in the finally; the boot reaper
 * dissolves + freezes any run a crashed host left in flight (so a restart can
 * never re-arm an orphan that re-spins opus); and the reaper is HEARTBEAT-GATED so
 * a run legitimately in flight in another live host is NOT killed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { OrgSql } from './reproducibility/db';

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

import {
  launchBenchRun,
  cancelBenchRun,
  reapStaleBenchRuns,
  assertNoActiveRun,
  _resetActiveRunsForTests,
  currentBenchTaskProviderCapture,
  readCurrentBenchTaskModelCalls,
  readCurrentBenchTaskRequestCensus,
  currentBenchSessionRequestDelta,
  currentBenchSessionUsageDelta,
  freezeCurrentBenchTaskProviderReservation,
  type CurrentTaskInput,
} from './run-launcher';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { canonicalJson } from './reproducibility/canonical-json';
import { currentBenchAssignmentId, currentBenchNativeCostReader } from './current-su';
import { closedCodexSessionPopulation } from '../interactive-usage/ingest-adapters';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import { registerLearningLoop, reserveLearningSpend, recordLearningSpendAttemptResult,
  settleLearningSpend } from '../learning-governor/store';
import { upsertBenchRun, setBenchRunHive, getBenchRunDetail } from './run-store';
import type { BenchTask } from './types';
import type { HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const WS = 'bench-launch-test-ws';

function migrationSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');
}

let db: FreshPgDb;
let sql: OrgSql;
let scope: { sql: OrgSql; workspaceId: string };

const task = (id: string): BenchTask => ({
  benchmark: 'swe-bench-pro',
  instanceId: id,
  problemStatement: 'p',
  repo: `/tmp/${id}`,
  baseCommit: 'abc',
  graderMeta: { dockerhub_tag: id, FAIL_TO_PASS: [], PASS_TO_PASS: [], testFiles: [] },
});

/** A fake engine: drives the durability hooks (so hive_slug + per-task rows land)
 *  then returns a clean result. Captured from bindDriver. */
function makeFakeEngine() {
  let hooks: {
    onHiveCreated?: (h: string) => void;
    onEnrolled?: (e: { task: BenchTask }) => void;
    onTaskCollected?: (tr: unknown) => void;
  } = {};
  const bindDriver = (opts: typeof hooks) => {
    hooks = opts;
  };
  const run = async (req: HiveBacklogRunRequest): Promise<HiveBacklogResult> => {
    hooks.onHiveCreated?.(`hive-${req.runId}`);
    for (const t of req.backlog) {
      hooks.onEnrolled?.({ task: t });
      hooks.onTaskCollected?.({
        attempt: {
          arm: req.arm, blueprintId: 'external-bench', instanceId: t.instanceId, seed: '1',
          diff: 'diff x', tokensIn: 10, tokensOut: 100, costUsd: 3, turns: 1, wallClockMs: 1000,
          trajectoryRef: '', stopReason: 'done',
        },
        cupId: `bee-${t.instanceId}`, placedAtMs: 0, startedAtMs: 0, finishedAtMs: 1000, disposition: 'spawn',
      });
    }
    return {
      arm: req.arm, suite: req.suite, runId: req.runId, seed: 1,
      startedAtMs: 0, finishedAtMs: 5000, peakConcurrentBees: 2,
      taskResults: [], coordEvents: [{ kind: 'placement', taskId: req.backlog[0]?.instanceId }],
      runError: null,
    };
  };
  return { bindDriver: bindDriver as never, run };
}

beforeAll(async () => {
  db = await createFreshPgDb('benchlaunch');
  sql = db.sql as unknown as OrgSql;
  await db.sql.unsafe(migrationSql('296-bench-run-operational-store.sql'));
  await db.sql.unsafe(migrationSql('298-bench-run-infra-excluded.sql'));
  // D-007 pot-rename: mig 296 creates bench_runs.hive_slug; mig 523 renamed it → pot_slug.
  // Replaying only 296/298 predates the rename, so apply it in-place to match the write path.
  await db.sql.unsafe(`ALTER TABLE harness_shared.bench_runs RENAME COLUMN hive_slug TO pot_slug`);
  for (const file of ['244-learning-governor.sql', '1116-learning-spend-reservations.sql', '1224-learning-reservation-resources.sql'])
    await db.sql.unsafe(migrationSql(file));
  await db.sql.unsafe('ALTER TABLE harness_shared.learning_governor_loops ADD COLUMN pot_slug text');
  await db.sql.unsafe('ALTER TABLE harness_shared.learning_spend_events ADD COLUMN pot_slug text');
  await db.sql.unsafe(`
    ALTER TABLE harness_shared.bench_runs       DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_tasks  DISABLE ROW LEVEL SECURITY;
    ALTER TABLE harness_shared.bench_run_events DISABLE ROW LEVEL SECURITY;
  `);
  scope = { sql, workspaceId: WS };
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  _resetActiveRunsForTests();
  await sql`DELETE FROM harness_shared.bench_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.learning_spend_events WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.learning_spend_reservations WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.learning_governor_loops WHERE workspace_id = ${WS}`;
});

describe('current provider capture host checkpoint', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  async function fixture(agent: 'codex' | 'claude' = 'codex') {
    const protocol = currentProtocolFixture('private-host-capture');
    for (const arm of protocol.arms) arm.account = 'private-provider-account';
    const armId = agent === 'claude' ? 'baseline' : 'papercusp';
    if (agent === 'claude') protocol.arms.find(arm => arm.id === armId)!.agent = 'claude';
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'bench-host-candidate-')); roots.push(checkoutRoot);
    const preregHash = createHash('sha256').update(canonicalJson(protocol)).digest('hex');
    const loopId = `benchmark:${preregHash}`, hostRunId = 'host-capture';
    const input: CurrentTaskInput = { options: { workspaceId: WS, runId: protocol.runId, armId, seed: 1,
      agent, model: 'configured-alias', effort: 'high', account: 'private-provider-account',
      preregistration: { preregHash, config: protocol } }, protocol, task: task('t1'), scope,
      context: { workspaceId: WS, principal: { slug: 'private-host' } } as CurrentTaskInput['context'],
      resources: { requestsPerArm: 2 } as CurrentTaskInput['resources'], loopId, hostRunId,
      checkout: { dir: checkoutRoot, repo: 'fixture', baseCommit: 'a'.repeat(40), cleanup: async () => {} },
      observation: { runtimeWorkspaceId: 'private-runtime', workerUnit: 'worker', gatewayUnit: 'gateway' } };
    await upsertBenchRun({ id: hostRunId, arm: 'papercusp', taskSetId: 'custom', model: input.options.model,
      status: 'running', config: { current: { preregHash, protocolRunId: protocol.runId }, protocol, loopId } }, scope);
    const capture = await currentBenchTaskProviderCapture(input); roots.push(capture.captureRoot);
    const [shape] = await sql`SELECT jsonb_typeof(config->'providerInputCaptures') AS kind
      FROM harness_shared.bench_runs WHERE id = ${hostRunId} AND workspace_id = ${WS}`;
    expect(shape!.kind).toBe('object');
    const request = (): GatewayCarryTrialAttempt => {
      const nativeSessionId = randomUUID(), nativeTurnId = randomUUID();
      const body = JSON.stringify(agent === 'claude' ? { model: input.options.model, output_config: { effort: 'high' },
        max_tokens: 10, messages: [{ role: 'user', content: 'private context' }] } :
        { model: input.options.model, reasoning: { effort: 'high' }, max_output_tokens: 10,
        client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ session_id: nativeSessionId,
          thread_id: nativeSessionId, turn_id: nativeTurnId }) }, input: [{ role: 'user', content: 'private context' }] });
      return { attemptId: randomUUID(), manifestSha256: preregHash,
        armId: currentBenchAssignmentId(protocol.runId, armId, 't1', 1), accountId: 'private-provider-account',
        ...(agent === 'claude' ? { transport: 'anthropic-http' as const, credentialHeader: 'x-api-key' as const,
          target: 'https://api.anthropic.com/v1/messages', anthropicVersion: '2023-06-01', anthropicBeta: null } :
          { nativeSessionId, nativeTurnId, transport: 'bearer-http' as const, credentialHeader: 'authorization' as const,
            target: 'https://api.openai.com/v1/responses' }),
        credentialSha256: 'c'.repeat(64), body,
        bodySha256: createHash('sha256').update(body).digest('hex'), clockId: 'private-clock', signal: new AbortController().signal };
    };
    return { input, capture, request };
  }
  async function recordedReservation(f: Awaited<ReturnType<typeof fixture>>, attempt: GatewayCarryTrialAttempt,
    { settled = true, completed = true, failure }: { settled?: boolean; completed?: boolean;
      failure?: 'send-refused' | 'fetch-failed' } = {}) {
    await f.capture.captureProviderInput(attempt);
    const { body: _body, signal: _signal, ...identity } = attempt;
    const resources = { inputTokens: 1000, outputTokens: 100, requestsPerArm: 2, armIds: [attempt.armId],
      usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 60_000, wallClockMsPerArm: 60_000 };
    await registerLearningLoop(sql, { workspaceId: WS, loopId: f.input.loopId, budgetKind: 'lifetime', budgetUsd: 60,
      enabled: true, meta: { reservationBinding: attempt.manifestSha256, reservationResourceBudget: resources } });
    expect((await reserveLearningSpend(sql, { workspaceId: WS, loopId: f.input.loopId, requestedUsd: 0.003, floorUsd: 0,
      attemptKind: 'evaluation', note: JSON.stringify({ nativeGatewayAttempt: identity }),
      exact: { reservationId: attempt.attemptId, binding: attempt.manifestSha256, expectedBudgetUsd: 60,
        resources: { armId: attempt.armId, inputTokens: 100, outputTokens: 10 }, expectedResourceBudget: resources } })).ok).toBe(true);
    if (failure) {
      const result: GatewayCarryTrialAttemptResult = failure === 'send-refused'
        ? { ...identity, reservationRef: attempt.attemptId, outcome: failure, responseStatus: null,
          costUsd: 0, costUsdMeasurementMissing: false }
        : { ...identity, reservationRef: attempt.attemptId, outcome: failure, responseStatus: null, costUsdMeasurementMissing: true };
      expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: attempt.attemptId, result })).toEqual({ ok: true });
      return;
    }
    const headers: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: attempt.attemptId,
      outcome: 'response-headers', responseStatus: 200, costUsdMeasurementMissing: true };
    expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: attempt.attemptId, result: headers })).toEqual({ ok: true });
    if (completed) {
      const result: GatewayCarryTrialAttemptResult = { ...headers, outcome: 'response-completed', responseStatus: 200,
        responseSha256: 'd'.repeat(64), responseBytes: 300, providerCompletion: {
          responseId: attempt.transport === 'anthropic-http' ? `msg_${attempt.attemptId.replaceAll('-', '')}` : 'private-response',
          model: f.input.options.model!, providerEffort: 'high', usage: { inputTokenBasis: 'inclusive', inputTokens: 100,
            outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 } } };
      expect(await recordLearningSpendAttemptResult(sql, { workspaceId: WS, reservationId: attempt.attemptId, result })).toEqual({ ok: true });
    }
    if (settled) expect((await settleLearningSpend(sql, { workspaceId: WS, reservationId: attempt.attemptId,
      disposition: 'used', usedUsd: 0.002 })).ok).toBe(true);
  }
  it('counts every admitted request including an incomplete response from the real governor ledger', async () => {
    const f = await fixture();
    expect(await readCurrentBenchTaskModelCalls(f.input, f.capture)).toBe(0);
    await recordedReservation(f, f.request());
    await recordedReservation(f, f.request(), { settled: false, completed: false });
    expect(await readCurrentBenchTaskModelCalls(f.input, f.capture)).toBe(2);
    const otherArm = { ...f.input, options: { ...f.input.options, armId: 'baseline' } };
    expect(await readCurrentBenchTaskModelCalls(otherArm, f.capture)).toBe(0);
  });
  it('retains Claude request counts and measured provider messages without synthesizing native turns', async () => {
    const f = await fixture('claude'), completed = f.request(), incomplete = f.request();
    await recordedReservation(f, completed);
    await recordedReservation(f, incomplete, { settled: false, completed: false });
    const census = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    expect(census.requests).toHaveLength(2);
    expect(census.requests.find(row => row.reservationId === completed.attemptId)).toEqual({ agent: 'claude',
      reservationId: completed.attemptId, bodySha256: completed.bodySha256,
      nativeMessageId: `msg_${completed.attemptId.replaceAll('-', '')}` });
    expect(census.requests.find(row => row.reservationId === incomplete.attemptId)).toEqual({ agent: 'claude',
      reservationId: incomplete.attemptId, bodySha256: incomplete.bodySha256 });
    expect(await readCurrentBenchTaskModelCalls(f.input, f.capture)).toBe(2);
    const frozen = await freezeCurrentBenchTaskProviderReservation(f.input, completed.attemptId);
    expect(frozen).toMatchObject({ agent: 'claude', anthropicVersion: '2023-06-01', anthropicBeta: null });
    expect(frozen).not.toHaveProperty('nativeTurnId'); expect(frozen).not.toHaveProperty('nativeSessionId');
    expect(() => currentBenchSessionRequestDelta({ ...census, requests: [] }, census, randomUUID())).toThrow(/request census/);
  });
  it('counts refused and failed Claude sends without claiming a provider completion', async () => {
    const f = await fixture('claude'), refused = f.request(), failed = f.request();
    await recordedReservation(f, refused, { failure: 'send-refused' });
    await recordedReservation(f, failed, { failure: 'fetch-failed' });
    const census = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    expect(census.requests).toHaveLength(2);
    for (const row of census.requests) {
      expect(row.agent).toBe('claude'); expect(row).not.toHaveProperty('nativeMessageId');
      expect(row).not.toHaveProperty('nativeSessionId'); expect(row).not.toHaveProperty('nativeTurnId');
    }
    expect(await readCurrentBenchTaskModelCalls(f.input, f.capture)).toBe(2);
  });
  it.each(['anthropicVersion', 'anthropicBeta', 'nativeSessionId', 'accountId'] as const)(
    'refuses Claude %s drift between captured input and the reservation', async field => {
      const f = await fixture('claude'), attempt = f.request(); await recordedReservation(f, attempt);
      await sql`UPDATE harness_shared.learning_spend_reservations SET note = jsonb_set(note::jsonb,
        ${['nativeGatewayAttempt', field]}::text[], ${JSON.stringify('foreign')}::text::jsonb)::text
        WHERE id = ${attempt.attemptId}`;
      await expect(readCurrentBenchTaskRequestCensus(f.input, f.capture)).rejects.toThrow(/capture|provider identity/);
    });
  it('refuses duplicate measured Claude provider messages across distinct reservations', async () => {
    const f = await fixture('claude'), first = f.request(), second = f.request();
    await recordedReservation(f, first); await recordedReservation(f, second);
    await sql`UPDATE harness_shared.learning_spend_reservations SET note = jsonb_set(note::jsonb,
      '{nativeGatewayAttemptResult,providerCompletion,responseId}',
      ${JSON.stringify(`msg_${first.attemptId.replaceAll('-', '')}`)}::text::jsonb)::text WHERE id = ${second.attemptId}`;
    await expect(readCurrentBenchTaskRequestCensus(f.input, f.capture)).rejects.toThrow(/reused provider message/);
  });
  it('refuses an admitted request with altered host input evidence rather than inferring count from usage', async () => {
    const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt);
    await sql`UPDATE harness_shared.learning_spend_reservations SET note = '{}' WHERE id = ${attempt.attemptId}`;
    await expect(readCurrentBenchTaskModelCalls(f.input, f.capture)).rejects.toThrow(/frozen input capture/);
  });
  it('counts fresh-session deltas without counting the first session again, retaining incomplete attempts', async () => {
    const f = await fixture(), first = f.request(), second = f.request();
    const before = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    await recordedReservation(f, first);
    const middle = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    await recordedReservation(f, second, { settled: false, completed: false });
    const after = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    expect(currentBenchSessionRequestDelta(before, middle, first.nativeSessionId!)).toEqual({
      modelCalls: 1, reservationIds: [first.attemptId] });
    expect(currentBenchSessionRequestDelta(middle, after, second.nativeSessionId!)).toEqual({
      modelCalls: 1, reservationIds: [second.attemptId] });
    expect(await readCurrentBenchTaskModelCalls(f.input, f.capture)).toBe(2);
    expect(Object.isFrozen(after.requests[0])).toBe(true);
    expect(Object.isFrozen(after.requests)).toBe(true);
    expect(Object.isFrozen(after.binding)).toBe(true);
  });
  it('refuses session replay, late requests from an earlier session, and a shrinking census', async () => {
    const f = await fixture(), first = f.request(), second = f.request();
    const before = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    await recordedReservation(f, first);
    const after = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    expect(() => currentBenchSessionRequestDelta(after, after, first.nativeSessionId!)).toThrow(/reused/);
    expect(() => currentBenchSessionRequestDelta(before, after, second.nativeSessionId!)).toThrow(/foreign/);
    expect(() => currentBenchSessionRequestDelta(after, before, second.nativeSessionId!)).toThrow(/non-monotone/);
    const foreign = { ...f.input, options: { ...f.input.options, armId: 'baseline' } };
    const other = await readCurrentBenchTaskRequestCensus(foreign, f.capture);
    expect(() => currentBenchSessionRequestDelta(before, other, second.nativeSessionId!)).toThrow(/foreign/);
  });
  it('joins fresh-session usage to the exact PG request delta without recounting prior sessions', async () => {
    const f = await fixture(), first = f.request(), second = f.request();
    const cost = (attempts: GatewayCarryTrialAttempt[]) => currentBenchNativeCostReader(f.input.protocol, {
      readParticipants: async () => [{ taskId: 'solver', ownerId: 'solver', codexHome: '/private/home', terminal: true }],
      readRuntime: async () => ({ complete: true, sessions: attempts.map(a => {
        const transcript = [
          { type: 'session_meta', payload: { id: a.nativeSessionId } },
          { type: 'turn_context', payload: { turn_id: a.nativeTurnId, model: 'configured-alias' } },
          { type: 'event_msg', payload: { type: 'token_count', info: {
            total_token_usage: { input_tokens: 10, output_tokens: 2 },
            last_token_usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 2 },
          } } },
          { type: 'event_msg', payload: { type: 'task_complete', turn_id: a.nativeTurnId } },
        ].map(row => JSON.stringify(row) + '\n').join('');
        const file = `/private/${a.nativeSessionId}.jsonl`;
        const population = closedCodexSessionPopulation({ transcript, file, fileGeneration: 0, nativeSessionId: a.nativeSessionId! });
        if (!population.ok) throw new Error(population.detail);
        return { nativeSessionId: a.nativeSessionId!, usage: { ...population, file,
          sourceSha256: createHash('sha256').update(transcript).digest('hex') } };
      }) }),
      readBilled: async () => ({ complete: true, knownSubtotalUsd: 0.02 }),
      readAttemptAccountingComplete: async () => true,
    })();
    const before = await readCurrentBenchTaskRequestCensus(f.input, f.capture);
    await recordedReservation(f, first);
    const middle = await readCurrentBenchTaskRequestCensus(f.input, f.capture), firstCost = await cost([first]);
    expect(currentBenchSessionUsageDelta({ before, after: middle, beforeCost: null, afterCost: firstCost,
      nativeSessionId: first.nativeSessionId! })).toMatchObject({ modelCalls: 1, reservationIds: [first.attemptId],
      tokensIn: 8, tokensCacheRead: 2, tokensOut: 2, billedCostUsd: 0.02 });
    await recordedReservation(f, second);
    const after = await readCurrentBenchTaskRequestCensus(f.input, f.capture), afterCost = await cost([first, second]);
    const input = { before: middle, after, beforeCost: firstCost, afterCost, nativeSessionId: second.nativeSessionId! };
    const delta = currentBenchSessionUsageDelta(input);
    expect(delta).toMatchObject({ modelCalls: 1, reservationIds: [second.attemptId], tokensIn: 8,
      tokensCacheRead: 2, tokensOut: 2, billedCostUsd: 0.02 });
    expect(delta.normalizedCostUsd).toBeCloseTo(firstCost.costUsd, 10);
    expect(afterCost.armMeta.nativeCostAccounting.billedCostUsd).toBe(0.04);
    // Neither missing historical sources nor a different native turn can certify this delta.
    expect(() => currentBenchSessionUsageDelta({ ...input, beforeCost: null })).toThrow(/non-monotone/);
    const wrongTurn = { ...after, requests: after.requests.map(r => r.nativeSessionId === second.nativeSessionId
      ? { ...r, nativeTurnId: randomUUID() } : r) };
    expect(() => currentBenchSessionUsageDelta({ ...input, after: wrongTurn })).toThrow(/request census/);
    const foreignProtocol = structuredClone(afterCost); foreignProtocol.armMeta.nativeCostAccounting.preregHash = 'e'.repeat(64);
    expect(() => currentBenchSessionUsageDelta({ ...input, afterCost: foreignProtocol })).toThrow(/non-monotone|request census/);
    const incomplete = structuredClone(afterCost); incomplete.costUsdMeasurementMissing = true;
    expect(() => currentBenchSessionUsageDelta({ ...input, afterCost: incomplete })).toThrow(/incomplete/);
  });
  it.each(['nativeSessionId', 'nativeTurnId', 'bodySha256'] as const)(
    'refuses %s drift between the complete ledger and private capture', async field => {
      const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt);
      await sql`UPDATE harness_shared.learning_spend_reservations SET note = jsonb_set(note::jsonb,
        ${['nativeGatewayAttempt', field]}::text[], ${JSON.stringify(field === 'bodySha256' ? 'e'.repeat(64) : randomUUID())}::text::jsonb)::text
        WHERE id = ${attempt.attemptId}`;
      await expect(readCurrentBenchTaskRequestCensus(f.input, f.capture)).rejects.toThrow(/frozen input capture/);
    });
  it('settled reservation freezes exact final note bytes in the existing checkpoint after checkout cleanup', async () => {
    const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt);
    await sql`UPDATE harness_shared.bench_runs SET status = 'done' WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    rmSync(f.input.checkout.dir, { recursive: true });
    const receipt = await freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId);
    const [row] = await sql`SELECT note, status, settled_at FROM harness_shared.learning_spend_reservations WHERE id = ${attempt.attemptId}`;
    expect(receipt.reservationNoteSha256).toBe(createHash('sha256').update(row.note).digest('hex'));
    expect(receipt.settledAt).toBe(row.settled_at.toISOString());
    const detail = await getBenchRunDetail(f.input.hostRunId, scope);
    const saved = detail!.config!.providerInputCaptures as Record<string, { settledProviderInputs: Record<string, unknown> }>;
    expect(saved[attempt.armId].settledProviderInputs[attempt.attemptId]).toEqual(receipt);
    expect(await freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toMatch(/credential|authorization|signal/);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(row.status).toBe('settled');
    expect(detail!.status).toBe('done');
  });
  it.each([{ settled: false, completed: true }, { settled: true, completed: false }])(
    'settled reservation refuses incomplete authority %j', async options => {
      const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt, options);
      await expect(freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)).rejects.toThrow(/settled matching|completed host/);
      const detail = await getBenchRunDetail(f.input.hostRunId, scope);
      const saved = detail!.config!.providerInputCaptures as Record<string, { settledProviderInputs?: unknown }>;
      expect(saved[attempt.armId].settledProviderInputs).toBeUndefined();
    });
  it.each(['note', 'settled_at'])('settled reservation refuses %s drift instead of replacing a frozen pin', async field => {
    const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt);
    const receipt = await freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId);
    if (field === 'note') await sql`UPDATE harness_shared.learning_spend_reservations SET note = note || ' ' WHERE id = ${attempt.attemptId}`;
    else await sql`UPDATE harness_shared.learning_spend_reservations SET settled_at = settled_at + interval '1 second' WHERE id = ${attempt.attemptId}`;
    await expect(freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)).rejects.toThrow(/host pin was frozen/);
    const detail = await getBenchRunDetail(f.input.hostRunId, scope);
    const saved = detail!.config!.providerInputCaptures as Record<string, { settledProviderInputs: Record<string, unknown> }>;
    expect(saved[attempt.armId].settledProviderInputs[attempt.attemptId]).toEqual(receipt);
  });
  it.each(['arm_id', 'loop_id', 'nativeTurnId', 'bodySha256'])('settled reservation refuses foreign %s authority', async field => {
    const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt);
    if (field === 'arm_id') await sql`UPDATE harness_shared.learning_spend_reservations SET arm_id = 'foreign-arm' WHERE id = ${attempt.attemptId}`;
    else if (field === 'loop_id') await sql`UPDATE harness_shared.learning_spend_reservations SET loop_id = 'foreign-loop' WHERE id = ${attempt.attemptId}`;
    else await sql`UPDATE harness_shared.learning_spend_reservations SET note = jsonb_set(note::jsonb,
      ${['nativeGatewayAttemptResult', field]}::text[], ${JSON.stringify(field === 'nativeTurnId' ? randomUUID() : 'e'.repeat(64))}::text::jsonb)::text
      WHERE id = ${attempt.attemptId}`;
    await expect(freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)).rejects.toThrow(/settled matching|completed host/);
  });
  it('settled reservation refuses unacknowledged disk captures and altered request bytes', async () => {
    const f = await fixture();
    await expect(freezeCurrentBenchTaskProviderReservation(f.input, randomUUID())).rejects.toThrow(/acknowledged/);
    const attempt = f.request(); await recordedReservation(f, attempt);
    const captured = f.capture.readCapture(attempt.attemptId)!;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(f.capture.captureRoot, captured.bodyPath), '{}');
    await expect(freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)).rejects.toThrow(/altered or missing evidence/);
  });
  it.each(['clockId', 'responseId', 'responseSha256', 'costUsdMeasurementMissing'])(
    'settled reservation refuses malformed completed response %s', async field => {
      const f = await fixture(), attempt = f.request(); await recordedReservation(f, attempt);
      const path = field === 'responseId' ? ['nativeGatewayAttemptResult', 'providerCompletion', field] : ['nativeGatewayAttemptResult', field];
      const value = field === 'clockId' ? {} : field === 'responseId' ? 12 : field === 'responseSha256' ? 'not-a-hash' : false;
      await sql`UPDATE harness_shared.learning_spend_reservations SET note = jsonb_set(note::jsonb,
        ${path}::text[], ${JSON.stringify(value)}::text::jsonb)::text WHERE id = ${attempt.attemptId}`;
      await expect(freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)).rejects.toThrow(/completed host request/);
    });
  it('settled reservation concurrent finalization preserves both independently frozen request pins', async () => {
    const f = await fixture(), first = f.request(), second = f.request();
    await recordedReservation(f, first); await recordedReservation(f, second);
    const receipts = await Promise.all([first, second].map(attempt => freezeCurrentBenchTaskProviderReservation(f.input, attempt.attemptId)));
    const detail = await getBenchRunDetail(f.input.hostRunId, scope);
    const saved = detail!.config!.providerInputCaptures as Record<string, { settledProviderInputs: Record<string, unknown> }>;
    expect(saved[first.armId].settledProviderInputs).toEqual(Object.fromEntries(receipts.map(receipt => [receipt.reservationId, receipt])));
    expect((await currentBenchTaskProviderCapture(f.input, { readOnly: true })).recoveryState().captures).toHaveLength(2);
  });
  it('restores acknowledged request pins from the real operational row and retains its allocation cap', async () => {
    const f = await fixture(), first = f.request();
    await f.capture.captureProviderInput(first);
    const restored = await currentBenchTaskProviderCapture(f.input);
    expect(restored.captureRoot).toBe(f.capture.captureRoot);
    expect(restored.readCapture(first.attemptId)).toEqual(f.capture.readCapture(first.attemptId));
    const row = await getBenchRunDetail(f.input.hostRunId, scope);
    const saved = row!.config!.providerInputCaptures as Record<string, { recovery: unknown }>;
    expect(saved[first.armId].recovery).toEqual(restored.recoveryState());
    await restored.captureProviderInput(f.request());
    await expect(restored.captureProviderInput(f.request())).rejects.toThrow(/exhausted/);
  });
  it('refuses forwarding after the durable checkpoint changes and never discovers unacknowledged receipts', async () => {
    const f = await fixture(), attempt = f.request();
    await sql`UPDATE harness_shared.bench_runs SET status = 'cancelled' WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    await expect(f.capture.captureProviderInput(attempt)).rejects.toThrow(/checkpoint changed/);
    await sql`UPDATE harness_shared.bench_runs SET status = 'running' WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    const restored = await currentBenchTaskProviderCapture(f.input);
    expect(restored.readCapture(attempt.attemptId)).toBeNull();
    await restored.captureProviderInput(f.request());
    await expect(restored.captureProviderInput(f.request())).rejects.toThrow(/exhausted/);
  });
  it('does not let concurrent recovered hosts overwrite acknowledged recovery pins', async () => {
    const f = await fixture(), peer = await currentBenchTaskProviderCapture(f.input);
    const first = f.request(); await f.capture.captureProviderInput(first);
    await expect(peer.captureProviderInput(f.request())).rejects.toThrow(/checkpoint changed/);
    const restored = await currentBenchTaskProviderCapture(f.input);
    expect(restored.readCapture(first.attemptId)).not.toBeNull();
    expect(restored.recoveryState().captures).toHaveLength(1);
  });
  it.each(['done', 'error', 'cancelled'])('retains read-only evidence after %s and checkout cleanup without reviving generation', async status => {
    const f = await fixture(), attempt = f.request();
    await f.capture.captureProviderInput(attempt);
    const expected = f.capture.readCapture(attempt.attemptId), pins = f.capture.recoveryState();
    await sql`UPDATE harness_shared.bench_runs SET status = ${status}
      WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    rmSync(f.input.checkout.dir, { recursive: true });
    // Reconstruct from the actual PG checkpoint and private disk after the
    // candidate directory is gone; no in-memory capture instance is borrowed.
    const reader = await currentBenchTaskProviderCapture(f.input, { readOnly: true });
    expect(reader.captureRoot).toBe(f.capture.captureRoot);
    expect(reader.readCapture(attempt.attemptId)).toEqual(expected);
    expect(reader.recoveryState()).toEqual(pins);
    await expect(reader.captureProviderInput(f.request())).rejects.toThrow(/Read-only/);
    await expect(currentBenchTaskProviderCapture(f.input)).rejects.toThrow();
    const row = await getBenchRunDetail(f.input.hostRunId, scope);
    expect(row!.status).toBe(status);
    expect((row!.config!.providerInputCaptures as Record<string, { recovery: unknown }>)[attempt.armId].recovery).toEqual(pins);
  });
  it('does not create a missing checkpoint during read-only inspection', async () => {
    const f = await fixture();
    await sql`UPDATE harness_shared.bench_runs SET config = config - 'providerInputCaptures'
      WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    await expect(currentBenchTaskProviderCapture(f.input, { readOnly: true })).rejects.toThrow(/existing host checkpoint/);
    const row = await getBenchRunDetail(f.input.hostRunId, scope);
    expect(row!.config).not.toHaveProperty('providerInputCaptures');
  });
  it('refuses altered retained evidence even after terminal checkout cleanup', async () => {
    const f = await fixture(), attempt = f.request();
    await f.capture.captureProviderInput(attempt);
    const receipt = f.capture.readCapture(attempt.attemptId)!;
    await sql`UPDATE harness_shared.bench_runs SET status = 'done'
      WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    rmSync(f.input.checkout.dir, { recursive: true });
    rmSync(join(f.capture.captureRoot, receipt.bodyPath));
    await expect(currentBenchTaskProviderCapture(f.input, { readOnly: true })).rejects.toThrow(/altered or missing evidence/);
  });
  it('retains acknowledged host evidence across an actual SIGKILL and private boot reaper without inference', async () => {
    const f = await fixture(), attempt = f.request();
    // This child executes the maintained host writer against only this fresh
    // database. It never starts a native agent or provider gateway. IPC carries
    // assignment data; the connection URL stays in the private environment.
    const script = `
      import postgres from 'postgres';
      import { currentBenchTaskProviderCapture } from ${JSON.stringify(new URL('./run-launcher.ts', import.meta.url).href)};
      const sql = postgres(process.env.BENCH_CAPTURE_TEST_DB_URL, { prepare: false });
      process.once('message', async ({ input, attempt }) => {
        try {
          input.scope = { sql, workspaceId: input.options.workspaceId };
          attempt.signal = new AbortController().signal;
          const capture = await currentBenchTaskProviderCapture(input);
          await capture.captureProviderInput(attempt);
          process.send({ ready: true, receipt: capture.readCapture(attempt.attemptId) });
        } catch (error) { process.send({ ready: false, error: String(error) }); }
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: resolve(__dirname, '../../../..'),
      env: { ...process.env, BENCH_CAPTURE_TEST_DB_URL: db.url,
        HARNESS_DATABASE_URL: db.url, HARNESS_ADMIN_DATABASE_URL: db.url, DATABASE_URL: db.url },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const closed = once(child, 'close');
    try {
      const ready = Promise.race([
        once(child, 'message').then(([message]) => message as { ready: boolean; receipt: unknown; error?: string }),
        closed.then(([code, signal]) => { throw new Error(`Private capture child exited before checkpoint: ${code}/${signal}: ${stderr}`); }),
      ]);
      const { scope: _scope, context: _context, checkout: _checkout, ...input } = f.input;
      child.send!({ input: { ...input, context: f.input.context,
        checkout: { dir: f.input.checkout.dir, repo: 'fixture', baseCommit: 'a'.repeat(40) } },
        attempt: { ...attempt, signal: undefined } });
      const message = await ready;
      expect(message.ready, message.error).toBe(true);
      expect(message.receipt).not.toBeNull();
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await closed).toEqual([null, 'SIGKILL']);
      const retireCurrent = vi.fn(async () => {}), dissolve = vi.fn(async () => {});
      const reaped = await reapStaleBenchRuns({ scope, staleAfterSec: 0, retireCurrent, dissolve });
      expect(reaped.reaped).toEqual([f.input.hostRunId]);
      expect(retireCurrent).toHaveBeenCalledExactlyOnceWith(WS, f.input.protocol.runId);
      rmSync(f.input.checkout.dir, { recursive: true });
      const reader = await currentBenchTaskProviderCapture(f.input, { readOnly: true });
      expect(reader.readCapture(attempt.attemptId)).toEqual(message.receipt);
      expect(reader.recoveryState().captures).toHaveLength(1);
      await expect(reader.captureProviderInput(f.request())).rejects.toThrow(/Read-only/);
      expect((await getBenchRunDetail(f.input.hostRunId, scope))!.status).toBe('error');
      expect((await reapStaleBenchRuns({ scope, staleAfterSec: 0, retireCurrent, dissolve })).reaped).toEqual([]);
      expect(retireCurrent).toHaveBeenCalledTimes(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 120_000);
  it.each(['checkout', 'account', 'protocol', 'pins', 'alias'])('rejects %s drift rather than allocating another host', async fault => {
    const f = await fixture();
    if (fault === 'checkout') {
      const other = mkdtempSync(join(tmpdir(), 'bench-host-other-')); roots.push(other); f.input.checkout.dir = other;
    }
    if (fault === 'account') f.input.options.account = 'foreign-account';
    if (fault === 'protocol') f.input.protocol.grader.version = 'foreign-grader';
    if (fault === 'alias') { f.input.options.account = 'auto'; f.input.protocol.arms[0].account = 'auto'; }
    if (fault === 'pins') await sql`UPDATE harness_shared.bench_runs SET config = jsonb_set(config,
      ${['providerInputCaptures', currentBenchAssignmentId(f.input.protocol.runId, 'papercusp', 't1', 1), 'recovery', 'rootIdentity']}::text[],
      '"foreign-inode"'::jsonb) WHERE id = ${f.input.hostRunId} AND workspace_id = ${WS}`;
    await expect(currentBenchTaskProviderCapture(f.input)).rejects.toThrow();
  });
});

describe('launchBenchRun (P-004)', () => {
  it('persists status=running immediately, drives the engine detached, finalizes to done + dissolves the hive', async () => {
    const dissolve = vi.fn(async () => {});
    const { bindDriver, run } = makeFakeEngine();
    const { runId, done } = await launchBenchRun(
      { arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', cap: 5 },
      { scope, run, bindDriver, dissolve, loadBacklog: async () => [task('instance_a'), task('instance_b')], assertEnabled: async () => {}, runId: 'launch-1' },
    );
    expect(runId).toBe('launch-1');

    // Immediately after launch: running, task set seeded as todo.
    const live = await getBenchRunDetail('launch-1', scope);
    expect(live!.status).toBe('running');
    expect(live!.source).toBe('ui');
    expect(live!.taskCount).toBe(2);
    expect(live!.perTask).toHaveLength(2);

    await done;

    const final = await getBenchRunDetail('launch-1', scope);
    expect(final!.status).toBe('done');
    expect(final!.potSlug).toBe('hive-launch-1');
    expect((final!.run.coordEvents ?? []).length).toBeGreaterThan(0);
    // The finally dissolved the spawned hive — no orphan learning loop survives.
    expect(dissolve).toHaveBeenCalledWith('hive-launch-1', WS);
  });

  it('refuses a second launch while one is in flight (single-active-run)', async () => {
    await upsertBenchRun({ id: 'busy-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running' }, scope);
    await expect(assertNoActiveRun(scope)).rejects.toThrow(/conflicting_run_active/);
    await expect(
      launchBenchRun(
        { arm: 'fifo-noqueen', taskSetId: '11-task-pilot' },
        { scope, loadBacklog: async () => [task('instance_a')], assertEnabled: async () => {}, runId: 'launch-2' },
      ),
    ).rejects.toThrow(/conflicting_run_active/);
  });

  it('cancel freezes status=cancelled + dissolves the hive', async () => {
    await upsertBenchRun({ id: 'cancel-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-cancel-1' }, scope);
    await setBenchRunHive('cancel-1', 'hive-cancel-1', scope);
    const dissolve = vi.fn(async () => {});
    const res = await cancelBenchRun('cancel-1', { scope, dissolve });
    expect(res.cancelled).toBe(true);
    expect(dissolve).toHaveBeenCalledWith('hive-cancel-1', WS);
    const detail = await getBenchRunDetail('cancel-1', scope);
    expect(detail!.status).toBe('cancelled');
  });
});

describe('reapStaleBenchRuns — spend-safety HARD GATE (P-005 / D-022)', () => {
  it('reaps every in-flight run on restart: dissolves the hive + freezes status (0 orphan re-spin)', async () => {
    // Two runs the crashed host left mid-flight.
    await upsertBenchRun({ id: 'stale-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-stale-1' }, scope);
    await upsertBenchRun({ id: 'stale-2', arm: 'fifo-noqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-stale-2' }, scope);

    const dissolve = vi.fn(async () => {});
    const { reaped } = await reapStaleBenchRuns({ scope, dissolve, staleAfterSec: 0 });

    expect(reaped.sort()).toEqual(['stale-1', 'stale-2']);
    // Every orphan hive was dissolved (deactivating its learning loops → no re-spin).
    expect(dissolve).toHaveBeenCalledWith('hive-stale-1', WS);
    expect(dissolve).toHaveBeenCalledWith('hive-stale-2', WS);
    // Status frozen to a terminal state — nothing is left 'running' to re-arm.
    for (const id of ['stale-1', 'stale-2']) {
      const d = await getBenchRunDetail(id, scope);
      expect(d!.status).toBe('error');
      expect(d!.runError).toMatch(/reaped/);
    }
    // Idempotent — a second reap finds nothing active.
    const again = await reapStaleBenchRuns({ scope, dissolve, staleAfterSec: 0 });
    expect(again.reaped).toEqual([]);
  });

  it('does NOT reap a run with a fresh heartbeat (a run legitimately in flight in another live host)', async () => {
    await upsertBenchRun({ id: 'live-1', arm: 'hive-realqueen', taskSetId: '11-task-pilot', model: 'opus', status: 'running', potSlug: 'hive-live-1' }, scope);
    const dissolve = vi.fn(async () => {});
    // updated_at was just set by upsertBenchRun → well within the 180s window.
    const { reaped } = await reapStaleBenchRuns({ scope, dissolve, staleAfterSec: 180 });
    expect(reaped).toEqual([]);
    expect(dissolve).not.toHaveBeenCalled();
    const d = await getBenchRunDetail('live-1', scope);
    expect(d!.status).toBe('running'); // untouched — still live
  });
});
