/**
 * gate-watch.integration.test.ts — tickGateWatch end-to-end against real
 * Postgres + real temp JSONL files (mirrors
 * ingest-claude-transcripts.session-attribution.integration.test.ts's
 * fixture pattern).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-gate-watch-test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown,
  inboxReply: {
    listPresence: vi.fn(async () => [] as Array<{ ownerId: string }>),
    sendMessage: vi.fn(async () => ({ msg_id: 'owner-reply-1' })),
    wakeRecipients: vi.fn(async () => ({
      targets: [] as string[],
      keys: [] as string[],
      woken: 0,
      staged: 0,
      stagedTargets: [] as string[],
      fanoutCapped: [] as string[],
    })),
  },
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});
vi.mock('../agent-tools/coordination/presence', () => ({ listPresence: h.inboxReply.listPresence }));
vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage: h.inboxReply.sendMessage }));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({ wakeRecipients: h.inboxReply.wakeRecipients }));

const { tickGateWatch } = await import('./gate-watch');
const { listPendingGates, openOrTouchGate } = await import('./gate-store');
const { blockedSessionToAttention } = await import('./adapters');
const { deliverInboxOwnerReply, INBOX_OWNER_REPLY_MARKER } = await import('../agent-tools/coordination/inbox-reply');

let org: OrgTestDb;
let sql: Sql;
const tmpDirs: string[] = [];

const askLine = (id: string, question: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [{ question, options: [{ label: 'yes' }] }] } }] },
  });
const resultLine = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 120_000);
afterAll(async () => {
  await org?.cleanup();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.session_pending_gates WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.session_gate_watcher_files WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WS} AND session_id LIKE 'gate-watch-owner-%'`;
  h.inboxReply.listPresence.mockReset().mockResolvedValue([]);
  h.inboxReply.sendMessage.mockReset().mockResolvedValue({ msg_id: 'owner-reply-1' });
  h.inboxReply.wakeRecipients.mockReset().mockResolvedValue({
    targets: [], keys: [], woken: 0, staged: 0, stagedTargets: [], fanoutCapped: [],
  });
});

describe('tickGateWatch (real PG + real transcript files)', () => {
  it('retains async questions after acknowledgement, closes only correlated human replies, and replays idempotently', async () => {
    const sessionId = 'codex-async-native-session';
    const ref = (index: number) => JSON.stringify(['request_user_input_async', 'async-ask', index]);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-async-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'rollout.jsonl');
    const header = { type: 'session_meta', payload: { id: sessionId } };
    const ask = { type: 'response_item', payload: { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'async-ask',
      arguments: JSON.stringify({ questions: [{ title: 'Which route?', options: ['Direct', 'Fleet'] }, { title: 'What deadline?' }] }),
    } };
    const ack = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'async-ask', output: '{"accepted":true}' } };
    await fs.writeFile(file, [header, ask].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect((await tickGateWatch({ root: dir })).opened).toBe(2);
    await fs.appendFile(file, JSON.stringify(ack) + '\n');
    expect((await tickGateWatch({ root: dir })).closed).toBe(0);
    expect(await listPendingGates({ workspaceId: WS, sessionId })).toMatchObject([
      { ref_id: ref(0), question: 'Which route?', options: [{ label: 'Direct' }, { label: 'Fleet' }] },
      { ref_id: ref(1), question: 'What deadline?', options: null },
    ]);
    const answer = (questionItemId: string, text: string) => JSON.stringify({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text:
        `<send_user_message_question_reply>${JSON.stringify({ questionItemId, question: 'Q?', answer: text })}</send_user_message_question_reply>`,
      }],
    } });
    const firstAnswer = answer(ref(0), 'Direct');
    await fs.appendFile(file, firstAnswer.slice(0, 40));
    expect((await tickGateWatch({ root: dir })).closed).toBe(0);
    await fs.appendFile(file, firstAnswer.slice(40) + '\n');
    expect((await tickGateWatch({ root: dir })).closed).toBe(1);
    expect((await listPendingGates({ workspaceId: WS, sessionId })).map(g => g.ref_id)).toEqual([ref(1)]);
    await fs.appendFile(file, answer('["request_user_input_async","unrelated",0]', 'Tomorrow') + '\n');
    expect((await tickGateWatch({ root: dir })).closed).toBe(0);
    await fs.appendFile(file, answer(ref(1), 'Tomorrow') + '\n');
    expect((await tickGateWatch({ root: dir })).closed).toBe(1);
    // Lose the watermark: complete history must neither resurrect answered gates
    // nor add a second row for an already observed native question.
    await sql`DELETE FROM harness_shared.session_gate_watcher_files WHERE workspace_id = ${WS}`;
    const replay = await tickGateWatch({ root: dir });
    expect(replay).toMatchObject({ opened: 0, closed: 0, errors: [] });
    expect(await listPendingGates({ workspaceId: WS, sessionId })).toEqual([]);
    expect(await listPendingGates({ workspaceId: WS, sessionId, includeClosed: true })).toHaveLength(2);
  });

  it('R-1/R-2: projects a native question into the owner inbox, delivers the owner answer, wakes the asker, then closes on the correlated result', async () => {
    const sessionId = 'gate-watch-owner-codex';
    const ownerId = 'su-gate-watch-owner';
    await sql`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, session_id, agent)
      VALUES (${WS}, 'console', ${ownerId}, ${sessionId}, 'codex')
    `;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-owner-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'rollout-name-is-not-the-identity.jsonl');
    await fs.writeFile(file, [
      { type: 'session_meta', payload: { id: sessionId } },
      { type: 'response_item', payload: {
        type: 'function_call', name: 'request_user_input', call_id: 'owner-ask',
        arguments: JSON.stringify({ questions: [{ question: 'Continue with the migration?', options: [{ label: 'Yes' }] }] }),
      } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');

    expect((await tickGateWatch({ root: dir })).opened).toBe(1);
    const [gate] = await listPendingGates({ workspaceId: WS, sessionId });
    expect(gate).toMatchObject({ client: 'codex', ref_id: 'owner-ask', owner_id: ownerId, question: 'Continue with the migration?' });
    if (!gate) throw new Error('native gate was not persisted');

    const card = blockedSessionToAttention({
      sessionId, client: gate.client, refId: gate.ref_id, gateKind: gate.kind,
      question: gate.question, ownerAgentId: gate.owner_id, harnessSlug: 'papercusp',
      waitingHours: 0, actionability: 'actionable', livenessState: 'live',
    });
    expect(card).toMatchObject({
      id: 'blocked-session:codex:gate-watch-owner-codex:owner-ask',
      kind: 'blocked-session', tier: 'decision', needsHuman: true,
      ownerAgentId: ownerId, status: 'blocked (codex)',
      ref: { kind: 'blocked-session', sessionId, client: 'codex', refId: 'owner-ask' },
    });

    h.inboxReply.listPresence.mockResolvedValue([{ ownerId: sessionId }]);
    h.inboxReply.wakeRecipients.mockResolvedValue({
      targets: [sessionId], keys: [`coord:inbox-wake:${sessionId}`], woken: 1,
      staged: 0, stagedTargets: [], fanoutCapped: [],
    });
    const reply = await deliverInboxOwnerReply({
      askerId: sessionId, text: 'Yes, continue.', summary: 'Owner answered your question',
      workspaceId: WS, planSlug: 'owner-question-delivery-and-review-route-scope-2026-10-15',
    });
    expect(reply).toMatchObject({ live: true, delivered: true, woken: 1, msgId: 'owner-reply-1' });
    expect(h.inboxReply.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: expect.any(String) }),
      expect.objectContaining({ to: [sessionId], body: 'Yes, continue.', expectsReply: false }),
    );
    expect(h.inboxReply.wakeRecipients).toHaveBeenCalledWith([sessionId], expect.objectContaining({
      payload: { [INBOX_OWNER_REPLY_MARKER]: true }, source: expect.any(String), workspaceId: WS,
    }));

    await fs.appendFile(file, JSON.stringify({
      type: 'response_item', payload: { type: 'function_call_output', call_id: 'owner-ask', output: 'Yes' },
    }) + '\n');
    expect((await tickGateWatch({ root: dir })).closed).toBe(1);
    expect(await listPendingGates({ workspaceId: WS, sessionId })).toHaveLength(0);
  });

  it.each(['codex', 'omp'] as const)('persists and closes %s questions under the native header identity across watermark ticks', async (client) => {
    const sessionId = `${client}-native-session`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-native-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'timestamp-unrelated-to-session.jsonl');
    const input = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] };
    const header = client === 'codex' ? { type: 'session_meta', payload: { id: sessionId } } : { type: 'session', id: sessionId };
    const ask = client === 'codex'
      ? { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'native-ask', arguments: JSON.stringify(input) } }
      : { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'native-ask', name: 'AskUserQuestion', arguments: input }] } };
    await fs.writeFile(file, [header, ask].map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect((await tickGateWatch({ root: dir })).opened).toBe(1);
    expect(await listPendingGates({ workspaceId: WS, sessionId })).toMatchObject([
      { client, session_id: sessionId, ref_id: 'native-ask', question: 'Continue?', options: [{ label: 'Yes' }] },
    ]);
    const answer = client === 'codex'
      ? { type: 'response_item', payload: { type: 'function_call_output', call_id: 'native-ask', output: 'Yes' } }
      : { type: 'message', message: { role: 'toolResult', toolCallId: 'native-ask', content: [{ type: 'text', text: 'Yes' }] } };
    await fs.appendFile(file, JSON.stringify(answer) + '\n');
    expect((await tickGateWatch({ root: dir })).closed).toBe(1);
    const rows = await listPendingGates({ workspaceId: WS, sessionId, includeClosed: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client, closed_reason: 'tool_result_observed' });
    expect(rows[0].closed_at).toBeTruthy();
    expect((await tickGateWatch({ root: dir })).opened).toBe(0);
  });

  it('opens a gate for an unanswered AskUserQuestion, then closes it once the tool_result lands', async () => {
    const uuid = 'cccc3333-dddd-4444-eeee-555566667777';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const file = path.join(dir, `${uuid}.jsonl`);
    await fs.writeFile(file, askLine('toolu_abc', 'Deploy now?') + '\n');

    const first = await tickGateWatch({ root: dir });
    expect(first.opened).toBe(1);

    let open = await listPendingGates({ workspaceId: WS, sessionId: uuid });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ ref_id: 'toolu_abc', question: 'Deploy now?', source: 'watcher', client: 'claude' });

    // Answer arrives — appended to the SAME file.
    await fs.appendFile(file, resultLine('toolu_abc') + '\n');
    const second = await tickGateWatch({ root: dir });
    expect(second.closed).toBe(1);

    open = await listPendingGates({ workspaceId: WS, sessionId: uuid });
    expect(open).toHaveLength(0);
  });

  it('never surfaces an ask that is answered before the first tick sees it', async () => {
    const uuid = 'dddd4444-eeee-5555-ffff-666677778888';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), [askLine('toolu_fast', 'Quick?'), resultLine('toolu_fast')].join('\n') + '\n');

    const result = await tickGateWatch({ root: dir });
    expect(result.opened).toBe(0);
    const open = await listPendingGates({ workspaceId: WS, sessionId: uuid });
    expect(open).toHaveLength(0);
  });

  it('is idempotent across re-ticks with no new content (byte watermark holds)', async () => {
    const uuid = 'eeee5555-ffff-6666-aaaa-777788889999';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), askLine('toolu_idem', 'Again?') + '\n');

    const first = await tickGateWatch({ root: dir });
    expect(first.opened).toBe(1);
    const second = await tickGateWatch({ root: dir });
    // No new bytes past the watermark — skipped, not re-opened.
    expect(second.opened).toBe(0);
    expect(second.alreadyOpen).toBe(0);

    const rows = await listPendingGates({ workspaceId: WS, sessionId: uuid, includeClosed: true });
    expect(rows).toHaveLength(1);
  });

  it('ignores a non-gate tool_use entirely', async () => {
    const uuid = 'ffff6666-aaaa-7777-bbbb-888899990000';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const bashLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }] },
    });
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), bashLine + '\n');

    const result = await tickGateWatch({ root: dir });
    expect(result.opened).toBe(0);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuid })).toHaveLength(0);
  });
});

/**
 * WI-10002079 regression guards. Each of these FAILS against the pre-fix
 * watcher, which is why the routine was unrunnable rather than merely
 * incomplete.
 */
