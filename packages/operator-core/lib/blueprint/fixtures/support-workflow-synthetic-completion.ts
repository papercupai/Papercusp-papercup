/** Shared private-PG test fixture. These fabricated worker/model rows are never
 * native execution, provider spend, business acceptance, or operational proof. */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { getWorkItem } from '../../work-items';
import { runWithWorkspace } from '../../workspace-als';
import { readAcceptedBlueprintDirectWorkItem } from '../operation-admission';
import { OperationEventBodySchema, prepareDirectOperationCompletion,
  type BlueprintOperationHandle } from '../operation-service';

export async function seedSupportWorkflowSyntheticCompletion(sql: Sql, input: {
  handle: BlueprintOperationHandle; role: string; output: unknown;
}) {
  const { handle, role, output } = input;
  const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (!/^org_[a-f0-9]{12}$/.test(database?.name ?? ''))
    throw new Error('Synthetic completion requires a createOrgTestDb private database');
  if (handle.target.kind !== 'work-item') throw new Error('Synthetic completion requires a work-item target');
  const workItemId = handle.target.id, workspaceId = handle.workspaceId;
  const item = await runWithWorkspace(workspaceId, () => getWorkItem(workItemId, handle.harnessSlug));
  if (!item) throw new Error('Synthetic completion admission is missing');
  const { pin } = await readAcceptedBlueprintDirectWorkItem(sql, workspaceId, item);
  const nativeSessionId = `synthetic-business-${randomUUID()}`;
  const workerId = `worker-${nativeSessionId}`;
  await sql`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, role, feature, agent, session_id, launch_spec, coord_owner_id)
    VALUES (${workspaceId}, 'console', ${role}, ${workItemId}, 'codex', ${nativeSessionId},
      ${sql.json(JSON.parse(JSON.stringify({ acceptedOperation: { pin } })))}, ${workerId})`;
  const attestation = OperationEventBodySchema.parse({ kind: 'model-attestation', receiptId: handle.receiptId,
    workItemId, runId: null, ownerId: workerId, nativeSessionId,
    requestId: randomUUID(), providerResponseId: `response-${nativeSessionId}`, backend: 'codex', provider: 'openai',
    requestedModel: 'gpt-6.1-sol', actualModel: 'gpt-6.1-sol', forwardedEffort: 'medium', effortSource: 'forwarded-request',
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, inputTokenBasis: 'inclusive' }, source: 'gateway' });
  if (attestation.kind !== 'model-attestation') throw new Error('Expected synthetic model attestation');
  await sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
    VALUES (${workspaceId}, 'blueprint-operation', ${`receipt:${handle.receiptId}`}, ${`model-${nativeSessionId}`}, ${sql.json(attestation)})`;
  await sql`INSERT INTO harness_shared.agent_usage_samples
    (workspace_id, session_id, ts, bucket_key, provider, model, model_class, source, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, usage_provenance)
    VALUES (${workspaceId}, ${nativeSessionId}, 1000, ${nativeSessionId}, 'openai', 'gpt-6.1-sol', 'default', 'interactive',
      10, 2, 0, 0, ${sql.json({ grain: 'request', modelSource: 'transcript',
        sourceId: `turn:${nativeSessionId}`, inputTotalTokens: 10 })})`;
  const [modelFixture] = await sql<{ n: number }[]>`SELECT count(*)::int AS n
    FROM harness_shared.adv_sessions s JOIN harness_shared.agent_usage_samples u
      ON u.workspace_id = s.workspace_id AND u.session_id = s.session_id
    WHERE s.workspace_id = ${workspaceId} AND s.feature = ${workItemId}
      AND s.launch_spec->'acceptedOperation'->'pin' = ${sql.json(JSON.parse(JSON.stringify(pin)))}
      AND u.model = 'gpt-6.1-sol' AND u.usage_provenance->>'modelSource' = 'transcript'`;
  if (modelFixture?.n !== 1) throw new Error('Synthetic completion requires paired model evidence');
  const completion = await runWithWorkspace(workspaceId,
    () => prepareDirectOperationCompletion(sql, workspaceId, item, output));
  await sql`UPDATE harness_shared.work_items SET status = 'done', authority = 'committed',
    terminal_owner = ${workerId}, terminal_completion_ref = ${`synthetic:${handle.receiptId}`},
    payload = payload || ${JSON.stringify({ blueprintResult: completion })}::text::jsonb
    WHERE workspace_id = ${workspaceId} AND harness_slug = ${handle.harnessSlug} AND feature_id = ${workItemId}`;
  return { workerId, completion, pairedModelRecords: modelFixture.n };
}
