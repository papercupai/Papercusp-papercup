import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JSONValue, Sql } from 'postgres';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { blueprintHash, compileAgentSpecification, pinPackageInput, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from './project-to-pg';
import {
  BLUEPRINT_PROGRAM_COMPLETION_OWNER, blueprintProgramCompletionRef,
  blueprintOperationAcceptanceSubjectRef, cancelBlueprintOperation,
  getBlueprintOperationResult, getBlueprintOperationStatus, readAcceptedProgramRootGuard,
  submitBlueprintOperation,
  OperationEventBodySchema,
} from './operation-service';
import { seedContentHash } from '../cupboard/rubric-store';
import { getRubric, provisionPinnedRubric } from '../rubrics';
import { createWorkItem, getWorkItem, setWorkItemState } from '../work-items';
import type { ExternalRuntimeProducerBinding, ExternalRuntimeStoredOutcome } from './operation-worker-binding';
import { CompletionVerificationEvidenceSchema } from '../coord-lifecycle/records';
import { runWithWorkspace } from '../workspace-als';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { runBlueprintOperationAction } from '../harness/routines/blueprint-operation-action';
// Copy-out mutation probes load the program executor from its mirrored path.
// The normal integration suite uses the tracked module.
const {
  coordProgramWorkflowId, findUnstartedAcceptedCoordPrograms, loadAcceptedCoordProgramBlueprint,
  loadAcceptedCoordProgramChild, settleAcceptedCoordProgram, submitAcceptedCoordProgramChild,
  awaitAcceptedCoordProgramChild,
} = await import(
  /* @vite-ignore */ process.env.PAPERCUSP_PROGRAM_WORKFLOW_PROBE_PATH ?? '../dbos/coord-program-workflow'
) as typeof import('../dbos/coord-program-workflow');

const connection = vi.hoisted(() => ({
  sql: undefined as unknown as Sql,
  // WI-10004562: member harness -> pot home slug, read by the potHomeSlugForHarness mock.
  potHomes: {} as Record<string, string>,
}));
// potHomeSlugForHarness is a harness-REGISTRY read. Overriding only it makes a harness a
// pot MEMBER while the real resolveWorkItemPot / potExists / createWorkItem path runs.
vi.mock('../hive-federation', async () => {
  const actual = await vi.importActual<typeof import('../hive-federation')>('../hive-federation');
  return {
    ...actual,
    potHomeSlugForHarness: async (...args: Parameters<typeof actual.potHomeSlugForHarness>) =>
      connection.potHomes[args[1]] ?? actual.potHomeSlugForHarness(...args),
  };
});
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
  withWorkspace: async <T>(workspace: string, fn: (tx: Sql) => Promise<T>) =>
    (connection.sql as Sql).begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>,
}));

const workspaceId = 'program-child-pin-it';
const harnessSlug = 'program-child-pin-harness';
let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  // Compile fixture contracts before cloning PG: stale operation identity pins
  // should fail once at preflight, not cascade into every program scenario.
  definition('fixture-preflight');
  db = await createOrgTestDb();
  sql = db.adminSql;
  connection.sql = sql;
  await sql`CREATE SCHEMA IF NOT EXISTS dbos`;
  await sql`CREATE TABLE IF NOT EXISTS dbos.workflow_status (
    workflow_uuid text PRIMARY KEY, status text NOT NULL
  )`;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${harnessSlug}, ${Buffer.from([0])}, 'kc-program-child-pin-harness', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

describe.each(['feature', 'change'] as const)('external voice canonical %s settlement (D037)', (kind) => {
  let sequence = 0;
  async function producer(owner = 'voice-runtime-owner') {
    const completionEvidence = CompletionVerificationEvidenceSchema.parse({
      filesChanged: [], filesDeleted: [], verifiedHow: 'trusted-phone-retained-records',
      testsRun: 'Binding and retained transcript digest checks',
      testResult: 'Stored completion and independently read transcript agree',
    });
    const id = `WI-external-voice-${kind}-${++sequence}`;
    const binding: ExternalRuntimeProducerBinding = {
      kind: 'external-runtime-producer', workspaceId, harnessSlug, storageHarnessSlug: harnessSlug,
      workItemId: id, executionOwnerId: owner, ownerId: 'phone-customer',
      callKey: `inbound:${id}`, callId: `call:${id}`, runId: `run:${id}`, jobId: `job:${id}`,
      configurationSha256: 'a'.repeat(64), registeredAt: '2026-10-07T13:00:00Z',
    };
    const item = await runWithWorkspace(workspaceId, () => createWorkItem({
      id, kind, title: `Voice producer ${id}`, harness: harnessSlug, workspaceId,
      createdBy: owner, assignee: owner, assignedBy: owner, admission: 'auto',
      payload: { externalRuntimeProducer: binding as unknown as JSONValue },
    }));
    const stored: ExternalRuntimeStoredOutcome = {
      binding, endReason: 'completed', endedAt: '2026-10-07T13:01:00Z',
      transcriptSegmentCount: 2, retainedSegmentCount: 2,
      transcriptSha256: 'b'.repeat(64), retainedSha256: 'b'.repeat(64), contentDeleted: false,
    };
    const opts = { harness: item.harness!, by: owner, completionRef: `phone:${id}`,
      completionEvidence: { ...completionEvidence, summary: 'Actual retained call verified' },
      externalRuntimeAttempt: { binding, updatedTs: Date.parse(item.updatedAt),
        readStoredOutcome: async () => stored } };
    return { id, owner, item, binding, stored, opts };
  }
  it('derives normal committed authority from a verified call and reads back canonical attribution', async () => {
    const p = await producer();
    const settled = await runWithWorkspace(workspaceId, () => setWorkItemState(p.id, 'done', p.opts));
    // Unified WorkItem maps the issue family's physical resolved state to done.
    expect(settled?.state).toBe('done');
    const read = await runWithWorkspace(workspaceId, () => getWorkItem(p.id, p.item.harness!));
    expect(read).toMatchObject({ terminalOwner: p.owner, terminalCompletionRef: `phone:${p.id}`,
      completionAuthority: 'committed', payload: { _completionEvidence: {
        verifiedHow: 'trusted-phone-retained-records', filesChanged: [], filesDeleted: [],
        externalRuntimeVerification: { binding: p.binding,
          transcript: { endedAt: p.stored.endedAt, segmentCount: 2, sha256: 'b'.repeat(64) } },
      } } });
    await expect(runWithWorkspace(workspaceId, () => setWorkItemState(p.id, 'done', p.opts)))
      .rejects.toThrow(/stale|terminal/);
    const replay = await runWithWorkspace(workspaceId, () => getWorkItem(p.id, p.item.harness!));
    expect(replay?.terminalCompletionRef).toBe(read?.terminalCompletionRef);
    expect(replay?.payload).toEqual(read?.payload);
  }, 90_000);
  it('refuses completion without trusted host verification or with worker-lost evidence', async () => {
    const p = await producer();
    const { externalRuntimeAttempt: _attempt, ...untrusted } = p.opts;
    await expect(runWithWorkspace(workspaceId, () => setWorkItemState(p.id, 'done', untrusted)))
      .rejects.toThrow('governed attributed');
    p.stored.endReason = 'worker-lost';
    await expect(runWithWorkspace(workspaceId, () => setWorkItemState(p.id, 'done', p.opts)))
      .rejects.toThrow('no verified complete');
    expect((await runWithWorkspace(workspaceId, () => getWorkItem(p.id, p.item.harness!)))?.terminalOwner).toBeNull();
  }, 90_000);
  it('does not manufacture a legacy null-authority completion for a system identity', async () => {
    const p = await producer('system:voice-runtime');
    await expect(runWithWorkspace(workspaceId, () => setWorkItemState(p.id, 'done', p.opts)))
      .rejects.toThrow('legacy or system');
    expect((await runWithWorkspace(workspaceId, () => getWorkItem(p.id, p.item.harness!)))?.terminalOwner).toBeNull();
  }, 90_000);
  it.each(['holder', 'epoch', 'binding', 'cancelled'] as const)('fences a %s change between trusted verification and the terminal write', async (change) => {
    const p = await producer();
    p.opts.externalRuntimeAttempt.readStoredOutcome = async () => {
      await sql`UPDATE harness_shared.work_items SET
        taken_by = CASE WHEN ${change === 'holder'} THEN 'replacement-voice-owner' ELSE taken_by END,
        updated_ts = CASE WHEN ${change === 'epoch'} THEN updated_ts + 1 ELSE updated_ts END,
        payload = CASE WHEN ${change === 'binding'} THEN jsonb_set(payload, '{externalRuntimeProducer,runId}', '"replacement-run"'::jsonb)
                       WHEN ${change === 'cancelled'} THEN payload || '{"blueprintCancellation":{}}'::jsonb ELSE payload END
        WHERE workspace_id = ${workspaceId} AND feature_id = ${p.id}`;
      return p.stored;
    };
    let result;
    try { result = await runWithWorkspace(workspaceId, () => setWorkItemState(p.id, 'done', p.opts)); }
    catch (error) { expect(String(error)).toMatch(/binding|attempt|holder|claim/); }
    expect(result).toBeFalsy();
    const read = await runWithWorkspace(workspaceId, () => getWorkItem(p.id, p.item.harness!));
    expect(read?.terminalOwner).toBeNull();
    expect(read?.assignee).toBe(change === 'holder' ? 'replacement-voice-owner' : p.owner);
  }, 90_000);
});

