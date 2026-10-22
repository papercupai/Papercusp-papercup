/** Synthetic accepted-operation control. Runs only in with-test-pg's private
 * background environment; never reads or recovers a shared worker invocation. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { runWithWorkspace } from '../../lib/workspace-als';
import { getWorkItem, setWorkItemState } from '../../lib/work-items';
import { projectBlueprintToPg } from '../../lib/blueprint/project-to-pg';
import { readActiveOperationModelPolicy } from '../../lib/blueprint/operation-worker-binding';
import { getBlueprintOperationResult, recordDirectOperationModelAttestation,
  retainDeferredOperationCompletion, settleDeferredOperationCompletions,
  submitBlueprintOperation } from '../../lib/blueprint/operation-service';
import { readAuthenticatedOperationCompletionInvocation } from '../../lib/agent-tools/work_items/complete';
import { ingestInteractiveUsage } from '../../lib/interactive-usage/ingest-claude-transcripts';

const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
assert.ok(workspaceId.startsWith('test-runtime-'));
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert.equal(process.env.PAPERCUSP_HOME, join(process.env.HOME!, '.papercusp'));
assert.notEqual(new URL(process.env.HARNESS_ADMIN_DATABASE_URL!).port, '5432');
assert.ok(!Object.keys(process.env).some(key => /^(OPENAI_|ANTHROPIC_|CODEX_HOME$)/.test(key)));
console.log('AI_COMPLETION_HOME ' + process.env.HOME);

const root = process.cwd();
const sourcePaths = [
  'packages/operator-core/lib/blueprint/operation-service.ts',
  'packages/operator-core/lib/agent-tools/work_items/complete.ts',
  'packages/operator-core/lib/interactive-usage/ingest-claude-transcripts.ts',
  'packages/operator-core/lib/work-items.ts',
];
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])));
const sourceBefore = await hashes();
const { sql } = getOrgPg();
try {
  await runWithWorkspace(workspaceId, async () => {
    const harnessSlug = 'ai-completion-private';
    const modelPolicy = { mode: 'exact' as const, models: ['gpt-5.6-sol'],
      effort: 'high', onUnavailable: 'fail' as const };
    const identity = { kind: 'identity', ref: 'worker', revision: '1.0.0', contentHash: 'b'.repeat(64) };
    const source = { id: 'ai-completion-private', workItem: { kind: 'task' },
      roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } },
      operations: [{ id: 'extract', version: 'A', target: { kind: 'work-item', itemKind: 'task' },
        execution: { kind: 'agent', role: 'worker' }, inputSchema: { type: 'object' },
        acceptance: { resultSchema: { type: 'object', required: ['edition'],
          properties: { edition: { type: 'string' } }, additionalProperties: false } },
        policy: { identity, model: modelPolicy } }],
    };
    await projectBlueprintToPg(sql, { workspaceId, harnessSlug,
      blueprint: BlueprintSchema.parse(source), specification: compileAgentSpecification({ source }) });
    const handle = await submitBlueprintOperation(sql, { workspaceId, harnessSlug,
      callerId: 'private-background-control', operationId: 'extract', requestKey: 'one-admitted-operation', input: {} });
    assert.equal(handle.target.kind, 'work-item');
    if (handle.target.kind !== 'work-item') throw new Error('expected direct work item');
    const itemId = handle.target.id;
    const initial = (await getWorkItem(itemId, harnessSlug))!;
    const pin = (initial.payload as Record<string, unknown>).blueprintOperation;
    const owner = 'private-completion-owner';
    const nativeId = randomUUID();
    const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'private-state' };
    // This models the applied launch and authenticated invocation boundary; it
    // does not launch an LLM, assert provider quality, or forge a shared receipt.
    const [launch] = await sql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, feature, agent, session_id, coord_owner_id, role, launch_spec)
      VALUES (${workspaceId}, 'omp', ${itemId}, 'codex', ${nativeId}, ${owner}, 'worker',
        ${sql.json({ workspaceId, harnessSlug, role: 'worker', ...revision,
          specificationArtifact: { configuration: { grants: {} } },
          acceptedOperation: { kind: 'blueprint-operation-worker', workItemId: itemId,
            operationId: 'extract', specificationRevision: handle.specificationRevision, pin,
            identity: { ref: identity.ref, revision: identity.revision, contentHash: identity.contentHash },
            requiredTools: ['work_items:complete'], modelPolicy,
            modelSelection: { model: 'gpt-5.6-sol:high', requestedModel: null,
              backend: 'codex', source: 'operation-policy' } } })}) RETURNING id`;
    await sql`INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
      VALUES (${workspaceId}, ${owner}, ${sql.json({ activation: { schemaVersion: 1,
        attribution: { actorId: owner, principalId: owner, sessionId: owner },
        desired: revision, prepared: null, applied: revision, status: 'applied' } })})`;
    await sql`UPDATE harness_shared.work_items SET taken_by = ${owner},
      taken_at = date_trunc('second', now()) - interval '1 minute' + interval '0.123456 seconds'
      WHERE workspace_id = ${workspaceId} AND feature_id = ${itemId}`;
    const binding = await readActiveOperationModelPolicy(workspaceId, owner, 'codex');
    assert.equal(binding.status, 'bound');
    if (binding.status !== 'bound' || !binding.attestation) throw new Error('missing applied receipt');
    const day = join(process.env.PAPERCUSP_HOME!, 'su-codex-homes', `session-${launch.id}`,
      'sessions', '2026', '10', '22');
    const transcript = join(day, `rollout-2026-10-22T00-00-00-${nativeId}.jsonl`);
    await mkdir(day, { recursive: true });
    // The strict verifier requires a known actual model before temporal gaps
    // can be deferred. Establish that prerequisite through the real ingester.
    await recordDirectOperationModelAttestation(sql, binding.attestation, {
      requestId: randomUUID(), providerResponseId: 'private-baseline-response', backend: 'codex',
      provider: 'openai', requestedModel: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol',
      forwardedEffort: 'high', effortSource: 'forwarded-request',
      usage: { inputTokens: 120, inputTokenBasis: 'inclusive', outputTokens: 17,
        cacheReadTokens: 20, cacheCreationTokens: 0 } });
    await writeFile(transcript, [
      { type: 'session_meta', payload: { id: nativeId } },
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'high' } },
      { type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 120, cached_input_tokens: 20,
          cache_write_input_tokens: 0, output_tokens: 17 } } } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const baseline = await ingestInteractiveUsage({ sessionIds: [nativeId] }, { sql, workspaceId });
    assert.deepEqual(baseline.errors, []);
    assert.equal(baseline.samples, 1);
    await recordDirectOperationModelAttestation(sql, binding.attestation, {
      requestId: randomUUID(), providerResponseId: 'private-background-response', backend: 'codex',
      provider: 'openai', requestedModel: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol',
      forwardedEffort: 'high', effortSource: 'forwarded-request',
      usage: { inputTokens: 140, inputTokenBasis: 'inclusive', outputTokens: 19,
        cacheReadTokens: 20, cacheCreationTokens: 0 } });
    const output = { edition: 'immutable-private-edition' };
    const evidence = { summary: 'Synthetic private completion after transcript convergence',
      testsRun: 'operation-completion.runtime.integration.test.ts', testResult: 'pass',
      verifiedHow: 'isolated-background-control' };
    const args = { id: itemId, harness: harnessSlug, state: 'done', assumptions: 'none',
      outputPayload: output, completion: evidence };
    const [invocation] = await sql`INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, run_id, spawn_id, window_key,
       status, coord_owner_id, principal_kind, principal_auth_method, principal_trust, args_json)
      VALUES (${workspaceId}, ${harnessSlug}, 'test-fixture', 'work_items:complete', 'worker',
        'private-original-run', 'private-spawn', 'private-window', 'ok', ${owner},
        'harness', 'spawn-url', 'trusted', ${sql.json(args)}) RETURNING id::text AS id`;
    const original = await readAuthenticatedOperationCompletionInvocation(workspaceId, invocation.id);
    assert.deepEqual(original.request.outputPayload, output);
    const item = original.item;
    const counts = async () => {
      const [row] = await sql`SELECT
        (SELECT count(*)::int FROM harness_shared.adv_sessions WHERE workspace_id = ${workspaceId}) AS workers,
        (SELECT count(*)::int FROM harness_shared.blueprint_operation_invocations WHERE workspace_id = ${workspaceId}) AS submissions,
        (SELECT count(*)::int FROM harness_shared.report_library WHERE workspace_id = ${workspaceId}) AS reports,
        ((SELECT count(*)::int FROM harness_shared.attention_notifications WHERE workspace_id = ${workspaceId}) +
         (SELECT count(*)::int FROM harness_shared.coord_event_log WHERE workspace_id = ${workspaceId}
           AND (surface = 'escalations' OR (surface IN ('messages', 'handoffs')
             AND jsonb_typeof(body->'to') = 'array' AND body->'to' ? 'human')))) AS notifications,
        (SELECT count(*)::int FROM harness_shared.tool_invocations WHERE workspace_id = ${workspaceId}) AS tool_calls`;
      return row;
    };
    const countsBefore = await counts();
    assert.equal(countsBefore.notifications, 0, 'the private control starts without human notifications');
    const close = () => setWorkItemState(itemId, 'done', { harness: harnessSlug, by: owner,
      completionAuthority: 'committed', outputPayload: output });
    await assert.rejects(close(), /unmatched request-grain/);
    assert.equal((await getWorkItem(itemId, harnessSlug))!.state, 'open');
    const retained = await retainDeferredOperationCompletion(sql, { item, ctx: original.ctx,
      state: 'done', output, completionEvidence: evidence, completionAuthority: 'committed',
      assumptions: undefined, sourceInvocationId: invocation.id });
    const [saved] = await sql`SELECT body FROM harness_shared.coord_event_log WHERE id = ${retained.eventId}`;
    assert.equal(saved.body.ownerId, owner);
    assert.equal(saved.body.sourceInvocationId, invocation.id);
    assert.deepEqual(saved.body.output, output);
    assert.deepEqual(saved.body.payloadSnapshot, item.payload);
    const before = await settleDeferredOperationCompletions(sql, workspaceId);
    assert.deepEqual(before.errors, []);
    assert.equal(before.pending, 1);
    assert.equal(before.completed, 0);
    // A bounded consumer catch-up uses the real parser and persisted watermark
    // without invoking the outer settlement sweep. This lets every SQL fence
    // face converged usage, rather than pass accidentally on a model refusal.
    await appendFile(transcript, JSON.stringify({ type: 'event_msg', payload: {
      type: 'token_count', info: { last_token_usage: { input_tokens: 140,
        cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 19 } },
    } }) + '\n');
    const catchup = await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true,
      sessionIds: [nativeId] }, { sql, workspaceId });
    assert.deepEqual(catchup.errors, []);
    assert.equal(catchup.samples, 1);
    assert.equal((await getWorkItem(itemId, harnessSlug))!.state, 'open');
    const [lateUsage] = await sql`SELECT input_tokens, output_tokens, cache_read_tokens
      FROM harness_shared.agent_usage_samples WHERE workspace_id = ${workspaceId}
        AND session_id = ${nativeId} AND output_tokens = 19`;
    assert.equal(Number(lateUsage.input_tokens), 120);
    assert.equal(Number(lateUsage.cache_read_tokens), 20);
    const controls: string[] = [];
    for (const [name, patch] of [
      ['actor', { ownerId: 'different-worker' }],
      ['item-stamp', { updatedAt: '2020-01-01T00:00:00.000Z' }],
      ['claim-stamp', { claimStamp: item.takenAt }],
      ['pin', { payloadSnapshot: { ...saved.body.payloadSnapshot, blueprintOperation: {} } }],
      ['output-snapshot', { payloadSnapshot: { ...saved.body.payloadSnapshot, out: { changed: true } } }],
      ['deadline', { deadlineAt: 1 }],
    ] as const) {
      try {
        const changed = await setWorkItemState(itemId, 'done', { harness: harnessSlug, by: owner,
          completionAuthority: 'committed', outputPayload: output,
          deferredOperationCompletion: { ...saved.body, ...patch } });
        assert.equal(changed, null, name + ' must refuse a canonical write');
      } catch (error) {
        assert.match(String(error), /deferred operation completion/, name);
      }
      assert.equal((await getWorkItem(itemId, harnessSlug))!.state, 'open', name);
      controls.push(name);
    }
    const [attested] = await sql`SELECT id, body FROM harness_shared.coord_event_log
      WHERE workspace_id = ${workspaceId} AND surface = 'blueprint-operation'
        AND body->>'kind' = 'model-attestation'
        AND body->>'providerResponseId' = 'private-background-response'`;
    for (const [name, field, value, refusal] of [
      ['model-policy', 'actualModel', 'gpt-5.6-terra', /outside the exact policy/],
      ['effort-policy', 'forwardedEffort', 'low', /outside the exact policy|differs from the accepted level/],
    ] as const) {
      await sql`UPDATE harness_shared.coord_event_log
        SET body = jsonb_set(body, ${[field]}, to_jsonb(${value}::text)) WHERE id = ${attested.id}`;
      try {
        await assert.rejects(close(), refusal);
        assert.equal((await getWorkItem(itemId, harnessSlug))!.state, 'open', name);
      } finally {
        await sql`UPDATE harness_shared.coord_event_log SET body = ${sql.json(attested.body)}
          WHERE id = ${attested.id}`;
      }
      controls.push(name);
    }
    // An unchanged native file must still drive the normal outer settlement;
    // neither another LLM turn nor a fabricated usage row is required.
    const ingested = await ingestInteractiveUsage({ sessionIds: [nativeId] }, { sql, workspaceId });
    assert.deepEqual(ingested.errors, []);
    assert.equal(ingested.samples, 0);
    const terminal = (await getWorkItem(itemId, harnessSlug))!;
    assert.equal(terminal.state, 'done');
    assert.deepEqual((terminal.payload as { out: unknown }).out, output);
    assert.equal(terminal.terminalOwner, owner);
    const after = await settleDeferredOperationCompletions(sql, workspaceId);
    assert.deepEqual(after, { completed: 0, pending: 0, refused: 0, errors: [], dispositions: [] });
    const result = await getBlueprintOperationResult(sql, handle, 'private-background-control');
    assert.equal(result.state, 'ready');
    if (result.state !== 'ready') throw new Error('canonical result is unavailable');
    assert.deepEqual(result.output, output);
    assert.equal(result.evidenceRef, `work-item:completion:${itemId}`);
    assert.equal(result.status.phase, 'terminal');
    assert.equal(result.status.outcome, 'succeeded');
    const [unchanged] = await sql`SELECT body FROM harness_shared.coord_event_log WHERE id = ${retained.eventId}`;
    const [invocationAfter] = await sql`SELECT args_json FROM harness_shared.tool_invocations WHERE id = ${invocation.id}`;
    assert.deepEqual(unchanged.body, saved.body);
    assert.deepEqual(invocationAfter.args_json, args);
    const countsAfter = await counts();
    assert.deepEqual(countsAfter, countsBefore);
    assert.deepEqual(await hashes(), sourceBefore);
    console.log('AI_COMPLETION_BACKGROUND_PROOF ' + JSON.stringify({ synthetic: true,
      workspaceId, pid: process.pid, hashes: sourceBefore, itemId, receiptId: handle.receiptId,
      invocationId: invocation.id, pendingEventId: retained.eventId, original: saved.body,
      before: { state: 'open', settlement: before }, after: { state: terminal.state, output },
      controls, ingested: { samples: catchup.samples, errors: ingested.errors }, countsBefore, countsAfter }));
  });
} finally {
  await sql.end({ timeout: 2 });
}
