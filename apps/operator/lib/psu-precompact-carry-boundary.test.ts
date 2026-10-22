// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexCarryTurnCompleted, makeAgentBusyGate, nativeExecutionFromRows,
  nativeTurnCompletedInTranscript,
} from '../scripts/psu-pty-host.mjs';
import { preCompactDecision } from '../scripts/hooks/cc/precompact-managed-carry.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'precompact-carry-boundary-'));
  roots.push(root);
  mkdirSync(join(root, 'sessions'));
  const transcriptPath = join(root, 'sessions', 'rollout.jsonl');
  const receivedAtMs = Date.now() - 1_000;
  const options = { agent: 'codex', env: { CODEX_HOME: root }, transcriptPath, receivedAtMs };
  const row = (type: string, at = receivedAtMs + 1, turn_id: string | null = 'turn-1') => ({
    type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type, turn_id },
  });
  const write = (rows: unknown[]) => writeFileSync(transcriptPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { options, row, write, probe: () => codexCarryTurnCompleted(options) };
}

describe('managed PreCompact interrupted carry boundary (WI-6554700010019730)', () => {
  it('resumes the queued carry after the hook veto even while the idle TUI repaints', async () => {
    const f = fixture();
    const decision = preCompactDecision({ ok: true, inner: { ok: true, requested: true, respawn: 'queued' } });
    expect(decision.continue).toBe(false);
    // Codex records this terminal row after a PreCompact continue:false. There
    // is no task_complete and no model turn left to flush or submit "continue".
    const rows = [f.row('task_started'), f.row('turn_aborted', f.options.receivedAtMs + 2)];
    f.write(rows);
    const execution = () => nativeExecutionFromRows(rows, { agent: 'codex' });
    expect(execution()).toMatchObject({ phase: 'failed', pendingTools: 0 });
    const gate = makeAgentBusyGate({ lastOutputAt: Date.now, quietMs: 1_000, capMs: 30, nativeExecution: execution });
    expect(await gate.waitAtPrompt(undefined, f.probe)).toMatchObject({ deferred: false, boundary: 'native-turn-complete' });
    // Success-only callers retain their existing semantics.
    expect(nativeTurnCompletedInTranscript(f.options)).toBe(false);
  });

  it.each(['function_call', 'custom_tool_call'])('waits for an interrupted %s effect to finish, including calls before the carry request', async type => {
    const f = fixture();
    const call = {
      type: 'response_item', timestamp: new Date(f.options.receivedAtMs - 1).toISOString(),
      payload: { type, call_id: 'external-effect', name: 'exec_command' },
    };
    const rows = [f.row('task_started', f.options.receivedAtMs - 2), call, f.row('turn_aborted')];
    f.write(rows);
    expect(f.probe()).toBe(false);
    const gate = makeAgentBusyGate({ lastOutputAt: Date.now, quietMs: 1_000, capMs: 20,
      nativeExecution: () => nativeExecutionFromRows(rows, { agent: 'codex' }) });
    expect(await gate.waitAtPrompt(undefined, f.probe)).toMatchObject({ deferred: true });
    rows.push({ ...call, timestamp: new Date(f.options.receivedAtMs + 2).toISOString(),
      payload: { type: `${type}_output`, call_id: 'external-effect', name: 'exec_command' } });
    f.write(rows);
    expect(f.probe()).toBe(true);
    expect(await gate.waitAtPrompt(undefined, f.probe)).toMatchObject({ deferred: false });
  });

  it('rejects stale, future, unidentified and partial aborts, and a newer active turn', () => {
    const f = fixture();
    for (const abort of [f.row('turn_aborted', f.options.receivedAtMs - 1),
      f.row('turn_aborted', Date.now() + 60_000), f.row('turn_aborted', undefined, null)]) {
      f.write([f.row('task_started', f.options.receivedAtMs - 2), abort]);
      expect(f.probe()).toBe(false);
    }
    f.write([f.row('task_started'), f.row('turn_aborted'), f.row('task_started', f.options.receivedAtMs + 2, 'turn-2')]);
    expect(f.probe()).toBe(false);
    f.write([f.row('task_started'), f.row('turn_aborted')]);
    appendFileSync(f.options.transcriptPath, '{"type":');
    expect(f.probe()).toBe(false);
    f.write([f.row('turn_aborted')]); // start (and possible tools) fell out of the bounded tail
    expect(f.probe()).toBe(false);
    f.write([f.row('task_started'), f.row('turn_aborted', undefined, 'other-turn')]);
    expect(f.probe()).toBe(false);
  });

  it('keeps transcript containment and the Codex-only restriction for interrupted carries', () => {
    const f = fixture();
    f.write([f.row('task_started'), f.row('turn_aborted')]);
    expect(f.probe()).toBe(true);
    expect(codexCarryTurnCompleted({ ...f.options, agent: 'claude' })).toBe(false);
    expect(codexCarryTurnCompleted({ ...f.options, env: {} })).toBe(false);
    const outside = join(f.options.env.CODEX_HOME, 'outside.jsonl');
    writeFileSync(outside, JSON.stringify(f.row('turn_aborted')) + '\n');
    expect(codexCarryTurnCompleted({ ...f.options, transcriptPath: outside })).toBe(false);
  });
});
