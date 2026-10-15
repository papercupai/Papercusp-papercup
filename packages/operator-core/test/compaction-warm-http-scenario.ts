/** No-host compaction custody through the maintained disposable HTTP worker. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { materializeLoop } from '../lib/harness/routines/loop';
import { setLoopCarryNote, getLoopCarryNoteWithMeta } from '../lib/carry-note';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string };

export async function measureCompactionWarmScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const requests: Array<Record<string, unknown>> = [];
  async function invoke(name: string, args: Record<string, unknown>) {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness, callerSid: 'private-compaction-warm', confirmed: true }),
      signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json() as any;
    await writeFile(join(o.evidenceDir, `compaction-request-${requests.length}.json`),
      JSON.stringify({ name, args, status: response.status, envelope }), { flag: 'wx' });
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    const text = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data ?? envelope.result);
    requests.push({ name, status: response.status, result });
    return { result, isError: envelope.result?.isError };
  }
  // Read the actor through the real transport before seeding its private rows.
  const { result: identity } = await invoke('coord:whoami', {});
  assert.equal(typeof identity.ownerId, 'string', JSON.stringify(identity));
  const ownerId: string = identity.ownerId;
  assert.ok(ownerId.length > 0);
  await materializeLoop({ workspaceId: o.workspace, harnessSlug: o.harness, ownerId,
    intervalSec: 300, kickoff: 'Keep the original WARM context', carry: 'warm',
    goal: 'Private no-host compaction custody control' });
  const ref = { workspaceId: o.workspace, harness: o.harness, ownerId };
  const note = 'Existing source-custody checkpoint; preserve WARM';
  await setLoopCarryNote(ref, note);
  const { sql } = getOrgPg();
  const snapshot = async () => {
    const rows = await sql`SELECT active, payload_template, next_fire_at::text AS next_fire_at
      FROM harness_shared.routines WHERE workspace_id = ${o.workspace} AND target_owner_id = ${ownerId}`;
    assert.equal(rows.length, 1, 'private owner must have exactly one routine');
    return { routine: rows[0], carry: await getLoopCarryNoteWithMeta(ref) };
  };
  const before = await snapshot();
  assert.equal(before.routine.active, true);
  assert.equal(before.routine.payload_template.carry ?? 'warm', 'warm');
  for (const args of [{}, { focus: 'continue the existing lane' }, { autoContinue: true },
    { respawn: true, continueNote: 'continue the existing lane' }]) {
    const response = await invoke('session:request-compaction', args);
    assert.equal(response.isError, true, JSON.stringify(response));
    assert.deepEqual({ ok: response.result.ok, requested: response.result.requested,
      respawn: response.result.respawn, error: response.result.error,
      carry: response.result.carry, retuned: response.result.retuned },
    { ok: false, requested: false, respawn: false, error: 'no_live_pty_host', carry: 'warm', retuned: false });
    assert.deepEqual(await snapshot(), before, 'a refusal must preserve routine, carry-note and clocks');
    const pending = await sql`SELECT pending_carry_respawn FROM harness_shared.session_briefs
      WHERE workspace_id = ${o.workspace} AND owner_id = ${ownerId} AND pending_carry_respawn IS NOT NULL`;
    assert.equal(pending.length, 0, 'no-host refusal must not queue a carry-respawn');
  }
  return { workspace: o.workspace, ownerId, requests, preserved: true, noPendingRespawn: true,
    carry: 'warm', carryNote: note, testedArgs: 4 };
}
