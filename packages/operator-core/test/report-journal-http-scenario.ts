/** Reports detector journey on the maintained disposable operator HTTP host. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { FILE_ADAPTERS } from '../lib/search/session-ingest';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string };
const reportBody = '# Private detector assessment\n\n## Findings\n'
  + 'The disposable HTTP fixture measures journal persistence and observation filing. '.repeat(12)
  + '\n\n## Verdict\nThis is private fixture data, not an owner deliverable.';

const publicationArgs = { title: 'Private journal publication control',
  body_md: reportBody, visibility: 'owner' as const };

/** Validate caller arguments before provisioning PG or building the HTTP host.
 * Harness scope belongs to the transport envelope, not reports:publish args. */
export async function validateReportJournalRequests() {
  const { default: publish } = await import('../lib/agent-tools/reports/publish');
  const schema = publish.args as { strict(): { parse(value: unknown): unknown;
    safeParse(value: unknown): { success: boolean } } };
  schema.strict().parse(publicationArgs);
  assert.equal(schema.strict().safeParse({ ...publicationArgs, harness: 'private' }).success, false);
}

export async function measureReportJournalScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const adapter = FILE_ADAPTERS.find(candidate => candidate.sourceKind === 'codex');
  assert.ok(adapter, 'registered Codex parser is required');
  const root = adapter.roots()[0].root;
  assert.ok(root.startsWith(process.env.HOME! + '/'), 'transcript root must be in the disposable HOME');
  const dir = join(root, '2026', '10', '12');
  await mkdir(dir, { recursive: true });
  const { sql } = getOrgPg();
  const requests: Array<Record<string, unknown>> = [];

  async function invoke(name: string, args: Record<string, unknown>, callerSid: string) {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness, callerSid }),
      signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json() as any;
    await writeFile(join(o.evidenceDir, `request-${requests.length}.json`),
      JSON.stringify({ name, args, callerSid, status: response.status, envelope }), { flag: 'wx' });
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope));
    const text = envelope.result?.content?.find((item: any) => item.type === 'text' && item.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (text ? JSON.parse(text.text) : envelope.result?.data ?? envelope.result);
    requests.push({ name, status: response.status, result });
    return result;
  }

  async function turn(text: string) {
    const session = randomUUID();
    const callerSid = 'private-reports-journal-' + session;
    // The HTTP transport qualifies the caller's identity. Read that identity
    // through the same public route used by publication instead of guessing it.
    const identity = await invoke('coord:whoami', {}, callerSid);
    assert.equal(typeof identity.ownerId, 'string', JSON.stringify(identity));
    assert.ok(identity.ownerId.trim(), 'the private actor must have a canonical owner');
    const owner: string = identity.ownerId;
    const timestamp = new Date().toISOString();
    const path = join(dir, `rollout-${session}.jsonl`);
    await writeFile(path, JSON.stringify({ timestamp, type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }],
    } }) + '\n', { flag: 'wx' });
    const turnRef = `${session}:${timestamp}`;
    const key = 'unpublished-report:' + createHash('sha256').update(turnRef).digest('hex');
    return { session, callerSid, owner, timestamp, path, turnRef, key };
  }
  const ingest = (input: Awaited<ReturnType<typeof turn>>) => invoke('journal:record-turn', {
    owner: input.owner, agent: 'codex', session_id: input.session,
    source_kind: 'codex', transcript_path: input.path, harness: o.harness,
  }, input.callerSid);
  const observations = (input: Awaited<ReturnType<typeof turn>>) => sql`
    SELECT issue_id, state, created_by, body, payload FROM harness_shared.engineer_issues
    WHERE payload->>'watchdogKey' = ${input.key}`;

  const unpublished = await turn(reportBody);
  const first = await ingest(unpublished);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.recorded, true, JSON.stringify(first));
  assert.equal(first.unpublishedReportObservationScheduled, true, JSON.stringify(first));
  assert.equal(first.turn_ts, unpublished.timestamp);
  let filed = await observations(unpublished);
  const deadline = Date.now() + 20_000;
  while (!filed.length && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 100));
    filed = await observations(unpublished);
  }
  assert.equal(filed.length, 1, 'scheduling success must be followed by a real observation row');
  assert.equal(filed[0].state, 'done');
  assert.equal(filed[0].created_by, unpublished.owner);
  assert.equal(filed[0].payload.lane, 'observation');
  assert.ok(filed[0].body.includes(unpublished.turnRef));
  const journal = await sql`SELECT workspace_id, owner_id, source_kind, session_id, harness_slug
    FROM harness_shared.session_turn_journal WHERE session_id = ${unpublished.session}`;
  // postgres returns an Array subclass; compare row count and row contents,
  // rather than treating its Result prototype as provenance data.
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0], { workspace_id: o.workspace, owner_id: unpublished.owner,
    source_kind: 'codex', session_id: unpublished.session, harness_slug: o.harness });
  const duplicate = await ingest(unpublished);
  assert.equal(duplicate.recorded, false, JSON.stringify(duplicate));
  assert.equal(duplicate.deduped, true, JSON.stringify(duplicate));
  assert.equal((await observations(unpublished)).length, 1);

  const published = await turn(reportBody);
  const publication = await invoke('reports:publish', publicationArgs, published.callerSid);
  assert.equal(publication.ok, true, JSON.stringify(publication));
  assert.equal(publication.origin.author_owner_id, published.owner,
    'publication must retain the author measured on the same HTTP transport');
  const publicationRows = await sql`SELECT author_owner_id, body_md FROM harness_shared.report_library
    WHERE workspace_id = ${o.workspace} AND author_owner_id = ${published.owner}`;
  assert.equal(publicationRows.length, 1, 'suppression control must use the same real author');
  assert.equal(publicationRows[0].body_md, reportBody);
  assert.equal((await ingest(published)).recorded, true);
  const progress = await turn('Still verifying the private HTTP detector.');
  assert.equal((await ingest(progress)).recorded, true);
  // A positive control on this same process already proves the callback is wired.
  // Let both bounded callbacks settle before asserting their negative controls.
  await new Promise(done => setTimeout(done, 5_000));
  assert.equal((await observations(published)).length, 0);
  assert.equal((await observations(progress)).length, 0);
  assert.equal((await observations(unpublished)).length, 1);
  const receipt = { workspace: o.workspace, harness: o.harness,
    unpublished: { session: unpublished.session, owner: unpublished.owner, turnRef: unpublished.turnRef,
      observationId: filed[0].issue_id, journalRows: journal.length, observationRows: 1 },
    deduped: true, publishedSuppressed: true, progressSuppressed: true,
    requests: requests.map(({ name, status }) => ({ name, status })),
    scope: 'Real public HTTP dispatch and detector on a disposable current-build operator; private transcript fixtures.' };
  await writeFile(join(o.evidenceDir, 'report-journal-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}