const definition = (version: string) => compileAgentSpecification({
  source: {
    id: 'program-child-pin', version, workItem: { kind: 'feature' },
    roles: [{ id: 'worker' }],
    spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Pinned program' } }] },
    operations: [{
      id: 'leaf', version,
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'worker' },
      policy: { identity: { kind: 'identity', ref: 'program-leaf-test-worker',
        revision: '1.0.0', contentHash: 'c'.repeat(64) } },
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'root', version,
      target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'program' },
      inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }, {
      id: 'rootTask', version,
      target: { kind: 'work-item', itemKind: 'task' },
      execution: { kind: 'program' },
      inputSchema: { type: 'object' },
      acceptance: { resultSchema: { type: 'object' } },
    }],
  },
});

describe('scheduled native operation admission governance (WI-10007318)', () => {
  let sequence = 0;
  async function schedule(capCents?: number, concurrency = 'skip') {
    const specification = definition('routine-governance-v1');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const routineId = `native-governance-${++sequence}`;
    const templateSlug = `daily-${routineId}`;
    const triggerConfig = capCents === undefined ? {} : { costCapCents: capCents };
    const payload = { harnessSlug, templateSlug, operationHarnessSlug: harnessSlug, operationId: 'leaf', input: {} };
    await sql`INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template, concurrency, active)
      VALUES (${routineId}, ${workspaceId}, ${harnessSlug}, ${templateSlug}, 'cron',
        ${sql.json(triggerConfig)}, 'system:blueprint-operation', ${sql.json(payload)}, ${concurrency}, true)`;
    await sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, content, content_hash, status, schedule_active)
      VALUES (${workspaceId}, ${harnessSlug}, ${templateSlug}, 'Native daily', '# Native daily', 'h', 'active', true)`;
    const fire = (key: string, client = sql, withoutGuard = false) => runBlueprintOperationAction({ workspaceId, installSlug: harnessSlug,
      routineId, workflowId: `${routineId}:${key}`, triggerConfig, payloadTemplate: payload }, { sql: client,
      submit: (db, input, internal) => submitBlueprintOperation(db, input, withoutGuard ? undefined : {
        ...internal, beforeNewAdmission: async tx => {
          await internal?.beforeNewAdmission?.(tx);
          // Widen the NEW-admission critical section so a missing row lock is
          // exposed by independent clients rather than a lucky query ordering.
          await tx`SELECT pg_sleep(0.15)`;
        },
      }),
    });
    const controls = async () => {
      const [r] = await sql<Array<{ active: boolean; schedule_active: boolean; reason: string | null }>>`
        SELECT r.active, p.schedule_active, r.metadata->'pause'->>'reason' AS reason
          FROM harness_shared.routines r JOIN harness_shared.harness_plans p
            ON p.workspace_id = r.workspace_id AND p.plan_slug = ${templateSlug} AND p.harness_slug = ${harnessSlug}
         WHERE r.workspace_id = ${workspaceId} AND r.id = ${routineId}`;
      return r;
    };
    return { fire, controls, routineId };
  }
  function admitted(result: Awaited<ReturnType<typeof runBlueprintOperationAction>>) {
    const handle = result.diagnostics?.blueprintOperation as import('./operation-service').BlueprintOperationHandle;
    expect(handle?.target.kind).toBe('work-item');
    return handle;
  }
  async function settle(handle: ReturnType<typeof admitted>) {
    if (handle.target.kind !== 'work-item') throw new Error('expected direct worker');
    await sql`UPDATE harness_shared.harness_features_consolidated SET status = 'done'
      WHERE workspace_id = ${workspaceId} AND feature_id = ${handle.target.id}`;
    const [item] = await sql<Array<{ payload: { blueprintOperation: JSONValue } }>>`
      SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND feature_id = ${handle.target.id}`;
    return { id: handle.target.id, pin: item.payload.blueprintOperation, receiptId: handle.receiptId };
  }
  async function usage(item: Awaited<ReturnType<typeof settle>>, cost: number | null, options: {
    bound?: boolean; stale?: boolean; lower?: boolean; duplicateSession?: boolean; missingAttestation?: boolean; missingSample?: boolean;
  } = {}) {
    const sessionId = `native-session-${++sequence}`;
    const launchSpec = options.bound === false ? {} : { acceptedOperation: { pin: item.pin } };
    for (let i = 0; i < (options.duplicateSession ? 2 : 1); i++) {
      await sql`INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, role, feature, agent, session_id, launch_spec, coord_owner_id)
        VALUES (${workspaceId}, 'console', 'worker', ${item.id}, 'codex', ${sessionId},
          ${sql.json(launchSpec)}, ${`worker-${sessionId}`})`;
    }
    const provenance = { grain: 'request', modelSource: 'transcript', ...(options.lower ? { costBound: 'lower' } : {}) };
    if (options.bound !== false && !options.missingAttestation) {
      const event = OperationEventBodySchema.parse({ kind: 'model-attestation', receiptId: item.receiptId,
        workItemId: item.id, runId: null, ownerId: `worker-${sessionId}`, nativeSessionId: sessionId,
        requestId: randomUUID(), providerResponseId: `response-${sessionId}`, backend: 'codex', provider: 'openai',
        requestedModel: 'gpt-6.1-sol', actualModel: 'gpt-6.1-sol', forwardedEffort: 'medium', effortSource: 'forwarded-request',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokenBasis: 'inclusive' }, source: 'gateway' });
      if (event.kind !== 'model-attestation') throw new Error('expected model attestation fixture');
      await sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
        VALUES (${workspaceId}, 'blueprint-operation', ${`receipt:${item.receiptId}`}, ${`model-${sessionId}`}, ${sql.json(event)})`;
    }
    if (!options.missingSample) await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, session_id, ts, bucket_key, provider, model_class, source, cost_usd, cost_source, price_table_version, usage_provenance)
      VALUES (${workspaceId}, ${sessionId}, 1000, ${sessionId}, 'openai', 'default', 'interactive',
        ${cost}, 'estimated', ${options.stale ? 'old-table' : PRICE_TABLE_VERSION}, ${sql.json(provenance)})`;
  }
  it('serializes distinct concurrent fires, preserves exact replay and blocks an accepted worker until settlement', async () => {
    const s = await schedule();
    const clientA = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
    const clientB = postgres(db.adminDsn, { max: 2, prepare: false, onnotice: () => {} });
    let results;
    try {
      results = await Promise.all([s.fire('a', clientA), s.fire('b', clientB)]);
      const control = await schedule();
      const unguarded = await Promise.all([control.fire('a', clientA, true), control.fire('b', clientB, true)]);
      expect(unguarded.filter(r => r.diagnostics?.blueprintOperation)).toHaveLength(2);
    } finally {
      await Promise.all([clientA.end({ timeout: 1 }), clientB.end({ timeout: 1 })]);
    }
    expect(results.filter(r => r.diagnostics?.blueprintOperation)).toHaveLength(1);
    expect(results.filter(r => r.diagnostics?.blueprintOperationAdmission)).toHaveLength(1);
    const first = results.find(r => r.diagnostics?.blueprintOperation)!;
    const handle = admitted(first);
    const key = results[0] === first ? 'a' : 'b';
    expect(await s.fire(key)).toEqual(first);
    expect(await s.fire('c')).toMatchObject({ diagnostics: { blueprintOperationAdmission: {
      reason: 'overlap', admitted: false, paused: false } } });
    await settle(handle);
    expect(admitted(await s.fire('d')).receiptId).not.toBe(handle.receiptId);
  }, 90_000);
  it('sums native usage once per session and excludes unrelated unbound spend', async () => {
    const s = await schedule(200);
    const item = await settle(admitted(await s.fire('a')));
    await usage(item, 0.80, { duplicateSession: true });
    await usage(item, 0.80);
    await usage(item, 500, { bound: false });
    admitted(await s.fire('b'));
    expect(await s.controls()).toMatchObject({ active: true, schedule_active: true });
  }, 90_000);
  it('pauses both native controls on priced spend over the threshold before admitting another worker', async () => {
    const s = await schedule(200);
    const first = await s.fire('a');
    await usage(await settle(admitted(first)), 2.004);
    expect(await s.fire('b')).toMatchObject({ diagnostics: { blueprintOperationAdmission: {
      admitted: false, paused: true, reason: 'cost-exceeded', costCents: 201 } } });
    expect(await s.controls()).toMatchObject({ active: false, schedule_active: false,
      reason: 'blueprint_operation_routine_cost-exceeded' });
    expect(await s.fire('a')).toEqual(first); // receipt replay still works after pause
    expect(await s.fire('c')).toMatchObject({ diagnostics: { blueprintOperationAdmission: { reason: 'inactive' } } });
  }, 90_000);
  it.each(['missing', 'null-price', 'unbound', 'stale-price', 'lower-bound', 'missing-attestation', 'missing-sample'] as const)(
    'pauses unknown %s cost rather than treating it as zero', async variant => {
      const s = await schedule(200);
      const item = await settle(admitted(await s.fire('a')));
      if (variant !== 'missing') await usage(item, variant === 'null-price' ? null : 0.01, {
        bound: variant !== 'unbound', stale: variant === 'stale-price', lower: variant === 'lower-bound',
        missingAttestation: variant === 'missing-attestation', missingSample: variant === 'missing-sample' });
      expect(await s.fire('b')).toMatchObject({ diagnostics: { blueprintOperationAdmission: {
        reason: 'cost-unknown', admitted: false, paused: true, costCents: null } } });
      expect(await s.controls()).toMatchObject({ active: false, schedule_active: false });
    }, 90_000);
  it('fails closed on a worker concurrency policy not implemented by short routine workflows', async () => {
    const s = await schedule(undefined, 'cancel-prev');
    admitted(await s.fire('a'));
    expect(await s.fire('b')).toMatchObject({ diagnostics: { blueprintOperationAdmission: {
      reason: 'unsupported-concurrency', admitted: false, paused: true } } });
    expect(await s.controls()).toMatchObject({ active: false, schedule_active: false });
  }, 90_000);
});

describe('program child admission pins the root specification', () => {
  it('requires a passing scorecard for the pinned rubric and exact current program result', async () => {
    const rubric = {
      rubricId: 'operation-result-quality', title: 'Operation result quality',
      characteristic: 'quality', description: 'Final output quality',
      methodRef: null, ratingScale: ['pass', 'partial', 'fail', 'unknown'],
      criteria: [{ key: 'correct', title: 'Correct', model: 'Output is correct',
        method: 'Check the final output', driftMarkers: 'Wrong answer' }],
    };
    const rubricPin = pinPackageInput({ packageKind: 'rubric', ref: rubric.rubricId,
      revision: '1.0.0', files: [], dependencies: [], value: rubric });
    await provisionPinnedRubric(rubric, workspaceId);
    expect((await runWithWorkspace(workspaceId, () => getRubric(rubric.rubricId)))?.criteriaHash)
      .toBe(seedContentHash(rubric));
    const specification = compileAgentSpecification({
      source: {
        id: 'graded-program', version: '1', workItem: { kind: 'feature' },
        spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Graded program' } }] },
        operations: [{ id: 'root', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
          execution: { kind: 'program' }, inputSchema: { type: 'object' },
          acceptance: { resultSchema: { type: 'object' }, rubric: {
            kind: 'rubric', ref: rubric.rubricId, revision: rubricPin.revision,
            contentHash: rubricPin.contentHash,
          } } }],
      },
      inputClosure: [rubricPin],
    });
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const handle = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'graded-program-caller', operationId: 'root',
      requestKey: 'graded-program-root', input: {}, title: 'Graded program root',
    });
    if (handle.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = handle.target.id;
    const item = await runWithWorkspace(workspaceId, () => getWorkItem(rootId, harnessSlug));
    if (!item) throw new Error('accepted work item is missing');
    const output = { answer: 'correct' };
    const subjectRef = blueprintOperationAcceptanceSubjectRef({
      targetRef: item.id, attemptRef: item.updatedAt, operationId: handle.operationId,
      specificationRevision: handle.specificationRevision, output,
    });
    const [row] = await sql<Array<{ updated_ts: number | string }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${item.id}`;
    const attempt = { workspaceId, harnessSlug, storageHarnessSlug: harnessSlug, workItemId: item.id,
      receiptId: handle.receiptId, operationId: handle.operationId,
      specificationRevision: handle.specificationRevision,
      updatedTs: Number(row.updated_ts), requireUncancelled: true };
    const close = () => runWithWorkspace(workspaceId, () => setWorkItemState(item.id, 'done', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: blueprintProgramCompletionRef(handle, 'succeeded'),
      completionAuthority: 'validated', outputPayload: output, acceptedProgramAttempt: attempt,
    }));
    await expect(close()).rejects.toThrow(`scorecards:emit subject.ref '${subjectRef}'`);
    const [ungraded] = await sql<Array<{ status: string; result: unknown }>>`
      SELECT status, payload->'blueprintResult' AS result
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${item.id}
    `;
    expect(ungraded.status).toBe('open');
    expect(ungraded.result).toBeNull();
    const fileCard = async (suffix: string, criteriaHash: string, rating: string) => {
      const id = `EI-graded-program-${suffix}`;
      const payload = { observation: { rubricRef: rubric.rubricId, rubricRevision: 1,
        criteriaHash, evidenceFingerprint: `fixture-${suffix}`, subject: { ref: subjectRef },
        ratings: { correct: { rating, evidence: 'Verified the exact final answer' } } } };
      await sql`
        INSERT INTO harness_shared.engineer_issues
          (workspace_id, issue_id, kind, scope, title, body, severity, source,
           state, payload, created_by, signal_origin, created_at, updated_at)
        VALUES (${workspaceId}, ${id}, 'change', ${`harness:${harnessSlug}`}, 'graded result', '',
          'minor', 'test', 'done', ${JSON.stringify(payload)}::text::jsonb,
          'su-grader', 'organic', now(), now())
      `;
      return id;
    };
    await fileCard('stale', 'a'.repeat(64), 'pass');
    await expect(close()).rejects.toThrow('stale, provisional, retracted or incomplete');
    await fileCard('failed', seedContentHash(rubric), 'fail');
    await expect(close()).rejects.toThrow('does not pass pinned criterion correct');
    const cardId = await fileCard('passed', seedContentHash(rubric), 'pass');
    expect((await close())?.state).toBe('done');
    const [graded] = await sql<Array<{ status: string; result: { output: unknown; acceptanceEvidenceRef: string } }>>`
      SELECT status, payload->'blueprintResult' AS result
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${item.id}
    `;
    expect(graded.status).toBe('done');
    expect(graded.result).toMatchObject({ output, acceptanceEvidenceRef: cardId });
    expect(await getBlueprintOperationResult(sql, handle, 'graded-program-caller'))
      .toMatchObject({ state: 'ready', output, acceptanceEvidenceRef: cardId });
    await sql`
      UPDATE harness_shared.engineer_issues
         SET payload = jsonb_set(payload, '{observation,retracted}', '{"reason":"withdrawn"}'::jsonb)
       WHERE workspace_id = ${workspaceId} AND issue_id = ${cardId}
    `;
    expect(await getBlueprintOperationResult(sql, handle, 'graded-program-caller'))
      .toMatchObject({ state: 'unavailable', status: { outcome: 'unverified' } });

    const rejected = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'graded-program-caller', operationId: 'root',
      requestKey: 'graded-program-no-scorecard', input: {}, title: 'Ungraded program root',
    });
    if (rejected.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const [rejectedRow] = await sql<Array<{ updated_ts: number | string }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${rejected.target.id}`;
    const failed = await settleAcceptedCoordProgram(sql, {
      blueprintId: 'graded-program', payload: {}, callerId: 'graded-program-caller',
      workspaceId, harnessSlug, workItemId: rejected.target.id,
      runId: 'graded-program-no-scorecard', acceptedOperation: rejected,
      acceptedAttemptUpdatedTs: Number(rejectedRow.updated_ts),
    }, { outcome: 'done', resolved: true });
    expect(failed.outcome).toBe('failed');
    expect(await getBlueprintOperationResult(sql, rejected, 'graded-program-caller'))
      .toMatchObject({ state: 'failed', reason: expect.stringContaining('blueprint operation acceptance failed:') });
  }, 90_000);

  it('launches a pinned external program after the owner blueprint pointer moves', async () => {
    const external = compileAgentSpecification({ source: {
      id: 'retained-external-program', version: 'external-A', workItem: { kind: 'feature' },
      spine: { steps: [{ id: 'aggregate', op: 'vote:aggregate', args: { posts: [] } }] },
    } });
    const externalBlueprint = external.configuration as Blueprint;
    const owner = compileAgentSpecification({
      source: {
        id: 'external-program-owner', version: 'owner-A', workItem: { kind: 'feature' },
        spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Owner program' } }] },
        operations: [{
          id: 'rootExternal', version: 'owner-A',
          target: { kind: 'work-item', itemKind: 'feature' },
          execution: { kind: 'program', blueprint: { kind: 'blueprint',
            ref: externalBlueprint.id, revision: externalBlueprint.version,
            contentHash: blueprintHash(externalBlueprint) } },
          inputSchema: { type: 'object' }, acceptance: { resultSchema: { type: 'object' } },
        }],
      },
      inputClosure: [pinPackageInput({
        packageKind: 'blueprint', ref: `operation:${externalBlueprint.id}`,
        revision: externalBlueprint.version, value: externalBlueprint,
        files: [], dependencies: [],
      })],
    });
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: owner.configuration as Blueprint, specification: owner });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'external-program-caller', operationId: 'rootExternal',
      requestKey: 'external-root', input: {}, title: 'External root',
    });
    const moved = definition('external-pointer-B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: moved.configuration as Blueprint, specification: moved });
    const pending = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === accepted.receiptId);
    expect(pending?.blueprintId).toBe(externalBlueprint.id);
    expect(pending?.acceptedOperation?.specificationRevision).toBe(owner.specificationRevision);
    const program = await loadAcceptedCoordProgramBlueprint(sql, accepted, 'external-program-caller');
    expect(program.id).toBe(externalBlueprint.id);
    expect(program.version).toBe('external-A');
    expect(program.spine.steps?.[0]?.op).toBe('vote:aggregate');
  }, 90_000);

  it('bounds nested program operations by the retained recursion limit', async () => {
    const specification = definition('bounded-nesting');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'bounded-caller', operationId: 'root',
      requestKey: 'bounded-root', input: {}, title: 'Bounded root',
    });
    const parent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    const child = await submitAcceptedCoordProgramChild(sql, parent!, {
      stepId: 'op-inner', operationId: 'rootTask', input: {},
    });
    const childParent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === child.receiptId);
    expect(childParent).toBeDefined();
    await expect(submitAcceptedCoordProgramChild(sql, childParent!, {
      stepId: 'op-nested', operationId: 'root', input: {},
    })).rejects.toThrow('exceeds the accepted recursion depth');
    const receipts = await sql<Array<{ id: string }>>`
      SELECT id::text FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${workspaceId} AND request_key = ${`program:${child.receiptId}:op-nested`}
    `;
    expect(receipts).toHaveLength(0);
  }, 90_000);

  // WI-10004562 / D-045: createWorkItem re-homes a pot MEMBER harness's item to the pot
  // home slug, while the receipt stays keyed by the operation harness. The launch scan,
  // the root guard and the child-invocation root recheck joined work_items on the
  // receipt's harness, so a pot member's program stayed `accepted` forever.
  it('launches, guards and invokes a pot-member program root stored under the pot home slug', async () => {
    const member = 'program-pot-member';
    const potHome = 'program-pot-home';
    await sql`
      INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${workspaceId}, ${potHome}, ${Buffer.from([1])}, 'kc-program-pot-home', 0)
      ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
    `;
    connection.potHomes[member] = potHome;
    try {
      const specification = definition('pot-member');
      await projectBlueprintToPg(sql, { workspaceId, harnessSlug: member,
        blueprint: specification.configuration as Blueprint, specification });
      const root = await submitBlueprintOperation(sql, {
        workspaceId, harnessSlug: member, callerId: 'pot-member-caller', operationId: 'root',
        requestKey: 'pot-member-root', input: {}, title: 'Pot member root',
      });
      if (root.target.kind !== 'work-item') throw new Error('program root must be a work item');
      expect(root.harnessSlug).toBe(member);
      // Positive control: the root really was re-homed, so this case exercises the bug.
      const stored = await sql<Array<{ harness_slug: string }>>`
        SELECT harness_slug FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ${root.target.id}`;
      expect(stored.map((row) => row.harness_slug)).toEqual([potHome]);
      // The receipt records where its item is stored.
      const [receipt] = await sql<Array<{ harness_slug: string; target_harness_slug: string | null }>>`
        SELECT harness_slug, target_harness_slug FROM harness_shared.blueprint_operation_invocations
         WHERE id = ${root.receiptId}`;
      expect(receipt).toEqual({ harness_slug: member, target_harness_slug: potHome });

      // The set-based launch scan finds the re-homed root.
      const parent = (await findUnstartedAcceptedCoordPrograms(sql))
        .find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
      expect(parent).toMatchObject({ harnessSlug: member, workItemId: root.target.id });
      // The one-round-trip root guard reads it.
      expect(await readAcceptedProgramRootGuard(sql, root, 'pot-member-caller'))
        .toMatchObject({ terminal: false, cancellationRequested: false });
      // A child invocation passes the current-root recheck and lands under the pot home too.
      const child = await submitAcceptedCoordProgramChild(sql, parent!, {
        stepId: 'op-member-leaf', operationId: 'leaf', input: { value: 'member' }, title: 'Member leaf',
      });
      if (child.target.kind !== 'work-item') throw new Error('leaf child must be a work item');
      expect(await getBlueprintOperationStatus(sql, child, 'pot-member-caller')).toMatchObject({ phase: 'accepted' });
      expect(await loadAcceptedCoordProgramChild(sql, parent!, 'member-leaf', 'leaf')).toEqual(child);

      // Cancellation stays a request (D-045); the guard sees it on the re-homed root.
      await cancelBlueprintOperation(sql, root, 'pot-member-caller', {
        requestKey: 'pot-member-cancel', reason: 'pot member cancellation',
      });
      expect(await readAcceptedProgramRootGuard(sql, root, 'pot-member-caller'))
        .toMatchObject({ terminal: false, cancellationRequested: true, storageHarnessSlug: potHome });

      // Terminal settlement writes the re-homed root. Live on bg-host this threw "accepted
      // coord program root attempt changed before terminal settlement": the attempt and the
      // settle/cancel writes addressed the root by the operation harness, not the pot home.
      expect(await settleAcceptedCoordProgram(sql, parent!, { outcome: 'done', resolved: true }))
        .toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
      expect(await getBlueprintOperationStatus(sql, child, 'pot-member-caller'))
        .toMatchObject({ cancellationRequested: true });
      const settledRoot = await sql<Array<{ harness_slug: string; status: string }>>`
        SELECT harness_slug, status FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ${root.target.id}`;
      expect(settledRoot.map((row) => row.harness_slug)).toEqual([potHome]);
      expect(ANY_FAMILY_TERMINAL_STATES).toContain(settledRoot[0]!.status);

      // The successful close path settles a second re-homed root and stores its result.
      const done = await submitBlueprintOperation(sql, {
        workspaceId, harnessSlug: member, callerId: 'pot-member-caller', operationId: 'root',
        requestKey: 'pot-member-root-done', input: {}, title: 'Pot member root (done)',
      });
      const doneParent = (await findUnstartedAcceptedCoordPrograms(sql))
        .find((entry) => entry.acceptedOperation?.receiptId === done.receiptId);
      expect(doneParent).toMatchObject({ harnessSlug: member });
      expect(await settleAcceptedCoordProgram(sql, doneParent!, { outcome: 'done', resolved: true }))
        .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
      expect(await getBlueprintOperationResult(sql, done, 'pot-member-caller'))
        .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
    } finally {
      delete connection.potHomes[member];
    }
  }, 90_000);

  it('does not relaunch a legacy terminal issue-family program root', async () => {
    const specification = definition('legacy-terminal');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'terminal-caller', operationId: 'rootTask',
      requestKey: 'legacy-terminal-root', input: {}, title: 'Legacy terminal root',
    });
    if (root.target.kind !== 'work-item') throw new Error('program root must be a work item');
    await sql`UPDATE harness_shared.work_items SET status = 'resolved'
      WHERE workspace_id = ${workspaceId} AND feature_id = ${root.target.id}`;
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .some((entry) => entry.acceptedOperation?.receiptId === root.receiptId)).toBe(false);
  }, 90_000);

  it('replays a child step against its root receipt and refuses a stale root attempt', async () => {
    const first = definition('child-A');
    const second = definition('child-B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-child-caller', operationId: 'root',
      requestKey: 'child-parent', input: {}, title: 'Parent program',
    });
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    const parent = pending.find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });
    const call = { stepId: 'op-create-leaf', operationId: 'leaf', input: { value: 'pinned' }, title: 'Child leaf' };
    const child = await submitAcceptedCoordProgramChild(sql, parent!, call);
    expect(child.specificationRevision).toBe(first.specificationRevision);
    expect(child.target.kind).toBe('work-item');
    expect(await submitAcceptedCoordProgramChild(sql, parent!, call)).toEqual(child);
    expect(await loadAcceptedCoordProgramChild(sql, parent!, 'create-leaf', 'leaf')).toEqual(child);
    await expect(loadAcceptedCoordProgramChild(sql, parent!, 'other-leaf', 'leaf'))
      .rejects.toThrow('receipt is missing');
    await expect(awaitAcceptedCoordProgramChild(sql, parent!, {
      invokeStepId: 'create-leaf', operationId: 'leaf', deadlineAt: new Date(0).toISOString(),
    })).rejects.toThrow('did not settle before its deadline');
    await expect(submitAcceptedCoordProgramChild(sql, parent!, { ...call, input: { value: 'changed' } }))
      .rejects.toThrow('reused with different input');
    await expect(submitAcceptedCoordProgramChild(sql, parent!, { ...call, operationId: 'root' }))
      .rejects.toThrow('distinct declared operation');
    await sql`UPDATE harness_shared.work_items SET updated_ts = updated_ts + 1
      WHERE workspace_id = ${workspaceId} AND feature_id = ${(root.target as { id: string }).id}`;
    await expect(submitAcceptedCoordProgramChild(sql, parent!, { ...call, stepId: 'late-leaf' }))
      .rejects.toThrow('root attempt changed');
    await expect(awaitAcceptedCoordProgramChild(sql, parent!, {
      invokeStepId: 'create-leaf', operationId: 'leaf', deadlineAt: new Date(0).toISOString(),
    })).rejects.toThrow('root attempt changed');
  }, 90_000);

  it('accepts revision A after pointer B and refuses a changed replay', async () => {
    const first = definition('A');
    const second = definition('B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });

    const request = { workspaceId, harnessSlug, callerId: 'program-root-1', operationId: 'leaf',
      requestKey: 'root:step-1', input: { value: 'original' }, title: 'Pinned child' };
    const accepted = await submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: first.specificationRevision });
    expect(accepted.specificationRevision).toBe(first.specificationRevision);
    expect(accepted.target.kind).toBe('work-item');
    const replay = await submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: first.specificationRevision });
    expect(replay).toEqual(accepted);
    await expect(submitBlueprintOperation(sql, request,
      { expectedSpecificationRevision: second.specificationRevision }))
      .rejects.toThrow('receipt differs from the expected specification revision');

    const [item] = await sql<Array<{ payload: { blueprintOperation: { specificationRevision: string } } }>>`
      SELECT payload FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND feature_id = ${(accepted.target as { id: string }).id}
    `;
    expect(item.payload.blueprintOperation.specificationRevision).toBe(first.specificationRevision);
  }, 90_000);

  it('loads an accepted program from revision A after the mutable pointer moves to B', async () => {
    const first = definition('A');
    const second = definition('B');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'root',
      requestKey: 'pinned-root', input: {}, title: 'Pinned root',
    });
    if (accepted.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = accepted.target.id;
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: second.configuration as Blueprint, specification: second });

    const pinned = await loadAcceptedCoordProgramBlueprint(sql, accepted, 'program-caller');
    expect(pinned.version).toBe('A');
    expect(pinned.spine.steps?.[0]?.id).toBe('open');
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    expect(pending.map((input) => input.acceptedOperation?.receiptId)).toContain(accepted.receiptId);
    const run = { blueprintId: pinned.id, payload: {}, callerId: 'program-caller',
      workspaceId, harnessSlug, workItemId: rootId, runId: 'first',
      acceptedOperation: accepted };
    expect(coordProgramWorkflowId(run)).toBe(`coord-program:operation:${workspaceId}:${accepted.receiptId}`);
    expect(coordProgramWorkflowId({ ...run, runId: 'lost-response-retry' })).toBe(coordProgramWorkflowId(run));
    await sql`INSERT INTO dbos.workflow_status (workflow_uuid, status)
      VALUES (${coordProgramWorkflowId(run)}, 'PENDING')`;
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .some((input) => input.acceptedOperation?.receiptId === accepted.receiptId)).toBe(false);
    await sql`DELETE FROM dbos.workflow_status WHERE workflow_uuid = ${coordProgramWorkflowId(run)}`;
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .filter((input) => input.acceptedOperation?.receiptId === accepted.receiptId)).toHaveLength(1);
    // WI-10003631: the launch scan stamps a direct (non-program) work-item
    // receipt out of its partial index immediately, while an in-flight program
    // root whose workflow row is gone stays unstamped and launchable.
    const direct = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'leaf',
      requestKey: 'direct-leaf', input: { value: 'direct' }, title: 'Direct leaf',
    }, { expectedSpecificationRevision: second.specificationRevision });
    await findUnstartedAcceptedCoordPrograms(sql);
    const stamps = await sql<Array<{ id: string; started: boolean }>>`
      SELECT id::text AS id, program_started_at IS NOT NULL AS started
        FROM harness_shared.blueprint_operation_invocations
       WHERE id IN (${direct.receiptId}, ${accepted.receiptId})`;
    expect(Object.fromEntries(stamps.map((row) => [Number(row.id), row.started])))
      .toEqual({ [direct.receiptId]: true, [accepted.receiptId]: false });
    await expect(loadAcceptedCoordProgramBlueprint(sql, accepted, 'different-caller'))
      .rejects.toThrow('handle does not match its durable receipt');
    await expect(loadAcceptedCoordProgramBlueprint(sql,
      { ...accepted, specificationRevision: second.specificationRevision }, 'program-caller'))
      .rejects.toThrow('handle does not match its durable receipt');
    const [root] = await sql<Array<{ updated_ts: string | number }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}`;
    const attempt = { workspaceId, harnessSlug, storageHarnessSlug: harnessSlug, workItemId: rootId,
      receiptId: accepted.receiptId, operationId: accepted.operationId,
      specificationRevision: accepted.specificationRevision,
      updatedTs: Number(root.updated_ts), requireUncancelled: true };
    const closed = await runWithWorkspace(workspaceId, () => setWorkItemState(rootId, 'done', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: blueprintProgramCompletionRef(accepted, 'succeeded'),
      completionAuthority: 'validated', outputPayload: { outcome: 'done', resolved: true },
      acceptedProgramAttempt: attempt,
    }));
    expect(closed?.state).toBe('done');
    expect(await getBlueprintOperationResult(sql, accepted, 'program-caller'))
      .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
    expect((await findUnstartedAcceptedCoordPrograms(sql))
      .some((input) => input.acceptedOperation?.receiptId === accepted.receiptId)).toBe(false);
  }, 90_000);

  it('fences a successful program close after cancellation and settles the canonical root as cancelled', async () => {
    const first = definition('cancel');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: first.configuration as Blueprint, specification: first });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'root',
      requestKey: 'cancel-root', input: {}, title: 'Cancelled root',
    });
    if (accepted.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = accepted.target.id;
    const [root] = await sql<Array<{ updated_ts: string | number; item_kind: string }>>`
      SELECT updated_ts, item_kind FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}`;
    const attempt = { workspaceId, harnessSlug, storageHarnessSlug: harnessSlug, workItemId: rootId,
      receiptId: accepted.receiptId, operationId: accepted.operationId,
      specificationRevision: accepted.specificationRevision,
      updatedTs: Number(root.updated_ts), requireUncancelled: true };
    // The guard also reports the root's family, which the program workflow passes
    // to the settling state write. Issue-family kinds are exactly bug/change/task
    // (the engineer_issues view predicate); every other kind is feature-family.
    const family = ['bug', 'change', 'task'].includes(root.item_kind) ? 'issue' : 'feature';
    // WI-10003631: the one-round-trip step guard must agree with the full status
    // read at every lifecycle point it is consulted on.
    const guardAgrees = async () => {
      const [guard, status] = await Promise.all([
        readAcceptedProgramRootGuard(sql, accepted),
        getBlueprintOperationStatus(sql, accepted, 'program-caller'),
      ]);
      // WI-10004562: the guard also reports the slug the root is stored under; for this
      // non-member harness that is the harness itself.
      expect(guard).toEqual({ terminal: status.phase === 'terminal',
        cancellationRequested: status.cancellationRequested, family, storageHarnessSlug: harnessSlug });
      return guard;
    };
    const stored = { family, storageHarnessSlug: harnessSlug };
    expect(await guardAgrees()).toEqual({ terminal: false, cancellationRequested: false, ...stored });
    // WI-10003631: with a caller, the same statement proves the receipt — the
    // program start relies on it instead of a full canonical read.
    expect(await readAcceptedProgramRootGuard(sql, accepted, 'program-caller'))
      .toEqual({ terminal: false, cancellationRequested: false, ...stored });
    for (const [label, handle, caller] of [
      ['wrong caller', accepted, 'someone-else'],
      ['wrong operation', { ...accepted, operationId: 'other-op' }, 'program-caller'],
      ['wrong revision', { ...accepted, specificationRevision: 'f'.repeat(64) }, 'program-caller'],
      ['wrong target', { ...accepted, target: { kind: 'work-item' as const, id: 'WI-0' } }, 'program-caller'],
    ] as const) {
      await expect(readAcceptedProgramRootGuard(sql, handle, caller), label)
        .rejects.toMatchObject({ code: 'handle_mismatch' });
      await expect(getBlueprintOperationStatus(sql, handle, caller), `${label} (canonical agrees)`)
        .rejects.toMatchObject({ code: 'handle_mismatch' });
    }
    await sql`UPDATE harness_shared.work_items
      SET payload = jsonb_set(payload, '{blueprintCancellation}', '{"eventId":"test"}'::jsonb, true)
      WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}`;
    expect(await guardAgrees()).toEqual({ terminal: false, cancellationRequested: true, ...stored });
    const raced = await runWithWorkspace(workspaceId, () => setWorkItemState(rootId, 'done', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: blueprintProgramCompletionRef(accepted, 'succeeded'),
      completionAuthority: 'validated', outputPayload: { outcome: 'done', resolved: true },
      acceptedProgramAttempt: attempt,
    }));
    expect(raced).toBeNull();
    const cancelled = await runWithWorkspace(workspaceId, () => setWorkItemState(rootId, 'dropped', {
      harness: harnessSlug, by: BLUEPRINT_PROGRAM_COMPLETION_OWNER,
      completionRef: `blueprint-program:cancelled:receipt:${accepted.receiptId}`,
      completionAuthority: 'validated',
      acceptedProgramAttempt: { ...attempt, requireUncancelled: false },
    }));
    expect(cancelled?.state).toBe('dropped');
    expect(await getBlueprintOperationStatus(sql, accepted, 'program-caller'))
      .toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
    expect(await guardAgrees()).toEqual({ terminal: true, cancellationRequested: true, ...stored });
  }, 90_000);

  it('passes root cancellation to an accepted child before reporting the root cancelled', async () => {
    const specification = definition('cancel-child');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'cancel-child-caller', operationId: 'root',
      requestKey: 'cancel-child-root', input: {}, title: 'Root with running child',
    });
    const parent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    const child = await submitAcceptedCoordProgramChild(sql, parent!, {
      stepId: 'op-create-leaf', operationId: 'leaf', input: { value: 'running' },
    });
    expect((await getBlueprintOperationStatus(sql, child, 'cancel-child-caller')).cancellationRequested)
      .toBe(false);
    await cancelBlueprintOperation(sql, root, 'cancel-child-caller', {
      requestKey: 'cancel-root-once', reason: 'stop the whole program',
    });
    expect(await settleAcceptedCoordProgram(sql, parent!, { outcome: 'done', resolved: true }))
      .toMatchObject({ phase: 'terminal', outcome: 'cancelled' });
    expect(await getBlueprintOperationStatus(sql, child, 'cancel-child-caller'))
      .toMatchObject({ cancellationRequested: true });
  }, 90_000);

  it('cascades cancellation through nested programs without duplicating child requests on replay', async () => {
    const specification = definition('cancel-nested');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'nested-cancel-caller', operationId: 'root',
      requestKey: 'nested-cancel-root', input: {}, title: 'Nested cancellation root',
    });
    const accepted = await findUnstartedAcceptedCoordPrograms(sql);
    const parent = accepted.find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    const nested = await submitAcceptedCoordProgramChild(sql, parent!, {
      stepId: 'op-nested', operationId: 'rootTask', input: {},
    });
    const nestedParent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === nested.receiptId);
    expect(nestedParent).toBeDefined();
    const leaf = await submitAcceptedCoordProgramChild(sql, nestedParent!, {
      stepId: 'op-leaf', operationId: 'leaf', input: { value: 'running' },
    });

    await cancelBlueprintOperation(sql, root, 'nested-cancel-caller', {
      requestKey: 'cancel-nested-once', reason: 'stop all nested work',
    });
    expect(await settleAcceptedCoordProgram(sql, parent!, { outcome: 'done', resolved: true }))
      .toMatchObject({ outcome: 'cancelled' });
    expect(await getBlueprintOperationStatus(sql, nested, 'nested-cancel-caller'))
      .toMatchObject({ cancellationRequested: true });
    expect(await settleAcceptedCoordProgram(sql, nestedParent!, { outcome: 'done', resolved: true }))
      .toMatchObject({ outcome: 'cancelled' });
    expect(await getBlueprintOperationStatus(sql, leaf, 'nested-cancel-caller'))
      .toMatchObject({ cancellationRequested: true });
    expect(await settleAcceptedCoordProgram(sql, parent!, { outcome: 'done', resolved: true }))
      .toMatchObject({ outcome: 'cancelled' });
    const [cancelEvents] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND surface = 'blueprint-operation'
         AND writer_key = ${`receipt:${nested.receiptId}`} AND body->>'kind' = 'cancel'
    `;
    expect(Number(cancelEvents.count)).toBe(1);
  }, 90_000);

  it('cancels children beyond the first receipt page', async () => {
    const specification = definition('cancel-many');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const root = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'many-cancel-caller', operationId: 'root',
      requestKey: 'many-cancel-root', input: {}, title: 'Many child operations',
    });
    const parent = (await findUnstartedAcceptedCoordPrograms(sql))
      .find((entry) => entry.acceptedOperation?.receiptId === root.receiptId);
    expect(parent).toBeDefined();
    const child = await submitAcceptedCoordProgramChild(sql, parent!, {
      stepId: 'op-page-0', operationId: 'leaf', input: { value: 'running' },
    });
    // Clone only the receipt rows to exercise the keyset cursor. Repeated full
    // operation admissions would test provisioning cost rather than paging.
    const clones = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.blueprint_operation_invocations
        (workspace_id, harness_slug, caller_id, operation_id, request_key,
         request_fingerprint, specification_revision, target_kind, target_ref)
      SELECT i.workspace_id, i.harness_slug, i.caller_id, i.operation_id,
             ${`program:${root.receiptId}:op-page-`} || gs.n::text,
             i.request_fingerprint, i.specification_revision, i.target_kind, i.target_ref
        FROM harness_shared.blueprint_operation_invocations i
        CROSS JOIN generate_series(1, 8) AS gs(n)
       WHERE i.id = ${child.receiptId}
      RETURNING id::text
    `;
    expect(clones).toHaveLength(8);
    await cancelBlueprintOperation(sql, root, 'many-cancel-caller', {
      requestKey: 'cancel-many-once', reason: 'stop every child',
    });
    expect(await settleAcceptedCoordProgram(sql, parent!, { outcome: 'done', resolved: true }))
      .toMatchObject({ outcome: 'cancelled' });
    expect(await getBlueprintOperationStatus(sql, child, 'many-cancel-caller'))
      .toMatchObject({ cancellationRequested: true });
    const [lastPage] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND surface = 'blueprint-operation'
         AND writer_key = ${`receipt:${clones.at(-1)!.id}`}
         AND body->>'kind' = 'cancel'
    `;
    expect(Number(lastPage.count)).toBe(1);
  }, 90_000);

  it('stores a typed result on a canonical issue-family program root', async () => {
    const specification = definition('task-root');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'rootTask',
      requestKey: 'task-root', input: {}, title: 'Task root',
    });
    if (accepted.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const rootId = accepted.target.id;
    const canonical = await runWithWorkspace(workspaceId, () => getWorkItem(rootId, harnessSlug));
    expect({ id: canonical?.id, harness: canonical?.harness })
      .toEqual({ id: rootId, harness: harnessSlug });
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    const input = pending.find((entry) => entry.acceptedOperation?.receiptId === accepted.receiptId);
    expect(input).toBeDefined();
    const settled = await settleAcceptedCoordProgram(sql, input!, { outcome: 'done', resolved: true });
    expect(settled).toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(await settleAcceptedCoordProgram(sql, input!, { outcome: 'failed', resolved: false }))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(await getBlueprintOperationResult(sql, accepted, 'program-caller'))
      .toMatchObject({ state: 'ready', output: { outcome: 'done', resolved: true } });
  }, 90_000);

  it('records an unresolved program as a canonical failed root', async () => {
    const specification = definition('unresolved');
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: specification.configuration as Blueprint, specification });
    const accepted = await submitBlueprintOperation(sql, {
      workspaceId, harnessSlug, callerId: 'program-caller', operationId: 'root',
      requestKey: 'unresolved-root', input: {}, title: 'Unresolved root',
    });
    const pending = await findUnstartedAcceptedCoordPrograms(sql);
    const input = pending.find((entry) => entry.acceptedOperation?.receiptId === accepted.receiptId);
    expect(input).toBeDefined();
    expect(await settleAcceptedCoordProgram(sql, input!, { outcome: 'no-gate-match', resolved: false }))
      .toMatchObject({ phase: 'terminal', outcome: 'failed' });
    expect(await getBlueprintOperationResult(sql, accepted, 'program-caller'))
      .toMatchObject({ state: 'failed' });
  }, 90_000);
});
