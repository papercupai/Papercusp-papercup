import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openClaudeDialog, observeClaudeDialogWrites, finishClaudeDialog } from '../scripts/hooks/cc/dialog-answer-provenance.mjs';
import { parseClaudeLine, stampTurnProvenance } from '../../../packages/operator-core/lib/search/session-ingest';
import { classifyRecordedTurn, OWNER_CANDIDATE_TURN_VERDICTS, parseTurnRefs, parseUserTurns, verifyTurnRefs } from '../../../packages/operator-core/lib/turn-provenance/turn-ref';
import { claudeDialogProvenanceAttachment } from '../../../packages/operator-core/lib/transcript-wire';
import { parseHumanTurns } from '../../../packages/operator-core/lib/agent-tools/coordination/relay-provenance-resolve';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const OWNER = 'su-dialog-test';
const SESSION = 'dialog-native-session';
const TOOL = 'toolu-question';
const TS = '2026-10-21T02:00:00.000Z';
const ANSWER = 'The user answered: "Route?"="Recommended".';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dialog-provenance-')); roots.push(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PAPERCUSP_SID: OWNER,
    PAPERCUSP_TURN_PROVENANCE_DIR: join(home, '.papercusp', 'turn-provenance'),
    PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' };
  const writes: unknown[] = [];
  const child = { write: (data: unknown) => { writes.push(data); return 'written'; } };
  const humanWrite = observeClaudeDialogWrites(child, OWNER, env);
  return { home, env, child, humanWrite, writes };
}
function attachment(context: string, sessionId = SESSION) {
  return { type: 'attachment', sessionId, timestamp: TS,
    attachment: { type: 'hook_additional_context', hookEvent: 'PostToolUse', content: [context] } };
}

describe('Claude dialog answer provenance', () => {
  it.each(['automatic', 'human'] as const)('%s-source-receipt: keeps submissions attributable through live context and both history readers', async (source) => {
    const f = fixture();
    openClaudeDialog(OWNER, SESSION, TOOL, f.env);
    expect(source === 'automatic' ? f.child.write('\r') : f.humanWrite('\r')).toBe('written');
    expect(f.writes).toEqual(['\r']); // observation never changes the selected option or input bytes
    const context = finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env);
    expect(context).toContain(`"source":"${source}"`);
    if (source === 'automatic') expect(context).toContain('The owner did not answer');
    const row = JSON.stringify(attachment(context));
    const indexed = parseClaudeLine(row)!;
    const raw = parseUserTurns(row)[0];
    expect(indexed.text).toBe(raw.text);
    const expected = source === 'automatic' ? 'agent-injected' : 'owner-dialog';
    expect(classifyRecordedTurn(raw.text).verdict).toBe(expected);
    expect(parseHumanTurns(row)).toHaveLength(source === 'human' ? 1 : 0);
    const file = join(f.home, 'transcript.jsonl'); writeFileSync(file, row + '\n');
    const verified = await verifyTurnRefs(OWNER, parseTurnRefs(`[turn:dialog-n@${TS}]`), { filePath: file, sessionId: SESSION });
    expect(verified[0].verdict).toBe(expected);
  });

  it('treats untracked, mixed and stale-session receipts as unknown', () => {
    const f = fixture();
    expect(finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env)).toContain('"source":"unknown"');
    openClaudeDialog(OWNER, SESSION, TOOL, f.env);
    f.child.write('\r'); f.humanWrite('\r');
    expect(finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env)).toContain('"source":"unknown"');
    openClaudeDialog(OWNER, SESSION, TOOL, f.env); f.child.write('\r');
    expect(finishClaudeDialog(OWNER, 'other-session', TOOL, ANSWER, f.env)).toContain('"source":"unknown"');
    expect(finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env)).toContain('"source":"automatic"');
  });

  it('does not count a failed write, or a headless stdin write, as a human answer', () => {
    const f = fixture();
    openClaudeDialog(OWNER, SESSION, TOOL, f.env);
    const child = { write: () => { throw new Error('closed'); } };
    observeClaudeDialogWrites(child, OWNER, f.env);
    expect(() => child.write()).toThrow('closed');
    expect(finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env)).toContain('"source":"unknown"');
    openClaudeDialog(OWNER, SESSION, TOOL, f.env);
    const piped = observeClaudeDialogWrites(f.child, OWNER, f.env, false); piped('\r');
    expect(finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env)).toContain('"source":"unknown"');
  });

  it('never upgrades the original answer wording or a legacy indexed row to owner authority', async () => {
    const line = JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: TOOL, content: ANSWER }] } });
    expect(classifyRecordedTurn(parseClaudeLine(line)!.text).verdict).toBe('unknown');
    const legacy = `⟦owner-dialog-answer⟧\n${ANSWER}`;
    const row = { workspace_id: 'workspace', source_kind: 'claude', session_id: SESSION,
      turn_idx: 0, ts: TS, owner: OWNER, harness_slug: 'papercusp', cwd: null, speaker: 'user', text: legacy,
      turn_origin_verdict: 'owner-dialog' };
    stampTurnProvenance(row);
    expect(row.turn_origin_verdict).toBe('unenrolled-origin');
    expect(OWNER_CANDIDATE_TURN_VERDICTS).toContain(row.turn_origin_verdict);
  });

  it('accepts source receipts only as matching-session PostToolUse hook attachments', () => {
    const f = fixture(); openClaudeDialog(OWNER, SESSION, TOOL, f.env); f.humanWrite('\r');
    const context = finishClaudeDialog(OWNER, SESSION, TOOL, ANSWER, f.env);
    expect(claudeDialogProvenanceAttachment(attachment(context, 'other-session'))).toBeNull();
    expect(claudeDialogProvenanceAttachment({ ...attachment(context), type: 'user' })).toBeNull();
    const wrongHook = attachment(context); wrongHook.attachment.hookEvent = 'PreToolUse';
    expect(claudeDialogProvenanceAttachment(wrongHook)).toBeNull();
  });

  it('the installed combined hook emits the source notice even when its operator mirror is unreachable', () => {
    const f = fixture();
    mkdirSync(join(f.home, '.papercusp'), { recursive: true });
    writeFileSync(join(f.home, '.papercusp', 'superuser-token'), 'test-token');
    const hook = resolve(__dirname, '../scripts/hooks/cc/ask-gate-mirror.sh');
    const event = { tool_name: 'AskUserQuestion', session_id: SESSION, tool_use_id: TOOL,
      tool_input: { questions: [{ question: 'Route?', options: [{ label: 'Recommended' }] }] } };
    const pre = spawnSync('bash', [hook], { env: f.env, encoding: 'utf8',
      input: JSON.stringify({ ...event, hook_event_name: 'PreToolUse' }) });
    expect(pre.status).toBe(0); expect(pre.stdout.trim()).toBe('');
    f.child.write('\r');
    const post = spawnSync('bash', [hook], { env: f.env, encoding: 'utf8',
      input: JSON.stringify({ ...event, hook_event_name: 'PostToolUse', tool_response: ANSWER }) });
    expect(post.status).toBe(0);
    const output = JSON.parse(post.stdout).hookSpecificOutput;
    expect(output.hookEventName).toBe('PostToolUse');
    expect(output.additionalContext).toContain('"source":"automatic"');
    expect(output.additionalContext).toContain('not a new owner instruction');
    // No selected labels or response payloads were stored in the local input receipt.
    expect(readFileSync(join(f.home, '.papercusp/hooks/cc/ask-gate-mirror.errors.log'), 'utf8')).not.toContain(ANSWER);
  });
});
