// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideLoopExecutionRecovery, type ExecutionRecoveryInput } from '@papercusp/operator-core/lib/harness/routines/loop-execution-recovery';
import { makeAgentBusyGate, nativeExecutionBlocksInjection, nativeExecutionFromRows, nativeTurnVerifierSupport,
  nativeLatestExecution, nativeLatestTurnCompleted, retainRunningNativeExecution } from '../scripts/psu-pty-host.mjs';

const timestamp = new Date(1000).toISOString();
const ctx = { receivedAtMs: 900, nowMs: 2000 };

describe('native execution observations', () => {
  it.each(['codex', 'claude', 'omp'])('reports missing evidence as unknown for %s', agent => {
    expect(nativeExecutionFromRows([], { agent, ...ctx }).phase).toBe('unknown');
  });

  it('distinguishes an aborted Codex turn from a running turn without reading error text', () => {
    const start = { type: 'event_msg', timestamp, payload: { type: 'task_started' } };
    expect(nativeExecutionFromRows([start], { agent: 'codex', ...ctx }).phase).toBe('running');
    expect(nativeExecutionFromRows([start, { ...start, payload: { type: 'turn_aborted' } }],
      { agent: 'codex', ...ctx }).phase).toBe('failed');
  });

  it.each(['task_complete', 'turn_completed'])('recognizes Codex %s errors and preserves unresolved tool effects', type => {
    const rows = [
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'failed-turn' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'effect' } },
      { type: 'event_msg', timestamp, payload: { type, turn_id: 'failed-turn',
        error: { codex_error_info: 'server_overloaded', message: 'Selected model is at capacity.' } } },
    ];
    const failed = nativeExecutionFromRows(rows, { agent: 'codex', ...ctx });
    expect(failed).toMatchObject({ phase: 'failed', pendingTools: 1 });
    expect(nativeExecutionBlocksInjection(failed)).toBe(true);
    rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'effect' } });
    expect(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx })).toMatchObject({ phase: 'failed', pendingTools: 0 });

    for (const error of [null, undefined]) {
      expect(nativeExecutionFromRows([
        { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'successful-turn' } },
        { type: 'event_msg', timestamp, payload: { type, turn_id: 'successful-turn', error } },
      ], { agent: 'codex', ...ctx })).toMatchObject({ phase: 'settled', pendingTools: 0 });
    }
  });

  it('keeps a silent Codex tool active until its matching result', () => {
    const rows = [
      { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'tool-a' } },
    ];
    expect(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx }).pendingTools).toBe(1);
    rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'tool-a' } });
    expect(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx }).pendingTools).toBe(0);
  });

  it('keeps Codex execution running when the bounded tail evicts task_started', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-native-execution-tail-'));
    const codexHome = join(root, 'codex');
    const sessionDir = join(codexHome, 'sessions', '2026', '10', '10');
    const receivedAtMs = 1_700_000_000_000;
    try {
      mkdirSync(sessionDir, { recursive: true });
      const transcriptPath = join(sessionDir, 'rollout.jsonl');
      const rows = [
        { type: 'event_msg', timestamp: new Date(receivedAtMs + 1).toISOString(),
          payload: { type: 'task_started' } },
        { type: 'response_item', timestamp: new Date(receivedAtMs + 2).toISOString(),
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(270 * 1024) }] } },
        { type: 'response_item', timestamp: new Date(receivedAtMs + 3).toISOString(),
          payload: { type: 'function_call', call_id: 'tool-a' } },
      ];
      writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      const size = statSync(transcriptPath).size;
      const startRowBytes = Buffer.byteLength(JSON.stringify(rows[0]) + '\n');
      expect(size - 256 * 1024).toBeGreaterThan(startRowBytes);

      const execution = nativeLatestExecution({
        agent: 'codex',
        env: { CODEX_HOME: codexHome },
        receivedAtMs,
        nowMs: receivedAtMs + 10_000,
      });
      expect(execution).toMatchObject({ phase: 'running', pendingTools: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['settled', 'running', 'accepted', 'partial'])('recovers Claude %s state behind an oversized trailing attachment', phase => {
    const root = mkdtempSync(join(tmpdir(), 'claude-native-execution-attachment-'));
    const sessionDir = join(root, 'projects', 'fixture-project');
    const nativeSessionId = '6a011c2d-09bb-4561-9470-ff284f407657';
    try {
      mkdirSync(sessionDir, { recursive: true });
      const rows: any[] = [
        { type: 'user', timestamp, message: { role: 'user', content: 'review current evidence' } },
        { type: 'assistant', uuid: 'assistant-1', timestamp,
          message: { role: 'assistant', stop_reason: phase === 'running' ? 'tool_use' : 'end_turn',
            content: phase === 'running' ? [{ type: 'tool_use', id: 'review-tool' }] : [] } },
      ];
      if (phase === 'accepted') rows.push({ type: 'user', timestamp,
        message: { role: 'user', content: 'a newer turn has been accepted' } });
      rows.push({ type: 'attachment', timestamp, attachment: { content: 'x'.repeat(337_363) } });
      const transcriptPath = join(sessionDir, `${nativeSessionId}.jsonl`);
      writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + (phase === 'partial' ? '' : '\n'));
      expect(statSync(transcriptPath).size).toBeGreaterThan(256 * 1024);
      const options = { agent: 'claude', env: { CLAUDE_CONFIG_DIR: root }, nativeSessionId, ...ctx };
      const observed = nativeLatestExecution(options);
      expect(observed).toMatchObject({ phase: phase === 'accepted' || phase === 'partial' ? 'unknown' : phase,
        pendingTools: phase === 'running' ? 1 : 0 });
      expect(nativeLatestTurnCompleted({ ...options, completedAtOrAfterMs: ctx.receivedAtMs }))
        .toBe(phase === 'settled');
      const retained = retainRunningNativeExecution(
        { phase: 'running', turnStartedAt: 1000, lastProgressAt: 1000, pendingTools: 0 }, observed);
      expect(nativeExecutionBlocksInjection(retained)).toBe(phase !== 'settled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains verified running state when a bounded transcript tail evicts task_started', () => {
    const previous = { phase: 'running', turnStartedAt: 1000, lastProgressAt: 1500, pendingTools: 0 };
    const evicted = { phase: 'unknown', turnStartedAt: null, lastProgressAt: null, pendingTools: 0 };
    expect(retainRunningNativeExecution(previous, evicted)).toEqual({
      phase: 'running', turnStartedAt: 1000, lastProgressAt: 1500, pendingTools: 0,
    });
  });

  it.each(['running', 'settled'])('observes the bound Codex writer when a newer sibling is %s', siblingPhase => {
    const root = mkdtempSync(join(tmpdir(), 'codex-native-execution-sibling-'));
    const sessionDir = join(root, 'sessions', '2026', '10', '17');
    const nativeSessionId = '01a147e0-dfd7-7d83-95a1-fe2c0250ebd2';
    const siblingId = '01a147fc-3632-7b62-a7d1-9a476a968e0f';
    const boundPhase = siblingPhase === 'running' ? 'settled' : 'running';
    try {
      mkdirSync(sessionDir, { recursive: true });
      for (const [id, phase, mtime] of [[nativeSessionId, boundPhase, 1], [siblingId, siblingPhase, 2]] as const) {
        const path = join(sessionDir, `rollout-2026-10-17-${id}.jsonl`);
        writeFileSync(path, JSON.stringify({ type: 'event_msg', timestamp,
          payload: { type: phase === 'running' ? 'task_started' : 'task_complete', turn_id: 'fixture-turn' } }) + '\n');
        utimesSync(path, mtime, mtime);
      }
      const options = { agent: 'codex', env: { CODEX_HOME: root }, nativeSessionId, ...ctx };
      expect(nativeLatestExecution(options)).toMatchObject({ phase: boundPhase });
      expect(nativeLatestTurnCompleted({ ...options, completedAtOrAfterMs: ctx.receivedAtMs }))
        .toBe(boundPhase === 'settled');
      for (const unavailableId of [null, '01a147e0-4039-71e1-ac86-108b32273db5', '../' + siblingId]) {
        expect(nativeLatestExecution({ ...options, nativeSessionId: unavailableId }).phase).toBe('unknown');
        expect(nativeLatestTurnCompleted({ ...options, nativeSessionId: unavailableId })).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets terminal native evidence replace a retained running state', () => {
    const previous = { phase: 'running', turnStartedAt: 1000, lastProgressAt: 1500, pendingTools: 0 };
    const settled = { phase: 'settled', turnStartedAt: null, lastProgressAt: 2000, pendingTools: 0 };
    expect(retainRunningNativeExecution(previous, settled)).toBe(settled);
  });

  it('does not turn unknown prior evidence into a running verdict', () => {
    const previous = { phase: 'unknown', turnStartedAt: null, lastProgressAt: null, pendingTools: 0 };
    const current = { phase: 'unknown', turnStartedAt: null, lastProgressAt: null, pendingTools: 0 };
    expect(retainRunningNativeExecution(previous, current)).toBe(current);
  });

  it('does not treat OMP tool-use as terminal and recognizes arbitrary failed outcomes', () => {
    const user = { type: 'message', id: 'u', timestamp, message: { role: 'user' } };
    const tool = { type: 'message', id: 'a', timestamp, message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call' }] } };
    expect(nativeExecutionFromRows([user, tool], { agent: 'omp', ...ctx })).toMatchObject({ phase: 'running', pendingTools: 1 });
    const failed = { type: 'message', id: 'b', timestamp, message: { role: 'assistant', stopReason: 'error', errorMessage: 'unseen failure' } };
    expect(nativeExecutionFromRows([user, tool, failed], { agent: 'omp', ...ctx })).toMatchObject({ phase: 'failed', pendingTools: 1 });
  });

  it('does not certify older, future, or shared-home evidence', () => {
    const done = { type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: 'done' } };
    expect(nativeExecutionFromRows([done], { agent: 'codex', receivedAtMs: 1001, nowMs: 2000 }).phase).toBe('unknown');
    expect(nativeExecutionFromRows([done], { agent: 'codex', receivedAtMs: 0, nowMs: 999 }).phase).toBe('unknown');
    expect(nativeTurnVerifierSupport('omp', { PI_CONFIG_DIR: '.omp' }).supported).toBe(false);
    expect(nativeTurnVerifierSupport('omp', { PI_CONFIG_DIR: '.papercusp/session-omp' }).supported).toBe(true);
  });

  it('keeps Claude tool results inside the same turn and uses typed API failure evidence', () => {
    const rows = [
      { type: 'user', timestamp, message: { role: 'user', content: 'start' } },
      { type: 'assistant', timestamp, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call' }] } },
      { type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call' }] } },
    ];
    expect(nativeExecutionFromRows(rows, { agent: 'claude', ...ctx })).toMatchObject({ phase: 'running', pendingTools: 0 });
    rows.push({ type: 'assistant', timestamp, isApiErrorMessage: true, message: { role: 'assistant' } } as never);
    expect(nativeExecutionFromRows(rows, { agent: 'claude', ...ctx }).phase).toBe('failed');
  });

  it.each(['codex', 'claude', 'omp'])('does not inject into a silent native %s turn', async agent => {
    const start = agent === 'codex'
      ? { type: 'event_msg', timestamp, payload: { type: 'task_started' } }
      : agent === 'claude' ? { type: 'assistant', timestamp, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'pending' }] } }
        : { type: 'message', timestamp, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'pending' }] } };
    const execution = nativeExecutionFromRows([start], { agent, ...ctx });
    const gate = makeAgentBusyGate({ lastOutputAt: () => 0, quietMs: 1, capMs: 1,
      nativeExecution: () => execution });
    expect(await gate.waitAtPrompt(undefined, () => true)).toMatchObject({ deferred: true, reason: 'agent-busy' });
  });

  it('rechecks execution after the poll phase before releasing a silent prompt', async () => {
    let reads = 0;
    const gate = makeAgentBusyGate({ lastOutputAt: () => 0, quietMs: 1, capMs: 1,
      nativeExecution: () => ({ phase: ++reads === 1 ? 'settled' : 'running' }) });
    expect(await gate.waitAtPrompt()).toMatchObject({ deferred: true });
  });

  it('preserves unresolved tool effects after an aborted turn until a matching result', () => {
    const rows = [
      { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'effect' } },
      { type: 'event_msg', timestamp, payload: { type: 'turn_aborted' } },
    ];
    expect(nativeExecutionBlocksInjection(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx }))).toBe(true);
    rows.push({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: 'effect' } });
    expect(nativeExecutionBlocksInjection(nativeExecutionFromRows(rows, { agent: 'codex', ...ctx }))).toBe(false);
  });

  it.each(['codex', 'claude', 'omp'])('protects an unresolved native %s approval request after failure until its matching result', agent => {
    // Native permission prompts leave the requested operation unresolved. The
    // observer must preserve that call even if its model turn fails meanwhile.
    const callId = 'approval-operation';
    const rows = agent === 'codex' ? [
      { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: callId,
        name: 'exec_command', arguments: JSON.stringify({ cmd: 'printf approved',
          sandbox_permissions: 'require_escalated', justification: 'Approve this operation?' }) } },
      { type: 'event_msg', timestamp, payload: { type: 'turn_aborted' } },
    ] : agent === 'claude' ? [
      { type: 'user', timestamp, message: { role: 'user', content: 'Run the approved operation' } },
      { type: 'assistant', timestamp, message: { role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'printf approved' } }] } },
      { type: 'assistant', timestamp, isApiErrorMessage: true, message: { role: 'assistant' } },
    ] : [
      { type: 'message', id: 'owner', timestamp, message: { role: 'user', content: 'Run the approved operation' } },
      { type: 'message', id: 'request', timestamp, message: { role: 'assistant', stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: { command: 'printf approved' } }] } },
      { type: 'message', id: 'failed', timestamp, message: { role: 'assistant', stopReason: 'error' } },
    ];
    const nowMs = 40_000;
    const decision = () => {
      const observed = nativeExecutionFromRows(rows, { agent, receivedAtMs: 900, nowMs });
      expect(observed.phase).toBe('failed');
      const input: ExecutionRecoveryInput = { ownerId: 'approval-owner', active: true, parked: true,
        firedAt: 900, nowMs, host: { ownerId: 'approval-owner', advSessionId: null, pid: 1, ptyPid: 2,
          sock: '/fixture', command: agent, startedAt: 0,
          execution: { ...observed, phase: 'failed', ownerId: 'approval-owner', hostPid: 1, childPid: 2,
            childGeneration: 1, receivedAtMs: 900, observedAt: nowMs } },
        inference: { active: 0, observedAt: nowMs } };
      return { observed, recovery: decideLoopExecutionRecovery(input) };
    };
    expect(decision()).toMatchObject({ observed: { pendingTools: 1 },
      recovery: { action: 'protect', state: { reason: 'native-operation', attempts: 0 } } });
    const output = (id: string) => agent === 'codex'
      ? { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: id, output: 'approved' } }
      : agent === 'claude'
        ? { type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'approved' }] } }
        : { type: 'message', id: `result-${id}`, timestamp,
          message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: 'approved' }] } };
    rows.push(output('another-operation') as never);
    expect(decision().recovery.action).toBe('protect');
    rows.push(output(callId) as never);
    expect(decision()).toMatchObject({ observed: { pendingTools: 0 },
      recovery: { action: 'recover', state: { attempts: 1 } } });
  });

  it('excludes a predecessor running turn after a new child/submission floor', () => {
    const row = { type: 'event_msg', timestamp, payload: { type: 'task_started' } };
    expect(nativeExecutionFromRows([row], { agent: 'codex', receivedAtMs: 1001, nowMs: 2000 }).phase).toBe('unknown');
  });

  it.each(['claude', 'omp'])('keeps an accepted %s prompt without model work unknown', agent => {
    const user = { type: agent === 'claude' ? 'user' : 'message', timestamp,
      message: { role: 'user', content: 'accepted prompt' } };
    expect(nativeExecutionFromRows([user], { agent, ...ctx })).toMatchObject({ phase: 'unknown', turnStartedAt: null });
  });
});
