import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { buildScratchUri, safeScratchFilesystemPath } from '../scratch-uri';
import { writeScratchReference } from '../scratch-reference';
import { productionOpportunityReaders } from './source-readers';

let f: Awaited<ReturnType<typeof sqlMiningFixture>>, dir: string, oldRoot: string | undefined;
const workspaceId = 'sql-mining-test', harnessSlug = 'mining-test', sourceBoundary = 'tool-ledger';
let permitted = true;
beforeAll(async () => {
  f = await sqlMiningFixture(); dir = await mkdtemp(join(tmpdir(), 'opportunity-readers-'));
  oldRoot = process.env.PAPERCUSP_SCRATCH_ROOT; process.env.PAPERCUSP_SCRATCH_ROOT = dir;
}, 120_000);
afterAll(async () => {
  if (oldRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = oldRoot;
  await f?.cleanup(); if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => { await f.clear(); permitted = true;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
  await f.db.adminSql`DELETE FROM harness_shared.adv_sessions`;
});
const readers = (locateTranscript?: NonNullable<Parameters<typeof productionOpportunityReaders>[1]>['locateTranscript']) =>
  productionOpportunityReaders({ workspaceId, harnessSlug, sourceBoundary, client: f.db.adminSql,
    authorize: async () => permitted }, { locateTranscript });
async function output(over: { ownerId?: string; workspaceId?: string; nowMs?: number; boundary?: boolean } = {}) {
  const uri = buildScratchUri({ workspaceId, toolName: 'dev:pg_query', runId: randomUUID(), basename: 'result.spill' });
  const path = safeScratchFilesystemPath(uri), id = await f.seed();
  writeScratchReference({ filePath: path, payload: 'preamble\n{"hits":[{"tool":"docs:get"}]}',
    workspaceId: over.workspaceId ?? workspaceId, ownerId: over.ownerId ?? 'su-private-actor',
    mediaType: 'application/json', ...(over.boundary === false ? {} : { bodyOffsetInPayload: 9 }), nowMs: over.nowMs });
  await f.db.adminSql`UPDATE harness_shared.tool_invocations SET output_ref=${uri} WHERE id=${id}::bigint`;
  return { path, input: { id, outputRef: uri, tool: 'dev:pg_query', metadata: {} } };
}
it('hydrates only the exact ledger-linked, integrity-checked and currently authorized result body', async () => {
  const { input } = await output();
  expect(await readers().readOutput(input)).toEqual({ callId: `invocation:${input.id}`, provider: 'ledger',
    namespace: 'operator-dispatch', complete: true, body: { hits: [{ tool: 'docs:get' }] } });
  expect(await readers().readOutput({ ...input, id: '999999999' })).toBeNull();
  expect(await readers().readOutput({ ...input, tool: 'docs:get' })).toBeNull();
  permitted = false; expect(await readers().readOutput(input)).toBeNull();
  permitted = true; await f.db.adminSql`UPDATE harness_shared.tool_invocations SET output_ref=NULL WHERE id=${input.id}::bigint`;
  expect(await readers().readOutput(input)).toBeNull();
});
it('leaves expired, foreign-owner, foreign-workspace, unframed and corrupted output UNKNOWN', async () => {
  for (const over of [{ nowMs: 1 }, { ownerId: 'su-other' }, { workspaceId: 'other' }, { boundary: false }]) {
    expect(await readers().readOutput((await output(over)).input)).toBeNull();
  }
  const { input, path } = await output();
  const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  expect(await readers().readOutput(input)).toBeNull();
});
it('rejects scratch symlink escapes and oversized evidence without reading an arbitrary path', async () => {
  const { input, path } = await output();
  const outside = join(dir, 'outside'); await writeFile(outside, '{"ok":true}');
  await rm(path); await symlink(outside, path);
  expect(await readers().readOutput(input)).toBeNull();
  await rm(path); await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(await readers().readOutput(input)).toBeNull();
});

async function native(provider: 'claude' | 'codex' | 'omp' = 'codex') {
  const actor = 'su-reader-test', sessionId = randomUUID(), callId = 'call-exact';
  const [adv] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id) VALUES (${workspaceId},'console',${actor},${provider},${sessionId}) RETURNING id::text`;
  const [activity] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,phase,tool_use_id,detail,status)
    VALUES (${workspaceId},${harnessSlug},${actor},${provider},${sessionId},'tool','exec_command','pre',${callId},'{}','ok') RETURNING id::text`;
  const lines = provider === 'codex' ? [
    { timestamp: '2026-10-24T12:00:00Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: '{"cmd":"rg private src"}' } },
    { timestamp: '2026-10-24T12:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '{"exit_code":0}' } },
  ] : provider === 'claude' ? [
    { type: 'assistant', timestamp: '2026-10-24T12:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'rg private src' } }] } },
    { type: 'user', timestamp: '2026-10-24T12:00:01Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: '{"exit_code":0}' }] } },
  ] : [
    { type: 'message', timestamp: '2026-10-24T12:00:00Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'rg private src' } }] } },
    { type: 'message', timestamp: '2026-10-24T12:00:01Z', message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: '{"exit_code":0}' }] } },
  ];
  const path = join(dir, `${sessionId}.jsonl`); await writeFile(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { input: { id: activity!.id, actor, provider, sessionId, callId }, path, advId: adv!.id };
}
it('hydrates exact canonical request/result IDs from bounded transcripts for all three providers', async () => {
  for (const provider of ['claude', 'codex', 'omp'] as const) {
    const { input, path } = await native(provider);
    const result = await readers(async () => path).readTranscript(input);
    expect(result?.sources).toHaveLength(1);
    expect(result?.sources[0]).toMatchObject({ callId: input.callId, provider, namespace: input.sessionId,
      result: { callId: input.callId, provider, namespace: input.sessionId, complete: true, body: { exit_code: 0 } } });
  }
});
it('refuses source or session mismatches and rechecks authorization after transcript IO', async () => {
  const { input, path, advId } = await native();
  let reads = 0;
  const reader = readers(async () => { reads++; return path; });
  for (const wrong of [{ actor: 'su-other' }, { sessionId: randomUUID() }, { provider: 'omp' as const }, { callId: 'wrong' }])
    expect(await reader.readTranscript({ ...input, ...wrong })).toBeNull();
  expect(reads).toBe(0);
  expect(await readers(async () => { permitted = false; return path; }).readTranscript(input)).toBeNull();
  permitted = true;
  expect(await readers(async () => {
    await f.db.adminSql`UPDATE harness_shared.adv_sessions SET session_id='changed' WHERE id=${advId}::bigint`;
    return path;
  }).readTranscript(input)).toBeNull();
});
it('keeps incomplete, missing and oversized transcripts UNKNOWN instead of certifying a partial snapshot', async () => {
  const { input, path } = await native();
  const reader = readers(async () => path);
  const original = await readFile(path); await writeFile(path, original.subarray(0, original.length - 1));
  expect(await reader.readTranscript(input)).toBeNull();
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024 + 1)); expect(await reader.readTranscript(input)).toBeNull();
  await rm(path); expect(await reader.readTranscript(input)).toBeNull();
});
