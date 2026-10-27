/**
 * storage.integration.test.ts — persistRunReport, the llm_test_runs /
 * llm_test_findings writer (schema in baseline, ex-073), against a real Postgres.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - findings_count aggregates severities across BOTH assert violations AND judge
 *    findings into one {error,warn,info} jsonb;
 *  - the transcript is zstd-compressed on write and decompressTranscript round-trips
 *    it back to the raw SSE array;
 *  - one llm_test_findings row per violation (source='assert') + per judge finding
 *    (source='judge');
 *  - `id`/`run_id` are real uuid columns — runIds must be valid UUIDs (faithfulness).
 *
 * The module opens its own pool via getHarnessAdminUrl(); we mock that to the
 * testcontainer DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { validateToolDeliveryManifests, type ToolDeliveryExperiment, type ToolDeliveryRun } from '../tool-delivery-acceptance';

const h = vi.hoisted(() => ({ url: '' }));
vi.mock('../embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => h.url,
  // storage.ts also resolves the admin URL via the with-source variant; the mock must expose
  // it too or persistRunReport throws "No export getHarnessAdminUrlWithSource on the mock".
  getHarnessAdminUrlWithSource: () => ({ url: h.url, source: 'test' }),
}));

const { persistRunReport, decompressTranscript } = await import('./storage');

const RUN_ID = '11111111-1111-1111-1111-111111111111';
const PERSISTENCE_SECRET = `sk-${'p'.repeat(48)}`;
let rootSql: postgres.Sql;

// Minimal RunReport — only the fields persistSingleRun reads (cast past the rich type).
function makeReport() {
  const turn = (rawSseTape: unknown[]) => ({
    rawSseTape, assistantText: 'hi', toolCalls: [], toolResults: [], cards: [], controlTags: [],
    finishReason: 'stop', costUsd: 0.1, latencyMs: 5, error: null,
  });
  const firstTurn = {
    ...turn([{ e: 'a' }]),
    toolResults: [{
      name: 'work_items:get',
      output: JSON.stringify({ apiKey: PERSISTENCE_SECRET, results: [{ id: 'WI-200' }] }),
      isError: false,
      truncated: false,
      sourceChars: 100,
    }],
  };
  const secondTurn = turn([{ e: 'b' }, { e: 'c' }]);
  const summary = {
    runId: RUN_ID, scenarioId: 'sc-1', scenarioVersion: 1, scenarioTarget: 'su', identityHash: 'idh',
    matrixIndex: null, sutModel: 'opus', judgeModel: 'sonnet', personaId: 'p1',
    personaTraits: { tone: 'curt' }, workspaceMode: 'isolated', transportMode: 'sse',
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
    totalCostUsd: 1.25, capBreaches: ['cap-x'],
    timeout: { cause: 'wallclock_deadline', stage: 'sut_session_send', turnIndex: 0 },
    llmCallDiagnostics: {
      events: [{
        callId: 'storage-call', attempt: 1, phase: 'transport-error', observedAt: '2026-01-01T00:00:10Z',
        label: 'gateway-pool', endpointOrigin: 'http://127.0.0.1:8788', loopback: true,
        governorMode: 'shared-provider', requestedAccount: null, servedAccount: 'account-a',
        providerRequestId: null, status: 503, transportFailureCode: 'ETIMEDOUT', callerAborted: false,
      }],
      total: 1,
      omitted: 0,
    },
    turns: [firstTurn, secondTurn],
    toolInvocations: [], continueChainRows: [],
  };
  const run = {
    status: 'passed',
    summary,
    simHistory: [
      { who: 'sim', action: { kind: 'text', thought: 'needs approval', text: 'Please approve this write.' } },
      { who: 'sut', turn: firstTurn },
      { who: 'sim', action: { kind: 'choice', thought: 'approved', cardId: 'approval', optionId: 'yes', freeText: 'go' } },
      { who: 'sut', turn: secondTurn },
    ],
    violations: [
      { severity: 'error', assertKind: 'shape', evidenceTurnIdx: 0, claim: 'v-err', suggestion: 's', originatingFindingIds: [] },
      { severity: 'warn', assertKind: 'tone', evidenceTurnIdx: null, claim: 'v-warn', suggestion: null, originatingFindingIds: [] },
    ],
    judge: {
      findings: [
        { severity: 'error', axis: 'accuracy', shape: 'missing', evidenceTurnIdx: 1, claim: 'j-err', suggestion: null, copyPrompt: 'cp' },
        { severity: 'info', axis: 'style', shape: 'nit', evidenceTurnIdx: null, claim: 'j-info', suggestion: 's2', copyPrompt: null },
      ],
      scores: { accuracy: 0.9 }, notes: 'n', judgeOverruledAssert: false, costUsd: 0.2,
    },
  };
  return { matrixGroupId: undefined, runs: [run] } as never;
}

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `llm_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  h.url = u.toString(); // the module's pool will open against this
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline (ex-073): id/run_id are uuid, findings_count jsonb NOT NULL default, etc.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.llm_test_runs (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      scenario_id text NOT NULL, scenario_version integer NOT NULL,
      scenario_target text NOT NULL, scenario_hash text NOT NULL, identity_hash text NOT NULL,
      matrix_group_id uuid, matrix_index integer,
      rubric_version text NOT NULL, sut_model text NOT NULL, judge_model text NOT NULL,
      persona_id text NOT NULL, persona_traits_json jsonb NOT NULL,
      workspace_mode text NOT NULL, transport_mode text NOT NULL,
      status text NOT NULL,
      started_at timestamptz DEFAULT now() NOT NULL, finished_at timestamptz,
      cost_usd numeric(10,6) DEFAULT 0 NOT NULL, cap_breaches text[] DEFAULT '{}'::text[] NOT NULL,
      scores_json jsonb, findings_count jsonb DEFAULT '{}'::jsonb NOT NULL,
      transcript_raw_zstd bytea, transcript_norm_json jsonb DEFAULT '{}'::jsonb NOT NULL,
      telemetry_json jsonb DEFAULT '{}'::jsonb NOT NULL, asserts_json jsonb DEFAULT '{}'::jsonb NOT NULL,
      judge_json jsonb, metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.llm_test_findings (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      run_id uuid NOT NULL, source text NOT NULL, severity text NOT NULL,
      axis text, assert_kind text, shape text, evidence_turn_idx integer,
      claim text NOT NULL, suggestion text, copy_prompt text,
      promoted_to_assert_id text, promoted_from text[] DEFAULT '{}'::text[] NOT NULL,
      acknowledged boolean DEFAULT false NOT NULL, acknowledged_by text, acknowledged_at timestamptz
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('persistRunReport (PG)', () => {
  it('validates calls after a real JSONB round trip without losing argument or call ordering checks', async () => {
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const definitions = [{ name: 'work_items__list', description: 'Full guidance', parameters: { type: 'object' } }];
    const mapping: [string, string][] = [['work_items__list', 'work_items:list']];
    const experiment: ToolDeliveryExperiment = { id: 'jsonb-regression', arms: { compactArm: 'compact', fullArm: 'full' },
      scenarios: ['sc-1'], manifestContract: { provider: 'codex', systemSha256: hash('prompt'), sutModel: 'sut',
        judgeModel: 'judge', scenarioHashes: { 'sc-1': 'scenario' }, canonicalBySanitized: mapping,
        compactDefinitions: definitions, fullDefinitions: definitions } };
    const calls = [
      { name: 'work_items:list', input: { includeFleet: true, intent: 'first', nested: { longerKey: [2, 1], a: null } } },
      { name: 'work_items:list', input: { limit: 2, intent: 'second' } },
    ];
    const turns = [{ toolCalls: calls }];
    const [stored] = await rootSql<{ normalized: unknown }[]>`SELECT ${rootSql.json(turns)}::jsonb AS normalized`;
    expect(JSON.stringify(stored!.normalized)).not.toBe(JSON.stringify(turns));
    expect(stored!.normalized).toEqual(turns);
    const manifest = (responseIndex: number) => ({ name: 'tool_definition_manifest', data: {
      schemaVersion: 'su-tool-definitions-v1', provider: 'codex', systemSha256: hash('prompt'), responseIndex,
      fullDefinitionsAfterUse: false, canonicalBySanitized: mapping,
      usedCanonicalNames: responseIndex ? ['work_items:list'] : [], definitions,
      sha256: hash(definitions), bytes: Buffer.byteLength(JSON.stringify(definitions)),
    } });
    const row: ToolDeliveryRun = { id: RUN_ID, scenario_id: 'sc-1', scenario_hash: 'scenario', sut_model: 'sut',
      judge_model: 'judge', status: 'passed', variant: 'full', transcript_norm_json: stored!.normalized,
      raw_events: [manifest(0), ...calls.flatMap((call, i) => [
        { name: 'tool_call', data: call }, manifest(i + 1),
      ]), { name: 'done', data: {} }] };
    expect(validateToolDeliveryManifests(row, experiment).reason).toBeUndefined();
    const mutations: Array<(turns: any[]) => void> = [
      value => { value[0].toolCalls.reverse(); },
      value => { value[0].toolCalls[0].input.nested.longerKey.reverse(); },
      value => { value[0].toolCalls[0].input.intent = 'changed'; },
      value => { value[0].toolCalls.pop(); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(stored!.normalized) as any[];
      mutate(changed);
      expect(validateToolDeliveryManifests({ ...row, transcript_norm_json: changed }, experiment).reason)
        .toContain('raw/normalized');
    }
    const changed = structuredClone(row);
    (changed.raw_events as any[])[0].data.definitions[0].description = 'Changed definition';
    expect(validateToolDeliveryManifests(changed, experiment).reason).toContain('frozen delivery contract');
  });
  it('inserts the run row with the cross-source findings_count and round-trippable transcript', async () => {
    await persistRunReport(makeReport(), 'rubric-v3', 'scenhash');
    const runs = await rootSql<{ status: string; scenario_target: string; findings_count: Record<string, number>; cost_usd: string; cap_breaches: string[]; rubric_version: string; transcript_raw_zstd: Buffer; transcript_norm_json: unknown; metadata_json: unknown }[]>`
      SELECT status, scenario_target, findings_count, cost_usd, cap_breaches, rubric_version, transcript_raw_zstd, transcript_norm_json, metadata_json
        FROM harness_shared.llm_test_runs WHERE id = ${RUN_ID}`;
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.status).toBe('passed');
    expect(r.scenario_target).toBe('su');
    expect(r.findings_count).toEqual({ error: 2, warn: 1, info: 1 }); // 1 violation-err + 1 judge-err; 1 warn; 1 info
    expect(Number(r.cost_usd)).toBeCloseTo(1.25, 6);
    expect(r.cap_breaches).toEqual(['cap-x']);
    expect(r.rubric_version).toBe('rubric-v3');
    expect(r.metadata_json).toEqual({
      timeout: {
        cause: 'wallclock_deadline',
        stage: 'sut_session_send',
        turnIndex: 0,
      },
      llmCallDiagnostics: {
        events: [{
          callId: 'storage-call', attempt: 1, phase: 'transport-error', observedAt: '2026-01-01T00:00:10Z',
          label: 'gateway-pool', endpointOrigin: 'http://127.0.0.1:8788', loopback: true,
          governorMode: 'shared-provider', requestedAccount: null, servedAccount: 'account-a',
          providerRequestId: null, status: 503, transportFailureCode: 'ETIMEDOUT', callerAborted: false,
        }],
        total: 1,
        omitted: 0,
      },
    });
    // transcript compressed on write → decompressTranscript restores the flattened rawSseTape.
    expect(decompressTranscript(r.transcript_raw_zstd)).toEqual([{ e: 'a' }, { e: 'b' }, { e: 'c' }]);
    expect(r.transcript_norm_json).toEqual([
      expect.objectContaining({
        idx: 0,
        toolResults: [expect.objectContaining({
          name: 'work_items:get',
          output: expect.stringContaining('[redacted]'),
        })],
        userText: 'Please approve this write.',
        simThought: 'needs approval',
        simKind: 'text',
      }),
      expect.objectContaining({
        idx: 1,
        userText: '[card approval → yes]: go',
        simThought: 'approved',
        simKind: 'choice',
      }),
    ]);
    expect(JSON.stringify(r.transcript_norm_json)).not.toContain(PERSISTENCE_SECRET);
  });

  it('writes one findings row per violation (assert) + per judge finding (judge)', async () => {
    const rows = await rootSql<{ source: string; severity: string; claim: string; assert_kind: string | null; axis: string | null }[]>`
      SELECT source, severity, claim, assert_kind, axis FROM harness_shared.llm_test_findings
       WHERE run_id = ${RUN_ID} ORDER BY source, severity`;
    expect(rows).toHaveLength(4);
    const asserts = rows.filter((x) => x.source === 'assert');
    const judges = rows.filter((x) => x.source === 'judge');
    expect(asserts.map((x) => x.claim).sort()).toEqual(['v-err', 'v-warn']);
    expect(asserts.every((x) => x.assert_kind !== null && x.axis === null)).toBe(true); // asserts carry assert_kind, no axis
    expect(judges.map((x) => x.claim).sort()).toEqual(['j-err', 'j-info']);
    expect(judges.every((x) => x.axis !== null && x.assert_kind === null)).toBe(true); // judge findings carry axis
  });
});