describe('tickGateWatch — WI-10002079 defects', () => {
  const MONTH_AGO = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  it('R1: scans EVERY configured root, not only one', async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-b-'));
    tmpDirs.push(dirA, dirB);
    const uuidA = 'a1111111-0000-4000-8000-00000000000a';
    const uuidB = 'b2222222-0000-4000-8000-00000000000b';
    await fs.writeFile(path.join(dirA, `${uuidA}.jsonl`), askLine('toolu_rootA', 'A?') + '\n');
    await fs.writeFile(path.join(dirB, `${uuidB}.jsonl`), askLine('toolu_rootB', 'B?') + '\n');

    const result = await tickGateWatch({ roots: [dirA, dirB] });

    expect(result.opened).toBe(2);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuidA })).toHaveLength(1);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuidB })).toHaveLength(1);
  });

  it('R1: a missing root is skipped without costing the roots that do exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const uuid = 'c3333333-0000-4000-8000-00000000000c';
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), askLine('toolu_survives', 'Still?') + '\n');

    const result = await tickGateWatch({
      roots: [path.join(os.tmpdir(), 'gate-watch-root-that-does-not-exist'), dir],
    });

    expect(result.opened).toBe(1);
  });

  it('R2: closes the NEWEST gate when more than 200 are open', async () => {
    // 204 older gates, each in its own session, then the one we will close.
    for (let i = 0; i < 204; i += 1) {
      await openOrTouchGate({
        workspaceId: WS,
        sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        client: 'claude',
        kind: 'ask',
        refId: `toolu_filler_${i}`,
        question: 'filler',
        options: null,
        source: 'watcher',
        rawRef: 'filler',
      });
    }
    const uuid = 'd4444444-0000-4000-8000-00000000000d';
    await openOrTouchGate({
      workspaceId: WS,
      sessionId: uuid,
      client: 'claude',
      kind: 'ask',
      refId: 'toolu_newest',
      question: 'Newest?',
      options: null,
      source: 'watcher',
      rawRef: 'seed',
    });
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuid })).toHaveLength(1);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), resultLine('toolu_newest') + '\n');

    const result = await tickGateWatch({ root: dir });

    // Seeding from listPendingGates({ limit: 200 }) ORDER BY opened_at ASC put
    // this gate — the 205th, and the NEWEST — outside the seed, so its close
    // candidate was discarded as "not a gate we opened". The bias was exactly
    // backwards: the excluded set is always the freshest gates.
    expect(result.closed).toBe(1);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuid })).toHaveLength(0);
  });

  it('R3: a first-seen OLD transcript never mints a gate from dead history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const uuid = 'e5555555-0000-4000-8000-00000000000e';
    const file = path.join(dir, `${uuid}.jsonl`);
    await fs.writeFile(file, askLine('toolu_ancient', 'Abandoned months ago?') + '\n');
    await fs.utimes(file, MONTH_AGO(), MONTH_AGO());

    const result = await tickGateWatch({ root: dir });

    expect(result.opened).toBe(0);
    expect(result.coldStartSkippedOpens).toBe(1);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuid })).toHaveLength(0);
  });

  it('R3: an old first-seen transcript still DISCHARGES a gate whose answer it contains', async () => {
    const uuid = 'f6666666-0000-4000-8000-00000000000f';
    await openOrTouchGate({
      workspaceId: WS,
      sessionId: uuid,
      client: 'claude',
      kind: 'ask',
      refId: 'toolu_answered',
      question: 'Answered long ago?',
      options: null,
      source: 'watcher',
      rawRef: 'pre-existing',
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const file = path.join(dir, `${uuid}.jsonl`);
    // Ask AND answer are both in history, so they cancel inside the cold-start
    // chunk: `closes` is empty and only `resolved` carries the evidence.
    await fs.writeFile(
      file,
      [askLine('toolu_answered', 'Answered long ago?'), resultLine('toolu_answered')].join('\n') + '\n',
    );
    await fs.utimes(file, MONTH_AGO(), MONTH_AGO());

    const result = await tickGateWatch({ root: dir });

    expect(result.opened).toBe(0);
    expect(result.closed).toBe(1);
    expect(await listPendingGates({ workspaceId: WS, sessionId: uuid })).toHaveLength(0);
  });

  it('R3: a RECENT first-seen transcript is still ingested normally', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    const uuid = 'a7777777-0000-4000-8000-00000000000a';
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`), askLine('toolu_fresh', 'Live?') + '\n');

    const result = await tickGateWatch({ root: dir });

    expect(result.opened).toBe(1);
    expect(result.coldStartSkippedOpens).toBe(0);
  });

  it('the per-tick file budget is a WORK cap that resumes, not a permanent horizon', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-watch-'));
    tmpDirs.push(dir);
    for (let i = 0; i < 3; i += 1) {
      await fs.writeFile(
        path.join(dir, `b8888888-0000-4000-8000-00000000000${i}.jsonl`),
        askLine(`toolu_budget_${i}`, `Q${i}?`) + '\n',
      );
    }

    const first = await tickGateWatch({ root: dir, maxFilesPerTick: 2 });
    expect(first.scannedFiles).toBe(2);
    expect(first.budgetExhausted).toBe(true);

    // The pre-fix `.slice(0, maxFiles)` re-picked the SAME first N every tick,
    // so the tail was unreachable on EVERY tick rather than merely deferred.
    const second = await tickGateWatch({ root: dir, maxFilesPerTick: 2 });
    expect(second.scannedFiles).toBe(1);
    expect(second.budgetExhausted).toBe(false);

    const total = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.session_pending_gates WHERE workspace_id = ${WS}
    `;
    expect(total[0].n).toBe(3);
  });
});
