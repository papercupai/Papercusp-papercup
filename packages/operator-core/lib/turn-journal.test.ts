/** Per-turn journal (deterministic-context-carry P-012) — extraction (agent
 *  ⟦journal⟧ line vs flagged mechanical fallback), the claim-vs-ledger
 *  tripwire, and the bounded transcript tail-reader / root-guarded resolver. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectClaimLedgerMismatch,
  extractJournalFromAssistantText,
  JOURNAL_MARKER,
  JOURNAL_NOTE_MAX_CHARS,
  MECHANICAL_NOTE_MAX_CHARS,
  readLastAssistantTurn,
  readVerbatimTail,
  resolveTranscriptPath,
} from './turn-journal';

describe('extractJournalFromAssistantText', () => {
  it('an agent-authored trailing ⟦journal⟧ line wins, unflagged', () => {
    const r = extractJournalFromAssistantText(
      'Long report body.\n\nMore detail here.\n\n⟦journal⟧ Landed the doors config; next is the hook wiring.',
    );
    expect(r).toEqual({
      note: 'Landed the doors config; next is the hook wiring.',
      source: 'agent',
      flagged: false,
    });
  });

  it('the LAST marker line wins when the convention is quoted earlier', () => {
    const r = extractJournalFromAssistantText(
      `The convention is a line like "${JOURNAL_MARKER} example note".\n${JOURNAL_MARKER} the real note`,
    );
    expect(r!.note).toBe('the real note');
    expect(r!.source).toBe('agent');
  });

  it('no marker → mechanical first line, markup stripped, FLAGGED', () => {
    const r = extractJournalFromAssistantText('## P-012 done\nDetail line.');
    expect(r).toEqual({ note: 'P-012 done', source: 'mechanical', flagged: true });
  });

  it('an empty marker line falls through to the mechanical fallback', () => {
    const r = extractJournalFromAssistantText(`Some text.\n${JOURNAL_MARKER}   `);
    expect(r!.source).toBe('mechanical');
    expect(r!.note).toBe('Some text.');
  });

  it('caps both variants at their budgets', () => {
    const long = 'x'.repeat(2000);
    expect(extractJournalFromAssistantText(`${JOURNAL_MARKER} ${long}`)!.note).toHaveLength(
      JOURNAL_NOTE_MAX_CHARS,
    );
    expect(extractJournalFromAssistantText(long)!.note).toHaveLength(MECHANICAL_NOTE_MAX_CHARS);
  });

  it('whitespace-only text yields null', () => {
    expect(extractJournalFromAssistantText('  \n \n')).toBeNull();
  });
});

describe('detectClaimLedgerMismatch (note says pass, ledger says exit 1; ledger NEWEST FIRST)', () => {
  const failedBash = { toolName: 'Bash', status: 'error', summary: '$ npx vitest run' };
  const cleanBash = { toolName: 'Bash', status: 'ok', summary: '$ npx vitest run' };
  const okRead = { toolName: 'Read', status: 'ok', summary: 'lib/foo.ts' };

  it('tripwires a success claim whose latest execution errored', () => {
    const t = detectClaimLedgerMismatch('All 12 tests pass; shipping it.', [failedBash]);
    expect(t).not.toBeNull();
    expect(t!.kind).toBe('claim-ledger-mismatch');
    expect(t!.claim.toLowerCase()).toContain('tests pass');
    expect(t!.evidence).toEqual([failedBash]);
  });

  it('recognizes the live "▶ <cmd>" summary shape as an execution (P-013 recon fix)', () => {
    const t = detectClaimLedgerMismatch('all tests pass', [
      { toolName: null, status: 'error', summary: '▶ npx vitest run' },
    ]);
    expect(t).not.toBeNull();
  });

  it('tripwires on ledger summary text ("exit code 1") when status was not stamped', () => {
    const t = detectClaimLedgerMismatch('build green, done', [
      { toolName: 'Bash', status: null, summary: '$ npm run build → exit code 1' },
    ]);
    expect(t).not.toBeNull();
  });

  it('the iterate-until-green turn stays clean: latest run ok, earlier run failed', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [cleanBash, failedBash])).toBeNull();
  });

  it('a claimed pass with an old failure and NO re-run still trips (Read/Edit ok does not attest)', () => {
    const t = detectClaimLedgerMismatch('all tests pass', [okRead, failedBash]);
    expect(t).not.toBeNull();
    expect(t!.evidence).toEqual([failedBash]);
  });

  it('a clean ledger never tripwires', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [cleanBash])).toBeNull();
  });

  it('no execution at all in the window → no tripwire (unverifiable, not dishonest)', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [okRead])).toBeNull();
  });

  it('a note with NO success claim never tripwires, whatever the ledger says', () => {
    expect(detectClaimLedgerMismatch('Refactored the resolver; next is wiring.', [failedBash])).toBeNull();
  });

  it('honest disclosure alongside the claim is never tripwired', () => {
    expect(
      detectClaimLedgerMismatch('unit tests pass but the integration suite is failing', [failedBash]),
    ).toBeNull();
  });

  it('evidence is capped at 3 rows', () => {
    const t = detectClaimLedgerMismatch(
      'typecheck clean',
      Array.from({ length: 10 }, (_, i) => ({ toolName: 'Bash', status: 'error', summary: `$ run ${i}` })),
    );
    expect(t!.evidence).toHaveLength(3);
  });

  it('tags the tripped domain (P-029 taxonomy)', () => {
    expect(detectClaimLedgerMismatch('all tests pass', [failedBash])!.domain).toBe('tests');
  });
});

describe('detectClaimLedgerMismatch — P-029 domains (deploy / commit) + isolation', () => {
  const failedDeploy = { toolName: 'deploy:harness', status: 'error', summary: 'deploy failed: gate red' };
  const okDeploy = { toolName: 'deploy:harness', status: 'ok', summary: 'deployed fence 65' };
  const failedRelease = { toolName: 'release:cut', status: 'error', summary: 'release aborted' };
  const failedGit = { toolName: 'git-sync:run', status: 'error', summary: 'push rejected' };
  const okGit = { toolName: 'capability:git', status: 'ok', summary: 'pushed 1 commit' };
  const failedBash = { toolName: 'Bash', status: 'error', summary: '$ npx vitest run' };

  it('deploy claim contradicted by a failed deploy tool trips, domain=deploy', () => {
    const t = detectClaimLedgerMismatch('Deployed to staging; :3170 is live.', [failedDeploy]);
    expect(t).not.toBeNull();
    expect(t!.domain).toBe('deploy');
    expect(t!.evidence).toEqual([failedDeploy]);
  });

  it('a release claim matches the deploy domain (release:* attests)', () => {
    expect(detectClaimLedgerMismatch('Cut a release.', [failedRelease])!.domain).toBe('deploy');
  });

  it('a successful deploy never trips the deploy claim', () => {
    expect(detectClaimLedgerMismatch('deployed to prod', [okDeploy])).toBeNull();
  });

  it('honest disclosure alongside a deploy claim is never tripwired', () => {
    expect(detectClaimLedgerMismatch('deployed, but the rollout failed', [failedDeploy])).toBeNull();
  });

  it('commit claim contradicted by a failed git op trips, domain=commit', () => {
    const t = detectClaimLedgerMismatch('Committed and pushed the fix.', [failedGit]);
    expect(t!.domain).toBe('commit');
    expect(t!.evidence).toEqual([failedGit]);
  });

  it('a successful push never trips the commit claim', () => {
    expect(detectClaimLedgerMismatch('pushed the branch', [okGit])).toBeNull();
  });

  // The soundness property of the taxonomy: each claim is diffed ONLY against
  // its own domain's ledger truth — foreign-domain failures are invisible.
  it('cross-domain isolation: a failed TEST never contradicts a DEPLOY claim', () => {
    expect(detectClaimLedgerMismatch('deployed to staging', [failedBash])).toBeNull();
  });

  it('cross-domain isolation: a failed DEPLOY never contradicts a COMMIT claim', () => {
    expect(detectClaimLedgerMismatch('Pushed the branch upstream.', [failedDeploy])).toBeNull();
  });

  it('priority: when tests AND deploy are both claimed and both failed, tests wins the slot', () => {
    const t = detectClaimLedgerMismatch('All tests pass and deployed to staging.', [failedDeploy, failedBash]);
    expect(t!.domain).toBe('tests');
  });
});

describe('readLastAssistantTurn / resolveTranscriptPath', () => {
  let sandbox: string;
  const claudeLine = (role: 'user' | 'assistant', text: string, ts: string) =>
    JSON.stringify({
      type: role,
      timestamp: ts,
      sessionId: 'sess-1',
      message: { role, content: [{ type: 'text', text }] },
    });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'papercusp-turn-journal-test-'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns the LAST assistant text turn of a claude transcript, with its ts', async () => {
    const f = join(sandbox, 'sess.jsonl');
    writeFileSync(
      f,
      [
        claudeLine('user', 'do the thing', '2026-07-14T10:00:00Z'),
        claudeLine('assistant', 'working on it', '2026-07-14T10:00:05Z'),
        claudeLine('assistant', `done.\n${JOURNAL_MARKER} the note`, '2026-07-14T10:00:20Z'),
      ].join('\n') + '\n',
    );
    const turn = await readLastAssistantTurn(f, 'claude');
    expect(turn).not.toBeNull();
    expect(turn!.speaker).toBe('assistant');
    expect(turn!.text).toContain('the note');
    expect(turn!.ts?.toISOString()).toBe('2026-07-14T10:00:20.000Z');
  });

  it('selects the latest completed Codex final and ignores later active commentary', async () => {
    const f = join(sandbox, 'codex.jsonl');
    const codexMessage = (role: 'user' | 'assistant', text: string, turnId: string, phase?: string) => JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        ...(phase ? { phase } : {}),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    });
    writeFileSync(f, [
      codexMessage('user', 'first request', 'turn-1'),
      codexMessage('assistant', 'completed answer ⟦journal⟧ selected', 'turn-1', 'commentary'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', error: null, last_agent_message: 'completed answer' } }),
      codexMessage('assistant', 'later active commentary', 'turn-2', 'commentary'),
    ].join('\n') + '\n');

    await expect(readLastAssistantTurn(f, 'codex')).resolves.toMatchObject({
      speaker: 'assistant',
      text: 'completed answer ⟦journal⟧ selected',
      requestId: 'turn-1',
      responseDisposition: 'delivered',
    });

    writeFileSync(f, codexMessage('assistant', 'commentary without a completed final', 'turn-3', 'commentary') + '\n');
    await expect(readLastAssistantTurn(f, 'codex')).resolves.toBeNull();

    writeFileSync(f, [
      codexMessage('assistant', 'interrupted commentary', 'turn-4', 'commentary'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-4', error: { message: 'interrupted' }, last_agent_message: null } }),
    ].join('\n') + '\n');
    await expect(readLastAssistantTurn(f, 'codex')).resolves.toBeNull();
  });

  it('a transcript whose tail is user turns still finds the previous assistant text', async () => {
    const f = join(sandbox, 'sess.jsonl');
    writeFileSync(
      f,
      [
        claudeLine('assistant', 'the answer', '2026-07-14T10:00:00Z'),
        claudeLine('user', 'thanks', '2026-07-14T10:00:10Z'),
      ].join('\n') + '\n',
    );
    const turn = await readLastAssistantTurn(f, 'claude');
    expect(turn!.text).toBe('the answer');
  });

  it('resolves a candidate path only when it lives under a known root', async () => {
    const root = join(sandbox, 'root');
    mkdirSync(join(root, 'proj'), { recursive: true });
    const inside = join(root, 'proj', 'abc.jsonl');
    writeFileSync(inside, claudeLine('assistant', 'hi', '2026-07-14T10:00:00Z') + '\n');
    const outside = join(sandbox, 'outside.jsonl');
    writeFileSync(outside, 'x\n');
    const roots = [{ root, dirDepth: 1 }];

    expect(await resolveTranscriptPath('claude', 'abc', inside, roots)).toBe(inside);
    // A foreign path is REFUSED as a candidate; the walk then finds the rooted
    // file by session id instead (never the foreign path).
    expect(await resolveTranscriptPath('claude', 'abc', outside, roots)).toBe(inside);
    expect(await resolveTranscriptPath('claude', 'nope', outside, roots)).toBeNull();
  });

  it('walks the roots by session id when no candidate is given', async () => {
    const root = join(sandbox, 'root');
    mkdirSync(join(root, 'proj'), { recursive: true });
    const f = join(root, 'proj', 'deadbeef-1234.jsonl');
    writeFileSync(f, claudeLine('assistant', 'hi', '2026-07-14T10:00:00Z') + '\n');
    expect(await resolveTranscriptPath('claude', 'deadbeef-1234', undefined, [{ root, dirDepth: 1 }])).toBe(f);
  });
});

describe('P-005-native-request-final-delivery-correlation: readVerbatimTail', () => {
  let sandbox: string;
  const claudeLine = (role: 'user' | 'assistant', text: string, ts: string) =>
    JSON.stringify({ type: role, timestamp: ts, sessionId: 'sess-1', message: { role, content: [{ type: 'text', text }] } });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'papercusp-verbatim-tail-test-'));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns the last N text turns of BOTH speakers, most-recent LAST', async () => {
    const f = join(sandbox, 'sess.jsonl');
    writeFileSync(
      f,
      [
        claudeLine('user', 'first ask', '2026-07-14T10:00:00Z'),
        claudeLine('assistant', 'first answer', '2026-07-14T10:00:05Z'),
        claudeLine('user', 'second ask', '2026-07-14T10:00:10Z'),
        claudeLine('assistant', 'second answer', '2026-07-14T10:00:15Z'),
      ].join('\n') + '\n',
    );
    const tail = await readVerbatimTail(f, 'claude', 3);
    expect(tail.map((t) => t.text)).toEqual(['first answer', 'second ask', 'second answer']);
    expect(tail[0].requestHistoryStatus).toBe('truncated');
    expect(tail[0].speaker).toBe('assistant');
    expect(tail[2].ts?.toISOString()).toBe('2026-07-14T10:00:15.000Z');
  });

  it('maxTurns <= 0 reads nothing', async () => {
    const f = join(sandbox, 'sess.jsonl');
    writeFileSync(f, claudeLine('assistant', 'hi', '2026-07-14T10:00:00Z') + '\n');
    expect(await readVerbatimTail(f, 'claude', 0)).toEqual([]);
  });

  it('threads Claude and OMP final delivery through tool-result nodes to the originating request', async () => {
    const claude = join(sandbox, 'claude.jsonl');
    writeFileSync(claude, [
      JSON.stringify({ type: 'user', uuid: 'cu1', parentUuid: null, message: { role: 'user', content: 'inspect it' } }),
      JSON.stringify({ type: 'assistant', uuid: 'ca1', parentUuid: 'cu1', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', uuid: 'ct1', parentUuid: 'ca1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'ca2', parentUuid: 'ct1', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'inspection complete' }] } }),
    ].join('\n') + '\n');
    expect(await readVerbatimTail(claude, 'claude', 8)).toMatchObject([
      { speaker: 'user', text: 'inspect it', requestId: 'cu1' },
      { speaker: 'assistant', text: 'inspection complete', requestId: 'cu1', responseDisposition: 'delivered' },
    ]);

    const omp = join(sandbox, 'omp.jsonl');
    writeFileSync(omp, [
      JSON.stringify({ type: 'message', id: 'ou1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'inspect OMP' }] } }),
      JSON.stringify({ type: 'message', id: 'oa1', parentId: 'ou1', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'tool-2', name: 'read' }] } }),
      JSON.stringify({ type: 'message', id: 'ot1', parentId: 'oa1', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } }),
      JSON.stringify({ type: 'message', id: 'oa2', parentId: 'ot1', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'OMP complete' }] } }),
    ].join('\n') + '\n');
    expect(await readVerbatimTail(omp, 'omp', 8)).toMatchObject([
      { speaker: 'user', text: 'inspect OMP', requestId: 'ou1' },
      { speaker: 'assistant', text: 'OMP complete', requestId: 'ou1', responseDisposition: 'delivered' },
    ]);
  });

  // EI-25227743201307257: a dialog answer is re-keyed to its own node id, so the
  // request whose turn raised the dialog must be read from the PARENT node.
  it('stamps a Claude dialog answer with the request of the turn that raised it (parentRequestId)', async () => {
    const f = join(sandbox, 'dialog.jsonl');
    const ask = (uuid: string, parentUuid: string) => JSON.stringify({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name: 'AskUserQuestion', input: {} }] } });
    const answer = (uuid: string, parentUuid: string, text: string) => JSON.stringify({ type: 'user', uuid, parentUuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${parentUuid}`, content: `Your questions have been answered: "Mic?"="${text}".` }] } });
    writeFileSync(f, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'start the session' } }),
      ask('q1', 'u1'),
      answer('d1', 'q1', 're-plugged'),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'd1', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'asking again' }] } }),
      ask('q2', 'a2'),
      answer('d2', 'q2', 'not at the machine'),
      JSON.stringify({ type: 'assistant', uuid: 'a3', parentUuid: 'd2', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'understood' }] } }),
    ].join('\n') + '\n');
    const users = (await readVerbatimTail(f, 'claude', 20)).filter((t) => t.speaker === 'user');
    expect(users).toMatchObject([
      { text: 'start the session', requestId: 'u1' },
      { requestId: 'd1', parentRequestId: 'u1' },
      { requestId: 'd2', parentRequestId: 'd1' },
    ]);
    // A root prompt has no parent node, so it carries no link at all.
    expect(users[0]).not.toHaveProperty('parentRequestId');
  });

  it('uses Codex task completion as the terminal receipt and keeps an errored turn interrupted', async () => {
    const f = join(sandbox, 'codex.jsonl');
    const message = (role: 'user' | 'assistant', text: string, turnId: string, phase?: string) => JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        ...(phase ? { phase } : {}),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
        content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
      },
    });
    writeFileSync(f, [
      message('user', 'first request', 'turn-1'),
      message('assistant', 'working', 'turn-1', 'commentary'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', error: { message: 'interrupted' }, last_agent_message: null } }),
      message('user', 'second request', 'turn-2'),
      message('assistant', 'second result', 'turn-2', 'commentary'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', error: null, last_agent_message: 'second result' } }),
    ].join('\n') + '\n');
    const tail = await readVerbatimTail(f, 'codex', 8);
    expect(tail).toMatchObject([
      { text: 'first request', requestId: 'turn-1' },
      { text: 'working', requestId: 'turn-1', responseDisposition: 'interrupted' },
      { text: 'second request', requestId: 'turn-2' },
      { text: 'second result', requestId: 'turn-2', responseDisposition: 'delivered' },
    ]);
  });
});
