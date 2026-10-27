import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';
import type { SqlToolCandidateScore } from './sql-tool-candidate-score';
import type { SqlToolRecommendation } from './bash-substitution/sql-tool-recommendations';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async orig => ({
  ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
const { captureImprovement } = await import('./harness/improvements/capture-core');
const { createIssue } = await import('./issues-engineer');
const { enterAgentReview } = await import('./harness/improvements/agent-review');
const { getWorkItem } = await import('./work-items');
const { submitSqlCandidateReview, submitMonitoredCandidateReview, readMonitoredCandidateReview } = await import('./sql-tool-candidate-review');
const { runSqlOpportunityCensus } = await import('./harness/routines/sql-read-census-action');
const { buildScratchUri, safeScratchFilesystemPath } = await import('./scratch-uri');
const { writeScratchReference } = await import('./scratch-reference');
const { miningScopeId } = await import('./agent-opportunities/privacy');
const WS = 'sql-review-fixture', HARNESS = 'papercusp';
let db: OrgTestDb;
let scratch: string;
const priorScratch = process.env.PAPERCUSP_SCRATCH_ROOT;
const priorWorkspace = process.env.PAPERCUSP_WORKSPACE_ID;
beforeAll(async () => {
  db = await createOrgTestDb(); h.sql = db.adminSql;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  scratch = await mkdtemp(join(tmpdir(), 'monitored-review-'));
  process.env.PAPERCUSP_SCRATCH_ROOT = scratch;
  const migration = new URL('../../../libs/papercusp/libs/db/sql/1579-sql-candidate-review-lifecycle.sql', import.meta.url);
  // Drafts are exercised before arming; armed migrations are already in the fixture template.
  if (!existsSync(migration)) await db.adminSql.unsafe(readFileSync(new URL(migration.href + '.DRAFT'), 'utf8'));
  const monitored = new URL('../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await db.adminSql.unsafe(readFileSync(existsSync(monitored) ? monitored : new URL(monitored.href + '.DRAFT'), 'utf8'));
}, 180_000);
afterAll(async () => {
  if (priorWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspace;
  if (priorScratch === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = priorScratch;
  await db?.cleanup();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.adminSql`DELETE FROM harness_shared.sql_candidate_reviews`;
  await db.adminSql`DELETE FROM harness_shared.scout_routed_ideas WHERE workspace_id=${WS}`;
  await db.adminSql`DELETE FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  await db.adminSql`DELETE FROM harness_shared.tool_invocations WHERE workspace_id=${WS}`;
  await db.adminSql`DELETE FROM harness_shared.sql_intent_runs WHERE workspace_id=${WS}`;
  await db.adminSql`DELETE FROM harness_shared.sql_intent_progress WHERE workspace_id=${WS}`;
});
const candidate = (): SqlToolCandidateScore => ({
  id: 'opaque-candidate', workspaceToken: 'ws-token', harnessToken: 'h-token', boundaryToken: 'boundary',
  fingerprint: 'opaque-shape', parserVersion: 'v1', policyVersion: 'sql-demand-score-v1',
  eligible: true, reasons: [], score: .8, components: [], counts: { ok: 12, error: 0, refused: 0, unknown: 0 },
  verifiedAgents: 3, activeDays: ['2026-10-23', '2026-10-24'],
  observedCost: { measuredCalls: 12, totalMs: 120, meanMs: 10, unit: 'dispatch-wall-ms' },
});
const input = () => ({ workspaceId: WS, harnessSlug: HARNESS, submittedBy: 'su-sql-filer',
  candidate: candidate(), contractRef: 'contract-v1' });
const capture = vi.fn(async (value: Parameters<typeof captureImprovement>[0]) =>
  captureImprovement(value, { searchIssues: async () => [], createIssue }));
const enroll = vi.fn(enterAgentReview);
const deps = () => ({ client: db.adminSql, capture, enroll });
const recommendation = (kind: SqlToolRecommendation['kind']): SqlToolRecommendation => ({
  kind, reason: 'maintained-fixture', toolName: null, immediatelyCallable: false,
  fingerprint: 'opaque-shape', requiredFeatures: null, evidenceRefs: [], missingFeatures: [],
});
it('reuses actual canonical intake and post-review ownership on repeated cycles R5-CONTRACT OUTCOME-P-006', async () => {
  capture.mockClear(); enroll.mockClear();
  const first = await submitSqlCandidateReview(input(), deps());
  expect(first).toMatchObject({ status: 'pending', queue: 'agent-review', owner: null });
  const item = await getWorkItem(first.workItemId!, HARNESS);
  expect(item).toMatchObject({ state: 'open', assignee: null, payload: {
    agentReview: { status: 'pending', submittedBy: 'su-sql-filer' },
  } });
  expect(capture.mock.calls[0]![0].assignee).toBe('su-sql-filer');
  expect(await submitSqlCandidateReview({ ...input(), candidate: { ...candidate(), counts: {
    ok: 100, error: 0, refused: 0, unknown: 0 } } }, deps())).toEqual(first);
  expect(capture).toHaveBeenCalledTimes(1); expect(enroll).toHaveBeenCalledTimes(1);
  const rows = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  expect(rows).toHaveLength(1);
  const ledger = await db.adminSql`SELECT routed_ref FROM harness_shared.scout_routed_ideas WHERE workspace_id=${WS}`;
  expect(ledger).toHaveLength(1); expect(ledger[0]!.routed_ref).toBe('wi:' + first.workItemId);
});
it('unchanged declined editions stay declined; changed contracts reopen for review R5-CONTRACT OUTCOME-P-006', async () => {
  const first = await submitSqlCandidateReview(input(), deps());
  await db.adminSql`UPDATE harness_shared.work_items SET status='dropped', taken_by=NULL
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'declined', workItemId: first.workItemId });
  const changed = await submitSqlCandidateReview({ ...input(), contractRef: 'contract-v2' }, deps());
  expect(changed).toMatchObject({ status: 'pending', owner: null, lifecycleId: first.lifecycleId });
  expect(changed.workItemId).not.toBe(first.workItemId); expect(changed.editionId).not.toBe(first.editionId);
  const rows = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  expect(rows).toHaveLength(2);
});
it('accepted ownership is read from the current review item R5-CONTRACT', async () => {
  const first = await submitSqlCandidateReview(input(), deps());
  // Model the authoritative state left by the independent review workflow.
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by='su-implementer',
    payload=jsonb_set(payload,'{agentReview,status}','"approved"'::jsonb)
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({
    status: 'accepted', workItemId: first.workItemId, queue: 'implementation', owner: 'su-implementer',
  });
});
it('suppressed and ineligible candidates never file work R5-CONTRACT', async () => {
  capture.mockClear();
  expect(await submitSqlCandidateReview({ ...input(), recommendation: recommendation('keep-sql') }, deps()))
    .toMatchObject({ status: 'suppressed', workItemId: null });
  expect(await submitSqlCandidateReview({ ...input(), recommendation: recommendation('keep-sql') }, deps()))
    .toMatchObject({ status: 'suppressed', workItemId: null });
  expect(await submitSqlCandidateReview({ ...input(), candidate: { ...candidate(), eligible: false } }, deps()))
    .toMatchObject({ status: 'ineligible' });
  expect(capture).not.toHaveBeenCalled();
  const rows = await db.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id=${WS}`;
  expect(rows).toHaveLength(0);
});
it('a crash after reservation resumes the same actual intake R5-CONTRACT', async () => {
  const fail = vi.fn(async () => { throw new Error('interrupted before capture'); });
  await expect(submitSqlCandidateReview(input(), { ...deps(), capture: fail })).rejects.toThrow('interrupted');
  const [reserved] = await db.adminSql`SELECT artifact_id FROM harness_shared.sql_candidate_reviews`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'pending', workItemId: reserved!.artifact_id });
});
it('pending enrollment retries filer release without releasing a reviewer R5-CONTRACT', async () => {
  const first = await submitSqlCandidateReview(input(), deps());
  // Partial enrollment has committed its payload but has not released the filer yet.
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by='su-sql-filer'
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'pending', owner: null });
  await db.adminSql`UPDATE harness_shared.work_items SET taken_by='su-independent-reviewer'
    WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
  expect(await submitSqlCandidateReview(input(), deps())).toMatchObject({ status: 'pending', owner: 'su-independent-reviewer' });
});

const monitoredInput = (family: 'search-reformulation' | 'result-recovery' | 'workaround-funnel' | 'native-operation' = 'search-reformulation') => ({
  workspaceId: WS, harnessSlug: HARNESS, submittedBy: 'su-sql-filer', contractRef: 'monitored-contract-v1',
  family, candidateId: 'a'.repeat(64), runId: randomUUID(), client: db.adminSql,
  scope: { workspaceId: WS, sourceBoundary: 'tool-ledger', epoch: 'review-test', key: new Uint8Array(32).fill(89) },
  authorize: async () => true, timeBudgetMs: 30_000,
});
const eligibleEvidence: NonNullable<Parameters<typeof submitMonitoredCandidateReview>[1]>['evidence'] = async opts => ({
  id: opts.candidateId, reviewEligible: true, sourceRefs: ['b'.repeat(64)], operationRefs: ['c'.repeat(64)],
  metrics: { privateDerivedCount: 987654321 },
});
it('activity families reuse canonical intake and keep source-dependent measurements out of work-item copies', async () => {
  capture.mockClear(); enroll.mockClear();
  const lifecycles = new Set<string>();
  for (const family of ['search-reformulation', 'result-recovery', 'workaround-funnel', 'native-operation'] as const) {
    const request = monitoredInput(family), d = { ...deps(), evidence: eligibleEvidence };
    const first = await submitMonitoredCandidateReview(request, d);
    expect(first).toMatchObject({ status: 'pending', queue: 'agent-review', owner: null });
    lifecycles.add(first.lifecycleId);
    expect(await submitMonitoredCandidateReview({ ...request, runId: randomUUID() }, d)).toEqual(first);
    const item = await getWorkItem(first.workItemId!, HARNESS);
    expect(item).toMatchObject({ payload: { monitoredCandidateReview: {
      family, runId: request.runId, candidateId: request.candidateId,
      lifecycleId: first.lifecycleId, editionId: first.editionId }, agentReview: { status: 'pending' } } });
    const recorded = capture.mock.calls.find(c => c[0].artifactId === first.workItemId)![0];
    expect(JSON.stringify(recorded)).not.toMatch(/privateDerivedCount|987654321|sourceRefs|operationRefs/);
    expect(await readMonitoredCandidateReview(request, d)).toEqual(first);
    await db.adminSql`UPDATE harness_shared.work_items SET status='dropped',taken_by=NULL
      WHERE workspace_id=${WS} AND feature_id=${first.workItemId!}`;
    expect(await submitMonitoredCandidateReview(request, d)).toMatchObject({ status: 'declined', workItemId: first.workItemId });
    const changed = await submitMonitoredCandidateReview({ ...request, contractRef: 'monitored-contract-v2' }, d);
    expect(changed).toMatchObject({ status: 'pending', lifecycleId: first.lifecycleId });
    expect(changed.editionId).not.toBe(first.editionId);
  }
  expect(lifecycles.size).toBe(4); expect(capture).toHaveBeenCalledTimes(8); expect(enroll).toHaveBeenCalledTimes(8);
});
it('activity review fails closed before reservation and after mid-intake revocation, then recovers the same pointer', async () => {
  const request = monitoredInput(); let allowed = false;
  const evidence = vi.fn(async (opts: Parameters<NonNullable<typeof eligibleEvidence>>[0]) =>
    allowed ? eligibleEvidence!(opts) : null);
  capture.mockClear(); enroll.mockClear();
  expect(await submitMonitoredCandidateReview(request, { ...deps(), evidence })).toMatchObject({ status: 'UNKNOWN', workItemId: null });
  expect(await db.adminSql`SELECT 1 FROM harness_shared.sql_candidate_reviews`).toHaveLength(0);
  allowed = true;
  const interrupted = await submitMonitoredCandidateReview(request, { ...deps(), evidence,
    capture: async value => { const result = await capture(value); allowed = false; return result; } });
  expect(interrupted).toMatchObject({ status: 'UNKNOWN', workItemId: null, owner: null });
  expect(interrupted).toMatchObject({ stage: 'review', reason: 'monitored_candidate_evidence_or_intake_unavailable' });
  expect(enroll).not.toHaveBeenCalled();
  expect(await readMonitoredCandidateReview(request, { ...deps(), evidence })).toBeNull();
  const [reservation] = await db.adminSql`SELECT artifact_id FROM harness_shared.sql_candidate_reviews`;
  allowed = true;
  const resumed = await submitMonitoredCandidateReview(request, { ...deps(), evidence });
  expect(resumed).toMatchObject({ status: 'pending', workItemId: reservation!.artifact_id });
  expect(capture).toHaveBeenCalledTimes(1);
  expect(await readMonitoredCandidateReview(request, { ...deps(), evidence })).toEqual(resumed);
  expect(await readMonitoredCandidateReview(request, { ...deps(), evidence,
    read: async (id, harness) => { const item = await getWorkItem(id, harness); allowed = false; return item; } })).toBeNull();
});
it('a timed-out activity evidence read cannot later reserve or enroll demand', async () => {
  const request = { ...monitoredInput(), timeBudgetMs: 10 };
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const evidence = async (opts: Parameters<NonNullable<typeof eligibleEvidence>>[0]) => { await wait; return eligibleEvidence!(opts); };
  expect(await submitMonitoredCandidateReview(request, { ...deps(), evidence })).toMatchObject({ status: 'UNKNOWN',
    stage: 'review', reason: 'sql_mining_time_budget' });
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(await db.adminSql`SELECT 1 FROM harness_shared.sql_candidate_reviews`).toHaveLength(0);
});
it('production cadence carries real authorized search sources into canonical review and revokes reads on output loss', async () => {
  const request = monitoredInput(), now = Date.parse('2026-10-25T12:00:00Z'), paths: string[] = [];
  for (const query of ['private-job queue', 'private-job status', 'private-job owner']) {
    const uri = buildScratchUri({ workspaceId: WS, toolName: 'tools:find', runId: randomUUID(), basename: 'result.spill' });
    const path = safeScratchFilesystemPath(uri); paths.push(path);
    writeScratchReference({ filePath: path, payload: JSON.stringify({ results: [] }), workspaceId: WS,
      ownerId: 'su-private-actor', mediaType: 'application/json', bodyOffsetInPayload: 0 });
    await db.adminSql`INSERT INTO harness_shared.tool_invocations
      (workspace_id,harness_slug,plugin_name,tool_name,role,spawn_id,window_key,invoked_at,status,
        coord_owner_id,args_json,transport,call_origin,call_origin_source,duration_ms,output_ref)
      VALUES (${WS},${HARNESS},'agent-mcp','tools:find','operator','test-request','test','2026-10-24T11:00:00Z',
        'ok','su-private-actor',${JSON.stringify({ query })}::jsonb,'mcp','agent','declared',12,${uri})`;
  }
  await db.adminSql`INSERT INTO harness_shared.sql_intent_progress (workspace_id,scope_id,harness_slug,retained_from)
    VALUES (${WS},${miningScopeId(request.scope, HARNESS)},${HARNESS},'2026-10-01T00:00:00Z')`;
  // Test seeding establishes fixture history only, never a deployed continuity receipt.
  const result = await runSqlOpportunityCensus({ ...request, now, rowBudget: 100 }, {
    monitoredReview: (value, supplied) => submitMonitoredCandidateReview(value, { ...supplied, ...deps() }),
  });
  expect(result.monitored).not.toBeNull();
  expect(result.monitoredReviewIntake).toMatchObject({ selected: 1, outsideBatch: 0,
    reviews: [{ family: 'search-reformulation', status: 'pending', queue: 'agent-review', owner: null }] });
  const review = result.monitoredReviewIntake!.reviews[0]!;
  const [stored] = await db.adminSql`SELECT diagnostics->'reviewIntake' AS review FROM harness_shared.sql_intent_family_runs
    WHERE workspace_id=${WS} AND run_id=${result.monitored!.runId}::uuid AND family='search-reformulation'`;
  expect(stored!.review).toHaveLength(1);
  expect(stored!.review).toMatchObject([{ family: review.family, candidateId: review.candidateId, status: 'pending' }]);
  expect(stored!.review[0]).not.toHaveProperty('owner');
  expect(stored!.review[0]).not.toHaveProperty('queue');
  const readInput = { ...request, now, rowBudget: 100, candidateId: review.candidateId,
    runId: result.monitored!.runId, contractRef: 'monitored-review-demand-v1' };
  expect(await readMonitoredCandidateReview(readInput, deps())).toMatchObject({ status: 'pending' });
  const original = readFileSync(paths[0]!); await rm(paths[0]!);
  expect(await readMonitoredCandidateReview(readInput, deps())).toBeNull();
  expect(await submitMonitoredCandidateReview(readInput, deps())).toMatchObject({ status: 'UNKNOWN', workItemId: null });
  await writeFile(paths[0]!, original);
  expect(await readMonitoredCandidateReview(readInput, deps())).toMatchObject({ status: 'pending' });
  const item = await getWorkItem('workItemId' in review ? review.workItemId! : '', HARNESS);
  expect(JSON.stringify(item)).not.toMatch(/private-job|su-private-actor|sourceRefs|operationRefs/);
  const failed = await runSqlOpportunityCensus({ ...request, now, rowBudget: 100 }, {
    monitoredReview: async () => { throw new Error('private review failure'); },
  });
  expect(failed.monitoredReviewIntake!.reviews).toMatchObject([{ status: 'UNKNOWN', stage: 'review', reason: 'dependency-error' }]);
  const [unknown] = await db.adminSql`SELECT diagnostics->'reviewIntake' AS review FROM harness_shared.sql_intent_family_runs
    WHERE workspace_id=${WS} AND run_id=${failed.monitored!.runId}::uuid AND family='search-reformulation'`;
  expect(unknown!.review).toEqual(failed.monitoredReviewIntake!.reviews);
  expect(JSON.stringify(unknown)).not.toContain('private review failure');
});
